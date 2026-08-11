#!/usr/bin/env node
'use strict';

/**
 * Tests for the mobile behaviour of the 3D view.
 * Run with: node mobile.test.js
 *
 * These need the real module graph rather than lifted function bodies — what is
 * under test is the branch each function takes on a narrow viewport, and that is
 * decided by _isMobile() reading window.innerWidth. test-setup.js builds a jsdom
 * window from index.html with stubs for the libraries loaded via <script> (d3,
 * THREE, ForceGraph3D), which is enough for the whole graph to evaluate.
 *
 * The graph is imported *once*: the modules import each other by plain relative
 * path, so re-importing one of them with a cache-busting query gives it a second
 * copy of everything underneath — including a second `state` — and assertions
 * then run against an object the code under test never reads. Runtime branches
 * are exercised by moving window.innerWidth between calls instead. The one
 * decision made at module-evaluation time (the label default) is the exception,
 * and gets its own isolated re-import.
 */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { setupDom } = require('./test-setup.js');

setupDom();

const url = f => pathToFileURL(path.join(__dirname, '..', 'js', f)).href;
const setWidth = w => { global.window.innerWidth = w; };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Records what the app asks of the 3D library, so the calls can be asserted on.
function stubGraph3D() {
  const calls = { handlers: {}, pixelRatio: null, zoomToFit: [], nodeResolution: null };
  const api = new Proxy(function () {}, {
    apply: () => api,
    construct: () => api,
    get: (_t, prop) => {
      if (prop === 'renderer') return () => ({
        domElement: global.document.createElement('canvas'),
        setPixelRatio: r => { calls.pixelRatio = r; },
        setSize: () => {},
      });
      if (prop === 'zoomToFit') return (ms, pad) => { calls.zoomToFit.push({ ms, pad }); };
      // Every other property has to be both callable (the .nodeColor(fn) chain)
      // and walkable (camera().up.set(...)), so hand back something that is both.
      return new Proxy(function () {}, {
        apply: (_f, _this, args) => {
          if (typeof prop === 'string' && prop.startsWith('on')) calls.handlers[prop] = args[0];
          if (prop === 'nodeResolution') calls.nodeResolution = args[0];
          return api;
        },
        get: () => api,
        construct: () => api,
      });
    },
  });
  global.ForceGraph3D = () => api;
  return { api, calls };
}

(async () => {
  Object.defineProperty(global.window, 'devicePixelRatio', { value: 3, configurable: true });

  const { state }  = await import(url('state.js'));
  const render3d   = await import(url('render-3d.js'));
  const { _isMobile } = await import(url('panels.js'));

  console.log('\n_isMobile (the switch everything below hangs off)');

  await test('a phone is mobile, a laptop is not', async () => {
    setWidth(390);  assert.strictEqual(_isMobile(), true);
    setWidth(1280); assert.strictEqual(_isMobile(), false);
  });

  await test('the boundary is inclusive at 768', async () => {
    setWidth(768); assert.strictEqual(_isMobile(), true);
    setWidth(769); assert.strictEqual(_isMobile(), false);
  });

  console.log('\n3D labels');

  await test('name labels default off on a phone and on elsewhere', async () => {
    // Decided when state.js is evaluated, so this one really does need a fresh
    // copy of that module per width. It is a leaf as far as this default is
    // concerned, so a second copy of it costs nothing.
    const at = async w => {
      setWidth(w);
      const m = await import(`${url('state.js')}?w=${w}`);
      return m.state.show3DNames;
    };
    assert.strictEqual(await at(390), false,
      'a hundred canvas labels on a 390px screen is a mat of boxes, not a chart');
    assert.strictEqual(await at(1280), true);
  });

  await test('label textures are drawn at a lower multiple on a phone', async () => {
    // makeTextSprite3D sets canvas.width before asking for the context, so a spy
    // on getContext sees the size it chose.
    const widthFor = w => {
      setWidth(w);
      let seen = null;
      global.window.HTMLCanvasElement.prototype.getContext = function () {
        if (seen === null) seen = this.width;
        return new Proxy({}, { get: () => () => {} });
      };
      render3d.makeTextSprite3D(() => {}, 100, 40);
      return seen;
    };
    const phone = widthFor(390), desk = widthFor(1280);
    assert.strictEqual(desk, 400, 'desktop should still draw at 4x');
    assert.strictEqual(phone, 200, 'a phone should draw at 2x');
  });

  console.log('\n3D framing and renderer');

  await test('zoomToFit leaves less dead margin on a narrow screen', async () => {
    const padFor = w => {
      setWidth(w);
      const { calls } = stubGraph3D();
      state.graph3d = new Proxy({}, {
        get: () => (ms, pad) => { calls.zoomToFit.push({ ms, pad }); },
      });
      render3d.fit3D(500);
      return calls.zoomToFit[0];
    };
    const phone = padFor(390), desk = padFor(1280);
    assert.strictEqual(phone.ms, 500, "the duration is the caller's to choose");
    assert.ok(phone.pad < desk.pad,
      `phone padding ${phone.pad} should be tighter than desktop ${desk.pad}`);
    state.graph3d = null;
  });

  await test('the renderer pixel ratio is capped hardest on a phone', async () => {
    const profileAt = async w => {
      setWidth(w);
      const { calls } = stubGraph3D();
      state.nodes = []; state.links = [];
      render3d.initGraph3D();
      await new Promise(r => setTimeout(r, 250));   // the controls block is deferred 150ms
      state.graph3d = null;                          // stop the deferred refit firing later
      return calls;
    };
    // The window reports devicePixelRatio 3, so an uncapped renderer would shade
    // nine fragments for every one you can see.
    const phone = await profileAt(390), desk = await profileAt(1280);
    assert.strictEqual(phone.pixelRatio, 2, 'a phone should be capped to 2');
    assert.strictEqual(desk.pixelRatio, null,
      'desktop must keep whatever the library chose — changing it there is a regression nobody asked for');
    assert.ok(phone.nodeResolution < desk.nodeResolution,
      `sphere resolution should drop on a phone (${phone.nodeResolution} vs ${desk.nodeResolution})`);
  });

  console.log('\n3D touch gestures');

  await test('a tap that ended a drag opens nothing', async () => {
    // One finger orbits the scene, and the gesture finishes with a click event.
    // When it finishes over a node the library reports a tap on that node, so
    // turning the scene used to fling open whatever was under the finger.
    setWidth(390);
    const { calls } = stubGraph3D();
    state.nodes = []; state.links = [];
    state.individuals = new Map([['I1', { displayName: 'A', famc: [], fams: [] }]]);
    render3d.initGraph3D();

    const { onNodeClick, onBackgroundClick } = calls.handlers;
    assert.ok(onNodeClick && onBackgroundClick, 'handlers were not registered');

    state._3dGestureDragged = true;
    // Reaching a detail panel would need far more DOM than this is about; what
    // matters is that the handler returns before doing anything at all, which it
    // proves by not throwing on a node whose data was never set up.
    onNodeClick({ id: 'I1', type: 'INDI' }, { stopPropagation() {} });
    onBackgroundClick();

    // ...and that it is the flag doing it: with the flag down, the same call
    // runs on into the panel code and blows up on the missing DOM.
    state._3dGestureDragged = false;
    let reached = false;
    try { onNodeClick({ id: 'nope', type: 'INDI' }, { stopPropagation() {} }); }
    catch { reached = true; }
    assert.ok(reached, 'with no drag recorded the click must fall through to the panel');
    state.graph3d = null;
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
