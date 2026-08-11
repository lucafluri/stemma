#!/usr/bin/env node
'use strict';

// Test runner for the plain-Node test suites.
// Executes every *.test.js file as a separate process so each suite is isolated
// and exits with the total failure count.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ORDER = [
  'gedcom.test.js',
  'import.test.js',
  'merge.test.js',
  'focus.test.js',
  'mobile.test.js',
  'workfile.test.js',
  'deceased.test.js',
  'hover.test.js',
  'stats.test.js',
  'autocomplete.test.js',
  'physics.test.js',
  'ui.test.js',
  'relations.test.js',
  'places.test.js',
  'map.test.js',
  'changes.test.js',
  'find.test.js',
  'import-ui.test.js',
  'autosave.test.js',
  'wiring.test.js'
];

const present = new Set(fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')));
const files = ORDER.filter(f => present.has(f));

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  } catch (e) {
    failed++;
  }
}

if (failed) {
  console.log(`\n${failed} suite(s) failed.`);
  process.exit(1);
}
console.log('\nAll suites passed.');
