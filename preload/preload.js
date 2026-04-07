/*
 * ScreenAI Desktop Assistant
 * Created by: Mohammed Jaseel Kunnathodika
 * LinkedIn: https://www.linkedin.com/in/jaseelkt/
 */

'use strict';

/**
 * preload.js — Secure contextBridge IPC surface.
 *
 * Exposes only named channels to the renderer. Raw ipcRenderer is never
 * passed through, preventing arbitrary channel access from renderer code.
 */

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Capture window ────────────────────────────────────────────────────

  onCaptureInit: (cb) =>
    ipcRenderer.on('capture:init', (_e, data) => cb(data)),

  sendRegionSelected: (region) =>
    ipcRenderer.send('capture:region-selected', region),

  sendCaptureCancel: () =>
    ipcRenderer.send('capture:cancel'),

  // ── Overlay window ────────────────────────────────────────────────────

  onOverlayInit: (cb) =>
    ipcRenderer.on('overlay:init', (_e, data) => cb(data)),

  onOverlayChunk: (cb) =>
    ipcRenderer.on('overlay:chunk', (_e, data) => cb(data)),

  onOverlayDone: (cb) =>
    ipcRenderer.on('overlay:done', () => cb()),

  onOverlayError: (cb) =>
    ipcRenderer.on('overlay:error', (_e, data) => cb(data)),

  sendAsk: (prompt, history) =>
    ipcRenderer.send('overlay:ask', { prompt, history }),

  sendClose: () =>
    ipcRenderer.send('overlay:close'),

  // ── Settings window ───────────────────────────────────────────────────

  /** Load current settings. Returns a Promise<settings object>. */
  settingsGet: () =>
    ipcRenderer.invoke('settings:get'),

  /** Save partial settings. Returns Promise<{ok, error?}>. */
  settingsSave: (data) =>
    ipcRenderer.invoke('settings:save', data),

  /** Close the settings window. */
  settingsClose: () =>
    ipcRenderer.send('settings:close'),

  /** Open a URL in the default system browser. */
  openExternal: (url) =>
    ipcRenderer.send('open:external', url),

  // ── Voice HUD window ──────────────────────────────────────────────────

  /** Listen for main → renderer state updates (idle/recording/transcribing/…) */
  onVoiceState: (cb) =>
    ipcRenderer.on('voice:state', (_e, data) => cb(data)),

  /** Listen for "start recording now" command from main */
  onVoiceStartRecording: (cb) =>
    ipcRenderer.on('voice:start-recording', () => cb()),

  /** Listen for "stop recording now" command from main */
  onVoiceStopRecording: (cb) =>
    ipcRenderer.on('voice:stop-recording', () => cb()),

  /** Listen for cancel command from main */
  onVoiceCancel: (cb) =>
    ipcRenderer.on('voice:cancel', () => cb()),

  /** Send recorded audio bytes + MIME type to main */
  sendVoiceAudioReady: (audioBase64, mimeType) =>
    ipcRenderer.send('voice:audio-ready', { audioBase64, mimeType }),

  /** Send error from renderer to main */
  sendVoiceError: (message) =>
    ipcRenderer.send('voice:error', { message }),

  // ── Guide window ──────────────────────────────────────────────────────

  /** Listen for guide initialization data */
  onGuideInit: (cb) =>
    ipcRenderer.on('guide:init', (_e, data) => cb(data)),

  /** Listen for audio playback data */
  onGuidePlayAudio: (cb) =>
    ipcRenderer.on('guide:play-audio', (_e, data) => cb(data)),

  /** Listen for guide errors */
  onGuideError: (cb) =>
    ipcRenderer.on('guide:error', (_e, data) => cb(data)),

  /** Close the guide window */
  sendGuideClose: () =>
    ipcRenderer.send('guide:close'),
});
