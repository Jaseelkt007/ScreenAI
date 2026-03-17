# ScreenAI

> Capture any part of your screen, ask an AI about it — instantly, without leaving your workflow.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)]()
[![Electron](https://img.shields.io/badge/Electron-29-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Gemini](https://img.shields.io/badge/Google%20Gemini-Vision-8E75B2?logo=google&logoColor=white)](https://aistudio.google.com/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4o-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![Download](https://img.shields.io/badge/Download-Windows%20Installer-0078D4?logo=windows&logoColor=white)](https://screen-ai-flame.vercel.app/)

ScreenAI is a lightweight desktop assistant that lives silently in your system tray. Press a global hotkey, drag to select a screen region, type your question, and get a streaming AI response right next to your selection.

**[Download for Windows](https://screen-ai-flame.vercel.app/)** · Built with Electron + Google Gemini Vision + OpenAI

---

## Features

- **Global hotkey** — trigger from any app at any time (`F7` or `Ctrl+Shift+Y` on Windows)
- **Snipping-tool-style capture** — drag to select any region of your screen
- **Streaming AI responses** — answers appear word-by-word as they generate
- **Multi-turn conversation** — ask follow-up questions about the same screenshot (3 turns)
- **Gemini + OpenAI support** — use Gemini 3 Flash, GPT-4o, o1, o3-mini, and more
- **Light / dark theme** — toggle inside the overlay panel
- **System tray** — always accessible, zero taskbar clutter
- **Start with OS** — optionally launch at login
- **Custom hotkey** — rebind to any key combo you prefer
- **HiDPI aware** — correct pixel coordinates on high-DPI / Retina displays

---

## Demo

```
Press F7  →  Screen dims, drag a region
           →  Overlay panel appears beside your selection
           →  Type: "What does this error mean?"
           →  AI answer streams in
           →  Ask follow-ups, or press Esc to close
```

---

## Hotkeys

| Platform | Default Shortcuts |
|---|---|
| Windows | `F7` · `Ctrl+Shift+Y` · `Alt+Shift+Y` |
| macOS   | `Shift+Cmd+Y` |

Press the hotkey again while the overlay is open to close it.
Rebind anytime via the tray icon → **Settings**.

---

## Getting Started

### Prerequisites

- **Node.js** 18 or later — [nodejs.org](https://nodejs.org)
- A **Gemini API key** (free) — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- *(Optional)* An **OpenAI API key** if you want to use GPT-4o / o1 — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

### Install & run

```bash
# 1. Clone the repo
git clone https://github.com/jaseelkt/screenai.git
cd screenai

# 2. Install dependencies
npm install

# 3. (Optional) Set API key via .env for local dev
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# 4. Run
npm start
```

The app starts silently in the system tray. On first launch with no API key configured, the Settings window opens automatically.

> You can also enter your API key through the UI: right-click the tray icon → **Settings / API Key**.

---

## Configuration

### Option A — Settings UI (recommended)

Right-click the tray icon → **Settings / API Key** and enter your key. Settings are saved to your OS user-data directory and persist across updates.

### Option B — `.env` file (dev / CI)

Copy `.env.example` to `.env` in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

The settings file takes priority over `.env`. Environment variables are a fallback for automation and local development.

---

## Supported Models

| Model | Provider | Notes |
|---|---|---|
| `gemini-3-flash-preview` | Google Gemini | Default — fast, multimodal |
| `gemini-2.5-flash` | Google Gemini | Requires Gemini API key |
| `gpt-4o` | OpenAI | Requires OpenAI API key |
| `gpt-4o-mini` | OpenAI | Requires OpenAI API key |
| `o1` | OpenAI | Requires OpenAI API key |
| `o3-mini` | OpenAI | Requires OpenAI API key |

Switch models anytime in **Settings**.

---

## Building from Source

### Windows installer (`.exe`)

```bash
# Must run on Windows
npm run build:win
# Output → dist/ScreenAI Setup 1.0.0.exe
```

### macOS DMG (`.dmg`)

```bash
# Must run on macOS
npm run build:mac
# Output → dist/ScreenAI-1.0.0.dmg
```

### Regenerate app icon

The build scripts call this automatically. To run manually:

```bash
npm run create-icon
```

This reads `icon.png` from the project root and writes a 512×512 version to `assets/icons/icon.png`.

---

## macOS: Screen Recording Permission

On macOS 10.15+, the OS requires explicit permission for screen capture.

On first use a permission dialog will appear. If you accidentally denied it:

1. Open **System Settings** → **Privacy & Security** → **Screen Recording**
2. Enable **ScreenAI**
3. Restart the app

---

## Project Structure

```
screenai/
├── main/
│   ├── main.js          # App entry point, window management, IPC routing
│   ├── hotkey.js        # Global shortcuts + system tray icon
│   ├── screenshot.js    # Full-screen capture and jimp region crop
│   ├── llm.js           # Gemini + OpenAI streaming API integration
│   ├── settings.js      # Read/write settings.json in OS userData dir
│   └── config.js        # .env loader
│
├── renderer/
│   ├── capture.html/js/css   # Snipping-tool selection window
│   ├── overlay.html/js/css   # Ask/answer overlay panel
│   └── settings.html/js/css  # Settings window
│
├── preload/
│   └── preload.js       # Secure contextBridge IPC surface
│
├── assets/
│   └── icons/           # App icon (generated by create-icon.js)
│
├── scripts/
│   └── create-icon.js   # Resizes icon.png → assets/icons/icon.png
│
├── docs/                # Architecture and implementation notes
├── .env.example         # Template for local API key configuration
├── electron-builder.json
└── package.json
```

---

## Architecture

All OS-level work (hotkeys, file I/O, HTTP) runs in the **main process**. Renderer pages are locked down (`contextIsolation: true`, `nodeIntegration: false`) and communicate only through named IPC channels exposed by `preload/preload.js` via `contextBridge`.

```
Hotkey / tray click
  → screenshot.js captures full screen (PNG buffer)
  → Capture window  — user drags a region
  → IPC: capture:region-selected → main crops with jimp (×scaleFactor for HiDPI)
  → Overlay window  — user types question, response streams in
  → IPC: overlay:ask → llm.js → Gemini or OpenAI streaming API
```

A 1×1 hidden **background window** keeps the Win32 message pump alive so global hotkeys continue working even when no visible window is open.

---

## Settings Storage

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\screen-ai-assistant\settings.json` |
| macOS   | `~/Library/Application Support/screen-ai-assistant/settings.json` |

API keys are stored only on your local machine and are never transmitted anywhere except directly to the respective AI provider API.

---

## Tech Stack

| Package | Version | Purpose |
|---|---|---|
| `electron` | ^29 | Desktop app framework |
| `electron-builder` | ^24 | Cross-platform packaging |
| `screenshot-desktop` | ^1.15 | Full-screen capture |
| `jimp` | 0.22.12 | Image cropping (pure JS, no native deps) |
| `node-fetch` | 2.7.0 | HTTP client for Gemini and OpenAI APIs |

---

## Contributing

Contributions are welcome. To get started:

1. Fork the repo and create a feature branch
2. `npm install` and `npm start` to run locally
3. Make your changes
4. Open a pull request with a clear description of what you changed and why

Please keep PRs focused — one feature or fix per PR.

---

## License

[Apache 2.0](./LICENSE) — © 2026 Mohammed Jaseel Kunnathodika

---

## Author

**Mohammed Jaseel Kunnathodika**
[linkedin.com/in/jaseelkt](https://www.linkedin.com/in/jaseelkt/)
