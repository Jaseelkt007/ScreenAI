'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────
// Agent subsystem refs (declared up top so loadSettings can reference them)
const agentEnabledCheckbox  = document.getElementById('agent-enabled-checkbox');
const agentSettingsSection  = document.getElementById('agent-settings-section');
const agentBackendSelect    = document.getElementById('agent-backend-select');
const codexSection          = document.getElementById('codex-section');
const vibeSection           = document.getElementById('vibe-section');
const codexCheckBtn         = document.getElementById('codex-check-btn');
const codexInstallBtn       = document.getElementById('codex-install-btn');
const codexAuthBtn          = document.getElementById('codex-auth-btn');
const codexStatus           = document.getElementById('codex-status');
const vibeCheckBtn          = document.getElementById('vibe-check-btn');
const vibeInstallBtn        = document.getElementById('vibe-install-btn');
const vibeStatus            = document.getElementById('vibe-status');
const mistralKeyInput       = document.getElementById('mistral-key-input');
const toggleMistralVisBtn   = document.getElementById('toggle-mistral-visibility');
const mistralLink           = document.getElementById('mistral-link');


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

// Voice Guide DOM refs
const voiceEnabledCheckbox   = document.getElementById('voice-enabled-checkbox');
const voiceSettingsSection   = document.getElementById('voice-settings-section');
const elevenlabsKeyInput     = document.getElementById('elevenlabs-key-input');
const toggleElVisBtn         = document.getElementById('toggle-el-visibility');
const elevenlabsLink         = document.getElementById('elevenlabs-link');
const voiceHotkeyDisplay     = document.getElementById('voice-hotkey-display');
const recordVoiceHotkeyBtn   = document.getElementById('record-voice-hotkey-btn');
const resetVoiceHotkeyBtn    = document.getElementById('reset-voice-hotkey-btn');
const voiceIdInput           = document.getElementById('voice-id-input');

//── State ──────────────────────────────────────────────────────────────────
let recordingHotkey      = false;
let currentHotkey        = '';   // empty string = use platform defaults (F7)
let recordingVoiceHotkey = false;
let currentVoiceHotkey   = '';   // empty string = use platform defaults (F8)

// ── Load current settings on open ─────────────────────────────────────────
window.electronAPI.settingsGet().then((s) => {
  apiKeyInput.value       = s.geminiApiKey  || '';
  openaiKeyInput.value    = s.openaiApiKey  || '';
  startupCheckbox.checked = s.startWithOS   !== false;

  // Show first-run welcome bar
  if (s.firstRun !== false) {
    const welcomeEl = document.getElementById('welcome');
    if (welcomeEl) welcomeEl.classList.remove('hidden');
  }

  // Model dropdown — upgrade stale model name saved from old version
  const STALE_MODELS = { 'gemini-3-flash-preview': 'gemini-2.5-flash-preview-04-17' };
  const rawModel = s.geminiModel || 'gemini-2.5-flash-preview-04-17';
  const savedModel = STALE_MODELS[rawModel] || rawModel;
  const opt = modelSelect.querySelector(`option[value="${savedModel}"]`);
  if (opt) modelSelect.value = savedModel;
  else modelSelect.value = 'gemini-2.5-flash-preview-04-17';
  updateOpenAIKeyVisibility();

  // Capture hotkey
  currentHotkey = s.customHotkey || '';
  hotkeyDisplay.textContent = currentHotkey || 'F7';

  // Voice settings
  voiceEnabledCheckbox.checked = s.voiceEnabled === true;
  elevenlabsKeyInput.value     = s.elevenlabsApiKey || '';
  voiceIdInput.value           = s.voiceId || 'JBFqnCBsd6RMkjVDRZzb';
  currentVoiceHotkey           = s.voiceHotkey || '';
  voiceHotkeyDisplay.textContent = currentVoiceHotkey || 'F8';
  updateVoiceSettingsVisibility();

  // Agent settings
  agentEnabledCheckbox.checked = s.agentEnabled === true;
  agentBackendSelect.value     = s.agentBackend || 'codex';
  mistralKeyInput.value        = s.mistralApiKey || '';
  updateAgentSections();
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

// ── Voice settings visibility ──────────────────────────────────────────────
voiceEnabledCheckbox.addEventListener('change', updateVoiceSettingsVisibility);

function updateVoiceSettingsVisibility() {
  voiceSettingsSection.classList.toggle('hidden', !voiceEnabledCheckbox.checked);
}

// ── ElevenLabs key visibility ──────────────────────────────────────────────
toggleElVisBtn.addEventListener('click', () => {
  const isPassword = elevenlabsKeyInput.type === 'password';
  elevenlabsKeyInput.type = isPassword ? 'text' : 'password';
});

// ── Open links in browser ──────────────────────────────────────────────────
apiLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://aistudio.google.com/app/apikey');
});
openaiLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://platform.openai.com/api-keys');
});
elevenlabsLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://elevenlabs.io/app/settings/api-keys');
});

// ── Hotkey recording (capture) ─────────────────────────────────────────────
recordHotkeyBtn.addEventListener('click', () => {
  if (recordingHotkey) stopRecording();
  else startRecording();
});

resetHotkeyBtn.addEventListener('click', () => {
  currentHotkey = '';
  hotkeyDisplay.textContent = 'F7';
  hotkeyDisplay.classList.remove('recording');
  stopRecording();
});

function startRecording() {
  if (recordingVoiceHotkey) stopVoiceHotkeyRecording();
  recordingHotkey = true;
  recordHotkeyBtn.textContent = 'CANCEL';
  hotkeyDisplay.textContent   = 'PRESS KEY…';
  hotkeyDisplay.classList.add('recording');
}

function stopRecording() {
  recordingHotkey = false;
  recordHotkeyBtn.textContent = 'BIND';
  hotkeyDisplay.classList.remove('recording');
}

// ── Voice hotkey recording ─────────────────────────────────────────────────
recordVoiceHotkeyBtn.addEventListener('click', () => {
  if (recordingVoiceHotkey) stopVoiceHotkeyRecording();
  else startVoiceHotkeyRecording();
});

resetVoiceHotkeyBtn.addEventListener('click', () => {
  currentVoiceHotkey = '';
  voiceHotkeyDisplay.textContent = 'F8';
  voiceHotkeyDisplay.classList.remove('recording');
  stopVoiceHotkeyRecording();
});

function startVoiceHotkeyRecording() {
  if (recordingHotkey) stopRecording();
  recordingVoiceHotkey = true;
  recordVoiceHotkeyBtn.textContent = 'CANCEL';
  voiceHotkeyDisplay.textContent   = 'PRESS KEY…';
  voiceHotkeyDisplay.classList.add('recording');
}

function stopVoiceHotkeyRecording() {
  recordingVoiceHotkey = false;
  recordVoiceHotkeyBtn.textContent = 'BIND';
  voiceHotkeyDisplay.classList.remove('recording');
}

document.addEventListener('keydown', (e) => {
  if (!recordingHotkey && !recordingVoiceHotkey) {
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

  const combo = parts.join('+');

  if (recordingHotkey) {
    currentHotkey = combo;
    hotkeyDisplay.textContent = combo;
    stopRecording();
  } else if (recordingVoiceHotkey) {
    currentVoiceHotkey = combo;
    voiceHotkeyDisplay.textContent = combo;
    stopVoiceHotkeyRecording();
  }
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
    geminiApiKey:     key,
    openaiApiKey:     openaiKey,
    geminiModel:      model,
    customHotkey:     currentHotkey,
    startWithOS:      startupCheckbox.checked,
    firstRun:         false,
    voiceEnabled:     voiceEnabledCheckbox.checked,
    elevenlabsApiKey: elevenlabsKeyInput.value.trim(),
    voiceHotkey:      currentVoiceHotkey,
    voiceId:          voiceIdInput.value.trim() || 'JBFqnCBsd6RMkjVDRZzb',
    // Agent subsystem
    agentEnabled:     agentEnabledCheckbox.checked,
    agentBackend:     agentBackendSelect.value,
    mistralApiKey:    mistralKeyInput.value.trim(),
  });

  if (result.ok) {
    showStatus('Settings saved!', 'success');
    setTimeout(() => window.electronAPI.settingsClose(), 1200);
  } else {
    showStatus(`Error saving settings: ${result.error}`, 'error');
    saveBtn.disabled    = false;
    saveBtn.textContent = 'SAVE & CLOSE';
  }
});

// ── Cancel ─────────────────────────────────────────────────────────────────
cancelBtn.addEventListener('click', () => window.electronAPI.settingsClose());

// ── Agent subsystem ────────────────────────────────────────────────────────

agentEnabledCheckbox.addEventListener('change', updateAgentSections);
agentBackendSelect.addEventListener('change', updateAgentSections);

function updateAgentSections() {
  agentSettingsSection.classList.toggle('hidden', !agentEnabledCheckbox.checked);
  const isVibe = agentBackendSelect.value === 'vibe';
  codexSection.classList.toggle('hidden', isVibe);
  vibeSection.classList.toggle('hidden', !isVibe);
}

// Check Codex installation
codexCheckBtn.addEventListener('click', async () => {
  codexStatus.textContent = 'Checking…';
  codexStatus.style.color = '';
  const result = await window.electronAPI.agentCheck('codex');
  if (result.installed) {
    const runtime = result.runtime === 'wsl' ? 'WSL' : 'native';
    const auth =
      result.authenticated === true ? ' · Logged in'
      : result.authenticated === false ? ' · Not signed in'
      : '';
    codexStatus.textContent =
      `✓ Installed (${runtime})` +
      (result.version ? ' · ' + result.version : '') +
      auth;
    codexStatus.style.color = '#86efac';
  } else {
    codexStatus.textContent = '✗ Not found — install Codex or use your WSL runtime';
    codexStatus.style.color = '#fca5a5';
  }
});

codexInstallBtn.addEventListener('click', async () => {
  codexStatus.textContent = 'Opening install terminal…';
  codexStatus.style.color = '#f59e0b';
  await window.electronAPI.agentInstall('codex');
});

// Launch codex auth in a terminal / browser
codexAuthBtn.addEventListener('click', async () => {
  codexStatus.textContent = 'Opening browser for ChatGPT sign-in…';
  codexStatus.style.color = '#f59e0b';
  const result = await window.electronAPI.agentAuthCodex();
  if (result && result.ok === false) {
    codexStatus.textContent = `✗ ${result.error || 'Codex is not installed.'}`;
    codexStatus.style.color = '#fca5a5';
  }
});

// Check Vibe installation
vibeCheckBtn.addEventListener('click', async () => {
  vibeStatus.textContent = 'Checking…';
  vibeStatus.style.color = '';
  const result = await window.electronAPI.agentCheck('vibe');
  if (result.installed) {
    vibeStatus.textContent = '✓ Installed' + (result.version ? ' · ' + result.version : '');
    vibeStatus.style.color = '#86efac';
  } else {
    vibeStatus.textContent = '✗ Not found — run: npm install -g @mistral-ai/vibe';
    vibeStatus.style.color = '#fca5a5';
  }
});

vibeInstallBtn.addEventListener('click', async () => {
  vibeStatus.textContent = 'Opening install terminal…';
  vibeStatus.style.color = '#f59e0b';
  await window.electronAPI.agentInstall('vibe');
});

// Mistral key visibility toggle
toggleMistralVisBtn.addEventListener('click', () => {
  const isPassword = mistralKeyInput.type === 'password';
  mistralKeyInput.type = isPassword ? 'text' : 'password';
});

// Mistral console link
mistralLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://console.mistral.ai');
});

// ElevenLabs voice library link
const elevenlabsVoicesLink = document.getElementById('elevenlabs-voices-link');
if (elevenlabsVoicesLink) {
  elevenlabsVoicesLink.addEventListener('click', () => {
    window.electronAPI.openExternal('https://elevenlabs.io/voice-library');
  });
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `tab-${target}`);
    });
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  statusBar.textContent = msg;
  statusBar.className   = type;
  statusBar.classList.remove('hidden');
}
