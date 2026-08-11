#!/usr/bin/env node
'use strict';

/**
 * Tests for the relation tool's path-based labels (js/relations.js).
 * Run with: node relations.test.js
 *
 * A spouse edge in the middle of a BFS path used to name the wrong pivot: for
 * "my grandfather" and "my wife's sister", it computed her blood relation to
 * my wife correctly (sister) but then said "sister of <me>" instead of
 * "sister of <my wife>" — reading as though she were the user's own sister.
 */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { setupDom } = require('./test-setup.js');

setupDom();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const { state } = await import(url('state.js'));
  const rel = await import(url('relations.js'));

  const p = (id, famc = [], fams = [], sex) => state.individuals.set(id, { famc, fams, displayName: id, sex });
  const f = (id, husb, wife, chil) => state.families.set(id, { husb, wife, chil });

  test('an in-law reached through a spouse edge is named relative to the spouse, not to the user', () => {
    state.individuals.clear();
    state.families.clear();

    // GF -> Dad -> Me, married to Wife; Wife's sister is unrelated by blood to GF.
    p('GF', [], ['F1']);
    p('Dad', ['F1'], ['F2']);
    p('Me', ['F2'], ['F3']);
    p('Wife', ['FW'], ['F3'], 'F');
    p('WifeSister', ['FW'], [], 'F');
    f('F1', 'GF', null, ['Dad']);
    f('F2', 'Dad', null, ['Me']);
    f('F3', 'Me', 'Wife', []);
    f('FW', null, null, ['Wife', 'WifeSister']);
    // FW needs a parent so 'Wife'/'WifeSister' share a common famc — give it one.
    state.families.set('FW', { husb: 'WifeDad', wife: null, chil: ['Wife', 'WifeSister'] });
    p('WifeDad', [], ['FW']);

    const label = rel._bfsPathLabel('GF', 'WifeSister');
    assert(!label.includes('Me'), `label must not name "Me": got "${label}"`);
    assert(label.includes('Wife'), `label should be relative to Wife: got "${label}"`);
  });
})().then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
