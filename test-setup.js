'use strict';
// Shared browser-environment shim for the Node test suite.
//
// js/*.js are real ES modules (loaded with `import`/`export`), unlike the old
// monolithic app.js which the tests used to regex-lift function bodies out
// of. Importing any one of them pulls in the whole tightly-coupled module
// graph (they import each other in a cycle), so this sets up just enough of
// a browser-like global environment -- a real DOM (from index.html, so every
// element id the app looks up actually exists), localStorage, and stubs for
// the third-party libraries loaded via <script> in the browser (d3, THREE,
// ForceGraph3D) -- for that whole graph to load without throwing. None of
// the top-level module code actually *renders* anything -- it only wires up
// event listeners -- so these stubs never need to do more than exist.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function setupDom() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // 'outside-only' lets us run classic <script>-style code directly against
  // the jsdom window's realm (via window.eval), matching how i18n.js expects
  // to be loaded -- it assigns `const I18N` / `function t` into script scope,
  // not module.exports.
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  global.localStorage = window.localStorage;
  global.sessionStorage = window.sessionStorage;
  global.CanvasRenderingContext2D = window.CanvasRenderingContext2D || class {};
  global.HTMLCanvasElement = window.HTMLCanvasElement;
  global.FileReader = window.FileReader;
  global.File = window.File;
  global.Blob = window.Blob;
  global.alert = () => {};
  global.confirm = () => true;
  // The app schedules work with these as bare globals, the way browser code
  // does, and anything that defers a frame throws without them. jsdom only
  // supplies them under `pretendToBeVisual`, which also starts a refresh loop
  // that would keep the test process alive — a timer is all that is wanted here.
  const raf = fn => setTimeout(() => fn(Date.now()), 16);
  global.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || raf;
  global.cancelAnimationFrame  = window.cancelAnimationFrame?.bind(window) || clearTimeout;

  // Third-party libraries loaded via <script src> in the browser -- app code
  // only calls into them from inside function bodies (never at module top
  // level), so a no-op stub is enough for import-time module evaluation.
  // A regular function, not an arrow: the app calls `new THREE.OrbitControls(...)`
  // and `new THREE.CanvasTexture(...)`, and an arrow function is not constructible,
  // so a chain built on one throws the moment any of that runs.
  const chain = () => new Proxy(function () {}, {
    get: () => chain(),
    apply: () => chain(),
    construct: () => chain(),
  });
  global.d3 = new Proxy({}, { get: () => chain() });
  global.THREE = new Proxy({}, { get: () => chain() });
  global.ForceGraph3D = () => chain();

  // i18n.js is loaded as a classic <script> in the browser and never exports
  // via module.exports -- run it in the jsdom window's own realm so its
  // top-level `const`/`function` declarations land in window/script scope,
  // exactly like a real <script src="i18n.js">.
  window.eval(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8'));
  global.t = window.t;

  // gedcom.js is a UMD module and works fine via plain require().
  global.GEDCOMModule = require('./gedcom.js');

  return dom;
}

module.exports = { setupDom };
