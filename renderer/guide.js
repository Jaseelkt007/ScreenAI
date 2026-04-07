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
let replayBlobUrl    = null; // object URL built from all received chunks for replay

// ── TTS streaming state ─────────────────────────────────────────────────────
let _mediaSource   = null;
let _sourceBuffer  = null;
let _chunkQueue    = []; // ArrayBuffers waiting to be appended
let _isAppending   = false;
let _streamEnded   = false;
let _replayChunks  = []; // raw Uint8Arrays collected for replay

// ── Close ──────────────────────────────────────────────────────────────────

function closeGuide() {
  stopAudio();
  if (replayBlobUrl) { URL.revokeObjectURL(replayBlobUrl); replayBlobUrl = null; }
  window.electronAPI.sendGuideClose();
}

closeBtn.addEventListener('click', closeGuide);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeGuide();
});

// ── Audio playback ─────────────────────────────────────────────────────────

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  // Reset streaming state
  _mediaSource  = null;
  _sourceBuffer = null;
  _chunkQueue   = [];
  _isAppending  = false;
  _streamEnded  = false;
}

// Start a MediaSource-backed audio element for streaming playback.
function startStreamingAudio() {
  stopAudio();
  _replayChunks = [];
  _streamEnded  = false;

  _mediaSource = new MediaSource();
  currentAudioUrl = URL.createObjectURL(_mediaSource);
  currentAudio = new Audio(currentAudioUrl);

  _mediaSource.addEventListener('sourceopen', () => {
    _sourceBuffer = _mediaSource.addSourceBuffer('audio/mpeg');
    _sourceBuffer.addEventListener('updateend', () => {
      _isAppending = false;
      flushChunkQueue();
    });
    flushChunkQueue(); // drain any chunks that arrived before sourceopen
  });

  currentAudio.play().catch((err) => {
    console.warn('[Guide] TTS stream play failed:', err.message);
  });
}

function flushChunkQueue() {
  if (_isAppending || !_sourceBuffer) return;

  if (_chunkQueue.length > 0) {
    _isAppending = true;
    _sourceBuffer.appendBuffer(_chunkQueue.shift());
    return;
  }

  // Queue empty — if stream is done, close the source.
  if (_streamEnded && _mediaSource && _mediaSource.readyState === 'open') {
    _mediaSource.endOfStream();
    buildReplayBlob();
  }
}

function appendTtsChunk(chunkBase64) {
  const bytes = Uint8Array.from(atob(chunkBase64), (c) => c.charCodeAt(0));
  _replayChunks.push(bytes);
  _chunkQueue.push(bytes.buffer);

  if (!_mediaSource) {
    startStreamingAudio();
  } else {
    flushChunkQueue();
  }
}

function onTtsStreamEnd() {
  _streamEnded = true;
  flushChunkQueue(); // may trigger endOfStream immediately if queue is empty
}

function buildReplayBlob() {
  if (_replayChunks.length === 0) return;
  const blob = new Blob(_replayChunks.map((c) => c.buffer), { type: 'audio/mpeg' });
  if (replayBlobUrl) URL.revokeObjectURL(replayBlobUrl);
  replayBlobUrl = URL.createObjectURL(blob);
  replayBtn.classList.remove('hidden');
}

// Legacy: full-buffer playback (kept for fallback / synthesizeSpeech path)
function playAudio(base64, mimeType) {
  stopAudio();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob  = new Blob([bytes.buffer], { type: mimeType });
  if (replayBlobUrl) URL.revokeObjectURL(replayBlobUrl);
  replayBlobUrl   = URL.createObjectURL(blob);
  currentAudioUrl = URL.createObjectURL(blob);
  currentAudio    = new Audio(currentAudioUrl);
  currentAudio.play().catch((err) => {
    console.warn('[Guide] Audio playback failed:', err.message);
  });
  replayBtn.classList.remove('hidden');
}

replayBtn.addEventListener('click', () => {
  if (!replayBlobUrl) return;
  stopAudio();
  currentAudioUrl = replayBlobUrl; // keep blob alive — don't revoke on stopAudio
  currentAudio    = new Audio(replayBlobUrl);
  currentAudio.play().catch((err) => {
    console.warn('[Guide] Replay failed:', err.message);
  });
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

// Streaming TTS (primary path)
window.electronAPI.onGuideTtsChunk((data) => {
  appendTtsChunk(data.chunkBase64);
});

window.electronAPI.onGuideTtsEnd(() => {
  onTtsStreamEnd();
});

// Legacy full-buffer path (fallback)
window.electronAPI.onGuidePlayAudio((data) => {
  playAudio(data.audioBase64, data.mimeType);
});

window.electronAPI.onGuideError((data) => {
  showError(data.message);
});
