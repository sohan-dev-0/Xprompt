/**
 * Xprompt — Storage Migration Runner
 *
 * Checks for legacy promptlock-session.json in userData and migrates it
 * to the new per-project isolated directory structure userData/projects/{projectId}/.
 * Runs atomically and idempotently on startup.
 */

'use strict';

const projectStore = require('./project-store');

/**
 * Execute data migration from legacy flat session format to per-project store.
 * @returns {Promise<{ migrated: boolean, projectId?: string, error?: string, reason?: string }>}
 */
async function runMigration() {
  try {
    const result = await projectStore.migrateLegacyData();
    console.log('[Migration] Run result:', result);
    return result;
  } catch (err) {
    console.error('[Migration] Failed:', err);
    return { migrated: false, error: err.message };
  }
}

module.exports = {
  runMigration,
};
