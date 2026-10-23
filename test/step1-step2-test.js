/**
 * Step 1 & Step 2 Upgrade Verification Tests
 * Tests Chat Tab, Progress Tab, Progress Calculator, Feature AST Analyzer & Snapshot Manager
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  calculateProgress,
  calculateModuleProgress,
  categorizeFiles,
  generateBlueprint,
  MODULE_BLUEPRINTS
} = require('../scanner/progress-calculator');

const {
  analyzeFeature,
  detectRequiredFiles,
  compareWithAST,
  FEATURE_CATALOG
} = require('../ast/feature-analyzer');

const {
  takeSnapshot,
  getSnapshot,
  listSnapshots,
  getLatestId,
  getLatestSnapshot,
  diffSnapshots
} = require('../scanner/snapshot-manager');

const sessionStore = require('../session-store');

console.log('\n--- Running Step 1 & Step 2 Upgrade Verification Tests ---');

// Mock snapshot
const mockSnapshot = {
  rootPath: '/app',
  stats: { totalFiles: 6, astFiles: 4, functions: 12, exports: 6, uniqueDeps: 5 },
  files: [
    { path: 'src/auth/auth.service.js', isAST: true, fns: ['validateUser', 'signToken'], exports: ['AuthService'], loc: 45 },
    { path: 'src/auth/auth.controller.js', isAST: true, fns: ['login', 'register'], exports: ['AuthController'], loc: 35 },
    { path: 'src/db/db.connection.js', isAST: true, fns: ['connect'], exports: ['db'], loc: 20 },
    { path: 'src/routes/api.router.js', isAST: true, fns: ['setupRoutes'], exports: ['router'], loc: 30 },
    { path: 'src/models/user.model.js', isAST: true, fns: [], exports: ['User'], loc: 15 },
    { path: 'package.json', isAST: false, loc: 50 }
  ]
};

// 1. Progress Calculator Tests
console.log('1. Testing Progress Calculator...');
const progress = calculateProgress(mockSnapshot);
assert(typeof progress.overall === 'number', 'progress.overall must be a number');
assert(progress.modules.auth && progress.modules.database && progress.modules.routes, 'All 3 modules must be present');
assert(progress.ready.length > 0, 'Ready files should be detected');
assert(Array.isArray(progress.missing), 'Missing files list should be present');

const modProgress = calculateModuleProgress(mockSnapshot, 'auth');
assert(typeof modProgress.progress === 'number', 'Module progress must be a number');
assert(modProgress.filesReady >= 2, 'Auth module should detect ready files');

const categorized = categorizeFiles(mockSnapshot.files);
assert(categorized.ready.length >= 3, 'Categorize files should identify ready files');

const blueprint = generateBlueprint('auth');
assert(blueprint.length >= 5, 'Blueprint for auth should have at least 5 expected files');
console.log('   ✔ Progress Calculator passed (Overall: ' + progress.overall + '%)');

// 2. Feature AST Analyzer Tests
console.log('2. Testing Feature AST Analyzer...');
const authReqs = detectRequiredFiles('auth');
assert(authReqs.length >= 4, 'Auth should have at least 4 required files');

const astComp = compareWithAST(authReqs, mockSnapshot);
assert(astComp.matched.length >= 2, 'Should match existing auth files in snapshot');
assert(astComp.missing.length > 0, 'Should find missing blueprint files');

const analysis = analyzeFeature('Implement JWT login and session refresh', mockSnapshot);
assert.strictEqual(analysis.featureKey, 'auth', 'Should detect auth feature');
assert(analysis.availableApproaches.length === 3, 'Should present 3 approaches (A, B, C)');
assert(analysis.availableApproaches.some(a => a.id === 'A'), 'Should include Option A');
assert(analysis.availableApproaches.some(a => a.id === 'B'), 'Should include Option B');
assert(analysis.availableApproaches.some(a => a.id === 'C'), 'Should include Option C');
console.log('   ✔ Feature AST Analyzer passed (' + analysis.availableApproaches.length + ' approaches generated)');

// 3. Snapshot Manager Tests
console.log('3. Testing Snapshot Manager...');
const snap1 = takeSnapshot('/app', 'Baseline Snapshot', mockSnapshot);
assert(snap1.id, 'Snapshot must have an id');
assert.strictEqual(getLatestId(), snap1.id, 'getLatestId should return snap1 id');
assert(getLatestSnapshot(), 'getLatestSnapshot should return latest snapshot');

const modifiedSnapshot = {
  ...mockSnapshot,
  files: [
    ...mockSnapshot.files,
    { path: 'src/services/stripe.service.js', isAST: true, fns: ['charge'], exports: ['stripe'] }
  ]
};
const snap2 = takeSnapshot('/app', 'After Stripe Implementation', modifiedSnapshot);
const diff = diffSnapshots(snap1.id, snap2.id);
assert.strictEqual(diff.summary.added, 1, 'Diff should reflect 1 added file');
assert.strictEqual(diff.added[0], 'src/services/stripe.service.js', 'Added file matches');

const snapList = listSnapshots();
assert(snapList.length >= 2, 'listSnapshots should return snapshots');
console.log('   ✔ Snapshot Manager passed (Snapshot Ring & Diff verified)');

// 4. Session Store Tests
console.log('4. Testing Session Store...');
sessionStore.clearState();
const saved = sessionStore.saveState({
  chatHistory: [{ role: 'user', text: 'Build JWT auth' }],
  selectedOption: 'A',
  currentProgress: progress
});
const loaded = sessionStore.loadState();
assert.strictEqual(loaded.selectedOption, 'A', 'selectedOption persists');
assert.strictEqual(loaded.chatHistory.length, 1, 'chatHistory persists');
assert.strictEqual(loaded.currentProgress.overall, progress.overall, 'currentProgress persists');
sessionStore.clearState();
console.log('   ✔ Session Store passed');

// 5. UI HTML & Tab Controller Markup Validation
console.log('5. Testing UI Markup & Tab Controllers...');
const indexHtml = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');

// Verify 4 core developer tabs (Scanner, Chat, Prompt, Verify)
const expectedTabs = ['scanner', 'chat', 'prompt', 'verify'];
for (const tab of expectedTabs) {
  assert(indexHtml.includes(`data-tab="${tab}"`), `Tab data-tab="${tab}" must exist in index.html`);
}

// Verify Chat Tab elements
const chatElements = [
  'id="chat-messages"',
  'id="chat-input"',
  'id="chat-send"',
  'id="chat-options"',
  'id="chat-approval"',
  'id="chat-typing"',
  'id="chat-clear"'
];
for (const el of chatElements) {
  assert(indexHtml.includes(el), `Chat Tab element ${el} must exist in index.html`);
}

// Verify Progress Tab elements
const progElements = [
  'id="progress-overall"',
  'id="progress-overall-pct"',
  'id="progress-modules"',
  'id="progress-missing"',
  'id="progress-partial"',
  'id="progress-ready"'
];
for (const el of progElements) {
  assert(indexHtml.includes(el), `Progress Tab element ${el} must exist in index.html`);
}

// Verify Preload APIs
assert(preloadJs.includes('chat: {'), 'preload must expose api.chat');
assert(preloadJs.includes('progress: {'), 'preload must expose api.progress');
assert(preloadJs.includes('prompt: {'), 'preload must expose api.prompt');
assert(preloadJs.includes('verify: {'), 'preload must expose api.verify');
assert(preloadJs.includes('snapshot: {'), 'preload must expose api.snapshot');
assert(preloadJs.includes('ai: {'), 'preload must expose api.ai');

console.log('   ✔ UI Markup & Preload Bridge passed');

console.log('\n======================================================');
console.log('🎉 ALL STEP 1 & STEP 2 UPGRADE TESTS PASSED SUCCESSFULLY!');
console.log('======================================================\n');
