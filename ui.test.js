#!/usr/bin/env node
'use strict';

/**
 * Tests for which controls the UI offers, and when.
 * Run with: node ui.test.js
 *
 * Every case here is a control that used to be on screen while doing nothing —
 * a physics panel with no simulation behind it, a 3D appearance panel in the 2D
 * view, export buttons that answered with an alert — or a control whose value
 * disagreed with the state it was supposed to be showing. They are written
 * against what a user can see and press, not against the functions that do it.
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

const shown = id => {
  const el = document.getElementById(id);
  assert(el, `#${id} is not in index.html`);
  return el.style.display !== 'none';
};

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, 'js', f)).href;
  const { state }          = await import(url('state.js'));
  const { showDataUI }     = await import(url('gedcom-io.js'));
  const { updateViewToggleUI } = await import(url('render-3d.js'));

  const person = id => [id, {
    id, name: 'A B', givn: 'A', surn: 'B', displayName: 'A B', sex: 'M',
    birth: { date: '', plac: '' }, death: { date: '', plac: '', caus: '' },
    deceased: false, birthYear: null, famc: [], fams: [],
  }];

  console.log('\nthe empty state');

  await test('an empty tree offers the two things you can actually do', async () => {
    state.individuals.clear();
    showDataUI();
    assert(shown('empty-state'), 'empty state should be up when there is nobody');
    assert(!shown('dl-wrap'), 'nothing to export yet');
    assert(document.getElementById('view-toggle-btn').disabled, 'nothing to view yet');
  });

  await test('one person is enough to put the real UI up', async () => {
    state.individuals.clear();
    state.individuals.set(...person('@I1@'));
    showDataUI();
    assert(!shown('empty-state'), 'empty state should be gone');
    assert(shown('dl-wrap'), 'export should be offered');
    assert(!document.getElementById('view-toggle-btn').disabled);
    assert(!document.getElementById('relation-tool-btn').disabled);
  });

  await test('deleting the last person brings the empty state back', async () => {
    state.individuals.clear();
    showDataUI();
    assert(shown('empty-state'));
    assert(!shown('dl-wrap'), 'and takes the export menu away again');
  });

  console.log('\ncontrols that match the view');

  await test('the 3D appearance panel is not offered in 2D', async () => {
    state.currentView = '2d';
    updateViewToggleUI();
    assert(!shown('appearance-panel'));
    state.currentView = '3d';
    updateViewToggleUI();
    assert(shown('appearance-panel'));
  });

  await test('the image exports are not offered in 3D, where they only alert', async () => {
    state.currentView = '3d';
    updateViewToggleUI();
    assert(!shown('export-2d-row'));
    state.currentView = '2d';
    updateViewToggleUI();
    assert(shown('export-2d-row'));
  });

  await test('the physics panel follows whether a simulation exists', async () => {
    state.currentView = '2d';
    state.treeLayout = true;          // classical chart: positions are computed
    updateViewToggleUI();
    assert(!shown('physics-panel'), 'no simulation to tune in the tree layout');
    assert(!shown('node-drag-btn'), 'and nothing to drag either');

    state.treeLayout = false;         // force layout in 2D
    updateViewToggleUI();
    assert(shown('physics-panel'));

    state.treeLayout = true;          // ...but 3D always has one
    state.currentView = '3d';
    updateViewToggleUI();
    assert(shown('physics-panel'));
  });

  console.log('\nstarting a tree from scratch');

  await test('the first person created on an empty page gets a 3D scene built for them', async () => {
    // Only the file loader used to call initGraph3D(), so a tree begun by hand
    // in the 3D view had nowhere to be drawn: the person existed and was listed
    // in the sidebar, and the canvas stayed black however long you waited.
    const { _fullRebuildGraph } = await import(url('gedcom-io.js'));
    state.individuals.clear();
    state.families.clear();
    state.currentView = '3d';
    state.graph3d = null;
    state.individuals.set(...person('@I1@'));
    _fullRebuildGraph({ warm: true });
    assert.ok(state.graph3d, 'the 3D graph should have been created on the first rebuild');
  });

  console.log('\ncontrols that match their state');

  await test('the 3D sliders open on the values actually being rendered', async () => {
    // The markup ships one set of numbers and state another; whichever wins,
    // they have to agree, or the first drag jumps the scene.
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise(r => setTimeout(r, 10));
    const pairs = [
      ['ap-node-opacity', state._3dAppearance.nodeOpacity],
      ['ap-link-opacity', state._3dAppearance.linkOpacity],
      ['ap-link-width',   state._3dAppearance.linkWidth],
      ['ap-node-size',    state._3dAppearance.nodeRelSize],
      ['ap-font-size',    state._3dFontSize],
    ];
    for (const [id, want] of pairs) {
      assert.strictEqual(parseFloat(document.getElementById(id).value), want,
        `${id} shows a different value than the scene uses`);
    }
  });

  await test('the family-marker size defaults to the size the 3D volume is scaled against', async () => {
    // `parseInt(...) || 1` used to make a fresh install start at 1 — a marker a
    // pixel across — and made 0, the slider's own minimum, unselectable.
    assert.strictEqual(state.famNodeSize, 7);
  });

  console.log('\n' + '─'.repeat(50));
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
