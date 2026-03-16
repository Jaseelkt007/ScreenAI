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
});
