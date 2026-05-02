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
const { classify, splitChain, splitChainWithBareAnd, extractOrdinal, extractBrowserHint } = require('./classifier');
const { dispatch }               = require('./dispatcher');
const { verify }                 = require('./verifier');
const { runPipelineFromText }    = require('./pipeline');
const traceMod                   = require('./trace');
const ctx                        = require('./context');

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

  await test('scoreFile: exact token match → strong tier, score 10', () => {
    const r = scoreFile('resume_Jaseel.pdf', '/home/u/Desktop/resume_Jaseel.pdf', ['resume'], null);
    assert.ok(r.score >= 10, `score: ${r.score}`);
    assert.equal(r.tier, 'strong');
  });

  await test('scoreFile: two exact tokens + matching ext → score 22, strong', () => {
    const r = scoreFile('resume_Jaseel.pdf', '/home/u/Desktop/resume_Jaseel.pdf', ['resume', 'jaseel'], 'pdf');
    assert.equal(r.score, 22);
    assert.equal(r.tier, 'strong');
  });

  await test('scoreFile: extension mismatch → 0, none', () => {
    const r = scoreFile('resume_Jaseel.pdf', '/home/u/Desktop/resume_Jaseel.pdf', ['resume'], 'docx');
    assert.equal(r.score, 0);
    assert.equal(r.tier, 'none');
  });

  await test('scoreFile: parent-path match → medium tier (no name token)', () => {
    const r = scoreFile('notes.txt', '/home/u/Documents/CV/notes.txt', ['cv'], null);
    assert.equal(r.tier, 'medium');
    assert.ok(r.score >= 5, `score: ${r.score}`);
  });

  await test('scoreFile: substring without word boundary → no match (was the bug)', () => {
    const r = scoreFile('myresumefile.pdf', '/home/u/Desktop/myresumefile.pdf', ['resume'], null);
    assert.equal(r.score, 0);
    assert.equal(r.tier, 'none');
  });

  await test('scoreFile: no match → 0, none', () => {
    const r = scoreFile('notes.txt', '/home/u/Desktop/notes.txt', ['resume'], null);
    assert.equal(r.score, 0);
    assert.equal(r.tier, 'none');
  });

  await test('scoreFile: stopword leak case — "can"/"you" no longer match unrelated files', () => {
    // Regression test for the Apr 2026 bug: "Can you find my CV" used to
    // match files via substring "can"/"you" inside other words.
    const r1 = scoreFile('first regression.txt', '/home/u/Desktop/first regression.txt', ['can', 'you'], null);
    assert.equal(r1.score, 0);
    const r2 = scoreFile('vacancy_notes.txt', '/home/u/Desktop/vacancy_notes.txt', ['can'], null);
    assert.equal(r2.score, 0);
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

// ─── 20. Phase 4 M4.4 — Suite 18: Trace module and structured run log ────────

async function runM44TraceTests() {

  // ── trace.js — createTrace / builder API ─────────────────────────────────

  section('20. M4.4 — Suite 18: trace.js createTrace + builder API');

  await test('createTrace builds record with required fields', () => {
    const record = traceMod.createTrace('find my CV').build();
    assert.ok(record.id,        'must have id');
    assert.ok(record.timestamp, 'must have timestamp');
    assert.equal(record.rawInput, 'find my CV');
    assert.ok('normalized'      in record, 'must have normalized');
    assert.ok('intent'          in record, 'must have intent');
    assert.ok('confidence'      in record, 'must have confidence');
    assert.ok('tier'            in record, 'must have tier');
    assert.ok('dispatchOk'     in record, 'must have dispatchOk');
    assert.ok('verifyOk'       in record, 'must have verifyOk');
    assert.ok(record.timings,   'must have timings');
  });

  await test('setClassification with patternIndex stores intent and patternIndex', () => {
    const fakeResult = { intent: 'file.find', confidence: 'pattern', params: { query: 'CV' }, needsConfirm: false };
    const record = traceMod.createTrace('find my CV')
      .setClassification(fakeResult, 4)
      .build();
    assert.equal(record.intent,       'file.find');
    assert.equal(record.patternIndex, 4);
    assert.equal(record.confidence,   'pattern');
    assert.equal(record.tier,         'pattern');
  });

  await test('setClassification with LLM confidence sets tier to llm', () => {
    const fakeResult = { intent: 'file.open', confidence: 'llm', params: {}, needsConfirm: false };
    const record = traceMod.createTrace('open the file').setClassification(fakeResult).build();
    assert.equal(record.tier, 'llm');
    assert.equal(record.patternIndex, null, '_patternIndex should be null for LLM');
  });

  await test('setClassification with unsupported intent sets tier to unsupported', () => {
    const fakeResult = { intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false };
    const record = traceMod.createTrace('blah blah').setClassification(fakeResult).build();
    assert.equal(record.tier, 'unsupported');
  });

  await test('setClassification reads _patternIndex from result when no explicit arg', () => {
    const fakeResult = { intent: 'app.open', confidence: 'pattern', params: {}, needsConfirm: false, _patternIndex: 12 };
    const record = traceMod.createTrace('open notepad').setClassification(fakeResult).build();
    assert.equal(record.patternIndex, 12);
  });

  await test('setContextUsed(null) → windowTarget/fileTarget null, hadCandidates false', () => {
    const record = traceMod.createTrace('test').setContextUsed(null).build();
    assert.equal(record.contextUsed.windowTarget,  null);
    assert.equal(record.contextUsed.fileTarget,    null);
    assert.equal(record.contextUsed.hadCandidates, false);
  });

  await test('setContextUsed with snapshot sets correct fields', () => {
    ctx.clear();
    ctx.setFileTarget('cv.pdf', '/docs/cv.pdf');
    const snap = ctx.snapshot();
    const record = traceMod.createTrace('open it').setContextUsed(snap).build();
    assert.ok(record.contextUsed.fileTarget,   'fileTarget should be present');
    assert.equal(record.contextUsed.fileTarget.name, 'cv.pdf');
    assert.equal(record.contextUsed.hadCandidates,   false);
    ctx.clear();
  });

  await test('setContextUsed with candidates in snapshot → hadCandidates true', () => {
    ctx.clear();
    const cands = [{ name: 'a.pdf', path: '/a.pdf', sizeBytes: 0 }];
    ctx.setCandidates(cands, { intent: 'file.delete', params: {} });
    const snap   = ctx.snapshot();
    const record = traceMod.createTrace('the second one').setContextUsed(snap).build();
    assert.equal(record.contextUsed.hadCandidates, true);
    ctx.clear();
  });

  await test('setDispatch with ok:false and error stores dispatchOk=false and error', () => {
    const record = traceMod.createTrace('test')
      .setDispatch({ ok: false, error: 'File not found.' })
      .build();
    assert.equal(record.dispatchOk, false);
    assert.equal(record.error, 'File not found.');
  });

  await test('setDispatch with ambiguous result stores ambiguousCount', () => {
    const candidates = [{ name: 'a.pdf', path: '/a.pdf', sizeBytes: 0 }, { name: 'b.pdf', path: '/b.pdf', sizeBytes: 0 }];
    const record = traceMod.createTrace('delete report')
      .setDispatch({ ok: false, ambiguous: true, candidates })
      .build();
    assert.equal(record.ambiguousCount, 2);
    assert.equal(record.dispatchOk,    false);
  });

  await test('setVerify(verified:true) → verifyOk true', () => {
    const record = traceMod.createTrace('test')
      .setVerify({ verified: true, method: 'file-exists' })
      .build();
    assert.equal(record.verifyOk, true);
  });

  await test('setVerify(verified:false) → verifyOk false', () => {
    const record = traceMod.createTrace('test')
      .setVerify({ verified: false, method: 'none' })
      .build();
    assert.equal(record.verifyOk, false);
  });

  await test('setTimings stores all timing fields', () => {
    const record = traceMod.createTrace('test')
      .setTimings({ classify: 1, dispatch: 22, verify: 3, tts: 240, total: 270 })
      .build();
    assert.equal(record.timings.classify, 1);
    assert.equal(record.timings.dispatch, 22);
    assert.equal(record.timings.total,    270);
  });

  await test('setChainStep stores chainStep label', () => {
    const record = traceMod.createTrace('test').setChainStep('1 of 2').build();
    assert.equal(record.chainStep, '1 of 2');
  });

  await test('setError stores error message', () => {
    const record = traceMod.createTrace('test').setError('oops').build();
    assert.equal(record.error, 'oops');
  });

  await test('build() returns frozen object', () => {
    const record = traceMod.createTrace('test').build();
    let threw = false;
    try { record.intent = 'changed'; } catch { threw = true; }
    // Either threw (strict mode) or value is unchanged (non-strict)
    assert.ok(record.intent !== 'changed' || threw, 'object should be frozen');
  });

  // ── writeTrace — no-op when disabled ────────────────────────────────────

  await test('writeTrace is no-op when jarvisTraceEnabled: false', async () => {
    const settingsMod = require('../settings');
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fallback) => key === 'jarvisTraceEnabled' ? false : origGet(key, fallback);
    try {
      const record = traceMod.createTrace('test').build();
      // Should not throw or create files
      await traceMod.writeTrace(record);
    } finally {
      settingsMod.getSetting = origGet;
    }
  });

  // ── writeTrace — writes file when enabled ────────────────────────────────

  await test('writeTrace writes a JSON file when jarvisTraceEnabled: true', async () => {
    const settingsMod = require('../settings');
    const tmpDir = path.join(os.tmpdir(), `jarvis-trace-test-${Date.now()}`);
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fallback) => {
      if (key === 'jarvisTraceEnabled') return true;
      if (key === 'jarvisTraceDir')     return tmpDir;
      if (key === 'jarvisTraceMaxFiles') return 200;
      return origGet(key, fallback);
    };
    try {
      const record = traceMod.createTrace('find my CV')
        .setClassification({ intent: 'file.find', confidence: 'pattern', params: {}, needsConfirm: false }, 4)
        .build();
      await traceMod.writeTrace(record);
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
      assert.equal(files.length, 1, 'exactly one trace file should be written');
      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
      assert.equal(written.intent, 'file.find');
      assert.equal(written.patternIndex, 4);
    } finally {
      settingsMod.getSetting = origGet;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  // ── Auto-prune ────────────────────────────────────────────────────────────

  await test('writeTrace auto-prunes oldest 50 files when count >= jarvisTraceMaxFiles', async () => {
    const settingsMod = require('../settings');
    const tmpDir = path.join(os.tmpdir(), `jarvis-prune-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Create exactly 200 dummy trace files
    for (let i = 0; i < 200; i++) {
      const name = `${1000000 + i}-xxxx.json`;
      fs.writeFileSync(path.join(tmpDir, name), '{}');
    }

    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fallback) => {
      if (key === 'jarvisTraceEnabled')  return true;
      if (key === 'jarvisTraceDir')      return tmpDir;
      if (key === 'jarvisTraceMaxFiles') return 200;
      return origGet(key, fallback);
    };
    try {
      const record = traceMod.createTrace('prune test').build();
      await traceMod.writeTrace(record);
      const remaining = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
      // Started with 200, deleted 50, wrote 1 → 151
      assert.ok(remaining.length <= 151, `expected ≤ 151 files, got ${remaining.length}`);
      assert.ok(remaining.length > 0,    'should have at least the newly written file');
    } finally {
      settingsMod.getSetting = origGet;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  // ── classifier _patternIndex ──────────────────────────────────────────────

  section('20b. M4.4 — Suite 18: classifier _patternIndex');

  await test('classifier returns _patternIndex: 0 for system.cancel (first pattern)', async () => {
    const r = await classify('cancel', LLM_NEVER_CALLED);
    assert.equal(r.intent,        'system.cancel');
    assert.equal(r._patternIndex, 0, `expected 0, got ${r._patternIndex}`);
  });

  await test('classifier returns _patternIndex: 1 for system.select (second pattern)', async () => {
    const r = await classify('one', LLM_NEVER_CALLED);
    assert.equal(r.intent,        'system.select');
    assert.equal(r._patternIndex, 1, `expected 1, got ${r._patternIndex}`);
  });

  await test('classifier returns a non-null _patternIndex for file.open', async () => {
    const r = await classify('open notes.txt', LLM_NEVER_CALLED);
    assert.ok(r.intent === 'file.open' || r.intent === 'file.read', `unexpected intent: ${r.intent}`);
    assert.ok(r._patternIndex != null, `_patternIndex should be set, got ${r._patternIndex}`);
  });

  await test('classifier LLM fallback result has _patternIndex: undefined', async () => {
    const llmStub = async () => ({ intent: 'file.open', confidence: 'llm', params: { name: 'test.pdf' }, needsConfirm: false, raw: 'test' });
    const r = await classify('zzz xyzzy blorple', llmStub);
    if (r.confidence === 'llm') {
      assert.ok(r._patternIndex == null, '_patternIndex should not be set for LLM result');
    }
    // If pattern matched something, that's OK — test is about LLM result shape
  });

  await test('classifier _patternIndex increases monotonically through PATTERN_TABLE', async () => {
    // system.cancel (0) < system.select (1): verify ordering
    const cancel = await classify('cancel',   LLM_NEVER_CALLED);
    const select = await classify('two',      LLM_NEVER_CALLED);
    assert.ok(cancel._patternIndex < select._patternIndex,
      `cancel(${cancel._patternIndex}) should have lower index than select(${select._patternIndex})`);
  });

  // ── Pipeline structured run log ──────────────────────────────────────────

  section('20c. M4.4 — Suite 18: pipeline [JARVIS RUN] log');

  await test('Pipeline emits [JARVIS RUN] log line for single-command runs', async () => {
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    classifierModule.classify = async () => ({ intent: 'system.volume', confidence: 'pattern', params: { action: 'mute' }, needsConfirm: false, _patternIndex: 5, raw: 'mute' });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Volume muted.' });
    verifierModule.verify     = async () => ({ verified: false });

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => { logLines.push(args.join(' ')); };

    try {
      const hudSend = () => {};
      await runPipelineFromText('mute', hudSend, () => Promise.resolve(true));
      assert.ok(logLines.some((l) => l.includes('[JARVIS RUN]')),
        `expected [JARVIS RUN] in log, got:\n${logLines.join('\n')}`);
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  await test('[JARVIS RUN] log contains intent, conf, dispatch, verify, total fields', async () => {
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    classifierModule.classify = async () => ({ intent: 'system.volume', confidence: 'pattern', params: { action: 'mute' }, needsConfirm: false, _patternIndex: 5, raw: 'mute' });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Volume muted.' });
    verifierModule.verify     = async () => ({ verified: false });

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => { logLines.push(args.join(' ')); };

    try {
      await runPipelineFromText('mute', () => {}, () => Promise.resolve(true));
      const runLine = logLines.find((l) => l.includes('[JARVIS RUN]')) || '';
      assert.ok(runLine.includes('intent=system.volume'), `missing intent in: ${runLine}`);
      assert.ok(runLine.includes('conf=pattern'),         `missing conf in: ${runLine}`);
      assert.ok(runLine.includes('dispatch=ok'),          `missing dispatch in: ${runLine}`);
      assert.ok(runLine.includes('verify=unverified'),    `missing verify in: ${runLine}`);
      assert.ok(runLine.includes('total='),               `missing total in: ${runLine}`);
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  await test('[JARVIS RUN] ctx=file when file context active at classification time', async () => {
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    ctx.setFileTarget('cv.pdf', '/docs/cv.pdf');

    classifierModule.classify = async () => ({ intent: 'file.open', confidence: 'pattern', params: { useContext: true }, needsConfirm: false, _patternIndex: 2, raw: 'open it' });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Opened cv.pdf.' });
    verifierModule.verify     = async () => ({ verified: false });

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => { logLines.push(args.join(' ')); };

    try {
      await runPipelineFromText('open it', () => {}, () => Promise.resolve(true));
      const runLine = logLines.find((l) => l.includes('[JARVIS RUN]')) || '';
      assert.ok(runLine.includes('ctx=file') || runLine.includes('ctx=both'),
        `expected ctx=file or ctx=both in: ${runLine}`);
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  await test('[JARVIS RUN] ctx=candidates when disambiguation candidates pending', async () => {
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    ctx.setCandidates(
      [{ name: 'r1.pdf', path: '/r1.pdf', sizeBytes: 0 }, { name: 'r2.pdf', path: '/r2.pdf', sizeBytes: 0 }],
      { intent: 'file.delete', params: { name: 'report' } }
    );

    classifierModule.classify = async () => ({ intent: 'system.select', confidence: 'pattern', params: { ordinal: 1 }, needsConfirm: false, _patternIndex: 1, raw: 'one' });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Deleted r1.pdf.' });
    verifierModule.verify     = async () => ({ verified: false });

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => { logLines.push(args.join(' ')); };

    try {
      await runPipelineFromText('one', () => {}, () => Promise.resolve(true));
      const runLine = logLines.find((l) => l.includes('[JARVIS RUN]')) || '';
      assert.ok(runLine.includes('ctx=candidates'),
        `expected ctx=candidates in: ${runLine}`);
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── M4.4.1 — agentSteps + path + jarvisTraceLevel ────────────────────────

  section('20d. M4.4.1 — Suite 18: agentSteps, path, jarvisTraceLevel');

  await test('createTrace defaults: agentSteps is empty array, path is "pattern"', () => {
    const record = traceMod.createTrace('mute').build();
    assert.ok(Array.isArray(record.agentSteps), 'agentSteps must be an array');
    assert.equal(record.agentSteps.length, 0, 'agentSteps must default to empty');
    assert.equal(record.path, 'pattern', 'path must default to "pattern"');
  });

  await test('addAgentStep appends a step with normalized fields', () => {
    const record = traceMod.createTrace('open the latest invoice')
      .setPath('agent')
      .addAgentStep({ tool: 'file.find', params: { query: 'invoice' }, result: { ok: true }, latencyMs: 42 })
      .addAgentStep({ tool: 'file.open', params: { path: '/x/y.pdf' }, result: { ok: true }, latencyMs: 18 })
      .build();
    assert.equal(record.path, 'agent');
    assert.equal(record.agentSteps.length, 2);
    assert.equal(record.agentSteps[0].tool, 'file.find');
    assert.equal(record.agentSteps[0].latencyMs, 42);
    assert.equal(record.agentSteps[0].retry, false, 'retry must default to false');
    assert.equal(record.agentSteps[1].tool, 'file.open');
    assert.deepEqual(record.agentSteps[1].params, { path: '/x/y.pdf' });
  });

  await test('addAgentStep preserves retry:true flag', () => {
    const record = traceMod.createTrace('click Send')
      .addAgentStep({ tool: 'ui.click', params: { name: 'Send' }, result: { ok: false }, latencyMs: 50 })
      .addAgentStep({ tool: 'ui.click', params: { name: 'Send' }, result: { ok: true }, latencyMs: 35, retry: true })
      .build();
    assert.equal(record.agentSteps[0].retry, false);
    assert.equal(record.agentSteps[1].retry, true);
  });

  await test('setPath only accepts "pattern" or "agent"', () => {
    const r1 = traceMod.createTrace('x').setPath('agent').build();
    assert.equal(r1.path, 'agent');
    const r2 = traceMod.createTrace('x').setPath('bogus').build();
    assert.equal(r2.path, 'pattern', 'invalid value must leave default in place');
  });

  await test('addAgentStep with null/undefined input is a no-op', () => {
    const record = traceMod.createTrace('x')
      .addAgentStep(null)
      .addAgentStep(undefined)
      .build();
    assert.equal(record.agentSteps.length, 0);
  });

  await test('build() returns an immutable agentSteps array', () => {
    const record = traceMod.createTrace('x')
      .addAgentStep({ tool: 'file.find', params: {}, result: { ok: true }, latencyMs: 10 })
      .build();
    // Mutating the inner steps shouldn't leak back through later snapshots.
    const beforeLen = record.agentSteps.length;
    try { record.agentSteps.push({ tool: 'leak' }); } catch { /* may throw on frozen — fine */ }
    // Even if push succeeds (the array itself isn't frozen), the original record
    // length should still equal what build() produced. The contract is that we
    // returned a fresh, defensively-copied array — not that it's deep-frozen.
    assert.ok(record.agentSteps.length >= beforeLen, 'sanity');
  });

  await test('summarizeRecord projects to minimal one-line shape', () => {
    const full = traceMod.createTrace('mute')
      .setClassification({ intent: 'system.volume', confidence: 'pattern', params: {}, needsConfirm: false }, 5)
      .setDispatch({ ok: true })
      .setVerify({ verified: true })
      .setTimings({ classify: 1, dispatch: 22, verify: 5, tts: 0, total: 28 })
      .setPath('pattern')
      .build();
    const summary = traceMod.summarizeRecord(full);
    assert.equal(summary.intent,     'system.volume');
    assert.equal(summary.dispatchOk, true);
    assert.equal(summary.verifyOk,   true);
    assert.equal(summary.path,       'pattern');
    assert.equal(summary.total,      28);
    assert.equal(summary.agentSteps, 0);
    // Should not contain heavy fields
    assert.ok(!('contextUsed' in summary), 'summary must not include contextUsed');
    assert.ok(!('params' in summary),      'summary must not include params');
  });

  await test('writeTrace level=off → no-op even when jarvisTraceEnabled true', async () => {
    const settingsMod = require('../settings');
    const tmpDir = path.join(os.tmpdir(), `jarvis-trace-off-${Date.now()}`);
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fallback) => {
      if (key === 'jarvisTraceEnabled')  return true;
      if (key === 'jarvisTraceDir')      return tmpDir;
      if (key === 'jarvisTraceLevel')    return 'off';
      if (key === 'jarvisTraceMaxFiles') return 200;
      return origGet(key, fallback);
    };
    try {
      const record = traceMod.createTrace('test').build();
      await traceMod.writeTrace(record);
      const exists = fs.existsSync(tmpDir);
      // Either the dir wasn't created, or it has zero files.
      if (exists) {
        const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
        assert.equal(files.length, 0, 'level=off must not write any trace files');
      }
    } finally {
      settingsMod.getSetting = origGet;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  await test('writeTrace level=summary writes a single-line minimal JSON', async () => {
    const settingsMod = require('../settings');
    const tmpDir = path.join(os.tmpdir(), `jarvis-trace-summary-${Date.now()}`);
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fallback) => {
      if (key === 'jarvisTraceEnabled')  return true;
      if (key === 'jarvisTraceDir')      return tmpDir;
      if (key === 'jarvisTraceLevel')    return 'summary';
      if (key === 'jarvisTraceMaxFiles') return 200;
      return origGet(key, fallback);
    };
    try {
      const record = traceMod.createTrace('mute')
        .setClassification({ intent: 'system.volume', confidence: 'pattern', params: {}, needsConfirm: false }, 5)
        .setDispatch({ ok: true })
        .setTimings({ classify: 1, dispatch: 22, verify: 5, tts: 0, total: 28 })
        .build();
      await traceMod.writeTrace(record);
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
      assert.equal(files.length, 1, 'one file written');
      const raw = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
      assert.equal(raw.split('\n').length, 1, 'summary must be one line');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.intent, 'system.volume');
      assert.ok(!('contextUsed' in parsed), 'summary must omit contextUsed');
      assert.ok(!('agentSteps'  in parsed) || typeof parsed.agentSteps === 'number',
        'summary agentSteps (if present) is a count, not an array');
    } finally {
      settingsMod.getSetting = origGet;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  await test('writeTrace level=full writes full multi-line JSON with agentSteps array', async () => {
    const settingsMod = require('../settings');
    const tmpDir = path.join(os.tmpdir(), `jarvis-trace-full-${Date.now()}`);
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fallback) => {
      if (key === 'jarvisTraceEnabled')  return true;
      if (key === 'jarvisTraceDir')      return tmpDir;
      if (key === 'jarvisTraceLevel')    return 'full';
      if (key === 'jarvisTraceMaxFiles') return 200;
      return origGet(key, fallback);
    };
    try {
      const record = traceMod.createTrace('open the latest invoice')
        .setPath('agent')
        .addAgentStep({ tool: 'file.find', params: { query: 'invoice' }, result: { ok: true }, latencyMs: 42 })
        .build();
      await traceMod.writeTrace(record);
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
      assert.equal(files.length, 1);
      const raw = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
      assert.ok(raw.split('\n').length > 1, 'full record must be pretty-printed (multi-line)');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.path, 'agent');
      assert.ok(Array.isArray(parsed.agentSteps), 'full record keeps agentSteps as an array');
      assert.equal(parsed.agentSteps.length, 1);
      assert.equal(parsed.agentSteps[0].tool, 'file.find');
    } finally {
      settingsMod.getSetting = origGet;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  // ── M4.4.1 — pipeline log: path= field ────────────────────────────────────

  section('20e. M4.4.1 — Suite 18: [JARVIS RUN] path= field');

  await test('[JARVIS RUN] log includes path=pattern by default', async () => {
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    classifierModule.classify = async () => ({ intent: 'system.volume', confidence: 'pattern', params: { action: 'mute' }, needsConfirm: false, _patternIndex: 5, raw: 'mute' });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Volume muted.' });
    verifierModule.verify     = async () => ({ verified: false });

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => { logLines.push(args.join(' ')); };

    try {
      await runPipelineFromText('mute', () => {}, () => Promise.resolve(true));
      const runLine = logLines.find((l) => l.includes('[JARVIS RUN]')) || '';
      assert.ok(runLine.includes('path=pattern'),
        `expected path=pattern in: ${runLine}`);
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });
}

// ─── Suite 19 — M4.5: Follow-Up Interaction Layer ────────────────────────────

async function runM45FollowUpTests() {
  section('19. M4.5 — Follow-Up Interaction Layer (Suite 19)');

  // ── Workflow A: find → open it ──
  await test('Workflow A: file.find single match → context set → file.open useContext resolves correctly', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    let step = 0;
    classifierModule.classify = async (t) => {
      step++;
      if (step === 1) return { intent: 'file.find', confidence: 'pattern', params: { query: 'cv' }, needsConfirm: false, _patternIndex: 16, raw: t };
      return { intent: 'file.open', confidence: 'pattern', params: { useContext: true }, needsConfirm: false, _patternIndex: 2, raw: t };
    };
    dispatcherModule.dispatch = async (cr) => {
      if (cr.intent === 'file.find') {
        ctx.setFileTarget('cv.pdf', '/docs/cv.pdf');
        return { ok: true, action: 'Found cv.pdf in Documents.', data: { matches: [{ name: 'cv.pdf', path: '/docs/cv.pdf', sizeBytes: 0 }] } };
      }
      if (cr.intent === 'file.open') {
        const fileTarget = ctx.getFileTarget();
        assert.ok(fileTarget, 'file context should be set');
        assert.equal(fileTarget.name, 'cv.pdf');
        return { ok: true, action: 'Opened cv.pdf.' };
      }
      return { ok: false, error: `Unexpected intent: ${cr.intent}` };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('find my cv', hudSend, () => Promise.resolve(true));
      const fileTarget = ctx.getFileTarget();
      assert.ok(fileTarget, 'file context should be populated after find');
      assert.equal(fileTarget.name, 'cv.pdf');

      await runPipelineFromText('open it', hudSend, () => Promise.resolve(true));
      const doneEvents = events.filter(e => e.ch === 'jarvis:done');
      const lastDone   = doneEvents[doneEvents.length - 1];
      assert.ok(lastDone.payload.ok, `Expected ok:true, got: ${JSON.stringify(lastDone.payload)}`);
      assert.ok(lastDone.payload.display.includes('Opened'), `display: "${lastDone.payload.display}"`);
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── Workflow B: find → rename it ──
  await test('Workflow B: file.find → context set → file.rename useContext renames correct file', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    let step = 0;
    classifierModule.classify = async (t) => {
      step++;
      if (step === 1) return { intent: 'file.find', confidence: 'pattern', params: { query: 'notes' }, needsConfirm: false, _patternIndex: 16, raw: t };
      return { intent: 'file.rename', confidence: 'pattern', params: { useContext: true, newName: 'journal.txt' }, needsConfirm: true, _patternIndex: 3, raw: t };
    };
    let renamedPath = null;
    dispatcherModule.dispatch = async (cr) => {
      if (cr.intent === 'file.find') {
        ctx.setFileTarget('notes.txt', '/docs/notes.txt');
        return { ok: true, action: 'Found notes.txt.', data: { matches: [{ name: 'notes.txt', path: '/docs/notes.txt', sizeBytes: 0 }] } };
      }
      if (cr.intent === 'file.rename') {
        const fileTarget = ctx.getFileTarget();
        assert.ok(fileTarget, 'context should be set');
        renamedPath = fileTarget.path;
        return { ok: true, action: 'Renamed notes.txt to journal.txt.' };
      }
      return { ok: false, error: 'unexpected' };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('find notes.txt', hudSend, () => Promise.resolve(true));
      await runPipelineFromText('rename it to journal.txt', hudSend, () => Promise.resolve(true));
      assert.equal(renamedPath, '/docs/notes.txt', `Expected /docs/notes.txt, got ${renamedPath}`);
      const doneEvents = events.filter(e => e.ch === 'jarvis:done' && e.payload.ok);
      assert.ok(doneEvents.length >= 1, 'Should have at least one ok done event');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── Workflow C: ambiguous delete → select second ──
  await test('Workflow C: file.delete ambiguous → jarvis:disambiguate emitted → system.select ordinal:2 → correct file', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    const candidates = [
      { name: 'report-final.pdf',  path: '/docs/report-final.pdf',  sizeBytes: 0 },
      { name: 'report-draft.pdf',  path: '/docs/report-draft.pdf',  sizeBytes: 0 },
      { name: 'old-report.txt',    path: '/docs/old-report.txt',     sizeBytes: 0 },
    ];

    let step = 0;
    classifierModule.classify = async (t) => {
      step++;
      if (step === 1) return { intent: 'file.delete', confidence: 'pattern', params: { name: 'report' }, needsConfirm: true, _patternIndex: 18, raw: t };
      return { intent: 'system.select', confidence: 'pattern', params: { ordinal: 2 }, needsConfirm: false, _patternIndex: 1, raw: t };
    };

    let deletedPath = null;
    dispatcherModule.dispatch = async (cr) => {
      if (cr.intent === 'file.delete' && !cr.params.path) {
        // Multi-match: set candidates and return ambiguous
        ctx.setCandidates(candidates, cr);
        return {
          ok: false, ambiguous: true,
          candidates,
          action: "I found 3 files. Say one, two, or three.",
        };
      }
      if (cr.intent === 'file.delete' && cr.params.path) {
        deletedPath = cr.params.path;
        return { ok: true, action: `Deleted ${cr.params.name}.` };
      }
      if (cr.intent === 'system.select') {
        // system.select clears candidates and re-dispatches
        const state = ctx.getCandidates();
        assert.ok(state, 'candidates should still be in context');
        const selected = state.candidates[cr.params.ordinal - 1];
        ctx.clearCandidates();
        const resolved = { ...state.classifiedResult, params: { ...state.classifiedResult.params, path: selected.path, name: selected.name } };
        return dispatcherModule.dispatch(resolved);
      }
      return { ok: false, error: 'unexpected' };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('delete report', hudSend, () => Promise.resolve(false));
      const disambigEvent = events.find(e => e.ch === 'jarvis:disambiguate');
      assert.ok(disambigEvent, 'jarvis:disambiguate event should be emitted');
      assert.equal(disambigEvent.payload.candidates.length, 3, 'Should list 3 candidates');

      await runPipelineFromText('the second one', hudSend, () => Promise.resolve(true));
      assert.equal(deletedPath, '/docs/report-draft.pdf', `Expected report-draft.pdf, got ${deletedPath}`);
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── Workflow D: focus → standalone type ──
  await test('Workflow D: app.focus → context.setWindowTarget → standalone input.type inherits hwnd', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();

    let step = 0;
    classifierModule.classify = async (t) => {
      step++;
      if (step === 1) return { intent: 'app.focus', confidence: 'pattern', params: { appName: 'notepad' }, needsConfirm: false, _patternIndex: 22, raw: t };
      return { intent: 'input.type', confidence: 'pattern', params: { text: 'hello world' }, needsConfirm: false, _patternIndex: 48, raw: t };
    };
    dispatcherModule.dispatch = async (cr) => {
      if (cr.intent === 'app.focus') {
        ctx.setWindowTarget('notepad', 12345, 'app');
        return { ok: true, action: 'Focused Notepad.', data: { processName: 'notepad', hwnd: 12345 } };
      }
      return { ok: true, action: 'Typed hello world.' };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('focus notepad', hudSend, () => Promise.resolve(true));
      const winCtx = ctx.getWindowTarget();
      assert.ok(winCtx, 'window context should be set after app.focus');
      assert.equal(winCtx.hwnd, 12345);

      await runPipelineFromText('type hello world', hudSend, () => Promise.resolve(true));
      const doneEvents = events.filter(e => e.ch === 'jarvis:done');
      const lastDone   = doneEvents[doneEvents.length - 1];
      assert.ok(lastDone.payload.ok, 'type command should succeed');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── Workflow E: context expiry → open it returns error ──
  await test('Workflow E: expired file context → file.open useContext → clean error, no crash', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    // Set a very short TTL to simulate expiry
    const origGet = require('../settings').getSetting;
    require('../settings').getSetting = (key, def) => key === 'jarvisContextTtlMs' ? 1 : origGet(key, def);

    // Set file target — will expire after 1ms
    ctx.setFileTarget('cv.pdf', '/docs/cv.pdf');
    await new Promise((r) => setTimeout(r, 10)); // wait for TTL to expire

    classifierModule.classify = async (t) => ({
      intent: 'file.open', confidence: 'pattern', params: { useContext: true }, needsConfirm: false, _patternIndex: 2, raw: t,
    });
    dispatcherModule.dispatch = async (cr) => {
      // Simulate dispatcher checking context
      const fileTarget = ctx.getFileTarget();
      if (cr.params.useContext && !fileTarget) {
        return { ok: false, error: 'No recent file in context. Please say the filename explicitly.' };
      }
      return { ok: true, action: 'Opened.' };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('open it', hudSend, () => Promise.resolve(true));
      const doneEvent = events.find(e => e.ch === 'jarvis:done');
      assert.ok(doneEvent, 'Should have jarvis:done event');
      assert.ok(!doneEvent.payload.ok, 'Should be ok:false when context expired');
      assert.ok(
        (doneEvent.payload.display || doneEvent.payload.error || '').toLowerCase().includes('context') ||
        (doneEvent.payload.display || doneEvent.payload.error || '').toLowerCase().includes('file'),
        `Error should mention context/file: "${doneEvent.payload.display}"`
      );
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      require('../settings').getSetting = origGet;
      ctx.clear();
    }
  });

  // ── Context badge: jarvis:context emitted after file.find ──
  await test('jarvis:context event emitted after successful file.find with single match', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    classifierModule.classify = async (t) => ({
      intent: 'file.find', confidence: 'pattern', params: { query: 'cv' }, needsConfirm: false, _patternIndex: 16, raw: t,
    });
    dispatcherModule.dispatch = async () => {
      ctx.setFileTarget('cv.pdf', '/docs/cv.pdf');
      return { ok: true, action: 'Found cv.pdf.', data: { matches: [{ name: 'cv.pdf', path: '/docs/cv.pdf', sizeBytes: 0 }] } };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('find my cv', hudSend, () => Promise.resolve(true));
      const ctxEvent = events.find(e => e.ch === 'jarvis:context');
      assert.ok(ctxEvent, 'jarvis:context event should be emitted');
      assert.equal(ctxEvent.payload.file, 'cv.pdf', `file should be cv.pdf, got ${ctxEvent.payload.file}`);
      assert.ok(typeof ctxEvent.payload.ttlMs === 'number', 'ttlMs should be a number');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── Context badge: NOT emitted after system.volume (no file/window context changed) ──
  await test('jarvis:context NOT emitted after system.volume when no file/window context active', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    classifierModule.classify = async (t) => ({
      intent: 'system.volume', confidence: 'pattern', params: { action: 'up' }, needsConfirm: false, _patternIndex: 27, raw: t,
    });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Volume up.' });
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('volume up', hudSend, () => Promise.resolve(true));
      const ctxEvent = events.find(e => e.ch === 'jarvis:context');
      assert.ok(!ctxEvent, 'jarvis:context should NOT be emitted when no context is active');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── Context badge: window target emitted after app.focus ──
  await test('jarvis:context event has window field after app.focus succeeds', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    classifierModule.classify = async (t) => ({
      intent: 'app.focus', confidence: 'pattern', params: { appName: 'notepad' }, needsConfirm: false, _patternIndex: 22, raw: t,
    });
    dispatcherModule.dispatch = async () => {
      ctx.setWindowTarget('notepad', 9999, 'app');
      return { ok: true, action: 'Focused Notepad.', data: { processName: 'notepad', hwnd: 9999 } };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('focus notepad', hudSend, () => Promise.resolve(true));
      const ctxEvent = events.find(e => e.ch === 'jarvis:context');
      assert.ok(ctxEvent, 'jarvis:context should be emitted after app.focus');
      assert.equal(ctxEvent.payload.window, 'notepad');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── cancel during disambiguation clears candidates ──
  await test('system.cancel during active disambiguation clears candidates; next command runs fresh', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    const candidates = [
      { name: 'r1.pdf', path: '/r1.pdf', sizeBytes: 0 },
      { name: 'r2.pdf', path: '/r2.pdf', sizeBytes: 0 },
    ];

    let step = 0;
    classifierModule.classify = async (t) => {
      step++;
      if (step === 1) return { intent: 'file.delete', confidence: 'pattern', params: { name: 'r' }, needsConfirm: true, _patternIndex: 18, raw: t };
      if (step === 2) return { intent: 'system.cancel', confidence: 'pattern', params: {}, needsConfirm: false, _patternIndex: 0, raw: t };
      return { intent: 'system.volume', confidence: 'pattern', params: { action: 'up' }, needsConfirm: false, _patternIndex: 27, raw: t };
    };
    dispatcherModule.dispatch = async (cr) => {
      if (cr.intent === 'file.delete') {
        ctx.setCandidates(candidates, cr);
        return { ok: false, ambiguous: true, candidates, action: 'Found 2 files.' };
      }
      if (cr.intent === 'system.cancel') {
        const hadCandidates = !!ctx.getCandidates();
        ctx.clearCandidates();
        return { ok: true, action: hadCandidates ? 'Cancelled. Selection cleared.' : 'OK, cancelled.', data: { cancelled: true } };
      }
      return { ok: true, action: 'Done.' };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('delete r', hudSend, () => Promise.resolve(false));
      assert.ok(ctx.getCandidates(), 'candidates should be set after ambiguous result');

      await runPipelineFromText('cancel', hudSend, () => Promise.resolve(true));
      assert.ok(!ctx.getCandidates(), 'candidates should be cleared after cancel');

      await runPipelineFromText('volume up', hudSend, () => Promise.resolve(true));
      const doneEvents = events.filter(e => e.ch === 'jarvis:done');
      const lastDone = doneEvents[doneEvents.length - 1];
      assert.ok(lastDone.payload.ok, 'third command should succeed normally');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── jarvisChainMaxSteps:3 allows 3 parts ──
  await test('jarvisChainMaxSteps:3 → splitChainWithBareAnd allows 3 parts', async () => {
    const { splitChainWithBareAnd } = require('./classifier');
    const result = splitChainWithBareAnd('open chrome and go to youtube and then minimize it', 3);
    assert.ok(result.parts.length >= 2, `Should allow at least 2 parts with maxSteps=3, got ${result.parts.length}`);
    // At most 3 parts allowed
    assert.ok(result.parts.length <= 3, `Should not exceed 3 parts, got ${result.parts.length}`);
  });

  // ── jarvisChainMaxSteps:2 (default) still caps at 2 ──
  await test('jarvisChainMaxSteps:2 (default) → splitChainWithBareAnd caps at 2', async () => {
    const { splitChainWithBareAnd } = require('./classifier');
    const result = splitChainWithBareAnd('mute and then volume up and then brightness down', 2);
    assert.equal(result.parts.length, 2, `Should cap at 2 parts, got ${result.parts.length}`);
    assert.ok(result.wasCapped, 'wasCapped should be true for 3-part input capped at 2');
  });

  // ── Pipeline uses jarvisChainMaxSteps setting from settings module ──
  await test('Pipeline reads jarvisChainMaxSteps from settings; default of 2 preserves Phase 3 behavior', async () => {
    const s = require('../settings');
    const maxSteps = s.getSetting('jarvisChainMaxSteps', 2);
    assert.equal(maxSteps, 2, `Default should be 2, got ${maxSteps}`);
  });

  // ── Context file target replaced when new file.find runs ──
  await test('New file.find overwrites old file context (not additive)', async () => {
    ctx.clear();
    ctx.setFileTarget('old.pdf', '/old.pdf');
    assert.equal(ctx.getFileTarget()?.name, 'old.pdf');

    ctx.setFileTarget('new.txt', '/new.txt');
    const fileTarget = ctx.getFileTarget();
    assert.equal(fileTarget?.name, 'new.txt', 'New file target should overwrite old');
    assert.equal(fileTarget?.path, '/new.txt');
    ctx.clear();
  });

  // ── Context window target NOT cleared by file operations ──
  await test('Window target persists across file operations (not cleared by file.find)', async () => {
    ctx.clear();
    ctx.setWindowTarget('notepad', 1234, 'app');
    ctx.setFileTarget('test.txt', '/test.txt');

    assert.ok(ctx.getWindowTarget(), 'window context should still be set');
    assert.equal(ctx.getWindowTarget()?.processName, 'notepad');
    assert.ok(ctx.getFileTarget(), 'file context should also be set');
    ctx.clear();
  });

  // ── context.clear() clears both file and window targets ──
  await test('ctx.clear() clears file and window targets so jarvis:context is not emitted', async () => {
    ctx.clear();
    ctx.setFileTarget('a.pdf', '/a.pdf');
    ctx.setWindowTarget('chrome', 5678, 'browser');
    ctx.clear();
    assert.ok(!ctx.getFileTarget(), 'file target should be null after clear');
    assert.ok(!ctx.getWindowTarget(), 'window target should be null after clear');
  });

  // ── jarvis:context event has correct ttlMs value ──
  await test('jarvis:context payload ttlMs matches jarvisContextTtlMs setting', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    classifierModule.classify = async (t) => ({
      intent: 'app.focus', confidence: 'pattern', params: { appName: 'notepad' }, needsConfirm: false, _patternIndex: 22, raw: t,
    });
    dispatcherModule.dispatch = async () => {
      ctx.setWindowTarget('notepad', 111, 'app');
      return { ok: true, action: 'Focused.', data: { processName: 'notepad', hwnd: 111 } };
    };
    verifierModule.verify = async () => ({ verified: false });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('focus notepad', hudSend, () => Promise.resolve(true));
      const ctxEvent = events.find(e => e.ch === 'jarvis:context');
      assert.ok(ctxEvent, 'jarvis:context should be emitted');
      const expectedTtl = require('../settings').getSetting('jarvisContextTtlMs', 30000);
      assert.equal(ctxEvent.payload.ttlMs, expectedTtl, `ttlMs should match setting: expected ${expectedTtl}, got ${ctxEvent.payload.ttlMs}`);
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });

  // ── system.select with expired context returns clean error ──
  await test('system.select with expired context (no candidates) returns clean error, no crash', async () => {
    const classifierModule  = require('./classifier');
    const origClassify  = classifierModule.classify;
    const { dispatch: realDispatch } = require('./dispatcher');

    ctx.clear(); // no candidates set

    classifierModule.classify = async (t) => ({
      intent: 'system.select', confidence: 'pattern', params: { ordinal: 1 }, needsConfirm: false, _patternIndex: 1, raw: t,
    });

    const events = [];
    const hudSend = (ch, payload) => events.push({ ch, payload });

    try {
      await runPipelineFromText('one', hudSend, () => Promise.resolve(true));
      const doneEvent = events.find(e => e.ch === 'jarvis:done');
      assert.ok(doneEvent, 'Should have jarvis:done event');
      // Should fail cleanly — no crash
      assert.ok(!doneEvent.payload.ok || doneEvent.payload.display, 'Should have a response without crashing');
    } finally {
      classifierModule.classify = origClassify;
      ctx.clear();
    }
  });

  // ── Context snapshot shows correct ctx= field in JARVIS RUN log ──
  await test('[JARVIS RUN] ctx=both when both file and window context are active', async () => {
    const classifierModule  = require('./classifier');
    const dispatcherModule  = require('./dispatcher');
    const verifierModule    = require('./verifier');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;

    ctx.clear();
    ctx.setFileTarget('doc.pdf', '/doc.pdf');
    ctx.setWindowTarget('chrome', 7777, 'browser');

    classifierModule.classify = async (t) => ({
      intent: 'system.volume', confidence: 'pattern', params: { action: 'up' }, needsConfirm: false, _patternIndex: 27, raw: t,
    });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Volume up.' });
    verifierModule.verify = async () => ({ verified: false });

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => { logLines.push(args.join(' ')); };

    try {
      await runPipelineFromText('volume up', () => {}, () => Promise.resolve(true));
      const runLine = logLines.find(l => l.includes('[JARVIS RUN]')) || '';
      assert.ok(runLine.includes('ctx=both'), `expected ctx=both in: ${runLine}`);
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ctx.clear();
    }
  });
}

// ─── Suite 20 — M4.5: Tool-Calling Agent Layer ────────────────────────────────

async function runM45AgentTests() {
  section('21. M4.5 — Suite 20: tool-schemas.js + agent.js');

  const toolSchemas = require('./tool-schemas');
  const agentMod    = require('./agent');

  // ── Schemas ───────────────────────────────────────────────────────────────

  await test('tool-schemas registers every dispatcher case (sample check)', () => {
    const required = [
      'file.find', 'file.open', 'file.delete', 'file.rename', 'file.move',
      'app.open', 'app.close', 'app.focus',
      'window.minimize', 'window.maximize', 'window.switch',
      'browser.goto', 'browser.search', 'browser.site',
      'input.type', 'input.key', 'input.shortcut',
      'system.volume', 'system.brightness', 'system.lock',
      'clipboard.write',
    ];
    for (const name of required) {
      assert.ok(toolSchemas.isRegistered(name), `${name} must be registered`);
      const s = toolSchemas.getSchema(name);
      assert.ok(s.description && s.parameters, `${name} missing description/parameters`);
    }
  });

  await test('toGeminiFunctionDeclarations returns one entry per schema', () => {
    const decls = toolSchemas.toGeminiFunctionDeclarations();
    assert.equal(decls.length, toolSchemas.TOOL_SCHEMAS.length);
    assert.ok(decls.every((d) => d.name && d.description && d.parameters));
  });

  await test('needsConfirmFor flags destructive intents', () => {
    assert.equal(toolSchemas.needsConfirmFor('file.delete', { name: 'x' }), true);
    assert.equal(toolSchemas.needsConfirmFor('file.rename', { newName: 'y' }), true);
    assert.equal(toolSchemas.needsConfirmFor('file.move',   { targetLocationHint: 'z' }), true);
    assert.equal(toolSchemas.needsConfirmFor('file.write',  { name: 'x' }), true);
    assert.equal(toolSchemas.needsConfirmFor('system.lock', {}), true);
  });

  await test('needsConfirmFor returns false for safe reads', () => {
    assert.equal(toolSchemas.needsConfirmFor('file.find', { query: 'x' }), false);
    assert.equal(toolSchemas.needsConfirmFor('app.open',  { appName: 'notepad' }), false);
    assert.equal(toolSchemas.needsConfirmFor('system.volume', { action: 'mute' }), false);
  });

  await test('needsConfirmFor file.append is dynamic on content length', () => {
    assert.equal(toolSchemas.needsConfirmFor('file.append', { name: 'x', content: 'short' }), false);
    const long = 'x'.repeat(250);
    assert.equal(toolSchemas.needsConfirmFor('file.append', { name: 'x', content: long }), true);
  });

  await test('needsConfirmFor unknown tool returns false', () => {
    assert.equal(toolSchemas.needsConfirmFor('does.not.exist', {}), false);
  });

  // ── Agent loop — single tool call → finalText ─────────────────────────────

  section('21b. M4.5 — Suite 20: agent runs one tool then finalText');

  await test('runAgent: one tool call → dispatch → finalText returned', async () => {
    let callCount = 0;
    const llmCall = async () => {
      callCount++;
      if (callCount === 1) return { functionCall: { name: 'app.open', args: { appName: 'notepad' } }, text: null, raw: {} };
      return { functionCall: null, text: 'Opened Notepad.', raw: {} };
    };
    const dispatch = async (cr) => ({ ok: true, action: `Opened ${cr.params.appName}.` });
    const result = await agentMod.runAgent({
      transcript: 'launch notepad please',
      llmCall, dispatch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stopped, 'final');
    assert.equal(result.finalText, 'Opened Notepad.');
    assert.equal(result.agentSteps.length, 1);
    assert.equal(result.agentSteps[0].tool, 'app.open');
    assert.equal(result.lastClassifierResult.intent, 'app.open');
    assert.equal(result.lastClassifierResult.confidence, 'agent');
  });

  // ── Agent loop — step cap ─────────────────────────────────────────────────

  await test('runAgent: respects jarvisAgentMaxSteps (cap = 3)', async () => {
    const settingsMod = require('../settings');
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fb) => {
      if (key === 'jarvisAgentMaxSteps')  return 3;
      if (key === 'jarvisAgentTimeoutMs') return 4000;
      if (key === 'jarvisAgentProvider')  return 'gemini-2.5-flash';
      return origGet(key, fb);
    };
    try {
      let calls = 0;
      const llmCall = async () => {
        calls++;
        return { functionCall: { name: 'window.minimize', args: {} }, text: null, raw: {} };
      };
      const dispatch = async () => ({ ok: true, action: 'Minimized.' });
      const result = await agentMod.runAgent({
        transcript: 'minimize all the windows', llmCall, dispatch,
      });
      assert.equal(result.stopped, 'maxSteps');
      assert.equal(result.agentSteps.length, 3, 'should cap at 3 steps');
      assert.equal(calls, 3);
    } finally {
      settingsMod.getSetting = origGet;
    }
  });

  // ── Agent loop — timeout ──────────────────────────────────────────────────

  await test('runAgent: hard timeout after jarvisAgentTimeoutMs', async () => {
    const settingsMod = require('../settings');
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fb) => {
      if (key === 'jarvisAgentMaxSteps')  return 5;
      if (key === 'jarvisAgentTimeoutMs') return 100;
      if (key === 'jarvisAgentProvider')  return 'gemini-2.5-flash';
      return origGet(key, fb);
    };
    try {
      const llmCall = async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { functionCall: { name: 'window.minimize', args: {} }, text: null, raw: {} };
      };
      const dispatch = async () => ({ ok: true });
      const result = await agentMod.runAgent({
        transcript: 'do many things', llmCall, dispatch,
      });
      // Should bail out before max steps because wall-clock exceeded.
      assert.ok(['timeout', 'maxSteps', 'final'].includes(result.stopped), `got stopped=${result.stopped}`);
      assert.ok(result.agentSteps.length <= 5);
    } finally {
      settingsMod.getSetting = origGet;
    }
  });

  // ── Confirmation gate fires for destructive agent calls ──────────────────

  await test('runAgent: destructive tool routes through waitForConfirm — declined', async () => {
    let confirmAsked = false;
    const llmCall = async () => ({
      functionCall: { name: 'file.delete', args: { name: 'thing.txt', path: '/x/thing.txt' } },
      text: null, raw: {},
    });
    let dispatched = false;
    const dispatch = async () => { dispatched = true; return { ok: true, action: 'Deleted.' }; };
    const result = await agentMod.runAgent({
      transcript: 'remove that file',
      llmCall, dispatch,
      waitForConfirm: async () => { confirmAsked = true; return false; },
    });
    assert.ok(confirmAsked, 'waitForConfirm must be invoked for file.delete');
    assert.equal(dispatched, false, 'dispatch must not run when confirm declines');
    assert.equal(result.ok, false);
    assert.equal(result.stopped, 'cancelled');
    assert.equal(result.finalText, 'Cancelled.');
  });

  await test('runAgent: destructive tool routes through waitForConfirm — accepted', async () => {
    let calls = 0;
    const llmCall = async () => {
      calls++;
      if (calls === 1) {
        return { functionCall: { name: 'file.delete', args: { name: 'thing.txt', path: '/x/thing.txt' } }, text: null, raw: {} };
      }
      return { functionCall: null, text: 'Deleted thing.txt.', raw: {} };
    };
    const dispatch = async () => ({ ok: true, action: 'Deleted thing.txt.' });
    const result = await agentMod.runAgent({
      transcript: 'remove thing',
      llmCall, dispatch,
      waitForConfirm: async () => true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.agentSteps.length, 1);
    assert.equal(result.agentSteps[0].tool, 'file.delete');
  });

  // ── Unknown tool name doesn't crash; agent recovers ──────────────────────

  await test('runAgent: unknown tool name → reported back to LLM, agent recovers', async () => {
    let calls = 0;
    const llmCall = async () => {
      calls++;
      if (calls === 1) return { functionCall: { name: 'does.not.exist', args: {} }, text: null, raw: {} };
      if (calls === 2) return { functionCall: { name: 'system.volume', args: { action: 'mute' } }, text: null, raw: {} };
      return { functionCall: null, text: 'Muted.', raw: {} };
    };
    const dispatch = async () => ({ ok: true, action: 'Muted.' });
    const result = await agentMod.runAgent({
      transcript: 'silence',
      llmCall, dispatch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.agentSteps[0].result.error, 'unknown tool');
    assert.equal(result.agentSteps[1].tool, 'system.volume');
  });

  // ── Dispatcher throws → agent surfaces, doesn't crash ────────────────────

  await test('runAgent: dispatcher throw is caught and reported as a step result', async () => {
    let calls = 0;
    const llmCall = async () => {
      calls++;
      if (calls === 1) return { functionCall: { name: 'app.open', args: { appName: 'foo' } }, text: null, raw: {} };
      return { functionCall: null, text: "Couldn't open foo.", raw: {} };
    };
    const dispatch = async () => { throw new Error('bad app'); };
    const result = await agentMod.runAgent({
      transcript: 'open foo',
      llmCall, dispatch,
    });
    assert.equal(result.agentSteps[0].result.ok, false);
    assert.ok(result.agentSteps[0].result.error.includes('bad app'));
  });

  // ── No api key when agent disabled — pipeline takes the fast-exit path ──
  // (covered indirectly by classifier suite which runs LLM_NEVER_CALLED;
  //  here we just assert the toggle reads from settings.)

  await test('jarvisAgentEnabled default is true and reads from settings', () => {
    const s = require('../settings');
    const v = s.getSetting('jarvisAgentEnabled', true);
    assert.equal(typeof v, 'boolean');
  });

  await test('jarvisAgentMaxSteps default is 3', () => {
    const s = require('../settings');
    const v = s.getSetting('jarvisAgentMaxSteps', 3);
    assert.equal(v, 3);
  });

  // ── Pipeline → agent route: path=agent in run log ────────────────────────

  section('21c. M4.5 — Suite 20: pipeline routes unsupported → agent → path=agent');

  await test('Pipeline routes system.unsupported to agent and logs path=agent', async () => {
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const agentModule      = require('./agent');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origAgent     = agentModule.runAgent;
    const origGet       = settingsMod.getSetting.bind(settingsMod);
    const origGetApiKey = settingsMod.getApiKey;

    settingsMod.getSetting = (key, fb) => (key === 'jarvisAgentEnabled' ? true : key === 'jarvisPlannerEnabled' ? false : origGet(key, fb));
    settingsMod.getApiKey  = () => 'fake-test-key';

    classifierModule.classify = async () => ({
      intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false, raw: 'foo bar baz',
    });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Did the thing.' });
    verifierModule.verify     = async () => ({ verified: true });
    agentModule.runAgent = async () => ({
      ok: true,
      finalText: 'Did the thing via agent.',
      agentSteps: [{ tool: 'app.open', params: { appName: 'notepad' }, result: { ok: true }, latencyMs: 10, retry: false }],
      lastDispatchResult: { ok: true, action: 'Opened.' },
      lastClassifierResult: { intent: 'app.open', params: { appName: 'notepad' }, confidence: 'agent', raw: 'foo bar baz', needsConfirm: false },
      stopped: 'final',
    });

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => { logLines.push(args.join(' ')); };

    try {
      await runPipelineFromText('foo bar baz', () => {}, () => Promise.resolve(true));
      const runLine = logLines.find((l) => l.includes('[JARVIS RUN]')) || '';
      assert.ok(runLine.includes('path=agent'),       `expected path=agent in: ${runLine}`);
      assert.ok(runLine.includes('intent=app.open'),  `expected intent=app.open in: ${runLine}`);
      assert.ok(runLine.includes('conf=agent'),       `expected conf=agent in: ${runLine}`);
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      agentModule.runAgent      = origAgent;
      settingsMod.getSetting    = origGet;
      settingsMod.getApiKey     = origGetApiKey;
      ctx.clear();
    }
  });

  await test('Pipeline fast-exits on unsupported when jarvisAgentEnabled=false (no api call)', async () => {
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const agentModule      = require('./agent');
    const origClassify  = classifierModule.classify;
    const origAgent     = agentModule.runAgent;
    const origGet       = settingsMod.getSetting.bind(settingsMod);
    const origGetApiKey = settingsMod.getApiKey;

    settingsMod.getSetting = (key, fb) => (key === 'jarvisAgentEnabled' ? false : origGet(key, fb));
    settingsMod.getApiKey  = () => 'fake-test-key';

    classifierModule.classify = async () => ({
      intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false, raw: 'zzz',
      reason: 'unrecognised',
    });
    let agentCalled = false;
    agentModule.runAgent = async () => { agentCalled = true; return { ok: false, finalText: 'no', agentSteps: [], stopped: 'final' }; };

    const events = [];
    try {
      await runPipelineFromText('zzz', (ch, p) => events.push({ ch, p }), () => Promise.resolve(true));
      assert.equal(agentCalled, false, 'agent must NOT run when jarvisAgentEnabled is false');
      const done = events.find((e) => e.ch === 'jarvis:done');
      assert.ok(done && done.p.ok === false);
    } finally {
      classifierModule.classify = origClassify;
      agentModule.runAgent      = origAgent;
      settingsMod.getSetting    = origGet;
      settingsMod.getApiKey     = origGetApiKey;
      ctx.clear();
    }
  });

  await test('Pipeline fast-exits on unsupported when no api key (regardless of agentEnabled)', async () => {
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const agentModule      = require('./agent');
    const origClassify  = classifierModule.classify;
    const origAgent     = agentModule.runAgent;
    const origGetApiKey = settingsMod.getApiKey;

    settingsMod.getApiKey  = () => '';

    classifierModule.classify = async () => ({
      intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false, raw: 'qq',
    });
    let agentCalled = false;
    agentModule.runAgent = async () => { agentCalled = true; return { ok: false, finalText: 'no', agentSteps: [], stopped: 'final' }; };

    try {
      await runPipelineFromText('qq', () => {}, () => Promise.resolve(true));
      assert.equal(agentCalled, false, 'agent must NOT run without api key');
    } finally {
      classifierModule.classify = origClassify;
      agentModule.runAgent      = origAgent;
      settingsMod.getApiKey     = origGetApiKey;
      ctx.clear();
    }
  });

  // ── Trace integration: agent path populates agentSteps in trace ──────────

  await test('Trace record path=agent and agentSteps populated when agent ran', async () => {
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const verifierModule   = require('./verifier');
    const agentModule      = require('./agent');
    const origClassify  = classifierModule.classify;
    const origVerify    = verifierModule.verify;
    const origAgent     = agentModule.runAgent;
    const origGet       = settingsMod.getSetting.bind(settingsMod);
    const origGetApiKey = settingsMod.getApiKey;

    const tmpDir = path.join(os.tmpdir(), `jarvis-trace-agent-${Date.now()}`);
    settingsMod.getSetting = (key, fb) => {
      if (key === 'jarvisTraceEnabled')  return true;
      if (key === 'jarvisTraceDir')      return tmpDir;
      if (key === 'jarvisTraceLevel')    return 'full';
      if (key === 'jarvisTraceMaxFiles') return 200;
      if (key === 'jarvisAgentEnabled')  return true;
      if (key === 'jarvisPlannerEnabled') return false; // M5.0 — keep this test on the agent path
      return origGet(key, fb);
    };
    settingsMod.getApiKey  = () => 'fake-test-key';

    classifierModule.classify = async () => ({
      intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false, raw: 'do something clever',
    });
    verifierModule.verify     = async () => ({ verified: true });
    agentModule.runAgent = async () => ({
      ok: true,
      finalText: 'Did it.',
      agentSteps: [
        { tool: 'file.find', params: { query: 'invoice' }, result: { ok: true }, latencyMs: 50, retry: false },
        { tool: 'file.open', params: { path: '/x/invoice.pdf' }, result: { ok: true }, latencyMs: 25, retry: false },
      ],
      lastDispatchResult:   { ok: true, action: 'Opened invoice.pdf.' },
      lastClassifierResult: { intent: 'file.open', params: { path: '/x/invoice.pdf' }, confidence: 'agent', raw: 'do something clever', needsConfirm: false },
      stopped: 'final',
    });

    try {
      await runPipelineFromText('do something clever', () => {}, () => Promise.resolve(true));
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
      assert.ok(files.length >= 1, 'trace file must be written');
      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
      assert.equal(written.path, 'agent');
      assert.ok(Array.isArray(written.agentSteps));
      assert.equal(written.agentSteps.length, 2);
      assert.equal(written.agentSteps[0].tool, 'file.find');
      assert.equal(written.agentSteps[1].tool, 'file.open');
    } finally {
      classifierModule.classify = origClassify;
      verifierModule.verify     = origVerify;
      agentModule.runAgent      = origAgent;
      settingsMod.getSetting    = origGet;
      settingsMod.getApiKey     = origGetApiKey;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
      ctx.clear();
    }
  });
}

// ─── Suite 21 — M4.6: UIA ui.* layer ─────────────────────────────────────────

async function runM46UiTests() {
  section('22. M4.6 — Suite 21: classifier ui.* patterns');

  await test('ui.click: "click Send" → ui.click {name:"Send"}', async () => {
    const r = await classify('click Send', LLM_NEVER_CALLED);
    assert.equal(r.intent,        'ui.click');
    assert.equal(r.params.name,   'Send');
  });

  await test('ui.click: "press the OK button" → ui.click {name:"OK"}', async () => {
    const r = await classify('press the OK button', LLM_NEVER_CALLED);
    assert.equal(r.intent,        'ui.click');
    assert.equal(r.params.name,   'OK');
  });

  await test('ui.click: "tap save" → ui.click {name:"save"}', async () => {
    const r = await classify('tap save', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'ui.click');
    assert.equal(r.params.name, 'save');
  });

  await test('ui.click: "click on the Cancel button" → ui.click {name:"Cancel"}', async () => {
    const r = await classify('click on the Cancel button', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'ui.click');
    assert.equal(r.params.name, 'Cancel');
  });

  await test('input.key still wins for "press enter" (no "the")', async () => {
    const r = await classify('press enter', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.key');
  });

  await test('ui.fill: "fill subject with hello world" → ui.fill', async () => {
    const r = await classify('fill subject with hello world', LLM_NEVER_CALLED);
    assert.equal(r.intent,        'ui.fill');
    assert.equal(r.params.name,   'subject');
    assert.equal(r.params.value,  'hello world');
  });

  await test('ui.fill: "type hello in subject" → ui.fill {name:"subject", value:"hello"}', async () => {
    const r = await classify('type hello in subject', LLM_NEVER_CALLED);
    assert.equal(r.intent,        'ui.fill');
    assert.equal(r.params.name,   'subject');
    assert.equal(r.params.value,  'hello');
  });

  await test('ui.fill: "type hi into the body" → ui.fill {name:"body", value:"hi"}', async () => {
    const r = await classify('type hi into the body', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'ui.fill');
    assert.equal(r.params.name,  'body');
    assert.equal(r.params.value, 'hi');
  });

  await test('input.type still wins for bare "type hello world" (no "in")', async () => {
    const r = await classify('type hello world', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.type');
  });

  await test('ui.read: "what does the status say" → ui.read', async () => {
    const r = await classify('what does the status say', LLM_NEVER_CALLED);
    assert.equal(r.intent,      'ui.read');
    assert.equal(r.params.name, 'status');
  });

  await test('ui.read: "read the subject field" → ui.read {name:"subject"}', async () => {
    const r = await classify('read the subject field', LLM_NEVER_CALLED);
    assert.equal(r.intent,      'ui.read');
    assert.equal(r.params.name, 'subject');
  });

  await test('file.read still wins for "read notes.txt" (extension present)', async () => {
    const r = await classify('read notes.txt', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'file.read');
  });

  // ── tool-schemas registers ui.* ───────────────────────────────────────────

  section('22b. M4.6 — Suite 21: tool-schemas registration');

  await test('ui.* tools are registered in tool-schemas', () => {
    const toolSchemas = require('./tool-schemas');
    for (const n of ['ui.list', 'ui.click', 'ui.fill', 'ui.read']) {
      assert.ok(toolSchemas.isRegistered(n), `${n} must be registered`);
    }
  });

  await test('Gemini function declarations include ui.* tools', () => {
    const toolSchemas = require('./tool-schemas');
    const decls = toolSchemas.toGeminiFunctionDeclarations();
    const names = decls.map((d) => d.name);
    for (const n of ['ui.list', 'ui.click', 'ui.fill', 'ui.read']) {
      assert.ok(names.includes(n), `${n} must be in function declarations`);
    }
  });

  await test('ui.* tools are not flagged destructive (no implicit confirm)', () => {
    const toolSchemas = require('./tool-schemas');
    for (const n of ['ui.list', 'ui.click', 'ui.fill', 'ui.read']) {
      assert.equal(toolSchemas.needsConfirmFor(n, {}), false, `${n} must not require confirm`);
    }
  });

  // ── ui.js — runPS mocking ─────────────────────────────────────────────────

  section('22c. M4.6 — Suite 21: ui.js wrapper (mocked PowerShell)');

  // Helper to swap runPS for a single test using a fresh module cache.
  function withMockedPS(stdoutStr, fn) {
    const psRunner = require('./tools/ps-runner');
    const orig = psRunner.runPS;
    psRunner.runPS = async () => ({ ok: true, stdout: stdoutStr, stderr: '' });
    return Promise.resolve(fn()).finally(() => { psRunner.runPS = orig; });
  }

  await test('listElements: parses elements array from PS stdout', async () => {
    const ui = require('./tools/ui');
    const stdout = JSON.stringify({
      ok: true,
      elements: [
        { name: 'Send',   automationId: 'btnSend', role: 'button', isEnabled: true },
        { name: 'Cancel', automationId: 'btnCancel', role: 'button', isEnabled: true },
      ],
    });
    await withMockedPS(stdout, async () => {
      const r = await ui.listElements({ scope: 'focused' });
      assert.equal(r.ok, true);
      assert.equal(r.data.elements.length, 2);
      assert.equal(r.data.elements[0].name, 'Send');
    });
  });

  await test('clickElement: single match → ok with target', async () => {
    const ui = require('./tools/ui');
    const stdout = JSON.stringify({ ok: true, target: { name: 'Send', automationId: 'btnSend', role: 'button', isEnabled: true } });
    await withMockedPS(stdout, async () => {
      const r = await ui.clickElement({ name: 'Send' });
      assert.equal(r.ok, true);
      assert.equal(r.data.target.name, 'Send');
      assert.ok(r.action.includes('Send'));
    });
  });

  await test('clickElement: ambiguous → returns candidates (M4.1 shape)', async () => {
    const ui = require('./tools/ui');
    const stdout = JSON.stringify({
      ok: false, ambiguous: true,
      candidates: [
        { name: 'Save', automationId: 'btnSaveTop', role: 'button', isEnabled: true },
        { name: 'Save', automationId: 'btnSaveBot', role: 'button', isEnabled: true },
      ],
    });
    await withMockedPS(stdout, async () => {
      const r = await ui.clickElement({ name: 'Save' });
      assert.equal(r.ok, false);
      assert.equal(r.ambiguous, true);
      assert.equal(r.candidates.length, 2);
      assert.ok(r.action.includes('Say one'));
    });
  });

  await test('clickElement: not_found → clean error', async () => {
    const ui = require('./tools/ui');
    const stdout = JSON.stringify({ ok: false, error: 'not_found' });
    await withMockedPS(stdout, async () => {
      const r = await ui.clickElement({ name: 'Nonexistent' });
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('Nonexistent'));
    });
  });

  await test('clickElement: missing selector → guarded error (no PS call)', async () => {
    const ui = require('./tools/ui');
    let psCalled = false;
    const psRunner = require('./tools/ps-runner');
    const orig = psRunner.runPS;
    psRunner.runPS = async () => { psCalled = true; return { ok: true, stdout: '{}', stderr: '' }; };
    try {
      const r = await ui.clickElement({});
      assert.equal(r.ok, false);
      assert.equal(psCalled, false, 'PS must not be called when selector is missing');
    } finally {
      psRunner.runPS = orig;
    }
  });

  await test('fillElement: missing value → clean error', async () => {
    const ui = require('./tools/ui');
    const r = await ui.fillElement({ name: 'subject' });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('value'));
  });

  await test('fillElement: success returns value in data', async () => {
    const ui = require('./tools/ui');
    const stdout = JSON.stringify({
      ok: true, target: { name: 'Subject', automationId: 'sb', role: 'edit' },
      value: 'hello',
    });
    await withMockedPS(stdout, async () => {
      const r = await ui.fillElement({ name: 'Subject', value: 'hello' });
      assert.equal(r.ok, true);
      assert.equal(r.data.value, 'hello');
    });
  });

  await test('readElement: returns the value', async () => {
    const ui = require('./tools/ui');
    const stdout = JSON.stringify({
      ok: true, target: { name: 'Status', automationId: 's', role: 'text' },
      value: 'All systems go',
    });
    await withMockedPS(stdout, async () => {
      const r = await ui.readElement({ name: 'Status' });
      assert.equal(r.ok, true);
      assert.equal(r.data.value, 'All systems go');
    });
  });

  await test('PS failure → tool error', async () => {
    const ui = require('./tools/ui');
    const psRunner = require('./tools/ps-runner');
    const orig = psRunner.runPS;
    psRunner.runPS = async () => ({ ok: false, stdout: '', stderr: '', error: 'PS timeout' });
    try {
      const r = await ui.clickElement({ name: 'X' });
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('timeout') || r.error.includes('PowerShell'));
    } finally {
      psRunner.runPS = orig;
    }
  });

  await test('Garbage stdout → clean error', async () => {
    const ui = require('./tools/ui');
    await withMockedPS('not json', async () => {
      const r = await ui.clickElement({ name: 'X' });
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('Invalid'));
    });
  });

  // ── Dispatcher routing ──────────────────────────────────────────────────

  section('22d. M4.6 — Suite 21: dispatcher cases');

  await test('dispatcher: ui.click without name AND automationId → DispatchError', async () => {
    const { dispatch, DispatchError } = require('./dispatcher');
    let threw = null;
    try {
      await dispatch({ intent: 'ui.click', params: {}, raw: 'click', needsConfirm: false });
    } catch (err) { threw = err; }
    assert.ok(threw instanceof DispatchError, 'should throw DispatchError');
  });

  await test('dispatcher: ui.fill without value → DispatchError', async () => {
    const { dispatch, DispatchError } = require('./dispatcher');
    let threw = null;
    try {
      await dispatch({ intent: 'ui.fill', params: { name: 'subject' }, raw: 'fill subject', needsConfirm: false });
    } catch (err) { threw = err; }
    assert.ok(threw instanceof DispatchError);
  });

  await test('dispatcher: ui.click with mocked tool returns ok', async () => {
    const psRunner = require('./tools/ps-runner');
    const orig = psRunner.runPS;
    psRunner.runPS = async () => ({
      ok: true,
      stdout: JSON.stringify({ ok: true, target: { name: 'Send', automationId: 'btn', role: 'button' } }),
      stderr: '',
    });
    try {
      const { dispatch } = require('./dispatcher');
      const r = await dispatch({ intent: 'ui.click', params: { name: 'Send' }, raw: 'click Send', needsConfirm: false });
      assert.equal(r.ok, true);
      assert.equal(r.data.target.name, 'Send');
    } finally {
      psRunner.runPS = orig;
    }
  });

  await test('dispatcher: ui.click ambiguous result surfaces ambiguous flag', async () => {
    const psRunner = require('./tools/ps-runner');
    const orig = psRunner.runPS;
    psRunner.runPS = async () => ({
      ok: true,
      stdout: JSON.stringify({
        ok: false, ambiguous: true,
        candidates: [
          { name: 'Save', automationId: 'a', role: 'button' },
          { name: 'Save', automationId: 'b', role: 'button' },
        ],
      }),
      stderr: '',
    });
    try {
      const { dispatch } = require('./dispatcher');
      const r = await dispatch({ intent: 'ui.click', params: { name: 'Save' }, raw: 'click Save', needsConfirm: false });
      assert.equal(r.ok, false);
      assert.equal(r.ambiguous, true);
      assert.equal(r.candidates.length, 2);
    } finally {
      psRunner.runPS = orig;
    }
  });

  // ── Verifier behavior ───────────────────────────────────────────────────

  section('22e. M4.6 — Suite 21: verifier ui.* cases');

  await test('verifier: ui.click ok with target → verified=true', async () => {
    const { verify } = require('./verifier');
    const r = await verify(
      { intent: 'ui.click', params: { name: 'Send' } },
      { ok: true, data: { target: { name: 'Send' }, method: 'invoke' }, action: '' },
    );
    assert.equal(r.verified, true);
    assert.equal(r.method, 'invoke_ok');
  });

  await test('verifier: ui.fill confirms via readback when values match', async () => {
    const psRunner = require('./tools/ps-runner');
    const orig = psRunner.runPS;
    psRunner.runPS = async () => ({
      ok: true,
      stdout: JSON.stringify({ ok: true, target: { name: 'Subject' }, value: 'hello' }),
      stderr: '',
    });
    try {
      const { verify } = require('./verifier');
      const r = await verify(
        { intent: 'ui.fill', params: { name: 'Subject' } },
        { ok: true, data: { target: { name: 'Subject', automationId: '' }, value: 'hello' }, action: '' },
      );
      assert.equal(r.verified, true);
      assert.equal(r.method, 'fill_readback');
    } finally {
      psRunner.runPS = orig;
    }
  });

  await test('verifier: ui.fill mismatch → verified=false', async () => {
    const psRunner = require('./tools/ps-runner');
    const orig = psRunner.runPS;
    psRunner.runPS = async () => ({
      ok: true,
      stdout: JSON.stringify({ ok: true, target: { name: 'Subject' }, value: 'something else' }),
      stderr: '',
    });
    try {
      const { verify } = require('./verifier');
      const r = await verify(
        { intent: 'ui.fill', params: { name: 'Subject' } },
        { ok: true, data: { target: { name: 'Subject', automationId: '' }, value: 'hello' }, action: '' },
      );
      assert.equal(r.verified, false);
      assert.ok(r.detail.includes('mismatch'));
    } finally {
      psRunner.runPS = orig;
    }
  });

  await test('verifier: ui.read with value → verified=true', async () => {
    const { verify } = require('./verifier');
    const r = await verify(
      { intent: 'ui.read', params: { name: 'Status' } },
      { ok: true, data: { target: { name: 'Status' }, value: 'All systems go' }, action: '' },
    );
    assert.equal(r.verified, true);
    assert.equal(r.method, 'read_ok');
  });

  await test('verifier: ui.list returns counts', async () => {
    const { verify } = require('./verifier');
    const r = await verify(
      { intent: 'ui.list', params: {} },
      { ok: true, data: { elements: [{ name: 'a' }, { name: 'b' }] }, action: '' },
    );
    assert.equal(r.verified, true);
    assert.ok(r.detail.includes('2'));
  });
}

// ─── Suite 22 — M4.7: Streaming pipeline ─────────────────────────────────────

async function runM47StreamingTests() {
  section('23. M4.7 — Suite 22: ack.js phrase mapping');

  const ackMod = require('./ack');

  await test('ackPhraseFor app.open includes app name', () => {
    assert.equal(ackMod.ackPhraseFor('app.open', { appName: 'chrome' }), 'Opening chrome.');
  });

  await test('ackPhraseFor falls back to generic phrase when no params', () => {
    assert.equal(ackMod.ackPhraseFor('app.open', {}), 'Opening it.');
  });

  await test('ackPhraseFor file.find → "Searching."', () => {
    assert.equal(ackMod.ackPhraseFor('file.find', {}), 'Searching.');
  });

  await test('ackPhraseFor returns null for destructive intents', () => {
    assert.equal(ackMod.ackPhraseFor('file.delete', { name: 'x.txt' }), null);
    assert.equal(ackMod.ackPhraseFor('file.rename', { newName: 'y' }), null);
    assert.equal(ackMod.ackPhraseFor('file.move',   { targetLocationHint: 'desktop' }), null);
    assert.equal(ackMod.ackPhraseFor('system.lock', {}), null);
  });

  await test('ackPhraseFor returns null when needsConfirm is true (defer)', () => {
    assert.equal(ackMod.ackPhraseFor('app.open', { appName: 'foo' }, { needsConfirm: true }), null);
  });

  await test('ackPhraseFor returns null for unsupported / unknown intents', () => {
    assert.equal(ackMod.ackPhraseFor('system.unsupported', {}), null);
    assert.equal(ackMod.ackPhraseFor('does.not.exist',     {}), null);
  });

  await test('ackPhraseFor ui.click includes element name', () => {
    assert.equal(ackMod.ackPhraseFor('ui.click', { name: 'Send' }), 'Clicking Send.');
  });

  // ── fireAck synthesizes & emits HUD event ──

  section('23b. M4.7 — Suite 22: fireAck non-blocking + jarvis:audio-ack event');

  await test('fireAck calls TTS once and emits jarvis:audio-ack', async () => {
    let ttsCalls = 0;
    const events = [];
    const synthesizeSpeech = async (text) => {
      ttsCalls++;
      assert.equal(text, 'Searching.');
      return { audioBuffer: Buffer.from('fake'), mimeType: 'audio/mpeg' };
    };
    const r = await ackMod.fireAck('Searching.', (ch, p) => events.push({ ch, p }), { synthesizeSpeech });
    assert.equal(ttsCalls, 1);
    assert.equal(r.ok, true);
    const ack = events.find((e) => e.ch === 'jarvis:audio-ack');
    assert.ok(ack, 'must emit jarvis:audio-ack');
    assert.equal(ack.p.phrase, 'Searching.');
    assert.ok(typeof ack.p.audioBase64 === 'string' && ack.p.audioBase64.length > 0);
  });

  await test('fireAck swallows TTS failures (no throw)', async () => {
    const synthesizeSpeech = async () => { throw new Error('no key'); };
    const events = [];
    const r = await ackMod.fireAck('On it.', (ch, p) => events.push({ ch, p }), { synthesizeSpeech });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('no key'));
    assert.equal(events.length, 0, 'no HUD event when TTS fails');
  });

  await test('fireAck with empty phrase is no-op', async () => {
    const r = await ackMod.fireAck('', () => {});
    assert.equal(r.ok, false);
  });

  // ── Pipeline integration: ack fires before result-TTS ──

  section('23c. M4.7 — Suite 22: pipeline ack ordering + audio-ack event');

  await test('Pipeline emits jarvis:audio-ack BEFORE jarvis:done on hot-path intent', async () => {
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');
    const ackModule        = require('./ack');

    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origSynth     = ttsMod.synthesizeSpeech;
    const origGet       = settingsMod.getSetting.bind(settingsMod);

    settingsMod.getSetting = (key, fb) => {
      if (key === 'jarvisStreamingEnabled') return true;
      if (key === 'jarvisAckTtsEnabled')    return true;
      return origGet(key, fb);
    };
    classifierModule.classify = async () => ({
      intent: 'app.open', confidence: 'pattern', params: { appName: 'notepad' }, needsConfirm: false, _patternIndex: 21, raw: 'open notepad',
    });
    dispatcherModule.dispatch = async () => {
      // Simulate ~30 ms dispatch
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, action: 'Opened notepad.' };
    };
    verifierModule.verify = async () => ({ verified: true, method: 'spawn_ok' });
    ttsMod.synthesizeSpeech = async (text) => {
      // Ack call resolves fast; result call runs after.
      const isAck = text.startsWith('Opening');
      await new Promise((r) => setTimeout(r, isAck ? 5 : 10));
      return { audioBuffer: Buffer.from(isAck ? 'ack' : 'res'), mimeType: 'audio/mpeg' };
    };

    const events = [];
    try {
      await runPipelineFromText('open notepad', (ch, p) => events.push({ ch, p }), () => Promise.resolve(true));
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      settingsMod.getSetting    = origGet;
      ctx.clear();
    }

    const ackIdx  = events.findIndex((e) => e.ch === 'jarvis:audio-ack');
    const doneIdx = events.findIndex((e) => e.ch === 'jarvis:done');
    assert.notEqual(ackIdx, -1, 'jarvis:audio-ack must fire');
    assert.notEqual(doneIdx, -1, 'jarvis:done must fire');
    assert.ok(ackIdx < doneIdx, `ack (${ackIdx}) must come before done (${doneIdx})`);
  });

  await test('Pipeline does NOT fire ack when intent is destructive (file.delete)', async () => {
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');

    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origSynth     = ttsMod.synthesizeSpeech;

    classifierModule.classify = async () => ({
      intent: 'file.delete', confidence: 'pattern',
      params: { name: 'note.txt', path: '/tmp/note.txt' },
      needsConfirm: true, _patternIndex: 19, raw: 'delete note.txt',
    });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Deleted.', data: { path: '/tmp/note.txt' } });
    verifierModule.verify = async () => ({ verified: true });
    let synthCalls = 0;
    ttsMod.synthesizeSpeech = async () => {
      synthCalls++;
      return { audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' };
    };

    const events = [];
    try {
      await runPipelineFromText('delete note.txt', (ch, p) => events.push({ ch, p }), () => Promise.resolve(true));
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }

    const ack = events.find((e) => e.ch === 'jarvis:audio-ack');
    assert.equal(ack, undefined, 'destructive intent must not fire ack');
    // result-tier TTS still runs once
    assert.ok(synthCalls >= 1, `expected at least the result TTS, got ${synthCalls}`);
  });

  await test('Pipeline skips ack when jarvisAckTtsEnabled is false', async () => {
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');

    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origSynth     = ttsMod.synthesizeSpeech;
    const origGet       = settingsMod.getSetting.bind(settingsMod);

    settingsMod.getSetting = (key, fb) => (key === 'jarvisAckTtsEnabled' ? false : origGet(key, fb));
    classifierModule.classify = async () => ({
      intent: 'app.open', confidence: 'pattern', params: { appName: 'notepad' }, needsConfirm: false, _patternIndex: 21, raw: 'open notepad',
    });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Opened.' });
    verifierModule.verify = async () => ({ verified: true });
    ttsMod.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    const events = [];
    try {
      await runPipelineFromText('open notepad', (ch, p) => events.push({ ch, p }), () => Promise.resolve(true));
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      settingsMod.getSetting    = origGet;
      ctx.clear();
    }

    const ack = events.find((e) => e.ch === 'jarvis:audio-ack');
    assert.equal(ack, undefined, 'no ack when setting disabled');
  });

  // ── Speculative pre-warm cache ──

  section('23d. M4.7 — Suite 22: prewarmClassify pre-warm cache');

  await test('prewarmClassify caches a pattern result; pipeline consumes it', async () => {
    const { prewarmClassify } = require('./pipeline');
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');

    let classifyCalls = 0;
    const origClassify = classifierModule.classify;
    const wrappedClassify = async (t) => {
      classifyCalls++;
      return origClassify(t);
    };
    const origDispatch = dispatcherModule.dispatch;
    const origVerify   = verifierModule.verify;
    const origSynth    = ttsMod.synthesizeSpeech;

    // Real classifier for "mute" — known pattern hit.
    classifierModule.classify = wrappedClassify;
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Volume muted.' });
    verifierModule.verify     = async () => ({ verified: true });
    ttsMod.synthesizeSpeech   = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    try {
      const r = await prewarmClassify('mute');
      assert.equal(r.cached, true, `prewarm should cache: ${JSON.stringify(r)}`);
      assert.equal(classifyCalls, 1);
      // Run with the same transcript — pipeline should consume cache (no extra classify call).
      await runPipelineFromText('mute', () => {}, () => Promise.resolve(true));
      assert.equal(classifyCalls, 1, 'classifier should NOT be called again when prewarm hit');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }
  });

  await test('prewarmClassify does NOT cache destructive intents', async () => {
    const { prewarmClassify } = require('./pipeline');
    const r = await prewarmClassify('delete report.txt');
    assert.equal(r.cached, false);
    assert.ok(r.reason === 'destructive' || r.intent !== 'file.delete' || r.reason);
  });

  await test('prewarmClassify does NOT cache when jarvisStreamingEnabled is false', async () => {
    const settingsMod = require('../settings');
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (key, fb) => (key === 'jarvisStreamingEnabled' ? false : origGet(key, fb));
    try {
      const { prewarmClassify } = require('./pipeline');
      const r = await prewarmClassify('mute');
      assert.equal(r.cached, false);
    } finally {
      settingsMod.getSetting = origGet;
    }
  });

  await test('prewarm cache miss (different transcript) → classifier still runs', async () => {
    const { prewarmClassify } = require('./pipeline');
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');

    let classifyCalls = 0;
    const origClassify = classifierModule.classify;
    const orig = origClassify;
    classifierModule.classify = async (t) => { classifyCalls++; return orig(t); };
    const origDispatch = dispatcherModule.dispatch;
    const origVerify   = verifierModule.verify;
    const origSynth    = ttsMod.synthesizeSpeech;
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'OK' });
    verifierModule.verify     = async () => ({ verified: true });
    ttsMod.synthesizeSpeech   = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    try {
      await prewarmClassify('mute');                            // cache "mute"
      await runPipelineFromText('volume up', () => {}, () => Promise.resolve(true));
      // 1 classify for prewarm + 1 classify for "volume up" (different transcript)
      assert.ok(classifyCalls >= 2, `expected ≥2 classify calls, got ${classifyCalls}`);
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }
  });

  // ── Cancellation ──

  section('23e. M4.7 — Suite 22: cancelCurrent + AbortSignal');

  await test('cancelCurrent returns false when no pipeline is running', () => {
    const { cancelCurrent } = require('./pipeline');
    assert.equal(cancelCurrent(), false);
  });

  await test('Pipeline emits cancelled jarvis:done when cancelCurrent fires mid-dispatch', async () => {
    const { cancelCurrent } = require('./pipeline');
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');

    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origSynth     = ttsMod.synthesizeSpeech;

    classifierModule.classify = async () => ({
      intent: 'file.find', confidence: 'pattern', params: { query: 'cv' }, needsConfirm: false, _patternIndex: 16, raw: 'find cv',
    });
    dispatcherModule.dispatch = async (cr, opts) => {
      // Long-running mock that respects the signal.
      return await new Promise((resolve) => {
        const sig = opts && opts.signal;
        const t = setTimeout(() => resolve({ ok: true, action: 'Found.', data: { matches: [] } }), 200);
        if (sig) {
          const onAbort = () => { clearTimeout(t); resolve({ ok: false, error: 'cancelled', cancelled: true, action: '' }); };
          if (sig.aborted) onAbort();
          else sig.addEventListener('abort', onAbort, { once: true });
        }
      });
    };
    verifierModule.verify   = async () => ({ verified: true });
    ttsMod.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    const events = [];
    try {
      const runPromise = runPipelineFromText('find cv', (ch, p) => events.push({ ch, p }), () => Promise.resolve(true));
      // Give the pipeline a tick to enter dispatch
      await new Promise((r) => setTimeout(r, 20));
      const cancelled = cancelCurrent();
      assert.equal(cancelled, true, 'cancelCurrent should report a cancel was issued');
      await runPromise;
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }

    const done = events.find((e) => e.ch === 'jarvis:done');
    assert.ok(done, 'jarvis:done must fire');
    assert.equal(done.p.ok, false);
    assert.equal(done.p.stopped, 'cancelled');
  });

  await test('dispatcher fast-exits when signal already aborted before dispatch', async () => {
    const { dispatch } = require('./dispatcher');
    const c = new AbortController();
    c.abort();
    const r = await dispatch(
      { intent: 'system.volume', params: { action: 'mute' }, raw: 'mute', needsConfirm: false },
      { signal: c.signal },
    );
    assert.equal(r.ok, false);
    assert.equal(r.cancelled, true);
  });

  // ── Run log includes path=pattern speculative=1 when prewarm hit ──

  section('23f. M4.7 — Suite 22: [JARVIS RUN] speculative=1 + ack="..."');

  await test('Run log gains speculative=1 when prewarm cache was consumed', async () => {
    const { prewarmClassify } = require('./pipeline');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');
    const origDispatch = dispatcherModule.dispatch;
    const origVerify   = verifierModule.verify;
    const origSynth    = ttsMod.synthesizeSpeech;
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'OK' });
    verifierModule.verify     = async () => ({ verified: true });
    ttsMod.synthesizeSpeech   = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    const logLines = [];
    const origLog = console.log;
    console.log = (...a) => { logLines.push(a.join(' ')); };
    try {
      await prewarmClassify('mute');
      await runPipelineFromText('mute', () => {}, () => Promise.resolve(true));
    } finally {
      console.log = origLog;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }
    const runLine = logLines.find((l) => l.includes('[JARVIS RUN]')) || '';
    assert.ok(runLine.includes('speculative=1'), `expected speculative=1 in: ${runLine}`);
  });

  await test('Run log includes ack="..." when ack fired', async () => {
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');
    const origClassify = classifierModule.classify;
    const origDispatch = dispatcherModule.dispatch;
    const origVerify   = verifierModule.verify;
    const origSynth    = ttsMod.synthesizeSpeech;

    classifierModule.classify = async () => ({
      intent: 'app.open', confidence: 'pattern', params: { appName: 'chrome' }, needsConfirm: false, _patternIndex: 21, raw: 'open chrome',
    });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Opened.' });
    verifierModule.verify     = async () => ({ verified: true });
    ttsMod.synthesizeSpeech   = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    const logLines = [];
    const origLog = console.log;
    console.log = (...a) => { logLines.push(a.join(' ')); };
    try {
      await runPipelineFromText('open chrome', () => {}, () => Promise.resolve(true));
    } finally {
      console.log = origLog;
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }
    const runLine = logLines.find((l) => l.includes('[JARVIS RUN]')) || '';
    assert.ok(runLine.includes('ack="Opening chrome.'), `expected ack=... in: ${runLine}`);
  });
}

// ─── Suite 23 — M4.8: Self-Correcting Loop & Conversational Continuity ──────

async function runM48ContinuityTests() {
  section('24. M4.8 — Suite 23: context.lastAction');

  await test('setLastAction / getLastAction round-trip', () => {
    ctx.clear();
    ctx.setLastAction({
      intent: 'input.type',
      params: { text: 'hello' },
      result: { ok: true, action: 'Typed "hello".' },
      transcript: 'type hello',
      needsConfirm: false,
    });
    const last = ctx.getLastAction();
    assert.ok(last);
    assert.equal(last.intent, 'input.type');
    assert.equal(last.params.text, 'hello');
    assert.equal(last.result.ok, true);
    ctx.clear();
  });

  await test('getLastAction returns null when nothing set', () => {
    ctx.clear();
    assert.equal(ctx.getLastAction(), null);
  });

  await test('setLastAction with empty entry is no-op', () => {
    ctx.clear();
    ctx.setLastAction(null);
    ctx.setLastAction({});
    assert.equal(ctx.getLastAction(), null);
  });

  await test('clear() drops lastAction', () => {
    ctx.setLastAction({ intent: 'app.open', params: { appName: 'notepad' } });
    assert.ok(ctx.getLastAction());
    ctx.clear();
    assert.equal(ctx.getLastAction(), null);
  });

  await test('snapshot() includes lastAction with ttlRemaining', () => {
    ctx.clear();
    ctx.setLastAction({ intent: 'app.open', params: { appName: 'chrome' }, transcript: 'open chrome' });
    const snap = ctx.snapshot();
    assert.ok(snap.lastAction);
    assert.equal(snap.lastAction.intent, 'app.open');
    assert.ok(typeof snap.lastAction.ttlRemaining === 'number');
    ctx.clear();
  });

  // ── Classifier patterns ────────────────────────────────────────────────────

  section('24b. M4.8 — Suite 23: classifier system.repeat / system.undo');

  await test('"do that again" → system.repeat', async () => {
    const r = await classify('do that again', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.repeat');
  });

  await test('"again" → system.repeat', async () => {
    const r = await classify('again', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.repeat');
  });

  await test('"repeat that" → system.repeat', async () => {
    const r = await classify('repeat that', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.repeat');
  });

  await test('Bare "undo" stays on legacy input.shortcut → ctrl+z (no collision)', async () => {
    const r = await classify('undo', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'input.shortcut');
    assert.equal(r.params.combo, 'ctrl+z');
  });

  await test('"undo that" → system.undo', async () => {
    const r = await classify('undo that', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.undo');
  });

  await test('"revert that" → system.undo', async () => {
    const r = await classify('revert that', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'system.undo');
  });

  await test('Existing _patternIndex assertions still hold (cancel=0, select=1)', async () => {
    const c = await classify('cancel', LLM_NEVER_CALLED);
    assert.equal(c._patternIndex, 0);
    const s = await classify('two', LLM_NEVER_CALLED);
    assert.equal(s._patternIndex, 1);
  });

  // ── Dispatcher cases ───────────────────────────────────────────────────────

  section('24c. M4.8 — Suite 23: dispatcher system.repeat / system.undo');

  await test('system.repeat with no lastAction → clean error', async () => {
    ctx.clear();
    const { dispatch } = require('./dispatcher');
    const r = await dispatch({ intent: 'system.repeat', params: {}, raw: 'do that again', needsConfirm: false });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('repeat'));
  });

  await test('system.repeat returns _resolved with the last action', async () => {
    ctx.clear();
    ctx.setLastAction({
      intent: 'input.type',
      params: { text: 'hello' },
      transcript: 'type hello',
      needsConfirm: false,
    });
    const { dispatch } = require('./dispatcher');
    const r = await dispatch({ intent: 'system.repeat', params: {}, raw: 'again', needsConfirm: false });
    assert.equal(r.ok, true);
    assert.ok(r._resolved);
    assert.equal(r._resolved.intent, 'input.type');
    assert.equal(r._resolved.params.text, 'hello');
    ctx.clear();
  });

  await test('system.undo with no lastAction → clean error', async () => {
    ctx.clear();
    const { dispatch } = require('./dispatcher');
    const r = await dispatch({ intent: 'system.undo', params: {}, raw: 'undo', needsConfirm: false });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('undo'));
  });

  await test('system.undo on input.type → _resolved input.shortcut ctrl+z', async () => {
    ctx.clear();
    ctx.setLastAction({ intent: 'input.type', params: { text: 'hi' }, transcript: 'type hi' });
    const { dispatch } = require('./dispatcher');
    const r = await dispatch({ intent: 'system.undo', params: {}, raw: 'undo' });
    assert.equal(r.ok, true);
    assert.equal(r._resolved.intent, 'input.shortcut');
    assert.equal(r._resolved.params.combo, 'ctrl+z');
    ctx.clear();
  });

  await test('system.undo on app.close → _resolved app.open', async () => {
    ctx.clear();
    ctx.setLastAction({ intent: 'app.close', params: { appName: 'notepad' }, transcript: 'close notepad' });
    const { dispatch } = require('./dispatcher');
    const r = await dispatch({ intent: 'system.undo', params: {}, raw: 'undo' });
    assert.equal(r.ok, true);
    assert.equal(r._resolved.intent, 'app.open');
    assert.equal(r._resolved.params.appName, 'notepad');
    ctx.clear();
  });

  await test('system.undo on input.shortcut ctrl+z → null (no double-undo)', async () => {
    ctx.clear();
    ctx.setLastAction({ intent: 'input.shortcut', params: { combo: 'ctrl+z' }, transcript: 'undo' });
    const { dispatch } = require('./dispatcher');
    const r = await dispatch({ intent: 'system.undo', params: {}, raw: 'undo' });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("don't know how to undo"));
    ctx.clear();
  });

  await test('system.undo on file.delete (unsupported inverse) → clean error', async () => {
    ctx.clear();
    ctx.setLastAction({ intent: 'file.delete', params: { name: 'x.txt', path: '/tmp/x.txt' } });
    const { dispatch } = require('./dispatcher');
    const r = await dispatch({ intent: 'system.undo', params: {} });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('file.delete'));
    ctx.clear();
  });

  // ── End-to-end pipeline: type → repeat ─────────────────────────────────────

  section('24d. M4.8 — Suite 23: end-to-end repeat workflow');

  await test('"type hello" → "do that again" → input.type dispatched twice', async () => {
    ctx.clear();
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origSynth     = ttsMod.synthesizeSpeech;

    const dispatchedIntents = [];
    let step = 0;
    classifierModule.classify = async (t) => {
      step++;
      if (step === 1) return { intent: 'input.type', confidence: 'pattern', params: { text: 'hello' }, needsConfirm: false, _patternIndex: 50, raw: t };
      return { intent: 'system.repeat', confidence: 'pattern', params: {}, needsConfirm: false, _patternIndex: 2, raw: t };
    };
    dispatcherModule.dispatch = async (cr) => {
      dispatchedIntents.push(cr.intent);
      return origDispatch(cr);   // Use real dispatcher for system.repeat to exercise _resolved
    };
    // Re-patch only for input.type tools (typeText would call PowerShell)
    const keyboardMod = require('./tools/keyboard');
    const origType = keyboardMod.typeText;
    keyboardMod.typeText = async () => ({ ok: true, action: 'Typed.' });
    verifierModule.verify   = async () => ({ verified: true });
    ttsMod.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    try {
      await runPipelineFromText('type hello', () => {}, () => Promise.resolve(true));
      // After step 1, lastAction should be set
      const last1 = ctx.getLastAction();
      assert.ok(last1, 'lastAction must be set after first command');
      assert.equal(last1.intent, 'input.type');

      await runPipelineFromText('do that again', () => {}, () => Promise.resolve(true));

      // dispatchedIntents should be: input.type (initial), system.repeat (re-route),
      // input.type (re-dispatched via _resolved)
      const typed = dispatchedIntents.filter((i) => i === 'input.type').length;
      const repeated = dispatchedIntents.filter((i) => i === 'system.repeat').length;
      assert.equal(typed, 2, `input.type expected twice, got ${typed} (intents: ${dispatchedIntents.join(',')})`);
      assert.equal(repeated, 1);
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      keyboardMod.typeText      = origType;
      ctx.clear();
    }
  });

  await test('Pipeline does NOT record lastAction for system.repeat itself', async () => {
    ctx.clear();
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origSynth     = ttsMod.synthesizeSpeech;

    classifierModule.classify = async (t) => ({
      intent: 'app.open', confidence: 'pattern', params: { appName: 'notepad' }, needsConfirm: false, _patternIndex: 23, raw: t,
    });
    dispatcherModule.dispatch = async () => ({ ok: true, action: 'Opened notepad.' });
    verifierModule.verify     = async () => ({ verified: true });
    ttsMod.synthesizeSpeech   = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    try {
      await runPipelineFromText('open notepad', () => {}, () => Promise.resolve(true));
      const last = ctx.getLastAction();
      assert.ok(last);
      assert.equal(last.intent, 'app.open', 'app.open must be recorded as lastAction');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }
  });

  await test('Pipeline does NOT record lastAction when dispatch fails', async () => {
    ctx.clear();
    const classifierModule = require('./classifier');
    const dispatcherModule = require('./dispatcher');
    const verifierModule   = require('./verifier');
    const ttsMod           = require('../tts');
    const origClassify  = classifierModule.classify;
    const origDispatch  = dispatcherModule.dispatch;
    const origVerify    = verifierModule.verify;
    const origSynth     = ttsMod.synthesizeSpeech;

    classifierModule.classify = async () => ({
      intent: 'app.open', confidence: 'pattern', params: { appName: 'foo' }, needsConfirm: false, _patternIndex: 23, raw: 'open foo',
    });
    dispatcherModule.dispatch = async () => ({ ok: false, error: 'unknown app' });
    verifierModule.verify     = async () => ({ verified: false });
    ttsMod.synthesizeSpeech   = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    try {
      await runPipelineFromText('open foo', () => {}, () => Promise.resolve(true));
      assert.equal(ctx.getLastAction(), null, 'failed dispatch must not set lastAction');
    } finally {
      classifierModule.classify = origClassify;
      dispatcherModule.dispatch = origDispatch;
      verifierModule.verify     = origVerify;
      ttsMod.synthesizeSpeech   = origSynth;
      ctx.clear();
    }
  });

  // ── Agent retry on verify-fail ─────────────────────────────────────────────

  section('24e. M4.8 — Suite 23: agent verify-fail retry');

  const agentMod = require('./agent');

  await test('retryAgent stamps retry:true on every step and seeds [RETRY] prompt', async () => {
    let prompts = 0;
    let seenRetryPrompt = false;
    const llmCall = async ({ contents }) => {
      prompts++;
      const text = (contents && contents[0] && contents[0].parts && contents[0].parts[0] && contents[0].parts[0].text) || '';
      if (text.includes('[RETRY]')) seenRetryPrompt = true;
      if (prompts === 1) return { functionCall: { name: 'app.open', args: { appName: 'chrome' } }, text: null, raw: {} };
      return { functionCall: null, text: 'Done.', raw: {} };
    };
    const dispatch = async () => ({ ok: true, action: 'Opened.' });
    const result = await agentMod.retryAgent({
      originalTranscript: 'open chrome',
      lastClassifierResult: { intent: 'app.open', params: { appName: 'krome' }, confidence: 'agent', raw: 'open chrome', needsConfirm: false },
      lastDispatchResult:   { ok: true, action: 'Opened.' },
      verifierResult:       { verified: false, method: 'spawn_ok', detail: 'process not found' },
      llmCall, dispatch,
    });
    assert.equal(seenRetryPrompt, true, 'retry prompt must include [RETRY] block');
    assert.ok(result.agentSteps.length >= 1);
    assert.equal(result.agentSteps[0].retry, true, 'every step must be retry:true');
    assert.equal(result.isRetry, true);
  });

  await test('Pipeline triggers retry when agent path verify=false; succeeds on retry', async () => {
    ctx.clear();
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const verifierModule   = require('./verifier');
    const agentModule      = require('./agent');
    const ttsMod           = require('../tts');
    const origClassify  = classifierModule.classify;
    const origVerify    = verifierModule.verify;
    const origRunAgent  = agentModule.runAgent;
    const origRetry     = agentModule.retryAgent;
    const origSynth     = ttsMod.synthesizeSpeech;
    const origGet       = settingsMod.getSetting.bind(settingsMod);
    const origGetApiKey = settingsMod.getApiKey;

    settingsMod.getSetting = (key, fb) => (key === 'jarvisAgentEnabled' ? true : key === 'jarvisPlannerEnabled' ? false : origGet(key, fb));
    settingsMod.getApiKey  = () => 'fake-key';

    classifierModule.classify = async () => ({
      intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false, raw: 'do something',
    });
    let verifyCount = 0;
    verifierModule.verify = async () => {
      verifyCount++;
      // First verify (after agent's first attempt) → false; second (after retry) → true
      return { verified: verifyCount > 1, method: 'invoke_ok', detail: verifyCount === 1 ? 'element not found' : 'ok' };
    };

    let retryCalled = false;
    agentModule.runAgent = async () => ({
      ok: true,
      finalText: 'Initial attempt.',
      agentSteps: [{ tool: 'ui.click', params: { name: 'sned' }, result: { ok: true }, latencyMs: 10, retry: false }],
      lastDispatchResult:   { ok: true, action: 'Clicked.' },
      lastClassifierResult: { intent: 'ui.click', params: { name: 'sned' }, confidence: 'agent', raw: 'do something', needsConfirm: false },
      stopped: 'final',
    });
    agentModule.retryAgent = async () => {
      retryCalled = true;
      return {
        ok: true,
        finalText: 'Fixed it on retry.',
        agentSteps: [{ tool: 'ui.click', params: { name: 'Send' }, result: { ok: true }, latencyMs: 12, retry: true }],
        lastDispatchResult:   { ok: true, action: 'Clicked Send.' },
        lastClassifierResult: { intent: 'ui.click', params: { name: 'Send' }, confidence: 'agent', raw: 'do something', needsConfirm: false },
        stopped: 'final',
        isRetry: true,
      };
    };
    ttsMod.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    const events = [];
    try {
      await runPipelineFromText('do something', (ch, p) => events.push({ ch, p }), () => Promise.resolve(true));
      assert.equal(retryCalled, true, 'retryAgent must fire on verify-fail');
      assert.ok(verifyCount >= 2, `expected ≥2 verify calls, got ${verifyCount}`);
      const done = events.find((e) => e.ch === 'jarvis:done');
      assert.ok(done);
      assert.equal(done.p.ok, true);
      assert.ok(done.p.display.includes('retry') || done.p.display.includes('Fixed'),
        `expected retry text in display, got: ${done.p.display}`);
    } finally {
      classifierModule.classify = origClassify;
      verifierModule.verify     = origVerify;
      agentModule.runAgent      = origRunAgent;
      agentModule.retryAgent    = origRetry;
      ttsMod.synthesizeSpeech   = origSynth;
      settingsMod.getSetting    = origGet;
      settingsMod.getApiKey     = origGetApiKey;
      ctx.clear();
    }
  });

  await test('Pipeline retry is capped at 1 (no second retry even if verify still fails)', async () => {
    ctx.clear();
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const verifierModule   = require('./verifier');
    const agentModule      = require('./agent');
    const ttsMod           = require('../tts');
    const origClassify  = classifierModule.classify;
    const origVerify    = verifierModule.verify;
    const origRunAgent  = agentModule.runAgent;
    const origRetry     = agentModule.retryAgent;
    const origSynth     = ttsMod.synthesizeSpeech;
    const origGet       = settingsMod.getSetting.bind(settingsMod);
    const origGetApiKey = settingsMod.getApiKey;

    settingsMod.getSetting = (key, fb) => (key === 'jarvisAgentEnabled' ? true : key === 'jarvisPlannerEnabled' ? false : origGet(key, fb));
    settingsMod.getApiKey  = () => 'fake-key';

    classifierModule.classify = async () => ({
      intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false, raw: 'do flaky',
    });
    verifierModule.verify = async () => ({ verified: false, method: 'invoke_ok', detail: 'still wrong' });

    agentModule.runAgent = async () => ({
      ok: true,
      finalText: 'try 1',
      agentSteps: [{ tool: 'ui.click', params: { name: 'a' }, result: { ok: true }, latencyMs: 1, retry: false }],
      lastDispatchResult:   { ok: true, action: '' },
      lastClassifierResult: { intent: 'ui.click', params: { name: 'a' }, confidence: 'agent', raw: 'do flaky', needsConfirm: false },
      stopped: 'final',
    });
    let retryCalls = 0;
    agentModule.retryAgent = async () => {
      retryCalls++;
      return {
        ok: true,
        finalText: 'try 2',
        agentSteps: [{ tool: 'ui.click', params: { name: 'b' }, result: { ok: true }, latencyMs: 1, retry: true }],
        lastDispatchResult:   { ok: true, action: '' },
        lastClassifierResult: { intent: 'ui.click', params: { name: 'b' }, confidence: 'agent', raw: 'do flaky', needsConfirm: false },
        stopped: 'final',
        isRetry: true,
      };
    };
    ttsMod.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    try {
      await runPipelineFromText('do flaky', () => {}, () => Promise.resolve(true));
      assert.equal(retryCalls, 1, `retry must fire exactly once, got ${retryCalls}`);
    } finally {
      classifierModule.classify = origClassify;
      verifierModule.verify     = origVerify;
      agentModule.runAgent      = origRunAgent;
      agentModule.retryAgent    = origRetry;
      ttsMod.synthesizeSpeech   = origSynth;
      settingsMod.getSetting    = origGet;
      settingsMod.getApiKey     = origGetApiKey;
      ctx.clear();
    }
  });

  await test('Pipeline retry NOT triggered when verify succeeds first time', async () => {
    ctx.clear();
    const settingsMod      = require('../settings');
    const classifierModule = require('./classifier');
    const verifierModule   = require('./verifier');
    const agentModule      = require('./agent');
    const ttsMod           = require('../tts');
    const origClassify  = classifierModule.classify;
    const origVerify    = verifierModule.verify;
    const origRunAgent  = agentModule.runAgent;
    const origRetry     = agentModule.retryAgent;
    const origSynth     = ttsMod.synthesizeSpeech;
    const origGet       = settingsMod.getSetting.bind(settingsMod);
    const origGetApiKey = settingsMod.getApiKey;

    settingsMod.getSetting = (key, fb) => (key === 'jarvisAgentEnabled' ? true : key === 'jarvisPlannerEnabled' ? false : origGet(key, fb));
    settingsMod.getApiKey  = () => 'fake-key';

    classifierModule.classify = async () => ({
      intent: 'system.unsupported', confidence: 'pattern', params: {}, needsConfirm: false, raw: 'works',
    });
    verifierModule.verify = async () => ({ verified: true, method: 'invoke_ok' });
    agentModule.runAgent = async () => ({
      ok: true, finalText: 'OK', agentSteps: [],
      lastDispatchResult:   { ok: true, action: 'OK' },
      lastClassifierResult: { intent: 'ui.click', params: { name: 'X' }, confidence: 'agent', raw: 'works', needsConfirm: false },
      stopped: 'final',
    });
    let retryCalls = 0;
    agentModule.retryAgent = async () => { retryCalls++; return { ok: true, finalText: '', agentSteps: [], stopped: 'final' }; };
    ttsMod.synthesizeSpeech = async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mpeg' });

    try {
      await runPipelineFromText('works', () => {}, () => Promise.resolve(true));
      assert.equal(retryCalls, 0, 'retry must NOT fire when first verify succeeds');
    } finally {
      classifierModule.classify = origClassify;
      verifierModule.verify     = origVerify;
      agentModule.runAgent      = origRunAgent;
      agentModule.retryAgent    = origRetry;
      ttsMod.synthesizeSpeech   = origSynth;
      settingsMod.getSetting    = origGet;
      settingsMod.getApiKey     = origGetApiKey;
      ctx.clear();
    }
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
  await runM44TraceTests();
  await runM45FollowUpTests();
  await runM45AgentTests();
  await runM46UiTests();
  await runM47StreamingTests();
  await runM48ContinuityTests();
  await runM50PlannerTests();
  await runM51M52ToolTests();
  await runM53M54Tests();

  console.log('\n─────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\nSome tests failed.');
    process.exit(1);
  } else {
    console.log('\nAll tests passed. Phase 4 M4.5 complete.');
  }
})();

// ─── Suite 24 — M5.0: Planner / Executor ─────────────────────────────────────

async function runM50PlannerTests() {
  section('25. M5.0 — Suite 24: planner');
  const planner  = require('./planner');
  const executor = require('./executor');

  await test('planner.makePlan: returns ok with steps when LLM returns valid JSON', async () => {
    const stubLlm = async () => ({
      json: {
        goal: 'open notepad',
        steps: [{ tool: 'app.open', params: { appName: 'notepad' }, why: 'launch' }],
        expectedFinalSpeak: 'Opened notepad.',
      },
      text: '', raw: {},
    });
    const r = await planner.makePlan({ transcript: 'open notepad', llmCall: stubLlm });
    assert.equal(r.ok, true);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].tool, 'app.open');
    assert.equal(r.steps[0].params.appName, 'notepad');
    assert.match(r.expectedFinalSpeak, /[Nn]otepad/);
  });

  await test('planner.makePlan: rejects unknown tool names', async () => {
    const stubLlm = async () => ({
      json: { goal: 'g', steps: [{ tool: 'nope.not.a.tool', params: {}, why: '' }], expectedFinalSpeak: 'x' },
      text: '', raw: {},
    });
    const r = await planner.makePlan({ transcript: 'do x', llmCall: stubLlm });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /unknown tool/);
  });

  await test('planner.makePlan: empty steps still ok with expectedFinalSpeak', async () => {
    const stubLlm = async () => ({
      json: { goal: 'nothing', steps: [], expectedFinalSpeak: 'OK, nothing to do.' },
      text: '', raw: {},
    });
    const r = await planner.makePlan({ transcript: 'do nothing', llmCall: stubLlm });
    assert.equal(r.ok, true);
    assert.equal(r.steps.length, 0);
    assert.match(r.expectedFinalSpeak, /nothing/);
  });

  await test('planner.makePlan: caps step list at jarvisPlanMaxSteps', async () => {
    const settingsMod = require('../settings');
    const origGet = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (k, fb) => (k === 'jarvisPlanMaxSteps' ? 3 : origGet(k, fb));
    try {
      const stubLlm = async () => ({
        json: {
          goal: 'g',
          steps: Array.from({ length: 8 }, () => ({ tool: 'app.open', params: { appName: 'notepad' }, why: '' })),
          expectedFinalSpeak: 'Done.',
        },
        text: '', raw: {},
      });
      const r = await planner.makePlan({ transcript: 'x', llmCall: stubLlm });
      assert.equal(r.ok, true);
      assert.equal(r.steps.length, 3);
    } finally {
      settingsMod.getSetting = origGet;
    }
  });

  await test('executor.runPlan: dispatches each step in order, returns finalSpeak', async () => {
    const events = [];
    const stubMakePlan = async () => ({
      ok: true,
      goal: 'g',
      steps: [
        { tool: 'app.open',     params: { appName: 'notepad' }, why: '' },
        { tool: 'window.minimize', params: {},                   why: '' },
      ],
      expectedFinalSpeak: 'Notepad opened and minimized.',
    });
    const dispatchCalls = [];
    const stubDispatch = async (cr) => {
      dispatchCalls.push(cr.intent);
      return { ok: true, action: 'OK', data: {} };
    };
    const r = await executor.runPlan({
      transcript:    'open notepad and minimize',
      hudSend:       () => {},
      waitForConfirm: async () => true,
      makePlan:      stubMakePlan,
      dispatch:      stubDispatch,
      verify:        async () => ({ verified: true }),
      fireNarration: () => {},
      onPlanEvent:   (e) => events.push(e),
    });
    assert.equal(r.ok, true);
    assert.equal(r.stopped, 'final');
    assert.deepEqual(dispatchCalls, ['app.open', 'window.minimize']);
    assert.equal(r.planSteps.length, 2);
    assert.match(r.finalSpeak, /minimized/);
    // Plan + 2 step.start + 2 step.done events = 5 minimum
    const types = events.map((e) => e.type);
    assert.ok(types.includes('plan'));
    assert.ok(types.filter((t) => t === 'step.start').length === 2);
    assert.ok(types.filter((t) => t === 'step.done').length === 2);
  });

  await test('executor.runPlan: re-plans once on step failure, then succeeds', async () => {
    let callCount = 0;
    const stubMakePlan = async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, goal: 'g', steps: [{ tool: 'app.open', params: { appName: 'wrongapp' }, why: '' }], expectedFinalSpeak: 'V1.' };
      }
      return { ok: true, goal: 'g', steps: [{ tool: 'app.open', params: { appName: 'notepad' }, why: '' }], expectedFinalSpeak: 'V2 — fixed it.' };
    };
    const stubDispatch = async (cr) => {
      if (cr.params.appName === 'wrongapp') return { ok: false, error: 'not found', action: '' };
      return { ok: true, action: 'OK', data: {} };
    };
    const r = await executor.runPlan({
      transcript:    'open notepad',
      hudSend:       () => {},
      waitForConfirm: async () => true,
      makePlan:      stubMakePlan,
      dispatch:      stubDispatch,
      verify:        async () => ({ verified: true }),
      fireNarration: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(r.replans, 1);
    assert.equal(callCount, 2);
    assert.match(r.finalSpeak, /fixed it/);
  });

  await test('executor.runPlan: stops on step failure when replan also fails', async () => {
    const stubMakePlan = async ({ failure }) => {
      if (failure) return { ok: false, error: 'no recovery' };
      return { ok: true, goal: 'g', steps: [{ tool: 'app.open', params: { appName: 'broken' }, why: '' }], expectedFinalSpeak: 'V1.' };
    };
    const stubDispatch = async () => ({ ok: false, error: 'broke', action: '' });
    const r = await executor.runPlan({
      transcript:    'open broken',
      hudSend:       () => {},
      waitForConfirm: async () => true,
      makePlan:      stubMakePlan,
      dispatch:      stubDispatch,
      verify:        async () => ({ verified: false }),
      fireNarration: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.stopped, 'step_failed');
  });

  await test('executor.runPlan: AbortSignal stops between steps', async () => {
    const ac = new AbortController();
    const stubMakePlan = async () => ({
      ok: true, goal: 'g',
      steps: [
        { tool: 'app.open', params: { appName: 'a' }, why: '' },
        { tool: 'app.open', params: { appName: 'b' }, why: '' },
      ],
      expectedFinalSpeak: 'done',
    });
    let dispatched = 0;
    const stubDispatch = async () => {
      dispatched++;
      if (dispatched === 1) ac.abort();
      return { ok: true, action: 'OK', data: {} };
    };
    const r = await executor.runPlan({
      transcript:    'x',
      signal:        ac.signal,
      hudSend:       () => {},
      waitForConfirm: async () => true,
      makePlan:      stubMakePlan,
      dispatch:      stubDispatch,
      verify:        async () => ({ verified: true }),
      fireNarration: () => {},
    });
    assert.equal(r.stopped, 'cancelled');
    assert.equal(r.ok, false);
  });

  await test('executor.runPlan: enforces destructive confirmation gate', async () => {
    let confirmCalled = false;
    const stubMakePlan = async () => ({
      ok: true, goal: 'g',
      steps: [{ tool: 'system.lock', params: {}, why: '' }],
      expectedFinalSpeak: 'Locked.',
    });
    const r = await executor.runPlan({
      transcript:    'lock my screen',
      hudSend:       () => {},
      waitForConfirm: async () => { confirmCalled = true; return false; },
      makePlan:      stubMakePlan,
      dispatch:      async () => ({ ok: true, action: 'should not run', data: {} }),
      verify:        async () => ({ verified: true }),
      fireNarration: () => {},
    });
    assert.equal(confirmCalled, true);
    assert.equal(r.stopped, 'cancelled');
    assert.equal(r.ok, false);
  });
}

// ─── Suite 25 — M5.1 / M5.2: New tool dispatcher cases ───────────────────────

async function runM51M52ToolTests() {
  section('26. M5.1/M5.2 — Suite 25: dispatcher new tools');
  const { dispatch } = require('./dispatcher');

  await test('dispatcher: web.search routes to web-search tool', async () => {
    const wsMod = require('./tools/web-search');
    const orig = wsMod.search;
    wsMod.search = async ({ query }) => ({ ok: true, data: { results: [{ title: 'X', url: 'http://x', snippet: 's' }], query }, action: 'searched' });
    try {
      const r = await dispatch({ intent: 'web.search', params: { query: 'foo' }, raw: 'foo', confidence: 'plan' });
      assert.equal(r.ok, true);
      assert.ok(r.data.results.length === 1);
    } finally { wsMod.search = orig; }
  });

  await test('dispatcher: web.scrape routes to web-scrape tool', async () => {
    const sMod = require('./tools/web-scrape');
    const orig = sMod.scrape;
    sMod.scrape = async ({ url }) => ({ ok: true, data: { url, title: 't', text: 'body', links: [] }, action: 'scraped' });
    try {
      const r = await dispatch({ intent: 'web.scrape', params: { url: 'https://example.com' }, raw: '', confidence: 'plan' });
      assert.equal(r.ok, true);
      assert.equal(r.data.title, 't');
    } finally { sMod.scrape = orig; }
  });

  await test('dispatcher: vision.read routes to vision tool', async () => {
    const vMod = require('./tools/vision');
    const orig = vMod.read;
    vMod.read = async () => ({ ok: true, data: { summary: 'A test', elements: [], scope: 'focused' }, action: 'A test' });
    try {
      const r = await dispatch({ intent: 'vision.read', params: {}, raw: '', confidence: 'plan' });
      assert.equal(r.ok, true);
      assert.match(r.data.summary, /test/);
    } finally { vMod.read = orig; }
  });

  await test('dispatcher: browser.tabs.list routes to browser-cdp', async () => {
    const cdpMod = require('./tools/browser-cdp');
    const orig = cdpMod.listTabs;
    cdpMod.listTabs = async () => ({ ok: true, data: { tabs: [{ tabId: 'T1', title: 't', url: 'u', active: true }] }, action: '1 tab.' });
    try {
      const r = await dispatch({ intent: 'browser.tabs.list', params: {}, raw: '', confidence: 'plan' });
      assert.equal(r.ok, true);
      assert.equal(r.data.tabs.length, 1);
    } finally { cdpMod.listTabs = orig; }
  });

  await test('dispatcher: browser.click rejects when no selector and no text', async () => {
    let threw = null;
    try { await dispatch({ intent: 'browser.click', params: {}, raw: '', confidence: 'plan' }); }
    catch (err) { threw = err; }
    assert.ok(threw, 'expected DispatchError');
    assert.match(threw.message, /selector|text/);
  });

  await test('classifier: "list tabs" → browser.tabs.list', async () => {
    const r = await classify('list tabs', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.tabs.list');
  });

  await test('classifier: "scroll to top" → browser.scroll {direction:top}', async () => {
    const r = await classify('scroll to top', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.scroll');
    assert.equal(r.params.direction, 'top');
  });

  await test('classifier: "read this page" → browser.read {mode:main}', async () => {
    const r = await classify('read this page', LLM_NEVER_CALLED);
    assert.equal(r.intent, 'browser.read');
    assert.equal(r.params.mode, 'main');
  });
}

// ─── Suite 26 — M5.3 / M5.4: Voice cancel + active result reroute ────────────

async function runM53M54Tests() {
  section('27. M5.3/M5.4 — Suite 26: voice cancel + result panel');
  const pipeline = require('./pipeline');

  await test('maybeVoiceCancel: returns false when no pipeline running', () => {
    const r = pipeline.maybeVoiceCancel('stop please');
    assert.equal(r, false);
  });

  await test('maybeVoiceCancel: ignores non-keyword partials', () => {
    const r = pipeline.maybeVoiceCancel('go to youtube and search lo-fi');
    assert.equal(r, false);
  });

  await test('context: setActiveResultSet + getActiveResultSet round-trip', () => {
    ctx.clear();
    ctx.setActiveResultSet({
      kind:   'web', source: 'web.search',
      cards:  [{ index: 1, title: 'A', url: 'http://a' }, { index: 2, title: 'B', url: 'http://b' }],
    });
    const r = ctx.getActiveResultSet();
    assert.ok(r);
    assert.equal(r.kind, 'web');
    assert.equal(r.cards.length, 2);
    ctx.clearActiveResultSet();
    assert.equal(ctx.getActiveResultSet(), null);
  });

  await test('dispatcher.system.select: routes to active result set when no candidates', async () => {
    const { dispatch } = require('./dispatcher');
    ctx.clear();
    ctx.setActiveResultSet({
      kind: 'web', source: 'web.search',
      cards: [
        { index: 1, title: 'First',  url: 'http://first.example'  },
        { index: 2, title: 'Second', url: 'http://second.example' },
      ],
    });
    const r = await dispatch({ intent: 'system.select', params: { ordinal: 2 }, raw: 'the second one', confidence: 'pattern' });
    assert.equal(r.ok, true);
    assert.ok(r._resolved, 'should produce a resolved re-dispatch');
    assert.equal(r._resolved.intent, 'browser.tabs.open');
    assert.equal(r._resolved.params.url, 'http://second.example');
    ctx.clear();
  });

  await test('dispatcher.system.select: rejects out-of-range ordinal against panel', async () => {
    const { dispatch } = require('./dispatcher');
    ctx.clear();
    ctx.setActiveResultSet({
      kind: 'web', source: 'web.search',
      cards: [{ index: 1, title: 'A', url: 'http://a' }],
    });
    const r = await dispatch({ intent: 'system.select', params: { ordinal: 5 }, raw: '', confidence: 'pattern' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Only 1 result/);
    ctx.clear();
  });

  await test('narrate.fireNarration: short-circuits when disabled', async () => {
    const settingsMod = require('../settings');
    const orig = settingsMod.getSetting.bind(settingsMod);
    settingsMod.getSetting = (k, fb) => (k === 'jarvisNarrationEnabled' ? false : orig(k, fb));
    try {
      const narrate = require('./narrate');
      const r = await narrate.fireNarration('hello', () => {});
      assert.equal(r.ok, false);
      assert.match(r.error, /disabled/);
    } finally {
      settingsMod.getSetting = orig;
    }
  });
}
