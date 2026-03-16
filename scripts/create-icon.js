/**
 * create-icon.js
 *
 * Copies and resizes the project's source icon (icon.png in the project root)
 * into assets/icons/icon.png at 512×512, preserving aspect ratio with
 * transparent padding.
 *
 * electron-builder automatically converts this PNG to:
 *   .ico  — Windows executable / taskbar
 *   .icns — macOS app bundle
 *
 * Run manually:  node scripts/create-icon.js
 * Run via build: called automatically by the "prebuild" npm scripts.
 */

'use strict';

const Jimp = require('jimp');
const path = require('path');
const fs   = require('fs');

const ROOT    = path.join(__dirname, '..');
const SRC     = path.join(ROOT, 'icon.png');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');
const OUT     = path.join(OUT_DIR, 'icon.png');
const SIZE    = 512;

async function createIcon() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`Source icon not found: ${SRC}`);
  }

  const src = await Jimp.read(SRC);

  // Scale to fit inside SIZE×SIZE, preserving aspect ratio.
  src.scaleToFit(SIZE, SIZE, Jimp.RESIZE_LANCZOS);

  // Centre on a transparent SIZE×SIZE canvas.
  const canvas = new Jimp(SIZE, SIZE, 0x00000000);
  const ox = Math.round((SIZE - src.getWidth())  / 2);
  const oy = Math.round((SIZE - src.getHeight()) / 2);
  canvas.composite(src, ox, oy);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await canvas.writeAsync(OUT);

  console.log(`✓ Icon written: ${OUT} (${SIZE}×${SIZE} px)`);
}

createIcon().catch((err) => {
  console.error('Icon generation failed:', err.message);
  process.exit(1);
});
