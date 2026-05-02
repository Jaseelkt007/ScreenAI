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

  sendResize: (height) =>
    ipcRenderer.send('overlay:resize', { height }),

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

  /** main → renderer: disambiguation list (M4.1). Returns unsubscribe fn. */
  onDisambiguate: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:disambiguate', h);
    return () => ipcRenderer.removeListener('jarvis:disambiguate', h);
  },

  /** main → renderer: context badge update (M4.5). Returns unsubscribe fn. */
  onContext: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:context', h);
    return () => ipcRenderer.removeListener('jarvis:context', h);
  },

  /** main → renderer: ack TTS audio (M4.7) — fires in parallel with dispatch. */
  onAudioAck: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:audio-ack', h);
    return () => ipcRenderer.removeListener('jarvis:audio-ack', h);
  },

  /** main → renderer: narration TTS audio (M5.3) — per plan step. */
  onAudioNarration: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:audio-narration', h);
    return () => ipcRenderer.removeListener('jarvis:audio-narration', h);
  },

  /** main → renderer: plan stream (M5.0) — { type: plan|step.start|step.done|step.fail|replan|final, ... } */
  onPlan: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:plan', h);
    return () => ipcRenderer.removeListener('jarvis:plan', h);
  },

  /** main → renderer: result-panel cards (M5.4). */
  onResults: (fn) => {
    const h = (_, p) => fn(p);
    ipcRenderer.on('jarvis:results', h);
    return () => ipcRenderer.removeListener('jarvis:results', h);
  },

  /** Renderer → main: pick the Nth card from the active result panel. */
  pickResult: (index) =>
    ipcRenderer.send('jarvis:pick-result', index),

  /** Renderer → main: voice-cancel keyword from a partial STT (M5.3). */
  voiceCancel: (partial) =>
    ipcRenderer.send('jarvis:voice-cancel', partial),

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

  /**
   * main → renderer: HUD should subscribe to pipeline events and switch into
   * the post-record visual state. Fired once audio has arrived in main from
   * the PTT HUD. Returns unsubscribe fn.
   */
  onOpenForPipeline: (fn) => {
    const h = () => fn();
    ipcRenderer.on('jarvis:open-for-pipeline', h);
    return () => ipcRenderer.removeListener('jarvis:open-for-pipeline', h);
  },
});

// ── PTT HUD (push-to-talk waveform) ──────────────────────────────────────────
// The PTT HUD owns the mic during a Right-Alt hold and pushes the resulting
// audio through `window.jarvis.sendAudio` (already exposed above).

contextBridge.exposeInMainWorld('ptt', {
  onStart: (cb) => ipcRenderer.on('ptt:start', () => cb()),
  onStop:  (cb) => ipcRenderer.on('ptt:stop',  () => cb()),
  onCancel:(cb) => ipcRenderer.on('ptt:cancel',() => cb()),
});
