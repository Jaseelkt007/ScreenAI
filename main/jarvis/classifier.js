'use strict';

/**
 * classifier.js — Two-tier intent classifier for the Jarvis pipeline.
 *
 * Tier 1: RegExp pattern table — sub-millisecond, no API call.
 * Tier 2: Gemini LLM fallback — optional, injectable, only when pattern misses.
 *
 * The LLM call function is a parameter with a default so it can be stubbed
 * in Tier A tests without any network call or Electron context.
 *
 * Pure Node.js — no Electron imports.
 */

const settings = require('../settings');
const { INTENT_SYSTEM_PROMPT } = require('./prompts/intent');
const { APP_NAMES } = require('./tools/app-names');

// Build regex alternation string from APP_NAMES keys (e.g. "notepad|chrome|edge|...")
// Sorted longest-first so longer names win over shorter subsets.
// Keys are regex-escaped so names like "notepad++" don't cause SyntaxError.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const APP_NAMES_ALTS = Object.keys(APP_NAMES)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegex)
  .join('|');

// ─── Pattern table ───────────────────────────────────────────────────────────
// Rules are evaluated in order — first match wins.
// Each entry: { intent, pattern: RegExp, extract: (match, transcript) => params }

const PATTERN_TABLE = [
  // ── file.mkdir — check before file.create to avoid "folder" matching "file" rules ──
  {
    intent:  'file.mkdir',
    pattern: /\b(create|make|new)\b.{0,30}\b(folder|directory|dir)\b/i,
    extract: (m, t) => ({
      name:         extractName(t) || extractAfterKeyword(t, ['called', 'named', 'folder', 'directory']) || 'new folder',
      locationHint: extractLocation(t),
    }),
  },

  // ── file.create ──
  {
    intent:  'file.create',
    pattern: /\b(create|make|new)\b.{0,40}\b(file|document|doc|txt|text file|note)\b/i,
    extract: (m, t) => ({
      name:         ensureExtension(extractName(t) || extractAfterKeyword(t, ['called', 'named']) || 'untitled.txt'),
      locationHint: extractLocation(t),
    }),
  },

  // ── file.create (touch <filename>) — Unix-style "touch notes.txt" ──
  {
    intent:  'file.create',
    pattern: /\btouch\s+[\w.-]+/i,
    extract: (m, t) => ({
      name:         ensureExtension(extractFilenameWithExt(t) || (t.match(/\btouch\s+([\w.-]+)/i)?.[1]) || 'untitled.txt'),
      locationHint: extractLocation(t),
    }),
  },

  // ── file.append — check before file.write ──
  {
    intent:  'file.append',
    pattern: /\b(append|add|attach)\b.{0,60}\b(to|into)\b/i,
    extract: (m, t) => ({
      name:         ensureExtension(extractFilenameWithExt(t) || extractName(t) || 'notes.txt'),
      content:      extractAppendContent(t),
      locationHint: extractLocation(t),
    }),
    needsConfirm: false,
  },

  // ── file.write ──
  {
    intent:  'file.write',
    pattern: /\b(write|save|put|set)\b.{0,60}\b(to|into|in)\b.{0,60}\.(txt|md|json|log|csv)\b/i,
    extract: (m, t) => ({
      name:         extractFilenameWithExt(t),
      content:      extractWriteContent(t),
      locationHint: extractLocation(t),
    }),
    needsConfirm: true,
  },

  // ── file.write (alternate: "save X to file Y") ──
  {
    intent:  'file.write',
    pattern: /\b(write|save)\b.{0,80}\b(file|document)\b/i,
    extract: (m, t) => ({
      name:         ensureExtension(extractName(t) || extractAfterKeyword(t, ['file', 'document']) || 'notes.txt'),
      content:      extractWriteContent(t),
      locationHint: extractLocation(t),
    }),
    needsConfirm: true,
  },

  // ── file.read ──
  {
    intent:  'file.read',
    pattern: /\b(read|open|show|display|print)\b.{0,40}\b(file|document|content|text)\b/i,
    extract: (m, t) => ({
      name:         ensureExtension(extractName(t) || extractAfterKeyword(t, ['file', 'document', 'called', 'named']) || ''),
      locationHint: extractLocation(t),
    }),
  },

  // ── file.read (what's in X.ext) ──
  {
    intent:  'file.read',
    pattern: /\bwhat('s| is)\b.{0,40}\.(txt|md|json|log|csv)\b/i,
    extract: (m, t) => ({
      name:         extractFilenameWithExt(t),
      locationHint: extractLocation(t),
    }),
  },

  // ── file.list ──
  {
    intent:  'file.list',
    pattern: /\b(list|show|display|what'?s?\s+in|what is in)\b.{0,50}\b(folder|directory|documents|desktop|downloads|jarvis)\b/i,
    extract: (m, t) => ({
      dirHint: extractLocation(t) || 'jarvis',
    }),
  },

  // ── app.close — before app.open to prevent "close" being caught by open/read patterns ──
  // Pattern is built dynamically from APP_NAMES so adding an app there updates this too.
  {
    intent:  'app.close',
    pattern: new RegExp(`\\b(close|quit|exit|terminate|shut\\s+down)\\b.{0,40}\\b(${APP_NAMES_ALTS})\\b`, 'i'),
    extract: (m, t) => ({ appName: extractTargetAppName(t) }),
  },

  // ── app.focus ──
  {
    intent:  'app.focus',
    pattern: new RegExp(`\\b(focus|switch\\s+to|bring(?:\\s+up)?|show|foreground|go\\s+to)\\b.{0,40}\\b(${APP_NAMES_ALTS})\\b`, 'i'),
    extract: (m, t) => ({ appName: extractTargetAppName(t) }),
  },

  // ── window.minimize ──
  {
    intent:  'window.minimize',
    pattern: /\b(minimize|minimise|hide\s+window)\b/i,
    extract: (m, t) => ({ appName: extractTargetAppName(t) || null }),
  },

  // ── window.maximize ──
  {
    intent:  'window.maximize',
    pattern: /\b(maximize|maximise|full.?screen|make\s+it\s+bigger|expand\s+window)\b/i,
    extract: (m, t) => ({ appName: extractTargetAppName(t) || null }),
  },

  // ── window.switch ──
  {
    intent:  'window.switch',
    pattern: /\b(switch\s+window|alt.?tab|go\s+to\s+(last|previous|next)\s+window|next\s+window)\b/i,
    extract: () => ({}),
  },

  // ── system.lock — check first among system intents to avoid "lock" matching other rules ──
  {
    intent:  'system.lock',
    pattern: /\b(lock|lock\s+(?:the\s+|my\s+)?(?:screen|computer|pc|laptop|session))\b/i,
    extract: () => ({}),
    needsConfirm: true,
  },

  // ── system.volume ──
  {
    intent:  'system.volume',
    pattern: /\b(mute|silence|unmute)\b|\b(volume|sound)\b.{0,25}\b(up|down|louder|quieter|higher|lower|increase|decrease|max|maximum|min|minimum)\b|\b(increase|decrease|raise|lower|turn\s+up|turn\s+down|crank\s+up)\b.{0,15}\b(volume|sound)\b|\bset\s+(?:the\s+)?volume\s+to\s+(?:\d+|zero|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|max(?:imum)?|full|min(?:imum)?)|\b(louder|quieter)\b/i,
    extract: (m, t) => extractVolumeParams(t),
  },

  // ── system.brightness ──
  {
    intent:  'system.brightness',
    pattern: /\b(brightness)\b.{0,20}\b(up|down|higher|lower|increase|decrease|more|less|max|min|dim)\b|\b(dim|brighten)\b.{0,20}\b(screen|display)\b|\b(increase|decrease)\b.{0,15}\b(brightness)\b/i,
    extract: (m, t) => ({
      action: /\b(up|higher|increase|more|brighten|max)\b/i.test(t) ? 'up' : 'down',
    }),
  },

  // ── app.open ──
  {
    intent:  'app.open',
    pattern: /\b(open|launch|start|run)\b.{0,30}\b(chrome|firefox|edge|safari|notepad|calculator|calc|vscode|vs code|visual studio code|code|word|excel|powerpoint|spotify|slack|teams|terminal|cmd|command prompt|powershell|paint|explorer|file explorer)\b/i,
    extract: (m, t) => ({
      appName: extractAppName(t),
    }),
  },

  // ── browser.newtab — before browser.closetab; explicit "new tab" only ──
  // Intentionally excludes bare "open tab" — too vague and collision-prone.
  {
    intent:  'browser.newtab',
    pattern: /\b(new\s+tab|open\s+(?:a\s+)?new\s+tab|create\s+(?:a\s+)?tab)\b/i,
    extract: () => ({}),
  },

  // ── browser.closetab — explicit tab phrasing; does NOT collide with app.close ──
  {
    intent:  'browser.closetab',
    pattern: /\b(close\s+(?:this\s+|the\s+|current\s+)?tab|shut\s+the\s+tab)\b/i,
    extract: () => ({}),
  },

  // ── browser.back ──
  {
    intent:  'browser.back',
    pattern: /\b(go\s+back|browser\s+back|previous\s+page|back\s+button|navigate\s+back)\b/i,
    extract: () => ({}),
  },

  // ── browser.refresh ──
  {
    intent:  'browser.refresh',
    pattern: /\b(refresh|reload|reload\s+page|refresh\s+page|reload\s+tab|refresh\s+tab)\b/i,
    extract: () => ({}),
  },

  // ── browser.addressbar ──
  {
    intent:  'browser.addressbar',
    pattern: /\b(focus\s+address\s+bar|go\s+to\s+(?:url|address)\s+bar|open\s+address\s+bar|url\s+bar|address\s+bar)\b/i,
    extract: () => ({}),
  },

  // ── browser.open ──
  {
    intent:  'browser.open',
    pattern: /\b(open|launch)\b.{0,30}\b(browser|web browser|internet|the web)\b/i,
    extract: () => ({}),
  },

  // ── browser.site — named site shortcuts ("open Gmail", "go to YouTube") ──
  // Must be placed BEFORE browser.goto so "go to YouTube" hits this first.
  // app.open fires before this rule, so "open Chrome" still routes to app.open.
  // (?!\.) negative lookahead ensures "youtube.com" does NOT match here —
  // domain-suffixed inputs (e.g. "go to youtube.com") fall through to browser.goto.
  {
    intent:  'browser.site',
    pattern: /\b(open|go to|visit|launch|load|navigate to)\b.{0,20}\b(gmail|youtube|github|linkedin|twitter|reddit|calendar|google calendar|notion|stackoverflow|stack overflow|google docs|google drive|google maps|chatgpt|claude|netflix|spotify web|amazon|google)\b(?!\.)/i,
    extract: (m, t) => ({ siteName: extractSiteName(t) }),
  },

  // ── browser.goto (explicit URL with scheme) ──
  {
    intent:  'browser.goto',
    pattern: /https?:\/\/\S+/i,
    extract: (m) => ({
      url: m[0],
    }),
  },

  // ── browser.goto ("go to", "navigate to", "open X.com") ──
  {
    intent:  'browser.goto',
    pattern: /\b(go to|navigate to|visit|open)\b.{0,40}\b[\w-]+\.(com|org|net|io|co|app|dev|edu|gov)\b/i,
    extract: (m, t) => ({
      url: extractUrl(t),
    }),
  },

  // ── browser.search ──
  {
    intent:  'browser.search',
    pattern: /\b(search|google|look up|find|look for|search for)\b.{1,120}/i,
    extract: (m, t) => ({
      query: extractSearchQuery(t),
    }),
  },

  // ── clipboard.write ──
  {
    intent:  'clipboard.write',
    pattern: /\b(copy|clipboard|copy to clipboard)\b.{0,10}[:.]\s*(.+)/i,
    extract: (m) => ({
      text: m[2] ? m[2].trim() : '',
    }),
  },

  // ── clipboard.write (alternate: "put X in/to clipboard") ──
  {
    intent:  'clipboard.write',
    pattern: /\bput\b.{0,40}\b(clipboard|clip board)\b/i,
    extract: (m, t) => ({
      text: extractClipboardContent(t),
    }),
  },

  // ── input.shortcut — named unambiguous aliases (save as before save, select all before others) ──
  // Excluded aliases: "open","close","new","find","print" — collide with other intent patterns.
  {
    intent:  'input.shortcut',
    pattern: /\b(save\s+as|select\s+all|undo|redo|copy|paste|cut|save)\b/i,
    extract: (m, t) => ({ combo: extractNamedShortcut(t) }),
  },

  // ── input.shortcut — spoken modifier combos ("press control c", "hit ctrl shift s") ──
  {
    intent:  'input.shortcut',
    pattern: /\b(press|hit|use)\b.{0,40}\b(ctrl|control|alt|shift)\b/i,
    extract: (m, t) => ({ combo: extractShortcutCombo(t) }),
  },

  // ── input.key — single named key presses ("press enter", "press escape") ──
  // Placed after input.shortcut so "press control enter" hits shortcut first.
  {
    intent:  'input.key',
    pattern: /\bpress\b.{0,20}\b(enter|return|escape|esc|delete|del|backspace|space|tab|home|end|page\s+up|page\s+down|up|down|left|right)\b/i,
    extract: (m, t) => ({ key: extractKeyName(t) }),
  },

  // ── input.type — catch-all for typing commands (MUST be last in table) ──
  // Placed after all file.write patterns — pattern ordering prevents "write X to file.txt"
  // from being swallowed here (file.write checks extension/file keyword first).
  // Multi-word triggers listed BEFORE single-word ones so the longer keyword wins.
  {
    intent:  'input.type',
    pattern: /\b(type\s+this|write\s+this|write\s+out|enter\s+this|type|input)\b[:\s]+(.+)/i,
    extract: (m, t) => ({ text: extractTypedText(t) }),
    // needsConfirm is handled by inferNeedsConfirm (reads jarvisInputConfirmMode setting)
  },
];

// Compile all patterns once at load
const COMPILED = PATTERN_TABLE.map((rule) => ({
  ...rule,
  regex: rule.pattern instanceof RegExp ? rule.pattern : new RegExp(rule.pattern, 'i'),
}));

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify a transcript into a ClassifierResult.
 *
 * @param {string}   transcript — transcribed voice command
 * @param {Function} [llmFn]   — injectable LLM caller; defaults to geminiLlmFallback.
 *                               In Tier A tests, pass a stub that returns a fixed result.
 * @returns {Promise<ClassifierResult>}
 */
async function classify(transcript, llmFn) {
  // Strip trailing punctuation that STT frequently appends ("Can you open Spotify?")
  // The ? breaks regex $ anchors and causes param extraction to return empty string.
  const t = (transcript || '').trim().replace(/[?.!,…]+$/, '').trim();
  if (!t) {
    return unsupported(t, 'Empty transcript.');
  }

  // ── Tier 1: pattern match ──
  const lower = t.toLowerCase();
  for (const rule of COMPILED) {
    const match = lower.match(rule.regex) || t.match(rule.regex);
    if (match) {
      const params = rule.extract(match, t);
      return {
        intent:       rule.intent,
        confidence:   'pattern',
        params,
        raw:          t,
        needsConfirm: rule.needsConfirm === true || inferNeedsConfirm(rule.intent, params),
      };
    }
  }

  // ── Tier 2: LLM fallback (optional) ──
  const llmEnabled = settings.getSetting('jarvisLlmFallback', true);
  const apiKey     = settings.getApiKey();

  if (!llmEnabled || !apiKey) {
    return unsupported(t, 'Command not recognised. Try rephrasing.');
  }

  const callLlm = llmFn || geminiLlmFallback;
  try {
    const result = await callLlm(t, apiKey);
    if (!result || !result.intent) throw new Error('Invalid LLM response');
    return result;
  } catch (err) {
    console.warn('[classifier] LLM fallback failed:', err.message);
    return unsupported(t, 'Command not recognised. Try rephrasing.');
  }
}

// ─── LLM fallback ────────────────────────────────────────────────────────────

async function geminiLlmFallback(transcript, apiKey) {
  const fetch = (await import('node-fetch')).default;
  const model = 'gemini-2.5-flash-preview-04-17';
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: INTENT_SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: transcript }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature:      0.1,
      maxOutputTokens:  256,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`Gemini API error ${res.status}`);

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No text in Gemini response');

    const parsed = JSON.parse(text);
    parsed.confidence = 'llm';
    parsed.raw = transcript;
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unsupported(raw, reason) {
  return { intent: 'system.unsupported', confidence: 'pattern', params: {}, raw, needsConfirm: false, reason };
}

function inferNeedsConfirm(intent, params) {
  // file.write always confirm (may overwrite); file.append confirm if long content
  if (intent === 'file.write') return true;
  if (intent === 'file.append' && params.content && params.content.length > 200) return true;
  // input.type: length-based confirm controlled by jarvisInputConfirmMode setting
  // Architecture note (Phase 3 candidate): this mixes policy into the classifier.
  // Cleaner long-term design: classifier emits {intent, params} only; policy layer
  // decides needsConfirm. Acceptable for Phase 2 speed. Revisit in Phase 3.
  if (intent === 'input.type') {
    const mode = settings.getSetting('jarvisInputConfirmMode', 'long_only');
    if (mode === 'always') return true;
    if (mode === 'never')  return false;
    return !!(params.text && params.text.length >= 80); // 'long_only' default
  }
  return false;
}

// ─── Param extraction helpers ─────────────────────────────────────────────────

/** Extract filename from "called X", "named X" patterns. */
function extractName(t) {
  const m = t.match(/\b(?:called|named)\s+([\w\s.-]+?)(?:\s+(?:in|on|to|at|the)\b|$)/i);
  if (m) return m[1].trim();
  return null;
}

/** Extract text after a specific keyword. */
function extractAfterKeyword(t, keywords) {
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw}\\s+([\\w.\\s-]+?)(?:\\s+(?:in|on|to|at|the)\\b|$)`, 'i');
    const m  = t.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/** Extract a filename with extension from the transcript. */
function extractFilenameWithExt(t) {
  const m = t.match(/\b([\w.-]+\.(txt|md|json|log|csv|html|js|py))\b/i);
  return m ? m[1] : null;
}

/** Extract the location/directory hint from spoken location words. */
function extractLocation(t) {
  const lower = t.toLowerCase();
  if (/\bdesktop\b/.test(lower))   return 'desktop';
  if (/\bdownload/.test(lower))    return 'downloads';
  if (/\bdocument/.test(lower))    return 'documents';
  if (/\bjarvis\b/.test(lower))    return 'jarvis';
  return undefined; // default — tools/files.js will use 'jarvis'
}

/** Ensure a filename has a .txt extension if no extension present. */
function ensureExtension(name) {
  if (!name) return 'untitled.txt';
  return /\.\w{2,4}$/.test(name) ? name : name + '.txt';
}

/** Extract the app name from an "open X" command. */
function extractAppName(t) {
  // Trailing punctuation is already stripped in classify() before t reaches here,
  // but the trailing [?.!,] group is kept as a belt-and-suspenders fallback.
  const m = t.match(/\b(?:open|launch|start|run)\s+([\w\s]+?)(?:\s+(?:please|now|for me)\b|[?.!,]|$)/i);
  return m ? m[1].trim().toLowerCase() : '';
}

/**
 * Extract the target app name from close/focus/minimize/maximize commands.
 * Scans APP_NAMES keys (longest first) to avoid partial matches.
 * Returns the spoken/key name (lowercased) or null if not found.
 */
function extractTargetAppName(t) {
  const lower = t.toLowerCase();
  // APP_NAMES_ALTS is already sorted longest-first — reuse same order
  const keys = Object.keys(APP_NAMES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return key;
  }
  return null;
}

/** Extract a URL from the transcript. */
function extractUrl(t) {
  // Try full URL first
  const httpMatch = t.match(/https?:\/\/\S+/i);
  if (httpMatch) return httpMatch[0];

  // Try domain pattern after navigation verbs
  const domainMatch = t.match(/\b(?:go to|navigate to|visit|open)\s+([\w-]+\.[a-z]{2,}(?:\/\S*)?)\b/i);
  if (domainMatch) return domainMatch[1];

  // Bare domain
  const bareMatch = t.match(/\b([\w-]+\.(?:com|org|net|io|co|app|dev|edu|gov)(?:\/\S*)?)\b/i);
  return bareMatch ? bareMatch[1] : '';
}

/** Extract content to write to a file. */
function extractWriteContent(t) {
  // "write X to file Y" → X
  const m = t.match(/\b(?:write|save|put)\s+(.+?)\s+(?:to|into|in)\s+(?:file\s+|document\s+)?[\w.]+/i);
  if (m) return m[1].trim();

  // "write: X" or "write, X"
  const delim = t.match(/\b(?:write|save)\b[:.]\s*(.+)/i);
  if (delim) return delim[1].trim();

  return '';
}

/** Extract content to append to a file. */
function extractAppendContent(t) {
  // "append X to file Y" → X
  const m = t.match(/\b(?:append|add|attach)\s+(.+?)\s+(?:to|into)\b/i);
  return m ? m[1].trim() : '';
}

/** Extract text to copy to clipboard. */
function extractClipboardContent(t) {
  const m = t.match(/\bput\s+(.+?)\s+(?:in|into|to|on)\s+(?:the\s+)?(?:clipboard|clip board)/i);
  return m ? m[1].trim() : '';
}

/** Extract search query (everything after the trigger verb). */
function extractSearchQuery(t) {
  const m = t.match(/\b(?:search(?:\s+for)?|google|look\s+up|find|look\s+for)\s+(.+)/i);
  return m ? m[1].trim() : t.trim();
}

// ─── M3.2 extraction helpers ─────────────────────────────────────────────────

// Word-to-number map for spoken volume levels ("set volume to seventy")
const WORD_LEVELS = {
  'zero': 0, 'min': 0, 'minimum': 0,
  'ten': 10, 'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
  'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
  'hundred': 100, 'one hundred': 100, 'max': 100, 'maximum': 100, 'full': 100,
};

/**
 * Extract volume action and level from transcript.
 * Returns { action, level? } for system.volume intent.
 */
function extractVolumeParams(t) {
  const lower = t.toLowerCase();

  if (/\bunmute\b/.test(lower)) return { action: 'unmute' };
  if (/\b(mute|silence)\b/.test(lower)) return { action: 'mute' };

  // "set volume to N" / "set the volume to N%" / "volume at N"
  const setDigit = lower.match(/\bset\s+(?:the\s+)?volume\s+to\s+(\d+)|\bvolume\b.{0,20}\bat\s+(\d+)/);
  if (setDigit) {
    const raw = parseInt(setDigit[1] || setDigit[2], 10);
    return { action: 'set', level: Math.max(0, Math.min(100, raw)) };
  }

  // "set volume to seventy" / "set the volume to max"
  const setWord = lower.match(/\bset\s+(?:the\s+)?volume\s+to\s+(one hundred|zero|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|max(?:imum)?|full|min(?:imum)?)\b/);
  if (setWord) {
    const level = WORD_LEVELS[setWord[1]];
    if (level !== undefined) return { action: 'set', level };
  }

  if (/\b(volume\s+up|sound\s+up|louder|higher\s+volume|increase\s+(?:the\s+)?volume|turn\s+(?:the\s+)?volume\s+up|raise\s+volume)\b/i.test(t)) {
    return { action: 'up' };
  }
  if (/\b(volume\s+down|sound\s+down|quieter|lower\s+volume|decrease\s+(?:the\s+)?volume|turn\s+(?:the\s+)?volume\s+down|reduce\s+volume)\b/i.test(t)) {
    return { action: 'down' };
  }

  // Generic direction words near "volume"
  if (/\b(up|higher|increase|louder|raise|max|maximum)\b/i.test(t)) return { action: 'up' };
  if (/\b(down|lower|decrease|quieter|reduce|min|minimum)\b/i.test(t)) return { action: 'down' };

  return { action: 'up' }; // fallback
}

// ─── M2.2 extraction helpers ──────────────────────────────────────────────────

/**
 * Extract named shortcut alias from the transcript.
 * Returns the normalized combo string (e.g. "ctrl+z") or null.
 * Longer phrases checked before shorter ones to avoid "save" matching before "save as".
 */
function extractNamedShortcut(t) {
  const lower = t.toLowerCase();
  if (/\bsave\s+as\b/.test(lower))    return 'ctrl+shift+s';
  if (/\bselect\s+all\b/.test(lower)) return 'ctrl+a';
  if (/\bundo\b/.test(lower))         return 'ctrl+z';
  if (/\bredo\b/.test(lower))         return 'ctrl+y';
  if (/\bcopy\b/.test(lower))         return 'ctrl+c';
  if (/\bpaste\b/.test(lower))        return 'ctrl+v';
  if (/\bcut\b/.test(lower))          return 'ctrl+x';
  if (/\bsave\b/.test(lower))         return 'ctrl+s';
  return null;
}

/**
 * Extract a modifier-key shortcut combo from "press control c" style transcripts.
 * Returns normalized combo string (e.g. "ctrl+c", "ctrl+shift+s", "alt+left") or null.
 * Uses a finite phrase table — no generalized heuristic parsing.
 */
function extractShortcutCombo(t) {
  // Try named alias first (catches "press save", "press undo" etc.)
  const named = extractNamedShortcut(t);
  if (named) return named;

  const lower = t.toLowerCase();

  // Finite phrase → combo table. Order: longer/more-specific first.
  const SHORTCUT_PHRASES = [
    [/\bctrl\s+shift\s+s\b|\bcontrol\s+shift\s+s\b/,  'ctrl+shift+s'],
    [/\balt\s+left\b/,                                  'alt+left'],
    [/\bctrl\s+c\b|\bcontrol\s+c\b/,                   'ctrl+c'],
    [/\bctrl\s+v\b|\bcontrol\s+v\b/,                   'ctrl+v'],
    [/\bctrl\s+x\b|\bcontrol\s+x\b/,                   'ctrl+x'],
    [/\bctrl\s+z\b|\bcontrol\s+z\b/,                   'ctrl+z'],
    [/\bctrl\s+y\b|\bcontrol\s+y\b/,                   'ctrl+y'],
    [/\bctrl\s+a\b|\bcontrol\s+a\b/,                   'ctrl+a'],
    [/\bctrl\s+s\b|\bcontrol\s+s\b/,                   'ctrl+s'],
    [/\bctrl\s+t\b|\bcontrol\s+t\b/,                   'ctrl+t'],
    [/\bctrl\s+w\b|\bcontrol\s+w\b/,                   'ctrl+w'],
    [/\bctrl\s+l\b|\bcontrol\s+l\b/,                   'ctrl+l'],
    [/\bctrl\s+r\b|\bcontrol\s+r\b/,                   'ctrl+r'],
  ];

  for (const [re, combo] of SHORTCUT_PHRASES) {
    if (re.test(lower)) return combo;
  }

  return null; // Unknown combo → pressShortcut will return "Unsupported shortcut"
}

/**
 * Extract the key name from "press X" commands.
 * Scans KEY_MAP keys (longer names first to avoid "up" matching before "page up").
 * Returns the spoken key name or null.
 */
function extractKeyName(t) {
  const lower = t.toLowerCase();
  // Import KEY_MAP keys from keyboard.js conceptually — we re-list them here
  // to keep the classifier pure (no dependency on the execution layer).
  const KNOWN_KEYS = [
    'page up', 'page down', // multi-word first
    'enter', 'return', 'escape', 'esc',
    'delete', 'del', 'backspace', 'space', 'tab',
    'home', 'end', 'up', 'down', 'left', 'right',
  ];
  for (const key of KNOWN_KEYS) {
    const re = new RegExp(`\\b${escapeRegex(key)}\\b`);
    if (re.test(lower)) return key;
  }
  return null;
}

/**
 * Extract the spoken site name from a browser.site command.
 * Strips trigger verbs and noise words so the raw site name remains.
 * e.g. "open my Gmail" → "gmail", "go to the YouTube website" → "youtube"
 */
function extractSiteName(t) {
  let s = t.toLowerCase().trim();

  // Strip trigger verbs at the start
  s = s.replace(/^(open|go to|visit|launch|load|navigate to)\s+/i, '');

  // Strip leading articles/possessives
  s = s.replace(/^(the|my)\s+/, '');

  // Strip trailing noise words
  s = s.replace(/\s+(website|web|page|site)$/, '');

  return s.trim();
}

/**
 * Extract text to type from "type X", "input X", "type this: X" commands.
 * Returns the raw text string (will be sanitized by keyboard.js).
 */
function extractTypedText(t) {
  // Multi-word triggers FIRST to avoid "type" swallowing "type this".
  // Handles: "type this: hello" | "write this hello" | "write out hello" | "type hello"
  const m = t.match(/\b(?:type\s+this|write\s+this|write\s+out|enter\s+this|type|input)\s*[:\s]\s*(.+)/i);
  return m ? m[1].trim() : '';
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { classify };
