/**
 * PromptLock — Session State Store (v2.0 Per-Project Proxy)
 *
 * Proxies session persistence to the isolated per-project storage manager.
 * Guarantees zero data overwrites when switching projects while maintaining
 * identical synchronous exports for backward compatibility.
 */

'use strict';

const projectStore = require('./storage/project-store');
let projectIPC     = null;

function getProjectIPC() {
  if (!projectIPC) {
    try {
      projectIPC = require('./ipc/project-ipc');
    } catch (_) {}
  }
  return projectIPC;
}

const DEFAULT_STATE = projectStore.getDefaultSession(null);

/**
 * Resolve the currently active project ID.
 * @returns {string|null}
 */
function resolveProjectId() {
  const ipc = getProjectIPC();
  if (ipc && typeof ipc.getActiveProjectId === 'function') {
    const id = ipc.getActiveProjectId();
    if (id && projectStore.isValidProjectId(id)) return id;
  }
  try {
    const settings = projectStore.loadSettingsSync();
    if (settings.lastProjectId && projectStore.isValidProjectId(settings.lastProjectId)) return settings.lastProjectId;
  } catch (_) {}
  return '0000000000000000';
}

/**
 * Load persisted session state for the active project.
 * Falls back cleanly to default state schema if missing or no project is active.
 * @returns {typeof DEFAULT_STATE}
 */
function loadState() {
  const projectId = resolveProjectId();
  try {
    const session = projectStore.loadSessionSync(projectId);
    return {
      ...DEFAULT_STATE,
      ...session,
    };
  } catch (err) {
    console.warn('[SessionStore] Error loading project session:', err.message);
    return { ...DEFAULT_STATE };
  }
}

/**
 * Save state updates to the active project session.
 * Merges updates atomically and syncs roadmap changes to roadmap.json.
 * @param {Partial<typeof DEFAULT_STATE>} updates
 * @returns {typeof DEFAULT_STATE}
 */
function saveState(updates = {}) {
  let projectId = resolveProjectId();

  // If a rootPath was provided and no project is currently bound, bind it
  const rootPath = updates.lastActiveProjectPath || updates.rootPath;
  if (rootPath) {
    const newPid = projectStore.getProjectId(rootPath);
    if (newPid) {
      projectId = newPid;
      const ipc = getProjectIPC();
      if (ipc && typeof ipc.setActiveProject === 'function') {
        ipc.setActiveProject(projectId, rootPath);
      }
    }
  }

  // If still no project ID, use valid 16-hex fallback ID to prevent crash
  if (!projectId || !projectStore.isValidProjectId(projectId)) {
    projectId = '0000000000000000';
  }

  try {
    const merged = projectStore.saveSessionSync(projectId, updates);

    // Sync roadmap changes if included in updates
    if (updates.roadmapGoal !== undefined || updates.roadmapMilestones !== undefined || updates.activeMilestoneId !== undefined) {
      projectStore.saveRoadmapSync(projectId, {
        activeGoal: updates.roadmapGoal || merged.roadmapGoal || '',
        milestones: Array.isArray(updates.roadmapMilestones) ? updates.roadmapMilestones : (merged.roadmapMilestones || []),
        activeMilestoneId: updates.activeMilestoneId || merged.activeMilestoneId || null,
        progress: merged.currentProgress?.overall || 0,
      });
    }

    return {
      ...DEFAULT_STATE,
      ...merged,
    };
  } catch (err) {
    console.error('[SessionStore] Error saving project session:', err);
    return loadState();
  }
}

/**
 * Clear saved session state for the active project back to defaults.
 */
function clearState() {
  const projectId = resolveProjectId();
  if (projectId) {
    try {
      const defaultSess = projectStore.getDefaultSession(projectId);
      defaultSess.chatHistory = [];
      defaultSess.currentIntent = '';
      defaultSess.currentPlan = null;
      defaultSess.pendingAction = null;
      defaultSess.pendingFeature = null;
      defaultSess.pendingBugReport = null;
      defaultSess.activeFeatureRequirements = [];
      defaultSess.lastGeneratedPrompt = null;
      defaultSess.roadmapGoal = '';
      defaultSess.roadmapMilestones = [];
      defaultSess.activeMilestoneId = null;
      defaultSess.activeTab = 'scanner';
      projectStore.saveSessionSync(projectId, defaultSess);
      projectStore.resetRoadmapSync(projectId);
    } catch (_) {}
  }
  return {
    ...DEFAULT_STATE,
    chatHistory: [],
    currentIntent: '',
    currentPlan: null,
    pendingAction: null,
    pendingFeature: null,
    pendingBugReport: null,
    activeFeatureRequirements: [],
    lastGeneratedPrompt: null,
    roadmapGoal: '',
    roadmapMilestones: [],
    activeMilestoneId: null,
    activeTab: 'scanner',
  };
}

/**
 * Wipe all in-memory and persisted state for the active project back to clean slate.
 */
function wipeActiveProjectMemory() {
  return clearState();
}

module.exports = {
  loadState,
  saveState,
  clearState,
  wipeActiveProjectMemory,
  DEFAULT_STATE,
  resolveProjectId,
};

