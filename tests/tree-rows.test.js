#!/usr/bin/env node
'use strict';

/**
 * Tests for the 2D chart's rows, driven through the real modules.
 * Run with: node tree-rows.test.js
 *
 * focus.test.js already covers computeTreeLayout in depth, but it does so by
 * lifting the function's source and handing it a fixture state — every one of
 * those fixtures sets `_lineageGen: null` by hand. That is exactly the field
 * that was never cleared in the running app, so the whole suite could pass
 * while the shipped chart drew children above their parents.
 *
 * These go through `state` and the real call order instead: build the graph,
 * compute the active set, lay it out. The point is not to re-test the layout
 * maths but to test the thing a fixture cannot — what one operation leaves
 * behind for the next one.
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

/** A straight male line of `n` people, `A0` the eldest. */
function lineage(prefix, n) {
  const lines = [], ids = [];
  for (let i = 0; i < n; i++) {
    const id = `@${prefix}${i}@`;
    ids.push(id);
    lines.push(`0 ${id} INDI`, `1 NAME ${prefix}${i} /${prefix}/`, '1 SEX M');
    if (i > 0) lines.push(`1 FAMC @F${prefix}${i}@`);
    if (i < n - 1) lines.push(`1 FAMS @F${prefix}${i + 1}@`);
  }
  for (let i = 1; i < n; i++) {
    lines.push(`0 @F${prefix}${i}@ FAM`, `1 HUSB ${ids[i - 1]}`, `1 CHIL ${ids[i]}`);
  }
  return { lines, ids };
}

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const { state } = await import(url('state.js'));
  const gd = await import(url('graph-data.js'));
  const tl = await import(url('tree-layout.js'));
  const GED = require('../gedcom.js');

  /** Load a tree and put the app in "classical chart, everybody shown" mode. */
  function load(...parts) {
    const lines = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1'];
    for (const p of parts) lines.push(...p.lines);
    lines.push('0 TRLR');
    const parsed = GED.parseGEDCOM(lines.join('\n'));
    state.individuals = parsed.individuals;
    state.families = parsed.families;
    state.treeLayout = true;
    state.currentView = '2d';
    state.focusRootId = null;
    state.focusLimit = 3;
    state._revealed = new Set();
    gd.buildGraphData();
    gd.computeActiveData();
  }

  const rowsOf = ids => {
    const pos = tl.computeTreeLayout();
    return Object.fromEntries(ids.map(id => [id, pos.get(id)?.y]));
  };

  /** Every child strictly below both of their parents. */
  function assertGenerationOrder(ids, note) {
    const rows = rowsOf(ids);
    for (const [famId, fam] of state.families) {
      for (const child of fam.chil) {
        for (const parent of [fam.husb, fam.wife].filter(Boolean)) {
          assert.ok(rows[parent] < rows[child],
            `${note}: ${child} (row ${rows[child]}) is not below its parent ${parent} (row ${rows[parent]}) in ${famId}`);
        }
      }
    }
  }

  console.log('\nrows with everybody on screen');

  await test('a straight line is drawn one generation per row', async () => {
    const a = lineage('A', 4);
    load(a);
    const rows = rowsOf(a.ids);
    const ys = a.ids.map(id => rows[id]);
    assert.ok(ys.every(y => Number.isFinite(y)), `every person needs a row: ${JSON.stringify(rows)}`);
    for (let i = 1; i < ys.length; i++) {
      assert.ok(ys[i] > ys[i - 1], `${a.ids[i]} should sit below ${a.ids[i - 1]}`);
    }
    const step = ys[1] - ys[0];
    for (let i = 1; i < ys.length; i++) {
      assert.strictEqual(ys[i] - ys[i - 1], step, 'generations should be evenly spaced');
    }
  });

  await test('two unrelated families are each ordered within themselves', async () => {
    const a = lineage('A', 4), b = lineage('B', 4);
    load(a, b);
    assertGenerationOrder([...a.ids, ...b.ids], 'two families');
  });

  console.log('\nafter a focus has been and gone');

  await test('clearing the focus restores the rows the chart started with', async () => {
    // The bug: chart rows are numbered relative to the focus root, and were
    // written but never cleared. Unfocusing left the people the focus had
    // covered on their old rows while everyone else fell back to the
    // whole-tree numbering — two origins in one chart.
    const a = lineage('A', 5), b = lineage('B', 5);
    load(a, b);
    const before = rowsOf([...a.ids, ...b.ids]);

    state.focusRootId = '@A4@';
    gd.computeActiveData();
    assert.ok(state._lineageGen, 'precondition: focusing numbers the rows from the root');

    state.focusRootId = null;
    gd.computeActiveData();
    assert.deepStrictEqual(rowsOf([...a.ids, ...b.ids]), before,
      'the same people with the same filter must land on the same rows');
  });

  await test('no focus means no lineage numbering left lying around', async () => {
    const a = lineage('A', 5);
    load(a);
    state.focusRootId = '@A4@';
    gd.computeActiveData();
    state.focusRootId = null;
    gd.computeActiveData();
    assert.strictEqual(state._lineageGen, null,
      'rows relative to a focus root outlive the focus they belong to');
  });

  await test('a child is never drawn above its parent after a focus session', async () => {
    // The visible symptom, stated the way a reader would notice it.
    const a = lineage('A', 5), b = lineage('B', 5);
    load(a, b);
    state.focusRootId = '@A4@';
    gd.computeActiveData();
    state.focusRootId = null;
    gd.computeActiveData();
    assertGenerationOrder([...a.ids, ...b.ids], 'after unfocusing');
  });

  await test('moving the focus renumbers rather than accumulating', async () => {
    const a = lineage('A', 5), b = lineage('B', 5);
    load(a, b);
    state.focusRootId = '@A4@';
    gd.computeActiveData();
    state.focusRootId = '@B4@';
    gd.computeActiveData();
    for (const id of state._lineageGen.keys()) {
      assert.ok(id.startsWith('@B'), `${id} belongs to the previous focus, not this one`);
    }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
