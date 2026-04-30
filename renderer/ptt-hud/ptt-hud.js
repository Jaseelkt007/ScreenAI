'use strict';

/**
 * ptt-hud.js — Push-to-talk HUD renderer.
 *
 * Owns the mic for the duration of a Right-Alt hold. Renders a real-mic-driven
 * waveform. On stop, encodes the recording and pushes it through the existing
 * `jarvis:audio` channel so the rest of the pipeline is unchanged.
 *
 * IPC (from main):
 *   ptt:start   — begin recording
 *   ptt:stop    — stop recording, encode, send audio
 *   ptt:cancel  — drop recording (anti-tap), no audio sent
 */

const bars = Array.from(document.querySelectorAll('.bar'));

let mediaRecorder = null;
let audioChunks   = [];
let audioContext  = null;
let analyser      = null;
let micStream     = null;
let levelRafId    = null;
let isRecording   = false;
let isCancelled   = false;
let warmStream    = null;

// ── Visibility ────────────────────────────────────────────────────────────────

function showPill() {
  document.body.classList.add('visible');
}

function hidePill() {
  document.body.classList.remove('visible');
}

// ── Mic ───────────────────────────────────────────────────────────────────────

async function getMic() {
  if (warmStream && warmStream.getAudioTracks().some((t) => t.readyState === 'live')) {
    return warmStream;
  }
  warmStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return warmStream;
}

function releaseMic() {
  if (warmStream) {
    warmStream.getTracks().forEach((t) => t.stop());
    warmStream = null;
  }
  micStream = null;
}

// ── Visualizer ────────────────────────────────────────────────────────────────

function startVisualizer(stream) {
  stopVisualizer();
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.55;
  audioContext.createMediaStreamSource(stream).connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  const N = bars.length;

  // Sample N evenly-spaced bins from the lower 2/3 of the spectrum (where
  // most voice energy lives). Skip the very lowest bins (DC / room rumble).
  const usableEnd = Math.floor(data.length * 0.7);
  const skip = 2;
  const step = Math.max(1, Math.floor((usableEnd - skip) / N));

  function tick() {
    analyser.getByteFrequencyData(data);
    for (let i = 0; i < N; i++) {
      const v = data[skip + i * step] || 0;
      const norm = Math.min(1, v / 200);
      const h = 3 + Math.round(norm * 18);
      bars[i].style.height = `${h}px`;
    }
    levelRafId = requestAnimationFrame(tick);
  }
  levelRafId = requestAnimationFrame(tick);
}

function stopVisualizer() {
  if (levelRafId) {
    cancelAnimationFrame(levelRafId);
    levelRafId = null;
  }
  for (const b of bars) b.style.height = '3px';
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
}

// ── Recording ────────────────────────────────────────────────────────────────

async function startRecording() {
  if (isRecording) return;
  isCancelled = false;
  audioChunks = [];

  let stream;
  try {
    stream = await getMic();
  } catch (err) {
    console.error('[PTT] Mic access denied:', err.message);
    hidePill();
    return;
  }
  micStream = stream;

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

  try {
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch (err) {
    console.error('[PTT] MediaRecorder init failed:', err.message);
    hidePill();
    return;
  }

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  });

  mediaRecorder.addEventListener('stop', () => {
    isRecording = false;
    stopVisualizer();
    hidePill();

    if (isCancelled) {
      audioChunks = [];
      return;
    }

    const finalMime = mediaRecorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: finalMime });

    if (blob.size === 0) {
      console.warn('[PTT] Empty recording — discarding');
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      window.jarvis.sendAudio({ audioBase64: base64, mimeType: finalMime });
    };
    reader.readAsDataURL(blob);
  });

  mediaRecorder.addEventListener('error', (e) => {
    isRecording = false;
    stopVisualizer();
    hidePill();
    console.error('[PTT] MediaRecorder error:', e.error?.message || 'unknown');
  });

  mediaRecorder.start(100);
  isRecording = true;
  startVisualizer(stream);
  showPill();
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) return;
  mediaRecorder.stop();
}

function cancelRecording() {
  isCancelled = true;
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
  } else {
    stopVisualizer();
    hidePill();
  }
  isRecording = false;
  audioChunks = [];
}

// ── IPC wiring ────────────────────────────────────────────────────────────────

window.ptt.onStart(() => {
  void startRecording();
});

window.ptt.onStop(() => {
  stopRecording();
});

window.ptt.onCancel(() => {
  cancelRecording();
});

// Release the mic when the window is being torn down so Windows drops the
// in-use indicator cleanly.
window.addEventListener('beforeunload', () => {
  releaseMic();
});
