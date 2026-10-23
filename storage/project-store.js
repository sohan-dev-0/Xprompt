/**
 * PromptLock — Per-Project Isolated Storage Manager
 *
 * Implements per-project isolated directory architecture:
 *   userData/
 *   ├── settings.json
 *   ├── recent-projects.json
 *   └── projects/
 *       └── {projectId}/
 *           ├── session.json
 *           ├── memory.json
 *           ├── snapshots.json (max 10)
 *           ├── features.json
 *           ├── roadmap.json
 *           └── meta.json
 *
 * All writes are ATOMIC (.tmp file write then rename).
 * Validates projectId as deterministic 16-char hex: sha256(path.resolve(rootPath).toLowerCase()).slice(0, 16).
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ── Directory Resolution ───────────────────────────────────────────────────────

let customUserDataDir = null;

function setCustomUserDataDir(dir) {
  customUserDataDir = dir;
}

function getUserDataDir() {
  if (customUserDataDir) return customUserDataDir;

  let userData = null;
  try {
    const electron = require('electron');
    if (electron?.app && typeof electron.app.getPath === 'function') {
      userData = electron.app.getPath('userData');
    }
  } catch (_) {}

  if (!userData) {
    userData = path.join(os.homedir(), '.promptlock');
  }

  if (!fs.existsSync(userData)) {
    fs.mkdirSync(userData, { recursive: true });
  }
  return userData;
}

function getProjectsDir() {
  const p = path.join(getUserDataDir(), 'projects');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function getRecentProjectsFile() {
  return path.join(getUserDataDir(), 'recent-projects.json');
}

function getSettingsFile() {
  return path.join(getUserDataDir(), 'settings.json');
}

// ── ID & Validation Helpers ───────────────────────────────────────────────────

/**
 * Compute deterministic 16-char hex projectId from rootPath.
 * Sanitize project directory path:
 * Resolves path, strips trailing slashes, and deduplicates repeated terminal folder names (e.g. /test/test -> /test)
 * @param {string} targetPath
 * @returns {string}
 */
function sanitizeProjectPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return targetPath;
  let normalized = path.resolve(targetPath.trim());
  const parts = normalized.split(path.sep);
  if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
    const parent = parts.slice(0, -1).join(path.sep) || path.sep;
    if (fs.existsSync(parent)) {
      normalized = parent;
    }
  }
  return normalized;
}

/**
 * Deterministically hash a workspace root path into a 16-character hex ID:
 * sha256(path.resolve(sanitizeProjectPath(rootPath)).toLowerCase()).slice(0, 16)
 * @param {string} rootPath
 * @returns {string|null}
 */
function getProjectId(rootPath) {
  if (!rootPath || typeof rootPath !== 'string') return null;
  const sanitized = sanitizeProjectPath(rootPath);
  const resolved = path.resolve(sanitized).toLowerCase();
  return crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

/**
 * Validate that a projectId is a 16-character hexadecimal string.
 * @param {string} projectId
 * @returns {boolean}
 */
function isValidProjectId(projectId) {
  return typeof projectId === 'string' && /^[a-f0-9]{16}$/i.test(projectId);
}

/**
 * Ensure project subdirectory exists in userData/projects/{projectId}/
 * @param {string} projectId
 * @returns {string} Absolute directory path
 */
function ensureProjectDir(projectId) {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid projectId: "${projectId}". Must be a 16-character hex string.`);
  }
  const dir = path.join(getProjectsDir(), projectId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getProjectFilePath(projectId, filename) {
  ensureProjectDir(projectId);
  return path.join(getProjectsDir(), projectId, filename);
}

// ── Atomic I/O Helpers ────────────────────────────────────────────────────────

/**
 * Read and parse JSON file asynchronously.
 * Returns null if file does not exist (ENOENT); throws on other errors.
 * @param {string} filePath
 * @returns {Promise<any|null>}
 */
async function readJson(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Synchronous JSON read helper.
 * Returns null if ENOENT; throws on syntax/read errors.
 * @param {string} filePath
 * @returns {any|null}
 */
function readJsonSync(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Atomic JSON write asynchronously (.tmp write then rename).
 * @param {string} filePath
 * @param {any} data
 */
async function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmp = `${filePath}.tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const payload = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tmp, payload, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

/**
 * Synchronous atomic JSON write (.tmp write then rename).
 * @param {string} filePath
 * @param {any} data
 */
function writeJsonSync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const payload = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Session Functions ─────────────────────────────────────────────────────────

function getDefaultSession(projectId) {
  return {
    projectId: projectId || null,
    chatHistory: [],
    currentIntent: '',
    currentPlan: null,
    currentSelectedOption: null,
    permissionStatus: null,
    lastGeneratedPrompt: null,
    promptHistory: [],
    lastVerificationReport: null,
    activeTab: 'scanner',
    lastSaved: Date.now(),

    // Stateful Pending Action Flow
    pendingAction: null,
    pendingFeature: null,
    pendingBugReport: null,
    activeFeatureRequirements: [],

    // Backward-compatible defaults for existing components & tests
    selectedTargetAI: 'cursor',
    activeRules: ['zero-secrets', 'zod-validation', 'sql-guard', 'no-eval'],
    roadmapGoal: '',
    roadmapMilestones: [],
    activeMilestoneId: null,
    lastActiveProjectPath: null,
    selectedOption: null,
    currentProgress: {
      overall: 0,
      modules: {
        auth: { progress: 0, filesReady: 0, filesTotal: 5 },
        database: { progress: 0, filesReady: 0, filesTotal: 5 },
        routes: { progress: 0, filesReady: 0, filesTotal: 5 }
      },
      missing: [],
      partial: [],
      ready: []
    },
  };
}

const MAX_CHAT_HISTORY = 500;
const MAX_PROMPT_HISTORY = 500;
const ARCHIVE_CHUNK_SIZE = 100;

let _archiver = null;
let _admZip = null;
function getArchiver() {
  if (!_archiver) _archiver = require('archiver');
  return _archiver;
}
function getAdmZip() {
  if (!_admZip) _admZip = require('adm-zip');
  return _admZip;
}

async function archiveChatIfExceeded(projectId, chatHistory) {
  if (!Array.isArray(chatHistory) || chatHistory.length <= MAX_CHAT_HISTORY) {
    return Array.isArray(chatHistory) ? chatHistory : [];
  }
  const toArchive = chatHistory.slice(0, ARCHIVE_CHUNK_SIZE);
  const retained = chatHistory.slice(ARCHIVE_CHUNK_SIZE);
  const archivePath = getProjectFilePath(projectId, 'chatArchive.json');
  let currentArchive = (await readJson(archivePath)) || [];
  if (!Array.isArray(currentArchive)) currentArchive = [];
  currentArchive.push(...toArchive);
  await writeJson(archivePath, currentArchive);
  return retained;
}

function archiveChatIfExceededSync(projectId, chatHistory) {
  if (!Array.isArray(chatHistory) || chatHistory.length <= MAX_CHAT_HISTORY) {
    return Array.isArray(chatHistory) ? chatHistory : [];
  }
  const toArchive = chatHistory.slice(0, ARCHIVE_CHUNK_SIZE);
  const retained = chatHistory.slice(ARCHIVE_CHUNK_SIZE);
  const archivePath = getProjectFilePath(projectId, 'chatArchive.json');
  let currentArchive = readJsonSync(archivePath) || [];
  if (!Array.isArray(currentArchive)) currentArchive = [];
  currentArchive.push(...toArchive);
  writeJsonSync(archivePath, currentArchive);
  return retained;
}

async function loadChatArchive(projectId) {
  if (!isValidProjectId(projectId)) return [];
  const p = getProjectFilePath(projectId, 'chatArchive.json');
  return (await readJson(p)) || [];
}

function loadChatArchiveSync(projectId) {
  if (!isValidProjectId(projectId)) return [];
  const p = getProjectFilePath(projectId, 'chatArchive.json');
  return readJsonSync(p) || [];
}

async function loadSession(projectId) {
  if (!isValidProjectId(projectId)) return getDefaultSession(projectId);
  const p = getProjectFilePath(projectId, 'session.json');
  const data = await readJson(p);
  if (!data) return getDefaultSession(projectId);
  return {
    ...getDefaultSession(projectId),
    ...data,
    projectId,
    chatHistory: Array.isArray(data.chatHistory) ? data.chatHistory.slice(-MAX_CHAT_HISTORY) : [],
    promptHistory: Array.isArray(data.promptHistory) ? data.promptHistory.slice(-MAX_PROMPT_HISTORY) : [],
  };
}

function loadSessionSync(projectId) {
  if (!isValidProjectId(projectId)) return getDefaultSession(projectId);
  const p = getProjectFilePath(projectId, 'session.json');
  const data = readJsonSync(p);
  if (!data) return getDefaultSession(projectId);
  return {
    ...getDefaultSession(projectId),
    ...data,
    projectId,
    chatHistory: Array.isArray(data.chatHistory) ? data.chatHistory.slice(-MAX_CHAT_HISTORY) : [],
    promptHistory: Array.isArray(data.promptHistory) ? data.promptHistory.slice(-MAX_PROMPT_HISTORY) : [],
  };
}

// Write queue promise chain map to serialize asynchronous session writes per project
const sessionWriteQueues = new Map();

async function saveSession(projectId, session) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  
  const previousWrite = sessionWriteQueues.get(projectId) || Promise.resolve();

  const doWrite = async () => {
    const p = getProjectFilePath(projectId, 'session.json');
    const current = (await readJson(p)) || getDefaultSession(projectId);
    let incomingChat = Array.isArray(session.chatHistory)
      ? session.chatHistory
      : (current.chatHistory || []);
    incomingChat = await archiveChatIfExceeded(projectId, incomingChat);
    const merged = {
      ...current,
      ...session,
      projectId,
      chatHistory: incomingChat.slice(-MAX_CHAT_HISTORY),
      promptHistory: Array.isArray(session.promptHistory)
        ? session.promptHistory.slice(-MAX_PROMPT_HISTORY)
        : (current.promptHistory || []).slice(-MAX_PROMPT_HISTORY),
      lastSaved: Date.now(),
    };
    await writeJson(p, merged);
    return merged;
  };

  const currentWrite = previousWrite.then(doWrite, doWrite);
  sessionWriteQueues.set(projectId, currentWrite);

  try {
    return await currentWrite;
  } finally {
    if (sessionWriteQueues.get(projectId) === currentWrite) {
      sessionWriteQueues.delete(projectId);
    }
  }
}

function saveSessionSync(projectId, session) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const p = getProjectFilePath(projectId, 'session.json');
  const current = readJsonSync(p) || getDefaultSession(projectId);
  let incomingChat = Array.isArray(session.chatHistory)
    ? session.chatHistory
    : (current.chatHistory || []);
  incomingChat = archiveChatIfExceededSync(projectId, incomingChat);
  const merged = {
    ...current,
    ...session,
    projectId,
    chatHistory: incomingChat.slice(-MAX_CHAT_HISTORY),
    promptHistory: Array.isArray(session.promptHistory)
      ? session.promptHistory.slice(-MAX_PROMPT_HISTORY)
      : (current.promptHistory || []).slice(-MAX_PROMPT_HISTORY),
    lastSaved: Date.now(),
  };
  writeJsonSync(p, merged);
  return merged;
}

// ── Project Memory Functions ──────────────────────────────────────────────────

async function loadMemory(projectId) {
  if (!isValidProjectId(projectId)) return null;
  const p = getProjectFilePath(projectId, 'memory.json');
  return await readJson(p);
}

function loadMemorySync(projectId) {
  if (!isValidProjectId(projectId)) return null;
  const p = getProjectFilePath(projectId, 'memory.json');
  return readJsonSync(p);
}

async function saveMemory(projectId, memory) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const p = getProjectFilePath(projectId, 'memory.json');
  await writeJson(p, memory);
  return memory;
}

function saveMemorySync(projectId, memory) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const p = getProjectFilePath(projectId, 'memory.json');
  writeJsonSync(p, memory);
  return memory;
}

// ── Snapshots Functions (Max 10 FIFO) ─────────────────────────────────────────

const MAX_SNAPSHOTS = 10;

async function loadSnapshots(projectId) {
  if (!isValidProjectId(projectId)) return { snapshots: [] };
  const p = getProjectFilePath(projectId, 'snapshots.json');
  const data = await readJson(p);
  return (data && Array.isArray(data.snapshots)) ? data : { snapshots: [] };
}

function loadSnapshotsSync(projectId) {
  if (!isValidProjectId(projectId)) return { snapshots: [] };
  const p = getProjectFilePath(projectId, 'snapshots.json');
  const data = readJsonSync(p);
  return (data && Array.isArray(data.snapshots)) ? data : { snapshots: [] };
}

async function saveSnapshots(projectId, data) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const list = Array.isArray(data?.snapshots) ? data.snapshots.slice(-MAX_SNAPSHOTS) : [];
  const payload = { snapshots: list };
  const p = getProjectFilePath(projectId, 'snapshots.json');
  await writeJson(p, payload);
  return payload;
}

function saveSnapshotsSync(projectId, data) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const list = Array.isArray(data?.snapshots) ? data.snapshots.slice(-MAX_SNAPSHOTS) : [];
  const payload = { snapshots: list };
  const p = getProjectFilePath(projectId, 'snapshots.json');
  writeJsonSync(p, payload);
  return payload;
}

// ── Features Functions ────────────────────────────────────────────────────────

async function loadFeatures(projectId) {
  if (!isValidProjectId(projectId)) return { features: [] };
  const p = getProjectFilePath(projectId, 'features.json');
  const data = await readJson(p);
  return (data && Array.isArray(data.features)) ? data : { features: [] };
}

function loadFeaturesSync(projectId) {
  if (!isValidProjectId(projectId)) return { features: [] };
  const p = getProjectFilePath(projectId, 'features.json');
  const data = readJsonSync(p);
  return (data && Array.isArray(data.features)) ? data : { features: [] };
}

async function saveFeatures(projectId, data) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const payload = { features: Array.isArray(data?.features) ? data.features : [] };
  const p = getProjectFilePath(projectId, 'features.json');
  await writeJson(p, payload);
  return payload;
}

function saveFeaturesSync(projectId, data) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const payload = { features: Array.isArray(data?.features) ? data.features : [] };
  const p = getProjectFilePath(projectId, 'features.json');
  writeJsonSync(p, payload);
  return payload;
}

// ── Roadmap Functions ─────────────────────────────────────────────────────────

const DEFAULT_ROADMAP = { activeGoal: '', milestones: [], progress: 0 };

async function loadRoadmap(projectId) {
  if (!isValidProjectId(projectId)) return { ...DEFAULT_ROADMAP };
  const p = getProjectFilePath(projectId, 'roadmap.json');
  const data = await readJson(p);
  return data ? { ...DEFAULT_ROADMAP, ...data } : { ...DEFAULT_ROADMAP };
}

function loadRoadmapSync(projectId) {
  if (!isValidProjectId(projectId)) return { ...DEFAULT_ROADMAP };
  const p = getProjectFilePath(projectId, 'roadmap.json');
  const data = readJsonSync(p);
  return data ? { ...DEFAULT_ROADMAP, ...data } : { ...DEFAULT_ROADMAP };
}

async function saveRoadmap(projectId, roadmap) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const payload = {
    activeGoal: roadmap?.activeGoal || '',
    milestones: Array.isArray(roadmap?.milestones) ? roadmap.milestones : [],
    progress: typeof roadmap?.progress === 'number' ? roadmap.progress : 0,
    activeMilestoneId: roadmap?.activeMilestoneId || null,
  };
  const p = getProjectFilePath(projectId, 'roadmap.json');
  await writeJson(p, payload);
  return payload;
}

function saveRoadmapSync(projectId, roadmap) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const payload = {
    activeGoal: roadmap?.activeGoal || '',
    milestones: Array.isArray(roadmap?.milestones) ? roadmap.milestones : [],
    progress: typeof roadmap?.progress === 'number' ? roadmap.progress : 0,
    activeMilestoneId: roadmap?.activeMilestoneId || null,
  };
  const p = getProjectFilePath(projectId, 'roadmap.json');
  writeJsonSync(p, payload);
  return payload;
}

async function resetRoadmap(projectId) {
  return await saveRoadmap(projectId, { activeGoal: '', milestones: [], progress: 0, activeMilestoneId: null });
}

function resetRoadmapSync(projectId) {
  return saveRoadmapSync(projectId, { activeGoal: '', milestones: [], progress: 0, activeMilestoneId: null });
}

// ── Meta Functions ────────────────────────────────────────────────────────────

async function loadMeta(projectId) {
  if (!isValidProjectId(projectId)) return null;
  const p = getProjectFilePath(projectId, 'meta.json');
  return await readJson(p);
}

function loadMetaSync(projectId) {
  if (!isValidProjectId(projectId)) return null;
  const p = getProjectFilePath(projectId, 'meta.json');
  return readJsonSync(p);
}

async function saveMeta(projectId, meta) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const payload = {
    projectId,
    rootPath: meta?.rootPath || '',
    name: meta?.name || (meta?.rootPath ? path.basename(meta.rootPath) : 'Unknown Project'),
    lastOpened: meta?.lastOpened || Date.now(),
  };
  const p = getProjectFilePath(projectId, 'meta.json');
  await writeJson(p, payload);
  return payload;
}

function saveMetaSync(projectId, meta) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const payload = {
    projectId,
    rootPath: meta?.rootPath || '',
    name: meta?.name || (meta?.rootPath ? path.basename(meta.rootPath) : 'Unknown Project'),
    lastOpened: meta?.lastOpened || Date.now(),
  };
  const p = getProjectFilePath(projectId, 'meta.json');
  writeJsonSync(p, payload);
  return payload;
}

// ── Recent Projects (Max 20) ──────────────────────────────────────────────────

const MAX_RECENT = 20;

async function getRecentProjects() {
  const p = getRecentProjectsFile();
  const data = await readJson(p);
  if (!data || !Array.isArray(data.projects)) return { projects: [] };

  let modified = false;
  const cleaned = [];
  const seenPids = new Set();
  for (const proj of data.projects) {
    if (!proj || !proj.rootPath) continue;
    const cleanPath = sanitizeProjectPath(proj.rootPath);
    const pid = getProjectId(cleanPath) || proj.projectId;
    if (seenPids.has(pid)) {
      modified = true;
      continue;
    }
    seenPids.add(pid);
    if (cleanPath !== proj.rootPath || pid !== proj.projectId) modified = true;
    cleaned.push({
      ...proj,
      projectId: pid,
      rootPath: cleanPath,
      name: proj.name || path.basename(cleanPath),
    });
  }

  if (modified) {
    const updated = { projects: cleaned.slice(0, MAX_RECENT) };
    try { await writeJson(p, updated); } catch (_) {}
    return updated;
  }
  return data;
}

function getRecentProjectsSync() {
  const p = getRecentProjectsFile();
  const data = readJsonSync(p);
  if (!data || !Array.isArray(data.projects)) return { projects: [] };

  let modified = false;
  const cleaned = [];
  const seenPids = new Set();
  for (const proj of data.projects) {
    if (!proj || !proj.rootPath) continue;
    const cleanPath = sanitizeProjectPath(proj.rootPath);
    const pid = getProjectId(cleanPath) || proj.projectId;
    if (seenPids.has(pid)) {
      modified = true;
      continue;
    }
    seenPids.add(pid);
    if (cleanPath !== proj.rootPath || pid !== proj.projectId) modified = true;
    cleaned.push({
      ...proj,
      projectId: pid,
      rootPath: cleanPath,
      name: proj.name || path.basename(cleanPath),
    });
  }

  if (modified) {
    const updated = { projects: cleaned.slice(0, MAX_RECENT) };
    try { writeJsonSync(p, updated); } catch (_) {}
    return updated;
  }
  return data;
}

async function addRecentProject({ projectId, rootPath, name, lastOpened }) {
  if (rootPath) rootPath = sanitizeProjectPath(rootPath);
  if (!projectId && rootPath) projectId = getProjectId(rootPath);
  if (!isValidProjectId(projectId)) return await getRecentProjects();
  const current = await getRecentProjects();
  const entry = {
    projectId,
    rootPath,
    name: name || (rootPath ? path.basename(rootPath) : 'Unknown Project'),
    lastOpened: lastOpened || Date.now(),
  };
  const filtered = current.projects.filter(p => p.projectId !== projectId);
  filtered.unshift(entry);
  const updated = { projects: filtered.slice(0, MAX_RECENT) };
  await writeJson(getRecentProjectsFile(), updated);
  return updated;
}

function addRecentProjectSync({ projectId, rootPath, name, lastOpened }) {
  if (rootPath) rootPath = sanitizeProjectPath(rootPath);
  if (!projectId && rootPath) projectId = getProjectId(rootPath);
  if (!isValidProjectId(projectId)) return getRecentProjectsSync();
  const current = getRecentProjectsSync();
  const entry = {
    projectId,
    rootPath,
    name: name || (rootPath ? path.basename(rootPath) : 'Unknown Project'),
    lastOpened: lastOpened || Date.now(),
  };
  const filtered = current.projects.filter(p => p.projectId !== projectId);
  filtered.unshift(entry);
  const updated = { projects: filtered.slice(0, MAX_RECENT) };
  writeJsonSync(getRecentProjectsFile(), updated);
  return updated;
}

async function removeRecentProject(projectId) {
  const current = await getRecentProjects();
  const filtered = current.projects.filter(p => p.projectId !== projectId);
  const updated = { projects: filtered };
  await writeJson(getRecentProjectsFile(), updated);
  return updated;
}

function removeRecentProjectSync(projectId) {
  const current = getRecentProjectsSync();
  const filtered = current.projects.filter(p => p.projectId !== projectId);
  const updated = { projects: filtered };
  writeJsonSync(getRecentProjectsFile(), updated);
  return updated;
}

// ── Settings Functions ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = { aiProvider: 'gemini', theme: 'dark', lastProjectId: null };

async function loadSettings() {
  const p = getSettingsFile();
  const data = await readJson(p);
  return data ? { ...DEFAULT_SETTINGS, ...data } : { ...DEFAULT_SETTINGS };
}

function loadSettingsSync() {
  const p = getSettingsFile();
  const data = readJsonSync(p);
  return data ? { ...DEFAULT_SETTINGS, ...data } : { ...DEFAULT_SETTINGS };
}

async function saveSettings(settings) {
  const current = await loadSettings();
  const merged = { ...current, ...settings };
  await writeJson(getSettingsFile(), merged);
  return merged;
}

function saveSettingsSync(settings) {
  const current = loadSettingsSync();
  const merged = { ...current, ...settings };
  writeJsonSync(getSettingsFile(), merged);
  return merged;
}

// ── Legacy Data Migration ─────────────────────────────────────────────────────

async function migrateLegacyData() {
  const baseDir = getUserDataDir();
  const legacySessionFile = path.join(baseDir, 'promptlock-session.json');

  if (!fs.existsSync(legacySessionFile)) {
    return { migrated: false, reason: 'No legacy session file found' };
  }

  try {
    const raw = await fs.promises.readFile(legacySessionFile, 'utf8');
    const oldSession = JSON.parse(raw);
    const rootPath = oldSession.lastActiveProjectPath || oldSession.rootPath;

    if (!rootPath || typeof rootPath !== 'string') {
      return { migrated: false, reason: 'No rootPath in legacy session' };
    }

    const projectId = getProjectId(rootPath);
    ensureProjectDir(projectId);

    // 4. Map old session fields → new schema, save
    const newSession = {
      ...getDefaultSession(projectId),
      projectId,
      rootPath,
      lastActiveProjectPath: rootPath,
      selectedTargetAI: oldSession.selectedTargetAI || 'cursor',
      activeRules: Array.isArray(oldSession.activeRules)
        ? oldSession.activeRules
        : ['zero-secrets', 'zod-validation', 'sql-guard', 'no-eval'],
      activeTab: oldSession.activeTab || 'scanner',
      chatHistory: Array.isArray(oldSession.chatHistory) ? oldSession.chatHistory : [],
      currentIntent: oldSession.currentIntent || '',
      currentPlan: oldSession.currentPlan || null,
      currentSelectedOption: oldSession.selectedOption || oldSession.currentSelectedOption || null,
      permissionStatus: oldSession.permissionStatus || null,
      lastGeneratedPrompt: oldSession.lastGeneratedPrompt || null,
      promptHistory: Array.isArray(oldSession.promptHistory) ? oldSession.promptHistory : [],
      lastVerificationReport: oldSession.lastVerificationReport || null,
      roadmapGoal: oldSession.roadmapGoal || 'Production Full-Stack Application',
      roadmapMilestones: Array.isArray(oldSession.roadmapMilestones) ? oldSession.roadmapMilestones : [],
      activeMilestoneId: oldSession.activeMilestoneId || null,
      lastSaved: Date.now(),
    };
    await saveSession(projectId, newSession);

    // Save roadmap if present
    if (oldSession.roadmapGoal || (Array.isArray(oldSession.roadmapMilestones) && oldSession.roadmapMilestones.length > 0)) {
      await saveRoadmap(projectId, {
        activeGoal: oldSession.roadmapGoal || '',
        milestones: Array.isArray(oldSession.roadmapMilestones) ? oldSession.roadmapMilestones : [],
        activeMilestoneId: oldSession.activeMilestoneId || null,
        progress: oldSession.currentProgress?.overall || 0,
      });
    }

    // Save meta
    const projectName = path.basename(rootPath);
    await saveMeta(projectId, {
      projectId,
      rootPath,
      name: projectName,
      lastOpened: Date.now(),
    });

    // 5. If userData/project-memory-{projectId}.json exists → move to memory.json
    const oldMemoryFile = path.join(baseDir, `project-memory-${projectId}.json`);
    if (fs.existsSync(oldMemoryFile)) {
      try {
        const memRaw = await fs.promises.readFile(oldMemoryFile, 'utf8');
        const memData = JSON.parse(memRaw);
        await saveMemory(projectId, memData);
        // Rename old memory file to .migrated
        await fs.promises.rename(oldMemoryFile, `${oldMemoryFile}.migrated`);
      } catch (memErr) {
        console.warn('[ProjectStore] Memory migration warning:', memErr.message);
      }
    }

    // 6. Add to recent projects
    await addRecentProject({
      projectId,
      rootPath,
      name: projectName,
      lastOpened: Date.now(),
    });

    // Update settings lastProjectId
    await saveSettings({ lastProjectId: projectId });

    // 7. Rename legacy file to .migrated (never delete!)
    const migratedFile = `${legacySessionFile}.migrated`;
    await fs.promises.rename(legacySessionFile, migratedFile);

    console.log(`[ProjectStore] Successfully migrated legacy data for project ${projectId} (${projectName})`);
    return { migrated: true, projectId };

  } catch (err) {
    console.error('[ProjectStore] Migration error:', err);
    return { migrated: false, error: err.message };
  }
}

// ── Delete Project Data (Task 21) ─────────────────────────────────────────────

async function deleteProjectData(projectId) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const projectDir = path.join(getProjectsDir(), projectId);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  await removeRecentProject(projectId);
  const settings = await loadSettings();
  if (settings.lastProjectId === projectId) {
    await saveSettings({ lastProjectId: null });
  }
  return { success: true, deleted: true, projectId };
}

function deleteProjectDataSync(projectId) {
  if (!isValidProjectId(projectId)) throw new Error(`Invalid projectId: "${projectId}"`);
  const projectDir = path.join(getProjectsDir(), projectId);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  removeRecentProjectSync(projectId);
  const settings = loadSettingsSync();
  if (settings.lastProjectId === projectId) {
    saveSettingsSync({ lastProjectId: null });
  }
  return { success: true, deleted: true, projectId };
}

// ── Storage Stats (Task 23) ───────────────────────────────────────────────────

function getStorageStatsSync() {
  const projectsDir = getProjectsDir();
  let totalProjects = 0;
  let totalBytes = 0;
  let oldestProject = null;
  let newestProject = null;

  if (fs.existsSync(projectsDir)) {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && isValidProjectId(ent.name)) {
        totalProjects++;
        const pDir = path.join(projectsDir, ent.name);
        let projectMtime = 0;
        let projectName = ent.name;

        const metaPath = path.join(pDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta?.name) projectName = meta.name;
            if (meta?.lastOpened) projectMtime = meta.lastOpened;
          } catch (_) {}
        }

        try {
          const files = fs.readdirSync(pDir);
          for (const f of files) {
            const stat = fs.statSync(path.join(pDir, f));
            totalBytes += stat.size;
            if (!projectMtime || stat.mtimeMs > projectMtime) {
              projectMtime = stat.mtimeMs;
            }
          }
        } catch (_) {}

        const item = { projectId: ent.name, name: projectName, lastOpened: projectMtime || Date.now() };
        if (!oldestProject || item.lastOpened < oldestProject.lastOpened) {
          oldestProject = item;
        }
        if (!newestProject || item.lastOpened > newestProject.lastOpened) {
          newestProject = item;
        }
      }
    }
  }

  return {
    totalProjects,
    projectCount: totalProjects,
    totalBytes,
    totalDiskUsageMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    oldestProject,
    newestProject,
  };
}

async function getStorageStats() {
  return getStorageStatsSync();
}

// ── Export / Import Session Data (Task 22) ───────────────────────────────────

function exportProjectData(projectId, destZipPath) {
  return new Promise((resolve, reject) => {
    try {
      if (!isValidProjectId(projectId)) return reject(new Error(`Invalid projectId: "${projectId}"`));
      const projectDir = path.join(getProjectsDir(), projectId);
      if (!fs.existsSync(projectDir)) return reject(new Error(`Project data directory not found for ${projectId}`));

      const AdmZip = getAdmZip();
      const zip = new AdmZip();
      zip.addLocalFolder(projectDir);
      zip.writeZip(destZipPath);
      const stat = fs.statSync(destZipPath);
      resolve({ success: true, path: destZipPath, bytes: stat.size });
    } catch (err) {
      reject(err);
    }
  });
}

function importProjectData(zipFilePath, targetRootPath) {
  if (!fs.existsSync(zipFilePath)) throw new Error(`Zip file not found: ${zipFilePath}`);
  const AdmZip = getAdmZip();
  const zip = new AdmZip(zipFilePath);

  let targetId = null;
  if (targetRootPath) {
    if (isValidProjectId(targetRootPath)) {
      targetId = targetRootPath;
    } else {
      targetId = getProjectId(targetRootPath);
    }
  }

  const metaEntry = zip.getEntry('meta.json');
  let zipMeta = null;
  if (metaEntry) {
    try {
      zipMeta = JSON.parse(zip.readAsText(metaEntry));
    } catch (_) {}
  }

  if (!targetId) {
    targetId = zipMeta?.projectId || crypto.randomBytes(8).toString('hex');
  }

  const targetDir = ensureProjectDir(targetId);
  zip.extractAllTo(targetDir, true);

  const newMeta = {
    ...(zipMeta || {}),
    projectId: targetId,
    rootPath: (targetRootPath && !isValidProjectId(targetRootPath)) ? targetRootPath : (zipMeta?.rootPath || targetDir),
    name: zipMeta?.name || path.basename((targetRootPath && !isValidProjectId(targetRootPath)) ? targetRootPath : targetDir),
    lastOpened: Date.now(),
  };

  saveMetaSync(targetId, newMeta);
  addRecentProjectSync(newMeta);

  return {
    success: true,
    projectId: targetId,
    meta: newMeta,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Constants & Paths
  get USER_DATA_DIR() { return getUserDataDir(); },
  get PROJECTS_DIR() { return getProjectsDir(); },
  get RECENT_PROJECTS_FILE() { return getRecentProjectsFile(); },
  get SETTINGS_FILE() { return getSettingsFile(); },
  setCustomUserDataDir,

  // ID & Validation
  getProjectId,
  sanitizeProjectPath,
  isValidProjectId,
  ensureProjectDir,
  getProjectDir: (projectId) => path.join(getProjectsDir(), projectId),
  getProjectsDir,
  getProjectFilePath,

  // Atomic I/O
  readJson,
  readJsonSync,
  writeJson,
  writeJsonSync,

  // Session
  getDefaultSession,
  loadSession,
  loadSessionSync,
  saveSession,
  saveSessionSync,

  // Memory
  loadMemory,
  loadMemorySync,
  saveMemory,
  saveMemorySync,

  // Snapshots
  loadSnapshots,
  loadSnapshotsSync,
  saveSnapshots,
  saveSnapshotsSync,

  // Features
  loadFeatures,
  loadFeaturesSync,
  saveFeatures,
  saveFeaturesSync,

  // Roadmap
  loadRoadmap,
  loadRoadmapSync,
  saveRoadmap,
  saveRoadmapSync,
  resetRoadmap,
  resetRoadmapSync,

  // Meta
  loadMeta,
  loadMetaSync,
  saveMeta,
  saveMetaSync,

  // Recent Projects
  getRecentProjects,
  getRecentProjectsSync,
  addRecentProject,
  addRecentProjectSync,
  removeRecentProject,
  removeRecentProjectSync,

  // Settings
  loadSettings,
  loadSettingsSync,
  saveSettings,
  saveSettingsSync,

  // Migration
  migrateLegacyData,

  // Chat Archive (Task 18)
  loadChatArchive,
  loadChatArchiveSync,

  // Delete Project Data (Task 21)
  deleteProjectData,
  deleteProjectDataSync,

  // Storage Stats (Task 23)
  getStorageStats,
  getStorageStatsSync,

  // Export / Import (Task 22)
  exportProjectData,
  importProjectData,
};
