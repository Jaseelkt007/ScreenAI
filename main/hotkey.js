'use strict';

/**
 * hotkey.js — Global hotkeys + system tray icon.
 *
 * Hotkeys (Windows):   F7,  Ctrl+Shift+Y,  Alt+Shift+Y
 * Hotkeys (macOS):     Shift+Command+Y
 *
 * The tray icon is always available as a guaranteed fallback trigger.
 * It also provides access to Settings and Quit.
 */

const { globalShortcut, Tray, Menu, nativeImage, app } = require('electron');
const path          = require('path');
const settingsStore = require('./settings');

let tray = null;

const PLATFORM_SHORTCUTS = {
  darwin: ['Shift+Command+Y'],
  win32:  ['CommandOrControl+Shift+Y', 'Alt+Shift+Y', 'F7'],
  linux:  ['CommandOrControl+Shift+Y', 'F7'],
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * @param {() => void} onCapture  - Called to start a screen capture.
 * @param {() => void} onSettings - Called to open the settings window.
 */
function registerHotkeys(onCapture, onSettings) {
  const shortcuts = PLATFORM_SHORTCUTS[process.platform] || PLATFORM_SHORTCUTS.linux;
  let anyOk = false;

  for (const shortcut of shortcuts) {
    const ok = globalShortcut.register(shortcut, () => {
      console.log(`[Hotkey] Triggered: ${shortcut}`);
      onCapture();
    });
    ok ? (anyOk = true, console.log(`[Hotkey] Registered: ${shortcut}`))
       : console.warn(`[Hotkey] Could not register: ${shortcut}`);
  }

  if (!anyOk) console.error('[Hotkey] No shortcuts registered — use the tray icon.');

  createTray(onCapture, onSettings);
}

function unregisterHotkeys() {
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
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
        // Rebuild menu so the checkmark reflects the new state.
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

module.exports = { registerHotkeys, unregisterHotkeys };
