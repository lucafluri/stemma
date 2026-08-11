#!/usr/bin/env node
'use strict';

/**
 * Tests for what this browser is left holding between visits:
 * the AI API key, and the warning about work that exists nowhere else.
 * Run with: node session.test.js
 *
 * Both are cases where the safe default depends on context rather than on a
 * setting — where the page is served from, and whether the autosave has
 * actually caught up — so both are easy to get quietly wrong.
 */

const assert = require('assert');
const { setupDom } = require('./test-setup.js');

const dom = setupDom();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const atOrigin = url => dom.reconfigure({ url });

(async () => {
  const Imp = await import('./js/import.js');
  const Io  = await import('./js/gedcom-io.js');
  const { state } = await import('./js/state.js');
  await new Promise(r => setTimeout(r, 50));
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  const clearStores = () => {
    localStorage.removeItem('ai_api_key');
    sessionStorage.removeItem('ai_api_key');
    const el = document.getElementById('ai-api-key-input');
    if (el) el.value = '';
    delete window.ANTHROPIC_API_KEY;
  };

  console.log('\nwhere the API key is allowed to live');

  await test('served from localhost, the key is kept for next time', () => {
    clearStores();
    atOrigin('http://localhost/');
    document.getElementById('ai-api-key-input').value = 'sk-ant-local';
    Imp._aiSaveKey();
    assert.strictEqual(localStorage.getItem('ai_api_key'), 'sk-ant-local',
      'on your own machine, remembering it is the point');
  });

  await test('served from a public origin, it lasts only for the tab', () => {
    clearStores();
    atOrigin('https://example.github.io/tree/');
    document.getElementById('ai-api-key-input').value = 'sk-ant-public';
    Imp._aiSaveKey();
    assert.strictEqual(sessionStorage.getItem('ai_api_key'), 'sk-ant-public', 'held for the session');
    assert.strictEqual(localStorage.getItem('ai_api_key'), null,
      'but never written where it would outlive the tab');
  });

  await test('a key persisted by an earlier visit is moved out of localStorage', () => {
    clearStores();
    atOrigin('https://example.github.io/tree/');
    localStorage.setItem('ai_api_key', 'sk-ant-stale');   // left by a build without this rule
    const got = Imp._aiGetKey();
    assert.strictEqual(got, 'sk-ant-stale', 'it is still usable for this session');
    assert.strictEqual(localStorage.getItem('ai_api_key'), null,
      'stopping new exposure is no good while the old one sits there');
    assert.strictEqual(sessionStorage.getItem('ai_api_key'), 'sk-ant-stale');
  });

  await test('the stray key is cleared on load, not only when AI import is opened', () => {
    clearStores();
    atOrigin('https://example.github.io/tree/');
    localStorage.setItem('ai_api_key', 'sk-ant-never-used-again');
    // Nothing here goes near the import dialog — this is what a visitor who
    // pasted a key once, months ago, and never used the feature again does.
    Imp._aiMigrateStrayKey();
    assert.strictEqual(localStorage.getItem('ai_api_key'), null,
      'a key nobody touches this session still has to come off disk');
  });

  await test('on localhost that same load leaves the stored key alone', () => {
    clearStores();
    atOrigin('http://localhost/');
    localStorage.setItem('ai_api_key', 'sk-ant-mine');
    assert.strictEqual(Imp._aiMigrateStrayKey(), false);
    assert.strictEqual(localStorage.getItem('ai_api_key'), 'sk-ant-mine',
      'remembering it is the whole point on your own machine');
  });

  await test('a file:// page counts as local', () => {
    atOrigin('file:///C:/tree/index.html');
    assert.strictEqual(Imp._aiKeyIsLocalOrigin(), true, 'nobody else can serve script to it');
  });

  await test('config.local.js still wins over anything stored', () => {
    clearStores();
    atOrigin('http://localhost/');
    localStorage.setItem('ai_api_key', 'sk-ant-stored');
    window.ANTHROPIC_API_KEY = 'sk-ant-config';
    assert.strictEqual(Imp._aiGetKey(), 'sk-ant-config');
    delete window.ANTHROPIC_API_KEY;
  });

  console.log('\nthe warning about unsaved work');

  atOrigin('http://localhost/');
  const wouldWarn = () => {
    const e = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  await test('a clean file leaves on request', () => {
    state._gedcomDirty = false;
    state._autosaveCaptured = false;
    assert.strictEqual(wouldWarn(), false);
  });

  await test('edits that exist only in this tab are worth interrupting for', () => {
    state._gedcomDirty = true;
    state._autosaveCaptured = false;
    assert.strictEqual(wouldWarn(), true);
  });

  await test('edits the autosave has already caught are not', () => {
    state._gedcomDirty = true;
    state._autosaveCaptured = true;
    assert.strictEqual(wouldWarn(), false,
      'the restore bar offers these back on the next load');
  });

  await test('the autosave sets that flag itself once it has written', async () => {
    state.individuals = new Map();
    state.families = new Map();
    state._autosaveCaptured = false;
    Io._setDirty(true);
    assert.strictEqual(state._autosaveCaptured, false, 'not before the debounced write lands');
    // _autosave() debounces by 2s; this is the one place the real delay matters.
    await new Promise(r => setTimeout(r, 2200));
    assert.strictEqual(state._autosaveCaptured, true, 'and true once it has');
    assert.ok(localStorage.getItem('gedcomAutosave'), 'with something actually stored');
    Io._setDirty(false);
  });
})().then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
