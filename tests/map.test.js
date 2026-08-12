#!/usr/bin/env node
'use strict';

/**
 * Tests for the map view.
 * Run with: node map.test.js
 *
 * The rendering is a browser problem, but the three things underneath it are
 * not, and each of them can be wrong in a way that reads as plausible on
 * screen: which events count as placed, which of them a year range admits,
 * and where a coordinate lands.
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

const person = (id, extra = {}) => ({
  id, name: id, givn: id, surn: '', maidenName: '', sex: 'U',
  birth: { date: '', plac: '' },
  death: { date: '', plac: '', caus: '' },
  deceased: false, birthYear: null, famc: [], fams: [], occu: '', note: '', displayName: id,
  ...extra,
});

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
  const map = await import(url('map-view.js'));
  const { state } = await import(url('state.js'));

  const load = (indis, fams = []) => {
    state.individuals = new Map(indis.map(i => [i.id, i]));
    state.families = new Map(fams.map(f => [f.id, f]));
  };

  console.log('\ncollecting events');

  await test('births, deaths and marriages with a place all land on the map', async () => {
    load([
      person('a', { birth: { date: '3 JAN 1820', plac: 'Rivertown' },
                    death: { date: '1890', plac: 'Mountainville', caus: '' } }),
      person('b', { birth: { date: '', plac: '' } }),
    ], [
      { id: 'F1', husb: 'a', wife: 'b', chil: [], marriages: [{ date: '12 MAY 1845', plac: 'Central', types: [] }] },
    ]);
    const events = map.collectMapEvents();
    assert.strictEqual(events.length, 3, 'exactly the three placed events');
    assert.deepStrictEqual(events.map(e => e.type).sort(), ['birth', 'death', 'marriage']);
    assert.deepStrictEqual(events.map(e => e.year).sort(), [1820, 1845, 1890]);
  });

  await test('an event with no place is not an event with an empty place', async () => {
    // A person with a birth date and no place cannot be drawn anywhere. Letting
    // one through would pile every such person onto a single '' marker.
    load([person('a', { birth: { date: '1820', plac: '' } })]);
    assert.strictEqual(map.collectMapEvents().length, 0);
  });

  await test('a place with no date still counts as a place', async () => {
    load([person('a', { birth: { date: '', plac: 'Rivertown' } })]);
    const [e] = map.collectMapEvents();
    assert.strictEqual(e.plac, 'Rivertown');
    assert.strictEqual(e.year, null, 'no date means no year, not year zero');
  });

  await test('a marriage is named after both partners', async () => {
    load([
      person('a', { name: 'Otto Bauer' }),
      person('b', { name: 'Emma Weber' }),
    ], [
      { id: 'F1', husb: 'a', wife: 'b', chil: [], marriages: [{ date: '1845', plac: 'Central', types: [] }] },
    ]);
    const [e] = map.collectMapEvents();
    assert.ok(e.name.includes('Otto Bauer') && e.name.includes('Emma Weber'), `got "${e.name}"`);
    assert.ok(state.individuals.has(e.id), 'clicking the row has to reach a real person');
  });

  console.log('\nthe time window');

  const events = [
    { type: 'birth', plac: 'A', year: 1800, id: 'a', name: 'a' },
    { type: 'death', plac: 'A', year: 1870, id: 'a', name: 'a' },
    { type: 'marriage', plac: 'B', year: 1900, id: 'b', name: 'b' },
    { type: 'birth', plac: 'C', year: null, id: 'c', name: 'c' },
  ];
  const all = { birth: true, death: true, marriage: true };

  await test('the range is inclusive at both ends', async () => {
    const got = map.filterEvents(events, { from: 1800, to: 1870, types: all, undated: false });
    assert.deepStrictEqual(got.map(e => e.year), [1800, 1870]);
  });

  await test('undated events are all in or all out, never smeared across the range', async () => {
    const out = map.filterEvents(events, { from: 1800, to: 1801, types: all, undated: false });
    assert.strictEqual(out.filter(e => e.year == null).length, 0);
    const inc = map.filterEvents(events, { from: 1800, to: 1801, types: all, undated: true });
    assert.strictEqual(inc.filter(e => e.year == null).length, 1);
  });

  await test('the type filter cuts before the year filter, not after', async () => {
    const got = map.filterEvents(events, { from: 1000, to: 2000, types: { birth: true }, undated: false });
    assert.deepStrictEqual(got.map(e => e.type), ['birth']);
  });

  await test('the year range spans the dated events and ignores the rest', async () => {
    assert.deepStrictEqual(map.eventYearRange(events), { min: 1800, max: 1900 });
    assert.strictEqual(map.eventYearRange([{ year: null }]), null, 'nothing dated means no range');
  });

  console.log('\ncoordinates');

  await test('places are grouped by spelling and carry their coordinates', async () => {
    const coords = new Map([['a', [47, 7.5]]]);
    const groups = map.groupByPlace(events, coords);
    assert.strictEqual(groups[0].plac, 'A', 'the busiest place comes first');
    assert.strictEqual(groups[0].events.length, 2);
    assert.deepStrictEqual(groups[0].ll, [47, 7.5]);
    assert.strictEqual(groups.find(g => g.plac === 'B').ll, null, 'unknown places stay listed');
  });

  await test('coordinates are looked up by the folded name, so case and accents share one', async () => {
    const coords = new Map([['malmo', [47.37, 8.54]]]);
    const groups = map.groupByPlace([{ type: 'birth', plac: 'Malmö ', year: 1800 }], coords);
    assert.deepStrictEqual(groups[0].ll, [47.37, 8.54]);
  });

  await test('Web Mercator puts the origin where the tile servers do', async () => {
    const [x, y] = map.project(0, 0);
    assert.ok(Math.abs(x - 0.5) < 1e-9 && Math.abs(y - 0.5) < 1e-9, 'null island is the centre');
    const [gx, gy] = map.project(8.54, 47.37);           // Malmö
    assert.ok(gx > 0.5 && gy < 0.5, 'east of Greenwich and north of the equator');
    // The projection runs to infinity at the poles; clamping is what keeps a
    // coordinate at 90°N from producing a NaN transform for the whole map.
    assert.ok(Number.isFinite(map.project(0, 90)[1]), 'the north pole must not be Infinity');
  });

  console.log('\nwriting coordinates into the records');

  const geoFixture = () => {
    load([
      person('a', { birth: { date: '1820', plac: 'Central' },
                    death: { date: '1890', plac: 'Central', caus: '' } }),
      person('b', { birth: { date: '1850', plac: 'Mountainville' } }),
    ], [
      { id: 'F1', husb: 'a', wife: 'b', chil: [], marriages: [{ date: '1845', plac: 'Central', types: [] }] },
    ]);
    return new Map([['central', [46.948, 7.4474]], ['mountainville', [47.2078, 7.5375]]]);
  };

  await test('a cached coordinate is offered for every field that names the place', async () => {
    const coords = geoFixture();
    const targets = map.coordWriteTargets(coords);
    assert.deepStrictEqual([...targets.keys()].sort(), ['Central', 'Mountainville']);
    assert.strictEqual(targets.get('Central').fields.length, 3, 'two events and a marriage');
  });

  await test('approving a place writes it, and not approving one leaves it alone', async () => {
    const coords = geoFixture();
    const changed = map.applyMapCoords(new Set(['Central']), coords);
    assert.strictEqual(changed, 3);
    const a = state.individuals.get('a');
    assert.deepStrictEqual(a.birth.map, [46.948, 7.4474]);
    assert.deepStrictEqual(a.death.map, [46.948, 7.4474]);
    assert.deepStrictEqual(state.families.get('F1').marriages[0].map, [46.948, 7.4474]);
    assert.strictEqual(state.individuals.get('b').birth.map, undefined,
      'a place nobody ticked must stay without coordinates');
  });

  await test('a place already carrying its coordinate is not offered again', async () => {
    const coords = geoFixture();
    map.applyMapCoords(new Set(['Central', 'Mountainville']), coords);
    assert.strictEqual(map.coordWriteTargets(coords).size, 0, 'nothing left to approve');
    assert.strictEqual(map.applyMapCoords(new Set(['Central']), coords), 0, 'and re-approving is a no-op');
  });

  await test('a coordinate that changed is offered again rather than silently kept', async () => {
    const coords = geoFixture();
    map.applyMapCoords(new Set(['Central']), coords);
    coords.set('central', [47.0, 8.0]);   // a better answer arrived
    const targets = map.coordWriteTargets(coords);
    assert.ok(targets.has('Central'), 'the records disagree with the cache, so it is a decision again');
  });

  await test('renaming a place drops the coordinates that were looked up for the old name', async () => {
    const places = await import(url('places.js'));
    const coords = geoFixture();
    map.applyMapCoords(new Set(['Central']), coords);
    places.applyPlaceRenames(new Map([['Central', 'Central, Republic']]));
    assert.strictEqual(state.individuals.get('a').birth.plac, 'Central, Republic');
    assert.strictEqual(state.individuals.get('a').birth.map, undefined,
      'coordinates found for one name must not be asserted about another');
  });

  await test('tidying spacing is not a rename and keeps the coordinates', async () => {
    const places = await import(url('places.js'));
    const coords = geoFixture();
    state.individuals.get('a').birth.plac = 'Central ,RP';
    coords.set(places.placeKey('Central ,RP'), [46.948, 7.4474]);
    map.applyMapCoords(new Set(['Central ,RP']), coords);
    places.applyPlaceRenames(new Map(), { tidy: true });
    assert.strictEqual(state.individuals.get('a').birth.plac, 'Central, RP');
    assert.deepStrictEqual(state.individuals.get('a').birth.map, [46.948, 7.4474]);
  });

  await test('a record that already carries coordinates draws without any lookup', async () => {
    // A GEDCOM with MAP subtrees is located the moment it loads. Requiring a
    // geocode run for coordinates the file already stated would be absurd.
    load([person('a', { birth: { date: '1820', plac: 'Central', map: [46.948, 7.4474] } })]);
    const groups = map.groupByPlace(map.collectMapEvents(), new Map());
    assert.deepStrictEqual(groups[0].ll, [46.948, 7.4474]);
    assert.strictEqual(map.coordWriteTargets(new Map()).size, 0, 'and there is nothing to approve');
  });

  await test('a corrected coordinate outranks the one in the record', async () => {
    // Otherwise pressing "this one" in the fix list would appear to do nothing
    // until the write was also approved.
    load([person('a', { birth: { date: '1820', plac: 'Central', map: [46.948, 7.4474] } })]);
    const groups = map.groupByPlace(map.collectMapEvents(), new Map([['central', [47, 8]]]));
    assert.deepStrictEqual(groups[0].ll, [47, 8]);
  });

  await test('a half-written coordinate is not treated as a location', async () => {
    load([person('a', { birth: { date: '1820', plac: 'Central', map: [46.948, null] } })]);
    assert.strictEqual(map.groupByPlace(map.collectMapEvents(), new Map())[0].ll, null);
  });

  await test('remembering a coordinate never overwrites one the user chose', async () => {
    localStorage.removeItem('placeCoords');
    const coords = map.placeCoords();
    coords.clear();
    assert.strictEqual(map.rememberPlaceCoords('Central', [46.948, 7.4474]), true);
    assert.strictEqual(map.rememberPlaceCoords('Central', [1, 1]), false, 'a second answer must not win');
    assert.deepStrictEqual(coords.get('central'), [46.948, 7.4474]);
    assert.strictEqual(map.rememberPlaceCoords('Central', [null, 1]), false, 'and rubbish is not an answer');
    coords.clear();
  });

  await test('the import wizard keeps the coordinates it reads instead of dropping them', async () => {
    // Its reader flattens people to string fields, so a MAP subtree has nowhere
    // on the record to go. It used to be silently discarded; now it lands in
    // the cache, where the map can offer to write it back after the merge.
    localStorage.removeItem('placeCoords');
    map.placeCoords().clear();
    const { _tiParseGedcomForMerge } = await import(url('import-parse.js'));
    _tiParseGedcomForMerge([
      '0 @I1@ INDI',
      '1 NAME Otto /Bauer/',
      '1 BIRT',
      '2 PLAC Central',
      '3 MAP',
      '4 LATI N46.947975',
      '4 LONG E7.447447',
      '1 DEAT',
      '2 PLAC Harbor City',
      '3 MAP',
      '4 LATI S33.045720',
      '4 LONG W71.619560',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 MARR',
      '2 PLAC Mountainville',
      '3 MAP',
      '4 LATI N47.207780',
      '4 LONG E7.537500',
      '0 TRLR',
    ].join('\n'));
    const coords = map.placeCoords();
    assert.deepStrictEqual(coords.get('central'), [46.947975, 7.447447]);
    assert.deepStrictEqual(coords.get('harbor city'), [-33.04572, -71.61956], 'south and west stay negative');
    assert.deepStrictEqual(coords.get('mountainville'), [47.20778, 7.5375], 'marriages count too');
    coords.clear();
  });

  console.log('\nediting a place');

  await test('changing a place drops the coordinates found for the old name', async () => {
    // The bug this exists for: retype "Central" as "Northport" in the detail panel and
    // the record kept Central's pin.
    const { setPlace } = await import(url('places.js'));
    const birth = { date: '1820', plac: 'Central', map: [46.948, 7.4474] };
    assert.strictEqual(setPlace(birth, 'Northport'), true);
    assert.strictEqual(birth.map, undefined);
  });

  await test('re-saving the same place keeps its coordinates', async () => {
    // Every edit-panel save writes every field back, so a no-op write must be a
    // no-op — otherwise editing an occupation would silently unlocate a person.
    const { setPlace } = await import(url('places.js'));
    const birth = { date: '1820', plac: 'Central', map: [46.948, 7.4474] };
    assert.strictEqual(setPlace(birth, '  Central  '), false, 'trimming is not a change');
    assert.deepStrictEqual(birth.map, [46.948, 7.4474]);
  });

  console.log('\ntiles');

  await test('the whole viewport is covered, and nothing above the north edge is asked for', async () => {
    const tiles = map.visibleTiles({ k: 256, x: 0, y: 0 }, 256, 256);
    assert.strictEqual(tiles.length, 1, 'a 256px world is exactly one tile');
    assert.deepStrictEqual([tiles[0].z, tiles[0].x, tiles[0].y], [0, 0, 0]);

    const zoomed = map.visibleTiles({ k: 1024, x: 0, y: 0 }, 1024, 1024);
    assert.strictEqual(zoomed.length, 16, 'zoom 2 covers the viewport with 4×4');
    assert.ok(zoomed.every(t => t.y >= 0 && t.y < 4), 'rows outside the world do not exist');
  });

  await test('panning past the antimeridian wraps the tile instead of asking for x = -1', async () => {
    const tiles = map.visibleTiles({ k: 1024, x: 300, y: 0 }, 400, 256);
    assert.ok(tiles.every(t => t.x >= 0 && t.x < 4), `wrapped columns: ${tiles.map(t => t.x)}`);
    assert.ok(tiles.some(t => t.sx < 0 || t.sx > 0), 'and they still get a screen position');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
