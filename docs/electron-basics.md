# Electron Fundamentals for This Project

## 1. Process architecture

Electron fuses Chromium and Node.js. Every app has at least two process types:

```
┌─────────────────────────────────┐
│          Main Process           │
│  • Single instance              │
│  • Full Node.js access          │
│  • Controls BrowserWindows      │
│  • Owns OS integrations         │
│    (hotkeys, tray, notifications)│
└───────────────┬─────────────────┘
                │ IPC (ipcMain / ipcRenderer)
    ┌───────────┴───────────┐
    │    Renderer Process   │  (one per BrowserWindow)
    │  • Chromium page      │
    │  • No Node.js by default
    │    (contextIsolation) │
    └───────────────────────┘
```

**Rule**: Any OS interaction (file system, HTTP, native APIs) belongs in the main process. The renderer is purely UI.

## 2. BrowserWindow — key options used in this project

```js
new BrowserWindow({
  transparent:  true,   // Window background is transparent (requires frame:false)
  frame:        false,  // No OS title bar or borders
  alwaysOnTop:  true,   // Float above all other apps
  skipTaskbar:  true,   // Don't appear in the taskbar / Dock
  hasShadow:    false,  // Disable the OS drop shadow
  webPreferences: {
    preload:          '/path/to/preload.js',
    contextIsolation: true,   // Isolate renderer from preload context
    nodeIntegration:  false,  // Disable require() in renderer
  },
});
```

### Why `transparent: true` needs `frame: false`

On Windows and macOS, the OS composites the window background. Setting `transparent: true` without `frame: false` produces undefined behaviour (sometimes just an invisible border). Always pair them.

### `setAlwaysOnTop(true, level)`

The optional `level` string controls z-order on macOS:
- `'normal'`       — Default floating window
- `'floating'`     — Overlays normal app windows (used by overlay)
- `'screen-saver'` — Overlays everything including the Dock (used by capture)

On Windows the level parameter is ignored; `alwaysOnTop: true` is sufficient.

## 3. Context Isolation + preload

The **preload script** runs before the renderer page loads, in a context that has both Node.js *and* DOM access. `contextBridge.exposeInMainWorld()` safely tunnels a limited API into the renderer's `window` object.

```js
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Only expose specific, named channels — never raw ipcRenderer.
  sendAsk: (prompt) => ipcRenderer.send('overlay:ask', { prompt }),
  onResponse: (cb)  => ipcRenderer.on('overlay:response', (_, d) => cb(d)),
});
```

```js
// renderer page
window.electronAPI.sendAsk('What error is shown?');
```

**Why not just `nodeIntegration: true`?**
It gives every renderer page access to the entire Node.js API, including `require('child_process')`. Any third-party script loaded in a renderer (accidentally or via a compromised dependency) gets full system access. `contextIsolation + preload` is the modern, secure default.

## 4. IPC patterns

### One-way (fire and forget)
```js
// renderer → main
ipcRenderer.send('channel', payload);

// main listener
ipcMain.on('channel', (event, payload) => { ... });
```

### Request / response (invoke)
```js
// renderer (async/await)
const result = await ipcRenderer.invoke('channel', payload);

// main handler
ipcMain.handle('channel', async (event, payload) => {
  return computedResult;
});
```

This project uses `send/on` for the overlay's ask flow (response comes back on a separate channel) and `on/send` from main to renderer for pushing results.

## 5. `app` events

| Event | When | Used for |
|---|---|---|
| `ready` | App fully initialised | Register hotkeys, create first window |
| `window-all-closed` | Last window closed | Prevented with `e.preventDefault()` to keep app alive |
| `will-quit` | Before process exits | Unregister global shortcuts |
| `activate` (macOS) | Dock icon clicked | Re-open main window (not applicable here — no Dock icon) |

## 6. `screen` module

```js
const { screen } = require('electron');

const primary     = screen.getPrimaryDisplay();
const { bounds }  = primary;       // { x, y, width, height } — logical pixels
const scale       = primary.scaleFactor; // Physical / logical ratio (e.g. 2.0 for Retina)
const { workAreaSize } = primary;  // Available area excluding taskbar/menu bar
```

Always use `bounds` (not `workAreaSize`) for fullscreen capture window sizing.
Use `workAreaSize` for overlay positioning so it doesn't appear under the taskbar.

## 7. Hiding from Dock and taskbar

```js
// macOS: hide from Dock (must be called after app is ready)
if (process.platform === 'darwin') {
  app.dock.hide();
}

// Windows/Linux: hide from taskbar per window
new BrowserWindow({ skipTaskbar: true });
```

`app.setActivationPolicy('accessory')` is an alternative on macOS but `app.dock.hide()` is simpler.
