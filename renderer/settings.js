'use strict';

// DOM refs
const apiKeyInput      = document.getElementById('api-key-input');
const modelInput       = document.getElementById('model-input');
const startupCheckbox  = document.getElementById('startup-checkbox');
const toggleVisBtn     = document.getElementById('toggle-visibility');
const saveBtn          = document.getElementById('save-btn');
const cancelBtn        = document.getElementById('cancel-btn');
const statusBar        = document.getElementById('status-bar');
const apiLink          = document.getElementById('api-link');

// ── Load current settings on open ─────────────────────────────────────────
window.electronAPI.settingsGet().then((s) => {
  apiKeyInput.value        = s.geminiApiKey  || '';
  modelInput.value         = s.geminiModel   || 'gemini-2.5-flash';
  startupCheckbox.checked  = s.startWithOS   !== false; // default true
});

// ── Toggle API key visibility ──────────────────────────────────────────────
toggleVisBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleVisBtn.title = isPassword ? 'Hide key' : 'Show key';
});

// ── Open API key link in browser ───────────────────────────────────────────
apiLink.addEventListener('click', () => {
  window.electronAPI.openExternal('https://aistudio.google.com/app/apikey');
});

// ── Save ───────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', async () => {
  const key   = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || 'gemini-2.5-flash';

  if (!key) {
    showStatus('Please enter a Gemini API key.', 'error');
    apiKeyInput.focus();
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const result = await window.electronAPI.settingsSave({
    geminiApiKey: key,
    geminiModel:  model,
    startWithOS:  startupCheckbox.checked,
    firstRun:     false,
  });

  if (result.ok) {
    showStatus('Settings saved! The app will use your new key immediately.', 'success');
    setTimeout(() => window.electronAPI.settingsClose(), 1200);
  } else {
    showStatus(`Error saving settings: ${result.error}`, 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save & Close';
  }
});

// ── Cancel ─────────────────────────────────────────────────────────────────
cancelBtn.addEventListener('click', () => {
  window.electronAPI.settingsClose();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.electronAPI.settingsClose();
});

// ── Helpers ────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  statusBar.textContent = msg;
  statusBar.className   = type;   // 'success' or 'error'
  statusBar.classList.remove('hidden');
}
