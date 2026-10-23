/**
 * PromptLock — Intent IPC Handler (Step 1 Upgrade)
 *
 * Handles developer intent submission and produces a mock execution plan.
 * All responses are stubs — no AI API calls are made here.
 */

'use strict';

const { ipcMain } = require('electron');

let isRegistered = false;

/**
 * Register intent-related IPC handlers.
 * @param {import('electron').BrowserWindow} getWindow - Fn returning main window
 */
function registerIntentIPC(getWindow) {
  if (isRegistered) return;
  isRegistered = true;

  try { ipcMain.removeHandler('intent:submit'); } catch (_) {}

  /**
   * intent:submit
   * Renderer → Main: developer submits their intent message.
   * Returns a stub plan object for the Permission tab to display.
   */
  ipcMain.handle('intent:submit', (_event, payload) => {
    // Validate input
    if (!payload || typeof payload.message !== 'string') {
      return { ok: false, error: 'Invalid payload: message must be a string' };
    }

    const message = payload.message.trim().slice(0, 2000); // cap length
    if (message.length < 3) {
      return { ok: false, error: 'Intent too short — please describe what you want to build' };
    }

    // Do NOT log the message content — only log that a submission occurred
    console.log('[Intent IPC] intent:submit received');

    // Stub plan response — simulates what an AI would generate
    const stubPlan = {
      id: `plan_${Date.now()}`,
      intentSummary: message.slice(0, 120) + (message.length > 120 ? '…' : ''),
      filesToEdit: [
        'src/auth/auth.service.ts',
        'src/auth/auth.controller.ts',
        'src/users/user.entity.ts',
      ],
      filesToCreate: [
        'src/auth/jwt.strategy.ts',
        'src/auth/guards/jwt-auth.guard.ts',
      ],
      forbiddenFiles: [
        '.env',
        'node_modules/',
        'package-lock.json',
      ],
      missingFiles: [
        'src/auth/dto/login.dto.ts',
        'src/auth/dto/register.dto.ts',
      ],
      riskLevel: 'medium',
      riskReasons: [
        'Touches authentication boundary',
        'Creates new JWT strategy — review token expiry',
        'Ensure Zod validation on all incoming DTOs',
      ],
      estimatedChanges: {
        linesAdded: 140,
        linesModified: 45,
        filesAffected: 5,
      },
      securityChecks: [
        'Zero hardcoded secrets',
        'No eval() usage',
        'Zod schema validation enforced',
        'SQL guard active',
      ],
      timestamp: new Date().toISOString(),
    };

    return { ok: true, plan: stubPlan };
  });

  console.log('[Intent IPC] intent:submit handler registered');
}

module.exports = { registerIntentIPC };
