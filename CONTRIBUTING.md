# Contributing to ScreenAI

Thanks for your interest in contributing! Here's everything you need to get started.

---

## Getting Started

### Prerequisites

- **Node.js** 18 or later
- A **Gemini API key** — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

### Setup

```bash
# 1. Fork the repo, then clone your fork
git clone https://github.com/your-username/screenai.git
cd screenai

# 2. Install dependencies
npm install

# 3. Configure your API key
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# 4. Run the app
npm start
```

The app starts silently in the system tray. Press `F7` or `Ctrl+Shift+Y` to trigger a capture.

---

## Project Structure

```
main/        # Main process — hotkeys, screenshot, LLM, settings
renderer/    # Renderer pages — capture, overlay, settings UI
preload/     # contextBridge IPC surface (the only bridge to main)
assets/      # App icons
scripts/     # Build utilities (icon generation)
docs/        # Architecture and implementation notes
```

Read `CLAUDE.md` for a full architecture overview before making changes.

---

## Making Changes

1. **Create a branch** from `main`
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** — keep them focused on one thing per PR

3. **Test manually** — there is no automated test suite, so please test the full flow:
   - Hotkey triggers capture
   - Region selection works
   - Overlay appears and AI response streams in
   - Settings save and persist across restarts

4. **Push and open a Pull Request** against `main`

---

## What to Contribute

Good areas to contribute:

- **Bug fixes** — check the [Issues](https://github.com/jaseelkt/screenai/issues) tab
- **New AI model support** — add models to `llm.js` and the settings dropdown
- **UI improvements** — overlay, settings, or capture window
- **macOS compatibility** — testing and fixes for macOS-specific behaviour
- **Multi-monitor support** — currently only captures the primary display
- **Accessibility** — keyboard navigation, ARIA labels

---

## Guidelines

- **One PR per fix or feature** — keep it focused and easy to review
- **Don't break the IPC contract** — if you change channel names in `preload/preload.js`, update all senders and handlers in `main/main.js`
- **No new dependencies without discussion** — open an issue first if you need to add a package
- **API keys stay out of code** — never hardcode keys, always read from settings or environment
- **Renderer pages are sandboxed** — `nodeIntegration` is disabled by design; all Node/OS work must go through IPC in the main process

---

## Reporting Bugs

Open an [Issue](https://github.com/jaseelkt/screenai/issues) with:

- Your OS and version (e.g. Windows 11, macOS 14)
- Steps to reproduce
- What you expected vs what happened
- Any relevant console output

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](./LICENSE).
