'use strict';

const hudEl         = document.getElementById('hud');
const agentNameEl   = document.getElementById('agent-name');
const phaseBadge    = document.getElementById('phase-badge');
const statusTextEl  = document.getElementById('status-text');
const feed          = document.getElementById('feed');
const feedWrap      = document.getElementById('feed-wrap');
const responsePanel = document.getElementById('response-panel');
const responseText  = document.getElementById('response-text');
const responseLabel = document.getElementById('response-label');
const replayBtn     = document.getElementById('replay-btn');
const voicePill     = document.getElementById('voice-pill');
const ttsText       = document.getElementById('tts-text');
const stopBtn       = document.getElementById('stop-btn');
const closeBtn      = document.getElementById('close-btn');

let activeRowEl = null;
let currentAudio = null;
let currentAudioUrl = null;
let audioQueue = [];
let audioPlaying = false;
let lastReplayBytes = null;
let responseStreaming = false;

const PHASE_MAP = {
  idle:       { cls: 'phase-idle',       label: 'STANDBY',    status: 'Standing by for the next request.' },
  thinking:   { cls: 'phase-thinking',   label: 'THINKING',   status: 'Interpreting the scene and request.' },
  searching:  { cls: 'phase-searching',  label: 'SEARCHING',  status: 'Searching for the right context.' },
  editing:    { cls: 'phase-editing',    label: 'EDITING',    status: 'Preparing controlled changes.' },
  running:    { cls: 'phase-running',    label: 'RUNNING',    status: 'Working through the active task.' },
  responding: { cls: 'phase-responding', label: 'BRIEFING',   status: 'Briefing assembled and ready.' },
  error:      { cls: 'phase-error',      label: 'ERROR',      status: 'Attention required.' },
  done:       { cls: 'phase-done',       label: 'COMPLETE',   status: 'Request complete. Awaiting the next command.' },
};

function setPhase(phase, detail = '') {
  const config = PHASE_MAP[phase] || PHASE_MAP.idle;

  // Drive orb colors via data-phase attribute
  hudEl.dataset.phase = phase;

  phaseBadge.className = config.cls;
  phaseBadge.textContent = config.label;

  // Animated state text transition
  const newText = detail || config.status;
  if (statusTextEl.textContent === newText) return;

  statusTextEl.classList.remove('state-enter');
  statusTextEl.classList.add('state-exit');

  setTimeout(() => {
    statusTextEl.textContent = newText;
    statusTextEl.classList.remove('state-exit');
    void statusTextEl.offsetHeight; // force reflow
    statusTextEl.classList.add('state-enter');
    statusTextEl.addEventListener('animationend', () => {
      statusTextEl.classList.remove('state-enter');
    }, { once: true });
  }, 220);
}

function setVoiceState(mode, text = '') {
  voicePill.className = '';
  voicePill.classList.add(`voice-${mode}`);
  ttsText.textContent = text || (mode === 'error' ? 'Voice output unavailable' : 'Voice standby');
}

function finalizeActiveRow(isError) {
  if (!activeRowEl) return;
  activeRowEl.classList.remove('row-active');
  activeRowEl.classList.add(isError ? 'row-error' : 'row-done');

  const iconEl = activeRowEl.querySelector('.row-icon');
  if (iconEl) {
    iconEl.textContent = isError ? '✗' : '✓';
    iconEl.className = `row-icon ${isError ? 'error' : 'done'}`;
  }

  activeRowEl = null;
}

function addFeedRow(event) {
  finalizeActiveRow(false);

  if (event.type === 'tool_result' || event.type === 'thinking' || event.type === 'response') return;

  const row = document.createElement('div');
  const isMilestone = event.type === 'milestone';
  const isError = event.type === 'error';

  row.className = [
    'feed-row',
    'row-active',
    isMilestone ? 'row-milestone' : '',
    isError ? 'row-error' : '',
  ].filter(Boolean).join(' ');

  const iconEl = document.createElement('span');
  iconEl.className = isError ? 'row-icon error' : 'row-icon spin';
  iconEl.textContent = isError ? '!' : '↻';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'row-body';

  const labelEl = document.createElement('div');
  labelEl.className = 'row-label' + (isMilestone ? ' is-milestone' : '') + (isError ? ' is-error' : '');
  labelEl.textContent = event.label || '';
  bodyEl.appendChild(labelEl);

  if (event.detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'row-detail';
    detailEl.textContent = event.detail;
    bodyEl.appendChild(detailEl);
  }

  row.appendChild(iconEl);
  row.appendChild(bodyEl);
  feed.appendChild(row);

  const emptyEl = document.getElementById('feed-empty');
  if (emptyEl) emptyEl.remove();

  activeRowEl = row;
  feedWrap.scrollTop = feedWrap.scrollHeight;
}

function isNearBottom(element, threshold = 36) {
  return (element.scrollHeight - element.scrollTop - element.clientHeight) <= threshold;
}

function showResponse(text, options = {}) {
  const { streaming = false, final = false } = options;
  finalizeActiveRow(false);
  const shouldFollow = responsePanel.classList.contains('hidden') || isNearBottom(responseText);

  responseStreaming = streaming && !final;
  responsePanel.classList.toggle('is-streaming', responseStreaming);
  responseText.classList.toggle('is-streaming', responseStreaming);
  responseLabel.textContent = responseStreaming ? 'Briefing Live' : 'Briefing';

  if (responseStreaming) {
    responseText.textContent = text || '';
  } else {
    if (typeof window.renderMarkdown === 'function') {
      responseText.innerHTML = window.renderMarkdown(text || '');
    } else {
      responseText.textContent = text;
    }
  }
  responsePanel.classList.remove('hidden');
  hudEl.classList.add('has-response');
  if (shouldFollow) {
    responseText.scrollTop = responseText.scrollHeight;
  }
}

function bytesFromBase64(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function stopCurrentAudio() {
  if (!currentAudio) return;
  currentAudio.pause();
  currentAudio.src = '';
  currentAudio = null;
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

function playAudioBytes(bytes, options = {}) {
  const { keepVoiceState = false } = options;
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);

  stopCurrentAudio();
  currentAudio = audio;
  currentAudioUrl = url;
  audio.volume = 1;
  audio.preload = 'auto';
  setVoiceState('speaking', ttsText.textContent || 'Delivering spoken response');

  audio.onended = () => {
    if (currentAudio === audio) {
      currentAudio = null;
      currentAudioUrl = null;
    }
    URL.revokeObjectURL(url);
    if (!keepVoiceState && !audioQueue.length) {
      audioPlaying = false;
      setVoiceState('standby', 'Voice standby');
    }
    if (audioQueue.length) {
      playNextAudio();
    }
  };

  audio.onerror = () => {
    window.electronAPI.sendAgentTelemetry('error', 'Audio element reported a playback error.');
    if (currentAudio === audio) {
      currentAudio = null;
      currentAudioUrl = null;
    }
    URL.revokeObjectURL(url);
    audioPlaying = false;
    setVoiceState('error', 'Voice output unavailable');
    if (audioQueue.length) {
      playNextAudio();
    }
  };

  audio.play().catch((err) => {
    window.electronAPI.sendAgentTelemetry('error', `Audio playback failed: ${err.message}`);
    if (currentAudio === audio) {
      currentAudio = null;
      currentAudioUrl = null;
    }
    URL.revokeObjectURL(url);
    audioPlaying = false;
    setVoiceState('error', 'Voice output unavailable');
    if (audioQueue.length) {
      playNextAudio();
    }
  });
}

function playNextAudio() {
  if (!audioQueue.length) {
    audioPlaying = false;
    if (!currentAudio) setVoiceState('standby', 'Voice standby');
    return;
  }

  audioPlaying = true;
  playAudioBytes(audioQueue.shift());
}

window.electronAPI.onAgentEvent((event) => {
  switch (event.type) {
    case 'thinking':
      setPhase('thinking', event.detail || '');
      break;

    case 'tool_call': {
      const label = (event.label || '').toLowerCase();
      if (label.includes('search') || label.includes('brows') || label.includes('url')) {
        setPhase('searching', event.detail || '');
      } else if (label.includes('writ') || label.includes('creat') || label.includes('patch') || label.includes('edit')) {
        setPhase('editing', event.detail || '');
      } else {
        setPhase('running', event.detail || '');
      }
      addFeedRow(event);
      break;
    }

    case 'milestone': {
      const label = (event.label || '').toLowerCase();
      if (label.includes('search') || label.includes('brows')) {
        setPhase('searching', event.detail || '');
      } else if (label.includes('writ') || label.includes('creat') || label.includes('edit') || label.includes('patch')) {
        setPhase('editing', event.detail || '');
      } else if (label.includes('run') || label.includes('exec') || label.includes('shell')) {
        setPhase('running', event.detail || '');
      } else {
        setPhase('thinking', event.detail || '');
      }
      addFeedRow(event);
      break;
    }

    case 'tool_result':
      finalizeActiveRow(false);
      break;

    case 'response':
      if (event.streaming === true && event.final !== true) {
        setPhase('responding', 'Streaming the briefing into the console.');
      } else {
        setPhase('responding');
      }
      showResponse(event.detail || event.label || '', {
        streaming: event.streaming === true,
        final: event.final === true,
      });
      break;

    case 'error':
      setPhase('error', event.detail || event.label || '');
      finalizeActiveRow(true);
      addFeedRow(event);
      setVoiceState('error', 'Voice output unavailable');
      break;
  }
});

window.electronAPI.onAgentDone(() => {
  finalizeActiveRow(false);
  setPhase('done');
  if (!audioPlaying) {
    setVoiceState('standby', 'Voice standby');
  }
});

window.electronAPI.onAgentInit((data) => {
  agentNameEl.textContent = (data.assistantName || 'JARVIS').toUpperCase();
  hudEl.dataset.phase = 'idle';
  hudEl.classList.remove('has-response');
  setPhase('idle');
  feed.innerHTML = '<div id="feed-empty">Standing by…</div>';
  responsePanel.classList.add('hidden');
  responseText.textContent = '';
  responsePanel.classList.remove('is-streaming');
  responseText.classList.remove('is-streaming');
  responseStreaming = false;
  replayBtn.classList.add('hidden');
  audioQueue = [];
  audioPlaying = false;
  lastReplayBytes = null;
  stopCurrentAudio();
  setVoiceState('standby', 'Voice standby');
  activeRowEl = null;
});

window.electronAPI.onAgentTts((text) => {
  setVoiceState('speaking', text || 'Delivering spoken response');
});

window.electronAPI.onAgentPlayAudio((data) => {
  const bytes = bytesFromBase64(data.audioBase64);
  lastReplayBytes = bytes;
  replayBtn.classList.remove('hidden');
  audioQueue.push(bytes);
  if (!audioPlaying && !currentAudio) {
    playNextAudio();
  }
});

replayBtn.addEventListener('click', () => {
  if (!lastReplayBytes) return;
  audioQueue = [];
  audioPlaying = false;
  playAudioBytes(lastReplayBytes, { keepVoiceState: false });
});

responseText.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  event.preventDefault();
  window.electronAPI.openExternal(link.href);
});

stopBtn.addEventListener('click', () => {
  window.electronAPI.sendAgentStop();
});

closeBtn.addEventListener('click', () => {
  window.electronAPI.sendAgentStop();
});

[stopBtn, closeBtn, replayBtn].forEach((element) => {
  element.style.webkitAppRegion = 'no-drag';
});

window.addEventListener('beforeunload', () => {
  audioQueue = [];
  stopCurrentAudio();
});
