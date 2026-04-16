# Jarvis Phase 1 — Implementation Plan

**Date:** 2026-04-13  
**Branch:** build off `security/hardening` or a new `feature/jarvis-pipeline` branch  
**Scope:** Fresh tool-first voice pipeline, completely separate from F7/F8 screenshot flow  
**Constraint:** Do not modify or remove any existing F7/F8 code during Phase 1

---

## 1. Folder and File Structure

```
main/
  jarvis/
    index.js            ← entry point; wired into main.js via one IPC call + hotkey
    pipeline.js         ← async orchestrator: STT → classify → dispatch → verify → TTS → HUD
    classifier.js       ← two-tier intent classifier: pattern match first, LLM fallback
    dispatcher.js       ← maps ClassifierResult to tool call, returns ToolResult
    verifier.js         ← structured post-action checks (no screenshots)
    tools/
      files.js          ← file system operations (create, read, write, append, list, mkdir)
      apps.js           ← open applications by name, Windows-first
      browser.js        ← open browser, go to URL, open search URL
      clipboard.js      ← write text to system clipboard
    prompts/
      intent.js         ← LLM system prompt + JSON schema for intent classification fallback

renderer/
  jarvis-hud/
    jarvis-hud.html     ← minimal HUD window markup
    jarvis-hud.js       ← renderer-side: receive IPC status events, animate state
    jarvis-hud.css      ← styling: thin floating bar, state-driven colors
```

**Do not modify F7/F8 pipeline logic under any circumstances.**  
The following files have restricted access:

| File | Access rule |
|---|---|
| `main/hotkey.js` | **Read-only** — do not touch; Jarvis hotkey is registered separately |
| `main/llm.js`, `main/stt.js`, `main/tts.js` | **Read-only** — import and call, never modify |
| `main/screenshot.js`, `main/agent-runner.js`, `main/narrator.js` | **Read-only** — not used at all in Phase 1 |
| `renderer/voice-hud/`, `renderer/guide/`, `renderer/overlay/` | **Read-only** — F7/F8 UI, untouched |
| `main/main.js` | **Minimal integration only** — add one `require('./jarvis/index').init()` call. No other changes. |
| `preload/preload.js` | **Extend only** — append `jarvis:` channel entries to contextBridge. Do not modify existing entries. |
| `main/settings.js` | **Extend only** — add two new setting keys with defaults. Do not modify existing keys or getters. |

---

## 2. Module Responsibilities

### `main/jarvis/index.js`
- Exports a single `init(mainWindow)` function called once from `main/main.js` at app-ready
- Registers the Jarvis hotkey (F9 / Shift+Command+J) by calling `globalShortcut.register()` directly — does NOT go through `hotkey.js` to avoid triggering `unregisterAll()`
- Creates and manages the Jarvis HUD `BrowserWindow` (hidden on startup, shown on activation)
- Registers two IPC handlers:
  - `ipcMain.on('jarvis:audio', ...)` — receives audio bytes from HUD renderer, kicks off pipeline
  - `ipcMain.handle('jarvis:ping', ...)` — health check used by settings UI
- Owns HUD window lifecycle: show on hotkey, hide on pipeline completion or error

### `main/jarvis/pipeline.js`
- Exports `runPipeline(audioBuffer, mimeType, hudSend)` — the full async execution chain
- `hudSend(event, payload)` is a callback for pushing live status updates to the HUD
- Steps in order:
  1. `hudSend('status', { phase: 'transcribing' })`
  2. Call `stt.transcribeAudio(audioBuffer, mimeType)` — reused as-is
  3. `hudSend('status', { phase: 'classifying', transcript })`
  4. Call `classifier.classify(transcript)` → `ClassifierResult`
  5. If `result.intent === 'system.unsupported'` → skip to error TTS immediately
  6. If `result.needsConfirm` → send `jarvis:confirm` to HUD and **await a one-shot promise** that resolves when `jarvis:confirm-reply` arrives or rejects after 10 seconds. The IPC listener must be registered, awaited, and cleaned up within this single async block — no persistent listeners, no global state. On rejection/cancel → send `jarvis:done { ok: false, display: 'Cancelled.' }` and return.
  7. `hudSend('status', { phase: 'executing', intent: result.intent })`
  8. Call `dispatcher.dispatch(result)` → `ToolResult`
  9. If `toolResult.ok` → call `verifier.verify(result, toolResult)` → `VerifierResult`
  10. Build `spokenText` from `toolResult.action` + verification outcome
  11. Call `tts.synthesizeSpeech(spokenText)` — reused as-is — non-fatal if it fails
  12. `hudSend('done', { ok: true, display, spoken, verifiedBy })`
  13. On any error at any step → `hudSend('done', { ok: false, error: message })`
- Total happy-path call chain is fully sequential and async/await — no callbacks, no shared state

### `main/jarvis/classifier.js`
- Exports `classify(transcript)` → `Promise<ClassifierResult>`
- **Tier 1: Pattern match** — runs a table of compiled RegExp rules against the lowercase transcript. Returns immediately (sub-millisecond) if a rule fires with confidence `'pattern'`
- **Tier 2: LLM fallback** — only invoked if no pattern matched AND `settings.getSetting('jarvisLlmFallback', true)` is enabled AND a Gemini API key is available. If any condition is false, returns `{ intent: 'system.unsupported', reason: 'Command not recognised. Try rephrasing.' }` without any API call.
- If the LLM returns an invalid JSON or unrecognised intent, returns `system.unsupported` — never crashes the pipeline.
- **Classifier responsibility is language-only.** It extracts semantic intent and raw spoken fields (e.g. `name: 'notes.txt'`, `locationHint: 'documents'`). It does NOT resolve file paths to absolute paths. Path resolution is the tool's job.
- **LLM call must be injectable for testing.** The function that makes the Gemini API call is a parameter with a default, not hardwired. In production, the default is used. In Tier A tests, a stub is injected that returns a fixed ClassifierResult. This means classifier.js is testable in pure Node without network calls or Electron context.
- The pattern table is a plain array of `{ pattern: RegExp, intent: string, extract: fn }` objects — easy to extend without touching other modules.

### `main/jarvis/dispatcher.js`
- Exports `dispatch(classifierResult)` → `Promise<ToolResult>`
- A simple switch/map over `classifierResult.intent` values
- Each branch calls the appropriate function from `tools/`
- Handles param validation before calling tools — throws `DispatchError` with a user-readable message if params are missing
- Does not contain any tool logic itself

### `main/jarvis/verifier.js`
- Exports `verify(classifierResult, toolResult)` → `Promise<VerifierResult>`
- Runs a quick structured check based on `classifierResult.intent`
- Returns `{ verified: boolean, method: string, detail?: string }`
- Verification failure is non-fatal — pipeline continues but spoken text notes it

### `main/jarvis/tools/files.js`
- Exports: `createFile`, `readFile`, `writeFile`, `appendFile`, `listDir`, `createDir`
- All paths are resolved and validated before any `fs` call
- **Pure Node.js module.** Uses `os.homedir()` and `path.join()` only — never `app.getPath()`. This is intentional: it keeps `files.js` testable in plain Node without an Electron context. The Jarvis workspace path is computed as `path.join(os.homedir(), 'Documents', 'Jarvis')`.
- **Jarvis workspace directory:** The default write target for Phase 1 is `~/Documents/Jarvis/`. This directory is created on first use if it does not exist. This makes file output predictable, safe, and easy to explain to the user ("Jarvis saves files to your Documents/Jarvis folder").
- **Allowed named locations:** The `resolveJarvisPath(name, locationHint)` helper resolves `locationHint` as follows:
  - `undefined` / `'jarvis'` → `path.join(os.homedir(), 'Documents', 'Jarvis')` (default)
  - `'documents'` → `path.join(os.homedir(), 'Documents')`
  - `'desktop'` → `path.join(os.homedir(), 'Desktop')`
  - `'downloads'` → `path.join(os.homedir(), 'Downloads')`
  - anything else → rejected, treat as `'jarvis'` with a logged warning
- **Path safety rule:** All resolved paths must start with `os.homedir()`. Reject anything outside, including any `..` traversal attempts.
- **No arbitrary absolute paths in Phase 1:** Transcripts like "save to C:/Windows/System32/file.txt" are rejected as unsupported regardless of content.

### `main/jarvis/tools/apps.js`
- Exports: `openApp(appName)` → `Promise<ToolResult>`
- **Windows-first implementation.** Phase 1 targets Windows only. macOS support is a clean abstraction target for Phase 2, not a Phase 1 deliverable.
- Uses a **strict whitelist table** mapping spoken app names to Windows-specific launch strategies. No arbitrary executable paths from transcript.
- Launch strategies per entry (in priority order):
  1. `shell.openExternal('app-protocol:')` for apps that register URI schemes (e.g. `vscode://`)
  2. `shell.openPath(knownExePath)` for apps with fixed executable locations
  3. `spawn('cmd.exe', ['/c', 'start', '', exeName])` as a last resort for apps in PATH
- Phase 1 whitelist (at minimum):

  | Spoken name | Strategy |
  |---|---|
  | chrome | known path: `C:/Program Files/Google/Chrome/Application/chrome.exe` — fail gracefully if not found; do NOT use `shell.openExternal('https://')` as that opens the default browser, not Chrome specifically |
  | firefox | known path `C:/Program Files/Mozilla Firefox/firefox.exe` |
  | notepad | `spawn('notepad.exe', [])` |
  | calculator | `shell.openExternal('calculator:')` (Windows URI scheme) |
  | vscode / code | `shell.openExternal('vscode://')` or `spawn('code', [])` if in PATH |
  | word | `spawn('winword.exe', [])` if Office installed |
  | excel | `spawn('excel.exe', [])` if Office installed |
  | spotify | `shell.openExternal('spotify:')` URI scheme |
  | terminal / cmd | `spawn('cmd.exe', [])` |
  | powershell | `spawn('powershell.exe', [])` |

- If spoken name is not in the whitelist → `ToolResult { ok: false, error: "I don't know how to open that app yet." }`
- **No fallback to `shell.openPath(rawName)` with unvalidated input** — this would be a security hole.

### `main/jarvis/tools/browser.js`
- **This is a URL launch and navigation tool, not a browser automation tool.**
- Phase 1 browser capability is limited to: open browser, navigate to URL, open search URL. It does not click, interact with, or read page content. That is Phase 2.
- Exports: `openBrowser()`, `gotoUrl(url)`, `search(query)`
- All use `shell.openExternal()` — the OS default browser opens the URL. No browser process management, no Playwright, no CDP in Phase 1.
- **`openBrowser()`** opens the system default browser at `https://www.google.com`. This is distinct from `app.open('chrome')` which tries to launch Chrome specifically. The `browser.open` intent means "open a browser" — not "open Chrome".
- `gotoUrl(url)` validates that the URL starts with `http://` or `https://` before calling `shell.openExternal()`.
- `search(query)` percent-encodes the query and opens `https://www.google.com/search?q=...`.

### `main/jarvis/tools/clipboard.js`
- Exports: `writeClipboard(text)` → `Promise<ToolResult>`
- Uses Electron's `clipboard.writeText(text)` — synchronous, no external dependency

### `main/jarvis/prompts/intent.js`
- Exports: `INTENT_SYSTEM_PROMPT` (string) and `SUPPORTED_INTENTS` (array of intent strings)
- The system prompt instructs the LLM to return a single JSON object matching `ClassifierResult`
- Kept as a separate module so the prompt can be revised without touching classifier logic

### `renderer/jarvis-hud/jarvis-hud.js`
- Manages microphone recording (same MediaRecorder approach as voice-hud)
- Listens for `jarvis:status` IPC events and updates the HUD state display
- Sends recorded audio to main via `ipcRenderer.send('jarvis:audio', { audioBase64, mimeType })`
- Handles `jarvis:confirm` events — shows a confirm/cancel prompt in the HUD
- Handles `jarvis:done` events — shows result, plays TTS audio if provided, auto-dismisses after 3s on success

---

## 3. Data Contracts

### 3.1 ClassifierResult

```js
{
  // Which action to perform
  intent: 'file.create'
        | 'file.read'
        | 'file.write'
        | 'file.append'
        | 'file.list'
        | 'file.mkdir'
        | 'app.open'
        | 'browser.open'
        | 'browser.goto'
        | 'browser.search'
        | 'clipboard.write'
        | 'system.unsupported',

  // How the intent was determined
  confidence: 'pattern' | 'llm',

  // Extracted parameters — only the fields relevant to the intent are populated.
  // IMPORTANT: The classifier outputs semantic/linguistic fields only.
  // It does NOT resolve paths to absolute paths. That is the dispatcher/tool's job.
  params: {
    // file ops — raw values as spoken
    name?:         string,   // filename as spoken, e.g. "notes.txt" or "notes"
    locationHint?: string,   // spoken location, e.g. "documents", "desktop", "jarvis"
                             // defaults to "jarvis" (→ ~/Documents/Jarvis/) if absent
    content?:      string,   // text content to write or append
    dirHint?:      string,   // spoken directory name for list/mkdir, e.g. "documents", "projects"

    // app ops
    appName?: string,        // spoken app name, lowercased, e.g. "chrome", "notepad"

    // browser/url-launch ops
    url?:     string,        // URL as spoken — may be bare (youtube.com); tool adds https://
    query?:   string,        // raw search query text

    // clipboard
    text?:    string,        // text to write to clipboard
  },

  // Original transcript, preserved for TTS and logging
  raw: string,

  // If true, pipeline must ask for confirmation before dispatch
  needsConfirm: boolean,

  // Human-readable reason if intent is unsupported or params are incomplete
  reason?: string,
}
```

### 3.2 ToolResult

```js
{
  // Whether the tool operation completed without error
  ok: boolean,

  // Tool-specific result payload — varies by intent
  data?: {
    // file.read
    content?:   string,
    sizeBytes?: number,
    // file.list
    entries?:   Array<{ name: string, type: 'file' | 'dir', sizeBytes: number }>,
    // file.create / write / append / mkdir
    path?:      string,
    sizeBytes?: number,
    // app.open / browser.*
    launched?:  boolean,
    url?:       string,
    // clipboard.write
    written?:   string,
  },

  // Short past-tense sentence describing what was done — used directly in TTS
  // e.g. "Created notes.txt in your Documents folder."
  action: string,

  // If ok=false, human-readable error for TTS and HUD display
  error?: string,
}
```

### 3.3 VerifierResult

```js
{
  // Whether the structured check passed
  verified: boolean,

  // What check was performed — for logging and display
  // e.g. "file_exists", "clipboard_readback", "size_nonzero"
  method: string,

  // Optional additional info
  // e.g. "file is 142 bytes", "clipboard contains 24 chars"
  detail?: string,
}
```

### 3.4 HUD Status Events (main → renderer via webContents.send)

```js
// Phase transitions during pipeline execution
{ event: 'jarvis:status', payload: {
    phase: 'listening' | 'transcribing' | 'classifying' | 'executing' | 'verifying' | 'speaking',
    transcript?: string,    // available from 'classifying' onward
    intent?: string,        // available from 'executing' onward
}}

// Confirmation required before destructive action
{ event: 'jarvis:confirm', payload: {
    message: string,        // "This will overwrite an existing file. Continue?"
    actionLabel: string,    // "Overwrite"
}}

// Pipeline completed (success or failure)
{ event: 'jarvis:done', payload: {
    ok: boolean,
    display: string,        // one-line text shown in HUD
    audioBase64?: string,   // TTS audio if synthesis succeeded
    mimeType?: string,
    verifiedBy?: string,    // e.g. "file exists (142 bytes)"
    error?: string,         // if ok=false
}}
```

### 3.5 IPC Channels Summary

| Channel | Direction | Purpose |
|---|---|---|
| `jarvis:audio` | renderer → main | Audio bytes from MediaRecorder |
| `jarvis:status` | main → renderer | Phase updates during pipeline |
| `jarvis:confirm` | main → renderer | Request user confirmation |
| `jarvis:confirm-reply` | renderer → main | User confirmed or cancelled |
| `jarvis:done` | main → renderer | Pipeline result + TTS audio |
| `jarvis:ping` | renderer → main (invoke) | Health check |

---

## 4. Implementation Order

Implement in this exact order. Each step is independently testable before moving to the next.

### Step 1 — `main/jarvis/tools/files.js`
Start here because it is pure Node.js, has no external dependencies, and is easy to verify manually.  
Implement: `createFile`, `readFile`, `writeFile`, `appendFile`, `listDir`, `createDir`.  
Implement the `resolveJarvisPath(name, locationHint)` helper that converts classifier params into an absolute path using the Jarvis workspace directory policy (see Section 2). Uses `os.homedir()` and `path.join()` — never `app.getPath()`. This is the single point of path resolution for all file tool functions.  
Ensure `~/Documents/Jarvis/` is created on first use if it does not exist (`fs.promises.mkdir(..., { recursive: true })`).  
Add home directory boundary safety check (`resolvedPath.startsWith(os.homedir())`) on all resolved paths.  
**Test (pure Node, no Electron context needed):**
- createFile → file exists in `~/Documents/Jarvis/`
- readFile → content matches what was written
- writeFile → overwrites correctly
- appendFile → size grows
- listDir with `locationHint: 'jarvis'` → lists correct directory
- createDir → new directory confirmed
- Safety: `resolveJarvisPath('../../etc/passwd', null)` → rejected

### Step 2 — `main/jarvis/tools/apps.js`
**Windows-first.** Implement the whitelist table as defined in Section 2.  
Each entry defines the exact launch strategy: URI scheme, known path, or `cmd /c start`.  
Test each entry explicitly — do not assume a strategy works without observing it.  
The module must return a clean `ToolResult { ok: false }` for any name not in the whitelist.  
macOS paths are not stubbed or guessed — the abstraction is clean but platform support is gated.  
**Test:** Trigger `openApp('notepad')`, `openApp('calculator')`, `openApp('vscode')` from main process. Verify each opens. Trigger `openApp('unknownapp')` and assert `ok: false`.

### Step 3 — `main/jarvis/tools/browser.js`
This tool handles URL launch and navigation only — not browser automation.  
Implement `openBrowser()`, `gotoUrl(url)`, `search(query)`.  
`gotoUrl()` normalises bare domains (e.g. `youtube.com` → `https://youtube.com`) before calling `shell.openExternal()`. Rejects non-http schemes.  
`search(query)` percent-encodes the query string and opens `https://www.google.com/search?q=...`.  
**Test:** Call each from main process. Confirm browser opens at correct URL for each. Test rejection of `ftp://` and `file://` schemes.

### Step 4 — `main/jarvis/tools/clipboard.js`
Implement `writeClipboard(text)`.  
Use `require('electron').clipboard.writeText(text)`.  
**Test:** Write a known string, then read back with `clipboard.readText()` and compare.

### Step 5 — `main/jarvis/verifier.js`
Implement the verification switch for each intent type.  
Verification map:

| Intent | Check | Method label |
|---|---|---|
| `file.create` | `fs.existsSync(path)` | `file_exists` |
| `file.read` | `content.length > 0` | `content_nonzero` |
| `file.write` | `fs.statSync(path).size > 0` | `size_nonzero` |
| `file.append` | `fs.statSync(path).size > priorSize` | `size_grew` |
| `file.list` | `entries.length >= 0` (always pass) | `entries_returned` |
| `file.mkdir` | `fs.existsSync(path) && stat.isDirectory()` | `dir_exists` |
| `app.open` | `toolResult.ok === true` (trust spawn result) | `spawn_ok` |
| `browser.*` | `toolResult.ok === true` (trust shell.openExternal) | `open_ok` |
| `clipboard.write` | `clipboard.readText() === text` | `clipboard_readback` |

**Test:** Call verifier directly with mock ToolResult objects, assert VerifierResult shapes.

### Step 6 — `main/jarvis/prompts/intent.js`
Write the `INTENT_SYSTEM_PROMPT` string and the `SUPPORTED_INTENTS` array.  
The prompt must:
- List every supported intent value exactly
- Describe the params schema
- Require the LLM to return ONLY valid JSON matching ClassifierResult
- Include 5–8 few-shot examples covering edge cases
- Instruct the LLM to set `intent: 'system.unsupported'` if no intent fits

**No tests needed here** — verify output as part of classifier testing.

### Step 7 — `main/jarvis/classifier.js`
Build the pattern table first. Test each rule against a list of 20+ sample utterances.  
Then implement the LLM fallback using the Gemini API (same key as existing `settings.getApiKey()`).  
Use `gemini-2.5-flash` (fast, cheap) with `responseMimeType: 'application/json'`.  
**Test table:** Run `classify()` against the Phase 1 command set (Section 9 below) and log results.  
Target: 100% of the Phase 1 command set resolved by pattern alone, without hitting the LLM.

### Step 8 — `main/jarvis/dispatcher.js`
Implement the intent-to-tool routing switch.  
Add param validation at the top of each case before calling the tool.  
**Test:** Call `dispatch()` with manually constructed ClassifierResult objects for each intent.

### Step 9 — `main/jarvis/pipeline.js`
Wire steps 1–8 together in the `runPipeline()` function.  
Import `stt` and `tts` from `../stt` and `../tts` respectively (existing modules, no changes).  
Add timing logs at each step for latency measurement during testing.  
**Test:** Run the pipeline in a test script with a pre-recorded audio file, check console output.

### Step 10 — `renderer/jarvis-hud/`
Build the three HUD files.  
The HUD is intentionally minimal: a 360×120px frameless window, always-on-top, bottom-right of screen. 360×120 gives enough vertical room for a status line, a transcript preview line, and a confirm/error message — without being cramped.  
State machine: `idle → listening → transcribing → classifying → executing → done/error`  
Each state has a color and a label (see Section 9 of HUD design).  
Audio recording reuses the same `MediaRecorder` approach from `voice-hud.js` — copy and adapt, do not import.

### Step 11 — `main/jarvis/index.js`
Create and manage the HUD window.  
Register the Jarvis hotkey via `globalShortcut.register()` directly — not through `hotkey.js`.  
Wire `ipcMain` handlers for `jarvis:audio` and `jarvis:confirm-reply`.  
Bridge pipeline status events to the HUD via `hudWindow.webContents.send()`.  
Export `init(mainWindow)` for `main.js` to call.

### Step 12 — Wire into `main/main.js`
Make minimal integration changes to `main/main.js` to initialize Jarvis. Do not refactor or restructure any existing startup logic.  
Add the Jarvis init call in the `app.whenReady()` block — typically one import and one function call, possibly with a guard:
```js
const jarvis = require('./jarvis/index');
// ...inside whenReady or after mainWindow is created:
jarvis.init(mainWindow);
```
Add `jarvis:` channel entries to the contextBridge in `preload/preload.js`.  
Add the Jarvis HUD window path to Electron's security content policy if applicable.

### Step 13 — Smoke test end-to-end
Run the app, press F9, speak "Create a file called test.txt", confirm file appears in Documents.  
Run through each category in the Phase 1 command set (Section 9).  
Measure and log latency for each step using the timing logs added in Step 9.

---

## 5. Reuse, Wrap, or Ignore

| Existing module | Decision | Notes |
|---|---|---|
| `main/stt.js` | **Reuse as-is** | Call `transcribeAudio()` directly from `pipeline.js`. No changes needed. |
| `main/tts.js` | **Reuse as-is** | Call `synthesizeSpeech()` from `pipeline.js`. TTS failure is non-fatal — pipeline completes without audio. |
| `main/settings.js` | **Extend only** | Read API keys via `getApiKey()`, `getElevenLabsKey()`. Add three new setting keys (`jarvisEnabled`, `jarvisHotkey`, `jarvisLlmFallback`) with defaults. Do not modify any existing keys or getters. |
| `main/llm.js` | **Ignore** | `streamLLM()` and `getVoiceGuide()` are screenshot-coupled. The LLM call for intent classification is implemented inline in `classifier.js` using `node-fetch` directly. |
| `main/hotkey.js` | **Do not modify** | Register the Jarvis hotkey separately via `globalShortcut.register()` in `jarvis/index.js`. Reason: `hotkey.js._doRegisterShortcuts()` calls `globalShortcut.unregisterAll()` at the top, which would wipe the Jarvis hotkey on re-registration. This is a known design flaw in the existing code — do not propagate it. |
| `main/screenshot.js` | **Ignore** | Not used in Phase 1 pipeline. |
| `main/agent-runner.js` | **Ignore** | Not in the Phase 1 path. Leave untouched. |
| `main/narrator.js` | **Ignore** | Not in the Phase 1 path. |
| `renderer/voice-hud/` | **Ignore** | Jarvis HUD is a separate window. Copy the MediaRecorder setup pattern if convenient, but do not share code or IPC channels. |
| `renderer/guide/` | **Ignore** | Not used by Jarvis. |
| `renderer/overlay/` | **Ignore** | Not used by Jarvis. |
| `preload/preload.js` | **Extend only** | Add `jarvis:` channel entries to the contextBridge. Do not modify existing channels. |

---

## 6. Intent Classification Strategy

### Tier 1: Pattern Match (target: handles 95%+ of Phase 1 commands)

Pattern rules are evaluated in order. First match wins. Rules are compiled once at module load.

```
Pattern table (pseudocode — exact RegExp in classifier.js):

[file.create]
  /\b(create|make|new)\b.{0,30}\b(file|document|doc|txt|text file)\b/i
  captures: name from "called X", "named X", "called X.txt"

[file.mkdir]
  /\b(create|make|new)\b.{0,20}\b(folder|directory|dir)\b/i
  captures: name from "called X", "named X"

[file.read]
  /\b(read|open|show|display|print)\b.{0,30}\b(file|document|content|text)\b/i
  OR /\bwhat('s| is)\b.{0,30}\bin\b.{0,30}\.(txt|md|json|log)\b/i
  captures: filename

[file.write]
  /\b(write|save|put|set)\b.{0,40}\b(to|into|in)\b.{0,40}\.(txt|md|json|log)\b/i
  captures: content, filename

[file.append]
  /\b(append|add|attach)\b.{0,40}\b(to|into)\b/i
  captures: content, filename

[file.list]
  /\b(list|show|display|what'?s?\s+in)\b.{0,40}\b(folder|directory|documents|desktop)\b/i
  captures: directory path or name

[app.open]
  /\b(open|launch|start|run)\b.{0,20}\b(chrome|firefox|edge|safari|notepad|calculator|vscode|code|word|excel|powerpoint|spotify|slack|teams|terminal|cmd|powershell)\b/i
  captures: appName

[browser.open]
  /\b(open|launch)\b.{0,20}\b(browser|web browser|internet)\b/i

[browser.goto]
  /(https?:\/\/|www\.)\S+/i  — URL detected in transcript
  OR /\b(go to|navigate to|open|visit)\b.{0,20}\b\w+\.\w{2,4}\b/i
  captures: URL (normalize: add https:// if missing)

[browser.search]
  /\b(search|google|look up|find|look for|search for)\b.{0,80}/i
  captures: query = everything after the trigger word

[clipboard.write]
  /\b(copy|clipboard|copy to clipboard)\b.{0,5}[:,.]\s*(.+)/i
  OR /\bput\b.{0,20}\bclipboard\b.{0,5}[:,.]\s*(.+)/i
  captures: text = content after the delimiter
```

Parameter extraction functions parse the transcript with secondary RegExp after intent is identified. Filenames are extracted from patterns like "called X", "named X", "called X.txt". Content is extracted as everything after "write", "append", "copy", etc.

### Tier 2: LLM Fallback (optional)

Called only when: (a) no pattern fires, AND (b) `jarvisLlmFallback` setting is `true`, AND (c) a Gemini API key is present.

If any condition fails, return `system.unsupported` immediately — no API call, no crash.

When active:
- Model: `gemini-2.5-flash` (same API key as existing flow)
- Temperature: `0.1` — deterministic, not creative
- Max tokens: `256` — the response is a small JSON object
- Timeout: `4000ms` — if it exceeds this, return `system.unsupported`
- Prompt: loaded from `prompts/intent.js` — few-shot examples + schema

**Pattern-only mode** is the safe baseline. The system must work fully without any LLM call for every command in the Phase 1 command set. The LLM fallback exists only for unanticipated phrasings of otherwise supported intents.

The LLM fallback should be rare. If it fires for any command in the Phase 1 command set during testing, add a pattern rule immediately — do not rely on the LLM for known commands.

---

## 7. Safety Model

### Action tiers

| Tier | Actions | Policy |
|---|---|---|
| **Safe — auto-execute** | file.create (new file only), file.read, file.list, file.mkdir, app.open, browser.*, clipboard.write | Execute immediately with no confirmation |
| **Caution — confirm first** | file.write (if file already exists and has content), file.append (always confirm if content > 200 chars) | Show confirm prompt in HUD before dispatching |
| **Blocked — Phase 1 scope** | file.delete, file.move, file.rename, shell commands, anything outside supported intents | Return `system.unsupported` with a clear spoken explanation |

### Confirmation UX
When `needsConfirm: true` is set in ClassifierResult:
1. HUD shows: "This will overwrite existing content in `notes.txt`. Press Enter to confirm or Escape to cancel."
2. The pipeline awaits a one-shot `jarvis:confirm-reply` IPC event — implemented as a promise with a 10-second timeout and immediate listener cleanup on resolve/reject.
3. If confirmed (Enter / confirm button) → proceed to dispatch
4. If cancelled (Escape / cancel button) or timed out → `jarvis:done` with `ok: false, display: 'Cancelled.'`

**Phase 1 confirmation is keyboard/UI only.** There is no second voice turn. Do not implement or suggest voice-based confirmation in Phase 1.

### Input safety rules (enforced in dispatcher/tools, not in classifier)
- All file paths are resolved to absolute paths before any `fs` call
- Resolved path must be within `app.getPath('home')` — reject anything outside
- File content is written as-is (no shell interpolation anywhere)
- `shell.openExternal()` only receives `http://` or `https://` URLs — reject all other schemes
- App names are looked up in a whitelist table — no arbitrary executable paths accepted from transcript

---

## 8. Verification Strategy (No Screenshots)

Verification is a best-effort structured check run after every successful tool call. It is non-fatal: if verification fails, the pipeline still reports success but the spoken text notes uncertainty.

### Per-intent verification

```
file.create  →  fs.existsSync(path)
                → detail: "file is X bytes"
                → spoken if verified: "Created. Confirmed it exists."
                → spoken if not: "Created, but I couldn't confirm it."

file.read    →  content.length > 0
                → detail: "X chars read"

file.write   →  fs.statSync(path).size > 0
                → detail: "file is X bytes"

file.append  →  currentSize > priorSize (capture stat before tool call)
                → detail: "file grew from X to Y bytes"

file.list    →  entries.length >= 0 (always passes — just count entries)
                → detail: "X items found"

file.mkdir   →  fs.existsSync(path) && fs.statSync(path).isDirectory()
                → detail: "directory confirmed"

app.open     →  toolResult.ok (trusts shell.openPath result code)
                → method: "spawn_ok"

browser.*    →  toolResult.ok (trusts shell.openExternal resolved promise)
                → method: "open_ok"

clipboard.write → clipboard.readText() === writtenText
                → method: "clipboard_readback"
                → detail: "X chars in clipboard"
```

Timing: verifier runs after dispatch, before TTS synthesis. Target < 50ms for all checks.

---

## 9. Phase 1 Command Set

These are the exact utterances the system must handle correctly in Phase 1.  
The pattern classifier must handle all of these without LLM fallback.

### File Operations
| Utterance | Intent | Params |
|---|---|---|
| "Create a file called notes.txt" | `file.create` | `name: notes.txt` |
| "Make a new file named todo.txt" | `file.create` | `name: todo.txt` |
| "Create a file called journal.md in Documents" | `file.create` | `name: journal.md, locationHint: documents` |
| "Write hello world to notes.txt" | `file.write` | `name: notes.txt, content: hello world` |
| "Append meeting at 3pm to journal.md" | `file.append` | `name: journal.md, content: meeting at 3pm` |
| "Read notes.txt" | `file.read` | `name: notes.txt` |
| "Show me what's in notes.txt" | `file.read` | `name: notes.txt` |
| "List my Documents folder" | `file.list` | `dirHint: documents` |
| "What's in my Documents?" | `file.list` | `dirHint: documents` |
| "Create a folder called projects" | `file.mkdir` | `name: projects` |
| "Make a directory named backups" | `file.mkdir` | `name: backups` |

### App Launch
| Utterance | Intent | Params |
|---|---|---|
| "Open Chrome" | `app.open` | `appName: chrome` |
| "Launch Notepad" | `app.open` | `appName: notepad` |
| "Open Calculator" | `app.open` | `appName: calculator` |
| "Start VS Code" | `app.open` | `appName: vscode` |
| "Open Spotify" | `app.open` | `appName: spotify` |

### Browser
| Utterance | Intent | Params |
|---|---|---|
| "Open the browser" | `browser.open` | — |
| "Go to youtube.com" | `browser.goto` | `url: https://youtube.com` |
| "Open https://github.com" | `browser.goto` | `url: https://github.com` |
| "Visit google.com" | `browser.goto` | `url: https://google.com` |
| "Search for machine learning tutorials" | `browser.search` | `query: machine learning tutorials` |
| "Google the weather in London" | `browser.search` | `query: weather in London` |
| "Look up latest AI news" | `browser.search` | `query: latest AI news` |

### Clipboard
| Utterance | Intent | Params |
|---|---|---|
| "Copy to clipboard: meeting at 3pm" | `clipboard.write` | `text: meeting at 3pm` |
| "Copy this to clipboard: hello world" | `clipboard.write` | `text: hello world` |
| "Put in clipboard: my phone number is 12345" | `clipboard.write` | `text: my phone number is 12345` |

### Unsupported (must fail gracefully)
| Utterance | Expected |
|---|---|
| "Delete my notes.txt" | `system.unsupported` → "I can't delete files yet." |
| "Send an email to John" | `system.unsupported` → "Email isn't supported yet." |
| "Take a screenshot" | `system.unsupported` → "Use F7 for screenshots." |
| "Book a meeting" | `system.unsupported` → "That's not something I can do yet." |

---

## 10. Testing Plan

Tests are split into two tiers based on runtime dependency. Do not mix them.

### Tier A — Pure Node.js tests (no Electron context required)

**Script:** `main/jarvis/test-node.js` — run with `node main/jarvis/test-node.js`  
These modules have no Electron dependency and can be tested directly in Node.

```
Test A1 — files.js / resolveJarvisPath()
  - Bare filename → resolves to ~/Documents/Jarvis/
  - locationHint 'documents' → resolves to ~/Documents/
  - locationHint 'desktop' → resolves to ~/Desktop/
  - locationHint 'downloads' → resolves to ~/Downloads/
  - Path traversal attempt (../../etc/passwd) → rejected with error
  - Absolute path input → rejected

Test A2 — files.js operations (using temp directory)
  - createFile: file exists, content matches
  - readFile: returns correct content
  - writeFile: overwrites content correctly
  - appendFile: size grows, new content appended
  - listDir: returns non-empty entries array in known directory
  - createDir: new directory confirmed isDirectory()

Test A3 — verifier.js (pure logic, mock ToolResult input)
  - For each intent: construct mock ToolResult, call verify(), assert shape
  - Verified=true cases: file exists, size grew, clipboard matches
  - Verified=false cases: file not found, size unchanged

Test A4 — classifier.js — MOST IMPORTANT TEST
  - Run every utterance in the Phase 1 command set through classify()
  - Assert: correct intent for each
  - Assert: correct raw param fields (name, locationHint, query, etc.)
  - Assert: confidence === 'pattern' for all Phase 1 command set utterances (no LLM)
  - Assert: 4 unsupported utterances return intent === 'system.unsupported'
  - Assert: classifier returns system.unsupported when LLM fallback is disabled
    and no pattern fires (simulate by passing a nonsense utterance with API key removed)

Test A5 — dispatcher.js (mock tool calls)
  - For each intent: call dispatch() with valid ClassifierResult
  - Assert ToolResult shape and ok === true
  - For each intent: call dispatch() with missing required params
  - Assert DispatchError with readable message
```

### Tier B — Electron-runtime tests (require app context)

**Method:** Trigger from within the running Electron app via console or a dev test button added temporarily to the settings window. These cannot run in plain Node because `clipboard`, `shell`, and `BrowserWindow` require Electron.

```
Test B1 — clipboard.js
  - writeClipboard('test-string-12345')
  - Read back with clipboard.readText() — assert exact match
  - Assert ToolResult { ok: true, data: { written: 'test-string-12345' } }

Test B2 — apps.js (manual observation)
  - openApp('notepad') → Notepad window appears
  - openApp('calculator') → Calculator window appears
  - openApp('vscode') → VS Code opens (or graceful failure if not installed)
  - openApp('unknownxyz') → ToolResult { ok: false } — no crash, no OS prompt

Test B3 — browser.js (manual observation)
  - openBrowser() → default browser opens to google.com
  - gotoUrl('youtube.com') → browser opens https://youtube.com
  - search('hello world') → browser opens correct Google search URL
  - gotoUrl('ftp://example.com') → rejected, ToolResult { ok: false }

Test B4 — pipeline.js end-to-end (manual)
  - Use a pre-recorded audio file of "Create a file called test.txt"
  - Run runPipeline() with it
  - Assert file created in ~/Documents/Jarvis/
  - Assert jarvis:done event fired with ok: true
  - Log and verify per-step latency
```

### Latency benchmark (measure before calling Phase 1 complete)

Log timestamps at each pipeline step and report to console:
```
[JARVIS] STT:        XXXms   ← dominant cost; network-bound, ~800–1400ms typical
[JARVIS] Classify:   Xms     (pattern) | XXXms (llm)
[JARVIS] Dispatch:   Xms
[JARVIS] Verify:     Xms
[JARVIS] TTS:        XXXms   ← second largest; ~600–1200ms typical
[JARVIS] Total:      XXXXms
```

**Target for Phase 1:**
- Pattern classify: < 2ms
- Tool dispatch (file ops, clipboard): < 100ms
- Tool dispatch (app launch, browser): < 300ms (OS dependent)
- TTS synthesis: < 1500ms (ElevenLabs turbo)
- Total (pattern path): < 2500ms from audio stop to first spoken word

**Important framing:** Phase 1 proves the pipeline architecture is correct, not that final product latency is achieved. The dominant cost is STT (~800–1400ms network round-trip) and TTS (~600–1200ms). These are provider-bound. The pipeline itself — classify, dispatch, verify — adds less than 200ms on the pattern path. Real latency optimisation (streaming STT, streaming TTS, on-device models) is a Phase 2 concern. The Phase 1 target of 2500ms is realistic and demonstrates the architecture works.

---

## 11. Risks and Design Mistakes to Avoid

### Risk 1 — Command injection via transcript
**Never** build shell commands by string-concatenating the transcript.  
Any tool that spawns a process must use `spawn(executable, [arg1, arg2])` with a fixed argument array — never `exec('open ' + appName)`.  
In Phase 1, there are no `exec` calls at all: files use `fs`, browsers use `shell.openExternal`, apps use `shell.openPath`.

### Risk 2 — Path traversal in file tools
A transcript like "read ../../.env" must be caught.  
Resolution rule: `path.resolve(documentsDir, userPath)` then check that the result starts with `os.homedir()`. Reject if not.

### Risk 3 — Hotkey conflict with `hotkey.js`
`hotkey.js._doRegisterShortcuts()` calls `globalShortcut.unregisterAll()` at the start of every re-registration. If the Jarvis hotkey is registered through `hotkey.js`, it will be wiped whenever the user saves settings.  
**Fix:** Register the Jarvis hotkey directly in `jarvis/index.js` using `globalShortcut.register()`. Re-register it from within `jarvis/index.js` after receiving a `settings-saved` event from main. Do not route it through `hotkey.js`.

### Risk 4 — Blocking the main process
All tool operations must be `async`/`await`. The `fs` calls in `files.js` must use `fs.promises` (not the synchronous `fs.writeFileSync` etc.) except for the verifier's quick stat check, which is intentionally synchronous and fast.

### Risk 5 — LLM fallback becoming the hot path
If the pattern table is too narrow, the LLM fallback fires on common commands and adds 300–600ms to every classification. During testing, log `confidence` for every command. If `confidence === 'llm'` appears for any command in the Phase 1 command set, add a pattern rule for it immediately.

### Risk 6 — TTS failure blocking the pipeline
`synthesizeSpeech()` makes a network call and can fail (API key missing, rate limit, network timeout). This must be wrapped in `try/catch` and treated as non-fatal. The pipeline always reaches `jarvis:done` even if TTS is silent.

### Risk 7 — HUD window lifecycle leaking
The HUD window must not be recreated on every hotkey press. Create it once at `init()`, show/hide it. If it is recreated on each press, multiple hidden windows will accumulate and cause memory/event listener leaks.

### Risk 8 — IPC channel collision with existing pipeline
All Jarvis IPC channels must use the `jarvis:` prefix. The existing voice pipeline uses `voice:` and `guide:` prefixes. Never send a Jarvis event on an existing channel.

### Risk 9 — Overengineering the classifier
Do not add a multi-stage NLP pipeline, tokenizer, or intent scoring model. A compiled RegExp table is fast, readable, and sufficient for Phase 1's command set. Complexity can be added in Phase 2 if the pattern table proves insufficient.

### Risk 10 — Scope creep during implementation
Phase 1 explicitly does not include: screenshot-based reasoning, multi-step agent loops, browser automation (Playwright/Puppeteer), email, calendar, file deletion, or any external service integration. If a tool implementation requires importing a new npm package, stop and reconsider whether it belongs in Phase 1.

---

## 12. Settings Additions (minimal)

Add three fields to the default settings in `main/settings.js`:

```js
// Jarvis pipeline
jarvisEnabled:     true,   // can be toggled from settings UI later
jarvisHotkey:      '',     // custom hotkey override, default is F9 / Shift+Command+J
jarvisLlmFallback: true,   // if false, classifier runs in pattern-only mode (no API call)
```

Add convenience getters:
```js
function isJarvisEnabled() {
  return getSetting('jarvisEnabled', true) === true;
}
function isJarvisLlmFallbackEnabled() {
  return getSetting('jarvisLlmFallback', true) === true;
}
```

Do not add a Jarvis settings card to the existing settings UI in Phase 1. The defaults are good enough to ship Phase 1. `jarvisLlmFallback: true` is the safe default because the Gemini key is already present from existing setup.

---

## 13. Preload Bridge Additions

In `preload/preload.js`, add a `jarvis` entry to the contextBridge alongside the existing `electronAPI`:

```js
jarvis: {
  sendAudio:    (data) => ipcRenderer.send('jarvis:audio', data),

  // Each listener returns an unsubscribe function.
  // Callers MUST call the returned function when the HUD unmounts or resets
  // to prevent listener accumulation across show/hide cycles.
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

  replyConfirm: (ok) => ipcRenderer.send('jarvis:confirm-reply', ok),
  ping:         ()   => ipcRenderer.invoke('jarvis:ping'),
}
```

In `jarvis-hud.js`, store the returned unsubscribe functions and call them when the HUD transitions back to idle or is hidden. This prevents listeners from accumulating across multiple pipeline runs.

---

## 14. Success Criteria for Phase 1

Phase 1 is complete when all of the following are true:

- [ ] F9 activates the Jarvis HUD without disturbing F7/F8 behaviour
- [ ] All Phase 1 command set utterances are classified correctly by pattern (no LLM calls for these)
- [ ] File operations work: create, read, write, append, list, mkdir
- [ ] App launch works for at least: Chrome, Notepad, Calculator, VS Code
- [ ] Browser operations work: open browser, go to URL, search
- [ ] Clipboard write works and is verified by readback
- [ ] Unsupported commands return a clear spoken explanation and do not crash
- [ ] TTS failure is non-fatal — HUD still shows result
- [ ] Total latency (pattern path) is under 2500ms from audio stop to TTS start
- [ ] No path traversal or command injection possible through any tool
- [ ] F7 and F8 continue to work identically to before
- [ ] No screenshot is captured anywhere in the Jarvis Phase 1 execution path — verified by:
  - No imports of `main/screenshot.js` anywhere in `main/jarvis/`
  - No calls to `screenshot-desktop` or any screen-capture API in `main/jarvis/`
  - No screenshot-related IPC channels (`capture:`, `screenshot:`) sent or received within the Jarvis pipeline
  - Grep is a supporting sanity check, not the proof — confirm by reading `pipeline.js` and `index.js` top-to-bottom

---

## 15. Implementation Milestones (Recommended Split)

Phase 1 should not be implemented in one continuous stretch. It contains ~1100–1200 lines of new code across 13 distinct files. Implementing it end-to-end without intermediate checkpoints risks:

- discovering a design flaw in tools only after the HUD and pipeline are built
- debugging a broken voice loop without knowing whether the issue is in STT, classification, dispatch, or the HUD
- losing motivation from a long gap between "starting" and "something works"

The recommended split is **3 milestones**. Each ends with a working, demonstrable result.

---

### Milestone 1 — Local Action Core (no voice, no UI)

**Goal:** Prove that the tool layer and classifier work correctly before touching any UI or IPC.

**Files to build:**
- `main/jarvis/tools/files.js`
- `main/jarvis/tools/apps.js`
- `main/jarvis/tools/browser.js`
- `main/jarvis/tools/clipboard.js`
- `main/jarvis/verifier.js`
- `main/jarvis/prompts/intent.js`
- `main/jarvis/classifier.js`
- `main/jarvis/dispatcher.js`
- `main/jarvis/test-node.js` (Tier A tests)

**Demo:** Run `node main/jarvis/test-node.js`. Pass hardcoded command strings through classify → dispatch → verify. See files created, apps launched, and browser opened — all from a terminal script, with no voice, no HUD, no Electron window.

**This milestone validates:** tool correctness, path safety, pattern classification, dispatcher routing, verifier logic.

**Done when:** All Tier A tests pass. All Phase 1 command set utterances classified correctly by pattern. File operations verified in `~/Documents/Jarvis/`.

---

### Milestone 2 — Pipeline + HUD with Text Input

**Goal:** Prove the full pipeline orchestration and HUD UX work, without the complexity of voice latency during development.

**Files to build:**
- `main/jarvis/pipeline.js` (accepts transcript string directly — STT is bypassed)
- `renderer/jarvis-hud/jarvis-hud.html`, `.css`, `.js`
- `main/jarvis/index.js`
- Wire into `main/main.js` and `preload/preload.js`

**HUD modification for this milestone only:** Add a text input field to the HUD so a command can be typed instead of spoken. This is removed or hidden in Milestone 3 once voice is wired in.

**Demo:** Press F9. HUD appears. Type "open notepad". Notepad opens. HUD shows done state and auto-dismisses. Press F9 again. Type "create a file called test.txt". File appears in `~/Documents/Jarvis/`. TTS speaks the confirmation.

**This milestone validates:** pipeline orchestration, phase transitions, HUD state machine, IPC channel wiring, confirmation flow, TTS integration, HUD lifecycle (show/hide without leaks).

**Done when:** All HUD states render correctly. All Phase 1 command set commands work when typed. Confirmation prompt appears and can be accepted or cancelled. TTS plays on success. F7 and F8 still work.

---

### Milestone 3 — Full Voice Integration

**Goal:** Wire STT into the pipeline. Remove the text input field. The product experience is now complete.

**Files to modify:**
- `main/jarvis/pipeline.js` — add `transcribeAudio()` call at the top
- `renderer/jarvis-hud/jarvis-hud.js` — add MediaRecorder recording, remove text input
- `main/jarvis/classifier.js` — enable LLM fallback (was stubbed in M1/M2 tests)

**Demo:** Press F9. HUD shows listening state. Speak "search for machine learning tutorials". Browser opens Google search. HUD shows done. TTS confirms. Total time under 2500ms.

**This milestone validates:** STT integration, MediaRecorder lifecycle, full end-to-end voice-to-action loop, latency benchmark under real voice conditions.

**Done when:** All Phase 1 success criteria from Section 14 are met. Latency benchmarks logged and within targets.

---

### Why this split works

| | M1 | M2 | M3 |
|---|---|---|---|
| Can demo after? | Yes (terminal) | Yes (typed commands) | Yes (voice) |
| Debuggable without voice latency? | Yes | Yes | — |
| Catches tool design flaws early? | Yes | — | — |
| Tests HUD without audio complexity? | — | Yes | — |
| Full product experience? | — | — | Yes |

**Start with Milestone 1.** It is the safest, most isolated, and most informative first step.
