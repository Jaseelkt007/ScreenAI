#!/usr/bin/env node
'use strict';

/**
 * test-node.js — Milestone 1 Tier A test suite.
 *
 * Pure Node.js — no Electron context needed.
 * Run with: node main/jarvis/test-node.js
 *
 * Tests:
 *   1. resolveJarvisPath — path safety
 *   2. files.js — create, read, write, append, listDir, createDir
 *   3. classifier.js — pattern matching across full Phase 1 command set
 *   4. dispatcher.js — file intent routing (pure Node intents only)
 *   5. verifier.js — file verification checks
 */

const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const assert   = require('assert').strict;

// Modules under test (pure Node — no Electron dependency)
const files = require('./tools/files');
const { resolveJarvisPath, createFile, readFile, writeFile, appendFile, listDir, createDir, LOCATION_MAP } = files;
const { classify, splitChain, extractOrdinal } = require('./classifier');
const { dispatch }               = require('./dispatcher');
const { verify }                 = require('./verifier');
const { runPipelineFromText }    = require('./pipeline');

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    → ${err.message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

async function withPatchedExports(modulePath, patches, fn) {
  const mod = require(modulePath);
  const originals = {};

  for (const [key, replacement] of Object.entries(patches)) {
    originals[key] = mod[key];
    mod[key] = replacement;
  }

  try {
    return await fn(mod);
  } finally {
    for (const [key, original] of Object.entries(originals)) {
      mod[key] = original;
    }
  }
}

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

// Track created files/dirs so we can clean up after tests
const createdPaths = [];

function trackPath(absPath) {
  if (absPath) createdPaths.push(absPath);
}

function cleanup() {
  for (const p of createdPaths.reverse()) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  createdPaths.length = 0;
}

// Unique prefix so parallel test runs don't collide
const TS = Date.now();

// ─── Classifier stub (for testing without network/LLM) ───────────────────────

const LLM_NEVER_CALLED = async () => {
  throw new Error('LLM should not be called — pattern table must cover this command');
};

// ─── 1. resolveJarvisPath ────────────────────────────────────────────────────

section('1. resolveJarvisPath — path safety');

async function runPathTests() {
  await test('valid name, default location → Jarvis workspace', () => {
    const r = resolveJarvisPath('notes.txt', undefined);
    assert.ok(r.ok, r.error);
    assert.equal(r.absPath, path.join(LOCATION_MAP.jarvis, 'notes.txt'));
  });

  await test('locationHint "desktop" → Desktop path', () => {
    const r = resolveJarvisPath('test.txt', 'desktop');
    assert.ok(r.ok, r.error);
    assert.ok(r.absPath.startsWith(os.homedir()), 'must be inside HOME');
    assert.ok(r.absPath.includes('Desktop'), 'should include Desktop');
  });

  await test('locationHint "documents" → Documents path', () => {
    const r = resolveJarvisPath('doc.txt', 'documents');
    assert.ok(r.ok, r.error);
    assert.ok(r.absPath.includes('Documents'));
  });

  await test('path traversal attack "../../etc/passwd" → rejected', () => {
    const r = resolveJarvisPath('../../etc/passwd', null);
    assert.ok(!r.ok, 'should be rejected');
    assert.ok(r.error, 'should have error message');
  });

  await test('name with backslash → rejected', () => {
    const r = resolveJarvisPath('..\\windows\\system32\\hack', null);
    assert.ok(!r.ok, 'backslash in name should be rejected');
  });

  await test('name with null byte → rejected', () => {
    const r = resolveJarvisPath('file\x00.txt', null);
    assert.ok(!r.ok);
  });

  await test('unknown locationHint falls back to jarvis workspace', () => {
    const r = resolveJarvisPath('file.txt', 'c:/windows/system32');
    assert.ok(r.ok, 'should fall back gracefully');
    assert.ok(r.absPath.startsWith(os.homedir()));
  });
}

// ─── 2. files.js operations ───────────────────────────────────────────────────

async function runFileTests() {
  section('2. files.js — file system operations');

  // Simple flat filenames — no path separators (those are tested in path-safety section)
  const testFile = `jtest-${TS}.txt`;
  const testDir  = `jtest-dir-${TS}`;

  cleanup();

  await test('createFile → file exists in Jarvis workspace', async () => {
    const r = await createFile({ name: testFile });
    assert.ok(r.ok, r.error);
    assert.ok(fs.existsSync(r.data.path));
    trackPath(r.data.path);
  });

  await test('createFile duplicate → fails with error', async () => {
    const r = await createFile({ name: testFile });
    assert.ok(!r.ok);
    assert.ok(r.error.includes('already exists'));
  });

  await test('writeFile → content on disk', async () => {
    const r = await writeFile({ name: testFile, content: 'hello world' });
    assert.ok(r.ok, r.error);
    assert.equal(fs.readFileSync(r.data.path, 'utf8'), 'hello world');
  });

  await test('readFile → content matches written value', async () => {
    const r = await readFile({ name: testFile });
    assert.ok(r.ok, r.error);
    assert.equal(r.data.content, 'hello world');
  });

  await test('appendFile → size grows', async () => {
    const before = (await readFile({ name: testFile })).data.sizeBytes;
    const r = await appendFile({ name: testFile, content: '\nmore text' });
    assert.ok(r.ok, r.error);
    assert.ok(r.data.sizeBytes > before, 'size should grow after append');
  });

  await test('listDir with locationHint "jarvis" → returns entries array', async () => {
    const r = await listDir({ dirHint: 'jarvis' });
    assert.ok(r.ok, r.error);
    assert.ok(Array.isArray(r.data.entries));
  });

  await test('createDir → new directory confirmed', async () => {
    const r = await createDir({ name: testDir });
    assert.ok(r.ok, r.error);
    const stat = fs.statSync(r.data.path);
    assert.ok(stat.isDirectory());
    trackPath(r.data.path);
  });

  await test('readFile on missing file → ok: false', async () => {
    const r = await readFile({ name: `missing-${TS}.txt` });
    assert.ok(!r.ok);
    assert.ok(r.error.includes('not found'));
  });

  cleanup();
}

// ─── 3. classifier.js — pattern matching ─────────────────────────────────────

async function runClassifierTests() {
  section('3. classifier.js — Phase 1 command set (pattern only, no LLM)');

  const cases = [
    // file.create
    { t: 'create a file called notes',                    intent: 'file.create' },
    { t: 'make a new text file named todo',               intent: 'file.create' },
    { t: 'create a new document called meeting',          intent: 'file.create' },
    { t: 'new file named report.txt',                     intent: 'file.create' },

    // file.mkdir
    { t: 'create a folder called projects',               intent: 'file.mkdir' },
    { t: 'make a new directory named backup',             intent: 'file.mkdir' },
    { t: 'create a new folder named work stuff',          intent: 'file.mkdir' },

    // file.read
    { t: 'read the file called notes.txt',                intent: 'file.read' },
    { t: 'show me the contents of document.txt',          intent: 'file.read' },
    { t: "what's in notes.txt",                           intent: 'file.read' },
    { t: 'open the file named readme.md',                 intent: 'file.read' },

    // file.write
    { t: 'write hello world to notes.txt',                intent: 'file.write' },
    { t: 'save my name is jarvis to info.txt',            intent: 'file.write' },

    // file.append
    { t: 'append buy milk to tasks.txt',                  intent: 'file.append' },
    { t: 'add a new line to my notes',                    intent: 'file.append' },

    // file.list
    { t: "list what's in the jarvis folder",              intent: 'file.list' },
    { t: 'show me the documents folder',                  intent: 'file.list' },
    { t: 'display the desktop directory',                 intent: 'file.list' },

    // app.open
    { t: 'open chrome',                                   intent: 'app.open' },
    { t: 'launch notepad',                                intent: 'app.open' },
    { t: 'start calculator',                              intent: 'app.open' },
    { t: 'open vscode',                                   intent: 'app.open' },
    { t: 'open powershell',                               intent: 'app.open' },
    { t: 'launch terminal',                               intent: 'app.open' },
    { t: 'open spotify',                                  intent: 'app.open' },

    // browser.open
    { t: 'open a browser',                                intent: 'browser.open' },
    { t: 'launch the web browser',                        intent: 'browser.open' },
    { t: 'open the internet',                             intent: 'browser.open' },

    // browser.goto
    { t: 'go to github.com',                              intent: 'browser.goto' },
    { t: 'navigate to https://www.youtube.com',           intent: 'browser.goto' },
    { t: 'visit stackoverflow.com',                       intent: 'browser.goto' },
    { t: 'open youtube.com',                              intent: 'browser.goto' },

    // browser.search
    { t: 'search for best coffee shops',                  intent: 'browser.search' },
    { t: 'google the weather today',                      intent: 'browser.search' },
    { t: 'look up electron js documentation',             intent: 'browser.search' },
    { t: 'find restaurants near me',                      intent: 'browser.search' },

    // clipboard.write
    { t: 'copy to clipboard: hello world',                intent: 'clipboard.write' },
    { t: 'clipboard: the quick brown fox',                intent: 'clipboard.write' },
  ];

  for (const { t, intent } of cases) {
    await test(`"${t}" → ${intent}`, async () => {
      const result = await classify(t, LLM_NEVER_CALLED);
      assert.equal(result.intent, intent,
        `Got "${result.intent}" (confidence: ${result.confidence})`);
      assert.equal(result.confidence, 'pattern', 'Should be resolved by pattern, not LLM');
    });
  }

  // Special: system.unsupported
  await test('"delete all my files" → system.unsupported', async () => {
    // LLM fallback allowed for this one (we're testing the pattern table didn't wrongly match)
    const result = await classify('delete all my files');
    assert.equal(result.intent, 'system.unsupported');
  });

  // Param extraction checks
  await test('file.create extracts name from "called notes"', async () => {
    const r = await classify('create a file called notes', LLM_NEVER_CALLED);
    assert.ok(r.params.name, 'name should be extracted');
    assert.ok(r.params.name.includes('notes'), `got: ${r.params.name}`);
  });

  await test('app.open extracts appName "chrome"', async () => {
    const r = await classify('open chrome', LLM_NEVER_CALLED);
    assert.equal(r.params.appName, 'chrome');
  });

  await test('browser.search extracts query', async () => {
    const r = await classify('search for best coffee shops', LLM_NEVER_CALLED);
    assert.ok(r.params.query.includes('coffee'), `query: ${r.params.query}`);
  });

  await test('browser.goto extracts URL from "go to github.com"', async () => {
    const r = await classify('go to github.com', LLM_NEVER_CALLED);
    assert.ok(r.params.url && r.params.url.includes('github'), `url: ${r.params.url}`);
  });

  await test('file.write sets needsConfirm: true', async () => {
    const r = await classify('write hello world to notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.needsConfirm, true);
  });

  await test('file.create sets needsConfirm: false', async () => {
    const r = await classify('create a file called todo', LLM_NEVER_CALLED);
    assert.equal(r.needsConfirm, false);
  });
}

// ─── 4. dispatcher.js — file intent routing (pure Node) ──────────────────────

async function runDispatcherTests() {
  section('4. dispatcher.js — file intent routing');

  cleanup();

  const dispFile = `jdisp-${TS}.txt`;
  const dispDir  = `jdisp-dir-${TS}`;
  let dispFilePath;

  await test('file.create → ToolResult ok:true, file on disk', async () => {
    const cr = {
      intent: 'file.create',
      params:  { name: dispFile, locationHint: 'jarvis' },
      raw:    'create a file called dispatch-test',
      needsConfirm: false,
    };
    const r = await dispatch(cr);
    assert.ok(r.ok, r.error);
    assert.ok(fs.existsSync(r.data.path));
    dispFilePath = r.data.path;
    trackPath(dispFilePath);
  });

  await test('file.write → writes correct content', async () => {
    const cr = {
      intent: 'file.write',
      params:  { name: dispFile, content: 'dispatched content', locationHint: 'jarvis' },
      raw:    'write dispatched content to dispatch-test.txt',
      needsConfirm: true,
    };
    const r = await dispatch(cr);
    assert.ok(r.ok, r.error);
    assert.equal(fs.readFileSync(r.data.path, 'utf8'), 'dispatched content');
  });

  await test('file.append → size grew', async () => {
    const cr = {
      intent: 'file.append',
      params:  { name: dispFile, content: ' more', locationHint: 'jarvis' },
      raw:    'append more to dispatch-test.txt',
      needsConfirm: false,
    };
    const r = await dispatch(cr);
    assert.ok(r.ok, r.error);
    assert.ok(r.data.sizeBytes > 0);
  });

  await test('file.list → entries array returned', async () => {
    const cr = { intent: 'file.list', params: { dirHint: 'jarvis' }, raw: 'list jarvis', needsConfirm: false };
    const r  = await dispatch(cr);
    assert.ok(r.ok, r.error);
    assert.ok(Array.isArray(r.data.entries));
  });

  await test('file.mkdir → directory created', async () => {
    const cr = {
      intent: 'file.mkdir',
      params:  { name: dispDir, locationHint: 'jarvis' },
      raw:    'create a folder called new-folder',
      needsConfirm: false,
    };
    const r = await dispatch(cr);
    assert.ok(r.ok, r.error);
    assert.ok(fs.statSync(r.data.path).isDirectory());
    trackPath(r.data.path);
  });

  await test('file.create missing name → DispatchError', async () => {
    const cr = { intent: 'file.create', params: {}, raw: '', needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  await test('system.unsupported → ok: false with reason', async () => {
    const cr = { intent: 'system.unsupported', params: {}, raw: 'delete everything', needsConfirm: false, reason: 'Not supported.' };
    const r  = await dispatch(cr);
    assert.ok(!r.ok);
    assert.ok(r.error);
  });

  cleanup();
}

// ─── 5. verifier.js — structured checks ──────────────────────────────────────

async function runVerifierTests() {
  section('5. verifier.js — structured verification');

  cleanup();

  // Create a file to verify against (flat name, no subdirectory)
  const testPath = path.join(LOCATION_MAP.jarvis, `jverify-${TS}.txt`);
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, 'verify content', 'utf8');
  trackPath(testPath);

  await test('file.create verified → file_exists method', async () => {
    const cr = { intent: 'file.create' };
    const tr = { ok: true, data: { path: testPath } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'file_exists');
    assert.ok(r.verified);
  });

  await test('file.read verified → content_nonzero', async () => {
    const cr = { intent: 'file.read' };
    const tr = { ok: true, data: { content: 'hello', sizeBytes: 5 } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'content_nonzero');
    assert.ok(r.verified);
  });

  await test('file.write verified → size_nonzero', async () => {
    const cr = { intent: 'file.write' };
    const tr = { ok: true, data: { path: testPath } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'size_nonzero');
    assert.ok(r.verified);
  });

  await test('file.append verified → size_grew', async () => {
    const before = fs.statSync(testPath).size;
    fs.appendFileSync(testPath, ' appended');
    const cr = { intent: 'file.append' };
    const tr = { ok: true, data: { path: testPath, priorSize: before } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'size_grew');
    assert.ok(r.verified);
  });

  await test('file.list verified → entries_returned', async () => {
    const cr = { intent: 'file.list' };
    const tr = { ok: true, data: { entries: [{ name: 'a.txt', type: 'file', sizeBytes: 5 }] } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'entries_returned');
    assert.ok(r.verified);
  });

  await test('file.mkdir verified → dir_exists', async () => {
    const dirPath = path.join(LOCATION_MAP.jarvis, `jverify-dir-${TS}`);
    fs.mkdirSync(dirPath, { recursive: true });
    trackPath(dirPath);
    const cr = { intent: 'file.mkdir' };
    const tr = { ok: true, data: { path: dirPath } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'dir_exists');
    assert.ok(r.verified);
  });

  await test('tool failure → verified: false, skipped', async () => {
    const cr = { intent: 'file.create' };
    const tr = { ok: false, error: 'file exists' };
    const r  = await verify(cr, tr);
    assert.ok(!r.verified);
    assert.equal(r.method, 'skipped');
  });

  await test('app.open verified → spawn_ok', async () => {
    const cr = { intent: 'app.open' };
    const tr = { ok: true, data: { launched: true } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('browser.search verified → open_ok', async () => {
    const cr = { intent: 'browser.search' };
    const tr = { ok: true, data: { url: 'https://google.com/search?q=test' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'open_ok');
    assert.ok(r.verified);
  });

  cleanup();
}

// ─── 6. Phase 2 M2.1 — classifier + verifier (window/app control) ────────────

async function runM21Tests() {
  section('6. M2.1 — Classifier patterns: app.close / app.focus / window.*');

  // ── app.close patterns ──
  const closeCases = [
    { t: 'close notepad',           intent: 'app.close', appName: 'notepad' },
    { t: 'quit chrome',             intent: 'app.close', appName: 'chrome' },
    { t: 'exit spotify',            intent: 'app.close', appName: 'spotify' },
    { t: 'terminate edge',          intent: 'app.close', appName: 'edge' },
    { t: 'shut down vscode',        intent: 'app.close', appName: 'vscode' },
    { t: 'close the word document', intent: 'app.close', appName: 'word' },
  ];

  for (const { t, intent, appName } of closeCases) {
    await test(`"${t}" → ${intent}, appName: ${appName}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, intent, `Got "${r.intent}"`);
      assert.equal(r.confidence, 'pattern');
      assert.equal(r.params.appName, appName, `appName: got "${r.params.appName}"`);
    });
  }

  // ── app.focus patterns ──
  const focusCases = [
    { t: 'focus notepad',      intent: 'app.focus', appName: 'notepad' },
    { t: 'switch to chrome',   intent: 'app.focus', appName: 'chrome' },
    { t: 'bring up edge',      intent: 'app.focus', appName: 'edge' },
    { t: 'show firefox',       intent: 'app.focus', appName: 'firefox' },
    { t: 'go to explorer',     intent: 'app.focus', appName: 'explorer' },
    { t: 'foreground vscode',  intent: 'app.focus', appName: 'vscode' },
  ];

  for (const { t, intent, appName } of focusCases) {
    await test(`"${t}" → ${intent}, appName: ${appName}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, intent, `Got "${r.intent}"`);
      assert.equal(r.confidence, 'pattern');
      assert.equal(r.params.appName, appName, `appName: got "${r.params.appName}"`);
    });
  }

  // ── window.minimize patterns ──
  await test('"minimize" → window.minimize, appName: null', async () => {
    const r = await classify('minimize', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.minimize');
    assert.equal(r.params.appName, null);
  });

  await test('"minimize window" → window.minimize, appName: null', async () => {
    const r = await classify('minimize window', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.minimize');
    assert.equal(r.params.appName, null);
  });

  await test('"minimize chrome" → window.minimize, appName: chrome', async () => {
    const r = await classify('minimize chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.minimize');
    assert.equal(r.params.appName, 'chrome');
  });

  await test('"minimise edge" → window.minimize (British spelling)', async () => {
    const r = await classify('minimise edge', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.minimize');
    assert.equal(r.params.appName, 'edge');
  });

  // ── window.maximize patterns ──
  await test('"maximize" → window.maximize, appName: null', async () => {
    const r = await classify('maximize', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.maximize');
    assert.equal(r.params.appName, null);
  });

  await test('"maximize edge" → window.maximize, appName: edge', async () => {
    const r = await classify('maximize edge', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.maximize');
    assert.equal(r.params.appName, 'edge');
  });

  await test('"full screen" → window.maximize', async () => {
    const r = await classify('full screen', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.maximize');
  });

  await test('"fullscreen" → window.maximize', async () => {
    const r = await classify('fullscreen', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.maximize');
  });

  // ── window.switch patterns ──
  await test('"switch window" → window.switch', async () => {
    const r = await classify('switch window', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.switch');
  });

  await test('"alt tab" → window.switch', async () => {
    const r = await classify('alt tab', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.switch');
  });

  await test('"go to last window" → window.switch', async () => {
    const r = await classify('go to last window', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.switch');
  });

  await test('"next window" → window.switch', async () => {
    const r = await classify('next window', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'window.switch');
  });

  // ── Collision tests — existing Phase 1 patterns must NOT be affected ──
  await test('"open notepad" → app.open (NOT app.close or app.focus)', async () => {
    const r = await classify('open notepad', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open', `Got "${r.intent}"`);
  });

  await test('"launch chrome" → app.open', async () => {
    const r = await classify('launch chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open');
  });

  await test('"write hello to notes.txt" → file.write (NOT app.close/focus)', async () => {
    const r = await classify('write hello to notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.write', `Got "${r.intent}"`);
  });

  await test('"go to github.com" → browser.goto (NOT window.switch or app.focus)', async () => {
    const r = await classify('go to github.com', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.goto', `Got "${r.intent}"`);
  });

  await test('"search for best coffee shops" → browser.search (no collision)', async () => {
    const r = await classify('search for best coffee shops', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.search');
  });

  // ── window.switch params are always empty ──
  await test('window.switch has no params', async () => {
    const r = await classify('switch window', LLM_NEVER_CALLED);
    assert.deepEqual(r.params, {});
  });

  // ── needsConfirm is false for all M2.1 intents ──
  await test('app.close needsConfirm: false', async () => {
    const r = await classify('close notepad', LLM_NEVER_CALLED);
    assert.equal(r.needsConfirm, false);
  });

  await test('window.maximize needsConfirm: false', async () => {
    const r = await classify('maximize chrome', LLM_NEVER_CALLED);
    assert.equal(r.needsConfirm, false);
  });

  // ── Verifier: process_gone ──
  section('6b. M2.1 — Verifier: process_gone and focus_assumed');

  await test('app.close with closed:true → process_gone verified', async () => {
    const cr = { intent: 'app.close' };
    const tr = { ok: true, data: { closed: true, processName: 'notepad' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'process_gone');
    assert.ok(r.verified);
  });

  await test('app.close with closed:false → process_gone not verified', async () => {
    const cr = { intent: 'app.close' };
    const tr = { ok: true, data: { closed: false, processName: 'notepad' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'process_gone');
    assert.ok(!r.verified);
  });

  await test('app.close tool failure → skipped', async () => {
    const cr = { intent: 'app.close' };
    const tr = { ok: false, error: 'notepad is not running' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
    assert.ok(!r.verified);
  });

  await test('app.focus → focus_assumed, verified: true', async () => {
    const cr = { intent: 'app.focus' };
    const tr = { ok: true, data: { focused: true, processName: 'chrome' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'focus_assumed');
    assert.ok(r.verified);
  });

  await test('window.minimize → spawn_ok', async () => {
    const cr = { intent: 'window.minimize' };
    const tr = { ok: true, data: {} };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('window.maximize → spawn_ok', async () => {
    const cr = { intent: 'window.maximize' };
    const tr = { ok: true, data: {} };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('window.switch → spawn_ok', async () => {
    const cr = { intent: 'window.switch' };
    const tr = { ok: true, data: {} };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });
}

// ─── 7. Phase 2 M2.2 — classifier: input.type / input.key / input.shortcut ───

async function runM22ClassifierTests() {
  section('7. M2.2 — Classifier: input.type / input.key / input.shortcut');

  // ── input.shortcut: named aliases ──
  const namedAliasCases = [
    { t: 'undo',                intent: 'input.shortcut', combo: 'ctrl+z' },
    { t: 'redo',                intent: 'input.shortcut', combo: 'ctrl+y' },
    { t: 'copy',                intent: 'input.shortcut', combo: 'ctrl+c' },
    { t: 'paste',               intent: 'input.shortcut', combo: 'ctrl+v' },
    { t: 'cut',                 intent: 'input.shortcut', combo: 'ctrl+x' },
    { t: 'select all',          intent: 'input.shortcut', combo: 'ctrl+a' },
    { t: 'save',                intent: 'input.shortcut', combo: 'ctrl+s' },
    { t: 'save as',             intent: 'input.shortcut', combo: 'ctrl+shift+s' },
    { t: 'please undo that',    intent: 'input.shortcut', combo: 'ctrl+z' },
    { t: 'can you save',        intent: 'input.shortcut', combo: 'ctrl+s' },
  ];

  for (const { t, intent, combo } of namedAliasCases) {
    await test(`"${t}" → ${intent}, combo: ${combo}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, intent, `Got "${r.intent}"`);
      assert.equal(r.confidence, 'pattern');
      assert.equal(r.params.combo, combo, `combo: got "${r.params.combo}"`);
    });
  }

  // ── input.shortcut: modifier combos ──
  const modifierCases = [
    { t: 'press control c',       combo: 'ctrl+c' },
    { t: 'press ctrl v',          combo: 'ctrl+v' },
    { t: 'hit control z',         combo: 'ctrl+z' },
    { t: 'press control shift s', combo: 'ctrl+shift+s' },
    { t: 'press alt left',        combo: 'alt+left' },
    { t: 'use ctrl t',            combo: 'ctrl+t' },
    { t: 'press control w',       combo: 'ctrl+w' },
    { t: 'press ctrl r',          combo: 'ctrl+r' },
  ];

  for (const { t, combo } of modifierCases) {
    await test(`"${t}" → input.shortcut, combo: ${combo}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, 'input.shortcut', `Got "${r.intent}"`);
      assert.equal(r.params.combo, combo, `combo: got "${r.params.combo}"`);
    });
  }

  // ── input.key ──
  const keyCases = [
    { t: 'press enter',     key: 'enter' },
    { t: 'press escape',    key: 'escape' },
    { t: 'press esc',       key: 'esc' },
    { t: 'press delete',    key: 'delete' },
    { t: 'press backspace', key: 'backspace' },
    { t: 'press tab',       key: 'tab' },
    { t: 'press up',        key: 'up' },
    { t: 'press down',      key: 'down' },
    { t: 'press left',      key: 'left' },
    { t: 'press right',     key: 'right' },
    { t: 'press home',      key: 'home' },
    { t: 'press end',       key: 'end' },
    { t: 'press page up',   key: 'page up' },
    { t: 'press page down', key: 'page down' },
  ];

  for (const { t, key } of keyCases) {
    await test(`"${t}" → input.key, key: ${key}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, 'input.key', `Got "${r.intent}"`);
      assert.equal(r.params.key, key, `key: got "${r.params.key}"`);
    });
  }

  // ── input.type ──
  const typeCases = [
    { t: 'type hello world',         text: 'hello world' },
    { t: 'type: hello world',        text: 'hello world' },
    { t: 'type this hello',          text: 'hello' },
    { t: 'type this: hello world',   text: 'hello world' },
    { t: 'input hello',              text: 'hello' },
    { t: 'input: some text here',    text: 'some text here' },
  ];

  for (const { t, text } of typeCases) {
    await test(`"${t}" → input.type, text: "${text}"`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, 'input.type', `Got "${r.intent}"`);
      assert.equal(r.params.text, text, `text: got "${r.params.text}"`);
    });
  }

  // ── Collision tests ──
  await test('"write hello to notes.txt" → file.write (NOT input.type)', async () => {
    const r = await classify('write hello to notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.write', `Got "${r.intent}"`);
  });

  await test('"copy to clipboard: hello" → clipboard.write (NOT input.shortcut)', async () => {
    const r = await classify('copy to clipboard: hello world', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'clipboard.write', `Got "${r.intent}"`);
  });

  await test('"press enter" → input.key (NOT input.shortcut)', async () => {
    const r = await classify('press enter', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.key', `Got "${r.intent}"`);
  });

  await test('"press control c" → input.shortcut (NOT input.key)', async () => {
    const r = await classify('press control c', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.shortcut');
  });

  await test('"open chrome" → app.open (NOT input.shortcut)', async () => {
    const r = await classify('open chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open');
  });

  // ── needsConfirm: length-based for input.type ──
  await test('input.type short text (<80 chars) → needsConfirm: false', async () => {
    const r = await classify('type hello world', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.type');
    assert.equal(r.needsConfirm, false, `needsConfirm should be false for short text`);
  });

  await test('input.type long text (>=80 chars) → needsConfirm: true', async () => {
    const longText = 'a'.repeat(80);
    const r = await classify(`type: ${longText}`, LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.type');
    assert.equal(r.needsConfirm, true, `needsConfirm should be true for text >= 80 chars`);
  });

  await test('input.key needsConfirm: false', async () => {
    const r = await classify('press enter', LLM_NEVER_CALLED);
    assert.equal(r.needsConfirm, false);
  });

  await test('input.shortcut needsConfirm: false', async () => {
    const r = await classify('undo', LLM_NEVER_CALLED);
    assert.equal(r.needsConfirm, false);
  });
}

// ─── 8. Phase 2 M2.2 — dispatcher routing (Tier A: param validation only) ───

async function runM22DispatcherTests() {
  section('8. M2.2 — Dispatcher routing: input.* param validation');

  // These tests verify dispatch ROUTING by checking DispatchError for missing params.
  // The keyboard.js PS calls are not tested here (Tier B — requires Windows runtime).

  await test('input.type missing text → DispatchError', async () => {
    const cr = { intent: 'input.type', params: {}, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError', `Expected DispatchError, got: ${err.name}`);
      assert.ok(err.message.includes('text to type'), `message: ${err.message}`);
    }
  });

  await test('input.key missing key → DispatchError', async () => {
    const cr = { intent: 'input.key', params: {}, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
      assert.ok(err.message.includes('key name'), `message: ${err.message}`);
    }
  });

  await test('input.shortcut missing combo → DispatchError', async () => {
    const cr = { intent: 'input.shortcut', params: {}, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
      assert.ok(err.message.includes('shortcut combo'), `message: ${err.message}`);
    }
  });

  // ── keyboard.js pure-logic tests (no PowerShell) ──
  const { typeText, pressKey, pressShortcut, comboToWScript, NAMED_SHORTCUTS, KEY_MAP } = require('./tools/keyboard');
  const {
    setPendingTypeTargetWindowHandle,
    consumePendingTypeTargetWindowHandle,
    clearPendingTypeTargetWindowHandle,
  } = require('./typing-target');

  await test('comboToWScript("ctrl+c") → "^c"', () => {
    assert.equal(comboToWScript('ctrl+c'), '^c');
  });

  await test('comboToWScript("ctrl+shift+s") → "^+s"', () => {
    assert.equal(comboToWScript('ctrl+shift+s'), '^+s');
  });

  await test('comboToWScript("alt+left") → "%{LEFT}"', () => {
    assert.equal(comboToWScript('alt+left'), '%{LEFT}');
  });

  await test('comboToWScript("win+l") → null (blocked by absence)', () => {
    assert.equal(comboToWScript('win+l'), null);
  });

  await test('comboToWScript("ctrl+alt+del") → null (blocked by absence)', () => {
    assert.equal(comboToWScript('ctrl+alt+del'), null);
  });

  await test('KEY_MAP has enter, escape, delete, backspace, tab', () => {
    assert.ok('enter' in KEY_MAP);
    assert.ok('escape' in KEY_MAP);
    assert.ok('delete' in KEY_MAP);
    assert.ok('backspace' in KEY_MAP);
    assert.ok('tab' in KEY_MAP);
  });

  await test('NAMED_SHORTCUTS: undo → ctrl+z, save as → ctrl+shift+s', () => {
    assert.equal(NAMED_SHORTCUTS['undo'], 'ctrl+z');
    assert.equal(NAMED_SHORTCUTS['save as'], 'ctrl+shift+s');
    assert.equal(NAMED_SHORTCUTS['save'], 'ctrl+s');
  });

  await test('typing-target stores a numeric window handle and consumes it once', () => {
    clearPendingTypeTargetWindowHandle();
    setPendingTypeTargetWindowHandle('123456');
    assert.equal(consumePendingTypeTargetWindowHandle(), '123456');
    assert.equal(consumePendingTypeTargetWindowHandle(), null);
  });

  await test('typing-target rejects invalid window handles', () => {
    clearPendingTypeTargetWindowHandle();
    setPendingTypeTargetWindowHandle('not-a-handle');
    assert.equal(consumePendingTypeTargetWindowHandle(), null);
  });

  // typeText input validation (no PS call needed — fails before PS)
  await test('typeText with empty string → ok: false (no PS call)', async () => {
    const r = await typeText('');
    assert.ok(!r.ok);
    assert.ok(r.error.includes('No text'));
  });

  await test('typeText with only control characters → ok: false', async () => {
    const r = await typeText('\x00\x01\x1F');
    assert.ok(!r.ok);
    assert.ok(r.error.includes('no printable'));
  });

  await test('typeText with 501 chars → ok: false (too long)', async () => {
    const r = await typeText('a'.repeat(501));
    assert.ok(!r.ok);
    assert.ok(r.error.includes('too long'), `error: ${r.error}`);
  });

  // pressShortcut allowlist validation (no PS call — fails before PS)
  await test('pressShortcut("win+l") → ok: false (not in allowlist)', async () => {
    const r = await pressShortcut('win+l');
    assert.ok(!r.ok);
    assert.ok(r.error.includes('Unsupported'), `error: ${r.error}`);
  });

  await test('pressShortcut("ctrl+alt+del") → ok: false (not in allowlist)', async () => {
    const r = await pressShortcut('ctrl+alt+del');
    assert.ok(!r.ok);
    assert.ok(r.error.includes('Unsupported'), `error: ${r.error}`);
  });

  await test('pressShortcut("alt+f4") → ok: false (not in allowlist)', async () => {
    const r = await pressShortcut('alt+f4');
    assert.ok(!r.ok);
  });

  // pressKey with unknown key (no PS call — fails before PS)
  await test('pressKey("f16") → ok: false (unknown key)', async () => {
    const r = await pressKey('f16');
    assert.ok(!r.ok);
    assert.ok(r.error.includes('Unknown key'), `error: ${r.error}`);
  });

  // verifier spawn_ok for input intents
  await test('input.type → spawn_ok (verifier)', async () => {
    const cr = { intent: 'input.type' };
    const tr = { ok: true, data: { typed: 'hello' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('input.key → spawn_ok (verifier)', async () => {
    const cr = { intent: 'input.key' };
    const tr = { ok: true, data: { key: 'enter' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('input.shortcut → spawn_ok (verifier)', async () => {
    const cr = { intent: 'input.shortcut' };
    const tr = { ok: true, data: { combo: 'ctrl+c' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });
}

// ─── 9. Phase 2 M2.3 — browser keyboard control ──────────────────────────────

async function runM23Tests() {
  section('9. M2.3 — Browser keyboard control');

  const classifierCases = [
    { t: 'new tab',            intent: 'browser.newtab' },
    { t: 'open new tab',       intent: 'browser.newtab' },
    { t: 'close tab',          intent: 'browser.closetab' },
    { t: 'close current tab',  intent: 'browser.closetab' },
    { t: 'go back',            intent: 'browser.back' },
    { t: 'previous page',      intent: 'browser.back' },
    { t: 'refresh page',       intent: 'browser.refresh' },
    { t: 'reload tab',         intent: 'browser.refresh' },
    { t: 'focus address bar',  intent: 'browser.addressbar' },
    { t: 'url bar',            intent: 'browser.addressbar' },
  ];

  for (const { t, intent } of classifierCases) {
    await test(`"${t}" → ${intent}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, intent, `Got "${r.intent}"`);
      assert.equal(r.confidence, 'pattern');
      assert.deepEqual(r.params, {});
      assert.equal(r.needsConfirm, false);
    });
  }

  await test('"close tab" → browser.closetab (NOT app.close)', async () => {
    const r = await classify('close tab', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.closetab');
  });

  await test('"close notepad" → app.close (NOT browser.closetab)', async () => {
    const r = await classify('close notepad', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.close');
    assert.equal(r.params.appName, 'notepad');
  });

  await test('"go to github.com" → browser.goto (NOT browser.back)', async () => {
    const r = await classify('go to github.com', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.goto');
    assert.ok(r.params.url.includes('github.com'));
  });

  section('9b. M2.3 — Dispatcher focus guard and routing');

  const dispatchCases = [
    { intent: 'browser.newtab',    combo: 'ctrl+t' },
    { intent: 'browser.closetab',  combo: 'ctrl+w' },
    { intent: 'browser.back',      combo: 'alt+left' },
    { intent: 'browser.refresh',   combo: 'ctrl+r' },
    { intent: 'browser.addressbar', combo: 'ctrl+l' },
  ];

  for (const { intent, combo } of dispatchCases) {
    await test(`${intent} with focused browser → pressShortcut("${combo}")`, async () => {
      let receivedCombo = null;

      await withPatchedExports('./tools/windows', {
        isBrowserFocused: async () => ({ focused: true, processName: 'chrome' }),
      }, async () => {
        await withPatchedExports('./tools/keyboard', {
          pressShortcut: async (actualCombo) => {
            receivedCombo = actualCombo;
            return { ok: true, data: { combo: actualCombo }, action: `Pressed ${actualCombo}.` };
          },
        }, async () => {
          const r = await dispatch({ intent, params: {}, raw: intent, needsConfirm: false });
          assert.ok(r.ok, r.error);
          assert.equal(receivedCombo, combo);
        });
      });
    });
  }

  await test('browser.newtab with no focused browser → helpful error and no shortcut sent', async () => {
    let shortcutCalls = 0;

    await withPatchedExports('./tools/windows', {
      isBrowserFocused: async () => ({ focused: false, processName: null }),
    }, async () => {
      await withPatchedExports('./tools/keyboard', {
        pressShortcut: async () => {
          shortcutCalls++;
          return { ok: true, data: {}, action: 'should not be called' };
        },
      }, async () => {
        const r = await dispatch({ intent: 'browser.newtab', params: {}, raw: 'new tab', needsConfirm: false });
        assert.ok(!r.ok);
        assert.equal(r.error, 'No browser is focused. Switch to a browser window first.');
        assert.equal(shortcutCalls, 0);
      });
    });
  });

  section('9c. M2.3 — Verifier: browser keyboard intents');

  for (const { intent, combo } of dispatchCases) {
    await test(`${intent} → spawn_ok (verifier)`, async () => {
      const cr = { intent };
      const tr = { ok: true, data: { combo } };
      const r  = await verify(cr, tr);
      assert.equal(r.method, 'spawn_ok');
      assert.ok(r.verified);
    });
  }
}

// ─── 10. Phase 2 M2.4 — Suite 8: Verifier Phase 2 ───────────────────────────

async function runM24VerifierTests() {
  section('10. M2.4 — Suite 8: Verifier Phase 2');

  // app.close: process_gone — verified when data.closed === true
  await test('app.close toolResult.ok=true, data.closed=true → process_gone verified:true', async () => {
    const cr = { intent: 'app.close' };
    const tr = { ok: true, data: { closed: true, processName: 'notepad' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'process_gone');
    assert.ok(r.verified);
    assert.ok(r.detail.includes('notepad'));
  });

  await test('app.close toolResult.ok=true, data.closed=false → process_gone verified:false', async () => {
    const cr = { intent: 'app.close' };
    const tr = { ok: true, data: { closed: false, processName: 'notepad' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'process_gone');
    assert.ok(!r.verified);
  });

  await test('app.close toolResult.ok=false → skipped (tool reported failure)', async () => {
    const cr = { intent: 'app.close' };
    const tr = { ok: false, error: 'not running' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
    assert.ok(!r.verified);
  });

  // app.focus: focus_assumed — always true when ok, honest method name
  await test('app.focus toolResult.ok=true → focus_assumed verified:true', async () => {
    const cr = { intent: 'app.focus' };
    const tr = { ok: true, data: { focused: true, processName: 'chrome' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'focus_assumed');
    assert.ok(r.verified);
  });

  await test('app.focus toolResult.ok=false → skipped', async () => {
    const cr = { intent: 'app.focus' };
    const tr = { ok: false, error: 'not running' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
  });

  // window.minimize / window.maximize / window.switch → spawn_ok
  await test('window.minimize → spawn_ok verified:true', async () => {
    const cr = { intent: 'window.minimize' };
    const tr = { ok: true, data: {} };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('window.maximize → spawn_ok verified:true', async () => {
    const cr = { intent: 'window.maximize' };
    const tr = { ok: true, data: {} };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('window.switch → spawn_ok verified:true', async () => {
    const cr = { intent: 'window.switch' };
    const tr = { ok: true, data: {} };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });
}

// ─── 11. Phase 2 M2.4 — Suite 10: Synonym & coverage tests ──────────────────

async function runM24SynonymTests() {
  section('11. M2.4 — Suite 10: Synonym and coverage tests');

  // ── app.open synonyms ──
  await test('"start chrome" → app.open', async () => {
    const r = await classify('start chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open');
    assert.equal(r.confidence, 'pattern');
  });

  await test('"run notepad" → app.open', async () => {
    const r = await classify('run notepad', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open');
  });

  await test('"launch spotify" → app.open', async () => {
    const r = await classify('launch spotify', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open');
  });

  // ── app.close synonyms ──
  await test('"exit chrome" → app.close + appName=chrome', async () => {
    const r = await classify('exit chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.close');
    assert.equal(r.params.appName, 'chrome');
  });

  await test('"terminate notepad" → app.close', async () => {
    const r = await classify('terminate notepad', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.close');
    assert.equal(r.params.appName, 'notepad');
  });

  await test('"shut down edge" → app.close', async () => {
    const r = await classify('shut down edge', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.close');
    assert.equal(r.params.appName, 'edge');
  });

  // ── app.focus synonyms ──
  await test('"bring chrome" → app.focus (bare bring)', async () => {
    const r = await classify('bring chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.focus');
    assert.equal(r.params.appName, 'chrome');
  });

  await test('"foreground notepad" → app.focus', async () => {
    const r = await classify('foreground notepad', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.focus');
    assert.equal(r.params.appName, 'notepad');
  });

  // ── browser.search synonyms ──
  await test('"look up python tutorial" → browser.search', async () => {
    const r = await classify('look up python tutorial', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.search');
    assert.ok(r.params.query.includes('python'));
  });

  await test('"google best pizza" → browser.search', async () => {
    const r = await classify('google best pizza', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.search');
    assert.ok(r.params.query.includes('best pizza'));
  });

  // ── file.create: touch ──
  await test('"touch notes.txt" → file.create (touch pattern)', async () => {
    const r = await classify('touch notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.create');
    assert.equal(r.params.name, 'notes.txt');
  });

  // ── input.type: write out ──
  await test('"write out hello world" → input.type', async () => {
    const r = await classify('write out hello world', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.type');
    assert.equal(r.params.text, 'hello world');
  });

  // ── Named shortcut: save (no collision with file.write) ──
  await test('"save" alone → input.shortcut combo:ctrl+s (not file.write)', async () => {
    const r = await classify('save', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.shortcut');
    assert.equal(r.params.combo, 'ctrl+s');
  });

  // ── Ordering: write collision ──
  await test('"write hello to notes.txt" → file.write (NOT input.type)', async () => {
    const r = await classify('write hello to notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.write');
  });

  await test('"write this text hello" → input.type (NOT file.write)', async () => {
    const r = await classify('write this text hello', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.type');
    assert.ok(r.params.text.includes('hello'));
  });
}

// ─── 12. Phase 3 M3.1 — Suite 9: browser.site ───────────────────────────────

async function runM31BrowserSiteTests() {
  section('12. M3.1 — Suite 9: browser.site classifier & resolveSiteUrl');

  const { resolveSiteUrl, NAMED_SITES } = require('./tools/sites');

  // ── resolveSiteUrl unit tests ──
  await test('resolveSiteUrl("gmail") → https://mail.google.com', () => {
    assert.equal(resolveSiteUrl('gmail'), 'https://mail.google.com');
  });

  await test('resolveSiteUrl("GMAIL") → case-insensitive match', () => {
    assert.equal(resolveSiteUrl('GMAIL'), 'https://mail.google.com');
  });

  await test('resolveSiteUrl("YouTube") → https://youtube.com', () => {
    assert.equal(resolveSiteUrl('YouTube'), 'https://youtube.com');
  });

  await test('resolveSiteUrl("the youtube website") → normalises to youtube → correct URL', () => {
    assert.equal(resolveSiteUrl('the youtube website'), 'https://youtube.com');
  });

  await test('resolveSiteUrl("my drive") → normalises to drive → https://drive.google.com', () => {
    assert.equal(resolveSiteUrl('my drive'), 'https://drive.google.com');
  });

  await test('resolveSiteUrl("stack overflow") → https://stackoverflow.com', () => {
    assert.equal(resolveSiteUrl('stack overflow'), 'https://stackoverflow.com');
  });

  await test('resolveSiteUrl("google calendar") → https://calendar.google.com', () => {
    assert.equal(resolveSiteUrl('google calendar'), 'https://calendar.google.com');
  });

  await test('resolveSiteUrl("unknownxyz") → null', () => {
    assert.equal(resolveSiteUrl('unknownxyz'), null);
  });

  await test('resolveSiteUrl(null) → null (graceful)', () => {
    assert.equal(resolveSiteUrl(null), null);
  });

  await test('resolveSiteUrl("") → null (graceful)', () => {
    assert.equal(resolveSiteUrl(''), null);
  });

  // ── Classifier: browser.site intent detection ──
  await test('"open Gmail" → browser.site', async () => {
    const r = await classify('open Gmail', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.site', `Got "${r.intent}"`);
    assert.equal(r.confidence, 'pattern');
    assert.ok(r.params.siteName, 'siteName should be set');
  });

  await test('"go to YouTube" → browser.site, siteName contains youtube', async () => {
    const r = await classify('go to YouTube', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.site', `Got "${r.intent}"`);
    assert.ok(r.params.siteName.includes('youtube'), `siteName: "${r.params.siteName}"`);
  });

  await test('"launch GitHub" → browser.site', async () => {
    const r = await classify('launch GitHub', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.site', `Got "${r.intent}"`);
    assert.ok(r.params.siteName.includes('github'), `siteName: "${r.params.siteName}"`);
  });

  await test('"open Google Calendar" → browser.site', async () => {
    const r = await classify('open Google Calendar', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.site', `Got "${r.intent}"`);
    assert.ok(r.params.siteName.includes('google calendar') || r.params.siteName.includes('calendar'), `siteName: "${r.params.siteName}"`);
  });

  await test('"visit Stack Overflow" → browser.site', async () => {
    const r = await classify('visit Stack Overflow', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.site', `Got "${r.intent}"`);
  });

  await test('"open Claude" → browser.site', async () => {
    const r = await classify('open Claude', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.site', `Got "${r.intent}"`);
    assert.ok(r.params.siteName.includes('claude'), `siteName: "${r.params.siteName}"`);
  });

  await test('browser.site needsConfirm: false', async () => {
    const r = await classify('open Gmail', LLM_NEVER_CALLED);
    assert.equal(r.needsConfirm, false);
  });

  // ── Collision tests ──
  await test('COLLISION: "go to youtube.com" → browser.goto (has .com domain)', async () => {
    const r = await classify('go to youtube.com', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.goto', `Got "${r.intent}" — .com URLs must hit browser.goto`);
  });

  await test('COLLISION: "open Chrome" → app.open (Chrome is in APP_NAMES)', async () => {
    const r = await classify('open Chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open', `Got "${r.intent}" — app.open must fire before browser.site`);
  });

  await test('COLLISION: "open Firefox" → app.open (not browser.site)', async () => {
    const r = await classify('open Firefox', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open', `Got "${r.intent}"`);
  });

  // ── Dispatcher: browser.site routing (stub Electron + sites) ──
  section('12b. M3.1 — Dispatcher: browser.site routing');

  await test('browser.site missing siteName → DispatchError', async () => {
    const cr = { intent: 'browser.site', params: {}, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
      assert.ok(err.message.includes('site name'), `message: ${err.message}`);
    }
  });

  await test('browser.site with unknown site → ok:false, clean error message', async () => {
    // Patch sites module to return null for unknown site
    const sites = require('./tools/sites');
    const orig  = sites.resolveSiteUrl;
    sites.resolveSiteUrl = () => null;
    try {
      const r = await dispatch({ intent: 'browser.site', params: { siteName: 'unknownxyz' }, needsConfirm: false });
      assert.ok(!r.ok);
      assert.ok(r.error.includes('unknownxyz'), `error: ${r.error}`);
    } finally {
      sites.resolveSiteUrl = orig;
    }
  });

  // ── Verifier: browser.site → open_ok ──
  section('12c. M3.1 — Verifier: browser.site');

  await test('browser.site → open_ok verified:true', async () => {
    const cr = { intent: 'browser.site' };
    const tr = { ok: true, data: { url: 'https://mail.google.com', launched: true } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'open_ok');
    assert.ok(r.verified);
    assert.ok(r.detail.includes('mail.google.com'));
  });

  await test('browser.site tool failure → skipped', async () => {
    const cr = { intent: 'browser.site' };
    const tr = { ok: false, error: 'shell.openExternal failed' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
    assert.ok(!r.verified);
  });
}

// ─── 13. Phase 3 M3.2 — Suite 10: system.volume / system.brightness / system.lock ──

async function runM32SystemTests() {
  section('13. M3.2 — Suite 10: system.volume / system.brightness / system.lock');

  // ── system.volume: basic action extraction ──
  const volumeCases = [
    { t: 'mute',                         action: 'mute' },
    { t: 'silence',                      action: 'mute' },
    { t: 'unmute',                       action: 'unmute' },
    { t: 'volume up',                    action: 'up' },
    { t: 'turn the volume down',         action: 'down' },
    { t: 'louder',                       action: 'up' },
    { t: 'quieter',                      action: 'down' },
    { t: 'increase volume',              action: 'up' },
    { t: 'decrease the volume',          action: 'down' },
  ];

  for (const { t, action } of volumeCases) {
    await test(`"${t}" → system.volume, action: ${action}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, 'system.volume', `Got "${r.intent}"`);
      assert.equal(r.confidence, 'pattern');
      assert.equal(r.params.action, action, `action: got "${r.params.action}"`);
      assert.equal(r.needsConfirm, false);
    });
  }

  // ── system.volume: set level ──
  await test('"set volume to 50" → system.volume, action: set, level: 50', async () => {
    const r = await classify('set volume to 50', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.volume', `Got "${r.intent}"`);
    assert.equal(r.params.action, 'set', `action: "${r.params.action}"`);
    assert.equal(r.params.level, 50, `level: ${r.params.level}`);
  });

  await test('"set volume to 70" → system.volume, action: set, level: 70', async () => {
    const r = await classify('set volume to 70', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.volume');
    assert.equal(r.params.action, 'set');
    assert.equal(r.params.level, 70);
  });

  await test('"set the volume to 100" → system.volume, action: set, level: 100', async () => {
    const r = await classify('set the volume to 100', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.volume', `Got "${r.intent}"`);
    assert.equal(r.params.action, 'set');
    assert.equal(r.params.level, 100);
  });

  await test('"set volume to seventy" → system.volume, action: set, level: 70', async () => {
    const r = await classify('set volume to seventy', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.volume', `Got "${r.intent}"`);
    assert.equal(r.params.action, 'set');
    assert.equal(r.params.level, 70);
  });

  await test('"set the volume to max" → system.volume, action: set, level: 100', async () => {
    const r = await classify('set the volume to max', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.volume', `Got "${r.intent}"`);
    assert.equal(r.params.action, 'set');
    assert.equal(r.params.level, 100);
  });

  // ── system.brightness ──
  const brightnessCases = [
    { t: 'brightness up',        action: 'up' },
    { t: 'brightness down',      action: 'down' },
    { t: 'increase brightness',  action: 'up' },
    { t: 'decrease brightness',  action: 'down' },
    { t: 'dim the screen',       action: 'down' },
    { t: 'brighten the display', action: 'up' },
  ];

  for (const { t, action } of brightnessCases) {
    await test(`"${t}" → system.brightness, action: ${action}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, 'system.brightness', `Got "${r.intent}"`);
      assert.equal(r.params.action, action, `action: got "${r.params.action}"`);
      assert.equal(r.needsConfirm, false);
    });
  }

  // ── system.lock ──
  await test('"lock the screen" → system.lock, needsConfirm: true', async () => {
    const r = await classify('lock the screen', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.lock', `Got "${r.intent}"`);
    assert.equal(r.needsConfirm, true, 'system.lock must always needsConfirm');
    assert.deepEqual(r.params, {});
  });

  await test('"lock my computer" → system.lock, needsConfirm: true', async () => {
    const r = await classify('lock my computer', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.lock', `Got "${r.intent}"`);
    assert.equal(r.needsConfirm, true);
  });

  await test('"lock" → system.lock', async () => {
    const r = await classify('lock', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.lock', `Got "${r.intent}"`);
    assert.equal(r.needsConfirm, true);
  });

  // ── Collision tests ──
  await test('COLLISION: "lower volume" does NOT match window.minimize', async () => {
    const r = await classify('lower volume', LLM_NEVER_CALLED);
    assert.notEqual(r.intent, 'window.minimize', `Should NOT be window.minimize`);
    assert.equal(r.intent, 'system.volume', `Got "${r.intent}"`);
  });

  await test('COLLISION: "mute" does NOT match app.* patterns', async () => {
    const r = await classify('mute', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.volume', `Got "${r.intent}"`);
  });

  // ── Dispatcher: system.* routing (Tier A — param validation, no PS calls) ──
  section('13b. M3.2 — Dispatcher: system.* routing (param validation)');

  await test('system.volume missing action → DispatchError', async () => {
    const cr = { intent: 'system.volume', params: {}, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  await test('system.volume invalid action → DispatchError', async () => {
    const cr = { intent: 'system.volume', params: { action: 'explode' }, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  await test('system.volume set action without level → DispatchError', async () => {
    const cr = { intent: 'system.volume', params: { action: 'set' }, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  await test('system.brightness invalid action → DispatchError', async () => {
    const cr = { intent: 'system.brightness', params: { action: 'strobe' }, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  // ── Volume level clamping in dispatcher ──
  await test('system.volume set level=150 → clamped to 100 (no error)', async () => {
    // Patch system module so we don't actually call PS
    const system = require('./tools/system');
    const origSetVolume = system.setVolume;
    let receivedLevel = null;
    system.setVolume = async (params) => {
      receivedLevel = params.level;
      return { ok: true, data: { action: 'set', level: params.level }, action: `Volume set to ${params.level}%.` };
    };
    try {
      const r = await dispatch({ intent: 'system.volume', params: { action: 'set', level: 150 }, needsConfirm: false });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.equal(receivedLevel, 100, `Expected clamped level 100, got ${receivedLevel}`);
    } finally {
      system.setVolume = origSetVolume;
    }
  });

  await test('system.volume set level=−10 → clamped to 0', async () => {
    const system = require('./tools/system');
    const origSetVolume = system.setVolume;
    let receivedLevel = null;
    system.setVolume = async (params) => {
      receivedLevel = params.level;
      return { ok: true, data: { action: 'set', level: params.level }, action: `Volume set to ${params.level}%.` };
    };
    try {
      await dispatch({ intent: 'system.volume', params: { action: 'set', level: -10 }, needsConfirm: false });
      assert.equal(receivedLevel, 0, `Expected clamped level 0, got ${receivedLevel}`);
    } finally {
      system.setVolume = origSetVolume;
    }
  });

  // ── Verifier ──
  section('13c. M3.2 — Verifier: system.* intents');

  await test('system.volume → spawn_ok verified:true', async () => {
    const cr = { intent: 'system.volume' };
    const tr = { ok: true, data: { action: 'mute' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('system.lock → spawn_ok verified:true', async () => {
    const cr = { intent: 'system.lock' };
    const tr = { ok: true, data: { locked: true } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
  });

  await test('system.brightness → spawn_ok verified:true', async () => {
    const cr = { intent: 'system.brightness' };
    const tr = { ok: true, data: { action: 'up', from: 50, to: 60 } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'spawn_ok');
    assert.ok(r.verified);
    assert.ok(r.detail.includes('60'));
  });

  await test('system.brightness unavailable → brightness_unsupported verified:false', async () => {
    const cr = { intent: 'system.brightness' };
    const tr = { ok: false, error: 'Brightness control not available on this display.' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'brightness_unsupported');
    assert.ok(!r.verified);
  });

  await test('system.volume tool failure → skipped', async () => {
    const cr = { intent: 'system.volume' };
    const tr = { ok: false, error: 'PS timed out' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
    assert.ok(!r.verified);
  });
}

// ─── 14. Phase 3 M3.3 — Suite 11: file.find + file.open ─────────────────────

async function runM33FileSearchTests() {
  section('14. M3.3 — Suite 11: file.find and file.open classifier');

  const { findFiles, openFile } = require('./tools/files');

  // ── file.find: classifier intent detection ──
  const findCases = [
    { t: 'find my CV',                           intent: 'file.find', q: 'cv' },
    { t: 'locate my resume',                     intent: 'file.find', q: 'resume' },
    { t: 'where is my thesis',                   intent: 'file.find', q: 'thesis' },
    { t: 'search for budget spreadsheet',        intent: 'file.find', q: 'budget' },
    { t: 'look for the invoice document',        intent: 'file.find', q: 'invoice' },
  ];

  for (const { t, intent, q } of findCases) {
    await test(`"${t}" → ${intent}`, async () => {
      const r = await classify(t, LLM_NEVER_CALLED);
      assert.equal(r.intent, intent, `Got "${r.intent}"`);
      assert.equal(r.confidence, 'pattern');
      if (q) assert.ok(r.params.query && r.params.query.toLowerCase().includes(q), `query "${r.params.query}" should include "${q}"`);
      assert.equal(r.needsConfirm, false);
    });
  }

  // ── file.find: with extension ──
  await test('"find notes.txt" → file.find, query contains notes.txt', async () => {
    const r = await classify('find notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.find', `Got "${r.intent}"`);
    assert.ok(r.params.query && r.params.query.toLowerCase().includes('notes'), `query: "${r.params.query}"`);
  });

  await test('"find notes.txt in Documents" → file.find, locationHint: documents', async () => {
    const r = await classify('find notes.txt in Documents', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.find', `Got "${r.intent}"`);
    assert.equal(r.params.locationHint, 'documents');
  });

  await test('"find PDF files" → file.find, extension: pdf', async () => {
    const r = await classify('find PDF files', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.find', `Got "${r.intent}"`);
    assert.equal(r.params.extension, 'pdf', `extension: "${r.params.extension}"`);
  });

  // ── file.open: classifier intent detection ──
  await test('"open notes.txt" → file.open, name: notes.txt', async () => {
    const r = await classify('open notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open', `Got "${r.intent}"`);
    assert.equal(r.params.name, 'notes.txt', `name: "${r.params.name}"`);
    assert.equal(r.needsConfirm, false);
  });

  await test('"open my resume.pdf" → file.open, name: resume.pdf', async () => {
    const r = await classify('open my resume.pdf', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open', `Got "${r.intent}"`);
    assert.ok(r.params.name && r.params.name.toLowerCase().includes('resume'), `name: "${r.params.name}"`);
  });

  await test('"show budget.xlsx" → file.open', async () => {
    const r = await classify('show budget.xlsx', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open', `Got "${r.intent}"`);
    assert.ok(r.params.name && r.params.name.toLowerCase().includes('budget'));
  });

  await test('"open my CV" → file.open, name alias: cv', async () => {
    const r = await classify('open my CV', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open', `Got "${r.intent}"`);
    assert.equal(r.params.name, 'cv', `name: "${r.params.name}"`);
  });

  await test('"load my presentation" → file.open, name: presentation', async () => {
    const r = await classify('load my presentation', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open', `Got "${r.intent}"`);
    assert.equal(r.params.name, 'presentation');
  });

  await test('"show my resume" → file.open, name: resume', async () => {
    const r = await classify('show my resume', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open', `Got "${r.intent}"`);
    assert.equal(r.params.name, 'resume');
  });

  // ── Collision tests ──
  await test('COLLISION: "open Chrome" → app.open (NOT file.open)', async () => {
    const r = await classify('open Chrome', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'app.open', `Got "${r.intent}" — app.open must fire before file.open`);
  });

  await test('COLLISION: "read notes.txt" → file.read (NOT file.open)', async () => {
    const r = await classify('read notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.read', `Got "${r.intent}" — file.read must fire before file.open`);
  });

  await test('COLLISION: "find my documents folder" → file.list (NOT file.find)', async () => {
    const r = await classify('find my documents folder', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.list', `Got "${r.intent}" — "folder" keyword must route to file.list`);
  });

  await test('COLLISION: "list my documents folder" → file.list (NOT file.find)', async () => {
    const r = await classify('list my documents folder', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.list', `Got "${r.intent}"`);
  });

  // ── Dispatcher: file.find routing ──
  section('14b. M3.3 — Dispatcher: file.find + file.open routing');

  await test('file.find missing query → DispatchError', async () => {
    const cr = { intent: 'file.find', params: {}, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError', `Expected DispatchError, got: ${err.name}`);
    }
  });

  await test('file.find with extension only → calls findFiles', async () => {
    let called = false;
    const orig = files.findFiles;
    files.findFiles = async ({ query, extension }) => {
      called = true;
      assert.equal(query, undefined);
      assert.equal(extension, 'pdf');
      return { ok: false, error: 'No files found.', action: '' };
    };
    try {
      const r = await dispatch({ intent: 'file.find', params: { extension: 'pdf' }, needsConfirm: false });
      assert.ok(called, 'findFiles should have been called');
    } finally {
      files.findFiles = orig;
    }
  });

  await test('file.open missing name and path → DispatchError', async () => {
    const cr = { intent: 'file.open', params: {}, needsConfirm: false };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  await test('file.open with name, findFiles returns no matches → ok:false', async () => {
    const orig = files.findFiles;
    files.findFiles = async () => ({ ok: false, error: 'No files matching...', action: '' });
    try {
      const r = await dispatch({ intent: 'file.open', params: { name: 'unknownxyz.txt' }, needsConfirm: false });
      assert.ok(!r.ok, 'Should return ok:false when file not found');
      assert.ok(r.error.includes('unknownxyz'), `error: ${r.error}`);
    } finally {
      files.findFiles = orig;
    }
  });

  await test('file.open with name, findFiles returns match → calls openFile with top match path', async () => {
    const origFind = files.findFiles;
    const origOpen = files.openFile;
    let openedPath = null;
    files.findFiles = async () => ({
      ok:     true,
      data:   { matches: [{ name: 'notes.txt', path: `${os.homedir()}/Documents/Jarvis/notes.txt`, sizeBytes: 100, modifiedAt: '' }], searchedIn: 'Jarvis', query: 'notes' },
      action: 'Found notes.txt.',
    });
    files.openFile = async ({ path: p }) => {
      openedPath = p;
      return { ok: true, data: { path: p, opened: true }, action: `Opened "notes.txt".` };
    };
    try {
      const r = await dispatch({ intent: 'file.open', params: { name: 'notes.txt' }, needsConfirm: false });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.ok(openedPath && openedPath.includes('notes.txt'), `openedPath: ${openedPath}`);
    } finally {
      files.findFiles = origFind;
      files.openFile  = origOpen;
    }
  });

  // ── Verifier: file.find and file.open ──
  section('14c. M3.3 — Verifier: file.find + file.open');

  await test('file.find with matches → search_ok verified:true', async () => {
    const cr = { intent: 'file.find' };
    const tr = { ok: true, data: { matches: [{ name: 'cv.pdf', path: `${os.homedir()}/Documents/cv.pdf` }], query: 'cv', searchedIn: 'Documents' } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'search_ok');
    assert.ok(r.verified);
    assert.ok(r.detail.includes('cv'));
  });

  await test('file.find with zero matches (ok:false) → skipped', async () => {
    const cr = { intent: 'file.find' };
    const tr = { ok: false, error: "No files matching 'xyz' found." };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
    assert.ok(!r.verified);
  });

  await test('file.open → open_ok verified:true', async () => {
    const cr = { intent: 'file.open' };
    const tr = { ok: true, data: { path: `${os.homedir()}/Documents/Jarvis/notes.txt`, opened: true } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'open_ok');
    assert.ok(r.verified);
    assert.ok(r.detail.includes('notes.txt'));
  });

  await test('file.open tool failure → skipped', async () => {
    const cr = { intent: 'file.open' };
    const tr = { ok: false, error: 'File not found' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
    assert.ok(!r.verified);
  });

  // ── findFiles safety: path outside HOME rejected ──
  await test('findFiles: PS result with path outside HOME is filtered out', async () => {
    // We can only test the pure-node parts of findFiles — the PS call returns results
    // which are filtered. We test that openFile rejects external paths.
    const r = await openFile({ path: '/etc/passwd' });
    assert.ok(!r.ok, 'Should reject path outside home directory');
    assert.ok(r.error.includes('outside home directory') || r.error.includes('requires Electron'), `error: ${r.error}`);
  });

  // ── Spoken-punctuation normalisation in classifier ──
  section('14d. M3.3 — Spoken punctuation normalisation');

  await test('"open resume underscore Jaseel dot pdf" → file.open with normalized name', async () => {
    const r = await classify('open resume underscore Jaseel dot pdf', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open', `Got "${r.intent}"`);
    assert.ok(r.params.name && /resume_jaseel\.pdf/i.test(r.params.name), `name: "${r.params.name}"`);
  });

  await test('"find my resume underscore jaseel" → file.find with normalized query', async () => {
    const r = await classify('find my resume underscore jaseel', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.find', `Got "${r.intent}"`);
    assert.ok(r.params.query && /resume_jaseel/i.test(r.params.query), `query: "${r.params.query}"`);
  });

  await test('"open report hyphen q1 dot docx" → file.open with normalized ext', async () => {
    const r = await classify('open report hyphen q1 dot docx', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open');
    assert.ok(r.params.name && /report-q1\.docx/i.test(r.params.name), `name: "${r.params.name}"`);
  });

  await test('non-file context ("type underscore") is NOT normalized', async () => {
    const r = await classify('type underscore', LLM_NEVER_CALLED);
    // should still land on input.type, and preserve "underscore" as spoken
    assert.equal(r.intent, 'input.type', `Got "${r.intent}"`);
  });

  await test('normalization preserves original raw', async () => {
    const r = await classify('find my resume underscore jaseel', LLM_NEVER_CALLED);
    assert.ok(r.raw.includes('underscore'), `raw: "${r.raw}" — must preserve original transcript`);
  });

  await test('file.open alias keeps full context ("open my resume Jaseel")', async () => {
    const r = await classify('open my resume Jaseel', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.open');
    assert.ok(r.params.name && /jaseel/i.test(r.params.name), `name: "${r.params.name}" must retain "jaseel"`);
  });

  // ── tokenizeQuery / expandAliases / scoreFile unit tests ──
  section('14e. M3.3 — tokenizeQuery / expandAliases / scoreFile');

  const { tokenizeQuery, expandAliases, scoreFile } = require('./tools/files');

  await test('tokenizeQuery: splits on whitespace/underscore/dash/dot', () => {
    const r = tokenizeQuery('resume_jaseel foo-bar');
    assert.deepEqual(r.tokens, ['resume', 'jaseel', 'foo', 'bar']);
    assert.equal(r.extension, null);
  });

  await test('tokenizeQuery: extracts trailing .pdf', () => {
    const r = tokenizeQuery('resume_jaseel.pdf');
    assert.deepEqual(r.tokens, ['resume', 'jaseel']);
    assert.equal(r.extension, 'pdf');
  });

  await test('tokenizeQuery: extracts trailing bare "pdf"', () => {
    const r = tokenizeQuery('resume jaseel pdf');
    assert.deepEqual(r.tokens, ['resume', 'jaseel']);
    assert.equal(r.extension, 'pdf');
  });

  await test('tokenizeQuery: drops stop words', () => {
    const r = tokenizeQuery('the resume document');
    assert.deepEqual(r.tokens, ['resume']);
  });

  await test('tokenizeQuery: empty / null → empty tokens', () => {
    assert.deepEqual(tokenizeQuery('').tokens, []);
    assert.deepEqual(tokenizeQuery(null).tokens, []);
  });

  await test('expandAliases: cv expands to resume/curriculum/vitae', () => {
    const r = expandAliases(['cv']);
    assert.ok(r.includes('cv'));
    assert.ok(r.includes('resume'));
    assert.ok(r.includes('curriculum'));
    assert.ok(r.includes('vitae'));
  });

  await test('expandAliases: resume expands symmetrically to cv', () => {
    const r = expandAliases(['resume']);
    assert.ok(r.includes('cv'));
    assert.ok(r.includes('resume'));
  });

  await test('expandAliases: non-alias token passes through unchanged', () => {
    const r = expandAliases(['jaseel']);
    assert.deepEqual(r, ['jaseel']);
  });

  await test('scoreFile: exact token match scores 10', () => {
    const s = scoreFile('resume_Jaseel.pdf', ['resume'], null);
    assert.ok(s >= 10, `score: ${s}`);
  });

  await test('scoreFile: two exact tokens + matching ext → 22', () => {
    const s = scoreFile('resume_Jaseel.pdf', ['resume', 'jaseel'], 'pdf');
    assert.equal(s, 22);
  });

  await test('scoreFile: extension mismatch → 0', () => {
    const s = scoreFile('resume_Jaseel.pdf', ['resume'], 'docx');
    assert.equal(s, 0);
  });

  await test('scoreFile: substring-only match scores 5', () => {
    const s = scoreFile('myresumefile.pdf', ['resume'], null);
    assert.equal(s, 5);
  });

  await test('scoreFile: no match → 0', () => {
    const s = scoreFile('notes.txt', ['resume'], null);
    assert.equal(s, 0);
  });

  // ── End-to-end findFiles with mocked PowerShell ──
  section('14f. M3.3 — findFiles end-to-end (mocked PS)');

  // Build a fake PS JSON payload with resume_Jaseel.pdf on Desktop + a few decoys
  const fakePsJson = JSON.stringify([
    { Name: 'resume_Jaseel.pdf',    FullName: `${os.homedir()}/Desktop/resume_Jaseel.pdf`,  LastWriteTime: '2026-03-01T10:00:00Z', Length: 120000 },
    { Name: 'resume_Jaseel.pdf',    FullName: `${os.homedir()}/Documents/resume_Jaseel.pdf`, LastWriteTime: '2026-02-01T10:00:00Z', Length: 120000 },
    { Name: 'random_notes.txt',     FullName: `${os.homedir()}/Documents/random_notes.txt`, LastWriteTime: '2026-01-01T10:00:00Z', Length: 2048 },
    { Name: 'budget_2025.xlsx',     FullName: `${os.homedir()}/Documents/budget_2025.xlsx`, LastWriteTime: '2025-12-01T10:00:00Z', Length: 8192 },
    { Name: 'etc_passwd',           FullName: `/etc/passwd`,                                 LastWriteTime: '2026-01-01T10:00:00Z', Length: 2048 },
  ]);

  await test('findFiles("cv") matches resume_Jaseel.pdf via alias expansion', async () => {
    await withPatchedExports('./tools/ps-runner', {
      runPS: async () => ({ ok: true, stdout: fakePsJson, stderr: '' }),
    }, async () => {
      const r = await files.findFiles({ query: 'cv', locationHint: 'desktop' });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.ok(r.data.matches.length >= 1);
      assert.equal(r.data.matches[0].name, 'resume_Jaseel.pdf');
      assert.ok(r.data.expandedTokens.includes('resume'));
    });
  });

  await test('findFiles("resume jaseel pdf") ranks resume_Jaseel.pdf first', async () => {
    await withPatchedExports('./tools/ps-runner', {
      runPS: async () => ({ ok: true, stdout: fakePsJson, stderr: '' }),
    }, async () => {
      const r = await files.findFiles({ query: 'resume jaseel pdf' });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.equal(r.data.matches[0].name, 'resume_Jaseel.pdf');
      assert.equal(r.data.extension, 'pdf');
    });
  });

  await test('findFiles("resume_Jaseel.pdf") returns exact match first', async () => {
    await withPatchedExports('./tools/ps-runner', {
      runPS: async () => ({ ok: true, stdout: fakePsJson, stderr: '' }),
    }, async () => {
      const r = await files.findFiles({ query: 'resume_Jaseel.pdf' });
      assert.ok(r.ok);
      assert.equal(r.data.matches[0].name, 'resume_Jaseel.pdf');
    });
  });

  await test('findFiles filters out paths outside HOME (/etc/passwd)', async () => {
    await withPatchedExports('./tools/ps-runner', {
      runPS: async () => ({ ok: true, stdout: fakePsJson, stderr: '' }),
    }, async () => {
      const r = await files.findFiles({ query: 'passwd' });
      if (r.ok) {
        for (const m of r.data.matches) {
          assert.ok(!m.path.startsWith('/etc/'), `Must not return /etc paths, got: ${m.path}`);
        }
      } // else: no matches after filtering — also acceptable
    });
  });

  await test('findFiles with extension only returns all matching-ext files', async () => {
    await withPatchedExports('./tools/ps-runner', {
      runPS: async () => ({ ok: true, stdout: fakePsJson, stderr: '' }),
    }, async () => {
      const r = await files.findFiles({ extension: 'pdf' });
      assert.ok(r.ok);
      for (const m of r.data.matches) {
        assert.ok(m.name.toLowerCase().endsWith('.pdf'), `non-pdf in results: ${m.name}`);
      }
    });
  });

  await test('findFiles with zero matches returns helpful error with tokens + aliases', async () => {
    await withPatchedExports('./tools/ps-runner', {
      runPS: async () => ({ ok: true, stdout: JSON.stringify([]), stderr: '' }),
    }, async () => {
      const r = await files.findFiles({ query: 'cv', locationHint: 'desktop' });
      assert.ok(!r.ok);
      assert.ok(r.error.includes('Desktop') || r.error.includes('desktop'), `error mentions location: ${r.error}`);
      assert.ok(r.error.includes('cv'), `error mentions query: ${r.error}`);
      assert.ok(/resume|curriculum|vitae/i.test(r.error), `error mentions alias: ${r.error}`);
    });
  });

  await test('findFiles honours locationHint=documents (single root)', async () => {
    let scriptSeen = '';
    await withPatchedExports('./tools/ps-runner', {
      runPS: async (script) => { scriptSeen = script; return { ok: true, stdout: fakePsJson, stderr: '' }; },
    }, async () => {
      await files.findFiles({ query: 'resume', locationHint: 'documents' });
      assert.ok(scriptSeen.includes('Documents'), 'PS script should target Documents');
      assert.ok(!scriptSeen.includes('Desktop'), 'PS script should NOT target Desktop when hint=documents');
    });
  });
}

// ─── 15. Phase 3 M3.4 — Suite 12: file.delete / file.rename / file.move ──────

async function runM34DestructiveFileTests() {
  section('15. M3.4 — Suite 12: file.delete / file.rename / file.move classifier');

  const { deleteFile, renameFile, moveFile } = require('./tools/files');

  // ── Classifier: file.delete ──
  await test('"delete notes.txt" → file.delete, needsConfirm: true', async () => {
    const r = await classify('delete notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.delete', `Got "${r.intent}"`);
    assert.equal(r.confidence, 'pattern');
    assert.equal(r.needsConfirm, true, 'file.delete must always needsConfirm');
    assert.ok(r.params.name && r.params.name.toLowerCase().includes('notes'), `name: "${r.params.name}"`);
  });

  await test('"remove old-report.pdf" → file.delete, needsConfirm: true', async () => {
    const r = await classify('remove old-report.pdf', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.delete', `Got "${r.intent}"`);
    assert.equal(r.needsConfirm, true);
    assert.ok(r.params.name, `name should be set: "${r.params.name}"`);
  });

  await test('"erase the file old-report.pdf" → file.delete', async () => {
    const r = await classify('erase the file old-report.pdf', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.delete', `Got "${r.intent}"`);
    assert.equal(r.needsConfirm, true);
  });

  // ── Classifier: file.rename ──
  await test('"rename notes.txt to journal.txt" → file.rename, needsConfirm: true', async () => {
    const r = await classify('rename notes.txt to journal.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.rename', `Got "${r.intent}"`);
    assert.equal(r.confidence, 'pattern');
    assert.equal(r.needsConfirm, true, 'file.rename must always needsConfirm');
    assert.ok(r.params.name && r.params.name.toLowerCase().includes('notes'), `name: "${r.params.name}"`);
    assert.ok(r.params.newName && r.params.newName.toLowerCase().includes('journal'), `newName: "${r.params.newName}"`);
  });

  await test('"rename the file report.docx to final-report.docx" → file.rename', async () => {
    const r = await classify('rename the file report.docx to final-report.docx', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.rename', `Got "${r.intent}"`);
    assert.equal(r.needsConfirm, true);
    assert.ok(r.params.newName && /final.?report/i.test(r.params.newName), `newName: "${r.params.newName}"`);
  });

  // ── Classifier: file.move ──
  await test('"move notes.txt to Desktop" → file.move, needsConfirm: true, targetLocationHint: desktop', async () => {
    const r = await classify('move notes.txt to Desktop', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.move', `Got "${r.intent}"`);
    assert.equal(r.confidence, 'pattern');
    assert.equal(r.needsConfirm, true, 'file.move must always needsConfirm');
    assert.equal(r.params.targetLocationHint, 'desktop', `targetLocationHint: "${r.params.targetLocationHint}"`);
  });

  await test('"move budget.xlsx to Documents" → file.move, targetLocationHint: documents', async () => {
    const r = await classify('move budget.xlsx to Documents', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.move', `Got "${r.intent}"`);
    assert.equal(r.params.targetLocationHint, 'documents', `targetLocationHint: "${r.params.targetLocationHint}"`);
  });

  await test('"transfer notes.txt into Downloads" → file.move', async () => {
    const r = await classify('transfer notes.txt into Downloads', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.move', `Got "${r.intent}"`);
    assert.equal(r.params.targetLocationHint, 'downloads', `targetLocationHint: "${r.params.targetLocationHint}"`);
  });

  // ── Collision tests ──
  await test('COLLISION: "erase" does NOT match file.append', async () => {
    const r = await classify('erase the file notes.txt', LLM_NEVER_CALLED);
    assert.notEqual(r.intent, 'file.append', 'Should not be file.append');
    assert.equal(r.intent, 'file.delete', `Got "${r.intent}"`);
  });

  await test('COLLISION: "remove" does NOT match file.read', async () => {
    const r = await classify('remove old-report.pdf', LLM_NEVER_CALLED);
    assert.notEqual(r.intent, 'file.read', 'Should not be file.read');
    assert.equal(r.intent, 'file.delete', `Got "${r.intent}"`);
  });

  // ── Dispatcher: file.delete / file.rename / file.move ──
  // The dispatcher now does find-first (calls findFiles to resolve real path,
  // then passes the absolute path to the tool). Tests mock findFiles to avoid
  // real PS execution in Tier A.
  section('15b. M3.4 — Dispatcher: file.delete / file.rename / file.move');

  await test('file.delete missing name → DispatchError', async () => {
    const cr = { intent: 'file.delete', params: {}, needsConfirm: true };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError', `Expected DispatchError, got: ${err.name}`);
      assert.ok(err.message.toLowerCase().includes('filename'), `message: ${err.message}`);
    }
  });

  await test('file.delete: dispatcher calls findFiles first, returns _resolved with concrete path', async () => {
    const fakeName = `dispatch-delete-${Date.now()}.txt`;
    const fakePath = path.join(LOCATION_MAP.jarvis, fakeName);
    await withPatchedExports('./tools/files', {
      findFiles: async () => ({
        ok:     true,
        data:   { matches: [{ name: fakeName, path: fakePath, sizeBytes: 100, modifiedAt: '', score: 15 }], searchedIn: 'Jarvis', query: 'test' },
        action: `Found ${fakeName}.`,
      }),
    }, async () => {
      const cr = { intent: 'file.delete', params: { name: 'test' }, needsConfirm: true };
      const r  = await dispatch(cr);
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.ok(r._resolved, 'Should return _resolved for pipeline confirm gate');
      assert.equal(r._resolved.params.path, fakePath, '_resolved.params.path should be the located path');
    });
  });

  await test('file.delete: findFiles returns no matches → ok:false helpful error', async () => {
    await withPatchedExports('./tools/files', {
      findFiles: async () => ({ ok: false, error: "No files matching 'missingxyz' found.", action: '' }),
    }, async () => {
      const r = await dispatch({ intent: 'file.delete', params: { name: 'missingxyz' }, needsConfirm: true });
      assert.ok(!r.ok, 'Should return ok:false when file not found');
      assert.ok(r.error.toLowerCase().includes('missingxyz'), `error: ${r.error}`);
    });
  });

  await test('file.rename missing newName → DispatchError', async () => {
    const cr = { intent: 'file.rename', params: { name: 'notes.txt' }, needsConfirm: true };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  await test('file.rename: dispatcher calls findFiles, returns _resolved with concrete path', async () => {
    const srcName = `dispatch-rename-src-${Date.now()}.txt`;
    const dstName = `dispatch-rename-dst-${Date.now()}.txt`;
    const srcPath = path.join(LOCATION_MAP.jarvis, srcName);
    await withPatchedExports('./tools/files', {
      findFiles: async () => ({
        ok:   true,
        data: { matches: [{ name: srcName, path: srcPath, sizeBytes: 100, modifiedAt: '', score: 15 }], searchedIn: 'Jarvis', query: srcName },
        action: `Found ${srcName}.`,
      }),
    }, async () => {
      const cr = { intent: 'file.rename', params: { name: srcName, newName: dstName }, needsConfirm: true };
      const r  = await dispatch(cr);
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.ok(r._resolved, 'Should return _resolved for pipeline confirm gate');
      assert.equal(r._resolved.params.path, srcPath, '_resolved.params.path should be the located path');
    });
  });

  await test('file.move missing targetLocationHint → DispatchError', async () => {
    const cr = { intent: 'file.move', params: { name: 'notes.txt' }, needsConfirm: true };
    try {
      await dispatch(cr);
      assert.fail('should have thrown DispatchError');
    } catch (err) {
      assert.equal(err.name, 'DispatchError');
    }
  });

  await test('file.move: dispatcher calls findFiles, returns _resolved with concrete path', async () => {
    const fname   = `dispatch-move-${Date.now()}.txt`;
    const srcPath = path.join(LOCATION_MAP.jarvis, fname);
    await withPatchedExports('./tools/files', {
      findFiles: async () => ({
        ok:   true,
        data: { matches: [{ name: fname, path: srcPath, sizeBytes: 100, modifiedAt: '', score: 15 }], searchedIn: 'Jarvis', query: fname },
        action: `Found ${fname}.`,
      }),
    }, async () => {
      const cr = { intent: 'file.move', params: { name: fname, targetLocationHint: 'desktop' }, needsConfirm: true };
      const r  = await dispatch(cr);
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.ok(r._resolved, 'Should return _resolved for pipeline confirm gate');
      assert.equal(r._resolved.params.path, srcPath, '_resolved.params.path should be the located path');
    });
  });

  // ── M3.4 hardening: strict match gate ──
  section('15b-h. M3.4 — Hardening: strict match gate, spoken normalization, move source fix');

  await test('file.delete: low-confidence match (score < 10) → rejected with helpful error', async () => {
    await withPatchedExports('./tools/files', {
      findFiles: async () => ({
        ok:   true,
        data: { matches: [{ name: 'other-file.txt', path: '/home/user/other-file.txt', sizeBytes: 100, modifiedAt: '', score: 5 }], searchedIn: 'Jarvis', query: 'xyz' },
        action: 'Found other-file.txt.',
      }),
    }, async () => {
      const r = await dispatch({ intent: 'file.delete', params: { name: 'xyz' }, needsConfirm: true });
      assert.ok(!r.ok, 'Should reject low-confidence match');
      assert.ok(
        r.error.toLowerCase().includes('confident') || r.error.toLowerCase().includes('score') || r.error.toLowerCase().includes('threshold'),
        `error should mention confidence/score: ${r.error}`
      );
    });
  });

  await test('file.delete: ambiguous matches (2 candidates ≥ 10) → returns ambiguous:true (M4.1)', async () => {
    const ctx = require('./context');
    ctx.clear();
    await withPatchedExports('./tools/files', {
      findFiles: async () => ({
        ok:   true,
        data: { matches: [
          { name: 'notes.txt',        path: '/home/user/notes.txt',        sizeBytes: 100, modifiedAt: '', score: 15 },
          { name: 'notes-backup.txt', path: '/home/user/notes-backup.txt', sizeBytes: 100, modifiedAt: '', score: 12 },
        ], searchedIn: 'Documents', query: 'notes' },
        action: 'Found 2 files.',
      }),
    }, async () => {
      const r = await dispatch({ intent: 'file.delete', params: { name: 'notes' }, needsConfirm: true });
      assert.ok(!r.ok, 'Should not be ok when ambiguous');
      assert.ok(r.ambiguous, 'Should return ambiguous:true for multiple matches (M4.1 disambiguation)');
      assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 2, 'Should include candidates');
    });
    ctx.clear();
  });

  await test('file.rename: low-confidence match → rejected', async () => {
    await withPatchedExports('./tools/files', {
      findFiles: async () => ({
        ok:   true,
        data: { matches: [{ name: 'unrelated.txt', path: '/home/user/unrelated.txt', sizeBytes: 100, modifiedAt: '', score: 3 }], searchedIn: 'Jarvis', query: 'xyz' },
        action: 'Found unrelated.txt.',
      }),
    }, async () => {
      const r = await dispatch({ intent: 'file.rename', params: { name: 'xyz', newName: 'abc.txt' }, needsConfirm: true });
      assert.ok(!r.ok, 'Should reject low-confidence match');
    });
  });

  await test('file.move: findFiles is called with locationHint=undefined (not destination hint)', async () => {
    let capturedLocationHint = 'NOT_CAPTURED';
    const fname   = `move-hint-test-${Date.now()}.txt`;
    const srcPath = path.join(LOCATION_MAP.jarvis, fname);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(srcPath, 'move hint test', 'utf8');
    try {
      await withPatchedExports('./tools/files', {
        findFiles: async (opts) => {
          capturedLocationHint = opts.locationHint;
          return {
            ok:   true,
            data: { matches: [{ name: fname, path: srcPath, sizeBytes: 100, modifiedAt: '', score: 15 }], searchedIn: 'All', query: fname },
            action: `Found ${fname}.`,
          };
        },
      }, async () => {
        const r = await dispatch({ intent: 'file.move', params: { name: fname, targetLocationHint: 'documents', locationHint: 'desktop' }, needsConfirm: true });
        assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      });
      assert.equal(capturedLocationHint, undefined, `Expected locationHint=undefined, got: "${capturedLocationHint}"`);
    } finally {
      try { if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath); } catch {}
    }
  });

  await test('classifier: spoken dot normalization on rename — "rename hello dot txt to journal dot txt"', async () => {
    const r = await classify('rename hello dot txt to journal dot txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.rename', `Got "${r.intent}"`);
    assert.ok(r.params.name && r.params.name.toLowerCase().includes('.txt'),
      `name should contain .txt: "${r.params.name}"`);
    assert.ok(r.params.newName && r.params.newName.toLowerCase().includes('.txt'),
      `newName should contain .txt: "${r.params.newName}"`);
  });

  await test('classifier: trailing extension word in newName — "rename report.txt to summary PDF"', async () => {
    const r = await classify('rename report.txt to summary PDF', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.rename', `Got "${r.intent}"`);
    assert.ok(r.params.newName && /summary\.pdf/i.test(r.params.newName),
      `newName should be "summary.pdf": "${r.params.newName}"`);
  });

  await test('files: renameFile auto-preserves extension when newName has none', async () => {
    const { renameFile } = require('./tools/files');
    const srcName = `ext-preserve-${Date.now()}.txt`;
    const srcPath = path.join(LOCATION_MAP.jarvis, srcName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(srcPath, 'ext test', 'utf8');
    try {
      const r = await renameFile({ name: srcName, newName: 'journal', locationHint: 'jarvis' });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.ok(r.data.newPath.endsWith('.txt'),
        `newPath should end with .txt: "${r.data.newPath}"`);
      assert.ok(fs.existsSync(r.data.newPath), 'Renamed file should exist');
    } finally {
      if (fs.existsSync(srcPath)) try { fs.unlinkSync(srcPath); } catch {}
      const dstPath = path.join(LOCATION_MAP.jarvis, 'journal.txt');
      if (fs.existsSync(dstPath)) try { fs.unlinkSync(dstPath); } catch {}
    }
  });

  await test('files: renameFile does NOT double-add extension when newName already has one', async () => {
    const { renameFile } = require('./tools/files');
    const srcName = `no-double-ext-${Date.now()}.txt`;
    const srcPath = path.join(LOCATION_MAP.jarvis, srcName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(srcPath, 'ext test', 'utf8');
    try {
      const r = await renameFile({ name: srcName, newName: 'journal.md', locationHint: 'jarvis' });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.ok(r.data.newPath.endsWith('.md'), `newPath should end with .md: "${r.data.newPath}"`);
    } finally {
      if (fs.existsSync(srcPath)) try { fs.unlinkSync(srcPath); } catch {}
      const dstPath = path.join(LOCATION_MAP.jarvis, 'journal.md');
      if (fs.existsSync(dstPath)) try { fs.unlinkSync(dstPath); } catch {}
    }
  });

  // ── Direct tool tests (backward compat: { name, locationHint } API) ──
  // These call the tool functions directly (no dispatcher / no findFiles) to verify
  // the fallback resolution path still works for Tier A Jarvis-workspace files.

  await test('deleteFile({ name, locationHint }) for existing file → ok:true (direct fallback API)', async () => {
    const tmpName = `direct-delete-${Date.now()}.txt`;
    const tmpPath = path.join(LOCATION_MAP.jarvis, tmpName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(tmpPath, 'to be deleted', 'utf8');
    try {
      const r = await deleteFile({ name: tmpName, locationHint: 'jarvis' });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.equal(r.data.deleted, true);
      assert.ok(!fs.existsSync(tmpPath), 'File should no longer exist');
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  await test('deleteFile({ name }) for non-existent file → ok:false', async () => {
    const r = await deleteFile({ name: 'nonexistent-xyz-99999.txt', locationHint: 'jarvis' });
    assert.ok(!r.ok, 'Should fail for non-existent file');
    assert.ok(r.error.toLowerCase().includes('not found'), `error: ${r.error}`);
  });

  await test('deleteFile path traversal ({ name: "../../../etc/passwd" }) → ok:false', async () => {
    const r = await deleteFile({ name: '../../../etc/passwd', locationHint: 'jarvis' });
    assert.ok(!r.ok, 'Should reject path traversal');
  });

  await test('renameFile({ name, newName, locationHint }) → ok:true (direct fallback API)', async () => {
    const srcName = `direct-rename-src-${Date.now()}.txt`;
    const dstName = `direct-rename-dst-${Date.now()}.txt`;
    const srcPath = path.join(LOCATION_MAP.jarvis, srcName);
    const dstPath = path.join(LOCATION_MAP.jarvis, dstName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(srcPath, 'rename me', 'utf8');
    try {
      const r = await renameFile({ name: srcName, newName: dstName, locationHint: 'jarvis' });
      assert.ok(r.ok, `Expected ok:true, got: ${r.error}`);
      assert.equal(r.data.renamed, true);
      assert.ok(!fs.existsSync(srcPath), 'Old name should no longer exist');
      assert.ok(fs.existsSync(dstPath), 'New name should exist');
    } finally {
      if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
      if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
    }
  });

  await test('renameFile with path separator in newName → ok:false', async () => {
    const r = await renameFile({ name: 'notes.txt', newName: '../other/journal.txt', locationHint: 'jarvis' });
    assert.ok(!r.ok, 'Should reject path separators in newName');
    assert.ok(r.error.toLowerCase().includes('separator') || r.error.toLowerCase().includes('path'), `error: ${r.error}`);
  });

  await test('renameFile with same name → ok:false', async () => {
    const tmpName = `same-name-${Date.now()}.txt`;
    const tmpPath = path.join(LOCATION_MAP.jarvis, tmpName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(tmpPath, 'same', 'utf8');
    try {
      const r = await renameFile({ name: tmpName, newName: tmpName, locationHint: 'jarvis' });
      assert.ok(!r.ok, 'Should reject same-name rename');
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  await test('moveFile({ path, targetLocationHint:"jarvis" }) to same dir → ok:false', async () => {
    // Use path-based API: src and dst both in jarvis → same location
    const fname = `same-move-${Date.now()}.txt`;
    const p     = path.join(LOCATION_MAP.jarvis, fname);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(p, 'same location test', 'utf8');
    try {
      const r = await moveFile({ path: p, targetLocationHint: 'jarvis' });
      assert.ok(!r.ok, 'Should reject same-location move');
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  // ── Verifier: file.delete → file_gone ──
  section('15c. M3.4 — Verifier: file.delete / file.rename / file.move');

  await test('file.delete → file_gone verified:true when file does not exist', async () => {
    const fakePath = path.join(LOCATION_MAP.jarvis, `gone-${Date.now()}.txt`);
    // File genuinely doesn't exist — verified should be true
    const cr = { intent: 'file.delete' };
    const tr = { ok: true, data: { path: fakePath, deleted: true, sizeBytes: 100 } };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'file_gone');
    assert.ok(r.verified, 'file_gone should be verified:true when file is absent');
  });

  await test('file.delete → file_gone verified:false when file still exists', async () => {
    const tmpName = `still-exists-${Date.now()}.txt`;
    const tmpPath = path.join(LOCATION_MAP.jarvis, tmpName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(tmpPath, 'still here', 'utf8');
    try {
      const cr = { intent: 'file.delete' };
      const tr = { ok: true, data: { path: tmpPath, deleted: true, sizeBytes: 10 } };
      const r  = await verify(cr, tr);
      assert.equal(r.method, 'file_gone');
      assert.ok(!r.verified, 'file_gone should be verified:false if file still exists');
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  await test('file.rename → file_exists verified:true for newPath', async () => {
    const tmpName = `rename-verify-${Date.now()}.txt`;
    const tmpPath = path.join(LOCATION_MAP.jarvis, tmpName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(tmpPath, 'verifier test', 'utf8');
    try {
      const cr = { intent: 'file.rename' };
      const tr = { ok: true, data: { oldPath: tmpPath + '.old', newPath: tmpPath, renamed: true } };
      const r  = await verify(cr, tr);
      assert.equal(r.method, 'file_exists');
      assert.ok(r.verified, 'file_exists should be verified:true when newPath exists');
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  await test('file.move → file_exists verified:true for newPath', async () => {
    const tmpName = `move-verify-${Date.now()}.txt`;
    const tmpPath = path.join(LOCATION_MAP.jarvis, tmpName);
    await fs.promises.mkdir(LOCATION_MAP.jarvis, { recursive: true });
    await fs.promises.writeFile(tmpPath, 'verifier test', 'utf8');
    try {
      const cr = { intent: 'file.move' };
      const tr = { ok: true, data: { oldPath: tmpPath + '.old', newPath: tmpPath, moved: true } };
      const r  = await verify(cr, tr);
      assert.equal(r.method, 'file_exists');
      assert.ok(r.verified, 'file_exists should be verified:true when newPath exists');
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  await test('file.delete tool failure → skipped', async () => {
    const cr = { intent: 'file.delete' };
    const tr = { ok: false, error: 'File not found' };
    const r  = await verify(cr, tr);
    assert.equal(r.method, 'skipped');
    assert.ok(!r.verified);
  });
}

// ─── 16. Phase 3 M3.5 — Suite 13: Sequential command chaining ────────────────

async function runM35ChainTests() {
  section('16. M3.5 — Suite 13: splitChain unit tests');

  // ── splitChain: basic splits ──
  // NOTE: bare "and" is NOT a chain connector (too collision-prone with noun phrases).
  // Chain connectors: "and then", "then", "and after that", "followed by", "after that".
  await test('splitChain("open Chrome and go to YouTube") → 1 part (bare "and" is not a connector)', () => {
    const r = splitChain('open Chrome and go to YouTube');
    assert.equal(r.parts.length, 1, `bare "and" must not split. parts: ${JSON.stringify(r.parts)}`);
    assert.equal(r.wasCapped, false);
  });

  await test('splitChain("open Chrome and then go to YouTube") → 2 parts', () => {
    const r = splitChain('open Chrome and then go to YouTube');
    assert.equal(r.parts.length, 2, `parts: ${JSON.stringify(r.parts)}`);
    assert.ok(r.parts[0].toLowerCase().includes('open chrome'), `part[0]: "${r.parts[0]}"`);
    assert.ok(r.parts[1].toLowerCase().includes('go to youtube'), `part[1]: "${r.parts[1]}"`);
    assert.equal(r.wasCapped, false);
  });

  await test('splitChain on "and then" connector', () => {
    const r = splitChain('open notepad and then type hello world');
    assert.equal(r.parts.length, 2);
    assert.ok(r.parts[0].toLowerCase().includes('open notepad'), `part[0]: "${r.parts[0]}"`);
    assert.ok(r.parts[1].toLowerCase().includes('type hello world'), `part[1]: "${r.parts[1]}"`);
    assert.equal(r.wasCapped, false);
  });

  await test('splitChain on bare "then" connector', () => {
    const r = splitChain('mute then lock the screen');
    assert.equal(r.parts.length, 2);
    assert.ok(r.parts[0].toLowerCase().includes('mute'), `part[0]: "${r.parts[0]}"`);
    assert.ok(r.parts[1].toLowerCase().includes('lock'), `part[1]: "${r.parts[1]}"`);
    assert.equal(r.wasCapped, false);
  });

  await test('splitChain on "followed by" connector', () => {
    const r = splitChain('volume up followed by brightness down');
    assert.equal(r.parts.length, 2);
    assert.ok(r.parts[0].toLowerCase().includes('volume up'), `part[0]: "${r.parts[0]}"`);
    assert.ok(r.parts[1].toLowerCase().includes('brightness down'), `part[1]: "${r.parts[1]}"`);
  });

  await test('splitChain on "and after that" connector', () => {
    const r = splitChain('mute and after that lock the screen');
    assert.equal(r.parts.length, 2);
    assert.ok(r.parts[0].toLowerCase().includes('mute'), `part[0]: "${r.parts[0]}"`);
    assert.ok(r.parts[1].toLowerCase().includes('lock'), `part[1]: "${r.parts[1]}"`);
  });

  await test('splitChain single command → 1 part, wasCapped:false', () => {
    const r = splitChain('open notepad');
    assert.equal(r.parts.length, 1, `parts: ${JSON.stringify(r.parts)}`);
    assert.equal(r.parts[0], 'open notepad');
    assert.equal(r.wasCapped, false);
  });

  await test('splitChain 3-part chain → capped at 2, wasCapped:true', () => {
    const r = splitChain('open notepad and then type hello and then save');
    assert.equal(r.parts.length, 2, `parts: ${JSON.stringify(r.parts)}`);
    assert.equal(r.wasCapped, true);
    assert.ok(r.parts[0].toLowerCase().includes('open notepad'), `part[0]: "${r.parts[0]}"`);
    assert.ok(r.parts[1].toLowerCase().includes('type hello'), `part[1]: "${r.parts[1]}"`);
  });

  await test('splitChain("create a file called notes.txt and write this: hello world") → correct split', () => {
    const r = splitChain('create a file called notes.txt and write this: hello world');
    // "and" without "then" should NOT split — no connector present
    // This is a single command (no chain connector)
    assert.equal(r.parts.length, 1, `Should not split on bare "and" without connector. parts: ${JSON.stringify(r.parts)}`);
  });

  await test('splitChain null/empty → safe handling', () => {
    const r = splitChain('');
    assert.equal(r.parts.length, 1);
    assert.equal(r.wasCapped, false);
  });

  section('16b. M3.5 — Pipeline chain integration tests');

  // ── Step 1 unsupported → pipeline stops ──
  await test('chain: step 1 unrecognised → done(ok:false), no step 2 attempted', async () => {
    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });
    const confirmCalls = [];
    const waitForConfirm = () => {
      confirmCalls.push(true);
      return Promise.resolve(true);
    };

    // "xyzzy and then mumble" — both parts are unrecognised (no LLM key in test env)
    await runPipelineFromText('xyzzy and then mumble', hudSend, waitForConfirm);

    const doneEvent = events.find(e => e.ch === 'jarvis:done');
    assert.ok(doneEvent, 'Should have received jarvis:done event');
    assert.ok(!doneEvent.payload.ok, 'Should be ok:false');
    assert.equal(confirmCalls.length, 0, 'No confirmation should have been requested');
  });

  // ── Step 1 fails via dispatch → step 2 skipped ──
  await test('chain: step 1 dispatch fails → step 2 not dispatched', async () => {
    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    let step2Classified = false;
    const classifierModule = require('./classifier');
    const origClassify = classifierModule.classify;
    classifierModule.classify = async (t) => {
      // step 1: returns a valid intent so dispatch runs; step 2: track if called
      if (t.includes('STEP1')) {
        return { intent: 'system.volume', params: { action: 'mute' }, needsConfirm: false, confidence: 'pattern', raw: t };
      }
      step2Classified = true;
      return { intent: 'system.volume', params: { action: 'up' }, needsConfirm: false, confidence: 'pattern', raw: t };
    };
    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;
    let dispatchCallCount = 0;
    dispatcherModule.dispatch = async (cr) => {
      dispatchCallCount++;
      return { ok: false, error: 'Simulated failure from step 1' };
    };

    try {
      await runPipelineFromText('STEP1 and then STEP2', hudSend, () => Promise.resolve(true));
      const doneEvent = events.find(e => e.ch === 'jarvis:done');
      assert.ok(doneEvent, 'Should have done event');
      assert.ok(!doneEvent.payload.ok, 'Should be ok:false');
      assert.equal(dispatchCallCount, 1, 'Only step 1 should have been dispatched');
      assert.ok(!step2Classified, 'Step 2 should not have been classified since step 1 failed');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
    }
  });

  // ── Step 2 requires confirm → confirm shown for step 2 ──
  await test('chain: step 2 needsConfirm → confirm requested for step 2', async () => {
    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });
    const confirmEvents = [];
    const waitForConfirm = () => {
      confirmEvents.push(true);
      return Promise.resolve(true);
    };

    const classifierModule = require('./classifier');
    const origClassify = classifierModule.classify;
    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;
    const verifierModule = require('./verifier');
    const origVerify = verifierModule.verify;

    classifierModule.classify = async (t) => {
      if (t.includes('STEP1')) return { intent: 'system.volume', params: { action: 'mute' }, needsConfirm: false, confidence: 'pattern', raw: t };
      // step 2 requires confirmation
      return { intent: 'system.lock', params: {}, needsConfirm: true, confidence: 'pattern', raw: t };
    };
    dispatcherModule.dispatch = async (cr) => {
      return { ok: true, data: {}, action: `Done: ${cr.intent}` };
    };
    verifierModule.verify = async (cr, tr) => {
      return { verified: true, method: 'spawn_ok', detail: 'ok' };
    };

    try {
      await runPipelineFromText('STEP1 and then STEP2', hudSend, waitForConfirm);
      const confirmShown = events.filter(e => e.ch === 'jarvis:confirm');
      assert.equal(confirmShown.length, 1, 'Exactly one confirm event should be emitted (for step 2)');
      const doneEvent = events.find(e => e.ch === 'jarvis:done');
      assert.ok(doneEvent, 'Should have done event');
      assert.ok(doneEvent.payload.ok, `Should be ok:true, got: ${JSON.stringify(doneEvent.payload)}`);
      assert.ok(Array.isArray(doneEvent.payload.steps), 'done event should have steps array');
      assert.equal(doneEvent.payload.steps.length, 2, 'Should have 2 steps');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify = origVerify;
    }
  });

  // ── Successful 2-step chain → steps array in done event ──
  await test('chain: 2 successful steps → done(ok:true, steps:[action1,action2])', async () => {
    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    const classifierModule = require('./classifier');
    const origClassify = classifierModule.classify;
    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;
    const verifierModule = require('./verifier');
    const origVerify = verifierModule.verify;

    let stepIndex = 0;
    classifierModule.classify = async (t) => {
      stepIndex++;
      return { intent: 'system.volume', params: { action: stepIndex === 1 ? 'mute' : 'up' }, needsConfirm: false, confidence: 'pattern', raw: t };
    };
    dispatcherModule.dispatch = async (cr) => {
      const label = cr.params.action === 'mute' ? 'Muted.' : 'Volume increased.';
      return { ok: true, data: {}, action: label };
    };
    verifierModule.verify = async () => ({ verified: true, method: 'spawn_ok', detail: 'ok' });

    try {
      stepIndex = 0;
      await runPipelineFromText('mute and then volume up', hudSend, () => Promise.resolve(true));
      const doneEvent = events.find(e => e.ch === 'jarvis:done');
      assert.ok(doneEvent, 'Should have done event');
      assert.ok(doneEvent.payload.ok, `ok:true expected. payload: ${JSON.stringify(doneEvent.payload)}`);
      assert.ok(Array.isArray(doneEvent.payload.steps), 'steps should be an array');
      assert.equal(doneEvent.payload.steps.length, 2, 'Should have 2 steps');
      assert.ok(doneEvent.payload.display.includes('Muted'), `display: "${doneEvent.payload.display}"`);
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify = origVerify;
    }
  });

  // ── 3-step chain → capped at 2 with spoken note ──
  await test('chain: 3-step utterance → executes 2 steps, display includes cap note', async () => {
    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    const classifierModule = require('./classifier');
    const origClassify = classifierModule.classify;
    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;
    const verifierModule = require('./verifier');
    const origVerify = verifierModule.verify;

    classifierModule.classify = async (t) => ({
      intent: 'system.volume', params: { action: 'mute' }, needsConfirm: false, confidence: 'pattern', raw: t,
    });
    dispatcherModule.dispatch = async () => ({ ok: true, data: {}, action: 'Muted.' });
    verifierModule.verify = async () => ({ verified: true, method: 'spawn_ok', detail: 'ok' });

    try {
      await runPipelineFromText('mute and then volume up and then brightness down', hudSend, () => Promise.resolve(true));
      const doneEvent = events.find(e => e.ch === 'jarvis:done');
      assert.ok(doneEvent, 'Should have done event');
      assert.ok(doneEvent.payload.ok, 'Should be ok:true (2 steps ran)');
      assert.ok(doneEvent.payload.display.toLowerCase().includes('two commands') ||
                doneEvent.payload.display.toLowerCase().includes('at a time'),
        `display should include cap note: "${doneEvent.payload.display}"`);
      assert.equal(doneEvent.payload.steps.length, 2, 'Only 2 steps should be in steps array');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify = origVerify;
    }
  });

  // ── Step indicator in status events ──
  await test('chain: status events include step field', async () => {
    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    const classifierModule = require('./classifier');
    const origClassify = classifierModule.classify;
    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;
    const verifierModule = require('./verifier');
    const origVerify = verifierModule.verify;

    classifierModule.classify = async (t) => ({
      intent: 'system.volume', params: { action: 'mute' }, needsConfirm: false, confidence: 'pattern', raw: t,
    });
    dispatcherModule.dispatch = async () => ({ ok: true, data: {}, action: 'Muted.' });
    verifierModule.verify = async () => ({ verified: true, method: 'spawn_ok', detail: 'ok' });

    try {
      await runPipelineFromText('mute and then volume up', hudSend, () => Promise.resolve(true));
      const statusWithStep = events.filter(e => e.ch === 'jarvis:status' && e.payload.step);
      assert.ok(statusWithStep.length > 0, 'At least one status event should have a step field');
      const steps = statusWithStep.map(e => e.payload.step);
      assert.ok(steps.includes('1 of 2'), `steps should include "1 of 2", got: ${JSON.stringify(steps)}`);
      assert.ok(steps.includes('2 of 2'), `steps should include "2 of 2", got: ${JSON.stringify(steps)}`);
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify = origVerify;
    }
  });
}

// ─── 17. Phase 4 M4.0 — Suite 14: Execution Context ──────────────────────────

async function runM40ContextTests() {
  section('17. M4.0 — Suite 14: context.js module');

  const ctx = require('./context');

  // ── Basic setters / getters ──
  await test('context: setFileTarget then getFileTarget returns correct entry', () => {
    ctx.clear();
    ctx.setFileTarget('cv.pdf', '/home/user/Documents/cv.pdf');
    const f = ctx.getFileTarget();
    assert.ok(f, 'should not be null');
    assert.equal(f.name, 'cv.pdf');
    assert.equal(f.path, '/home/user/Documents/cv.pdf');
  });

  await test('context: setWindowTarget then getWindowTarget returns correct entry', () => {
    ctx.clear();
    ctx.setWindowTarget('notepad', 12345, 'app');
    const w = ctx.getWindowTarget();
    assert.ok(w, 'should not be null');
    assert.equal(w.processName, 'notepad');
    assert.equal(w.hwnd, 12345);
    assert.equal(w.kind, 'app');
  });

  await test('context: setWindowTarget with browser kind stored correctly', () => {
    ctx.clear();
    ctx.setWindowTarget('msedge', 99, 'browser');
    const w = ctx.getWindowTarget();
    assert.equal(w.kind, 'browser');
    assert.equal(w.processName, 'msedge');
  });

  await test('context: setWindowTarget with null hwnd is allowed', () => {
    ctx.clear();
    ctx.setWindowTarget('notepad', null, 'app');
    const w = ctx.getWindowTarget();
    assert.ok(w, 'should exist');
    assert.equal(w.hwnd, null);
  });

  await test('context: setCandidates then getCandidates returns candidates + classifiedResult', () => {
    ctx.clear();
    const candidates = [
      { name: 'report-final.pdf', path: '/home/user/Documents/report-final.pdf', sizeBytes: 1024 },
      { name: 'report-draft.pdf', path: '/home/user/Documents/report-draft.pdf', sizeBytes: 512 },
    ];
    const fakeResult = { intent: 'file.delete', params: { name: 'report' } };
    ctx.setCandidates(candidates, fakeResult);
    const c = ctx.getCandidates();
    assert.ok(c, 'should not be null');
    assert.equal(c.candidates.length, 2);
    assert.equal(c.candidates[0].name, 'report-final.pdf');
    assert.equal(c.classifiedResult.intent, 'file.delete');
  });

  // ── clear() ──
  await test('context: clear() nullifies all getters', () => {
    ctx.setFileTarget('notes.txt', '/home/user/notes.txt');
    ctx.setWindowTarget('notepad', 1, 'app');
    ctx.setCandidates([{ name: 'x', path: '/x' }], {});
    ctx.clear();
    assert.equal(ctx.getFileTarget(), null);
    assert.equal(ctx.getWindowTarget(), null);
    assert.equal(ctx.getCandidates(), null);
  });

  // ── clearCandidates() ──
  await test('context: clearCandidates() removes only candidates, not window/file', () => {
    ctx.clear();
    ctx.setFileTarget('notes.txt', '/home/user/notes.txt');
    ctx.setWindowTarget('notepad', 1, 'app');
    ctx.setCandidates([{ name: 'x', path: '/x' }], {});
    ctx.clearCandidates();
    assert.equal(ctx.getCandidates(), null, 'candidates should be gone');
    assert.ok(ctx.getFileTarget(), 'file target should remain');
    assert.ok(ctx.getWindowTarget(), 'window target should remain');
  });

  // ── TTL expiry ──
  await test('context: getFileTarget returns null after TTL expires', async () => {
    ctx.clear();
    const settings = require('../settings');
    const origGet = settings.getSetting;
    // Override TTL to 50ms so we can test expiry quickly
    settings.getSetting = (key, fallback) => key === 'jarvisContextTtlMs' ? 50 : origGet(key, fallback);
    try {
      ctx.setFileTarget('old.txt', '/home/user/old.txt');
      assert.ok(ctx.getFileTarget(), 'should be present immediately');
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(ctx.getFileTarget(), null, 'should be null after TTL expired');
    } finally {
      settings.getSetting = origGet;
      ctx.clear();
    }
  });

  await test('context: getWindowTarget returns null after TTL expires', async () => {
    ctx.clear();
    const settings = require('../settings');
    const origGet = settings.getSetting;
    settings.getSetting = (key, fallback) => key === 'jarvisContextTtlMs' ? 50 : origGet(key, fallback);
    try {
      ctx.setWindowTarget('notepad', 1, 'app');
      assert.ok(ctx.getWindowTarget(), 'should be present immediately');
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(ctx.getWindowTarget(), null, 'should be null after TTL expired');
    } finally {
      settings.getSetting = origGet;
      ctx.clear();
    }
  });

  await test('context: TTL=0 means context never expires', async () => {
    ctx.clear();
    const settings = require('../settings');
    const origGet = settings.getSetting;
    settings.getSetting = (key, fallback) => key === 'jarvisContextTtlMs' ? 0 : origGet(key, fallback);
    try {
      ctx.setFileTarget('forever.txt', '/home/user/forever.txt');
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(ctx.getFileTarget(), 'TTL=0 should never expire');
    } finally {
      settings.getSetting = origGet;
      ctx.clear();
    }
  });

  // ── snapshot() ──
  await test('context: snapshot() returns full state including ttlRemaining', () => {
    ctx.clear();
    ctx.setFileTarget('snap.pdf', '/home/user/snap.pdf');
    ctx.setWindowTarget('notepad', 7, 'app');
    const snap = ctx.snapshot();
    assert.ok(snap.file, 'file should be in snapshot');
    assert.equal(snap.file.name, 'snap.pdf');
    assert.ok(typeof snap.file.ttlRemaining === 'number', 'ttlRemaining should be a number');
    assert.ok(snap.window, 'window should be in snapshot');
    assert.equal(snap.window.processName, 'notepad');
    assert.equal(snap.candidates, null, 'candidates should be null');
    assert.ok(snap.ttlMs > 0, 'ttlMs should be present');
    ctx.clear();
  });

  await test('context: snapshot() with no context set returns all nulls', () => {
    ctx.clear();
    const snap = ctx.snapshot();
    assert.equal(snap.window, null);
    assert.equal(snap.file, null);
    assert.equal(snap.candidates, null);
  });

  // ── Edge cases ──
  await test('context: setFileTarget with empty args is a no-op', () => {
    ctx.clear();
    ctx.setFileTarget('', '/some/path');
    assert.equal(ctx.getFileTarget(), null, 'empty name should not set');
    ctx.setFileTarget('name.txt', '');
    assert.equal(ctx.getFileTarget(), null, 'empty path should not set');
  });

  await test('context: setWindowTarget with empty processName is a no-op', () => {
    ctx.clear();
    ctx.setWindowTarget('', 1, 'app');
    assert.equal(ctx.getWindowTarget(), null);
  });

  await test('context: setCandidates with empty array is a no-op', () => {
    ctx.clear();
    ctx.setCandidates([], {});
    assert.equal(ctx.getCandidates(), null);
  });

  await test('context: overwriting file target replaces previous value', () => {
    ctx.clear();
    ctx.setFileTarget('old.pdf', '/home/user/old.pdf');
    ctx.setFileTarget('new.pdf', '/home/user/new.pdf');
    const f = ctx.getFileTarget();
    assert.equal(f.name, 'new.pdf');
    ctx.clear();
  });

  // ── Pipeline integration: app.focus writes to context ──
  await test('context: dispatcher writes window target after mock app.focus success', async () => {
    ctx.clear();
    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;

    // Patch dispatch to simulate app.focus returning ok with processName
    dispatcherModule.dispatch = async (cr) => {
      if (cr.intent === 'app.focus') {
        // Write context directly (simulating what real dispatcher does)
        ctx.setWindowTarget('notepad', null, 'app');
        return { ok: true, data: { focused: true, processName: 'notepad' }, action: 'Focused notepad.' };
      }
      return origDispatch(cr);
    };

    try {
      const events = [];
      const hudSend = (ch, p) => events.push({ ch, payload: p });
      await runPipelineFromText('focus notepad', hudSend, () => Promise.resolve(true));
      const w = ctx.getWindowTarget();
      assert.ok(w, 'window target should be set after app.focus');
      assert.equal(w.processName, 'notepad');
    } finally {
      dispatcherModule.dispatch = origDispatch;
      ctx.clear();
    }
  });

  // ── Pipeline integration: file.find writes to context ──
  await test('context: dispatcher writes file target after mock file.find single match', async () => {
    ctx.clear();
    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;

    dispatcherModule.dispatch = async (cr) => {
      if (cr.intent === 'file.find') {
        ctx.setFileTarget('cv.pdf', '/home/user/Documents/cv.pdf');
        return {
          ok: true,
          data: { matches: [{ name: 'cv.pdf', path: '/home/user/Documents/cv.pdf', sizeBytes: 1024 }], query: 'cv', searchedIn: 'Documents' },
          action: 'Found cv.pdf in Documents.',
        };
      }
      return origDispatch(cr);
    };

    try {
      const events = [];
      const hudSend = (ch, p) => events.push({ ch, payload: p });
      await runPipelineFromText('find my CV', hudSend, () => Promise.resolve(true));
      const f = ctx.getFileTarget();
      assert.ok(f, 'file target should be set after file.find');
      assert.equal(f.name, 'cv.pdf');
    } finally {
      dispatcherModule.dispatch = origDispatch;
      ctx.clear();
    }
  });
}

// ─── 18. Phase 4 M4.1 — Suite 15: Ambiguity Resolution ──────────────────────

async function runM41DisambiguationTests() {

  // ── system.cancel patterns ──
  section('18. M4.1 — Suite 15: system.cancel patterns');

  await test('system.cancel: "cancel" → system.cancel', async () => {
    const r = await classify('cancel', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.cancel');
    assert.equal(r.confidence, 'pattern');
  });

  await test('system.cancel: "never mind" → system.cancel', async () => {
    const r = await classify('never mind', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.cancel');
  });

  await test('system.cancel: "nevermind" → system.cancel', async () => {
    const r = await classify('nevermind', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.cancel');
  });

  await test('system.cancel: "forget it" → system.cancel', async () => {
    const r = await classify('forget it', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.cancel');
  });

  await test('system.cancel: "no" → system.cancel', async () => {
    const r = await classify('no', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.cancel');
  });

  await test('system.cancel: "abort" → system.cancel', async () => {
    const r = await classify('abort', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.cancel');
  });

  // Collision: "cancel" inside longer phrase should NOT fire system.cancel (anchored)
  await test('system.cancel collision: "cancel my booking" → NOT system.cancel (anchored)', async () => {
    const r = await classify('cancel my booking', LLM_NEVER_CALLED);
    assert.notEqual(r.intent, 'system.cancel', 'multi-word phrase must not match anchored pattern');
  });

  // ── system.select patterns ──
  section('18b. M4.1 — Suite 15: system.select patterns');

  await test('system.select: "one" → { ordinal: 1 }', async () => {
    const r = await classify('one', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.select');
    assert.equal(r.params.ordinal, 1);
  });

  await test('system.select: "two" → { ordinal: 2 }', async () => {
    const r = await classify('two', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.select');
    assert.equal(r.params.ordinal, 2);
  });

  await test('system.select: "the second one" → { ordinal: 2 }', async () => {
    const r = await classify('the second one', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.select');
    assert.equal(r.params.ordinal, 2);
  });

  await test('system.select: "number 3" → { ordinal: 3 }', async () => {
    const r = await classify('number 3', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.select');
    assert.equal(r.params.ordinal, 3);
  });

  await test('system.select: "4" → { ordinal: 4 }', async () => {
    const r = await classify('4', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.select');
    assert.equal(r.params.ordinal, 4);
  });

  await test('system.select: "option 2" → { ordinal: 2 }', async () => {
    const r = await classify('option 2', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.select');
    assert.equal(r.params.ordinal, 2);
  });

  await test('system.select: "first" → { ordinal: 1 }', async () => {
    const r = await classify('first', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.select');
    assert.equal(r.params.ordinal, 1);
  });

  // Collision: "open one drive" should NOT match system.select (anchored)
  await test('system.select collision: "open one drive" → NOT system.select', async () => {
    const r = await classify('open one drive', LLM_NEVER_CALLED);
    assert.notEqual(r.intent, 'system.select', '"open one drive" must not fire system.select');
  });

  // ── extractOrdinal ──
  section('18c. M4.1 — Suite 15: extractOrdinal helper');

  await test('extractOrdinal("first") → 1', () => {
    assert.equal(extractOrdinal('first'), 1);
  });

  await test('extractOrdinal("second one") → 2', () => {
    assert.equal(extractOrdinal('the second one'), 2);
  });

  await test('extractOrdinal("5") → 5', () => {
    assert.equal(extractOrdinal('5'), 5);
  });

  await test('extractOrdinal("tenth") → null', () => {
    assert.equal(extractOrdinal('tenth'), null);
  });

  // ── Dispatcher: system.cancel and system.select ──
  section('18d. M4.1 — Suite 15: dispatcher system.cancel and system.select');

  await test('dispatcher: system.cancel with no candidates → ok:true, clean message', async () => {
    const ctx = require('./context');
    ctx.clear();
    const r = await dispatch({ intent: 'system.cancel', params: {} });
    assert.ok(r.ok, 'should succeed');
    assert.ok(r.action.includes('cancel') || r.action.includes('Cancel'), 'should mention cancel');
  });

  await test('dispatcher: system.cancel with candidates → clears candidates, ok:true', async () => {
    const ctx = require('./context');
    ctx.clear();
    ctx.setCandidates([{ name: 'a.pdf', path: '/a.pdf' }], { intent: 'file.delete', params: {} });
    assert.ok(ctx.getCandidates(), 'candidates should be set');
    const r = await dispatch({ intent: 'system.cancel', params: {} });
    assert.ok(r.ok);
    assert.equal(ctx.getCandidates(), null, 'candidates should be cleared');
    ctx.clear();
  });

  await test('dispatcher: system.select with no candidates → ok:false, clean error', async () => {
    const ctx = require('./context');
    ctx.clear();
    const r = await dispatch({ intent: 'system.select', params: { ordinal: 1 } });
    assert.ok(!r.ok, 'should fail');
    assert.ok(r.error, 'should have error message');
  });

  await test('dispatcher: system.select with ordinal out of range → ok:false, error', async () => {
    const ctx = require('./context');
    ctx.clear();
    ctx.setCandidates([
      { name: 'a.pdf', path: '/a.pdf' },
      { name: 'b.pdf', path: '/b.pdf' },
    ], { intent: 'file.delete', params: { name: 'report' }, needsConfirm: true });
    const r = await dispatch({ intent: 'system.select', params: { ordinal: 5 } });
    assert.ok(!r.ok);
    assert.ok(r.error.includes('2') || r.error.includes('option'), 'error should mention valid range');
    ctx.clear();
  });

  await test('dispatcher: system.select valid → ok:true, _resolved set, context cleared', async () => {
    const ctx = require('./context');
    ctx.clear();
    const candidates = [
      { name: 'report-final.pdf', path: '/home/user/Documents/report-final.pdf', sizeBytes: 1024 },
      { name: 'report-draft.pdf', path: '/home/user/Documents/report-draft.pdf', sizeBytes: 512 },
    ];
    const origClassified = { intent: 'file.delete', params: { name: 'report' }, needsConfirm: true };
    ctx.setCandidates(candidates, origClassified);
    const r = await dispatch({ intent: 'system.select', params: { ordinal: 2 } });
    assert.ok(r.ok, 'should succeed');
    assert.ok(r._resolved, '_resolved should be set');
    assert.equal(r._resolved.intent, 'file.delete');
    assert.equal(r._resolved.params.path, '/home/user/Documents/report-draft.pdf');
    assert.equal(ctx.getCandidates(), null, 'candidates should be cleared after select');
    ctx.clear();
  });

  // ── Dispatcher: file.delete ambiguity ──
  section('18e. M4.1 — Suite 15: file.delete disambiguation flow');

  await test('dispatcher: file.delete with 3 score-qualifying matches → ambiguous:true', async () => {
    const ctx = require('./context');
    ctx.clear();

    const filesModule = require('./tools/files');
    const origFind = filesModule.findFiles;
    filesModule.findFiles = async () => ({
      ok: true,
      data: {
        matches: [
          { name: 'report-final.pdf', path: '/docs/report-final.pdf', score: 15 },
          { name: 'report-draft.pdf', path: '/docs/report-draft.pdf', score: 12 },
          { name: 'old-report.txt',   path: '/docs/old-report.txt',   score: 11 },
        ],
        query: 'report',
        searchedIn: 'Documents',
      },
    });

    try {
      const r = await dispatch({ intent: 'file.delete', params: { name: 'report' }, needsConfirm: true });
      assert.ok(!r.ok, 'should not be ok (ambiguous)');
      assert.ok(r.ambiguous, 'should have ambiguous:true');
      assert.ok(Array.isArray(r.candidates), 'should have candidates array');
      assert.equal(r.candidates.length, 3);
      assert.ok(r.action.includes('3') || r.action.includes('report'), 'action should mention count or name');
      // context should have candidates set
      const cands = ctx.getCandidates();
      assert.ok(cands, 'context should have candidates set');
      assert.equal(cands.candidates.length, 3);
    } finally {
      filesModule.findFiles = origFind;
      ctx.clear();
    }
  });

  await test('dispatcher: file.delete with single match → NOT ambiguous, proceeds normally', async () => {
    const filesModule = require('./tools/files');
    const origFind    = filesModule.findFiles;
    const origDelete  = filesModule.deleteFile;

    filesModule.findFiles = async () => ({
      ok: true,
      data: { matches: [{ name: 'report.pdf', path: '/docs/report.pdf', score: 18 }], query: 'report' },
    });
    filesModule.deleteFile = async ({ path: p }) => ({ ok: true, data: { path: p }, action: `Deleted ${p}.` });

    try {
      const r = await dispatch({ intent: 'file.delete', params: { name: 'report' }, needsConfirm: true });
      assert.ok(!r.ambiguous, 'single match should not be ambiguous');
    } finally {
      filesModule.findFiles  = origFind;
      filesModule.deleteFile = origDelete;
    }
  });

  await test('file.find with multiple matches does NOT trigger disambiguation', async () => {
    const filesModule = require('./tools/files');
    const origFind = filesModule.findFiles;
    filesModule.findFiles = async () => ({
      ok: true,
      data: {
        matches: [
          { name: 'report-final.pdf', path: '/docs/report-final.pdf', score: 15 },
          { name: 'report-draft.pdf', path: '/docs/report-draft.pdf', score: 12 },
        ],
        query: 'report',
      },
    });
    try {
      const r = await dispatch({ intent: 'file.find', params: { query: 'report' } });
      assert.ok(!r.ambiguous, 'file.find should never return ambiguous:true');
    } finally {
      filesModule.findFiles = origFind;
    }
  });

  // ── Pipeline: disambiguate event emission ──
  section('18f. M4.1 — Suite 15: pipeline disambiguation event emission');

  await test('pipeline: ambiguous dispatch result → emits jarvis:disambiguate event', async () => {
    const ctx = require('./context');
    ctx.clear();

    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;

    const candidates = [
      { name: 'report-final.pdf', path: '/docs/report-final.pdf' },
      { name: 'report-draft.pdf', path: '/docs/report-draft.pdf' },
    ];

    dispatcherModule.dispatch = async () => ({
      ok:         false,
      ambiguous:  true,
      candidates,
      action:     "I found 2 files matching \"report\". Say one or two.",
    });

    const events = [];
    const hudSend = (ch, p) => events.push({ ch, payload: p });

    try {
      // Use transcript that classifies to file.delete (has extension so pattern matches)
      await runPipelineFromText('delete report.pdf', hudSend, () => Promise.resolve(true));
      const disambigEvent = events.find((e) => e.ch === 'jarvis:disambiguate');
      assert.ok(disambigEvent, 'jarvis:disambiguate event should be emitted');
      assert.ok(Array.isArray(disambigEvent.payload.candidates));
      assert.equal(disambigEvent.payload.candidates.length, 2);

      const doneEvent = events.find((e) => e.ch === 'jarvis:done');
      assert.ok(doneEvent, 'jarvis:done should fire after disambiguation');
      assert.ok(doneEvent.payload.disambiguating, 'done payload should have disambiguating:true');
      assert.ok(!doneEvent.payload.ok, 'done should have ok:false');
    } finally {
      dispatcherModule.dispatch = origDispatch;
      ctx.clear();
    }
  });

  await test('pipeline: system.select _resolved → fires confirm gate then re-dispatches', async () => {
    const ctx = require('./context');
    ctx.clear();

    const dispatcherModule = require('./dispatcher');
    const origDispatch = dispatcherModule.dispatch;

    let dispatchCallCount = 0;
    let lastDispatchedIntent = null;

    dispatcherModule.dispatch = async (cr) => {
      dispatchCallCount++;
      lastDispatchedIntent = cr.intent;

      if (cr.intent === 'system.select') {
        const resolved = {
          intent: 'file.delete',
          params: { name: 'report-final.pdf', path: '/docs/report-final.pdf' },
          needsConfirm: true,
        };
        return { ok: true, _resolved: resolved, data: { selectedCandidate: resolved.params }, action: 'Selected "report-final.pdf".' };
      }
      if (cr.intent === 'file.delete') {
        return { ok: true, data: { path: '/docs/report-final.pdf' }, action: 'Deleted report-final.pdf.' };
      }
      return origDispatch(cr);
    };

    const confirmLog = [];
    const events = [];
    const hudSend = (ch, p) => events.push({ ch, payload: p });
    const waitForConfirm = () => {
      confirmLog.push('confirm_asked');
      return Promise.resolve(true);
    };

    try {
      await runPipelineFromText('the second one', hudSend, waitForConfirm);
      assert.ok(confirmLog.length >= 1, 'confirmation gate should have fired for the resolved file.delete');
      assert.equal(dispatchCallCount, 2, 'should dispatch twice: system.select then file.delete');
      const doneEvent = events.find((e) => e.ch === 'jarvis:done');
      assert.ok(doneEvent && doneEvent.payload.ok, 'pipeline should end with ok:true');
    } finally {
      dispatcherModule.dispatch = origDispatch;
      ctx.clear();
    }
  });
}

// ─── 19. Phase 4 M4.3 — Suite 17: Natural Command Refinement ─────────────────

async function runM43NaturalRefinementTests() {
  const { classify, splitChain, splitChainWithBareAnd, extractBrowserHint } = require('./classifier');
  const ctx = require('./context');

  // ── splitChainWithBareAnd ──────────────────────────────────────────────────

  section('19. M4.3 — Suite 17: splitChainWithBareAnd');

  test('bare "and" splits "Open Chrome and go to YouTube" into 2 parts', () => {
    const { parts, wasCapped } = splitChainWithBareAnd('Open Chrome and go to YouTube');
    assert.equal(parts.length, 2, 'should produce 2 parts');
    assert.equal(wasCapped, false);
    assert.ok(parts[0].trim().toLowerCase().includes('open chrome'));
    assert.ok(parts[1].trim().toLowerCase().includes('go to youtube'));
  });

  test('bare "and" with filename component is NOT split ("rename notes and tasks.txt to archive.txt")', () => {
    const { parts } = splitChainWithBareAnd('rename notes and tasks.txt to archive.txt');
    assert.equal(parts.length, 1, 'should not split when filename extension found');
  });

  test('bare "and" with extension in second part is NOT split', () => {
    const { parts } = splitChainWithBareAnd('find report and open summary.pdf');
    assert.equal(parts.length, 1);
  });

  test('reliable connector takes priority over bare "and"', () => {
    const { parts } = splitChainWithBareAnd('open Chrome and then go to YouTube');
    assert.equal(parts.length, 2);
    // splitChain matched "and then" — parts should differ from bare-and split
  });

  test('no "and" → single part, wasCapped false', () => {
    const { parts, wasCapped } = splitChainWithBareAnd('mute');
    assert.equal(parts.length, 1);
    assert.equal(wasCapped, false);
  });

  test('three-part bare "and" capped at default 2 with wasCapped:true', () => {
    const { parts, wasCapped } = splitChainWithBareAnd('open A and open B and open C');
    assert.equal(parts.length, 2);
    assert.equal(wasCapped, true);
  });

  test('three-part bare "and" with maxSteps=3 yields 3 parts', () => {
    const { parts, wasCapped } = splitChainWithBareAnd('open A and open B and open C', 3);
    assert.equal(parts.length, 3);
    assert.equal(wasCapped, false);
  });

  test('splitChain still works and exports are unchanged', () => {
    const { parts } = splitChain('open Chrome and then go to YouTube');
    assert.equal(parts.length, 2);
  });

  // ── extractBrowserHint ────────────────────────────────────────────────────

  section('19b. M4.3 — Suite 17: extractBrowserHint');

  test('extractBrowserHint "go to YouTube in Edge" → "edge"', () => {
    assert.equal(extractBrowserHint('go to YouTube in Edge'), 'edge');
  });

  test('extractBrowserHint "open Gmail using Chrome" → "chrome"', () => {
    assert.equal(extractBrowserHint('open Gmail using Chrome'), 'chrome');
  });

  test('extractBrowserHint "open Gmail in Firefox" → "firefox"', () => {
    assert.equal(extractBrowserHint('open Gmail in Firefox'), 'firefox');
  });

  test('extractBrowserHint "open Gmail" → null', () => {
    assert.equal(extractBrowserHint('open Gmail'), null);
  });

  test('extractBrowserHint "open Gmail in brave" → "brave"', () => {
    assert.equal(extractBrowserHint('open Gmail in brave'), 'brave');
  });

  // ── Pronoun patterns ──────────────────────────────────────────────────────

  section('19c. M4.3 — Suite 17: pronoun classifier patterns');

  test('"open it" → file.open { useContext: true }', async () => {
    const r = await classify('open it');
    assert.equal(r.intent, 'file.open');
    assert.equal(r.params.useContext, true);
    assert.equal(r.confidence, 'pattern');
  });

  test('"show that file" → file.open { useContext: true }', async () => {
    const r = await classify('show that file');
    assert.equal(r.intent, 'file.open');
    assert.equal(r.params.useContext, true);
  });

  test('"rename it to final.txt" → file.rename { useContext:true, newName:"final.txt" }', async () => {
    const r = await classify('rename it to final.txt');
    assert.equal(r.intent, 'file.rename');
    assert.equal(r.params.useContext, true);
    assert.equal(r.params.newName, 'final.txt');
    assert.equal(r.needsConfirm, true);
  });

  test('"delete it" → file.delete { useContext: true }, needsConfirm', async () => {
    const r = await classify('delete it');
    assert.equal(r.intent, 'file.delete');
    assert.equal(r.params.useContext, true);
    assert.equal(r.needsConfirm, true);
  });

  test('"remove that file" → file.delete { useContext: true }', async () => {
    const r = await classify('remove that file');
    assert.equal(r.intent, 'file.delete');
    assert.equal(r.params.useContext, true);
  });

  test('"move it to Desktop" → file.move { useContext:true, targetLocationHint:"desktop" }', async () => {
    const r = await classify('move it to Desktop');
    assert.equal(r.intent, 'file.move');
    assert.equal(r.params.useContext, true);
    assert.equal(r.params.targetLocationHint, 'desktop');
    assert.equal(r.needsConfirm, true);
  });

  test('"open it somewhat please" does NOT match pronoun pattern (not anchored)', async () => {
    const r = await classify('open it somewhat please');
    // Should NOT be file.open useContext — anchored pattern requires short bare form
    assert.ok(r.intent !== 'file.open' || r.params.useContext !== true,
      'long phrase should not fire pronoun pattern');
  });

  test('"open one drive" does NOT trigger system.select (ordinal guard)', async () => {
    const r = await classify('open one drive');
    assert.notEqual(r.intent, 'system.select', '"one" inside a longer phrase should not fire system.select');
  });

  // ── New APP_NAMES aliases ─────────────────────────────────────────────────

  section('19d. M4.3 — Suite 17: new app name aliases');

  test('"open vs code" → app.open, appName contains "vs code"', async () => {
    const r = await classify('open vs code');
    assert.equal(r.intent, 'app.open');
    assert.ok(r.params.appName && r.params.appName.toLowerCase().includes('vs code'),
      `expected "vs code" in appName, got "${r.params.appName}"`);
  });

  test('"open task manager" → app.open', async () => {
    const r = await classify('open task manager');
    assert.equal(r.intent, 'app.open');
    assert.ok(r.params.appName && r.params.appName.toLowerCase().includes('task manager'),
      `expected "task manager" in appName, got "${r.params.appName}"`);
  });

  test('"open powerpoint" → app.open', async () => {
    const r = await classify('open powerpoint');
    assert.equal(r.intent, 'app.open');
    assert.ok(r.params.appName && r.params.appName.toLowerCase().includes('powerpoint'),
      `expected "powerpoint" in appName, got "${r.params.appName}"`);
  });

  test('"close calculator" → app.close', async () => {
    const r = await classify('close calculator');
    assert.equal(r.intent, 'app.close');
    assert.ok(r.params.appName && r.params.appName.toLowerCase().includes('calculator'),
      `expected "calculator" in appName, got "${r.params.appName}"`);
  });

  test('"open explorer" → app.open (file explorer alias without "file" word collision)', async () => {
    const r = await classify('open explorer');
    assert.equal(r.intent, 'app.open');
    assert.ok(r.params.appName && r.params.appName.toLowerCase().includes('explorer'),
      `expected "explorer" in appName, got "${r.params.appName}"`);
  });

  // ── Dispatcher useContext resolution ──────────────────────────────────────

  section('19e. M4.3 — Suite 17: dispatcher useContext resolution');

  test('file.open { useContext:true } with no context → clean error', async () => {
    const dispatcherModule = require('./dispatcher');
    ctx.clear();
    const result = await dispatcherModule.dispatch({
      intent: 'file.open',
      params: { useContext: true },
    });
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.toLowerCase().includes('context'),
      `expected context error, got: "${result.error}"`);
  });

  test('file.rename { useContext:true } with no context → clean error', async () => {
    const dispatcherModule = require('./dispatcher');
    ctx.clear();
    const result = await dispatcherModule.dispatch({
      intent: 'file.rename',
      params: { useContext: true, newName: 'new.txt' },
    });
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.toLowerCase().includes('context'));
  });

  test('file.delete { useContext:true } with no context → clean error', async () => {
    const dispatcherModule = require('./dispatcher');
    ctx.clear();
    const result = await dispatcherModule.dispatch({
      intent: 'file.delete',
      params: { useContext: true },
      needsConfirm: true,
    });
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.toLowerCase().includes('context'));
  });

  test('file.move { useContext:true } with no context → clean error', async () => {
    const dispatcherModule = require('./dispatcher');
    ctx.clear();
    const result = await dispatcherModule.dispatch({
      intent: 'file.move',
      params: { useContext: true, targetLocationHint: 'desktop' },
      needsConfirm: true,
    });
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.toLowerCase().includes('context'));
  });

  test('file.delete { useContext:true } with file context → returns _resolved with path', async () => {
    const dispatcherModule = require('./dispatcher');
    ctx.clear();
    ctx.setFileTarget('cv.pdf', '/home/user/Documents/cv.pdf');
    const result = await dispatcherModule.dispatch({
      intent: 'file.delete',
      params: { useContext: true },
      needsConfirm: true,
    });
    ctx.clear();
    assert.equal(result.ok, true);
    assert.ok(result._resolved, 'should return _resolved for pipeline to handle');
    assert.equal(result._resolved.params.path, '/home/user/Documents/cv.pdf');
    assert.equal(result._resolved.params.name, 'cv.pdf');
  });
}

// ─── Run all suites ───────────────────────────────────────────────────────────

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  Jarvis — Phase 1 + Phase 2 + Phase 3 M3.5 Tier A Tests                 ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  await runPathTests();
  await runFileTests();
  await runClassifierTests();
  await runDispatcherTests();
  await runVerifierTests();
  await runM21Tests();
  await runM22ClassifierTests();
  await runM22DispatcherTests();
  await runM23Tests();
  await runM24VerifierTests();
  await runM24SynonymTests();
  await runM31BrowserSiteTests();
  await runM32SystemTests();
  await runM33FileSearchTests();
  await runM34DestructiveFileTests();
  await runM35ChainTests();
  await runM40ContextTests();
  await runM41DisambiguationTests();
  await runM43NaturalRefinementTests();

  console.log('\n─────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\nSome tests failed.');
    process.exit(1);
  } else {
    console.log('\nAll tests passed. Phase 4 M4.3 complete.');
  }
})();
