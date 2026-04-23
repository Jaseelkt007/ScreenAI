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
  // ── system.cancel — must be first: anchored, whole-transcript match ──
  // Placed before everything so "cancel" / "never mind" can't accidentally match
  // another rule when the user is cancelling an active disambiguation flow.
  {
    intent:  'system.cancel',
    pattern: /^\s*(cancel|never\s+mind|nevermind|forget\s+it|abort|stop|no|nope)\s*$/i,
    extract: () => ({}),
  },

  // ── system.select — ordinal selection during active disambiguation ──
  // Placed second (before all file/app rules) so bare ordinals fire fast.
  // Anchored: only fires when the entire transcript is an ordinal reference.
  // Includes both cardinal ("one", "two") and ordinal ("first", "second") forms.
  {
    intent:  'system.select',
    pattern: /^\s*(?:the\s+|number\s+|option\s+)?(first|second|third|fourth|fifth|one|two|three|four|five|1|2|3|4|5)\s*(?:one|option|file|match)?\s*$/i,
    extract: (m, t) => ({ ordinal: extractOrdinal(t) }),
  },

  // ── file.open (context pronoun: "open it", "show that file") — M4.3 ──
  // Anchored so only fires when entire transcript is a short pronoun reference.
  // Placed BEFORE generic file.open — more specific wins.
  {
    intent:  'file.open',
    pattern: /^\s*(open|show|launch|load|display)\s+(it|that|that\s+file|the\s+file)\s*$/i,
    extract: () => ({ useContext: true }),
  },

  // ── file.rename (context pronoun: "rename it to X") — M4.3 ──
  {
    intent:  'file.rename',
    pattern: /^\s*(rename|call|name)\s+(it|that|that\s+file|the\s+file)\s+to\s+(.+)\s*$/i,
    extract: (m) => ({ useContext: true, newName: normalizeSpokenFilename(m[3]?.trim()) }),
    needsConfirm: true,
  },

  // ── file.delete (context pronoun: "delete it", "remove that file") — M4.3 ──
  {
    intent:  'file.delete',
    pattern: /^\s*(delete|remove|erase|trash)\s+(it|that|that\s+file|the\s+file)\s*$/i,
    extract: () => ({ useContext: true }),
    needsConfirm: true,
  },

  // ── file.move (context pronoun: "move it to Desktop") — M4.3 ──
  {
    intent:  'file.move',
    pattern: /^\s*(move|transfer|put)\s+(it|that|that\s+file|the\s+file)\s+(?:to|into)\s+(.+)\s*$/i,
    extract: (m, t) => ({ useContext: true, targetLocationHint: extractTargetLocation(t) }),
    needsConfirm: true,
  },

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
  // Second alternative added in Phase 3: "find ... folder/directory" also routes here
  // so "find my documents folder" → file.list instead of file.find.
  {
    intent:  'file.list',
    pattern: /\b(list|show|display|what'?s?\s+in|what is in)\b.{0,50}\b(folder|directory|documents|desktop|downloads|jarvis)\b|\b(find|locate)\b.{0,50}\b(folder|directory)\b/i,
    extract: (m, t) => ({
      dirHint: extractLocation(t) || 'jarvis',
    }),
  },

  // ── file.read (read filename.ext — without "file" keyword) — Phase 3 additive ──
  // Handles "read notes.txt" which the existing file.read pattern misses (no "file/document/content/text").
  // Placed before file.find so "read" + extension → file.read, not file.open.
  {
    intent:  'file.read',
    pattern: /\bread\b.{0,30}[\w\s.-]+\.(txt|pdf|docx|xlsx|pptx|md|json|csv|log|html|js|py|png|jpg|jpeg)\b/i,
    extract: (m, t) => ({
      name:         extractFilenameWithExtExpanded(t) || extractName(t) || '',
      locationHint: extractLocation(t),
    }),
  },

  // ── file.find (keyword search) ──
  // Must be placed AFTER file.list so "find ... folder" routes to file.list first.
  // Secondary keyword list includes location words (desktop/documents/downloads) and
  // common document nouns so "find resume on desktop" and "find cover letter" both match.
  {
    intent:  'file.find',
    pattern: /\b(find|locate|search for|look for|where is|where'?s)\b.{0,50}\b(file|document|doc|pdf|image|photo|video|spreadsheet|my|the|desktop|documents|downloads|jarvis|resume|cv|letter|report|notes|invoice|contract|budget|presentation|thesis|slides|receipt|agreement)\b/i,
    extract: (m, t) => ({
      query:        extractFindQuery(t),
      extension:    extractExtension(t),
      locationHint: extractLocation(t),
    }),
  },

  // ── file.find (with file extension in transcript) ──
  {
    intent:  'file.find',
    pattern: /\b(find|locate|where is|where'?s)\b.{0,40}[\w\s-]+\.(txt|pdf|docx|xlsx|pptx|png|jpg|jpeg|mp4|md|json|csv|zip)\b/i,
    extract: (m, t) => ({
      query:        extractFilenameWithExtExpanded(t),
      locationHint: extractLocation(t),
    }),
  },

  // ── file.delete ──
  {
    intent:  'file.delete',
    pattern: /\b(delete|remove|erase|trash)\b.{0,50}\b(file|document|[\w.-]*\.(txt|pdf|docx|md|json|csv|xlsx|png|jpg|jpeg|log|html|pptx|mp4|zip))\b/i,
    extract: (m, t) => ({
      name:         normalizeSpokenFilename(extractFilenameWithExtExpanded(t) || extractName(t) || extractDeleteTarget(t)),
      locationHint: extractLocation(t),
    }),
    needsConfirm: true,
  },

  // ── file.rename ──
  {
    intent:  'file.rename',
    pattern: /\b(rename|call it|name it|rename\s+(?:the\s+|this\s+)?file)\b.{0,60}\bto\b/i,
    extract: (m, t) => ({
      name:         extractFilenameFromPhrase(t, 'before_to'),
      newName:      extractFilenameFromPhrase(t, 'after_to'),
      locationHint: extractLocation(t),
    }),
    needsConfirm: true,
  },

  // ── file.move ──
  {
    intent:  'file.move',
    pattern: /\b(move|transfer|put)\b.{0,50}[\w.-]+.{0,20}\b(to|into)\b.{0,30}\b(documents|desktop|downloads|jarvis)\b/i,
    extract: (m, t) => ({
      name:               normalizeSpokenFilename(extractFilenameWithExtExpanded(t) || extractName(t) || extractMoveTarget(t)),
      locationHint:       extractLocation(t),
      targetLocationHint: extractTargetLocation(t),
    }),
    needsConfirm: true,
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

  // ── app.open — pattern built from APP_NAMES_ALTS so new apps auto-register ──
  {
    intent:  'app.open',
    pattern: new RegExp(`\\b(open|launch|start|run)\\b.{0,30}\\b(${APP_NAMES_ALTS})\\b`, 'i'),
    extract: (m, t) => ({
      appName: extractTargetAppName(t) || extractAppName(t),
    }),
  },

  // ── file.open (with file extension) ──
  // Must come AFTER app.open — app.open uses APP_NAMES_ALTS which won't match filenames.
  // Must come AFTER file.read so "read notes.txt" hits file.read first.
  {
    intent:  'file.open',
    pattern: /\b(open|show|load|launch|read|display)\b.{0,50}[\w\s-]+\.(txt|pdf|docx|xlsx|pptx|png|jpg|jpeg|mp4|md|json|csv|zip)\b/i,
    extract: (m, t) => ({
      name:         extractFilenameWithExtExpanded(t),
      locationHint: extractLocation(t),
    }),
  },

  // ── file.open (document alias: "open my CV", "show my resume") ──
  {
    intent:  'file.open',
    pattern: /\b(open|show|load|display)\b.{0,20}\b(my\s+)?(cv|resume|thesis|portfolio|report|presentation|budget|invoice|contract)\b/i,
    extract: (m, t) => ({
      name:         extractDocumentAlias(t),
      locationHint: extractLocation(t),
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

  // ── file.find (short-phrase fallback) — placed just before browser.search ──
  // Catches bare "find <noun>" / "locate <noun>" that lacked any keyword cue above.
  // "find resume Jaseel", "find cover letter", "find second_regression.txt" all land here.
  // The ^ anchor + 30-char cap keep it constrained to short filename-style queries.
  // First neg-lookahead: blocks web-search openers ("a ", "me ", "out" etc.).
  // Second neg-lookahead: blocks web-signal words anywhere in the phrase.
  {
    intent:  'file.find',
    pattern: /^\s*(?:find|locate)\s+(?!(?:a\s|me\s|the\s+best\s|out\b|if\b|how\b|what\b|when\b|where\b|who\b))(?![\w\s]{0,25}\b(?:near|around|online|weather|news|flights?|hotels?|restaurants?|recipes?|directions?)\b)[\w][\w\s._-]{1,30}\s*$/i,
    extract: (m, t) => ({
      query:        extractFindQuery(t),
      extension:    extractExtension(t),
      locationHint: extractLocation(t),
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
// File-context verbs that justify normalising spoken punctuation ("underscore",
// "dot pdf"). Only when one of these verbs is present do we rewrite the
// transcript — keeps unrelated commands ("type the word underscore") untouched.
// Destructive verbs (delete/rename/move) are included so "delete hello dot txt"
// and "rename notes dot txt to journal dot txt" are normalized before extraction.
const FILE_CONTEXT_RE = /\b(open|show|load|launch|read|display|find|locate|search\s+for|look\s+for|where'?s|where\s+is|delete|remove|erase|trash|rename|move|transfer)\b/i;

async function classify(transcript, llmFn) {
  // Strip trailing punctuation that STT frequently appends ("Can you open Spotify?")
  // The ? breaks regex $ anchors and causes param extraction to return empty string.
  const rawInput = (transcript || '').trim().replace(/[?.!,…]+$/, '').trim();
  if (!rawInput) {
    return unsupported(rawInput, 'Empty transcript.');
  }

  // Spoken punctuation normalisation — only inside a file-command context so
  // "find resume underscore Jaseel dot pdf" becomes "find resume_Jaseel.pdf".
  let t = rawInput;
  if (FILE_CONTEXT_RE.test(t)) {
    t = t
      .replace(/\s*\bunderscore\b\s*/gi, '_')
      .replace(/\s*\bhyphen\b\s*/gi, '-')
      .replace(/(\w)\s+dash\s+(\w)/gi, '$1-$2')
      .replace(/\s*\bdot\s+([a-z]{2,5})\b/gi, '.$1');
  }

  // ── Tier 1: pattern match ──
  const lower = t.toLowerCase();
  for (let idx = 0; idx < COMPILED.length; idx++) {
    const rule  = COMPILED[idx];
    const match = lower.match(rule.regex) || t.match(rule.regex);
    if (match) {
      const params = rule.extract(match, t);
      return {
        intent:        rule.intent,
        confidence:    'pattern',
        params,
        raw:           rawInput,
        needsConfirm:  rule.needsConfirm === true || inferNeedsConfirm(rule.intent, params),
        _patternIndex: idx,   // diagnostic — index in COMPILED (M4.4)
      };
    }
  }

  // ── Tier 2: LLM fallback (optional) ──
  const llmEnabled = settings.getSetting('jarvisLlmFallback', true);
  const apiKey     = settings.getApiKey();

  if (!llmEnabled || !apiKey) {
    return unsupported(rawInput, 'Command not recognised. Try rephrasing.');
  }

  const callLlm = llmFn || geminiLlmFallback;
  try {
    const result = await callLlm(t, apiKey);
    if (!result || !result.intent) throw new Error('Invalid LLM response');
    return result;
  } catch (err) {
    console.warn('[classifier] LLM fallback failed:', err.message);
    return unsupported(rawInput, 'Command not recognised. Try rephrasing.');
  }
}

// ─── LLM fallback ────────────────────────────────────────────────────────────

async function geminiLlmFallback(transcript, apiKey) {
  const fetch = (await import('node-fetch')).default;
  const model = settings.getGeminiModel ? settings.getGeminiModel() : 'gemini-2.5-flash';
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

// ─── M3.3 extraction helpers ─────────────────────────────────────────────────

/** Extract a filename with the expanded extension set used by file.find and file.open. */
function extractFilenameWithExtExpanded(t) {
  const m = t.match(/\b([\w.-]+\.(txt|pdf|docx|xlsx|pptx|png|jpg|jpeg|mp4|md|json|csv|zip|log|html|js|py))\b/i);
  return m ? m[1] : null;
}

/**
 * Extract the file extension keyword from a transcript.
 * e.g. "find PDF files" → "pdf", "find my jpg images" → "jpg"
 */
function extractExtension(t) {
  const m = t.toLowerCase().match(/\b(pdf|docx|xlsx|pptx|txt|md|json|csv|png|jpg|jpeg|mp4|zip|log|html|js|py)\b/);
  return m ? m[1] : null;
}

/**
 * Extract the search query from a file.find command.
 * Strips trigger verbs, articles, possessives, and trailing location hints.
 * Preserves the full remainder (multi-word queries flow into findFiles
 * where they are tokenized and scored).
 */
function extractFindQuery(t) {
  let s = t
    .replace(/\b(find|locate|search\s+for|look\s+for|where\s+is|where'?s)\b\s*/i, '')
    .replace(/^\s*(my|the|a|an)\s+/i, '')
    .replace(/\s+\b(in|on|at|from|inside)\s+(documents|desktop|downloads|jarvis)\b.*$/i, '')
    .replace(/\s+\b(files?|documents?|docs?)\b$/i, '')
    .trim();
  return s || null;
}

/**
 * Extract the spoken name for a file.open command with a document alias.
 * Returns the full remainder so phrases like "open my resume Jaseel" keep
 * the "jaseel" token for findFiles ranking. Single-word aliases still
 * collapse to just the alias ("open my CV" → "cv").
 */
function extractDocumentAlias(t) {
  let s = t.toLowerCase()
    .replace(/\b(open|show|load|display|launch|read)\b\s*/i, '')
    .replace(/^\s*(my|the|a|an)\s+/i, '')
    .replace(/\s+\b(in|on|at|from|inside)\s+(documents|desktop|downloads|jarvis)\b.*$/i, '')
    .replace(/\s+(please|now|for\s+me)$/i, '')
    .trim();
  return s || null;
}

// ─── M3.4 extraction helpers ─────────────────────────────────────────────────

/**
 * Normalize a spoken filename to a real filename:
 *   - "underscore" → "_", "hyphen"/"dash" → "-"
 *   - "dot txt" → ".txt"
 *   - trailing bare extension word: "hello PDF" → "hello.pdf"
 *
 * Applied to both source and destination names in destructive ops so that
 * "rename hello dot txt to journal PDF" extracts "hello.txt" and "journal.pdf".
 */
function normalizeSpokenFilename(s) {
  if (!s) return s;
  let n = s.trim()
    .replace(/\s*\bunderscore\b\s*/gi, '_')
    .replace(/\s*\bhyphen\b\s*/gi, '-')
    .replace(/(\w)\s+dash\s+(\w)/gi, '$1-$2')
    .replace(/\s*\bdot\s+([a-z]{2,5})\b/gi, '.$1');
  // Trailing bare extension word "hello pdf" → "hello.pdf" (only when no extension yet)
  if (!/\.[a-z0-9]{2,5}$/i.test(n)) {
    n = n.replace(/\s+(pdf|docx?|xlsx?|pptx?|txt|md|json|csv|png|jpe?g|mp4|zip|log|html|js|py)\s*$/i,
      (_, ext) => '.' + ext.toLowerCase());
  }
  return n.trim();
}

/**
 * Extract a bare filename target from "delete notes.txt" when no "file" keyword
 * is present — grabs the last whitespace-delimited token that looks like a filename.
 */
function extractDeleteTarget(t) {
  // Strip leading verb
  const s = t.replace(/^\s*(delete|remove|erase|trash)\s+/i, '').trim();
  // If result looks like a filename, return it
  if (/^[\w.-]+$/.test(s)) return s;
  return null;
}

/**
 * Extract the target filename from a file.move command: the token after the
 * verb and before any "to/into <location>" phrase.
 */
function extractMoveTarget(t) {
  const m = t.match(/\b(?:move|transfer|put)\s+([\w.-]+)\b/i);
  return m ? m[1] : null;
}

/**
 * Split a rename transcript on the first "to" that separates old and new names.
 * "rename notes.txt to journal.txt"  → before_to="notes.txt", after_to="journal.txt"
 * "rename my report to new-report"  → before_to="my report", after_to="new-report"
 *
 * @param {string} t          — full transcript
 * @param {'before_to'|'after_to'} side
 * @returns {string|null}
 */
function extractFilenameFromPhrase(t, side) {
  // Strip leading rename verb phrase
  let s = t.replace(/^\s*(?:rename|call it|name it|rename\s+(?:the\s+|this\s+)?file)\s*/i, '').trim();

  // Split on first standalone " to " (not "to Documents" etc. — those come after)
  const toIdx = s.search(/\s+to\s+/i);
  if (toIdx === -1) return null;

  const before = normalizeSpokenFilename(s.slice(0, toIdx).trim());
  const after  = normalizeSpokenFilename(
    s.slice(toIdx).replace(/^\s+to\s+/i, '').trim()
      // Strip trailing location hints from the "after" part
      .replace(/\s+(?:in|on|at|from|inside)\s+(?:documents|desktop|downloads|jarvis)\b.*/i, '')
      .trim()
  );

  if (side === 'before_to') return before || null;
  if (side === 'after_to')  return after  || null;
  return null;
}

/**
 * Extract the TARGET location from a move command — the location that appears
 * AFTER "to" or "into" in the transcript.
 * e.g. "move notes.txt to Desktop" → "desktop"
 */
function extractTargetLocation(t) {
  const lower = t.toLowerCase();
  // Find "to" or "into" then look for a location keyword after it
  const m = lower.match(/\b(?:to|into)\b.{0,30}\b(documents|desktop|downloads|jarvis)\b/i);
  if (m) return m[1].toLowerCase();
  return undefined;
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

// ─── M4.1 — Ordinal extraction ───────────────────────────────────────────────

/**
 * Convert a spoken or numeric ordinal into a 1-based integer.
 * Returns null when no known ordinal is found.
 */
function extractOrdinal(t) {
  const lower = t.toLowerCase().trim();
  const MAP = {
    'first': 1,  'one': 1,  '1': 1,
    'second': 2, 'two': 2,  '2': 2,
    'third': 3,  'three': 3,'3': 3,
    'fourth': 4, 'four': 4, '4': 4,
    'fifth': 5,  'five': 5, '5': 5,
  };
  // Check longer words first to avoid "one" matching inside "fourth"
  const keys = Object.keys(MAP).sort((a, b) => b.length - a.length);
  for (const word of keys) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(lower)) return MAP[word];
  }
  return null;
}

// ─── M3.5 — Sequential command chaining ──────────────────────────────────────

/**
 * Split a transcript on natural chain connectors ("and then", "then", etc.).
 * Returns { parts: string[], wasCapped: boolean }.
 *
 * - Single command → parts: [transcript], wasCapped: false
 * - Two-part chain → parts: [a, b], wasCapped: false
 * - Three-or-more → parts: [a, b] (cap at 2), wasCapped: true
 *
 * Only splits on connectors surrounded by whitespace to avoid breaking
 * phrases like "notes then" where "then" is part of a filename.
 */
const CHAIN_RE = /\s+(?:and\s+then|and\s+after\s+that|followed\s+by|after\s+that,?|then)\s+/i;

function splitChain(transcript) {
  const allParts = (transcript || '').split(CHAIN_RE);
  if (allParts.length <= 1) return { parts: [transcript || ''], wasCapped: false };
  if (allParts.length > 2)  return { parts: allParts.slice(0, 2), wasCapped: true };
  return { parts: allParts, wasCapped: false };
}

// ─── M4.3 — Bare "and" chain splitting ───────────────────────────────────────

const BARE_AND_RE = /\s+and\s+/i;

/**
 * Known file extensions used to detect filename components in bare-and splits.
 * If either candidate part contains one of these, the split is rejected.
 */
const FILENAME_EXT_RE = /\.(txt|pdf|docx|xlsx|pptx|png|jpg|jpeg|md|json|csv|zip|mp4|log|html|js|py)\b/i;

/**
 * Returns true when the string contains a filename component that would make
 * a bare "and" split unsafe (e.g. "notes and tasks.txt").
 */
function hasFilenameComponent(s) {
  return FILENAME_EXT_RE.test(s);
}

/**
 * Extended chain splitter that also handles bare " and " connectors.
 *
 * Strategy:
 *  1. Try the reliable connectors first (splitChain). If they match, return immediately.
 *  2. Only attempt bare " and " split when no reliable connector was found.
 *  3. Guard: reject if either candidate part contains a filename extension token.
 *  4. Cap at jarvisChainMaxSteps (default 2).
 *
 * splitChain is still exported and all Suite 13 tests continue to pass.
 */
function splitChainWithBareAnd(transcript, maxSteps) {
  // Try reliable connectors first
  const reliable = splitChain(transcript);
  if (reliable.parts.length > 1) return reliable;

  // Attempt bare "and" split
  const andParts = (transcript || '').split(BARE_AND_RE);
  if (andParts.length < 2) return { parts: [transcript || ''], wasCapped: false };

  // Reject if any part looks like a filename component
  if (andParts.some(hasFilenameComponent)) {
    return { parts: [transcript || ''], wasCapped: false };
  }

  const cap = maxSteps || 2;
  const result  = andParts.slice(0, cap);
  const wasCapped = andParts.length > cap;
  return { parts: result, wasCapped };
}

// ─── M4.3 — Browser hint extraction ──────────────────────────────────────────

/**
 * Extract an explicit browser hint from phrases like "go to YouTube in Edge"
 * or "open Gmail using Chrome".
 * Returns 'edge' | 'chrome' | 'firefox' | null.
 */
function extractBrowserHint(t) {
  const lower = t.toLowerCase();
  if (/\bin\s+edge\b|\busing\s+edge\b/.test(lower))    return 'edge';
  if (/\bin\s+chrome\b|\busing\s+chrome\b/.test(lower)) return 'chrome';
  if (/\bin\s+firefox\b|\busing\s+firefox\b/.test(lower)) return 'firefox';
  if (/\bin\s+brave\b|\busing\s+brave\b/.test(lower))   return 'brave';
  return null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { classify, splitChain, splitChainWithBareAnd, extractBrowserHint, extractOrdinal };
