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

const src = fs.readFileSync(path.join(__dirname, 'js', 'import.js'), 'utf8');

function lift(name) {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert(m, `${name} not found in app.js — did it get renamed?`);
  return m[0];
}
function liftConst(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[[^\\]]*\\];`));
  assert(m, `${name} not found in app.js`);
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
    'state', 'document', '_renderImportCard', '_renderImportSummary',
    `${liftConst('_IM_UPDATE_FIELDS')}
     ${lift('_imExistingValue')}
     ${lift('_imLinkExisting')}
     ${lift('_imToggleFieldApply')}
     ${lift('_imUnlink')}
     return { _imLinkExisting, _imUnlink, _imToggleFieldApply, _imExistingValue };`
  )({ individuals, _importActions: actions }, { querySelector: () => null }, () => '', () => {});
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
