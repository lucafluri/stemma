#!/usr/bin/env node
'use strict';

/**
 * Tests for linking an import card to somebody already in the tree.
 * Run with: node import.test.js
 *
 * The functions under test live in js/import.js as real ES modules (state is
 * a shared `state.<name>` object rather than a bare global). They're lifted
 * out of the module's source text and run with a stand-in `state` object
 * injected, the same isolation technique the original monolithic app.js
 * tests used, since these functions are deeply entangled with the rest of
 * the import UI (rendering, DOM) that a plain `import()` would also pull in.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The parsing and merge half now lives in import-parse.js, the dialog in
// import.js. Both are read so a function moving between them does not break
// the lift — what is under test is the function, not which file holds it.
const src = ['import.js', 'import-parse.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8'))
  .join('\n');

function lift(name) {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert(m, `${name} not found under js/ — did it get renamed?`);
  return m[0];
}
function liftConst(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[[^\\]]*\\];`));
  assert(m, `${name} not found under js/`);
  return m[0];
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// One person already in the tree: born 1902 in Bern, no death recorded.
function buildTree() {
  return new Map([['@I1@', {
    name: 'Hans Muster',
    birth: { date: '1902', plac: 'Bern' },
    death: { date: '', plac: '' },
    sex: 'M',
    note: '',
  }]]);
}

// The import proposes the same man, but says 1901 and adds a death date.
function buildAction() {
  return {
    id: 'a1', kind: 'person', status: 'pending',
    fields: {
      'Name': 'Hans Muster', 'Birth Date': '1901', 'Birth Place': '',
      'Death Date': '1978', 'Death Place': '', 'Sex': 'M', 'Notes': '',
    },
    _person: {
      fullName: 'Hans Muster', birthDate: '1901', birthPlace: '',
      deathDate: '1978', deathPlace: '', sex: 'M', notes: '',
    },
  };
}

function makeApi(individuals, actions) {
  return new Function(
    'state', 'document', '_renderImportCard', '_renderImportSummary', '_imRepaintAction',
    `${liftConst('_IM_UPDATE_FIELDS')}
     ${lift('_imExistingValue')}
     ${lift('_imLinkExisting')}
     ${lift('_imToggleFieldApply')}
     ${lift('_imUnlink')}
     return { _imLinkExisting, _imUnlink, _imToggleFieldApply, _imExistingValue };`
  )({ individuals, _importActions: actions }, { querySelector: () => null }, () => '', () => {}, () => {});
}

console.log('\nimport linking');

test('linking keeps the imported values instead of dropping them', () => {
  // The old code replaced the card's fields with only what the tree lacked, so
  // an import that disagreed with the tree lost its own answer on the way in.
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  api._imLinkExisting(action, '@I1@');
  assert.strictEqual(action.fields['Birth Date'], '1901', 'the import said 1901 and must still say so');
  assert.strictEqual(action.kind, 'update');
  assert.strictEqual(action.existingId, '@I1@');
});

test('a gap in the tree is filled; a disagreement is not, unless asked', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  api._imLinkExisting(action, '@I1@');
  assert.strictEqual(action.fieldApply['Death Date'], true,
    'the tree has no death date, so the import fills it');
  assert.strictEqual(action.fieldApply['Birth Date'], false,
    'the tree says 1902 — do not overwrite it without being told');
  assert.strictEqual(action.fieldApply['Birth Place'], false, 'nothing to write');
  assert.strictEqual(action.fieldApply['Sex'], false, 'the tree already knows');
});

test('the choice can be flipped either way', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  api._imLinkExisting(action, '@I1@');
  api._imToggleFieldApply('a1', 'Birth Date');
  assert.strictEqual(action.fieldApply['Birth Date'], true, 'now prefer the import');
  api._imToggleFieldApply('a1', 'Birth Date');
  assert.strictEqual(action.fieldApply['Birth Date'], false, 'and back again');
});

test('unlink puts the card back exactly, including edits made by hand', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  action.fields['Birth Place'] = 'Thun';          // typed before linking
  const before = JSON.stringify(action.fields);

  api._imLinkExisting(action, '@I1@');
  api._imUnlink('a1');

  assert.strictEqual(JSON.stringify(action.fields), before, 'fields must round-trip');
  assert.strictEqual(action.kind, 'person');
  assert.strictEqual(action.status, 'pending');
  assert.strictEqual(action.existingId, undefined);
  assert.strictEqual(action.fieldApply, undefined);
});

test('link and unlink can be repeated without drift', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  const before = JSON.stringify(action.fields);
  for (let i = 0; i < 3; i++) {
    api._imLinkExisting(action, '@I1@');
    api._imUnlink('a1');
  }
  assert.strictEqual(JSON.stringify(action.fields), before);
});

test('a card that arrived already matched still unlinks to its parse', () => {
  // Auto-matched cards have no snapshot to restore, so the parsed person is the
  // only sensible thing to fall back to.
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  action.kind = 'update';
  action.existingId = '@I1@';
  api._imUnlink('a1');
  assert.strictEqual(action.kind, 'person');
  assert.strictEqual(action.fields['Birth Date'], '1901', 'falls back to the parsed person');
  assert.strictEqual(action.existingId, undefined);
});

test('linking an unknown person changes nothing', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  const before = JSON.stringify(action);
  assert.strictEqual(api._imLinkExisting(action, '@NOPE@'), false);
  assert.strictEqual(JSON.stringify(action), before, 'a failed link must not half-apply');
});

console.log('\nimport apply (which side actually gets written)');

// The apply pass, lifted far enough to exercise the per-field decision.
function applyUpdate(individuals, action) {
  const indi = individuals.get(action.existingId);
  const use = f => action.fieldApply ? !!action.fieldApply[f] : !!action.fields[f];
  if (use('Birth Date'))  indi.birth.date = action.fields['Birth Date'];
  if (use('Birth Place')) indi.birth.plac = action.fields['Birth Place'];
  if (use('Death Date')) { indi.death.date = action.fields['Death Date']; indi.deceased = true; }
  if (use('Death Place')) indi.death.plac = action.fields['Death Place'];
  if (use('Sex')) indi.sex = action.fields['Sex'];
  if (use('Notes')) indi.note = indi.note ? indi.note + '; ' + action.fields['Notes'] : action.fields['Notes'];
  return indi;
}

test('by default the tree keeps its own answer and gains what it lacked', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  api._imLinkExisting(action, '@I1@');
  const indi = applyUpdate(individuals, action);
  assert.strictEqual(indi.birth.date, '1902', 'the tree keeps its birth date');
  assert.strictEqual(indi.death.date, '1978', 'and gains the death date it lacked');
});

test('choosing the import writes the import', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  api._imLinkExisting(action, '@I1@');
  api._imToggleFieldApply('a1', 'Birth Date');
  const indi = applyUpdate(individuals, action);
  assert.strictEqual(indi.birth.date, '1901', 'the reader picked the import');
});

test('an empty imported value is never written over a real one', () => {
  const individuals = buildTree();
  const action = buildAction();
  const api = makeApi(individuals, [action]);
  api._imLinkExisting(action, '@I1@');
  const indi = applyUpdate(individuals, action);
  assert.strictEqual(indi.birth.plac, 'Bern', 'the import had no birth place to offer');
});

// ── Merging a second file into a tree that is already loaded ────────────────
//
// The three questions the diff table has to answer: what is new, what already
// matches, and what would float off on its own if imported as-is.

// Hans + Anna, married, with one child Peter.
function buildFamilyTree() {
  const individuals = new Map([
    ['@I1@', { id:'@I1@', name:'Hans Muster', sex:'M', birth:{date:'1900',plac:''}, death:{date:'',plac:''}, note:'', fams:['@F1@'], famc:[] }],
    ['@I2@', { id:'@I2@', name:'Anna Muster', sex:'F', birth:{date:'1902',plac:''}, death:{date:'',plac:''}, note:'', fams:['@F1@'], famc:[] }],
    ['@I3@', { id:'@I3@', name:'Peter Muster', sex:'M', birth:{date:'1930',plac:''}, death:{date:'',plac:''}, note:'', fams:[], famc:['@F1@'] }],
  ]);
  const families = new Map([
    ['@F1@', { id:'@F1@', husb:'@I1@', wife:'@I2@', chil:['@I3@'], marriages:[{date:'1928',plac:'Bern',types:[]}], div:false, divDate:'' }],
  ]);
  return { individuals, families };
}

function mergeApi(individuals, families) {
  const state = { individuals, families };
  const api = new Function(
    'state',
    `${lift('_tiNormName')}
     ${lift('_tiParseName')}
     ${lift('_tiLevenshtein')}
     ${lift('_tiNameScore')}
     ${lift('_tiGenerateActions')}
     ${lift('_tiConnectivity')}
     ${lift('_tiApplyActions')}
     return { _tiGenerateActions, _tiConnectivity, _tiApplyActions };`
  )(state);
  api.state = state;
  return api;
}

// The same couple as the tree has, but the file knows a second child.
function personHansWithTwoKids() {
  return {
    fullName:'Hans Muster', sex:'M', birthDate:'1900', birthPlace:'',
    deathDate:'', deathPlace:'', fatherName:'', motherName:'', notes:'',
    sourceNote:'', marriages:[{
      spouseName:'Anna Muster', date:'1928', place:'Bern',
      children:[{ fullName:'Peter Muster' }, { fullName:'Klara Muster' }],
    }],
  };
}

function bareperson(fullName, birthDate) {
  return {
    fullName, sex:'', birthDate: birthDate || '', birthPlace:'',
    deathDate:'', deathPlace:'', fatherName:'', motherName:'', notes:'',
    sourceNote:'', marriages:[],
  };
}

console.log('\nmerging a second file (diff, connection, children)');

test('a person the tree already holds identically is reported, not hidden', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([bareperson('Peter Muster', '1930')]);
  const same = actions.filter(a => a.kind === 'same');
  assert.strictEqual(same.length, 1, 'the row has to exist — "identical" is an answer');
  assert.strictEqual(same[0].status, 'skipped', 'but nothing about it needs approving');
  assert.strictEqual(same[0].existingId, '@I3@');
});

test('a child the tree lacks is hung off the family the tree already has', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([personHansWithTwoKids()]);
  const marr = actions.filter(a => a.kind === 'marriage');
  assert.strictEqual(marr.length, 1, 'the couple is known, so this is a child addition');
  assert.strictEqual(marr[0].existingFamId, '@F1@');
  assert.strictEqual(marr[0].fields['Children'], 'Klara Muster',
    'Peter is already in that family — only Klara is news');
});

test('a couple the tree has with no new children makes no row at all', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const p = personHansWithTwoKids();
  p.marriages[0].children = [{ fullName: 'Peter Muster' }];
  assert.strictEqual(api._tiGenerateActions([p]).filter(a => a.kind === 'marriage').length, 0);
});

test('applying it puts the child in the existing family, not a duplicate one', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([personHansWithTwoKids(), bareperson('Klara Muster')]);
  actions.forEach(a => { if (a.kind !== 'same') a.status = 'approved'; });
  api._tiApplyActions(actions);

  assert.strictEqual(families.size, 1, 'no second @F@ record for a couple already recorded');
  const fam = families.get('@F1@');
  assert.strictEqual(fam.chil.length, 2, 'Peter and Klara');
  const klaraId = fam.chil.find(id => individuals.get(id)?.name === 'Klara Muster');
  assert(klaraId, 'Klara made it into the family');
  assert.deepStrictEqual(individuals.get(klaraId).famc, ['@F1@'], 'and points back at it');
});

test('applying it twice does not list the same child twice', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([personHansWithTwoKids(), bareperson('Klara Muster')]);
  actions.forEach(a => { if (a.kind !== 'same') a.status = 'approved'; });
  api._tiApplyActions(actions);
  api._tiApplyActions(actions);
  assert.strictEqual(families.get('@F1@').chil.length, 2);
});

console.log('\nwould this import land connected to the tree?');

test('a person reachable through an existing family counts as connected', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([personHansWithTwoKids(), bareperson('Klara Muster')]);
  const klara = actions.find(a => a.kind === 'person' && a.fields['Name'] === 'Klara Muster');
  assert(klara, 'Klara is a new person');
  assert.strictEqual(api._tiConnectivity(actions).get(klara.id), true);
});

test('a person with no tie to anything in the tree is flagged', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([bareperson('Fremder Mann', '1880')]);
  const loner = actions.find(a => a.kind === 'person');
  assert.strictEqual(api._tiConnectivity(actions).get(loner.id), false);
});

test('an island of imported people connected only to each other is still an island', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const dad = bareperson('Fremder Mann', '1880');
  dad.marriages = [{ spouseName:'Fremde Frau', date:'', place:'', children:[{ fullName:'Fremdes Kind' }] }];
  const actions = api._tiGenerateActions([dad, bareperson('Fremde Frau'), bareperson('Fremdes Kind')]);
  const conn = api._tiConnectivity(actions);
  for (const a of actions.filter(a => a.kind === 'person')) {
    assert.strictEqual(conn.get(a.id), false, `${a.fields['Name']} is on the island`);
  }
});

test('a tie sitting in a card nobody approved yet does not count as written', () => {
  // The preview counts every card still in play, so Klara reads as connected.
  // What will actually be written is another matter: approving only Klara puts
  // her in the file with nothing holding her to anybody.
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([personHansWithTwoKids(), bareperson('Klara Muster')]);
  const klara = actions.find(a => a.kind === 'person' && a.fields['Name'] === 'Klara Muster');
  const marr  = actions.find(a => a.kind === 'marriage');

  klara.status = 'approved';
  const approvedOnly = a => a.status === 'approved';
  assert.strictEqual(api._tiConnectivity(actions).get(klara.id), true, 'preview: fine once you approve the lot');
  assert.strictEqual(api._tiConnectivity(actions, approvedOnly).get(klara.id), false,
    'reality: the card that adopts her is still pending');

  marr.status = 'approved';
  assert.strictEqual(api._tiConnectivity(actions, approvedOnly).get(klara.id), true,
    'approving that card is what fixes it');
});

test('skipping the card that carried the tie strands the people it held', () => {
  const { individuals, families } = buildFamilyTree();
  const api = mergeApi(individuals, families);
  const actions = api._tiGenerateActions([personHansWithTwoKids(), bareperson('Klara Muster')]);
  const klara = actions.find(a => a.kind === 'person' && a.fields['Name'] === 'Klara Muster');
  assert.strictEqual(api._tiConnectivity(actions).get(klara.id), true);
  actions.find(a => a.kind === 'marriage').status = 'skipped';
  assert.strictEqual(api._tiConnectivity(actions).get(klara.id), false,
    'without that family card there is nothing holding her on');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
