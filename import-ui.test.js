#!/usr/bin/env node
'use strict';

/**
 * Tests for the import review screen's own UI — the diff table and the filter
 * chips. Run with: node import-ui.test.js
 *
 * merge.test.js covers what the review *decides* (which warnings follow which
 * approvals); import.test.js covers the merge logic underneath. Neither looks
 * at what the screen actually puts on the page, which is the half a reader
 * touches: whether every suggestion gets a row, whether the counts on the
 * chips match the rows they filter to, and whether a name out of an untrusted
 * file can inject markup into the table.
 */

const assert = require('assert');
const { setupDom } = require('./test-setup.js');

setupDom();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Hans and Anna are in the tree, childless. The file being merged gives Hans a
// birthplace he does not have on file (→ an update row), repeats the marriage
// with a daughter the tree lacks (→ a marriage row and a new-person row), and
// adds somebody tied to nobody at all (→ a new-person row that would land
// detached). One of every kind the chips filter by, except 'same'.
function seedTree(state) {
  state.individuals = new Map([
    ['@I1@', { id:'@I1@', name:'Hans Muster', sex:'M', birth:{date:'1900',plac:''}, death:{date:'',plac:''}, note:'', fams:['@F1@'], famc:[] }],
    ['@I2@', { id:'@I2@', name:'Anna Muster', sex:'F', birth:{date:'1902',plac:''}, death:{date:'',plac:''}, note:'', fams:['@F1@'], famc:[] }],
  ]);
  state.families = new Map([
    ['@F1@', { id:'@F1@', husb:'@I1@', wife:'@I2@', chil:[], marriages:[{date:'1928',plac:'Bern',types:[]}], div:false, divDate:'' }],
  ]);
}

const person = (fullName, extra = {}) => ({
  fullName, sex:'', birthDate:'', birthPlace:'', deathDate:'', deathPlace:'',
  fatherName:'', motherName:'', notes:'', sourceNote:'s', marriages:[], ...extra,
});

function parsedFile() {
  return [
    person('Hans Muster', { sex:'M', birthDate:'1900', birthPlace:'Bern', marriages:[
      { spouseName:'Anna Muster', date:'1928', place:'Bern', children:[{ fullName:'Klara Muster' }] }] }),
    person('Klara Muster', { sex:'F', birthDate:'1935' }),
    person('Zzz Island',   { sex:'M', birthDate:'1800' }),
  ];
}

const rows  = () => document.querySelectorAll('.import-diff-table tbody tr').length;
const chips = () => [...document.querySelectorAll('.import-filter-chip')];
const chipByKey = key => chips().find(c => (c.getAttribute('onclick') || '').includes(`'${key}'`));
const chipCount = key => Number(chipByKey(key).querySelector('b').textContent);

(async () => {
  const Imp = await import('./js/import.js');
  const { state } = await import('./js/state.js');
  await new Promise(r => setTimeout(r, 50));

  // jsdom finished parsing long before the module graph loaded, so the
  // module's own DOMContentLoaded wiring would never run. In a browser it
  // does: module scripts are deferred and execute before that event fires.
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  // Every test starts from the same review, unfiltered, in table view.
  const review = (parsed = parsedFile()) => {
    seedTree(state);
    state._importFilter = 'all';
    state._importView = 'table';
    state._importActions = Imp._tiGenerateActions(parsed);
    Imp._renderImportReview();
  };

  console.log('\nthe diff table');

  test('every suggestion gets a row', () => {
    review();
    assert.strictEqual(rows(), state._importActions.length,
      `${state._importActions.length} suggestions should be ${state._importActions.length} rows, got ${rows()}`);
  });

  test('a name out of the imported file cannot inject markup into the table', () => {
    review([person('<img src=x onerror=alert(1)>Evil Muster', { sex:'M' })]);
    const table = document.querySelector('.import-diff-table');
    assert.strictEqual(table.querySelectorAll('img').length, 0, 'the name must not become an element');
    assert.ok(table.textContent.includes('<img src=x'), 'it should still be readable as text');
  });

  console.log('\nthe filter chips');

  test('each chip counts the kind it filters to', () => {
    review();
    // One update (Hans gains a birthplace), one marriage, two new people.
    assert.strictEqual(chipCount('all'), 4, 'all');
    assert.strictEqual(chipCount('new'), 2, 'new');
    assert.strictEqual(chipCount('changed'), 1, 'changed');
    assert.strictEqual(chipCount('marriage'), 1, 'marriage');
    assert.strictEqual(chipCount('same'), 0, 'same');
  });

  test('choosing a chip narrows the table to exactly what it counted', () => {
    review();
    for (const [key, kind] of [['new', 'person'], ['changed', 'update'], ['marriage', 'marriage']]) {
      Imp._imSetFilter(key);
      assert.strictEqual(rows(), chipCount(key), `${key}: rows should match the chip's own count`);
      assert.ok(Imp._imVisibleActions().every(a => a.kind === kind), `${key} should show only ${kind} rows`);
    }
  });

  test('the chosen chip is the one marked on', () => {
    review();
    Imp._imSetFilter('new');
    assert.ok(chipByKey('new').className.includes('import-filter-chip--on'), 'new should be lit');
    assert.ok(!chipByKey('marriage').className.includes('import-filter-chip--on'), 'marriage should not be');
  });

  test('choosing the same chip again goes back to everything', () => {
    review();
    Imp._imSetFilter('new');
    assert.strictEqual(state._importFilter, 'new');
    Imp._imSetFilter('new');
    assert.strictEqual(state._importFilter, 'all', 'a second click should clear the filter');
    assert.strictEqual(rows(), state._importActions.length);
  });

  test('the unconnected chip finds the person who would land detached', () => {
    review();
    assert.strictEqual(chipCount('unconnected'), 1, 'only Zzz Island is tied to nothing');
    Imp._imSetFilter('unconnected');
    const visible = Imp._imVisibleActions();
    assert.strictEqual(visible.length, 1);
    assert.strictEqual(visible[0].fields['Name'], 'Zzz Island');
  });

  test('a filter that matches nothing says so instead of showing an empty table', () => {
    review();
    Imp._imSetFilter('same');   // nothing in this file is identical to the tree
    assert.strictEqual(document.querySelectorAll('.import-diff-table').length, 0, 'no table');
    assert.ok(document.querySelector('.import-empty-filter'), 'an explanation should take its place');
  });

  console.log('\nthe view toggle');

  test('cards view replaces the table rather than adding to it', () => {
    review();
    Imp._imSetView('cards');
    assert.strictEqual(document.querySelectorAll('.import-diff-table').length, 0, 'the table should be gone');
    assert.ok(document.getElementById('import-actions-list').children.length > 0, 'cards should be there');
    Imp._imSetView('table');
    assert.strictEqual(rows(), state._importActions.length, 'and switching back restores the rows');
  });
})().then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
