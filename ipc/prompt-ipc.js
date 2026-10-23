/**
 * PromptLock — Prompt Generation IPC Handler (Step 4 Strict Prompt Builder & Polish)
 *
 * Compiles approved execution plans into strict guardrail prompts.
 * Fully grounded with:
 *  - Target AI Agent formatting (Cursor, Claude, Anti-Gravity, etc.)
 *  - Missing File Analysis & Warnings
 *  - Active Security Guardrails (Zero Secrets, Zod, SQL Guard, No Eval)
 *  - Step 2.6 AST-Grounded Milestone & Roadmap Constraints
 *  - Strict Worker Mode instructions
 *  - Preset Templates library
 */

'use strict';

const { ipcMain } = require('electron');
const { buildStrictPrompt } = require('../rules/prompt-builder');
const { getTemplates } = require('../rules/prompt-templates');
const sessionStore = require('../session-store');
const projectMemory = require('../ai/project-memory');

let isRegistered = false;

function isValidIntentString(val) {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'null' || lower === 'undefined') return false;
  if (lower === 'feature implementation' || lower === 'implement approved feature scope') return false;
  return true;
}

/**
 * Register prompt-related IPC handlers.
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {object} [astEngineRef] - Reference to the ast-engine for watcher control
 */
function registerPromptIPC(getWindow, astEngineRef) {
  if (isRegistered) return;
  isRegistered = true;

  ['prompt:generate', 'prompt:get-last', 'prompt:get-templates', 'security:select-rules'].forEach(ch => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
  });

  /**
   * security:select-rules (Step 5)
   * Renderer → Main: Analyze context and select relevant security rules.
   */
  ipcMain.handle('security:select-rules', async (_event, payload = {}) => {
    try {
      const { selectSecurityRules } = require('../security/rule-selector');
      let snapshot = null;
      let memory = null;
      if (astEngineRef?.getSnapshot) snapshot = astEngineRef.getSnapshot();
      if (snapshot?.rootPath) {
        const cached = projectMemory.load(snapshot.rootPath);
        if (cached) memory = cached.memory;
      }
      return await selectSecurityRules({
        ...payload,
        snapshot: payload.snapshot || snapshot,
        projectMemory: payload.projectMemory || memory,
      });
    } catch (err) {
      console.warn('[Prompt IPC] security:select-rules error:', err);
      const { selectRulesHeuristically } = require('../security/rule-selector');
      return selectRulesHeuristically(payload);
    }
  });

  /**
   * prompt:generate
   * Renderer → Main: generate a strict guardrail prompt from the approved plan.
   */
  ipcMain.handle('prompt:generate', async (_event, payload = {}) => {
    try {
      console.log('[Prompt IPC] prompt:generate called');

      const savedState = sessionStore.loadState();

      // Resolve plan
      let plan = payload.plan || null;
      if (!plan && payload.planId && savedState.currentPlan?.id === payload.planId) {
        plan = savedState.currentPlan;
      } else if (!plan) {
        plan = savedState.currentPlan || {};
      }

      const candidateTasks = [
        typeof payload === 'object' ? (payload.currentIntent || payload.task || payload.feature) : null,
        savedState.currentIntent,
        plan.userIntent,
        plan.task,
        plan.intentSummary,
        typeof payload === 'object' ? payload.userIntent : null,
        plan.featureType,
      ];
      const task = candidateTasks.find(isValidIntentString)
        || (isValidIntentString(savedState.currentIntent) ? savedState.currentIntent : 'Feature Implementation');

      console.log(`[Prompt IPC] Regenerating prompt for feature: ${task}`);
      const agent = payload.agent || savedState.selectedTargetAI || 'cursor';
      const activeRules = Array.isArray(payload.activeRules) && payload.activeRules.length > 0
        ? payload.activeRules
        : (savedState.activeRules || null);

      // Pause chokidar watcher during prompt generation if available
      if (astEngineRef && typeof astEngineRef.pauseWatching === 'function') {
        astEngineRef.pauseWatching();
        console.log('[Prompt IPC] Chokidar watcher paused during prompt compilation');
      }

      // AST Snapshot - force AST scan to ensure latest functions and file structures are captured
      let snapshot = null;
      let memory = null;
      let projectPath = payload.projectPath || savedState.lastActiveProjectPath || null;
      if (!projectPath) {
        try {
          const projectIPC = require('./project-ipc');
          projectPath = projectIPC.getActiveRootPath();
        } catch (_) {}
      }
      if (!projectPath && astEngineRef?.getSnapshot) {
        projectPath = astEngineRef.getSnapshot()?.rootPath;
      }

      try {
        const engine = astEngineRef || require('../ast-engine');
        if (projectPath && (typeof engine.scan === 'function' || typeof engine.rescan === 'function')) {
          const scanFn = typeof engine.scan === 'function' ? engine.scan : engine.rescan;
          snapshot = await scanFn(projectPath);
        } else if (engine?.getSnapshot) {
          snapshot = engine.getSnapshot();
        }
        if (payload.snapshot && (!snapshot || !snapshot.files || snapshot.files.length === 0)) {
          snapshot = payload.snapshot;
        }
        if (snapshot?.rootPath) {
          const cached = projectMemory.load(snapshot.rootPath);
          if (cached) memory = cached.memory;
        }
      } catch (scanErr) {
        console.warn('[Prompt IPC] AST scan error:', scanErr.message);
        if (payload.snapshot) snapshot = payload.snapshot;
        else if (astEngineRef?.getSnapshot) snapshot = astEngineRef.getSnapshot();
      }



      // Resolve selectedOption & files
      let selectedOption = payload.selectedOption
        || plan.selectedOption
        || savedState.selectedOption
        || null;

      let selectedOptionName = payload.selectedOptionName
        || plan.selectedOptionName
        || savedState.selectedOptionName
        || (typeof selectedOption === 'object' && selectedOption ? (selectedOption.name || selectedOption.label || selectedOption.title || selectedOption.description) : null)
        || (typeof selectedOption === 'string' ? selectedOption : null);

      let filesToEdit = (typeof selectedOption === 'object' && selectedOption && Array.isArray(selectedOption.filesToEdit) && selectedOption.filesToEdit.length > 0)
        ? [...selectedOption.filesToEdit]
        : (Array.isArray(plan.filesToEdit) && plan.filesToEdit.length > 0
          ? [...plan.filesToEdit]
          : (Array.isArray(payload.filesToEdit) ? [...payload.filesToEdit] : []));

      let filesToCreate = (typeof selectedOption === 'object' && selectedOption && Array.isArray(selectedOption.filesToCreate) && selectedOption.filesToCreate.length > 0)
        ? [...selectedOption.filesToCreate]
        : (Array.isArray(plan.filesToCreate) && plan.filesToCreate.length > 0
          ? [...plan.filesToCreate]
          : (Array.isArray(payload.filesToCreate) ? [...payload.filesToCreate] : []));

      // Filter backend files if project is frontend
      const { detectProjectType } = require('../ast/project-type-detector');
      const { isBackendFilename } = require('../rules/missing-file-analyzer');
      const typeResult = detectProjectType(snapshot, memory || {});
      const isFrontendProj = typeResult.projectType === 'frontend';

      if (isFrontendProj) {
        filesToEdit = filesToEdit.filter(f => !isBackendFilename(f));
        filesToCreate = filesToCreate.filter(f => !isBackendFilename(f));
        if (filesToEdit.length === 0 && filesToCreate.length === 0) {
          filesToEdit = ['index.html', 'app.js'];
          filesToCreate = [];
        }
      }

      const planDomain = plan.domain || (typeof plan.featureType === 'string' && plan.featureType.length <= 40 && plan.featureType !== task ? plan.featureType : undefined);
      const planWithTask = {
        ...plan,
        task,
        intentSummary: task,
        userIntent: task,
        domain: planDomain,
        featureType: planDomain,
        selectedOption: selectedOption || selectedOptionName,
        selectedOptionName: selectedOptionName || (typeof selectedOption === 'string' ? selectedOption : null),
        selectedOptionObject: typeof selectedOption === 'object' ? selectedOption : null,
        filesToEdit,
        filesToCreate,
      };

      const result = await buildStrictPrompt({
        plan: planWithTask,
        currentIntent: task,
        task,
        feature: task,
        userIntent: task,
        agent,
        activeRules,
        snapshot,
        projectMemory: memory,
        projectType: typeResult.projectType,
      });

      // Resume watcher
      if (astEngineRef && typeof astEngineRef.resumeWatching === 'function') {
        astEngineRef.resumeWatching();
        console.log('[Prompt IPC] Chokidar watcher resumed');
      }

      // Persist in session store
      const session = sessionStore.loadState();
      session.promptHistory = Array.isArray(session.promptHistory) ? session.promptHistory : [];

      const newPrompt = result.prompt;
      session.promptHistory.push({
        prompt: newPrompt,
        feature: task,
        featureName: task,
        task,
        timestamp: Date.now(),
        generatedAt: new Date().toISOString(),
        validation: result.metadata?.validation || result.validation,
        agent,
        planId: planWithTask.id || `plan_${Date.now()}`,
        promptPreview: newPrompt.slice(0, 160),
      });

      // Establish locked Baseline Snapshot for verification of this execution
      let baselineSnapshotId = session.baselineSnapshotId || null;
      try {
        let rootPath = snapshot?.rootPath;
        if (!rootPath && astEngineRef && typeof astEngineRef.getSnapshot === 'function') {
          const cur = astEngineRef.getSnapshot();
          rootPath = cur?.rootPath;
        }
        if (rootPath) {
          const snapshotManager = require('../scanner/snapshot-manager');
          const baselineSnap = snapshotManager.takeSnapshot(
            rootPath,
            'Baseline (Pre-Execution)',
            snapshot || (astEngineRef && typeof astEngineRef.getSnapshot === 'function' ? astEngineRef.getSnapshot() : null)
          );
          if (baselineSnap?.id) {
            baselineSnapshotId = baselineSnap.id;
          }
        }
      } catch (err) {
        console.warn('[Prompt IPC] Could not take baseline snapshot:', err.message);
      }

      await sessionStore.saveState({
        promptHistory: session.promptHistory,
        lastGeneratedPrompt: newPrompt,
        currentIntent: task,
        currentPlan: planWithTask,
        selectedOption: selectedOption || selectedOptionName,
        selectedOptionName: selectedOptionName || (typeof selectedOption === 'string' ? selectedOption : null),
        activeRules: result.metadata?.selectedSecurityRules || session.activeRules,
        baselineSnapshotId,
        lastVerifiedHash: null,
        lastVerificationReport: null,
      });

      const selectedRuleIds = result.metadata?.selectedSecurityRules || [];

      const win = typeof getWindow === 'function' ? getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prompt:ready', {
          prompt: newPrompt,
          selectedRuleIds,
          rules: result.metadata?.security?.rules || [],
          metadata: {
            ...result.metadata,
            promptHistory: session.promptHistory,
          },
          validation: result.metadata?.validation || result.validation,
          promptHistory: session.promptHistory,
        });
      }

      console.log(`[Prompt IPC] Strict prompt generated (${result.metadata.tokenEstimate} tokens est.) for ${agent}`);

      return {
        ok: true,
        prompt: newPrompt,
        selectedRuleIds,
        rules: result.metadata?.security?.rules || [],
        metadata: {
          ...result.metadata,
          promptHistory: session.promptHistory,
        },
        validation: result.metadata?.validation || result.validation,
        promptHistory: session.promptHistory,
      };

    } catch (err) {
      console.error('[Prompt IPC] prompt:generate error:', err);
      if (astEngineRef && typeof astEngineRef.resumeWatching === 'function') {
        astEngineRef.resumeWatching();
      }
      return { ok: false, error: err.message };
    }
  });

  /**
   * prompt:get-last
   * Returns previously generated prompt from session state.
   */
  ipcMain.handle('prompt:get-last', () => {
    const s = sessionStore.loadState();
    return {
      ok: true,
      prompt: s.lastGeneratedPrompt || null,
      promptHistory: s.promptHistory || [],
    };
  });

  /**
   * prompt:get-templates
   * Returns available preset prompt templates.
   */
  ipcMain.handle('prompt:get-templates', () => {
    return {
      ok: true,
      templates: getTemplates(),
    };
  });

  console.log('[Prompt IPC] prompt:generate, prompt:get-last, and prompt:get-templates handlers registered');
}

module.exports = { registerPromptIPC };
