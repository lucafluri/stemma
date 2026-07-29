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
  // Exponent form too — 40e6 reads better than 40000000 in the source, and a
  // helper that silently returns 40 for it is worse than no helper.
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*([0-9.]+(?:[eE][+-]?[0-9]+)?)`));
  assert(m, `${name} not found in app.js`);
  return Number(m[1]);
}
// The shipped default: first cousins and no further.
const COUSIN_DEGREE = 1;
const ballSrc       = lift('computeFocusSet');
const lineageSrc    = lift('computeLineageSet');
const collateralSrc = lift('_collateralMaxDepth');

// `tree` selects which branch of computeFocusSet runs: the lineage chart set
// or the force view's BFS ball.
function focusSet(individuals, families, focusRootId, focusLimit, tree = false) {
  return new Function(
    'individuals', 'families', 'focusRootId', 'focusLimit', 'useTreeLayout', 'treeLayout', '_revealed', 'cousinDegree',
    `${collateralSrc}\n${lineageSrc}\n${ballSrc}\nreturn computeFocusSet();`
  )(individuals, families, focusRootId, focusLimit, () => tree, tree, new Set(), COUSIN_DEGREE);
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

test('keeps the blood relatives — line, siblings and cousins', () => {
  const { individuals, families } = buildTree();
  const kept = new Set(people(focusSet(individuals, families, 'I3', 100, true)));
  for (const id of ['I3', 'I1', 'I2', 'I14']) {
    assert.ok(kept.has(id), `${id} is direct line and must be kept`);
  }
  const sibs = [...kept].filter(id => /^I(4|5|6|7|8|9|10|11|12)$/.test(id));
  assert.strictEqual(sibs.length, 9, `all 9 siblings belong on the chart, got ${sibs.length}`);
});

test('keeps the spouse of every blood relative, one hop only', () => {
  const { individuals, families } = buildTree();
  const kept = new Set(people(focusSet(individuals, families, 'I3', 100, true)));
  // I13 married the focus person — shown right beside them.
  assert.ok(kept.has('I13'), 'the subject\'s own spouse gets a box next to them');
  // ...and the parents of someone on the chart are both kept, spouses or not.
  assert.ok(kept.has('I1') && kept.has('I2'), 'ancestor couples stay whole');
});

// ── Fixture: three generations of ancestors, one collateral branch at each ──
// GG1+GG2 -> G1, GreatAuntUncle ; G1+G2 -> P1, P1b ; P1+P2 -> I3(focus), Sib
// P1b+P1bSpouse -> Cousin ; Cousin+CousinSpouse -> CousinChild ; I3+I13 -> I14
function buildAncestryFixture() {
  const individuals = new Map();
  const families = new Map();
  const person = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });

  person('GG1', [], ['FGG']);           person('GG2', [], ['FGG']);
  person('G1', ['FGG'], ['FG']);        person('GreatAuntUncle', ['FGG'], []);
  person('G2', [], ['FG']);
  person('P1', ['FG'], ['F1']);         person('P1b', ['FG'], ['FAU']);
  person('P2', [], ['F1']);
  person('I3', ['F1'], ['F3']);         person('Sib', ['F1'], []);
  person('P1bSpouse', [], ['FAU']);
  person('Cousin', ['FAU'], ['FC']);
  person('CousinSpouse', [], ['FC']);
  person('CousinChild', ['FC'], []);
  person('I13', [], ['F3']);            person('I14', ['F3'], []);

  families.set('FGG', { husb: 'GG1', wife: 'GG2', chil: ['G1', 'GreatAuntUncle'] });
  families.set('FG',  { husb: 'G1',  wife: 'G2',  chil: ['P1', 'P1b'] });
  families.set('FAU', { husb: 'P1b', wife: 'P1bSpouse', chil: ['Cousin'] });
  families.set('F1',  { husb: 'P1',  wife: 'P2',  chil: ['I3', 'Sib'] });
  families.set('FC',  { husb: 'Cousin', wife: 'CousinSpouse', chil: ['CousinChild'] });
  families.set('F3',  { husb: 'I3',  wife: 'I13', chil: ['I14'] });
  return { individuals, families };
}

// buildAncestryFixture's person ids don't all start with 'I' (P1, G1, GG1,
// Sib, Cousin...), so use the raw returned set directly instead of the
// 'I'-prefixed people() filter that buildTree()'s fixture relies on.
test('keeps siblings and first cousins', () => {
  const { individuals, families } = buildAncestryFixture();
  const kept = focusSet(individuals, families, 'I3', 100, true);
  for (const id of ['Sib', 'P1b', 'Cousin']) {
    assert.ok(kept.has(id), `${id} is within siblings/first-cousins and must be kept`);
  }
});

test('reaches out to nieces and first cousins by default', () => {
  const { individuals, families } = buildAncestryFixture();
  const kept = focusSet(individuals, families, 'I3', 100, true);
  assert.ok(kept.has('Cousin'), 'a first cousin belongs on the chart');
  assert.ok(kept.has('P1b'), 'and the aunt or uncle they hang from');
});

test('anything past a first cousin is off unless asked for', () => {
  const { individuals, families } = buildAncestryFixture();
  const kept = focusSet(individuals, families, 'I3', 100, true);
  assert.ok(!kept.has('CousinChild'), 'a first cousin\'s child is further than asked for');
  assert.ok(!kept.has('GreatAuntUncle'), 'so is a great-grandparent\'s other child');
});

// ── The cousin-degree option ──
console.log('\n_collateralMaxDepth (how far cousins reach)');

const reach = new Function(`${lift('_collateralMaxDepth')}\nreturn _collateralMaxDepth;`)();

test('the degree maps onto how far each ancestor may fan out', () => {
  // Nth cousins share an ancestor n+1 up and sit n+1 back down from them.
  for (const degree of [0, 1, 2, 3, 4]) {
    for (let gen = 2; gen <= degree + 1; gen++) {
      assert.strictEqual(reach(gen, degree), gen,
        `degree ${degree}: generation ${gen} should fan out ${gen}`);
    }
    assert.strictEqual(reach(degree + 2, degree), 0,
      `degree ${degree}: generation ${degree + 2} is past the cap`);
  }
});

test('siblings and their children are never cut, whatever the degree', () => {
  // Nobody thinks of a nephew as a distant relative, so the parents' branch is
  // not what this option is about.
  for (const degree of [0, 1, 2, 3, 4]) {
    assert.strictEqual(reach(1, degree), 2, `degree ${degree} should still keep nieces and nephews`);
  }
});

test('degree 0 keeps no cousins at all', () => {
  assert.strictEqual(reach(2, 0), 0, 'no aunts, uncles or cousins');
  assert.strictEqual(reach(1, 0), 2, 'but still siblings and their children');
});

test('a wider setting reaches strictly further, never less', () => {
  for (let gen = 1; gen <= 6; gen++) {
    for (let d = 0; d < 4; d++) {
      assert.ok(reach(gen, d + 1) >= reach(gen, d),
        `generation ${gen}: degree ${d + 1} reaches less far than ${d}`);
    }
  }
});

test('turning the option up brings second cousins in', () => {
  const { individuals, families } = buildAncestryFixture();
  const at = degree => new Function(
    'individuals', 'families', 'focusRootId', 'focusLimit', 'useTreeLayout', 'treeLayout', '_revealed', 'cousinDegree',
    `${collateralSrc}\n${lineageSrc}\n${ballSrc}\nreturn computeFocusSet();`
  )(individuals, families, 'I3', 100, () => true, true, new Set(), degree);

  assert.ok(!at(1).has('GreatAuntUncle'), 'hidden at the default');
  assert.ok(at(2).has('GreatAuntUncle'), 'shown once second cousins are asked for');
  // ...and the direct line is never affected by the setting.
  for (const degree of [0, 1, 2, 3]) {
    for (const id of ['P1', 'G1', 'GG1']) {
      assert.ok(at(degree).has(id), `degree ${degree} must keep the ancestor ${id}`);
    }
  }
});

test('keeps the direct ancestor line regardless of collateral distance', () => {
  const { individuals, families } = buildAncestryFixture();
  const kept = focusSet(individuals, families, 'I3', 100, true);
  for (const id of ['P1', 'P2', 'G1', 'G2', 'GG1', 'GG2']) {
    assert.ok(kept.has(id), `${id} is a direct ancestor and must be kept`);
  }
});

test('keeps the one-hop spouse of a collateral relative, not their descendants', () => {
  const { individuals, families } = buildAncestryFixture();
  const kept = focusSet(individuals, families, 'I3', 100, true);
  assert.ok(kept.has('P1bSpouse'), 'an aunt/uncle\'s spouse gets a box beside them');
  assert.ok(kept.has('CousinSpouse'), 'a first cousin\'s spouse gets a box beside them');
});

test('respects the budget', () => {
  const { individuals, families } = buildTree();
  for (const limit of [1, 2, 3, 5, 20]) {
    const n = people(focusSet(individuals, families, 'I3', limit, true)).length;
    assert.ok(n <= limit, `limit ${limit} produced ${n}`);
  }
});

test('the nearest ring is kept when the budget bites', () => {
  const { individuals, families } = buildTree();
  // Parents and the child are one step away; the siblings are two.
  const kept = new Set(people(focusSet(individuals, families, 'I3', 4, true)));
  assert.ok(kept.has('I3') && kept.has('I14'), 'the subject and their child come first');
  assert.ok(kept.has('I1') || kept.has('I2'), 'parents come before siblings');
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
  // The subject's own entry lives in the same map being shifted. Reading f.x
  // live inside the loop zeroes it on the first iteration, after which every
  // other node shifts by 0 and the subject is stranded at the origin on top of
  // whoever was there. Assert the source captures the offset first.
  const centring = src.match(/const f = pos\.get\(subject\);[\s\S]{0,320}?\n  \}/);
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

// ── Layered layout ──
// Y is the generation and nothing else; X is solved as a layered graph. Run the
// real computeTreeLayout with its module state injected and check the finished
// chart against the things a reader actually notices.
console.log('\ncomputeTreeLayout (layered layout)');

const LAYOUT_CONSTS = ['TREE_ROW_H', 'TREE_COL_W', 'TREE_SPOUSE_DX', 'TREE_FAM_DY',
  'TREE_MARK_GAP', 'TREE_GROUP_GAP', 'TREE_ORDER_PASSES', 'TREE_COORD_PASSES',
  'TREE_BUS_UP', 'TREE_LANE_DY', 'TREE_LANE_MIN', 'TREE_MARR_STEP', 'TREE_CHIP_DX', 'TREE_CHIP_DY', 'NODE_BOX_W', 'NODE_BOX_H', 'TREE_BUS_CLEARANCE'];

function layoutOf({ individuals, families, focusRootId, depths }) {
  // Everyone plus every family is on screen; FAM nodes are the bipartite mode.
  const nodes = [...individuals.keys(), ...families.keys()].map(id => ({ id }));
  const args = [individuals, families, focusRootId, nodes,
    () => depths, depths, null, null, () => constOf('FAM_MARKER_MIN'),
    ...LAYOUT_CONSTS.map(constOf)];
  // computeTreeLayout reassigns _treeBusY, so read it back after the call
  // rather than handing in a map and expecting it to have been filled.
  return new Function(
    'individuals', 'families', 'focusRootId', 'nodes',
    'computeGenerationDepths', '_lineageGen', '_treeBusY', '_treeOmitted',
    'famMarkerSize', ...LAYOUT_CONSTS,
    `${lift('_assignBusLanes')}\n${lift('_defaultFocusRoot')}\n${lift('treeAnchorId')}\n${lift('computeTreeLayout')}
     const pos = computeTreeLayout();
     return { pos, busY: _treeBusY };`
  )(...args);
}

// Rows are the invariant everything else gives way to, so every layout fixture
// gets checked for them. `pos` is centred on the subject, so a person's y is
// their generation offset times the row height — exactly, never a fraction.
function assertRowsLineUp(pos, depths, label) {
  const ROW = constOf('TREE_ROW_H');
  const seen = new Map();
  for (const [id, p] of pos) {
    if (!depths.has(id)) continue;   // FAM markers sit between rows by design
    assert.ok(Math.abs(p.y / ROW - Math.round(p.y / ROW)) < 1e-9,
      `${label}: ${id} is at y=${p.y}, not on a row`);
    if (seen.has(p.y)) {
      assert.strictEqual(depths.get(id), seen.get(p.y),
        `${label}: ${id} shares a row with a different generation`);
    } else seen.set(p.y, depths.get(id));
  }
  // ...and no generation is split across two rows.
  const rowFor = new Map();
  for (const [id, p] of pos) {
    if (!depths.has(id)) continue;
    const g = depths.get(id);
    if (rowFor.has(g)) {
      assert.strictEqual(p.y, rowFor.get(g), `${label}: generation ${g} is split across rows`);
    } else rowFor.set(g, p.y);
  }
}

// Boxes in one row must never touch. This is the constraint the coordinate pass
// solves under, so it holds whatever the data does — and, unlike the old block
// layout, it is satisfied without ever moving anybody off their generation.
function assertNoOverlap(pos, isPerson, label) {
  const BOX_W = constOf('NODE_BOX_W');
  const rows = new Map();
  for (const [id, p] of pos) {
    if (!isPerson(id)) continue;
    if (!rows.has(p.y)) rows.set(p.y, []);
    rows.get(p.y).push([id, p.x]);
  }
  for (const [y, list] of rows) {
    list.sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i][1] - list[i - 1][1] >= BOX_W - 1e-6,
        `${label}: row ${y}: ${list[i - 1][0]} and ${list[i][0]} overlap`);
    }
  }
}

// I1+I2 -> I3, I4, I5 ; I3+I13 -> I14, I15 ; I4+I16 -> I17
function buildBlockFixture() {
  const individuals = new Map();
  const families = new Map();
  const person = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const fam = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  person('I1', [], ['F1']);   person('I2', [], ['F1']);
  person('I3', ['F1'], ['F2']); person('I4', ['F1'], ['F3']); person('I5', ['F1']);
  person('I13', [], ['F2']);  person('I16', [], ['F3']);
  person('I14', ['F2']);      person('I15', ['F2']);  person('I17', ['F3']);
  fam('F1', 'I1', 'I2', ['I3', 'I4', 'I5']);
  fam('F2', 'I3', 'I13', ['I14', 'I15']);
  fam('F3', 'I4', 'I16', ['I17']);
  const depths = new Map([['I1', 0], ['I2', 0], ['I3', 1], ['I4', 1], ['I5', 1],
    ['I13', 1], ['I16', 1], ['I14', 2], ['I15', 2], ['I17', 2]]);
  return { individuals, families, focusRootId: 'I3', depths };
}

// The people in a layout fixture, for tests that assert everybody got placed.
const individualsOf = f => [...f.individuals.keys()];

test('everyone of one generation lands on one row', () => {
  const f = buildBlockFixture();
  assertRowsLineUp(layoutOf(f).pos, f.depths, 'block fixture');
});

test('no two boxes in a row overlap', () => {
  const { pos } = layoutOf(buildBlockFixture());
  assertNoOverlap(pos, id => id.startsWith('I'), 'block fixture');
});

test('a couple is drawn side by side', () => {
  const { pos } = layoutOf(buildBlockFixture());
  const COL_W = constOf('TREE_COL_W');
  for (const [a, b] of [['I1', 'I2'], ['I3', 'I13'], ['I4', 'I16']]) {
    assert.ok(Math.abs(pos.get(a).x - pos.get(b).x) <= COL_W + 1e-6,
      `${a} and ${b} are married but ${Math.abs(pos.get(a).x - pos.get(b).x).toFixed(0)}px apart`);
    assert.strictEqual(pos.get(a).y, pos.get(b).y, `${a} and ${b} must be level`);
  }
});

test('a marriage marker sits between the couple and above their children', () => {
  const { pos } = layoutOf(buildBlockFixture());
  for (const [fid, h, w] of [['F1', 'I1', 'I2'], ['F2', 'I3', 'I13'], ['F3', 'I4', 'I16']]) {
    const m = pos.get(fid);
    assert.ok(m.x >= Math.min(pos.get(h).x, pos.get(w).x) - 1e-6 &&
              m.x <= Math.max(pos.get(h).x, pos.get(w).x) + 1e-6,
      `${fid} marker is outside the couple it belongs to`);
    assert.ok(m.y > pos.get(h).y, `${fid} marker must hang below its couple`);
  }
});

// A childless couple: nothing hangs under their marriage, so nothing should be
// left dangling in the band under their row either.
function buildChildlessFixture() {
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('P1', [], ['FP']); p('P2', [], ['FP']);
  p('SUBJ', ['FP'], ['FS']); p('SP', [], ['FS']);
  f('FP', 'P1', 'P2', ['SUBJ']);
  f('FS', 'SUBJ', 'SP', []);
  const depths = new Map([['P1', 0], ['P2', 0], ['SUBJ', 1], ['SP', 1]]);
  return { individuals, families, focusRootId: 'SUBJ', depths };
}

test('a childless marriage sits between the couple, on their own row', () => {
  const { pos } = layoutOf(buildChildlessFixture());
  const m = pos.get('FS'), a = pos.get('SUBJ'), b = pos.get('SP');
  assert.strictEqual(m.y, a.y, 'the marker dropped below a couple it has no children under');
  assert.strictEqual(m.y, b.y);
  assert.ok(m.x > Math.min(a.x, b.x) && m.x < Math.max(a.x, b.x),
    'the marker must sit in the gap between the two, not beside them');
  // And in the gap, not under a box.
  const halfBox = constOf('NODE_BOX_W') / 2;
  for (const q of [a, b]) {
    assert.ok(Math.abs(m.x - q.x) >= halfBox,
      `the marker at x=${m.x} is under the box at x=${q.x}`);
  }
});

test('a marriage that does have children still hangs below the couple', () => {
  // The other half of the rule: the band under the row is for the sibling bar,
  // so a marriage with children on the chart still has to make room for it.
  const { pos } = layoutOf(buildChildlessFixture());
  assert.ok(pos.get('FP').y > pos.get('P1').y,
    'FP has a child on the chart and must keep its place below the couple');
  assert.ok(pos.get('FP').y < pos.get('SUBJ').y,
    'and still above the row that child sits on');
});

test('a couple pushed apart keeps the marker below, not on top of a stranger', () => {
  // The placement only holds while the two are side by side. A marriage that
  // has to reach past somebody cannot put its marker on the row — that space
  // belongs to whoever is sitting between them.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  // M marries A and B, so he sits between them and the A/B marriages reach.
  p('M', [], ['FA', 'FB']); p('A', [], ['FA']); p('B', [], ['FB']);
  p('KA', ['FA']);
  f('FA', 'M', 'A', ['KA']);   // has a child, anchors the chart
  f('FB', 'M', 'B', []);       // childless, but M is beside A too
  const depths = new Map([['M', 0], ['A', 0], ['B', 0], ['KA', 1]]);
  const { pos } = layoutOf({ individuals, families, focusRootId: 'M', depths });

  const m = pos.get('FB');
  const span = Math.abs(pos.get('M').x - pos.get('B').x);
  if (span <= constOf('TREE_COL_W') * 1.2) {
    assert.strictEqual(m.y, pos.get('M').y, 'side by side after all, so it belongs on the row');
  } else {
    assert.ok(m.y > pos.get('M').y, 'a marriage that reaches must stay below the row');
  }
  // Either way it never lands on somebody else's box.
  for (const id of ['M', 'A', 'B']) {
    if (Math.abs(m.y - pos.get(id).y) > 1e-9) continue;
    assert.ok(Math.abs(m.x - pos.get(id).x) >= constOf('NODE_BOX_W') / 2,
      `the FB marker is sitting on ${id}`);
  }
});

test('the husband is drawn on the left', () => {
  const { pos } = layoutOf(buildBlockFixture());
  for (const [h, w] of [['I1', 'I2'], ['I3', 'I13'], ['I4', 'I16']]) {
    assert.ok(pos.get(h).x < pos.get(w).x, `${h} is the husband and belongs left of ${w}`);
  }
});

test('a remarried person is drawn between their spouses', () => {
  // The one case where the husband cannot be left of both his wives — he sits
  // between them instead, which is how a printed chart shows a remarriage, and
  // it is what keeps both marriage lines a single column long.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('W1', [], ['FA']); p('H', [], ['FA', 'FB']); p('W2', [], ['FB']);
  p('K1', ['FA']); p('K2', ['FB']);
  f('FA', 'H', 'W1', ['K1']); f('FB', 'H', 'W2', ['K2']);
  const depths = new Map([['W1', 0], ['H', 0], ['W2', 0], ['K1', 1], ['K2', 1]]);
  const { pos } = layoutOf({ individuals, families, focusRootId: 'H', depths });

  const COL_W = constOf('TREE_COL_W');
  const at = id => pos.get(id).x;
  assert.ok((at('W1') < at('H') && at('H') < at('W2')) ||
            (at('W2') < at('H') && at('H') < at('W1')),
    `H should sit between W1 and W2, got ${['W1', 'H', 'W2'].map(i => i + '@' + Math.round(at(i)))}`);
  for (const [a, b] of [['H', 'W1'], ['H', 'W2']]) {
    assert.ok(Math.abs(at(a) - at(b)) <= COL_W + 1e-6,
      `${a} and ${b} are married but ${Math.abs(at(a) - at(b)).toFixed(0)}px apart`);
  }
  // ...and each marriage keeps its own marker, between the pair it belongs to.
  for (const [fid, a, b] of [['FA', 'H', 'W1'], ['FB', 'H', 'W2']]) {
    const m = pos.get(fid).x;
    assert.ok(m >= Math.min(at(a), at(b)) - 1e-6 && m <= Math.max(at(a), at(b)) + 1e-6,
      `${fid} marker is not between ${a} and ${b}`);
  }
  assert.notStrictEqual(pos.get('FA').x, pos.get('FB').x, 'the two marriages need distinct markers');
});

test('further marriages stack instead of piling onto one line', () => {
  // A person can sit beside at most two of their spouses. The third marriage
  // has to reach past somebody, and its marker then lands under an unrelated
  // box — where it reads as that person's marriage, on the same line as
  // everyone else's. Each marriage that has to reach gets a level of its own.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('H', [], ['F1', 'F2', 'F3']);
  p('W1', [], ['F1']); p('W2', [], ['F2']); p('W3', [], ['F3']);
  const depths = new Map([['H', 0], ['W1', 0], ['W2', 0], ['W3', 0]]);
  [['F1', 'W1', ['A1']], ['F2', 'W2', ['B1']], ['F3', 'W3', ['C1']]].forEach(([fid, w, kids]) => {
    f(fid, 'H', w, kids);
    kids.forEach(k => { p(k, [fid]); depths.set(k, 1); });
  });
  const { pos } = layoutOf({ individuals, families, focusRootId: 'A1', depths });

  const BOX_W = constOf('NODE_BOX_W'), ROW_H = constOf('TREE_ROW_H');
  const rowY = pos.get('H').y;

  for (const [fid, husb, wife] of [['F1', 'H', 'W1'], ['F2', 'H', 'W2'], ['F3', 'H', 'W3']]) {
    const m = pos.get(fid);
    // Still between the two it marries...
    assert.ok(m.x >= Math.min(pos.get(husb).x, pos.get(wife).x) - 1e-6 &&
              m.x <= Math.max(pos.get(husb).x, pos.get(wife).x) + 1e-6,
      `${fid} marker is outside its couple`);
    // ...and never left sitting on the base line under a stranger.
    const strangerAbove = [...pos].some(([id, q]) =>
      individuals.has(id) && id !== husb && id !== wife &&
      Math.abs(q.y - rowY) < 1e-6 && Math.abs(q.x - m.x) < BOX_W / 2);
    if (strangerAbove) {
      assert.ok(m.y > rowY + constOf('TREE_FAM_DY') * ROW_H + 1e-6,
        `${fid} sits under somebody else on the shared line — it needs a level of its own`);
    }
  }

  // The three markers must not all be on one line.
  const levels = new Set(['F1', 'F2', 'F3'].map(fid => Math.round(pos.get(fid).y)));
  assert.ok(levels.size > 1, 'three marriages of one person all drew on the same line');
});

test('the chart lays out with no subject chosen at all', () => {
  // Focus is a filter; the chart is the 2D view whether or not one is set. It
  // used to fall back to the force layout the moment focus was cleared, which
  // made clearing a filter look like switching to a different application.
  const f = buildBlockFixture();
  const { pos } = layoutOf({ ...f, focusRootId: null });
  for (const id of individualsOf(f)) {
    assert.ok(pos.has(id), `${id} must still be placed without a subject`);
  }
  assertRowsLineUp(pos, f.depths, 'unfocused');
  assertNoOverlap(pos, id => id.startsWith('I'), 'unfocused');
});

test('with no subject the chart still anchors on somebody', () => {
  // Something has to decide ordering and centring. Whoever it is, it must be a
  // person actually on the chart — not a stale id, and not nobody.
  const f = buildBlockFixture();
  const { pos } = layoutOf({ ...f, focusRootId: null });
  const xs = [...pos].filter(([id]) => id.startsWith('I')).map(([, p]) => p.x);
  assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 0,
    'the chart should be centred on somebody, so it must straddle the origin');
});

test('a subject who is filtered out does not break the chart', () => {
  // The focus person can be off-screen — a surname filter, a stale selection.
  // The chart must still draw rather than returning nothing.
  const f = buildBlockFixture();
  const { pos } = layoutOf({ ...f, focusRootId: 'I999' });
  assert.ok(pos.size > 0, 'an unknown subject must not blank the chart');
  assertRowsLineUp(pos, f.depths, 'stale subject');
});

test('a couple sitting side by side keeps the plain marker height', () => {
  // Only marriages that have to reach get lifted; the ordinary case must not
  // drift downward, or every chart gains a step it does not need.
  const { pos } = layoutOf(buildBlockFixture());
  const base = (constOf('TREE_FAM_DY')) * constOf('TREE_ROW_H');
  for (const [fid, h, w] of [['F1', 'I1', 'I2'], ['F2', 'I3', 'I13'], ['F3', 'I4', 'I16']]) {
    assert.ok(Math.abs(pos.get(fid).y - (pos.get(h).y + base)) < 1e-6,
      `${fid} was lifted although ${h} and ${w} are already side by side`);
  }
});

test('a sibling bar never rides above the marker it hangs from', () => {
  const { pos, busY } = layoutOf(buildBlockFixture());
  for (const [fid, kid] of [['F1', 'I3'], ['F2', 'I14'], ['F3', 'I17']]) {
    const bar = busY.get(fid);
    assert.ok(bar > pos.get(fid).y, `${fid}: bar ${bar} is above its marker ${pos.get(fid).y}`);
    assert.ok(bar < pos.get(kid).y, `${fid}: bar ${bar} is below its children`);
  }
});

test('parents sit over the children they share', () => {
  const { pos } = layoutOf(buildBlockFixture());
  const mid = (a, b) => (pos.get(a).x + pos.get(b).x) / 2;
  const kids = ['I3', 'I4', 'I5'].map(k => pos.get(k).x);
  const span = [Math.min(...kids), Math.max(...kids)];
  assert.ok(mid('I1', 'I2') >= span[0] && mid('I1', 'I2') <= span[1],
    'I1+I2 should sit within the span of their children');
  assert.ok(Math.abs(mid('I3', 'I13') - mid('I14', 'I15')) < constOf('TREE_COL_W'),
    'I3+I13 should sit near the midpoint of I14 and I15');
});

test('two child bars never share a height where they overlap', () => {
  // Overlapping bars get separate lanes, but a lane cannot rise above the
  // marker its bar hangs from. With a fixed step per lane the top ones all hit
  // that ceiling and collapse back onto one height — overlapping after all,
  // which is the child lines running into each other.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  // Five couples on one row, each with children, so the row needs many lanes.
  const depths = new Map();
  const kids = [];
  for (let i = 0; i < 5; i++) {
    p(`H${i}`, [], [`F${i}`]); p(`W${i}`, [], [`F${i}`]);
    depths.set(`H${i}`, 0); depths.set(`W${i}`, 0);
    const chil = [`K${i}a`, `K${i}b`];
    for (const k of chil) { p(k, [`F${i}`]); depths.set(k, 1); kids.push(k); }
    f(`F${i}`, `H${i}`, `W${i}`, chil);
  }
  const { pos, busY } = layoutOf({ individuals, families, focusRootId: 'K0a', depths });

  const bars = [];
  for (let i = 0; i < 5; i++) {
    const xsAll = [pos.get(`F${i}`).x, pos.get(`K${i}a`).x, pos.get(`K${i}b`).x];
    bars.push({ y: busY.get(`F${i}`), x0: Math.min(...xsAll), x1: Math.max(...xsAll) });
  }
  for (let i = 0; i < bars.length; i++) {
    for (let j = i + 1; j < bars.length; j++) {
      const a = bars[i], b = bars[j];
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (overlap <= 0) continue;
      assert.notStrictEqual(a.y, b.y,
        `two bars overlap by ${overlap.toFixed(0)}px and share height ${a.y}`);
    }
  }
});

test('children of different families are held further apart than siblings', () => {
  const { pos } = layoutOf(buildBlockFixture());
  const COL_W = constOf('TREE_COL_W'), GROUP = constOf('TREE_GROUP_GAP');
  // I14 and I15 are siblings; I17 is from the family next door.
  const sibGap = Math.abs(pos.get('I14').x - pos.get('I15').x);
  const groupGap = Math.min(
    ...['I14', 'I15'].map(s => Math.abs(pos.get(s).x - pos.get('I17').x)));
  assert.ok(sibGap <= COL_W + 1e-6, `siblings should sit a column apart, got ${sibGap.toFixed(0)}`);
  assert.ok(groupGap >= COL_W + GROUP - 1e-6,
    `a different family should be at least ${COL_W + GROUP} away, got ${groupGap.toFixed(0)}`);
});

test('the subject is balanced, not left at the edge', () => {
  const { pos } = layoutOf(buildBlockFixture());
  const xs = [...pos].filter(([id]) => id.startsWith('I')).map(([, p]) => p.x);
  const left = -Math.min(...xs), right = Math.max(...xs);   // pos is centred on I3
  assert.ok(Math.min(left, right) > 0, `nothing on one side: ${left} / ${right}`);
  assert.ok(Math.max(left, right) / Math.min(left, right) < 3,
    `lopsided around the subject: ${left.toFixed(0)} left, ${right.toFixed(0)} right`);
});


// ── Bilateral pedigree ──
// Both of the subject's parents have their own parents and their own collateral
// branches. Only one side can own the parents' couple; the other side's
// ancestry has to hang off the couple as a "wing" or it lays out as a separate
// root tree at the far edge, with its child connector straying right across the
// chart to reach the parent it belongs to.
console.log('\ncomputeTreeLayout (bilateral pedigree)');

//   PGF+PGM -> FA, Uncle          MGF+MGM -> MO, Aunt
//   FA+MO -> Sib1, SUBJ, Sib2     Uncle+UncleW -> Cousin1
//   Aunt+AuntH -> Cousin2         SUBJ+Sp -> Kid
function buildPedigreeFixture() {
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('PGF', [], ['FP']);   p('PGM', [], ['FP']);
  p('MGF', [], ['FM']);   p('MGM', [], ['FM']);
  p('FA', ['FP'], ['FC']);  p('Uncle', ['FP'], ['FU']);  p('UncleW', [], ['FU']);
  p('MO', ['FM'], ['FC']);  p('Aunt', ['FM'], ['FT']);   p('AuntH', [], ['FT']);
  p('Sib1', ['FC']);  p('SUBJ', ['FC'], ['FS']);  p('Sib2', ['FC']);
  p('Cousin1', ['FU']);  p('Cousin2', ['FT']);
  p('Sp', [], ['FS']);   p('Kid', ['FS']);
  f('FP', 'PGF', 'PGM', ['FA', 'Uncle']);   f('FM', 'MGF', 'MGM', ['MO', 'Aunt']);
  f('FC', 'FA', 'MO', ['Sib1', 'SUBJ', 'Sib2']);
  f('FU', 'Uncle', 'UncleW', ['Cousin1']);  f('FT', 'AuntH', 'Aunt', ['Cousin2']);
  f('FS', 'SUBJ', 'Sp', ['Kid']);
  const depths = new Map([['PGF', -2], ['PGM', -2], ['MGF', -2], ['MGM', -2],
    ['FA', -1], ['MO', -1], ['Uncle', -1], ['UncleW', -1], ['Aunt', -1], ['AuntH', -1],
    ['Sib1', 0], ['SUBJ', 0], ['Sib2', 0], ['Cousin1', 0], ['Cousin2', 0], ['Sp', 0],
    ['Kid', 1]]);
  return { individuals, families, focusRootId: 'SUBJ', depths };
}

test('a parent\'s family sits on the side that parent is drawn on', () => {
  const { pos } = layoutOf(buildPedigreeFixture());
  const at = id => pos.get(id).x;
  assert.ok(at('FA') < at('MO'), 'husband is drawn left of wife');
  // ...so the whole paternal side is left of the whole maternal side, row by
  // row. Comparing a grandparent against the mother's own x would be reading
  // too much into it: a grandparent is centred over their children and may land
  // slightly either side of any one of them. Which half of the chart a family
  // occupies is the property that actually reads.
  const sides = [
    [['PGF', 'PGM'], ['MGF', 'MGM']],                    // grandparents
    [['Uncle', 'UncleW'], ['Aunt', 'AuntH']],            // aunts and uncles
    [['Cousin1'], ['Cousin2']],                          // cousins
  ];
  for (const [pat, mat] of sides) {
    const rightmostPaternal = Math.max(...pat.map(at));
    const leftmostMaternal  = Math.min(...mat.map(at));
    assert.ok(rightmostPaternal < leftmostMaternal,
      `paternal ${pat} at ${pat.map(at).map(Math.round)} should all be left of ` +
      `maternal ${mat} at ${mat.map(at).map(Math.round)}`);
  }
  // And the subject's own generation runs paternal cousins, sibship, maternal.
  for (const id of ['Sib1', 'SUBJ', 'Sib2']) {
    assert.ok(at('Cousin1') < at(id) && at(id) < at('Cousin2'),
      `${id} should sit between the two sides of cousins`);
  }
});

test('no connector strays across the chart', () => {
  const { pos, busY } = layoutOf(buildPedigreeFixture());
  const span = Math.max(...[...pos.values()].map(p => p.x)) -
               Math.min(...[...pos.values()].map(p => p.x));
  for (const [fid, fam] of buildPedigreeFixture().families) {
    if (!pos.has(fid)) continue;
    const fx = pos.get(fid).x;
    // A marriage line reaches from a spouse to the marker between the couple:
    // a couple's width, never further. This is the dashed one that used to run
    // the length of the chart when a married-in person got their own root tree.
    for (const s of [fam.husb, fam.wife]) {
      if (!s || !pos.has(s)) continue;
      assert.ok(Math.abs(pos.get(s).x - fx) <= constOf('TREE_SPOUSE_DX'),
        `marriage line ${s}->${fid} reaches ${Math.abs(pos.get(s).x - fx).toFixed(0)}px`);
    }
    // A sibling bar may be wide, but never most of the chart wide.
    const kids = fam.chil.filter(c => pos.has(c));
    if (!kids.length) continue;
    const reach = Math.max(...kids.map(c => Math.abs(pos.get(c).x - fx)));
    assert.ok(reach < span / 2,
      `sibling bar for ${fid} reaches ${reach.toFixed(0)}px of a ${span.toFixed(0)}px chart`);
    assert.ok(busY.get(fid) != null, `${fid} has children but no bar height`);
  }
});

test('married-in ancestry keeps its own generation', () => {
  // The mother's parents belong on the same row as the father's. Deciding a
  // wing's row defensively — hoisting it clear of whatever might be in the way
  // — put every maternal line generations above where it belongs.
  const { pos } = layoutOf(buildPedigreeFixture());
  assert.strictEqual(pos.get('MGF').y, pos.get('PGF').y, 'grandparents share a row');
  assert.strictEqual(pos.get('MGM').y, pos.get('PGM').y);
  assert.strictEqual(pos.get('Aunt').y, pos.get('Uncle').y, 'aunts and uncles share a row');
  assert.strictEqual(pos.get('Cousin2').y, pos.get('Cousin1').y, 'cousins share a row');
});

test('no box is ever drawn on top of another', () => {
  // The blocks nest: a child sits inside its parent's x-interval, a wing inside
  // the interval of the block it hangs off. Nesting is safe only while the two
  // are on different rows, so this is the invariant the row rules exist to hold.
  const { pos } = layoutOf(buildPedigreeFixture());
  const BOX_W = constOf('NODE_BOX_W');
  const rows = new Map();
  for (const [id, p] of pos) {
    if (id.startsWith('F')) continue;
    if (!rows.has(p.y)) rows.set(p.y, []);
    rows.get(p.y).push([id, p.x]);
  }
  for (const [y, list] of rows) {
    list.sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i][1] - list[i - 1][1] >= BOX_W,
        `row ${y}: ${list[i - 1][0]} and ${list[i][0]} boxes overlap`);
    }
  }
});

test('a chain of remarriages is seated side by side', () => {
  // W married H1 and then H2, and H2 had a first wife W2 of his own. All four
  // belong in one row, each next to somebody they married — seating only the
  // person's own spouses strands the far end of the chain in a block of its
  // own with a marriage line reaching back across the chart.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('GP1', [], ['FG']);  p('GP2', [], ['FG']);
  p('W', ['FG'], ['FA', 'FB']);  p('H1', [], ['FA']);  p('H2', [], ['FB', 'FC']);
  p('W2', [], ['FC']);   p('KID', ['FA']);
  f('FG', 'GP1', 'GP2', ['W']);
  f('FA', 'H1', 'W', ['KID']);  f('FB', 'H2', 'W', []);  f('FC', 'H2', 'W2', []);
  const depths = new Map([['GP1', -1], ['GP2', -1], ['W', 0], ['H1', 0], ['H2', 0],
    ['W2', 0], ['KID', 1]]);
  const { pos } = layoutOf({ individuals, families, focusRootId: 'W', depths });

  const COL_W = constOf('TREE_COL_W');
  for (const [a, b] of [['H1', 'W'], ['W', 'H2'], ['H2', 'W2']]) {
    assert.ok(Math.abs(pos.get(a).x - pos.get(b).x) <= COL_W + 0.001,
      `${a} and ${b} are married but ${Math.abs(pos.get(a).x - pos.get(b).x).toFixed(0)}px apart`);
    assert.strictEqual(pos.get(a).y, pos.get(b).y, `${a} and ${b} must share a row`);
  }
});

test('the pedigree balances around the subject', () => {
  const { pos } = layoutOf(buildPedigreeFixture());
  const xs = [...pos].filter(([id]) => id !== 'SUBJ' && !id.startsWith('F'))
    .map(([, p]) => p.x);
  const left = -Math.min(...xs), right = Math.max(...xs);   // pos is centred on SUBJ
  assert.ok(Math.min(left, right) > 0, `nothing on one side: ${left} / ${right}`);
  assert.ok(Math.max(left, right) / Math.min(left, right) < 2,
    `lopsided around the subject: ${left.toFixed(0)} left, ${right.toFixed(0)} right`);
});

// ── Revealing a cut branch ──
console.log('\n_revealed (clicking a "+N" chip)');

function revealSet(individuals, families, focusRootId, focusLimit, revealed) {
  return new Function(
    'individuals', 'families', 'focusRootId', 'focusLimit', 'useTreeLayout', 'treeLayout', '_revealed', 'cousinDegree',
    `${collateralSrc}\n${lineageSrc}\n${ballSrc}\nreturn computeFocusSet();`
  )(individuals, families, focusRootId, focusLimit, () => true, true, revealed, COUSIN_DEGREE);
}

test('a "+N" chip sits at the junction, with nothing drawn to it', () => {
  // The chip marks where a branch was cut, so it belongs at the cut: beside the
  // marriage marker whose other children are missing. Put it anywhere else and
  // it needs a line to say what it belongs to — and every version of that line,
  // in every colour, read as something stray left on the chart.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('H', [], ['F1']); p('W', [], ['F1']);
  p('Shown', ['F1']); p('Hidden1', ['F1']); p('Hidden2', ['F1']);
  f('F1', 'H', 'W', ['Shown', 'Hidden1', 'Hidden2']);
  const depths = new Map([['H', 0], ['W', 0], ['Shown', 1]]);

  // Only H, W and Shown are on screen; the other two children were cut.
  const nodes = ['H', 'W', 'Shown', 'F1'].map(id => ({ id }));
  const r = new Function(
    'individuals', 'families', 'focusRootId', 'nodes',
    'computeGenerationDepths', '_lineageGen', '_treeBusY', '_treeOmitted',
    'famMarkerSize', ...LAYOUT_CONSTS,
    `${lift('_assignBusLanes')}\n${lift('_defaultFocusRoot')}\n${lift('treeAnchorId')}\n${lift('computeTreeLayout')}
     const pos = computeTreeLayout();
     return { pos, omitted: _treeOmitted };`
  )(individuals, families, 'Shown', nodes, () => depths, depths, null, null,
    () => constOf('FAM_MARKER_MIN'), ...LAYOUT_CONSTS.map(constOf));

  const chip = (r.omitted || []).find(o => o.kind === 'children');
  assert.ok(chip, 'a family with cut children must be marked');
  assert.strictEqual(chip.n, 2, 'both hidden children counted');
  assert.deepStrictEqual(chip.hidden.sort(), ['Hidden1', 'Hidden2']);

  // It must be within arm's reach of the marker it belongs to...
  const m = r.pos.get('F1');
  assert.ok(Math.hypot(chip.x - m.x, chip.y - m.y) <= constOf('TREE_COL_W'),
    `chip is ${Math.hypot(chip.x - m.x, chip.y - m.y).toFixed(0)}px from its marker`);
  // ...and carry no anchor, because nothing is drawn to it.
  assert.strictEqual(chip.anchor, undefined, 'a chip at the junction needs no connector');
  assert.strictEqual(chip.bus, undefined);
});

// A cut branch three generations deep, so a chip has something to count past
// the first row: P1+P2 -> SUBJ and HID; HID+HS -> K1, K2; K1+KS -> G1.
function buildDeepBranch() {
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('P1', [], ['FP']); p('P2', [], ['FP']);
  p('SUBJ', ['FP'], []); p('HID', ['FP'], ['FH']);
  p('HS', [], ['FH']);
  p('K1', ['FH'], ['FK']); p('K2', ['FH']);
  p('KS', [], ['FK']); p('G1', ['FK']);
  f('FP', 'P1', 'P2', ['SUBJ', 'HID']);
  f('FH', 'HID', 'HS', ['K1', 'K2']);
  f('FK', 'K1', 'KS', ['G1']);
  return { individuals, families };
}

// Lay out a chart for a subject with a given budget and revealed set, and hand
// back the chips, so a test can click one the way the reader would.
function chipsFor(individuals, families, focusRootId, focusLimit, revealed) {
  const set = new Function(
    'individuals', 'families', 'focusRootId', 'focusLimit', 'useTreeLayout', 'treeLayout', '_revealed', 'cousinDegree', '_lineageGen',
    `${collateralSrc}\n${lineageSrc}\n${ballSrc}
     const s = computeFocusSet(); return { s, gen: _lineageGen };`
  )(individuals, families, focusRootId, focusLimit, () => true, true, revealed, COUSIN_DEGREE, null);

  const r = new Function(
    'individuals', 'families', 'focusRootId', 'nodes',
    'computeGenerationDepths', '_lineageGen', '_treeBusY', '_treeOmitted',
    'famMarkerSize', ...LAYOUT_CONSTS,
    `${lift('_assignBusLanes')}\n${lift('_defaultFocusRoot')}\n${lift('treeAnchorId')}\n${lift('computeTreeLayout')}
     const pos = computeTreeLayout();
     return { pos, omitted: _treeOmitted };`
  )(individuals, families, focusRootId, [...set.s].map(id => ({ id })),
    () => set.gen, set.gen, null, null,
    () => constOf('FAM_MARKER_MIN'), ...LAYOUT_CONSTS.map(constOf));
  return { shown: set.s, chips: r.omitted || [] };
}

test('the count is everyone behind the branch, not just the next row', () => {
  const { individuals, families } = buildDeepBranch();
  // Budget 3 keeps the subject and their parents; the whole HID branch is cut.
  const { shown, chips } = chipsFor(individuals, families, 'SUBJ', 3, new Set());
  for (const id of ['HID', 'HS', 'K1', 'K2', 'KS', 'G1']) {
    assert.ok(!shown.has(id), `${id} should be cut at this budget`);
  }
  const chip = chips.find(c => c.kind === 'children');
  assert.ok(chip, 'the cut branch must be marked');
  // HID, their spouse, both children, that child's spouse, and the grandchild.
  assert.strictEqual(chip.n, 6, 'the whole branch, six people');
  assert.deepStrictEqual(chip.hidden, ['HID'], 'but one click opens only the next row');
});

test('clicking opens one generation and the chip carries the rest', () => {
  const { individuals, families } = buildDeepBranch();
  const revealed = new Set();
  const seen = [];

  for (let click = 0; click < 6; click++) {
    const { shown, chips } = chipsFor(individuals, families, 'SUBJ', 3, revealed);
    const next = chips.filter(c => c.kind === 'children' && c.hidden.some(h => !shown.has(h)));
    if (!next.length) break;
    seen.push(next.reduce((s, c) => s + c.n, 0));
    for (const c of next) for (const h of c.hidden) revealed.add(h);
  }

  // Three rows down the branch, each opened by one click, and the number left
  // behind the chip falls every time.
  assert.ok(seen.length >= 3, `expected at least three steps, got ${seen.length}: ${seen}`);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] < seen[i - 1], `count did not fall: ${seen}`);
  }

  const { shown } = chipsFor(individuals, families, 'SUBJ', 3, revealed);
  for (const id of ['HID', 'HS', 'K1', 'K2', 'KS', 'G1']) {
    assert.ok(shown.has(id), `${id} should have arrived after opening the branch out`);
  }
});

test('a revealed person brings their partner, so the count adds up', () => {
  // The partner arrives with them rather than through the budget-limited pass —
  // otherwise a "+6" can produce five people and the reader is left counting.
  const { individuals, families } = buildDeepBranch();
  const { shown } = chipsFor(individuals, families, 'SUBJ', 3, new Set(['HID']));
  assert.ok(shown.has('HID'));
  assert.ok(shown.has('HS'), 'the partner of a revealed person comes with them');
  assert.ok(!shown.has('G1'), '...but their branch does not open all at once');
});

test('a revealed person already on the chart still brings their partner', () => {
  // Opening a branch twice used to lose people: the entry was skipped whole
  // because the person was already there, which also skipped their partner.
  const { individuals, families } = buildDeepBranch();
  const a = chipsFor(individuals, families, 'SUBJ', 3, new Set(['HID']));
  const b = chipsFor(individuals, families, 'SUBJ', 3, new Set(['HID', 'K1']));
  assert.ok(a.shown.has('HS') && b.shown.has('HS'), 'the partner survives a second open');
  assert.ok(b.shown.has('KS'), 'and the newly opened row brings its own partner');
});

test('a revealed person joins the chart, budget or no budget', () => {
  const { individuals, families } = buildTree();
  const tight = revealSet(individuals, families, 'I3', 4, new Set());
  const cut = [...individuals.keys()].filter(id => !tight.has(id));
  assert.ok(cut.length, 'the fixture must actually cut somebody at this budget');

  const after = revealSet(individuals, families, 'I3', 4, new Set([cut[0]]));
  assert.ok(after.has(cut[0]), 'the person clicked on must appear');
  // ...and brings the family that connects them, or they would float.
  const indi = individuals.get(cut[0]);
  assert.ok([...indi.famc, ...indi.fams].some(f => after.has(f)),
    'a revealed person must arrive connected to something');
});

test('a revealed person gets a generation like everybody else', () => {
  const { individuals, families } = buildTree();
  const gen = new Function(
    'individuals', 'families', 'focusRootId', 'focusLimit', 'useTreeLayout', 'treeLayout', '_revealed', 'cousinDegree', '_lineageGen',
    `${collateralSrc}\n${lineageSrc}\n${ballSrc}
     computeFocusSet(); return _lineageGen;`
  )(individuals, families, 'I3', 4, () => true, true, new Set(['I7']), COUSIN_DEGREE, null);
  assert.ok(gen.has('I7'), 'without a row the layout cannot place them');
  assert.strictEqual(gen.get('I7'), gen.get('I3'), 'a sibling shares the subject\'s row');
});

// ── Generation depth ──
// Depth counts the ancestors above a person, so anyone whose parents are not in
// the file scores 0. For the oldest person on a line that is right; for someone
// who married in it puts them at the top of the chart instead of beside their
// partner.
console.log('\ncomputeGenerationDepths (married-in people)');

const depthsOf = (individuals, families) => new Function(
  'individuals', 'families', '_genDepthsCache', 'GEN_GAP',
  `${lift('computeGenerationDepths')}\nreturn computeGenerationDepths();`
)(individuals, families, null, 28);

// GG -> G -> P -> KID. Each generation marries somebody with no parents on file.
function buildInLawFixture() {
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('GG', [], ['F1']);   p('GGw', [], ['F1']);       // root couple, neither has parents
  p('G', ['F1'], ['F2']); p('Gw', [], ['F2']);       // Gw married in
  p('P', ['F2'], ['F3']); p('Pw', [], ['F3']);       // Pw married in
  p('KID', ['F3']);
  f('F1', 'GG', 'GGw', ['G']);
  f('F2', 'G', 'Gw', ['P']);
  f('F3', 'P', 'Pw', ['KID']);
  return { individuals, families };
}

test('a parent is always exactly one generation above their child', () => {
  // Layering by longest ancestor chain gives every person the depth of the
  // deepest route *to* them, which is not the same as their generation. A man
  // whose own line is recorded two deep, married to a woman whose line runs
  // twelve deep, gets pushed to her level — and his parents are then left ten
  // generations above their own son. Generations follow the relations instead,
  // so each link is worth exactly what it is.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });

  // H's father is the whole of his recorded line; W's runs four deep.
  p('HDad', [], ['FH']); p('H', ['FH'], ['M']);
  p('W4', [], ['FW4']); p('W3', ['FW4'], ['FW3']); p('W2', ['FW3'], ['FW2']);
  p('W1', ['FW2'], ['FW1']); p('W', ['FW1'], ['M']);
  p('KID', ['M']);
  f('FH', 'HDad', null, ['H']);
  f('FW4', 'W4', null, ['W3']); f('FW3', 'W3', null, ['W2']);
  f('FW2', 'W2', null, ['W1']); f('FW1', 'W1', null, ['W']);
  f('M', 'H', 'W', ['KID']);

  const d = depthsOf(individuals, families);
  for (const [, fam] of families) {
    for (const c of fam.chil) {
      for (const q of [fam.husb, fam.wife].filter(Boolean)) {
        assert.strictEqual(d.get(c) - d.get(q), 1,
          `${q} (gen ${d.get(q)}) to ${c} (gen ${d.get(c)}) is ${d.get(c) - d.get(q)} generations`);
      }
    }
  }
  assert.strictEqual(d.get('H'), d.get('W'), 'and the couple is still level');
});

test('every relation is honoured when the data does not contradict itself', () => {
  // The strong form of both rules at once. They can only ever both hold where
  // the file is consistent — a real tree with cousins marrying can state that
  // two people are both the same generation and one above the other, and then
  // something has to give. Where nothing contradicts, nothing should give.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  // Four generations, two branches, every rung a couple, uneven recorded depth.
  p('A', [], ['FA']); p('Aw', [], ['FA']);
  p('B1', ['FA'], ['FB1']); p('B1w', [], ['FB1']);
  p('B2', ['FA'], ['FB2']); p('B2w', [], ['FB2']);
  p('C1', ['FB1'], ['FC1']); p('C1w', [], ['FC1']);
  p('C2', ['FB2']);
  p('D1', ['FC1']);
  f('FA', 'A', 'Aw', ['B1', 'B2']);
  f('FB1', 'B1', 'B1w', ['C1']);
  f('FB2', 'B2', 'B2w', ['C2']);
  f('FC1', 'C1', 'C1w', ['D1']);

  const d = depthsOf(individuals, families);
  let edges = 0, couples = 0;
  for (const [, fam] of families) {
    const par = [fam.husb, fam.wife].filter(x => x && individuals.has(x));
    if (par.length === 2) {
      couples++;
      assert.strictEqual(d.get(par[0]), d.get(par[1]), `couple ${par} split`);
    }
    for (const c of fam.chil) {
      for (const q of par) {
        edges++;
        assert.strictEqual(d.get(c) - d.get(q), 1, `${q} -> ${c} is not one generation`);
      }
    }
  }
  assert.ok(edges >= 6 && couples >= 4, 'the fixture must actually exercise both rules');
  assert.strictEqual(Math.max(...d.values()), 3, 'four generations, numbered 0 to 3');
});

test('a couple is never split across generations', () => {
  // Depth is the longest chain of ancestors above a person, so measured per
  // person a husband whose line is recorded eight deep lands generations away
  // from the wife whose line is recorded three deep. That says nothing about
  // them and everything about how much of each family somebody wrote down.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });

  // H's line is recorded three deep; W's only one deep. They are still a couple.
  p('H3', [], ['FH3']); p('H2', ['FH3'], ['FH2']); p('H1', ['FH2'], ['FH1']);
  p('H', ['FH1'], ['M']);
  p('W1', [], ['FW1']); p('W', ['FW1'], ['M']);
  p('KID', ['M']);
  f('FH3', 'H3', null, ['H2']); f('FH2', 'H2', null, ['H1']); f('FH1', 'H1', null, ['H']);
  f('FW1', 'W1', null, ['W']);
  f('M', 'H', 'W', ['KID']);

  const d = depthsOf(individuals, families);
  assert.strictEqual(d.get('H'), d.get('W'),
    `H is gen ${d.get('H')} and W gen ${d.get('W')} — a married couple shares a generation`);
  assert.ok(d.get('KID') > d.get('H'), 'and their child is still below them');
});

test('couples stay level all the way up a line', () => {
  // Every rung of the fixture is a couple, so a single leveling pass is not
  // enough — the answer has to come out of how generations are measured.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  // Deep line on the husbands' side, nothing recorded on the wives' side.
  let prev = null;
  for (let i = 4; i >= 0; i--) {
    p('H' + i, i === 4 ? [] : ['F' + (i + 1)], ['M' + i]);
    p('W' + i, [], ['M' + i]);
    f('M' + i, 'H' + i, 'W' + i, i ? ['H' + (i - 1)] : []);
    if (prev !== null) f('F' + prev, 'H' + prev, 'W' + prev, ['H' + i]);
    prev = i;
  }
  const d = depthsOf(individuals, families);
  for (let i = 4; i >= 0; i--) {
    assert.strictEqual(d.get('H' + i), d.get('W' + i),
      `rung ${i}: H${i} gen ${d.get('H' + i)} vs W${i} gen ${d.get('W' + i)}`);
  }
});

test('somebody who married in takes their partner\'s generation', () => {
  const { individuals, families } = buildInLawFixture();
  const d = depthsOf(individuals, families);
  assert.strictEqual(d.get('Gw'), d.get('G'), 'Gw married G and belongs beside them');
  assert.strictEqual(d.get('Pw'), d.get('P'), 'Pw married P and belongs beside them');
  assert.ok(d.get('Pw') > d.get('Gw'), 'and the two in-laws are a generation apart');
});

test('a root couple with no parents on either side stays at the top', () => {
  const { individuals, families } = buildInLawFixture();
  const d = depthsOf(individuals, families);
  assert.strictEqual(d.get('GG'), 0);
  assert.strictEqual(d.get('GGw'), 0, 'nobody to defer to — this is a real root');
});

test('inferring a generation never lifts a parent past their own child', () => {
  // The reason the inference is capped. A plain "match your spouse" rule
  // cascades on a tree where cousins marry — the spouse rises, the children get
  // pushed down, their spouses follow, and it comes back around. That inflated
  // a 16-generation file to 37 and left hundreds of children above a parent.
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  // X has no parents. One marriage reaches deep, the other is near the top —
  // matching the deep spouse would drop X below their own child by the other.
  p('A', [], ['FA']); p('A2', ['FA'], ['FB']); p('DEEP', ['FB'], ['FX']);
  p('X', [], ['FX', 'FY']); p('SHALLOW', [], ['FY']); p('KID', ['FY']);
  f('FA', 'A', null, ['A2']); f('FB', 'A2', null, ['DEEP']);
  f('FX', 'DEEP', 'X', []); f('FY', 'SHALLOW', 'X', ['KID']);

  const d = depthsOf(individuals, families);
  for (const [, fam] of families) {
    const par = [fam.husb, fam.wife].filter(q => q && individuals.has(q));
    for (const c of fam.chil) {
      if (!individuals.has(c)) continue;
      for (const q of par) {
        assert.ok(d.get(c) > d.get(q),
          `${c} (gen ${d.get(c)}) must sit below its parent ${q} (gen ${d.get(q)})`);
      }
    }
  }
});

test('the inference cannot add generations to the chart', () => {
  // Runaway shows up as a taller chart than the ancestry actually justifies.
  const { individuals, families } = buildInLawFixture();
  const d = depthsOf(individuals, families);
  assert.strictEqual(Math.max(...d.values()), 3, 'GG → G → P → KID is four levels');
});

// ── Connector routing ──
// A marriage line drawn along the row runs straight through every box between
// its two ends. That is what read as dashes strewn across the chart, and no
// layout can rule it out entirely — a couple the ordering could not seat side
// by side still has to be joined. Routing fixes it instead of hoping.
console.log('\n_linkPath (connector routing)');

const pathFor = (d, tree = true) => new Function(
  'd', 'useTreeLayout', '_treeBusY', 'TREE_ROW_H', 'TREE_FAM_DY', 'TREE_COL_W',
  `${lift('_linkPath')}\nreturn _linkPath(d);`
)(d, () => tree, new Map(), constOf('TREE_ROW_H'), constOf('TREE_FAM_DY'), constOf('TREE_COL_W'));

// Every horizontal run in a path, as [y, x0, x1].
function horizontals(path) {
  const out = [];
  let x = 0, y = 0;
  for (const [, op, arg] of path.matchAll(/([MVHLC])([-\d.,\s]*)/g)) {
    const n = arg.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (op === 'M' || op === 'L') { if (op === 'L') out.push([y, x, n[0]]); [x, y] = n; }
    else if (op === 'V') y = n[0];
    else if (op === 'H') { out.push([y, x, n[0]]); x = n[0]; }
    else if (op === 'C') { x = n[4]; y = n[5]; }
  }
  return out;
}

test('a couple side by side is joined at their own height', () => {
  // The normal case, and by far the most common link on the chart: the marker
  // is half a column away, nothing can be in between, so the line stays on the
  // row. Almost all of it then falls behind the two boxes and what shows is a
  // short bar across the gap. Dropping it into the space below the row instead
  // hangs a visible bracket under every couple — dozens per chart, which is
  // what "dashed lines everywhere" looks like.
  const COL_W = constOf('TREE_COL_W');
  const d = { ltype: 'spouse', source: { x: 0, y: 0, id: 'A' }, target: { x: COL_W / 2, y: 31, id: 'F' } };
  const runs = horizontals(pathFor(d));
  assert.ok(runs.length > 0, 'expected a horizontal run');
  for (const [y] of runs) {
    assert.strictEqual(y, 0, `bar drawn at y=${y}; a short couple should join on the row`);
  }
});

test('a marriage line never runs along the row it starts on', () => {
  const far = { ltype: 'spouse', source: { x: 0, y: 0, id: 'A' }, target: { x: 900, y: 31, id: 'F' } };
  for (const [, x0, x1] of horizontals(pathFor(far))) void [x0, x1];
  for (const [y] of horizontals(pathFor(far))) {
    assert.ok(Math.abs(y - 0) > 1e-9, `marriage line runs along y=0, through the row it leaves`);
  }
});

test('a marriage line between two people on one row still leaves it', () => {
  // Direct mode: no marker between the couple, so both ends are on the row and
  // the bar has to be given a height of its own.
  const d = { ltype: 'spouse', source: { x: 0, y: 0, id: 'A' }, target: { x: 600, y: 0, id: 'B' } };
  const runs = horizontals(pathFor(d));
  assert.ok(runs.length > 0, 'expected a horizontal run');
  for (const [y] of runs) assert.ok(y > 0, `bar drawn at y=${y}, on the row itself`);
});

test('outside the tree view links stay straight', () => {
  const d = { ltype: 'spouse', source: { x: 0, y: 0, id: 'A' }, target: { x: 50, y: 9, id: 'B' } };
  assert.strictEqual(pathFor(d, false), 'M0,0L50,9');
});

// ── Image export ──
// The export itself needs a browser (it clones the live SVG and rasterises it),
// but the sizing decision is arithmetic and is where a big chart goes wrong.
console.log('\n_exportScale (2D image export)');

const exportScale = (w, h) => new Function(
  'w', 'h', 'EXPORT_LONG_EDGE', 'EXPORT_MAX_PIXELS', 'EXPORT_MAX_EDGE',
  `${lift('_exportScale')}\nreturn _exportScale(w, h);`
)(w, h, constOf('EXPORT_LONG_EDGE'), constOf('EXPORT_MAX_PIXELS'), constOf('EXPORT_MAX_EDGE'));

test('a small chart is blown up to the long-edge target', () => {
  const LONG = constOf('EXPORT_LONG_EDGE');
  const s = exportScale(400, 300);
  assert.ok(Math.abs(400 * s - LONG) < 1, `long edge should reach ${LONG}, got ${(400 * s).toFixed(0)}`);
});

test('a chart is not shrunk unless a ceiling forces it', () => {
  const MAXP = constOf('EXPORT_MAX_PIXELS'), MAXE = constOf('EXPORT_MAX_EDGE');
  const w = 5000, h = 3000;
  assert.ok(w * h <= MAXP && Math.max(w, h) <= MAXE, 'fixture must fit inside both ceilings');
  assert.ok(exportScale(w, h) >= 1, 'downscaling would throw away detail already on screen');
});

test('a chart past the ceilings is scaled down rather than failing', () => {
  // The browser enforces these by refusing to allocate, so there is no version
  // of this that both keeps 1:1 and produces a file.
  const MAXE = constOf('EXPORT_MAX_EDGE');
  const s = exportScale(40000, 4000);
  assert.ok(s < 1, 'a chart wider than the dimension cap has to come down');
  assert.ok(40000 * s <= MAXE * 1.001, `width ${(40000 * s).toFixed(0)} still over the ${MAXE} cap`);
});

test('a chart already past the long-edge target is left at 1:1', () => {
  // Upscaling stops at the target, so the two ceilings below never bind while
  // sharpening — at the target even a square export is only 36Mpx. They exist
  // for charts that are already enormous at 1:1, which is the next test.
  assert.strictEqual(exportScale(9000, 1200), 1);
});

test('a chart too big to rasterise is brought under both ceilings', () => {
  const MAXP = constOf('EXPORT_MAX_PIXELS'), MAXE = constOf('EXPORT_MAX_EDGE');
  for (const [w, h] of [[20000, 9000], [9000, 20000], [8000, 8000]]) {
    const s = exportScale(w, h);
    assert.ok(w * h * s * s <= MAXP * 1.001,
      `${w}x${h}: ${((w * h * s * s) / 1e6).toFixed(0)}Mpx exceeds ${(MAXP / 1e6).toFixed(0)}Mpx`);
    assert.ok(Math.max(w, h) * s <= MAXE * 1.001,
      `${w}x${h}: edge ${(Math.max(w, h) * s).toFixed(0)} exceeds ${MAXE}`);
  }
});

test('the ceiling is respected at every aspect ratio', () => {
  const MAXP = constOf('EXPORT_MAX_PIXELS'), MAXE = constOf('EXPORT_MAX_EDGE');
  for (const [w, h] of [[100, 100], [5000, 200], [200, 5000], [30000, 800], [1, 1], [12000, 9000]]) {
    const s = exportScale(w, h);
    assert.ok(Number.isFinite(s) && s > 0, `${w}x${h}: scale is ${s}`);
    assert.ok(w * h * s * s <= MAXP * 1.001, `${w}x${h}: ${(w * h * s * s / 1e6).toFixed(0)}Mpx over ceiling`);
    assert.ok(Math.max(w, h) * s <= MAXE * 1.001, `${w}x${h}: edge ${(Math.max(w, h) * s).toFixed(0)} over cap`);
  }
});

// ── Node box ──
console.log('\nnodeYears (box second line)');

const years = indi => new Function('indi', `${lift('nodeYears')}\nreturn nodeYears(indi);`)(indi);

test('reads a life span, or whichever end is known', () => {
  assert.strictEqual(years({ birthYear: 1901, death: { date: '12 MAR 1978' } }), '1901–1978');
  assert.strictEqual(years({ birthYear: 1901, death: { date: '' } }), '*1901');
  assert.strictEqual(years({ birthYear: null, death: { date: 'ABT 1978' } }), '†1978');
  assert.strictEqual(years({ birthYear: null, death: null }), '');
  assert.strictEqual(years({}), '', 'a record with no dates at all must not throw');
});

test('the box is tall enough for both lines', () => {
  const h = constOf('NODE_BOX_H');
  const name = constOf('NODE_BOX_FONT'), year = constOf('NODE_YEAR_FONT');
  assert.ok(h >= name + year + 6, `NODE_BOX_H ${h} cannot hold ${name}px + ${year}px text`);
  // And the marriage marker must clear the bottom of the box it hangs under.
  assert.ok(constOf('TREE_ROW_H') * constOf('TREE_FAM_DY') > h / 2,
    'the FAM marker sits inside the couple box');
});

// ── Generation band (the two-handle slider) ──
console.log('\ngenerationNumbers / inGenRange (generation band)');

// Everything the band needs, lifted together: the numbering, the test, and the
// setter. The setter reaches for the DOM and a redraw, so both are stubbed —
// what is under test is which band it settles on, not what it repaints.
const genBand = (individuals, families, genRange = null) => new Function(
  'individuals', 'families', '_genDepthsCache', '_genNumbers', 'GEN_GAP', 'genRange',
  `${lift('computeGenerationDepths')}
   ${lift('generationNumbers')}
   ${lift('generationCount')}
   ${lift('inGenRange')}
   ${lift('_genRangePair')}
   const updateGenRangeUI = () => {}, applyFilter = () => {};
   ${lift('setGenRange')}
   ${lift('previewGenRange')}
   const _paintGenRange = () => {};
   return {
     numbers: generationNumbers(),
     count:   generationCount(),
     inRange: id => inGenRange(id),
     set:     (lo, hi) => { setGenRange(lo, hi); return genRange; },
     // A drag must move the label without touching the band behind it.
     drag:    (lo, hi) => { previewGenRange(lo, hi); return genRange; },
   };`
)(individuals, families, null, null, 28, genRange);

// Four generations down one line, so the numbering has somewhere to count from.
function buildLadder() {
  const individuals = new Map();
  const families = new Map();
  const p = (id, famc = [], fams = []) => individuals.set(id, { famc, fams, displayName: id });
  const f = (id, husb, wife, chil) => families.set(id, { husb, wife, chil });
  p('A', [], ['FA']); p('B', ['FA'], ['FB']); p('C', ['FB'], ['FC']); p('D', ['FC']);
  f('FA', 'A', null, ['B']); f('FB', 'B', null, ['C']); f('FC', 'C', null, ['D']);
  return { individuals, families };
}

test('the derived caches are cleared where the data is read, not where one rebuild happens', () => {
  // A structural check, because the bug it guards against is structural. The
  // caches used to be cleared in _fullRebuildGraph(), and the file loader does
  // not call it — it open-codes its own rebuild around buildGraphData(). So a
  // file loaded that way was drawn with whatever depths were cached before it
  // arrived: none, if the app was still empty. The generation slider then had
  // no generations to offer and hid itself, and 3D generation mode had nothing
  // to sort by. buildGraphData() is the one function every path goes through.
  const body = src.match(/function buildGraphData\(\)[\s\S]*?\n\}/)[0];
  for (const cache of ['_genDepthsCache', '_genNumbers', '_estimatedYears']) {
    assert.ok(new RegExp(`${cache}\\s*=\\s*null`).test(body),
      `buildGraphData() must clear ${cache} — a path that skips the clear draws stale generations`);
  }
});

test('generations are numbered from the youngest, not from the oldest ancestor', () => {
  // The reader counts back from themselves. Numbering from the oldest ancestor
  // instead would renumber everybody the moment one more grandparent is found.
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families);
  assert.strictEqual(g.numbers.get('D'), 0, 'the youngest generation is 0');
  assert.strictEqual(g.numbers.get('C'), 1);
  assert.strictEqual(g.numbers.get('B'), 2);
  assert.strictEqual(g.numbers.get('A'), 3, 'and the oldest is the highest');
  assert.strictEqual(g.count, 4);
});

test('a band keeps the generations inside it and drops the rest', () => {
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families, { min: 1, max: 2 });
  assert.strictEqual(g.inRange('C'), true);
  assert.strictEqual(g.inRange('B'), true);
  assert.strictEqual(g.inRange('D'), false, 'below the band');
  assert.strictEqual(g.inRange('A'), false, 'above the band');
});

test('no band means everybody', () => {
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families, null);
  for (const id of ['A', 'B', 'C', 'D']) assert.strictEqual(g.inRange(id), true);
});

test('an id the numbering has never seen is never dropped by the band', () => {
  // The visibility gate is called with whatever id it is handed, including ones
  // that outlived the record behind them. A filter that cannot judge somebody
  // must not be the thing that hides them — the checks after it decide.
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families, { min: 0, max: 0 });
  assert.strictEqual(g.numbers.has('GHOST'), false, 'the fixture must not know this id');
  assert.strictEqual(g.inRange('GHOST'), true);
  // Everyone the numbering *does* know is still judged normally.
  assert.strictEqual(g.inRange('A'), false);
});

test('dragging one handle past the other swaps them instead of collapsing', () => {
  // Two stacked native sliders cannot stop each other, so the pair is sorted.
  // Reading it the other way — clamping the dragged handle — pins the band shut
  // the moment the reader drags through the middle.
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families);
  assert.deepStrictEqual(g.set(3, 1), { min: 1, max: 3 });
});

test('the full span is stored as no band at all', () => {
  // So that loading a deeper file is not silently filtered by the old top end.
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families);
  assert.strictEqual(g.set(0, 3), null, 'a band covering everything is not a band');
  assert.deepStrictEqual(g.set(0, 2), { min: 0, max: 2 });
});

test('dragging a handle does not refilter until it is let go', () => {
  // Refiltering costs over a second on a large file in 3D, and `input` fires
  // on every step of a drag. So the drag only repaints; `change` commits.
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families);
  assert.strictEqual(g.drag(1, 2), null, 'a drag must leave the band alone');
  assert.deepStrictEqual(g.set(1, 2), { min: 1, max: 2 }, 'and the release must apply it');
});

test('a band is clamped to the generations that exist', () => {
  const { individuals, families } = buildLadder();
  const g = genBand(individuals, families);
  assert.deepStrictEqual(g.set(-5, 99), null, 'clamped to the full span, which is no band');
  assert.deepStrictEqual(g.set(2, 99), { min: 2, max: 3 });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
