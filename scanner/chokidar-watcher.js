/**
 * PromptLock — Chokidar Watcher Manager (Step 2 Upgrade)
 *
 * Real-time workspace file system monitoring with pause/resume queuing.
 *  - pauseWatching(): stops emitting events, queues them in memory
 *  - resumeWatching(): flushes queue and emits consolidated update
 *  - getQueuedChanges(): returns currently queued change events
 */

'use strict';

const path     = require('path');
const chokidar = require('chokidar');
const { shouldIgnore } = require('./ignore-rules');

class WatcherManager {
  constructor() {
    /** @type {import('chokidar').FSWatcher | null} */
    this.watcher = null;
    this.isPaused = false;
    this.eventQueue = [];
    this.debounceTimer = null;
    this.onEventCallback = null;
    this.onSnapshotReady = null;
    this.rootPath = null;
    this.igFilter = null;
  }

  /**
   * Start watching the given root directory.
   */
  start(dir, igFilter, onEvent, onSnapshotReady) {
    this.stop();
    this.rootPath = dir;
    this.igFilter = igFilter;
    this.onEventCallback = onEvent;
    this.onSnapshotReady = onSnapshotReady;
    this.isPaused = false;
    this.eventQueue = [];

    this.watcher = chokidar.watch(dir, {
      ignored: (filePath) => {
        const basename = path.basename(filePath);
        if (basename.endsWith('.json')) return true;
        if (basename.endsWith('.pyc') || basename.endsWith('.pyo') || basename.endsWith('.pyd')) return true;
        const rel = path.relative(dir, filePath);
        if (!rel) return false;
        const parts = rel.split(/[\\/]/);
        if (parts.some(p => ['.venv', 'venv', 'env', '__pycache__', '.git', 'node_modules', 'userData', 'dist', 'build', 'out', 'coverage'].includes(p) || p.startsWith('userData') || p === '.env' || p.startsWith('.env.'))) return true;
        return shouldIgnore(rel, this.igFilter);
      },
      persistent:       true,
      ignoreInitial:    true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      usePolling:       false,
      disableGlobbing:  true,
    });

    this.watcher
      .on('add',    filePath => this.handleEvent('add',    filePath))
      .on('change', filePath => this.handleEvent('change', filePath))
      .on('unlink', filePath => this.handleEvent('remove', filePath))
      .on('error',  err => console.error('[PromptLock Watcher]', err));

    console.log('[WatcherManager] Started watching:', dir);
  }

  /**
   * Internal event dispatcher with pause queuing and debounce.
   */
  handleEvent(event, filePath) {
    if (!this.watcher || !this.rootPath) return; // Guard against stale events
    const basename = path.basename(filePath);
    if (basename.endsWith('.json')) return;
    if (basename.endsWith('.pyc') || basename.endsWith('.pyo') || basename.endsWith('.pyd')) return;

    const rel = this.rootPath ? path.relative(this.rootPath, filePath) : filePath;
    if (rel) {
      const parts = rel.split(/[\\/]/);
      if (parts.some(p => ['.venv', 'venv', 'env', '__pycache__', '.git', 'node_modules', 'userData', 'dist', 'build', 'out', 'coverage'].includes(p) || p.startsWith('userData') || p === '.env' || p.startsWith('.env.'))) return;
      if (shouldIgnore(rel, this.igFilter)) return;
    }

    if (this.isPaused) {
      this.eventQueue.push({ event, filePath, rel, timestamp: new Date().toISOString() });
      console.log(`[WatcherManager] (PAUSED) Queued event: ${event} ${rel}`);
      return;
    }

    if (this.onEventCallback) {
      this.onEventCallback(event, filePath);
    }

    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (this.onSnapshotReady) {
        this.onSnapshotReady();
      }
    }, 120);
  }

  /**
   * Pause watching: stop emitting notifications, queue incoming changes.
   */
  pauseWatching() {
    this.isPaused = true;
    clearTimeout(this.debounceTimer);
    console.log('[WatcherManager] Watcher PAUSED — queuing FS events');
  }

  /**
   * Resume watching: flush queued events and notify listeners.
   */
  resumeWatching() {
    if (!this.isPaused) return [];
    this.isPaused = false;
    const flushed = [...this.eventQueue];
    this.eventQueue = [];
    console.log(`[WatcherManager] Watcher RESUMED — flushing ${flushed.length} queued events`);

    for (const item of flushed) {
      if (this.onEventCallback) {
        this.onEventCallback(item.event, item.filePath);
      }
    }

    if (flushed.length > 0 && this.onSnapshotReady) {
      this.onSnapshotReady();
    }

    return flushed;
  }

  /**
   * Safely pause and prepare watcher for project switch, preventing file corruption.
   */
  async safeSwitch(newDir = null) {
    this.pauseWatching();
    this.eventQueue = [];
    clearTimeout(this.debounceTimer);
    const oldWatcher = this.watcher;
    this.watcher = null;
    if (oldWatcher) {
      try {
        await oldWatcher.close();
      } catch (_) {}
    }
    this.rootPath = newDir;
    console.log('[WatcherManager] Concurrency Safeguard: safeSwitch completed');
  }

  /**
   * Get all currently queued changes while paused.
   */
  getQueuedChanges() {
    return [...this.eventQueue];
  }

  /**
   * Stop and destroy the watcher.
   */
  async stop() {
    clearTimeout(this.debounceTimer);
    const oldWatcher = this.watcher;
    this.watcher = null;
    this.eventQueue = [];
    this.isPaused = false;
    if (oldWatcher) {
      try {
        await oldWatcher.close();
      } catch (_) {}
    }
  }
}

module.exports = { WatcherManager };
