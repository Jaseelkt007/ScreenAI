'use strict';

/**
 * guide.js — Voice Guide result renderer
 *
 * Responsibilities:
 *  - Receive guide data from main via guide:init
 *  - Render transcript, summary, numbered steps
 *  - Draw screenshot preview with optional highlight box on canvas
 *  - Receive TTS audio and play it automatically
 *  - Support Replay button and Close
 */

const loadingState       = document.getElementById('loading-state');
const content            = document.getElementById('content');
const errorState         = document.getElementById('error-state');
const errorMessage       = document.getElementById('error-message');
const transcriptText     = document.getElementById('transcript-text');
const summaryText        = document.getElementById('summary-text');
const stepsList          = document.getElementById('steps-list');
const confidenceWarning  = document.getElementById('confidence-warning');
const screenshotCanvas   = document.getElementById('screenshot-canvas');
const screenshotWrap     = document.getElementById('screenshot-wrap');
const replayBtn          = document.getElementById('replay-btn');
const closeBtn           = document.getElementById('close-btn');

let currentAudioUrl  = null;
let currentAudio     = null;
let lastAudioBase64  = null;
let lastAudioMime    = null;

// ── Close ──────────────────────────────────────────────────────────────────

closeBtn.addEventListener('click', () => {
  stopAudio();
  window.electronAPI.sendGuideClose();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    stopAudio();
    window.electronAPI.sendGuideClose();
  }
});

// ── Audio playback ─────────────────────────────────────────────────────────

function playAudio(base64, mimeType) {
  stopAudio();

  const blob = base64ToBlob(base64, mimeType);
  currentAudioUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(currentAudioUrl);
  currentAudio.play().catch((err) => {
    console.warn('[Guide] Audio playback failed:', err.message);
  });
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

function base64ToBlob(base64, mimeType) {
  const bytes = atob(base64);
  const arr   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

replayBtn.addEventListener('click', () => {
  if (lastAudioBase64) {
    playAudio(lastAudioBase64, lastAudioMime);
  }
});

// ── Guide rendering ────────────────────────────────────────────────────────

function renderGuide(data) {
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  content.classList.remove('hidden');

  // Transcript
  transcriptText.textContent = data.transcript || '';

  // Summary
  summaryText.textContent = data.summary || data.spoken_summary || '';

  // Steps
  stepsList.innerHTML = '';
  const steps = data.steps || [];
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = 'step-item';
    li.innerHTML = `
      <div class="step-number">${step.id}</div>
      <div class="step-body">
        <div class="step-title">${escapeHtml(step.title || '')}</div>
        <div class="step-instruction">${escapeHtml(step.instruction || '')}</div>
      </div>
    `;
    stepsList.appendChild(li);
  }

  // Confidence warning
  const conf = data.overall_confidence ?? 1;
  confidenceWarning.classList.toggle('hidden', conf >= 0.45);

  // Screenshot + highlight
  if (data.screenshotDataUrl) {
    renderScreenshot(data.screenshotDataUrl, data.steps);
  }
}

function renderScreenshot(dataUrl, steps) {
  const img = new Image();
  img.onload = () => {
    const MAX_W = 196; // canvas display width
    const ratio = MAX_W / img.naturalWidth;
    const dispH = Math.round(img.naturalHeight * ratio);

    screenshotCanvas.width  = img.naturalWidth;
    screenshotCanvas.height = img.naturalHeight;
    screenshotCanvas.style.width  = `${MAX_W}px`;
    screenshotCanvas.style.height = `${dispH}px`;

    const ctx = screenshotCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Draw first step's target highlight if present
    const firstWithTarget = (steps || []).find((s) => s.target);
    if (firstWithTarget) {
      const t = firstWithTarget.target;
      const x = t.x * img.naturalWidth;
      const y = t.y * img.naturalHeight;
      const w = t.w * img.naturalWidth;
      const h = t.h * img.naturalHeight;

      // Semi-transparent overlay
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, img.naturalWidth, img.naturalHeight);

      // Cut-out the highlight region (draw original pixels back)
      ctx.drawImage(img, x, y, w, h, x, y, w, h);

      // Border
      ctx.strokeStyle = '#00d4ff';
      ctx.lineWidth   = Math.max(2, img.naturalWidth * 0.004);
      ctx.shadowColor = '#00d4ff';
      ctx.shadowBlur  = 8;
      ctx.strokeRect(x, y, w, h);
    }
  };
  img.src = dataUrl;
}

function showError(msg) {
  loadingState.classList.add('hidden');
  content.classList.add('hidden');
  errorState.classList.remove('hidden');
  errorMessage.textContent = msg || 'An unexpected error occurred.';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── IPC listeners ──────────────────────────────────────────────────────────

window.electronAPI.onGuideInit((data) => {
  renderGuide(data);
});

window.electronAPI.onGuidePlayAudio((data) => {
  replayBtn.classList.remove('hidden');
  lastAudioBase64 = data.audioBase64;
  lastAudioMime   = data.mimeType;
  playAudio(data.audioBase64, data.mimeType);
});

window.electronAPI.onGuideError((data) => {
  showError(data.message);
});
