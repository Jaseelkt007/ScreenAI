/**
 * create-icon.js
 *
 * Resizes icon.png (project root) → assets/icons/icon.png at 512×512,
 * preserving aspect ratio with transparent padding.
 *
 * electron-builder's internal app-builder binary converts this PNG to a
 * proper multi-resolution ICO before handing it to rcedit for EXE patching.
 * No manual ICO generation is needed — let electron-builder own that step.
 *
 * Uses only jimp (already a project dependency).
 *
 * Run manually:  node scripts/create-icon.js
 * Run via build: called automatically by the prebuild npm scripts.
 */

'use strict';

const { Jimp } = require('jimp');
const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const SRC     = path.join(ROOT, 'icon.png');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');
const OUT_PNG = path.join(OUT_DIR, 'icon.png');
const SIZE    = 512;

async function createIcon() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`Source icon not found: ${SRC}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const src = await Jimp.read(SRC);
  src.scaleToFit({ w: SIZE, h: SIZE });

  const canvas = new Jimp({ width: SIZE, height: SIZE, color: 0x00000000 });
  canvas.composite(
    src,
    Math.round((SIZE - src.bitmap.width)  / 2),
    Math.round((SIZE - src.bitmap.height) / 2)
  );

  await canvas.write(OUT_PNG);
  console.log(`✓ Icon written : ${OUT_PNG} (${SIZE}×${SIZE} px)`);
}

createIcon().catch(err => {
  console.error('Icon generation failed:', err.message);
  process.exit(1);
});
