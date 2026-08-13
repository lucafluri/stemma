#!/usr/bin/env node
'use strict';

/**
 * Tests for gedcom.js
 * Run with: node gedcom.test.js
 */

const assert = require('assert');
const {
  parseGEDCOM,
  serializeGEDCOM,
  exportJSON,
  importJSON,
  exportYAML,
  importYAML
} = require('../gedcom.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    if (e.actual !== undefined) {
      console.error(`    actual:   ${JSON.stringify(e.actual)}`);
      console.error(`    expected: ${JSON.stringify(e.expected)}`);
    }
    failed++;
  }
}

function deepEqual(a, b, msg) {
  assert.deepStrictEqual(a, b, msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// GEDCOM PARSER
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nGEDCOM Parser');

test('parses a simple individual', () => {
  const ged = `0 HEAD
1 SOUR Test
0 @I1@ INDI
1 NAME Otto /Example/
2 GIVN Otto
2 SURN Example
1 SEX M
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.ok(i, 'individual exists');
  assert.strictEqual(i.givn, 'Otto');
  assert.strictEqual(i.surn, 'Example');
  assert.strictEqual(i.name, 'Otto Example');
  assert.strictEqual(i.sex, 'M');
  assert.strictEqual(i.maidenName, '');
});

test('parses birth/death dates and places', () => {
  const ged = `0 @I1@ INDI
1 NAME Emma /Schulz/
1 BIRT
2 DATE 15 MAR 1950
2 PLAC Capital
1 DEAT
2 DATE 3 JAN 2020
2 PLAC Port
2 CAUS Heart failure
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.birth.date, '15 MAR 1950');
  assert.strictEqual(i.birth.plac, 'Capital');
  assert.strictEqual(i.birthYear, 1950);
  assert.strictEqual(i.death.date, '3 JAN 2020');
  assert.strictEqual(i.death.plac, 'Port');
  assert.strictEqual(i.death.caus, 'Heart failure');
  assert.strictEqual(i.deceased, true);
});

test('parses maiden name from NAME TYPE birth/married (new format)', () => {
  const ged = `0 @I1@ INDI
1 NAME Emma /Example/
2 GIVN Emma
2 SURN Example
2 TYPE birth
1 NAME Emma /Schulz/
2 GIVN Emma
2 SURN Schulz
2 TYPE married
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.givn, 'Emma');
  assert.strictEqual(i.surn, 'Schulz');
  assert.strictEqual(i.name, 'Emma Schulz');
  assert.strictEqual(i.maidenName, 'Example');
});

test('parses maiden name from legacy _MARN tag', () => {
  const ged = `0 @I1@ INDI
1 NAME Emma /Schulz/
2 GIVN Emma
2 SURN Schulz
1 _MARN Example
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.surn, 'Schulz');
  assert.strictEqual(i.maidenName, 'Example');
});

test('parses maiden name from second NAME record (legacy no-TYPE format)', () => {
  const ged = `0 @I1@ INDI
1 NAME Emma /Schulz/
1 NAME Emma /Example/
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.surn, 'Schulz');
  assert.strictEqual(i.maidenName, 'Example');
});

test('_MARN is ignored if NAME TYPE birth already found', () => {
  const ged = `0 @I1@ INDI
1 NAME Emma /Example/
2 TYPE birth
1 NAME Emma /Schulz/
2 TYPE married
1 _MARN Schmidt
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.maidenName, 'Example');
});

test('parses FAM record with marriage and children', () => {
  const ged = `0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 10 JUN 1975
2 PLAC Meadow
0 TRLR`;
  const { families } = parseGEDCOM(ged);
  const f = families.get('@F1@');
  assert.strictEqual(f.husb, '@I1@');
  assert.strictEqual(f.wife, '@I2@');
  deepEqual(f.chil, ['@I3@', '@I4@']);
  assert.strictEqual(f.marriages[0].date, '10 JUN 1975');
  assert.strictEqual(f.marriages[0].plac, 'Meadow');
});

test('parses FAM with divorce', () => {
  const ged = `0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 DIV Y
2 DATE 1990
0 TRLR`;
  const { families } = parseGEDCOM(ged);
  const f = families.get('@F1@');
  assert.strictEqual(f.div, true);
  assert.strictEqual(f.divDate, '1990');
});

test('parses UTF-8 BOM', () => {
  const ged = '﻿0 HEAD\n0 @I1@ INDI\n1 NAME Leo /Example/\n0 TRLR';
  const { individuals } = parseGEDCOM(ged);
  assert.ok(individuals.has('@I1@'));
});

test('generates displayName correctly', () => {
  const ged = `0 @I1@ INDI
1 NAME Otto /Schmidt/
0 @I2@ INDI
1 NAME Konstantin /Verylongname/
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  assert.strictEqual(individuals.get('@I1@').displayName, 'Otto Schmidt');
  // Long name should be abbreviated
  const i2 = individuals.get('@I2@');
  assert.ok(i2.displayName.length <= 24);
});

test('parses FAMC and FAMS links', () => {
  const ged = `0 @I1@ INDI
1 NAME Child /One/
1 FAMC @F1@
1 FAMS @F2@
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  deepEqual(i.famc, ['@F1@']);
  deepEqual(i.fams, ['@F2@']);
});

test('parses multi-line NOTE with CONT', () => {
  const ged = `0 @I1@ INDI
1 NAME Test /Person/
1 NOTE First line
2 CONT Second line
2 CONT Third line
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  assert.strictEqual(individuals.get('@I1@').note, 'First line\nSecond line\nThird line');
});

// ─────────────────────────────────────────────────────────────────────────────
// GEDCOM SERIALIZER
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nGEDCOM Serializer');

test('serializes maiden name as TYPE birth/married (not _MARN)', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Emma /Example/
2 TYPE birth
1 NAME Emma /Schulz/
2 TYPE married
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('2 TYPE birth'), 'should contain TYPE birth');
  assert.ok(out.includes('2 TYPE married'), 'should contain TYPE married');
  assert.ok(!out.includes('_MARN'), 'should NOT contain _MARN');
});

test('serializes maiden name with correct NAME lines', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Emma /Schulz/
1 _MARN Example
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('1 NAME Emma /Example/'), 'birth name line');
  assert.ok(out.includes('2 SURN Example'), 'birth SURN');
  assert.ok(out.includes('2 TYPE birth'));
  assert.ok(out.includes('1 NAME Emma /Schulz/'), 'married name line');
  assert.ok(out.includes('2 TYPE married'));
  assert.ok(!out.includes('_MARN'));
});

test('serializes individual without maiden name as single NAME', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Otto /Example/
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  const nameCount = (out.match(/^1 NAME/gm) || []).length;
  assert.strictEqual(nameCount, 1);
  assert.ok(!out.includes('TYPE birth'));
  assert.ok(!out.includes('TYPE married'));
});

test('serializes DEAT Y for deceased-only individuals', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Dead /Person/
1 DEAT Y
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('1 DEAT Y'));
});

test('round-trip GEDCOM preserves all data', () => {
  const original = `0 HEAD\r\n1 SOUR Test Source\r\n1 GEDC\r\n2 VERS 5.5.1\r\n2 FORM LINEAGE-LINKED\r\n1 CHAR UTF-8\r\n0 @I1@ INDI\r\n1 NAME Emma /Example/\r\n2 GIVN Emma\r\n2 SURN Example\r\n2 TYPE birth\r\n1 NAME Emma /Schulz/\r\n2 GIVN Emma\r\n2 SURN Schulz\r\n2 TYPE married\r\n1 SEX F\r\n1 BIRT\r\n2 DATE 1 JAN 1960\r\n2 PLAC Capital\r\n1 FAMS @F1@\r\n0 @F1@ FAM\r\n1 HUSB @I2@\r\n1 WIFE @I1@\r\n0 TRLR`;
  const { individuals, families } = parseGEDCOM(original);
  const out = serializeGEDCOM(individuals, families);
  const { individuals: i2 } = parseGEDCOM(out);
  const jane = i2.get('@I1@');
  assert.strictEqual(jane.givn,      'Emma');
  assert.strictEqual(jane.surn,      'Schulz');
  assert.strictEqual(jane.maidenName,'Example');
  assert.strictEqual(jane.birth.date,'1 JAN 1960');
  assert.strictEqual(jane.birth.plac,'Capital');
});

test('serializes FAM marriages and divorce', () => {
  const { individuals, families } = parseGEDCOM(`0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE 10 JUN 1975
2 PLAC Meadow
1 DIV Y
2 DATE 1990
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('2 DATE 10 JUN 1975'));
  assert.ok(out.includes('2 PLAC Meadow'));
  assert.ok(out.includes('1 DIV Y'));
  assert.ok(out.includes('2 DATE 1990'));
});

test('serializes multi-line NOTE with CONT', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Test /Person/
1 NOTE Line one
2 CONT Line two
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('1 NOTE Line one'));
  assert.ok(out.includes('2 CONT Line two'));
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON EXPORT/IMPORT
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nJSON Export/Import');

test('exportJSON produces valid JSON with individuals and families', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Emma /Schulz/
1 _MARN Example
0 @F1@ FAM
1 WIFE @I1@
0 TRLR`);
  const json = exportJSON(individuals, families);
  const data = JSON.parse(json);
  assert.strictEqual(data.format, 'gedcom-vis-json');
  assert.ok(Array.isArray(data.individuals));
  assert.ok(Array.isArray(data.families));
  assert.strictEqual(data.individuals[0].id, '@I1@');
  assert.strictEqual(data.individuals[0].maidenName, 'Example');
});

test('importJSON restores individuals and families', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Emma /Example/
2 TYPE birth
1 NAME Emma /Schulz/
2 TYPE married
1 BIRT
2 DATE 1 JAN 1960
0 @F1@ FAM
1 WIFE @I1@
0 TRLR`);
  const json = exportJSON(individuals, families);
  const imported = importJSON(json);
  const jane = imported.individuals.get('@I1@');
  assert.strictEqual(jane.maidenName, 'Example');
  assert.strictEqual(jane.surn, 'Schulz');
  assert.strictEqual(jane.birth.date, '1 JAN 1960');
  assert.ok(imported.families.has('@F1@'));
});

test('JSON round-trip preserves maiden name', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Clara /Sample/
1 _MARN Neumann
0 TRLR`);
  const json  = exportJSON(individuals, families);
  const imp   = importJSON(json);
  assert.strictEqual(imp.individuals.get('@I1@').maidenName, 'Neumann');
});

test('importJSON throws on invalid data', () => {
  assert.throws(() => importJSON('{"version":1}'), /Invalid JSON/);
});

// ─────────────────────────────────────────────────────────────────────────────
// YAML EXPORT/IMPORT
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nYAML Export/Import');

test('exportYAML produces non-empty string starting with comment', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Test /Person/
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  assert.ok(typeof yaml === 'string' && yaml.length > 0);
  assert.ok(yaml.startsWith('# gedcom-vis'));
  assert.ok(yaml.includes('individuals:'));
  assert.ok(yaml.includes('families:'));
});

test('YAML round-trip preserves maiden name', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Emma /Example/
2 TYPE birth
1 NAME Emma /Schulz/
2 TYPE married
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  const jane = imp.individuals.get('@I1@');
  assert.strictEqual(jane.maidenName, 'Example');
  assert.strictEqual(jane.surn, 'Schulz');
});

test('YAML round-trip preserves birth/death data', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Otto /Schmidt/
1 BIRT
2 DATE 5 MAY 1900
2 PLAC Riverview
1 DEAT
2 DATE 3 APR 1975
2 CAUS Old age
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  const otto = imp.individuals.get('@I1@');
  assert.strictEqual(otto.birth.date, '5 MAY 1900');
  assert.strictEqual(otto.birth.plac, 'Riverview');
  assert.strictEqual(otto.death.date, '3 APR 1975');
  assert.strictEqual(otto.death.caus, 'Old age');
});

test('YAML round-trip preserves families and children', () => {
  const { individuals, families } = parseGEDCOM(`0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 10 JUN 1975
2 PLAC Meadow
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  const fam  = imp.families.get('@F1@');
  assert.strictEqual(fam.husb, '@I1@');
  assert.strictEqual(fam.wife, '@I2@');
  deepEqual(fam.chil, ['@I3@', '@I4@']);
  assert.strictEqual(fam.marriages[0].date, '10 JUN 1975');
  assert.strictEqual(fam.marriages[0].plac, 'Meadow');
});

test('YAML round-trip with multiple individuals', () => {
  const ged = `0 @I1@ INDI
1 NAME Otto /Example/
1 SEX M
0 @I2@ INDI
1 NAME Emma /Example/
2 TYPE birth
1 NAME Emma /Schulz/
2 TYPE married
1 SEX F
0 TRLR`;
  const { individuals, families } = parseGEDCOM(ged);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  assert.strictEqual(imp.individuals.get('@I1@').surn, 'Example');
  assert.strictEqual(imp.individuals.get('@I2@').maidenName, 'Example');
  assert.strictEqual(imp.individuals.get('@I2@').surn, 'Schulz');
});

test('YAML handles empty arrays and null values', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Alone /Person/
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  const p    = imp.individuals.get('@I1@');
  deepEqual(p.famc, []);
  deepEqual(p.fams, []);
  assert.strictEqual(p.occu, '');
});

test('YAML handles IDs with @ signs', () => {
  const { individuals, families } = parseGEDCOM(`0 @I42@ INDI
1 NAME Special /ID/
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  // @I42@ must be quoted in YAML
  assert.ok(yaml.includes('"@I42@"'));
  const imp  = importYAML(yaml);
  assert.ok(imp.individuals.has('@I42@'));
});

test('importYAML throws on missing individuals', () => {
  assert.throws(() => importYAML('version: 1\nfamilies: []'), /Invalid YAML/);
});

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY COMPATIBILITY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nLegacy compatibility');

test('GEDCOM with _MARN is read correctly and saved with new format', () => {
  const legacyGED = `0 @I1@ INDI
1 NAME Elena /Example/
2 GIVN Elena
2 SURN Example
1 _MARN Schneider
1 SEX F
0 TRLR`;
  const { individuals, families } = parseGEDCOM(legacyGED);
  const maria = individuals.get('@I1@');
  // Correctly read
  assert.strictEqual(maria.surn, 'Example');
  assert.strictEqual(maria.maidenName, 'Schneider');

  // Written in new format
  const out = serializeGEDCOM(individuals, families);
  assert.ok(!out.includes('_MARN'), 'new output must not use _MARN');
  assert.ok(out.includes('TYPE birth'), 'new output must use TYPE birth');
  assert.ok(out.includes('TYPE married'), 'new output must use TYPE married');
  assert.ok(out.includes('1 NAME Elena /Schneider/'), 'birth name line');
  assert.ok(out.includes('1 NAME Elena /Example/'), 'married name line');
});

test('re-parsing the new output gives same maidenName', () => {
  const legacyGED = `0 @I1@ INDI
1 NAME Emma /Grau/
1 _MARN Schneider
0 TRLR`;
  const { individuals, families } = parseGEDCOM(legacyGED);
  const out = serializeGEDCOM(individuals, families);
  const { individuals: i2 } = parseGEDCOM(out);
  const emma = i2.get('@I1@');
  assert.strictEqual(emma.surn, 'Grau');
  assert.strictEqual(emma.maidenName, 'Schneider');
});

// ─────────────────────────────────────────────────────────────────────────────
// Lossless round-trip fixes
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nLossless round-trip fixes');

test('CONC concatenates note text without a line break', () => {
  const ged = `0 @I1@ INDI
1 NOTE abc
2 CONC def
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  assert.strictEqual(individuals.get('@I1@').note, 'abcdef');
});

test('CONT preserves leading whitespace in note continuation', () => {
  const ged = `0 @I1@ INDI
1 NOTE abc
2 CONT   indented
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  assert.strictEqual(individuals.get('@I1@').note, 'abc\n  indented');
});

test('unrecognized level-1 subtree round-trips inside INDI', () => {
  const ged = `0 @I1@ INDI
1 NAME Otto /Example/
1 CHR
2 DATE 1 JAN 1900
2 PLAC Malmo
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const out = serializeGEDCOM(individuals, new Map());
  assert.ok(out.includes('1 CHR'), 'CHR line preserved');
  assert.ok(out.includes('2 DATE 1 JAN 1900'), 'nested DATE preserved');
  assert.ok(out.includes('2 PLAC Malmo'), 'nested PLAC preserved');

  const { individuals: i2 } = parseGEDCOM(out);
  assert.ok((i2.get('@I1@')._unknown || []).some(l => l.includes('CHR')), 'still captured as unknown after re-parse');
});

test('unrecognized level-0 record round-trips via otherLines', () => {
  const ged = `0 @I1@ INDI
1 NAME Otto /Example/
0 @S1@ SOUR
1 TITL Church book
0 TRLR`;
  const { individuals, families, otherLines } = parseGEDCOM(ged);
  assert.ok(otherLines.some(l => l.includes('@S1@ SOUR')), 'SOUR record captured');
  assert.ok(otherLines.some(l => l.includes('TITL Church book')), 'SOUR sub-line captured');

  const out = serializeGEDCOM(individuals, families, otherLines);
  assert.ok(out.includes('0 @S1@ SOUR'), 'SOUR record re-emitted');
  assert.ok(out.includes('1 TITL Church book'), 'SOUR sub-line re-emitted');
  assert.ok(out.indexOf('0 @S1@ SOUR') < out.indexOf('0 TRLR'), 'emitted before TRLR');
});

test('FAM NOTE round-trips (preserved as unknown level-1 subtree)', () => {
  const ged = `0 @F1@ FAM
1 HUSB @I1@
1 NOTE Married in secret
0 TRLR`;
  const { families } = parseGEDCOM(ged);
  const out = serializeGEDCOM(new Map(), families);
  assert.ok(out.includes('1 NOTE Married in secret'), 'FAM NOTE preserved');
});

test('malicious xref with a quote is rejected', () => {
  const ged = `0 @I'x@ INDI
1 NAME Evil /Person/
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  assert.strictEqual(individuals.size, 0, 'malformed xref must not be parsed as a record');
});

test('JSON round-trip preserves unknown level-1 subtree', () => {
  const ged = `0 @I1@ INDI
1 NAME Otto /Example/
1 BURI
2 PLAC Malmo
0 TRLR`;
  const { individuals, families } = parseGEDCOM(ged);
  const json = exportJSON(individuals, families);
  const { individuals: i2 } = importJSON(json);
  const out = serializeGEDCOM(i2, new Map());
  assert.ok(out.includes('1 BURI'), 'BURI preserved through JSON round-trip');
  assert.ok(out.includes('2 PLAC Malmo'), 'nested PLAC preserved through JSON round-trip');
});

// ─────────────────────────────────────────────────────────────────────────────
// Exporting only the visible selection
// ─────────────────────────────────────────────────────────────────────────────
// visibleSubset() lives in js/gedcom-io.js, which is an ES module wired to the
// DOM. Lift it the way focus.test.js lifts the layout functions and hand it a
// plain `state` — it only ever reads state.nodes/individuals/families.
const fs = require('fs');
const path = require('path');
const ioSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'gedcom-io.js'), 'utf8');
const subsetSrc = ioSrc.match(/export function visibleSubset\(\) \{[\s\S]*?\n\}/)[0].replace('export ', '');
const visibleSubset = state =>
  new Function('state', `${subsetSrc}\nreturn visibleSubset();`)(state);

// GP1+GP2 -> PARENT ; PARENT+INLAW -> KID ; GP1+GP2 also -> AUNT (off-screen)
function buildSelectionFixture() {
  const ged = `0 @I1@ INDI
1 NAME Grand /Pa/
1 FAMS @F1@
0 @I2@ INDI
1 NAME Grand /Ma/
1 FAMS @F1@
0 @I3@ INDI
1 NAME Par /Ent/
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME In /Law/
1 FAMS @F2@
0 @I5@ INDI
1 NAME The /Kid/
1 FAMC @F2@
0 @I9@ INDI
1 NAME Off /Screen/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I9@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I5@
1 MARR
2 DATE 12 MAY 1901
0 TRLR`;
  return parseGEDCOM(ged);
}

// Every id a file points at must also be in it, or it breaks on the way back in.
function assertNoDanglingRefs(individuals, families, label) {
  for (const [id, i] of individuals) {
    for (const f of (i.famc || [])) assert.ok(families.has(f), `${label}: ${id} FAMC -> missing ${f}`);
    for (const f of (i.fams || [])) assert.ok(families.has(f), `${label}: ${id} FAMS -> missing ${f}`);
  }
  for (const [id, f] of families) {
    for (const p of [f.husb, f.wife]) {
      if (p) assert.ok(individuals.has(p), `${label}: ${id} spouse -> missing ${p}`);
    }
    for (const c of (f.chil || [])) assert.ok(individuals.has(c), `${label}: ${id} CHIL -> missing ${c}`);
  }
}

test('a selection export keeps only the visible people', () => {
  const { individuals, families } = buildSelectionFixture();
  const nodes = ['I1', 'I2', 'I3', 'I4', 'I5'].map(n => ({ id: `@${n}@`, type: 'INDI' }))
    .concat([{ id: '@F1@', type: 'FAM' }, { id: '@F2@', type: 'FAM' }]);
  const sub = visibleSubset({ individuals, families, nodes });

  assert.deepStrictEqual([...sub.individuals.keys()].sort(),
    ['@I1@', '@I2@', '@I3@', '@I4@', '@I5@'], 'the off-screen aunt must not be exported');
  assertNoDanglingRefs(sub.individuals, sub.families, 'selection');
  // ...and the family she was a child of survives, minus her.
  assert.deepStrictEqual(sub.families.get('@F1@').chil, ['@I3@'], 'F1 must drop the hidden child');
});

test('a selection export survives the round trip through GEDCOM and JSON', () => {
  const { individuals, families } = buildSelectionFixture();
  const nodes = ['I3', 'I4', 'I5'].map(n => ({ id: `@${n}@`, type: 'INDI' }));
  const sub = visibleSubset({ individuals, families, nodes });

  // I3's parents are gone, so the link up to F1 has to go with them.
  assert.deepStrictEqual(sub.individuals.get('@I3@').famc, [], 'FAMC to a dropped family must be pruned');
  assert.ok(!sub.families.has('@F1@'), 'a family with nobody left in it is not exported');

  for (const [label, reparse] of [
    ['gedcom', () => parseGEDCOM(serializeGEDCOM(sub.individuals, sub.families, []))],
    ['json',   () => importJSON(exportJSON(sub.individuals, sub.families))],
  ]) {
    const back = reparse();
    assert.deepStrictEqual([...back.individuals.keys()].sort(), ['@I3@', '@I4@', '@I5@'], `${label}: people`);
    assertNoDanglingRefs(back.individuals, back.families, label);
    assert.strictEqual(back.families.get('@F2@').marriages[0].date, '12 MAY 1901',
      `${label}: the marriage fact must come along`);
  }
});

test('a marriage is kept when only one spouse is on screen', () => {
  // Dropping it would throw away the marriage date, which is a fact about the
  // person who *is* in the selection.
  const { individuals, families } = buildSelectionFixture();
  const sub = visibleSubset({ individuals, families, nodes: [{ id: '@I3@', type: 'INDI' }] });
  assert.ok(sub.families.has('@F2@'), 'F2 should survive on I3 alone');
  assert.strictEqual(sub.families.get('@F2@').wife, null, 'the off-screen spouse must be unlinked');
  assertNoDanglingRefs(sub.individuals, sub.families, 'lone spouse');
});

test('exporting a selection does not mutate the loaded tree', () => {
  const { individuals, families } = buildSelectionFixture();
  visibleSubset({ individuals, families, nodes: [{ id: '@I3@', type: 'INDI' }] });
  assert.strictEqual(families.get('@F1@').chil.length, 2, 'the original family lost a child');
  assert.strictEqual(families.get('@F2@').wife, '@I4@', 'the original marriage lost a spouse');
  assert.deepStrictEqual(individuals.get('@I3@').famc, ['@F1@'], 'the original FAMC was pruned');
});

// ─────────────────────────────────────────────────────────────────────────────
// Place coordinates (the MAP subtree under PLAC)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nplace coordinates');

const GEO_GED = [
  '0 HEAD',
  '1 GEDC',
  '2 VERS 5.5.1',
  '0 @I1@ INDI',
  '1 NAME Otto /Bauer/',
  '1 BIRT',
  '2 DATE 3 JAN 1820',
  '2 PLAC Central',
  '3 MAP',
  '4 LATI N46.947975',
  '4 LONG E7.447447',
  '1 DEAT',
  '2 DATE 1890',
  '2 PLAC Harbor City',
  '3 MAP',
  '4 LATI S33.045720',
  '4 LONG W71.619560',
  '2 CAUS Fever',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '1 MARR',
  '2 DATE 1845',
  '2 PLAC Mountainville',
  '3 MAP',
  '4 LATI N47.207780',
  '4 LONG E7.537500',
  '0 TRLR',
].join('\n');

test('coordinates are read off every kind of event', () => {
  const { individuals, families } = parseGEDCOM(GEO_GED);
  const i = individuals.get('@I1@');
  deepEqual(i.birth.map, [46.947975, 7.447447], 'birth');
  // South and west are negative, which is the whole reason the hemisphere
  // letter cannot just be dropped.
  deepEqual(i.death.map, [-33.04572, -71.61956], 'death');
  deepEqual(families.get('@F1@').marriages[0].map, [47.20778, 7.5375], 'marriage');
});

test('a tag after the MAP subtree is still read as part of the event', () => {
  // "2 CAUS Fever" sits after "4 LONG" and belongs to DEAT, not to the map.
  const { individuals } = parseGEDCOM(GEO_GED);
  assert.strictEqual(individuals.get('@I1@').death.caus, 'Fever');
});

test('coordinates survive a GEDCOM round-trip', () => {
  const first = parseGEDCOM(GEO_GED);
  const out = serializeGEDCOM(first.individuals, first.families);
  assert.ok(out.includes('4 LATI N46.947975'), `MAP not written:\n${out}`);
  assert.ok(out.includes('4 LONG W71.619560'), 'west must come back out as W');
  const again = parseGEDCOM(out);
  deepEqual(again.individuals.get('@I1@').birth.map, [46.947975, 7.447447]);
  deepEqual(again.individuals.get('@I1@').death.map, [-33.04572, -71.61956]);
  deepEqual(again.families.get('@F1@').marriages[0].map, [47.20778, 7.5375]);
});

test('a MAP belongs to its own event and does not leak into the next one', () => {
  const { individuals } = parseGEDCOM(GEO_GED);
  const { individuals: i2 } = parseGEDCOM([
    '0 @I1@ INDI',
    '1 BIRT',
    '2 PLAC Central',
    '3 MAP',
    '4 LATI N46.947975',
    '4 LONG E7.447447',
    '1 DEAT',
    '2 PLAC Mountainville',
    '0 TRLR',
  ].join('\n'));
  assert.ok(individuals.get('@I1@').birth.map, 'precondition');
  assert.strictEqual(i2.get('@I1@').death.map, undefined, 'a place with no MAP has no coordinates');
});

test('a place without coordinates writes no MAP lines', () => {
  const { individuals, families } = parseGEDCOM([
    '0 @I1@ INDI', '1 BIRT', '2 PLAC Central', '0 TRLR',
  ].join('\n'));
  const out = serializeGEDCOM(individuals, families);
  assert.ok(!out.includes('MAP'), `an empty MAP subtree is worse than none:\n${out}`);
});

test('a half-written pair is not exported as if it were a location', () => {
  // Files in the wild carry "4 LATI" with no "4 LONG". Half a coordinate points
  // at the Gulf of Guinea, and writing it out would make that look deliberate.
  const { individuals, families } = parseGEDCOM([
    '0 @I1@ INDI', '1 BIRT', '2 PLAC Central', '3 MAP', '4 LATI N46.9', '0 TRLR',
  ].join('\n'));
  const out = serializeGEDCOM(individuals, families);
  assert.ok(!out.includes('MAP'), `incomplete coordinates must not be written:\n${out}`);
});

test('coordinates travel through JSON and YAML too', () => {
  const first = parseGEDCOM(GEO_GED);
  const viaJson = importJSON(exportJSON(first.individuals, first.families));
  deepEqual(viaJson.individuals.get('@I1@').birth.map, [46.947975, 7.447447], 'JSON');
  deepEqual(viaJson.families.get('@F1@').marriages[0].map, [47.20778, 7.5375], 'JSON marriage');

  const viaYaml = importYAML(exportYAML(first.individuals, first.families));
  deepEqual(viaYaml.individuals.get('@I1@').birth.map, [46.947975, 7.447447], 'YAML');
  deepEqual(viaYaml.individuals.get('@I1@').death.map, [-33.04572, -71.61956], 'YAML, negative');
  deepEqual(viaYaml.families.get('@F1@').marriages[0].map, [47.20778, 7.5375], 'YAML marriage');
});

// ─────────────────────────────────────────────────────────────────────────────
// Both directions of a family link
// ─────────────────────────────────────────────────────────────────────────────
//
// A family membership is stated twice in GEDCOM: on the FAM record
// (HUSB/WIFE/CHIL) and on each person (FAMS/FAMC). The chart is built from the
// first and every walk over the tree — focus, ancestors, descendants, the
// relation finder — reads the second. A file that states only one of the two
// used to draw all its connections and then behave as though nobody was
// related to anybody.
console.log('\nreciprocal family pointers');

test('a file that names members only on the FAM record still links them', () => {
  const { individuals, families } = parseGEDCOM([
    '0 HEAD',
    '0 @P0@ INDI', '1 NAME Child /Doe/',
    '0 @P1@ INDI', '1 NAME Father /Doe/', '1 SEX M',
    '0 @P2@ INDI', '1 NAME Mother /Roe/', '1 SEX F',
    '0 @F0@ FAM', '1 HUSB @P1@', '1 WIFE @P2@', '1 CHIL @P0@',
    '0 TRLR',
  ].join('\n'));
  deepEqual(individuals.get('@P0@').famc, ['@F0@'], 'the child knows its family');
  deepEqual(individuals.get('@P1@').fams, ['@F0@'], 'and so does the father');
  deepEqual(individuals.get('@P2@').fams, ['@F0@'], '...and the mother');
  assert.strictEqual(families.size, 1);
});

test('a file that names them only on the people fills the FAM record', () => {
  const { families } = parseGEDCOM([
    '0 HEAD',
    '0 @P0@ INDI', '1 NAME Child /Doe/', '1 FAMC @F0@',
    '0 @P1@ INDI', '1 NAME Father /Doe/', '1 SEX M', '1 FAMS @F0@',
    '0 @P2@ INDI', '1 NAME Mother /Roe/', '1 SEX F', '1 FAMS @F0@',
    '0 @F0@ FAM',
    '0 TRLR',
  ].join('\n'));
  const f = families.get('@F0@');
  assert.strictEqual(f.husb, '@P1@');
  assert.strictEqual(f.wife, '@P2@');
  deepEqual(f.chil, ['@P0@']);
});

test('a file that states both directions is left exactly as it is', () => {
  // The common case, and the one this must not touch: no duplicated ids, no
  // spouse slot rewritten.
  const src = [
    '0 HEAD',
    '0 @P0@ INDI', '1 NAME Child /Doe/', '1 FAMC @F0@',
    '0 @P1@ INDI', '1 NAME Father /Doe/', '1 SEX M', '1 FAMS @F0@',
    '0 @P2@ INDI', '1 NAME Mother /Roe/', '1 SEX F', '1 FAMS @F0@',
    '0 @F0@ FAM', '1 HUSB @P1@', '1 WIFE @P2@', '1 CHIL @P0@',
    '0 TRLR',
  ].join('\n');
  const { individuals, families } = parseGEDCOM(src);
  deepEqual(individuals.get('@P0@').famc, ['@F0@'], 'no duplicate famc');
  deepEqual(individuals.get('@P1@').fams, ['@F0@'], 'no duplicate fams');
  deepEqual(families.get('@F0@').chil, ['@P0@'], 'no duplicate child');
  assert.strictEqual(families.get('@F0@').husb, '@P1@');
});

test('a pointer to a family that is not in the file is not invented', () => {
  const { individuals, families } = parseGEDCOM([
    '0 HEAD',
    '0 @P0@ INDI', '1 NAME Orphan /Doe/', '1 FAMC @NOPE@',
    '0 TRLR',
  ].join('\n'));
  assert.strictEqual(families.size, 0, 'no family conjured from a dangling pointer');
  deepEqual(individuals.get('@P0@').famc, ['@NOPE@'], 'the pointer itself is left alone');
});

test('the repair survives a JSON round trip', () => {
  const { individuals, families } = parseGEDCOM([
    '0 HEAD',
    '0 @P0@ INDI', '1 NAME Child /Doe/',
    '0 @P1@ INDI', '1 NAME Father /Doe/', '1 SEX M',
    '0 @F0@ FAM', '1 HUSB @P1@', '1 CHIL @P0@',
    '0 TRLR',
  ].join('\n'));
  const back = importJSON(exportJSON(individuals, families));
  deepEqual(back.individuals.get('@P0@').famc, ['@F0@']);
  deepEqual(back.individuals.get('@P1@').fams, ['@F0@']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
