#!/usr/bin/env node
'use strict';

/**
 * Tests for auto-marking long-dead people as deceased.
 * Run with: node deceased.test.js
 *
 * Driven through buildGraphData(), which is the only thing that calls the
 * marker — and the function the file loader actually goes through, since
 * _loadDatasetFile() open-codes its own rebuild rather than using
 * _fullRebuildGraph(). Calling the marker directly would pass while the real
 * load path still did nothing.
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

const p = (id, extra = {}) => Object.assign({
  id, givn: id, surn: 'X', famc: [], fams: [], marriages: [],
  birth: {}, death: {}, deceased: false,
}, extra);

// A single line of descent: each person is the child of the one above. Only the
// youngest has a recorded birth year, so everybody else can only be placed by
// the estimate — which is the case this is about.
function buildLine(depth, youngestBirthYear) {
  const individuals = new Map(), families = new Map();
  const ids = Array.from({ length: depth }, (_, i) => `P${i}`);   // P0 = oldest
  for (const id of ids) individuals.set(id, p(id));
  const youngest = ids[ids.length - 1];
  individuals.get(youngest).birth = { date: `1 JAN ${youngestBirthYear}` };
  individuals.get(youngest).birthYear = youngestBirthYear;

  for (let i = 0; i + 1 < ids.length; i++) {
    const fid = `F${i}`;
    families.set(fid, { id: fid, husb: ids[i], wife: null, chil: [ids[i + 1]], marriages: [] });
    individuals.get(ids[i]).fams.push(fid);
    individuals.get(ids[i + 1]).famc.push(fid);
  }
  return { individuals, families, ids };
}

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const gd = await import(url('graph-data.js'));
  const { state } = await import(url('state.js'));

  const THRESHOLD = gd.DECEASED_AGE_THRESHOLD;
  const cutoff = new Date().getFullYear() - THRESHOLD;

  const load = ({ individuals, families }) => {
    state.individuals = individuals;
    state.families = families;
    state._nodeObjCache = new Map();
    state.allNodes = []; state.allLinks = [];
    gd.buildGraphData();
  };

  console.log(`\nauto-marking (threshold ${THRESHOLD}, cutoff year ${cutoff})`);

  await test('a recorded birth year past the threshold marks the person', async () => {
    const individuals = new Map([
      ['old',   p('old',   { birthYear: cutoff - 5 })],
      ['young', p('young', { birthYear: cutoff + 5 })],
    ]);
    load({ individuals, families: new Map() });
    assert.strictEqual(individuals.get('old').deceased, true,
      `born ${cutoff - 5}, which is over ${THRESHOLD} years ago`);
    assert.strictEqual(individuals.get('young').deceased, false,
      `born ${cutoff + 5}, so they could well be alive`);
  });

  await test('someone with no birth year at all is placed by the estimate', async () => {
    // Seven generations, only the youngest dated: the ones the estimate puts
    // before the cutoff must be marked even though nothing about them is recorded.
    const line = buildLine(7, 2010);
    load(line);
    const est = gd.computeEstimatedYears();

    let markedByEstimate = 0;
    for (const id of line.ids) {
      const indi = line.individuals.get(id);
      if (indi.birthYear) continue;
      const guess = est.get(id);
      assert.ok(guess, `${id} should have an estimated year`);
      assert.strictEqual(indi.deceased, guess <= cutoff,
        `${id} estimated ${guess}: expected deceased=${guess <= cutoff}, got ${indi.deceased}`);
      if (indi.deceased) markedByEstimate++;
    }
    assert.ok(markedByEstimate >= 2,
      `the fixture should reach past the cutoff — only ${markedByEstimate} were marked`);
  });

  await test('the youngest, who has a real date, is left alone', async () => {
    const line = buildLine(7, 2010);
    load(line);
    const youngest = line.individuals.get(line.ids[line.ids.length - 1]);
    assert.strictEqual(youngest.deceased, false, 'born 2010 and dated — not a candidate');
  });

  await test('a recorded birth year is never overruled by the estimate', async () => {
    // A late child of a long-dead line: everyone around them is 19th century, so
    // the estimate would put them there too. Their own recorded year is the fact.
    const line = buildLine(6, 2015);
    const oldest = line.ids[0];
    line.individuals.get(oldest).birth = { date: '1 JAN 2001' };
    line.individuals.get(oldest).birthYear = 2001;
    load(line);
    assert.strictEqual(line.individuals.get(oldest).deceased, false,
      'a recorded 2001 birth must win over any estimate derived from relatives');
  });

  await test('somebody already marked deceased is not disturbed', async () => {
    const individuals = new Map([['d', p('d', { birthYear: 1990, deceased: true, death: { date: '2020' } })]]);
    load({ individuals, families: new Map() });
    assert.strictEqual(individuals.get('d').deceased, true);
    assert.strictEqual(individuals.get('d').death.date, '2020', 'their death record must be untouched');
  });

  await test('a living person with no dates at all is not marked on nothing', async () => {
    // No year, no relatives to estimate from: there is nothing that says they
    // are long dead, so the record stays as it is.
    const individuals = new Map([['lone', p('lone')]]);
    load({ individuals, families: new Map() });
    assert.strictEqual(individuals.get('lone').deceased, false,
      'with no evidence either way, leave the record alone');
  });

  console.log('\nwhat gets written out');

  await test('an auto-marked person is saved as dead with no invented date', async () => {
    const line = buildLine(7, 2010);
    load(line);
    const marked = line.ids.find(id => line.individuals.get(id).deceased);
    assert.ok(marked, 'the fixture should have marked somebody');
    const ged = global.GEDCOMModule.serializeGEDCOM(line.individuals, line.families, []);
    const record = ged.split(/^0 /m).find(r => r.startsWith(marked + ' INDI'));
    assert.ok(/^1 DEAT Y$/m.test(record),
      `${marked} should serialize as "1 DEAT Y", got:\n${record}`);
    assert.ok(!/^2 DATE/m.test(record.split('1 DEAT')[1] || ''),
      'a guess must not turn into a recorded death date');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
