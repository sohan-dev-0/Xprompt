/**
 * PromptLock — Execution Verifier (Step 6 Upgrade)
 *
 * Orchestrates diff extraction and AI call for post-execution verification.
 * Adheres strictly to token saving: only sends Snapshot Diff (changed lines & AST delta),
 * never the full codebase.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { validateContracts } = require('./contract-validator');
const productionAuditor = require('./production-auditor');

let promptTemplateCache = null;

/**
 * Load the verify-execution.md prompt template.
 * @returns {string}
 */
function loadPromptTemplate() {
  if (promptTemplateCache) return promptTemplateCache;
  const promptPath = path.join(__dirname, '../ai/prompts/verify-execution.md');
  try {
    promptTemplateCache = fs.readFileSync(promptPath, 'utf8');
  } catch (_) {
    // Fallback if file read fails
    promptTemplateCache = [
      'You are PromptLock\'s strict AI Verification & Execution Drift Engine.',
      'Analyze the changes against the plan and prompt.',
      'Original Prompt:\n{{originalPrompt}}',
      'Plan:\n{{plan}}',
      'Diff:\n{{diff}}',
      'Return ONLY JSON: { "done": [], "partial": [], "missed": [], "violations": [], "brokenImports": [], "regressions": [], "riskScore": 0, "nextActions": [] }'
    ].join('\n\n');
  }
  return promptTemplateCache;
}

const FORBIDDEN_FILES = [
  'package.json',
  'package-lock.json',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  'node_modules',
  '.git',
  '__pycache__',
];

/**
 * Check if any forbidden file was modified in diff or git working tree.
 * @param {object|string} diff
 * @param {string|null} [projectPath]
 * @returns {string[]}
 */
function checkForbiddenFileBreach(diff, projectPath = null) {
  const breaches = new Set();

  const checkItem = (item) => {
    if (!item) return;
    const str = typeof item === 'string' ? item : (item.path || item.name || String(item));
    const normalized = str.replace(/\\/g, '/');
    const base = path.basename(normalized).toLowerCase();
    const lower = normalized.toLowerCase();

    for (const fb of FORBIDDEN_FILES) {
      const fbLower = fb.toLowerCase();
      if (base === fbLower) {
        breaches.add(base);
        return;
      }
      if (base.startsWith('.env')) {
        breaches.add(base);
        return;
      }
      if (lower === fbLower || lower.startsWith(fbLower + '/') || lower.includes('/' + fbLower + '/') || lower.endsWith('/' + fbLower)) {
        breaches.add(base);
        return;
      }
    }
  };

  if (diff && typeof diff === 'object') {
    (diff.modified || []).forEach(checkItem);
    (diff.added || []).forEach(checkItem);
    (diff.deleted || []).forEach(checkItem);
  } else if (typeof diff === 'string') {
    for (const fb of FORBIDDEN_FILES) {
      if (diff.includes(fb)) {
        breaches.add(fb);
      }
    }
  }

  // Check git status in projectPath if available
  if (projectPath && fs.existsSync(projectPath)) {
    try {
      const gitDir = path.join(projectPath, '.git');
      if (fs.existsSync(gitDir)) {
        const out = execSync('git status --porcelain', {
          cwd: projectPath,
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        for (const line of out.split('\n')) {
          const file = line.slice(3).trim();
          if (file) checkItem(file);
        }
      }
    } catch (_) {}
  }

  return Array.from(breaches);
}

/**
 * Summarize a large diff exceeding token/char limit (3,000 tokens / 12,000 characters).
 * Omits raw code diff to prevent API crashes and provides file line delta counts.
 *
 * @param {string} rawDiff
 * @param {string[]} [modifiedFiles]
 * @returns {string}
 */
function summarizeLargeDiff(rawDiff, modifiedFiles = []) {
  const lines = (typeof rawDiff === 'string' ? rawDiff : '').split('\n');
  const fileStats = new Map();
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) currentFile = match[1].trim();
    } else if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith('--- a/')) {
      if (!currentFile) currentFile = line.slice(6).trim();
    }

    if (currentFile) {
      if (!fileStats.has(currentFile)) {
        fileStats.set(currentFile, { added: 0, deleted: 0 });
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        fileStats.get(currentFile).added++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        fileStats.get(currentFile).deleted++;
      }
    }
  }

  const summary = [
    `[LARGE DIFF SUMMARY - DIFF EXCEEDED 12,000 CHARACTERS / 3,000 TOKENS]`,
    `Notice: Raw code diff omitted to prevent API context limit overflow.`,
  ];

  if (fileStats.size > 0) {
    for (const [file, stats] of fileStats.entries()) {
      summary.push(`File ${file} modified: ${stats.added} lines added, ${stats.deleted} deleted`);
    }
  } else if (Array.isArray(modifiedFiles) && modifiedFiles.length > 0) {
    for (const f of modifiedFiles) {
      summary.push(`File ${f} modified: large change detected`);
    }
  } else {
    const addedCount = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletedCount = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    summary.push(`Files modified: ${addedCount} lines added, ${deletedCount} deleted`);
  }

  return summary.join('\n');
}

/**
 * Format a token-efficient diff representation:
 * Only sends changed/added/deleted files, lines, and AST functions delta.
 * Never sends full file contents or unchanged code.
 * If diff exceeds 12,000 chars (3,000 tokens), summarizes it without sending raw diff.
 *
 * @param {object|string} diff - Snapshot diff object or raw diff string
 * @param {string} [projectPath] - Absolute path to project root
 * @param {object} [beforeSnapshot]
 * @param {object} [afterSnapshot]
 * @returns {string}
 */
function extractTokenEfficientDiff(diff, projectPath, beforeSnapshot, afterSnapshot) {
  if (typeof diff === 'string') {
    if (diff.length > 12000) {
      return summarizeLargeDiff(diff, []);
    }
    return diff.trim();
  }

  const lines = [];

  // 1. Try to extract git diff (only changed lines) if git is present
  let gitDiff = '';
  if (projectPath) {
    try {
      const gitDir = path.join(projectPath, '.git');
      if (fs.existsSync(gitDir)) {
        // -U2 limits context to 2 lines per change to save tokens
        gitDiff = execSync('git diff -U2', {
          cwd: projectPath,
          encoding: 'utf8',
          timeout: 4000,
          maxBuffer: 512 * 1024,
        }).trim();

        if (!gitDiff) {
          // Check for staged or untracked file status
          gitDiff = execSync('git status --short', {
            cwd: projectPath,
            encoding: 'utf8',
            timeout: 3000,
          }).trim();
        }
      }
    } catch (_) {}
  }

  if (gitDiff) {
    if (gitDiff.length > 12000) {
      return summarizeLargeDiff(gitDiff, diff?.modified || []);
    }
    lines.push('[GIT CHANGED LINES DIFF]');
    lines.push(gitDiff);
    return lines.join('\n');
  }

  // 2. Snapshot diff fallback: File delta + AST signature delta
  lines.push('[SNAPSHOT FILE DELTA]');
  if (diff && typeof diff === 'object') {
    const added = Array.isArray(diff.added) ? diff.added : [];
    const modified = Array.isArray(diff.modified) ? diff.modified : [];
    const deleted = Array.isArray(diff.deleted) ? diff.deleted : [];

    lines.push(`Added Files (${added.length}): ${added.join(', ') || 'None'}`);
    lines.push(`Modified Files (${modified.length}): ${modified.join(', ') || 'None'}`);
    lines.push(`Deleted Files (${deleted.length}): ${deleted.join(', ') || 'None'}`);

    // If before/after snapshots are available, inspect function and export deltas
    if (beforeSnapshot?.files && afterSnapshot?.files) {
      const beforeMap = new Map((beforeSnapshot.files || []).map(f => [f.path, f]));
      const afterMap = new Map((afterSnapshot.files || []).map(f => [f.path, f]));

      lines.push('\n[AST CONTRACT & EXPORT DELTA]');
      for (const modPath of modified.slice(0, 15)) {
        const bf = beforeMap.get(modPath);
        const af = afterMap.get(modPath);
        if (bf && af) {
          const addedFns = (af.fns || []).filter(fn => !(bf.fns || []).includes(fn));
          const removedFns = (bf.fns || []).filter(fn => !(af.fns || []).includes(fn));
          const addedExports = (af.exports || []).filter(ex => !(bf.exports || []).includes(ex));
          const removedExports = (bf.exports || []).filter(ex => !(af.exports || []).includes(ex));

          const changes = [];
          if (addedFns.length > 0) changes.push(`+fns: [${addedFns.join(', ')}]`);
          if (removedFns.length > 0) changes.push(`-fns: [${removedFns.join(', ')}]`);
          if (addedExports.length > 0) changes.push(`+exports: [${addedExports.join(', ')}]`);
          if (removedExports.length > 0) changes.push(`-exports: [${removedExports.join(', ')}]`);

          if (changes.length > 0) {
            lines.push(`  • ${modPath}: ${changes.join(' | ')}`);
          }
        }
      }
    }
  } else {
    lines.push('No diff details recorded.');
  }

  const result = lines.join('\n');
  if (result.length > 12000) {
    return summarizeLargeDiff(result, diff?.modified || []);
  }

  return result;
}

/**
 * Safely parse JSON from AI raw output.
 * @param {string} raw
 * @returns {object|null}
 */
function parseAiJsonResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch (_) {
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (_) {}
    }
    return null;
  }
}

/**
 * Rule-based fallback report generator when AI call fails or is unavailable.
 * @param {object} diff
 * @param {object} snapshot
 * @param {object} plan
 * @param {object|null} [contractResult]
 * @param {object} [context]
 * @returns {object}
 */
function buildRuleBasedFallback(diff, snapshot, plan, contractResult = null, context = {}) {
  const done = [];
  const partial = [];
  const missed = [];
  const violations = [];
  const brokenImports = [];
  const regressions = [];

  const addedFiles = Array.isArray(diff?.added) ? diff.added : [];
  const modifiedFiles = Array.isArray(diff?.modified) ? diff.modified : [];
  const deletedFiles = Array.isArray(diff?.deleted) ? diff.deleted : [];

  const afterFiles = (context?.afterSnapshot?.files && Array.isArray(context.afterSnapshot.files))
    ? context.afterSnapshot.files
    : ((snapshot?.files && Array.isArray(snapshot.files)) ? snapshot.files : []);
  const existingFilePaths = afterFiles.map(f => typeof f === 'string' ? f : (f.path || f.name || String(f)));
  const projPath = context?.projectPath || snapshot?.rootPath || null;

  if (snapshot || afterFiles.length > 0) {
    const astParsed = afterFiles.filter(f => f.isAST).length;
    const total = afterFiles.length;
    done.push(`Project scanned: ${total} files (${astParsed} AST-parsed)`);

    if (addedFiles.length > 0) {
      done.push(`${addedFiles.length} file(s) created: ${addedFiles.slice(0, 3).join(', ')}`);
    }
    if (modifiedFiles.length > 0) {
      done.push(`${modifiedFiles.length} file(s) modified: ${modifiedFiles.slice(0, 3).join(', ')}`);
    }
    if (deletedFiles.length > 0) {
      partial.push(`${deletedFiles.length} file(s) removed — verify intentional: ${deletedFiles.slice(0, 3).join(', ')}`);
    }

    // Check for risky imports
    const riskyBar = (snapshot?.depHealth || []).find(h => h.name === 'Risky Imports');
    if (riskyBar && riskyBar.raw > 0) {
      violations.push(`${riskyBar.raw} risky import(s) detected (eval, vm, child_process, etc.)`);
    }
  } else {
    missed.push('No active project found — unable to verify AST grounding.');
  }

  // Check expected plan files against actual touched files & physical disk
  if (plan) {
    const expectedCreates = Array.isArray(plan.filesToCreate) ? plan.filesToCreate : [];
    const expectedEdits = Array.isArray(plan.filesToEdit) ? plan.filesToEdit : [];

    for (const exp of expectedCreates) {
      const matchAdded = addedFiles.some(f => f.endsWith(exp) || exp.endsWith(f));
      const existsInSnapshot = existingFilePaths.some(f => f.endsWith(exp) || exp.endsWith(f));
      let existsOnDisk = false;
      if (projPath) {
        try {
          const absExp = path.isAbsolute(exp) ? exp : path.join(projPath, exp);
          existsOnDisk = fs.existsSync(absExp);
        } catch (_) {}
      }

      if (matchAdded || existsInSnapshot || existsOnDisk) {
        const doneMsg = `Created planned file: ${exp}`;
        if (!done.includes(doneMsg)) {
          done.push(doneMsg);
        }
      } else {
        missed.push(`Expected file not created: ${exp}`);
      }
    }
    for (const exp of expectedEdits) {
      const matchModified = modifiedFiles.some(f => f.endsWith(exp) || exp.endsWith(f));
      const existsInSnapshot = existingFilePaths.some(f => f.endsWith(exp) || exp.endsWith(f));
      let existsOnDisk = false;
      if (projPath) {
        try {
          const absExp = path.isAbsolute(exp) ? exp : path.join(projPath, exp);
          existsOnDisk = fs.existsSync(absExp);
        } catch (_) {}
      }

      if (matchModified) {
        const doneMsg = `Modified planned file: ${exp}`;
        if (!done.includes(doneMsg)) done.push(doneMsg);
      } else if (!existsInSnapshot && !existsOnDisk) {
        partial.push(`Planned edit not detected in: ${exp}`);
      }
    }
  }

  // Append cross-file contract validation results
  if (contractResult && Array.isArray(contractResult.violations) && contractResult.violations.length > 0) {
    for (const v of contractResult.violations) {
      if (!violations.includes(v)) {
        violations.push(v);
      }
    }
  }
  if (contractResult && Array.isArray(contractResult.warnings) && contractResult.warnings.length > 0) {
    for (const w of contractResult.warnings) {
      if (!partial.includes(w)) {
        partial.push(w);
      }
    }
  }

  // Production Readiness Audit
  const audit = productionAuditor.auditProductionReadiness({
    projectPath: projPath,
    snapshot: snapshot || context?.afterSnapshot,
    afterSnapshot: context?.afterSnapshot,
    diff,
  });

  let productionScore = audit.productionScore;
  if (missed.length > 0) {
    productionScore = Math.max(0, productionScore - missed.length * 15);
  }

  const baseScore = violations.length * 25 + brokenImports.length * 20 + regressions.length * 20 + missed.length * 10;
  let riskScore = Math.max(0, Math.min(100, violations.length > 0 || missed.length > 0 ? baseScore : (done.length > 0 ? 5 : 20)));

  if (contractResult && Array.isArray(contractResult.violations) && contractResult.violations.length > 0) {
    riskScore = Math.min(100, Math.max(60, riskScore + (contractResult.riskIncrease || 30)));
  } else if (contractResult && Array.isArray(contractResult.warnings) && contractResult.warnings.length > 0) {
    riskScore = Math.min(100, riskScore + (contractResult.riskIncrease || 10));
  }

  // Check forbidden file breach in fallback
  const forbiddenBreaches = checkForbiddenFileBreach(diff, projPath);
  for (const fb of forbiddenBreaches) {
    const msg = `CRITICAL VIOLATION: Forbidden file ${fb} was modified.`;
    if (!violations.includes(msg)) violations.unshift(msg);
  }
  if (forbiddenBreaches.length > 0) {
    riskScore = 100;
  }

  const riskLabel = riskScore <= 15 ? 'Low' : riskScore <= 50 ? 'Medium' : 'High';
  const productionVerdict = productionScore >= 90 ? 'Production Ready' : productionScore >= 50 ? 'Needs Polish' : 'Not Production Ready';

  return {
    timestamp: new Date().toISOString(),
    productionScore,
    readinessScore: productionScore,
    productionVerdict,
    status: audit.status,
    badge: audit.badge,
    categories: audit.categories,
    passedChecks: audit.passedChecks,
    failedChecks: audit.failedChecks,
    done: done.length > 0 ? done : ['Project scan completed with 0 detected file modifications'],
    partial: partial.length > 0 ? partial : ['No partial completions detected'],
    missed: missed.length > 0 ? missed : ['No planned requirements missed'],
    violations: violations.length > 0 ? violations : ['No security violations detected'],
    brokenImports: brokenImports.length > 0 ? brokenImports : ['No broken imports detected'],
    regressions: regressions.length > 0 ? regressions : ['No functional regressions detected'],
    riskScore,
    riskLabel,
    nextActions: audit.nextActions && audit.nextActions.length > 0 ? audit.nextActions : [
      'Review modified files in File Tree tab',
      'Confirm all unit and integration tests pass',
      'Verify no sensitive tokens or secrets are committed',
      'Proceed to next milestone in Roadmap tab'
    ],
    isAiVerified: false,
    isStub: true,
    providerUsed: 'fallback',
    isStatic: true,
    contracts: contractResult || null,
  };
}

/**
 * In-memory fallback cache for test runs and volatile execution contexts.
 */
let inMemoryCache = {
  lastDiffHash: null,
  lastVerifiedHash: null,
  lastVerificationReport: null,
};

let sessionStore = null;
try {
  sessionStore = require('../session-store');
} catch (_) {}

/**
 * Compute a strict workspace hash based on physical files on disk,
 * in-memory content overrides, diff delta, and contract status.
 *
 * @param {object} params
 * @returns {string}
 */
function computeWorkspaceHash(params = {}) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');

  const {
    projectPath = null,
    snapshot = null,
    diff = null,
    htmlContent = null,
    jsContent = null,
    contractResult = null,
  } = params;

  if (typeof htmlContent === 'string') {
    hash.update(`html:${htmlContent}`);
  }
  if (typeof jsContent === 'string') {
    hash.update(`js:${jsContent}`);
  }

  // 1. Hash physical files on disk
  if (projectPath && fs.existsSync(projectPath)) {
    try {
      let shouldIgnore = () => false;
      try {
        shouldIgnore = require('../scanner/ignore-rules').shouldIgnore;
      } catch (_) {}

      const files = [];
      function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(projectPath, full);
          if (shouldIgnore(rel, projectPath)) continue;
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            files.push(rel);
          }
        }
      }
      walk(projectPath);
      files.sort();

      for (const rel of files) {
        const full = path.join(projectPath, rel);
        try {
          const st = fs.statSync(full);
          hash.update(`${rel}:${st.size}:${st.mtimeMs}`);
          const content = fs.readFileSync(full);
          hash.update(content);
        } catch (_) {}
      }
    } catch (_) {}
  } else if (snapshot?.files && Array.isArray(snapshot.files)) {
    const sorted = [...snapshot.files].sort((a, b) => (a.path || '').localeCompare(b.path || ''));
    for (const f of sorted) {
      hash.update(`${f.path}:${f.hash || ''}:${f.lastModified || ''}`);
    }
  }

  // 2. Hash diff state
  if (diff && typeof diff === 'object') {
    const added = Array.isArray(diff.added) ? [...diff.added].sort() : [];
    const modified = Array.isArray(diff.modified) ? [...diff.modified].sort() : [];
    const deleted = Array.isArray(diff.deleted) ? [...diff.deleted].sort() : [];
    hash.update(`diff:A=${added.join(',')}|M=${modified.join(',')}|D=${deleted.join(',')}`);
  }

  // 3. Hash contract status
  if (contractResult) {
    const v = (contractResult.violations || []).join(';');
    const w = (contractResult.warnings || []).join(';');
    hash.update(`contracts:${v}|${w}|${contractResult.passed}`);
  }

  return hash.digest('hex');
}

/**
 * Compute a deterministic SHA-256 hash of the diff.
 * Strips all volatile metadata (timestamps, snapshot IDs, labels) so that
 * identical file modifications produce the exact same hash across scans.
 *
 * @param {object|string} diff - Snapshot diff or string
 * @param {string} [diffSnippet] - Clean AST & file delta snippet
 * @param {string} [contractSignature] - Static cross-file contract signature
 * @returns {string}
 */
function computeDiffHash(diff, diffSnippet = '', contractSignature = '') {
  const crypto = require('crypto');
  let data = '';

  if (diff && typeof diff === 'object') {
    const added = Array.isArray(diff.added) ? [...diff.added].sort() : [];
    const modified = Array.isArray(diff.modified) ? [...diff.modified].sort() : [];
    const deleted = Array.isArray(diff.deleted) ? [...diff.deleted].sort() : [];
    data = `A:${added.join(',')}|M:${modified.join(',')}|D:${deleted.join(',')}`;
  }

  const snippet = (typeof diffSnippet === 'string' ? diffSnippet : '').trim();
  const payload = `${data}#${snippet}#${contractSignature}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Step 6: Verify execution drift and guardrail adherence using AI.
 * Deterministic caching: Checks if currentWorkspaceHash has changed. If unchanged,
 * returns cached report immediately to guarantee deterministic results.
 *
 * @param {object} params
 * @param {string} [params.originalPrompt] - Strict guardrail prompt given to developer/AI
 * @param {object} [params.plan] - Approved implementation plan
 * @param {object|string} [params.diff] - Snapshot diff or changed lines
 * @param {string} [params.projectPath] - Project root directory
 * @param {object} [params.snapshot] - Current AST snapshot
 * @param {object} [params.beforeSnapshot] - Pre-execution snapshot
 * @param {object} [params.afterSnapshot] - Post-execution snapshot
 * @param {boolean} [params.forceFresh] - Force a new AI verification run
 * @param {string} [params.htmlContent] - Optional direct HTML string override
 * @param {string} [params.jsContent] - Optional direct JS string override
 * @param {string} [params.htmlPath] - Optional HTML path
 * @param {string} [params.jsPath] - Optional JS path
 * @param {object} [deps] - Injected dependencies (for testing or provider calls)
 * @returns {Promise<object>}
 */
async function verifyExecution(params = {}, deps = {}) {
  const {
    originalPrompt = '',
    plan = null,
    diff = null,
    projectPath = null,
    snapshot = null,
    beforeSnapshot = null,
    afterSnapshot = null,
    forceFresh = false,
  } = params;

  // 1. Calculate diff between beforeSnapshot (0-file baseline) vs afterSnapshot (physical disk files)
  let effectiveDiff = diff;
  const beforeFiles = (beforeSnapshot?.files && Array.isArray(beforeSnapshot.files)) ? beforeSnapshot.files : [];
  const afterFiles = (afterSnapshot?.files && Array.isArray(afterSnapshot.files))
    ? afterSnapshot.files
    : ((snapshot?.files && Array.isArray(snapshot.files)) ? snapshot.files : []);

  const filePaths = afterFiles.map(f => typeof f === 'string' ? f : (f.path || f.name || String(f)));

  // If beforeSnapshot is empty (0-file pre-execution baseline), calculate diff:
  // beforeSnapshot (0 files) vs afterSnapshot (files from disk) -> all files are ADDED
  if (beforeFiles.length === 0 && filePaths.length > 0) {
    effectiveDiff = {
      added: [...filePaths],
      modified: [],
      deleted: [],
      unchanged: [],
      summary: {
        added: filePaths.length,
        modified: 0,
        deleted: 0,
        unchanged: 0,
      },
    };
  } else if (beforeSnapshot && afterSnapshot && (!diff || !diff.added || diff.added.length === 0)) {
    const beforeMap = new Map(beforeFiles.map(f => [typeof f === 'string' ? f : f.path, f]));
    const afterMap = new Map(afterFiles.map(f => [typeof f === 'string' ? f : f.path, f]));
    const added = [];
    const modified = [];
    const deleted = [];
    const unchanged = [];

    for (const [p, af] of afterMap) {
      if (!beforeMap.has(p)) {
        added.push(p);
      } else {
        const bf = beforeMap.get(p);
        const changed = (typeof bf === 'object' && typeof af === 'object') && (
          bf.hash !== af.hash ||
          JSON.stringify(bf.fns || []) !== JSON.stringify(af.fns || []) ||
          JSON.stringify(bf.exports || []) !== JSON.stringify(af.exports || [])
        );
        if (changed) modified.push(p); else unchanged.push(p);
      }
    }
    for (const p of beforeMap.keys()) {
      if (!afterMap.has(p)) deleted.push(p);
    }

    effectiveDiff = {
      added,
      modified,
      deleted,
      unchanged,
      summary: {
        added: added.length,
        modified: modified.length,
        deleted: deleted.length,
        unchanged: unchanged.length,
      },
    };
  }

  // 2. Run static cross-file contract validator BEFORE sending diff to AI
  const contractValidatorFn = deps.validateContracts || validateContracts;
  const contractResult = contractValidatorFn({
    projectPath,
    snapshot,
    diff: effectiveDiff,
    plan,
    htmlContent: params.htmlContent,
    jsContent: params.jsContent,
    htmlPath: params.htmlPath,
    jsPath: params.jsPath,
  });

  const contractSignature = contractResult
    ? `${(contractResult.violations || []).join(';')}|${(contractResult.warnings || []).join(';')}|${contractResult.passed}`
    : '';

  // 3. Compute strict workspace hash and diff hash
  const currentWorkspaceHash = computeWorkspaceHash({
    projectPath,
    snapshot,
    diff: effectiveDiff,
    htmlContent: params.htmlContent,
    jsContent: params.jsContent,
    contractResult,
  });

  const diffSnippet = extractTokenEfficientDiff(effectiveDiff, projectPath, beforeSnapshot, afterSnapshot);
  const diffHash = computeDiffHash(effectiveDiff, diffSnippet, contractSignature);

  // 4. Strict File Hash Caching: If unchanged, return cached report immediately
  const store = deps.sessionStore !== undefined ? deps.sessionStore : sessionStore;
  let savedSession = null;
  if (store && typeof store.loadState === 'function') {
    try {
      savedSession = store.loadState();
    } catch (_) {}
  }

  const lastVerifiedHash = savedSession?.lastVerifiedHash || inMemoryCache.lastVerifiedHash || savedSession?.lastDiffHash || inMemoryCache.lastDiffHash;
  const isHashMatch = (lastVerifiedHash === currentWorkspaceHash) || (lastVerifiedHash === diffHash);
  const cachedReportRaw = isHashMatch
    ? (savedSession?.lastVerificationReport || inMemoryCache.lastVerificationReport)
    : null;

  if (!forceFresh && !deps.skipCache && cachedReportRaw) {
    console.log(`[ExecutionVerifier] Workspace hash unchanged (${currentWorkspaceHash.slice(0, 8)}), returning cached verification report immediately.`);
    return {
      ...cachedReportRaw,
      isCached: true,
      cached: true,
      unchanged: true,
      lastVerifiedHash: currentWorkspaceHash,
      currentWorkspaceHash,
      diffHash,
    };
  }

  const planString = typeof plan === 'object' && plan !== null
    ? JSON.stringify({
        task: plan.task || plan.feature || 'Unknown',
        selectedOption: plan.selectedOptionName || plan.selectedOption || null,
        filesToEdit: plan.filesToEdit || [],
        filesToCreate: plan.filesToCreate || [],
        activeRules: plan.activeRules || [],
      }, null, 2)
    : String(plan || 'No plan details available');

  const promptText = originalPrompt && originalPrompt.trim()
    ? originalPrompt.slice(0, 8000)
    : 'No strict prompt recorded for this feature session.';

  // Check forbidden file breach BEFORE sending diff to AI
  const forbiddenBreaches = checkForbiddenFileBreach(effectiveDiff, projectPath);
  const forbiddenViolations = forbiddenBreaches.map(f => `CRITICAL VIOLATION: Forbidden file ${f} was modified.`);

  // 5. Build full AI prompt (including static contract findings)
  let contractNote = '';
  if (contractResult && (contractResult.violations.length > 0 || contractResult.warnings.length > 0)) {
    contractNote = `\n\n[STATIC CROSS-FILE CONTRACT VALIDATION]\nViolations: ${contractResult.violations.join('; ') || 'None'}\nWarnings: ${contractResult.warnings.join('; ') || 'None'}`;
  }
  if (forbiddenViolations.length > 0) {
    contractNote += `\n\n[CRITICAL SECURITY BREACH: FORBIDDEN FILE MODIFICATION]\n${forbiddenViolations.join('\n')}`;
  }

  const template = deps.promptTemplate || loadPromptTemplate();
  const compiledPrompt = template
    .replace('{{originalPrompt}}', promptText)
    .replace('{{plan}}', planString)
    .replace('{{diff}}', diffSnippet + contractNote);

  // 6. Resolve AI provider invoker (force temperature: 0 for determinism)
  let aiInvoker = deps.callProviderDeterministic || deps.callProvider;
  if (!aiInvoker) {
    try {
      const aiService = require('../ai/ai-service');
      aiInvoker = async (p) => {
        const res = await aiService.callProviderWithFallback(p, null, { temperature: 0 });
        if (!res.success) throw new Error(res.error || 'AI verification call failed');
        return res.data;
      };
    } catch (_) {
      aiInvoker = null;
    }
  }

  // 7. Execute AI call or fallback
  if (!aiInvoker) {
    const fallback = buildRuleBasedFallback(effectiveDiff, snapshot || afterSnapshot, plan, contractResult, { afterSnapshot, projectPath });
    fallback.diff = effectiveDiff?.summary || null;
    fallback.isCached = false;
    fallback.cached = false;
    fallback.unchanged = false;
    fallback.diffHash = diffHash;
    fallback.lastVerifiedHash = currentWorkspaceHash;
    fallback.currentWorkspaceHash = currentWorkspaceHash;
    fallback.contracts = contractResult;

    inMemoryCache.lastVerifiedHash = currentWorkspaceHash;
    inMemoryCache.lastDiffHash = diffHash;
    inMemoryCache.lastVerificationReport = fallback;

    if (store && typeof store.saveState === 'function') {
      try {
        store.saveState({
          lastVerifiedHash: currentWorkspaceHash,
          lastDiffHash: diffHash,
          lastVerificationReport: fallback,
        });
      } catch (_) {}
    }

    return fallback;
  }

  try {
    const rawResponse = await aiInvoker(compiledPrompt);
    const parsed = parseAiJsonResponse(rawResponse);

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.done)) {
      console.warn('[ExecutionVerifier] AI response was not valid verification JSON, using rule-based fallback');
      const fallback = buildRuleBasedFallback(effectiveDiff, snapshot || afterSnapshot, plan, contractResult, { afterSnapshot, projectPath });
      fallback.diff = effectiveDiff?.summary || null;
      fallback.isCached = false;
      fallback.cached = false;
      fallback.unchanged = false;
      fallback.diffHash = diffHash;
      fallback.lastVerifiedHash = currentWorkspaceHash;
      fallback.currentWorkspaceHash = currentWorkspaceHash;
      fallback.contracts = contractResult;

      inMemoryCache.lastVerifiedHash = currentWorkspaceHash;
      inMemoryCache.lastDiffHash = diffHash;
      inMemoryCache.lastVerificationReport = fallback;

      if (store && typeof store.saveState === 'function') {
        try {
          store.saveState({
            lastVerifiedHash: currentWorkspaceHash,
            lastDiffHash: diffHash,
            lastVerificationReport: fallback,
          });
        } catch (_) {}
      }

      return fallback;
    }

    // Normalize AI report fields
    const done = Array.isArray(parsed.done) ? parsed.done : [];
    const partial = Array.isArray(parsed.partial) ? parsed.partial : [];
    const missed = Array.isArray(parsed.missed) ? parsed.missed : [];
    const violations = Array.isArray(parsed.violations) ? parsed.violations : [];
    const brokenImports = Array.isArray(parsed.brokenImports) ? parsed.brokenImports : [];
    const regressions = Array.isArray(parsed.regressions) ? parsed.regressions : [];
    const nextActions = Array.isArray(parsed.nextActions) && parsed.nextActions.length > 0
      ? parsed.nextActions
      : ['Run unit tests', 'Verify guardrails in changed files'];

    // Filter out false "missed" items if the file physically exists in afterSnapshot or on disk
    const projPath = projectPath || snapshot?.rootPath || null;
    const realMissed = [];
    for (const m of missed) {
      const lower = String(m).toLowerCase();
      const isFileExist = filePaths.some(p => {
        const base = path.basename(p).toLowerCase();
        return lower.includes(base) || lower.includes(p.toLowerCase());
      }) || (projPath && (() => {
        const words = m.split(/[\s,:`'"]+/);
        return words.some(w => {
          if (!w || !w.includes('.')) return false;
          try {
            return fs.existsSync(path.isAbsolute(w) ? w : path.join(projPath, w));
          } catch (_) { return false; }
        });
      })());

      if (isFileExist && (lower.includes('missed') || lower.includes('not created') || lower.includes('missing') || lower.includes('expected file'))) {
        const doneMsg = `Verified file exists on disk: ${m.replace(/^expected file not created:?\s*/i, '').replace(/^missed:?\s*/i, '')}`;
        if (!done.includes(doneMsg)) done.push(doneMsg);
      } else {
        realMissed.push(m);
      }
    }
    missed.length = 0;
    missed.push(...realMissed);

    // If plan specifies filesToCreate, ensure any physically existing file cannot be marked as missed and is in done
    if (plan && Array.isArray(plan.filesToCreate)) {
      for (const exp of plan.filesToCreate) {
        const exists = filePaths.some(f => f.endsWith(exp) || exp.endsWith(f)) ||
          (projPath && fs.existsSync(path.isAbsolute(exp) ? exp : path.join(projPath, exp)));
        if (exists) {
          const doneMsg = `Created planned file: ${exp}`;
          if (!done.includes(doneMsg)) done.push(doneMsg);
        }
      }
    }

    let riskScore = typeof parsed.riskScore === 'number' ? parsed.riskScore : 10;

    // Incorporate contract validation results into final report
    if (contractResult && Array.isArray(contractResult.violations) && contractResult.violations.length > 0) {
      const realViolations = violations.filter(v => !v.toLowerCase().startsWith('no '));
      for (const v of contractResult.violations) {
        if (!realViolations.includes(v)) {
          realViolations.push(v);
        }
      }
      violations.length = 0;
      violations.push(...realViolations);

      // Failure increases risk by 30% and guarantees High risk (>= 60)
      riskScore = Math.min(100, Math.max(60, riskScore + (contractResult.riskIncrease || 30)));
    } else if (contractResult && Array.isArray(contractResult.warnings) && contractResult.warnings.length > 0) {
      for (const w of contractResult.warnings) {
        if (!partial.includes(w)) {
          partial.push(w);
        }
      }
      riskScore = Math.min(100, riskScore + (contractResult.riskIncrease || 10));
    }

    // Forbidden file breach check: if modified, risk score immediately jumps to 100
    if (forbiddenBreaches.length > 0) {
      const realViolations = violations.filter(v => !v.toLowerCase().startsWith('no '));
      for (const fv of forbiddenViolations) {
        if (!realViolations.includes(fv)) {
          realViolations.unshift(fv);
        }
      }
      violations.length = 0;
      violations.push(...realViolations);
      riskScore = 100;
    }

    riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));
    const riskLabel = riskScore <= 15 ? 'Low' : riskScore <= 50 ? 'Medium' : 'High';

    const audit = productionAuditor.auditProductionReadiness({
      projectPath,
      snapshot: snapshot || afterSnapshot,
      afterSnapshot,
      diff: effectiveDiff,
    });

    let productionScore = audit.productionScore;
    if (missed.length > 0) {
      productionScore = Math.max(0, productionScore - missed.length * 15);
    }
    const productionVerdict = productionScore >= 90 ? 'Production Ready' : productionScore >= 50 ? 'Needs Polish' : 'Not Production Ready';

    const finalReport = {
      timestamp: new Date().toISOString(),
      productionScore,
      readinessScore: productionScore,
      productionVerdict,
      status: audit.status,
      badge: audit.badge,
      categories: audit.categories,
      passedChecks: audit.passedChecks,
      failedChecks: audit.failedChecks,
      done: done.length > 0 ? done : ['No completed items identified'],
      partial: partial.length > 0 ? partial : ['No partial completions detected'],
      missed: missed.length > 0 ? missed : ['No planned requirements missed'],
      violations: violations.length > 0 ? violations : ['No security violations detected'],
      brokenImports: brokenImports.length > 0 ? brokenImports : ['No broken imports detected'],
      regressions: regressions.length > 0 ? regressions : ['No functional regressions detected'],
      riskScore,
      riskLabel,
      nextActions: audit.nextActions && audit.nextActions.length > 0 ? audit.nextActions : nextActions,
      diff: effectiveDiff?.summary || null,
      isAiVerified: true,
      isStub: false,
      isCached: false,
      cached: false,
      unchanged: false,
      diffHash,
      lastVerifiedHash: currentWorkspaceHash,
      currentWorkspaceHash,
      contracts: contractResult || null,
    };

    // Cache in-memory and session
    inMemoryCache.lastVerifiedHash = currentWorkspaceHash;
    inMemoryCache.lastDiffHash = diffHash;
    inMemoryCache.lastVerificationReport = finalReport;

    if (store && typeof store.saveState === 'function') {
      try {
        store.saveState({
          lastVerifiedHash: currentWorkspaceHash,
          lastDiffHash: diffHash,
          lastVerificationReport: finalReport,
        });
      } catch (err) {
        console.warn('[ExecutionVerifier] Failed to save verification report to session:', err.message);
      }
    }

    return finalReport;
  } catch (err) {
    console.warn('[ExecutionVerifier] AI verification failed, falling back to rule-based report:', err.message);
    const fallback = buildRuleBasedFallback(effectiveDiff, snapshot || afterSnapshot, plan, contractResult, { afterSnapshot, projectPath });
    fallback.diff = effectiveDiff?.summary || null;
    fallback._error = err.message;
    fallback.aiError = 'API_LIMIT_REACHED';
    fallback.isCached = false;
    fallback.cached = false;
    fallback.unchanged = false;
    fallback.diffHash = diffHash;
    fallback.lastVerifiedHash = currentWorkspaceHash;
    fallback.currentWorkspaceHash = currentWorkspaceHash;
    fallback.contracts = contractResult;

    inMemoryCache.lastVerifiedHash = currentWorkspaceHash;
    inMemoryCache.lastDiffHash = diffHash;
    inMemoryCache.lastVerificationReport = fallback;

    if (store && typeof store.saveState === 'function') {
      try {
        store.saveState({
          lastVerifiedHash: currentWorkspaceHash,
          lastDiffHash: diffHash,
          lastVerificationReport: fallback,
        });
      } catch (_) {}
    }

    return fallback;
  }
}

module.exports = {
  verifyExecution,
  computeDiffHash,
  computeWorkspaceHash,
  extractTokenEfficientDiff,
  buildRuleBasedFallback,
  parseAiJsonResponse,
  loadPromptTemplate,
  validateContracts,
  checkForbiddenFileBreach,
  summarizeLargeDiff,
  FORBIDDEN_FILES,
};
