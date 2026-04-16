'use strict';

/**
 * tools/app-names.js — Shared spoken-name → process-name mapping.
 *
 * Imported by apps.js (for launch) and windows.js (for close/focus/minimize).
 * Centralised here so both modules stay in sync.
 */

/**
 * Map of lowercase spoken name → { processName, exe }.
 * processName is the value returned by Get-Process -Name on Windows.
 */
const APP_NAMES = {
  'notepad':   { processName: 'notepad',          exe: 'notepad.exe' },
  'chrome':    { processName: 'chrome',            exe: 'chrome.exe' },
  'edge':      { processName: 'msedge',            exe: 'msedge.exe' },
  'firefox':   { processName: 'firefox',           exe: 'firefox.exe' },
  'brave':     { processName: 'brave',             exe: 'brave.exe' },
  'spotify':   { processName: 'Spotify',           exe: 'Spotify.exe' },
  'vscode':    { processName: 'Code',              exe: 'Code.exe' },
  'code':      { processName: 'Code',              exe: 'Code.exe' },
  'word':      { processName: 'WINWORD',           exe: 'WINWORD.EXE' },
  'excel':     { processName: 'EXCEL',             exe: 'EXCEL.EXE' },
  'explorer':  { processName: 'explorer',          exe: 'explorer.exe' },
  'terminal':  { processName: 'WindowsTerminal',   exe: 'wt.exe' },
  'slack':     { processName: 'slack',             exe: 'slack.exe' },
  'teams':     { processName: 'Teams',             exe: 'Teams.exe' },
  'discord':   { processName: 'Discord',           exe: 'Discord.exe' },
  'whatsapp':  { processName: 'WhatsApp',          exe: 'WhatsApp.exe' },
  'zoom':      { processName: 'Zoom',              exe: 'Zoom.exe' },
  'telegram':  { processName: 'Telegram',          exe: 'Telegram.exe' },
  'obs':       { processName: 'obs64',             exe: 'obs64.exe' },
  'paint':     { processName: 'mspaint',           exe: 'mspaint.exe' },
  'notepad++': { processName: 'notepad++',         exe: 'notepad++.exe' },
};

/** Set of known browser process names (lowercase). Used by isBrowserFocused(). */
const BROWSER_PROCESS_NAMES = new Set([
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi',
]);

module.exports = { APP_NAMES, BROWSER_PROCESS_NAMES };
