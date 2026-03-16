# Packaging with electron-builder

## 1. Overview

`electron-builder` bundles the Electron binary, Node.js runtime, app code, and native modules into a single distributable installer.

| Platform | Output format | File |
|---|---|---|
| Windows | NSIS installer | `Screen AI Assistant Setup 1.0.0.exe` |
| macOS | DMG disk image | `Screen AI Assistant-1.0.0.dmg` |

## 2. electron-builder.json

```json
{
  "appId": "com.screenai.assistant",
  "productName": "Screen AI Assistant",
  "directories": {
    "output": "dist",
    "buildResources": "assets"
  },
  "files": [
    "main/**/*",
    "renderer/**/*",
    "preload/**/*",
    "assets/**/*",
    "node_modules/**/*",
    "package.json"
  ],
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }],
    "icon": "assets/icons/icon.ico"
  },
  "mac": {
    "target": [{ "target": "dmg", "arch": ["x64", "arm64"] }],
    "icon": "assets/icons/icon.icns",
    "category": "public.app-category.utilities"
  }
}
```

## 3. Build commands

```bash
# Install dependencies (includes devDependencies)
npm install

# Development run (no packaging)
npm start

# Build for Windows (from Windows or cross-compile)
npm run build:win

# Build for macOS (must run on macOS)
npm run build:mac

# Build for both
npm run build
```

## 4. Icons

### Windows: icon.ico

ICO files must contain multiple resolutions:
- 16×16, 32×32, 48×48, 64×64, 128×128, 256×256

Create from PNG using ImageMagick:
```bash
convert icon.png -resize 256x256 \
  \( -clone 0 -resize 16x16  \) \
  \( -clone 0 -resize 32x32  \) \
  \( -clone 0 -resize 48x48  \) \
  \( -clone 0 -resize 128x128\) \
  -delete 0 icon.ico
```

Or use online converter: convertio.co/png-ico

### macOS: icon.icns

ICNS files are created from an `.iconset` folder:
```bash
mkdir AppIcon.iconset
sips -z 16   16   icon.png --out AppIcon.iconset/icon_16x16.png
sips -z 32   32   icon.png --out AppIcon.iconset/icon_16x16@2x.png
sips -z 32   32   icon.png --out AppIcon.iconset/icon_32x32.png
sips -z 64   64   icon.png --out AppIcon.iconset/icon_32x32@2x.png
sips -z 128  128  icon.png --out AppIcon.iconset/icon_128x128.png
sips -z 256  256  icon.png --out AppIcon.iconset/icon_128x128@2x.png
sips -z 256  256  icon.png --out AppIcon.iconset/icon_256x256.png
sips -z 512  512  icon.png --out AppIcon.iconset/icon_256x256@2x.png
sips -z 512  512  icon.png --out AppIcon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out AppIcon.iconset/icon_512x512@2x.png
iconutil -c icns AppIcon.iconset
```

Place output at `assets/icons/icon.icns`.

## 5. Native modules (jimp, screenshot-desktop)

`jimp` is pure JavaScript — no native compilation required.

`screenshot-desktop` is also pure JS on Windows and macOS (uses shell commands). No `node-gyp` rebuild needed for this project.

If you add native modules in the future (e.g., `keytar`), electron-builder handles rebuilding them for the target Electron version automatically via `electron-rebuild`.

## 6. macOS notarisation

For distribution outside the Mac App Store, macOS Gatekeeper requires:
1. **Code signing** — `Developer ID Application` certificate from Apple.
2. **Notarisation** — Upload to Apple's notarisation service and staple the ticket.

electron-builder can automate this:
```json
"mac": {
  "identity": "Developer ID Application: Your Name (TEAMID)",
  "notarize": {
    "teamId": "TEAMID"
  }
}
```

Requires setting `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` environment variables.

## 7. Windows code signing

Windows SmartScreen warns on unsigned executables. Sign with a code signing certificate:

```json
"win": {
  "certificateFile": "cert.pfx",
  "certificatePassword": "your-password"
}
```

Or via environment variables:
```
WIN_CSC_LINK=cert.pfx
WIN_CSC_KEY_PASSWORD=your-password
```

## 8. Auto-update (Phase 2)

electron-builder integrates with `electron-updater` for seamless auto-updates:

```bash
npm install electron-updater
```

```js
// main.js
const { autoUpdater } = require('electron-updater');
autoUpdater.checkForUpdatesAndNotify();
```

Configure a publish target (GitHub Releases, S3, etc.) in `electron-builder.json`.

## 9. Build output structure

```
dist/
├── Screen AI Assistant Setup 1.0.0.exe   (Windows installer)
├── Screen AI Assistant-1.0.0.dmg          (macOS DMG)
├── mac/
│   └── Screen AI Assistant.app/
└── win-unpacked/
    └── Screen AI Assistant.exe
```

The `win-unpacked` folder contains the app without the installer wrapper — useful for portable/testing builds.
