#!/usr/bin/env node
'use strict';

/**
 * Tests for typed date entry (js/dates.js) and the entry-form helpers.
 * Run with: node dates.test.js
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
  const { parseLooseDate: parse } = await import('../js/dates.js');
  const Entry = await import('../js/entry.js');
  const { state } = await import('../js/state.js');
  await new Promise(r => setTimeout(r, 20));

  const v = s => parse(s).value;

  console.log('\nnumeric and written dates');
  const same = {
    '31 JUL 1980': ['31.7.1980', '31/7/1980', '1980-07-31', '1980/7/31', '31 July 1980', '31. Juli 1980', 'Jul 31, 1980', 'july 31st 1980', ' 31  jul  1980 '],
    'JUL 1980': ['7.1980', '07/1980', 'July 1980', 'Juli 1980', '1980-07'],
    '1980': ['1980'],
    '5 MAR 1850': ['5. März 1850', '5 maerz 1850', '5.3.1850'],
    '3 MAY 1900': ['3 mai 1900', '3 May 1900'],
  };
  for (const [want, inputs] of Object.entries(same)) {
    for (const i of inputs) await test(`"${i}" is ${want}`, () => assert.deepStrictEqual(parse(i), { ok: true, value: want }));
  }

  await test('slashes with an impossible month are read month-first', () => {
    assert.strictEqual(v('7/31/1980'), '31 JUL 1980');
    assert.strictEqual(v('12/11/1980'), '12 NOV 1980', 'ambiguous: day first');
  });

  console.log('\nqualifiers and ranges');
  const q = {
    'ABT 1900': ['um 1900', 'ca. 1900', 'ca 1900', 'about 1900', 'circa 1900', '~1900', 'abt 1900'],
    'BEF 1900': ['vor 1900', 'before 1900', 'bef. 1900'],
    'AFT 1900': ['nach 1900', 'after 1900'],
    'EST 1900': ['est 1900', 'geschätzt 1900'],
    'CAL 1720': ['cal 1720'],
    'BET 1850 AND 1860': ['1850-1860', '1850 – 1860', 'zwischen 1850 und 1860', 'between 1850 and 1860'],
    'FROM 1900 TO 1910': ['von 1900 bis 1910', 'from 1900 to 1910'],
    'ABT 3 MAR 1850': ['ABT 3 MAR 1850', 'um 3.3.1850'],
  };
  for (const [want, inputs] of Object.entries(q)) {
    for (const i of inputs) await test(`"${i}" is ${want}`, () => assert.deepStrictEqual(parse(i), { ok: true, value: want }));
  }

  console.log('\nwhat is left alone');
  for (const odd of ['INT 1900 (census)', '1700/01', '@#DJULIAN@ 1650', 'x', '31.2.1980', '29.2.1900', '13.13.1980', '1980-07-45']) {
    await test(`"${odd}" is kept as typed`, () => assert.deepStrictEqual(parse(odd), { ok: false, value: odd }));
  }
  await test('a leap day is accepted in a leap year only', () => {
    assert.strictEqual(v('29.2.2000'), '29 FEB 2000');
    assert.strictEqual(parse('29.2.1900').ok, false);
  });
  await test('empty is fine and empty', () => assert.deepStrictEqual(parse('  '), { ok: true, value: '' }));
  await test('a word that merely starts like a qualifier is not one', () => {
    assert.strictEqual(parse('umbrella 1900').ok, false);
  });

  console.log('\nsex from the first name');
  const person = (id, givn, sex) => state.individuals.set(id, { id, givn, sex, name: givn, famc: [], fams: [], birth: {}, death: {} });
  state.individuals.clear();
  await test('a name the tree knows is guessed', () => {
    person('@1@', 'Anna', 'F'); person('@2@', 'Anna Maria', 'F'); person('@3@', 'Hans', 'M'); person('@4@', 'Hans Peter', 'M');
    state._dataVersion = (state._dataVersion || 0) + 1;
    assert.strictEqual(Entry.guessSex('Anna'), 'F');
    assert.strictEqual(Entry.guessSex('hans peter'), 'M', 'first name counts');
  });
  await test('an unknown or mixed name is not guessed', () => {
    person('@5@', 'Alex', 'M'); person('@6@', 'Alex', 'F');
    state._dataVersion++;
    assert.strictEqual(Entry.guessSex('Alex'), '');
    assert.strictEqual(Entry.guessSex('Zebediah'), '');
    assert.strictEqual(Entry.guessSex(''), '');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
