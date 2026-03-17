'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────
const apiKeyInput          = document.getElementById('api-key-input');
const modelSelect          = document.getElementById('model-select');
const openaiKeySection     = document.getElementById('openai-key-section');
const openaiKeyInput       = document.getElementById('openai-key-input');
const startupCheckbox      = document.getElementById('startup-checkbox');
const toggleVisBtn         = document.getElementById('toggle-visibility');
const toggleOpenaiVisBtn   = document.getElementById('toggle-openai-visibility');
const saveBtn              = document.getElementById('save-btn');
const cancelBtn            = document.getElementById('cancel-btn');
const statusBar            = document.getElementById('status-bar');
const apiLink              = document.getElementById('api-link');
const openaiLink           = document.getElementById('openai-link');

const hotkeyDisplay        = document.getElementById('hotkey-display');
const recordHotkeyBtn      = document.getElementById('record-hotkey-btn');
const resetHotkeyBtn       = document.getElementById('reset-hotkey-btn');

//── State ──────────────────────────────────────────────────────────────────
let recordingHotkey = false;
let currentHotkey   = '';   // empty string = use platform defaults (F7)

// ── Load current settings on open ─────────────────────────────────────────
window.electronAPI.settingsGet().then((s) => {
  apiKeyInput.value       = s.geminiApiKey  || '';
  openaiKeyInput.value    = s.openaiApiKey  || '';
  startupCheckbox.checked = s.startWithOS   !== false;

  // Model dropdown
  const savedModel = s.geminiModel || 'gemini-3-flash-preview';
  const opt = modelSelect.querySelector(`option[value="${savedModel}"]`);
  if (opt) modelSelect.value = savedModel;
  else modelSelect.value = 'gemini-3-flash-preview';
  updateOpenAIKeyVisibility();

  // Hotkey
  currentHotkey = s.customHotkey || '';
  hotkeyDisplay.textContent = currentHotkey || 'F7 (Default)';
});

// ── Model dropdown → show/hide OpenAI key ─────────────────────────────────
modelSelect.addEventListener('change', updateOpenAIKeyVisibility);

function updateOpenAIKeyVisibility() {
  const isOpenAI = /^(gpt-|o1|o3|o4)/.test(modelSelect.value);
  openaiKeySection.classList.toggle('hidden', !isOpenAI);
}

// ── Toggle API key visibility ──────────────────────────────────────────────
toggleVisBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type  = isPassword ? 'text' : 'password';
  toggleVisBtn.title = isPassword ? 'Hide key' : 'Show key';
});

toggleOpenaiVisBtn.addEventListener('click', () => {
  const isPassword = openaiKeyInput.type === 'password';
  openaiKeyInput.type  = isPassword ? 'text' : 'password';
  toggleOpenaiVisBtn.title = isPassword ? 'Hide key' : 'Show key';
});

// ── Open links in browser ──────────────────────────────────────────────────
apiLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://aistudio.google.com/app/apikey');
});
openaiLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://platform.openai.com/api-keys');
});

// ── Hotkey recording ───────────────────────────────────────────────────────
recordHotkeyBtn.addEventListener('click', () => {
  if (recordingHotkey) stopRecording();
  else startRecording();
});

resetHotkeyBtn.addEventListener('click', () => {
  currentHotkey = '';
  hotkeyDisplay.textContent = 'F7 (Default)';
  hotkeyDisplay.classList.remove('recording');
  stopRecording();
});

function startRecording() {
  recordingHotkey = true;
  recordHotkeyBtn.textContent = 'Cancel';
  hotkeyDisplay.textContent   = 'Press a key combo…';
  hotkeyDisplay.classList.add('recording');
}

function stopRecording() {
  recordingHotkey = false;
  recordHotkeyBtn.textContent = 'Change';
  hotkeyDisplay.classList.remove('recording');
}

document.addEventListener('keydown', (e) => {
  if (!recordingHotkey) {
    if (e.key === 'Escape') window.electronAPI.settingsClose();
    return;
  }

  // Ignore bare modifier key presses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

  e.preventDefault();
  e.stopPropagation();

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey)  parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  // Map browser key names to Electron globalShortcut format
  const KEY_MAP = {
    ' ':           'Space',
    'Enter':       'Return',
    'ArrowLeft':   'Left',
    'ArrowRight':  'Right',
    'ArrowUp':     'Up',
    'ArrowDown':   'Down',
    'Escape':      'Escape',
    'Backspace':   'Backspace',
    'Delete':      'Delete',
    'Tab':         'Tab',
    'Home':        'Home',
    'End':         'End',
    'PageUp':      'PageUp',
    'PageDown':    'PageDown',
  };

  let key = KEY_MAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);

  currentHotkey = parts.join('+');
  hotkeyDisplay.textContent = currentHotkey;
  stopRecording();
});

// ── Save ───────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', async () => {
  const key      = apiKeyInput.value.trim();
  const model    = modelSelect.value;
  const openaiKey = openaiKeyInput.value.trim();

  if (!key) {
    showStatus('Please enter a Gemini API key.', 'error');
    apiKeyInput.focus();
    return;
  }

  if (/^(gpt-|o1|o3|o4)/.test(model) && !openaiKey) {
    showStatus('Please enter your OpenAI API key for the selected model.', 'error');
    openaiKeyInput.focus();
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const result = await window.electronAPI.settingsSave({
    geminiApiKey: key,
    openaiApiKey: openaiKey,
    geminiModel:  model,
    customHotkey: currentHotkey,
    startWithOS:  startupCheckbox.checked,
    firstRun:     false,
  });

  if (result.ok) {
    showStatus('Settings saved!', 'success');
    setTimeout(() => window.electronAPI.settingsClose(), 1200);
  } else {
    showStatus(`Error saving settings: ${result.error}`, 'error');
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save & Close';
  }
});

// ── Cancel ─────────────────────────────────────────────────────────────────
cancelBtn.addEventListener('click', () => window.electronAPI.settingsClose());

// ── Helpers ────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  statusBar.textContent = msg;
  statusBar.className   = type;
  statusBar.classList.remove('hidden');
}
