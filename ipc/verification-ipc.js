/**
 * PromptLock — Verification IPC Handler (Step 1 Upgrade)
 *
 * Handles post-execution verification: re-scan and report generation.
 * Uses Snapshot Manager to diff before/after states.
 * All AI analysis is a stub — no API calls.
 */

'use strict';

const { ipcMain } = require('electron');
const snapshotManager = require('../scanner/snapshot-manager');
const sessionStore = require('../session-store');
const { verifyExecution, buildRuleBasedFallback } = require('../verification/execution-verifier');
const { buildFixPrompt } = require('../verification/fix-prompt-builder');

let isRegistered = false;

/**
 * Register verification-related IPC handlers.
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {object} astEngineRef - Reference to the ast-engine
 */
function registerVerificationIPC(getWindow, astEngineRef) {
  if (isRegistered) return;
  isRegistered = true;

  [
    'execution:verify',
    'verification:generate-fix-prompt',
    'snapshot:take',
    'snapshot:diff',
    'snapshot:list'
  ].forEach(ch => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
  });

  /**
   * execution:verify
   * Renderer → Main: re-scan project and produce an AI verification report.
   * Resumes the chokidar watcher, takes a new snapshot, diffs with last,
   * and runs AI drift analysis against the original strict prompt & plan.
   */
  ipcMain.handle('execution:verify', async (_event, payload) => {
    console.log('[Verification IPC] execution:verify received');

    // Resume watcher after prompt generation pause
    if (astEngineRef && typeof astEngineRef.resumeWatching === 'function') {
      astEngineRef.resumeWatching();
      console.log('[Verification IPC] Chokidar watcher resumed');
    }

    // Resolve project path
    let projectPath = payload?.projectPath || null;
    if (!projectPath && astEngineRef && typeof astEngineRef.getSnapshot === 'function') {
      try {
        projectPath = astEngineRef.getSnapshot()?.rootPath || null;
      } catch (_) {}
    }
    if (!projectPath) {
      try {
        const saved = sessionStore.loadState();
        projectPath = saved?.lastActiveProjectPath || saved?.projectPath || null;
      } catch (_) {}
    }

    // Force fresh, absolute re-scan of the directory from physical disk
    let currentSnapshot = null;
    if (astEngineRef && typeof astEngineRef.rescan === 'function' && projectPath) {
      try {
        currentSnapshot = await astEngineRef.rescan(projectPath);
      } catch (err) {
        console.warn('[Verification IPC] astEngine rescan error:', err.message);
      }
    }
    if (!currentSnapshot && astEngineRef && typeof astEngineRef.getSnapshot === 'function') {
      try {
        currentSnapshot = astEngineRef.getSnapshot();
        if (!projectPath) projectPath = currentSnapshot?.rootPath || null;
      } catch (_) {}
    }

    // Load saved prompt & plan from session
    let savedState = null;
    try {
      savedState = sessionStore.loadState();
    } catch (_) {}

    // 1. Resolve or lock Baseline Snapshot (strictly pre-execution state: 0 files)
    let baselineId = savedState?.baselineSnapshotId || null;
    let beforeSnapshot = baselineId ? snapshotManager.getSnapshot(baselineId) : null;

    if (!beforeSnapshot && projectPath) {
      const baseline = snapshotManager.takeSnapshot(
        projectPath,
        'Baseline (Pre-Execution)',
        { rootPath: projectPath, files: [] }
      );
      baselineId = baseline.id;
      beforeSnapshot = baseline;
      try {
        sessionStore.saveState({ baselineSnapshotId: baselineId });
      } catch (_) {}
    }

    // 2. Take after-snapshot (post-execution) — NEVER rely on in-memory watcher state.
    // Force a fresh, absolute scan of the entire directory from the physical disk.
    let newSnap = null;
    let diffResult = null;

    if (projectPath) {
      newSnap = snapshotManager.takeSnapshot(
        projectPath,
        `Post-Verify ${new Date().toLocaleTimeString()}`,
        currentSnapshot,
        { forceDiskScan: true }
      );

      if (baselineId && newSnap) {
        try {
          diffResult = snapshotManager.diffSnapshots(baselineId, newSnap.id);
        } catch (err) {
          console.warn('[Verification IPC] Diff failed:', err.message);
        }
      }
    }

    const originalPrompt = (payload && typeof payload.originalPrompt === 'string')
      ? payload.originalPrompt
      : (savedState?.lastGeneratedPrompt || '');
    const plan = (payload && payload.plan)
      ? payload.plan
      : (savedState?.currentPlan || null);

    // Run AI verification drift engine
    let report = null;
    try {
      report = await verifyExecution({
        originalPrompt,
        plan,
        diff: diffResult,
        projectPath,
        snapshot: currentSnapshot || newSnap,
        beforeSnapshot,
        afterSnapshot: newSnap,
        forceFresh: payload?.forceFresh === true,
      });
    } catch (err) {
      console.warn('[Verification IPC] verifyExecution threw error, building rule fallback:', err.message);
      report = buildRuleBasedFallback(diffResult, currentSnapshot || newSnap, plan, null, { afterSnapshot: newSnap, projectPath });
    }

    if (!report.snapshotId) {
      report.snapshotId = newSnap?.id || baselineId || snapshotManager.getLatestId();
    }

    // Persist latest report, hashes, and lock baseline in session state
    try {
      sessionStore.saveState({
        lastVerificationReport: report,
        lastVerifiedHash: report.lastVerifiedHash || report.currentWorkspaceHash || null,
        lastDiffHash: report.diffHash || savedState?.lastDiffHash || null,
        baselineSnapshotId: baselineId,
      });
    } catch (_) {}

    // Push report event to renderer
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('verification:report', report);
    }

    return { ok: true, report };
  });

  /**
   * verification:generate-fix-prompt — deterministically compiles a fix prompt
   */
  ipcMain.handle('verification:generate-fix-prompt', async (_event, payload) => {
    try {
      const savedState = sessionStore.loadState() || {};
      const report = (payload && typeof payload === 'object' && payload.riskScore !== undefined)
        ? payload
        : (payload?.report || savedState.lastVerificationReport || {});

      const originalPrompt = (payload && payload.originalPrompt)
        || savedState.lastGeneratedPrompt
        || '';

      const plan = (payload && payload.plan)
        || savedState.currentPlan
        || null;

      const fixPrompt = buildFixPrompt({
        originalPrompt,
        plan,
        verificationReport: report,
      });

      const updatedPromptHistory = [
        ...(Array.isArray(savedState.promptHistory) ? savedState.promptHistory : []),
        {
          prompt: fixPrompt,
          feature: 'Auto-Fix: ' + (savedState.currentIntent || 'Verification Issues'),
          featureName: 'Auto-Fix',
          task: 'Auto-Fix: ' + (savedState.currentIntent || 'Verification Issues'),
          timestamp: Date.now(),
          generatedAt: new Date().toISOString(),
          agent: savedState.selectedAgent || 'Target AI',
          promptPreview: fixPrompt.slice(0, 160),
          isFixPrompt: true,
        },
      ];

      sessionStore.saveState({
        lastGeneratedPrompt: fixPrompt,
        promptHistory: updatedPromptHistory,
      });

      const win = typeof getWindow === 'function' ? getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prompt:ready', {
          prompt: fixPrompt,
          metadata: {
            isFixPrompt: true,
            riskScore: report.riskScore,
            riskLabel: report.riskLabel,
          },
          promptHistory: updatedPromptHistory,
        });
      }

      return {
        ok: true,
        prompt: fixPrompt,
        promptHistory: updatedPromptHistory,
      };
    } catch (err) {
      console.error('[Verification IPC] generate-fix-prompt error:', err);
      return { ok: false, error: err.message };
    }
  });

  /**
   * snapshot:take — manually take a snapshot
   */
  ipcMain.handle('snapshot:take', async (_event, payload) => {
    const label = (payload && typeof payload.label === 'string')
      ? payload.label.trim().slice(0, 100)
      : 'Manual Snapshot';

    let currentSnapshot = null;
    let projectPath = (payload && typeof payload.projectPath === 'string') ? payload.projectPath : null;

    try {
      if (astEngineRef && typeof astEngineRef.getSnapshot === 'function') {
        currentSnapshot = astEngineRef.getSnapshot();
        if (!projectPath) projectPath = currentSnapshot?.rootPath || null;
      }
    } catch (_) {}

    if (!projectPath) {
      return { ok: false, error: 'No active project to snapshot' };
    }

    const snap = snapshotManager.takeSnapshot(projectPath, label, currentSnapshot);
    return { ok: true, snapshot: snap };
  });

  /**
   * snapshot:diff — diff two snapshots by ID
   */
  ipcMain.handle('snapshot:diff', (_event, payload) => {
    if (!payload || typeof payload.beforeId !== 'string' || typeof payload.afterId !== 'string') {
      return { ok: false, error: 'Both beforeId and afterId are required' };
    }
    try {
      const diff = snapshotManager.diffSnapshots(payload.beforeId, payload.afterId);
      return { ok: true, diff };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * snapshot:list — list all stored snapshots
   */
  ipcMain.handle('snapshot:list', () => {
    return { ok: true, snapshots: snapshotManager.listSnapshots() };
  });

  console.log('[Verification IPC] execution:verify / verification:generate-fix-prompt / snapshot:take / snapshot:diff / snapshot:list handlers registered');
}

/**
 * Build a stub verification report from current snapshot and diff.
 */
function buildStubReport(snapshot, diff) {
  const done = [];
  const partial = [];
  const missed = [];
  const violations = [];

  if (snapshot) {
    const astParsed = (snapshot.files || []).filter(f => f.isAST).length;
    const total = (snapshot.files || []).length;

    done.push(`Project re-scanned: ${total} files, ${astParsed} AST-parsed`);

    if (diff) {
      if (diff.added.length > 0) done.push(`${diff.added.length} new file(s) created: ${diff.added.slice(0,3).join(', ')}`);
      if (diff.modified.length > 0) done.push(`${diff.modified.length} file(s) modified`);
      if (diff.deleted.length > 0) partial.push(`${diff.deleted.length} file(s) removed — verify intentional`);
    }

    // Check for risky imports
    const riskyBar = (snapshot.depHealth || []).find(h => h.name === 'Risky Imports');
    if (riskyBar && riskyBar.raw > 0) {
      violations.push(`${riskyBar.raw} risky import(s) detected (eval, vm, child_process, etc.)`);
    }
  } else {
    missed.push('No active project — re-scan failed. Please open a project first.');
  }

  const riskScore = violations.length > 0 ? Math.min(100, violations.length * 25 + 20) : 5;

  return {
    timestamp: new Date().toISOString(),
    done,
    partial: partial.length > 0 ? partial : ['No partial completions detected'],
    missed:  missed.length > 0 ? missed : ['No missed items'],
    violations: violations.length > 0 ? violations : ['No security violations detected'],
    brokenImports: ['No broken imports detected'],
    regressions: ['No functional regressions detected'],
    riskScore,
    riskLabel: riskScore < 20 ? 'Low' : riskScore < 60 ? 'Medium' : 'High',
    nextActions: [
      'Review modified files in File Tree tab',
      'Check Roadmap & Goals tab for milestone progress update',
      'Run your test suite to confirm no regressions',
      'Copy the guardrail prompt and paste it into your target AI',
    ],
    snapshotId: snapshotManager.getLatestId(),
    diff: diff ? diff.summary : null,
    isStub: true,
  };
}

module.exports = { registerVerificationIPC };
