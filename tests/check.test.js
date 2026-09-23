#!/usr/bin/env node
'use strict';

/**
 * Tests for the data check and for undo/redo.
 * Run with: node check.test.js
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
  const Check = await import('../js/check.js');
  const History = await import('../js/history.js');
  const { state } = await import('../js/state.js');
  await new Promise(r => setTimeout(r, 20));

  const load = lines => {
    const r = GEDCOMModule.parseGEDCOM(lines.join('\n'));
    state.individuals.clear(); state.families.clear();
    for (const [k, v] of r.individuals) state.individuals.set(k, v);
    for (const [k, v] of r.families) state.families.set(k, v);
    state.media = r.media;
  };
  const kinds = () => Check.checkTree().map(i => i.kind);

  console.log('\nthe data check');

  await test('a clean family has nothing to report', () => {
    load(['0 @D@ INDI', '1 NAME Dad /X/', '1 SEX M', '1 BIRT', '2 DATE 1850', '1 DEAT', '2 DATE 1920', '1 FAMS @F@',
          '0 @M@ INDI', '1 NAME Mum /X/', '1 SEX F', '1 BIRT', '2 DATE 1855', '1 FAMS @F@',
          '0 @C@ INDI', '1 NAME Kid /X/', '1 BIRT', '2 DATE 1880', '1 FAMC @F@',
          '0 @F@ FAM', '1 HUSB @D@', '1 WIFE @M@', '1 CHIL @C@', '1 MARR', '2 DATE 1878', '0 TRLR']);
    assert.deepStrictEqual(kinds(), []);
  });

  await test('impossible dates are errors', () => {
    load(['0 @D@ INDI', '1 NAME Dad /X/', '1 SEX M', '1 BIRT', '2 DATE 1850', '1 DEAT', '2 DATE 1840', '1 FAMS @F@',
          '0 @M@ INDI', '1 NAME Mum /X/', '1 SEX F', '1 BIRT', '2 DATE 1855', '1 DEAT', '2 DATE 1870', '1 FAMS @F@',
          '0 @C@ INDI', '1 NAME Kid /X/', '1 BIRT', '2 DATE 1880', '1 FAMC @F@',
          '0 @F@ FAM', '1 HUSB @D@', '1 WIFE @M@', '1 CHIL @C@', '1 MARR', '2 DATE 1845', '0 TRLR']);
    const k = kinds();
    for (const want of ['deathBeforeBirth', 'bornAfterParentDeath', 'marriedBeforeBirth', 'marriedAfterDeath']) {
      assert.ok(k.includes(want), `${want} in ${k}`);
    }
    assert.ok(Check.checkTree().filter(i => i.level === 'error').length >= 4);
  });

  await test('a father may die a few months before the birth', () => {
    load(['0 @D@ INDI', '1 NAME Dad /X/', '1 SEX M', '1 BIRT', '2 DATE 1850', '1 DEAT', '2 DATE 1879', '1 FAMS @F@',
          '0 @C@ INDI', '1 NAME Kid /X/', '1 BIRT', '2 DATE 1880', '1 FAMC @F@',
          '0 @F@ FAM', '1 HUSB @D@', '1 CHIL @C@', '0 TRLR']);
    assert.ok(!kinds().includes('bornAfterParentDeath'));
  });

  await test('somebody who is their own ancestor is found, without overflowing', () => {
    load(['0 @A@ INDI', '1 NAME A /X/', '1 FAMC @F1@', '1 FAMS @F2@',
          '0 @B@ INDI', '1 NAME B /X/', '1 FAMC @F2@', '1 FAMS @F1@',
          '0 @F1@ FAM', '1 HUSB @B@', '1 CHIL @A@', '0 @F2@ FAM', '1 HUSB @A@', '1 CHIL @B@', '0 TRLR']);
    assert.ok(kinds().includes('ownAncestor'));
  });

  await test('namesakes with the same birth year are possible duplicates', () => {
    load(['0 @A@ INDI', '1 NAME Anna /Meier/', '1 BIRT', '2 DATE 1801',
          '0 @B@ INDI', '1 NAME Anna /Meier/', '1 BIRT', '2 DATE ABT 1801',
          '0 @C@ INDI', '1 NAME Anna /Meier/', '1 BIRT', '2 DATE 1850', '0 TRLR']);
    const dups = Check.checkTree().filter(i => i.kind === 'duplicate');
    assert.strictEqual(dups.length, 1);
    assert.deepStrictEqual(dups[0].ids.sort(), ['@A@', '@B@']);
  });

  await test('siblings given the same name are not duplicates', () => {
    load(['0 @A@ INDI', '1 NAME Hans /Meier/', '1 BIRT', '2 DATE 1801', '1 FAMC @F@',
          '0 @B@ INDI', '1 NAME Hans /Meier/', '1 BIRT', '2 DATE 1804', '1 FAMC @F@',
          '0 @F@ FAM', '1 CHIL @A@', '1 CHIL @B@', '0 TRLR']);
    assert.ok(!kinds().includes('duplicate'));
  });

  console.log('\nundo and redo');

  await test('undo puts the tree back and redo takes it forward again', () => {
    load(['0 @A@ INDI', '1 NAME Anna /Meier/', '0 TRLR']);
    History.clearUndo();
    History.onHistoryRestore(() => {});
    History.recordUndo('rename');
    state.individuals.get('@A@').name = 'Changed';
    assert.ok(History.canUndo());
    History.undo();
    assert.strictEqual(state.individuals.get('@A@').name, 'Anna Meier');
    assert.ok(History.canRedo());
    History.redo();
    assert.strictEqual(state.individuals.get('@A@').name, 'Changed');
  });

  await test('a form that is cancelled leaves no step behind', () => {
    load(['0 @A@ INDI', '1 NAME Anna /Meier/', '0 TRLR']);
    History.clearUndo();
    History.beginUndo('edit');
    History.cancelUndo();
    History.commitUndo();
    assert.ok(!History.canUndo());
  });

  await test('a new change clears the redo list', () => {
    load(['0 @A@ INDI', '1 NAME Anna /Meier/', '0 TRLR']);
    History.clearUndo();
    History.recordUndo('one');
    History.undo();
    assert.ok(History.canRedo());
    History.recordUndo('two');
    assert.ok(!History.canRedo());
  });

  await test('media records come back with an undo', () => {
    load(['0 @A@ INDI', '1 NAME Anna /Meier/', '1 OBJE @O1@', '0 @O1@ OBJE', '1 FILE a.jpg', '0 TRLR']);
    History.clearUndo();
    History.recordUndo('remove');
    state.media.delete('@O1@');
    delete state.individuals.get('@A@').media;
    History.undo();
    assert.ok(state.media.has('@O1@'));
    assert.deepStrictEqual(state.individuals.get('@A@').media, ['@O1@']);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
