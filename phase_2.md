# Jarvis Phase 2 — Implementation Plan

**Date:** 2026-04-14 (revised after design review)
**Branch:** build off `security/hardening` (current) or a new `feature/jarvis-phase2` branch
**Scope:** Desktop control and interaction — window management, keyboard input, browser keyboard shortcuts, and classifier hardening
**Constraint:** Do not modify or remove any Phase 1 tool logic. Extend only. All Phase 1 tests must continue to pass at every milestone boundary.

---

## 1. Phase 2 Goals

Phase 1 delivered a working voice-to-action pipeline for basic launch, file, clipboard, and browser open actions. Users are now naturally attempting richer commands:

- "close notepad" → fails (no intent)
- "close the tab" → fails (no intent)
- "type hello world" → fails (no intent)
- "press control c" → fails (no intent)
- "minimize chrome" → fails (no intent)

Phase 2 makes these commands work. The design philosophy stays the same:

- **Tool-first, vision-last.** No screenshot reasoning as a default path.
- **Windows-first.** Mac/Linux support is secondary; note where divergence is needed.
- **Extend, do not redesign.** classifier.js, dispatcher.js, verifier.js, pipeline.js are all additive-only.
- **No Playwright, no autonomous browsing.** Browser control is keyboard-shortcut based — focus the browser, send the keystroke.
- **No multi-step agent loops.** Each command is still single-intent → single-dispatch.

---

## 2. New Intents (13 additions)

Current Phase 1 intents (12): `file.create`, `file.read`, `file.write`, `file.append`, `file.listdir`, `file.mkdir`, `app.open`, `browser.open`, `browser.goto`, `browser.search`, `clipboard.write`, `system.unsupported`

Phase 2 adds:

| Intent | Namespace rationale | Example commands |
|---|---|---|
| `app.close` | Targets a **named process** | "close notepad", "quit spotify", "exit chrome" |
| `app.focus` | Targets a **named process** | "focus notepad", "switch to chrome", "bring up edge" |
| `window.minimize` | Targets the **current window** by default; targets named app window if app name present | "minimize", "minimize window", "minimize chrome" |
| `window.maximize` | Targets the **current window** by default; targets named app window if app name present | "maximize", "maximize window", "maximize edge" |
| `window.switch` | Window-level OS action, no process name | "switch window", "alt tab", "go to last window" |
| `input.type` | | "type hello world", "write this text: hello" |
| `input.key` | | "press enter", "press escape", "press delete" |
| `input.shortcut` | | "press control c", "control shift t", "undo" |
| `browser.newtab` | | "new tab", "open new tab", "create tab" |
| `browser.closetab` | | "close tab", "close this tab", "shut the tab" |
| `browser.back` | | "go back", "browser back", "previous page" |
| `browser.refresh` | | "refresh", "reload page", "refresh tab" |
| `browser.addressbar` | | "focus address bar", "go to URL bar" |

**Namespace rationale:** `app.*` intents target a named process ("close notepad", "focus chrome"). `window.*` intents are window-level OS operations that act on the current active window — they do not require a process name and are conceptually distinct from controlling a specific application. This distinction matters for long-term scaling.

**Total after Phase 2: 25 intents**

---

## 3. New Tool Modules

### `main/jarvis/tools/windows.js`

Owns all window-level operations: close, focus, minimize, maximize, list active windows.

**Implementation strategy (Windows):** PowerShell via `child_process.execFile('powershell.exe', ['-NoProfile', '-Command', ...])` with a 5-second timeout. No native node addons — avoids compilation issues in Electron.

Key functions:

#### `closeApp(name)` — graceful close only

**Closes the app window gracefully, not forcefully.** This is the correct default for "close notepad" — the app gets a chance to prompt for unsaved changes.

Implementation:
1. Find process handle via `Get-Process -Name <proc>`.
2. Call Win32 `PostMessage(hwnd, WM_CLOSE, 0, 0)` via `Add-Type` inline DllImport.
3. Wait up to 3 seconds for the process to exit.
4. Return `{ ok: true }` if process is gone, `{ ok: false, error: "App did not close gracefully." }` if still running.

**Do NOT use `Stop-Process -Force` in Phase 2.** Force kill (SIGKILL equivalent) bypasses save dialogs and can cause data loss. If a future Phase 3 "kill app" or "force close" intent is added, it will map to a separate `app.kill` intent with its own dispatch case and a mandatory confirm gate. This separation is intentional.

#### `focusApp(name)`
Finds `MainWindowHandle` via `Get-Process`, calls Win32 `SetForegroundWindow(hwnd)` via Add-Type inline DllImport.

#### `minimizeWindow(appName?)`
Operates on the **active window by default**; targets a named app window when `appName` is provided. If `appName` is provided, finds the process handle first via `Get-Process`. Otherwise reads the current foreground window via `GetForegroundWindow()`. Calls Win32 `ShowWindow(hwnd, SW_MINIMIZE)` via Add-Type.

#### `maximizeWindow(appName?)`
Same as minimize, with `SW_MAXIMIZE`. Same default-to-active-window behavior applies.

#### `switchWindow()`
Sends Alt+Tab via WScript.Shell (no target name). Acts on OS-level window stack.

#### `listActiveWindows()`
`Get-Process | Where-Object {$_.MainWindowTitle -ne ''}` → returns array of `{name, title, pid}`. Used internally for name resolution.

#### `isBrowserFocused()`
Checks if the currently focused process name is in the known browser list (`chrome`, `msedge`, `firefox`, `brave`, `opera`). Returns `{ focused: boolean, processName: string | null }`. Called by all `browser.*` dispatch cases before sending keyboard shortcuts.

**Fail-safe contract:** If the PowerShell call errors, times out, or returns an ambiguous result, `isBrowserFocused()` must return `{ focused: false, processName: null }`. It must never assume the browser is focused when uncertain. The safe default is always `false` — this means a browser command may fail with a helpful error, which is far preferable to silently sending keystrokes to the wrong application.

**Name resolution:** Reuse the existing app name map from `app-names.js` to translate spoken names ("chrome", "edge", "notepad") to process names ("chrome.exe", "msedge.exe", "notepad.exe").

**Safety guard:** A hardcoded `PROTECTED_PROCESSES` set blocks `closeApp` on critical system processes: `explorer`, `winlogon`, `csrss`, `services`, `svchost`, `lsass`, `system`. Returns `{ ok: false, error: "Cannot close system process." }` without any PowerShell call.

**Mac fallback:** `osascript -e 'quit app "Notepad"'` style AppleScript. Out of scope for Phase 2 implementation but the module should have a platform branch stub that returns `{ ok: false, error: "Not supported on this platform yet." }`.

---

### `main/jarvis/tools/keyboard.js`

Owns all keyboard input simulation.

**Implementation strategy (Windows):** PowerShell `WScript.Shell.SendKeys()` for all key sending. This is zero-dependency and available on every Windows system.

> **Phase 2 scope note:** WScript.Shell.SendKeys() is acceptable for a Windows-first prototype. It is timing-sensitive, focus-sensitive, and layout-sensitive. It can behave inconsistently with some special keys and international keyboard layouts. It is NOT considered a permanent robust solution. Plan to evaluate `@nut-tree/nut-js` or equivalent in Phase 3 if reliability issues arise in testing.

Key functions:

#### `typeText(text)`
- Sanitize: printable ASCII (0x20–0x7E) only. Strip all control characters.
- Enforce length limit: 500 characters max. Return `{ ok: false, error: "Text too long (max 500 chars)." }` if exceeded.
- Send via `$shell.SendKeys("text")`.

#### `pressKey(key)`
Maps a spoken key name to WScript.Shell key code and sends it:

| Spoken | WScript code |
|---|---|
| enter / return | `{ENTER}` |
| escape / esc | `{ESC}` |
| delete | `{DELETE}` |
| backspace | `{BS}` |
| space | ` ` |
| tab | `{TAB}` |
| home | `{HOME}` |
| end | `{END}` |
| page up | `{PGUP}` |
| page down | `{PGDN}` |
| up | `{UP}` |
| down | `{DOWN}` |
| left | `{LEFT}` |
| right | `{RIGHT}` |

Unknown key names return `{ ok: false, error: "Unknown key: <name>" }`.

#### `pressShortcut(combo)`
Uses an **explicit allowlist only.** No heuristic combo parsing. Every supported shortcut is enumerated. Anything outside the list returns `{ ok: false, error: "Unsupported shortcut." }`.

**Allowed shortcuts (Phase 2):**

| WScript code | Spoken triggers |
|---|---|
| `^c` | control c, ctrl c, copy |
| `^v` | control v, ctrl v, paste |
| `^x` | control x, ctrl x, cut |
| `^z` | control z, ctrl z, undo |
| `^y` | control y, ctrl y, redo |
| `^a` | control a, ctrl a, select all |
| `^s` | control s, ctrl s, save |
| `^+s` | control shift s, ctrl shift s, save as |
| `^t` | control t, ctrl t |
| `^w` | control w, ctrl w |
| `^l` | control l, ctrl l |
| `^r` | control r, ctrl r |
| `%{LEFT}` | alt left |
| `{ENTER}` | enter |
| `{ESC}` | escape |
| `{TAB}` | tab |
| `{BS}` | backspace |
| `{DELETE}` | delete |
| `{UP}` | up arrow |
| `{DOWN}` | down arrow |
| `{LEFT}` | left arrow |
| `{RIGHT}` | right arrow |

**Explicitly blocked** (even if requested): `Win+L` (lock screen), `Ctrl+Alt+Del`, `Alt+F4`.

**Mac fallback:** AppleScript `keystroke` / `key code` — out of scope for Phase 2.

---

## 4. Modified Files (Phase 2 additions only)

### `main/jarvis/tools/app-names.js` (new — extracted from apps.js)

Shared process name map used by both `apps.js` and `windows.js`. Prevents duplication of the app name list.

```js
// Maps spoken names → { processName, exe }
const APP_NAMES = {
  'notepad':  { processName: 'notepad',  exe: 'notepad.exe' },
  'chrome':   { processName: 'chrome',   exe: 'chrome.exe' },
  'edge':     { processName: 'msedge',   exe: 'msedge.exe' },
  'firefox':  { processName: 'firefox',  exe: 'firefox.exe' },
  'spotify':  { processName: 'Spotify',  exe: 'Spotify.exe' },
  'vscode':   { processName: 'Code',     exe: 'Code.exe' },
  'code':     { processName: 'Code',     exe: 'Code.exe' },
  'word':     { processName: 'WINWORD',  exe: 'WINWORD.EXE' },
  'excel':    { processName: 'EXCEL',    exe: 'EXCEL.EXE' },
};

const BROWSER_PROCESS_NAMES = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi']);
```

`apps.js` is updated to import from `app-names.js` instead of its internal map. No behavior change.

---

### `main/jarvis/classifier.js`

Add 13 new pattern-table entries. Insert before the `system.unsupported` catch-all.

**Confirmation policy per intent:**

| Intent | `needsConfirm` | Condition |
|---|---|---|
| `app.close` | false | Graceful close; app will prompt if needed |
| `app.focus` | false | Non-destructive |
| `window.minimize` | false | Non-destructive |
| `window.maximize` | false | Non-destructive |
| `window.switch` | false | Non-destructive |
| `input.type` | **length-based** | `text.length >= 80` → confirm; `< 80` → no confirm |
| `input.key` | false | Single keystroke |
| `input.shortcut` | false | Whitelisted combo only |
| `browser.*` | false | Keyboard shortcut, browser must already be focused |

**`input.type` confirmation rationale:** Forcing confirmation on every typing action is too slow for a voice assistant. Short text (under 80 chars) is sent immediately. Long text (≥80 chars) requires confirm because it is more likely to be accidentally triggered and more disruptive to undo. The threshold is configurable via `jarvisInputConfirmMode` setting (see Section 10).

> **Architecture note (Phase 3 candidate):** Reading confirm policy inside the classifier mixes language understanding with behavioral policy. The cleaner long-term design is: classifier extracts `{ intent, params }` only; the pipeline or a dedicated policy layer decides `needsConfirm` based on settings and params. This is acceptable for Phase 2 speed of implementation. Revisit in Phase 3 when policy rules grow more complex.

New extractors to add:
- `extractShortcutCombo(t)` — maps spoken phrase to allowlist key using the table above
- `extractKeyName(t)` — matches spoken key name against the key map
- `extractTypedText(t)` — extracts text after "type", "write", "input", "enter this" keywords

---

### `main/jarvis/dispatcher.js`

Add new dispatch cases for all 13 new intents:

```js
case 'app.close':         return windows.closeApp(p.appName);
case 'app.focus':         return windows.focusApp(p.appName);
case 'window.minimize':   return windows.minimizeWindow(p.appName || null);
case 'window.maximize':   return windows.maximizeWindow(p.appName || null);
case 'window.switch':     return windows.switchWindow();
case 'input.type':        return keyboard.typeText(p.text);
case 'input.key':         return keyboard.pressKey(p.key);
case 'input.shortcut':    return keyboard.pressShortcut(p.combo);
case 'browser.newtab':    return keyboard.pressShortcut('ctrl+t');
case 'browser.closetab':  return keyboard.pressShortcut('ctrl+w');
case 'browser.back':      return keyboard.pressShortcut('alt+left');
case 'browser.refresh':   return keyboard.pressShortcut('ctrl+r');
case 'browser.addressbar':return keyboard.pressShortcut('ctrl+l');
```

**Browser intents have a focus guard.** Before dispatching any `browser.*` intent, the dispatcher calls `windows.isBrowserFocused()`. If `focused === false`, dispatch returns immediately:

```js
{ ok: false, error: 'No browser is focused. Switch to a browser window first.' }
```

This prevents keyboard shortcuts from firing on the wrong application when the user speaks a browser command while a different window is active. It is a hard guard, not advisory.

---

### `main/jarvis/verifier.js`

Add verification cases for new intents:

| Intent | Verification method | How |
|---|---|---|
| `app.close` | `process_gone` | PowerShell `Get-Process -Name <name> -ErrorAction SilentlyContinue` — must return nothing |
| `app.focus` | `focus_assumed` | Non-fatal: check process exists; actual focus state is not verifiable headlessly. Method named honestly. |
| `window.minimize` | `spawn_ok` | PS exit code only; window state query is complex and non-fatal |
| `window.maximize` | `spawn_ok` | Same as minimize |
| `window.switch` | `spawn_ok` | Input sent; verification non-applicable |
| `input.type` | `spawn_ok` | Keystroke delivered if no error |
| `input.key` | `spawn_ok` | Same |
| `input.shortcut` | `spawn_ok` | Same |
| `browser.*` | `spawn_ok` | Keystroke delivered if focus guard passed and no error |

**`focus_assumed` method:** Named to reflect that we verified the process exists and sent the focus request, but cannot confirm the window actually came to the foreground. This is honest — `focus_ok` would imply a stronger guarantee that we cannot make.

`verifier.js` receives `toolResult.extra` (e.g. process name used) from `windows.js` to run `process_gone` check for `app.close`. This is the most meaningful verification in Phase 2.

---

### `main/jarvis/prompts/intent.js`

Update `INTENT_SYSTEM_PROMPT`:
- Add all 13 new intents to the schema section (using updated `window.*` namespace)
- Add 5+ new few-shot examples covering window control, typing, shortcuts
- Update the supported intents list

---

### `main/jarvis/test-node.js`

New Tier A test suites (pure Node, no Electron):
- **Suite 6 — Classifier Phase 2** (~35 tests): all 13 new intents, synonym variants, edge cases, param extraction, ordering collision tests (`close tab` vs `close notepad`, `close` as shortcut vs `app.close`)
- **Suite 7 — Dispatcher Phase 2 stubs** (~10 tests): mock `windows.js` and `keyboard.js`, assert correct function called with correct params
- **Suite 8 — Verifier Phase 2** (~8 tests): `process_gone`, `focus_assumed`, `spawn_ok` for new intents

Target: ~130 total Tier A tests after Phase 2.

---

## 5. Phased Milestones

Phase 2 is split into 4 milestones. Each milestone is independently deployable — the pipeline continues to work for Phase 1 commands at every boundary.

---

### Milestone 2.1 — Window & App Control

**Goal:** "Close notepad", "focus chrome", "minimize edge", "maximize window", "switch window" all work end-to-end.

**Files created:**
- `main/jarvis/tools/app-names.js` (extracted/new)
- `main/jarvis/tools/windows.js`

**Files modified:**
- `main/jarvis/tools/apps.js` — import from `app-names.js`, no behavior change
- `main/jarvis/classifier.js` — add 5 new patterns: `app.close`, `app.focus`, `window.minimize`, `window.maximize`, `window.switch`
- `main/jarvis/dispatcher.js` — add 5 new dispatch cases + browser focus guard skeleton
- `main/jarvis/verifier.js` — add `process_gone` and `focus_assumed` verification
- `main/jarvis/prompts/intent.js` — add 5 new intents + 2 examples
- `main/jarvis/test-node.js` — Suite 6 partial: window control classifier, ~15 tests

**Acceptance criteria:**
- "close notepad" → graceful WM_CLOSE sent; process_gone verified
- "focus chrome" → SetForegroundWindow called; focus_assumed returned
- "minimize edge", "maximize edge" → SW_MINIMIZE/SW_MAXIMIZE called; spawn_ok returned
- "switch window" → Alt+Tab sent via WScript.Shell
- "close explorer" → blocked by PROTECTED_PROCESSES with safe error message
- Graceful close: app receives WM_CLOSE and can prompt for unsaved changes (NOT force killed)
- All Phase 1 Tier A tests still pass (76 tests)
- ~15 new tests pass

---

### Milestone 2.2 — Keyboard & Input Simulation

**Goal:** "Type hello world", "press enter", "press control c" all work end-to-end.

**Files created:**
- `main/jarvis/tools/keyboard.js`

**Files modified:**
- `main/jarvis/classifier.js` — add 3 new patterns: `input.type`, `input.key`, `input.shortcut`
- `main/jarvis/dispatcher.js` — add 3 new dispatch cases
- `main/jarvis/verifier.js` — `spawn_ok` for input intents (already partially exists)
- `main/jarvis/prompts/intent.js` — add 3 new intents + 2 examples
- `main/jarvis/test-node.js` — Suite 6 continued (~15 more tests), Suite 7 stubs (~10 tests)
- `main/settings.js` — add `jarvisInputConfirmMode: 'long_only'` default

**Acceptance criteria:**
- "type hello world" → `keyboard.typeText("hello world")` dispatched, no confirm (< 80 chars)
- "type [text ≥ 80 chars]" → confirm required before sending
- "press enter" → `keyboard.pressKey("enter")` dispatched
- "press control c" → `keyboard.pressShortcut("ctrl+c")` dispatched
- "press Win+L" → rejected with "Unsupported shortcut" (blocklist enforced)
- "save" → maps to `ctrl+s` via named alias
- "redo" → maps to `ctrl+y` via named alias
- Shortcut outside allowlist → returns `{ ok: false, error: "Unsupported shortcut." }`
- Text length > 500 chars → returns `{ ok: false, error: "Text too long (max 500 chars)." }`
- Text sanitized: control characters stripped
- All prior tests still pass

---

### Milestone 2.3 — Browser Keyboard Control

**Goal:** "New tab", "close tab", "go back", "refresh", "focus address bar" all work — but only when a browser is focused.

**Files modified:**
- `main/jarvis/classifier.js` — add 5 new patterns: `browser.newtab`, `browser.closetab`, `browser.back`, `browser.refresh`, `browser.addressbar`
- `main/jarvis/dispatcher.js` — add 5 new dispatch cases; finalize `isBrowserFocused()` guard
- `main/jarvis/prompts/intent.js` — add 5 new intents + 2 examples
- `main/jarvis/test-node.js` — Suite 6 browser section (~10 more tests)

**Acceptance criteria:**
- "open new tab" → `browser.newtab` classified, `keyboard.pressShortcut('ctrl+t')` dispatched (when browser focused)
- "go back" → `browser.back` classified, `keyboard.pressShortcut('alt+left')` dispatched
- "close tab" does NOT match `app.close` pattern
- "close notepad" does NOT match `browser.closetab` pattern
- When no browser is focused → returns `{ ok: false, error: "No browser is focused. Switch to a browser window first." }`
- All prior tests still pass

---

### Milestone 2.4 — Classifier & Coverage Hardening

**Goal:** Improve pattern coverage and synonym handling for all Phase 1 and Phase 2 intents. Better LLM fallback prompt. End-to-end smoke test pass.

**Scope:**
- Audit all 25 patterns for synonym gaps. Common gaps to fix:
  - `app.open`: add "start", "run", "launch"
  - `app.close`: add "exit", "terminate", "shut down" (already has "quit")
  - `app.focus`: add "bring", "show", "foreground"
  - `browser.search`: add "look up", "google", "search for"
  - `file.create`: add "touch", "new note", "blank file"
  - `input.type`: add "enter this", "write out"
- Named shortcut aliases (safe subset — no ambiguous words):

  | Spoken | Shortcut |
  |---|---|
  | undo | ctrl+z |
  | redo | ctrl+y |
  | copy | ctrl+c |
  | paste | ctrl+v |
  | cut | ctrl+x |
  | select all | ctrl+a |
  | save | ctrl+s |
  | save as | ctrl+shift+s |

  **Not included:** "open", "close", "new", "find", "print" — these words collide with `app.open`, `app.close`, `file.create` and other existing patterns. Ambiguous aliases cause misclassification and are excluded entirely.

- Update LLM fallback prompt with new 25-intent schema
- Fix any pattern ordering bugs found during M2.1–M2.3

**Files modified:**
- `main/jarvis/classifier.js` — pattern expansion
- `main/jarvis/prompts/intent.js` — full prompt rewrite with 25-intent schema
- `main/jarvis/test-node.js` — Suite 8 verifier (~8 tests), ~15 synonym edge-case tests

**Acceptance criteria:**
- All ~130 Tier A tests pass
- Manual smoke test: 20 varied voice commands across all intent categories pass end-to-end
- No regression: all Phase 1 commands still classify correctly
- LLM fallback prompt: manual test with 5 edge cases using Gemini

---

## 6. Classifier Patterns — Phase 2

```js
// ── app.close — check before app.open ──
{
  intent: 'app.close',
  pattern: /\b(close|quit|exit|terminate|shut down)\b.{0,40}\b(notepad|chrome|edge|firefox|spotify|vscode|code|explorer|word|excel)\b/i,
  extract: (m, t) => ({ appName: extractAppName(t) }),
},

// ── app.focus ──
{
  intent: 'app.focus',
  pattern: /\b(focus|switch to|bring up|show|foreground|go to)\b.{0,40}\b(notepad|chrome|edge|firefox|spotify|vscode|code|explorer|word|excel)\b/i,
  extract: (m, t) => ({ appName: extractAppName(t) }),
},

// ── window.minimize — before maximize to avoid confusion ──
{
  intent: 'window.minimize',
  pattern: /\b(minimize|minimise|hide window)\b/i,
  extract: (m, t) => ({ appName: extractAppName(t) || null }),
},

// ── window.maximize ──
{
  intent: 'window.maximize',
  pattern: /\b(maximize|maximise|full.?screen|make it bigger|expand window)\b/i,
  extract: (m, t) => ({ appName: extractAppName(t) || null }),
},

// ── window.switch ──
{
  intent: 'window.switch',
  pattern: /\b(switch window|alt.?tab|go to (last|previous|next) window|next window)\b/i,
  extract: () => ({}),
},

// ── browser.newtab — before browser.closetab ──
// Intentionally excludes bare "open tab" — too vague in natural speech and collision-prone.
{
  intent: 'browser.newtab',
  pattern: /\b(new tab|open (a )?new tab|create (a )?tab)\b/i,
  extract: () => ({}),
},

// ── browser.closetab — "close tab" must not match app.close ──
{
  intent: 'browser.closetab',
  pattern: /\b(close (this |the |current )?tab|shut the tab)\b/i,
  extract: () => ({}),
},

// ── browser.back ──
{
  intent: 'browser.back',
  pattern: /\b(go back|browser back|previous page|back button|navigate back)\b/i,
  extract: () => ({}),
},

// ── browser.refresh ──
{
  intent: 'browser.refresh',
  pattern: /\b(refresh|reload|reload page|refresh page|reload tab|refresh tab)\b/i,
  extract: () => ({}),
},

// ── browser.addressbar ──
{
  intent: 'browser.addressbar',
  pattern: /\b(focus address bar|go to (url|address) bar|open address bar|url bar|address bar)\b/i,
  extract: () => ({}),
},

// ── input.shortcut (named aliases — unambiguous only) — before modifier shortcut ──
{
  intent: 'input.shortcut',
  pattern: /\b(undo|redo|copy|paste|cut|select all|save as|save)\b/i,
  extract: (m, t) => ({ combo: extractNamedShortcut(t) }),
},

// ── input.shortcut (modifier combos) ──
{
  intent: 'input.shortcut',
  pattern: /\b(press|hit|use)\b.{0,40}\b(ctrl|control|alt|shift|win|windows)\b/i,
  extract: (m, t) => ({ combo: extractShortcutCombo(t) }),
},

// ── input.key — before input.type ──
{
  intent: 'input.key',
  pattern: /\bpress\b.{0,20}\b(enter|return|escape|esc|delete|backspace|space|tab|home|end|page up|page down|up|down|left|right)\b/i,
  extract: (m, t) => ({ key: extractKeyName(t) }),
},

// ── input.type — catch-all input, near the end ──
{
  intent: 'input.type',
  pattern: /\b(type|write|input|enter this|type this|write this)\b[:\s]+(.+)/i,
  extract: (m, t) => ({ text: extractTypedText(t) }),
  needsConfirm: (params) => params.text && params.text.length >= 80,
},
```

**Pattern ordering in the full table (after Phase 2 insertions):**

1. `file.mkdir`
2. `file.create`
3. `file.append`
4. `file.write` (with ext)
5. `file.write` (alternate)
6. `file.read`
7. `file.listdir`
8. `app.close` ← NEW (before app.open, catches "close")
9. `app.focus` ← NEW
10. `window.minimize` ← NEW
11. `window.maximize` ← NEW
12. `window.switch` ← NEW
13. `app.open`
14. `browser.newtab` ← NEW (before closetab)
15. `browser.closetab` ← NEW
16. `browser.back` ← NEW
17. `browser.refresh` ← NEW
18. `browser.addressbar` ← NEW
19. `browser.goto`
20. `browser.search`
21. `clipboard.write`
22. `input.shortcut` (named — unambiguous only) ← NEW
23. `input.shortcut` (modifier combo) ← NEW
24. `input.key` ← NEW
25. `input.type` ← NEW (catch-all, last before unsupported)

---

## 7. Dependency Analysis

### npm/native dependencies

**Option A (Recommended) — Zero new npm dependencies:**

Use PowerShell scripts (`child_process.execFile`) for all window management and keyboard input. Every Windows system has PowerShell 5+ and WScript.Shell. No native compilation. No `node-gyp`. No prebuilt binaries.

- Window management: PowerShell + Win32 API via `Add-Type` inline P/Invoke
- Keyboard input: `WScript.Shell.SendKeys()` via PowerShell

**Option B — Native node addon:**

`@nut-tree/nut-js` provides cross-platform keyboard/mouse input with prebuilt binaries. More robust than WScript.Shell but requires native module rebuilding when Electron version changes.

**Decision: Use Option A for Phase 2.** PowerShell is zero-risk for distribution. If WScript.Shell fragility causes reliability issues during testing, migrate individual functions to Option B in Phase 3. Do not pre-optimize.

### Electron-runtime requirement

`windows.js` and `keyboard.js` both use `child_process` (Node built-in). They do NOT require Electron context. They are testable in pure Node with mocked `execFile`. This keeps them in **Tier A** for dispatcher stubs and classifier tests. End-to-end dispatch tests (Tier B) require a real Windows environment.

---

## 8. Safety & Risk Analysis

### Risk 1 — `app.close` on wrong process

**Scenario:** User says "close explorer" — file manager crashes, desktop disappears.
**Mitigation:** `PROTECTED_PROCESSES` set blocks `closeApp` on system processes. Returns error without any PowerShell call.

### Risk 2 — Graceful close doesn't work

**Scenario:** `closeApp` sends WM_CLOSE but the app ignores it (some apps do).
**Mitigation:** Wait up to 3 seconds, then return `{ ok: false, error: "App did not close gracefully." }`. Never escalate to force kill automatically. If a user explicitly needs force kill, that will be a separate `app.kill` intent in Phase 3 with a mandatory confirm gate.

### Risk 3 — `input.type` injecting unintended text

**Scenario:** Classifier misclassifies a voice command as `input.type`, injecting keystrokes into a focused app.
**Mitigation:**
- Confirmation required for text ≥ 80 chars.
- Character whitelist: printable ASCII (0x20–0x7E) only. Control characters stripped.
- WScript.Shell does not execute code — it sends keystrokes only. No shell injection risk.

### Risk 4 — `input.shortcut` sending dangerous combos

**Scenario:** User says something that resolves to `Win+L` (lock screen).
**Mitigation:** Explicit blocklist (`Win+L`, `Ctrl+Alt+Del`, `Alt+F4`). Allowlist-only approach: any combo not in the allowed table returns an error, never gets sent.

### Risk 5 — `browser.closetab` collides with `app.close`

**Scenario:** "Close tab" matches `app.close`.
**Mitigation:** `browser.closetab` pattern requires explicit phrasing "close tab" / "close this tab". `app.close` pattern requires an app name match from the known app list. Tested explicitly in Suite 6.

### Risk 6 — Browser shortcuts fire on wrong app

**Scenario:** User says "new tab" while Notepad is focused. Ctrl+T fires in Notepad (does nothing or does something unexpected).
**Mitigation:** `isBrowserFocused()` guard in dispatcher. If no browser is focused, returns a helpful error instead of sending the shortcut. This is a hard guard.

### Risk 7 — WScript.Shell timing/focus sensitivity

**Scenario:** SendKeys fires before the target window gains focus, keystroke lands in wrong place.
**Mitigation:** For window control intents (`app.focus`, `window.switch`), add a short `Start-Sleep -Milliseconds 150` between the focus command and any subsequent keystroke. Accept that WScript.Shell is prototype-quality for Phase 2 and document the limitation clearly. Evaluate `@nut-tree/nut-js` in Phase 3.

### Risk 8 — PowerShell startup latency

**Scenario:** Launching a new PowerShell process per command adds 200–400ms latency.
**Mitigation:** Accept this latency for Phase 2. Window control and keyboard input are not latency-critical. If latency is problematic in Phase 3, evaluate a long-lived PowerShell stdin/stdout process. Out of scope for Phase 2.

---

## 9. Testing Plan

### Tier A — Pure Node (automated, added to test-node.js)

**Suite 6 — Classifier Phase 2 (~35 tests)**
- All 13 new intents with primary utterance
- Synonym variants (3–5 per intent category)
- Param extraction: `appName`, `text`, `key`, `combo`
- Ordering: "close tab" does NOT match `app.close`
- Ordering: "close notepad" does NOT match `browser.closetab`
- Ordering: "save" matches `input.shortcut` named alias, not `file.write`
- Ordering: "undo" does NOT match `app.*` or `file.*`
- Ordering (write collision): "write hello to notes.txt" matches `file.write`, NOT `input.type`
- Ordering (write collision): "write this text hello" matches `input.type`, NOT `file.write`
- Edge cases: missing app name → `system.unsupported`, empty type text → `system.unsupported`
- Named shortcut: "undo" → `ctrl+z`; "copy" → `ctrl+c`
- Excluded alias collision: "open" as shortcut should NOT fire (not in alias table)

**Suite 7 — Dispatcher Phase 2 stubs (~10 tests)**
- Mock `windows.js` and `keyboard.js` with recording stubs
- Assert correct function called with correct params for each of the 13 new intents
- Assert `DispatchError` thrown for missing required params (e.g. `input.type` with no text)
- Assert browser focus guard fires and returns error when `isBrowserFocused()` returns false

**Suite 8 — Verifier Phase 2 (~8 tests)**
- `process_gone`: returns `verified: true` when process not found
- `process_gone`: returns `verified: false` when process still found
- `focus_assumed`: always returns `verified: true` with method `'focus_assumed'`
- `spawn_ok`: already covered in Phase 1 for input intents

### Tier B — Manual Electron (run on a real Windows session)

**Window control smoke test:**
1. Open Notepad — type some text
2. "minimize notepad" → verify minimized
3. "maximize notepad" → verify maximized
4. "close notepad" → verify Notepad prompts to save → verify window closed after dismissal
5. "close explorer" → verify blocked with error message

**Input control smoke test:**
1. Open Notepad
2. "type hello world" → sent immediately (no confirm, <80 chars)
3. "type [text ≥ 80 chars]" → confirm required → verify text appears after confirm
4. "press enter" → verify new line
5. "press control a" → verify all selected
6. "press delete" → verify text deleted
7. "undo" → verify Ctrl+Z fires (text restored)

**Browser control smoke test:**
1. Open Edge/Chrome and put it in focus
2. "open new tab" → verify new tab
3. "go back" → verify navigation
4. "refresh" → verify reload
5. "close tab" → verify tab closed
6. "focus address bar" → verify cursor in address bar
7. Switch to Notepad — say "new tab" → verify error: "No browser is focused"

**End-to-end voice test (all categories):**
- 5 Phase 1 commands (must still work)
- 5 window control commands
- 3 keyboard input commands
- 5 browser control commands

---

## 10. Settings Extension (Phase 2)

One new setting is added in Milestone 2.2:

### `jarvisInputConfirmMode`

Controls when `input.type` requires user confirmation before typing.

| Value | Behavior |
|---|---|
| `"long_only"` (default) | Confirm only for text ≥ 80 characters |
| `"always"` | Always confirm before typing |
| `"never"` | Never confirm (sends immediately regardless of length) |

Added to `main/settings.js` `getDefaults()`:
```js
jarvisInputConfirmMode: 'long_only',
```

The classifier's `needsConfirm` field for `input.type` reads this setting at classification time. This allows the user to tune behavior without a code change if the default feel is wrong.

---

## 11. What Is Explicitly Out of Scope for Phase 2

| Feature | Reason for exclusion |
|---|---|
| `app.kill` (force terminate) | Separate intent needed with mandatory confirm; Phase 3 |
| Screenshot-based verification | Phase 1 constraint continues; adds complexity and latency |
| Playwright/browser automation | Too complex for single-intent model; Phase 3 candidate |
| Mouse click by position/element | Requires vision or accessibility tree |
| Multi-step command chains | Agent loop redesign required; Phase 3 |
| File delete/move/rename | High data-loss risk; needs Phase 3 safety architecture |
| Settings UI for Jarvis controls | Frontend work; Phase 3 |
| On-device/offline STT | Infrastructure change; Phase 3 |
| Mac/Linux full implementation | Windows-first constraint; add stubs only |
| Browser tab switching by number | Requires Playwright or accessibility API |
| Volume/media control | Separate tool category; Phase 3 |
| Wake word ("Hey Jarvis") | Continuous mic raises privacy concerns; Phase 3 |
| Drag and drop | Requires mouse position context |
| `@nut-tree/nut-js` native input | Evaluate in Phase 3 if WScript.Shell proves insufficient |

---

## 12. File Change Summary

```
main/jarvis/
  tools/
    app-names.js        ← NEW — shared app name map (extracted from apps.js)
    windows.js          ← NEW — closeApp (graceful), focusApp, minimizeWindow,
                                 maximizeWindow, switchWindow, isBrowserFocused
    keyboard.js         ← NEW — typeText, pressKey, pressShortcut (allowlist only)
    apps.js             ← MODIFY — import from app-names.js (behavior unchanged)
  classifier.js         ← MODIFY — 13 new pattern entries + 3 new extractors
                                    + length-based needsConfirm for input.type
  dispatcher.js         ← MODIFY — 13 new dispatch cases + browser focus guard
  verifier.js           ← MODIFY — process_gone, focus_assumed cases
  prompts/intent.js     ← MODIFY — updated schema + examples for 25 intents
  test-node.js          ← MODIFY — Suite 6, 7, 8 (~53 new tests → ~130 total)
  settings.js           ← MODIFY — add jarvisInputConfirmMode: 'long_only'

No changes to:
  pipeline.js           — orchestration unchanged
  index.js              — no new IPC channels needed
  main/main.js          — no changes
  preload/preload.js    — no new IPC surface
  renderer/jarvis-hud/  — no HUD changes
```

---

## 13. Milestone Delivery Checklist

### M2.1 — Window & App Control
- [ ] `app-names.js` extracted, `apps.js` updated, behavior regression-free
- [ ] `windows.js` implemented: graceful closeApp (WM_CLOSE, not Stop-Process -Force), focusApp, minimizeWindow, maximizeWindow, switchWindow, isBrowserFocused
- [ ] Protected process list enforced; force kill NOT used
- [ ] Classifier: 5 new patterns (`app.close`, `app.focus`, `window.minimize`, `window.maximize`, `window.switch`)
- [ ] Dispatcher: 5 new cases + browser focus guard skeleton
- [ ] Verifier: `process_gone` and `focus_assumed` (not `focus_ok`) added
- [ ] Prompts: 5 new intents in schema
- [ ] Tests: Suite 6 partial (~15 tests), all passing
- [ ] All 76 Phase 1 tests still passing

### M2.2 — Keyboard & Input Simulation
- [ ] `keyboard.js` implemented: typeText, pressKey, pressShortcut
- [ ] Explicit allowlist only — no heuristic combo parsing
- [ ] Blocklist enforced: Win+L, Ctrl+Alt+Del, Alt+F4 rejected
- [ ] Text length limit and ASCII sanitization enforced
- [ ] `input.type` confirm: none for <80 chars, required for ≥80 chars
- [ ] Named shortcut aliases: undo, redo, copy, paste, cut, select all, save, save as only
- [ ] Classifier: 3 new patterns (`input.type`, `input.key`, `input.shortcut`)
- [ ] Dispatcher: 3 new cases
- [ ] Settings: `jarvisInputConfirmMode: 'long_only'` added
- [ ] Prompts: 3 new intents in schema
- [ ] Tests: Suite 6 continued + Suite 7 stubs (~25 more tests), all passing
- [ ] All prior tests still passing

### M2.3 — Browser Keyboard Control
- [ ] `isBrowserFocused()` finalized in `windows.js`
- [ ] Dispatcher: `isBrowserFocused()` guard active for all `browser.*` intents
- [ ] Classifier: 5 new browser.* patterns, no collision with `app.close`
- [ ] Dispatcher: 5 new cases routing to `keyboard.pressShortcut`
- [ ] "No browser focused" returns helpful error, not a silent wrong-app keystroke
- [ ] Prompts: 5 new intents in schema
- [ ] Tests: Suite 6 browser section + guard tests (~10 tests), all passing
- [ ] All prior tests still passing

### M2.4 — Classifier & Coverage Hardening
- [ ] All 25 patterns audited for synonym gaps
- [ ] Named shortcut alias set finalized (safe subset only — "open", "close", "new", "find", "print" excluded)
- [ ] LLM prompt fully updated with 25-intent schema
- [ ] Suite 8 verifier tests (~8 tests)
- [ ] Synonym edge-case tests (~15 tests)
- [ ] Total Tier A tests: ~130, all passing
- [ ] Manual Tier B smoke test: 20 voice commands pass end-to-end
- [ ] WScript.Shell fragility noted in internal docs; Phase 3 evaluation item logged
- [ ] phase_2.md marked complete

---

*Phase 2 builds on Phase 1 without modifying any Phase 1 logic. Every milestone boundary leaves the pipeline in a working, shippable state.*
