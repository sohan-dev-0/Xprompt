require('dotenv').config();

/**
 * PromptLock — Electron Main Process (v2.0 Orchestrator Upgrade)
 *
 * Implements Step 1 & Step 2 Architecture:
 *  - Floating frameless glassmorphism window
 *  - Deep AST scanning & file metadata engine
 *  - Watcher pause/resume controls
 *  - IPC handlers for Intent, Permission, Prompt, Verification, Snapshots, and AI Settings
 */

'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  dialog,
  clipboard,
  screen,
  Tray,
  nativeImage,
  Menu,
} = require('electron');
const path         = require('path');
const fs           = require('fs');
const astEngine    = require('./ast-engine');
const sessionStore = require('./session-store');

// Step 1 & 2 IPC Modules (Chat, Permission, Prompt, Verification)
const { registerChatIPC }         = require('./ipc/chat-ipc');
const { registerPermissionIPC }   = require('./ipc/permission-ipc');
const { registerPromptIPC }       = require('./ipc/prompt-ipc');
const { registerVerificationIPC } = require('./ipc/verification-ipc');
const { register: registerAIIPC } = require('./ipc/ai-ipc');

let mainWindow = null;
let tray = null;

// Window size states
const ICON_SIZE   = { width: 64,  height: 64  };
const EXPAND_SIZE = { width: 560, height: 720 };

// ── Window factory ────────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'assets/icon.png'),
    width:  ICON_SIZE.width,
    height: ICON_SIZE.height,
    x: width  - ICON_SIZE.width  - 24,
    y: height - ICON_SIZE.height - 24,
    frame:       false,
    transparent: true,
    hasShadow:   true,
    alwaysOnTop: true,
    resizable:   false,
    skipTaskbar: false,
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      sandbox:              false,
      backgroundThrottling: true,
    },
  });

  mainWindow.loadFile('renderer/index.html');
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[Renderer] ${message}`);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Set Mac Dock Icon
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, 'assets/icon.png'));
    } catch (e) {
      console.warn('[PromptLock] Failed to set dock icon:', e.message);
    }
  }

  // Set System Tray Icon
  try {
    const iconPath = path.join(__dirname, 'assets/icon.png');
    if (fs.existsSync(iconPath)) {
      const trayImage = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
      tray = new Tray(trayImage);
      tray.setToolTip('PromptLock');
      const trayMenu = Menu.buildFromTemplate([
        {
          label: 'Show / Hide PromptLock',
          click: () => {
            if (!mainWindow) return;
            if (mainWindow.isVisible()) {
              mainWindow.hide();
            } else {
              mainWindow.show();
              mainWindow.focus();
            }
          }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ]);
      tray.setContextMenu(trayMenu);
      tray.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      });
    }
  } catch (trayErr) {
    console.warn('[PromptLock] Tray setup warning:', trayErr.message);
  }

  createWindow();

  // 1. Run storage migration first
  try {
    await require('./storage/migrate').runMigration();
  } catch (migErr) {
    console.warn('[PromptLock] Startup migration warning:', migErr.message);
  }

  // 2. Register modular IPC modules
  const getWindow = () => mainWindow;
  const projectIPC = require('./ipc/project-ipc');
  const projectStore = require('./storage/project-store');

  try { projectIPC.register(getWindow, astEngine); } catch (e) { console.warn('[IPC] project-ipc registration error:', e.message); }
  try { registerChatIPC(getWindow, astEngine); } catch (e) { console.warn('[IPC] chat-ipc registration error:', e.message); }
  try { registerPermissionIPC(getWindow, astEngine); } catch (e) { console.warn('[IPC] permission-ipc registration error:', e.message); }
  try { registerPromptIPC(getWindow, astEngine); } catch (e) { console.warn('[IPC] prompt-ipc registration error:', e.message); }
  try { registerVerificationIPC(getWindow, astEngine); } catch (e) { console.warn('[IPC] verification-ipc registration error:', e.message); }
  try { registerAIIPC(getWindow, astEngine); } catch (e) { console.warn('[IPC] ai-ipc registration error:', e.message); }

  // Pre-scan last active project on launch if it exists
  const savedState = sessionStore.loadState();
  const rawActiveRoot = savedState.lastActiveProjectPath || projectIPC.getActiveRootPath();
  const activeRoot = projectStore.sanitizeProjectPath(rawActiveRoot);

  if (activeRoot && fs.existsSync(activeRoot)) {
    console.log('[PromptLock] Auto-restoring workspace on startup:', activeRoot);
    try {
      const activePid = projectIPC.getActiveProjectId();
      if (activePid) {
        try {
          const snapshotManager = require('./scanner/snapshot-manager');
          if (typeof snapshotManager.init === 'function') snapshotManager.init(activePid);
        } catch (_) {}
      }

      await astEngine.init(savedState.lastActiveProjectPath || activeRoot, (updatedSnapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ast:update', updatedSnapshot);
        }
      });
    } catch (err) {
      console.warn('[PromptLock] Startup pre-scan error:', err.message);
    }
  }

  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!mainWindow) { createWindow(); return; }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    } else {
      mainWindow.webContents.send('toggle-from-shortcut');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await astEngine.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Window management IPC ─────────────────────────────────────────────────────

ipcMain.on('window-expand', () => {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let x = Math.max(8, Math.min(bounds.x + bounds.width  - EXPAND_SIZE.width,  sw - EXPAND_SIZE.width  - 8));
  let y = Math.max(8, Math.min(bounds.y + bounds.height - EXPAND_SIZE.height, sh - EXPAND_SIZE.height - 8));

  mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: EXPAND_SIZE.width, height: EXPAND_SIZE.height });
  mainWindow.focus();
  console.log('[PromptLock] Expanded panel to', EXPAND_SIZE.width, 'x', EXPAND_SIZE.height, 'at', x, y);
});

ipcMain.on('window-collapse', () => {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let x = Math.max(8, Math.min(bounds.x + bounds.width  - ICON_SIZE.width,  sw - ICON_SIZE.width  - 8));
  let y = Math.max(8, Math.min(bounds.y + bounds.height - ICON_SIZE.height, sh - ICON_SIZE.height - 8));
  mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: ICON_SIZE.width, height: ICON_SIZE.height });
  console.log('[PromptLock] Collapsed to icon at', x, y);
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close',    () => mainWindow?.hide());

ipcMain.on('window-move', (_e, { dx, dy }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [w, h] = mainWindow.getSize();
  mainWindow.setPosition(
    Math.round(Math.max(0, Math.min(x + dx, sw - w))),
    Math.round(Math.max(0, Math.min(y + dy, sh - h)))
  );
});

// ── Basic utility IPC ─────────────────────────────────────────────────────────

ipcMain.handle('dialog-open-folder', async (_e, opts = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: (opts && opts.title) || 'Select or Create Project Root Directory — PromptLock',
    buttonLabel: (opts && opts.buttonLabel) || 'Select Folder',
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const projectStore = require('./storage/project-store');
    return projectStore.sanitizeProjectPath(result.filePaths[0]);
  }
  return null;
});

ipcMain.handle('clipboard-write', (_e, text) => {
  if (typeof text === 'string') {
    clipboard.writeText(text);
    return true;
  }
  return false;
});

// ── Session State IPC ─────────────────────────────────────────────────────────

ipcMain.handle('session:load', () => {
  return sessionStore.loadState();
});

ipcMain.handle('session:save', (_e, updates) => {
  return sessionStore.saveState(updates);
});

ipcMain.on('session:save-sync', (event, updates) => {
  try {
    const res = sessionStore.saveState(updates);
    event.returnValue = { success: true, state: res };
  } catch (err) {
    event.returnValue = { success: false, error: err.message };
  }
});

// ── AST / Scan IPC ────────────────────────────────────────────────────────────

ipcMain.handle('ast:scan', async (_e, rawFolderPath) => {
  const projectStore = require('./storage/project-store');
  const folderPath   = projectStore.sanitizeProjectPath(rawFolderPath);
  console.log('[PromptLock] Starting AST scan for:', folderPath);

  try {
    const projectStore = require('./storage/project-store');
    const projectIPC   = require('./ipc/project-ipc');
    const projectId    = projectStore.getProjectId(folderPath);
    const projectName  = path.basename(folderPath);

    projectStore.ensureProjectDir(projectId);
    await projectStore.saveMeta(projectId, {
      projectId,
      rootPath: folderPath,
      name: projectName,
      lastOpened: Date.now(),
    });
    await projectStore.addRecentProject({
      projectId,
      rootPath: folderPath,
      name: projectName,
      lastOpened: Date.now(),
    });
    await projectStore.saveSettings({ lastProjectId: projectId });
    projectIPC.setActiveProject(projectId, folderPath);

    try {
      const snapshotManager = require('./scanner/snapshot-manager');
      if (typeof snapshotManager.init === 'function') snapshotManager.init(projectId);
    } catch (_) {}

    const snapshot = await astEngine.init(folderPath, (updatedSnapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ast:update', updatedSnapshot);
      }
    });

    sessionStore.saveState({ lastActiveProjectPath: folderPath });

    console.log(
      `[PromptLock] Scan complete: ${snapshot.stats.totalFiles} files, ` +
      `${snapshot.stats.astFiles} AST-parsed, ${snapshot.stats.functions} functions`
    );

    return { ok: true, snapshot, projectId };

  } catch (err) {
    console.error('[PromptLock] AST scan error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ast:get-snapshot', () => {
  return astEngine.getSnapshot();
});

ipcMain.handle('ast:stop', async () => {
  await astEngine.destroy();
  sessionStore.saveState({ lastActiveProjectPath: null });
  return true;
});
