/**
 * PromptLock — Permission (Plan Approval) IPC Handler (Step 1 Upgrade)
 *
 * Handles the developer approve/reject/modify cycle for AI-generated plans.
 * All handlers are stub implementations — no AI API calls.
 */

'use strict';

const { ipcMain } = require('electron');
const { buildStrictPrompt } = require('../rules/prompt-builder');
const sessionStore = require('../session-store');
const projectMemory = require('../ai/project-memory');

/** In-memory plan registry (cleared when no project is active) */
const planRegistry = new Map();

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
 * Register permission-related IPC handlers.
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {object} [astEngineRef]
 */
function registerPermissionIPC(getWindow, astEngineRef) {
  if (isRegistered) return;
  isRegistered = true;

  ['plan:approve', 'plan:reject', 'plan:modify'].forEach(ch => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
  });

  /**
   * plan:approve
   * Renderer → Main: developer approves the current plan.
   * Compiles and persists the strict guardrail prompt.
   * Returns { ok: true, approved: true, planId, message, prompt, metadata }
   */
  ipcMain.handle('plan:approve', async (_event, payload) => {
    if (!payload || (typeof payload !== 'object' && typeof payload !== 'string')) {
      return { ok: false, error: 'Invalid payload: planId required' };
    }
    const planId = typeof payload === 'string' ? payload : (payload.planId || 'plan_' + Date.now());
    console.log('[Permission IPC] plan:approve — planId:', planId);
    planRegistry.set(planId, { status: 'approved', timestamp: new Date().toISOString() });

    const savedState = sessionStore.loadState();
    sessionStore.saveState({ permissionStatus: 'approved' });

    let promptResult = null;
    let updatedPromptHistory = null;
    try {
      let plan = (typeof payload === 'object' && payload.plan) ? payload.plan : null;
      if (!plan && savedState.currentPlan?.id === planId) {
        plan = savedState.currentPlan;
      } else if (!plan) {
        plan = savedState.currentPlan || { id: planId };
      }

      const aiService = require('../ai/ai-service');
      const isQ = (s) => typeof aiService?.isConversationalQuestion === 'function' ? aiService.isConversationalQuestion(s) : false;
      const cleanFn = (s) => typeof aiService?.cleanFeatureIntent === 'function' ? aiService.cleanFeatureIntent(s) : s;
      const candidateTasks = [
        typeof payload === 'object' ? (payload.currentIntent || payload.task || payload.feature) : null,
        savedState.currentIntent,
        plan.userIntent,
        plan.task,
        plan.intentSummary,
        typeof payload === 'object' ? payload.userIntent : null,
        plan.featureType,
      ].filter(c => isValidIntentString(c) && !isQ(c));
      const rawTask = candidateTasks.find(c => isValidIntentString(c) && !isQ(c))
        || (isValidIntentString(savedState.currentIntent) && !isQ(savedState.currentIntent) ? savedState.currentIntent : 'Feature Implementation');
      const task = cleanFn(rawTask);
      const agent = (typeof payload === 'object' && payload.agent)
        || savedState.selectedTargetAI
        || 'cursor';
      const activeRules = (typeof payload === 'object' && Array.isArray(payload.activeRules))
        ? payload.activeRules
        : (savedState.activeRules || ['zero-secrets', 'zod-validation', 'sql-guard', 'no-eval']);

      // Force AST scan to ensure latest functions and file structures are captured
      let snapshot = null;
      let memory = null;
      let projectPath = (typeof payload === 'object' && payload.projectPath) || savedState.lastActiveProjectPath || null;
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
        if (typeof payload === 'object' && payload.snapshot && (!snapshot || !snapshot.files || snapshot.files.length === 0)) {
          snapshot = payload.snapshot;
        }
        if (snapshot?.rootPath) {
          const cached = projectMemory.load(snapshot.rootPath);
          if (cached) memory = cached.memory;
        }
      } catch (scanErr) {
        console.warn('[Permission IPC] AST scan error:', scanErr.message);
        if (typeof payload === 'object' && payload.snapshot) snapshot = payload.snapshot;
        else if (astEngineRef?.getSnapshot) snapshot = astEngineRef.getSnapshot();
      }



      const selectedOption = (typeof payload === 'object' && payload.selectedOption)
        || plan.selectedOption
        || savedState.selectedOption
        || null;

      const selectedOptionName = (typeof payload === 'object' && payload.selectedOptionName)
        || plan.selectedOptionName
        || savedState.selectedOptionName
        || (typeof selectedOption === 'object' && selectedOption ? (selectedOption.name || selectedOption.label || selectedOption.title || selectedOption.description) : null)
        || (typeof selectedOption === 'string' ? selectedOption : null);

      let filesToEdit = (typeof selectedOption === 'object' && selectedOption && Array.isArray(selectedOption.filesToEdit) && selectedOption.filesToEdit.length > 0)
        ? [...selectedOption.filesToEdit]
        : (Array.isArray(plan.filesToEdit) && plan.filesToEdit.length > 0
          ? [...plan.filesToEdit]
          : (typeof payload === 'object' && Array.isArray(payload.filesToEdit) ? [...payload.filesToEdit] : []));

      let filesToCreate = (typeof selectedOption === 'object' && selectedOption && Array.isArray(selectedOption.filesToCreate) && selectedOption.filesToCreate.length > 0)
        ? [...selectedOption.filesToCreate]
        : (Array.isArray(plan.filesToCreate) && plan.filesToCreate.length > 0
          ? [...plan.filesToCreate]
          : (typeof payload === 'object' && Array.isArray(payload.filesToCreate) ? [...payload.filesToCreate] : []));

      const isProdModular = plan.isProductionModular
        || (typeof selectedOption === 'object' && selectedOption?.isProductionModular)
        || /production\s*modular/i.test(selectedOptionName || '')
        || /production\s*modular/i.test(typeof selectedOption === 'string' ? selectedOption : '');

      const isSingleFileProto = plan.isSingleFilePrototype
        || (typeof selectedOption === 'object' && selectedOption?.isSingleFilePrototype)
        || /single\s*file/i.test(selectedOptionName || '')
        || /single\s*file/i.test(typeof selectedOption === 'string' ? selectedOption : '');

      if (isProdModular) {
        if (!snapshot || !snapshot.files || snapshot.files.length === 0) {
          filesToCreate = ['index.html', 'style.css', 'app.js'];
          filesToEdit = [];
        }
      } else if (isSingleFileProto) {
        if (!snapshot || !snapshot.files || snapshot.files.length === 0) {
          filesToCreate = ['index.html'];
          filesToEdit = [];
        }
      }

      const planDomain = plan.domain || (typeof plan.featureType === 'string' && plan.featureType.length <= 40 && plan.featureType !== task ? plan.featureType : undefined);
      const planWithTask = {
        ...plan,
        task,
        intentSummary: task,
        userIntent: plan.userIntent || savedState.currentIntent || task,
        domain: planDomain,
        featureType: planDomain,
        selectedOption: selectedOption || selectedOptionName,
        selectedOptionName: selectedOptionName || (typeof selectedOption === 'string' ? selectedOption : null),
        selectedOptionObject: typeof selectedOption === 'object' ? selectedOption : null,
        filesToEdit,
        filesToCreate,
        isProductionModular: isProdModular,
        isSingleFilePrototype: isSingleFileProto,
        architectureBadge: isProdModular ? '✅ Production Architecture Selected' : undefined,
      };

      promptResult = await buildStrictPrompt({
        plan: planWithTask,
        currentIntent: task,
        task,
        feature: task,
        userIntent: plan.userIntent || savedState.currentIntent || task,
        agent,
        activeRules,
        snapshot,
        projectMemory: memory,
      });

      if (promptResult?.prompt) {
        const promptHistory = Array.isArray(savedState.promptHistory) ? savedState.promptHistory : [];
        updatedPromptHistory = [
          ...promptHistory,
          {
            prompt: promptResult.prompt,
            feature: task,
            featureName: task,
            task,
            timestamp: Date.now(),
            generatedAt: new Date().toISOString(),
            validation: promptResult.metadata?.validation,
            agent,
            planId,
            promptPreview: promptResult.prompt.slice(0, 160),
          },
        ];
        const selectedRuleIds = promptResult.metadata?.selectedSecurityRules || [];

        let baselineSnapshotId = savedState?.baselineSnapshotId || null;
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
          console.warn('[Permission IPC] Could not take baseline snapshot:', err.message);
        }

        sessionStore.saveState({
          lastGeneratedPrompt: promptResult.prompt,
          currentIntent: task,
          currentPlan: planWithTask,
          selectedOption: selectedOption || selectedOptionName,
          selectedOptionName: selectedOptionName || (typeof selectedOption === 'string' ? selectedOption : null),
          promptHistory: updatedPromptHistory,
          activeRules: selectedRuleIds.length > 0 ? selectedRuleIds : savedState.activeRules,
          baselineSnapshotId,
          lastVerifiedHash: null,
          lastVerificationReport: null,
        });

        const win = typeof getWindow === 'function' ? getWindow() : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('prompt:ready', {
            prompt: promptResult.prompt,
            selectedRuleIds,
            rules: promptResult.metadata?.security?.rules || [],
            metadata: promptResult.metadata,
            validation: promptResult.metadata?.validation,
            promptHistory: updatedPromptHistory,
          });
        }
      }
    } catch (err) {
      console.warn('[Permission IPC] plan:approve prompt generation warning:', err.message);
    }

    return {
      ok: true,
      approved: true,
      planId,
      message: 'Plan approved. Strict guardrail prompt generated.',
      prompt: promptResult?.prompt || null,
      selectedRuleIds: promptResult?.metadata?.selectedSecurityRules || [],
      rules: promptResult?.metadata?.security?.rules || [],
      metadata: promptResult?.metadata || null,
      validation: promptResult?.metadata?.validation || null,
      promptHistory: updatedPromptHistory || null,
    };
  });

  /**
   * plan:reject
   * Renderer → Main: developer rejects the plan.
   * Returns { approved: false }
   */
  ipcMain.handle('plan:reject', (_event, payload) => {
    if (!payload || typeof payload.planId !== 'string') {
      return { ok: false, error: 'Invalid payload: planId required' };
    }
    console.log('[Permission IPC] plan:reject — planId:', payload.planId);
    planRegistry.set(payload.planId, { status: 'rejected', timestamp: new Date().toISOString() });

    return {
      ok: true,
      approved: false,
      planId: payload.planId,
      message: 'Plan rejected. Please revise your intent and resubmit.',
    };
  });

  /**
   * plan:modify
   * Renderer → Main: developer requests a modification with notes.
   * Returns { revisedPlan } (stub)
   */
  ipcMain.handle('plan:modify', (_event, payload) => {
    if (!payload || typeof payload.planId !== 'string') {
      return { ok: false, error: 'Invalid payload: planId required' };
    }

    const notes = typeof payload.notes === 'string' ? payload.notes.trim().slice(0, 1000) : '';
    console.log('[Permission IPC] plan:modify — planId:', payload.planId);
    planRegistry.set(payload.planId, {
      status: 'modified',
      timestamp: new Date().toISOString(),
      // Do not store the notes in registry (may contain sensitive intent details)
    });

    // Return stub revised plan
    const revisedPlan = {
      id: payload.planId,
      revisedAt: new Date().toISOString(),
      status: 'awaiting_review',
      modificationNote: notes.slice(0, 80) + (notes.length > 80 ? '…' : ''),
      filesToEdit: ['src/auth/auth.service.ts'],
      filesToCreate: ['src/auth/dto/login.dto.ts'],
      forbiddenFiles: ['.env'],
      missingFiles: [],
      riskLevel: 'low',
      riskReasons: ['Modification reduces scope — lower risk'],
    };

    return { ok: true, revisedPlan };
  });

  console.log('[Permission IPC] plan:approve / plan:reject / plan:modify handlers registered');
}

module.exports = { registerPermissionIPC };
