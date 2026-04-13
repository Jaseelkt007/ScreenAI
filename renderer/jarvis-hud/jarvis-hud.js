'use strict';

/**
 * jarvis-hud.js — Jarvis HUD renderer.
 *
 * M2 mode: text input for command entry (no microphone recording).
 * M3 will add MediaRecorder and remove/hide the text input.
 *
 * State machine:
 *   idle → classifying → executing → verifying → speaking → done | error
 *
 * IPC surface (via window.jarvis — set up in preload.js):
 *   window.jarvis.sendText(text)        — send typed command to main
 *   window.jarvis.replyConfirm(bool)    — confirm/cancel response
 *   window.jarvis.onStatus(fn)          → unsubscribe fn
 *   window.jarvis.onConfirm(fn)         → unsubscribe fn
 *   window.jarvis.onDone(fn)            → unsubscribe fn
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────

const orb          = document.getElementById('orb');
const statusLabel  = document.getElementById('status-label');
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

// ── State ─────────────────────────────────────────────────────────────────────

let _unsubStatus  = null;
let _unsubConfirm = null;
let _unsubDone    = null;
let _dismissTimer = null;
let _currentAudio = null;

// ── State machine ─────────────────────────────────────────────────────────────

const STATE_CONFIG = {
  idle:        { orb: 'orb-idle',      label: 'Jarvis' },
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

  // Show/hide input row: only when idle (waiting for command)
  inputRow.classList.toggle('hidden', state !== 'idle');

  // Hide result bar on new run
  if (state === 'idle') {
    resultBar.classList.add('hidden');
    resultBar.className = 'hidden';
    transcript.classList.add('hidden');
    transcript.textContent = '';
    confirmBar.classList.add('hidden');
    cancelDismissTimer();
  }
}

// ── IPC subscription ─────────────────────────────────────────────────────────

function subscribeAll() {
  // Guard: remove any stale listeners from a previous pipeline run
  unsubscribeAll();

  _unsubStatus = window.jarvis.onStatus((payload) => {
    const { phase, transcript: t, intent } = payload;

    // Show transcript preview once we have it
    if (t) {
      transcript.textContent = `"${t}"`;
      transcript.classList.remove('hidden');
    }

    setState(phase, buildPhaseLabel(phase, intent));
  });

  _unsubConfirm = window.jarvis.onConfirm((payload) => {
    showConfirm(payload.message, payload.actionLabel);
  });

  _unsubDone = window.jarvis.onDone((payload) => {
    handleDone(payload);
  });
}

function unsubscribeAll() {
  if (_unsubStatus)  { _unsubStatus();  _unsubStatus  = null; }
  if (_unsubConfirm) { _unsubConfirm(); _unsubConfirm = null; }
  if (_unsubDone)    { _unsubDone();    _unsubDone    = null; }
}

function buildPhaseLabel(phase, intent) {
  const LABELS = {
    transcribing: 'Transcribing…',
    classifying:  'Thinking…',
    executing:    intent ? `Running ${intent.split('.')[1] || 'action'}…` : 'Working…',
    verifying:    'Verifying…',
    speaking:     'Speaking…',
  };
  return LABELS[phase] || phase;
}

// ── Command submission ────────────────────────────────────────────────────────

function submitCommand() {
  const text = cmdInput.value.trim();
  if (!text) return;

  cmdInput.value = '';
  cmdInput.disabled = true;
  sendBtn.disabled  = true;

  setState('classifying');
  subscribeAll(); // set up listeners before main starts sending

  window.jarvis.sendText(text);
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

  // Clear confirm if still showing
  hideConfirm();

  // Show result bar
  const displayText = display || (ok ? 'Done.' : error || 'Error.');
  resultText.textContent = displayText;
  resultBar.className = ok ? 'result-ok' : 'result-error';
  resultBar.classList.remove('hidden');
  transcript.classList.add('hidden');

  setState(ok ? 'done' : 'error', ok ? 'Done' : 'Error');

  // Play TTS audio if provided
  if (audioBase64 && mimeType) {
    playAudio(audioBase64, mimeType);
  }

  // Auto-dismiss after 3s on success, 5s on error
  const delay = ok ? 3000 : 5000;
  cancelDismissTimer();
  _dismissTimer = setTimeout(() => resetToIdle(), delay);
}

// ── Audio playback ────────────────────────────────────────────────────────────

function playAudio(base64, mimeType) {
  try {
    if (_currentAudio) {
      _currentAudio.pause();
      _currentAudio = null;
    }
    const byteStr = atob(base64);
    const bytes   = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const url  = URL.createObjectURL(blob);
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
  unsubscribeAll();
  cmdInput.disabled = false;
  sendBtn.disabled  = false;
  setState('idle');
  cmdInput.focus();
}

function cancelDismissTimer() {
  if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }
}

// ── Event listeners ───────────────────────────────────────────────────────────

cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCommand();
  if (e.key === 'Escape') window.jarvis.closeHud();
});

sendBtn.addEventListener('click', submitCommand);

closeBtn.addEventListener('click', () => window.jarvis.closeHud());

// Keyboard shortcuts for confirmation
document.addEventListener('keydown', (e) => {
  if (confirmBar.classList.contains('hidden')) return;

  if (e.key === 'Enter') { e.preventDefault(); sendConfirm(true); }
  if (e.key === 'Escape') { e.preventDefault(); sendConfirm(false); }
});

confirmOkBtn.addEventListener('click', () => sendConfirm(true));
confirmCancelBtn.addEventListener('click', () => sendConfirm(false));

// ── Init ──────────────────────────────────────────────────────────────────────

setState('idle');
cmdInput.focus();
