/**
 * PromptLock v2.0 — Step 5 Context-Aware Security Guardrails Test Suite
 *
 * Verifies:
 *  1. Base Security Rules catalog (6 core rules + frontend rules + domain rules)
 *  2. AI Prompt Template (select-security.md existence & placeholder structure)
 *  3. AI Rule Selector & aiService.selectSecurityRules integration
 *  4. Context Test 1 (Frontend): Feature "Add dark mode", Project: Vanilla JS
 *     - Expected: XSS Guard included, Zod/SQL excluded.
 *  5. Context Test 2 (Backend Auth): Feature "JWT Login", Project: Express
 *     - Expected: Rate limiting, SQL Guard, JWT rotation included.
 *  6. Context Test 3 (Payment): Feature "Stripe Checkout", Project: Express/Fastify
 *     - Expected: Webhook signature verification and idempotency keys included.
 *  7. Strict Prompt Builder integration with dynamic ## Security Guardrails injection
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const { BASE_RULES, getRule, getAllRules, getCoreRules, getFrontendRules, getDomainRules } = require('../security/base-rules');
const { selectSecurityRules, selectRulesHeuristically } = require('../security/rule-selector');
const aiService = require('../ai/ai-service');
const { buildStrictPrompt } = require('../rules/prompt-builder');

async function runTests() {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  PromptLock — Step 5 Context-Aware Security Guardrails Suite');
  console.log('══════════════════════════════════════════════════════════════════\n');

  let passed = 0;

  // ── TEST 1: Base Rules Catalog Completeness ────────────────────────────────
  console.log('► Test 1: Base Security Rules Catalog Completeness...');
  {
    assert.ok(Array.isArray(BASE_RULES) && BASE_RULES.length >= 6, 'BASE_RULES must contain at least 6 rules');

    const expectedRuleIds = [
      'zero-secrets',
      'sql-guard',
      'zod-validation',
      'rate-limiting',
      'owasp-headers',
      'error-masking',
      'xss-guard',
      'no-innerhtml',
      'no-eval',
      'jwt-rotation',
      'bcrypt-hash',
      'webhook-signature',
      'idempotency',
    ];

    for (const id of expectedRuleIds) {
      const rule = getRule(id);
      assert.ok(rule, `Rule '${id}' must exist in base-rules`);
      assert.ok(rule.text && rule.text.length > 20, `Rule '${id}' must have substantial directive text`);
    }

    const coreRules = getCoreRules();
    assert.ok(coreRules.length >= 6, 'getCoreRules must return at least 6 core/backend rules');

    const frontendRules = getFrontendRules();
    assert.ok(frontendRules.some(r => r.id === 'xss-guard'), 'Frontend rules must include xss-guard');
    assert.ok(frontendRules.some(r => r.id === 'no-innerhtml'), 'Frontend rules must include no-innerhtml');

    console.log(`  ✔ PASS: Catalog verified with ${BASE_RULES.length} security rules.`);
    passed++;
  }

  // ── TEST 2: AI Prompt Template Verification ───────────────────────────────
  console.log('\n► Test 2: AI Security Prompt Template (select-security.md)...');
  {
    const promptPath = path.join(__dirname, '../ai/prompts/select-security.md');
    assert.ok(fs.existsSync(promptPath), 'select-security.md must exist in ai/prompts/');

    const templateContent = fs.readFileSync(promptPath, 'utf8');
    assert.ok(templateContent.includes('{{feature}}'), 'Template must include {{feature}} placeholder');
    assert.ok(templateContent.includes('{{projectType}}'), 'Template must include {{projectType}} placeholder');
    assert.ok(templateContent.includes('{{availableRules}}'), 'Template must include {{availableRules}} placeholder');
    assert.ok(templateContent.includes('selectedRuleIds'), 'Template must document selectedRuleIds output schema');

    console.log('  ✔ PASS: select-security.md contains required guidelines & placeholders.');
    passed++;
  }

  // ── TEST 3: aiService.selectSecurityRules Export & Invocation ──────────────
  console.log('\n► Test 3: aiService.selectSecurityRules Integration...');
  {
    assert.strictEqual(typeof aiService.selectSecurityRules, 'function', 'aiService must export selectSecurityRules()');
    
    const res = await aiService.selectSecurityRules({
      feature: 'Add contact form',
      projectType: 'frontend',
    });

    assert.ok(res && typeof res === 'object', 'selectSecurityRules must return an object');
    assert.ok(Array.isArray(res.selectedRuleIds), 'result must have selectedRuleIds array');
    assert.ok(res.selectedRuleIds.includes('zero-secrets'), 'zero-secrets must be included');

    console.log(`  ✔ PASS: aiService.selectSecurityRules executed cleanly (returned ${res.selectedRuleIds.length} rules).`);
    passed++;
  }

  // ── TEST 4: Context Test 1 (Frontend): "Add dark mode", Vanilla JS ─────────
  console.log('\n► Test 4: Context Test 1 (Frontend) — Feature: "Add dark mode", Project: Vanilla JS...');
  {
    const frontendSnapshot = {
      rootPath: '/mock/vanilla-frontend',
      files: [
        { path: 'index.html', fns: [], exports: [] },
        { path: 'style.css', fns: [], exports: [] },
        { path: 'app.js', fns: ['initTheme'], exports: [] },
      ],
    };

    // 1. Test selector directly
    const selected = await selectSecurityRules({
      feature: 'Add dark mode',
      projectType: 'frontend',
      selectedOption: 'CSS Variables & LocalStorage Theme Toggle',
      snapshot: frontendSnapshot,
    });

    assert.ok(selected.selectedRuleIds.includes('xss-guard'), 'Frontend MUST include xss-guard');
    assert.ok(selected.selectedRuleIds.includes('no-innerhtml'), 'Frontend MUST include no-innerhtml');
    assert.ok(selected.selectedRuleIds.includes('zero-secrets'), 'Frontend MUST include zero-secrets');
    assert.ok(!selected.selectedRuleIds.includes('sql-guard'), 'Frontend MUST NOT include sql-guard');
    assert.ok(!selected.selectedRuleIds.includes('zod-validation'), 'Frontend MUST NOT include zod-validation');
    assert.ok(!selected.selectedRuleIds.includes('rate-limiting'), 'Frontend MUST NOT include rate-limiting');

    // 2. Test full strict prompt compilation
    const promptRes = await buildStrictPrompt({
      task: 'Add dark mode',
      feature: 'Add dark mode',
      plan: {
        id: 'plan_dark_mode',
        task: 'Add dark mode',
        intentSummary: 'Add dark mode',
        selectedOption: 'CSS Variables & LocalStorage Theme Toggle',
        filesToEdit: ['style.css', 'app.js'],
        filesToCreate: [],
      },
      agent: 'cursor',
      snapshot: frontendSnapshot,
    });

    assert.strictEqual(promptRes.ok, true);
    const p = promptRes.prompt;

    assert.ok(p.includes('XSS GUARD'), 'Compiled prompt must contain XSS GUARD');
    assert.ok(p.includes('NO INNERHTML'), 'Compiled prompt must contain NO INNERHTML');
    assert.ok(p.includes('ZERO SECRETS'), 'Compiled prompt must contain ZERO SECRETS');
    assert.ok(!p.includes('SQL GUARD'), 'Compiled prompt must NOT contain SQL GUARD');
    assert.ok(!p.includes('ZOD VALIDATION'), 'Compiled prompt must NOT contain ZOD VALIDATION');

    console.log('  ✔ PASS: Frontend dark mode strictly includes XSS Guard & excludes Zod/SQL.');
    passed++;
  }

  // ── TEST 5: Context Test 2 (Backend Auth): "JWT Login", Express ────────────
  console.log('\n► Test 5: Context Test 2 (Backend Auth) — Feature: "JWT Login", Project: Express...');
  {
    const backendSnapshot = {
      rootPath: '/mock/express-backend',
      files: [
        { path: 'package.json', fns: [], exports: [] },
        { path: 'src/server.js', fns: ['start'], exports: [] },
        { path: 'src/routes/auth.routes.js', fns: ['login'], exports: ['authRouter'] },
        { path: 'src/controllers/auth.controller.js', fns: ['handleLogin'], exports: ['handleLogin'] },
      ],
    };

    // 1. Test selector directly
    const selected = await selectSecurityRules({
      feature: 'JWT Login',
      projectType: 'backend',
      selectedOption: 'Express JWT Access & Refresh Token Rotation',
      snapshot: backendSnapshot,
    });

    assert.ok(selected.selectedRuleIds.includes('rate-limiting'), 'Backend Auth MUST include rate-limiting');
    assert.ok(selected.selectedRuleIds.includes('sql-guard'), 'Backend Auth MUST include sql-guard');
    assert.ok(selected.selectedRuleIds.includes('jwt-rotation'), 'Backend Auth MUST include jwt-rotation');
    assert.ok(selected.selectedRuleIds.includes('bcrypt-hash'), 'Backend Auth MUST include bcrypt-hash');
    assert.ok(selected.selectedRuleIds.includes('zod-validation'), 'Backend Auth MUST include zod-validation');
    assert.ok(selected.selectedRuleIds.includes('zero-secrets'), 'Backend Auth MUST include zero-secrets');

    // 2. Test full strict prompt compilation
    const promptRes = await buildStrictPrompt({
      task: 'JWT Login',
      feature: 'JWT Login',
      plan: {
        id: 'plan_jwt_login',
        task: 'JWT Login',
        intentSummary: 'JWT Login',
        selectedOption: 'Express JWT Access & Refresh Token Rotation',
        filesToEdit: ['src/routes/auth.routes.js', 'src/controllers/auth.controller.js'],
        filesToCreate: ['src/middlewares/authMiddleware.js'],
      },
      agent: 'cursor',
      snapshot: backendSnapshot,
    });

    assert.strictEqual(promptRes.ok, true);
    const p = promptRes.prompt;

    assert.ok(p.includes('RATE LIMITING'), 'Compiled prompt must contain RATE LIMITING');
    assert.ok(p.includes('SQL GUARD'), 'Compiled prompt must contain SQL GUARD');
    assert.ok(p.includes('JWT ROTATION'), 'Compiled prompt must contain JWT ROTATION');
    assert.ok(p.includes('ZERO SECRETS'), 'Compiled prompt must contain ZERO SECRETS');

    console.log('  ✔ PASS: Backend JWT Login strictly includes Rate Limiting, SQL Guard & JWT Rotation.');
    passed++;
  }

  // ── TEST 6: Context Test 3 (Payment): "Stripe Checkout", Webhook & Idempotency ──
  console.log('\n► Test 6: Context Test 3 (Payment) — Feature: "Stripe Checkout"...');
  {
    const paymentSelected = await selectSecurityRules({
      feature: 'Stripe Checkout and Subscription Webhook',
      projectType: 'backend',
      selectedOption: 'Stripe Checkout Sessions with Signature Verification',
    });

    assert.ok(paymentSelected.selectedRuleIds.includes('webhook-signature'), 'Payment MUST include webhook-signature');
    assert.ok(paymentSelected.selectedRuleIds.includes('idempotency'), 'Payment MUST include idempotency');
    assert.ok(paymentSelected.selectedRuleIds.includes('zero-secrets'), 'Payment MUST include zero-secrets');

    console.log('  ✔ PASS: Payment feature strictly includes Webhook Signature & Idempotency.');
    passed++;
  }

  // ── TEST 7: Metadata Inspection & Backward Compatibility ───────────────────
  console.log('\n► Test 7: Prompt Metadata & Security Inspection...');
  {
    const promptRes = await buildStrictPrompt({
      task: 'User profile page',
      plan: {
        id: 'plan_profile',
        task: 'User profile page',
      },
      agent: 'cursor',
    });

    assert.ok(promptRes.metadata.security, 'metadata must include security selection object');
    assert.ok(Array.isArray(promptRes.metadata.selectedSecurityRules), 'metadata must include selectedSecurityRules array');
    assert.ok(promptRes.metadata.selectedSecurityRules.includes('zero-secrets'));

    console.log('  ✔ PASS: metadata.security properly tracks selected security rules.');
    passed++;
  }

  // ── TEST 8: UI Chip Synchronization & selectedRuleIds Verification ─────────
  console.log('\n► Test 8: UI Chip Synchronization & selectedRuleIds Payload Verification...');
  {
    // 1. Verify frontend project (Dark Mode) returns selectedRuleIds
    const frontendRes = await buildStrictPrompt({
      task: 'Add dark mode toggle',
      feature: 'Add dark mode toggle',
      snapshot: {
        rootPath: '/mock/vanilla-frontend',
        files: [{ path: 'index.html' }, { path: 'style.css' }, { path: 'app.js' }],
      },
      plan: {
        task: 'Add dark mode toggle',
        selectedOption: 'CSS Variables with Theme Toggle',
      },
    });

    const ruleIds = frontendRes.metadata?.selectedSecurityRules;
    assert.ok(Array.isArray(ruleIds), 'selectedSecurityRules must be an array');
    assert.ok(ruleIds.includes('xss-guard'), 'Frontend rules must include xss-guard');
    assert.ok(ruleIds.includes('zero-secrets'), 'Frontend rules must include zero-secrets');
    assert.ok(!ruleIds.includes('sql-guard'), 'Frontend rules must NOT include sql-guard');
    assert.ok(!ruleIds.includes('zod-validation'), 'Frontend rules must NOT include zod-validation');

    // 2. Test pill sync simulation
    const simulatedPills = [
      { rule: 'zero-secrets', active: true },
      { rule: 'zod-validation', active: true },
      { rule: 'sql-guard', active: true },
      { rule: 'no-eval', active: true },
      { rule: 'rate-limit', active: false },
      { rule: 'xss-guard', active: false },
    ];

    const ruleSet = new Set(ruleIds.map(r => r.toLowerCase()));
    if (ruleSet.has('rate-limiting')) ruleSet.add('rate-limit');
    if (ruleSet.has('rate-limit')) ruleSet.add('rate-limiting');
    if (ruleSet.has('input-sanitization')) ruleSet.add('zod-validation');
    if (ruleSet.has('sql-injection')) ruleSet.add('sql-guard');

    simulatedPills.forEach(p => {
      p.active = ruleSet.has(p.rule);
    });

    const activeMap = Object.fromEntries(simulatedPills.map(p => [p.rule, p.active]));
    assert.strictEqual(activeMap['zero-secrets'], true, 'Zero Secrets must remain active');
    assert.strictEqual(activeMap['xss-guard'], true, 'XSS Guard must be active for frontend');
    assert.strictEqual(activeMap['no-eval'], true, 'No eval must be active for frontend');
    assert.strictEqual(activeMap['zod-validation'], false, 'Zod Validation must be INACTIVE for frontend');
    assert.strictEqual(activeMap['sql-guard'], false, 'SQL Guard must be INACTIVE for frontend');
    assert.strictEqual(activeMap['rate-limit'], false, 'Rate Limiting must be INACTIVE for frontend');

    console.log('  ✔ PASS: Frontend dark mode correctly activates XSS Guard and deactivates Zod/SQL chips.');
    passed++;
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(`🎉 ALL ${passed}/8 STEP 5 CONTEXT-AWARE SECURITY TESTS PASSED (100%)`);
  console.log('══════════════════════════════════════════════════════════════════\n');
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('\n❌ Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
