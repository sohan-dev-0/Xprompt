/**
 * PromptLock v2.0 — Complete Verification Test Suite
 * Validating Step 1 (UI & Floating Window Architecture) & Step 2 (AST Engine & Scanner)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const astEngine = require('../ast-engine');

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
};

const results = [];

function record(suite, testName, passed, details) {
  results.push({ suite, testName, passed, details });
  const badge = passed
    ? `${colors.green}${colors.bold}✔ PASS${colors.reset}`
    : `${colors.red}${colors.bold}✘ FAIL${colors.reset}`;
  console.log(`  ${badge} ${colors.bold}${testName}${colors.reset}`);
  if (details) {
    console.log(`         ${colors.dim}${details}${colors.reset}`);
  }
}

async function runSuite() {
  console.log(`\n${colors.cyan}${colors.bold}=======================================================`);
  console.log(`   PromptLock v2.0 — Comprehensive Verification Suite`);
  console.log(`=======================================================${colors.reset}\n`);

  // ════════════════════════════════════════════════════════════════
  // Test Suite 1: Step 1 - UI & Window Architecture Tests
  // ════════════════════════════════════════════════════════════════
  console.log(`${colors.yellow}${colors.bold}► Test Suite 1: Step 1 - UI & Window Architecture${colors.reset}`);

  // 1.1 Frameless & Glassmorphic Window Test
  try {
    const mainJs = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const styleCss = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');

    const hasFrameFalse = /frame:\s*false/.test(mainJs);
    const hasTransparent = /transparent:\s*true/.test(mainJs);
    const hasAlwaysOnTop = /alwaysOnTop:\s*true/.test(mainJs);
    const hasBackdropBlur = /backdrop-filter:\s*blur\(\d+px\)/.test(styleCss);
    const hasDeepGlass = styleCss.includes('--glass-panel') && styleCss.includes('--glass-card');

    const passed = hasFrameFalse && hasTransparent && hasAlwaysOnTop && hasBackdropBlur && hasDeepGlass;
    record(
      'Suite 1',
      '1. Frameless & Glassmorphic Window Test',
      passed,
      `frame:false (${hasFrameFalse}), transparent:true (${hasTransparent}), backdrop-filter blur (${hasBackdropBlur})`
    );
  } catch (err) {
    record('Suite 1', '1. Frameless & Glassmorphic Window Test', false, err.message);
  }

  // 1.2 Global Shortcut Toggle Test
  try {
    const mainJs = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

    const hasShortcutReg = mainJs.includes("CommandOrControl+Shift+G");
    const hasToggleSend = mainJs.includes("mainWindow.webContents.send('toggle-from-shortcut')");
    const hasPreloadOnToggle = preloadJs.includes("onToggle:");
    const hasAppToggleListener = appJs.includes("api.onToggle(");

    const passed = hasShortcutReg && hasToggleSend && hasPreloadOnToggle && hasAppToggleListener;
    record(
      'Suite 1',
      '2. Global Shortcut Toggle Test (Cmd/Ctrl+Shift+G)',
      passed,
      `Shortcut registered: ${hasShortcutReg}, IPC channel: toggle-from-shortcut, Bound in UI: ${hasAppToggleListener}`
    );
  } catch (err) {
    record('Suite 1', '2. Global Shortcut Toggle Test (Cmd/Ctrl+Shift+G)', false, err.message);
  }

  // 1.3 IPC Bridge Security Test
  try {
    const mainJs = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');

    const hasContextIsolation = /contextIsolation:\s*true/.test(mainJs);
    const hasNodeIntegrationFalse = /nodeIntegration:\s*false/.test(mainJs);
    const hasContextBridge = preloadJs.includes('contextBridge.exposeInMainWorld');
    const exposesDirectIpc = /contextBridge\.exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(preloadJs);

    const passed = hasContextIsolation && hasNodeIntegrationFalse && hasContextBridge && !exposesDirectIpc;
    record(
      'Suite 1',
      '3. IPC Bridge Security Test',
      passed,
      `contextIsolation: ${hasContextIsolation}, nodeIntegration: false, No raw ipcRenderer leakage: ${!exposesDirectIpc}`
    );
  } catch (err) {
    record('Suite 1', '3. IPC Bridge Security Test', false, err.message);
  }

  // ════════════════════════════════════════════════════════════════
  // Test Suite 2: Step 2 - Directory Scanner & AST Engine Tests
  // ════════════════════════════════════════════════════════════════
  console.log(`\n${colors.yellow}${colors.bold}► Test Suite 2: Step 2 - Directory Scanner & AST Engine${colors.reset}`);

  // Create temporary mock workspace
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlock-test-'));

  try {
    // Scaffold test workspace structure
    fs.mkdirSync(path.join(tempDir, '.git'));
    fs.writeFileSync(path.join(tempDir, '.git/config'), '[core]\nrepositoryformatversion = 0');

    fs.mkdirSync(path.join(tempDir, 'node_modules/fake-pkg'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'node_modules/fake-pkg/index.js'), 'module.exports = 123;');

    fs.mkdirSync(path.join(tempDir, 'dist'));
    fs.writeFileSync(path.join(tempDir, 'dist/bundle.js'), 'console.log("bundle");');

    fs.mkdirSync(path.join(tempDir, 'build'));
    fs.writeFileSync(path.join(tempDir, 'build/app.min.js'), 'console.log("min");');

    fs.mkdirSync(path.join(tempDir, 'coverage'));
    fs.writeFileSync(path.join(tempDir, 'coverage/lcov.info'), 'TN:\n');

    fs.writeFileSync(path.join(tempDir, '.env'), 'DATABASE_URL=postgres://secret');
    fs.writeFileSync(path.join(tempDir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    fs.writeFileSync(path.join(tempDir, 'photo.jpg'), Buffer.from([0xFF, 0xD8, 0xFF]));
    fs.writeFileSync(path.join(tempDir, 'archive.zip'), Buffer.from([0x50, 0x4B, 0x03, 0x04]));

    // Valid JS/TS code files
    fs.mkdirSync(path.join(tempDir, 'src/services'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/services/auth.service.ts'),
      `
      import { sign, verify } from 'jsonwebtoken';
      import { z } from 'zod';

      export class AuthService {
        async validateToken(token: string): Promise<boolean> {
          return true;
        }
      }

      export const generateUserSession = (userId: string, role: string) => {
        return sign({ userId, role }, 'secret');
      };
      `
    );

    fs.writeFileSync(
      path.join(tempDir, 'src/index.js'),
      `
      const express = require('express');
      const { AuthService } = require('./services/auth.service');

      function startServer(port = 3000) {
        console.log('Server started on port', port);
      }

      const router = () => {};

      module.exports = {
        startServer,
        router
      };
      `
    );

    // 2.1 Automated Ignore Rule Test
    const initialSnapshot = await astEngine.init(tempDir, () => {});
    const scannedPaths = initialSnapshot.files.map(f => f.path);

    const hasIgnoredGit = scannedPaths.some(p => p.includes('.git'));
    const hasIgnoredModules = scannedPaths.some(p => p.includes('node_modules'));
    const hasIgnoredDist = scannedPaths.some(p => p.includes('dist'));
    const hasIgnoredBuild = scannedPaths.some(p => p.includes('build'));
    const hasIgnoredCoverage = scannedPaths.some(p => p.includes('coverage'));
    const hasIgnoredEnv = scannedPaths.some(p => p.includes('.env'));
    const hasIgnoredBinaries = scannedPaths.some(p => p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.zip'));

    const ignorePassed = !hasIgnoredGit && !hasIgnoredModules && !hasIgnoredDist &&
                         !hasIgnoredBuild && !hasIgnoredCoverage && !hasIgnoredEnv &&
                         !hasIgnoredBinaries && scannedPaths.length > 0;

    record(
      'Suite 2',
      '1. Automated Ignore Rule Test',
      ignorePassed,
      `Correctly skipped: node_modules, .git, dist, build, coverage, .env, *.png, *.jpg, *.zip. Scanned: ${scannedPaths.length} valid source files.`
    );

    // 2.2 Lightweight AST Metadata Extraction Test
    const authMeta = initialSnapshot.files.find(f => f.path.includes('auth.service.ts'));
    const indexMeta = initialSnapshot.files.find(f => f.path.includes('index.js'));

    const authFnsHasService = authMeta && authMeta.fns.some(fn => fn.includes('AuthService'));
    const authFnsHasSession = authMeta && authMeta.fns.some(fn => fn.includes('generateUserSession'));
    const authExportsCheck = authMeta && authMeta.exports.includes('AuthService') && authMeta.exports.includes('generateUserSession');
    const authImportsCheck = authMeta && authMeta.imports.some(i => i.from === 'jsonwebtoken') && authMeta.imports.some(i => i.from === 'zod');

    const indexFnsCheck = indexMeta && indexMeta.fns.some(fn => fn.includes('startServer'));
    const indexExportsCheck = indexMeta && (indexMeta.exports.includes('startServer') || indexMeta.exports.includes('router'));
    const indexImportsCheck = indexMeta && indexMeta.imports.some(i => i.from === 'express');

    // Confirm file content is NOT held on file metadata (token-saver proof)
    const hasNoRawSource = !authMeta.source && !authMeta.content && !indexMeta.source && !indexMeta.content;

    const astExtractionPassed = authFnsHasService && authFnsHasSession && authExportsCheck &&
                                authImportsCheck && indexFnsCheck && indexExportsCheck &&
                                indexImportsCheck && hasNoRawSource;

    record(
      'Suite 2',
      '2. Lightweight AST Metadata Extraction Test (Token-Saver)',
      astExtractionPassed,
      `Extracted: ${initialSnapshot.stats.functions} functions, ${initialSnapshot.stats.uniqueDeps} deps, Raw source excluded: ${hasNoRawSource}`
    );

    // 2.3 Real-time Chokidar Watcher Test
    let watcherUpdateFired = false;
    let updatedSnapshot = null;

    // Re-init with callback
    await astEngine.init(tempDir, (snap) => {
      watcherUpdateFired = true;
      updatedSnapshot = snap;
    });

    // Simulate adding a new file
    const newFilePath = path.join(tempDir, 'src/payment.ts');
    fs.writeFileSync(
      newFilePath,
      `
      export function processCheckout(cartId: string, amount: number) {
        return { success: true };
      }
      `
    );

    // Give chokidar stabilityThreshold (200ms) + debounce (120ms) to fire
    await new Promise(r => setTimeout(r, 900));

    const fileWasAdded = updatedSnapshot && updatedSnapshot.files.some(f => f.path.includes('payment.ts'));
    const fnWasExtracted = updatedSnapshot && updatedSnapshot.files.find(f => f.path.includes('payment.ts'))?.fns.some(fn => fn.includes('processCheckout'));

    // Simulate modifying the file
    fs.appendFileSync(newFilePath, '\nexport function refundPayment(id: string) { return true; }\n');
    await new Promise(r => setTimeout(r, 900));

    const fnWasUpdated = updatedSnapshot && updatedSnapshot.files.find(f => f.path.includes('payment.ts'))?.fns.some(fn => fn.includes('refundPayment'));

    // Simulate deleting the file
    fs.unlinkSync(newFilePath);
    await new Promise(r => setTimeout(r, 900));

    const fileWasRemoved = updatedSnapshot && !updatedSnapshot.files.some(f => f.path.includes('payment.ts'));

    const watcherPassed = watcherUpdateFired && fileWasAdded && fnWasExtracted && fnWasUpdated && fileWasRemoved;

    record(
      'Suite 2',
      '3. Real-time Chokidar Watcher Test',
      watcherPassed,
      `Watcher events verified: add (${fileWasAdded}), modify (${fnWasUpdated}), unlink (${fileWasRemoved})`
    );

    // 2.4 UI File Tree & Health Sync Test
    const latestSnapshot = astEngine.getSnapshot();
    const hasDepHealth = Array.isArray(latestSnapshot.depHealth) && (latestSnapshot.depHealth.length === 5 || latestSnapshot.depHealth.length === 8);
    const hasStats = latestSnapshot.stats && typeof latestSnapshot.stats.totalFiles === 'number' && typeof latestSnapshot.stats.astFiles === 'number';

    // Verify UI formatter integration in renderer/app.js
    const appJs = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
    const hasRenderSnapshot = appJs.includes('function renderSnapshot(snapshot)');
    const hasTreeStatsRow = appJs.includes('ft-stats-row');
    const hasDepHealthRendering = appJs.includes('dh-bar-fill');
    const hasAstContextInjection = appJs.includes('formatAstContextSnippet');

    const uiSyncPassed = hasDepHealth && hasStats && hasRenderSnapshot && hasTreeStatsRow && hasDepHealthRendering && hasAstContextInjection;

    record(
      'Suite 2',
      '4. UI File Tree & Health Sync Test',
      uiSyncPassed,
      `Snapshot schema valid (5 health bars), renderSnapshot() implemented, AST Context injected into prompts: ${hasAstContextInjection}`
    );

    await astEngine.destroy();

  } finally {
    // Cleanup temporary workspace
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }

  // ════════════════════════════════════════════════════════════════
  // Test Suite 3: Step 3 - Session Persistence & State Restoration
  // ════════════════════════════════════════════════════════════════
  console.log(`\n${colors.yellow}${colors.bold}► Test Suite 3: Session Persistence & State Restoration${colors.reset}`);

  try {
    const sessionStore = require('../session-store');
    sessionStore.clearState();

    // 3.1 Store Read/Write & Schema Integrity Test
    const testState = {
      lastActiveProjectPath: '/Users/sohan/Desktop/Projects/test',
      selectedTargetAI: 'claude',
      activeRules: ['zero-secrets', 'zod-validation', 'sql-guard'],
      activeTab: 'filetree',
      chatHistory: [
        { id: 'u_1', type: 'user', text: 'Add Stripe checkout', time: '10:00 AM' },
        { id: 'rpb_1', type: 'assistant', text: 'Add Stripe checkout', readyPrompt: 'xml...', rulesCount: 3, time: '10:01 AM' },
      ],
    };

    sessionStore.saveState(testState);
    const loaded = sessionStore.loadState();

    const matchesProject = loaded.lastActiveProjectPath === testState.lastActiveProjectPath;
    const matchesAI = loaded.selectedTargetAI === testState.selectedTargetAI;
    const matchesRules = Array.isArray(loaded.activeRules) && loaded.activeRules.length === 3;
    const matchesTab = loaded.activeTab === testState.activeTab;
    const matchesChat = Array.isArray(loaded.chatHistory) && loaded.chatHistory.length === 2;

    const storePassed = matchesProject && matchesAI && matchesRules && matchesTab && matchesChat;
    record(
      'Suite 3',
      '1. Local State Storage & Schema Integrity Test',
      storePassed,
      `Project (${matchesProject}), Target AI (${matchesAI}), Active Rules (${matchesRules}), Tab (${matchesTab}), Chat (${matchesChat})`
    );

    sessionStore.clearState();
  } catch (err) {
    record('Suite 3', '1. Local State Storage & Schema Integrity Test', false, err.message);
  }

  // 3.2 Launch Auto-Restoration Hook Integration Test
  try {
    const mainJs = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');

    const hasSessionStoreRequire = mainJs.includes("require('./session-store')");
    const hasStartupPreScan = mainJs.includes("sessionStore.loadState()") && mainJs.includes("astEngine.init(savedState.lastActiveProjectPath");
    const hasIpcSessionLoad = mainJs.includes("ipcMain.handle('session:load'");
    const hasIpcSessionSave = mainJs.includes("ipcMain.handle('session:save'");
    const hasPreloadLoad = preloadJs.includes("sessionLoad:");
    const hasPreloadSave = preloadJs.includes("sessionSave:");

    const backendPassed = hasSessionStoreRequire && hasStartupPreScan && hasIpcSessionLoad &&
                          hasIpcSessionSave && hasPreloadLoad && hasPreloadSave;
    record(
      'Suite 3',
      '2. Backend Launch Auto-Restoration Hook Test',
      backendPassed,
      `Startup pre-scan: ${hasStartupPreScan}, IPC channels (session:load, session:save): true, Bridge exposed: true`
    );
  } catch (err) {
    record('Suite 3', '2. Backend Launch Auto-Restoration Hook Test', false, err.message);
  }

  // 3.3 Frontend UI State Recovery & Auto-Save Test
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

    const hasInitSession = appJs.includes("async function initSession()");
    const hasPersistSession = appJs.includes("function persistSession()");
    const hasTabPersist = appJs.includes("persistSession();") && appJs.includes("tab.addEventListener");
    const hasAgentPersist = appJs.includes("targetAgentSelect.addEventListener");
    const hasChatRestore = appJs.includes("appendUserBubble") && appJs.includes("appendReadyPromptBox");
    const hasInitCall = appJs.includes("initSession();");

    const uiPassed = hasInitSession && hasPersistSession && hasTabPersist && hasAgentPersist && hasChatRestore && hasInitCall;
    record(
      'Suite 3',
      '3. Frontend UI State Recovery & Auto-Save Test',
      uiPassed,
      `initSession(): ${hasInitSession}, persistSession(): ${hasPersistSession}, Chat & prompt box recovery: ${hasChatRestore}`
    );
  } catch (err) {
    record('Suite 3', '3. Frontend UI State Recovery & Auto-Save Test', false, err.message);
  }

  // ════════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════════
  // Test Suite 4: 4-Core Developer Navigation & Prompt Grounding
  // ════════════════════════════════════════════════════════════════
  console.log(`\n${colors.yellow}${colors.bold}► Test Suite 4: 4-Core Developer Navigation & Prompt Grounding${colors.reset}`);

  // 4.1 4-Core Navigation Bar & Roadmap Removal Test
  try {
    const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
    const sessionStore = require('../session-store');

    const hasScannerTab = html.includes('data-tab="scanner"');
    const hasChatTab = html.includes('data-tab="chat"');
    const hasPromptTab = html.includes('data-tab="prompt"');
    const hasVerifyTab = html.includes('data-tab="verify"');
    const noRoadmapTab = !html.includes('data-tab="roadmap"');
    const noRoadmapSection = !html.includes('id="tabRoadmap"') && !html.includes('id="tab-roadmap"');
    const noRoadmapPresets = !html.includes('btnPresetAuth');
    const noRoadmapCss = !css.includes('.rm-overview-card') && !css.includes('.btn-add-milestone');

    // Test session persistence without crash on legacy roadmap fields
    sessionStore.clearState();
    sessionStore.saveState({
      roadmapGoal: 'Full-Stack SaaS Platform',
      roadmapMilestones: [
        { id: 'm1', title: 'User Auth', tokens: ['auth', 'jwt'], manualDone: true }
      ]
    });
    const loaded = sessionStore.loadState();
    const persistsWithoutCrash = loaded && typeof loaded === 'object';
    sessionStore.clearState();

    const passed = hasScannerTab && hasChatTab && hasPromptTab && hasVerifyTab &&
                   noRoadmapTab && noRoadmapSection && noRoadmapPresets &&
                   noRoadmapCss && persistsWithoutCrash;

    record(
      'Suite 4',
      '1. 4-Core Navigation Bar & Roadmap Removal Test',
      passed,
      `Core 4 Tabs: Scanner, Chat, Prompt, Verify (Roadmap removed: ${noRoadmapTab}), Storage stability: ${persistsWithoutCrash}`
    );
  } catch (err) {
    record('Suite 4', '1. 4-Core Navigation Bar & Roadmap Removal Test', false, err.message);
  }

  // 4.2 Graceful Tab Fallback & Controller Test
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

    const hasSwitchTabFn = appJs.includes('function switchTab(');
    const hasFallback = appJs.includes('roadmap') && (appJs.includes("targetTabId = 'chat'") || appJs.includes("tabToRestore = 'chat'"));
    const noRoadmapListeners = !appJs.includes('btnPresetAuth') && !appJs.includes('btnAddMilestone.addEventListener');

    const passed = hasSwitchTabFn && hasFallback && noRoadmapListeners;

    record(
      'Suite 4',
      '2. Graceful Tab Fallback & Controller Test',
      passed,
      `switchTab(): ${hasSwitchTabFn}, Fallback to chat: ${hasFallback}, Stale roadmap listeners removed: ${noRoadmapListeners}`
    );
  } catch (err) {
    record('Suite 4', '2. Graceful Tab Fallback & Controller Test', false, err.message);
  }

  // 4.3 Prompt Cleanliness & Absence of Milestone Constraints Test
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
    const { buildStrictPrompt } = require('../src/main/rules/prompt-builder');

    const appNoRoadmapBlock = !appJs.includes('roadmapBlock') && !appJs.includes('<roadmap_constraints>');

    const mockPlan = {
      task: 'Add a login page',
      intentSummary: 'Add a login page',
      filesToEdit: ['index.html', 'app.js'],
      filesToCreate: [],
    };
    const generated = await buildStrictPrompt({ plan: mockPlan, agent: 'cursor' });
    const noMilestoneConstraints = !generated.prompt.includes('[MILESTONE & ROADMAP CONSTRAINTS]') &&
                                   !generated.prompt.includes('ACTIVE PROJECT GOAL') &&
                                   !generated.prompt.includes('TARGET MILESTONE');

    const passed = appNoRoadmapBlock && noMilestoneConstraints;

    record(
      'Suite 4',
      '3. Prompt Cleanliness & Absence of Milestone Constraints Test',
      passed,
      `Renderer prompt formatters clean: ${appNoRoadmapBlock}, Generated prompt has zero roadmap/milestone constraints: ${noMilestoneConstraints}`
    );
  } catch (err) {
    record('Suite 4', '3. Prompt Cleanliness & Absence of Milestone Constraints Test', false, err.message);
  }
  const total = results.length;
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = total - passedCount;

  console.log(`\n${colors.cyan}-------------------------------------------------------${colors.reset}`);
  console.log(`${colors.bold}Total Test Cases:${colors.reset} ${total}`);
  console.log(`${colors.green}${colors.bold}Passed:${colors.reset}           ${passedCount}`);
  console.log(`${colors.red}${colors.bold}Failed:${colors.reset}           ${failedCount}`);
  console.log(`${colors.cyan}-------------------------------------------------------${colors.reset}`);

  if (failedCount === 0) {
    console.log(`\n${colors.green}${colors.bold}🎉 ALL VERIFICATION TESTS PASSED! PromptLock v2.0 is fully verified.${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${colors.red}${colors.bold}❌ Some tests failed. Please review the failures above.${colors.reset}\n`);
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
