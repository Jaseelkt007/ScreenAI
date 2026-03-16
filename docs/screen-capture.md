# Screen Capture Pipeline

## 1. Overview

The capture pipeline converts the user's drag gesture into a cropped PNG buffer ready for the LLM:

```
OS screen buffer
      │
      ▼  screenshot-desktop
Full-screen PNG buffer (physical pixels)
      │
      ▼  BrowserWindow (capture.html)
User drag selection  (logical pixels)
      │
      ▼  × scaleFactor  (main.js)
Physical-pixel rectangle
      │
      ▼  jimp.crop()
Cropped PNG buffer
      │
      ▼  base64 data URL
Overlay thumbnail  +  LLM API payload
```

## 2. screenshot-desktop

`screenshot-desktop` is a Node.js module that wraps platform-native screenshot utilities:

| Platform | Backend |
|---|---|
| Windows | `screenshot-desktop` uses Win32 GDI `BitBlt` |
| macOS | Uses `screencapture -x` CLI (no sound) |
| Linux | Uses `import` (ImageMagick) or scrot |

```js
const screenshot = require('screenshot-desktop');

// Capture primary display as PNG buffer
const buffer = await screenshot({ format: 'png' });
```

### Multi-monitor

```js
// List all displays
const displays = await screenshot.listDisplays();
// [{ id: 1, name: 'Monitor 1' }, { id: 2, name: 'Monitor 2' }]

// Capture a specific display
const buffer = await screenshot({ screen: displays[1].id, format: 'png' });
```

For Phase 1, we capture the primary display only.

### macOS permissions

macOS 10.15+ requires "Screen Recording" permission. Without it, `screenshot-desktop` returns a black image without throwing. Detect this by checking if the returned buffer is all black, or proactively request permission via:

```js
const { systemPreferences } = require('electron');
// The permission check happens automatically when screenshot is taken.
// Guide the user to System Settings > Privacy > Screen Recording if it fails.
```

## 3. Timing — capturing BEFORE opening UI

The screenshot must be taken **before** the capture window opens. If you capture after, the dimmed overlay itself appears in the screenshot.

```js
// ✓ Correct order:
const buffer = await captureFullScreen();    // No UI visible yet
openCaptureWindow(buffer);                   // Then show UI

// ✗ Wrong order:
openCaptureWindow();                         // UI appears
const buffer = await captureFullScreen();    // UI is in the screenshot
```

## 4. DPI scaling

On HiDPI displays (Retina, 4K), the OS uses a scaleFactor (e.g., 2.0) so UI elements don't appear tiny. This means:
- A 2560×1440 physical screen may be a 1280×720 logical screen at 2.0x scale.
- `screenshot-desktop` returns 2560×1440 pixels.
- Mouse events return logical coordinates (0–1280, 0–720).

**Always multiply logical coordinates by scaleFactor before cropping:**

```js
const scaleFactor = screen.getPrimaryDisplay().scaleFactor;

const physicalRegion = {
  x:      logicalRegion.x      * scaleFactor,
  y:      logicalRegion.y      * scaleFactor,
  width:  logicalRegion.width  * scaleFactor,
  height: logicalRegion.height * scaleFactor,
};

const cropped = await cropImage(buffer, physicalRegion);
```

## 5. Jimp — image cropping

[Jimp](https://github.com/jimp-dev/jimp) is a pure-JavaScript image manipulation library with no native bindings, making it reliable in cross-platform Electron builds.

```js
const Jimp = require('jimp');

async function cropImage(buffer, { x, y, width, height }) {
  const image = await Jimp.read(buffer);

  // Clamp to image bounds (guards against floating-point rounding)
  const imgW  = image.getWidth();
  const imgH  = image.getHeight();
  const cropX = Math.max(0, Math.min(Math.round(x), imgW - 1));
  const cropY = Math.max(0, Math.min(Math.round(y), imgH - 1));
  const cropW = Math.min(Math.round(width),  imgW - cropX);
  const cropH = Math.min(Math.round(height), imgH - cropY);

  image.crop(cropX, cropY, cropW, cropH);
  return image.getBufferAsync(Jimp.MIME_PNG);
}
```

### Jimp API versions

- **v0.22.x** — `.crop()` mutates in-place, `.getBufferAsync()`.
- **v1.x**    — New builder API, different import syntax.

This project pins **v0.22.12** for stability.

## 6. Canvas-based selection UI

The capture renderer draws a "punched-out" selection on a `<canvas>`:

```
┌──────────────────────────────────────┐
│ Screenshot (dimmed dark overlay)      │
│                                      │
│    ┌─────────────────┐               │
│    │ Clear region    │  ← Real       │
│    │ (reveals        │    screenshot │
│    │  screenshot)    │    pixels     │
│    └─────────────────┘               │
│                                      │
└──────────────────────────────────────┘
```

Implementation:
```js
// 1. Draw full screenshot
ctx.drawImage(bgImage, 0, 0);

// 2. Dark overlay on top
ctx.fillStyle = 'rgba(0,0,0,0.38)';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// 3. Clip to selection and redraw screenshot (punches hole in overlay)
ctx.save();
ctx.beginPath();
ctx.rect(selX, selY, selW, selH);
ctx.clip();
ctx.drawImage(bgImage, 0, 0);
ctx.restore();
```

## 7. Alternative: Electron's desktopCapturer

Electron provides a built-in `desktopCapturer` API that streams screen content via WebRTC. It is more complex but required for continuous/live capture in future phases.

```js
const { desktopCapturer } = require('electron');

const sources = await desktopCapturer.getSources({
  types: ['screen'],
  thumbnailSize: { width: 1920, height: 1080 },
});

// sources[0].thumbnail is an Electron NativeImage
const buffer = sources[0].thumbnail.toPNG();
```

For single-shot capture in Phase 1, `screenshot-desktop` is simpler and more reliable.
