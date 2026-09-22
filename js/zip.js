/**
 * ZIP archives, without a library.
 *
 * Two jobs: write a GEDCOM with its media files beside it, and read one back
 * — ours, or the zip another genealogy program exported (GEDZIP `.gdz` is the
 * same container). Writing stores media as-is (photos and video are already
 * compressed; deflating them again costs time and saves nothing) and deflates
 * the text files. Reading handles stored and deflated entries, data
 * descriptors and Zip64, and hands entries back as Blob slices, so a large
 * archive is never held in memory whole.
 *
 * Compression goes through the browser's own CompressionStream /
 * DecompressionStream ('deflate-raw'), available in every current browser and
 * in Node 18+.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

async function _bytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

async function _pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canDeflate = () => typeof CompressionStream !== 'undefined';

function _dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a zip. `entries` is [{ name, data, compress? }] where data is a Blob,
 * string, ArrayBuffer or Uint8Array. Text is deflated unless `compress` is
 * false; binary is stored unless `compress` is true. Resolves to a Blob.
 */
export async function makeZip(entries, { onProgress } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = _dosTime(new Date());
  const enc = new TextEncoder();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const raw = await _bytes(e.data);
    const crc = crc32(raw);
    let body = raw, method = 0;
    const wantDeflate = e.compress ?? (typeof e.data === 'string');
    if (wantDeflate && canDeflate() && raw.length > 64) {
      const def = await _pipe(raw, new CompressionStream('deflate-raw'));
      if (def.length < raw.length) { body = def; method = 8; }
    }
    if (offset > 0xFFFFFFFE || raw.length > 0xFFFFFFFE) throw new Error('Archive too large (over 4 GB)');

    const name = enc.encode(e.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);         // names are UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);

    offset += 30 + name.length + body.length;
    onProgress?.(i + 1, entries.length);
  }

  if (entries.length > 0xFFFF) throw new Error('Too many files for one archive');
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

async function _slice(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

const _u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;

/**
 * List a zip's files. Resolves to [{ name, size, blob() }] — `blob()` reads
 * (and if need be inflates) that one entry. Rejects if this is not a zip.
 */
export async function readZip(blob) {
  const tailLen = Math.min(blob.size, 22 + 0xFFFF);
  const tail = await _slice(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive');

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  // Zip64: the real numbers are in the zip64 end-of-central-directory record.
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    const locAt = blob.size - tailLen + eocd - 20;
    if (locAt >= 0) {
      const loc = await _slice(blob, locAt, locAt + 20);
      if (loc.getUint32(0, true) === 0x07064b50) {
        const recAt = _u64(loc, 8);
        const rec = await _slice(blob, recAt, recAt + 56);
        if (rec.getUint32(0, true) === 0x06064b50) {
          count = _u64(rec, 32);
          cdSize = _u64(rec, 40);
          cdOffset = _u64(rec, 48);
        }
      }
    }
  }

  const cd = await _slice(blob, cdOffset, cdOffset + cdSize);
  const utf8 = new TextDecoder('utf-8');
  const legacy = new TextDecoder('windows-1252');
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true);
    let usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    const name = (flags & 0x0800 ? utf8 : legacy).decode(nameBytes);

    // Zip64 extra field: whichever of the three were 0xFFFFFFFF, in order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xFFFFFFFF) { usize = _u64(cd, q); q += 8; }
        if (csize === 0xFFFFFFFF) { csize = _u64(cd, q); q += 8; }
        if (local === 0xFFFFFFFF) { local = _u64(cd, q); q += 8; }
      }
      x += 4 + len;
    }
    p = xEnd + commentLen;

    if (name.endsWith('/')) continue;   // a directory
    const entry = {
      name, size: usize, method, encrypted: !!(flags & 1),
      async blob(type = '') {
        if (this.encrypted) throw new Error(`${name} is encrypted`);
        const head = await _slice(blob, local, local + 30);
        const start = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
        const data = blob.slice(start, start + csize);
        if (method === 0) return type ? new Blob([data], { type }) : data;
        if (method === 8) {
          if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack compressed zip entries');
          const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
          const b = await new Response(stream).blob();
          return type ? new Blob([b], { type }) : b;
        }
        throw new Error(`${name}: unsupported compression method ${method}`);
      },
    };
    out.push(entry);
  }
  return out;
}

/** Does this look like a zip (by content, not by name)? */
export async function isZip(blob) {
  if (!blob || blob.size < 4) return false;
  const dv = await _slice(blob, 0, 4);
  return dv.getUint32(0, true) === 0x04034b50;
}
