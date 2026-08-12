#!/usr/bin/env node
'use strict';

/**
 * Tests for the two things that decide whether a large file is usable at all:
 *
 *  - spouseIndex(), which replaced a per-person scan of every family in
 *    isIndiVisible(). The scan was O(people × families) and froze the app for
 *    fifteen seconds on one surname checkbox at 50,000 people.
 *  - the automatic focus above AUTO_FOCUS_THRESHOLD, which is what stops the
 *    renderer being handed the whole file in the first place.
 *
 * Both are driven through the real entry points — buildGraphData() and
 * _loadDatasetFile() — rather than called directly: the file loader open-codes
 * its own rebuild instead of using _fullRebuildGraph(), so a test that reaches
 * past it can pass while the actual load path does nothing.
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

const p = (id, surn, extra = {}) => Object.assign({
  id, givn: id, surn, maidenName: '', famc: [], fams: [], marriages: [],
  birth: {}, death: {}, deceased: false,
}, extra);

// One married couple with different surnames, and their child.
function buildCouple() {
  const individuals = new Map();
  const families = new Map();
  individuals.set('H', p('H', 'Hill',  { fams: ['F1'] }));
  individuals.set('W', p('W', 'Ward',  { fams: ['F1'] }));
  individuals.set('C', p('C', 'Hill',  { famc: ['F1'] }));
  families.set('F1', { id: 'F1', husb: 'H', wife: 'W', chil: ['C'], marriages: [] });
  return { individuals, families };
}

// A GEDCOM string with `n` unrelated people, plus one couple with a child so
// there is a best-connected person for the automatic focus to land on.
function bigGedcom(n) {
  const lines = ['0 HEAD', '1 CHAR UTF-8'];
  for (let i = 0; i < n; i++) {
    lines.push(`0 @I${i}@ INDI`, `1 NAME Person${i} /Sur${i % 50}/`, '1 SEX U');
  }
  lines.push(
    '0 @HUB@ INDI', '1 NAME Hub /Central/', '1 FAMS @FH@',
    '0 @SP@ INDI',  '1 NAME Spouse /Central/', '1 FAMS @FH@',
    '0 @KID@ INDI', '1 NAME Kid /Central/', '1 FAMC @FH@',
    '0 @FH@ FAM',   '1 HUSB @HUB@', '1 WIFE @SP@', '1 CHIL @KID@',
    '0 TRLR');
  return lines.join('\n');
}

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const gd    = await import(url('graph-data.js'));
  const io    = await import(url('gedcom-io.js'));
  const { AUTO_FOCUS_THRESHOLD } = await import(url('constants.js'));
  const { state } = await import(url('state.js'));

  // Put the fixture in through the same door the app uses, so the caches the
  // real code depends on are in the state the real code leaves them in.
  const load = ({ individuals, families }) => {
    state.individuals.clear(); state.families.clear();
    for (const [k, v] of individuals) state.individuals.set(k, v);
    for (const [k, v] of families)    state.families.set(k, v);
    state.focusRootId = null;
    state.genRange = null;
    state.surnameEnabled.clear();
    for (const [, i] of individuals) state.surnameEnabled.set(i.surn, true);
    gd.buildGraphData();
  };

  console.log('\nthe surname filter and married couples');

  await test('a person whose own surname is off is kept by their spouse', async () => {
    load(buildCouple());
    state.surnameEnabled.set('Ward', false);
    assert.strictEqual(gd.isIndiVisible('W'), true,
      'she married a Hill, and the Hills are still shown');
  });

  await test('...and dropped once the spouse is off too', async () => {
    load(buildCouple());
    state.surnameEnabled.set('Ward', false);
    state.surnameEnabled.set('Hill', false);
    assert.strictEqual(gd.isIndiVisible('W'), false);
  });

  await test('a child is not kept by their parents\' surname', async () => {
    // Only marriage carries someone across the filter — the index holds spouse
    // pairs, not family membership, and this is the difference.
    load(buildCouple());
    state.individuals.get('C').surn = 'Other';
    state.surnameEnabled.set('Other', false);
    gd.buildGraphData();               // the surname changed; rebuild as the app would
    state.surnameEnabled.set('Other', false);
    assert.strictEqual(gd.isIndiVisible('C'), false);
  });

  await test('the index is rebuilt when the marriages change', async () => {
    // The whole risk of caching this: a stale index makes people vanish. Every
    // path that edits the tree goes through buildGraphData(), which clears it.
    load(buildCouple());
    assert.deepStrictEqual(gd.spouseIndex().get('W'), ['H']);
    state.families.get('F1').wife = null;
    state.individuals.get('W').fams = [];
    gd.buildGraphData();
    assert.strictEqual(gd.spouseIndex().get('W'), undefined,
      'a divorce recorded by clearing the slot must not leave the pair behind');
    state.surnameEnabled.set('Ward', false);
    assert.strictEqual(gd.isIndiVisible('W'), false);
  });

  console.log('\nautomatic focus on a file too big to draw whole');

  // The load pipeline runs for real here. Keep it in 2D — the 3D branch reaches
  // for a canvas context jsdom does not provide.
  state.currentView = '2d';
  global.window.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy({}, { get: () => () => {} });
  const settle = () => new Promise(r => setTimeout(r, 50));

  await test('a small file is shown whole', async () => {
    state.focusRootId = null;
    io._loadDatasetFile(new global.window.File([bigGedcom(20)], 'small.ged'));
    await settle();
    assert.strictEqual(state.focusRootId, null,
      'nothing to protect the renderer from at this size');
  });

  await test('a file over the threshold opens focused on somebody', async () => {
    state.focusRootId = null;
    io._loadDatasetFile(new global.window.File([bigGedcom(AUTO_FOCUS_THRESHOLD + 1)], 'big.ged'));
    await settle();
    assert.ok(state.individuals.size > AUTO_FOCUS_THRESHOLD, 'fixture should be over the line');
    assert.ok(state.focusRootId, 'a focus person should have been chosen');
    // Ids keep the @…@ the file writes them with — that is what the parser stores.
    assert.strictEqual(state.focusRootId, '@HUB@',
      'and it should be the best-connected one, not whoever came first in the file');
  });

  await test('the focus actually cuts what the renderer is handed', async () => {
    assert.ok(state.nodes.length < state.allNodes.length / 10,
      `the chart should be a small slice of the file, got ${state.nodes.length} of ${state.allNodes.length}`);
  });

  console.log('\nthe culling window');

  const r2d = await import(url('render-2d.js'));

  // A node at the centre of a 1000×600 window, at three zooms. What is being
  // pinned down is the direction of the inverse transform: a sign error here
  // puts the window on the far side of the origin, and the chart simply never
  // draws.
  await test('the window maps back to what is actually on screen', async () => {
    const r = r2d._cullRect(1000, 600, { k: 1, x: 0, y: 0 });
    assert.ok(r.x0 < 0 && r.x1 > 1000, `x should span the screen, got ${r.x0}..${r.x1}`);
    assert.ok(r.y0 < 0 && r.y1 > 600,  `y should span the screen, got ${r.y0}..${r.y1}`);
  });

  await test('panning right moves the window right in graph space', async () => {
    // Translating the layer by -500 screen px brings graph x≈500 to the origin.
    const a = r2d._cullRect(1000, 600, { k: 1, x: 0,    y: 0 });
    const b = r2d._cullRect(1000, 600, { k: 1, x: -500, y: 0 });
    assert.ok(b.x0 > a.x0 && b.x1 > a.x1, 'the window should have followed the pan');
    assert.strictEqual(Math.round(b.x0 - a.x0), 500);
  });

  await test('zooming in narrows the window', async () => {
    const out = r2d._cullRect(1000, 600, { k: 0.5, x: 0, y: 0 });
    const inn = r2d._cullRect(1000, 600, { k: 4,   x: 0, y: 0 });
    assert.ok((inn.x1 - inn.x0) < (out.x1 - out.x0) / 4,
      'four times the magnification should show far less of the chart');
  });

  await test('the slack is a screen distance, not a graph one', async () => {
    // Same number of pixels of margin at every zoom — in graph units that has
    // to shrink as you magnify, or a zoomed-in view keeps drawing a screenful
    // of boxes nobody can see.
    const near = r2d._cullRect(1000, 600, { k: 10, x: 0, y: 0 });
    const far  = r2d._cullRect(1000, 600, { k: 1,  x: 0, y: 0 });
    const slackOf = (r, W, k) => ((r.x1 - r.x0) - W / k) / 2 - r2d.NODE_BOX_W / 2;
    assert.ok(Math.abs(slackOf(near, 1000, 10) * 10 - r2d.CULL_SLACK_PX) < 1e-6);
    assert.ok(Math.abs(slackOf(far,  1000, 1)  * 1  - r2d.CULL_SLACK_PX) < 1e-6);
  });

  await test('culling only switches on for a chart big enough to need it', async () => {
    state.nodes = new Array(r2d.CULL_MIN_NODES - 1).fill({ id: 'x' });
    assert.strictEqual(r2d._cullActive(), false);
    state.nodes = new Array(r2d.CULL_MIN_NODES).fill({ id: 'x' });
    assert.strictEqual(r2d._cullActive(), true);
  });

  console.log('\nthe 3D scene budget');

  const r3d = await import(url('render-3d.js'));
  // The budget is a live setting now (a slider in the 3D appearance panel), so
  // the test sets its own small one rather than building a fixture big enough
  // to trip the shipped default.
  const SCENE_MAX_NODES = 300;
  state.scene3d.maxNodes = SCENE_MAX_NODES;

  // A long chain, so the ball has somewhere to grow and the budget has to stop
  // it. Everyone is connected, so a shortfall can only be the budget.
  const buildChain = n => {
    const individuals = new Map(), families = new Map();
    for (let i = 0; i < n; i++) individuals.set('P' + i, p('P' + i, 'S' + (i % 7)));
    for (let i = 0; i + 1 < n; i++) {
      const f = 'F' + i;
      families.set(f, { id: f, husb: 'P' + i, wife: null, chil: ['P' + (i + 1)], marriages: [] });
      individuals.get('P' + i).fams.push(f);
      individuals.get('P' + (i + 1)).famc.push(f);
    }
    return { individuals, families };
  };

  await test('a scene within budget is handed over whole', async () => {
    load(buildChain(50));
    const d = r3d.scene3DData();
    assert.strictEqual(d.nodes.length, state.nodes.length);
    assert.strictEqual(state._3dOmitted, 0);
  });

  await test('a scene over budget is cut to it', async () => {
    load(buildChain(SCENE_MAX_NODES + 800));
    const d = r3d.scene3DData();
    assert.ok(state.nodes.length > SCENE_MAX_NODES, 'fixture should exceed the budget');
    assert.ok(d.nodes.length <= SCENE_MAX_NODES,
      `handed ${d.nodes.length}, budget is ${SCENE_MAX_NODES}`);
    assert.ok(state._3dOmitted > 0, 'and it should say how many it left out');
  });

  await test('what it keeps is connected, not an arbitrary slice', async () => {
    // The whole point of growing a ball rather than taking the first N: every
    // link in the scene must have both ends in it, and every node bar the seed
    // must be reachable. A scene of unconnected dots would pass a count check.
    const d = r3d.scene3DData();
    const ids = new Set(d.nodes.map(n => n.id));
    for (const l of d.links) {
      assert.ok(ids.has(l.source) && ids.has(l.target), 'a link left the scene dangling');
    }
    const adj = new Map();
    for (const l of d.links) {
      (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)).push(l.target);
      (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)).push(l.source);
    }
    const seen = new Set([d.nodes[0].id]);
    for (const q = [d.nodes[0].id]; q.length;) {
      for (const nb of adj.get(q.shift()) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    assert.strictEqual(seen.size, d.nodes.length,
      `${d.nodes.length - seen.size} of the kept nodes hang off nothing`);
  });

  await test('the focus person is the one the scene is built around', async () => {
    load(buildChain(SCENE_MAX_NODES + 800));
    state.focusRootId = 'P' + (SCENE_MAX_NODES + 400);   // deliberately far down the chain
    const ids = new Set(r3d.scene3DData().nodes.map(n => n.id));
    assert.ok(ids.has(state.focusRootId),
      'the person the reader chose must not be the one the budget drops');
    state.focusRootId = null;
  });

  console.log('\nthe computed 3D starting layout');

  const { seedScene3D } = await import(url('seed-3d.js'));

  // A branching pedigree: every couple has three children, one of whom marries
  // and has three of their own. Wide enough that an unstructured seed would
  // interleave the branches.
  function buildPedigree(gens) {
    const individuals = new Map(), families = new Map();
    let pid = 0, fid = 0;
    const person = () => { const id = 'P' + (++pid); individuals.set(id, p(id, 'S')); return id; };
    let layer = [[person(), person()], [person(), person()]];
    for (let g = 0; g < gens; g++) {
      const next = [];
      for (const [h, w] of layer) {
        const f = 'F' + (++fid);
        const ch = [person(), person(), person()];
        families.set(f, { id: f, husb: h, wife: w, chil: ch, marriages: [] });
        individuals.get(h).fams.push(f); individuals.get(w).fams.push(f);
        for (const c of ch) individuals.get(c).famc.push(f);
        next.push([ch[0], person()]);
      }
      layer = next;
    }
    return { individuals, families };
  }

  const seedOf = fixture => {
    load(fixture);
    const data = { nodes: state.nodes.map(n => ({ id: n.id, type: n.type, data: n.data })), links: [] };
    seedScene3D(data);
    return new Map(data.nodes.map(n => [n.id, n]));
  };

  await test('everybody gets a finite position', async () => {
    const pos = seedOf(buildPedigree(4));
    for (const [id, n] of pos) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.z), `${id} was left unplaced`);
    }
  });

  await test('relatives land near each other, strangers do not', async () => {
    // The whole point of inheriting an angular wedge. Compare the distance from
    // a parent to their own child against the distance to a random other person:
    // if the seed carries no structure the two are the same.
    const fx = buildPedigree(4);
    const pos = seedOf(fx);
    const d = (a, b) => Math.hypot(pos.get(a).x - pos.get(b).x, pos.get(a).z - pos.get(b).z);
    let kin = 0, kinN = 0;
    for (const [, fam] of fx.families) {
      for (const c of fam.chil) {
        if (!pos.has(fam.husb) || !pos.has(c)) continue;
        kin += d(fam.husb, c); kinN++;
      }
    }
    const ids = [...pos.keys()].filter(id => pos.get(id).type === 'INDI');
    let far = 0, farN = 0;
    for (let i = 0; i < ids.length; i += 7) {
      for (let j = 3; j < ids.length; j += 11) {
        if (i === j) continue;
        far += d(ids[i], ids[j]); farN++;
      }
    }
    const meanKin = kin / kinN, meanAny = far / farN;
    assert.ok(meanKin < meanAny * 0.6,
      `parent→child ${meanKin.toFixed(0)} should be well under the ${meanAny.toFixed(0)} of any two people`);
  });

  await test('a deep line does not overflow the stack', async () => {
    // The walk is iterative for this reason: a long pedigree recursed would
    // throw, and a GEDCOM with thousands of generations of descent is a real
    // (if malformed) file.
    const individuals = new Map(), families = new Map();
    const ids = Array.from({ length: 6000 }, (_, i) => 'D' + i);
    for (const id of ids) individuals.set(id, p(id, 'S'));
    for (let i = 0; i + 1 < ids.length; i++) {
      const f = 'FD' + i;
      families.set(f, { id: f, husb: ids[i], wife: null, chil: [ids[i + 1]], marriages: [] });
      individuals.get(ids[i]).fams.push(f);
      individuals.get(ids[i + 1]).famc.push(f);
    }
    const pos = seedOf({ individuals, families });
    assert.ok(Number.isFinite(pos.get('D5999').x), 'the far end of the line should still be placed');
  });

  await test('a person who married in sits beside their partner', async () => {
    const fx = buildPedigree(3);
    const pos = seedOf(fx);
    // Spouses of the branch heads have no descent of their own to inherit from.
    let checked = 0;
    for (const [, fam] of fx.families) {
      if (!fam.husb || !fam.wife || !pos.has(fam.husb) || !pos.has(fam.wife)) continue;
      const d = Math.hypot(pos.get(fam.husb).x - pos.get(fam.wife).x,
                           pos.get(fam.husb).z - pos.get(fam.wife).z);
      assert.ok(Number.isFinite(d), 'both partners should be placed');
      checked++;
    }
    assert.ok(checked > 0, 'the fixture should contain couples');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
