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
 *   →  Gemini/OpenAI API  →  response shown in overlay
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  shell,
  nativeImage,
  session,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerHotkeys, reregisterHotkeys, unregisterHotkeys } = require('./hotkey');
const jarvis = require('./jarvis/index');
const { captureFullScreen, cropImage }                          = require('./screenshot');
const { streamLLM }                                             = require('./llm');
const settingsStore                                             = require('./settings');
const {
  patchProcessPath,
  preResolveCodexCmd,
  checkAgentInstallation,
  resolveCodexCommand,
} = require('./agent-runner');

const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, '../assets/icons/icon.png')
);
const VIBE_INSTALL_DOCS_URL = 'https://docs.mistral.ai/mistral-vibe/introduction/install';

// ─── Security helpers ─────────────────────────────────────────────────────

/**
 * lockWindow — apply navigation guards to every BrowserWindow.
 * Prevents renderer-side XSS or prompt-injection from navigating a window
 * to a remote URL or spawning popup windows.
 */
function lockWindow(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Some renderer windows (e.g. Jarvis HUD) play TTS audio without a direct
// user click, so Chromium needs autoplay permission for media playback.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ─── Window references ─────────────────────────────────────────────────────
let backgroundWindow = null;
let captureWindow    = null;
let overlayWindow    = null;
let settingsWindow   = null;

// In-flight screenshot buffers
let fullScreenBuffer = null;
let croppedBuffer    = null;

// Stored full bounds for compact → expanded window transition
let _overlayExpandBounds = null;

// ─── App lifecycle ────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  // Session-level Content-Security-Policy — enforced before any renderer HTML
  // is evaluated, so it cannot be overridden by page-level <meta> tags.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:;",
        ],
      },
    });
  });

  // Patch PATH so child processes (codex, vibe) are discoverable.
  // Must run inside whenReady — execSync before event loop starts can hang on Windows.
  patchProcessPath();
  preResolveCodexCmd();

  applyStartupSetting();
  createBackgroundWindow();

  registerHotkeys(onHotkeyTriggered, openSettingsWindow);

  if (settingsStore.isFirstRun() || !settingsStore.getApiKey()) {
    openSettingsWindow();
  }

  // ── Jarvis pipeline (Phase 1) ─────────────────────────────────────────────
  jarvis.init();

  console.log('[App] Screen AI Assistant running. F7 to capture · Hold Right Alt for Jarvis.');
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
    args: process.platform === 'win32' ? ['--hidden'] : [],
  });
}

// ─── Background window (Win32 message pump keepalive) ─────────────────────

function createBackgroundWindow() {
  backgroundWindow = new BrowserWindow({
    width: 1, height: 1, x: -200, y: -200,
    show: false, frame: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lockWindow(backgroundWindow);
  backgroundWindow.loadURL('about:blank');
  backgroundWindow.on('closed', () => {
    backgroundWindow = null;
    if (!app.isQuitting) createBackgroundWindow();
  });
}

// ─── Screenshot hotkey / tray trigger ────────────────────────────────────

async function onHotkeyTriggered() {
  console.log('[App] *** Screenshot hotkey fired! ***');

  if (settingsWindow) { settingsWindow.focus(); return; }
  if (captureWindow || overlayWindow) { closeAll(); return; }

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
    height:      900,
    resizable:   false,
    frame:       true,
    skipTaskbar: false,
    title:       'ScreenAI — Settings',
    icon:        APP_ICON,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });

  lockWindow(settingsWindow);
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.handle('settings:get', () => settingsStore.loadSettings());

// Keys that must never appear in logs
const SENSITIVE_KEYS = new Set([
  'geminiApiKey', 'openaiApiKey', 'elevenlabsApiKey', 'mistralApiKey',
]);

function redactForLog(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.has(k) ? (v ? '***' : '') : v;
  }
  return out;
}

ipcMain.handle('settings:save', (_event, partial) => {
  try {
    settingsStore.saveSettings(partial);
    applyStartupSetting();
    if ('customHotkey' in partial) {
      reregisterHotkeys();
    }
    if ('jarvisHotkey' in partial && typeof jarvis.reregisterHotkey === 'function') {
      jarvis.reregisterHotkey();
    }
    console.log('[Settings] Saved:', JSON.stringify(redactForLog(partial)));
    return { ok: true };
  } catch (err) {
    console.error('[Settings] Save error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.on('settings:close', () => { if (settingsWindow) settingsWindow.close(); });
ipcMain.on('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    shell.openExternal(url);
  }
});

// ─── Screenshot capture flow ──────────────────────────────────────────────

async function startCaptureFlow() {
  console.log('[App] Capturing full screen…');
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
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });

  lockWindow(captureWindow);
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

// ─── Overlay window ───────────────────────────────────────────────────────

function openOverlayWindow(logicalRegion) {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const GAP = 12;
  const maxW = Math.max(360, workAreaSize.width - GAP * 2);
  const maxH = Math.max(280, workAreaSize.height - GAP * 2);
  // F7 expanded panel: moderate floating size, not the old full Jarvis layout
  const W = Math.min(maxW, Math.max(500, Math.round(workAreaSize.width * 0.38)));
  const H = Math.min(maxH, Math.max(340, Math.round(workAreaSize.height * 0.50)));

  // Centre the expanded panel on screen for a cleaner floating feel
  let fullX = Math.round((workAreaSize.width  - W) / 2);
  let fullY = Math.round((workAreaSize.height - H) / 2);
  if (fullX + W > workAreaSize.width)  fullX = logicalRegion.x - W - GAP;
  if (fullX < 0)                       fullX = GAP;
  if (fullY + H > workAreaSize.height) fullY = workAreaSize.height - H - GAP;
  if (fullY < 0)                       fullY = GAP;

  // Store the full expanded bounds for when user submits the compact input
  _overlayExpandBounds = { x: fullX, y: fullY, width: W, height: H };

  // Start as a compact pill (430×62) centred horizontally
  const PILL_W = 430;
  const PILL_H = 62;
  const x = Math.max(GAP, Math.round((workAreaSize.width  - PILL_W) / 2));
  const y = Math.max(GAP, Math.min(
    workAreaSize.height - PILL_H - GAP,
    Math.round(workAreaSize.height * 0.68)
  ));

  overlayWindow = new BrowserWindow({
    x, y, width: PILL_W, height: PILL_H,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: false,
    backgroundColor: '#00000000',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });

  lockWindow(overlayWindow);
  overlayWindow.setAlwaysOnTop(true, 'floating');
  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    overlayWindow.focus();
  });

  overlayWindow.webContents.once('did-finish-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !croppedBuffer) return;
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

ipcMain.on('overlay:expand', () => {
  if (!overlayWindow || overlayWindow.isDestroyed() || !_overlayExpandBounds) return;
  const { x, y, width, height } = _overlayExpandBounds;
  overlayWindow.setResizable(true);
  overlayWindow.setBounds({ x, y, width, height }, true);
});

// Content-aware resize: renderer sends the desired height after an answer
// streams in.  We keep width and recentre Y within the work area.
ipcMain.on('overlay:resize', (_event, { height }) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { workAreaSize } = screen.getPrimaryDisplay();
  const newH   = Math.min(640, Math.max(280, Math.round(height)));
  const bounds = overlayWindow.getBounds();
  const newY   = Math.max(
    12,
    Math.min(bounds.y, workAreaSize.height - newH - 12),
  );
  overlayWindow.setBounds({ x: bounds.x, y: newY, width: bounds.width, height: newH }, true);
});


// ─── IPC: check agent installation ────────────────────────────────────────

ipcMain.handle('agent:check', async (_event, backend) => {
  patchProcessPath();
  return checkAgentInstallation(backend, { force: true });
});

// ─── IPC: run codex auth ───────────────────────────────────────────────────

ipcMain.handle('agent:auth-codex', async () => {
  const { exec } = require('child_process');
  const resolved = await resolveCodexCommand({ force: true });

  if (!resolved) {
    return { ok: false, error: 'Codex is not installed.' };
  }

  if (process.platform === 'win32') {
    if (resolved.runtime === 'wsl') {
      exec('start "" cmd /k wsl.exe bash -ic "codex login; exec bash -i"', { shell: true });
    } else {
      exec('start "" cmd /k codex login', { shell: true });
    }
  } else if (process.platform === 'darwin') {
    exec('open -a Terminal -e "codex login"');
  } else {
    exec('codex login', (err) => {
      if (err) console.error('[Agent] codex auth error:', err.message);
    });
  }
  return { ok: true };
});

function quoteForShellSingle(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function escapeForAppleScript(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function getVibeUnixInstallScript() {
  return [
    'if command -v curl >/dev/null 2>&1; then',
    '  curl -LsSf https://mistral.ai/vibe/install.sh | bash',
    'elif command -v uv >/dev/null 2>&1; then',
    '  uv tool install mistral-vibe',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  python3 -m pip install --user mistral-vibe',
    'elif command -v pip >/dev/null 2>&1; then',
    '  pip install --user mistral-vibe',
    'else',
    '  printf "%s\\n" "Mistral is not installed through npm."',
    '  printf "%s\\n" "Install Python 3.12+ or uv, then rerun this step."',
    `  printf "%s\\n" "Docs: ${VIBE_INSTALL_DOCS_URL}"`,
    'fi',
  ].join('\n');
}

function getVibeWindowsInstallCommand() {
  const script = [
    '$uv = Get-Command uv -ErrorAction SilentlyContinue',
    'if ($uv) { uv tool install mistral-vibe; exit $LASTEXITCODE }',
    '$py = Get-Command py -ErrorAction SilentlyContinue',
    'if ($py) { py -m pip install --user mistral-vibe; exit $LASTEXITCODE }',
    '$python = Get-Command python -ErrorAction SilentlyContinue',
    'if ($python) { python -m pip install --user mistral-vibe; exit $LASTEXITCODE }',
    '$pip = Get-Command pip -ErrorAction SilentlyContinue',
    'if ($pip) { pip install --user mistral-vibe; exit $LASTEXITCODE }',
    "Write-Host 'Mistral is not installed through npm.' -ForegroundColor Yellow",
    "Write-Host 'Install Python 3.12+ or uv, then rerun this step.' -ForegroundColor Yellow",
    `Write-Host 'Docs: ${VIBE_INSTALL_DOCS_URL}' -ForegroundColor Cyan`,
  ].join('; ');
  return `start "" powershell -NoExit -ExecutionPolicy Bypass -Command "${script}"`;
}

function openMacTerminal(exec, command, onError) {
  const appleScriptCommand = escapeForAppleScript(command);
  exec(
    `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${appleScriptCommand}"'`,
    { shell: true },
    onError,
  );
}

ipcMain.handle('agent:install', async (_event, backend) => {
  const { exec } = require('child_process');
  const name = (backend || 'codex').toLowerCase();
  const logInstallError = (err) => {
    if (err) console.error('[Agent] install error:', err.message);
  };

  if (name === 'vibe') {
    const unixScript = getVibeUnixInstallScript();

    if (process.platform === 'win32') {
      exec(getVibeWindowsInstallCommand(), { shell: true }, logInstallError);
    } else if (process.platform === 'darwin') {
      openMacTerminal(exec, unixScript, (err) => {
        if (err) {
          exec(`/bin/bash -lc ${quoteForShellSingle(unixScript)}`, { shell: true }, logInstallError);
        }
      });
    } else {
      exec(
        `x-terminal-emulator -e /bin/bash -lc ${quoteForShellSingle(`${unixScript}\nexec /bin/bash`)}`,
        { shell: true },
        (err) => {
          if (err) {
            exec(`/bin/bash -lc ${quoteForShellSingle(unixScript)}`, { shell: true }, logInstallError);
          }
        },
      );
    }

    return { ok: true };
  }

  const pkg = '@openai/codex';

  if (process.platform === 'win32') {
    exec(`start "" cmd /k npm install -g ${pkg}`, { shell: true }, logInstallError);
  } else if (process.platform === 'darwin') {
    openMacTerminal(exec, `npm install -g ${pkg}`, (err) => {
      if (err) {
        exec(`/bin/bash -lc ${quoteForShellSingle(`npm install -g ${pkg}`)}`, { shell: true }, logInstallError);
      }
    });
  } else {
    exec(
      `x-terminal-emulator -e /bin/bash -lc ${quoteForShellSingle(`npm install -g ${pkg}\nexec /bin/bash`)}`,
      { shell: true },
      (err) => {
        if (err) {
          exec(`/bin/bash -lc ${quoteForShellSingle(`npm install -g ${pkg}`)}`, { shell: true }, logInstallError);
        }
      },
    );
  }

  return { ok: true };
});

// ─── Screenshot flow cleanup ──────────────────────────────────────────────

function closeAll() {
  if (captureWindow)  { captureWindow.destroy();  captureWindow  = null; }
  if (overlayWindow)  { overlayWindow.destroy();  overlayWindow  = null; }
  fullScreenBuffer = null;
  croppedBuffer    = null;
}
