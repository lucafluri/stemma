#!/usr/bin/env node
'use strict';

/**
 * Tests for the warning about work that exists nowhere else.
 * Run with: node autosave.test.js
 *
 * Whether leaving the page is worth interrupting for depends on whether the
 * autosave has actually caught up, not merely on the file being dirty — so
 * the guard is easy to get wrong in either direction: nagging about work that
 * is already safe, or staying quiet about work that is not.
 */

const assert = require('assert');
const { setupDom } = require('./test-setup.js');

setupDom();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

(async () => {
  const Io = await import('./js/gedcom-io.js');
  const { state } = await import('./js/state.js');
  await new Promise(r => setTimeout(r, 50));
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  const wouldWarn = () => {
    const e = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  console.log('\nthe warning about unsaved work');

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
