/**
 * PromptLock — Auto-Fix Prompt Builder (Step 6 Extension)
 *
 * Deterministically compiles a strict "Fix Prompt" from a verification report.
 * No AI calls — purely string composition from the JSON report data.
 * Guarantees accuracy and zero token cost.
 */

'use strict';

/**
 * Build a strict fix prompt from the verification report.
 *
 * @param {object} opts
 * @param {string}  opts.originalPrompt     — The original guardrail prompt that was given to the AI
 * @param {object|string|null} opts.plan    — The original plan object or summary string
 * @param {object}  opts.verificationReport — Full verification report from execution-verifier
 * @returns {string} Compiled strict markdown fix prompt
 */
function buildFixPrompt({ originalPrompt = '', plan = null, verificationReport = {} }) {
  const {
    done        = [],
    missed      = [],
    violations  = [],
    brokenImports = [],
    regressions = [],
    riskScore   = 0,
    riskLabel   = 'Unknown',
  } = verificationReport;

  const now = new Date().toISOString();
  const lines = [];

  const productionScore = verificationReport.productionScore !== undefined
    ? verificationReport.productionScore
    : Math.max(0, 100 - riskScore);
  const productionVerdict = verificationReport.productionVerdict || (productionScore >= 90 ? 'Production Ready' : productionScore >= 50 ? 'Needs Polish' : 'Not Production Ready');

  // Header
  lines.push('# 🛠️ PromptLock Auto-Fix Prompt');
  lines.push('> Generated: ' + now);
  lines.push(`> Production Readiness Score: **${productionScore}% (${productionVerdict})**`);
  if (riskScore > 0) {
    lines.push('> Risk Score at scan time: **' + riskScore + ' — ' + riskLabel + ' Risk**');
  }
  lines.push('');
  lines.push('## ⚠️ Mission & Scope: Production Readiness & Quality Only');
  lines.push(
    'PromptLock audited this project for **Production Readiness** (Architecture, Code Quality, Security, and Error Resilience). ' +
    'You **MUST** focus strictly on architecture, JSDoc annotations, unit test creation, security sanitization, and error handling. ' +
    'Do **NOT** break, rewrite, or alter working game/app logic — only elevate code quality and structure.'
  );
  lines.push('');

  // Next Actions Checklist
  const nextActions = Array.isArray(verificationReport.nextActions) ? verificationReport.nextActions : [];
  if (nextActions.length > 0) {
    lines.push('## 📋 Production Readiness Checklist — Actionable Steps');
    nextActions.forEach(act => lines.push(`- [ ] ${act}`));
    lines.push('');
  }

  // Failed Checks
  const failedChecks = Array.isArray(verificationReport.failedChecks) ? verificationReport.failedChecks : [];
  if (failedChecks.length > 0) {
    lines.push('## ❌ Missing Production Requirements');
    failedChecks.forEach(fc => lines.push(`- **${fc.name}** [${fc.category || 'quality'}]: ${fc.detail}`));
    lines.push('');
  }

  // Original Task Prompt
  if (originalPrompt && originalPrompt.trim()) {
    lines.push('## 📋 Original Task Prompt (Strict — Do NOT Deviate)');
    lines.push('```');
    lines.push(originalPrompt.trim());
    lines.push('```');
    lines.push('');
  }

  // Plan Summary
  if (plan) {
    let planText;
    if (typeof plan === 'string') {
      planText = plan.trim();
    } else if (plan && typeof plan === 'object') {
      planText = plan.task || plan.summary || plan.description || JSON.stringify(plan, null, 2);
    }
    if (planText) {
      lines.push('## 🗺️ Original Plan');
      lines.push('```');
      lines.push(typeof planText === 'string' ? planText.trim() : JSON.stringify(planText, null, 2));
      lines.push('```');
      lines.push('');
    }
  }

  // Missed Items
  const realMissed = (missed || []).filter(m => !_isNone(m));
  if (realMissed.length > 0) {
    lines.push('## ❌ Missed Items — MUST Complete');
    lines.push('The following were expected but NOT found after the last execution:');
    realMissed.forEach(m => lines.push('- ' + m));
    lines.push('');
    lines.push(
      '**Fix Instruction:** Implement each missed item exactly as described in the original task prompt. ' +
      'Do not skip any item. After fixing, explicitly confirm each item is now complete.'
    );
    lines.push('');
  }

  // Violations
  const realViolations = (violations || []).filter(v => !_isNone(v));
  if (realViolations.length > 0) {
    lines.push('## 🚨 Guardrail Violations — MUST Fix');
    lines.push('The following violations of the original guardrail constraints were detected:');
    realViolations.forEach(v => lines.push('- ' + v));
    lines.push('');
    lines.push(
      '**Fix Instruction:** Revert or refactor each violation. ' +
      'Do NOT introduce any new code that violates these constraints. ' +
      'If unsure, remove the offending code entirely and re-implement it cleanly.'
    );
    lines.push('');
  }

  // Broken Imports
  const realBrokenImports = (brokenImports || []).filter(b => !_isNone(b));
  if (realBrokenImports.length > 0) {
    lines.push('## 🔗 Broken Imports — MUST Resolve');
    lines.push('The following import/require paths are broken or reference missing modules:');
    realBrokenImports.forEach(b => lines.push('- ' + b));
    lines.push('');
    lines.push(
      '**Fix Instruction:** Correct each broken import. ' +
      'Ensure all referenced files/modules exist at the correct paths. ' +
      'Do NOT create stub files — implement the missing module properly if it is needed.'
    );
    lines.push('');
  }

  // Regressions
  const realRegressions = (regressions || []).filter(r => !_isNone(r));
  if (realRegressions.length > 0) {
    lines.push('## 📉 Regressions — MUST Restore');
    lines.push('The following previously-working functions or behaviours were broken by the last execution:');
    realRegressions.forEach(r => lines.push('- ' + r));
    lines.push('');
    lines.push(
      '**Fix Instruction:** Restore each broken function or API signature to its previous working state. ' +
      'Do NOT break any other existing behaviour in the process.'
    );
    lines.push('');
  }

  // Completed Context (Do NOT re-do)
  const realDone = (done || []).filter(d => d && d.trim());
  if (realDone.length > 0) {
    lines.push('## ✅ Already Completed (Do NOT Redo or Change)');
    lines.push('The following items were confirmed complete by the verification scan:');
    realDone.forEach(d => lines.push('- ' + d));
    lines.push('');
  }

  // Non-Negotiable Guardrails
  lines.push('## 🔒 Strict Guardrails — Non-Negotiable');
  lines.push('1. **Scope Lock** — Only address the issues listed in this prompt. Nothing else.');
  lines.push('2. **No Deletions** — Do NOT delete any file not explicitly named in the violations above.');
  lines.push('3. **No Extras** — Do NOT create new files, new features, or new dependencies unless strictly required by the fix.');
  lines.push('4. **Preserve Passing** — Do NOT change any code that is listed as "Already Completed".');
  lines.push('5. **Explicit Confirmation** — After all fixes, list exactly what you changed, which file, and why.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Heuristic: is an item a "none detected" placeholder string?
 */
function _isNone(str) {
  if (!str || typeof str !== 'string') return true;
  const lower = str.toLowerCase();
  return (
    lower.startsWith('no ') ||
    lower.includes('none detected') ||
    lower.includes('not detected') ||
    lower.includes('no violations') ||
    lower.includes('no broken') ||
    lower.includes('no missed') ||
    lower.includes('no functional') ||
    lower.includes('no partial') ||
    lower.includes('no security')
  );
}

module.exports = { buildFixPrompt };
