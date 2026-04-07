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
 *
 * Voice Guide flow (F8 / Shift+Cmd+V):
 *   Voice HUD opens  →  user speaks  →  hotkey again to stop
 *   →  ElevenLabs STT  →  full-screen capture
 *   →  LLM structured guide  →  Guide window  →  ElevenLabs TTS
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
const { captureFullScreen, cropImage }                          = require('./screenshot');
const { streamLLM, getVoiceGuide }                             = require('./llm');
const { transcribeAudio }                                       = require('./stt');
const { synthesizeSpeech, streamSpeech }                        = require('./tts');
const settingsStore                                             = require('./settings');

const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, '../assets/icons/icon.png')
);

// ─── Window references ─────────────────────────────────────────────────────
let backgroundWindow = null;
let captureWindow    = null;
let overlayWindow    = null;
let settingsWindow   = null;
let voiceHudWindow   = null;
let guideWindow      = null;

// In-flight screenshot buffers
let fullScreenBuffer = null;
let croppedBuffer    = null;

// ─── Voice session state machine ──────────────────────────────────────────
// States: idle | starting | recording | transcribing | capturing | analyzing | showing_result | speaking | error
let voiceState = 'idle';

// ─── Performance timing ────────────────────────────────────────────────────
// Anchored at the moment the voice hotkey fires so every [PERF] log is
// relative to the same origin. Used by the /latency_report skill.
let _voicePerfOrigin    = 0; // absolute ms timestamp of hotkey press
let _recordingStartedAt = 0; // absolute ms timestamp when MediaRecorder started

// ─── TTS streaming state ───────────────────────────────────────────────────
// Chunks that arrive before the guide window renderer is ready are buffered
// here and flushed once ready-to-show fires.
let _guideAudioReady    = false;
let _guideTtsBuffer     = []; // array of base64 strings
let _guideTtsStreamEnded = false;

function setVoiceState(state, message) {
  voiceState = state;
  console.log(`[Voice] State → ${state}${message ? ': ' + message : ''}`);
  if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
    voiceHudWindow.webContents.send('voice:state', { state, message: message || null });
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  applyStartupSetting();
  createBackgroundWindow();

  registerHotkeys(onHotkeyTriggered, openSettingsWindow, onVoiceHotkeyTriggered);

  if (settingsStore.isFirstRun() || !settingsStore.getApiKey()) {
    openSettingsWindow();
  }

  console.log('[App] Screen AI Assistant running. F7 / Ctrl+Shift+Y to capture. F8 for voice guide.');
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
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

  // Don't start screenshot flow while voice is active
  if (voiceState !== 'idle') {
    console.log('[App] Voice flow active — ignoring screenshot hotkey');
    return;
  }

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

// ─── Voice hotkey trigger ─────────────────────────────────────────────────

async function onVoiceHotkeyTriggered() {
  console.log('[Voice] *** Voice hotkey fired! State:', voiceState);

  if (settingsWindow) { settingsWindow.focus(); return; }

  // Toggle: if currently recording → stop and submit
  if (voiceState === 'recording') {
    console.log('[Voice] Hotkey fired during recording → stopping');
    if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
      voiceHudWindow.webContents.send('voice:stop-recording');
    }
    return;
  }

  // HUD is loading but renderer not ready yet — ignore the press to avoid
  // sending IPC messages into a window that hasn't set up its listeners.
  if (voiceState === 'starting') {
    console.log('[Voice] HUD still loading — ignoring hotkey');
    return;
  }

  // If in any other active state → cancel
  if (voiceState !== 'idle') {
    console.log('[Voice] Cancelling active voice session');
    cancelVoiceSession();
    return;
  }

  // Start new session
  if (!settingsStore.getElevenLabsKey()) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Voice Guide',
      message: 'No ElevenLabs API key configured.\nOpen Settings and enable Voice Guide to add your key.',
    });
    return;
  }

  if (!settingsStore.getApiKey()) {
    openSettingsWindow();
    return;
  }

  // Don't start voice if screenshot flow is active
  if (captureWindow || overlayWindow) {
    console.log('[Voice] Screenshot flow active — ignoring voice hotkey');
    return;
  }

  await startVoiceSession();
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
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.handle('settings:get', () => settingsStore.loadSettings());

ipcMain.handle('settings:save', (_event, partial) => {
  try {
    settingsStore.saveSettings(partial);
    applyStartupSetting();
    if ('customHotkey' in partial || 'voiceHotkey' in partial || 'voiceEnabled' in partial) {
      reregisterHotkeys();
    }
    console.log('[Settings] Saved:', JSON.stringify(partial));
    return { ok: true };
  } catch (err) {
    console.error('[Settings] Save error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.on('settings:close', () => { if (settingsWindow) settingsWindow.close(); });
ipcMain.on('open:external', (_e, url) => shell.openExternal(url));

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

// ─── Overlay window ───────────────────────────────────────────────────────

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

// ─── Voice Guide flow ─────────────────────────────────────────────────────

async function startVoiceSession() {
  _voicePerfOrigin = Date.now();
  console.log('[Voice] Starting voice session');
  console.log(`[PERF] origin ts=${_voicePerfOrigin}`);
  // Use 'starting' until the HUD renderer signals it is ready.
  setVoiceState('starting');

  openVoiceHudWindow();
}


function openVoiceHudWindow() {
  if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
    voiceHudWindow.destroy();
    voiceHudWindow = null;
  }

  const { workAreaSize } = screen.getPrimaryDisplay();
  const W = 220, H = 50;

  voiceHudWindow = new BrowserWindow({
    x:           Math.round((workAreaSize.width - W) / 2),
    y:           workAreaSize.height - H - 40,
    width:       W,
    height:      H,
    transparent: true,
    frame:       false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    movable:     true,
    hasShadow:   false,
    focusable:   false,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  voiceHudWindow.setAlwaysOnTop(true, 'screen-saver');
  voiceHudWindow.loadFile(path.join(__dirname, '../renderer/voice-hud.html'));

  voiceHudWindow.once('ready-to-show', () => {
    voiceHudWindow.show();
    console.log('[Voice] HUD shown');
  });

  // did-finish-load fires after ALL renderer scripts have executed —
  // safe to transition state and send IPC commands now.
  voiceHudWindow.webContents.once('did-finish-load', () => {
    if (voiceState !== 'starting') {
      console.log('[Voice] did-finish-load: state is', voiceState, '— not starting recording');
      return;
    }

    const hudLoadMs = Date.now() - _voicePerfOrigin;
    console.log(`[PERF] hud-load: ${hudLoadMs}ms  (hotkey → HUD JS ready)`);

    _recordingStartedAt = Date.now();
    setVoiceState('recording');
    voiceHudWindow.webContents.send('voice:start-recording');
    console.log('[Voice] Page loaded — start-recording sent');

    // Safety timeout: auto-stop if user forgets to press F8 again
    const maxMs = settingsStore.getSetting('maxVoiceDurationMs', 20000);
    setTimeout(() => {
      if (voiceState === 'recording') {
        console.log('[Voice] Max duration reached — auto-stopping');
        if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
          voiceHudWindow.webContents.send('voice:stop-recording');
        }
      }
    }, maxMs);
  });

  voiceHudWindow.on('closed', () => {
    voiceHudWindow = null;
    // If closed mid-session, reset to idle
    if (voiceState === 'recording') {
      voiceState = 'idle';
    }
  });
}

// Renderer → main: audio ready
ipcMain.on('voice:audio-ready', async (_event, { audioBase64, mimeType }) => {
  if (voiceState !== 'recording') {
    console.warn('[Voice] audio-ready received but state is', voiceState, '— ignoring');
    return;
  }

  const recordingDurationMs = _recordingStartedAt ? Date.now() - _recordingStartedAt : 0;
  console.log(`[Voice] Audio ready: ${audioBase64.length} base64 chars, mime=${mimeType}`);
  console.log(`[PERF] recording-duration: ${recordingDurationMs}ms  (mic open → stop pressed)`);

  try {
    await runVoicePipeline(audioBase64, mimeType);
  } catch (err) {
    console.error('[Voice] Pipeline error:', err.message);
    setVoiceState('error', err.message);
    // Show error in HUD briefly then close
    setTimeout(() => cleanupVoiceSession(), 2500);
    // Also show error in guide window if it's open
    if (guideWindow && !guideWindow.isDestroyed()) {
      guideWindow.webContents.send('guide:error', { message: err.message });
    }
  }
});

// Renderer → main: error from HUD renderer (e.g. mic denied)
ipcMain.on('voice:error', (_event, { message }) => {
  console.error('[Voice] Renderer error:', message);
  setVoiceState('error', message);
  setTimeout(() => cleanupVoiceSession(), 2500);
});

async function runVoicePipeline(audioBase64, mimeType) {
  const t0 = Date.now();

  // ── Steps 1+2: STT + Screen capture in parallel ──────────────────────────
  setVoiceState('transcribing');
  console.log('[Voice] [1+2] STT + screen capture in parallel…');

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  let sttMs = 0, capMs = 0;

  const [sttResult, screenshotBuffer] = await Promise.all([
    (async () => {
      const t = Date.now();
      const result = await transcribeAudio(audioBuffer, mimeType);
      sttMs = Date.now() - t;
      return result;
    })(),
    (async () => {
      const t = Date.now();
      const buffer = await captureFullScreen();
      capMs = Date.now() - t;
      return buffer;
    })(),
  ]);

  const transcript = sttResult.text;
  console.log(`[Voice] Transcript: "${transcript}"`);
  console.log(`[PERF] stt: ${sttMs}ms  (${audioBuffer.length} bytes → ${transcript.length} chars)`);
  console.log(`[PERF] capture: ${capMs}ms  (${screenshotBuffer.length} bytes)`);

  if (!transcript) {
    throw new Error('Empty transcript — no speech detected.');
  }

  // ── Step 3: LLM guide ────────────────────────────────────────────────────
  setVoiceState('analyzing');
  console.log('[Voice] [3/4] Getting voice guide from LLM…');

  const t_llm = Date.now();
  const guide = await getVoiceGuide(screenshotBuffer, transcript);
  const llmMs = Date.now() - t_llm;

  console.log(`[PERF] llm: ${llmMs}ms  (confidence=${guide.overall_confidence}, steps=${guide.steps.length})`);

  // ── Step 4: Open guide window ────────────────────────────────────────────
  setVoiceState('showing_result');
  console.log('[Voice] [4/4] Opening guide window…');

  if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
    voiceHudWindow.destroy();
    voiceHudWindow = null;
  }

  const t_guide = Date.now();
  const screenshotDataUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
  openGuideWindow({ ...guide, screenshotDataUrl });
  const guideMs = Date.now() - t_guide;

  console.log(`[PERF] guide-open: ${guideMs}ms`);

  // ── Step 5: TTS (non-blocking — guide shows regardless) ──────────────────
  console.log('[Voice] Starting TTS for spoken summary…');
  setVoiceState('speaking');

  runTTS(guide.spoken_summary).catch((err) => {
    console.warn('[Voice] TTS failed (non-fatal):', err.message);
    setVoiceState('showing_result');
  });

  const pipelineMs  = Date.now() - t0;
  const hotToGuideMs = _voicePerfOrigin ? Date.now() - _voicePerfOrigin : pipelineMs;

  // ── Summary log (easy to grep for /latency_report) ───────────────────────
  console.log(
    `[PERF] pipeline-summary  stt=${sttMs}ms  capture=${capMs}ms  llm=${llmMs}ms` +
    `  guide-open=${guideMs}ms  subtotal=${pipelineMs}ms  hotkey→guide=${hotToGuideMs}ms`
  );
  console.log(`[Voice] Full pipeline complete in ${pipelineMs}ms`);
}

async function runTTS(text) {
  _guideAudioReady     = false;
  _guideTtsBuffer      = [];
  _guideTtsStreamEnded = false;

  const t_tts = Date.now();
  let firstChunkLoggedMs = null;
  let totalBytes = 0;

  try {
    await streamSpeech(text, (chunk) => {
      totalBytes += chunk.length;

      if (!firstChunkLoggedMs) {
        firstChunkLoggedMs = Date.now() - t_tts;
        console.log(`[PERF] tts-first-chunk: ${firstChunkLoggedMs}ms  (latency to first audio byte)`);
      }

      const chunkBase64 = chunk.toString('base64');

      if (_guideAudioReady && guideWindow && !guideWindow.isDestroyed()) {
        guideWindow.webContents.send('guide:tts-chunk', { chunkBase64 });
      } else {
        _guideTtsBuffer.push(chunkBase64);
      }
    });

    _guideTtsStreamEnded = true;
    const ttsMs      = Date.now() - t_tts;
    const wallClockMs = _voicePerfOrigin ? Date.now() - _voicePerfOrigin : 0;
    console.log(`[PERF] tts: ${ttsMs}ms  (${text.length} chars, ${totalBytes} bytes streamed)`);
    console.log(`[PERF] wall-clock: ${wallClockMs}ms  (hotkey → TTS stream complete)`);

    if (_guideAudioReady && guideWindow && !guideWindow.isDestroyed()) {
      guideWindow.webContents.send('guide:tts-end');
    }
  } catch (err) {
    console.warn('[Voice] TTS stream failed (non-fatal):', err.message);
  }

  setVoiceState('showing_result');
}

function openGuideWindow(data) {
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.destroy();
    guideWindow = null;
  }

  const { workAreaSize } = screen.getPrimaryDisplay();
  const W = 680, H = 460;

  guideWindow = new BrowserWindow({
    x:           Math.round((workAreaSize.width  - W) / 2),
    y:           Math.round((workAreaSize.height - H) / 2),
    width:       W,
    height:      H,
    transparent: true,
    frame:       false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable:   true,
    hasShadow:   true,
    icon:        APP_ICON,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  guideWindow.setAlwaysOnTop(true, 'floating');
  guideWindow.loadFile(path.join(__dirname, '../renderer/guide.html'));

  guideWindow.once('ready-to-show', () => {
    guideWindow.show();
    guideWindow.focus();
    guideWindow.webContents.send('guide:init', data);

    // Flush any TTS chunks that arrived while the window was loading.
    _guideAudioReady = true;
    for (const chunkBase64 of _guideTtsBuffer) {
      guideWindow.webContents.send('guide:tts-chunk', { chunkBase64 });
    }
    _guideTtsBuffer = [];

    if (_guideTtsStreamEnded) {
      guideWindow.webContents.send('guide:tts-end');
    }
  });

  guideWindow.on('closed', () => {
    guideWindow = null;
    if (voiceState !== 'idle') voiceState = 'idle';
    console.log('[Voice] Guide window closed → idle');
  });
}

ipcMain.on('guide:close', () => {
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.destroy();
    guideWindow = null;
  }
  cleanupVoiceSession();
});

// ─── Voice session cleanup ────────────────────────────────────────────────

function cancelVoiceSession() {
  if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
    voiceHudWindow.webContents.send('voice:cancel');
    setTimeout(() => {
      if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
        voiceHudWindow.destroy();
        voiceHudWindow = null;
      }
    }, 200);
  }
  cleanupVoiceSession();
}

function cleanupVoiceSession() {
  voiceState = 'idle';
  if (voiceHudWindow && !voiceHudWindow.isDestroyed()) {
    voiceHudWindow.destroy();
    voiceHudWindow = null;
  }
  console.log('[Voice] Session cleaned up → idle');
}

// ─── Screenshot flow cleanup ──────────────────────────────────────────────

function closeAll() {
  if (captureWindow)  { captureWindow.destroy();  captureWindow  = null; }
  if (overlayWindow)  { overlayWindow.destroy();  overlayWindow  = null; }
  fullScreenBuffer = null;
  croppedBuffer    = null;
}
