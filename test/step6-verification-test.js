/**
 * PromptLock v2.0 — Step 6 AI Verification & Execution Drift Engine Test Suite
 *
 * Verifies:
 *  1. Verification prompt template existence & placeholder structure (verify-execution.md)
 *  2. Token-efficient diff extraction (caps token usage, never leaks full codebase)
 *  3. Mock Diff & Template Substitution (AI prompt receives prompt, plan, diff)
 *  4. Fallback Handling (invalid JSON / AI failure gracefully falls back to rule-based engine)
 *  5. Successful AI Output Parsing & Normalization (markdown fence stripping, schema keys)
 *  6. aiService.verifyExecution integration & temperature 0 enforcement
 *  7. UI Contract Validation (index.html & verify-tab.js elements for Step 6)
 *  8. Deterministic Diff Hashing & Caching (identical diff returns cached report without calling AI)
 *  9. Watcher & Scanner Ignore Rules (strictly ignores userData and *.json)
 * 10. Auto-Fix Prompt Generation (buildFixPrompt compiles strict prompt deterministically)
 * 11. Auto-Fix Prompt UI & Preload Contract (button wiring, preload api, ipc handler)
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const {
  verifyExecution,
  computeDiffHash,
  extractTokenEfficientDiff,
  buildRuleBasedFallback,
  parseAiJsonResponse,
  loadPromptTemplate,
} = require('../verification/execution-verifier');

const { buildFixPrompt } = require('../verification/fix-prompt-builder');
const { shouldIgnore, ALWAYS_IGNORE } = require('../scanner/ignore-rules');
const aiService = require('../ai/ai-service');

async function runTests() {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  PromptLock — Step 6 AI Verification & Drift Engine Suite');
  console.log('══════════════════════════════════════════════════════════════════\n');

  let passed = 0;

  // ── TEST 1: Verification Prompt Template Verification ────────────────────────
  console.log('► Test 1: AI Verification Prompt Template (verify-execution.md)...');
  {
    const promptPath = path.join(__dirname, '../ai/prompts/verify-execution.md');
    assert.ok(fs.existsSync(promptPath), 'verify-execution.md must exist in ai/prompts/');

    const templateContent = fs.readFileSync(promptPath, 'utf8');
    assert.ok(templateContent.includes('{{originalPrompt}}'), 'Template must include {{originalPrompt}} placeholder');
    assert.ok(templateContent.includes('{{plan}}'), 'Template must include {{plan}} placeholder');
    assert.ok(templateContent.includes('{{diff}}'), 'Template must include {{diff}} placeholder');
    assert.ok(templateContent.includes('brokenImports'), 'Template must document brokenImports schema');
    assert.ok(templateContent.includes('regressions'), 'Template must document regressions schema');
    assert.ok(templateContent.includes('riskScore'), 'Template must document riskScore schema');

    console.log('  ✔ PASS: verify-execution.md contains required guidelines & placeholders.');
    passed++;
  }

  // ── TEST 2: Token-Efficient Diff Extraction ──────────────────────────────────
  console.log('\n► Test 2: Token-Efficient Diff & AST Delta Extraction...');
  {
    const mockDiff = {
      added: ['theme.js'],
      modified: ['index.html', 'app.js'],
      deleted: ['old-theme.js'],
    };

    const mockBeforeSnapshot = {
      files: [
        { path: 'app.js', fns: ['initApp'], exports: ['start'] },
        { path: 'index.html', fns: [], exports: [] },
      ],
    };

    const mockAfterSnapshot = {
      files: [
        { path: 'app.js', fns: ['initApp', 'toggleTheme'], exports: ['start', 'toggleTheme'] },
        { path: 'index.html', fns: [], exports: [] },
      ],
    };

    const extracted = extractTokenEfficientDiff(mockDiff, null, mockBeforeSnapshot, mockAfterSnapshot);
    assert.ok(typeof extracted === 'string', 'Extracted diff must be a string');
    assert.ok(extracted.includes('[SNAPSHOT FILE DELTA]'), 'Must include file delta');
    assert.ok(extracted.includes('theme.js'), 'Must include added theme.js');
    assert.ok(extracted.includes('+fns: [toggleTheme]'), 'Must include AST functions delta');
    assert.ok(extracted.includes('+exports: [toggleTheme]'), 'Must include AST exports delta');

    // Test token ceiling on huge strings
    const hugeStringDiff = 'A'.repeat(50000);
    const capped = extractTokenEfficientDiff(hugeStringDiff);
    assert.ok(capped.length <= 15000, `Large diff must be capped under 15000 chars, got: ${capped.length}`);

    console.log('  ✔ PASS: Diff extraction produces AST deltas and respects token budget.');
    passed++;
  }

  // ── TEST 3: Mock Diff & AI Template Substitution ─────────────────────────────
  console.log('\n► Test 3: Mock Diff & AI Template Substitution...');
  {
    let promptCaptured = '';
    const mockCallProvider = async (prompt) => {
      promptCaptured = prompt;
      return JSON.stringify({
        done: ['Theme toggle implemented cleanly'],
        partial: [],
        missed: [],
        violations: [],
        brokenImports: [],
        regressions: [],
        riskScore: 10,
        nextActions: ['Test on multiple browsers'],
      });
    };

    const dummyPrompt = 'MOCK_STRICT_PROMPT: DO NOT INVENT ROUTES';
    const dummyPlan = { task: 'Add dark mode toggle', selectedOptionName: 'CSS Variables', filesToEdit: ['index.html', 'app.js'] };
    const dummyDiff = { added: ['theme.js'], modified: ['index.html'] };

    const report = await verifyExecution({
      originalPrompt: dummyPrompt,
      plan: dummyPlan,
      diff: dummyDiff,
      forceFresh: true,
    }, {
      callProvider: mockCallProvider,
      skipCache: true,
    });

    assert.ok(promptCaptured.includes('MOCK_STRICT_PROMPT: DO NOT INVENT ROUTES'), 'Prompt must contain original prompt');
    assert.ok(promptCaptured.includes('CSS Variables'), 'Prompt must contain plan details');
    assert.ok(promptCaptured.includes('theme.js'), 'Prompt must contain diff snippet');
    assert.ok(!promptCaptured.includes('{{originalPrompt}}'), 'Placeholder {{originalPrompt}} must be replaced');
    assert.ok(!promptCaptured.includes('{{plan}}'), 'Placeholder {{plan}} must be replaced');
    assert.ok(!promptCaptured.includes('{{diff}}'), 'Placeholder {{diff}} must be replaced');

    assert.strictEqual(report.isAiVerified, true, 'Report must be marked isAiVerified: true');
    assert.strictEqual(report.isStub, false, 'Report must have isStub: false');
    assert.strictEqual(report.riskScore, 10, 'Risk score must match AI output');
    assert.strictEqual(report.riskLabel, 'Low', 'Risk label must be Low for score <= 15');

    console.log('  ✔ PASS: AI template substituted correctly and returned parsed verification.');
    passed++;
  }

  // ── TEST 4: Fallback Engine Resilience (Invalid JSON & Errors) ───────────────
  console.log('\n► Test 4: Fallback Engine on AI Errors / Non-JSON Output...');
  {
    // Case A: AI provider throws error
    const failingProvider = async () => {
      throw new Error('Groq rate limit exceeded: 429');
    };

    const fallbackReport1 = await verifyExecution({
      originalPrompt: 'Feature prompt',
      diff: { added: ['err-test.js'] },
      forceFresh: true,
    }, {
      callProvider: failingProvider,
      skipCache: true,
    });

    assert.strictEqual(fallbackReport1.isAiVerified, false, 'Failed AI must have isAiVerified: false');
    assert.strictEqual(fallbackReport1.isStub, true, 'Failed AI must set isStub: true');
    assert.ok(Array.isArray(fallbackReport1.done), 'Fallback must include done array');
    assert.ok(Array.isArray(fallbackReport1.violations), 'Fallback must include violations array');
    assert.ok(Array.isArray(fallbackReport1.brokenImports), 'Fallback must include brokenImports array');
    assert.ok(Array.isArray(fallbackReport1.regressions), 'Fallback must include regressions array');
    assert.ok(typeof fallbackReport1.riskScore === 'number', 'Fallback must have numeric riskScore');
    assert.ok(Array.isArray(fallbackReport1.nextActions), 'Fallback must have nextActions checklist');

    // Case B: AI provider returns plain conversational text instead of JSON
    const nonJsonProvider = async () => {
      return 'I have reviewed your project and it looks great to me!';
    };

    const fallbackReport2 = await verifyExecution({
      originalPrompt: 'Feature prompt',
      diff: { added: ['non-json.js'] },
      forceFresh: true,
    }, {
      callProvider: nonJsonProvider,
      skipCache: true,
    });

    assert.strictEqual(fallbackReport2.isAiVerified, false, 'Non-JSON output must trigger fallback');
    assert.strictEqual(fallbackReport2.isStub, true, 'Non-JSON output must have isStub: true');

    console.log('  ✔ PASS: Graceful fallback on network failure and non-JSON AI output.');
    passed++;
  }

  // ── TEST 5: Markdown Fence Stripping & JSON Resilience ───────────────────────
  console.log('\n► Test 5: Markdown Code Fence Stripping & Normalization...');
  {
    const fencedMarkdown = [
      'Here is the analysis report you requested:',
      '```json',
      '{',
      '  "done": ["Created auth.service.js"],',
      '  "partial": ["Rate limiter configured with placeholder key"],',
      '  "missed": ["No unit test found for token rotation"],',
      '  "violations": ["Hardcoded secret in config.example.js"],',
      '  "brokenImports": ["../utils/old-helper.js not found"],',
      '  "regressions": ["verifyUser signature changed from (id) to (id, tenant)"],',
      '  "riskScore": 75,',
      '  "nextActions": ["Fix broken import", "Remove secret"]',
      '}',
      '```',
      'Please let me know if you need anything else!'
    ].join('\n');

    const parsed = parseAiJsonResponse(fencedMarkdown);
    assert.ok(parsed, 'parseAiJsonResponse must extract JSON from fenced block');
    assert.strictEqual(parsed.riskScore, 75);
    assert.strictEqual(parsed.done[0], 'Created auth.service.js');
    assert.strictEqual(parsed.brokenImports[0], '../utils/old-helper.js not found');

    const providerWithFences = async () => fencedMarkdown;
    const report = await verifyExecution({
      forceFresh: true,
      diff: { added: ['auth.service.js'] }
    }, {
      callProvider: providerWithFences,
      skipCache: true,
    });

    assert.strictEqual(report.isAiVerified, true);
    assert.strictEqual(report.riskScore, 75);
    assert.strictEqual(report.riskLabel, 'High', 'Score 75 must be High risk');
    assert.strictEqual(report.brokenImports.length, 1);
    assert.strictEqual(report.regressions.length, 1);

    console.log('  ✔ PASS: Markdown fences cleanly stripped and schema fields normalized.');
    passed++;
  }

  // ── TEST 6: aiService.verifyExecution Export & Execution ─────────────────────
  console.log('\n► Test 6: aiService.verifyExecution Export & Execution...');
  {
    assert.strictEqual(typeof aiService.verifyExecution, 'function', 'aiService must export verifyExecution()');

    // Run without provider keys configured — must safely return valid fallback report
    const serviceReport = await aiService.verifyExecution({
      originalPrompt: 'Add unit tests',
      diff: { modified: ['app.test.js'] },
      forceFresh: true,
    });

    assert.ok(serviceReport && typeof serviceReport === 'object', 'Must return report object');
    assert.ok(Array.isArray(serviceReport.done), 'Must have done array');
    assert.ok(Array.isArray(serviceReport.nextActions), 'Must have nextActions array');
    assert.ok(typeof serviceReport.riskScore === 'number', 'Must have numeric riskScore');

    console.log('  ✔ PASS: aiService.verifyExecution verified and functional.');
    passed++;
  }

  // ── TEST 7: UI Contract Verification (HTML & Verify Tab) ─────────────────────
  console.log('\n► Test 7: UI Contract Verification (index.html & verify-tab.js)...');
  {
    const htmlPath = path.join(__dirname, '../renderer/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(html.includes('id="verify-risk-bar"'), 'index.html must include #verify-risk-bar');
    assert.ok(html.includes('id="verify-ai-badge"'), 'index.html must include #verify-ai-badge');
    assert.ok(html.includes('id="vr-issues-accordion"'), 'index.html must include #vr-issues-accordion');
    assert.ok(html.includes('id="vr-issues-count"'), 'index.html must include #vr-issues-count');
    assert.ok(html.includes('id="vr-broken-imports-card"'), 'index.html must include #vr-broken-imports-card');
    assert.ok(html.includes('id="verify-broken-imports"'), 'index.html must include #verify-broken-imports');
    assert.ok(html.includes('id="vr-regressions-card"'), 'index.html must include #vr-regressions-card');
    assert.ok(html.includes('id="verify-regressions"'), 'index.html must include #verify-regressions');
    assert.ok(html.includes('id="verify-next-actions"'), 'index.html must include #verify-next-actions');

    const tabPath = path.join(__dirname, '../renderer/tabs/verify-tab.js');
    const tabCode = fs.readFileSync(tabPath, 'utf8');

    assert.ok(tabCode.includes('verifyRiskBar'), 'verify-tab.js must control verifyRiskBar');
    assert.ok(tabCode.includes('verifyAiBadge'), 'verify-tab.js must control verifyAiBadge');
    assert.ok(tabCode.includes('issuesAccordion'), 'verify-tab.js must control issuesAccordion');
    assert.ok(tabCode.includes('verifyBrokenImports'), 'verify-tab.js must control verifyBrokenImports');
    assert.ok(tabCode.includes('verifyRegressions'), 'verify-tab.js must control verifyRegressions');
    assert.ok(tabCode.includes('window.renderVerificationReport'), 'verify-tab.js must expose window.renderVerificationReport');

    console.log('  ✔ PASS: UI contract elements and accordion controller bindings confirmed.');
    passed++;
  }

  // ── TEST 8: Deterministic Diff Hashing & Caching ─────────────────────────────
  console.log('\n► Test 8: Deterministic Diff Hashing & Caching Engine...');
  {
    // 1. Verify computeDiffHash is deterministic and strips timestamps
    const diffWithTimestamps1 = {
      added: ['src/feature.js'],
      beforeId: 'snap_1700000001_abc',
      afterId: 'snap_1700000002_def',
      beforeLabel: 'Post-Verify 10:00:01 AM',
      afterLabel: 'Post-Verify 10:00:02 AM',
    };
    const diffWithTimestamps2 = {
      added: ['src/feature.js'],
      beforeId: 'snap_1700009999_xyz',
      afterId: 'snap_1700010000_uvw',
      beforeLabel: 'Post-Verify 11:35:49 PM',
      afterLabel: 'Post-Verify 11:35:50 PM',
    };

    const hash1 = computeDiffHash(diffWithTimestamps1, '[DIFF] added src/feature.js');
    const hash2 = computeDiffHash(diffWithTimestamps2, '[DIFF] added src/feature.js');
    assert.strictEqual(hash1, hash2, 'Diff hashes must be IDENTICAL regardless of timestamps/snapshot IDs');

    // 2. Verify cached execution: Same diff does NOT call AI second time
    let aiCalls = 0;
    const testProvider = async () => {
      aiCalls++;
      return JSON.stringify({
        done: ['Feature verified'],
        partial: [],
        missed: [],
        violations: [],
        brokenImports: [],
        regressions: [],
        riskScore: 20,
        nextActions: ['Ready to merge'],
      });
    };

    const mockSession = {
      state: {},
      loadState() { return this.state; },
      saveState(up) { Object.assign(this.state, up); return this.state; }
    };

    const testDiff = { added: ['src/components/dark-mode.js'] };

    // First scan: calls AI
    const run1 = await verifyExecution({
      originalPrompt: 'Add dark mode toggle',
      diff: testDiff,
    }, {
      callProvider: testProvider,
      sessionStore: mockSession,
    });

    assert.strictEqual(aiCalls, 1, 'First scan must call AI');
    assert.strictEqual(run1.cached, false, 'First scan is not cached');
    assert.strictEqual(run1.riskScore, 20);

    // Second scan with identical diff: does NOT call AI, returns from cache!
    const run2 = await verifyExecution({
      originalPrompt: 'Add dark mode toggle',
      diff: testDiff,
    }, {
      callProvider: testProvider,
      sessionStore: mockSession,
    });

    assert.strictEqual(aiCalls, 1, 'Second scan with same diff MUST NOT call AI again');
    assert.strictEqual(run2.cached, true, 'Second scan must be marked cached: true');
    assert.strictEqual(run2.unchanged, true, 'Second scan must be marked unchanged: true');
    assert.strictEqual(run2.riskScore, 20, 'Second scan must return exact same riskScore');

    // Third scan with NEW diff (user edited file): calls AI again!
    const editedDiff = { added: ['src/components/dark-mode.js', 'src/styles/theme.css'] };
    const run3 = await verifyExecution({
      originalPrompt: 'Add dark mode toggle',
      diff: editedDiff,
    }, {
      callProvider: testProvider,
      sessionStore: mockSession,
    });

    assert.strictEqual(aiCalls, 2, 'Scan with edited file MUST trigger a fresh AI verification');
    assert.strictEqual(run3.cached, false, 'Scan with edited file must produce fresh non-cached report');

    console.log('  ✔ PASS: Deterministic caching verified. Identical diffs bypass AI, edits trigger re-scan.');
    passed++;
  }

  // ── TEST 9: Watcher & Ignore Rules for userData and *.json ───────────────────
  console.log('\n► Test 9: Watcher & Ignore Rules for userData and *.json...');
  {
    assert.ok(ALWAYS_IGNORE.includes('userData'), 'ALWAYS_IGNORE must include userData');
    assert.ok(ALWAYS_IGNORE.includes('*.json'), 'ALWAYS_IGNORE must include *.json');

    // Test shouldIgnore with various paths
    assert.strictEqual(shouldIgnore('userData/projects/0001/session.json', null), true, 'userData session.json must be ignored');
    assert.strictEqual(shouldIgnore('userData/projects/0001/snapshots.json', null), true, 'userData snapshots.json must be ignored');
    assert.strictEqual(shouldIgnore('src/config.json', null), true, '.json files must be ignored from random diff triggers');
    assert.strictEqual(shouldIgnore('package.json', null), true, 'package.json must be ignored from random diff triggers');
    assert.strictEqual(shouldIgnore('src/components/button.js', null), false, 'Normal source code (.js) must NOT be ignored');

    console.log('  ✔ PASS: Watcher strictly ignores userData and .json files to prevent phantom diffs.');
    passed++;
  }

  // ── TEST 10: Auto-Fix Prompt Generation (buildFixPrompt) ─────────────────────
  console.log('\n► Test 10: Auto-Fix Prompt Compilation (buildFixPrompt)...');
  {
    const mockReport = {
      timestamp: '2026-10-18T12:00:00.000Z',
      done: ['src/utils/theme.js created successfully'],
      missed: ['Dark mode toggle button in navbar'],
      violations: ['Directly edited legacy.css violating Rule #4'],
      brokenImports: ['import { theme } from "./missing" in app.js'],
      regressions: ['renderUserAvatar function signature removed in user.js'],
      riskScore: 65,
      riskLabel: 'High',
    };

    const fixPrompt = buildFixPrompt({
      originalPrompt: 'Build dark mode toggle using CSS variables and index.html button',
      plan: { task: 'Add dark mode toggle to navigation bar' },
      verificationReport: mockReport,
    });

    assert.ok(typeof fixPrompt === 'string', 'Fix prompt must be a string');
    assert.ok(fixPrompt.includes('# 🛠️ Xprompt Auto-Fix Prompt') || fixPrompt.includes('# 🛠️ PromptLock Auto-Fix Prompt'), 'Must contain Fix Prompt header');
    assert.ok(fixPrompt.includes('65 — High Risk'), 'Must include risk score and label');
    assert.ok(fixPrompt.includes('Original Task Prompt'), 'Must contain original prompt context');
    assert.ok(fixPrompt.includes('Build dark mode toggle'), 'Must include original prompt text');
    assert.ok(fixPrompt.includes('Original Plan'), 'Must contain original plan');
    assert.ok(fixPrompt.includes('Dark mode toggle button in navbar'), 'Must include missed item');
    assert.ok(fixPrompt.includes('Directly edited legacy.css'), 'Must include violation');
    assert.ok(fixPrompt.includes('import { theme } from "./missing"'), 'Must include broken import');
    assert.ok(fixPrompt.includes('renderUserAvatar function signature removed'), 'Must include regression');
    assert.ok(fixPrompt.includes('src/utils/theme.js created successfully'), 'Must include completed items under Do NOT Redo');
    assert.ok(fixPrompt.includes('Strict Guardrails — Non-Negotiable'), 'Must include strict guardrails');

    // Test with placeholder "no issues" strings to ensure clean filtering
    const cleanReport = {
      done: ['All tasks done'],
      missed: ['No missed items'],
      violations: ['No security violations detected'],
      brokenImports: ['No broken imports detected'],
      regressions: ['No functional regressions detected'],
      riskScore: 0,
      riskLabel: 'Low',
    };
    const cleanFixPrompt = buildFixPrompt({ verificationReport: cleanReport });
    assert.ok(!cleanFixPrompt.includes('## ❌ Missed Items'), 'Should not include Missed section when no missed items');
    assert.ok(!cleanFixPrompt.includes('## 🚨 Guardrail Violations'), 'Should not include Violations section when clean');
    assert.ok(!cleanFixPrompt.includes('## 🔗 Broken Imports'), 'Should not include Broken Imports section when clean');
    assert.ok(!cleanFixPrompt.includes('## 📉 Regressions'), 'Should not include Regressions section when clean');

    console.log('  ✔ PASS: buildFixPrompt deterministically compiles strict fix prompt with full issue attribution.');
    passed++;
  }

  // ── TEST 11: Auto-Fix Prompt UI, Preload & IPC Contract ──────────────────────
  console.log('\n► Test 11: Auto-Fix Prompt UI, Preload & IPC Contract...');
  {
    const htmlPath = path.join(__dirname, '../renderer/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(htmlContent.includes('id="btn-generate-fix-prompt"'), 'index.html must include #btn-generate-fix-prompt');

    const cssPath = path.join(__dirname, '../renderer/styles/glass.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    assert.ok(cssContent.includes('.btn-primary'), 'glass.css must define .btn-primary styling');

    const verifyTabPath = path.join(__dirname, '../renderer/tabs/verify-tab.js');
    const verifyTabCode = fs.readFileSync(verifyTabPath, 'utf8');
    assert.ok(verifyTabCode.includes('btnGenerateFixPrompt'), 'verify-tab.js must reference btnGenerateFixPrompt');
    assert.ok(verifyTabCode.includes('generateFixPrompt'), 'verify-tab.js must define generateFixPrompt action');
    assert.ok(verifyTabCode.includes('data-tab="prompt"'), 'verify-tab.js must switch to prompt tab on fix prompt generation');

    const preloadPath = path.join(__dirname, '../preload.js');
    const preloadCode = fs.readFileSync(preloadPath, 'utf8');
    assert.ok(preloadCode.includes('generateFixPrompt'), 'preload.js must expose generateFixPrompt');
    assert.ok(preloadCode.includes('verification:generate-fix-prompt'), 'preload.js must invoke verification:generate-fix-prompt');

    const ipcPath = path.join(__dirname, '../ipc/verification-ipc.js');
    const ipcCode = fs.readFileSync(ipcPath, 'utf8');
    assert.ok(ipcCode.includes("'verification:generate-fix-prompt'"), 'verification-ipc.js must register verification:generate-fix-prompt');
    assert.ok(ipcCode.includes('buildFixPrompt'), 'verification-ipc.js must use buildFixPrompt');

    console.log('  ✔ PASS: Auto-Fix UI, Preload Bridge, and IPC handlers correctly integrated.');
    passed++;
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(`  Step 6 Verification Test Suite: ALL ${passed} / 11 TESTS PASSED`);
  console.log('══════════════════════════════════════════════════════════════════\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST RUNNER FAILURE:', err);
  process.exit(1);
});
