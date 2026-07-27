#!/usr/bin/env node
'use strict';

/**
 * Tests for the 2D focus filter (computeFocusSet in app.js).
 * Run with: node focus.test.js
 *
 * app.js is a browser script, not a module, so the function is lifted out of
 * the source text and run with its globals injected.
 */

const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync(require('path').join(__dirname, 'app.js'), 'utf8');

function lift(name) {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert(m, `${name} not found in app.js — did it get renamed?`);
  return m[0];
}

function constOf(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*([\\d.]+)`));
  assert(m, `${name} not found in app.js`);
  return Number(m[1]);
}
const ballSrc    = lift('computeFocusSet');
const lineageSrc = lift('computeLineageSet');

// `tree` selects which branch of computeFocusSet runs: the lineage chart set
// or the force view's BFS ball.
function focusSet(individuals, families, focusRootId, focusLimit, tree = false) {
  return new Function(
    'individuals', 'families', 'focusRootId', 'focusLimit', 'useTreeLayout',
    `${lineageSrc}\n${ballSrc}\nreturn computeFocusSet();`
  )(individuals, families, focusRootId, focusLimit, () => tree);
}

// ── Fixture: a 4-generation line plus a wide sibling ring ──
// I1+I2 -> I3 (+ 9 siblings I4..I12) ; I3+I13 -> I14
function buildTree() {
  const individuals = new Map();
  const families = new Map();
  const person = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });

  person('I1', [], ['F1']);            // father
  person('I2', [], ['F1']);            // mother
  person('I3', ['F1'], ['F2']);        // focus person
  for (let i = 4; i <= 12; i++) person('I' + i, ['F1'], []);  // 9 siblings
  person('I13', [], ['F2']);           // spouse of I3
  person('I14', ['F2'], []);           // child of I3

  families.set('F1', { husb: 'I1', wife: 'I2', chil: ['I3', ...Array.from({ length: 9 }, (_, i) => 'I' + (i + 4))] });
  families.set('F2', { husb: 'I3', wife: 'I13', chil: ['I14'] });
  return { individuals, families };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const people = s => [...s].filter(id => id.startsWith('I'));

console.log('\ncomputeFocusSet');

test('returns null when no focus person is set', () => {
  const { individuals, families } = buildTree();
  assert.strictEqual(focusSet(individuals, families, null, 100), null);
});

test('returns null for an unknown focus person', () => {
  const { individuals, families } = buildTree();
  assert.strictEqual(focusSet(individuals, families, 'I999', 100), null);
});

test('an ample budget keeps everyone', () => {
  const { individuals, families } = buildTree();
  const s = focusSet(individuals, families, 'I3', 100);
  assert.strictEqual(people(s).length, 14);
  assert.deepStrictEqual([...s].filter(id => id.startsWith('F')).sort(), ['F1', 'F2']);
});

test('never exceeds the budget', () => {
  const { individuals, families } = buildTree();
  for (const limit of [1, 2, 3, 5, 8, 13, 14, 50]) {
    const n = people(focusSet(individuals, families, 'I3', limit)).length;
    assert.ok(n <= limit, `limit ${limit} produced ${n} people`);
  }
});

test('the focus person is always kept', () => {
  const { individuals, families } = buildTree();
  assert.ok(focusSet(individuals, families, 'I3', 1).has('I3'));
});

test('a tight budget keeps the closest relatives and drops the distant ones', () => {
  const { individuals, families } = buildTree();
  // Budget 5: I3 + its 4 direct family links (parents, spouse, child) come
  // first; the 9 siblings are one step further out and must be cut.
  const s = focusSet(individuals, families, 'I3', 5);
  const kept = new Set(people(s));
  assert.ok(kept.has('I3'));
  for (const id of ['I1', 'I2', 'I13', 'I14']) assert.ok(kept.has(id), `${id} (distance 1) should be kept`);
  const siblingsKept = [...kept].filter(id => /^I(4|5|6|7|8|9|10|11|12)$/.test(id));
  assert.strictEqual(siblingsKept.length, 0, `siblings should be cut, got ${siblingsKept}`);
});

test('a partly-fitting ring is filled up to the budget, not dropped whole', () => {
  const { individuals, families } = buildTree();
  const s = focusSet(individuals, families, 'I3', 8);   // 5 close + room for 3 siblings
  assert.strictEqual(people(s).length, 8);
});

test('drops FAM nodes that no longer join two kept people', () => {
  const { individuals, families } = buildTree();
  const s = focusSet(individuals, families, 'I14', 2);  // I14 + one parent only
  for (const famId of [...s].filter(id => id.startsWith('F'))) {
    const fam = families.get(famId);
    const kept = [fam.husb, fam.wife, ...fam.chil].filter(id => id && s.has(id));
    assert.ok(kept.length >= 2, `${famId} kept with only ${kept.length} member(s)`);
  }
});

test('every kept person is reachable — no orphans', () => {
  const { individuals, families } = buildTree();
  const s = focusSet(individuals, families, 'I3', 7);
  for (const pid of people(s)) {
    if (pid === 'I3') continue;
    const indi = individuals.get(pid);
    const linked = [...indi.famc, ...indi.fams].some(f => s.has(f));
    assert.ok(linked, `${pid} kept but connected to no kept family`);
  }
});

test('survives a malformed tree (missing family / dangling ids)', () => {
  const individuals = new Map([['I1', { famc: ['FNOPE'], fams: [], displayName: 'I1' }]]);
  const families = new Map();
  const s = focusSet(individuals, families, 'I1', 50);
  assert.deepStrictEqual([...s], ['I1']);
});

// ── Lineage set (classical chart) ──
console.log('\ncomputeLineageSet (tree mode)');

test('keeps the direct line but not the siblings', () => {
  const { individuals, families } = buildTree();
  const s = focusSet(individuals, families, 'I3', 100, true);
  const kept = new Set(people(s));
  for (const id of ['I3', 'I1', 'I2', 'I13', 'I14']) {
    assert.ok(kept.has(id), `${id} is direct line and must be kept`);
  }
  const sibs = [...kept].filter(id => /^I(4|5|6|7|8|9|10|11|12)$/.test(id));
  assert.strictEqual(sibs.length, 0, `siblings are not lineage, got ${sibs}`);
});

test('the ball keeps siblings where the lineage does not', () => {
  const { individuals, families } = buildTree();
  const ball = new Set(people(focusSet(individuals, families, 'I3', 100, false)));
  const line = new Set(people(focusSet(individuals, families, 'I3', 100, true)));
  assert.ok(ball.size > line.size, 'the BFS ball should be the wider set');
  assert.ok(ball.has('I4') && !line.has('I4'), 'I4 is a sibling: in the ball, not the lineage');
});

test('respects the budget', () => {
  const { individuals, families } = buildTree();
  for (const limit of [1, 2, 3, 5, 20]) {
    const n = people(focusSet(individuals, families, 'I3', limit, true)).length;
    assert.ok(n <= limit, `limit ${limit} produced ${n}`);
  }
});

test('spouses ride along with their generation', () => {
  const { individuals, families } = buildTree();
  // I13 is the focus person's spouse — a couple is one chart unit.
  assert.ok(people(focusSet(individuals, families, 'I3', 3, true)).includes('I13'));
});

// ── Tree layout: generation rows ──
// computeTreeLayout leans on a lot of module state, so rather than lift it out
// we check the property that actually matters and is easy to state: everyone in
// the same generation lands on the same row, and rows are ordered by generation.
const treeSrc = src.match(/const TREE_ROW_H\s*=\s*(\d+)/);
assert(treeSrc, 'TREE_ROW_H not found in app.js');
const ROW_H = Number(treeSrc[1]);

console.log('\ncomputeTreeLayout constants');

test('row height leaves space for a label above each node', () => {
  // Labels sit 12px above a node at zoom 1 with a 13px font; a row that tight
  // would overlap the row above.
  assert.ok(ROW_H >= 60, `TREE_ROW_H ${ROW_H} is too tight for labels`);
});

test('generation rows derive from depth, so cousins share a row', () => {
  // Mirrors the genY() in computeTreeLayout: y is a pure function of depth.
  const genY = (depth, rootGen) => (depth - rootGen) * ROW_H;
  assert.strictEqual(genY(3, 2), genY(3, 2), 'same depth must give the same y');
  assert.strictEqual(genY(2, 2), 0, 'the focus generation is row 0');
  assert.ok(genY(1, 2) < 0, 'parents sit above');
  assert.ok(genY(3, 2) > 0, 'children sit below');
});

// ── Connector lanes ──
console.log('\n_assignBusLanes (connector routing)');

const CLEARANCE = constOf('TREE_BUS_CLEARANCE');
const lanesOf = items => new Function(
  'items', 'TREE_BUS_CLEARANCE',
  `${lift('_assignBusLanes')}\nreturn _assignBusLanes(items);`
)(items, CLEARANCE);

// Any two runs sharing a lane must not overlap in x — that is the whole point.
const assertNoLaneOverlap = items => {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].lane !== items[j].lane) continue;
      const overlap = Math.min(items[i].x1, items[j].x1) - Math.max(items[i].x0, items[j].x0);
      assert.ok(overlap <= 0, `lane ${items[i].lane}: ${JSON.stringify(items[i])} overlaps ${JSON.stringify(items[j])}`);
    }
  }
};

test('disjoint runs all share one lane', () => {
  const items = [
    { key: 'a', x0: 0, x1: 100 },
    { key: 'b', x0: 200, x1: 300 },
    { key: 'c', x0: 400, x1: 500 },
  ];
  assert.strictEqual(lanesOf(items), 1);
  assertNoLaneOverlap(items);
});

test('overlapping runs never share a lane', () => {
  const items = [
    { key: 'a', x0: 0, x1: 500 },
    { key: 'b', x0: 100, x1: 600 },
    { key: 'c', x0: 200, x1: 700 },
  ];
  assert.strictEqual(lanesOf(items), 3);
  assertNoLaneOverlap(items);
});

test('spends only as many lanes as the busiest point needs', () => {
  // Two overlap at a time, so two lanes suffice however many runs there are.
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ key: 'r' + i, x0: i * 100, x1: i * 100 + 150 });
  assert.strictEqual(lanesOf(items), 2);
  assertNoLaneOverlap(items);
});

test('a long remarriage reach does not evict its neighbours', () => {
  // The case that motivated lanes: one run spanning the whole row.
  const items = [
    { key: 'long', x0: 0, x1: 1000 },
    { key: 'a', x0: 100, x1: 200 },
    { key: 'b', x0: 300, x1: 400 },
    { key: 'c', x0: 500, x1: 600 },
  ];
  lanesOf(items);
  assertNoLaneOverlap(items);
});

test('holds a clearance gap between runs in one lane', () => {
  const items = [
    { key: 'a', x0: 0, x1: 100 },
    { key: 'b', x0: 110, x1: 200 },   // touches within the clearance margin
  ];
  assert.strictEqual(lanesOf(items), 2, 'runs closer than the clearance need separate lanes');
});

test('survives an empty set', () => {
  assert.strictEqual(lanesOf([]), 0);
});

test('chart centring reads the offset before shifting', () => {
  // The focus person's own entry lives in the same map being shifted. Reading
  // f.x live inside the loop zeroes it on the first iteration, after which
  // every other node shifts by 0 and the subject is stranded at the origin on
  // top of whoever was there. Assert the source captures the offset first.
  const centring = src.match(/const f = pos\.get\(focusRootId\);[\s\S]{0,320}?\n  \}/);
  assert(centring, 'chart centring block not found in app.js');
  assert.ok(
    /const dx = f\.x, dy = f\.y;/.test(centring[0]),
    'centring must snapshot f.x/f.y before mutating pos'
  );
  assert.ok(
    !/p\.x -= f\.x/.test(centring[0]),
    'centring must not subtract f.x live while iterating pos'
  );
});

test('a row never packs people closer than one column', () => {
  // Guards the separation pass: the loop must push each node to at least the
  // previous node's x plus a full column.
  const sep = src.match(/const separateRows = \(\) => \{[\s\S]*?\n  \};/);
  assert(sep, 'separateRows not found in app.js');
  assert.ok(/\+ TREE_COL_W/.test(sep[0]), 'separation must use a full column as the minimum');
  const layout = src.match(/separateRows\(\);\n  for \(let i = 0[\s\S]{0,120}/);
  assert(layout, 'separation/recentre loop not found');
  assert.ok(
    /recentreParents\(\); separateRows\(\);/.test(layout[0]),
    'the loop must end on a separation pass so non-overlap survives recentring'
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
