'use strict';

/**
 * index.js — Jarvis pipeline entry point.
 *
 * Responsibilities:
 *   - Register F9 / Shift+Command+J hotkey directly via globalShortcut
 *     (NOT through hotkey.js — that calls unregisterAll() on re-register)
 *   - Create and manage the Jarvis HUD BrowserWindow (create once, show/hide)
 *   - Wire IPC: jarvis:text, jarvis:audio, jarvis:confirm-reply, jarvis:ping
 *   - Provide hudSend() and waitForConfirm() to pipeline
 *
 * Called once from main.js: jarvis.init(mainWindow)
 */

const {
  globalShortcut,
  BrowserWindow,
  ipcMain,
  screen,
  app,
} = require('electron');

const path     = require('path');
const settings = require('../settings');
const { runPipelineFromText, runPipelineFromAudio } = require('./pipeline');

// ─── Module state ─────────────────────────────────────────────────────────────

let _hudWindow   = null;
let _mainWindow  = null;
let _pipelineRunning = false;

// One-shot confirm resolve/reject — populated by waitForConfirm(), cleared on use
let _confirmResolve = null;
let _confirmReject  = null;
let _confirmTimer   = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the Jarvis pipeline. Called once from main.js after app is ready.
 * @param {BrowserWindow} mainWindow — the app's primary window (for re-registration events)
 */
function init(mainWindow) {
  _mainWindow = mainWindow;

  if (!settings.getSetting('jarvisEnabled', true)) {
    console.log('[Jarvis] Disabled in settings — skipping init.');
    return;
  }

  createHudWindow();
  registerHotkey();
  registerIpcHandlers();

  console.log('[Jarvis] Initialized. Press F9 / Shift+Command+J to activate.');
}

// ─── Hotkey ───────────────────────────────────────────────────────────────────

const HOTKEYS = {
  darwin: ['Shift+Command+J'],
  win32:  ['F9'],
  linux:  ['F9'],
};

function registerHotkey() {
  const customHotkey = settings.getSetting('jarvisHotkey', '');
  const shortcuts = customHotkey
    ? [customHotkey]
    : (HOTKEYS[process.platform] || HOTKEYS.linux);

  for (const shortcut of shortcuts) {
    try {
      const ok = globalShortcut.register(shortcut, onHotkeyFired);
      if (ok) {
        console.log(`[Jarvis] Hotkey registered: ${shortcut}`);
        return;
      } else {
        console.warn(`[Jarvis] Could not register hotkey: ${shortcut}`);
      }
    } catch (err) {
      console.warn(`[Jarvis] Hotkey error (${shortcut}):`, err.message);
    }
  }
}

function onHotkeyFired() {
  if (!_hudWindow || _hudWindow.isDestroyed()) {
    createHudWindow();
  }

  if (_hudWindow.isVisible()) {
    // Toggle: hide if already open and pipeline is idle
    if (!_pipelineRunning) {
      _hudWindow.hide();
    }
    return;
  }

  showHud();
}

// ─── HUD window ───────────────────────────────────────────────────────────────

function createHudWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  _hudWindow = new BrowserWindow({
    width:  360,
    height: 120,
    x: width  - 360 - 20,
    y: height - 120 - 20,
    frame:          false,
    transparent:    true,
    alwaysOnTop:    true,
    skipTaskbar:    true,
    resizable:      false,
    movable:        true,
    show:           false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // needed for preload IPC
      preload:          path.join(__dirname, '../../preload/preload.js'),
    },
  });

  // Prevent navigation / popups
  _hudWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  _hudWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  _hudWindow.loadFile(
    path.join(__dirname, '../../renderer/jarvis-hud/jarvis-hud.html')
  );

  _hudWindow.on('closed', () => {
    _hudWindow = null;
  });

  // Don't show in taskbar / dock
  if (process.platform === 'darwin') _hudWindow.setVisibleOnAllWorkspaces(true);
}

function showHud() {
  if (!_hudWindow || _hudWindow.isDestroyed()) createHudWindow();
  _hudWindow.show();
  _hudWindow.focus();
}

function hideHud() {
  if (_hudWindow && !_hudWindow.isDestroyed() && _hudWindow.isVisible()) {
    _hudWindow.hide();
  }
}

function hudSend(channel, payload) {
  if (!_hudWindow || _hudWindow.isDestroyed() || _hudWindow.webContents.isDestroyed()) return;
  _hudWindow.webContents.send(channel, payload);
}

// ─── waitForConfirm — one-shot promise ───────────────────────────────────────

function waitForConfirm() {
  return new Promise((resolve, reject) => {
    // Clear any stale confirm state
    clearConfirmState();

    _confirmResolve = resolve;
    _confirmReject  = reject;

    // 10-second timeout
    _confirmTimer = setTimeout(() => {
      clearConfirmState();
      reject(new Error('Confirmation timeout'));
    }, 10000);
  });
}

function clearConfirmState() {
  if (_confirmTimer) { clearTimeout(_confirmTimer); _confirmTimer = null; }
  _confirmResolve = null;
  _confirmReject  = null;
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers() {

  // ── jarvis:text — M2 typed command from HUD ──────────────────────────────
  ipcMain.on('jarvis:text', async (_e, text) => {
    if (_pipelineRunning) {
      console.warn('[Jarvis] Pipeline already running — ignoring new command');
      return;
    }

    if (!text || typeof text !== 'string' || !text.trim()) return;

    console.log(`[Jarvis] Command received: "${text}"`);
    _pipelineRunning = true;

    try {
      await runPipelineFromText(text.trim(), hudSend, waitForConfirm);
    } finally {
      _pipelineRunning = false;
    }

    // Auto-hide HUD shortly after done event is sent (renderer auto-dismisses first)
    setTimeout(() => {
      if (!_pipelineRunning) hideHud();
    }, 4000);
  });

  // ── jarvis:audio — M3 voice audio from HUD ───────────────────────────────
  ipcMain.on('jarvis:audio', async (_e, { audioBase64, mimeType }) => {
    if (_pipelineRunning) {
      console.warn('[Jarvis] Pipeline already running — ignoring audio');
      return;
    }

    if (!audioBase64) return;

    _pipelineRunning = true;
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      await runPipelineFromAudio(audioBuffer, mimeType, hudSend, waitForConfirm);
    } finally {
      _pipelineRunning = false;
    }

    setTimeout(() => {
      if (!_pipelineRunning) hideHud();
    }, 4000);
  });

  // ── jarvis:confirm-reply — user confirmed or cancelled ───────────────────
  ipcMain.on('jarvis:confirm-reply', (_e, confirmed) => {
    if (_confirmResolve) {
      const resolve = _confirmResolve;
      clearConfirmState();
      resolve(!!confirmed);
    }
  });

  // ── jarvis:close — renderer requests close ────────────────────────────────
  ipcMain.on('jarvis:close', () => {
    hideHud();
  });

  // ── jarvis:ping — health check (used by settings UI) ─────────────────────
  ipcMain.handle('jarvis:ping', () => {
    return { ok: true, version: 1, running: _pipelineRunning };
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('will-quit', () => {
  globalShortcut.unregister('F9');
  globalShortcut.unregister('Shift+Command+J');
});

module.exports = { init };
