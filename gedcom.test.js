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
} = require('./gedcom.js');

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
1 NAME John /Doe/
2 GIVN John
2 SURN Doe
1 SEX M
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.ok(i, 'individual exists');
  assert.strictEqual(i.givn, 'John');
  assert.strictEqual(i.surn, 'Doe');
  assert.strictEqual(i.name, 'John Doe');
  assert.strictEqual(i.sex, 'M');
  assert.strictEqual(i.maidenName, '');
});

test('parses birth/death dates and places', () => {
  const ged = `0 @I1@ INDI
1 NAME Jane /Smith/
1 BIRT
2 DATE 15 MAR 1950
2 PLAC Berlin
1 DEAT
2 DATE 3 JAN 2020
2 PLAC Hamburg
2 CAUS Herzversagen
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.birth.date, '15 MAR 1950');
  assert.strictEqual(i.birth.plac, 'Berlin');
  assert.strictEqual(i.birthYear, 1950);
  assert.strictEqual(i.death.date, '3 JAN 2020');
  assert.strictEqual(i.death.plac, 'Hamburg');
  assert.strictEqual(i.death.caus, 'Herzversagen');
  assert.strictEqual(i.deceased, true);
});

test('parses maiden name from NAME TYPE birth/married (new format)', () => {
  const ged = `0 @I1@ INDI
1 NAME Jane /Doe/
2 GIVN Jane
2 SURN Doe
2 TYPE birth
1 NAME Jane /Smith/
2 GIVN Jane
2 SURN Smith
2 TYPE married
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.givn, 'Jane');
  assert.strictEqual(i.surn, 'Smith');
  assert.strictEqual(i.name, 'Jane Smith');
  assert.strictEqual(i.maidenName, 'Doe');
});

test('parses maiden name from legacy _MARN tag', () => {
  const ged = `0 @I1@ INDI
1 NAME Jane /Smith/
2 GIVN Jane
2 SURN Smith
1 _MARN Doe
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.surn, 'Smith');
  assert.strictEqual(i.maidenName, 'Doe');
});

test('parses maiden name from second NAME record (legacy no-TYPE format)', () => {
  const ged = `0 @I1@ INDI
1 NAME Jane /Smith/
1 NAME Jane /Doe/
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.surn, 'Smith');
  assert.strictEqual(i.maidenName, 'Doe');
});

test('_MARN is ignored if NAME TYPE birth already found', () => {
  const ged = `0 @I1@ INDI
1 NAME Jane /Doe/
2 TYPE birth
1 NAME Jane /Smith/
2 TYPE married
1 _MARN Mueller
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  const i = individuals.get('@I1@');
  assert.strictEqual(i.maidenName, 'Doe');
});

test('parses FAM record with marriage and children', () => {
  const ged = `0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 10 JUN 1975
2 PLAC Munich
0 TRLR`;
  const { families } = parseGEDCOM(ged);
  const f = families.get('@F1@');
  assert.strictEqual(f.husb, '@I1@');
  assert.strictEqual(f.wife, '@I2@');
  deepEqual(f.chil, ['@I3@', '@I4@']);
  assert.strictEqual(f.marriages[0].date, '10 JUN 1975');
  assert.strictEqual(f.marriages[0].plac, 'Munich');
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
  const ged = '﻿0 HEAD\n0 @I1@ INDI\n1 NAME Max /Muster/\n0 TRLR';
  const { individuals } = parseGEDCOM(ged);
  assert.ok(individuals.has('@I1@'));
});

test('generates displayName correctly', () => {
  const ged = `0 @I1@ INDI
1 NAME Hans /Mueller/
0 @I2@ INDI
1 NAME Bartholomäus /Langnamensmann/
0 TRLR`;
  const { individuals } = parseGEDCOM(ged);
  assert.strictEqual(individuals.get('@I1@').displayName, 'Hans Mueller');
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
1 NAME Jane /Doe/
2 TYPE birth
1 NAME Jane /Smith/
2 TYPE married
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('2 TYPE birth'), 'should contain TYPE birth');
  assert.ok(out.includes('2 TYPE married'), 'should contain TYPE married');
  assert.ok(!out.includes('_MARN'), 'should NOT contain _MARN');
});

test('serializes maiden name with correct NAME lines', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Jane /Smith/
1 _MARN Doe
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('1 NAME Jane /Doe/'), 'birth name line');
  assert.ok(out.includes('2 SURN Doe'), 'birth SURN');
  assert.ok(out.includes('2 TYPE birth'));
  assert.ok(out.includes('1 NAME Jane /Smith/'), 'married name line');
  assert.ok(out.includes('2 TYPE married'));
  assert.ok(!out.includes('_MARN'));
});

test('serializes individual without maiden name as single NAME', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME John /Doe/
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
  const original = `0 HEAD\r\n1 SOUR Stammbaum Vis\r\n1 GEDC\r\n2 VERS 5.5.1\r\n2 FORM LINEAGE-LINKED\r\n1 CHAR UTF-8\r\n0 @I1@ INDI\r\n1 NAME Jane /Doe/\r\n2 GIVN Jane\r\n2 SURN Doe\r\n2 TYPE birth\r\n1 NAME Jane /Smith/\r\n2 GIVN Jane\r\n2 SURN Smith\r\n2 TYPE married\r\n1 SEX F\r\n1 BIRT\r\n2 DATE 1 JAN 1960\r\n2 PLAC Berlin\r\n1 FAMS @F1@\r\n0 @F1@ FAM\r\n1 HUSB @I2@\r\n1 WIFE @I1@\r\n0 TRLR`;
  const { individuals, families } = parseGEDCOM(original);
  const out = serializeGEDCOM(individuals, families);
  const { individuals: i2 } = parseGEDCOM(out);
  const jane = i2.get('@I1@');
  assert.strictEqual(jane.givn,      'Jane');
  assert.strictEqual(jane.surn,      'Smith');
  assert.strictEqual(jane.maidenName,'Doe');
  assert.strictEqual(jane.birth.date,'1 JAN 1960');
  assert.strictEqual(jane.birth.plac,'Berlin');
});

test('serializes FAM marriages and divorce', () => {
  const { individuals, families } = parseGEDCOM(`0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE 10 JUN 1975
2 PLAC Munich
1 DIV Y
2 DATE 1990
0 TRLR`);
  const out = serializeGEDCOM(individuals, families);
  assert.ok(out.includes('2 DATE 10 JUN 1975'));
  assert.ok(out.includes('2 PLAC Munich'));
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
1 NAME Jane /Smith/
1 _MARN Doe
0 @F1@ FAM
1 WIFE @I1@
0 TRLR`);
  const json = exportJSON(individuals, families);
  const data = JSON.parse(json);
  assert.strictEqual(data.format, 'gedcom-vis-json');
  assert.ok(Array.isArray(data.individuals));
  assert.ok(Array.isArray(data.families));
  assert.strictEqual(data.individuals[0].id, '@I1@');
  assert.strictEqual(data.individuals[0].maidenName, 'Doe');
});

test('importJSON restores individuals and families', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Jane /Doe/
2 TYPE birth
1 NAME Jane /Smith/
2 TYPE married
1 BIRT
2 DATE 1 JAN 1960
0 @F1@ FAM
1 WIFE @I1@
0 TRLR`);
  const json = exportJSON(individuals, families);
  const imported = importJSON(json);
  const jane = imported.individuals.get('@I1@');
  assert.strictEqual(jane.maidenName, 'Doe');
  assert.strictEqual(jane.surn, 'Smith');
  assert.strictEqual(jane.birth.date, '1 JAN 1960');
  assert.ok(imported.families.has('@F1@'));
});

test('JSON round-trip preserves maiden name', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Marie /Curie/
1 _MARN Sklodowska
0 TRLR`);
  const json  = exportJSON(individuals, families);
  const imp   = importJSON(json);
  assert.strictEqual(imp.individuals.get('@I1@').maidenName, 'Sklodowska');
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
1 NAME Jane /Doe/
2 TYPE birth
1 NAME Jane /Smith/
2 TYPE married
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  const jane = imp.individuals.get('@I1@');
  assert.strictEqual(jane.maidenName, 'Doe');
  assert.strictEqual(jane.surn, 'Smith');
});

test('YAML round-trip preserves birth/death data', () => {
  const { individuals, families } = parseGEDCOM(`0 @I1@ INDI
1 NAME Hans /Mueller/
1 BIRT
2 DATE 5 MAY 1900
2 PLAC Vienna
1 DEAT
2 DATE 3 APR 1975
2 CAUS Old age
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  const hans = imp.individuals.get('@I1@');
  assert.strictEqual(hans.birth.date, '5 MAY 1900');
  assert.strictEqual(hans.birth.plac, 'Vienna');
  assert.strictEqual(hans.death.date, '3 APR 1975');
  assert.strictEqual(hans.death.caus, 'Old age');
});

test('YAML round-trip preserves families and children', () => {
  const { individuals, families } = parseGEDCOM(`0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 10 JUN 1975
2 PLAC Munich
0 TRLR`);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  const fam  = imp.families.get('@F1@');
  assert.strictEqual(fam.husb, '@I1@');
  assert.strictEqual(fam.wife, '@I2@');
  deepEqual(fam.chil, ['@I3@', '@I4@']);
  assert.strictEqual(fam.marriages[0].date, '10 JUN 1975');
  assert.strictEqual(fam.marriages[0].plac, 'Munich');
});

test('YAML round-trip with multiple individuals', () => {
  const ged = `0 @I1@ INDI
1 NAME John /Doe/
1 SEX M
0 @I2@ INDI
1 NAME Jane /Doe/
2 TYPE birth
1 NAME Jane /Smith/
2 TYPE married
1 SEX F
0 TRLR`;
  const { individuals, families } = parseGEDCOM(ged);
  const yaml = exportYAML(individuals, families);
  const imp  = importYAML(yaml);
  assert.strictEqual(imp.individuals.get('@I1@').surn, 'Doe');
  assert.strictEqual(imp.individuals.get('@I2@').maidenName, 'Doe');
  assert.strictEqual(imp.individuals.get('@I2@').surn, 'Smith');
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
1 NAME Maria /Muster/
2 GIVN Maria
2 SURN Muster
1 _MARN Schmidt
1 SEX F
0 TRLR`;
  const { individuals, families } = parseGEDCOM(legacyGED);
  const maria = individuals.get('@I1@');
  // Correctly read
  assert.strictEqual(maria.surn, 'Muster');
  assert.strictEqual(maria.maidenName, 'Schmidt');

  // Written in new format
  const out = serializeGEDCOM(individuals, families);
  assert.ok(!out.includes('_MARN'), 'new output must not use _MARN');
  assert.ok(out.includes('TYPE birth'), 'new output must use TYPE birth');
  assert.ok(out.includes('TYPE married'), 'new output must use TYPE married');
  assert.ok(out.includes('1 NAME Maria /Schmidt/'), 'birth name line');
  assert.ok(out.includes('1 NAME Maria /Muster/'), 'married name line');
});

test('re-parsing the new output gives same maidenName', () => {
  const legacyGED = `0 @I1@ INDI
1 NAME Anna /Braun/
1 _MARN Weber
0 TRLR`;
  const { individuals, families } = parseGEDCOM(legacyGED);
  const out = serializeGEDCOM(individuals, families);
  const { individuals: i2 } = parseGEDCOM(out);
  const anna = i2.get('@I1@');
  assert.strictEqual(anna.surn, 'Braun');
  assert.strictEqual(anna.maidenName, 'Weber');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
