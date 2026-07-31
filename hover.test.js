#!/usr/bin/env node
'use strict';

/**
 * Tests for the text on a person's box in the 2D view.
 * Run with: node hover.test.js
 *
 * This file also covered the quick-add hover buttons, which have been removed —
 * the detail panel's own "+ parent / spouse / child" buttons do the same job,
 * and the hover set cost a raise() and two listeners per node on every move of
 * the pointer.
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
