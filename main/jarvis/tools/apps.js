'use strict';

/**
 * tools/apps.js — Open applications by spoken name.
 *
 * Windows-first. Each whitelist entry defines an exact launch strategy.
 * No arbitrary paths from user input are ever passed to spawn or shell calls.
 *
 * Requires Electron (shell, app) — Tier B module (not testable in plain Node).
 */

const { shell } = require('electron');
const { spawn }  = require('child_process');
const fs         = require('fs');
// APP_NAMES imported for consistency — windows.js uses it for close/focus operations.
// Both modules share the same spoken-name → process-name map.
const { APP_NAMES } = require('./app-names'); // eslint-disable-line no-unused-vars

// ─── Launch strategies ───────────────────────────────────────────────────────

/** Try to spawn an executable. Returns a promise resolving with ok/error. */
function trySpawn(cmd, args = []) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
      child.unref();
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      // Give it 300ms — if no error fired it likely launched successfully
      setTimeout(() => resolve({ ok: true }), 300);
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

/** Try shell.openExternal with a URI scheme. */
async function tryUri(uri) {
  try {
    await shell.openExternal(uri);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Try a known executable path, then fall back to spawn by name. */
async function tryKnownPath(knownPath, fallbackExe, fallbackArgs = []) {
  if (knownPath && fs.existsSync(knownPath)) {
    return trySpawn(knownPath, []);
  }
  // Path not found — try by name in PATH
  return trySpawn(fallbackExe, fallbackArgs);
}

// ─── Whitelist table ─────────────────────────────────────────────────────────

/**
 * Each entry: { aliases: string[], launch: () => Promise<{ok, error?}> }
 * Aliases are lowercased spoken names.
 */
const WHITELIST = [
  {
    aliases: ['chrome', 'google chrome'],
    launch: () => tryKnownPath(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'chrome'
    ),
  },
  {
    aliases: ['firefox', 'mozilla firefox'],
    launch: () => tryKnownPath(
      'C:/Program Files/Mozilla Firefox/firefox.exe',
      'firefox'
    ),
  },
  {
    aliases: ['edge', 'microsoft edge'],
    launch: () => tryKnownPath(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'msedge'
    ),
  },
  {
    aliases: ['notepad'],
    launch: () => trySpawn('notepad.exe', []),
  },
  {
    aliases: ['calculator', 'calc'],
    launch: () => tryUri('calculator:'),
  },
  {
    aliases: ['vscode', 'vs code', 'visual studio code', 'code'],
    launch: async () => {
      // Try URI scheme first, then PATH
      const r = await tryUri('vscode://');
      if (r.ok) return r;
      return trySpawn('code', []);
    },
  },
  {
    aliases: ['word', 'microsoft word'],
    launch: () => trySpawn('winword.exe', []),
  },
  {
    aliases: ['excel', 'microsoft excel'],
    launch: () => trySpawn('excel.exe', []),
  },
  {
    aliases: ['powerpoint', 'microsoft powerpoint'],
    launch: () => trySpawn('powerpnt.exe', []),
  },
  {
    aliases: ['spotify'],
    launch: () => tryUri('spotify:'),
  },
  {
    aliases: ['slack'],
    launch: () => tryUri('slack:'),
  },
  {
    aliases: ['teams', 'microsoft teams'],
    launch: () => tryUri('msteams:'),
  },
  {
    aliases: ['terminal', 'cmd', 'command prompt', 'command line'],
    launch: () => trySpawn('cmd.exe', []),
  },
  {
    aliases: ['powershell'],
    launch: () => trySpawn('powershell.exe', []),
  },
  {
    aliases: ['paint', 'ms paint'],
    launch: () => trySpawn('mspaint.exe', []),
  },
  {
    aliases: ['explorer', 'file explorer', 'files'],
    launch: () => trySpawn('explorer.exe', []),
  },
  {
    aliases: ['obs', 'obs studio'],
    launch: () => tryKnownPath(
      'C:/Program Files/obs-studio/bin/64bit/obs64.exe',
      'obs64.exe'
    ),
  },
  {
    aliases: ['discord'],
    launch: () => tryKnownPath(
      `${process.env.LOCALAPPDATA}/Discord/Update.exe`,
      'Discord.exe',
      ['--processStart', 'Discord.exe']
    ),
  },
  {
    aliases: ['zoom'],
    launch: () => tryUri('zoommtg:'),
  },
  {
    aliases: ['telegram'],
    launch: () => tryKnownPath(
      `${process.env.APPDATA}/Telegram Desktop/Telegram.exe`,
      'Telegram.exe'
    ),
  },
  {
    aliases: ['whatsapp'],
    launch: () => tryUri('whatsapp:'),
  },
  {
    aliases: ['notepad++', 'notepadplusplus'],
    launch: () => tryKnownPath(
      'C:/Program Files/Notepad++/notepad++.exe',
      'notepad++.exe'
    ),
  },
];

// Build lookup map at module load — O(1) lookups at runtime
const LOOKUP = new Map();
for (const entry of WHITELIST) {
  for (const alias of entry.aliases) {
    LOOKUP.set(alias.toLowerCase(), entry);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Open an application by spoken name.
 * @param {string} appName — lowercased spoken name
 * @returns {Promise<ToolResult>}
 */
async function openApp(appName) {
  const key = (appName || '').toLowerCase().trim();
  const entry = LOOKUP.get(key);

  if (!entry) {
    return {
      ok: false,
      error: `I don't know how to open "${appName}" yet.`,
      action: '',
    };
  }

  const result = await entry.launch();

  if (!result.ok) {
    return {
      ok: false,
      error: `Could not open "${appName}": ${result.error}`,
      action: '',
    };
  }

  return {
    ok: true,
    data: { launched: true },
    action: `Opened ${appName}.`,
  };
}

/** Exported for testing: check if an app name is in the whitelist. */
function isKnownApp(appName) {
  return LOOKUP.has((appName || '').toLowerCase().trim());
}

module.exports = { openApp, isKnownApp };
