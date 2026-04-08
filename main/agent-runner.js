'use strict';

const { execSync, spawn } = require('child_process');
const { EventEmitter }    = require('events');
const os                  = require('os');
const path                = require('path');

/**
 * patchProcessPath() — Called once at Electron startup.
 *
 * On Windows, Electron's process.env.PATH is the *system* PATH only.
 * User-level PATH entries (where npm global tools, codex, vibe live) are
 * stored separately in the registry and NOT inherited by Electron unless
 * the shell that launched it merges them.
 *
 * Fix: read the Windows user PATH directly from the registry via PowerShell,
 * then merge it into process.env.PATH so every subsequent exec/spawn
 * automatically sees the correct PATH — no per-call env passing required.
 *
 * On Unix/macOS: npm global bin and Homebrew bin are added as fallback only
 * if they're missing (they usually are already present).
 */
function patchProcessPath() {
  if (process.platform === 'win32') {
    _patchWindows();
  } else {
    _patchUnix();
  }
}

function _patchWindows() {
  const sep = ';';
  const candidates = new Set();

  // 1. Read Windows user PATH from registry (covers ALL install methods)
  try {
    const userPath = execSync(
      'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"',
      { encoding: 'utf8', timeout: 6000, windowsHide: true }
    ).trim();
    if (userPath) {
      userPath.split(sep).filter(Boolean).forEach(d => candidates.add(d));
    }
  } catch { /* powershell not available — fall through */ }

  // 2. npm global prefix as extra fallback
  try {
    const prefix = execSync('npm config get prefix', {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    }).trim();
    if (prefix && prefix !== 'undefined') candidates.add(prefix);
  } catch {}

  // 3. Common Windows default location
  const appData = process.env.APPDATA ||
    path.join(os.homedir(), 'AppData', 'Roaming');
  candidates.add(path.join(appData, 'npm'));

  // Merge: prepend any missing entries to process.env.PATH
  const current  = new Set((process.env.PATH || '').split(sep).filter(Boolean));
  const newDirs  = [...candidates].filter(d => !current.has(d));

  if (newDirs.length) {
    process.env.PATH = newDirs.join(sep) + sep + (process.env.PATH || '');
    console.log('[AgentEnv] Added to PATH:', newDirs.join(', '));
  } else {
    console.log('[AgentEnv] PATH already complete');
  }
}

function _patchUnix() {
  const sep  = ':';
  const home = os.homedir();

  const candidates = [
    process.platform === 'darwin' ? '/opt/homebrew/bin' : null,
    process.platform === 'darwin' ? '/usr/local/bin'    : null,
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
  ].filter(Boolean);

  try {
    const prefix = execSync('npm config get prefix', {
      encoding: 'utf8', timeout: 4000,
    }).trim();
    if (prefix && prefix !== 'undefined') {
      candidates.unshift(path.join(prefix, 'bin'));
    }
  } catch {}

  const current = new Set((process.env.PATH || '').split(sep).filter(Boolean));
  const newDirs = candidates.filter(d => d && !current.has(d));

  if (newDirs.length) {
    process.env.PATH = newDirs.join(sep) + sep + (process.env.PATH || '');
    console.log('[AgentEnv] Added to PATH:', newDirs.join(', '));
  }
}

/**
 * buildAgentEnv() — Returns process.env (already patched by patchProcessPath).
 * Still accepts extra overrides (e.g. TERM=dumb for Codex).
 */
function buildAgentEnv(extra = {}) {
  return Object.keys(extra).length ? { ...process.env, ...extra } : process.env;
}

/**
 * agent-runner.js — Background agent process management
 *
 * Spawns Codex or Vibe CLI as child processes, parses their stdout into
 * normalized events, and emits them for the narrator + Agent HUD to consume.
 *
 * Normalized event shape:
 *   { type, label, detail, raw }
 *
 * Event types:
 *   thinking   — internal reasoning (always silent)
 *   tool_call  — tool being invoked (shown in feed, rarely spoken)
 *   tool_result — tool output (always silent)
 *   milestone  — high-value action worth narrating (spoken)
 *   response   — final answer text (spoken)
 *   error      — something failed (spoken)
 */

async function probeCommand(cmd, args = [], opts = {}) {
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs || 5000;
  const shell = opts.shell === true;

  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    const child = spawn(cmd, args, {
      env,
      windowsHide: true,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, version: null, code: 'ETIMEDOUT' });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, version: null, code: err.code || 'ERROR', error: err });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        version: summarizeProbeOutput(output),
        code,
      });
    });
  });
}

async function captureCommand(cmd, args = [], opts = {}) {
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs || 5000;
  const shell = opts.shell === true;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(cmd, args, {
      env,
      windowsHide: true,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      resolve({
        ok: false,
        code: 'ETIMEDOUT',
        stdout,
        stderr,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: err.code || 'ERROR',
        stdout,
        stderr,
        error: err,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
      });
    });
  });
}

function getWslCodexProbeScript() {
  return [
    'if [ -f ~/.bashrc ]; then . ~/.bashrc >/dev/null 2>&1; fi',
    'codex_path="$(command -v codex || true)"',
    'if [ -z "$codex_path" ]; then echo "codex not found in WSL PATH" >&2; exit 127; fi',
    'case "$codex_path" in',
    '  /mnt/*) echo "WSL codex resolves to a Windows shim: $codex_path" >&2; exit 126 ;;',
    'esac',
    'node_path="$(command -v node || true)"',
    'if [ -z "$node_path" ]; then echo "node not found in WSL PATH" >&2; exit 127; fi',
    'case "$node_path" in',
    '  /mnt/*) echo "WSL node resolves to a Windows binary: $node_path" >&2; exit 126 ;;',
    'esac',
  ].join('\n');
}

async function probeWslCodex(env) {
  const script = [
    getWslCodexProbeScript(),
    'codex --version',
  ].join('\n');

  const result = await captureCommand('wsl.exe', ['bash', '-lc', script], {
    env,
    timeoutMs: 8000,
  });

  const combinedOutput = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n');

  return {
    ok: result.ok,
    code: result.code,
    version: result.ok ? summarizeProbeOutput(result.stdout || result.stderr) : null,
    detail: summarizeProbeOutput(combinedOutput),
  };
}

let _codexResolution = null;
let _codexResolutionPromise = null;

async function resolveCodexCommand(opts = {}) {
  const force = opts.force === true;
  const preferWsl = opts.preferWsl !== false;
  if (force) {
    _codexResolution = null;
    _codexResolutionPromise = null;
  }

  if (_codexResolution !== null) return _codexResolution;
  if (_codexResolutionPromise) return _codexResolutionPromise;

  _codexResolutionPromise = (async () => {
    const env = buildAgentEnv({ TERM: 'dumb', NO_COLOR: '1' });

    const tryWsl = async () => {
      const wsl = await probeWslCodex(env);
      if (wsl.ok) {
        _codexResolution = {
          installed: true,
          runtime: 'wsl',
          cmd: 'wsl.exe',
          useShell: false,
          version: wsl.version,
        };
        console.log(`[AgentEnv] Codex detected: WSL${wsl.version ? ` (${wsl.version})` : ''}`);
        return _codexResolution;
      }
      if (wsl.detail) {
        console.warn(`[AgentEnv] WSL Codex unavailable: ${wsl.detail}`);
      }
      return null;
    };

    const tryNative = async () => {
      const native = await probeCommand('codex', ['--version'], {
        env,
        timeoutMs: 4000,
        shell: process.platform === 'win32',
      });
      if (native.ok) {
        _codexResolution = {
          installed: true,
          runtime: 'native',
          cmd: 'codex',
          useShell: process.platform === 'win32',
          version: native.version,
        };
        console.log(`[AgentEnv] Codex detected: native${native.version ? ` (${native.version})` : ''}`);
        return _codexResolution;
      }
      return null;
    };

    if (process.platform === 'win32') {
      if (preferWsl) {
        const wslResult = await tryWsl();
        if (wslResult) return wslResult;
        const nativeResult = await tryNative();
        if (nativeResult) return nativeResult;
      } else {
        const nativeResult = await tryNative();
        if (nativeResult) return nativeResult;
        const wslResult = await tryWsl();
        if (wslResult) return wslResult;
      }
    } else {
      const nativeResult = await tryNative();
      if (nativeResult) return nativeResult;
    }

    _codexResolution = false;
    console.warn('[AgentEnv] Codex not detected in native Windows or WSL');
    return _codexResolution;
  })();

  try {
    return await _codexResolutionPromise;
  } finally {
    _codexResolutionPromise = null;
  }
}

function preResolveCodexCmd() {
  resolveCodexCommand().catch((err) => {
    console.warn('[AgentEnv] Codex pre-resolve failed:', err.message);
  });
}

async function checkAgentInstallation(backend, opts = {}) {
  const name = (backend || 'codex').toLowerCase();

  if (name === 'codex') {
    const resolved = await resolveCodexCommand(opts);
    if (!resolved) {
      return {
        installed: false,
        version: null,
        runtime: null,
      };
    }
    let authenticated = null;
    let authMessage = null;
    const env = buildAgentEnv({ TERM: 'dumb', NO_COLOR: '1' });
    if (resolved.runtime === 'wsl') {
      const loginStatus = await probeCommand('wsl.exe', [
        'bash',
        '-lc',
        [
          getWslCodexProbeScript(),
          'codex login status',
        ].join('\n'),
      ], {
        env,
        timeoutMs: 8000,
      });
      authMessage = loginStatus.version || null;
      authenticated = /logged in/i.test(authMessage || '') ? true : (loginStatus.ok ? false : null);
    } else {
      const loginStatus = await probeCommand('codex', ['login', 'status'], {
        env,
        timeoutMs: 4000,
        shell: process.platform === 'win32',
      });
      authMessage = loginStatus.version || null;
      authenticated = /logged in/i.test(authMessage || '') ? true : (loginStatus.ok ? false : null);
    }
    return {
      installed: true,
      version: resolved.version || null,
      runtime: resolved.runtime,
      authenticated,
      authMessage,
    };
  }

    if (name === 'vibe') {
      const vibe = await probeCommand('vibe', ['--version'], {
        env: buildAgentEnv(),
        timeoutMs: 5000,
        shell: process.platform === 'win32',
      });
      return {
        installed: vibe.ok,
      version: vibe.version || null,
      runtime: vibe.ok ? 'native' : null,
    };
  }

  return { installed: false, version: null, runtime: null };
}

// ─── Tool classification ───────────────────────────────────────────────────

const MILESTONE_TOOLS = new Set([
  'web_search', 'search', 'brave_search', 'bing_search', 'google_search',
  'browser', 'navigate', 'open_url',
  'write_file', 'create_file', 'patch_file', 'apply_patch', 'str_replace',
  'execute', 'shell', 'bash', 'run_command', 'computer',
]);

const TOOL_LABELS = {
  web_search:    'Searching web',
  search:        'Searching',
  brave_search:  'Searching web',
  bing_search:   'Searching web',
  google_search: 'Searching web',
  browser:       'Browsing',
  navigate:      'Opening URL',
  open_url:      'Opening URL',
  read_file:     'Reading file',
  list_files:    'Listing files',
  list_dir:      'Listing directory',
  write_file:    'Writing file',
  create_file:   'Creating file',
  patch_file:    'Patching file',
  apply_patch:   'Applying patch',
  str_replace:   'Editing file',
  execute:       'Running command',
  shell:         'Running shell',
  bash:          'Running bash',
  run_command:   'Running command',
  computer:      'Using computer',
};

// Strip ANSI escape codes from CLI output
function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][A-Z]/g, '');
}

function summarizeProbeOutput(output) {
  const lines = stripAnsi(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => !/^warning:\s+proceeding, even though we could not update path:/i.test(line)) ||
    lines[0] ||
    null
  );
}

function normalizeRunInput(input) {
  if (typeof input === 'string') {
    return { prompt: input, imagePaths: [] };
  }

  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const imagePaths = Array.isArray(input?.imagePaths)
    ? input.imagePaths.filter((value) => typeof value === 'string' && value.trim())
    : [];

  return { prompt, imagePaths };
}

function quoteForBash(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function getDefaultWslPath(winPath) {
  if (typeof winPath !== 'string' || !winPath.trim()) return winPath;
  if (!/^[A-Za-z]:[\\/]/.test(winPath)) {
    return winPath.replace(/\\/g, '/');
  }

  const drive = winPath[0].toLowerCase();
  const rest = winPath.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive}/${rest}`;
}

async function convertWindowsPathToWsl(winPath, env) {
  if (process.platform !== 'win32' || !winPath) return winPath;

  const fallback = getDefaultWslPath(winPath);
  const result = await captureCommand('wsl.exe', ['wslpath', '-a', '-u', winPath], {
    env,
    timeoutMs: 5000,
  });

  const converted = stripAnsi(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (result.ok && converted) {
    return converted;
  }

  if (/^[A-Za-z]:[\\/]/.test(winPath)) {
    console.warn(`[AgentEnv] WSL path conversion fell back to default mapping: ${winPath} -> ${fallback}`);
    return fallback;
  }

  throw new Error(`Unable to convert Windows path for WSL: ${winPath}`);
}

// ─── Base class ────────────────────────────────────────────────────────────

class AgentRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this._proc = null;
    this._stopped = false;
    this._cwd = options.cwd || process.cwd();
  }

  /**
   * Start the agent.
   * @param {string|{prompt: string, imagePaths?: string[]}} input - User task
   */
  run(input) {
    throw new Error('AgentRunner.run() must be overridden');
  }

  stop() {
    this._stopped = true;
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
    }
  }

  _emit(type, label, detail = '', raw = null) {
    this.emit('event', { type, label, detail, raw });
  }

  _classifyTool(toolName) {
    const name = (toolName || '').toLowerCase().replace(/-/g, '_');
    const isMilestone = MILESTONE_TOOLS.has(name);
    const label = TOOL_LABELS[name] || `${toolName}`;
    return { isMilestone, label };
  }

  _tryParseJSON(line) {
    try { return JSON.parse(line); } catch { return null; }
  }
}

// ─── Codex Runner ─────────────────────────────────────────────────────────
//
// Spawns: codex exec --json --full-auto [-i image ...] "<prompt>"
//
// OpenAI's non-interactive docs recommend `codex exec` for automation.
// With `--json`, stdout becomes a JSONL event stream that includes
// thread/turn lifecycle events and item.* events.
// ──────────────────────────────────────────────────────────────────────────

class CodexRunner extends AgentRunner {
  run(input) {
    this._stopped = false;
    const { prompt, imagePaths } = normalizeRunInput(input);

    (async () => {
      const resolved = await resolveCodexCommand();
      if (this._stopped) return;

      if (!resolved) {
        this._emit('error', 'Codex not installed', 'Install Codex on Windows or use the WSL runtime.');
        this.emit('done');
        return;
      }

      const env = buildAgentEnv({ TERM: 'dumb', NO_COLOR: '1' });
      let cmd = resolved.cmd;
      let args;
      let shell = resolved.useShell === true;
      const imageArgs = imagePaths.flatMap((imagePath) => ['-i', imagePath]);
      let spawnCwd = this._cwd;

      if (resolved.runtime === 'wsl') {
        const wslCwd = await convertWindowsPathToWsl(this._cwd, env);
        const wslImagePaths = await Promise.all(
          imagePaths.map((imagePath) => convertWindowsPathToWsl(path.resolve(this._cwd, imagePath), env))
        );
        const codexArgs = [
          'exec',
          '--json',
          '--full-auto',
          '--skip-git-repo-check',
          prompt,
          ...wslImagePaths.flatMap((imagePath) => ['-i', imagePath]),
        ];

        spawnCwd = process.cwd();
        console.log(`[AgentEnv] WSL scratch dir: ${wslCwd}`);
        args = [
          'bash',
          '-lc',
          [
            getWslCodexProbeScript(),
            `cd ${quoteForBash(wslCwd)} || { echo "Unable to enter WSL scratch dir" >&2; exit 1; }`,
            `exec codex ${codexArgs.map((value) => quoteForBash(value)).join(' ')}`,
          ].join('\n'),
        ];
      } else if (process.platform === 'win32') {
        env.SCREENAI_AGENT_PROMPT = prompt;
        env.SCREENAI_AGENT_IMAGES = JSON.stringify(imagePaths);
        cmd = 'powershell.exe';
        args = [
          '-NoProfile',
          '-Command',
          [
            '$codexArgs = @("exec", "--json", "--full-auto", "--skip-git-repo-check", $env:SCREENAI_AGENT_PROMPT)',
            '$images = @()',
            'if ($env:SCREENAI_AGENT_IMAGES) { $images = @(ConvertFrom-Json $env:SCREENAI_AGENT_IMAGES) }',
            'foreach ($img in $images) { $codexArgs += @("-i", $img) }',
            '& codex @codexArgs',
          ].join('; '),
        ];
        shell = false;
      } else {
        args = ['exec', '--json', '--full-auto', '--skip-git-repo-check', prompt, ...imageArgs];
      }

      this._proc = spawn(cmd, args, {
        cwd: spawnCwd,
        env,
        windowsHide: true,
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._emit(
        'milestone',
        'Processing request',
        'Reviewing your screen and prompt…'
      );

      let buffer = '';
      let stderrBuffer = '';

      this._proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const clean = stripAnsi(line).trim();
          if (clean) this._parseLine(clean);
        }
      });

      this._proc.stderr.on('data', (chunk) => {
        const msg = stripAnsi(chunk.toString()).trim();
        if (msg) {
          stderrBuffer += msg + '\n';
          console.log('[Codex stderr]', msg);
        }
      });

      this._proc.on('error', (err) => {
        const isNotFound = err.code === 'ENOENT';
        this._emit(
          'error',
          isNotFound ? 'Codex not installed' : 'Codex error',
          isNotFound ? 'Install Codex on Windows or use the WSL runtime.' : err.message,
        );
      });

      this._proc.on('close', (code) => {
        if (buffer.trim()) this._parseLine(stripAnsi(buffer).trim());
        if (!this._stopped && code !== 0 && code !== null) {
          const stderrDetail = stderrBuffer
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .pop();
          if (
            resolved.runtime === 'native' &&
            process.platform === 'win32' &&
            /no terminal is available for a confirmation prompt|refusing to start the interactive tui/i.test(stderrBuffer)
          ) {
            this._emit(
              'error',
              'Codex requires WSL on Windows',
              'Native Windows Codex needs an interactive terminal for this mode. Install/use Codex in WSL for hidden agent runs.',
            );
            this.emit('done');
            return;
          }
          this._emit(
            'error',
            'Codex exited',
            stderrDetail ? `Exit code ${code}: ${stderrDetail}` : `Exit code ${code}`,
          );
        }
        this.emit('done');
      });
    })().catch((err) => {
      if (!this._stopped) {
        this._emit('error', 'Codex error', err.message);
        this.emit('done');
      }
    });
  }

  _parseLine(line) {
    // 1. Try JSON first (newer Codex versions)
    const obj = this._tryParseJSON(line);
    if (obj) {
      this._handleJSON(obj);
      return;
    }

    // 2. Text pattern matching for ANSI-stripped Codex output
    const lower = line.toLowerCase();

    // Tool-like patterns: "> action: detail" or "  [action] detail"
    const toolMatch = line.match(/^[>\s\[]*(\w[\w _-]+)[:\]]\s+(.+)$/);
    if (toolMatch) {
      const action = toolMatch[1].toLowerCase().replace(/\s+/g, '_');
      const detail = toolMatch[2].trim();
      const { isMilestone, label } = this._classifyTool(action);
      if (TOOL_LABELS[action] || isMilestone) {
        this._emit(isMilestone ? 'milestone' : 'tool_call', label, detail);
        return;
      }
    }

    // Keyword-based milestone detection in prose lines
    if (/searching|web search|browsing/i.test(line)) {
      this._emit('milestone', 'Searching web', line.slice(0, 80));
      return;
    }
    if (/writing|creating|patching|modifying.*file/i.test(line)) {
      this._emit('milestone', 'Writing file', line.slice(0, 80));
      return;
    }
    if (/running|executing|command/i.test(line)) {
      this._emit('tool_call', 'Running command', line.slice(0, 80));
      return;
    }
    if (/reading|opening.*file/i.test(line)) {
      this._emit('tool_call', 'Reading file', line.slice(0, 80));
      return;
    }

    // Substantial lines that look like a final response
    if (line.length > 40 && !/^[#>*\-=\[\]{}]/.test(line)) {
      this._emit('response', 'Response', line);
    }
  }

  _handleJSON(obj) {
    if (obj?.msg && typeof obj.msg === 'object') {
      obj = { ...obj.msg, external_id: obj.external_id || obj.msg.external_id };
    }

    const type = obj.type || obj.role || '';

    if (type === 'thread.started' || type === 'turn.started' || type === 'turn.completed') {
      return;
    }

    if (type === 'turn.failed' || type === 'error') {
      const detail =
        obj?.error?.message ||
        obj?.message ||
        obj?.detail ||
        'Codex execution failed.';
      if (type === 'error' && /reconnecting/i.test(String(detail))) {
        this._emit('thinking', 'Reconnecting', String(detail), obj);
        return;
      }
      this._emit('error', 'Codex error', String(detail), obj);
      return;
    }

    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      this._handleItemEvent(type, obj.item || {}, obj);
      return;
    }

    if (type === 'agent_message' || type === 'assistant_message') {
      const text = this._extractItemText(obj);
      if (text) this._emit('response', 'Response', text, obj);
      return;
    }

    if (type === 'function_call' || type === 'tool_use' || type === 'tool') {
      const name = obj.name || obj.function?.name || 'unknown';
      const { isMilestone, label } = this._classifyTool(name);
      let detail = '';
      try {
        const args = typeof obj.arguments === 'string'
          ? JSON.parse(obj.arguments)
          : (obj.input || obj.arguments || {});
        detail = args.query || args.cmd || args.command || args.path || args.url || '';
      } catch {}
      this._emit(isMilestone ? 'milestone' : 'tool_call', label, String(detail).slice(0, 100), obj);

    } else if (type === 'function_call_output' || type === 'tool_result') {
      this._emit('tool_result', 'Result received', '', obj);

    } else if (type === 'reasoning' || type === 'thinking') {
      this._emit('thinking', 'Thinking', '', obj);

    } else if (type === 'message' || type === 'assistant' || type === 'text') {
      let text = '';
      if (typeof obj.content === 'string') {
        text = obj.content;
      } else if (Array.isArray(obj.content)) {
        text = obj.content.filter(c => c.type === 'text').map(c => c.text).join('');
      } else if (typeof obj.text === 'string') {
        text = obj.text;
      }
      if (text && obj.role !== 'tool') {
        this._emit('response', 'Response', text, obj);
      }
    }
  }

  _handleItemEvent(eventType, item, raw) {
    const itemType = String(item?.item_type || item?.type || '').toLowerCase();
    if (!itemType) return;

    if (itemType === 'agent_message' || itemType === 'assistant_message') {
      const text = this._extractItemText(item);
      if (text && eventType === 'item.completed') {
        this._emit('response', 'Response', text, raw);
      }
      return;
    }

    if (itemType === 'reasoning') {
      this._emit('thinking', 'Thinking', '', raw);
      return;
    }

    if (itemType === 'command_execution') {
      const detail = item.command || item.cmd || item.summary || '';
      this._emit(
        eventType === 'item.started' ? 'tool_call' : 'tool_result',
        eventType === 'item.started' ? 'Running command' : 'Command finished',
        String(detail).slice(0, 160),
        raw,
      );
      return;
    }

    if (itemType.includes('web') || itemType.includes('search')) {
      const detail = item.query || item.url || item.summary || item.text || '';
      this._emit(
        eventType === 'item.started' ? 'milestone' : 'tool_result',
        'Searching web',
        String(detail).slice(0, 160),
        raw,
      );
      return;
    }

    if (itemType.includes('file')) {
      const detail = item.path || item.summary || item.change || '';
      this._emit(
        eventType === 'item.started' ? 'milestone' : 'tool_result',
        eventType === 'item.started' ? 'Writing file' : 'File updated',
        String(detail).slice(0, 160),
        raw,
      );
      return;
    }

    if (itemType.includes('mcp') || itemType.includes('tool')) {
      const name = item.name || item.tool_name || item.server || itemType;
      const { isMilestone, label } = this._classifyTool(name);
      const detail =
        item.query ||
        item.url ||
        item.command ||
        item.path ||
        item.summary ||
        '';
      this._emit(
        eventType === 'item.started'
          ? (isMilestone ? 'milestone' : 'tool_call')
          : 'tool_result',
        label,
        String(detail).slice(0, 160),
        raw,
      );
      return;
    }

    if (itemType.includes('plan')) {
      const text = this._extractItemText(item) || item.summary || '';
      if (text && eventType === 'item.completed') {
        this._emit('milestone', 'Plan updated', String(text).slice(0, 160), raw);
      }
      return;
    }
  }

  _extractItemText(item) {
    if (typeof item?.text === 'string') return item.text;
    if (typeof item?.message === 'string') return item.message;
    if (Array.isArray(item?.content)) {
      return item.content
        .map((part) => {
          if (typeof part === 'string') return part;
          return part?.text || '';
        })
        .join('');
    }
    return '';
  }
}

// ─── Vibe Runner ──────────────────────────────────────────────────────────
//
// Spawns: vibe --prompt "<prompt>" --output streaming
//
// Vibe outputs newline-delimited JSON (NDJSON) — clean and easy to parse.
// ──────────────────────────────────────────────────────────────────────────

class VibeRunner extends AgentRunner {
  run(input) {
    this._stopped = false;
    const { prompt } = normalizeRunInput(input);
    const env = buildAgentEnv();
    this._proc = spawn('vibe', ['--prompt', prompt, '--output', 'streaming'], {
      cwd: this._cwd,
      env,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._emit('milestone', 'Vibe starting', 'Initializing agent…');

    let buffer = '';

    this._proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const clean = line.trim();
        if (clean) this._parseLine(clean);
      }
    });

    this._proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log('[Vibe stderr]', msg);
    });

    this._proc.on('error', (err) => {
      const isNotFound = err.code === 'ENOENT';
      this._emit('error',
        isNotFound ? 'Vibe not installed' : 'Vibe error',
        isNotFound ? 'Run: npm install -g @mistral-ai/vibe' : err.message,
      );
    });

    this._proc.on('close', (code) => {
      if (buffer.trim()) this._parseLine(buffer.trim());
      if (code !== 0 && code !== null) {
        this._emit('error', 'Vibe exited', `Exit code ${code}`);
      }
      this.emit('done');
    });
  }

  _parseLine(line) {
    const obj = this._tryParseJSON(line);
    if (!obj) return; // Vibe always outputs JSON in streaming mode

    const role    = obj.role  || '';
    const msgType = obj.type  || '';

    // Tool call
    if (msgType === 'tool_call' || (role === 'assistant' && Array.isArray(obj.tool_calls))) {
      const calls = obj.tool_calls || [obj];
      for (const tc of calls) {
        const name = tc.function?.name || tc.name || 'unknown';
        const { isMilestone, label } = this._classifyTool(name);
        let detail = '';
        try {
          const args = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.input || tc.arguments || {});
          detail = args.query || args.cmd || args.path || args.url || args.input || '';
        } catch {}
        this._emit(isMilestone ? 'milestone' : 'tool_call', label, String(detail).slice(0, 100), obj);
      }
      return;
    }

    // Tool result
    if (msgType === 'tool_result' || role === 'tool') {
      this._emit('tool_result', 'Result received', '', obj);
      return;
    }

    // Assistant message / final response
    if (role === 'assistant' || msgType === 'message') {
      let text = '';
      if (typeof obj.content === 'string') {
        text = obj.content;
      } else if (Array.isArray(obj.content)) {
        text = obj.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('');
      }
      if (text) {
        this._emit('response', 'Response', text, obj);
      }
    }
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

function createRunner(backend, options = {}) {
  switch ((backend || '').toLowerCase()) {
    case 'vibe':  return new VibeRunner(options);
    case 'codex':
    default:      return new CodexRunner(options);
  }
}

module.exports = {
  createRunner,
  CodexRunner,
  VibeRunner,
  buildAgentEnv,
  patchProcessPath,
  resolveCodexCommand,
  preResolveCodexCmd,
  checkAgentInstallation,
};
