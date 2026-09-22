#!/usr/bin/env node
'use strict';

/**
 * Tests for editing people without damaging what was there.
 * Run with: node editing.test.js
 *
 *  - the date widget: opening and saving a person must hand every date back
 *    as it was, including the ones the fields cannot show;
 *  - removing a relationship: "not this man's child" must not also take him
 *    away from the mother and from every sibling;
 *  - closing the panel mid-edit must not leave nameless stubs behind;
 *  - finding people by name: ranked, accent-insensitive.
 */

const assert = require('assert');
const { setupDom } = require('./test-setup.js');

setupDom();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); failed++; }
}

(async () => {
  const Io = await import('../js/gedcom-io.js');
  const Panels = await import('../js/panels.js');
  const Search = await import('../js/search.js');
  const { state } = await import('../js/state.js');
  await new Promise(r => setTimeout(r, 20));

  const load = ged => {
    const r = GEDCOMModule.parseGEDCOM(ged);
    state.individuals.clear(); state.families.clear();
    for (const [k, v] of r.individuals) state.individuals.set(k, v);
    for (const [k, v] of r.families) state.families.set(k, v);
    state._dataVersion++;
  };

  // Render one widget into the page and read it straight back.
  const host = document.createElement('div');
  document.body.appendChild(host);
  const widget = value => { host.innerHTML = Io._gedcomDateWidget('w', value); return document.getElementById('w'); };

  console.log('\nthe date widget');

  for (const d of ['12 MAR 1901', 'ABT 1850', 'CAL 1720', 'BET 1850 AND 1860', 'FROM 1914 TO 1918',
                   'FROM MAR 1914', 'TO 1918', '1700/01', '@#DJULIAN@ 1650', 'INT 1900 (census)', 'abt 1850', '']) {
    await test(`"${d}" comes back unchanged when nothing was touched`, () => {
      widget(d);
      assert.strictEqual(Io._gedcomDateValue('w'), d);
    });
  }

  await test('what the fields can hold opens as fields, anything else as text', () => {
    assert.strictEqual(widget('BET 1850 AND 1860').dataset.mode, 'parts');
    assert.strictEqual(widget('1700/01').dataset.mode, 'text');
  });

  await test('a range is built from both dates', () => {
    const el = widget('');
    el.querySelector('.gd-prefix').value = 'BET';
    el.querySelector('.gd-year:not(.gd-year2)').value = '1850';
    el.querySelector('.gd-year2').value = '1860';
    assert.strictEqual(Io._gedcomDateValue('w'), 'BET 1850 AND 1860');
  });

  await test('"between" with only one end is written as the open-ended date it means', () => {
    const el = widget('');
    el.querySelector('.gd-prefix').value = 'BET';
    el.querySelector('.gd-year:not(.gd-year2)').value = '1850';
    assert.strictEqual(Io._gedcomDateValue('w'), 'AFT 1850');
  });

  await test('free text is written as typed', () => {
    const el = widget('');
    Io._gdToggleMode('w');
    el.querySelector('.gd-text').value = '  INT 1900   (per census) ';
    assert.strictEqual(Io._gedcomDateValue('w'), 'INT 1900 (per census)');
  });

  await test('switching to text carries the fields over, and back again', () => {
    const el = widget('ABT 3 MAR 1850');
    Io._gdToggleMode('w');
    assert.strictEqual(el.querySelector('.gd-text').value, 'ABT 3 MAR 1850');
    el.querySelector('.gd-text').value = 'FROM 1900 TO 1910';
    Io._gdToggleMode('w');
    assert.strictEqual(el.dataset.mode, 'parts');
    assert.strictEqual(Io._gedcomDateValue('w'), 'FROM 1900 TO 1910');
  });

  console.log('\nremoving relationships');

  const family = () => load([
    '0 @D@ INDI', '1 NAME Dad /X/', '1 SEX M', '1 FAMS @F1@',
    '0 @M@ INDI', '1 NAME Mum /X/', '1 SEX F', '1 FAMS @F1@',
    '0 @C@ INDI', '1 NAME Child /X/', '1 FAMC @F1@',
    '0 @S@ INDI', '1 NAME Sib /X/', '1 FAMC @F1@',
    '0 @F1@ FAM', '1 HUSB @D@', '1 WIFE @M@', '1 CHIL @C@', '1 CHIL @S@', '1 MARR', '2 DATE 1900',
    '0 TRLR'].join('\n'));

  await test('removing the father keeps the mother, and the siblings keep both parents', () => {
    family();
    Panels._applyRemovedRelations('@C@', [{ type: 'parent', targetId: '@D@', famId: '@F1@' }]);
    const f1 = state.families.get('@F1@');
    assert.strictEqual(f1.husb, '@D@', 'the father is still married to the mother');
    assert.deepStrictEqual(f1.chil, ['@S@'], 'the sibling is still their child');
    const c = state.individuals.get('@C@');
    assert.strictEqual(c.famc.length, 1);
    const single = state.families.get(c.famc[0]);
    assert.strictEqual(single.wife, '@M@');
    assert.strictEqual(single.husb, null);
    assert.ok(single.chil.includes('@C@'));
    assert.ok(state.individuals.get('@M@').fams.includes(single.id), 'both directions of the link agree');
  });

  await test('removing both parents takes the child out of the family and nothing else', () => {
    family();
    Panels._applyRemovedRelations('@C@', [
      { type: 'parent', targetId: '@D@', famId: '@F1@' },
      { type: 'parent', targetId: '@M@', famId: '@F1@' },
    ]);
    assert.deepStrictEqual(state.individuals.get('@C@').famc, []);
    assert.deepStrictEqual(state.families.get('@F1@').chil, ['@S@']);
    assert.strictEqual(state.families.size, 1, 'no single-parent family was invented');
  });

  await test('removing a spouse leaves no one-sided pointer behind', () => {
    family();
    Panels._applyRemovedRelations('@D@', [{ type: 'spouse', targetId: '@M@', famId: '@F1@' }]);
    const f1 = state.families.get('@F1@');
    assert.strictEqual(f1.wife, null);
    assert.ok(!state.individuals.get('@M@').fams.includes('@F1@'));
    assert.strictEqual(f1.husb, '@D@', 'the children stay with the person being edited');
  });

  await test('a childless marriage whose partner is removed goes altogether', () => {
    load(['0 @A@ INDI', '1 FAMS @F1@', '0 @B@ INDI', '1 FAMS @F1@', '0 @F1@ FAM', '1 HUSB @A@', '1 WIFE @B@', '0 TRLR'].join('\n'));
    Panels._applyRemovedRelations('@A@', [{ type: 'spouse', targetId: '@B@', famId: '@F1@' }]);
    assert.strictEqual(state.families.size, 0);
    assert.deepStrictEqual(state.individuals.get('@A@').fams, []);
  });

  await test('nobody becomes their own relative', () => {
    family();
    const before = JSON.stringify([...state.families.values()]);
    Panels._applyRelation('@C@', { targetId: '@C@', type: 'child' });
    assert.strictEqual(JSON.stringify([...state.families.values()]), before);
  });

  console.log('\nnew ids');

  await test('new ids are free and do not rescan from 1 each time', () => {
    family();
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const id = Panels.getNextIndiId();
      assert.ok(!state.individuals.has(id) && !ids.has(id));
      ids.add(id);
      state.individuals.set(id, GEDCOMModule._makeIndi(id));
    }
  });

  console.log('\nclosing the panel mid-edit');

  await test('a new person that was never saved does not stay behind', () => {
    family();
    const n = state.individuals.size;
    Panels.addNewPerson();
    assert.strictEqual(state.individuals.size, n + 1);
    Panels.closeDetailPanel();
    assert.strictEqual(state.individuals.size, n, 'the empty stub is discarded');
    assert.strictEqual(state._editingId, null);
  });

  console.log('\nfinding people');

  await test('whole names rank above partial ones, and accents do not matter', () => {
    load(['0 @A@ INDI', '1 NAME Annalena /Weber/', '0 @B@ INDI', '1 NAME Anna /Müller/',
          '0 @C@ INDI', '1 NAME Hanna /Anders/', '0 TRLR'].join('\n'));
    const hits = Search.searchPeople('anna muller').map(h => h.id);
    assert.deepStrictEqual(hits, ['@B@']);
    const anna = Search.searchPeople('anna').map(h => h.id);
    assert.strictEqual(anna[0], '@B@', 'the one actually called Anna first');
    assert.ok(anna.includes('@A@') && anna.includes('@C@'), 'prefix and substring matches follow');
  });

  await test('a maiden name finds a married woman', () => {
    load(['0 @W@ INDI', '1 NAME Eva /Beispiel/', '2 TYPE birth', '1 NAME Eva /Muster/', '2 TYPE married', '0 TRLR'].join('\n'));
    assert.deepStrictEqual(Search.searchPeople('eva beispiel').map(h => h.id), ['@W@']);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
