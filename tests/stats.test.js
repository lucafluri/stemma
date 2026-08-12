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
  const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
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

  console.log('\nnew statistics');

  await test('the most-descendants ranking counts every generation below, once each', async () => {
    // g -> c1, c2; c1 -> gc1, gc2 — g has 4 descendants, c1 has 2, c2 has 0.
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'g', wife: null, chil: ['c1', 'c2'], marriages: [] }],
      ['F2', { id: 'F2', husb: 'c1', wife: null, chil: ['gc1', 'gc2'], marriages: [] }],
    ]);
    const people = new Map([
      ['g', p('g', { fams: ['F1'] })],
      ['c1', p('c1', { famc: ['F1'], fams: ['F2'] })],
      ['c2', p('c2', { famc: ['F1'] })],
      ['gc1', p('gc1', { famc: ['F2'] })],
      ['gc2', p('gc2', { famc: ['F2'] })],
    ]);
    const s = load(people, fams);
    assert.deepStrictEqual(s.prolific[0], { id: 'g', n: 4, name: 'g' });
    assert.deepStrictEqual(s.prolific[1], { id: 'c1', n: 2, name: 'c1' });
  });

  await test('a shared descendant is not double-counted through a remarriage', async () => {
    // g married twice; both marriages produced the *same* recorded child would
    // be a data error, but a child appearing in fam.chil of only one marriage
    // must not inflate g's count via the other.
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'g', wife: 'w1', chil: ['c'], marriages: [] }],
      ['F2', { id: 'F2', husb: 'g', wife: 'w2', chil: [], marriages: [] }],
    ]);
    const people = new Map([
      ['g', p('g', { fams: ['F1', 'F2'] })],
      ['w1', p('w1', { fams: ['F1'] })],
      ['w2', p('w2', { fams: ['F2'] })],
      ['c', p('c', { famc: ['F1'] })],
    ]);
    const s = load(people, fams);
    assert.strictEqual(s.prolific.find(x => x.name === 'g').n, 1);
  });

  await test('twins are counted as one group per shared birth year, not per child', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'a', wife: 'b', chil: ['t1', 't2', 'solo'], marriages: [] }],
    ]);
    const people = new Map([
      ['a', p('a')], ['b', p('b')],
      ['t1', p('t1', { birthYear: 1900, famc: ['F1'] })],
      ['t2', p('t2', { birthYear: 1900, famc: ['F1'] })],
      ['solo', p('solo', { birthYear: 1905, famc: ['F1'] })],
    ]);
    assert.strictEqual(load(people, fams).twinGroups, 1);
  });

  await test('remarriage is counted from real families only, and the most-married person is named', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'a', wife: 'w1', chil: [], marriages: [] }],
      ['F2', { id: 'F2', husb: 'a', wife: 'w2', chil: [], marriages: [] }],
      ['F3', { id: 'F3', husb: 'a', wife: 'w3', chil: [], marriages: [] }],
    ]);
    const people = new Map([
      ['a', p('a', { fams: ['F1', 'F2', 'F3'] })],
      ['w1', p('w1', { fams: ['F1'] })],
      ['w2', p('w2', { fams: ['F2'] })],
      ['w3', p('w3', { fams: ['F3'] })],
    ]);
    const s = load(people, fams);
    assert.strictEqual(s.families2.remarried, 1, 'only "a" has more than one marriage');
    assert.deepStrictEqual(s.families2.mostMarried, { id: 'a', n: 3, name: 'a' });
  });

  await test('never-married is everyone absent from every family as a spouse', async () => {
    const fams = new Map([['F1', { id: 'F1', husb: 'a', wife: 'b', chil: [], marriages: [] }]]);
    const s = load(new Map([['a', p('a')], ['b', p('b')], ['c', p('c')]]), fams);
    assert.strictEqual(s.families2.neverMarried, 1);
  });

  await test('spousal age gap is the absolute difference between recorded birth years', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'h', wife: 'w', chil: [], marriages: [] }],
    ]);
    const s = load(new Map([
      ['h', p('h', { birthYear: 1880 })],
      ['w', p('w', { birthYear: 1895 })],
    ]), fams);
    assert.strictEqual(s.families2.spouseGap.n, 1);
    assert.strictEqual(s.families2.spouseGap.mean, 15);
    assert.strictEqual(s.families2.spouseGap.max, 15);
  });

  await test('a couple sharing a grandparent counts as a cousin couple', async () => {
    // GP -> p1, p2 (siblings); p1 -> h; p2 -> w; h marries w.
    const fams = new Map([
      ['FG', { id: 'FG', husb: 'gp', wife: null, chil: ['p1', 'p2'], marriages: [] }],
      ['F1', { id: 'F1', husb: 'p1', wife: null, chil: ['h'], marriages: [] }],
      ['F2', { id: 'F2', husb: 'p2', wife: null, chil: ['w'], marriages: [] }],
      ['F3', { id: 'F3', husb: 'h', wife: 'w', chil: [], marriages: [] }],
    ]);
    const people = new Map([
      ['gp', p('gp', { fams: ['FG'] })],
      ['p1', p('p1', { famc: ['FG'], fams: ['F1'] })],
      ['p2', p('p2', { famc: ['FG'], fams: ['F2'] })],
      ['h', p('h', { famc: ['F1'], fams: ['F3'] })],
      ['w', p('w', { famc: ['F2'], fams: ['F3'] })],
    ]);
    assert.strictEqual(load(people, fams).families2.cousinCouples, 1);
  });

  await test('an unrelated couple is not counted as sharing an ancestor', async () => {
    const fams = new Map([['F1', { id: 'F1', husb: 'h', wife: 'w', chil: [], marriages: [] }]]);
    const s = load(new Map([['h', p('h')], ['w', p('w')]]), fams);
    assert.strictEqual(s.families2.cousinCouples, 0);
  });

  await test('the births-per-decade timeline fills gap decades with zero rather than skipping them', async () => {
    const s = load(new Map([
      ['a', p('a', { birthYear: 1800 })],
      ['b', p('b', { birthYear: 1830 })],
    ]));
    assert.strictEqual(s.timeline.length, 4, '1800s, 1810s, 1820s, 1830s');
    assert.deepStrictEqual(s.timeline.map(d => d.n), [1, 0, 0, 1]);
  });

  await test('the youngest-at-marriage and youngest-parent figures are the minimum, not the mean', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'h', wife: 'w', chil: ['c'], marriages: [{ date: '1920' }] }],
    ]);
    const s = load(new Map([
      ['h', p('h', { birthYear: 1890, fams: ['F1'] })],   // married at 30
      ['w', p('w', { birthYear: 1900, fams: ['F1'] })],   // married at 20
      ['c', p('c', { birthYear: 1925, famc: ['F1'] })],   // h is 35, w is 25 at c's birth
    ]), fams);
    assert.strictEqual(s.marriageAge.min, 20);
    assert.strictEqual(s.parentAge.min, 25);
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
      ['a', p('a', { birthYear: 1900, death: { date: '1970' }, birth: { plac: 'Central' } })],
      ['b', p('b', { birthYear: 1910 })],
      ['c', p('c')], ['d', p('d')],
    ]));
    assert.strictEqual(s.completeness.birth, 0.5);
    assert.strictEqual(s.completeness.death, 0.25);
    assert.strictEqual(s.completeness.place, 0.25);
  });

  await test('given names are counted by the first one only', async () => {
    // "Otto Karl" and "Otto" are the same name being handed down, which is the
    // thing the list is for.
    const s = load(new Map([
      ['a', p('a', { givn: 'Otto', surn: 'Bauer', sex: 'M' })],
      ['b', p('b', { givn: 'Otto Karl', surn: 'Bauer', sex: 'M' })],
      ['c', p('c', { givn: 'Emma', surn: 'Weber', sex: 'F' })],
    ]));
    assert.deepStrictEqual(s.top.givenM[0], ['Otto', 2]);
    assert.deepStrictEqual(s.top.surnames[0], ['Bauer', 2]);
  });

  await test('the given-name ranking is kept per sex, ten of each', async () => {
    // Pooled, a tree with more men than women shows a list of men's names with
    // the odd woman's name in it, and neither pattern is readable.
    const s = load(new Map([
      ['a', p('a', { givn: 'Otto',  sex: 'M' })],
      ['b', p('b', { givn: 'Otto',  sex: 'M' })],
      ['c', p('c', { givn: 'Otto',  sex: 'M' })],
      ['d', p('d', { givn: 'Emma',  sex: 'F' })],
      ['e', p('e', { givn: 'Emma',  sex: 'F' })],
      ['f', p('f', { givn: 'Clara', sex: 'F' })],
    ]));
    assert.deepStrictEqual(s.top.givenM, [['Otto', 3]]);
    assert.deepStrictEqual(s.top.givenF, [['Emma', 2], ['Clara', 1]]);
    assert.deepStrictEqual(s.top.givenU, []);
  });

  await test('a name is only counted under the sex actually recorded', async () => {
    // Sasha is a man's name in Italy and a woman's in Germany — pooling them
    // would report a count that belongs to neither list.
    const s = load(new Map([
      ['a', p('a', { givn: 'Sasha', sex: 'M' })],
      ['b', p('b', { givn: 'Sasha', sex: 'F' })],
      ['c', p('c', { givn: 'Sasha' })],
    ]));
    assert.deepStrictEqual(s.top.givenM, [['Sasha', 1]]);
    assert.deepStrictEqual(s.top.givenF, [['Sasha', 1]]);
    assert.deepStrictEqual(s.top.givenU, [['Sasha', 1]],
      'people with no recorded sex still have to appear somewhere');
  });

  await test('a married woman counts towards the family she was born into as well', async () => {
    // She is a Weber by birth and a Bauer by marriage, and belongs to both
    // lines — which is the entire reason the maiden name is recorded.
    const s = load(new Map([
      ['a', p('a', { surn: 'Bauer' })],
      ['b', p('b', { surn: 'Bauer', maidenName: 'Weber' })],
    ]));
    assert.deepStrictEqual(s.top.surnames, [['Bauer', 2], ['Weber', 1]]);
  });

  await test('the statistics and the sidebar legend report the same family sizes', async () => {
    // They each used to count their own way — the legend both names, the
    // statistics only the married surname — so the same family had two
    // different sizes depending on which list you read.
    const { buildSurnameColorMap } = await import(url('colors.js'));
    const people = new Map([
      ['a', p('a', { surn: 'Bauer' })],
      ['b', p('b', { surn: 'Bauer', maidenName: 'Weber' })],
      ['c', p('c', { surn: ' Bauer ' })],          // stray whitespace is the same family
      ['d', p('d', { surn: 'Weber' })],
      ['e', p('e', { surn: '' })],                  // no family name at all
    ]);
    const s = load(people);
    state.individuals = people;
    const legend = new Map(buildSurnameColorMap().filter(([name]) => name !== null));
    for (const [name, n] of s.top.surnames) {
      assert.strictEqual(legend.get(name), n, `${name}: legend and statistics disagree`);
    }
    assert.strictEqual(legend.get('Bauer'), 3, 'the untrimmed name belongs to the same row');
  });

  await test('ties in a top list are ordered predictably, not by chance', async () => {
    const s = load(new Map([
      ['a', p('a', { surn: 'Zorn' })], ['b', p('b', { surn: 'Althaus' })],
    ]));
    assert.deepStrictEqual(s.top.surnames.map(x => x[0]), ['Althaus', 'Zorn'],
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
      ['a', p('a', { sex: 'M', surn: 'Bauer', givn: 'Otto', birthYear: 1900,
                     death: { date: '1970' }, deceased: true })],
      ['b', p('b', { sex: 'F', surn: 'Weber', givn: 'Emma', birthYear: 1910 })],
    ]));
    renderStats();
    const html = body().innerHTML;
    assert.ok(html.includes('Bauer'), 'the top surname should appear');
    assert.ok(/\b70\b/.test(html), 'the lifespan should appear');
    assert.ok(html.includes('stat-bar'), 'the sex split bar should be drawn');
  });

  await test('an open window follows the tree instead of freezing on what it opened with', async () => {
    // This is what made the statistics disagree with the sidebar's family-name
    // list: that list is rebuilt on every change, while the panel was rendered
    // only when it was opened — so after any edit the same family had two
    // different sizes on screen at once.
    const { refreshStats, openStatsTool, closeStatsTool } = await import(url('stats.js'));

    load(new Map([['a', p('a', { surn: 'Bauer' })]]));
    openStatsTool();
    assert.ok(body().textContent.includes('Bauer'), 'precondition: the window is showing');

    load(new Map([['a', p('a', { surn: 'Bauer' })], ['b', p('b', { surn: 'Weber' })]]));
    refreshStats();
    assert.ok(body().textContent.includes('Weber'), 'a person added while it is open must appear');

    // ...and a closed window still costs nothing to leave alone.
    closeStatsTool();
    const before = body().innerHTML;
    load(new Map([['c', p('c', { surn: 'Zorn' })]]));
    refreshStats();
    assert.strictEqual(body().innerHTML, before, 'a closed window should not be re-rendered');
  });

  await test('a long name keeps its count and stays readable on hover', async () => {
    // Ranks six to ten are where the long place names live, and a name long
    // enough to be ellipsised used to squeeze the number off the right edge.
    const place = 'Farawaytown, Bigdistrict, Regiontown, Greenstate, RA';
    load(new Map([['a', p('a', { birth: { date: '', plac: place } })]]));
    renderStats();
    const li = [...body().querySelectorAll('.stat-list li')]
      .find(el => el.textContent.includes('Farawaytown'));
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

  console.log('\ndrilling into a figure');

  const { showStatSubset, backToStatsOverview } = await import(url('stats.js'));
  const detail = () => global.document.getElementById('stats-detail');
  const detailList = () => global.document.getElementById('stats-detail-list');
  const rowNames = () => [...detailList().querySelectorAll('.find-row-name')].map(el => el.textContent);

  await test('clicking a sex figure lists exactly that group', async () => {
    load(new Map([
      ['a', p('a', { sex: 'M', displayName: 'Otto' })],
      ['b', p('b', { sex: 'F', displayName: 'Emma' })],
      ['c', p('c', { sex: 'M', displayName: 'Karl' })],
    ]));
    renderStats();
    showStatSubset('sex', 'M', 'Männlich');
    assert.deepStrictEqual(rowNames().sort(), ['Karl', 'Otto']);
    assert.strictEqual(body().style.display, 'none', 'the overview makes way for the list');
    assert.strictEqual(detail().style.display, 'flex');
  });

  await test('going back restores the overview and hides the detail list', async () => {
    backToStatsOverview();
    assert.strictEqual(detail().style.display, 'none');
    assert.strictEqual(body().style.display, '');
  });

  await test('a top-list name is clickable to exactly the people who carry it', async () => {
    load(new Map([
      ['a', p('a', { surn: 'Bauer', displayName: 'Otto Bauer' })],
      ['b', p('b', { surn: 'Bauer', displayName: 'Karl Bauer' })],
      ['c', p('c', { surn: 'Weber', displayName: 'Emma Weber' })],
    ]));
    renderStats();
    showStatSubset('surname', 'Bauer', 'Bauer');
    assert.deepStrictEqual(rowNames().sort(), ['Karl Bauer', 'Otto Bauer']);
  });

  await test('a decade bar is clickable to who was actually born then', async () => {
    load(new Map([
      ['a', p('a', { birthYear: 1852, displayName: 'A' })],
      ['b', p('b', { birthYear: 1859, displayName: 'B' })],
      ['c', p('c', { birthYear: 1861, displayName: 'C' })],   // next decade — must not appear
    ]));
    renderStats();
    showStatSubset('decade', 1850, '1850–1859');
    assert.deepStrictEqual(rowNames().sort(), ['A', 'B']);
  });

  await test('the most-descendants entry is clickable to its own descendants, not itself', async () => {
    const fams = new Map([['F1', { id: 'F1', husb: 'g', wife: null, chil: ['c'], marriages: [] }]]);
    load(new Map([
      ['g', p('g', { fams: ['F1'], displayName: 'Grandparent' })],
      ['c', p('c', { famc: ['F1'], displayName: 'Child' })],
    ]), fams);
    renderStats();
    showStatSubset('descendants', 'g', 'Grandparent');
    assert.deepStrictEqual(rowNames(), ['Child']);
  });

  await test('the largest spousal age gap is clickable to exactly that couple', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'h1', wife: 'w1', chil: [], marriages: [] }],  // 5-year gap
      ['F2', { id: 'F2', husb: 'h2', wife: 'w2', chil: [], marriages: [] }],  // 25-year gap
    ]);
    load(new Map([
      ['h1', p('h1', { birthYear: 1900, displayName: 'H1' })],
      ['w1', p('w1', { birthYear: 1905, displayName: 'W1' })],
      ['h2', p('h2', { birthYear: 1900, displayName: 'H2' })],
      ['w2', p('w2', { birthYear: 1925, displayName: 'W2' })],
    ]), fams);
    renderStats();
    showStatSubset('spouseGapMax', null, 'Largest age gap');
    assert.deepStrictEqual(rowNames().sort(), ['H2', 'W2']);
  });

  await test('youngest at marriage and youngest as a parent are clickable to those people', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'h', wife: 'w', chil: ['c'], marriages: [{ date: '1920' }] }],
    ]);
    load(new Map([
      ['h', p('h', { birthYear: 1890, fams: ['F1'], displayName: 'H' })],   // married at 30
      ['w', p('w', { birthYear: 1900, fams: ['F1'], displayName: 'W' })],   // married at 20
      ['c', p('c', { birthYear: 1925, famc: ['F1'], displayName: 'C' })],   // W is 25, H is 35 at birth
    ]), fams);
    renderStats();
    showStatSubset('youngestMarriage', null, 'Youngest at marriage');
    assert.deepStrictEqual(rowNames(), ['W'], 'w married youngest, at 20');
    showStatSubset('youngestParent', null, 'Youngest as a parent');
    assert.deepStrictEqual(rowNames(), ['W'], 'w was the younger parent, at 25');
  });

  await test('divorced is clickable to the two people who divorced', async () => {
    const fams = new Map([
      ['F1', { id: 'F1', husb: 'a', wife: 'b', chil: [], marriages: [], div: true }],
      ['F2', { id: 'F2', husb: 'c', wife: 'd', chil: [], marriages: [] }],
    ]);
    load(new Map([
      ['a', p('a', { displayName: 'A' })], ['b', p('b', { displayName: 'B' })],
      ['c', p('c', { displayName: 'C' })], ['d', p('d', { displayName: 'D' })],
    ]), fams);
    renderStats();
    showStatSubset('divorced', null, 'Divorced');
    assert.deepStrictEqual(rowNames().sort(), ['A', 'B']);
  });

  await test('each completeness row is clickable to who actually has that fact recorded', async () => {
    load(new Map([
      ['a', p('a', { birthYear: 1900, death: { date: '1970' }, birth: { plac: 'Central' }, displayName: 'A' })],
      ['b', p('b', { birthYear: 1910, displayName: 'B' })],
      ['c', p('c', { displayName: 'C' })],
    ]));
    renderStats();
    showStatSubset('hasBirth', null, 'Has a birth year');
    assert.deepStrictEqual(rowNames().sort(), ['A', 'B']);
    showStatSubset('hasDeath', null, 'Has a death year');
    assert.deepStrictEqual(rowNames(), ['A']);
    showStatSubset('hasPlace', null, 'Has a place');
    assert.deepStrictEqual(rowNames(), ['A']);
  });

  await test('an empty result still says so rather than showing a stale list', async () => {
    load(new Map([['a', p('a', { sex: 'M', displayName: 'Otto' })]]));
    renderStats();
    showStatSubset('sex', 'F', 'Weiblich');
    assert.strictEqual(detailList().querySelectorAll('.find-row').length, 0);
    assert.ok(detailList().textContent.trim().length > 0, 'an empty state message must still show');
  });

  await test('reopening the panel resets back to the overview', async () => {
    const { openStatsTool } = await import(url('stats.js'));
    load(new Map([['a', p('a', { sex: 'M' })]]));
    renderStats();
    showStatSubset('sex', 'M', 'Männlich');
    assert.strictEqual(detail().style.display, 'flex', 'precondition: the detail list is showing');
    openStatsTool();
    assert.strictEqual(detail().style.display, 'none', 'opening fresh must not strand the reader in a stale list');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
