# Global Hotkeys in Electron

## 1. What makes a hotkey "global"

A *global* shortcut fires even when the application window is not focused — the app may be completely hidden with no visible UI. This is what allows Screen AI Assistant to feel invisible yet always responsive.

Electron provides `globalShortcut` in the main process. Underneath it uses:
- **Windows** — `RegisterHotKey` Win32 API
- **macOS**   — `CGEventTapCreate` (Carbon event system)
- **Linux**   — X11 `XGrabKey`

## 2. Platform shortcut strings

Electron uses a string format: `Modifier+Modifier+Key`

| Modifier token | Meaning |
|---|---|
| `Command` / `Cmd` | ⌘ (macOS only) |
| `Control` / `Ctrl` | Ctrl |
| `Alt` / `Option` | Alt / ⌥ |
| `Shift` | ⇧ |
| `Super` | Windows key (Win/Linux) |
| `Meta` | ⌘ on macOS, Win key on Windows |

```js
// hotkey.js — platform-aware registration
const SHORTCUTS = {
  darwin: 'Shift+Command+Y',  // ⇧⌘Y
  win32:  'Shift+Super+Y',    // ⇧⊞Y
  linux:  'Shift+Super+Y',
};

const shortcut = SHORTCUTS[process.platform];

const ok = globalShortcut.register(shortcut, callback);
if (!ok) console.error('Hotkey already in use by another app');
```

## 3. Registration lifecycle

```js
// Register after app is ready
app.whenReady().then(() => {
  globalShortcut.register('Shift+Command+Y', onHotkey);
});

// Unregister before process exit — releases the key for other apps
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
```

**Important**: If the app crashes without calling `unregisterAll()`, the OS may hold the hotkey lock until the system is rebooted (especially on Windows). Electron's default cleanup usually handles this, but wrapping the main process in a try/catch and calling `unregisterAll()` in the error handler is good practice.

## 4. Handling conflicts

`globalShortcut.register()` returns `false` if another process already owns the hotkey. Common conflicts:
- Windows default: `Win+Y` — we use `Shift+Win+Y` to avoid it.
- macOS Spotlight: `Cmd+Space`
- Snipping Tool: `Win+Shift+S` — we avoid `S` for this reason.

When registration fails, surface a clear error to the user rather than silently failing.

## 5. Testing without focus

To verify the hotkey fires when another app is focused:
1. Click on a browser or terminal window.
2. Press the hotkey combination.
3. The capture window should appear on top.

## 6. Alternative: Media keys and special keys

```js
globalShortcut.register('F13', callback);          // Custom F-key (useful on macOS)
globalShortcut.register('MediaPlayPause', callback); // Media button
```

These are useful for remapping physical buttons on keyboards without conflicting with OS defaults.

## 7. Electron `globalShortcut` vs OS-level tools

| Approach | Pros | Cons |
|---|---|---|
| `globalShortcut` | Built-in, cross-platform, no extra deps | One shortcut per process; can conflict |
| `node-global-key-listener` | Low-level key monitoring | Requires accessibility permissions on macOS |
| AutoHotKey (Windows) | Very powerful | External tool, Windows only |

For this project, `globalShortcut` is the correct choice.
