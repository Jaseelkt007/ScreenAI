# Cross-Platform Build Guide (Windows + macOS)

## 1. Platform differences in this project

| Concern | Windows | macOS |
|---|---|---|
| Global hotkey | `Shift+Super+Y` | `Shift+Command+Y` |
| Hide from taskbar | `skipTaskbar: true` per window | `app.dock.hide()` |
| `alwaysOnTop` level | Not applicable (bool only) | `'screen-saver'` / `'floating'` |
| Screen Recording permission | Not required | Required (macOS 10.15+) |
| Transparent window compositing | DWM (on by default in Win10+) | Always available |
| Build output | `.exe` (NSIS) | `.dmg` |
| Icon format | `.ico` | `.icns` |

## 2. Conditional code patterns

Use `process.platform` to branch platform-specific logic:

```js
// Hide from OS task switcher
if (process.platform === 'darwin') {
  app.dock.hide();
}

// Platform hotkey
const shortcut = process.platform === 'darwin'
  ? 'Shift+Command+Y'
  : 'Shift+Super+Y';

// macOS requires a level string for full-screen-above-Dock behaviour
if (process.platform === 'darwin') {
  captureWindow.setAlwaysOnTop(true, 'screen-saver');
} else {
  captureWindow.setAlwaysOnTop(true);
}
```

## 3. Building on Windows (for Windows target)

```bash
# Prerequisites: Node.js 18+, Git
npm install
npm run build:win
# Output: dist/Screen AI Assistant Setup 1.0.0.exe
```

### Windows-specific gotchas

**Transparent windows with rounded corners (Win11):**
Windows 11 adds system-level rounded corners to windows. Since we use `frame: false`, set:
```js
// Disable Win11 rounded corners on the overlay (optional, personal preference)
win.setWindowButtonVisibility(false); // macOS only — no equivalent on Windows
```
On Windows 11 the rounded corners on frameless windows cannot be disabled via Electron API currently. The CSS `border-radius` on `#app` handles visual rounding instead.

**`Super` key on Windows:**
The Windows key (`⊞`) maps to `Super` in Electron on Windows. `Shift+Super+Y` = `Shift+Win+Y`.

**NSIS installer elevation:**
The `requestedExecutionLevel: 'asInvoker'` setting prevents UAC prompts (no admin required). The app installs per-user.

## 4. Building on macOS (for macOS target)

```bash
# Prerequisites: Node.js 18+, Xcode Command Line Tools
xcode-select --install
npm install
npm run build:mac
# Output: dist/Screen AI Assistant-1.0.0.dmg
```

### macOS-specific gotchas

**Screen Recording permission:**
macOS 10.15+ blocks `screenshot-desktop` without Screen Recording permission. The first capture attempt triggers the OS permission dialog. If the user denies it:
- `screenshot-desktop` returns a blank/black image without an error.
- Show a dialog guiding the user to `System Settings > Privacy & Security > Screen Recording`.

**Apple Silicon (arm64) + Intel (x64) universal build:**
```json
"mac": {
  "target": [{ "target": "dmg", "arch": ["x64", "arm64"] }]
}
```
electron-builder creates separate DMGs for each arch. For a single universal binary:
```json
"arch": ["universal"]
```
Universal binaries are larger (~2× size) but run natively on both Intel and Apple Silicon.

**Code signing on macOS:**
Unsigned builds show a Gatekeeper warning. For development, right-click > Open bypasses it. For distribution, a paid Apple Developer account is required.

## 5. Cross-compiling

**Building for macOS from Windows (or vice versa)** is not supported by electron-builder for native targets. Always build on the target platform.

Exception: If your app has **no native modules**, you can cross-compile. `jimp` and `screenshot-desktop` are pure JS, so theoretically cross-compilation works. However, macOS-specific Electron features (like `app.dock`) will be in the bundle regardless.

**Recommended CI setup (GitHub Actions):**
```yaml
jobs:
  build-windows:
    runs-on: windows-latest
    steps: [ npm install, npm run build:win ]

  build-macos:
    runs-on: macos-latest
    steps: [ npm install, npm run build:mac ]
```

## 6. Environment variables in packaged builds

In development: `.env` file next to `package.json`.
In packaged builds: `.env` next to the executable, or set via OS environment variables.

`config.js` searches these locations in order:
1. `__dirname/../.env` (dev)
2. Next to the executable

For end-user distribution, consider prompting for the API key on first launch and storing it in the OS keychain with `keytar`.

## 7. Testing cross-platform behaviour without owning both platforms

- **Windows in VM on macOS**: UTM or Parallels with Windows 11 ARM/x64.
- **macOS in VM on Windows**: Not possible on standard hardware (macOS EULA prohibits virtualisation on non-Apple hardware except for CI).
- **GitHub Actions**: Free macOS runners available for open-source repos.
- **BrowserStack App Automate**: Remote device testing.
