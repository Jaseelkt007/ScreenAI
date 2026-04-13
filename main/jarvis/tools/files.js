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

module.exports = {
  createFile,
  readFile,
  writeFile,
  appendFile,
  listDir,
  createDir,
  // Exported for tests
  resolveJarvisPath,
  LOCATION_MAP,
};
