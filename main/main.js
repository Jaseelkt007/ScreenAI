/*
 * ScreenAI Desktop Assistant
 * Created by: Mohammed Jaseel Kunnathodika
 * LinkedIn: https://www.linkedin.com/in/jaseelkt/
 */

'use strict';

/**
 * main.js — Application entry point
 *
 * Boot sequence:
 *   1. Load settings from userData (API key, startup preference).
 *   2. Create a hidden background window (keeps Win32 message pump alive).
 *   3. Register global hotkeys + tray icon.
 *   4. If first run (no API key), open the Settings window automatically.
 *
 * Capture flow (hotkey/tray click):
 *   Capture window  →  user drags region
 *   →  jimp crop
 *   →  Overlay window  →  user types question
 *   →  Gemini API  →  response shown in overlay
 */

require('./config'); // Load .env into process.env early

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  shell,
  nativeImage,
} = require('electron');
const path = require('path');

const { registerHotkeys, reregisterHotkeys, unregisterHotkeys } = require('./hotkey');
const { captureFullScreen, cropImage }        = require('./screenshot');
const { streamLLM }                           = require('./llm');
const settingsStore                           = require('./settings');

const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, '../assets/icons/icon.png')
);

// ─── Window references ─────────────────────────────────────────────────────
let backgroundWindow = null;
let captureWindow    = null;
let overlayWindow    = null;
let settingsWindow   = null;

// In-flight screenshot buffers
let fullScreenBuffer = null;
let croppedBuffer    = null;

// ─── App lifecycle ────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  // Apply startup-at-login preference from settings.
  applyStartupSetting();

  // Hidden background window keeps Win32 hotkey message pump alive.
  createBackgroundWindow();

  // Register hotkeys and tray icon.
  registerHotkeys(onHotkeyTriggered, openSettingsWindow);

  // Show settings on first run (no API key configured yet).
  if (settingsStore.isFirstRun() || !settingsStore.getApiKey()) {
    openSettingsWindow();
  }

  console.log('[App] Screen AI Assistant running. F7 / Ctrl+Shift+Y to capture.');
});

app.on('window-all-closed', (e) => e.preventDefault());

app.isQuitting = false;
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', unregisterHotkeys);

// ─── Startup setting ──────────────────────────────────────────────────────

function applyStartupSetting() {
  const enabled = settingsStore.getSetting('startWithOS', true);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // On Windows, pass the --hidden flag so the app starts silently.
    args: process.platform === 'win32' ? ['--hidden'] : [],
  });
}

// ─── Background window (Win32 message pump keepalive) ─────────────────────

function createBackgroundWindow() {
  backgroundWindow = new BrowserWindow({
    width: 1, height: 1, x: -200, y: -200,
    show: false, frame: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  backgroundWindow.loadURL('about:blank');
  backgroundWindow.on('closed', () => {
    backgroundWindow = null;
    if (!app.isQuitting) createBackgroundWindow();
  });
}

// ─── Hotkey / tray trigger ────────────────────────────────────────────────

async function onHotkeyTriggered() {
  console.log('[App] *** Hotkey fired! ***');

  // If settings are open, don't also open the capture flow.
  if (settingsWindow) { settingsWindow.focus(); return; }

  if (captureWindow || overlayWindow) { closeAll(); return; }

  // Guard: require API key before capture.
  if (!settingsStore.getApiKey()) {
    openSettingsWindow();
    return;
  }

  try {
    await startCaptureFlow();
  } catch (err) {
    console.error('[App] Capture flow error:', err.message);
    dialog.showErrorBox('Screen AI Assistant', err.message);
    closeAll();
  }
}

// ─── Settings window ──────────────────────────────────────────────────────

function openSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }

  settingsWindow = new BrowserWindow({
    width:       440,
    height:      720,
    resizable:   false,
    frame:       true,
    skipTaskbar: false,
    title:       'ScreenAI — Settings',
    icon:        APP_ICON,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));

  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// IPC: renderer requests current settings
ipcMain.handle('settings:get', () => settingsStore.loadSettings());

// IPC: renderer saves settings
ipcMain.handle('settings:save', (_event, partial) => {
  try {
    settingsStore.saveSettings(partial);
    applyStartupSetting();
    // Re-register hotkeys if the custom hotkey changed.
    if ('customHotkey' in partial) reregisterHotkeys();
    console.log('[Settings] Saved:', JSON.stringify(partial));
    return { ok: true };
  } catch (err) {
    console.error('[Settings] Save error:', err.message);
    return { ok: false, error: err.message };
  }
});

// IPC: renderer closes settings window
ipcMain.on('settings:close', () => { if (settingsWindow) settingsWindow.close(); });

// IPC: open URL in system browser
ipcMain.on('open:external', (_e, url) => shell.openExternal(url));


// ─── Phase 1: Capture window ──────────────────────────────────────────────

async function startCaptureFlow() {
  console.log('[App] Capturing full screen...');
  fullScreenBuffer = await captureFullScreen();
  console.log(`[App] Screenshot captured: ${fullScreenBuffer.length} bytes`);
  openCaptureWindow();
}

function openCaptureWindow() {
  const { bounds } = screen.getPrimaryDisplay();

  captureWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  captureWindow.setAlwaysOnTop(true, 'screen-saver');
  captureWindow.loadFile(path.join(__dirname, '../renderer/capture.html'));

  captureWindow.once('ready-to-show', () => {
    console.log('[App] Capture window ready.');
    captureWindow.show();
    captureWindow.focus();

    const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
    const dataUrl     = `data:image/png;base64,${fullScreenBuffer.toString('base64')}`;

    captureWindow.webContents.send('capture:init', {
      dataUrl,
      logicalWidth:  bounds.width,
      logicalHeight: bounds.height,
      scaleFactor,
    });
  });
}

ipcMain.on('capture:region-selected', async (_event, logicalRegion) => {
  if (!captureWindow) return;
  captureWindow.destroy();
  captureWindow = null;

  try {
    const scale = screen.getPrimaryDisplay().scaleFactor;
    croppedBuffer = await cropImage(fullScreenBuffer, {
      x:      logicalRegion.x      * scale,
      y:      logicalRegion.y      * scale,
      width:  logicalRegion.width  * scale,
      height: logicalRegion.height * scale,
    });
    openOverlayWindow(logicalRegion);
  } catch (err) {
    console.error('[App] Crop error:', err.message);
    closeAll();
  }
});

ipcMain.on('capture:cancel', closeAll);

// ─── Phase 2: Overlay window ──────────────────────────────────────────────

function openOverlayWindow(logicalRegion) {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const W = 720, H = 520, GAP = 12;

  let x = logicalRegion.x + logicalRegion.width + GAP;
  let y = logicalRegion.y;
  if (x + W > workAreaSize.width)  x = logicalRegion.x - W - GAP;
  if (x < 0)                       x = GAP;
  if (y + H > workAreaSize.height) y = workAreaSize.height - H - GAP;
  if (y < 0)                       y = GAP;

  overlayWindow = new BrowserWindow({
    x, y, width: W, height: H,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, hasShadow: false,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'floating');
  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    overlayWindow.focus();
    const imageDataUrl = `data:image/png;base64,${croppedBuffer.toString('base64')}`;
    overlayWindow.webContents.send('overlay:init', { imageDataUrl });
  });
}

ipcMain.on('overlay:ask', async (event, { prompt, history }) => {
  if (!croppedBuffer) {
    event.sender.send('overlay:error', { message: 'No screenshot. Try capturing again.' });
    return;
  }
  try {
    await streamLLM(croppedBuffer, prompt, history || [], (chunk) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('overlay:chunk', { chunk });
      }
    });
    if (!event.sender.isDestroyed()) {
      event.sender.send('overlay:done');
    }
  } catch (err) {
    console.error('[App] LLM error:', err.message);
    if (!event.sender.isDestroyed()) {
      event.sender.send('overlay:error', { message: err.message });
    }
  }
});

ipcMain.on('overlay:close', closeAll);

// ─── Cleanup ──────────────────────────────────────────────────────────────

function closeAll() {
  if (captureWindow)  { captureWindow.destroy();  captureWindow  = null; }
  if (overlayWindow)  { overlayWindow.destroy();  overlayWindow  = null; }
  fullScreenBuffer = null;
  croppedBuffer    = null;
}
