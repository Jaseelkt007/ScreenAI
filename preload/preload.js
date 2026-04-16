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

  sendExpand: () =>
    ipcRenderer.send('overlay:expand'),

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

  /** Listen for audio playback data (full buffer, legacy) */
  onGuidePlayAudio: (cb) =>
    ipcRenderer.on('guide:play-audio', (_e, data) => cb(data)),

  /** Listen for a streaming TTS audio chunk */
  onGuideTtsChunk: (cb) =>
    ipcRenderer.on('guide:tts-chunk', (_e, data) => cb(data)),

  /** Listen for TTS stream end signal */
  onGuideTtsEnd: (cb) =>
    ipcRenderer.on('guide:tts-end', () => cb()),

  /** Listen for guide errors */
  onGuideError: (cb) =>
    ipcRenderer.on('guide:error', (_e, data) => cb(data)),

  /** Close the guide window */
  sendGuideClose: () =>
    ipcRenderer.send('guide:close'),

  // ── Agent HUD window ──────────────────────────────────────────────────

  /** Receive init data (backend name) when HUD opens */
  onAgentInit: (cb) =>
    ipcRenderer.on('agent:init', (_e, data) => cb(data)),

  /** Receive a normalized agent event */
  onAgentEvent: (cb) =>
    ipcRenderer.on('agent:event', (_e, data) => cb(data)),

  /** Agent run finished */
  onAgentDone: (cb) =>
    ipcRenderer.on('agent:done', () => cb()),

  /** TTS subtitle update */
  onAgentTts: (cb) =>
    ipcRenderer.on('agent:tts', (_e, text) => cb(text)),

  /** Receive TTS audio to play in the agent HUD */
  onAgentPlayAudio: (cb) =>
    ipcRenderer.on('agent:play-audio', (_e, data) => cb(data)),

  /** User pressed Stop */
  sendAgentStop: () =>
    ipcRenderer.send('agent:stop'),

  /** Renderer telemetry for hidden agent HUD issues such as audio playback */
  sendAgentTelemetry: (level, message) =>
    ipcRenderer.send('agent:telemetry', { level, message }),

  /** Check if an agent CLI is installed. Returns Promise<{installed, version, runtime}> */
  agentCheck: (backend) =>
    ipcRenderer.invoke('agent:check', backend),

  /** Launch codex auth (opens browser). Returns Promise<{ok}> */
  agentAuthCodex: () =>
    ipcRenderer.invoke('agent:auth-codex'),

  /** Launch a terminal install flow for the selected backend. */
  agentInstall: (backend) =>
    ipcRenderer.invoke('agent:install', backend),
});

// ── Jarvis HUD ────────────────────────────────────────────────────────────────
// Separate contextBridge entry — does not touch electronAPI above.

contextBridge.exposeInMainWorld('jarvis', {

  /** Send a typed command text to main (M2 mode). */
  sendText: (text) =>
    ipcRenderer.send('jarvis:text', text),

  /** Send recorded audio bytes to main (M3 mode). */
  sendAudio: (data) =>
    ipcRenderer.send('jarvis:audio', data),

  /** Close the HUD window. */
  closeHud: () =>
    ipcRenderer.send('jarvis:close'),

  /**
   * Each onX listener returns an unsubscribe function.
   * MUST be called when the HUD resets to idle to prevent listener accumulation.
   */
  onStatus: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:status', h);
    return () => ipcRenderer.removeListener('jarvis:status', h);
  },

  onConfirm: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:confirm', h);
    return () => ipcRenderer.removeListener('jarvis:confirm', h);
  },

  onDone: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:done', h);
    return () => ipcRenderer.removeListener('jarvis:done', h);
  },

  /** Send confirm (true) or cancel (false) reply to main. */
  replyConfirm: (ok) =>
    ipcRenderer.send('jarvis:confirm-reply', ok),

  /** Health check — resolves with { ok, version, running }. */
  ping: () =>
    ipcRenderer.invoke('jarvis:ping'),

  /** main → renderer: begin MediaRecorder. Returns unsubscribe fn. */
  onStartRecording: (fn) => {
    const h = () => fn();
    ipcRenderer.on('jarvis:start-recording', h);
    return () => ipcRenderer.removeListener('jarvis:start-recording', h);
  },

  /** main → renderer: stop MediaRecorder and send audio. Returns unsubscribe fn. */
  onStopRecording: (fn) => {
    const h = () => fn();
    ipcRenderer.on('jarvis:stop-recording', h);
    return () => ipcRenderer.removeListener('jarvis:stop-recording', h);
  },
});
