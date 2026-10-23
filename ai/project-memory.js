/**
 * PromptLock — Project Memory (Step 3 & Per-Project Storage Upgrade)
 *
 * Persists AI-analyzed project understanding in userData/projects/{projectId}/memory.json.
 * Invalidates when file count changes by >10% or >10 minutes stale on large projects.
 * Never re-calls AI if cache is fresh.
 */

'use strict';

const projectStore = require('../storage/project-store');

const CACHE_TTL_MS    = 10 * 60 * 1000;  // 10 minutes
const STALE_THRESHOLD = 0.10;             // 10% file change triggers invalidation

/**
 * Resolve project ID from a path or an existing ID.
 * @param {string} [rootPathOrId]
 * @returns {string|null}
 */
function resolveId(rootPathOrId) {
  if (!rootPathOrId) {
    try {
      const { getActiveProjectId } = require('../ipc/project-ipc');
      return getActiveProjectId();
    } catch (_) {
      return null;
    }
  }
  if (projectStore.isValidProjectId(rootPathOrId)) {
    return rootPathOrId;
  }
  return projectStore.getProjectId(rootPathOrId);
}

/**
 * Compute a stable project ID from root path (backward compatible helper).
 * @param {string} rootPath
 * @returns {string}
 */
function projectId(rootPath) {
  return projectStore.getProjectId(rootPath);
}

/**
 * Check if cached memory is stale relative to a new snapshot.
 * @param {object} cached - Previously stored memory entry
 * @param {object} snapshot - Current AST snapshot
 * @returns {boolean}
 */
function isStale(cached, snapshot) {
  if (!cached || !cached.timestamp) return true;

  const ageMs = Date.now() - new Date(cached.timestamp).getTime();
  if (ageMs > CACHE_TTL_MS) return true;

  // File count drift check
  const cachedCount  = cached.snapshotFileCount || 0;
  const currentCount = (snapshot?.files || []).length;
  if (cachedCount > 0) {
    const drift = Math.abs(currentCount - cachedCount) / cachedCount;
    if (drift > STALE_THRESHOLD) return true;
  }

  return false;
}

/**
 * Load cached project memory from project store.
 * @param {string} rootPathOrId
 * @returns {object|null}
 */
function load(rootPathOrId) {
  const id = resolveId(rootPathOrId);
  if (!id) return null;
  return projectStore.loadMemorySync(id);
}

/**
 * Save project memory to project store.
 * @param {string} rootPathOrId
 * @param {object} memory - AI-generated project understanding
 * @param {object|number} snapshot - Current snapshot (for stale check reference)
 */
function save(rootPathOrId, memory, snapshot) {
  const id = resolveId(rootPathOrId);
  if (!id) return;

  const entry = {
    projectId:         id,
    rootPath:          (typeof rootPathOrId === 'string' && rootPathOrId.length !== 16) ? rootPathOrId : null,
    timestamp:         new Date().toISOString(),
    snapshotFileCount: typeof snapshot === 'number' ? snapshot : (snapshot?.files || []).length,
    memory,
  };
  projectStore.saveMemorySync(id, entry);
}

/**
 * Invalidate cached memory (force re-analyze on next call).
 * @param {string} rootPathOrId
 */
function invalidate(rootPathOrId) {
  const id = resolveId(rootPathOrId);
  if (id) {
    try {
      projectStore.saveMemorySync(id, null);
    } catch (_) {}
  }
}

/**
 * Generate (or return cached) project memory for a snapshot.
 * Calls AI understandProject() only if cache is missing or stale.
 * @param {string} rootPath
 * @param {object} snapshot
 * @returns {Promise<{ memory: object, fromCache: boolean }>}
 */
async function generate(rootPath, snapshot) {
  const cached = load(rootPath);
  if (cached && !isStale(cached, snapshot)) {
    return { memory: cached.memory, fromCache: true };
  }

  const { understandProject } = require('./ai-service');
  const memory = await understandProject(snapshot);

  save(rootPath, memory, snapshot);
  return { memory, fromCache: false };
}

/**
 * Update (patch) cached project memory.
 * @param {string} rootPathOrId
 * @param {object} patch
 * @returns {object}
 */
function update(rootPathOrId, patch = {}) {
  const existing = load(rootPathOrId) || { memory: {} };
  const updatedMemory = {
    ...(existing.memory || {}),
    ...patch,
  };
  save(rootPathOrId, updatedMemory, existing.snapshotFileCount || 0);
  return updatedMemory;
}

module.exports = {
  generate,
  load,
  save,
  update,
  invalidate,
  isStale,
  projectId,
};
