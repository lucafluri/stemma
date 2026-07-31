#!/usr/bin/env node
'use strict';

/**
 * Tests for what dragging a physics slider costs.
 * Run with: node physics.test.js
 *
 * A range input fires `input` on every pixel it travels, and each event used to
 * restart a fourteen-hundred-node simulation from scratch, repin every node, and
 * wake the other view's simulation too. These pin down that it does none of that
 * any more.
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
  const r3d = await import(url('render-3d.js'));
  const { state } = await import(url('state.js'));

  // Counts what the app asks of the 3D library.
  const calls = { reheat: 0, forces: 0 };
  const force = () => new Proxy(function () {}, { apply: () => force(), get: () => force() });
  state.graph3d = {
    d3Force: () => { calls.forces++; return force(); },
    d3AlphaDecay: () => {}, d3VelocityDecay: () => {},
    d3ReheatSimulation: () => { calls.reheat++; },
    graphData: () => ({ nodes: [], links: [] }),
  };

  // ...and of the 2D one.
  let sim2dRestarts = 0;
  const chain = new Proxy(function () {}, {
    apply: () => chain,
    get: (_t, p) => {
      if (p === 'restart') return () => { sim2dRestarts++; return chain; };
      // alpha() is read back as a number (`Math.max(sim.alpha(), 0.25)`), so it
      // cannot hand out the chain like everything else does.
      if (p === 'alpha') return (v) => (v === undefined ? 0.1 : chain);
      return () => chain;
    },
  });
  state.simulation = chain;
  state.stratify3D = 'off';   // so any repin that does happen is cheap

  const reset = () => { calls.reheat = 0; calls.forces = 0; sim2dRestarts = 0; };
  const frame = () => new Promise(r => setTimeout(r, 40));   // let the rAF fire

  console.log('\ncoalescing');

  await test('a burst of slider events becomes one apply', async () => {
    state.currentView = '3d';
    reset();
    for (let i = 0; i < 50; i++) r2d.schedulePhysicsParams({ repin: false });
    assert.strictEqual(calls.reheat, 0, 'nothing should happen synchronously');
    await frame();
    assert.strictEqual(calls.reheat, 1, `50 events should cost one reheat, cost ${calls.reheat}`);
  });

  await test('a later burst applies again rather than being swallowed', async () => {
    state.currentView = '3d';
    reset();
    r2d.schedulePhysicsParams({ repin: false });
    await frame();
    r2d.schedulePhysicsParams({ repin: false });
    await frame();
    assert.strictEqual(calls.reheat, 2, 'each frame of dragging should still take effect');
  });

  console.log('\nnot waking what nobody is watching');

  await test('in 2D, the 3D simulation keeps its forces but stays asleep', async () => {
    state.currentView = '2d';
    reset();
    r2d.applyPhysicsParams({ repin: false });
    assert.ok(calls.forces > 0, 'the 3D forces must still be brought up to date');
    assert.strictEqual(calls.reheat, 0, 'but the hidden 3D layout must not be restarted');
    assert.ok(sim2dRestarts > 0, 'the visible 2D layout is the one that reheats');
  });

  await test('in 3D, the 2D simulation keeps its forces but stays asleep', async () => {
    state.currentView = '3d';
    reset();
    r2d.applyPhysicsParams({ repin: false });
    assert.strictEqual(sim2dRestarts, 0, 'the hidden 2D layout must not be restarted');
    assert.strictEqual(calls.reheat, 1, 'the visible 3D layout is the one that reheats');
  });

  console.log('\nnot repinning for a change that cannot move the pins');

  await test('a physics change does not recompute the stratification pins', async () => {
    // The Y pins come from the stratify mode and the axis spread. No physics
    // slider touches either, so repinning every node per event was pure waste.
    let repins = 0;
    state.stratify3D = 'time';
    state._birthYearRange = { min: 1800, max: 2000 };
    state.graph3d.graphData = () => { repins++; return { nodes: [], links: [] }; };

    state.currentView = '3d';
    r3d.apply3DPhysics({ repin: false });
    assert.strictEqual(repins, 0, 'a physics-only change must not touch the pins');

    r3d.apply3DPhysics();
    assert.strictEqual(repins, 1, '...but a rebuild still must, or new nodes float free');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
