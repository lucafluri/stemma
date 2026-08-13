#!/usr/bin/env node
'use strict';

/**
 * Tests for js/settings.js — the one table every persisted setting goes
 * through. Run with: node settings.test.js
 *
 * Three of these guard things that were live bugs before the registry existed:
 * a stored value that is out of range must not reach the renderer (a zero in
 * scene3d empties the 3D view with no way back), a reset must not take the
 * autosaved GEDCOM with it, and settings written by the *old* scattered code
 * must still read back — an existing install upgrading to this must not have
 * its tuned setup silently reset.
 */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { setupDom } = require('./test-setup.js');

setupDom();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const S = await import(url('settings.js'));
  const { SCENE_DEFAULTS, NODE_COLOR_DEFAULTS } = await import(url('constants.js'));

  const clear = () => { S.resetSettings(); localStorage.removeItem('gedcomAutosave'); };

  console.log('\nreading and writing');

  await test('a setting with nothing stored reads as its default', async () => {
    clear();
    assert.strictEqual(S.readSetting('focusLimit'), 120);
    assert.strictEqual(S.readSetting('treeLayout'), true);
    assert.strictEqual(S.readSetting('stratify3D'), 'time');
    assert.deepStrictEqual(S.readSetting('scene3d'), SCENE_DEFAULTS);
  });

  await test('what is written is what is read back', async () => {
    clear();
    S.writeSetting('focusLimit', 300);
    S.writeSetting('treeLayout', false);
    S.writeSetting('stratify3D', 'generation');
    S.writeSetting('nodeColors', { ...NODE_COLOR_DEFAULTS, male: '#123456' });
    assert.strictEqual(S.readSetting('focusLimit'), 300);
    assert.strictEqual(S.readSetting('treeLayout'), false);
    assert.strictEqual(S.readSetting('stratify3D'), 'generation');
    assert.strictEqual(S.readSetting('nodeColors').male, '#123456');
  });

  await test('the default is a fresh copy, so editing one does not move it', async () => {
    clear();
    const a = S.readSetting('scene3d');
    a.maxNodes = 1;
    assert.strictEqual(S.readSetting('scene3d').maxNodes, SCENE_DEFAULTS.maxNodes,
      'the next reader must not see the last one\'s edits');
  });

  console.log('\nvalues that should never reach the renderer');

  await test('a corrupt object entry costs only the keys that are bad', async () => {
    clear();
    // The whole point of merging key by key: one bad number must not throw
    // away a scene the reader spent time tuning.
    localStorage.setItem('scene3d', JSON.stringify({ maxNodes: 9000, drawMax: 'lots', detailMax: -5 }));
    const v = S.readSetting('scene3d');
    assert.strictEqual(v.maxNodes, 9000, 'the good key survives');
    assert.strictEqual(v.drawMax, SCENE_DEFAULTS.drawMax, 'a string is not a budget');
    assert.strictEqual(v.detailMax, SCENE_DEFAULTS.detailMax, 'nor is a negative one');
  });

  await test('unparseable JSON falls back whole', async () => {
    clear();
    localStorage.setItem('nodeColors', '{not json');
    assert.deepStrictEqual(S.readSetting('nodeColors'), NODE_COLOR_DEFAULTS);
  });

  await test('a string outside the allowed set falls back', async () => {
    clear();
    localStorage.setItem('stratify3D', 'sideways');
    assert.strictEqual(S.readSetting('stratify3D'), 'time');
    localStorage.setItem('viewMode', '4d');
    assert.strictEqual(S.readSetting('viewMode'), '3d');
  });

  await test('a number outside its declared range falls back', async () => {
    clear();
    localStorage.setItem('famNodeSize', '-3');
    assert.strictEqual(S.readSetting('famNodeSize'), 7);
    localStorage.setItem('focusLimit', 'plenty');
    assert.strictEqual(S.readSetting('focusLimit'), 120);
  });

  console.log('\nsettings written by the code this replaced');

  await test("a boolean stored as '1'/'0' still reads", async () => {
    clear();
    localStorage.setItem('treeLayout', '0');
    assert.strictEqual(S.readSetting('treeLayout'), false);
    localStorage.setItem('includeSpouseFamily', '1');
    assert.strictEqual(S.readSetting('includeSpouseFamily'), true);
  });

  await test("...and one stored as 'true'/'false' does too", async () => {
    // colorBySurname was the odd one out: written with String(bool).
    clear();
    localStorage.setItem('colorBySurname', 'false');
    assert.strictEqual(S.readSetting('colorBySurname'), false);
    localStorage.setItem('colorBySurname', 'true');
    assert.strictEqual(S.readSetting('colorBySurname'), true);
  });

  console.log('\nreset, export and import');

  await test('reset clears the settings and leaves the data alone', async () => {
    clear();
    S.writeSetting('focusLimit', 400);
    localStorage.setItem('gedcomAutosave', '{"ged":"0 HEAD"}');
    localStorage.setItem('placeCoords', '{"bern":[46.9,7.4]}');
    S.resetSettings();
    assert.strictEqual(S.readSetting('focusLimit'), 120, 'the setting is gone');
    assert.ok(localStorage.getItem('gedcomAutosave'), 'the unsaved tree is NOT');
    assert.ok(localStorage.getItem('placeCoords'), 'nor is the geocode cache');
  });

  await test('export then import round-trips', async () => {
    clear();
    S.writeSetting('focusLimit', 250);
    S.writeSetting('mapDotColor', '#00ff00');
    const bag = S.exportSettings();
    S.resetSettings();
    assert.strictEqual(S.readSetting('focusLimit'), 120);
    S.importSettings(bag);
    assert.strictEqual(S.readSetting('focusLimit'), 250);
    assert.strictEqual(S.readSetting('mapDotColor'), '#00ff00');
  });

  await test('import ignores keys the registry does not own', async () => {
    clear();
    const n = S.importSettings({ focusLimit: 200, gedcomAutosave: 'nice try', nonsense: 1 });
    assert.strictEqual(n, 1, 'only the one real setting counts');
    assert.strictEqual(localStorage.getItem('gedcomAutosave'), null,
      'an imported file must not be able to write outside the registry');
  });

  await test('import of something that is not a settings bag does nothing', async () => {
    clear();
    assert.strictEqual(S.importSettings(null), 0);
    assert.strictEqual(S.importSettings([1, 2, 3]), 0);
    assert.strictEqual(S.importSettings('hello'), 0);
  });

  console.log('\na browser with storage switched off');

  await test('nothing throws when localStorage does', async () => {
    // Safari's private mode. state.js read localStorage at module scope, so a
    // throw here used to take down the whole module graph and show a blank page.
    const real = global.localStorage;
    global.localStorage = new Proxy({}, { get() { throw new Error('SecurityError'); } });
    try {
      assert.strictEqual(S.lsGet('anything'), null);
      assert.strictEqual(S.lsSet('anything', 'x'), false);
      S.lsRemove('anything');
      assert.strictEqual(S.readSetting('focusLimit'), 120, 'and reading gives the default');
      S.writeSetting('focusLimit', 999);
    } finally {
      global.localStorage = real;
    }
  });

  clear();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
