# ScreenAI

> Open-source desktop assistant for understanding what is on your screen, without leaving your workflow.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)]()
[![Electron](https://img.shields.io/badge/Electron-29-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Download](https://img.shields.io/badge/Download-Latest%20Release-0078D4?logo=github&logoColor=white)](https://github.com/Jaseelkt007/Screenai_electron/releases/latest)

ScreenAI is a tray-based desktop application that brings multimodal AI into everyday desktop work. Instead of copying screenshots into a browser and losing context, you trigger ScreenAI with a global hotkey, capture part of the screen, ask a question, and get a streamed answer beside the exact UI you are looking at.

The project also includes **Jarvis**, a hands-free voice mode that records your question, looks at the current screen, generates a short visual guide, and speaks the answer back to you.

**[Download the latest Windows release](https://github.com/Jaseelkt007/Screenai_electron/releases/latest)** · **[Contributing](./CONTRIBUTING.md)** · **[Architecture Docs](./docs/architecture.md)**

## Why ScreenAI

Modern desktop work is full of moments where the answer depends on visual context:

- You are staring at an error dialog and want a plain-English explanation
- You need help navigating an unfamiliar settings page or dashboard
- You want a quick summary of what is on screen without writing a long prompt
- You want spoken guidance while your hands stay on the keyboard or mouse

ScreenAI is designed for those moments. It keeps capture, question, answer, and follow-up in one flow instead of pushing you into a separate tool.

## What It Does

| Capability | Description |
|---|---|
| Region capture | Select any part of the screen with a snipping-tool-style interaction |
| Streaming answers | Responses appear incrementally as the model generates them |
| Follow-up context | Continue the conversation about the same screenshot |
| Voice guidance | Ask spoken questions and receive spoken answers with visual steps |
| Multiple providers | Use Gemini by default or switch to supported OpenAI models |
| Global hotkeys | Launch capture or voice mode from anywhere |
| Tray-first workflow | Stays out of the taskbar and remains available in the system tray |
| HiDPI-aware capture | Correct coordinate handling on scaled and Retina displays |
| Local settings | API keys and preferences are stored on the local machine |

## Two Interaction Modes

### 1. Screenshot Q&A

This is the core ScreenAI workflow:

1. Press the capture hotkey
2. Drag to select a region of the screen
3. Ask a question about what you selected
4. Read a streamed answer directly in the overlay
5. Ask follow-up questions without recapturing immediately

Typical prompts:

- `What does this error mean?`
- `Summarize this screen`
- `Which button should I click next?`
- `Explain this settings panel`

### 2. Jarvis Voice Guide

Jarvis is a voice-first assistant for screen-aware guidance:

1. Press the voice hotkey
2. Speak your question
3. Stop recording
4. ScreenAI captures the current screen and transcribes your audio
5. A guide window opens with concise steps and highlighted regions
6. The spoken response is played back through ElevenLabs streaming TTS

This mode is useful when you want instructions without switching attention away from the app you are using.

## How It Works

At a high level, ScreenAI combines three responsibilities:

- **Desktop integration**: global hotkeys, tray behavior, screen capture, settings, and native windows
- **Multimodal reasoning**: screenshot-plus-prompt requests routed to Gemini or OpenAI
- **Voice pipeline**: speech-to-text, structured guidance, and streaming text-to-speech for Jarvis

The Electron main process owns OS integration and provider API calls. Lightweight renderer windows handle the user interface for capture, overlay answers, settings, voice HUD, and the guide view. A secure preload bridge exposes only the IPC surface needed by those renderers.

For implementation details, see [docs/architecture.md](./docs/architecture.md) and the other files in [docs/](./docs).

## Requirements

- Node.js 18 or later
- A Gemini API key for Gemini-powered flows
- An OpenAI API key if you want to use OpenAI models
- An ElevenLabs API key if you want to enable Jarvis voice mode

## Getting Started

### Run from source

```bash
git clone https://github.com/Jaseelkt007/Screenai_electron.git
cd Screenai_electron
npm install
npm start
```

On first launch, ScreenAI starts in the system tray. If no provider credentials are configured, the Settings window opens so you can finish setup.

### Configure provider keys

The recommended path is the Settings UI:

1. Launch the app
2. Open the tray icon menu
3. Choose **Settings**
4. Add the provider keys you want to use

You can also use a local `.env` file for development:

```bash
cp .env.example .env
```

Example environment variables:

```env
GEMINI_API_KEY=your_gemini_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
GEMINI_MODEL=gemini-3-flash-preview
```

Settings stored by the application take precedence over environment variables.

## Default Hotkeys

| Function | Windows | macOS |
|---|---|---|
| Screen capture | `F7`, `Ctrl+Shift+Y`, `Alt+Shift+Y` | `Shift+Cmd+Y` |
| Jarvis voice guide | `F8` | `Shift+Cmd+V` |

Both hotkeys can be changed in Settings.

## Providers and Models

| Workflow | Provider(s) | Notes |
|---|---|---|
| Screenshot Q&A | Gemini, OpenAI | Select the overlay model in Settings |
| Voice guide | Gemini + ElevenLabs | Uses Gemini for guide generation and ElevenLabs for STT/TTS |

Current model choices exposed in the app include:

- `gemini-3-flash-preview`
- `gemini-2.5-flash`
- `gpt-4o`
- `gpt-4o-mini`
- `o1`
- `o3-mini`

## Platform Support

- **Windows**: primary release target with installer builds
- **macOS**: supported from source and for DMG builds
- **Linux**: not currently documented as an official target

### macOS screen recording permission

macOS requires explicit permission for screen capture. If capture does not work:

1. Open **System Settings**
2. Go to **Privacy & Security**
3. Open **Screen Recording**
4. Enable **ScreenAI**
5. Restart the app

## Build from Source

```bash
# Windows
npm run build:win

# macOS
npm run build:mac
```

Packaged artifacts are written to `dist/`.

## Project Layout

```text
main/       Electron main-process logic: app lifecycle, hotkeys, capture, LLM, voice
renderer/   HTML/CSS/JS renderer windows for capture, overlay, guide, HUD, and settings
preload/    Secure IPC bridge exposed to renderer processes
assets/     Icons and other bundled assets
scripts/    Small build and asset-generation utilities
docs/       Architecture and implementation notes
```

## Privacy and Security

- API keys are stored locally in the app's user-data directory or provided through environment variables
- Screenshots and voice data are sent only to the providers needed for the selected workflow
- Renderer windows run with `contextIsolation: true` and `nodeIntegration: false`
- The application does not depend on loading remote UI content

## Documentation

Additional project notes live in [docs/](./docs), including:

- [Architecture overview](./docs/architecture.md)
- [Screen capture](./docs/screen-capture.md)
- [Global hotkeys](./docs/global-hotkeys.md)
- [LLM integration](./docs/llm-integration.md)
- [Security model](./docs/security.md)

## Contributing

Contributions are welcome. For setup and contribution expectations, see [CONTRIBUTING.md](./CONTRIBUTING.md).

Good first contributions typically include:

- bug fixes
- UX improvements
- provider integration improvements
- performance work around capture, streaming, or rendering
- documentation and onboarding improvements

Please keep pull requests focused and include a clear description of what changed and why.

## License

ScreenAI is licensed under the [Apache License 2.0](./LICENSE).

## Credits

Created and maintained by **Mohammed Jaseel Kunnathodika**.
