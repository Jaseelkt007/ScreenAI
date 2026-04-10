/*
 * ScreenAI Desktop Assistant
 * Created by: Mohammed Jaseel Kunnathodika
 * LinkedIn: https://www.linkedin.com/in/jaseelkt/
 */

'use strict';

const hudEl             = document.getElementById('hud');
const screenshotImg     = document.getElementById('screenshot-img');
const questionInput     = document.getElementById('question-input');
const sendBtn           = document.getElementById('send-btn');
const closeBtn          = document.getElementById('close-btn');
const retakeBtn         = document.getElementById('retake-btn');
const chatMessages      = document.getElementById('chat-messages');
const placeholderEl     = document.getElementById('placeholder');
const inputFooter       = document.getElementById('input-footer');
const phaseBadge        = document.getElementById('phase-badge');
const conversationLabel = document.getElementById('conversation-label');
const conversationMeta  = document.getElementById('conversation-meta');
const inputMeta         = document.getElementById('input-meta');
const captureChip       = document.getElementById('capture-chip');
const turnCounter       = document.getElementById('turn-counter');
const turnsUsedEl       = document.getElementById('turns-used');
const turnsMaxEl        = document.getElementById('turns-max');
const sendBtnLabel      = sendBtn.querySelector('.btn-text');

const MAX_TURNS = 3;

let conversation       = [];
let isLoading          = false;
let pendingUserMessage = null;
let currentAIBubble    = null;
let currentAIMessage   = null;
let streamBuffer       = '';

const PHASE_COPY = {
  idle: {
    badgeClass: 'phase-idle',
    badge: 'CAPTURE READY',
    label: 'ANALYSIS FEED',
    meta: 'Awaiting prompt',
    inputMeta: 'Enter to transmit',
    chip: 'REGION LOCKED',
  },
  loading: {
    badgeClass: 'phase-loading',
    badge: 'ANALYZING',
    label: 'BRIEFING LIVE',
    meta: 'Streaming response',
    inputMeta: 'Transmission locked',
    chip: 'VISUAL LOCK ENGAGED',
  },
  done: {
    badgeClass: 'phase-done',
    badge: 'ANALYSIS COMPLETE',
    label: 'ANALYSIS FEED',
    meta: 'Ready for follow-up',
    inputMeta: 'Ready for next prompt',
    chip: 'GROUNDING VERIFIED',
  },
  error: {
    badgeClass: 'phase-error',
    badge: 'ANALYSIS ERROR',
    label: 'ANALYSIS FEED',
    meta: 'Response failed',
    inputMeta: 'Retry available',
    chip: 'RETRY AVAILABLE',
  },
};

turnsMaxEl.textContent = MAX_TURNS;
setOverlayState('idle');

window.electronAPI.onOverlayInit(({ imageDataUrl }) => {
  screenshotImg.src = imageDataUrl;
  questionInput.focus();
  setOverlayState('idle');
});

window.electronAPI.onOverlayChunk(({ chunk }) => {
  if (!currentAIBubble) return;

  const dots = currentAIBubble.querySelector('.thinking-dots');
  if (dots) dots.remove();

  streamBuffer += chunk;
  renderMarkdownInto(currentAIBubble, streamBuffer);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  setOverlayState('loading');
});

window.electronAPI.onOverlayDone(() => {
  if (currentAIBubble) {
    renderMarkdownInto(currentAIBubble, streamBuffer);
  }

  if (pendingUserMessage !== null) {
    conversation.push({ role: 'user', content: pendingUserMessage });
    pendingUserMessage = null;
  }

  if (currentAIBubble && currentAIMessage) {
    conversation.push({ role: 'model', content: streamBuffer });
    currentAIMessage.classList.remove('is-live');
    addCopyButton(currentAIMessage, streamBuffer);
    currentAIBubble  = null;
    currentAIMessage = null;
    streamBuffer     = '';
  }

  const turnCount = conversation.filter((message) => message.role === 'model').length;
  updateTurnCounter(turnCount);

  if (turnCount >= MAX_TURNS) {
    setOverlayState('done', `Turn cap reached: ${MAX_TURNS}/${MAX_TURNS}`);
    showContextLimit();
  } else {
    setOverlayState('done', `Turn ${turnCount} of ${MAX_TURNS} complete`);
    setInputEnabled(true);
  }
});

window.electronAPI.onOverlayError(({ message }) => {
  pendingUserMessage = null;

  if (currentAIBubble && currentAIMessage) {
    const dots = currentAIBubble.querySelector('.thinking-dots');
    if (dots) dots.remove();
    currentAIMessage.classList.remove('is-live');
    currentAIMessage.classList.add('is-error');
    currentAIBubble.textContent = `Error: ${message}`;
    currentAIBubble  = null;
    currentAIMessage = null;
    streamBuffer     = '';
  }

  setOverlayState('error', message);
  setInputEnabled(true);
});

function submitQuestion() {
  const prompt = questionInput.value.trim();
  if (!prompt || isLoading) return;

  hidePlaceholder();
  appendUserMessage(prompt);
  appendThinkingBubble();
  setInputEnabled(false);
  setOverlayState('loading');

  pendingUserMessage = prompt;
  window.electronAPI.sendAsk(prompt, conversation);

  questionInput.value = '';
  questionInput.style.height = 'auto';
}

sendBtn.addEventListener('click', submitQuestion);

questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitQuestion();
  }
});

questionInput.addEventListener('input', () => {
  questionInput.style.height = 'auto';
  questionInput.style.height = `${Math.min(questionInput.scrollHeight, 120)}px`;
});

closeBtn.addEventListener('click', () => window.electronAPI.sendClose());
retakeBtn.addEventListener('click', () => window.electronAPI.sendClose());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.electronAPI.sendClose();
});

chatMessages.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  event.preventDefault();
  window.electronAPI.openExternal(link.href);
});

function setOverlayState(state, detail = '') {
  const config = PHASE_COPY[state] || PHASE_COPY.idle;

  hudEl.dataset.state = state;
  phaseBadge.className = config.badgeClass;
  phaseBadge.textContent = config.badge;
  conversationLabel.textContent = config.label;
  conversationMeta.textContent = detail || config.meta;
  inputMeta.textContent = config.inputMeta;
  captureChip.textContent = config.chip;
}

function appendUserMessage(text) {
  const { messageEl, bubbleEl } = createMessage({
    role: 'user',
    label: 'COMMAND',
    name: 'You',
  });

  bubbleEl.textContent = text;
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendThinkingBubble() {
  streamBuffer = '';

  const { messageEl, bubbleEl } = createMessage({
    role: 'ai',
    label: 'BRIEFING LIVE',
    name: 'ScreenAI',
    live: true,
  });

  bubbleEl.innerHTML = `
    <div class="thinking-dots">
      <span></span><span></span><span></span>
    </div>
  `;

  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  currentAIMessage = messageEl;
  currentAIBubble = bubbleEl;
}

function createMessage({ role, label, name, live = false }) {
  const messageEl = document.createElement('div');
  messageEl.className = ['message', role, live ? 'is-live' : ''].filter(Boolean).join(' ');

  const headEl = document.createElement('div');
  headEl.className = 'message-head';

  const headMainEl = document.createElement('div');
  headMainEl.className = 'message-head-main';

  const labelEl = document.createElement('div');
  labelEl.className = 'message-label';
  labelEl.textContent = label;

  const roleEl = document.createElement('div');
  roleEl.className = 'message-role';
  roleEl.textContent = name;

  headMainEl.appendChild(labelEl);
  headMainEl.appendChild(roleEl);
  headEl.appendChild(headMainEl);

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'message-bubble';

  messageEl.appendChild(headEl);
  messageEl.appendChild(bubbleEl);

  return { messageEl, bubbleEl, headEl };
}

function addCopyButton(messageEl, rawText) {
  const headEl = messageEl.querySelector('.message-head');
  if (!headEl || headEl.querySelector('.copy-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = 'Copy response';
  btn.setAttribute('aria-label', 'Copy response');
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.2" />
      <path d="M2.5 8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v.5"
            stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
    </svg>
    COPY
  `;

  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(rawText).then(() => {
      btn.classList.add('copied');
      btn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 6.5l3 3 5-5" stroke="currentColor"
                stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        COPIED
      `;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.2" />
            <path d="M2.5 8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v.5"
                  stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          COPY
        `;
      }, 1800);
    }).catch(() => {});
  });

  headEl.appendChild(btn);
}

function updateTurnCounter(completedTurns) {
  turnsUsedEl.textContent = completedTurns;

  if (completedTurns === 0) {
    turnCounter.classList.add('hidden');
  } else {
    turnCounter.classList.remove('hidden');
  }

  turnCounter.classList.toggle('is-warning', completedTurns >= MAX_TURNS - 1);
}

function showContextLimit() {
  inputFooter.classList.add('hidden');

  const existing = document.getElementById('context-limit');
  if (existing) return;

  const notice = document.createElement('div');
  notice.id = 'context-limit';
  notice.innerHTML = `
    <p>Conversation limit reached. Start a new screenshot to continue with fresh context.</p>
    <button id="new-screenshot-btn">NEW SCREENSHOT</button>
  `;

  chatMessages.appendChild(notice);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  document.getElementById('new-screenshot-btn')
    .addEventListener('click', () => window.electronAPI.sendClose());
}

function hidePlaceholder() {
  placeholderEl.classList.add('hidden');
}

function setInputEnabled(enabled) {
  isLoading = !enabled;
  sendBtn.disabled = !enabled;
  questionInput.disabled = !enabled;
  sendBtnLabel.textContent = enabled ? 'ANALYZE' : 'LIVE';

  if (enabled) {
    questionInput.focus();
  }
}

function renderMarkdownInto(element, text) {
  if (typeof window.renderMarkdown === 'function') {
    element.innerHTML = window.renderMarkdown(text);
  } else {
    element.textContent = text;
  }
}
