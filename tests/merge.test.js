#!/usr/bin/env node
'use strict';

/**
 * Tests for the import review screen as it actually behaves in a document:
 * approving one row changes the verdict on another, and the other row has to
 * show it. Run with: node merge.test.js
 *
 * Unlike import.test.js, which lifts functions out of the source and runs them
 * against a stand-in state, this drives the real module graph against a real
 * DOM built from index.html, because the thing under test *is* the repainting.
 */

const assert = require('assert');
const { setupDom } = require('./test-setup.js');

setupDom();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Otto and Emma are in the tree and childless. The file being merged says they
// have a daughter, Lena — so Lena is a new person whose only tie to anything
// is the family row sitting next to her in the same review.
function seed(state) {
  state.individuals = new Map([
    ['@I1@', { id:'@I1@', name:'Otto Example', sex:'M', birth:{date:'1900',plac:''}, death:{date:'',plac:''}, note:'', fams:['@F1@'], famc:[] }],
    ['@I2@', { id:'@I2@', name:'Emma Example', sex:'F', birth:{date:'1902',plac:''}, death:{date:'',plac:''}, note:'', fams:['@F1@'], famc:[] }],
  ]);
  state.families = new Map([
    ['@F1@', { id:'@F1@', husb:'@I1@', wife:'@I2@', chil:[], marriages:[{date:'1928',plac:'Central',types:[]}], div:false, divDate:'' }],
  ]);
  return [
    { fullName:'Otto Example', sex:'M', birthDate:'1900', birthPlace:'', deathDate:'', deathPlace:'',
      fatherName:'', motherName:'', notes:'', sourceNote:'s', marriages:[
        { spouseName:'Emma Example', date:'1928', place:'Central', children:[{ fullName:'Lena Example' }] }] },
    { fullName:'Lena Example', sex:'F', birthDate:'1935', birthPlace:'', deathDate:'', deathPlace:'',
      fatherName:'', motherName:'', notes:'', sourceNote:'s', marriages:[] },
  ];
}

(async () => {
  const Imp = await import('../js/import.js');
  const { state } = await import('../js/state.js');
  await new Promise(r => setTimeout(r, 50));

  // jsdom has finished parsing long before the module graph loads, so the
  // module's own DOMContentLoaded wiring would never run. In a browser it does:
  // module scripts are deferred and execute before that event fires.
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  state._importActions = Imp._tiGenerateActions(seed(state));
  Imp._renderImportReview();

  const list  = document.getElementById('import-actions-list');
  const klara = state._importActions.find(a => a.kind === 'person' && a.fields['Name'] === 'Lena Example');
  const marr  = state._importActions.find(a => a.kind === 'marriage');
  assert(klara && marr, 'the fixture produced the two rows the test is about');

  const rowOf  = id => list.querySelector(`tr[data-drow-id="${id}"]`);
  const connOf = id => rowOf(id).querySelector('.import-conn').className.replace('import-conn ', '');
  const click  = (id, status) => rowOf(id).querySelector(`[data-status="${status}"]`)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nimport review: warnings that follow the approvals');

  test('while everything is pending, the preview shows her as connected', () => {
    assert.strictEqual(connOf(klara.id), 'import-conn--ok');
  });

  test('approving her alone says so — the tie is not approved yet', () => {
    click(klara.id, 'approved');
    assert.strictEqual(connOf(klara.id), 'import-conn--pending');
  });

  test('approving the family row clears the warning on her row', () => {
    // The bug this pins: her row is not the row that was clicked.
    click(marr.id, 'approved');
    assert.strictEqual(connOf(klara.id), 'import-conn--ok');
  });

  test('taking that approval back brings the warning straight back', () => {
    click(marr.id, 'approved');   // toggles to pending
    assert.strictEqual(connOf(klara.id), 'import-conn--pending');
  });

  test('skipping the family row leaves her a genuine island, with a way out', () => {
    click(marr.id, 'skipped');
    assert.strictEqual(connOf(klara.id), 'import-conn--warn');
    assert(rowOf(klara.id).querySelector('.import-dbtn--link'), 'the attach button is offered');
  });

  test('the toolbar count tracks it too', () => {
    assert(/import-filter-chip--warn[^>]*>[^<]*<b>1<\/b>/
      .test(document.getElementById('import-summary').innerHTML));
  });

  console.log('\nimport apply: the guard judges what is approved');

  test('applying is refused while the only tie is still unapproved', () => {
    click(marr.id, 'skipped');    // back to pending
    let msg = '';
    global.alert = window.alert = m => { msg = m; };
    Imp.applyImport();
    assert(msg, 'the reader was told');
    assert.strictEqual(state._importFilter, 'unconnected', 'and shown which rows');
    assert.strictEqual(state.families.get('@F1@').chil.length, 0, 'nothing was written');
  });

  test('approving the tie lets it through and the child lands in the family', () => {
    state._importFilter = 'all';
    Imp._renderImportReview();
    click(marr.id, 'approved');
    Imp._tiApplyActions(state._importActions);
    const chil = state.families.get('@F1@').chil.map(id => state.individuals.get(id)?.name);
    assert.deepStrictEqual(chil, ['Lena Example']);
    assert.strictEqual(state.families.size, 1, 'into the existing family, not a copy of it');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
