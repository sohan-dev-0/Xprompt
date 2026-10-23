/**
 * PromptLock — Production Readiness Auditor
 *
 * Evaluates the Production Readiness of the project structure and code quality:
 * 1. Architecture (30% weight): HTML, CSS, JS separation and modular layout.
 * 2. Code Quality (30% weight): JSDoc / Type annotations, unit tests, and modularity.
 * 3. Security (20% weight): Safe DOM manipulation (no raw innerHTML) and no hardcoded secrets/eval.
 * 4. Error Handling (20% weight): try-catch blocks and DOM null-check guardrails.
 *
 * Produces a deterministic Production Readiness Score (0-100%) and actionable checklist.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_CATEGORIES = {
  ARCHITECTURE: 'architecture',
  CODE_QUALITY: 'codeQuality',
  SECURITY: 'security',
  ERROR_HANDLING: 'errorHandling',
};

/**
 * Audit a project's production readiness.
 *
 * @param {object} params
 * @param {string} [params.projectPath] - Absolute root path of project
 * @param {object} [params.snapshot] - AST snapshot
 * @param {object} [params.afterSnapshot] - Post-execution snapshot
 * @param {Array<string>} [params.files] - Optional explicit file list
 * @returns {object} Production readiness audit report
 */
function auditProductionReadiness(params = {}) {
  const projectPath = params.projectPath || params.snapshot?.rootPath || null;
  const snapshot = params.afterSnapshot || params.snapshot || null;

  // 1. Collect all project files
  const fileMap = new Map(); // relativePath -> content

  if (projectPath && fs.existsSync(projectPath)) {
    try {
      function scanDir(dir, rel = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const name = entry.name;
          if (name.startsWith('.') || name === 'node_modules' || name === 'userData' || name === 'dist' || name === 'build') {
            continue;
          }
          const fullPath = path.join(dir, name);
          const relPath = rel ? path.join(rel, name) : name;
          if (entry.isDirectory()) {
            scanDir(fullPath, relPath);
          } else if (entry.isFile()) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              fileMap.set(relPath, content);
            } catch (_) {}
          }
        }
      }
      scanDir(projectPath);
    } catch (_) {}
  }

  // Fallback to snapshot files if physical disk returned no files
  if (fileMap.size === 0 && snapshot?.files && Array.isArray(snapshot.files)) {
    for (const f of snapshot.files) {
      const relPath = typeof f === 'string' ? f : (f.path || f.name || '');
      if (relPath) {
        fileMap.set(relPath, f.content || '');
      }
    }
  }

  const allFilePaths = Array.from(fileMap.keys());
  const htmlFiles = allFilePaths.filter(f => f.endsWith('.html'));
  const cssFiles = allFilePaths.filter(f => f.endsWith('.css') || f.endsWith('.scss') || f.endsWith('.sass'));
  const jsFiles = allFilePaths.filter(f => (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.ts')) && !isTestFile(f));
  const testFiles = allFilePaths.filter(f => isTestFile(f));

  // Category Check Collections
  const passedChecks = [];
  const failedChecks = [];
  const nextActions = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. ARCHITECTURE (30% Weight)
  // ─────────────────────────────────────────────────────────────────────────────
  let archScore = 0;
  const archChecks = [];

  // Check A1: File Separation (15 pts)
  const isSeparated = (htmlFiles.length > 0 && (cssFiles.length > 0 || jsFiles.length > 0)) ||
    (allFilePaths.length > 1 && !htmlFiles.some(h => isMonolithicHtml(fileMap.get(h) || '')));

  const isSingleFileHtml = htmlFiles.length === 1 && cssFiles.length === 0 && jsFiles.length === 0;

  if (!isSingleFileHtml && isSeparated) {
    archScore += 15;
    const item = {
      id: 'arch-separation',
      category: AUDIT_CATEGORIES.ARCHITECTURE,
      name: 'Separation of Concerns',
      passed: true,
      points: 15,
      maxPoints: 15,
      detail: `Clean separation verified (${htmlFiles.length} HTML, ${cssFiles.length} CSS, ${jsFiles.length} JS files)`,
    };
    archChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'arch-separation',
      category: AUDIT_CATEGORIES.ARCHITECTURE,
      name: 'Separation of Concerns',
      passed: false,
      points: 0,
      maxPoints: 15,
      detail: 'Monolithic single-file project. CSS and JS are not separated from HTML.',
    };
    archChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Separate HTML, CSS, and JS: Extract inline styles into style.css and scripts into app.js');
  }

  // Check A2: Project Structure & Organization (15 pts)
  const hasModularFolders = allFilePaths.some(p => p.includes('/') || p.includes('\\'));
  const hasMultipleCleanFiles = allFilePaths.length >= 3 && !isSingleFileHtml;

  if (hasModularFolders || hasMultipleCleanFiles) {
    archScore += 15;
    const item = {
      id: 'arch-structure',
      category: AUDIT_CATEGORIES.ARCHITECTURE,
      name: 'Modular Project Structure',
      passed: true,
      points: 15,
      maxPoints: 15,
      detail: hasModularFolders ? 'Dedicated folder structure detected' : 'Standard multi-file modular layout detected',
    };
    archChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'arch-structure',
      category: AUDIT_CATEGORIES.ARCHITECTURE,
      name: 'Modular Project Structure',
      passed: false,
      points: 0,
      maxPoints: 15,
      detail: 'Flat or single-file layout without modular folder organization.',
    };
    archChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Organize code into modular directories (e.g. src/, components/, styles/)');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. CODE QUALITY (30% Weight)
  // ─────────────────────────────────────────────────────────────────────────────
  let qualityScore = 0;
  const qualityChecks = [];

  // Check Q1: JSDoc / Type Annotations (10 pts)
  let hasJsDoc = false;
  for (const jsPath of jsFiles) {
    const content = fileMap.get(jsPath) || '';
    if (/\/\*\*[\s\S]*?@(param|returns?|type|typedef|property)[\s\S]*?\*\//i.test(content) ||
        /\/\*\*[\s\S]*?\*\//.test(content) && content.includes('@')) {
      hasJsDoc = true;
      break;
    }
  }

  if (hasJsDoc) {
    qualityScore += 10;
    const item = {
      id: 'quality-jsdoc',
      category: AUDIT_CATEGORIES.CODE_QUALITY,
      name: 'JSDoc & Type Annotations',
      passed: true,
      points: 10,
      maxPoints: 10,
      detail: 'JSDoc type annotations found on functions and components',
    };
    qualityChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'quality-jsdoc',
      category: AUDIT_CATEGORIES.CODE_QUALITY,
      name: 'JSDoc & Type Annotations',
      passed: false,
      points: 0,
      maxPoints: 10,
      detail: 'Missing JSDoc parameter/return type documentation in JavaScript files.',
    };
    qualityChecks.push(item);
    failedChecks.push(item);
    const targetJs = jsFiles[0] || 'app.js';
    nextActions.push(`Add JSDoc (@param, @returns) annotations to functions in ${targetJs}`);
  }

  // Check Q2: Automated Unit Tests (10 pts)
  const hasTests = testFiles.length > 0;
  if (hasTests) {
    qualityScore += 10;
    const item = {
      id: 'quality-tests',
      category: AUDIT_CATEGORIES.CODE_QUALITY,
      name: 'Automated Unit Tests',
      passed: true,
      points: 10,
      maxPoints: 10,
      detail: `Automated test files present (${testFiles.join(', ')})`,
    };
    qualityChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'quality-tests',
      category: AUDIT_CATEGORIES.CODE_QUALITY,
      name: 'Automated Unit Tests',
      passed: false,
      points: 0,
      maxPoints: 10,
      detail: 'No automated test files found (e.g. test.js or app.test.js).',
    };
    qualityChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Create automated unit tests (e.g., test.js or app.test.js) to verify core logic');
  }

  // Check Q3: Modular Code Architecture (10 pts)
  let isModular = false;
  if (!isSingleFileHtml) {
    for (const jsPath of jsFiles) {
      const content = fileMap.get(jsPath) || '';
      if (/\bexport\s+(?:default|const|let|var|function|class)\b/.test(content) ||
          /\bimport\s+.*?from\b/.test(content) ||
          /\bmodule\.exports\b/.test(content) ||
          /\brequire\(/.test(content) ||
          /\(\s*function\s*\(\)\s*\{[\s\S]*?\}\s*\)\s*\(\s*\)/.test(content) ||
          /class\s+[A-Z]\w+/.test(content)) {
        isModular = true;
        break;
      }
    }
  }

  if (isModular) {
    qualityScore += 10;
    const item = {
      id: 'quality-modularity',
      category: AUDIT_CATEGORIES.CODE_QUALITY,
      name: 'Modular Architecture',
      passed: true,
      points: 10,
      maxPoints: 10,
      detail: 'Code is modularized using standard ES6/CommonJS or component patterns',
    };
    qualityChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'quality-modularity',
      category: AUDIT_CATEGORIES.CODE_QUALITY,
      name: 'Modular Architecture',
      passed: false,
      points: 0,
      maxPoints: 10,
      detail: 'Code lacks modular encapsulation (missing exports/imports or structured classes).',
    };
    qualityChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Refactor code into modular components with explicit exports and imports');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SECURITY (20% Weight)
  // ─────────────────────────────────────────────────────────────────────────────
  let securityScore = 0;
  const securityChecks = [];

  // Check S1: Safe DOM Manipulation (10 pts)
  let hasUnsafeInnerHtml = false;
  let unsafeDetail = '';

  for (const [fpath, content] of fileMap.entries()) {
    if (fpath.endsWith('.js') || fpath.endsWith('.html')) {
      // Look for .innerHTML (= or +=) with HTML strings or dynamic interpolation
      const innerHtmlMatches = content.match(/\.innerHTML\s*(\+?)=\s*([^\n;]+)/g) || [];
      for (const m of innerHtmlMatches) {
        const val = m.replace(/^\.innerHTML\s*(\+?)=\s*/, '').trim();
        // Only clearing with empty string is considered safe without sanitization
        const isClearing = val === "''" || val === '""';
        const isSanitized = /escapeHtml|sanitize|DOMPurify/i.test(val);
        if (!isClearing && !isSanitized) {
          hasUnsafeInnerHtml = true;
          unsafeDetail = `Raw innerHTML assignment detected in ${fpath}. Use textContent or DOM elements instead.`;
          break;
        }
      }
      if (/\bdocument\.write\s*\(/.test(content)) {
        hasUnsafeInnerHtml = true;
        unsafeDetail = `document.write usage in ${fpath}`;
        break;
      }
    }
  }

  if (!hasUnsafeInnerHtml) {
    securityScore += 10;
    const item = {
      id: 'security-dom',
      category: AUDIT_CATEGORIES.SECURITY,
      name: 'Safe DOM Manipulation',
      passed: true,
      points: 10,
      maxPoints: 10,
      detail: 'No raw or unsanitized innerHTML injections detected',
    };
    securityChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'security-dom',
      category: AUDIT_CATEGORIES.SECURITY,
      name: 'Safe DOM Manipulation',
      passed: false,
      points: 0,
      maxPoints: 10,
      detail: unsafeDetail || 'Direct unescaped innerHTML usage detected. Use textContent or sanitize inputs.',
    };
    securityChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Replace unsafe innerHTML assignments with textContent or sanitized DOM builders');
  }

  // Check S2: No Hardcoded Secrets & Safe Execution (10 pts)
  let hasHardcodedSecret = false;
  let secretDetail = '';

  for (const [fpath, content] of fileMap.entries()) {
    if (fpath.endsWith('.env') || fpath.includes('.env.')) continue;
    // Check for hardcoded API keys / tokens / eval
    if (/\b(?:eval|new\s+Function)\s*\(/.test(content)) {
      hasHardcodedSecret = true;
      secretDetail = `Dangerous eval() or new Function() in ${fpath}`;
      break;
    }
    if (/['"`](?:sk_live_[0-9a-zA-Z]{20,}|AIzaSy[0-9a-zA-Z\-_]{33}|ghp_[0-9a-zA-Z]{36})['"`]/.test(content)) {
      hasHardcodedSecret = true;
      secretDetail = `Hardcoded live API secret token found in ${fpath}`;
      break;
    }
  }

  if (!hasHardcodedSecret) {
    securityScore += 10;
    const item = {
      id: 'security-secrets',
      category: AUDIT_CATEGORIES.SECURITY,
      name: 'Secrets & Execution Safety',
      passed: true,
      points: 10,
      maxPoints: 10,
      detail: 'No hardcoded secrets, API tokens, or dangerous eval() statements found',
    };
    securityChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'security-secrets',
      category: AUDIT_CATEGORIES.SECURITY,
      name: 'Secrets & Execution Safety',
      passed: false,
      points: 0,
      maxPoints: 10,
      detail: secretDetail || 'Potential hardcoded secrets or eval() usage detected.',
    };
    securityChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Remove hardcoded secrets and replace dangerous eval() with safe alternatives');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. ERROR HANDLING & RESILIENCE (20% Weight)
  // ─────────────────────────────────────────────────────────────────────────────
  let errorScore = 0;
  const errorChecks = [];

  // Check E1: Exception Handling (try-catch) (10 pts)
  let hasTryCatch = false;
  for (const jsPath of jsFiles) {
    const content = fileMap.get(jsPath) || '';
    if (/\btry\s*\{[\s\S]*?\}\s*catch\b/.test(content)) {
      hasTryCatch = true;
      break;
    }
  }

  if (hasTryCatch) {
    errorScore += 10;
    const item = {
      id: 'error-try-catch',
      category: AUDIT_CATEGORIES.ERROR_HANDLING,
      name: 'Exception Handling (try-catch)',
      passed: true,
      points: 10,
      maxPoints: 10,
      detail: 'try-catch exception handling implemented for critical operations',
    };
    errorChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'error-try-catch',
      category: AUDIT_CATEGORIES.ERROR_HANDLING,
      name: 'Exception Handling (try-catch)',
      passed: false,
      points: 0,
      maxPoints: 10,
      detail: 'No try-catch blocks found for asynchronous operations or runtime exceptions.',
    };
    errorChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Wrap asynchronous requests, parsing, and storage calls in try-catch blocks');
  }

  // Check E2: DOM Element Null Guards (10 pts)
  let hasDomGuards = false;
  if (!isSingleFileHtml && jsFiles.length > 0) {
    for (const jsPath of jsFiles) {
      const content = fileMap.get(jsPath) || '';
      // Look for null checks before DOM operations: `if (!el)`, `if (el)`, `?.addEventListener`, `el && el.`
      if (/if\s*\(\s*!?\s*[\w$]+(?:El|Btn|Container|Card|List|Input|Form|Element|Node)?\s*\)/i.test(content) ||
          /\?\.(?:addEventListener|querySelector|setAttribute|classList|style)/.test(content) ||
          /[\w$]+\s*&&\s*[\w$]+\.addEventListener/.test(content)) {
        hasDomGuards = true;
        break;
      }
    }
  }

  if (hasDomGuards) {
    errorScore += 10;
    const item = {
      id: 'error-dom-guards',
      category: AUDIT_CATEGORIES.ERROR_HANDLING,
      name: 'DOM Element Null Guards',
      passed: true,
      points: 10,
      maxPoints: 10,
      detail: 'Defensive null-checks and guard clauses present before DOM interaction',
    };
    errorChecks.push(item);
    passedChecks.push(item);
  } else {
    const item = {
      id: 'error-dom-guards',
      category: AUDIT_CATEGORIES.ERROR_HANDLING,
      name: 'DOM Element Null Guards',
      passed: false,
      points: 0,
      maxPoints: 10,
      detail: 'DOM elements accessed without verifying existence or using optional chaining.',
    };
    errorChecks.push(item);
    failedChecks.push(item);
    nextActions.push('Add defensive guards (e.g. if (!element) return) before attaching listeners or mutating DOM');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COMPUTE OVERALL SCORE (0-100%)
  // ─────────────────────────────────────────────────────────────────────────────
  const totalScore = Math.max(0, Math.min(100, archScore + qualityScore + securityScore + errorScore));

  let verdict = 'Not Production Ready';
  let verdictStatus = 'red';
  let verdictBadge = 'FIX REQUIRED';

  if (totalScore >= 90) {
    verdict = 'Production Ready';
    verdictStatus = 'green';
    verdictBadge = 'Ready for Review';
  } else if (totalScore >= 50) {
    verdict = 'Needs Polish';
    verdictStatus = 'yellow';
    verdictBadge = 'Quality: Needs Polish';
  }

  return {
    productionScore: totalScore,
    readinessScore: totalScore,
    score: totalScore,
    verdict,
    status: verdictStatus,
    badge: verdictBadge,
    categories: {
      architecture: {
        score: archScore,
        maxScore: 30,
        weight: 30,
        passed: archScore >= 20,
        label: 'Architecture',
        icon: '🏗️',
        checks: archChecks,
      },
      codeQuality: {
        score: qualityScore,
        maxScore: 30,
        weight: 30,
        passed: qualityScore >= 20,
        label: 'Code Quality',
        icon: '💎',
        checks: qualityChecks,
      },
      security: {
        score: securityScore,
        maxScore: 20,
        weight: 20,
        passed: securityScore >= 15,
        label: 'Security',
        icon: '🛡️',
        checks: securityChecks,
      },
      errorHandling: {
        score: errorScore,
        maxScore: 20,
        weight: 20,
        passed: errorScore >= 15,
        label: 'Error Handling',
        icon: '⚡',
        checks: errorChecks,
      },
    },
    passedChecks,
    failedChecks,
    nextActions: nextActions.length > 0 ? nextActions : [
      'Confirm all automated unit tests pass',
      'Verify build bundle before deployment',
      'Deploy to staging environment',
    ],
    timestamp: new Date().toISOString(),
    isProductionAudit: true,
  };
}

/**
 * Determine if a file path is a unit test file.
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFile(filePath) {
  const norm = filePath.toLowerCase();
  return norm.includes('.test.') ||
    norm.includes('.spec.') ||
    norm.endsWith('test.js') ||
    norm.endsWith('tests.js') ||
    norm.startsWith('test/') ||
    norm.startsWith('tests/') ||
    norm.includes('/test/') ||
    norm.includes('/tests/');
}

/**
 * Determine if HTML is monolithic (contains inline script and style tags).
 * @param {string} content
 * @returns {boolean}
 */
function isMonolithicHtml(content) {
  const hasInlineStyle = /<style[\s\S]*?>[\s\S]{50,}<\/style>/i.test(content);
  const hasInlineScript = /<script[\s\S]*?>[\s\S]{50,}<\/script>/i.test(content);
  return hasInlineStyle && hasInlineScript;
}

module.exports = {
  auditProductionReadiness,
  AUDIT_CATEGORIES,
};
