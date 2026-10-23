/**
 * PromptLock — AST Metadata & Dependency Intelligence Engine (Step 2 Upgraded)
 *
 * Responsibilities:
 *  1. Folder scanning with ignore engine (*.log, .DS_Store, Thumbs.db, *.tmp + .gitignore).
 *  2. Deep AST file metadata extraction:
 *     hash (sha256), lastModified, gitStatus, loc, classes[], isEntryPoint.
 *  3. Chokidar watcher with pauseWatching() and resumeWatching() queuing.
 *  4. 8-metric dependency health analysis:
 *     [Files Scanned, AST Parsed, Dependencies, Risky Imports, .env Exposure,
 *      Missing Imports, Dependency Cycles, Orphan Files].
 *  5. In-memory metadata tree surfaced to renderer via IPC.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const {
  buildIgnoreFilter,
  shouldIgnore,
  ALWAYS_IGNORE,
  BINARY_EXT,
  AST_EXT,
  MAX_FILE_BYTES,
} = require('./scanner/ignore-rules');
const {
  parseFileDeep,
  calculateHealth,
  calculateModuleBreakdown,
  checkEntryPoint,
} = require('./scanner/file-tree');
const { WatcherManager } = require('./scanner/chokidar-watcher');

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} absolute path → file metadata */
const fileMap = new Map();

/** @type {WatcherManager} */
const watcherManager = new WatcherManager();

/** @type {string | null} */
let rootPath = null;

/** @type {import('ignore').Ignore} */
let ig = null;

/** Broadcaster: called every time metadata changes — bound by main.js */
let onChangeCallback = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialise (or re-initialise) the engine for a new project root.
 * @param {string} dir  Absolute path of the project root.
 * @param {(snapshot: object) => void} onChange  Called whenever metadata changes.
 */
async function init(dir, onChange) {
  onChangeCallback = onChange;
  rootPath = dir;
  fileMap.clear();

  // Build ignore rules
  ig = buildIgnoreFilter(dir);

  // Full initial scan
  await scanDir(dir, dir);

  // Start watcher with pause/resume support
  watcherManager.start(
    dir,
    ig,
    (event, filePath) => {
      const rel = rootPath ? path.relative(rootPath, filePath) : filePath;
      if (event === 'remove') {
        fileMap.delete(filePath);
        console.log(`[AST] removed: ${rel}`);
      } else {
        // 'add' or 'change': re-parse the single file
        const meta = parseFileDeep(filePath, rootPath);
        if (meta) {
          fileMap.set(filePath, meta);
        } else {
          fileMap.delete(filePath);
        }
        console.log(`[AST] ${event}: ${rel}`);
      }
    },
    () => {
      if (onChangeCallback) onChangeCallback(buildSnapshot());
    }
  );

  return buildSnapshot();
}

/**
 * Tear down the watcher (call on app quit or when switching project).
 */
async function destroy() {
  await watcherManager.stop();
  fileMap.clear();
  rootPath = null;
  onChangeCallback = null;
}

/**
 * Return the current in-memory project snapshot (IPC-safe plain object).
 */
function getSnapshot() {
  return buildSnapshot();
}

/**
 * Pause watcher events during prompt generation.
 */
function pauseWatching() {
  watcherManager.pauseWatching();
}

/**
 * Resume watcher events after execution verification.
 */
function resumeWatching() {
  return watcherManager.resumeWatching();
}

/**
 * Get queued changes while paused.
 */
function getQueuedChanges() {
  return watcherManager.getQueuedChanges();
}

// ─── Directory Scanner ────────────────────────────────────────────────────────

async function scanDir(dir, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);

    if (shouldIgnore(rel, ig)) continue;

    if (entry.isDirectory()) {
      await scanDir(abs, root);
    } else if (entry.isFile()) {
      const meta = parseFileDeep(abs, root);
      if (meta) fileMap.set(abs, meta);
    }
  }
}

// ─── Snapshot Builder ─────────────────────────────────────────────────────────

function buildSnapshot() {
  const files = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
  const astFiles = files.filter(f => f.isAST);
  const nonAST = files.filter(f => !f.isAST);

  const allImports = astFiles.flatMap(f => f.imports.map(i => i.from));
  const external = allImports.filter(m => !m.startsWith('.') && !m.startsWith('/'));
  const unique = [...new Set(external)];

  // 8 Health bars computed via scanner/file-tree.js
  const depHealth = calculateHealth(files, rootPath);

  return {
    projectId:  `pl_${Buffer.from(rootPath || '').toString('base64').slice(0, 12)}`,
    rootPath:   rootPath || '',
    scannedAt:  new Date().toISOString(),
    stats: {
      totalFiles:  files.length,
      astFiles:    astFiles.length,
      otherFiles:  nonAST.length,
      functions:   astFiles.reduce((n, f) => n + (f.fns || []).length, 0),
      exports:     astFiles.reduce((n, f) => n + (f.exports || []).length, 0),
      uniqueDeps:  unique.length,
      totalLoc:    files.reduce((n, f) => n + (f.loc || 0), 0),
      moduleWiseBreakdown: calculateModuleBreakdown(files),
    },
    moduleWiseBreakdown: calculateModuleBreakdown(files),
    depHealth,
    files,
  };
}

/**
 * Force a fresh, absolute re-scan of the directory from physical disk,
 * updating fileMap and returning the updated snapshot.
 * @param {string} [targetDir]
 * @returns {Promise<object>}
 */
async function rescan(targetDir) {
  const dir = targetDir || rootPath;
  if (!dir || !fs.existsSync(dir)) return buildSnapshot();
  rootPath = dir;
  ig = buildIgnoreFilter(dir);
  fileMap.clear();
  await scanDir(dir, dir);
  const snap = buildSnapshot();
  if (onChangeCallback) onChangeCallback(snap);
  return snap;
}

async function scan(targetDir) {
  return await rescan(targetDir);
}

module.exports = {
  init,
  destroy,
  getSnapshot,
  pauseWatching,
  resumeWatching,
  getQueuedChanges,
  buildSnapshot,
  rescan,
  scan,
};
