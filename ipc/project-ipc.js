/**
 * PromptLock — Project Management IPC Handler
 *
 * Manages active project context, switching between projects, recent projects list,
 * and auto-loading on startup.
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { ipcMain }  = require('electron');
const projectStore = require('../storage/project-store');

let activeProjectId = null;
let activeRootPath  = null;

/**
 * Get the currently active project ID.
 * Falls back to lastProjectId from settings if set.
 * @returns {string|null}
 */
function getActiveProjectId() {
  if (activeProjectId) return activeProjectId;
  try {
    const settings = projectStore.loadSettingsSync();
    if (settings.lastProjectId && projectStore.isValidProjectId(settings.lastProjectId)) {
      activeProjectId = settings.lastProjectId;
      const meta = projectStore.loadMetaSync(activeProjectId);
      if (meta?.rootPath) activeRootPath = meta.rootPath;
      return activeProjectId;
    }
  } catch (_) {}
  return null;
}

/**
 * Get the currently active project root path.
 * @returns {string|null}
 */
function getActiveRootPath() {
  if (activeRootPath) return activeRootPath;
  const pid = getActiveProjectId();
  if (pid) {
    try {
      const meta = projectStore.loadMetaSync(pid);
      if (meta?.rootPath) activeRootPath = meta.rootPath;
    } catch (_) {}
  }
  return activeRootPath;
}

let isRegistered = false;

/**
 * Set the currently active project context in memory.
 * @param {string} id - 16-character hex projectId
 * @param {string} rootPath - Absolute directory path
 */
function setActiveProject(id, rootPath) {
  activeProjectId = id;
  activeRootPath  = projectStore.sanitizeProjectPath(rootPath);
}

let switchQueueChain = Promise.resolve();
let isScanOrPromptActive = false;
let activeScanPromise = null;

function setScanInProgress(inProgress, promise = null) {
  isScanOrPromptActive = Boolean(inProgress);
  activeScanPromise = promise;
}

function setPromptInProgress(inProgress, promise = null) {
  isScanOrPromptActive = Boolean(inProgress);
  activeScanPromise = promise;
}

function isOperationInProgress() {
  return isScanOrPromptActive;
}

async function performProjectSwitch(payload, prevProjectId, prevRootPath, getWindow, astEngineRef) {
  try {
    let rawRootPath = typeof payload === 'string' ? payload : payload?.rootPath;
    if (!rawRootPath || typeof rawRootPath !== 'string') {
      throw new Error('rootPath is required to switch projects.');
    }

    const rootPath = projectStore.sanitizeProjectPath(rawRootPath);
    const projectId = projectStore.getProjectId(rootPath);
    projectStore.ensureProjectDir(projectId);

    // Immediately set active project so any loadState() or session call uses the new project ID
    setActiveProject(projectId, rootPath);

    // Check if project folder on disk is empty (0 files)
    let isFolderEmpty = false;
    try {
      if (fs.existsSync(rootPath)) {
        const diskFiles = fs.readdirSync(rootPath);
        isFolderEmpty = diskFiles.filter(f => !f.startsWith('.')).length === 0;
      }
    } catch (_) {}

    // 1. Immediately CLEAR all in-memory variables in the Node process:
    // astSummary = null, projectMemory = {}, activeFeatureRequirements = [], currentIntent = '', pendingAction = null
    try {
      const aiService = require('../ai/ai-service');
      if (typeof aiService.clearMemory === 'function') {
        aiService.clearMemory();
        if (isFolderEmpty) {
          aiService.setInMemoryState({
            projectMemory: { domain: 'Unknown', techStack: 'Unknown' },
            astSummary: null,
          });
        }
      }
    } catch (_) {}

    try {
      const chatIPC = require('./chat-ipc');
      if (typeof chatIPC.clearChatState === 'function') {
        chatIPC.clearChatState();
      }
    } catch (_) {}

    const projectName = (typeof payload === 'object' && payload?.name)
      ? payload.name
      : path.basename(rootPath);

    const meta = {
      projectId,
      rootPath,
      name: projectName,
      lastOpened: Date.now(),
    };

    // 2. Load ONLY the new project's session.json. If it's an empty/new folder, start with a completely blank slate.
    const sessionPath = projectStore.getProjectFilePath(projectId, 'session.json');
    const isNewProjectStorage = !fs.existsSync(sessionPath)
      && !fs.existsSync(projectStore.getProjectFilePath(projectId, 'roadmap.json'));

    if (isFolderEmpty || isNewProjectStorage) {
      await projectStore.saveRoadmap(projectId, {
        activeGoal: '',
        milestones: [],
        progress: 0,
        activeMilestoneId: null,
      });
      const defaultSess = projectStore.getDefaultSession(projectId);
      defaultSess.chatHistory = [];
      defaultSess.currentIntent = '';
      defaultSess.activeFeatureRequirements = [];
      defaultSess.pendingAction = null;
      defaultSess.pendingFeature = null;
      defaultSess.pendingBugReport = null;
      defaultSess.lastGeneratedPrompt = null;
      defaultSess.currentPlan = null;
      defaultSess.roadmapGoal = '';
      defaultSess.roadmapMilestones = [];
      defaultSess.activeMilestoneId = null;
      defaultSess.activeTab = 'scanner';
      await projectStore.saveSession(projectId, defaultSess);

      try {
        const projectMemory = require('../ai/project-memory');
        if (isFolderEmpty && typeof projectMemory.save === 'function') {
          projectMemory.save(projectId, {
            domain: 'Unknown',
            techStack: 'Unknown',
            architecturePattern: 'Unknown',
            primaryLanguage: 'Unknown',
            missingBlueprints: [],
            existingFeatures: [],
          }, 0);
        } else if (typeof projectMemory.invalidate === 'function') {
          projectMemory.invalidate(projectId);
          projectMemory.invalidate(rootPath);
        }
      } catch (_) {}
    }

    await projectStore.saveMeta(projectId, meta);
    await projectStore.addRecentProject(meta);

    // Initialize snapshot manager for this project
    try {
      const snapshotManager = require('../scanner/snapshot-manager');
      if (typeof snapshotManager.init === 'function') {
        snapshotManager.init(projectId);
      }
    } catch (_) {}

    // Re-init AST engine watcher if available
    if (astEngineRef && typeof astEngineRef.init === 'function') {
      try {
        const win = typeof getWindow === 'function' ? getWindow() : null;
        await astEngineRef.init(rootPath, (updatedSnapshot) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('ast:update', updatedSnapshot);
          }
        });
      } catch (scanErr) {
        console.warn('[Project IPC] Switch AST scan warning:', scanErr.message);
      }
    }

    await projectStore.saveSettings({ lastProjectId: projectId });

    console.log(`[Project IPC] Switched active project to "${projectName}" (${projectId})`);

    return {
      success: true,
      data: {
        projectId,
        rootPath,
        name: projectName,
      },
    };

  } catch (err) {
    console.error('[Project IPC] project:switch error:', err);
    // Revert settings.lastProjectId to previous project if switch failed
    if (prevProjectId) {
      try {
        await projectStore.saveSettings({ lastProjectId: prevProjectId });
        if (prevRootPath) {
          setActiveProject(prevProjectId, prevRootPath);
        }
      } catch (_) {}
    }
    return { success: false, error: err.message };
  }
}

/**
 * Register project IPC handlers.
 * @param {() => import('electron').BrowserWindow|null} [getWindow]
 * @param {object} [astEngineRef]
 */
function register(getWindow, astEngineRef) {
  if (isRegistered) return;
  isRegistered = true;

  [
    'project:get-active',
    'project:switch',
    'project:get-recent',
    'project:remove-recent',
    'project:auto-load',
    'project:delete-data',
    'project:export-data',
    'project:import-data',
    'storage:get-stats',
  ].forEach(ch => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
  });

  /**
   * project:get-active
   * Returns active project context.
   */
  ipcMain.handle('project:get-active', async () => {
    try {
      return {
        success: true,
        data: {
          projectId: getActiveProjectId(),
          rootPath:  getActiveRootPath(),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * project:switch
   * Switches the active workspace to another project directory with concurrency safeguarding.
   */
  ipcMain.handle('project:switch', async (_event, payload) => {
    // 1. Immediately pause watcher if astEngineRef exists so no intermediate file events cause corruption
    if (astEngineRef && typeof astEngineRef.pauseWatching === 'function') {
      try { astEngineRef.pauseWatching(); } catch (_) {}
    }

    const prevProjectId = getActiveProjectId();
    const prevRootPath  = getActiveRootPath();

    // 2. Concurrency safeguard: queue the switch behind any ongoing operation / scan
    const executeQueuedSwitch = async () => {
      if (activeScanPromise) {
        try {
          console.log('[Project IPC] Concurrency Safeguard: Waiting for background scan/operation before switching');
          await activeScanPromise;
        } catch (_) {}
      }

      return await performProjectSwitch(payload, prevProjectId, prevRootPath, getWindow, astEngineRef);
    };

    const queued = switchQueueChain.then(executeQueuedSwitch, executeQueuedSwitch);
    switchQueueChain = queued.catch(() => {});
    return await queued;
  });

  /**
   * project:get-recent
   * Returns list of recent projects (max 20).
   */
  ipcMain.handle('project:get-recent', async () => {
    try {
      const recent = await projectStore.getRecentProjects();
      return {
        success: true,
        data: recent.projects || [],
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * project:remove-recent
   * Removes a project from recent projects list.
   */
  ipcMain.handle('project:remove-recent', async (_event, payload) => {
    try {
      const projectId = typeof payload === 'string' ? payload : payload?.projectId;
      if (!projectId) throw new Error('projectId required');
      const updated = await projectStore.removeRecentProject(projectId);
      return {
        success: true,
        data: updated.projects || [],
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * project:auto-load
   * Finds lastProjectId in settings/recent, sets active variables, returns project.
   */
  ipcMain.handle('project:auto-load', async () => {
    try {
      const settings = await projectStore.loadSettings();
      if (!settings.lastProjectId) {
        return { success: true, data: null };
      }

      const recent = await projectStore.getRecentProjects();
      let match = (recent.projects || []).find(p => p.projectId === settings.lastProjectId);

      if (!match) {
        const meta = await projectStore.loadMeta(settings.lastProjectId);
        if (meta) match = meta;
      }

      if (match) {
        setActiveProject(match.projectId, match.rootPath);
        return {
          success: true,
          data: match,
        };
      }

      return { success: true, data: null };

    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * project:delete-data
   * Deletes all persisted data for a project and removes from recent.
   */
  ipcMain.handle('project:delete-data', async (_event, payload) => {
    try {
      const projectId = typeof payload === 'string' ? payload : payload?.projectId;
      if (!projectId) throw new Error('projectId required');
      const result = await projectStore.deleteProjectData(projectId);
      if (activeProjectId === projectId) {
        activeProjectId = null;
        activeRootPath = null;
      }
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * project:export-data
   * Exports project session and context data to a zip archive.
   */
  ipcMain.handle('project:export-data', async (_event, payload) => {
    try {
      const { dialog } = require('electron');
      const projectId = payload?.projectId || activeProjectId;
      if (!projectId) throw new Error('No project selected to export');

      let destPath = payload?.destPath;
      if (!destPath) {
        const win = typeof getWindow === 'function' ? getWindow() : null;
        const { filePath, canceled } = await dialog.showSaveDialog(win, {
          title: 'Export Project Session Data',
          defaultPath: `promptlock-project-${projectId}.zip`,
          filters: [{ name: 'Zip Archives', extensions: ['zip'] }],
        });
        if (canceled || !filePath) return { success: false, canceled: true };
        destPath = filePath;
      }

      const res = await projectStore.exportProjectData(projectId, destPath);
      return { success: true, data: res };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * project:import-data
   * Imports a project data zip archive.
   */
  ipcMain.handle('project:import-data', async (_event, payload) => {
    try {
      const { dialog } = require('electron');
      let zipPath = payload?.zipPath;
      if (!zipPath) {
        const win = typeof getWindow === 'function' ? getWindow() : null;
        const { filePaths, canceled } = await dialog.showOpenDialog(win, {
          title: 'Import Project Session Data',
          filters: [{ name: 'Zip Archives', extensions: ['zip'] }],
          properties: ['openFile'],
        });
        if (canceled || !filePaths?.[0]) return { success: false, canceled: true };
        zipPath = filePaths[0];
      }

      const targetRootPath = payload?.targetRootPath || null;
      const res = projectStore.importProjectData(zipPath, targetRootPath);
      return { success: true, data: res };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * storage:get-stats
   * Returns disk usage and project storage statistics.
   */
  ipcMain.handle('storage:get-stats', async () => {
    try {
      const stats = await projectStore.getStorageStats();
      return { success: true, data: stats };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  console.log('[Project IPC] project:get-active, project:switch, project:get-recent, project:remove-recent, project:auto-load, project:delete-data, storage:get-stats registered');
}

module.exports = {
  register,
  performProjectSwitch,
  getActiveProjectId,
  getActiveRootPath,
  setActiveProject,
  setScanInProgress,
  setPromptInProgress,
  isOperationInProgress,
};
