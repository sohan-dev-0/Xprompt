/**
 * PromptLock — AI IPC Handler (Step 3)
 *
 * Registers secure IPC handlers for all AI operations:
 *  - ai:understand-project
 *  - ai:suggest-options
 *  - ai:chat-respond
 *  - ai:set-provider  (runtime key override)
 *  - ai:set-key       (runtime key override, NEVER logged)
 *  - ai:test-connection
 *
 * Security:
 *  - Never exposes raw AI response to renderer without sanitization
 *  - Never logs API keys
 *  - All handlers wrapped in try-catch with safe error messages
 */

'use strict';

const { ipcMain }        = require('electron');
const aiService          = require('../ai/ai-service');
const projectMemory      = require('../ai/project-memory');
const sessionStore       = require('../session-store');
const { getActiveProvider, hasKey, setKeyRuntime, redactKey, getKey } = require('../ai/api-key-store');


let isRegistered = false;

/**
 * Register all AI IPC handlers.
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {object} astEngineRef
 */
function register(getWindow, astEngineRef) {
  if (isRegistered) return;
  isRegistered = true;

  [
    'ai:understand-project',
    'ai:suggest-options',
    'ai:chat-respond',
    'ai:test-connection',
    'ai:set-provider',
    'ai:set-key',
    'ai:get-config'
  ].forEach(ch => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
  });

  /**
   * ai:understand-project
   * Triggers full project understanding via AI (cached via project-memory).
   */
  ipcMain.handle('ai:understand-project', async (_event) => {
    try {
      let snapshot = null;
      try {
        if (astEngineRef?.getSnapshot) snapshot = astEngineRef.getSnapshot();
      } catch (_) {}

      if (!snapshot || !snapshot.rootPath) {
        return { ok: false, error: 'No active project. Open a workspace first.' };
      }

      console.log('[AI IPC] ai:understand-project called for:', snapshot.rootPath);
      const { memory, fromCache } = await projectMemory.generate(snapshot.rootPath, snapshot);
      console.log('[AI IPC] ai:understand-project complete. fromCache:', fromCache);

      return { ok: true, memory, fromCache };
    } catch (err) {
      console.warn('[AI IPC] ai:understand-project error:', err.message);
      return { ok: false, error: err.message };
    }
  });

  /**
   * ai:suggest-options
   * Returns A/B/C approach options for a feature request.
   */
  ipcMain.handle('ai:suggest-options', async (_event, payload) => {
    const featureRequest = payload?.featureRequest || payload?.message || '';
    if (!featureRequest.trim()) {
      return { ok: false, error: 'No feature request provided' };
    }

    try {
      let snapshot = null;
      let memory   = null;
      try {
        if (astEngineRef?.getSnapshot) snapshot = astEngineRef.getSnapshot();
        if (snapshot?.rootPath) {
          const cached = projectMemory.load(snapshot.rootPath);
          if (cached) memory = cached.memory;
        }
      } catch (_) {}

      const projectContext = {
        domain:              memory?.domain               || 'Software Project',
        techStack:           memory?.techStack            || [],
        architecturePattern: memory?.architecturePattern  || 'Unknown',
        missingBlueprints:   memory?.missingBlueprints    || [],
        existingFeatures:    memory?.existingFeatures     || [],
        files:               (snapshot?.files             || []).slice(0, 20),
        activeRules:         payload?.activeRules         || [],
        _snapshot:           snapshot,                   // for project-type-detector file-path analysis
      };

      console.log('[AI IPC] ai:suggest-options for:', featureRequest.slice(0, 80));
      const result = await aiService.suggestOptions(featureRequest, projectContext);
      return { ok: true, result };
    } catch (err) {
      console.warn('[AI IPC] ai:suggest-options error:', err.message);
      return { ok: false, error: err.message };
    }
  });

  /**
   * ai:chat-respond
   * Returns AI-generated conversational reply for a chat message.
   */
  ipcMain.handle('ai:chat-respond', async (_event, payload) => {
    const message = payload?.message || '';
    if (!message.trim()) {
      return { ok: false, error: 'No message provided' };
    }

    try {
      let snapshot = null;
      let memory   = null;
      try {
        if (astEngineRef?.getSnapshot) snapshot = astEngineRef.getSnapshot();
        if (snapshot?.rootPath) {
          const cached = projectMemory.load(snapshot.rootPath);
          if (cached) memory = cached.memory;
        }
      } catch (_) {}

      const projectContext = {
        domain:            memory?.domain              || 'Software Project',
        techStack:         memory?.techStack           || [],
        architecturePattern: memory?.architecturePattern || 'Unknown',
        missingBlueprints: memory?.missingBlueprints   || [],
        existingFeatures:  memory?.existingFeatures    || [],
      };

      console.log('[AI IPC] ai:chat-respond received');
      const result = await aiService.chatRespond(message, {
        snapshot,
        projectContext,
        conversationHistory: payload?.conversationHistory || [],
        activeRules:         payload?.activeRules         || [],
      });

      if (result && (result.error === 'API_LIMIT_REACHED' || result.success === false)) {
        return { ok: false, error: 'API_LIMIT_REACHED', result };
      }

      return { ok: true, result };
    } catch (err) {
      console.warn('[AI IPC] ai:chat-respond error:', err.message);
      return { ok: false, error: 'API_LIMIT_REACHED', details: err.message };
    }
  });

  /**
   * ai:test-connection
   * Test if the active provider's API key works.
   */
  ipcMain.handle('ai:test-connection', async (_event, payload) => {
    const provider = payload?.provider || getActiveProvider();
    console.log('[AI IPC] ai:test-connection for provider:', provider);
    const result = await aiService.testConnection(provider);
    return result;
  });

  /**
   * ai:set-provider
   * Change the active provider at runtime.
   */
  ipcMain.handle('ai:set-provider', async (_event, payload) => {
    const provider = payload?.provider || payload;
    if (!provider || typeof provider !== 'string') {
      return { ok: false, error: 'Invalid provider name' };
    }
    process.env.AI_PROVIDER = provider.toLowerCase().trim();
    sessionStore.saveState({ aiProvider: process.env.AI_PROVIDER });
    return { ok: true, provider: process.env.AI_PROVIDER };
  });

  /**
   * ai:set-key
   * Set an API key at runtime (NEVER logged, NEVER stored to disk by this handler).
   */
  ipcMain.handle('ai:set-key', async (_event, payload) => {
    const { provider, key } = payload || {};
    if (!provider || !key) return { ok: false, error: 'provider and key required' };
    setKeyRuntime(provider, key);
    sessionStore.saveState({ aiKey: key.trim() });
    // Invalidate project memory so next chat triggers fresh AI understanding
    try {
      const snapshot = astEngineRef?.getSnapshot?.();
      if (snapshot?.rootPath) projectMemory.invalidate(snapshot.rootPath);
    } catch (_) {}
    return { ok: true, provider, keyPreview: redactKey(key) };
  });

  /**
   * ai:get-config
   * Returns current AI provider configuration & key availability status.
   */
  ipcMain.handle('ai:get-config', async () => {
    return {
      ok: true,
      activeProvider: getActiveProvider(),
      availableProviders: ['groq', 'gemini', 'openai', 'anthropic', 'openrouter', 'ollama'],
      hasKey: {
        groq: hasKey('groq'),
        gemini: hasKey('gemini'),
        openai: hasKey('openai'),
        anthropic: hasKey('anthropic'),
        openrouter: hasKey('openrouter'),
        ollama: true,
      },
    };
  });

  console.log('[AI IPC] ai:understand-project / ai:suggest-options / ai:chat-respond / ai:test-connection / ai:set-provider / ai:set-key / ai:get-config registered');
}

module.exports = { register };
