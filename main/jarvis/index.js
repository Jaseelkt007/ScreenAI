'use strict';

/**
 * index.js — Jarvis pipeline entry point.
 *
 * Hotkey behaviour (M3):
 *   First F9  → show HUD + send jarvis:start-recording (begin voice capture)
 *   Second F9 → send jarvis:stop-recording → HUD encodes audio → sends jarvis:audio
 *   F9 while pipeline running → ignored
 *   F9 while HUD idle/visible → hide HUD (toggle)
 *
 * The Jarvis hotkey is registered via globalShortcut.register() directly —
 * NOT through hotkey.js — because hotkey.js calls globalShortcut.unregisterAll()
 * on every re-registration, which would wipe the Jarvis hotkey.
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
const { captureForegroundWindow } = require('./tools/windows');
const { runPipelineFromText, runPipelineFromAudio } = require('./pipeline');
const {
  setPendingTypeTargetWindowHandle,
  clearPendingTypeTargetWindowHandle,
} = require('./typing-target');

// ─── Module state ─────────────────────────────────────────────────────────────

let _hudWindow       = null;
let _hudReady        = false;   // true once did-finish-load fires
let _pendingStart    = false;   // queued start-recording for cold-start

let _pipelineRunning = false;
let _isRecording     = false;   // M3: tracks whether HUD is currently recording
let _hotkeyStarting  = false;   // guards the async "show HUD + begin recording" path

// One-shot confirm resolve/reject
let _confirmResolve = null;
let _confirmReject  = null;
let _confirmTimer   = null;

// ─── Public API ───────────────────────────────────────────────────────────────

function init(mainWindow) {
  if (!settings.getSetting('jarvisEnabled', true)) {
    console.log('[Jarvis] Disabled in settings — skipping init.');
    return;
  }

  createHudWindow();
  registerHotkey();
  registerIpcHandlers();

  console.log('[Jarvis] Initialized. F9 / Shift+Command+J → speak command.');
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
      }
      console.warn(`[Jarvis] Could not register hotkey: ${shortcut}`);
    } catch (err) {
      console.warn(`[Jarvis] Hotkey error (${shortcut}):`, err.message);
    }
  }
}

function onHotkeyFired() {
  // ── While pipeline is executing: ignore ──────────────────────────────────
  if (_pipelineRunning) return;

  // ── While first-press startup is still restoring state: ignore ───────────
  if (_hotkeyStarting) return;

  // ── While recording: second press = stop recording ───────────────────────
  if (_isRecording) {
    _isRecording = false;
    hudSend('jarvis:stop-recording', {});
    return;
  }

  // ── HUD is visible and idle: hide (toggle off) ───────────────────────────
  if (_hudWindow && !_hudWindow.isDestroyed() && _hudWindow.isVisible()) {
    hideHud();
    return;
  }

  // ── First press: show HUD + start recording ───────────────────────────────
  void startRecordingFromHotkey();
}

async function startRecordingFromHotkey() {
  _hotkeyStarting = true;
  _isRecording = true;

  try {
    await rememberTypeTargetWindow();

    if (!_hudWindow || _hudWindow.isDestroyed()) {
      createHudWindow();
    }

    showHud();

    if (_hudReady) {
      hudSend('jarvis:start-recording', {});
    } else {
      // Window not yet loaded — send after did-finish-load
      _pendingStart = true;
    }
  } finally {
    _hotkeyStarting = false;
  }
}

// ─── HUD window ───────────────────────────────────────────────────────────────

function createHudWindow() {
  _hudReady     = false;
  _pendingStart = false;

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  _hudWindow = new BrowserWindow({
    width:       360,
    height:      120,
    x:           width  - 360 - 20,
    y:           height - 120 - 20,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    movable:     true,
    show:        false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      preload:          path.join(__dirname, '../../preload/preload.js'),
    },
  });

  _hudWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  _hudWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  _hudWindow.loadFile(
    path.join(__dirname, '../../renderer/jarvis-hud/jarvis-hud.html')
  );

  _hudWindow.webContents.once('did-finish-load', () => {
    _hudReady = true;
    if (_pendingStart) {
      _pendingStart = false;
      hudSend('jarvis:start-recording', {});
    }
  });

  _hudWindow.on('closed', () => {
    _hudWindow    = null;
    _hudReady     = false;
    _isRecording  = false;
    _pendingStart = false;
    _hotkeyStarting = false;
    clearPendingTypeTargetWindowHandle();
  });

  if (process.platform === 'darwin') {
    _hudWindow.setVisibleOnAllWorkspaces(true);
  }
}

function showHud() {
  if (!_hudWindow || _hudWindow.isDestroyed()) createHudWindow();
  try {
    if (typeof _hudWindow.showInactive === 'function') {
      _hudWindow.showInactive();
    } else {
      _hudWindow.show();
    }
  } catch {
    _hudWindow.show();
  }
}

function hideHud() {
  if (_hudWindow && !_hudWindow.isDestroyed() && _hudWindow.isVisible()) {
    _hudWindow.hide();
  }
  clearPendingTypeTargetWindowHandle();
}

function hudSend(channel, payload) {
  if (!_hudWindow || _hudWindow.isDestroyed() || _hudWindow.webContents.isDestroyed()) return;
  _hudWindow.webContents.send(channel, payload);
}

async function rememberTypeTargetWindow() {
  clearPendingTypeTargetWindowHandle();

  if (process.platform !== 'win32') return;

  const hwnd = await captureForegroundWindow();
  if (hwnd) {
    setPendingTypeTargetWindowHandle(hwnd);
  }
}

// ─── waitForConfirm — one-shot promise ───────────────────────────────────────

function waitForConfirm() {
  return new Promise((resolve, reject) => {
    clearConfirmState();
    _confirmResolve = resolve;
    _confirmReject  = reject;
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

  // ── jarvis:audio — M3 voice audio (HUD sends after MediaRecorder stops) ──
  ipcMain.on('jarvis:audio', async (_e, { audioBase64, mimeType }) => {
    // Recording is now complete regardless of who stopped it
    _isRecording = false;

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
      clearPendingTypeTargetWindowHandle();
    }

    // Auto-hide after result auto-dismiss in renderer (3–5s); add small buffer
    setTimeout(() => { if (!_pipelineRunning) hideHud(); }, 4500);
  });

  // ── jarvis:text — M2/debug typed command ─────────────────────────────────
  ipcMain.on('jarvis:text', async (_e, text) => {
    if (_pipelineRunning) {
      console.warn('[Jarvis] Pipeline already running — ignoring text command');
      return;
    }
    if (!text || typeof text !== 'string' || !text.trim()) return;

    console.log(`[Jarvis] Text command: "${text}"`);
    _pipelineRunning = true;
    try {
      await runPipelineFromText(text.trim(), hudSend, waitForConfirm);
    } finally {
      _pipelineRunning = false;
      clearPendingTypeTargetWindowHandle();
    }

    setTimeout(() => { if (!_pipelineRunning) hideHud(); }, 4500);
  });

  // ── jarvis:confirm-reply ──────────────────────────────────────────────────
  ipcMain.on('jarvis:confirm-reply', (_e, confirmed) => {
    if (_confirmResolve) {
      const resolve = _confirmResolve;
      clearConfirmState();
      resolve(!!confirmed);
    }
  });

  // ── jarvis:close ──────────────────────────────────────────────────────────
  ipcMain.on('jarvis:close', () => {
    _isRecording = false;
    hideHud();
  });

  // ── jarvis:ping ───────────────────────────────────────────────────────────
  ipcMain.handle('jarvis:ping', () => ({
    ok: true, version: 1, running: _pipelineRunning, recording: _isRecording,
  }));
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('will-quit', () => {
  try { globalShortcut.unregister('F9'); } catch {}
  try { globalShortcut.unregister('Shift+Command+J'); } catch {}
});

module.exports = { init };
