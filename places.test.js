#!/usr/bin/env node
'use strict';

/**
 * Tests for the place-name cleanup.
 * Run with: node places.test.js
 *
 * The risk in this feature is not that it fails to group — it is that it
 * groups two places that are genuinely different, or rewrites a field nobody
 * ticked. Most of what follows is about where the grouping stops.
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

const p = (id, bplac, dplac) => ({
  id, name: id, givn: id, surn: '', maidenName: '', sex: 'U',
  birth: { date: '', plac: bplac || '' },
  death: { date: '', plac: dplac || '', caus: '' },
  deceased: false, birthYear: null, famc: [], fams: [], occu: '', note: '', displayName: id,
});

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, 'js', f)).href;
  const places = await import(url('places.js'));
  const { state } = await import(url('state.js'));

  const load = (indis, fams = []) => {
    state.individuals = new Map(indis.map(i => [i.id, i]));
    state.families = new Map(fams.map(f => [f.id, f]));
  };

  console.log('\nfolding a place name for comparison');

  await test('case, accents and punctuation all fold away', () => {
    assert.strictEqual(places.placeKey('Zürich'), places.placeKey('ZURICH'));
    assert.strictEqual(places.placeKey('St. Gallen'), places.placeKey('St  Gallen'));
    assert.strictEqual(places.placeKey('  Bern, CH '), 'bern ch');
  });

  await test('different places do not fold together', () => {
    assert.notStrictEqual(places.placeKey('Bern'), places.placeKey('Born'));
  });

  console.log('\nwhat counts as the same place');

  await test('a one-letter typo is a candidate', () => {
    assert.ok(places.looksRelated('luterbach', 'luterbah'));
  });

  await test('an added qualifier is a candidate', () => {
    assert.ok(places.looksRelated('bern', 'bern schweiz'));
  });

  await test('two unrelated names are not', () => {
    assert.ok(!places.looksRelated('bern', 'basel'));
    assert.ok(!places.looksRelated('bern schweiz', 'basel schweiz'),
      'sharing only the country must not be enough');
  });

  await test('a one-edit difference in a short name is not treated as a typo', () => {
    assert.ok(!places.looksRelated('Bern', 'Born'), 'both are real places');
    assert.ok(!places.looksRelated('Sion', 'Sitten'));
  });

  console.log('\nthe locality carries the match');

  await test('the first component is what gets compared', () => {
    assert.strictEqual(places.placeLocality('Luterbach, Solothurn, Schweiz'), 'luterbach');
    assert.strictEqual(places.placeLocality('Zürich'), 'zurich');
  });

  await test('the same town with completely different tails still matches', () => {
    assert.ok(places.looksRelated('Luterbach, CH', 'Luterbach, Solothurn, Schweiz'),
      'no token of one is a subset of the other, but the town is the same');
  });

  await test('a typo in the town matches across different tails', () => {
    assert.ok(places.looksRelated('Luterbah, CH', 'Luterbach, Solothurn'));
  });

  await test('different towns in the same canton do not match', () => {
    assert.ok(!places.looksRelated('Luterbach, Solothurn, CH', 'Derendingen, Solothurn, CH'),
      'sharing the tail is not sharing the place');
  });

  await test('the same town name in two countries is still only a suggestion', () => {
    load([p('a', 'Neuchâtel, Suisse'), p('b', 'Neuchâtel, France')]);
    const g = places.groupPlaces()[0];
    assert.ok(g, 'they belong in one group to be looked at');
    const other = g.variants.find(v => v.value !== g.canonical);
    assert.strictEqual(other.exact, false, 'a contradicting country must never pre-tick');
  });

  console.log('\ngrouping a tree');

  await test('spellings that differ only in case and accents land in one group', () => {
    load([p('a', 'Zürich'), p('b', 'zurich'), p('c', 'ZÜRICH')]);
    const groups = places.groupPlaces();
    assert.strictEqual(groups.length, 1, `expected one group, got ${groups.length}`);
    assert.strictEqual(groups[0].total, 3);
    assert.ok(groups[0].variants.every(v => v.exact), 'all three are the same word');
  });

  await test('the commonest spelling is the one proposed', () => {
    load([p('a', 'Zürich'), p('b', 'Zürich'), p('c', 'zurich')]);
    assert.strictEqual(places.groupPlaces()[0].canonical, 'Zürich');
  });

  await test('an equally common spelling that kept its capital and accent wins', () => {
    load([p('a', 'zurich'), p('b', 'Zürich')]);
    assert.strictEqual(places.groupPlaces()[0].canonical, 'Zürich');
  });

  await test('the tidier punctuation wins an otherwise exact tie', () => {
    load([p('a', 'Bern ,CH'), p('b', 'Bern, CH')]);
    assert.strictEqual(places.groupPlaces()[0].canonical, 'Bern, CH');
  });

  await test('between equally common spellings the more specific one wins', () => {
    load([p('a', 'Bern'), p('b', 'Bern, Schweiz')]);
    assert.strictEqual(places.groupPlaces()[0].canonical, 'Bern, Schweiz');
  });

  await test('a looser match is offered but not pre-ticked', () => {
    load([p('a', 'Bern'), p('b', 'Bern'), p('c', 'Bern, Schweiz')]);
    const g = places.groupPlaces()[0];
    const loose = g.variants.find(v => v.value === 'Bern, Schweiz');
    assert.ok(loose, 'the qualified spelling should be in the group');
    assert.strictEqual(loose.exact, false, 'it is not merely a spelling difference');
  });

  await test('a place with no variants is not a group', () => {
    load([p('a', 'Bern'), p('b', 'Basel')]);
    assert.deepStrictEqual(places.groupPlaces(), []);
  });

  console.log('\nmerging by hand');

  await test('two names no rule relates can be grouped anyway', () => {
    load([p('a', 'Sankt Gallen'), p('b', 'S. Gallen')]);
    assert.deepStrictEqual(places.groupPlaces(), [], 'nothing should relate them on its own');
    const g = places.groupPlaces(places.collectPlaces(), { merges: [['Sankt Gallen', 'S. Gallen']] });
    assert.strictEqual(g.length, 1);
    assert.deepStrictEqual(g[0].variants.map(v => v.value).sort(), ['S. Gallen', 'Sankt Gallen']);
  });

  await test('a hand-picked variant arrives ticked, unlike a guessed one', () => {
    load([p('a', 'Sankt Gallen'), p('b', 'S. Gallen')]);
    const g = places.groupPlaces(places.collectPlaces(), { merges: [['Sankt Gallen', 'S. Gallen']] })[0];
    assert.ok(g.variants.every(v => v.forced), 'the user named both of them');
  });

  await test('a hand-made group holds exactly what was named', () => {
    // Two spellings picked out of two existing groups make a group of those
    // two. Dragging their old group-mates along would be the opposite of what
    // "as a new group" asks for.
    load([
      p('a', 'Sankt Gallen'), p('b', 'sankt gallen'),
      p('c', 'S. Gallen'), p('d', 'S Gallen'),
    ]);
    assert.strictEqual(places.groupPlaces().length, 2, 'two separate groups to begin with');
    const g = places.groupPlaces(places.collectPlaces(), { merges: [['Sankt Gallen', 'S. Gallen']] });
    assert.strictEqual(g.length, 1);
    assert.deepStrictEqual(g[0].variants.map(v => v.value).sort(), ['S. Gallen', 'Sankt Gallen']);
  });

  await test('what a hand merge left behind is grouped automatically again', () => {
    load([
      p('a', 'Sankt Gallen'), p('b', 'sankt gallen'), p('c', 'SANKT GALLEN'),
      p('d', 'S. Gallen'),
    ]);
    const g = places.groupPlaces(places.collectPlaces(), { merges: [['Sankt Gallen', 'S. Gallen']] });
    assert.strictEqual(g.length, 2, 'the two spellings left over still match each other');
    const leftovers = g.find(x => !x.variants.some(v => v.forced));
    assert.deepStrictEqual(leftovers.variants.map(v => v.value).sort(), ['SANKT GALLEN', 'sankt gallen']);
  });

  await test('merging into a group joins all of it, not just its title', () => {
    // The UI hands over every member of the target group for this reason:
    // naming only the canonical would tear the group apart to admit one place.
    load([p('a', 'Zürich'), p('b', 'zurich'), p('c', 'Genf')]);
    const before = places.groupPlaces()[0];
    const g = places.groupPlaces(places.collectPlaces(),
      { merges: [['Genf', ...before.variants.map(v => v.value)]] });
    assert.strictEqual(g.length, 1);
    assert.deepStrictEqual(g[0].variants.map(v => v.value).sort(), ['Genf', 'Zürich', 'zurich']);
  });

  await test('naming a place that is not in the tree changes nothing', () => {
    load([p('a', 'Bern'), p('b', 'Basel')]);
    assert.deepStrictEqual(places.groupPlaces(places.collectPlaces(), { merges: [['Bern', 'Genf']] }), [],
      'a single real name is not a group');
  });

  console.log('\nrewriting the records');

  await test('renames reach births, deaths and marriages alike', () => {
    load(
      [p('a', 'zurich'), p('b', '', 'zurich')],
      [{ id: 'F1', husb: 'a', wife: 'b', chil: [], marriages: [{ date: '', plac: 'zurich', types: [] }], div: false, divDate: '' }],
    );
    const n = places.applyPlaceRenames(new Map([['zurich', 'Zürich']]));
    assert.strictEqual(n, 3, `three fields hold it, ${n} were rewritten`);
    assert.strictEqual(state.individuals.get('a').birth.plac, 'Zürich');
    assert.strictEqual(state.individuals.get('b').death.plac, 'Zürich');
    assert.strictEqual(state.families.get('F1').marriages[0].plac, 'Zürich');
  });

  await test('a place nobody renamed is left exactly as it was', () => {
    load([p('a', 'zurich'), p('b', 'Basel')]);
    places.applyPlaceRenames(new Map([['zurich', 'Zürich']]));
    assert.strictEqual(state.individuals.get('b').birth.plac, 'Basel');
  });

  await test('empty fields stay empty rather than becoming a place', () => {
    load([p('a', '')]);
    const n = places.applyPlaceRenames(new Map([['', 'Zürich']]), { tidy: true });
    assert.strictEqual(n, 0);
    assert.strictEqual(state.individuals.get('a').birth.plac, '');
  });

  console.log('\ntidying spacing');

  await test('repeated spaces and stray commas settle into one form', () => {
    assert.strictEqual(places.tidyPlace('Bern ,CH'), 'Bern, CH');
    assert.strictEqual(places.tidyPlace('Bern,,CH'), 'Bern, CH');
    assert.strictEqual(places.tidyPlace('  Bern   Mitte '), 'Bern Mitte');
    assert.strictEqual(places.tidyPlace('Bern,'), 'Bern');
  });

  await test('tidying applies even where nothing was renamed', () => {
    load([p('a', 'Bern ,CH')]);
    const n = places.applyPlaceRenames(new Map(), { tidy: true });
    assert.strictEqual(n, 1);
    assert.strictEqual(state.individuals.get('a').birth.plac, 'Bern, CH');
  });

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
