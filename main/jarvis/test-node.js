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
const { resolveJarvisPath, createFile, readFile, writeFile, appendFile, listDir, createDir, LOCATION_MAP } = require('./tools/files');
const { classify }  = require('./classifier');
const { dispatch }  = require('./dispatcher');
const { verify }    = require('./verifier');

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

// ─── Run all suites ───────────────────────────────────────────────────────────

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  Jarvis — Phase 1 + Phase 2 + Phase 3 M3.2 Tier A Tests                 ║');
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

  console.log('\n─────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\nSome tests failed.');
    process.exit(1);
  } else {
    console.log('\nAll tests passed. Phase 3 M3.2 complete.');
  }
})();
