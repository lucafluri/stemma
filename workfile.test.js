#!/usr/bin/env node
'use strict';

/**
 * Tests for the working file — reopening the last file and saving back over it.
 * Run with: node workfile.test.js
 *
 * Everything here writes to somebody's disk, so the interesting cases are the
 * ones where it must NOT: a stale handle left over from a previous file, and a
 * .json file being handed GEDCOM text. The File System Access API is stubbed,
 * since neither jsdom nor Node has one.
 */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { setupDom } = require('./test-setup.js');

setupDom();

// jsdom has no File System Access API, so the feature check would send every
// case down the "unsupported" path. Give it one; individual tests remove it
// again to exercise that path deliberately.
global.window.showOpenFilePicker = async () => [];
global.window.showSaveFilePicker = async () => null;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// A stand-in for a file on disk, recording what actually got written to it.
function fakeHandle(name, { permission = 'granted' } = {}) {
  const h = {
    name,
    written: [],
    queryPermission: async () => permission,
    requestPermission: async () => permission,
    getFile: async () => new global.window.File([h.contents ?? ''], name),
    createWritable: async () => ({
      write: async txt => { h.written.push(txt); },
      close: async () => {},
    }),
  };
  return h;
}

// jsdom has no IndexedDB, and the handle store is the one part of this that a
// reload depends on. Rather than stub around it, stand up just enough of the API
// for the real _idb() to run against — including firing oncomplete a tick later,
// since the code assigns that handler after the request is made.
function installFakeIndexedDB() {
  const data = new Map();
  const later = fn => setTimeout(fn, 0);
  global.window.indexedDB = global.indexedDB = {
    open() {
      const openReq = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      later(() => {
        const db = {
          createObjectStore: () => {},
          close: () => {},
          transaction() {
            const tx = { oncomplete: null, onerror: null, error: null };
            later(() => tx.oncomplete && tx.oncomplete());
            return {
              objectStore: () => ({
                put(v, k) { data.set(k, v); return { result: undefined, transaction: tx }; },
                get(k)    { return { result: data.get(k), transaction: tx }; },
              }),
            };
          },
        };
        openReq.result = db;
        openReq.onupgradeneeded?.();
        openReq.onsuccess?.();
      });
      return openReq;
    },
  };
  return { peek: () => data.get('recent'), clear: () => data.clear() };
}

(async () => {
  const url = f => pathToFileURL(path.join(__dirname, 'js', f)).href;
  const io = await import(url('gedcom-io.js'));
  const { state } = await import(url('state.js'));

  // Built by the real parser rather than by hand: the serializers read fields a
  // hand-written object quietly lacks, and a fixture that only looks like a
  // person would be testing the fixture.
  const loadFixture = () => {
    const parsed = global.GEDCOMModule.parseGEDCOM(
      ['0 @I1@ INDI', '1 NAME Ada /Byron/', '2 GIVN Ada', '2 SURN Byron',
       '1 BIRT', '2 DATE 10 DEC 1815', '0 TRLR'].join('\n'));
    state.individuals = parsed.individuals;
    state.families = parsed.families;
    state.otherLines = parsed.otherLines || [];
  };

  console.log('\nformat of the written text');

  await test('a file is written back in the format it already is', async () => {
    // Writing GEDCOM lines into a file called .json is how you corrupt somebody's
    // data while telling them it was saved.
    loadFixture();

    const seen = {};
    for (const name of ['tree.ged', 'tree.json', 'tree.yaml']) {
      const h = fakeHandle(name);
      state._fileHandle = h;
      await io.saveToFile();
      assert.strictEqual(h.written.length, 1, `${name}: expected exactly one write`);
      seen[name] = h.written[0];
    }
    assert.ok(seen['tree.ged'].includes('0 @I1@ INDI'), '.ged should get GEDCOM lines');
    assert.ok(seen['tree.ged'].startsWith('﻿'), '.ged should keep the BOM the download path writes');
    assert.deepStrictEqual(JSON.parse(seen['tree.json']).individuals[0].givn, 'Ada',
      '.json should get parseable JSON');
    assert.ok(seen['tree.yaml'].includes('format: gedcom-vis-yaml'), '.yaml should get YAML');
    assert.ok(!seen['tree.json'].includes('0 @I1@ INDI'), '.json must not receive GEDCOM lines');
  });

  console.log('\nwhich file gets overwritten');

  await test('nothing is written when permission is refused', async () => {
    const h = fakeHandle('tree.ged', { permission: 'denied' });
    state._fileHandle = h;
    await io.saveToFile();
    assert.strictEqual(h.written.length, 0, 'a refused prompt must not write anything');
  });

  await test('an imported file does not overwrite the last file opened', async () => {
    // The trap: open work.ged, then import something unrelated. The dataset on
    // screen now has nothing to do with work.ged, and saving must not land on it.
    const previous = fakeHandle('work.ged');
    state._fileHandle = previous;

    // _loadDatasetFile is what every import path funnels through; called without
    // a handle it must forget the old one.
    io._loadDatasetFile(new global.window.File(['0 HEAD\n0 TRLR'], 'other.ged'));
    assert.strictEqual(state._fileHandle, null,
      'loading a file that came without a handle must clear the remembered one');

    await io.saveToFile();
    assert.strictEqual(previous.written.length, 0,
      'work.ged must not be touched by data that did not come from it');
  });

  await test('reopening a file keeps its handle, so saving lands back on it', async () => {
    const h = fakeHandle('work.ged');
    h.contents = '0 HEAD\n0 TRLR';
    io._loadDatasetFile(await h.getFile(), h);
    assert.strictEqual(state._fileHandle, h, 'a file opened by handle must keep it');
  });

  console.log('\nunsupported browsers');

  await test('the buttons are hidden where the API does not exist', async () => {
    // Firefox and mobile browsers cannot write back to a chosen file. Offering
    // the buttons anyway would promise something they cannot do.
    delete global.window.showOpenFilePicker;
    assert.strictEqual(io.fileAccessSupported(), false);

    const openBtn = global.document.getElementById('open-recent-btn');
    const saveBtn = global.document.getElementById('save-file-btn');
    assert.ok(openBtn && saveBtn, 'both buttons must exist in the markup');
    openBtn.style.display = saveBtn.style.display = 'inline-block';
    await io.updateFileButtons();
    assert.strictEqual(openBtn.style.display, 'none');
    assert.strictEqual(saveBtn.style.display, 'none');
  });

  await test('saving falls back to a download where the API is missing', async () => {
    let downloaded = 0;
    const realCreate = global.document.createElement.bind(global.document);
    global.document.createElement = tag => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => { downloaded++; };
      return el;
    };
    global.window.URL.createObjectURL = () => 'blob:x';
    global.window.URL.revokeObjectURL = () => {};
    global.URL.createObjectURL = () => 'blob:x';
    global.URL.revokeObjectURL = () => {};

    state._fileHandle = null;
    await io.saveToFile();
    global.document.createElement = realCreate;
    assert.strictEqual(downloaded, 1, 'it should still be possible to get the data out');
  });

  console.log('\nremembering the last file opened');

  const idb = installFakeIndexedDB();
  const settle = () => new Promise(r => setTimeout(r, 20));

  // These cases put a real file through _loadDatasetFile, which runs the whole
  // load pipeline. Keep it in 2D — the 3D branch reaches for a canvas context
  // jsdom does not provide — and quiet the render timers it logs on the way.
  state.currentView = '2d';
  global.window.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy({}, { get: () => () => {} });
  console.time = console.timeEnd = () => {};

  await test('opening a file records it as the recent one', async () => {
    idb.clear();
    const h = fakeHandle('first.ged');
    io._loadDatasetFile(new global.window.File(['0 HEAD\n0 TRLR'], 'first.ged'), h);
    await settle();
    assert.strictEqual(idb.peek(), h, 'the file just opened should be the one remembered');
  });

  await test('opening another file replaces it', async () => {
    // The bug: only the reopen button used to record anything, so opening a file
    // any other way left the button offering something opened long ago.
    idb.clear();
    const first = fakeHandle('first.ged'), second = fakeHandle('second.ged');
    io._loadDatasetFile(new global.window.File(['0 TRLR'], 'first.ged'), first);
    await settle();
    io._loadDatasetFile(new global.window.File(['0 TRLR'], 'second.ged'), second);
    await settle();
    assert.strictEqual(idb.peek(), second, 'the newer file must win');
    assert.strictEqual(idb.peek().name, 'second.ged');
  });

  await test('a file opened without a handle leaves the shortcut alone', async () => {
    // An autosave restore, or a browser that cannot give handles. There is
    // nothing better to remember, and dropping the shortcut would strand someone
    // resuming work on the very file it points at — but it must not be presented
    // as the open document either, which is _fileHandle's job and stays null.
    idb.clear();
    const h = fakeHandle('work.ged');
    io._loadDatasetFile(new global.window.File(['0 TRLR'], 'work.ged'), h);
    await settle();
    io._loadDatasetFile(new global.window.File(['0 TRLR'], 'restored.ged'));
    await settle();
    assert.strictEqual(idb.peek(), h, 'the reopen shortcut should survive');
    assert.strictEqual(state._fileHandle, null, 'but nothing is open for saving');
  });

  await test('what was stored can be read back', async () => {
    // Exercises the real _idb() round trip, which is what a reload depends on.
    idb.clear();
    const h = fakeHandle('roundtrip.ged');
    await io._saveRecentHandle(h);
    assert.strictEqual((await io._readRecentHandle()).name, 'roundtrip.ged');
  });

  console.log('\nfilename on the buttons');

  await test('the save button names the file and appears only with one', async () => {
    global.window.showOpenFilePicker = async () => [];   // support detected again
    const openBtn = global.document.getElementById('open-recent-btn');
    const saveBtn = global.document.getElementById('save-file-btn');

    state._fileHandle = null;
    await io.updateFileButtons();
    assert.strictEqual(saveBtn.style.display, 'none',
      'with nothing open there is no file to save into');

    state._fileHandle = fakeHandle('Fluri-Stammbaum.ged');
    await io.updateFileButtons();
    assert.strictEqual(saveBtn.style.display, 'inline-block');
    assert.ok(saveBtn.innerHTML.includes('Fluri-Stammbaum.ged'),
      `the save button must name its target, got ${saveBtn.innerHTML}`);
    assert.ok(openBtn.innerHTML.includes('Fluri-Stammbaum.ged'),
      'the open button should offer the same file back');
  });

  await test('a filename with markup in it cannot inject into the button', async () => {
    const saveBtn = global.document.getElementById('save-file-btn');
    state._fileHandle = fakeHandle('<img src=x onerror=alert(1)>.ged');
    await io.updateFileButtons();
    assert.ok(!saveBtn.querySelector('img'), 'a filename must not become markup');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
