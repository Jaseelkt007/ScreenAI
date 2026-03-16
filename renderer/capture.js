'use strict';

/**
 * capture.js — Renderer logic for the region-selection window.
 *
 * How it works (Snipping-Tool style):
 *   1. Main sends the full-screen PNG as a base64 data URL via IPC.
 *   2. We draw it onto a canvas that fills the entire screen.
 *   3. A translucent dark overlay is rendered on top.
 *   4. As the user drags, the selected rectangle is "punched out" of the
 *      overlay, revealing the underlying screenshot at full brightness.
 *   5. On mouseup the logical-pixel rectangle is sent back to main.
 *
 * Coordinate system:
 *   All values (canvas size, mouse positions) are in *logical* (CSS) pixels.
 *   Main applies the display's scaleFactor before calling jimp.
 */

const canvas = document.getElementById('selection-canvas');
const ctx    = canvas.getContext('2d');

// ── State ─────────────────────────────────────────────────────────────────
let bgImage    = null;    // HTMLImageElement of the full screenshot
let isDrawing  = false;
let startX     = 0;
let startY     = 0;
let currentX   = 0;
let currentY   = 0;

// Selection highlight colour (cyan-blue)
const BORDER_COLOR  = '#00d4ff';
const OVERLAY_COLOR = 'rgba(0, 0, 0, 0.38)';

// ── Init ──────────────────────────────────────────────────────────────────

window.electronAPI.onCaptureInit(({ dataUrl, logicalWidth, logicalHeight }) => {
  // Size the canvas to match the logical screen dimensions.
  canvas.width  = logicalWidth;
  canvas.height = logicalHeight;

  const img = new Image();
  img.onload = () => {
    bgImage = img;
    drawFrame(); // Draw the initial dimmed state immediately.
  };
  img.src = dataUrl;
});

// ── Render loop ───────────────────────────────────────────────────────────

function drawFrame() {
  if (!bgImage) return;

  // 1. Draw the full screenshot as background.
  ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);

  // 2. Dim the whole screen.
  ctx.fillStyle = OVERLAY_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!isDrawing) return;

  const rect = getSelectionRect();
  if (rect.w <= 0 || rect.h <= 0) return;

  // 3. Punch a clear hole: redraw the screenshot only in the selection area.
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  // 4. Draw the selection border.
  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  // 5. Draw corner handles.
  drawHandles(rect);

  // 6. Dimension label.
  drawDimensionLabel(rect);
}

/**
 * Draw small filled squares at the four corners of the selection.
 */
function drawHandles({ x, y, w, h }) {
  const SIZE = 6;
  ctx.fillStyle = BORDER_COLOR;
  const corners = [
    [x,         y        ],
    [x + w - SIZE, y        ],
    [x,         y + h - SIZE],
    [x + w - SIZE, y + h - SIZE],
  ];
  corners.forEach(([cx, cy]) => ctx.fillRect(cx, cy, SIZE, SIZE));
}

/**
 * Draw a "W × H" label just above (or inside) the selection rectangle.
 */
function drawDimensionLabel({ x, y, w, h }) {
  const label     = `${Math.round(w)} × ${Math.round(h)}`;
  const padding   = 4;
  const fontSize  = 12;
  ctx.font        = `${fontSize}px monospace`;

  const textWidth  = ctx.measureText(label).width;
  const bgW        = textWidth + padding * 2;
  const bgH        = fontSize + padding * 2;
  const labelX     = x;
  const labelY     = y - bgH - 3 >= 0 ? y - bgH - 3 : y + h + 3;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(labelX, labelY, bgW, bgH);

  ctx.fillStyle = BORDER_COLOR;
  ctx.fillText(label, labelX + padding, labelY + padding + fontSize - 2);
}

// ── Mouse events ──────────────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  isDrawing = true;
  startX    = e.clientX;
  startY    = e.clientY;
  currentX  = e.clientX;
  currentY  = e.clientY;
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDrawing) return;
  currentX = e.clientX;
  currentY = e.clientY;
  drawFrame();
});

canvas.addEventListener('mouseup', (e) => {
  if (!isDrawing) return;
  isDrawing = false;

  const rect = getSelectionRect();

  // Ignore tiny accidental clicks.
  if (rect.w < 8 || rect.h < 8) {
    window.electronAPI.sendCaptureCancel();
    return;
  }

  window.electronAPI.sendRegionSelected({
    x:      rect.x,
    y:      rect.y,
    width:  rect.w,
    height: rect.h,
  });
});

// ── Keyboard ──────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.electronAPI.sendCaptureCancel();
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────

/**
 * Return a normalised {x, y, w, h} rect regardless of drag direction.
 */
function getSelectionRect() {
  return {
    x: Math.min(startX, currentX),
    y: Math.min(startY, currentY),
    w: Math.abs(currentX - startX),
    h: Math.abs(currentY - startY),
  };
}
