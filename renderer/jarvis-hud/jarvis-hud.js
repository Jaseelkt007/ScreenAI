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
const disambiguateBar    = document.getElementById('disambiguate-bar');
const disambiguatePrompt = document.getElementById('disambiguate-prompt');
const disambiguateList   = document.getElementById('disambiguate-list');
const contextBadge       = document.getElementById('context-badge');
const contextBadgeText   = document.getElementById('context-badge-text');
const resultBar    = document.getElementById('result-bar');
const resultText   = document.getElementById('result-text');
const closeBtn     = document.getElementById('close-btn');
// M5.0 — plan progress
const planProgress       = document.getElementById('plan-progress');
const planProgressStep   = document.getElementById('plan-progress-step');
const planProgressNarr   = document.getElementById('plan-progress-narration');
const planProgressFill   = document.getElementById('plan-progress-fill');
// M5.4 — result panel
const resultPanel        = document.getElementById('result-panel');
const resultPanelTitle   = document.getElementById('result-panel-title');
const resultPanelList    = document.getElementById('result-panel-list');

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

let _unsubStartRec       = null;
let _unsubStopRec        = null;
let _unsubStatus         = null;
let _unsubConfirm        = null;
let _unsubDone           = null;
let _unsubDisambig       = null;
let _unsubContext        = null;
let _unsubAudioAck       = null;       // M4.7
let _unsubAudioNarration = null;       // M5.3
let _unsubPlan           = null;       // M5.0
let _unsubResults        = null;       // M5.4
let _dismissTimer        = null;
let _contextFadeTimer    = null;
let _resultPanelTimer    = null;       // M5.4 — auto-dismiss
let _currentAudio        = null;       // result-tier audio (replaceable)
let _ackAudio            = null;       // M4.7 — ack-tier audio (separate slot)
let _narrationAudio      = null;       // M5.3 — narration-tier audio (separate slot)
let _planTotalSteps      = 0;          // M5.0
let _planActiveCards     = [];         // M5.4 — currently-shown card list

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
    // Keep the disambiguation list visible during idle — user needs to see
    // the choices. It will be cleared on the next successful command or close.
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

  _unsubDisambig = window.jarvis.onDisambiguate((payload) => {
    showDisambiguationList(payload.candidates, payload.listText);
  });

  _unsubContext = window.jarvis.onContext((payload) => {
    showContextBadge(payload);
  });

  // M4.7 — play the short ack TTS in its own audio slot so the upcoming
  // result-tier TTS doesn't cut it off.
  _unsubAudioAck = window.jarvis.onAudioAck((payload) => {
    if (payload && payload.audioBase64 && payload.mimeType) {
      playAckAudio(payload.audioBase64, payload.mimeType);
    }
  });

  // M5.3 — narration-tier audio (per plan step). Yet another slot so a long
  // plan with many narrations doesn't clobber the ack/result tiers.
  if (window.jarvis.onAudioNarration) {
    _unsubAudioNarration = window.jarvis.onAudioNarration((payload) => {
      if (payload && payload.audioBase64 && payload.mimeType) {
        playNarrationAudio(payload.audioBase64, payload.mimeType, payload.volume);
      }
    });
  }

  // M5.0 — plan stream (plan, step.start/done/fail, replan).
  if (window.jarvis.onPlan) {
    _unsubPlan = window.jarvis.onPlan((ev) => handlePlanEvent(ev));
  }

  // M5.4 — result panel cards.
  if (window.jarvis.onResults) {
    _unsubResults = window.jarvis.onResults((payload) => showResultPanel(payload));
  }
}

function unsubscribePipeline() {
  if (_unsubStatus)         { _unsubStatus();         _unsubStatus         = null; }
  if (_unsubConfirm)        { _unsubConfirm();        _unsubConfirm        = null; }
  if (_unsubDone)           { _unsubDone();           _unsubDone           = null; }
  if (_unsubDisambig)       { _unsubDisambig();       _unsubDisambig       = null; }
  if (_unsubContext)        { _unsubContext();        _unsubContext        = null; }
  if (_unsubAudioAck)       { _unsubAudioAck();       _unsubAudioAck       = null; }
  if (_unsubAudioNarration) { _unsubAudioNarration(); _unsubAudioNarration = null; }
  if (_unsubPlan)           { _unsubPlan();           _unsubPlan           = null; }
  if (_unsubResults)        { _unsubResults();        _unsubResults        = null; }
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
  const { ok, display, audioBase64, mimeType, error, disambiguating } = payload;

  hideConfirm();
  hidePlanProgress();
  unsubscribePipeline();
  releaseMic();

  // Disambiguation state: show list and wait for next command; do not auto-dismiss.
  if (disambiguating) {
    transcript.classList.add('hidden');
    setState('idle');
    if (audioBase64 && mimeType) playAudio(audioBase64, mimeType);
    return;
  }

  // On a successful result, clear any lingering disambiguation list.
  if (ok) hideDisambiguationList();

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

// ── Disambiguation list (M4.1) ────────────────────────────────────────────────

function showDisambiguationList(candidates, listText) {
  disambiguateList.innerHTML = '';
  (candidates || []).slice(0, 5).forEach((c) => {
    const li = document.createElement('li');
    li.textContent = c.name;
    disambiguateList.appendChild(li);
  });
  disambiguatePrompt.textContent = 'Which one? Say one, two, or three.';
  disambiguateBar.classList.remove('hidden');
}

function hideDisambiguationList() {
  disambiguateBar.classList.add('hidden');
  disambiguateList.innerHTML = '';
}

// ── Context badge (M4.5) ──────────────────────────────────────────────────────

function showContextBadge(payload) {
  const { file, window: win, ttlMs } = payload;
  const label = file ? file : win;
  if (!label) {
    hideContextBadge();
    return;
  }

  contextBadgeText.textContent = `Context: ${label}`;
  contextBadge.classList.remove('hidden', 'context-fading');

  // Cancel any previous fade timer and schedule a new one
  if (_contextFadeTimer) { clearTimeout(_contextFadeTimer); _contextFadeTimer = null; }

  if (ttlMs > 0) {
    _contextFadeTimer = setTimeout(() => {
      contextBadge.classList.add('context-fading');
      // Remove after fade animation completes (400ms transition)
      setTimeout(() => hideContextBadge(), 400);
    }, ttlMs);
  }
}

function hideContextBadge() {
  if (_contextFadeTimer) { clearTimeout(_contextFadeTimer); _contextFadeTimer = null; }
  contextBadge.classList.add('hidden');
  contextBadge.classList.remove('context-fading');
  contextBadgeText.textContent = '';
}

// ── Plan progress (M5.0) ─────────────────────────────────────────────────────

function handlePlanEvent(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'plan') {
    _planTotalSteps = (ev.steps || []).length;
    showPlanProgress(0, _planTotalSteps, ev.steps && ev.steps[0] ? `Working on "${(ev.goal || '').slice(0, 60)}"…` : 'Planning…');
    // New plan supersedes any prior result panel.
    hideResultPanel();
    return;
  }
  if (ev.type === 'step.start') {
    showPlanProgress(ev.index || 0, _planTotalSteps || (ev.total || 1), ev.narration || `Running ${ev.tool}…`);
    return;
  }
  if (ev.type === 'step.done') {
    showPlanProgress(((ev.index || 0) + 1), _planTotalSteps || (ev.total || 1), '✓');
    return;
  }
  if (ev.type === 'step.fail') {
    showPlanProgress(ev.index || 0, _planTotalSteps || 1, ev.error || 'Step failed');
    return;
  }
  if (ev.type === 'replan') {
    showPlanProgress(ev.index || 0, _planTotalSteps || 1, 'Re-planning…');
    return;
  }
}

function showPlanProgress(stepIdx, totalSteps, narration) {
  const total = Math.max(1, totalSteps || 1);
  planProgressStep.textContent = `Step ${Math.min(stepIdx + 1, total)}/${total}`;
  planProgressNarr.textContent = narration || '';
  const pct = Math.min(100, Math.round((stepIdx / total) * 100));
  planProgressFill.style.width = `${pct}%`;
  planProgress.classList.remove('hidden');
}

function hidePlanProgress() {
  planProgress.classList.add('hidden');
  planProgressFill.style.width = '0%';
  _planTotalSteps = 0;
}

// ── Result panel (M5.4) ──────────────────────────────────────────────────────

function showResultPanel(payload) {
  if (!payload || !Array.isArray(payload.cards) || payload.cards.length === 0) {
    hideResultPanel();
    return;
  }
  const titles = { web: 'Search results', tabs: 'Open tabs', files: 'Files' };
  resultPanelTitle.textContent = titles[payload.kind] || 'Results';
  resultPanelList.innerHTML = '';
  _planActiveCards = payload.cards.slice(0, 9);
  _planActiveCards.forEach((card) => {
    const li = document.createElement('li');
    li.className = 'result-card';
    li.dataset.index = card.index;

    const row = document.createElement('div');
    row.className = 'result-card-row';
    const idx = document.createElement('span');
    idx.className = 'result-card-index';
    idx.textContent = card.index;
    const ttl = document.createElement('span');
    ttl.className = 'result-card-title';
    ttl.textContent = card.title || card.url || card.path || '';
    row.appendChild(idx);
    row.appendChild(ttl);
    li.appendChild(row);

    if (card.snippet) {
      const sn = document.createElement('div');
      sn.className = 'result-card-snippet';
      sn.textContent = card.snippet;
      li.appendChild(sn);
    }
    if (card.url) {
      const u = document.createElement('div');
      u.className = 'result-card-url';
      u.textContent = card.url;
      li.appendChild(u);
    } else if (card.path) {
      const p = document.createElement('div');
      p.className = 'result-card-url';
      p.textContent = card.path;
      li.appendChild(p);
    }

    li.addEventListener('click', () => pickResult(card.index));
    resultPanelList.appendChild(li);
  });
  resultPanel.classList.remove('hidden');

  // Auto-dismiss
  if (_resultPanelTimer) { clearTimeout(_resultPanelTimer); _resultPanelTimer = null; }
  _resultPanelTimer = setTimeout(() => hideResultPanel(), 30000);
}

function hideResultPanel() {
  if (_resultPanelTimer) { clearTimeout(_resultPanelTimer); _resultPanelTimer = null; }
  resultPanel.classList.add('hidden');
  resultPanelList.innerHTML = '';
  _planActiveCards = [];
}

function pickResult(index) {
  if (!index || !_planActiveCards.length) return;
  if (window.jarvis && typeof window.jarvis.pickResult === 'function') {
    window.jarvis.pickResult(index);
    hideResultPanel();
  }
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

// M4.7 — ack TTS plays in its own slot so a fast result-tier playAudio() call
// doesn't cut off the ack mid-word. New ack replaces previous ack (same as
// result-tier behavior — never queue acks).
function playAckAudio(base64, mimeType) {
  try {
    if (_ackAudio) { _ackAudio.pause(); _ackAudio = null; }
    const byteStr = atob(base64);
    const bytes   = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob  = new Blob([bytes], { type: mimeType });
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    _ackAudio = audio;
    audio.play().catch((e) => console.warn('[HUD] Ack play failed:', e.message));
  } catch (err) {
    console.warn('[HUD] Ack decode error:', err.message);
  }
}

// M5.3 — narration TTS plays in its own slot. Volume defaults to 0.6 so a
// narration during a long plan stays underneath the result voice.
function playNarrationAudio(base64, mimeType, volume) {
  try {
    if (_narrationAudio) { _narrationAudio.pause(); _narrationAudio = null; }
    const byteStr = atob(base64);
    const bytes   = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob  = new Blob([bytes], { type: mimeType });
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = typeof volume === 'number' && volume > 0 && volume <= 1 ? volume : 0.6;
    audio.onended = () => URL.revokeObjectURL(url);
    _narrationAudio = audio;
    audio.play().catch((e) => console.warn('[HUD] Narration play failed:', e.message));
  } catch (err) {
    console.warn('[HUD] Narration decode error:', err.message);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetToIdle() {
  cancelDismissTimer();
  unsubscribePipeline();
  if (isRecording) cancelRecording();
  else releaseMic();
  hideDisambiguationList();
  setState('idle');
  if (_textInputVisible) cmdInput.focus();
  // Note: context badge is NOT cleared on idle — it persists until TTL expires
  // or a new command explicitly clears it. This is by design (M4.5).
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

  // M5.4 — keyboard 1–9 → pick result panel card
  if (!resultPanel.classList.contains('hidden') && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    pickResult(Number(e.key));
    return;
  }

  // Alt+T — toggle text input debug fallback
  if (e.altKey && e.key === 't') {
    e.preventDefault();
    showTextInput();
  }

  // Escape when idle → close HUD
  if (e.key === 'Escape' && !isRecording) {
    if (!resultPanel.classList.contains('hidden')) {
      hideResultPanel();
      return;
    }
    window.jarvis.closeHud();
  }
});

// ── IPC: recording commands from main (legacy — recording now lives in PTT HUD) ─

_unsubStartRec = window.jarvis.onStartRecording(() => {
  startRecording();
});

_unsubStopRec = window.jarvis.onStopRecording(() => {
  stopRecording();
});

// ── IPC: open-for-pipeline — fired by main once PTT audio has arrived ─────────
// Recording happens in the PTT HUD, not here. When audio is handed off to the
// pipeline, this signal asks the Jarvis HUD to subscribe to pipeline events
// and show "Transcribing…" while STT runs.
if (window.jarvis.onOpenForPipeline) {
  window.jarvis.onOpenForPipeline(() => {
    cancelDismissTimer();
    hideConfirm();
    hideResultPanel();
    transcript.classList.add('hidden');
    transcript.textContent = '';
    setState('transcribing');
    subscribePipeline();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

setState('idle');
