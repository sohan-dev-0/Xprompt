/**
 * PromptLock — Snapshot Manager (Step 2 Upgrade & Disk Persistence)
 *
 * Manages immutable project snapshots with diff capability.
 * Persists up to 10 snapshots to userData/projects/{projectId}/snapshots.json.
 * Automatically loads snapshots when switching projects.
 */

'use strict';

const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const projectStore = require('../storage/project-store');

const MAX_SNAPSHOTS = 10;

/** @type {Map<string, object>} id → snapshot */
const snapshotRing = new Map();
const snapshotOrder = [];
let currentProjectId = null;

function resolveProjectId(projectPathOrId) {
  if (projectPathOrId) {
    if (projectStore.isValidProjectId(projectPathOrId)) return projectPathOrId;
    const pid = projectStore.getProjectId(projectPathOrId);
    if (pid) return pid;
  }
  if (currentProjectId) return currentProjectId;
  try {
    const { getActiveProjectId } = require('../ipc/project-ipc');
    return getActiveProjectId();
  } catch (_) {
    return null;
  }
}

/**
 * Initialize or restore snapshots from disk for a given project.
 * @param {string} [projectPathOrId]
 * @returns {Array<object>} Loaded snapshot headers
 */
function init(projectPathOrId) {
  const pid = resolveProjectId(projectPathOrId);
  currentProjectId = pid;
  snapshotRing.clear();
  snapshotOrder.length = 0;

  if (pid) {
    try {
      const data = projectStore.loadSnapshotsSync(pid);
      if (data && Array.isArray(data.snapshots)) {
        for (const snap of data.snapshots) {
          if (snap && snap.id) {
            snapshotRing.set(snap.id, snap);
            snapshotOrder.push(snap.id);
          }
        }
        console.log(`[SnapshotManager] Restored ${snapshotOrder.length} snapshot(s) from disk for project ${pid}`);
      }
    } catch (err) {
      console.warn('[SnapshotManager] Error loading snapshots from disk:', err.message);
    }
  }

  return listSnapshots();
}

/**
 * Persist in-memory snapshot ring to disk.
 * @param {string} [projectPathOrId]
 */
function persist(projectPathOrId) {
  const pid = resolveProjectId(projectPathOrId);
  if (!pid) return;

  try {
    const snapshots = snapshotOrder
      .map(id => snapshotRing.get(id))
      .filter(Boolean)
      .slice(-MAX_SNAPSHOTS);

    projectStore.saveSnapshotsSync(pid, { snapshots });
  } catch (err) {
    console.warn('[SnapshotManager] Failed to persist snapshots to disk:', err.message);
  }
}

/**
 * Clear in-memory snapshots and persist empty list to disk.
 * @param {string} [projectPathOrId]
 */
function clearSnapshots(projectPathOrId) {
  snapshotRing.clear();
  snapshotOrder.length = 0;
  persist(projectPathOrId);
}

/**
 * Recursively scan directory from physical disk to get absolute file state.
 * @param {string} projectPath
 * @returns {Array<object>}
 */
function scanDirectorySync(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return [];
  let ig = null;
  let shouldIgnore = () => false;
  try {
    const ignoreRules = require('./ignore-rules');
    ig = ignoreRules.buildIgnoreFilter(projectPath);
    shouldIgnore = ignoreRules.shouldIgnore;
  } catch (_) {}

  let parseFileDeep = null;
  try {
    parseFileDeep = require('./file-tree').parseFileDeep;
  } catch (_) {}

  const files = [];

  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectPath, full);
      if (shouldIgnore(rel, ig)) continue;

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        let meta = null;
        if (parseFileDeep) {
          try {
            meta = parseFileDeep(full, projectPath);
          } catch (_) {}
        }
        if (meta) {
          files.push(meta);
        } else {
          files.push({
            path: rel,
            fns: [],
            exports: [],
            isAST: false,
            loc: 0,
            classes: [],
          });
        }
      }
    }
  }

  walk(projectPath);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function takeSnapshot(projectPath, label, currentSnapshot, options = {}) {
  if (!projectPath || typeof projectPath !== 'string') throw new Error('Invalid projectPath');
  if (!label || typeof label !== 'string') label = `Snapshot ${new Date().toLocaleTimeString()}`;

  const uuid = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex')).slice(0, 8);
  const id = `snap_${Date.now()}_${uuid}`;
  const timestamp = new Date().toISOString();

  let files = [];
  if (options && options.forceDiskScan) {
    files = scanDirectorySync(projectPath);
  } else if (currentSnapshot && Array.isArray(currentSnapshot.files)) {
    files = currentSnapshot.files;
  } else if (fs.existsSync(projectPath)) {
    files = scanDirectorySync(projectPath);
  }

  const contentDigest = crypto.createHash('sha256')
    .update(JSON.stringify(files.map(f => ({ p: f.path, fns: f.fns }))))
    .digest('hex').slice(0, 16);

  let gitHash = null;
  try {
    const headPath = path.join(projectPath, '.git', 'HEAD');
    if (fs.existsSync(headPath)) {
      const head = fs.readFileSync(headPath, 'utf8').trim();
      if (head.startsWith('ref:')) {
        const refPath = path.join(projectPath, '.git', head.slice(5).trim());
        if (fs.existsSync(refPath)) gitHash = fs.readFileSync(refPath, 'utf8').trim().slice(0, 8);
      } else {
        gitHash = head.slice(0, 8);
      }
    }
  } catch (_) {}

  const astFiles = files.filter(f => f.isAST);
  const astSummary = {
    totalFiles: files.length,
    astFiles:   astFiles.length,
    functions:  files.reduce((n, f) => n + (f.fns || []).length, 0),
    exports:    files.reduce((n, f) => n + (f.exports || []).length, 0),
    uniqueDeps: currentSnapshot?.stats?.uniqueDeps || 0,
    contentDigest,
  };

  const snap = {
    id, label, timestamp, projectPath, gitHash, astSummary,
    files: files.map(f => ({
      path: f.path, fns: f.fns || [], exports: f.exports || [],
      isAST: f.isAST || false, hash: f.hash || null,
      lastModified: f.lastModified || null, loc: f.loc || null,
      classes: f.classes || [], isEntryPoint: f.isEntryPoint || false,
      gitStatus: f.gitStatus || null,
    })),
  };

  if (snapshotOrder.length >= MAX_SNAPSHOTS) {
    const oldest = snapshotOrder.shift();
    snapshotRing.delete(oldest);
  }
  snapshotRing.set(id, snap);
  snapshotOrder.push(id);

  console.log(`[SnapshotManager] Took snapshot "${label}" (${id}) — ${files.length} files`);

  // Persist to disk
  persist(projectPath);

  return snap;
}

function diffSnapshots(beforeId, afterId) {
  const before = snapshotRing.get(beforeId);
  const after  = snapshotRing.get(afterId);
  if (!before) throw new Error(`Snapshot not found: ${beforeId}`);
  if (!after)  throw new Error(`Snapshot not found: ${afterId}`);

  const beforeMap = new Map(before.files.map(f => [f.path, f]));
  const afterMap  = new Map(after.files.map(f => [f.path, f]));

  const added = [], modified = [], deleted = [], unchanged = [];

  for (const [p, afterFile] of afterMap) {
    if (!beforeMap.has(p)) {
      added.push(p);
    } else {
      const bf = beforeMap.get(p);
      const changed = JSON.stringify(afterFile.fns) !== JSON.stringify(bf.fns) ||
        JSON.stringify(afterFile.exports) !== JSON.stringify(bf.exports) ||
        afterFile.hash !== bf.hash;
      if (changed) modified.push(p); else unchanged.push(p);
    }
  }
  for (const p of beforeMap.keys()) { if (!afterMap.has(p)) deleted.push(p); }

  return {
    beforeId, afterId,
    beforeLabel: before.label, afterLabel: after.label,
    added, modified, deleted, unchanged,
    summary: { added: added.length, modified: modified.length, deleted: deleted.length, unchanged: unchanged.length },
  };
}

function getLatestId() {
  return snapshotOrder.length > 0 ? snapshotOrder[snapshotOrder.length - 1] : null;
}

function getSnapshot(id) {
  return snapshotRing.get(id) || null;
}

function listSnapshots() {
  return snapshotOrder.map(id => {
    const s = snapshotRing.get(id);
    return s ? {
      id: s.id,
      label: s.label,
      timestamp: s.timestamp,
      gitHash: s.gitHash,
      totalFiles: s.files?.length || 0,
      astSummary: s.astSummary
    } : null;
  }).filter(Boolean);
}

function getLatestSnapshot() {
  const latestId = getLatestId();
  return latestId ? snapshotRing.get(latestId) : null;
}

const { calculateProgress } = require('./progress-calculator');

/**
 * Compute progress metrics for a feature type from the latest project snapshot.
 * @param {string} [featureType]
 * @returns {object}
 */
function getProgressForFeature(featureType) {
  const snap = getLatestSnapshot();
  return calculateProgress(snap, featureType);
}

module.exports = {
  init,
  persist,
  clearSnapshots,
  takeSnapshot,
  diffSnapshots,
  getLatestId,
  listSnapshots,
  getSnapshot,
  getLatestSnapshot,
  getProgressForFeature,
  scanDirectorySync,
};
