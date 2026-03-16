# Transparent & Frameless Overlay Windows in Electron

## 1. Required BrowserWindow options

```js
const win = new BrowserWindow({
  transparent:  true,   // Enable compositing transparency
  frame:        false,  // Remove OS title bar & borders (required with transparent)
  alwaysOnTop:  true,   // Float above other app windows
  skipTaskbar:  true,   // Don't show in Windows taskbar / macOS Cmd+Tab
  hasShadow:    false,  // Disable OS drop shadow (optional, cleaner look)
  resizable:    true,   // Allow the user to resize by dragging the edge
});
```

On **macOS** pair with:
```js
win.setAlwaysOnTop(true, 'floating');        // For the overlay
win.setAlwaysOnTop(true, 'screen-saver');   // For the capture window (above Dock)
```

On **Windows**, `transparent: true` requires the window to have no background colour set in CSS either — use `background: transparent` on `html, body`.

## 2. Making the background transparent in CSS

```css
/* overlay.css */
html, body {
  background: transparent;  /* REQUIRED — Electron won't show transparency otherwise */
}

#app {
  background: rgba(16, 16, 20, 0.90);  /* Semi-transparent dark card */
  backdrop-filter: blur(20px);          /* Frosted glass effect */
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.09);
}
```

> **Windows caveat**: `backdrop-filter: blur()` is only supported in Electron on Windows when DWM (Desktop Window Manager) compositing is enabled, which it is by default in Windows 10/11. On some systems with disabled DWM (rare), the blur won't render but the background colour still works.

## 3. Dragging a frameless window

Without a title bar, the user has no handle to drag the window. Two CSS approaches:

```css
/* Make the whole header draggable */
#header {
  -webkit-app-region: drag;
}

/* Opt specific elements out (buttons must not be draggable) */
button {
  -webkit-app-region: no-drag;
}
```

> Only use `-webkit-app-region: drag` on a dedicated header strip. Applying it to the whole window makes text selection impossible.

## 4. Window resizing

`resizable: true` adds invisible OS-level resize handles on the window edges. Combine with `minWidth` / `minHeight` to prevent the window collapsing:

```js
new BrowserWindow({
  resizable: true,
  minWidth:  300,
  minHeight: 200,
});
```

## 5. Click-through regions

Sometimes you want part of the overlay to be interactive and part to let mouse events pass through to the app below:

```js
// Make the entire window ignore mouse events (passes clicks through)
win.setIgnoreMouseEvents(true);

// Forward: whole window is click-through BUT hover still works
win.setIgnoreMouseEvents(true, { forward: true });

// To toggle interactivity from the renderer:
// Renderer sends IPC → main calls setIgnoreMouseEvents(false)
```

This is useful for Phase 2 features like ambient overlays.

## 6. The capture window — fullscreen transparent

The capture window requires slightly different handling because it needs to:
1. Cover the entire screen (including macOS menu bar).
2. Show the screenshot as background.
3. Be interactive for mouse drag selection.

```js
const { bounds } = screen.getPrimaryDisplay();

const captureWin = new BrowserWindow({
  x: bounds.x, y: bounds.y,
  width: bounds.width, height: bounds.height,
  transparent: true,
  frame:       false,
  alwaysOnTop: true,
});

captureWin.setAlwaysOnTop(true, 'screen-saver');
```

Using `bounds` (not `workAreaSize`) ensures the window covers the macOS menu bar.

## 7. Platform-specific caveats

| Platform | Caveat |
|---|---|
| **Windows** | `transparent + frame:false` works without special config in Win10+. On Win7, requires Aero compositing. |
| **macOS** | `NSVisualEffectView` (native vibrancy) is not available from Electron without native modules. `backdrop-filter` in CSS is the equivalent. |
| **Linux (X11)** | Requires a compositor (picom, compiz). Without it, transparent areas render black. |
| **Linux (Wayland)** | Limited support in Electron 29. Fallback to X11 mode (`ELECTRON_OZONE_PLATFORM_HINT=x11`). |

## 8. Overlay positioning logic

Position the overlay near the selection without going off-screen:

```js
let x = region.x + region.width + GAP;   // Prefer right of selection
if (x + OVERLAY_W > screenW) x = region.x - OVERLAY_W - GAP;  // Fall back left
if (x < 0) x = GAP;                       // Clamp to screen edge

let y = region.y;
if (y + OVERLAY_H > screenH) y = screenH - OVERLAY_H - GAP;
if (y < 0) y = GAP;
```
