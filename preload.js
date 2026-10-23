/**
 * PromptLock — Secure Preload Bridge (Step 1 & 2 Upgrade)
 *
 * Exposes strictly typed APIs to the renderer process via contextBridge.
 * Follows security principles: contextIsolation: true, nodeIntegration: false.
 * Never exposes raw ipcRenderer or Node internals.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const apiBridge = {
  // ── Chat & Orchestration (Step 1.2 Upgrade) ─────────────────────────────
  chat: {
    send: (payload) =>
      ipcRenderer.invoke('chat:send', typeof payload === 'string' ? { message: payload } : payload),
    selectOption: (optionOrId, planId, extra) => {
      if (typeof optionOrId === 'object' && optionOrId !== null) {
        return ipcRenderer.invoke('chat:options', optionOrId);
      }
      return ipcRenderer.invoke('chat:options', {
        optionId: optionOrId,
        planId,
        ...(typeof extra === 'object' ? extra : {}),
      });
    },
    approve: (planIdOrPayload) =>
      ipcRenderer.invoke('chat:approve', typeof planIdOrPayload === 'string' ? { planId: planIdOrPayload } : planIdOrPayload),
    reject: (planId) =>
      ipcRenderer.invoke('chat:reject', typeof planId === 'string' ? { planId } : planId),
    modify: (planId, notes) =>
      ipcRenderer.invoke('chat:modify', { planId, notes }),
  },

  // ── Progress Engine (Step 1.2 & 2 Upgrade) ───────────────────────────────
  progress: {
    get: (featureType) => ipcRenderer.invoke('progress:get', featureType),
    update: () => ipcRenderer.invoke('progress:update'),
    onUpdate: (cb) => {
      const handler = (_event, progress) => cb(progress);
      ipcRenderer.on('progress:update', handler);
      return () => ipcRenderer.removeListener('progress:update', handler);
    },
  },

  // ── Intent & Plan Aliases (Backward Compatibility) ──────────────────────
  intent: {
    submit: (payload) => ipcRenderer.invoke('intent:submit', payload),
  },

  plan: {
    approve: (payload) =>
      ipcRenderer.invoke('plan:approve', typeof payload === 'string' ? { planId: payload } : payload),
    reject: (payload) =>
      ipcRenderer.invoke('plan:reject', typeof payload === 'string' ? { planId: payload } : payload),
    modify: (idOrPayload, notes) => {
      if (typeof idOrPayload === 'string') {
        return ipcRenderer.invoke('plan:modify', { planId: idOrPayload, notes });
      }
      return ipcRenderer.invoke('plan:modify', idOrPayload);
    },
  },

  // ── Prompt ──────────────────────────────────────────────────────────────
  prompt: {
    generate:     (payload) => ipcRenderer.invoke('prompt:generate', payload),
    getLast:      () => ipcRenderer.invoke('prompt:get-last'),
    getTemplates: () => ipcRenderer.invoke('prompt:get-templates'),
    onReady:      (cb) => {
      if (typeof window !== 'undefined' && window.__promptReadyHandler) {
        ipcRenderer.removeListener('prompt:ready', window.__promptReadyHandler);
      }
      const handler = (_event, data) => cb(data);
      if (typeof window !== 'undefined') {
        window.__promptReadyHandler = handler;
      }
      ipcRenderer.on('prompt:ready', handler);
      return () => ipcRenderer.removeListener('prompt:ready', handler);
    },
  },

  // ── Verify ──────────────────────────────────────────────────────────────
  verify: {
    run: (payload) => ipcRenderer.invoke('execution:verify', payload),
    generateFixPrompt: (payload) => ipcRenderer.invoke('verification:generate-fix-prompt', payload),
  },
  verification: {
    run: (payload) => ipcRenderer.invoke('execution:verify', payload),
    generateFixPrompt: (payload) => ipcRenderer.invoke('verification:generate-fix-prompt', payload),
  },

  // ── Security (Step 5) ──────────────────────────────────────────────────
  security: {
    selectRules: (payload) => ipcRenderer.invoke('security:select-rules', payload),
  },

  // ── AI Service & Orchestration (Step 3 Upgrade) ────────────────────────
  ai: {
    understandProject: () => ipcRenderer.invoke('ai:understand-project'),
    suggestOptions: (payload) =>
      ipcRenderer.invoke('ai:suggest-options', typeof payload === 'string' ? { featureRequest: payload } : payload),
    chatRespond: (payload) =>
      ipcRenderer.invoke('ai:chat-respond', typeof payload === 'string' ? { message: payload } : payload),
    setProvider: (provider) =>
      ipcRenderer.invoke('ai:set-provider', typeof provider === 'string' ? { provider } : provider),
    setKey: (keyOrPayload, maybeKey) => {
      if (typeof keyOrPayload === 'string' && typeof maybeKey === 'string') {
        return ipcRenderer.invoke('ai:set-key', { provider: keyOrPayload, key: maybeKey });
      }
      if (typeof keyOrPayload === 'string') {
        return ipcRenderer.invoke('ai:set-key', { provider: 'gemini', key: keyOrPayload });
      }
      return ipcRenderer.invoke('ai:set-key', keyOrPayload);
    },
    testConnection: (provider) =>
      ipcRenderer.invoke('ai:test-connection', typeof provider === 'string' ? { provider } : provider),
    getConfig: () => ipcRenderer.invoke('ai:get-config'),
  },

  // ── Project Management (Per-Project Storage) ───────────────────────────
  project: {
    getActive:    ()           => ipcRenderer.invoke('project:get-active'),
    switch:       (payload)    => ipcRenderer.invoke('project:switch', typeof payload === 'string' ? { rootPath: payload } : payload),
    getRecent:    ()           => ipcRenderer.invoke('project:get-recent'),
    removeRecent: (payload)    => ipcRenderer.invoke('project:remove-recent', typeof payload === 'string' ? { projectId: payload } : payload),
    deleteData:   (payload)    => ipcRenderer.invoke('project:delete-data', typeof payload === 'string' ? { projectId: payload } : payload),
    exportData:   (payload)    => ipcRenderer.invoke('project:export-data', payload),
    importData:   (payload)    => ipcRenderer.invoke('project:import-data', payload),
    autoLoad:     ()           => ipcRenderer.invoke('project:auto-load'),
  },

  // ── Storage Stats ───────────────────────────────────────────────────────
  storage: {
    getStats:     ()           => ipcRenderer.invoke('storage:get-stats'),
  },

  // ── Session ─────────────────────────────────────────────────────────────
  session: {
    load: () => ipcRenderer.invoke('session:load'),
    save: (updates) => ipcRenderer.invoke('session:save', updates),
    saveSync: (updates) => ipcRenderer.sendSync('session:save-sync', updates),
  },

  // ── Snapshots ───────────────────────────────────────────────────────────
  snapshot: {
    take: (payload) => ipcRenderer.invoke('snapshot:take', payload),
    diff: (payload) => ipcRenderer.invoke('snapshot:diff', payload),
    list: () => ipcRenderer.invoke('snapshot:list'),
  },

  // ── Verification Report Event Stream ────────────────────────────────────
  onVerificationReport: (cb) => {
    const handler = (_event, report) => cb(report);
    ipcRenderer.on('verification:report', handler);
    return () => ipcRenderer.removeListener('verification:report', handler);
  },

  // ── Window controls ─────────────────────────────────────────────────────
  expand:          ()           => ipcRenderer.send('window-expand'),
  collapse:        ()           => ipcRenderer.send('window-collapse'),
  minimize:        ()           => ipcRenderer.send('window-minimize'),
  close:           ()           => ipcRenderer.send('window-close'),
  move:            (dx, dy)     => ipcRenderer.send('window-move', { dx, dy }),
  platform:        process.platform,

  // ── Utilities ────────────────────────────────────────────────────────────
  openFolder:      (opts)       => ipcRenderer.invoke('dialog-open-folder', opts),
  copyToClipboard: (text)       => ipcRenderer.invoke('clipboard-write', text),

  // ── Shortcut passthrough ─────────────────────────────────────────────────
  onToggle:        (cb)         => ipcRenderer.on('toggle-from-shortcut', cb),

  // ── AST / Project Intelligence ───────────────────────────────────────────
  astScan:         (folderPath) => ipcRenderer.invoke('ast:scan', folderPath),
  astGetSnapshot:  ()           => ipcRenderer.invoke('ast:get-snapshot'),
  astStop:         ()           => ipcRenderer.invoke('ast:stop'),
  onAstUpdate:     (cb) => {
    const handler = (_event, snapshot) => cb(snapshot);
    ipcRenderer.on('ast:update', handler);
    return () => ipcRenderer.removeListener('ast:update', handler);
  },

  // ── Session State Persistence aliases ─────────────────────────────────────
  sessionLoad:     ()           => ipcRenderer.invoke('session:load'),
  sessionSave:     (updates)    => ipcRenderer.invoke('session:save', updates),
  sessionSaveSync: (updates)    => ipcRenderer.sendSync('session:save-sync', updates),
};

// Expose window.api as specified
contextBridge.exposeInMainWorld('api', apiBridge);

// Expose window.promptLock for complete backward compatibility
contextBridge.exposeInMainWorld('promptLock', apiBridge);

