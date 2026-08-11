#!/usr/bin/env node
'use strict';

/**
 * Tests that index.html's inline handlers actually resolve.
 * Run with: node wiring.test.js
 *
 * The markup wires ~70 controls with inline `onclick="someFn()"`, and the
 * functions they name are put on window in bulk at the end of js/main.js. A
 * button whose handler was renamed, or whose module stopped exporting it,
 * looks completely fine until somebody clicks it and the console says
 * "someFn is not defined" — nothing else in the suite would notice, because
 * nothing else goes through the markup.
 *
 * This is the cheap guard for that: load the real module graph the way the
 * browser does, then check every name the markup calls is really there.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setupDom } = require('./test-setup.js');

setupDom();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Language keywords and globals that can legally head a call inside a handler.
const NOT_HANDLERS = new Set(['if', 'for', 'while', 'return', 'typeof', 'new',
  'Number', 'String', 'Boolean', 'parseInt', 'parseFloat', 'alert', 'confirm']);

function handlerNames(html) {
  const names = new Set();
  const attr = /\son(?:click|change|input|error|dragover|dragleave|drop|mousedown|mouseup|keyup|keydown|submit|focus|blur)\s*=\s*"([^"]*)"/g;
  for (const m of html.matchAll(attr)) {
    // Only calls that are not method calls: `foo(` counts, `document.foo(`
    // does not — the latter is resolved off its own object at click time.
    for (const c of m[1].matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!NOT_HANDLERS.has(c[2])) names.add(c[2]);
    }
  }
  return names;
}

(async () => {
  // js/main.js is what puts every module's exports on window, so importing it
  // is what makes the inline handlers resolvable — exactly as in the browser.
  await import('../js/main.js');
  await new Promise(r => setTimeout(r, 100));
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 50));

  const names = handlerNames(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));

  console.log('\ninline handlers in index.html');

  test('the markup wires a meaningful number of them', () => {
    // Guards the regex itself: if it silently stopped matching, the test
    // below would pass by checking nothing at all.
    assert.ok(names.size > 40, `expected dozens of handlers, found ${names.size}`);
  });

  test('every one of them resolves to a function on window', () => {
    const missing = [...names].filter(n => typeof window[n] !== 'function');
    assert.deepStrictEqual(missing, [],
      `these are called by the markup but are not on window: ${missing.join(', ')}`);
  });
})().then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch(e => {
  console.error('the module graph failed to load:', e.message);
  process.exit(1);
});
