'use strict';

/**
 * hotkey.js — Global hotkeys + system tray icon.
 *
 * Hotkeys (Windows):   F7,  Ctrl+Shift+Y,  Alt+Shift+Y  (or user's custom hotkey)
 * Hotkeys (macOS):     Shift+Command+Y
 *
 * The tray icon is always available as a guaranteed fallback trigger.
 * It also provides access to Settings and Quit.
 */

const { globalShortcut, Tray, Menu, nativeImage, app } = require('electron');
const path          = require('path');
const settingsStore = require('./settings');

let tray = null;
let _onCapture  = null;
let _onSettings = null;

const PLATFORM_SHORTCUTS = {
  darwin: ['Shift+Command+Y'],
  win32:  ['F7', 'CommandOrControl+Shift+Y', 'Alt+Shift+Y'],
  linux:  ['F7', 'CommandOrControl+Shift+Y'],
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * @param {() => void} onCapture  - Called to start a screen capture.
 * @param {() => void} onSettings - Called to open the settings window.
 */
function registerHotkeys(onCapture, onSettings) {
  _onCapture  = onCapture;
  _onSettings = onSettings;
  _doRegisterShortcuts();
  createTray(onCapture, onSettings);
}

/**
 * Re-register shortcuts only (does not recreate the tray).
 * Call this after the user saves a new custom hotkey.
 */
function reregisterHotkeys() {
  _doRegisterShortcuts();
}

function unregisterHotkeys() {
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
}

// ─── Internal ──────────────────────────────────────────────────────────────

function _doRegisterShortcuts() {
  globalShortcut.unregisterAll();

  const customHotkey   = settingsStore.getSetting('customHotkey', '');
  const platformShortcuts = PLATFORM_SHORTCUTS[process.platform] || PLATFORM_SHORTCUTS.linux;

  let anyOk = false;

  // Try custom hotkey first if set
  if (customHotkey) {
    try {
      const ok = globalShortcut.register(customHotkey, () => {
        console.log(`[Hotkey] Triggered: ${customHotkey}`);
        if (_onCapture) _onCapture();
      });
      if (ok) {
        anyOk = true;
        console.log(`[Hotkey] Registered custom: ${customHotkey}`);
      } else {
        console.warn(`[Hotkey] Could not register custom hotkey: ${customHotkey} — falling back to defaults`);
      }
    } catch (err) {
      console.warn(`[Hotkey] Error registering custom hotkey: ${err.message} — falling back to defaults`);
    }
  }

  // Always register platform defaults as fallback (or primary if no custom)
  if (!anyOk) {
    for (const shortcut of platformShortcuts) {
      try {
        const ok = globalShortcut.register(shortcut, () => {
          console.log(`[Hotkey] Triggered: ${shortcut}`);
          if (_onCapture) _onCapture();
        });
        if (ok) {
          anyOk = true;
          console.log(`[Hotkey] Registered: ${shortcut}`);
        } else {
          console.warn(`[Hotkey] Could not register: ${shortcut}`);
        }
      } catch (err) {
        console.warn(`[Hotkey] Error registering ${shortcut}: ${err.message}`);
      }
    }
  }

  if (!anyOk) console.error('[Hotkey] No shortcuts registered — use the tray icon.');
}

// ─── Tray icon ────────────────────────────────────────────────────────────

const ICON_PATH = path.join(__dirname, '../assets/icons/icon.png');

function createTray(onCapture, onSettings) {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('ScreenAI');

  // Left-click immediately triggers capture.
  tray.on('click', () => {
    console.log('[Tray] Clicked — starting capture');
    onCapture();
  });

  rebuildTrayMenu(onCapture, onSettings);
}

function rebuildTrayMenu(onCapture, onSettings) {
  const startWithOS = settingsStore.getSetting('startWithOS', true);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Capture Screen Region',
      click: onCapture,
    },
    { type: 'separator' },
    {
      label: 'Settings / API Key…',
      click: onSettings,
    },
    {
      label: 'Start with Windows',
      type:  'checkbox',
      checked: startWithOS,
      click: (menuItem) => {
        settingsStore.saveSettings({ startWithOS: menuItem.checked });
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
          args: process.platform === 'win32' ? ['--hidden'] : [],
        });
        console.log(`[Tray] Start with OS: ${menuItem.checked}`);
        rebuildTrayMenu(onCapture, onSettings);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(menu);
}

module.exports = { registerHotkeys, reregisterHotkeys, unregisterHotkeys };
