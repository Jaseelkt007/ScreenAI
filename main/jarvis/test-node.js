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

// ─── Run all suites ───────────────────────────────────────────────────────────

(async () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Jarvis Phase 1 — Milestone 1 Tier A Tests  ║');
  console.log('╚══════════════════════════════════════════╝');

  await runPathTests();
  await runFileTests();
  await runClassifierTests();
  await runDispatcherTests();
  await runVerifierTests();

  console.log('\n─────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\nSome tests failed. Fix failures before moving to Milestone 2.');
    process.exit(1);
  } else {
    console.log('\nAll tests passed. Milestone 1 complete.');
  }
})();
