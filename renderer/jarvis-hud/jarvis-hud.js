'use strict';

/**
 * jarvis-hud.js — Jarvis HUD renderer (M3 — full voice).
 *
 * Voice flow:
 *   main sends jarvis:start-recording → startRecording()
 *   main sends jarvis:stop-recording  → stopRecording()
 *   stop event fires → encode blob → jarvis.sendAudio()
 *   pipeline runs → jarvis:status events update HUD
 *   jarvis:done → show result → auto-dismiss → resetToIdle()
 *
 * Debug fallback: toggle text input with Alt+T (kept for development).
 *
 * IPC surface (window.jarvis — from preload.js):
 *   sendAudio({ audioBase64, mimeType })
 *   sendText(text)           — debug fallback
 *   replyConfirm(bool)
 *   closeHud()
 *   onStartRecording(fn)     → unsub
 *   onStopRecording(fn)      → unsub
 *   onStatus(fn)             → unsub
 *   onConfirm(fn)            → unsub
 *   onDone(fn)               → unsub
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────

const orb          = document.getElementById('orb');
const statusLabel  = document.getElementById('status-label');
const listenRow    = document.getElementById('listen-row');
const levelFill    = document.getElementById('level-fill');
const stopBtn      = document.getElementById('stop-btn');
const transcript   = document.getElementById('transcript');
const inputRow     = document.getElementById('input-row');
const cmdInput     = document.getElementById('cmd-input');
const sendBtn      = document.getElementById('send-btn');
const confirmBar   = document.getElementById('confirm-bar');
const confirmMsg   = document.getElementById('confirm-msg');
const confirmOkBtn = document.getElementById('confirm-ok-btn');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const resultBar    = document.getElementById('result-bar');
const resultText   = document.getElementById('result-text');
const closeBtn     = document.getElementById('close-btn');

// ── Recording state ───────────────────────────────────────────────────────────

let mediaRecorder  = null;
let audioChunks    = [];
let audioContext   = null;
let analyser       = null;
let micStream      = null;
let levelRafId     = null;
let isRecording    = false;
let isCancelled    = false;

// ── Pipeline IPC state ────────────────────────────────────────────────────────

let _unsubStartRec = null;
let _unsubStopRec  = null;
let _unsubStatus   = null;
let _unsubConfirm  = null;
let _unsubDone     = null;
let _dismissTimer  = null;
let _currentAudio  = null;

// ── State machine ─────────────────────────────────────────────────────────────

const STATE_CONFIG = {
  idle:        { orb: 'orb-idle',      label: 'Jarvis' },
  listening:   { orb: 'orb-listening', label: 'Listening…' },
  transcribing:{ orb: 'orb-active',    label: 'Transcribing…' },
  classifying: { orb: 'orb-active',    label: 'Thinking…' },
  executing:   { orb: 'orb-executing', label: 'Working…' },
  verifying:   { orb: 'orb-executing', label: 'Verifying…' },
  speaking:    { orb: 'orb-active',    label: 'Speaking…' },
  done:        { orb: 'orb-done',      label: 'Done' },
  error:       { orb: 'orb-error',     label: 'Error' },
};

function setState(state, labelOverride) {
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.idle;

  orb.className = cfg.orb;
  statusLabel.textContent = labelOverride || cfg.label;

  // Show/hide secondary rows
  const isListening  = state === 'listening';
  const isPipeline   = ['transcribing','classifying','executing','verifying','speaking'].includes(state);
  const isIdle       = state === 'idle';

  listenRow.classList.toggle('hidden', !isListening);
  transcript.classList.toggle('hidden', !isPipeline || !transcript.textContent);
  inputRow.classList.toggle('hidden', !_textInputVisible);

  if (isIdle) {
    resultBar.classList.add('hidden');
    resultBar.className = 'hidden';
    confirmBar.classList.add('hidden');
    transcript.classList.add('hidden');
    transcript.textContent = '';
    cancelDismissTimer();
  }
}

// ── Microphone access ─────────────────────────────────────────────────────────

async function getMic() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return micStream;
}

function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

// ── Level meter ───────────────────────────────────────────────────────────────

function startLevelMeter(stream) {
  stopLevelMeter();
  audioContext = new AudioContext();
  analyser     = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(stream).connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((s, v) => s + v, 0) / data.length;
    levelFill.style.width = `${Math.min(100, avg * 2.0)}%`;
    levelRafId = requestAnimationFrame(tick);
  }
  levelRafId = requestAnimationFrame(tick);
}

function stopLevelMeter() {
  if (levelRafId) { cancelAnimationFrame(levelRafId); levelRafId = null; }
  levelFill.style.width = '0%';
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; analyser = null; }
}

// ── Recording ─────────────────────────────────────────────────────────────────

async function startRecording() {
  if (isRecording) return;

  isCancelled = false;
  audioChunks = [];

  let stream;
  try {
    stream = await getMic();
  } catch (err) {
    setState('error', 'Mic denied');
    console.error('[HUD] Mic access denied:', err.message);
    return;
  }

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

  try {
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch (err) {
    setState('error', 'Recorder error');
    console.error('[HUD] MediaRecorder init failed:', err.message);
    return;
  }

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  });

  mediaRecorder.addEventListener('stop', () => {
    isRecording = false;
    stopLevelMeter();

    if (isCancelled) {
      audioChunks = [];
      return;
    }

    const finalMime = mediaRecorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: finalMime });

    if (blob.size === 0) {
      setState('error', 'No audio captured');
      return;
    }

    // Show transcribing state while main calls STT
    setState('transcribing');
    subscribePipeline();

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      window.jarvis.sendAudio({ audioBase64: base64, mimeType: finalMime });
    };
    reader.readAsDataURL(blob);
  });

  mediaRecorder.addEventListener('error', (e) => {
    isRecording = false;
    stopLevelMeter();
    setState('error', 'Record error');
    console.error('[HUD] MediaRecorder error:', e.error?.message || 'unknown');
  });

  mediaRecorder.start(100); // collect chunks every 100ms
  isRecording = true;
  startLevelMeter(stream);
  setState('listening');
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) return;
  mediaRecorder.stop();
  // rest handled in the 'stop' event listener above
}

function cancelRecording() {
  isCancelled = true;
  if (mediaRecorder && isRecording) mediaRecorder.stop();
  isRecording = false;
  audioChunks = [];
  stopLevelMeter();
  releaseMic();
  setState('idle');
}

// ── Pipeline IPC subscriptions ────────────────────────────────────────────────

function subscribePipeline() {
  unsubscribePipeline();

  _unsubStatus = window.jarvis.onStatus((payload) => {
    const { phase, transcript: t, intent, step } = payload;
    if (t) {
      transcript.textContent = `"${t}"`;
      transcript.classList.remove('hidden');
    }
    setState(phase, buildPhaseLabel(phase, intent, step));
  });

  _unsubConfirm = window.jarvis.onConfirm((payload) => {
    showConfirm(payload.message, payload.actionLabel);
  });

  _unsubDone = window.jarvis.onDone((payload) => {
    handleDone(payload);
  });
}

function unsubscribePipeline() {
  if (_unsubStatus)  { _unsubStatus();  _unsubStatus  = null; }
  if (_unsubConfirm) { _unsubConfirm(); _unsubConfirm = null; }
  if (_unsubDone)    { _unsubDone();    _unsubDone    = null; }
}

function buildPhaseLabel(phase, intent, step) {
  const stepPrefix = step ? `[${step}] ` : '';
  const map = {
    transcribing: 'Transcribing…',
    classifying:  step ? `${stepPrefix}Thinking…` : 'Thinking…',
    executing:    intent ? `${stepPrefix}${intent.split('.')[1] || 'action'}…` : 'Working…',
    verifying:    step ? `${stepPrefix}Verifying…` : 'Verifying…',
    speaking:     'Speaking…',
  };
  return map[phase] || phase;
}

// ── Confirm flow ──────────────────────────────────────────────────────────────

function showConfirm(message, actionLabel) {
  confirmMsg.textContent = message;
  confirmOkBtn.textContent = actionLabel ? `${actionLabel} ↵` : 'Confirm ↵';
  confirmBar.classList.remove('hidden');
  confirmOkBtn.focus();
}

function hideConfirm() {
  confirmBar.classList.add('hidden');
}

function sendConfirm(ok) {
  hideConfirm();
  window.jarvis.replyConfirm(ok);
}

// ── Done handling ─────────────────────────────────────────────────────────────

function handleDone(payload) {
  const { ok, display, audioBase64, mimeType, error } = payload;

  hideConfirm();
  unsubscribePipeline();
  releaseMic();

  const displayText = display || (ok ? 'Done.' : error || 'Error.');
  resultText.textContent = displayText;
  resultBar.className = ok ? 'result-ok' : 'result-error';
  resultBar.classList.remove('hidden');
  transcript.classList.add('hidden');
  setState(ok ? 'done' : 'error');

  if (audioBase64 && mimeType) playAudio(audioBase64, mimeType);

  const delay = ok ? 3000 : 5000;
  cancelDismissTimer();
  _dismissTimer = setTimeout(() => resetToIdle(), delay);
}

// ── Audio playback ────────────────────────────────────────────────────────────

function playAudio(base64, mimeType) {
  try {
    if (_currentAudio) { _currentAudio.pause(); _currentAudio = null; }
    const byteStr = atob(base64);
    const bytes   = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob  = new Blob([bytes], { type: mimeType });
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    _currentAudio = audio;
    audio.play().catch((e) => console.warn('[HUD] Audio play failed:', e.message));
  } catch (err) {
    console.warn('[HUD] Audio decode error:', err.message);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetToIdle() {
  cancelDismissTimer();
  unsubscribePipeline();
  if (isRecording) cancelRecording();
  else releaseMic();
  setState('idle');
  if (_textInputVisible) cmdInput.focus();
}

function cancelDismissTimer() {
  if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }
}

// ── Text input debug fallback ─────────────────────────────────────────────────

let _textInputVisible = false;

function showTextInput() {
  _textInputVisible = true;
  inputRow.classList.remove('hidden');
  cmdInput.focus();
}

function submitCommand() {
  const text = cmdInput.value.trim();
  if (!text) return;
  cmdInput.value = '';
  cmdInput.disabled = true;
  sendBtn.disabled  = true;
  setState('classifying');
  subscribePipeline();
  window.jarvis.sendText(text);
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Stop button — same as second F9 press
stopBtn.addEventListener('click', () => stopRecording());

// Confirm
confirmOkBtn.addEventListener('click', () => sendConfirm(true));
confirmCancelBtn.addEventListener('click', () => sendConfirm(false));

// Close
closeBtn.addEventListener('click', () => {
  if (isRecording) cancelRecording();
  window.jarvis.closeHud();
});

// Text input (debug)
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCommand();
  if (e.key === 'Escape') window.jarvis.closeHud();
});
sendBtn.addEventListener('click', submitCommand);

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Confirmation shortcuts
  if (!confirmBar.classList.contains('hidden')) {
    if (e.key === 'Enter')  { e.preventDefault(); sendConfirm(true);  return; }
    if (e.key === 'Escape') { e.preventDefault(); sendConfirm(false); return; }
  }

  // Alt+T — toggle text input debug fallback
  if (e.altKey && e.key === 't') {
    e.preventDefault();
    showTextInput();
  }

  // Escape when idle → close HUD
  if (e.key === 'Escape' && !isRecording) {
    window.jarvis.closeHud();
  }
});

// ── IPC: recording commands from main ─────────────────────────────────────────

// Store unsubscribers for recording listeners (persistent across sessions)
_unsubStartRec = window.jarvis.onStartRecording(() => {
  startRecording();
});

_unsubStopRec = window.jarvis.onStopRecording(() => {
  stopRecording();
});

// ── Init ──────────────────────────────────────────────────────────────────────

setState('idle');
