# Architecture Overview — Screen AI Assistant

## 1. High-level concept

Screen AI Assistant is a tray-less, invisible desktop application that springs to life only when the user presses a global hotkey. It captures a screen region, shows a translucent overlay panel, and streams the image + question to a vision-capable LLM (Gemini).

```
┌──────────────────────────────────────────────────────────┐
│                  Electron Main Process                   │
│                                                          │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────┐  │
│  │ hotkey.js│  │screenshot  │  │  llm.js  │  │config │  │
│  │          │  │    .js     │  │          │  │  .js  │  │
│  └────┬─────┘  └─────┬──────┘  └────┬─────┘  └───────┘  │
│       │              │              │                    │
│       └──────────────┴──────────────┘                    │
│                       main.js (orchestrator)             │
│                       IPC bridge                         │
└──────────────────┬───────────────────┬───────────────────┘
                   │ contextBridge     │ contextBridge
    ┌──────────────┴───┐         ┌─────┴──────────────┐
    │  Capture Window  │         │   Overlay Window   │
    │  (BrowserWindow) │         │  (BrowserWindow)   │
    │  capture.html    │         │  overlay.html      │
    │  capture.js      │         │  overlay.js        │
    │  capture.css     │         │  overlay.css       │
    └──────────────────┘         └────────────────────┘
             ▲                           ▲
             │    preload/preload.js     │
             └───────────────────────────┘
```

## 2. Process model

Electron runs two types of processes:

| Process | Role |
|---|---|
| **Main** | Node.js; owns OS integration (hotkeys, windows, file I/O, HTTP) |
| **Renderer** | Chromium page; handles UI and user interaction only |

Renderers cannot access Node.js APIs directly (`contextIsolation: true`, `nodeIntegration: false`). All privileged work flows through the IPC bridge exposed in `preload/preload.js`.

## 3. Capture flow (Phase 1)

```
Hotkey pressed
    │
    ▼
captureFullScreen()          ← screenshot-desktop grabs a PNG buffer
    │
    ▼
openCaptureWindow()          ← frameless, transparent, fullscreen BrowserWindow
    │                           (sends PNG as base64 data URL to renderer)
    ▼
User drags selection         ← canvas punch-out technique (see capture.js)
    │
    ▼
IPC: capture:region-selected ← logical pixel rect sent to main
    │
    ▼
cropImage(buffer, physicalRect) ← jimp crops after applying scaleFactor
    │
    ▼
openOverlayWindow()          ← frameless translucent BrowserWindow
    │
    ▼
User types question + Enter
    │
    ▼
IPC: overlay:ask             ← {prompt} sent to main
    │
    ▼
askLLM(croppedBuffer, prompt) ← Gemini REST API call
    │
    ▼
IPC: overlay:response        ← {text} sent back to renderer
    │
    ▼
Response rendered in overlay
```

## 4. IPC channel reference

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `capture:init` | main → renderer | `{dataUrl, logicalWidth, logicalHeight, scaleFactor}` | Initialise capture canvas |
| `capture:region-selected` | renderer → main | `{x, y, width, height}` | User finished dragging |
| `capture:cancel` | renderer → main | — | Esc pressed in capture window |
| `overlay:init` | main → renderer | `{imageDataUrl}` | Send cropped screenshot to overlay |
| `overlay:ask` | renderer → main | `{prompt}` | User submitted a question |
| `overlay:response` | main → renderer | `{text}` | LLM response text |
| `overlay:error` | main → renderer | `{message}` | Error string |
| `overlay:close` | renderer → main | — | User clicked X or pressed Esc |

## 5. Window properties

| Window | transparent | frame | alwaysOnTop level | skipTaskbar |
|---|---|---|---|---|
| Capture | ✓ | ✗ | screen-saver | ✓ |
| Overlay | ✓ | ✗ | floating | ✓ |

## 6. DPI / HiDPI handling

`screenshot-desktop` returns an image in **physical pixels**.
Mouse events in the renderer are in **logical (CSS) pixels**.

```
physicalX = logicalX × display.scaleFactor
```

`main.js` reads `screen.getPrimaryDisplay().scaleFactor` and applies it before calling `cropImage()` in `screenshot.js`.

## 7. Security model

- `nodeIntegration: false` — no `require()` in renderer pages.
- `contextIsolation: true` — renderer runs in a separate V8 context.
- `preload.js` exposes only named IPC channels via `contextBridge`.
- No remote content is loaded; all pages are local `file://` URLs.
- CSP headers in every HTML file block inline scripts and remote resources.

## 8. Module responsibilities

| File | Responsibility |
|---|---|
| `main/main.js` | App bootstrap, window lifecycle, IPC orchestration |
| `main/hotkey.js` | Platform-aware global shortcut registration |
| `main/screenshot.js` | Full-screen capture and region cropping |
| `main/llm.js` | Gemini Vision API request/response |
| `main/config.js` | Env / .env file loading |
| `preload/preload.js` | Secure contextBridge IPC surface |
| `renderer/capture.*` | Snipping-tool-style region selection UI |
| `renderer/overlay.*` | Ask/answer panel UI |
