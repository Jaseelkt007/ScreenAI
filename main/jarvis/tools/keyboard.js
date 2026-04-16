'use strict';

/**
 * tools/keyboard.js — Keyboard input simulation via PowerShell + WScript.Shell.SendKeys.
 *
 * Windows-first. Zero new npm dependencies — WScript.Shell is available on every Windows system.
 *
 * ── M3.0 WScript.Shell Evaluation Decision ────────────────────────────────────
 * STATUS: PENDING MANUAL EVALUATION
 *
 * Before relying on WScript.Shell for production use, run the following tests
 * on a real Windows session and record the failure rate:
 *
 *   Test 1: typeText("hello world") in Notepad — repeat 5×, count failures
 *   Test 2: pressShortcut("ctrl+c") in VS Code  — repeat 10×, count failures
 *   Test 3: pressKey("enter") in a form field    — repeat 5×, count failures
 *
 * Decision criteria:
 *   - Failure rate > 20% on ANY test → migrate keyboard.js to @nut-tree/nut-js
 *       npm install @nut-tree/nut-js (provides prebuilt Electron-compatible binaries)
 *       Replace typeText / pressKey / pressShortcut with nut-js equivalents.
 *       Dispatcher and classifier stay unchanged — tool interface is identical.
 *   - Failure rate ≤ 5% on ALL tests → keep WScript.Shell, document limitation here.
 *
 * Once evaluated, replace this block with:
 *   DECISION: KEEP WScript.Shell — <failure rates>, <date>
 * or:
 *   DECISION: MIGRATED to @nut-tree/nut-js — <reason>, <date>
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Safety rules:
 *   - pressShortcut uses an EXPLICIT ALLOWLIST only. No heuristic combo parsing.
 *   - Anything outside the allowlist returns { ok: false, error: "Unsupported shortcut." }
 *   - Blocklist (Win+L, Ctrl+Alt+Del, Alt+F4) is enforced by absence from the allowlist.
 *
 * Pure Node.js — no Electron imports.
 */

const { runPS } = require('./ps-runner');
const { consumePendingTypeTargetWindowHandle } = require('../typing-target');

const FOCUS_WIN32_TYPE_DEF = `
if (-not ([System.Management.Automation.PSTypeName]'JarvisKeyboardWin32').Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class JarvisKeyboardWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
}
`;

// ─── Key maps ─────────────────────────────────────────────────────────────────

/**
 * Named shortcut aliases — unambiguous spoken names only.
 * Excluded: "open", "close", "new", "find", "print" — collide with other intent patterns.
 * Values are normalized combo strings passed to pressShortcut / comboToWScript.
 */
const NAMED_SHORTCUTS = {
  'save as':    'ctrl+shift+s',
  'select all': 'ctrl+a',
  'undo':       'ctrl+z',
  'redo':       'ctrl+y',
  'copy':       'ctrl+c',
  'paste':      'ctrl+v',
  'cut':        'ctrl+x',
  'save':       'ctrl+s',
};

/**
 * Spoken key name → WScript.Shell SendKeys code.
 * Used by pressKey().
 */
const KEY_MAP = {
  'enter':     '{ENTER}',
  'return':    '{ENTER}',
  'escape':    '{ESC}',
  'esc':       '{ESC}',
  'delete':    '{DELETE}',
  'del':       '{DELETE}',
  'backspace': '{BS}',
  'space':     ' ',
  'tab':       '{TAB}',
  'home':      '{HOME}',
  'end':       '{END}',
  'page up':   '{PGUP}',
  'page down': '{PGDN}',
  'up':        '{UP}',
  'down':      '{DOWN}',
  'left':      '{LEFT}',
  'right':     '{RIGHT}',
};

/**
 * Normalized combo string → WScript.Shell SendKeys code.
 * This is the explicit allowlist — every supported shortcut is enumerated here.
 * Win+L, Ctrl+Alt+Del, Alt+F4 are blocked by absence from this map.
 */
const COMBO_TO_WSCRIPT = {
  'ctrl+c':       '^c',
  'ctrl+v':       '^v',
  'ctrl+x':       '^x',
  'ctrl+z':       '^z',
  'ctrl+y':       '^y',
  'ctrl+a':       '^a',
  'ctrl+s':       '^s',
  'ctrl+shift+s': '^+s',
  'ctrl+t':       '^t',
  'ctrl+w':       '^w',
  'ctrl+l':       '^l',
  'ctrl+r':       '^r',
  'alt+left':     '%{LEFT}',
  'enter':        '{ENTER}',
  'escape':       '{ESC}',
  'tab':          '{TAB}',
  'backspace':    '{BS}',
  'delete':       '{DELETE}',
  'up':           '{UP}',
  'down':         '{DOWN}',
  'left':         '{LEFT}',
  'right':        '{RIGHT}',
};

// ─── WScript escaping helpers ─────────────────────────────────────────────────

/**
 * Escape text for WScript.Shell.SendKeys.
 * WScript special chars: + ^ % ~ ( ) { }
 *   { → {{   (literal open brace)
 *   } → }}   (literal close brace)
 *   others → {char}  (e.g. + → {+})
 */
function wscriptEscape(text) {
  return text
    .replace(/\{/g, '{{')
    .replace(/\}/g, '}}')
    .replace(/[+^%~()]/g, (ch) => `{${ch}}`);
}

/**
 * Escape single quotes for embedding in a PowerShell single-quoted string.
 * Single quote → doubled single quote ('').
 */
function psSingleQuoteEscape(s) {
  return s.replace(/'/g, "''");
}

function buildFocusRestoreScript(windowHandle) {
  if (!windowHandle) return '';

  const handle = psSingleQuoteEscape(windowHandle);
  return `
${FOCUS_WIN32_TYPE_DEF}
$targetHwndValue = [Int64]::Parse('${handle}')
$targetHwnd = [IntPtr]::new($targetHwndValue)
if ($targetHwnd -eq [IntPtr]::Zero) { Write-Output 'FOCUS_FAILED'; exit 0 }
[JarvisKeyboardWin32]::SetForegroundWindow($targetHwnd) | Out-Null
Start-Sleep -Milliseconds 150
$currentHwnd = [JarvisKeyboardWin32]::GetForegroundWindow()
if ($currentHwnd -ne $targetHwnd) { Write-Output 'FOCUS_FAILED'; exit 0 }
`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Type text into the currently focused application via WScript.Shell.SendKeys.
 *
 * Sanitization:
 *   - Strips all characters outside printable ASCII (0x20–0x7E)
 *   - Enforces 500-character limit
 *   - Escapes WScript and PowerShell special characters
 *
 * @param {string} text — raw text to type
 * @returns {Promise<ToolResult>}
 */
async function typeText(text) {
  if (!text) {
    return { ok: false, error: 'No text provided.', action: '' };
  }

  // Sanitize: printable ASCII only (0x20–0x7E), strip control characters
  const sanitized = (text || '').replace(/[^\x20-\x7E]/g, '');

  if (sanitized.length === 0) {
    return { ok: false, error: 'Text contains no printable characters.', action: '' };
  }

  if (sanitized.length > 500) {
    return { ok: false, error: 'Text too long (max 500 chars).', action: '' };
  }

  // WScript-escape, then PS single-quote-escape
  const escaped = psSingleQuoteEscape(wscriptEscape(sanitized));
  const targetWindowHandle = consumePendingTypeTargetWindowHandle();

  const script = `
${buildFocusRestoreScript(targetWindowHandle)}
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('${escaped}')
Write-Output 'OK'
`;

  const r = await runPS(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${(r.stderr || r.error || '').trim()}`, action: '' };
  }
  if (r.stdout.trim() === 'FOCUS_FAILED') {
    return { ok: false, error: 'Could not restore focus to the previous window before typing.', action: '' };
  }
  const preview = sanitized.length > 40
    ? sanitized.slice(0, 40) + '…'
    : sanitized;
  return { ok: true, data: { typed: sanitized }, action: `Typed: "${preview}"` };
}

/**
 * Press a single named key.
 *
 * @param {string} keyName — spoken key name (e.g. "enter", "escape", "page up")
 * @returns {Promise<ToolResult>}
 */
async function pressKey(keyName) {
  const key = (keyName || '').toLowerCase().trim();
  const code = KEY_MAP[key];

  if (!code) {
    const known = Object.keys(KEY_MAP)
      .filter((k, i, a) => a.indexOf(k) === i) // dedupe
      .join(', ');
    return {
      ok: false,
      error: `Unknown key: "${keyName}". Supported: ${known}.`,
      action: '',
    };
  }

  const script = `
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('${psSingleQuoteEscape(code)}')
Write-Output 'OK'
`;

  const r = await runPS(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${(r.stderr || r.error || '').trim()}`, action: '' };
  }
  return { ok: true, data: { key: keyName, code }, action: `Pressed ${keyName}.` };
}

/**
 * Press a keyboard shortcut from the explicit allowlist.
 *
 * @param {string} combo — normalized combo string (e.g. "ctrl+c", "ctrl+shift+s", "alt+left")
 *                         OR a WScript code directly (e.g. "^c") — both are accepted.
 * @returns {Promise<ToolResult>}
 */
async function pressShortcut(combo) {
  const normalized = (combo || '').toLowerCase().trim();

  // Try normalized combo first (e.g. "ctrl+c")
  let code = COMBO_TO_WSCRIPT[normalized];

  // Also check if a raw WScript code was passed (for internal dispatcher use)
  if (!code && Object.values(COMBO_TO_WSCRIPT).includes(combo)) {
    code = combo;
  }

  if (!code) {
    return {
      ok: false,
      error: `Unsupported shortcut: "${combo}". Say something like "control c", "save", or "undo".`,
      action: '',
    };
  }

  const script = `
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('${psSingleQuoteEscape(code)}')
Write-Output 'OK'
`;

  const r = await runPS(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${(r.stderr || r.error || '').trim()}`, action: '' };
  }
  return { ok: true, data: { combo: normalized, code }, action: `Pressed ${combo}.` };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * comboToWScript — exported for classifier/testing use.
 * Returns the WScript code for a normalized combo, or null if not in allowlist.
 */
function comboToWScript(combo) {
  return COMBO_TO_WSCRIPT[(combo || '').toLowerCase().trim()] || null;
}

module.exports = {
  typeText,
  pressKey,
  pressShortcut,
  comboToWScript,
  // Exported for classifier use (avoid re-defining the same data there)
  NAMED_SHORTCUTS,
  KEY_MAP,
};
