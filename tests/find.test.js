#!/usr/bin/env node
'use strict';

/**
 * Tests for the person filter.
 * Run with: node find.test.js
 *
 * The interesting assertions are about what must *not* match: criteria narrow
 * together, an unrecorded date is not a date in range, and the estimated birth
 * years the layout invents never stand in for a recorded one.
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
  id, name: id, givn: '', surn: '', maidenName: '', sex: 'U',
  birth: { date: '', plac: '' }, death: { date: '', plac: '', caus: '' },
  deceased: false, birthYear: null, famc: [], fams: [], occu: '', note: '', displayName: id,
}, o);

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const find = await import(url('find.js'));
  const { state } = await import(url('state.js'));

  const load = (indis, fams = []) => {
    state.individuals = new Map(indis.map(i => [i.id, i]));
    state.families = new Map(fams.map(f => [f.id, f]));
  };
  const ids = c => find.findPeople(c).map(h => h.id);

  console.log('\nmatching on a name');

  await test('a name matches given, family and maiden alike', () => {
    const hans = p('a', { givn: 'Hans', surn: 'Fluri' });
    const anna = p('b', { givn: 'Anna', surn: 'Fluri', maidenName: 'Meier' });
    assert.ok(find.matchPerson(hans, { name: 'fluri' }));
    assert.ok(find.matchPerson(anna, { name: 'meier' }), 'her birth name is a name she has');
    assert.ok(!find.matchPerson(hans, { name: 'meier' }));
  });

  await test('accents and case do not have to be typed', () => {
    const m = p('a', { givn: 'Jürg', surn: 'Müller' });
    assert.ok(find.matchPerson(m, { name: 'muller' }));
    assert.ok(find.matchPerson(m, { name: 'JÜRG' }));
  });

  console.log('\nmatching on a place');

  await test('any recorded place counts, including where they married', () => {
    load(
      [p('a', { birth: { date: '', plac: 'Luterbach' } }),
       p('b', { death: { date: '', plac: 'Bern', caus: '' } }),
       p('c', { fams: ['F1'] }),
       p('d')],
      [{ id: 'F1', husb: 'c', wife: null, chil: [], marriages: [{ date: '', plac: 'Olten' }], div: false, divDate: '' }],
    );
    assert.deepStrictEqual(ids({ place: 'luterbach' }), ['a']);
    assert.deepStrictEqual(ids({ place: 'bern' }), ['b']);
    assert.deepStrictEqual(ids({ place: 'olten' }), ['c'], 'the marriage place is a place too');
  });

  await test('a place matches on part of the name', () => {
    load([p('a', { birth: { date: '', plac: 'Luterbach, Solothurn, Schweiz' } })]);
    assert.deepStrictEqual(ids({ place: 'solothurn' }), ['a']);
  });

  console.log('\nmatching on dates');

  await test('a year range takes the year out of a free-text date', () => {
    load([
      p('a', { birth: { date: '12 MAR 1901', plac: '' } }),
      p('b', { birth: { date: 'ABT 1850', plac: '' } }),
      p('c', { birth: { date: '1799', plac: '' } }),
    ]);
    assert.deepStrictEqual(ids({ bornFrom: 1800, bornTo: 1900 }), ['b']);
    assert.deepStrictEqual(ids({ bornFrom: 1900 }), ['a']);
    assert.deepStrictEqual(ids({ bornTo: 1800 }), ['c']);
  });

  await test('an unrecorded date is not a date inside the range', () => {
    load([p('a', { birth: { date: '', plac: '' } })]);
    assert.deepStrictEqual(ids({ bornFrom: 1800, bornTo: 2000 }), []);
  });

  await test('the estimated birth year is never treated as evidence', () => {
    // birthYear is what the layout guesses to place somebody on the timeline.
    // A filter answering "born before 1850" from guesses reads as a finding.
    load([p('a', { birthYear: 1830, birth: { date: '', plac: '' } })]);
    assert.deepStrictEqual(ids({ bornTo: 1850 }), []);
  });

  await test('a marriage year matches any of the marriages', () => {
    load(
      [p('a', { fams: ['F1', 'F2'] }), p('b', { fams: ['F3'] })],
      [{ id: 'F1', chil: [], marriages: [{ date: '6 JUN 1928', plac: '' }] },
       { id: 'F2', chil: [], marriages: [{ date: '1949', plac: '' }] },
       { id: 'F3', chil: [], marriages: [{ date: '1899', plac: '' }] }],
    );
    assert.deepStrictEqual(ids({ marriedFrom: 1940, marriedTo: 1950 }), ['a']);
    assert.deepStrictEqual(ids({ marriedFrom: 1890, marriedTo: 1900 }), ['b']);
  });

  console.log('\nmatching on sex and status');

  await test('unknown sex is its own answer, not the absence of one', () => {
    load([p('a', { sex: 'M' }), p('b', { sex: 'F' }), p('c')]);
    assert.deepStrictEqual(ids({ sex: 'M' }), ['a']);
    assert.deepStrictEqual(ids({ sex: 'U' }), ['c']);
  });

  await test('living and deceased split the tree between them', () => {
    load([p('a', { deceased: true }), p('b')]);
    assert.deepStrictEqual(ids({ status: 'deceased' }), ['a']);
    assert.deepStrictEqual(ids({ status: 'living' }), ['b']);
  });

  console.log('\ncriteria together');

  await test('every filled-in field has to match, not just one', () => {
    load([
      p('a', { givn: 'Hans', sex: 'M', birth: { date: '1901', plac: 'Bern' } }),
      p('b', { givn: 'Hans', sex: 'M', birth: { date: '1901', plac: 'Basel' } }),
      p('c', { givn: 'Anna', sex: 'F', birth: { date: '1901', plac: 'Bern' } }),
    ]);
    assert.deepStrictEqual(ids({ name: 'hans', place: 'bern', sex: 'M' }), ['a']);
  });

  await test('an empty form is the whole tree, in name order', () => {
    load([p('c', { displayName: 'Zora' }), p('a', { displayName: 'Anna' }), p('b', { displayName: 'Marc' })]);
    assert.deepStrictEqual(ids({}), ['a', 'b', 'c']);
  });

  console.log('\nfinding what is missing');

  await test('people with no birth date are findable as a list', () => {
    load([p('a', { birth: { date: '1901', plac: '' } }), p('b')]);
    assert.deepStrictEqual(ids({ missing: 'birth' }), ['b']);
  });

  await test('a missing death date only counts for the dead', () => {
    // Someone living has no death date and is not an omission.
    load([p('a', { deceased: true }), p('b'), p('c', { deceased: true, death: { date: '1980', plac: '', caus: '' } })]);
    assert.deepStrictEqual(ids({ missing: 'death' }), ['a']);
  });

  await test('the other gaps are findable too', () => {
    load([
      p('a'),
      p('b', { sex: 'F', famc: ['F1'], birth: { date: '', plac: 'Bern' } }),
    ]);
    assert.deepStrictEqual(ids({ missing: 'place' }), ['a']);
    assert.deepStrictEqual(ids({ missing: 'sex' }), ['a']);
    assert.deepStrictEqual(ids({ missing: 'parents' }), ['a']);
  });

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
