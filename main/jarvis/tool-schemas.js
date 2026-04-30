'use strict';

/**
 * tool-schemas.js — Single source of truth for the tools the M4.5 agent can call.
 *
 * Each entry mirrors one case in dispatcher.js. The agent picks a tool by name
 * and the dispatcher executes it. New tools (e.g. M4.6 ui.* layer) only need to
 * append a schema here and add a dispatcher case — no agent code changes.
 *
 * Pure data + a couple of small helpers; no Electron imports so it's loadable
 * in pure-Node tests.
 *
 * Schema shape:
 *   {
 *     name:         'file.find',                 // matches dispatcher case
 *     description:  'Find files by name or extension on disk.',
 *     parameters: {                              // JSON Schema (Gemini-compatible subset)
 *       type:       'object',
 *       properties: { ... },
 *       required:   [...],
 *     },
 *     destructive?: true,                        // forces confirmation gate
 *     needsConfirm?: (params) => boolean,        // optional dynamic predicate
 *   }
 */

// ─── Reusable property fragments ──────────────────────────────────────────────

const STR = (description) => ({ type: 'string', description });
const NUM = (description) => ({ type: 'number', description });

const LOCATION_HINT = {
  type: 'string',
  description:
    "Where to look. One of 'desktop', 'documents', 'downloads', 'pictures', 'jarvis', or omit for default.",
  enum: ['desktop', 'documents', 'downloads', 'pictures', 'jarvis'],
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = [
  // ── File ops ──────────────────────────────────────────────────────────────
  {
    name: 'file.create',
    description: 'Create a new empty file with the given name.',
    parameters: {
      type: 'object',
      properties: {
        name: STR('Filename including extension, e.g. "notes.txt".'),
        locationHint: LOCATION_HINT,
      },
      required: ['name'],
    },
  },
  {
    name: 'file.read',
    description: 'Read the contents of a file by name.',
    parameters: {
      type: 'object',
      properties: {
        name: STR('Filename including extension.'),
        locationHint: LOCATION_HINT,
      },
      required: ['name'],
    },
  },
  {
    name: 'file.write',
    description: 'Overwrite (or create) a file with the given content. Always confirms.',
    parameters: {
      type: 'object',
      properties: {
        name:    STR('Filename including extension.'),
        content: STR('Text content to write. May be empty.'),
        locationHint: LOCATION_HINT,
      },
      required: ['name'],
    },
    destructive: true,
  },
  {
    name: 'file.append',
    description: 'Append text to an existing file. Confirms when content is large (>200 chars).',
    parameters: {
      type: 'object',
      properties: {
        name:    STR('Filename including extension.'),
        content: STR('Text to append.'),
        locationHint: LOCATION_HINT,
      },
      required: ['name', 'content'],
    },
    needsConfirm: (params) => !!(params && typeof params.content === 'string' && params.content.length > 200),
  },
  {
    name: 'file.list',
    description: 'List files in a directory.',
    parameters: {
      type: 'object',
      properties: {
        dirHint: STR('Directory to list. Same vocabulary as locationHint.'),
        locationHint: LOCATION_HINT,
      },
    },
  },
  {
    name: 'file.mkdir',
    description: 'Create a new folder.',
    parameters: {
      type: 'object',
      properties: {
        name: STR('Folder name.'),
        locationHint: LOCATION_HINT,
      },
      required: ['name'],
    },
  },
  {
    name: 'file.find',
    description:
      'Search for files by name keyword and/or extension. Returns matches sorted by relevance. Use this before file.open / file.delete / file.rename / file.move when the user gives only a partial name.',
    parameters: {
      type: 'object',
      properties: {
        query:        STR('Filename keyword. Optional if extension is set.'),
        extension:    STR('Filename extension without the dot, e.g. "pdf".'),
        locationHint: LOCATION_HINT,
      },
    },
  },
  {
    name: 'file.open',
    description: 'Open a file in its default application.',
    parameters: {
      type: 'object',
      properties: {
        name: STR('Filename including extension.'),
        path: STR('Absolute path. Pass this when known (e.g. from file.find result) to skip search.'),
        locationHint: LOCATION_HINT,
        useContext: { type: 'boolean', description: 'If true, open the file currently in execution context (the last "found" file).' },
      },
    },
  },
  {
    name: 'file.delete',
    description: 'Permanently delete a file. Always confirms.',
    parameters: {
      type: 'object',
      properties: {
        name: STR('Filename including extension.'),
        path: STR('Absolute path. Pass this when known to skip search.'),
        locationHint: LOCATION_HINT,
        useContext: { type: 'boolean' },
      },
    },
    destructive: true,
  },
  {
    name: 'file.rename',
    description: 'Rename a file. Always confirms.',
    parameters: {
      type: 'object',
      properties: {
        name:    STR('Current filename including extension.'),
        newName: STR('New filename including extension.'),
        path:    STR('Absolute path of the source file. Pass this when known.'),
        locationHint: LOCATION_HINT,
        useContext: { type: 'boolean' },
      },
      required: ['newName'],
    },
    destructive: true,
  },
  {
    name: 'file.move',
    description: 'Move a file to another location. Always confirms.',
    parameters: {
      type: 'object',
      properties: {
        name: STR('Filename to move.'),
        path: STR('Absolute path of the source file.'),
        targetLocationHint: STR('Destination, same vocabulary as locationHint.'),
        locationHint: LOCATION_HINT,
        useContext: { type: 'boolean' },
      },
      required: ['targetLocationHint'],
    },
    destructive: true,
  },

  // ── App ops ───────────────────────────────────────────────────────────────
  {
    name: 'app.open',
    description: 'Launch an application by name (e.g. "chrome", "notepad", "vs code").',
    parameters: {
      type: 'object',
      properties: { appName: STR('Application name, lowercase, no path.') },
      required: ['appName'],
    },
  },
  {
    name: 'app.close',
    description: 'Close an application gracefully by name.',
    parameters: {
      type: 'object',
      properties: { appName: STR('Application name.') },
      required: ['appName'],
    },
  },
  {
    name: 'app.focus',
    description: 'Bring an existing application window to the foreground.',
    parameters: {
      type: 'object',
      properties: { appName: STR('Application name.') },
      required: ['appName'],
    },
  },

  // ── Window ops ────────────────────────────────────────────────────────────
  {
    name: 'window.minimize',
    description: 'Minimize a window. If appName is omitted, minimizes the active window.',
    parameters: {
      type: 'object',
      properties: { appName: STR('Optional application name; omit to minimize active window.') },
    },
  },
  {
    name: 'window.maximize',
    description: 'Maximize a window. If appName is omitted, maximizes the active window.',
    parameters: {
      type: 'object',
      properties: { appName: STR('Optional application name.') },
    },
  },
  {
    name: 'window.switch',
    description: 'Switch to the next window (Alt+Tab equivalent).',
    parameters: { type: 'object', properties: {} },
  },

  // ── Browser ops ───────────────────────────────────────────────────────────
  {
    name: 'browser.open',
    description: 'Open the default browser to a blank/start page.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser.goto',
    description: 'Navigate to a URL in the browser.',
    parameters: {
      type: 'object',
      properties: {
        url:          STR('Full URL including https:// (or a bare domain like "youtube.com").'),
        browserHint:  STR('Optional browser to target: "edge", "chrome", or "firefox".'),
      },
      required: ['url'],
    },
  },
  {
    name: 'browser.search',
    description: 'Run a Google search in the user\'s browser via CDP. Opens a search results tab and parses the top results so the planner can reason about them. Prefer web.search when you only need text snippets and don\'t need to show the user a tab.',
    parameters: {
      type: 'object',
      properties: {
        query:  STR('Search query.'),
        engine: { type: 'string', enum: ['google', 'duckduckgo', 'bing'] },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser.site',
    description: 'Open a known site by short name (e.g. "youtube", "gmail").',
    parameters: {
      type: 'object',
      properties: {
        siteName:    STR('Short site name.'),
        browserHint: STR('Optional browser to target.'),
      },
      required: ['siteName'],
    },
  },
  {
    name: 'browser.newtab',
    description: 'Open a new tab in the focused browser.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser.closetab',
    description: 'Close the current tab in the focused browser.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser.back',
    description: 'Go back one page in the focused browser.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser.refresh',
    description: 'Refresh the current page in the focused browser.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser.addressbar',
    description: 'Focus the address bar in the focused browser.',
    parameters: { type: 'object', properties: {} },
  },

  // ── Input / keyboard ──────────────────────────────────────────────────────
  {
    name: 'input.type',
    description: 'Type literal text into the focused window. Confirms on long text per settings.',
    parameters: {
      type: 'object',
      properties: { text: STR('Exact text to type.') },
      required: ['text'],
    },
  },
  {
    name: 'input.key',
    description: 'Press a single named key, e.g. "enter", "tab", "escape".',
    parameters: {
      type: 'object',
      properties: { key: STR('Key name.') },
      required: ['key'],
    },
  },
  {
    name: 'input.shortcut',
    description: 'Press a keyboard shortcut combo, e.g. "ctrl+s", "alt+f4".',
    parameters: {
      type: 'object',
      properties: { combo: STR('Shortcut combo with + separators.') },
      required: ['combo'],
    },
  },

  // ── Clipboard ─────────────────────────────────────────────────────────────
  {
    name: 'clipboard.write',
    description: 'Copy text to the system clipboard.',
    parameters: {
      type: 'object',
      properties: { text: STR('Text to copy.') },
      required: ['text'],
    },
  },

  // ── System ────────────────────────────────────────────────────────────────
  {
    name: 'system.volume',
    description: 'Adjust system audio volume.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['mute', 'unmute', 'up', 'down', 'set'] },
        level:  NUM('Target volume 0–100, only used when action="set".'),
      },
      required: ['action'],
    },
  },
  {
    name: 'system.brightness',
    description: 'Adjust display brightness up or down by one step.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['up', 'down'] } },
      required: ['action'],
    },
  },
  {
    name: 'system.lock',
    description: 'Lock the screen. Always confirms.',
    parameters: { type: 'object', properties: {} },
    destructive: true,
  },

  // ── M4.6 — generic UI control via Windows UIAutomation ───────────────────
  {
    name: 'ui.list',
    description:
      'List the named, clickable, or readable controls in the focused window (or the desktop). Use this to discover what is on screen before calling ui.click / ui.fill / ui.read.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['focused', 'desktop'], description: 'Default "focused".' },
        role:  STR('Optional role filter, e.g. "button", "edit", "link".'),
      },
    },
  },
  {
    name: 'ui.click',
    description:
      'Click / invoke a UI control by visible name (e.g. "Send", "Submit") or automationId. If multiple match, returns ambiguous candidates for disambiguation.',
    parameters: {
      type: 'object',
      properties: {
        name:         STR('Visible label of the control.'),
        automationId: STR('Stable automation id, when known. Wins over name.'),
        role:         STR('Optional role hint, e.g. "button".'),
        scope:        { type: 'string', enum: ['focused', 'desktop'] },
      },
    },
  },
  {
    name: 'ui.fill',
    description:
      'Set the text of an edit control by name or automationId. Use this for form fields rather than input.type unless the user explicitly wants raw keystrokes.',
    parameters: {
      type: 'object',
      properties: {
        name:         STR('Visible label of the field.'),
        automationId: STR('Stable automation id when known.'),
        value:        STR('Text to put into the field. Literal — do not paraphrase.'),
        scope:        { type: 'string', enum: ['focused', 'desktop'] },
      },
      required: ['value'],
    },
  },
  {
    name: 'ui.read',
    description:
      'Read the text/value of a UI control by name or automationId.',
    parameters: {
      type: 'object',
      properties: {
        name:         STR('Visible label of the element.'),
        automationId: STR('Stable automation id when known.'),
        scope:        { type: 'string', enum: ['focused', 'desktop'] },
      },
    },
  },

  // ── M5.1 — Browser tools (Playwright + CDP attach to user's Chrome) ──────
  {
    name: 'browser.tabs.list',
    description:
      'List the open tabs in the user\'s Chrome (CDP). Returns each tab\'s id, title, url, and whether it is active. Cheap (~30 ms).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser.tabs.open',
    description:
      'Open a new tab at the given URL in the user\'s Chrome (CDP). Returns the new tabId. Use this rather than browser.goto when you want a NEW tab; browser.goto navigates the active tab.',
    parameters: {
      type: 'object',
      properties: {
        url:    STR('Full URL or bare domain (e.g. "youtube.com").'),
        focus:  { type: 'boolean', description: 'If true (default), focus the new tab.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser.tabs.close',
    description: 'Close a tab in the user\'s Chrome by tabId. Omit tabId to close the active tab.',
    parameters: {
      type: 'object',
      properties: {
        tabId: STR('Tab id from browser.tabs.list. Omit for the active tab.'),
      },
    },
  },
  {
    name: 'browser.tabs.focus',
    description: 'Bring a tab to the foreground by tabId.',
    parameters: {
      type: 'object',
      properties: {
        tabId: STR('Tab id from browser.tabs.list.'),
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser.read',
    description:
      'Read text content from a tab in the user\'s Chrome. Use mode "main" for the article body, "text" for a CSS selector\'s textContent, "html" for raw HTML. Truncates long responses.',
    parameters: {
      type: 'object',
      properties: {
        tabId:    STR('Tab id from browser.tabs.list. Omit for the active tab.'),
        selector: STR('CSS selector to read. Omit when mode="main".'),
        mode:     { type: 'string', enum: ['text', 'html', 'main'] },
        max:      NUM('Max characters to return (default 4000).'),
      },
    },
  },
  {
    name: 'browser.click',
    description:
      'Click an element in a tab in the user\'s Chrome. Provide either a CSS selector OR a visible text label. Uses Playwright\'s text= for label match.',
    parameters: {
      type: 'object',
      properties: {
        tabId:    STR('Tab id, omit for active.'),
        selector: STR('CSS selector. Wins when present.'),
        text:     STR('Visible text label of the element.'),
      },
    },
  },
  {
    name: 'browser.fill',
    description:
      'Type text into an input/textarea in a tab. Provide either a CSS selector OR a label (associated <label> text).',
    parameters: {
      type: 'object',
      properties: {
        tabId:    STR('Tab id, omit for active.'),
        selector: STR('CSS selector. Wins when present.'),
        label:    STR('Form label text.'),
        value:    STR('Text to type into the field.'),
      },
      required: ['value'],
    },
  },
  {
    name: 'browser.scroll',
    description: 'Scroll the page in a tab.',
    parameters: {
      type: 'object',
      properties: {
        tabId:     STR('Tab id, omit for active.'),
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount:    NUM('Pixels to scroll. Default 600.'),
      },
      required: ['direction'],
    },
  },

  // ── M5.2 — Knowledge tools ───────────────────────────────────────────────
  {
    name: 'web.search',
    description:
      'Search the web via Brave Search API. Fast (~300 ms). Returns top results as {title, url, snippet}. Use this for "what\'s happening with X" / "look up Y" when you only need text snippets and do NOT need to show the user a browser tab. Prefer over browser.search whenever the user just wants information.',
    parameters: {
      type: 'object',
      properties: {
        query: STR('Search query.'),
        count: NUM('Number of results, 1-10. Default 5.'),
      },
      required: ['query'],
    },
  },
  {
    name: 'web.scrape',
    description:
      'Deep-scrape a specific URL via Apify (handles JS rendering, anti-bot, pagination). SLOW (~2-5 s). Only use when browser.read with mode="main" is insufficient — e.g. paginated lists, heavily client-rendered pages, sites that block plain fetches.',
    parameters: {
      type: 'object',
      properties: {
        url:           STR('Full URL to scrape.'),
        instructions:  STR('Optional natural-language hint of what to extract. Best-effort.'),
      },
      required: ['url'],
    },
  },
  {
    name: 'vision.read',
    description:
      'STRICT FALLBACK ONLY. Take a screenshot of the focused window (or full screen) and ask Gemini Vision what it shows. Slow (~800-1500 ms). Use this ONLY when ui.list returned 0 elements AND the focused window is not Chrome (so browser.* is unavailable). Custom-canvas apps, games, dialogs without UIA names. Do NOT use as your first read.',
    parameters: {
      type: 'object',
      properties: {
        scope:    { type: 'string', enum: ['focused', 'screen'] },
        question: STR('Optional question to focus the vision model. Default is "What controls are visible?".'),
      },
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _BY_NAME = new Map(TOOL_SCHEMAS.map((s) => [s.name, s]));

/** Return the schema by tool name, or null. */
function getSchema(name) {
  return _BY_NAME.get(name) || null;
}

/** True if the tool name is registered. */
function isRegistered(name) {
  return _BY_NAME.has(name);
}

/**
 * Whether a given (tool, params) needs confirmation before dispatch.
 * Static: schema marks it destructive: true.
 * Dynamic: schema provides a needsConfirm(params) predicate.
 * input.type uses inferNeedsConfirm from classifier (length / setting based).
 */
function needsConfirmFor(name, params) {
  const schema = _BY_NAME.get(name);
  if (!schema) return false;
  if (schema.destructive) return true;
  if (typeof schema.needsConfirm === 'function') {
    try { return !!schema.needsConfirm(params || {}); } catch { return false; }
  }
  if (name === 'input.type') {
    const { inferNeedsConfirm } = require('./classifier');
    return inferNeedsConfirm('input.type', params || {});
  }
  return false;
}

/** Convert TOOL_SCHEMAS → Gemini function_declarations array. */
function toGeminiFunctionDeclarations() {
  return TOOL_SCHEMAS.map((s) => ({
    name:        s.name,
    description: s.description,
    parameters:  s.parameters,
  }));
}

/** Convert TOOL_SCHEMAS → OpenAI tools array (future fallback support). */
function toOpenAITools() {
  return TOOL_SCHEMAS.map((s) => ({
    type: 'function',
    function: {
      name:        s.name,
      description: s.description,
      parameters:  s.parameters,
    },
  }));
}

module.exports = {
  TOOL_SCHEMAS,
  getSchema,
  isRegistered,
  needsConfirmFor,
  toGeminiFunctionDeclarations,
  toOpenAITools,
};
