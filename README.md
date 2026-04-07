# ScreenAI

> Capture any part of your screen, ask an AI about it — instantly, without leaving your workflow.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-00d4ff.svg)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)]()
[![Electron](https://img.shields.io/badge/Electron-29-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Gemini](https://img.shields.io/badge/Google%20Gemini-Vision-8E75B2?logo=google&logoColor=white)](https://aistudio.google.com/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4o-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![Download](https://img.shields.io/badge/Download-Windows%20Installer-0078D4?logo=windows&logoColor=white)](https://github.com/Jaseelkt007/ScreenAI/releases/latest)

ScreenAI is a lightweight desktop assistant that lives silently in your system tray. Press a global hotkey, drag to select a screen region, type your question, and get a streaming AI response right next to your selection. Or trigger **Jarvis** — a hands-free voice guide that captures your screen, transcribes your spoken question, and speaks the answer back to you.

**[Download v2.0 for Windows](https://github.com/Jaseelkt007/ScreenAI/releases/latest)** · Built with Electron + Google Gemini + ElevenLabs

---

## What's New in v2.0

### Jarvis — Voice Guide

A full voice pipeline, hands-free:

1. Press `F8` (or your custom Jarvis hotkey) → mic opens
2. Speak your question
3. Press `F8` again → ScreenAI transcribes, captures your screen, and asks the LLM
4. The Guide window appears with step-by-step instructions and a screenshot highlight
5. Jarvis **speaks** the answer aloud via ElevenLabs TTS

### Performance overhaul

| Optimization | Detail |
|---|---|
| **Parallel STT + Capture** | Transcription and screen capture now run simultaneously |
| **JPEG compression** | Screenshot compressed PNG → JPEG before sending to LLM (~75% smaller) |
| **TTS streaming** | Audio starts playing from the first chunk — no waiting for full synthesis |
| **Gemini 2.5 Flash for voice** | Voice guide uses `gemini-2.5-flash` independently of the overlay model |

### Redesigned Settings UI

- Cyberpunk HUD aesthetic — dot-grid background, cyan glows, animated scan line
- **Jarvis hotkey** always visible and configurable (even when Jarvis is disabled)
- Card-based layout with corner bracket decorations
- Proper toggle switches replacing checkboxes

---

## Features

- **Global hotkey** — trigger from any app at any time (`F7` or `Ctrl+Shift+Y` on Windows)
- **Snipping-tool-style capture** — drag to select any region of your screen
- **Streaming AI responses** — answers appear word-by-word as they generate
- **Multi-turn conversation** — ask follow-up questions about the same screenshot (3 turns)
- **Gemini + OpenAI support** — use Gemini 3 Flash, Gemini 2.5 Flash, GPT-4o, o1, o3-mini, and more
- **Jarvis voice guide** — speak your question, hear the answer (ElevenLabs STT + TTS)
- **Streaming TTS** — audio playback begins before synthesis completes
- **System tray** — always accessible, zero taskbar clutter
- **Start with OS** — optionally launch at login
- **Custom hotkeys** — rebind both capture and Jarvis hotkeys
- **HiDPI aware** — correct pixel coordinates on high-DPI / Retina displays

---

## Demo

**Screenshot mode:**
```
Press F7  →  Screen dims, drag a region
           →  Overlay panel appears beside your selection
           →  Type: "What does this error mean?"
           →  AI answer streams in
           →  Ask follow-ups, or press Esc to close
```

**Jarvis voice mode:**
```
Press F8  →  Mic opens, HUD appears
           →  Speak: "Can you explain what's on my screen?"
           →  Press F8 again to stop
           →  STT + screen capture run in parallel
           →  Guide window opens with steps + screenshot highlight
           →  Jarvis speaks the answer (streaming audio)
```

---

## Hotkeys

| Function | Default | Configurable |
|---|---|---|
| Screen Capture | `F7` / `Ctrl+Shift+Y` | Yes — Settings |
| Jarvis Voice Guide | `F8` | Yes — Settings |

Press the hotkey again while active to stop/cancel. Rebind anytime via the tray icon → **Settings**.

---

## Getting Started

### Prerequisites

- **Node.js** 18 or later — [nodejs.org](https://nodejs.org)
- A **Gemini API key** (free) — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- *(Optional)* An **OpenAI API key** for GPT-4o / o1 — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- *(Optional)* An **ElevenLabs API key** for Jarvis voice — [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)

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

> You can also enter your API key through the UI: right-click the tray icon → **Settings**.

---

## Configuration

### Option A — Settings UI (recommended)

Right-click the tray icon → **Settings** and enter your keys. Settings are saved to your OS user-data directory and persist across updates.

### Option B — `.env` file (dev / CI)

Copy `.env.example` to `.env` in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

The settings file takes priority over `.env`. Environment variables are a fallback for automation and local development.

---

## Supported Models

| Model | Provider | Used For |
|---|---|---|
| `gemini-3-flash-preview` | Google Gemini | Overlay Q&A (default) |
| `gemini-2.5-flash` | Google Gemini | Jarvis voice guide (fixed) |
| `gpt-4o` | OpenAI | Overlay Q&A |
| `gpt-4o-mini` | OpenAI | Overlay Q&A |
| `o1` | OpenAI | Overlay Q&A |
| `o3-mini` | OpenAI | Overlay Q&A |

The **overlay** model is user-selectable in Settings. The **Jarvis** voice guide always uses `gemini-2.5-flash` for optimal speed.

---

## Building from Source

### Windows installer (`.exe`)

```bash
# Must run on Windows
npm run build:win
# Output → dist/ScreenAI.Setup.2.0.exe
```

### macOS DMG (`.dmg`)

```bash
# Must run on macOS
npm run build:mac
# Output → dist/ScreenAI-2.0.0.dmg
```

### Regenerate app icon

```bash
npm run create-icon
```

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
│   ├── llm.js           # Gemini + OpenAI streaming API, JPEG compression
│   ├── stt.js           # ElevenLabs speech-to-text
│   ├── tts.js           # ElevenLabs TTS (streaming)
│   ├── settings.js      # Read/write settings.json in OS userData dir
│   └── config.js        # .env loader
│
├── renderer/
│   ├── capture.html/js/css       # Snipping-tool selection window
│   ├── overlay.html/js/css       # Ask/answer overlay panel
│   ├── voice-hud.html/js/css     # Jarvis recording indicator HUD
│   ├── guide.html/js/css         # Jarvis voice guide result window
│   └── settings.html/js/css      # Settings window (redesigned v2.0)
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
├── .env.example         # Template for local API key configuration
├── electron-builder.json
└── package.json
```

---

## Architecture

All OS-level work (hotkeys, file I/O, HTTP) runs in the **main process**. Renderer pages are locked down (`contextIsolation: true`, `nodeIntegration: false`) and communicate only through named IPC channels exposed by `preload/preload.js` via `contextBridge`.

**Screenshot flow:**
```
Hotkey → screenshot.js captures full screen (PNG)
       → Capture window: user drags a region
       → IPC: capture:region-selected → main crops with jimp
       → Overlay window: user types question, response streams in
       → IPC: overlay:ask → llm.js → Gemini or OpenAI streaming API
```

**Jarvis voice flow:**
```
F8 hotkey → Voice HUD opens, mic starts
          → F8 again → audio sent to main
          → [parallel] ElevenLabs STT  +  captureFullScreen()
          → llm.js → gemini-2.5-flash (JPEG screenshot)
          → Guide window opens (guide:init)
          → [streaming] ElevenLabs TTS chunks → guide:tts-chunk → MediaSource playback
```

A 1×1 hidden **background window** keeps the Win32 message pump alive so global hotkeys work even when no visible window is open.

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
| `jimp` | 0.22.12 | Image cropping + JPEG compression |
| `node-fetch` | 2.7.0 | HTTP client for AI provider APIs |

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
