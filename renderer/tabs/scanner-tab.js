/**
 * Xprompt — Scanner Tab Controller (Step 2 Upgrade Shim)
 *
 * Thin module wrapper for the File Tree & Health tab.
 * Core logic lives in app.js (renderSnapshot, renderScanningState, etc.)
 * This file exists to match the new modular structure.
 *
 * Step 2 upgrades wired here:
 * - 8 health bars (was 5) — handled in ast-engine.js buildSnapshot()
 * - Deep metadata display (hash, loc, gitStatus) — renderSnapshot() in app.js
 */

'use strict';

// Re-export tab init marker
window._scannerTabInit = true;
