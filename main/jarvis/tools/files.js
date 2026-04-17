'use strict';

/**
 * tools/files.js — File system operations for the Jarvis pipeline.
 *
 * Pure Node.js module — never imports from Electron. Uses os.homedir() and
 * path.join() only so this file is fully testable with plain `node`.
 *
 * Default write target: ~/Documents/Jarvis/
 * All paths must remain inside os.homedir(). Anything outside is rejected.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ─── Path resolution ────────────────────────────────────────────────────────

const HOME = os.homedir();

const LOCATION_MAP = {
  jarvis:    path.join(HOME, 'Documents', 'Jarvis'),
  documents: path.join(HOME, 'Documents'),
  desktop:   path.join(HOME, 'Desktop'),
  downloads: path.join(HOME, 'Downloads'),
};

/**
 * Resolve a spoken filename + optional location hint to an absolute path.
 *
 * @param {string} name          — filename as spoken (e.g. "notes", "notes.txt")
 * @param {string|undefined} locationHint — spoken location keyword or undefined
 * @returns {{ ok: true, absPath: string } | { ok: false, error: string }}
 */
function resolveJarvisPath(name, locationHint) {
  // Reject if name contains path separators or null bytes
  if (!name || /[/\\:*?"<>|\x00]/.test(name)) {
    return { ok: false, error: `Invalid filename: "${name}"` };
  }

  const hint = (locationHint || 'jarvis').toLowerCase().trim();
  let baseDir = LOCATION_MAP[hint];

  if (!baseDir) {
    console.warn(`[files] Unknown locationHint "${hint}" — falling back to jarvis workspace`);
    baseDir = LOCATION_MAP.jarvis;
  }

  const absPath = path.normalize(path.join(baseDir, name));

  // Boundary check — must remain inside HOME
  if (!absPath.startsWith(HOME + path.sep) && absPath !== HOME) {
    return { ok: false, error: `Path outside home directory is not allowed: "${absPath}"` };
  }

  return { ok: true, absPath, baseDir };
}

/**
 * Resolve a directory from a spoken dirHint (no filename involved).
 */
function resolveJarvisDir(dirHint) {
  const hint = (dirHint || 'jarvis').toLowerCase().trim();
  const absPath = LOCATION_MAP[hint];

  if (!absPath) {
    return { ok: false, error: `Unknown directory: "${dirHint}". Try "jarvis", "documents", "desktop", or "downloads".` };
  }

  return { ok: true, absPath };
}

/** Ensure the Jarvis workspace exists (called lazily before any write). */
async function ensureJarvisWorkspace() {
  await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
}

// ─── Tool functions ──────────────────────────────────────────────────────────

/**
 * Create a new empty file (fails if file already exists).
 * @param {{ name: string, locationHint?: string }} params
 * @returns {Promise<ToolResult>}
 */
async function createFile({ name, locationHint }) {
  const resolved = resolveJarvisPath(name, locationHint);
  if (!resolved.ok) return { ok: false, error: resolved.error, action: '' };

  const { absPath } = resolved;
  await ensureJarvisWorkspace();

  if (fs.existsSync(absPath)) {
    return {
      ok: false,
      error: `File already exists: "${path.basename(absPath)}"`,
      action: '',
    };
  }

  await fs.promises.writeFile(absPath, '', 'utf8');
  return {
    ok: true,
    data: { path: absPath, sizeBytes: 0 },
    action: `Created "${path.basename(absPath)}" in ${friendlyDir(path.dirname(absPath))}.`,
  };
}

/**
 * Read a file and return its content.
 * @param {{ name: string, locationHint?: string }} params
 * @returns {Promise<ToolResult>}
 */
async function readFile({ name, locationHint }) {
  const resolved = resolveJarvisPath(name, locationHint);
  if (!resolved.ok) return { ok: false, error: resolved.error, action: '' };

  const { absPath } = resolved;

  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `File not found: "${path.basename(absPath)}"`, action: '' };
  }

  const content = await fs.promises.readFile(absPath, 'utf8');
  const stat = await fs.promises.stat(absPath);
  return {
    ok: true,
    data: { content, sizeBytes: stat.size },
    action: `Read "${path.basename(absPath)}" (${stat.size} bytes).`,
  };
}

/**
 * Write (overwrite) content to a file. Creates the file if it does not exist.
 * @param {{ name: string, locationHint?: string, content: string }} params
 * @returns {Promise<ToolResult>}
 */
async function writeFile({ name, locationHint, content = '' }) {
  const resolved = resolveJarvisPath(name, locationHint);
  if (!resolved.ok) return { ok: false, error: resolved.error, action: '' };

  const { absPath } = resolved;
  await ensureJarvisWorkspace();
  await fs.promises.writeFile(absPath, content, 'utf8');
  const stat = await fs.promises.stat(absPath);
  return {
    ok: true,
    data: { path: absPath, sizeBytes: stat.size },
    action: `Wrote ${stat.size} bytes to "${path.basename(absPath)}".`,
  };
}

/**
 * Append content to a file. Creates the file if it does not exist.
 * @param {{ name: string, locationHint?: string, content: string }} params
 * @returns {Promise<ToolResult>}
 */
async function appendFile({ name, locationHint, content = '' }) {
  const resolved = resolveJarvisPath(name, locationHint);
  if (!resolved.ok) return { ok: false, error: resolved.error, action: '' };

  const { absPath } = resolved;
  await ensureJarvisWorkspace();

  let priorSize = 0;
  if (fs.existsSync(absPath)) {
    priorSize = (await fs.promises.stat(absPath)).size;
  }

  await fs.promises.appendFile(absPath, content, 'utf8');
  const stat = await fs.promises.stat(absPath);
  return {
    ok: true,
    data: { path: absPath, sizeBytes: stat.size, priorSize },
    action: `Appended ${stat.size - priorSize} bytes to "${path.basename(absPath)}".`,
  };
}

/**
 * List the contents of a directory.
 * @param {{ dirHint?: string }} params
 * @returns {Promise<ToolResult>}
 */
async function listDir({ dirHint } = {}) {
  const resolved = resolveJarvisDir(dirHint || 'jarvis');
  if (!resolved.ok) return { ok: false, error: resolved.error, action: '' };

  const { absPath } = resolved;

  // Auto-create the Jarvis workspace if it's the default target and doesn't exist yet
  if (absPath === LOCATION_MAP.jarvis) {
    await ensureJarvisWorkspace();
  }

  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `Directory not found: "${absPath}"`, action: '' };
  }

  const names = await fs.promises.readdir(absPath);
  const entries = await Promise.all(
    names.map(async (n) => {
      const full = path.join(absPath, n);
      try {
        const st = await fs.promises.stat(full);
        return { name: n, type: st.isDirectory() ? 'dir' : 'file', sizeBytes: st.size };
      } catch {
        return { name: n, type: 'unknown', sizeBytes: 0 };
      }
    })
  );

  return {
    ok: true,
    data: { entries },
    action: `Listed ${entries.length} item${entries.length !== 1 ? 's' : ''} in ${friendlyDir(absPath)}.`,
  };
}

/**
 * Create a directory (nested creation supported).
 * @param {{ name: string, locationHint?: string }} params
 * @returns {Promise<ToolResult>}
 */
async function createDir({ name, locationHint }) {
  const resolved = resolveJarvisPath(name, locationHint);
  if (!resolved.ok) return { ok: false, error: resolved.error, action: '' };

  const { absPath } = resolved;
  await fs.promises.mkdir(absPath, { recursive: true });
  return {
    ok: true,
    data: { path: absPath },
    action: `Created folder "${path.basename(absPath)}" in ${friendlyDir(path.dirname(absPath))}.`,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return a human-friendly label for a known directory path. */
function friendlyDir(absDir) {
  for (const [label, dir] of Object.entries(LOCATION_MAP)) {
    if (absDir === dir) return label === 'jarvis' ? 'your Jarvis folder' : `your ${label.charAt(0).toUpperCase() + label.slice(1)} folder`;
  }
  return absDir;
}

// ─── File search: aliases, tokenization, scoring ────────────────────────────

/**
 * Bidirectional document-term synonyms. Expanded on the query side only so
 * "find my CV" also matches files named "resume_Jaseel.pdf".
 */
const DOCUMENT_ALIASES = {
  cv:           ['resume', 'curriculum', 'vitae'],
  resume:       ['cv', 'curriculum', 'vitae'],
  curriculum:   ['cv', 'resume', 'vitae'],
  vitae:        ['cv', 'resume', 'curriculum'],
  thesis:       ['dissertation'],
  dissertation: ['thesis'],
  presentation: ['slides', 'deck'],
  slides:       ['presentation', 'deck'],
  deck:         ['presentation', 'slides'],
  invoice:      ['bill', 'receipt'],
  bill:         ['invoice', 'receipt'],
  receipt:      ['invoice', 'bill'],
  contract:     ['agreement'],
  agreement:    ['contract'],
  report:       ['summary'],
  budget:       ['finance', 'finances'],
};

const KNOWN_EXTENSIONS = new Set([
  'pdf','docx','doc','xlsx','xls','pptx','ppt',
  'txt','md','json','csv','log','html','js','py',
  'png','jpg','jpeg','gif','mp4','mov','zip',
]);

const QUERY_STOP_WORDS = new Set([
  'a','an','the','my','your','this','that',
  'file','files','document','documents','doc','docs',
  'in','on','at','with','for','to','of','from',
  'please','now',
]);

/**
 * Split a query string into normalized tokens, pulling out a trailing
 * extension if present (either `.pdf` or a bare trailing `pdf` token).
 *
 * @param {string} query
 * @returns {{ tokens: string[], extension: string|null }}
 */
function tokenizeQuery(query) {
  if (!query) return { tokens: [], extension: null };
  let lower = String(query).toLowerCase().trim();

  let extension = null;
  const extMatch = lower.match(/\.([a-z0-9]{2,5})$/);
  if (extMatch && KNOWN_EXTENSIONS.has(extMatch[1])) {
    extension = extMatch[1];
    lower = lower.slice(0, -extMatch[0].length);
  }

  let tokens = lower
    .split(/[\s_.\-]+/)
    .filter(Boolean)
    .filter((t) => !QUERY_STOP_WORDS.has(t));

  if (!extension && tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (KNOWN_EXTENSIONS.has(last)) {
      extension = last;
      tokens = tokens.slice(0, -1);
    }
  }

  return { tokens, extension };
}

/** Expand a token list with document aliases (union, preserves order of first occurrence). */
function expandAliases(tokens) {
  const seen = new Set();
  const out  = [];
  for (const t of tokens) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
    const aliases = DOCUMENT_ALIASES[t];
    if (aliases) {
      for (const a of aliases) {
        if (!seen.has(a)) { seen.add(a); out.push(a); }
      }
    }
  }
  return out;
}

/**
 * Score a filename against expanded query tokens + optional extension.
 *
 *   exact token in filename stem    → +10
 *   substring of filename (lower)   → +5
 *   matching extension              → +2 bonus
 *   specified extension mismatch    → rejected (score 0)
 */
function scoreFile(fileName, queryTokens, extension) {
  if (!fileName) return 0;
  const lower  = fileName.toLowerCase();
  const dot    = lower.lastIndexOf('.');
  const ext    = dot >= 0 ? lower.slice(dot + 1) : '';
  const stem   = dot >= 0 ? lower.slice(0, dot) : lower;

  if (extension && ext !== extension.toLowerCase()) return 0;

  const stemTokens = stem.split(/[\s_.\-]+/).filter(Boolean);
  const stemSet    = new Set(stemTokens);

  let score = 0;
  for (const qt of queryTokens) {
    if (!qt) continue;
    if (stemSet.has(qt)) {
      score += 10;
    } else if (lower.includes(qt)) {
      score += 5;
    }
  }

  if (extension && ext === extension.toLowerCase()) score += 2;
  return score;
}

/**
 * Search for files matching a spoken query using a broad PowerShell scan
 * followed by JS-side tokenize/alias-expand/fuzzy-score ranking.
 *
 * @param {{ query?: string, extension?: string, locationHint?: string }} params
 * @returns {Promise<ToolResult>}
 */
async function findFiles({ query, extension, locationHint } = {}) {
  if (!query && !extension) {
    return { ok: false, error: 'No search query provided.', action: '' };
  }

  const { runPS }   = require('./ps-runner');
  const settings    = require('../../settings');

  const hint = locationHint ? locationHint.toLowerCase().trim() : null;

  // Build PowerShell search roots using [System.Environment]::GetFolderPath()
  // so OneDrive-redirected Desktop/Documents are resolved correctly.
  let psRootsBlock;
  let searchedIn;
  if (hint && LOCATION_MAP[hint]) {
    let psRootExpr;
    if (hint === 'desktop') {
      psRootExpr = `[System.Environment]::GetFolderPath('Desktop')`;
    } else if (hint === 'documents') {
      psRootExpr = `[System.Environment]::GetFolderPath('MyDocuments')`;
    } else {
      const psPath = LOCATION_MAP[hint].replace(/'/g, "''");
      psRootExpr = `'${psPath}'`;
    }
    psRootsBlock = `$searchRoots = @(${psRootExpr})`;
    searchedIn   = friendlyDir(LOCATION_MAP[hint]);
  } else {
    psRootsBlock = `$searchRoots = @([System.Environment]::GetFolderPath('MyDocuments'), [System.Environment]::GetFolderPath('Desktop'))`;
    searchedIn   = 'Documents and Desktop';
  }

  const depth = settings.getFileSearchDepth ? settings.getFileSearchDepth() : 3;

  const parsed         = tokenizeQuery(query);
  const baseTokens     = parsed.tokens;
  const finalExt       = (extension || parsed.extension || '').toLowerCase() || null;
  const expandedTokens = expandAliases(baseTokens);

  const psScript = `
${psRootsBlock}
$results = @()
foreach ($root in $searchRoots) {
  if (Test-Path $root) {
    try {
      $results += Get-ChildItem -Path $root -Recurse -Depth ${depth} -File -ErrorAction SilentlyContinue |
        Select-Object Name, FullName, @{N='LastWriteTime';E={$_.LastWriteTime.ToString('o')}}, Length
    } catch {}
  }
}
$results | ConvertTo-Json -Depth 1
`.trim();

  console.log('[findFiles] query:', query, '| ext:', extension, '| hint:', locationHint);
  console.log('[findFiles] baseTokens:', baseTokens, '| expandedTokens:', expandedTokens, '| finalExt:', finalExt);

  const psResult = await runPS(psScript, { timeoutMs: 8000 });

  console.log('[findFiles] PS ok:', psResult.ok, '| stdout length:', psResult.stdout?.length, '| stderr:', psResult.stderr?.slice(0, 200));

  let allFiles = [];
  if (psResult.stdout && psResult.stdout.trim()) {
    try {
      const parsedJson = JSON.parse(psResult.stdout.trim());
      const items      = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const homeLower  = HOME.toLowerCase();
      allFiles = items
        .filter((item) => item && item.FullName && item.Name)
        .filter((item) => item.FullName.toLowerCase().startsWith(homeLower + path.sep.toLowerCase()));
    } catch (e) {
      console.log('[findFiles] JSON parse error:', e.message, '| raw stdout:', psResult.stdout.slice(0, 300));
    }
  }

  console.log('[findFiles] allFiles count:', allFiles.length, '| samples:', allFiles.slice(0, 5).map(f => f.Name));

  // Score candidates. If the user specified only an extension, use every
  // matching-extension file (score=10) — tokens are empty so scoreFile returns 0.
  let scored;
  if (baseTokens.length === 0 && finalExt) {
    scored = allFiles
      .filter((item) => item.Name.toLowerCase().endsWith('.' + finalExt))
      .map((item) => ({
        name:       item.Name,
        path:       item.FullName,
        sizeBytes:  item.Length || 0,
        modifiedAt: item.LastWriteTime,
        score:      10,
      }));
  } else {
    scored = allFiles
      .map((item) => ({
        name:       item.Name,
        path:       item.FullName,
        sizeBytes:  item.Length || 0,
        modifiedAt: item.LastWriteTime,
        score:      scoreFile(item.Name, expandedTokens, finalExt),
      }))
      .filter((x) => x.score > 0);
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || ''));
  });

  const topMatches = scored.slice(0, 10).map(({ score, ...rest }) => rest);
  const searchKey  = query || extension;

  if (topMatches.length === 0) {
    const extraAliases = expandedTokens.filter((t) => !baseTokens.includes(t));
    const aliasHint    = extraAliases.length ? ` (also tried: ${extraAliases.join(', ')})` : '';
    const tokenHint    = baseTokens.length ? ` using tokens [${baseTokens.join(', ')}]${aliasHint}` : aliasHint;
    return {
      ok:     false,
      error:  `No files matching "${searchKey}" found in ${searchedIn}${tokenHint}.`,
      action: '',
    };
  }

  const actionText = topMatches.length === 1
    ? `Found ${topMatches[0].name} in ${friendlyDir(path.dirname(topMatches[0].path))}.`
    : `Found ${topMatches.length} files matching "${searchKey}". Showing the most recent.`;

  return {
    ok:   true,
    data: {
      matches:        topMatches,
      searchedIn,
      query:          searchKey,
      tokens:         baseTokens,
      expandedTokens,
      extension:      finalExt,
    },
    action: actionText,
  };
}

/**
 * Open a file using the OS default application via Electron's shell.openPath.
 * The resolved path must be within the user's home directory.
 *
 * @param {{ path: string }} params
 * @returns {Promise<ToolResult>}
 */
async function openFile({ path: filePath }) {
  if (!filePath) {
    return { ok: false, error: 'No file path provided.', action: '' };
  }

  const absPath = path.resolve(filePath);

  // Safety: must be within home directory
  if (!absPath.startsWith(HOME + path.sep) && absPath !== HOME) {
    return { ok: false, error: 'Path outside home directory is not allowed.', action: '' };
  }

  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `File not found: "${path.basename(absPath)}"`, action: '' };
  }

  // Lazy require — shell is only available inside Electron
  let shell;
  try {
    ({ shell } = require('electron'));
  } catch {
    return { ok: false, error: 'File open requires Electron context (Tier B only).', action: '' };
  }

  const openError = await shell.openPath(absPath);
  if (openError) {
    return { ok: false, error: openError, action: '' };
  }

  return {
    ok:     true,
    data:   { path: absPath, opened: true },
    action: `Opened "${path.basename(absPath)}".`,
  };
}

module.exports = {
  createFile,
  readFile,
  writeFile,
  appendFile,
  listDir,
  createDir,
  findFiles,
  openFile,
  // Exported for tests
  resolveJarvisPath,
  LOCATION_MAP,
  tokenizeQuery,
  expandAliases,
  scoreFile,
  DOCUMENT_ALIASES,
};
