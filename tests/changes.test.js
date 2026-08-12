#!/usr/bin/env node
'use strict';

/**
 * Tests for the change log.
 * Run with: node changes.test.js
 *
 * The risk here is not that it misses a change — that is obvious the moment
 * anyone looks. It is that it reports changes that did not happen. A log that
 * cries wolf on every save is one nobody reads, and the derived fields on these
 * records (displayName, birthYear) move on their own every time a name is
 * retyped in the same shape.
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

const person = (id, extra = {}) => ({
  id, name: id, givn: id, surn: '', maidenName: '', sex: 'U',
  birth: { date: '', plac: '' },
  death: { date: '', plac: '', caus: '' },
  deceased: false, birthYear: null, famc: [], fams: [], occu: '', note: '', displayName: id,
  ...extra,
});

const family = (id, extra = {}) => ({
  id, husb: null, wife: null, chil: [], marriages: [], div: false, divDate: '', ...extra,
});

const tree = (indis, fams = []) => ({
  individuals: new Map(indis.map(i => [i.id, i])),
  families: new Map(fams.map(f => [f.id, f])),
});

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const changes = await import(url('changes.js'));
  const { state } = await import(url('state.js'));

  const only = d => [...d.people, ...d.families];
  const fieldsOf = (d, label) => {
    const r = only(d).find(x => x.label === label);
    return Object.fromEntries((r?.fields || []).map(f => [f.key, [f.before, f.after]]));
  };

  console.log('\nnothing happened');

  await test('an untouched tree reports no changes at all', async () => {
    const before = tree([person('a', { name: 'Otto Bauer' })], [family('F1')]);
    const after  = tree([person('a', { name: 'Otto Bauer' })], [family('F1')]);
    const d = changes.diffTrees(before, after);
    assert.strictEqual(d.counts.total, 0, JSON.stringify(only(d)));
  });

  await test('derived fields moving on their own is not a change', async () => {
    // displayName and birthYear are recomputed from the name and the birth
    // date. If the diff walked the objects generically, every save would look
    // like an edit to every person who had ever been opened in the editor.
    const before = tree([person('a', { name: 'Otto Bauer', displayName: 'Otto Bauer', birthYear: null })]);
    const after  = tree([person('a', { name: 'Otto Bauer', displayName: 'Otto F.', birthYear: 1820,
                                       _unknown: ['1 SOUR @S1@'] })]);
    assert.strictEqual(changes.diffTrees(before, after).counts.total, 0);
  });

  console.log('\nwhat changed');

  await test('a new person is reported as added, with no field list', async () => {
    const d = changes.diffTrees(tree([]), tree([person('a', { name: 'Otto Bauer' })]));
    assert.deepStrictEqual(d.counts, { added: 1, changed: 0, removed: 0, total: 1 });
    assert.strictEqual(d.people[0].kind, 'added');
    assert.strictEqual(d.people[0].label, 'Otto Bauer');
    assert.strictEqual(d.people[0].fields.length, 0, 'everything about a new person is new');
  });

  await test('a deleted person is reported under the name they had', async () => {
    const d = changes.diffTrees(tree([person('a', { name: 'Otto Bauer' })]), tree([]));
    assert.deepStrictEqual(d.counts, { added: 0, changed: 0, removed: 1, total: 1 });
    assert.strictEqual(d.people[0].kind, 'removed');
    assert.strictEqual(d.people[0].label, 'Otto Bauer');
  });

  await test('an edited field is reported both before and after', async () => {
    const before = tree([person('a', { name: 'Otto', birth: { date: '1820', plac: 'Central' } })]);
    const after  = tree([person('a', { name: 'Otto', birth: { date: '3 JAN 1820', plac: 'Northport' } })]);
    const f = fieldsOf(changes.diffTrees(before, after), 'Otto');
    assert.deepStrictEqual(f.birthDate, ['1820', '3 JAN 1820']);
    assert.deepStrictEqual(f.birthPlace, ['Central', 'Northport']);
    assert.strictEqual(Object.keys(f).length, 2, 'and nothing else');
  });

  await test('clearing a field is a change, not an absence of one', async () => {
    const before = tree([person('a', { occu: 'Craftsman' })]);
    const after  = tree([person('a', { occu: '' })]);
    assert.deepStrictEqual(fieldsOf(changes.diffTrees(before, after), 'a').occupation, ['Craftsman', '']);
  });

  await test('coordinates written onto a place show up as their own change', async () => {
    const before = tree([person('a', { birth: { date: '', plac: 'Central' } })]);
    const after  = tree([person('a', { birth: { date: '', plac: 'Central', map: [46.948, 7.4474] } })]);
    const f = fieldsOf(changes.diffTrees(before, after), 'a');
    assert.deepStrictEqual(f.birthCoords, ['', '46.94800, 7.44740']);
    assert.ok(!f.birthPlace, 'the place itself did not move');
  });

  await test('marking someone deceased reads as a change, not as a blank', async () => {
    const d = changes.diffTrees(tree([person('a')]), tree([person('a', { deceased: true })]));
    assert.deepStrictEqual(fieldsOf(d, 'a').deceased, ['no', 'yes']);
  });

  console.log('\nfamilies');

  await test('relationship changes are named, not listed as xrefs', async () => {
    // "children: Felix → Felix, Nora" is readable; "@I3@ → @I3@, @I4@" is not.
    const people = [
      person('h', { name: 'Otto Bauer' }),
      person('w', { name: 'Emma Weber' }),
      person('c1', { name: 'Felix Bauer' }),
      person('c2', { name: 'Nora Bauer' }),
    ];
    const before = tree(people, [family('F1', { husb: 'h', wife: 'w', chil: ['c1'] })]);
    const after  = tree(people, [family('F1', { husb: 'h', wife: 'w', chil: ['c1', 'c2'] })]);
    const d = changes.diffTrees(before, after);
    assert.strictEqual(d.families[0].label, 'Otto Bauer & Emma Weber');
    assert.deepStrictEqual(fieldsOf(d, 'Otto Bauer & Emma Weber').children,
      ['Felix Bauer', 'Felix Bauer, Nora Bauer']);
  });

  await test('a relationship change is reported once, on the family', async () => {
    // The person's FAMS/FAMC say the same thing from the other end. Reporting
    // both would double every relationship edit in the log.
    const before = tree([person('h', { name: 'Otto', fams: [] })], [family('F1', { husb: null })]);
    const after  = tree([person('h', { name: 'Otto', fams: ['F1'] })], [family('F1', { husb: 'h' })]);
    const d = changes.diffTrees(before, after);
    assert.strictEqual(d.people.length, 0, 'the person record says nothing new');
    assert.deepStrictEqual(fieldsOf(d, 'Otto').husband, ['', 'Otto']);
  });

  await test('a marriage date and place read as one line', async () => {
    const before = tree([], [family('F1', { marriages: [{ date: '', plac: '', types: [] }] })]);
    const after  = tree([], [family('F1', { marriages: [{ date: '1845', plac: 'Central', types: [] }] })]);
    assert.deepStrictEqual(fieldsOf(changes.diffTrees(before, after), 'F1').marriages, ['—', '1845, Central']);
  });

  console.log('\nordering and the baseline');

  await test('additions come first and deletions last', async () => {
    const before = tree([person('gone', { name: 'Gone' }), person('edit', { name: 'Edit' })]);
    const after  = tree([person('edit', { name: 'Edit', occu: 'Craftsman' }), person('new', { name: 'New' })]);
    assert.deepStrictEqual(changes.diffTrees(before, after).people.map(r => r.kind),
      ['added', 'changed', 'removed']);
  });

  await test('no baseline is not the same as no changes', async () => {
    // Before any file is loaded there is nothing to compare against, and
    // reporting "no changes" there would be a claim the app cannot make.
    assert.strictEqual(changes.diffTrees(null, tree([person('a')])), null);
  });

  await test('the baseline is the tree as it stood when it was captured', async () => {
    state.individuals = new Map([['a', person('a', { name: 'Otto', occu: 'Craftsman' })]]);
    state.families = new Map();
    changes.captureBaseline();
    assert.strictEqual(changes.currentChanges().counts.total, 0, 'capturing means "this is now the reference"');

    state.individuals.get('a').occu = 'Schmidt';
    const d = changes.currentChanges();
    assert.strictEqual(d.counts.changed, 1);
    assert.deepStrictEqual(fieldsOf(d, 'Otto').occupation, ['Craftsman', 'Schmidt']);
  });

  await test('the baseline is a copy, not a window onto the live records', async () => {
    // Holding the records themselves would compare each one against itself and
    // report a permanently clean tree, which is the one failure mode that looks
    // exactly like success.
    state.individuals = new Map([['a', person('a', { name: 'Otto', occu: 'Craftsman' })]]);
    state.families = new Map();
    changes.captureBaseline();
    state.individuals.get('a').occu = 'Baker';
    assert.strictEqual(changes.baselineTree().individuals.get('a').occu, 'Craftsman');
  });

  console.log('\nrendering');

  await test('the window shows an edit, and says so plainly when there is none', async () => {
    const body = () => global.document.getElementById('changes-body');
    state.individuals = new Map([['a', person('a', { name: 'Otto Bauer', occu: 'Craftsman' })]]);
    state.families = new Map();
    changes.captureBaseline();

    changes.openChangesTool();
    assert.ok(/nothing|nichts/i.test(body().textContent), `expected an empty state, got: ${body().textContent}`);

    state.individuals.get('a').occu = 'Schmidt';
    changes.refreshChanges();
    const html = body().innerHTML;
    assert.ok(html.includes('Otto Bauer'), 'the person should be named');
    assert.ok(html.includes('Craftsman') && html.includes('Schmidt'), 'both sides belong in the log');

    changes.closeChangesTool();
    const before = body().innerHTML;
    state.individuals.get('a').occu = 'Baker';
    changes.refreshChanges();
    assert.strictEqual(body().innerHTML, before, 'a closed window should not be re-rendered');
  });

  await test('a name cannot inject markup into the log', async () => {
    state.individuals = new Map([['a', person('a', { name: 'A' })]]);
    state.families = new Map();
    changes.captureBaseline();
    state.individuals.get('a').occu = '<img src=x onerror=alert(1)>';
    changes.openChangesTool();
    const body = global.document.getElementById('changes-body');
    assert.strictEqual(body.querySelector('img'), null, 'an occupation must not become markup');
    changes.closeChangesTool();
  });

  console.log('\nfinding the log');

  await test('the log is reachable from the menu you save out of', async () => {
    // It sits in the export dropdown rather than under Tools: what a save would
    // write belongs next to the ways of writing it, behind a button that
    // already announces unsaved work on its own.
    const entry = global.document.querySelector('#export-dropdown .dd-review');
    assert.ok(entry, 'the export dropdown should offer the change log');
    assert.ok(/openChangesTool/.test(entry.getAttribute('onclick')), 'and it should open it');
    assert.strictEqual(global.document.querySelector('#tools-dropdown .dd-review'), null,
      'it should not be in two menus at once');
  });

  await test('unsaved work still marks the button the log now lives behind', async () => {
    const { _setDirty } = await import(url('gedcom-io.js'));
    const btn = global.document.getElementById('dl-btn');
    _setDirty(true);
    assert.ok(btn.classList.contains('has-unsaved'), 'an edit should mark it');
    _setDirty(false);
    assert.ok(!btn.classList.contains('has-unsaved'), 'saving should clear it again');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
