#!/usr/bin/env node
'use strict';

/**
 * Tests for media attachments and the archives that carry them.
 * Run with: node media.test.js
 *
 * What has to hold for the feature to be worth having: a zip this app writes
 * is a real zip (another program, or `unzip`, can open it), the .ged inside it
 * names each file by the path it sits at in the archive, and opening such an
 * archive — ours or another program's — puts every file back on the right
 * record, even when the FILE lines are absolute paths from somebody's PC.
 */

const assert = require('assert');
const { setupDom } = require('./test-setup.js');

setupDom();
// jsdom has its own Blob and File, which Node's stream/compression APIs do not
// accept. The code under test only needs the platform ones.
global.Blob = require('buffer').Blob;
global.File = require('buffer').File;
global.window.Blob = global.Blob;
global.window.File = global.File;
global.URL.createObjectURL = () => 'blob:test';
global.URL.revokeObjectURL = () => {};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); failed++; }
}

(async () => {
  const Zip = await import('../js/zip.js');
  const Media = await import('../js/media.js');
  const { state } = await import('../js/state.js');
  await new Promise(r => setTimeout(r, 20));

  const bytes = n => new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
  const reset = () => {
    state.individuals.clear();
    state.families.clear();
    state.media = new Map();
    Media.resetMediaSession();
  };

  console.log('\nzip');

  await test('what makeZip writes, readZip reads back byte for byte', async () => {
    const img = bytes(3000);
    const blob = await Zip.makeZip([
      { name: 'tree.ged', data: '0 HEAD\r\n'.repeat(100) + '0 TRLR' },
      { name: 'media/Zürich 1900.jpg', data: new Blob([img]) },
    ]);
    const entries = await Zip.readZip(blob);
    assert.deepStrictEqual(entries.map(e => e.name), ['tree.ged', 'media/Zürich 1900.jpg']);
    assert.strictEqual(entries[0].method, 8, 'text is deflated');
    assert.strictEqual(entries[1].method, 0, 'binary is stored');
    const back = new Uint8Array(await (await entries[1].blob()).arrayBuffer());
    assert.deepStrictEqual([...back], [...img]);
    assert.ok((await (await entries[0].blob()).text()).startsWith('0 HEAD'));
  });

  await test('the CRC is the standard one', () => {
    assert.strictEqual(Zip.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  });

  await test('something that is not a zip is refused rather than misread', async () => {
    await assert.rejects(() => Zip.readZip(new Blob(['0 HEAD\n0 TRLR'])));
    assert.strictEqual(await Zip.isZip(new Blob(['0 HEAD'])), false);
  });

  console.log('\nattaching and linking');

  await test('attaching a file creates a record under media/ and links it', async () => {
    reset();
    state.individuals.set('@I1@', GEDCOMModule._makeIndi('@I1@'));
    const [id] = await Media.addMediaFiles('@I1@', [new File([bytes(10)], 'Portrait: 1900.jpg', { type: 'image/jpeg' })]);
    const m = state.media.get(id);
    assert.strictEqual(m.file, 'media/Portrait_ 1900.jpg', 'unsafe characters are replaced');
    assert.strictEqual(m.title, 'Portrait: 1900');
    assert.deepStrictEqual(state.individuals.get('@I1@').media, [id]);
    assert.ok(await Media.getMediaFile(m.file), 'the bytes are kept for this session');
  });

  await test('two different files with one name get two paths', async () => {
    reset();
    state.individuals.set('@I1@', GEDCOMModule._makeIndi('@I1@'));
    const [a] = await Media.addMediaFiles('@I1@', [new File([bytes(10)], 'scan.png')]);
    const [b] = await Media.addMediaFiles('@I1@', [new File([bytes(20)], 'scan.png')]);
    assert.notStrictEqual(state.media.get(a).file, state.media.get(b).file);
  });

  await test('the same file added twice is linked once, not stored twice', async () => {
    reset();
    state.individuals.set('@I1@', GEDCOMModule._makeIndi('@I1@'));
    state.individuals.set('@I2@', GEDCOMModule._makeIndi('@I2@'));
    const f = new File([bytes(10)], 'family.jpg');
    const [a] = await Media.addMediaFiles('@I1@', [f]);
    const [b] = await Media.addMediaFiles('@I2@', [f]);
    assert.strictEqual(a, b);
    assert.strictEqual(state.media.size, 1);
  });

  await test('a portrait is the primary image, else the first image', async () => {
    reset();
    const p = GEDCOMModule._makeIndi('@I1@');
    state.individuals.set('@I1@', p);
    const [doc, img1, img2] = await Media.addMediaFiles('@I1@', [
      new File([bytes(1)], 'letter.pdf'), new File([bytes(2)], 'one.jpg'), new File([bytes(3)], 'two.jpg')]);
    assert.strictEqual(Media.portraitOf(p).id, img1, 'the first image, not the document');
    Media.setPrimaryMedia('@I1@', img2);
    assert.strictEqual(Media.portraitOf(p).id, img2);
    assert.strictEqual(p.media[0], img2, 'and it moves to the front');
    assert.ok(p.media.includes(doc));
  });

  await test('unlinking the last reference drops the record, not a shared one', async () => {
    reset();
    state.individuals.set('@I1@', GEDCOMModule._makeIndi('@I1@'));
    state.individuals.set('@I2@', GEDCOMModule._makeIndi('@I2@'));
    const f = new File([bytes(5)], 'shared.jpg');
    const [id] = await Media.addMediaFiles('@I1@', [f]);
    await Media.addMediaFiles('@I2@', [f]);
    Media.unlinkMedia('@I1@', id);
    assert.ok(state.media.has(id), 'still linked from @I2@');
    Media.unlinkMedia('@I2@', id);
    assert.ok(!state.media.has(id));
    assert.strictEqual(state.individuals.get('@I2@').media, undefined);
  });

  await test('a web link is attached by reference', () => {
    reset();
    state.individuals.set('@I1@', GEDCOMModule._makeIndi('@I1@'));
    const id = Media.addMediaUrl('@I1@', 'https://example.org/archive/record/42');
    assert.strictEqual(state.media.get(id).file, 'https://example.org/archive/record/42');
    assert.strictEqual(Media.addMediaUrl('@I1@', 'javascript:alert(1)'), null, 'only http(s)');
  });

  console.log('\nfinding files for FILE paths');

  await test('an absolute Windows path finds the file by its longest matching tail', async () => {
    reset();
    state.media.set('@O1@', { id: '@O1@', file: 'C:\\Users\\me\\Tree\\photos\\anna.jpg', form: 'jpg', title: '' });
    const right = new Blob([bytes(7)]), wrong = new Blob([bytes(3)]);
    const res = await Media.attachCandidates([
      { path: 'other/anna.jpg', get: async () => wrong },
      { path: 'Tree/photos/anna.jpg', get: async () => right },
    ]);
    assert.deepStrictEqual(res, { matched: 1, missing: 0 });
    assert.strictEqual((await Media.getMediaFile('C:\\Users\\me\\Tree\\photos\\anna.jpg')).size, 7);
  });

  await test('a file that is nowhere is counted as missing', async () => {
    reset();
    state.media.set('@O1@', { id: '@O1@', file: 'gone.jpg', form: 'jpg', title: '' });
    const res = await Media.attachCandidates([{ path: 'other.jpg', get: async () => new Blob(['x']) }]);
    assert.deepStrictEqual(res, { matched: 0, missing: 1 });
  });

  console.log('\narchives');

  await test('an exported archive holds the .ged and each file at the path the .ged names', async () => {
    reset();
    const p = GEDCOMModule._makeIndi('@I1@');
    p.name = 'Anna'; p.givn = 'Anna';
    state.individuals.set('@I1@', p);
    const [rel] = await Media.addMediaFiles('@I1@', [new File([bytes(9)], 'anna.jpg')]);
    state.media.set('@O9@', { id: '@O9@', file: 'D:\\scans\\letter.pdf', form: 'pdf', title: 'Letter' });
    await Media.putMediaFile('D:\\scans\\letter.pdf', new Blob([bytes(4)]));
    state.media.set('@O8@', { id: '@O8@', file: 'https://example.org/x', form: 'url', title: '' });
    p.media.push('@O9@', '@O8@');

    const { blob, files, missing } = await Media.buildMediaArchive({
      individuals: state.individuals, families: state.families, otherLines: [], media: state.media, baseName: 'tree',
    });
    assert.strictEqual(files, 2);
    assert.strictEqual(missing, 0);
    const entries = await Zip.readZip(blob);
    const names = entries.map(e => e.name);
    assert.deepStrictEqual(names, ['tree.ged', state.media.get(rel).file, 'media/letter.pdf']);
    const ged = await (await entries[0].blob()).text();
    assert.ok(ged.includes('1 FILE media/letter.pdf'), 'the absolute path is rewritten inside the archive');
    assert.ok(ged.includes('1 FILE https://example.org/x'), 'a web link stays a web link');
    assert.strictEqual(state.media.get('@O9@').file, 'D:\\scans\\letter.pdf', 'the tree in memory keeps its own path');
  });

  await test('opening an archive finds its .ged and offers the rest, relative to it', async () => {
    const blob = await Zip.makeZip([
      { name: 'export/notes.txt', data: 'hi' },
      { name: 'export/family.ged', data: '0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Ölga /X/\n1 OBJE @O1@\n0 @O1@ OBJE\n1 FILE media/o.jpg\n0 TRLR' },
      { name: 'export/media/o.jpg', data: new Blob([bytes(6)]) },
    ]);
    const arc = await Media.readMediaArchive(blob);
    assert.strictEqual(arc.gedName, 'family.ged');
    assert.ok(arc.text.includes('Ölga'));
    assert.deepStrictEqual(arc.candidates.map(c => c.path).sort(), ['media/o.jpg', 'notes.txt']);

    reset();
    const r = GEDCOMModule.parseGEDCOM(arc.text);
    state.media = r.media;
    const res = await Media.attachCandidates(arc.candidates);
    assert.strictEqual(res.matched, 1);
    assert.strictEqual((await Media.getMediaFile('media/o.jpg')).size, 6);
  });

  await test('a GEDZIP (gedcom.ged) is preferred over any other .ged in the archive', async () => {
    const blob = await Zip.makeZip([
      { name: 'old/backup.ged', data: '0 HEAD\n0 @I9@ INDI\n0 TRLR' },
      { name: 'gedcom.ged', data: '0 HEAD\n0 @I1@ INDI\n1 NAME Right /One/\n0 TRLR' },
    ]);
    const arc = await Media.readMediaArchive(blob);
    assert.ok(arc.text.includes('Right'));
  });

  await test('an archive without a .ged says so', async () => {
    const blob = await Zip.makeZip([{ name: 'a.jpg', data: new Blob([bytes(3)]) }]);
    await assert.rejects(() => Media.readMediaArchive(blob));
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
