#!/usr/bin/env node
'use strict';

/**
 * Tests for name autocomplete in the editing forms.
 * Run with: node autocomplete.test.js
 *
 * The point of the change these cover is that the wiring is decided by what a
 * field is, not by a hand-kept list of ids — so the interesting assertion is
 * that a form nobody enumerated still gets it.
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

const p = (id, o = {}) => Object.assign({
  id, name: '', givn: '', surn: '', maidenName: '', sex: 'U',
  birth: { date: '', plac: '' }, death: { date: '', plac: '', caus: '' },
  deceased: false, birthYear: null, famc: [], fams: [], occu: '', note: '', displayName: id,
}, o);

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, 'js', f)).href;
  const panels = await import(url('panels.js'));
  const { state } = await import(url('state.js'));

  state.individuals = new Map([
    ['a', p('a', { givn: 'Hans',       surn: 'Fluri',  occu: 'Bäcker', birth: { plac: 'Luterbach' } })],
    ['b', p('b', { givn: 'Hans Peter', surn: 'Fluri' })],
    ['c', p('c', { givn: 'Anna',       surn: 'Meier',  maidenName: 'Zaugg' })],
    ['d', p('d', { givn: 'Anna',       surn: 'Egger' })],
    ['e', p('e', { givn: 'Anna',       surn: 'Fluri' })],
  ]);
  state.families = new Map();

  console.log('\nwhat gets suggested');

  await test('given names come back commonest first', async () => {
    const names = panels._acGivenNames();
    assert.strictEqual(names[0], 'Anna', `three Annas should lead, got ${names.slice(0, 3)}`);
    assert.ok(names.includes('Hans'));
  });

  await test('a double given name also offers its parts', async () => {
    // "Hans Peter" should be findable by typing either half — a whole-string
    // match would never surface it from "Peter".
    const names = panels._acGivenNames();
    assert.ok(names.includes('Hans Peter'), 'the full name should be offered');
    assert.ok(names.includes('Peter'), 'and so should the second part');
  });

  await test('maiden names are offered as surnames', async () => {
    // They are surnames the tree already knows, and exactly what someone is
    // reaching for when filling in a woman's birth name.
    assert.ok(panels._acSurnames().includes('Zaugg'));
    assert.strictEqual(panels._acSurnames()[0], 'Fluri', 'the commonest surname should lead');
  });

  await test('ties are ordered predictably rather than by chance', async () => {
    const s = panels._acSurnames();
    const ones = s.filter(x => ['Egger', 'Meier', 'Zaugg'].includes(x));
    assert.deepStrictEqual(ones, ['Egger', 'Meier', 'Zaugg'],
      'equal counts should fall back to alphabetical');
  });

  console.log('\nwhich fields get wired');

  const attached = el => el.dataset.acAttached === '1';
  const mount = html => {
    const box = global.document.getElementById('detail-content');
    box.innerHTML = html;
    panels._acAttachFields(box);
    return box;
  };

  await test('the main edit form gets both name fields', async () => {
    const box = mount(`
      <input id="ef-givn"><input id="ef-surn"><input id="ef-maiden">
      <input id="ef-bplac"><input id="ef-dplac"><input id="ef-occu">`);
    for (const id of ['ef-givn', 'ef-surn', 'ef-maiden', 'ef-bplac', 'ef-dplac', 'ef-occu']) {
      assert.ok(attached(box.querySelector('#' + id)), `${id} was not wired`);
    }
  });

  await test('a form nobody listed by id is wired all the same', async () => {
    // Quick-add relative, new partner, new child — none of these were in the old
    // hand-kept list, which is why only the main edit form ever had this.
    const box = mount(`
      <input id="qa-parent-givn"><input id="qa-parent-surn">
      <input id="qa-spouse-givn"><input id="qa-spouse-surn">
      <input id="ef-fnc-givn"><input id="ef-fnc-surn">
      <input id="ef-husb-givn"><input id="ef-husb-surn">
      <input id="ef-np-givn"><input id="ef-np-surn">
      <input id="some-future-form-givn">`);
    for (const el of box.querySelectorAll('input')) {
      assert.ok(attached(el), `${el.id} was not wired`);
    }
  });

  await test('a field that is not a name is left alone', async () => {
    const box = mount('<input id="ef-note"><input id="ef-dcaus"><input id="search-input">');
    for (const el of box.querySelectorAll('input')) {
      assert.ok(!attached(el), `${el.id} should not have autocomplete`);
    }
  });

  await test('attaching twice does not stack listeners', async () => {
    const box = mount('<input id="ef-givn">');
    const el = box.querySelector('#ef-givn');
    let adds = 0;
    const real = el.addEventListener.bind(el);
    el.addEventListener = (...args) => { adds++; real(...args); };
    panels._acAttachFields(box);
    assert.strictEqual(adds, 0, 'an already-wired input must be left as it is');
  });

  console.log('\nrendering a panel wires it');

  await test('writing panel content attaches without a separate call', async () => {
    // The forms arrive by having their HTML written into the panel, so that is
    // the one place that can promise the fields are wired.
    panels._setPanelContent('<input id="ef-givn"><input id="ef-surn">');
    const box = global.document.getElementById('detail-content');
    assert.ok(attached(box.querySelector('#ef-givn')));
    assert.ok(attached(box.querySelector('#ef-surn')));
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
