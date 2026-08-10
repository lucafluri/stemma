#!/usr/bin/env node
'use strict';

/**
 * Tests for the statistics panel.
 * Run with: node stats.test.js
 *
 * These figures are the one place in the app a reader is most likely to take a
 * number at face value, so the cases below are mostly about what must NOT be
 * counted: estimated years, impossible lifespans, people who are not there.
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

const p = (id, o = {}) => Object.assign({
  id, givn: '', surn: '', sex: 'U', displayName: id,
  birth: { date: '', plac: '' }, death: { date: '', plac: '', caus: '' },
  deceased: false, birthYear: null, famc: [], fams: [], occu: '', note: '',
}, o);

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, 'js', f)).href;
  const { computeStats } = await import(url('stats.js'));
  const { state } = await import(url('state.js'));

  const load = (individuals, families = new Map()) => {
    state.individuals = individuals;
    state.families = families;
    state._genDepthsCache = null;
    state._estimatedYears = null;
    return computeStats();
  };

  console.log('\nheadline counts');

  await test('an empty tree reports nothing rather than zeroes', async () => {
    assert.strictEqual(load(new Map()), null, 'the panel should say "no data", not show 0s');
  });

  await test('people are split by sex, with unknowns their own bucket', async () => {
    const s = load(new Map([
      ['a', p('a', { sex: 'M' })], ['b', p('b', { sex: 'F' })],
      ['c', p('c', { sex: 'F' })], ['d', p('d')],
    ]));
    assert.strictEqual(s.people, 4);
    assert.deepStrictEqual(s.sex, { M: 1, F: 2, U: 1 });
  });

  console.log('\nlifespans');

  await test('only people with both years recorded count towards the average', async () => {
    const s = load(new Map([
      ['a', p('a', { birthYear: 1900, death: { date: '1960' }, deceased: true })],  // 60
      ['b', p('b', { birthYear: 1900, death: { date: '1980' }, deceased: true })],  // 80
      ['c', p('c', { birthYear: 1900, deceased: true })],                            // no death year
      ['d', p('d', { death: { date: '1970' }, deceased: true })],                    // no birth year
      ['e', p('e', { birthYear: 1990 })],                                            // living
    ]));
    assert.strictEqual(s.lifespan.n, 2, 'only a and b have both ends recorded');
    assert.strictEqual(s.lifespan.mean, 70);
    assert.strictEqual(s.lifespan.median, 70);
  });

  await test('an estimated birth year is never used for a lifespan', async () => {
    // The layout estimates a year for everybody, and averaging those in would
    // produce a figure that looks like evidence and is not.
    const s = load(new Map([['a', p('a', { death: { date: '1900' }, deceased: true })]]));
    state._estimatedYears = new Map([['a', 1800]]);
    const again = computeStats();
    assert.strictEqual(s.lifespan.n, 0);
    assert.strictEqual(again.lifespan.n, 0, 'an estimate must not become a data point');
  });

  await test('impossible lifespans are thrown out, not averaged in', async () => {
    // A death before a birth, or a 300-year life, is a transcription slip or two
    // people merged into one. Averaging it drags the figure around silently.
    const s = load(new Map([
      ['ok',   p('ok',   { birthYear: 1900, death: { date: '1970' }, deceased: true })],
      ['back', p('back', { birthYear: 1950, death: { date: '1900' }, deceased: true })],
      ['long', p('long', { birthYear: 1600, death: { date: '1900' }, deceased: true })],
    ]));
    assert.strictEqual(s.lifespan.n, 1, 'only the plausible one counts');
    assert.strictEqual(s.lifespan.mean, 70);
    assert.strictEqual(s.lifespan.oldest.name, 'ok');
  });

  await test('children who died under 5 are not averaged into lifespan', async () => {
    const s = load(new Map([
      ['adult', p('adult', { birthYear: 1900, death: { date: '1970' }, deceased: true })],  // 70
      ['child', p('child', { birthYear: 1900, death: { date: '1902' }, deceased: true })],  // 2
      ['baby',  p('baby',  { birthYear: 1900, death: { date: '1900' }, deceased: true })],  // 0
    ]));
    assert.strictEqual(s.lifespan.n, 1, 'only the adult counts');
    assert.strictEqual(s.lifespan.mean, 70);
    assert.strictEqual(s.lifespan.childDeaths, 2);
    assert.strictEqual(s.lifespan.childRate, 2 / 3);
  });

  console.log('\nmarriage and parent age');

  await test('average age at first marriage is computed from birth and marriage years', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'h', wife: 'w', chil: [], marriages: [{ date: '1920' }] }],
    ]);
    const s = load(new Map([
      ['h', p('h', { sex: 'M', birthYear: 1890, fams: ['F1'] })],  // 30
      ['w', p('w', { sex: 'F', birthYear: 1895, fams: ['F1'] })],  // 25
    ]), fams);
    assert.strictEqual(s.marriageAge.n, 2);
    assert.strictEqual(s.marriageAge.mean, 27.5);
  });

  await test('average parent age at child birth uses known parent and child birth years', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'h', wife: 'w', chil: ['c'], marriages: [] }],
    ]);
    const s = load(new Map([
      ['h', p('h', { sex: 'M', birthYear: 1890 })],
      ['w', p('w', { sex: 'F', birthYear: 1895 })],
      ['c', p('c', { birthYear: 1920, famc: ['F1'] })],
    ]), fams);
    assert.strictEqual(s.parentAge.n, 2);
    assert.strictEqual(s.parentAge.mean, 27.5);
  });

  console.log('\nfamilies');

  await test('the children average covers families that have children', async () => {
    // Counting childless couples in answers a different question — "how many
    // children does a marriage produce" is about the ones that produced any.
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'a', wife: 'b', chil: ['c', 'd'], marriages: [] }],
      ['F2', { id: 'F2', husb: 'e', wife: null, chil: ['f', 'g', 'h', 'i'], marriages: [] }],
      ['F3', { id: 'F3', husb: null, wife: null, chil: [], marriages: [] }],
    ]);
    const people = new Map('abcdefghi'.split('').map(x => [x, p(x)]));
    const s = load(people, fams);
    assert.strictEqual(s.children.meanWithChildren, 3, '(2 + 4) / 2');
    assert.strictEqual(s.children.meanAll, 2, '(2 + 4 + 0) / 3');
    assert.strictEqual(s.children.childless, 1);
    assert.strictEqual(s.children.biggest.n, 4);
  });

  await test('children who are not in the file are not counted', async () => {
    // A GEDCOM can name a child it does not contain. Counting the name would
    // inflate every family-size figure on the panel.
    const fams = new Map([['F1', { id: 'F1', husb: 'a', wife: null, chil: ['b', 'ghost'], marriages: [] }]]);
    const s = load(new Map([['a', p('a')], ['b', p('b')]]), fams);
    assert.strictEqual(s.children.meanWithChildren, 1, 'only the child actually present counts');
    assert.strictEqual(s.children.biggest.n, 1);
  });

  console.log('\ncoverage and top lists');

  await test('coverage is the share of people with each fact recorded', async () => {
    const s = load(new Map([
      ['a', p('a', { birthYear: 1900, death: { date: '1970' }, birth: { plac: 'Bern' } })],
      ['b', p('b', { birthYear: 1910 })],
      ['c', p('c')], ['d', p('d')],
    ]));
    assert.strictEqual(s.completeness.birth, 0.5);
    assert.strictEqual(s.completeness.death, 0.25);
    assert.strictEqual(s.completeness.place, 0.25);
  });

  await test('given names are counted by the first one only', async () => {
    // "Hans Peter" and "Hans" are the same name being handed down, which is the
    // thing the list is for.
    const s = load(new Map([
      ['a', p('a', { givn: 'Hans', surn: 'Fluri' })],
      ['b', p('b', { givn: 'Hans Peter', surn: 'Fluri' })],
      ['c', p('c', { givn: 'Anna', surn: 'Meier' })],
    ]));
    assert.deepStrictEqual(s.top.givenNames[0], ['Hans', 2]);
    assert.deepStrictEqual(s.top.surnames[0], ['Fluri', 2]);
  });

  await test('a married woman counts towards the family she was born into as well', async () => {
    // She is a Meier by birth and a Fluri by marriage, and belongs to both
    // lines — which is the entire reason the maiden name is recorded.
    const s = load(new Map([
      ['a', p('a', { surn: 'Fluri' })],
      ['b', p('b', { surn: 'Fluri', maidenName: 'Meier' })],
    ]));
    assert.deepStrictEqual(s.top.surnames, [['Fluri', 2], ['Meier', 1]]);
  });

  await test('the statistics and the sidebar legend report the same family sizes', async () => {
    // They each used to count their own way — the legend both names, the
    // statistics only the married surname — so the same family had two
    // different sizes depending on which list you read.
    const { buildSurnameColorMap } = await import(url('colors.js'));
    const people = new Map([
      ['a', p('a', { surn: 'Fluri' })],
      ['b', p('b', { surn: 'Fluri', maidenName: 'Meier' })],
      ['c', p('c', { surn: ' Fluri ' })],          // stray whitespace is the same family
      ['d', p('d', { surn: 'Meier' })],
      ['e', p('e', { surn: '' })],                  // no family name at all
    ]);
    const s = load(people);
    state.individuals = people;
    const legend = new Map(buildSurnameColorMap().filter(([name]) => name !== null));
    for (const [name, n] of s.top.surnames) {
      assert.strictEqual(legend.get(name), n, `${name}: legend and statistics disagree`);
    }
    assert.strictEqual(legend.get('Fluri'), 3, 'the untrimmed name belongs to the same row');
  });

  await test('ties in a top list are ordered predictably, not by chance', async () => {
    const s = load(new Map([
      ['a', p('a', { surn: 'Zwahlen' })], ['b', p('b', { surn: 'Aebi' })],
    ]));
    assert.deepStrictEqual(s.top.surnames.map(x => x[0]), ['Aebi', 'Zwahlen'],
      'equal counts should fall back to alphabetical');
  });

  await test('causes of death are ranked by frequency', async () => {
    const s = load(new Map([
      ['a', p('a', { birthYear: 1900, death: { date: '1960', caus: 'Heart failure' }, deceased: true })],
      ['b', p('b', { birthYear: 1900, death: { date: '1970', caus: 'Heart failure' }, deceased: true })],
      ['c', p('c', { birthYear: 1900, death: { date: '1980', caus: 'Cancer' },       deceased: true })],
    ]));
    assert.deepStrictEqual(s.top.causes[0], ['Heart failure', 2]);
    assert.deepStrictEqual(s.top.causes[1], ['Cancer', 1]);
  });

  console.log('\nrendering');

  const { renderStats } = await import(url('stats.js'));
  const body = () => global.document.getElementById('stats-body');

  await test('the panel renders the figures into the sidebar', async () => {
    load(new Map([
      ['a', p('a', { sex: 'M', surn: 'Fluri', givn: 'Hans', birthYear: 1900,
                     death: { date: '1970' }, deceased: true })],
      ['b', p('b', { sex: 'F', surn: 'Meier', givn: 'Anna', birthYear: 1910 })],
    ]));
    renderStats();
    const html = body().innerHTML;
    assert.ok(html.includes('Fluri'), 'the top surname should appear');
    assert.ok(/\b70\b/.test(html), 'the lifespan should appear');
    assert.ok(html.includes('stat-bar'), 'the sex split bar should be drawn');
  });

  await test('an open panel follows the tree instead of freezing on what it opened with', async () => {
    // This is what made the statistics disagree with the sidebar's family-name
    // list: that list is rebuilt on every change, while the panel was rendered
    // only when it was opened — so after any edit the same family had two
    // different sizes on screen at once.
    const { refreshStats } = await import(url('stats.js'));
    const panel = global.document.getElementById('stats-panel');

    load(new Map([['a', p('a', { surn: 'Fluri' })]]));
    panel.open = true;
    refreshStats();
    assert.ok(body().textContent.includes('Fluri'), 'precondition: the panel is showing');

    load(new Map([['a', p('a', { surn: 'Fluri' })], ['b', p('b', { surn: 'Meier' })]]));
    refreshStats();
    assert.ok(body().textContent.includes('Meier'), 'a person added while it is open must appear');

    // ...and a closed panel still costs nothing to leave alone.
    panel.open = false;
    const before = body().innerHTML;
    load(new Map([['c', p('c', { surn: 'Zwahlen' })]]));
    refreshStats();
    assert.strictEqual(body().innerHTML, before, 'a closed panel should not be re-rendered');
  });

  await test('a long name keeps its count and stays readable on hover', async () => {
    // Ranks six to ten are where the long place names live, and a name long
    // enough to be ellipsised used to squeeze the number off the right edge.
    const place = 'Tettnang, Bodenseekreis, Tübingen, Baden-Württemberg, DE';
    load(new Map([['a', p('a', { birth: { date: '', plac: place } })]]));
    renderStats();
    const li = [...body().querySelectorAll('.stat-list li')]
      .find(el => el.textContent.includes('Tettnang'));
    assert.ok(li, 'the place should be listed');
    assert.strictEqual(li.children[0].getAttribute('title'), place, 'the full name belongs in the title');
    assert.strictEqual(li.children[1].textContent, '1', 'the count must survive next to it');
  });

  await test('an empty tree says so instead of rendering nothing', async () => {
    load(new Map());
    renderStats();
    assert.ok(body().textContent.trim().length > 0, 'the panel should not be silently blank');
  });

  await test('a name cannot inject markup into the panel', async () => {
    load(new Map([['a', p('a', { surn: '<img src=x onerror=alert(1)>', givn: 'A' })]]));
    renderStats();
    assert.strictEqual(body().querySelector('img'), null, 'a surname must not become markup');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
