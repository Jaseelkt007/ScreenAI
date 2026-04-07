'use strict';

/**
 * voice-hud.js — Voice HUD renderer
 *
 * Responsibilities:
 *  - Request microphone access via getUserMedia
 *  - Record audio with MediaRecorder on command from main
 *  - Send final audio bytes (base64) + MIME type back to main
 *  - Display voice state (Listening, Thinking, Speaking, Error)
 *  - Show a live audio level meter while recording
 */

const micIcon     = document.getElementById('mic-icon');
const spinnerIcon = document.getElementById('spinner-icon');
const label       = document.getElementById('label');
const levelFill   = document.getElementById('level-fill');

let mediaRecorder  = null;
let audioChunks    = [];
let audioContext   = null;
let analyser       = null;
let micStream      = null;
let levelRafId     = null;
let isRecording    = false;
let isCancelled    = false; // set true on cancel to suppress the stop-event audio send

// ── State display ──────────────────────────────────────────────────────────

function setState(state, message) {
  label.className = `state-${state}`;
  label.textContent = message || stateLabel(state);

  const isThinking = (state === 'transcribing' || state === 'capturing' || state === 'analyzing');
  micIcon.classList.toggle('hidden', isThinking);
  spinnerIcon.classList.toggle('hidden', !isThinking);

  micIcon.className = state === 'recording' ? 'recording'
                    : state === 'error'     ? 'error'
                    : '';

  if (state !== 'recording') stopLevelMeter();
}

function stateLabel(state) {
  const LABELS = {
    idle:          'Ready',
    recording:     'Listening…',
    transcribing:  'Transcribing…',
    capturing:     'Capturing…',
    analyzing:     'Thinking…',
    showing_result:'Done',
    speaking:      'Speaking…',
    error:         'Error',
  };
  return LABELS[state] || state;
}

// ── Level meter ────────────────────────────────────────────────────────────

function startLevelMeter(stream) {
  if (audioContext) { audioContext.close(); audioContext = null; }

  audioContext = new AudioContext();
  analyser     = audioContext.createAnalyser();
  analyser.fftSize = 256;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((s, v) => s + v, 0) / data.length;
    levelFill.style.width = `${Math.min(100, avg * 1.8)}%`;
    levelRafId = requestAnimationFrame(tick);
  }
  levelRafId = requestAnimationFrame(tick);
}

function stopLevelMeter() {
  if (levelRafId) { cancelAnimationFrame(levelRafId); levelRafId = null; }
  levelFill.style.width = '0%';
  if (audioContext) { audioContext.close(); audioContext = null; analyser = null; }
}

// ── Microphone access ──────────────────────────────────────────────────────

async function getMic() {
  if (micStream) return micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return micStream;
  } catch (err) {
    throw new Error(`Microphone access denied: ${err.message}`);
  }
}

function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

// ── Recording ──────────────────────────────────────────────────────────────

async function startRecording() {
  if (isRecording) return;
  isCancelled = false;

  let stream;
  try {
    stream = await getMic();
  } catch (err) {
    setState('error', 'Mic denied');
    window.electronAPI.sendVoiceError(err.message);
    return;
  }

  audioChunks = [];

  // Prefer webm/opus, fall back to browser default
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

  const options = mimeType ? { mimeType } : {};

  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    setState('error', 'Recorder error');
    window.electronAPI.sendVoiceError(`MediaRecorder init failed: ${err.message}`);
    return;
  }

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  });

  mediaRecorder.addEventListener('stop', () => {
    isRecording = false;
    stopLevelMeter();

    // If the session was cancelled, discard audio — do not send to main.
    if (isCancelled) {
      audioChunks = [];
      return;
    }

    const finalMime = mediaRecorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: finalMime });

    if (blob.size === 0) {
      window.electronAPI.sendVoiceError('Empty recording — no audio captured.');
      return;
    }

    // Convert Blob to base64 for IPC transfer
    const reader = new FileReader();
    reader.onloadend = () => {
      // result is "data:audio/webm;base64,XXXX"
      const base64 = reader.result.split(',')[1];
      window.electronAPI.sendVoiceAudioReady(base64, finalMime);
    };
    reader.readAsDataURL(blob);
  });

  mediaRecorder.addEventListener('error', (e) => {
    isRecording = false;
    setState('error', 'Record error');
    window.electronAPI.sendVoiceError(`MediaRecorder error: ${e.error?.message || 'unknown'}`);
  });

  mediaRecorder.start(100); // collect chunks every 100ms
  isRecording = true;
  startLevelMeter(stream);
  setState('recording');
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) return;
  mediaRecorder.stop();
  // state will update via the 'stop' event → audio-ready sent to main
}

function cancelRecording() {
  isCancelled = true; // guard the stop event — don't send audio to main
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
  }
  isRecording = false;
  audioChunks = [];
  stopLevelMeter();
  releaseMic();
  setState('idle');
}

// ── IPC listeners ──────────────────────────────────────────────────────────

window.electronAPI.onVoiceState((data) => {
  setState(data.state, data.message || null);
});

window.electronAPI.onVoiceStartRecording(() => {
  startRecording();
});

window.electronAPI.onVoiceStopRecording(() => {
  stopRecording();
});

window.electronAPI.onVoiceCancel(() => {
  cancelRecording();
});

// ── Initial state ──────────────────────────────────────────────────────────
setState('recording'); // HUD opens only when recording starts
