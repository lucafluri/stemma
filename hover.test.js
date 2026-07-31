#!/usr/bin/env node
'use strict';

/**
 * Tests for the 2D node box: the quick-add hover buttons, and the maiden name
 * on the name line.
 * Run with: node hover.test.js
 *
 * The hover cases are about event sequences a browser really produces — an
 * enter that arrives before the matching leave, a leave that never arrives at
 * all — so they drive _showQuickAdd() directly against real DOM nodes rather
 * than trying to synthesise pointer input.
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

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, 'js', f)).href;
  const r2d = await import(url('render-2d.js'));
  const { state } = await import(url('state.js'));

  // jsdom has no SVG layout, but d3 only needs real elements to set styles on.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const makeNode = () => {
    const g = global.document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'ng');
    for (let i = 0; i < 3; i++) {
      const b = global.document.createElementNS(SVG_NS, 'g');
      b.setAttribute('class', 'qa-hover-btn');
      b.style.display = 'none';
      g.appendChild(b);
    }
    global.document.body.appendChild(g);
    return g;
  };
  const shown = g => [...g.querySelectorAll('.qa-hover-btn')].every(b => b.style.display === '');
  const hiddenAll = g => [...g.querySelectorAll('.qa-hover-btn')].every(b => b.style.display === 'none');

  console.log('\nquick-add buttons on hover');

  await test('hovering a node shows its buttons and only its', async () => {
    state._qaHoverEl = null;
    const a = makeNode(), b = makeNode();
    r2d._showQuickAdd(a);
    assert.ok(shown(a), 'the hovered node should show its buttons');
    assert.ok(hiddenAll(b), 'a node nobody is hovering should not');
  });

  await test('moving to another node turns the first one off', async () => {
    state._qaHoverEl = null;
    const a = makeNode(), b = makeNode();
    r2d._showQuickAdd(a);
    r2d._showQuickAdd(b);
    assert.ok(hiddenAll(a), 'the node left behind must go dark');
    assert.ok(shown(b), 'the node arrived at must light up');
  });

  await test('a lost mouseleave cannot strand buttons on', async () => {
    // The reported bug: sweep the pointer quickly across the graph and some
    // nodes never get their leave event, so their buttons stayed lit for good.
    // Entering the next node clears the previous one regardless.
    state._qaHoverEl = null;
    const nodes = Array.from({ length: 6 }, makeNode);
    for (const n of nodes) r2d._showQuickAdd(n);   // enters only, no leaves at all
    const lit = nodes.filter(shown);
    assert.strictEqual(lit.length, 1, `only the last node should be lit, found ${lit.length}`);
    assert.strictEqual(lit[0], nodes[nodes.length - 1]);
  });

  await test('a late leave for the previous node does not blank the new one', async () => {
    // Crossing between two touching nodes, the browser can deliver enter(B)
    // before leave(A). Acting on that leave unguarded would switch off the
    // buttons the cursor has just arrived on.
    state._qaHoverEl = null;
    const a = makeNode(), b = makeNode();
    r2d._showQuickAdd(a);
    r2d._showQuickAdd(b);                       // enter B arrives first
    if (state._qaHoverEl === a) r2d._showQuickAdd(null);   // the guard in the handler
    assert.ok(shown(b), 'B must still be lit after A\'s late leave');
    assert.ok(hiddenAll(a), 'and A must be dark');
  });

  await test('leaving the chart clears the last node', async () => {
    state._qaHoverEl = null;
    const a = makeNode();
    r2d._showQuickAdd(a);
    r2d._showQuickAdd(null);                    // the svg-level mouseleave backstop
    assert.ok(hiddenAll(a));
    assert.strictEqual(state._qaHoverEl, null, 'the tracker must let go too');
  });

  await test('re-entering the same node is not a no-op that loses the buttons', async () => {
    state._qaHoverEl = null;
    const a = makeNode();
    r2d._showQuickAdd(a);
    r2d._showQuickAdd(a);
    assert.ok(shown(a), 'a repeated enter must leave the buttons on');
  });

  console.log('\nthe + in the quick-add buttons');

  // "M<x0>,<y>H<x1>M<x>,<y0>V<y1>" — a horizontal stroke then a vertical one.
  // Read structurally rather than by counting numbers, so the assertions are
  // about the geometry and not about where a value happens to land in the string.
  const plusArms = r => {
    const m = r2d._qaPlusPath(r).match(
      /^M(-?[\d.]+),(-?[\d.]+)H(-?[\d.]+)M(-?[\d.]+),(-?[\d.]+)V(-?[\d.]+)$/);
    assert.ok(m, `unexpected path shape: ${r2d._qaPlusPath(r)}`);
    const [x0, y, x1, x, y0, y1] = m.slice(1).map(Number);
    return { x0, y, x1, x, y0, y1 };
  };

  await test('the plus is centred on the circle it sits in', async () => {
    const p = plusArms(r2d.QA_BTN_R);
    assert.strictEqual(p.x0, -p.x1, `horizontal stroke runs ${p.x0}..${p.x1}, not symmetric about 0`);
    assert.strictEqual(p.y0, -p.y1, `vertical stroke runs ${p.y0}..${p.y1}, not symmetric about 0`);
    assert.strictEqual(p.y, 0, 'the horizontal stroke must sit on the centre line');
    assert.strictEqual(p.x, 0, 'the vertical stroke must sit on the centre line');
    assert.ok(p.x1 > 0 && p.x1 < r2d.QA_BTN_R,
      `the arms (${p.x1}) must fit inside the circle (${r2d.QA_BTN_R})`);
  });

  await test('it stays centred at any button size', async () => {
    for (const r of [5, 9, 12, 20]) {
      const p = plusArms(r);
      assert.strictEqual(p.x0, -p.x1, `r=${r}: horizontal stroke off centre`);
      assert.strictEqual(p.y0, -p.y1, `r=${r}: vertical stroke off centre`);
      assert.strictEqual(p.x, 0, `r=${r}: vertical stroke off the centre line`);
      assert.strictEqual(p.y, 0, `r=${r}: horizontal stroke off the centre line`);
      assert.ok(p.x1 > 0 && p.x1 < r, `r=${r}: arm ${p.x1} does not fit inside the circle`);
      assert.strictEqual(p.x1, p.y1, `r=${r}: the plus should have equal arms, got ${p.x1} and ${p.y1}`);
    }
  });

  console.log('\nmaiden name on the box');

  const label = o => r2d.nodeLabelText(o);

  await test('the maiden name is shown after the married name', async () => {
    assert.strictEqual(label({ displayName: 'Anna Müller', maidenName: 'Meier' }), 'Anna Müller (Meier)');
  });

  await test('a person without one is unchanged', async () => {
    assert.strictEqual(label({ displayName: 'Hans Fluri' }), 'Hans Fluri');
    assert.strictEqual(label({ displayName: 'Hans Fluri', maidenName: '' }), 'Hans Fluri');
    assert.strictEqual(label({ displayName: 'Hans Fluri', maidenName: '   ' }), 'Hans Fluri',
      'a field holding only spaces is not a maiden name');
  });

  await test('it is not repeated when she is already shown under it', async () => {
    // A woman who kept her name, or a record with both fields filled in the same
    // — "Anna Meier (Meier)" reads as a mistake in the data.
    assert.strictEqual(label({ displayName: 'Anna Meier', maidenName: 'Meier' }), 'Anna Meier');
  });

  await test('a missing display name does not produce a stray bracket', async () => {
    assert.strictEqual(label({ maidenName: 'Meier' }), 'Meier',
      'with no other name the maiden name is the name, not a bracketed footnote');
    assert.strictEqual(label({}), '');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
