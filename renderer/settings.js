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
const voiceIdSelect          = document.getElementById('voice-id-select');

// Phase 5 — Web search / scrape / browser DOM refs
const websearchProviderSelect    = document.getElementById('websearch-provider-select');
const tavilyKeyField             = document.getElementById('tavily-key-field');
const tavilyKeyInput             = document.getElementById('tavily-key-input');
const toggleTavilyVisBtn         = document.getElementById('toggle-tavily-visibility');
const tavilyLink                 = document.getElementById('tavily-link');
const braveKeyField              = document.getElementById('brave-key-field');
const braveKeyInput              = document.getElementById('brave-key-input');
const toggleBraveVisBtn          = document.getElementById('toggle-brave-visibility');
const braveLink                  = document.getElementById('brave-link');
const apifyTokenInput            = document.getElementById('apify-token-input');
const toggleApifyVisBtn          = document.getElementById('toggle-apify-visibility');
const apifyLink                  = document.getElementById('apify-link');
const chromeAutoLaunchCheckbox   = document.getElementById('chrome-autolaunch-checkbox');
const narrationEnabledCheckbox   = document.getElementById('narration-enabled-checkbox');
const visionEnabledCheckbox      = document.getElementById('vision-enabled-checkbox');

//── State ──────────────────────────────────────────────────────────────────
let recordingHotkey      = false;
let currentHotkey        = '';   // empty string = use platform defaults (F7)
let recordingVoiceHotkey = false;
let currentJarvisHotkey  = '';   // empty string = default (Right Alt) for Jarvis PTT
let mistralInstallMonitor = null;

// ── PTT key mapping ────────────────────────────────────────────────────────
// Maps a KeyboardEvent.code to a uiohook-napi UiohookKey name. Only keys
// that make sense as a push-to-talk single-key hotkey are listed.
const PTT_KEY_MAP = {
  AltRight:     'AltRight',
  AltLeft:      'Alt',
  ControlRight: 'CtrlRight',
  ControlLeft:  'Ctrl',
  ShiftRight:   'ShiftRight',
  ShiftLeft:    'Shift',
  CapsLock:     'CapsLock',
  Pause:        'Pause',
  ScrollLock:   'ScrollLock',
  Tab:          'Tab',
  Backquote:    'Backquote',
  Space:        'Space',
};
for (let i = 1; i <= 12; i++) PTT_KEY_MAP[`F${i}`] = `F${i}`;
for (let c = 65; c <= 90; c++) {
  const letter = String.fromCharCode(c);
  PTT_KEY_MAP[`Key${letter}`] = letter;
}
for (let d = 0; d <= 9; d++) PTT_KEY_MAP[`Digit${d}`] = String(d);

const PTT_DISPLAY_LABEL = {
  AltRight:     'Right Alt',
  Alt:          'Left Alt',
  CtrlRight:    'Right Ctrl',
  Ctrl:         'Left Ctrl',
  ShiftRight:   'Right Shift',
  Shift:        'Left Shift',
  Backquote:    '`',
};

function pttHotkeyLabel(name) {
  if (!name) return 'Right Alt';
  return PTT_DISPLAY_LABEL[name] || name;
}

// Voice select: if the saved voiceId isn't one of the built-in options
// (e.g. someone pasted a custom ID into settings.json directly), append a
// transient option for it so the dropdown reflects the actual saved state
// instead of silently snapping to the first option.
function setVoiceSelectValue(id) {
  if (!voiceIdSelect) return;
  const has = Array.from(voiceIdSelect.options).some((o) => o.value === id);
  if (!has) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `Custom (${id})`;
    voiceIdSelect.appendChild(opt);
  }
  voiceIdSelect.value = id;
}

const MISTRAL_INSTALL_POLL_MS = 3000;
const MISTRAL_INSTALL_TIMEOUT_MS = 180000;

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

  // Model dropdown — upgrade stale or removed model names saved from old versions
  const STALE_MODELS = {
    'gemini-2.5-flash-preview-04-17': 'gemini-3.1-flash-lite-preview',
  };
  const rawModel = s.geminiModel || 'gemini-3.1-flash-lite-preview';
  const savedModel = STALE_MODELS[rawModel] || rawModel;
  const opt = modelSelect.querySelector(`option[value="${savedModel}"]`);
  if (opt) modelSelect.value = savedModel;
  else modelSelect.value = 'gemini-3.1-flash-lite-preview';
  updateOpenAIKeyVisibility();

  // Capture hotkey
  currentHotkey = s.customHotkey || '';
  hotkeyDisplay.textContent = currentHotkey || 'F7';

  // Voice settings
  voiceEnabledCheckbox.checked = s.voiceEnabled === true;
  elevenlabsKeyInput.value     = s.elevenlabsApiKey || '';
  setVoiceSelectValue(s.voiceId || 'EXAVITQu4vr4xnSDxMaL');
  currentJarvisHotkey          = s.jarvisHotkey || '';
  voiceHotkeyDisplay.textContent = pttHotkeyLabel(currentJarvisHotkey);
  updateVoiceSettingsVisibility();

  // Agent settings
  agentEnabledCheckbox.checked = s.agentEnabled === true;
  agentBackendSelect.value     = s.agentBackend || 'codex';
  mistralKeyInput.value        = s.mistralApiKey || '';
  updateAgentSections();

  // Phase 5 — Web / browser / pipeline
  websearchProviderSelect.value     = s.jarvisWebSearchProvider || 'tavily';
  tavilyKeyInput.value              = s.jarvisTavilyApiKey || '';
  braveKeyInput.value               = s.jarvisBraveApiKey || '';
  apifyTokenInput.value             = s.jarvisApifyToken || '';
  chromeAutoLaunchCheckbox.checked  = s.jarvisChromeAutoLaunch !== false;
  narrationEnabledCheckbox.checked  = s.jarvisNarrationEnabled !== false;
  visionEnabledCheckbox.checked     = s.jarvisVisionEnabled    !== false;
  updateWebSearchProviderVisibility();
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

// ── Jarvis PTT hotkey recording ────────────────────────────────────────────
recordVoiceHotkeyBtn.addEventListener('click', () => {
  if (recordingVoiceHotkey) stopVoiceHotkeyRecording();
  else startVoiceHotkeyRecording();
});

resetVoiceHotkeyBtn.addEventListener('click', () => {
  currentJarvisHotkey = '';
  voiceHotkeyDisplay.textContent = 'Right Alt';
  voiceHotkeyDisplay.classList.remove('recording');
  stopVoiceHotkeyRecording();
});

function startVoiceHotkeyRecording() {
  if (recordingHotkey) stopRecording();
  recordingVoiceHotkey = true;
  recordVoiceHotkeyBtn.textContent = 'CANCEL';
  voiceHotkeyDisplay.textContent   = 'HOLD A KEY…';
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

  // ── Jarvis PTT hotkey: capture by e.code so Left/Right Alt are distinct.
  // PTT keys are single keys, not Electron-style chord combos.
  if (recordingVoiceHotkey) {
    e.preventDefault();
    e.stopPropagation();

    const mapped = PTT_KEY_MAP[e.code];
    if (!mapped) {
      // Unsupported PTT key — flash a hint and keep recording.
      voiceHotkeyDisplay.textContent = 'UNSUPPORTED — TRY ANOTHER';
      return;
    }

    currentJarvisHotkey = mapped;
    voiceHotkeyDisplay.textContent = pttHotkeyLabel(mapped);
    stopVoiceHotkeyRecording();
    return;
  }

  // ── Capture hotkey: Electron globalShortcut chord format (existing).
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

  e.preventDefault();
  e.stopPropagation();

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey)  parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

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
    jarvisHotkey:     currentJarvisHotkey,
    voiceId:          voiceIdSelect.value || 'EXAVITQu4vr4xnSDxMaL',
    // Agent subsystem
    agentEnabled:     agentEnabledCheckbox.checked,
    agentBackend:     agentBackendSelect.value,
    mistralApiKey:    mistralKeyInput.value.trim(),
    // Phase 5 — Web / browser / pipeline
    jarvisWebSearchProvider: websearchProviderSelect.value,
    jarvisTavilyApiKey:      tavilyKeyInput.value.trim(),
    jarvisBraveApiKey:       braveKeyInput.value.trim(),
    jarvisApifyToken:        apifyTokenInput.value.trim(),
    jarvisChromeAutoLaunch:  chromeAutoLaunchCheckbox.checked,
    jarvisNarrationEnabled:  narrationEnabledCheckbox.checked,
    jarvisVisionEnabled:     visionEnabledCheckbox.checked,
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

function setMistralStatus(text, color = '') {
  vibeStatus.textContent = text;
  vibeStatus.style.color = color;
}

function renderMistralCheckResult(result) {
  if (result.installed) {
    setMistralStatus('✓ Installed' + (result.version ? ' · ' + result.version : ''), '#86efac');
    return;
  }
  setMistralStatus('✗ Not found — click INSTALL to set up Mistral', '#fca5a5');
}

function stopMistralInstallMonitor() {
  if (mistralInstallMonitor) {
    clearTimeout(mistralInstallMonitor);
    mistralInstallMonitor = null;
  }
  vibeInstallBtn.disabled = false;
}

async function monitorMistralInstall(startedAt = Date.now()) {
  let result;
  try {
    result = await window.electronAPI.agentCheck('vibe');
  } catch (err) {
    stopMistralInstallMonitor();
    setMistralStatus(`✗ ${err.message || 'Unable to verify Mistral setup.'}`, '#fca5a5');
    return;
  }

  if (result.installed) {
    stopMistralInstallMonitor();
    renderMistralCheckResult(result);
    return;
  }

  if (Date.now() - startedAt >= MISTRAL_INSTALL_TIMEOUT_MS) {
    stopMistralInstallMonitor();
    setMistralStatus('Installer opened. Finish setup in the terminal, then click CHECK.', '#f59e0b');
    return;
  }

  setMistralStatus('Installer opened. Waiting for Mistral…', '#f59e0b');
  mistralInstallMonitor = setTimeout(() => {
    monitorMistralInstall(startedAt);
  }, MISTRAL_INSTALL_POLL_MS);
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
  stopMistralInstallMonitor();
  setMistralStatus('Checking…');
  try {
    const result = await window.electronAPI.agentCheck('vibe');
    renderMistralCheckResult(result);
  } catch (err) {
    setMistralStatus(`✗ ${err.message || 'Unable to check Mistral.'}`, '#fca5a5');
  }
});

vibeInstallBtn.addEventListener('click', async () => {
  stopMistralInstallMonitor();
  vibeInstallBtn.disabled = true;
  setMistralStatus('Opening Mistral installer…', '#f59e0b');
  const result = await window.electronAPI.agentInstall('vibe');
  if (result && result.ok === false) {
    stopMistralInstallMonitor();
    setMistralStatus(`✗ ${result.error || 'Unable to launch Mistral installer.'}`, '#fca5a5');
    return;
  }
  setMistralStatus('Installer opened. Waiting for Mistral…', '#f59e0b');
  monitorMistralInstall();
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

// ── Phase 5 — Web search provider switch ──────────────────────────────────
function updateWebSearchProviderVisibility() {
  const provider = websearchProviderSelect.value;
  tavilyKeyField.classList.toggle('hidden', provider !== 'tavily');
  braveKeyField.classList.toggle('hidden',  provider !== 'brave');
}
websearchProviderSelect.addEventListener('change', updateWebSearchProviderVisibility);

// Phase 5 — key visibility toggles
toggleTavilyVisBtn.addEventListener('click', () => {
  tavilyKeyInput.type = tavilyKeyInput.type === 'password' ? 'text' : 'password';
});
toggleBraveVisBtn.addEventListener('click', () => {
  braveKeyInput.type = braveKeyInput.type === 'password' ? 'text' : 'password';
});
toggleApifyVisBtn.addEventListener('click', () => {
  apifyTokenInput.type = apifyTokenInput.type === 'password' ? 'text' : 'password';
});

// Phase 5 — external links
tavilyLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://app.tavily.com/sign-in');
});
braveLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://api-dashboard.search.brave.com/app/keys');
});
apifyLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://console.apify.com/account/integrations');
});

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
