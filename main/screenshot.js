'use strict';

/**
 * screenshot.js
 *
 * Handles full-screen capture and region cropping.
 *
 * Flow:
 *   1. captureFullScreen() — uses screenshot-desktop to grab a PNG buffer
 *      of the primary display in physical pixels.
 *   2. cropImage()         — uses jimp to crop the PNG to the user's
 *      selected rectangle and return a new PNG buffer.
 *
 * DPI / HiDPI note:
 *   Mouse-event coordinates from the renderer are in *logical* (CSS) pixels.
 *   screenshot-desktop returns an image in *physical* pixels.
 *   Use the display's scaleFactor to convert between the two:
 *     physicalX = logicalX * scaleFactor
 */

const screenshotDesktop = require('screenshot-desktop');
const Jimp = require('jimp');

// ─── Full-screen capture ───────────────────────────────────────────────────

/**
 * Capture the primary display and return a PNG Buffer.
 *
 * @returns {Promise<Buffer>} Raw PNG image data.
 */
async function captureFullScreen() {
  try {
    // screenshot-desktop defaults to PNG format and the primary screen.
    const buffer = await screenshotDesktop({ format: 'png' });
    return buffer;
  } catch (err) {
    // Common cause on macOS: missing Screen Recording permission.
    if (process.platform === 'darwin') {
      throw new Error(
        'Screen capture failed. Please grant "Screen Recording" permission to ' +
        'Screen AI Assistant in System Settings → Privacy & Security.'
      );
    }
    throw new Error(`Screen capture failed: ${err.message}`);
  }
}

// ─── Region crop ──────────────────────────────────────────────────────────

/**
 * Crop a rectangular region from a PNG buffer.
 *
 * @param {Buffer} imageBuffer           - Source PNG buffer (physical pixels).
 * @param {{ x: number, y: number, width: number, height: number }} region
 *   Coordinates in *physical* pixels (already scaled by the caller).
 * @returns {Promise<Buffer>} Cropped PNG buffer.
 */
async function cropImage(imageBuffer, region) {
  const { x, y, width, height } = region;

  if (width <= 0 || height <= 0) {
    throw new Error('Invalid crop region: width and height must be positive.');
  }

  const image = await Jimp.read(imageBuffer);

  const imgW = image.getWidth();
  const imgH = image.getHeight();

  // Clamp region to actual image dimensions to avoid out-of-bounds errors.
  const cropX = Math.max(0, Math.min(Math.round(x), imgW - 1));
  const cropY = Math.max(0, Math.min(Math.round(y), imgH - 1));
  const cropW = Math.min(Math.round(width),  imgW - cropX);
  const cropH = Math.min(Math.round(height), imgH - cropY);

  if (cropW <= 0 || cropH <= 0) {
    throw new Error('Crop region is outside the image bounds.');
  }

  image.crop(cropX, cropY, cropW, cropH);

  return image.getBufferAsync(Jimp.MIME_PNG);
}

module.exports = { captureFullScreen, cropImage };
