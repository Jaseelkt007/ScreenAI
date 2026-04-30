'use strict';

/**
 * index.js — Jarvis pipeline entry point.
 *
 * Hotkey behaviour (push-to-talk):
 *   Hold Right Alt          → show PTT HUD, start recording
 *   Release Right Alt       → stop recording, hand audio to pipeline,
 *                             show Jarvis HUD for transcript/plan/result
 *   Release < 200 ms        → discard (anti-tap)
 *   Hold while pipeline busy → ignored
 *
 * Hold detection uses uiohook-napi because Electron's `globalShortcut`
 * fires only on key down. The default key is Right Alt; the user can
 * rebind via Settings → JARVIS HOTKEY.
 */

const {
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

// uiohook-napi is a native module — load defensively so a missing or
// un-rebuilt binary degrades to "Jarvis disabled" rather than crashing
// the whole app.
let uIOhook = null;
let UiohookKey = null;
try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
} catch (err) {
  console.warn('[Jarvis] uiohook-napi failed to load — push-to-talk disabled:', err.message);
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _hudWindow       = null;
let _hudReady        = false;

let _pttHudWindow    = null;
let _pttHudReady     = false;
let _pttPendingStart = false;

let _pipelineRunning = false;
let _pttHolding      = false;   // Right Alt currently down
let _pttBusy         = false;   // released, audio in flight to main

let _uiohookStarted  = false;
let _activeKeycode   = null;    // current PTT keycode after settings resolve
let _keydownHandler  = null;
let _keyupHandler    = null;

let _pttDownAt       = 0;
let _pttBusyTimeout  = null;
const PTT_MIN_HOLD_MS  = 200;
const PTT_BUSY_TIMEOUT_MS = 3000; // safety: clear _pttBusy if audio never arrives

// One-shot confirm resolve/reject
let _confirmResolve = null;
let _confirmReject  = null;
let _confirmTimer   = null;

// ─── Public API ───────────────────────────────────────────────────────────────

function init() {
  if (!settings.getSetting('jarvisEnabled', true)) {
    console.log('[Jarvis] Disabled in settings — skipping init.');
    return;
  }

  createHudWindow();
  createPttHudWindow();
  registerIpcHandlers();
  registerHotkey();

  console.log('[Jarvis] Initialized. Hold Right Alt → speak command.');
}

/** Re-read the configured PTT key and update the live binding. */
function reregisterHotkey() {
  _activeKeycode = resolveKeycode();
  console.log(`[Jarvis] PTT key bound to keycode ${_activeKeycode}`);
}

// ─── Hotkey (uiohook push-to-talk) ────────────────────────────────────────────

function resolveKeycode() {
  if (!UiohookKey) return null;
  const name = (settings.getSetting('jarvisHotkey', '') || 'AltRight').trim();
  const code = UiohookKey[name];
  if (typeof code === 'number') return code;
  console.warn(`[Jarvis] Unknown jarvisHotkey "${name}" — falling back to AltRight`);
  return UiohookKey.AltRight;
}

function registerHotkey() {
  if (!uIOhook || !UiohookKey) return;

  _activeKeycode = resolveKeycode();

  _keydownHandler = (e) => {
    if (_activeKeycode == null || e.keycode !== _activeKeycode) return;
    onPttKeyDown();
  };
  _keyupHandler = (e) => {
    if (_activeKeycode == null || e.keycode !== _activeKeycode) return;
    onPttKeyUp();
  };

  uIOhook.on('keydown', _keydownHandler);
  uIOhook.on('keyup',   _keyupHandler);

  if (!_uiohookStarted) {
    try {
      uIOhook.start();
      _uiohookStarted = true;
      console.log(`[Jarvis] uiohook started — PTT keycode ${_activeKeycode}`);
    } catch (err) {
      console.error('[Jarvis] uiohook.start failed:', err.message);
    }
  }
}

function onPttKeyDown() {
  // OS key-repeat fires keydown continuously while held — ignore re-entrant
  // events while we're already holding.
  if (_pttHolding) return;
  if (_pipelineRunning || _pttBusy) {
    // Don't even flip the holding flag, so the matching keyup is a no-op too.
    return;
  }

  _pttHolding = true;
  _pttDownAt  = Date.now();
  void onPttStart();
}

function onPttKeyUp() {
  if (!_pttHolding) return;
  _pttHolding = false;

  const heldMs = Date.now() - _pttDownAt;
  if (heldMs < PTT_MIN_HOLD_MS) {
    void onPttCancel();
    return;
  }

  _pttBusy = true;
  if (_pttBusyTimeout) clearTimeout(_pttBusyTimeout);
  _pttBusyTimeout = setTimeout(() => {
    if (_pttBusy) {
      console.warn('[Jarvis] PTT audio never arrived — clearing busy flag');
      _pttBusy = false;
    }
    _pttBusyTimeout = null;
  }, PTT_BUSY_TIMEOUT_MS);
  pttHudSend('ptt:stop');
}

async function onPttStart() {
  try {
    await rememberTypeTargetWindow();
  } catch (err) {
    console.warn('[Jarvis] type-target capture failed (non-fatal):', err.message);
  }

  if (!_pttHudWindow || _pttHudWindow.isDestroyed()) {
    createPttHudWindow();
  }

  if (_pttHudReady) {
    pttHudSend('ptt:start');
  } else {
    _pttPendingStart = true;
  }
}

function onPttCancel() {
  if (_pttHudReady) pttHudSend('ptt:cancel');
  _pttPendingStart = false;
}

// ─── Jarvis HUD (results / plan / transcript) ────────────────────────────────

function createHudWindow() {
  _hudReady = false;

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  _hudWindow = new BrowserWindow({
    width:       360,
    height:      120,
    x:           width  - 360 - 20,
    y:           height - 120 - 20,
    frame:       false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    movable:     true,
    hasShadow:   false,
    thickFrame:  false,
    roundedCorners: false,
    show:        false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      preload:          path.join(__dirname, '../../preload/preload.js'),
    },
  });

  // Re-assert transparency. On Windows 11 the constructor `backgroundColor`
  // is sometimes ignored, leaving the window painting an opaque black plate
  // behind any rounded body — visible as a "rectangle around the oval".
  try { _hudWindow.setBackgroundColor('#00000000'); } catch {}

  _hudWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  _hudWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  _hudWindow.loadFile(
    path.join(__dirname, '../../renderer/jarvis-hud/jarvis-hud.html')
  );

  _hudWindow.webContents.once('did-finish-load', () => {
    _hudReady = true;
    try { _hudWindow.setBackgroundColor('#00000000'); } catch {}
  });

  _hudWindow.on('closed', () => {
    _hudWindow = null;
    _hudReady  = false;
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

// ─── PTT HUD (small waveform, owns the mic during hold) ──────────────────────

function createPttHudWindow() {
  _pttHudReady     = false;
  _pttPendingStart = false;

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const W = 140;
  const H = 44;

  _pttHudWindow = new BrowserWindow({
    width:       W,
    height:      H,
    x:           Math.round((width - W) / 2),
    y:           height - H - 32,
    frame:       false,
    transparent: true,
    backgroundColor: '#00000000', // fully transparent — prevents OS-level rectangle backdrop
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    movable:     false,
    focusable:   false,
    hasShadow:   false,
    thickFrame:  false,
    roundedCorners: false,
    show:        false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      preload:          path.join(__dirname, '../../preload/preload.js'),
    },
  });

  _pttHudWindow.setAlwaysOnTop(true, 'screen-saver');
  try { _pttHudWindow.setBackgroundColor('#00000000'); } catch {}

  _pttHudWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  _pttHudWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  _pttHudWindow.loadFile(
    path.join(__dirname, '../../renderer/ptt-hud/ptt-hud.html')
  );

  _pttHudWindow.webContents.once('did-finish-load', () => {
    _pttHudReady = true;
    try { _pttHudWindow.setBackgroundColor('#00000000'); } catch {}
    if (_pttPendingStart) {
      _pttPendingStart = false;
      pttHudSend('ptt:start');
      // The renderer paints the pill; the show happens here.
      try { _pttHudWindow.showInactive(); } catch { _pttHudWindow.show(); }
    }
  });

  _pttHudWindow.on('closed', () => {
    _pttHudWindow = null;
    _pttHudReady  = false;
  });

  if (process.platform === 'darwin') {
    _pttHudWindow.setVisibleOnAllWorkspaces(true);
  }
}

function pttHudSend(channel, payload) {
  if (!_pttHudWindow || _pttHudWindow.isDestroyed()) return;
  if (_pttHudWindow.webContents.isDestroyed()) return;
  if (channel === 'ptt:start') {
    try { _pttHudWindow.showInactive(); } catch { _pttHudWindow.show(); }
  }
  _pttHudWindow.webContents.send(channel, payload);
  if (channel === 'ptt:stop' || channel === 'ptt:cancel') {
    // Renderer fades out, then we hide the OS window so Windows drops the
    // always-on-top surface entirely.
    setTimeout(() => {
      if (_pttHudWindow && !_pttHudWindow.isDestroyed() && _pttHudWindow.isVisible()) {
        _pttHudWindow.hide();
      }
    }, 180);
  }
}

// ─── Type-target capture ─────────────────────────────────────────────────────

async function rememberTypeTargetWindow() {
  clearPendingTypeTargetWindowHandle();
  if (process.platform !== 'win32') return;
  const hwnd = await captureForegroundWindow();
  if (hwnd) setPendingTypeTargetWindowHandle(hwnd);
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

  // ── jarvis:audio — audio arrives from the PTT HUD ────────────────────────
  ipcMain.on('jarvis:audio', async (_e, { audioBase64, mimeType }) => {
    _pttBusy = false;
    if (_pttBusyTimeout) { clearTimeout(_pttBusyTimeout); _pttBusyTimeout = null; }

    if (_pipelineRunning) {
      console.warn('[Jarvis] Pipeline already running — ignoring audio');
      return;
    }
    if (!audioBase64) return;

    // Surface the Jarvis HUD now that work is starting. The HUD subscribes
    // to pipeline events as soon as it gets `jarvis:open-for-pipeline`.
    showHud();
    hudSend('jarvis:open-for-pipeline');

    _pipelineRunning = true;
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      await runPipelineFromAudio(audioBuffer, mimeType, hudSend, waitForConfirm);
    } finally {
      _pipelineRunning = false;
      clearPendingTypeTargetWindowHandle();
    }

    setTimeout(() => { if (!_pipelineRunning) hideHud(); }, 4500);
  });

  // ── jarvis:text — typed command (debug fallback) ─────────────────────────
  ipcMain.on('jarvis:text', async (_e, text) => {
    if (_pipelineRunning) {
      console.warn('[Jarvis] Pipeline already running — ignoring text command');
      return;
    }
    if (!text || typeof text !== 'string' || !text.trim()) return;

    console.log(`[Jarvis] Text command: "${text}"`);
    showHud();
    hudSend('jarvis:open-for-pipeline');

    _pipelineRunning = true;
    try {
      await runPipelineFromText(text.trim(), hudSend, waitForConfirm);
    } finally {
      _pipelineRunning = false;
      clearPendingTypeTargetWindowHandle();
    }

    setTimeout(() => { if (!_pipelineRunning) hideHud(); }, 4500);
  });

  ipcMain.on('jarvis:confirm-reply', (_e, confirmed) => {
    if (_confirmResolve) {
      const resolve = _confirmResolve;
      clearConfirmState();
      resolve(!!confirmed);
    }
  });

  ipcMain.on('jarvis:close', () => {
    hideHud();
  });

  // ── M5.4 — jarvis:pick-result — voice-pickable card from result panel ────
  ipcMain.on('jarvis:pick-result', async (_e, index) => {
    if (_pipelineRunning) return;
    const ord = Number(index);
    if (!ord || ord < 1 || ord > 9) return;
    showHud();
    hudSend('jarvis:open-for-pipeline');
    _pipelineRunning = true;
    try {
      await runPipelineFromText(`number ${ord}`, hudSend, waitForConfirm);
    } finally {
      _pipelineRunning = false;
    }
  });

  // ── M5.3 — jarvis:voice-cancel — partial-STT keyword cancel ──────────────
  ipcMain.on('jarvis:voice-cancel', (_e, partial) => {
    try {
      const { maybeVoiceCancel } = require('./pipeline');
      maybeVoiceCancel(typeof partial === 'string' ? partial : '');
    } catch (err) {
      console.warn('[Jarvis] voice-cancel error:', err.message);
    }
  });

  ipcMain.handle('jarvis:ping', () => ({
    ok: true, version: 1, running: _pipelineRunning, holding: _pttHolding,
  }));
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('will-quit', () => {
  if (uIOhook && _uiohookStarted) {
    try { uIOhook.stop(); } catch {}
    _uiohookStarted = false;
  }
});

module.exports = { init, reregisterHotkey };
