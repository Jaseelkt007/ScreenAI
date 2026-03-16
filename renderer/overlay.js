/*
 * ScreenAI Desktop Assistant
 * Created by: Mohammed Jaseel Kunnathodika
 * LinkedIn: https://www.linkedin.com/in/jaseelkt/
 */

'use strict';

/**
 * overlay.js — Renderer logic for the split-layout ask/answer overlay.
 *
 * Features:
 *   - Markdown rendering for AI responses (via markdown.js)
 *   - Streaming text into AI bubbles in real-time
 *   - Chat history (up to MAX_TURNS turns) with turn counter
 *   - Copy-to-clipboard button per AI message
 *   - Dark / Light theme toggle (persisted via localStorage)
 */

// ── DOM references ────────────────────────────────────────────────────────
const screenshotImg = document.getElementById('screenshot-img');
const questionInput = document.getElementById('question-input');
const sendBtn       = document.getElementById('send-btn');
const closeBtn      = document.getElementById('close-btn');
const retakeBtn     = document.getElementById('retake-btn');
const themeBtn      = document.getElementById('theme-btn');
const chatMessages  = document.getElementById('chat-messages');
const placeholderEl = document.getElementById('placeholder');
const inputFooter   = document.getElementById('input-footer');
const turnCounter   = document.getElementById('turn-counter');
const turnsUsedEl   = document.getElementById('turns-used');

// ── Conversation state ────────────────────────────────────────────────────
const MAX_TURNS = 3;

/** Completed exchanges: [{role:'user'|'model', content:'...'}] */
let conversation       = [];
let isLoading          = false;
let pendingUserMessage = null;   // prompt for the in-flight request
let currentAIBubble    = null;   // <div.message-bubble> being streamed into
let streamBuffer       = '';     // raw text accumulator for current AI response

// ── Theme ─────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  const app = document.getElementById('app');
  if (theme === 'light') {
    app.setAttribute('data-theme', 'light');
  } else {
    app.removeAttribute('data-theme');
  }
}

// Restore saved theme before first paint.
const savedTheme = localStorage.getItem('screenai-theme') || 'dark';
applyTheme(savedTheme);

themeBtn.addEventListener('click', () => {
  const current = document.getElementById('app').getAttribute('data-theme') === 'light'
    ? 'light' : 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('screenai-theme', next);
});

// ── Init ──────────────────────────────────────────────────────────────────

window.electronAPI.onOverlayInit(({ imageDataUrl }) => {
  screenshotImg.src = imageDataUrl;
  questionInput.focus();
});

// ── Streaming handlers ────────────────────────────────────────────────────

window.electronAPI.onOverlayChunk(({ chunk }) => {
  if (!currentAIBubble) return;

  // Remove thinking dots on first real content.
  const dots = currentAIBubble.querySelector('.thinking-dots');
  if (dots) dots.remove();

  streamBuffer += chunk;
  // Render markdown progressively. Unclosed code fences show as text
  // during streaming and snap into proper blocks once the fence closes.
  currentAIBubble.innerHTML = window.renderMarkdown(streamBuffer);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

window.electronAPI.onOverlayDone(() => {
  // Finalize: re-render the complete content as clean markdown.
  if (currentAIBubble) {
    currentAIBubble.innerHTML = window.renderMarkdown(streamBuffer);
  }

  // Commit exchange to history.
  if (pendingUserMessage !== null) {
    conversation.push({ role: 'user',  content: pendingUserMessage });
    pendingUserMessage = null;
  }
  if (currentAIBubble) {
    conversation.push({ role: 'model', content: streamBuffer });
    addCopyButton(currentAIBubble.closest('.message'), streamBuffer);
    currentAIBubble = null;
    streamBuffer    = '';
  }

  // Update turn counter.
  const turnCount = conversation.filter(m => m.role === 'model').length;
  updateTurnCounter(turnCount);

  if (turnCount >= MAX_TURNS) {
    showContextLimit();
  } else {
    setInputEnabled(true);
  }
});

window.electronAPI.onOverlayError(({ message }) => {
  pendingUserMessage = null;

  if (currentAIBubble) {
    const dots = currentAIBubble.querySelector('.thinking-dots');
    if (dots) dots.remove();
    currentAIBubble.textContent = `Error: ${message}`;
    currentAIBubble.closest('.message').classList.add('is-error');
    currentAIBubble = null;
    streamBuffer    = '';
  }

  setInputEnabled(true);
});

// ── Submit ────────────────────────────────────────────────────────────────

function submitQuestion() {
  const prompt = questionInput.value.trim();
  if (!prompt || isLoading) return;

  hidePlaceholder();
  appendUserMessage(prompt);
  appendThinkingBubble();
  setInputEnabled(false);

  pendingUserMessage = prompt;
  window.electronAPI.sendAsk(prompt, conversation);

  questionInput.value        = '';
  questionInput.style.height = 'auto';
}

sendBtn.addEventListener('click', submitQuestion);

questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitQuestion();
  }
});

questionInput.addEventListener('input', () => {
  questionInput.style.height = 'auto';
  questionInput.style.height = `${Math.min(questionInput.scrollHeight, 96)}px`;
});

// ── Close / Retake ────────────────────────────────────────────────────────

closeBtn.addEventListener('click',  () => window.electronAPI.sendClose());
retakeBtn.addEventListener('click', () => window.electronAPI.sendClose());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.electronAPI.sendClose();
});

// ── Chat DOM helpers ──────────────────────────────────────────────────────

function appendUserMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'message user';
  msg.innerHTML = `
    <div class="message-label">You</div>
    <div class="message-bubble">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendThinkingBubble() {
  streamBuffer = '';

  const msg = document.createElement('div');
  msg.className = 'message ai';

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'ScreenAI';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = `
    <div class="thinking-dots">
      <span></span><span></span><span></span>
    </div>
  `;

  msg.appendChild(label);
  msg.appendChild(bubble);
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  currentAIBubble = bubble;
}

/**
 * Add a copy-to-clipboard button below a completed AI message.
 * @param {HTMLElement} msgEl     - The .message.ai container element.
 * @param {string}      rawText   - The raw markdown text to copy.
 */
function addCopyButton(msgEl, rawText) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = 'Copy response';
  btn.setAttribute('aria-label', 'Copy response');
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="4" y="4" width="7" height="7" rx="1.5"
            stroke="currentColor" stroke-width="1.2"/>
      <path d="M2.5 8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v.5"
            stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
    Copy
  `;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(rawText).then(() => {
      btn.classList.add('copied');
      btn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6.5l3 3 5-5" stroke="currentColor"
                stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Copied!
      `;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="4" y="4" width="7" height="7" rx="1.5"
                  stroke="currentColor" stroke-width="1.2"/>
            <path d="M2.5 8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v.5"
                  stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          Copy
        `;
      }, 2000);
    });
  });
  msgEl.appendChild(btn);
}

function updateTurnCounter(completedTurns) {
  turnsUsedEl.textContent = completedTurns;
  if (completedTurns === 0) {
    turnCounter.classList.add('hidden');
  } else {
    turnCounter.classList.remove('hidden');
    // Warn visually on last turn.
    turnCounter.style.borderColor =
      completedTurns >= MAX_TURNS - 1
        ? 'rgba(252, 165, 165, 0.35)'
        : '';
    turnCounter.style.color =
      completedTurns >= MAX_TURNS - 1
        ? 'rgba(252, 165, 165, 0.7)'
        : '';
  }
}

function showContextLimit() {
  inputFooter.classList.add('hidden');

  const notice = document.createElement('div');
  notice.id = 'context-limit';
  notice.innerHTML = `
    <p>Context limit reached &mdash; ${MAX_TURNS}&thinsp;/&thinsp;${MAX_TURNS} turns used.</p>
    <button id="new-screenshot-btn">&#8635;&ensp;Take New Screenshot</button>
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
  isLoading              = !enabled;
  sendBtn.disabled       = !enabled;
  questionInput.disabled = !enabled;
  if (enabled) questionInput.focus();
}

// ── Text helpers ──────────────────────────────────────────────────────────

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
