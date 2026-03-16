# Screen AI Assistant

A cross-platform desktop AI assistant that lives invisibly in the background. Press a global hotkey, select a screen region, ask a question, and get an instant AI answer — all without leaving your workflow.

Built with **Electron**, **Node.js**, and **Google Gemini Vision**.

---

## Features (Phase 1 MVP)

- **Invisible background app** — no Dock icon, no taskbar icon
- **Global hotkey** — triggers from any app, any time
- **Snipping-tool-style selection** — drag to capture any screen region
- **Translucent overlay panel** — minimal dark UI appears next to your selection
- **Gemini Vision** — sends screenshot + question to Google's multimodal LLM
- **Cross-platform** — Windows 10/11 and macOS 12+

---

## Hotkey

| Platform | Shortcut |
|---|---|
| Windows | `Ctrl + Shift + Y` |
| macOS   | `Shift + ⌘ + Y`   |

Press the hotkey again to dismiss any open window.

---

## Project structure

```
screen-ai-assistant/
│
├── main/
│   ├── main.js          ← App entry point, window orchestration, IPC
│   ├── hotkey.js        ← Global shortcut registration
│   ├── screenshot.js    ← Full-screen capture + jimp region crop
│   ├── llm.js           ← Gemini Vision API integration
│   └── config.js        ← Environment variable / .env loader
│
├── renderer/
│   ├── capture.html     ← Snipping-tool selection window
│   ├── capture.js       ← Canvas drag-to-select logic
│   ├── capture.css
│   ├── overlay.html     ← Ask/answer overlay panel
│   ├── overlay.js       ← Question input + response rendering
│   └── overlay.css
│
├── preload/
│   └── preload.js       ← Secure contextBridge IPC surface
│
├── assets/
│   └── icons/           ← icon.ico (Win) + icon.icns (Mac)
│
├── docs/                ← Architecture & skill documentation
│   ├── architecture.md
│   ├── electron-basics.md
│   ├── global-hotkeys.md
│   ├── transparent-overlay.md
│   ├── screen-capture.md
│   ├── llm-integration.md
│   ├── security.md
│   ├── packaging.md
│   └── cross-platform-build.md
│
├── package.json
├── electron-builder.json
└── .env.example
```

---

## Prerequisites

- **Node.js** 18 or later — [nodejs.org](https://nodejs.org)
- **npm** 9 or later (bundled with Node.js)
- A **Gemini API key** — [Get one free at Google AI Studio](https://aistudio.google.com/app/apikey)

---

## Installation

```bash
# 1. Clone or download the project
git clone <your-repo-url> screen-ai-assistant
cd screen-ai-assistant

# 2. Install dependencies
npm install

# 3. Configure your API key
cp .env.example .env
# Open .env in any editor and set GEMINI_API_KEY=your_key_here
```

---

## Running in development

```bash
npm start
```

The app launches silently — no window appears. Look for a console message:

```
[App] Screen AI Assistant is running in the background.
[App] Press the global hotkey to start a screen query.
```

Now press the hotkey:
- **Windows**: `Shift + Win + Y`
- **macOS**: `Shift + ⌘ + Y`

---

## Usage

1. Press the hotkey — the screen dims with a crosshair cursor.
2. **Click and drag** to select the region you want to ask about.
3. An overlay panel appears next to your selection.
4. Type your question in the text box.
5. Press **Enter** (or click the arrow button) to send.
6. The AI response appears in the panel.
7. Ask follow-up questions, or press **Esc** to close.

---

## Building for distribution

### Windows installer (`.exe`)

```bash
# Run on Windows
npm run build:win
# Output: dist/Screen AI Assistant Setup 1.0.0.exe
```

### macOS DMG (`.dmg`)

```bash
# Run on macOS
npm run build:mac
# Output: dist/Screen AI Assistant-1.0.0.dmg
```

> See `docs/packaging.md` for icon generation and code signing instructions.

---

## macOS: Screen Recording permission

On macOS 10.15+, the app needs **Screen Recording** permission to capture the screen.

On first use, macOS will show a permission dialog. If you accidentally denied it:

1. Open **System Settings** → **Privacy & Security** → **Screen Recording**
2. Enable **Screen AI Assistant**
3. Restart the app

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: override the model (default: gemini-2.0-flash)
# GEMINI_MODEL=gemini-2.0-flash
```

---

## Documentation

Detailed skill and architecture documentation lives in `docs/`:

| File | Contents |
|---|---|
| `architecture.md` | Full system diagram, IPC channels, data flow |
| `electron-basics.md` | Electron process model, BrowserWindow, IPC patterns |
| `global-hotkeys.md` | globalShortcut API, platform keys, lifecycle |
| `transparent-overlay.md` | Frameless/transparent windows, CSS techniques |
| `screen-capture.md` | screenshot-desktop, DPI scaling, jimp cropping |
| `llm-integration.md` | Gemini API, request format, error handling |
| `security.md` | contextIsolation, IPC hardening, API key safety |
| `packaging.md` | electron-builder, icons, notarisation |
| `cross-platform-build.md` | Windows vs macOS differences, CI setup |

---

## Roadmap (future phases)

- [ ] System tray icon with settings menu
- [ ] API key entry UI (no manual `.env` editing)
- [ ] Continuous screen monitoring mode
- [ ] Voice input
- [ ] Autonomous agent loop (Phase 3+)
- [ ] Multi-monitor support
- [ ] Auto-update

---

## Tech stack

| Package | Version | Purpose |
|---|---|---|
| `electron` | ^29 | Desktop app framework |
| `electron-builder` | ^24 | Cross-platform packaging |
| `screenshot-desktop` | ^1.15 | Full-screen capture |
| `jimp` | 0.22.12 | Image cropping (pure JS) |
| `node-fetch` | 2.7.0 | HTTP client for Gemini API |
