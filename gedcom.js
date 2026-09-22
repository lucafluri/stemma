/* gedcom.js – GEDCOM 5.5.1 parser/serializer + JSON/YAML export/import
 *
 * Works as a browser global (window.GEDCOMModule) and as a Node.js module.
 *
 * Maiden names are stored as a second NAME record with TYPE birth/married:
 *   1 NAME Jane /Doe/
 *   2 GIVN Jane
 *   2 SURN Doe
 *   2 TYPE birth
 *   1 NAME Jane /Smith/
 *   2 GIVN Jane
 *   2 SURN Smith
 *   2 TYPE married
 *
 * Legacy _MARN tags are read for backward compatibility but never written.
 *
 * ── Nothing the model does not understand is dropped ─────────────────────────
 * The editable model is small (names, sex, birth, death, occupation, note,
 * family links, marriages, media). A real file carries far more: sources and
 * notes on every event, PEDI adoption flags on FAMC, _FREL/_MREL on CHIL,
 * nicknames and suffixes on NAME, alternate names, TIME under DATE, FORM under
 * PLAC. Every one of those is kept as raw lines on the record in `_sub`, keyed
 * by the structure it hangs off, and written back underneath that same
 * structure on save. Whole level-1 structures the model has no field for (CHR,
 * BURI, RESI, pointer NOTEs, …) are kept in `_unknown`, and whole level-0
 * records (SOUR, REPO, NOTE, SUBM, …) in `otherLines`.
 *
 * ── Media ────────────────────────────────────────────────────────────────────
 * OBJE records are parsed into a `media` map: { id, file, form, type, title }.
 * People and families list the ids they link in `media`, first = portrait.
 * Inline OBJE structures (5.5 style, FILE directly under the person) are read
 * into records of their own — same meaning, one representation. The files
 * themselves are not in the GEDCOM; FILE is a path, relative paths are what
 * other programs resolve next to the .ged, and a zip of both is what carries
 * them between programs (see js/media.js).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.GEDCOMModule = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── Data model ─────────────────────────────────────────────────────────────

  function _makeIndi(id) {
    return {
      id,
      name: '', givn: '', surn: '', maidenName: '',
      sex: 'U',
      birth: { date: '', plac: '' },
      death: { date: '', plac: '', caus: '' },
      deceased: false,
      birthYear: null,
      famc: [], fams: [],
      occu: '', note: '',
      displayName: ''
    };
  }

  function _makeFam(id) {
    return {
      id,
      husb: null, wife: null, chil: [],
      marriages: [], div: false, divDate: ''
    };
  }

  /** The short form of a name the chart draws. One definition, used by the
   *  parser and by every editor that renames somebody. */
  function displayNameOf(givn, surn, name) {
    let d = (givn && surn) ? givn + ' ' + surn : (name || '');
    if (d.length > 24) {
      d = givn
        ? givn + (surn ? ' ' + surn[0] + '.' : '')
        : d.slice(0, 22) + '…';
    }
    return d;
  }

  /** First four-digit year in a GEDCOM date, or null. */
  function yearOf(date) {
    const m = String(date == null ? '' : date).match(/\b(\d{4})\b/);
    return m ? +m[1] : null;
  }

  /** The recorded birth year: the birth date's, or failing that the baptism's
   *  (kept at parse time as `_chrYear`) — parish registers often record only
   *  the baptism, a few days after the birth. */
  function birthYearOf(indi) {
    return yearOf(indi?.birth?.date) ?? (Number.isFinite(indi?._chrYear) ? indi._chrYear : null);
  }

  // ─── Place coordinates ──────────────────────────────────────────────────────
  //
  // A place field may carry `map: [lat, lon]` in decimal degrees, south and west
  // negative. GEDCOM writes it as a MAP subtree under the event's PLAC:
  //
  //   2 PLAC Bern
  //   3 MAP
  //   4 LATI N46.947975
  //   4 LONG E7.447447
  //
  // 5.5.1 has no place record to hang coordinates off, so they repeat per event
  // — which is what Gramps, RootsMagic and Ancestry all write, and therefore
  // what other software reads.

  /** "N46.947975", "-7.44" → a number; anything unparseable → null. */
  function _geoNum(v) {
    const m = String(v == null ? '' : v).trim().match(/^([NSEW])?\s*(-?\d+(?:\.\d+)?)$/i);
    if (!m) return null;
    const n = +m[2];
    return /^[SW]$/i.test(m[1] || '') ? -Math.abs(n) : n;
  }

  /** The MAP subtree for a place field, or nothing when it has no usable pair. */
  function _mapLines(level, ll) {
    if (!Array.isArray(ll) || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return [];
    const f = (v, pos, neg) => (v < 0 ? neg : pos) + Math.abs(v).toFixed(6);
    return [`${level} MAP`, `${level + 1} LATI ${f(ll[0], 'N', 'S')}`, `${level + 1} LONG ${f(ll[1], 'E', 'W')}`];
  }

  // ─── Media helpers ──────────────────────────────────────────────────────────

  const _MEDIA_KIND = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image',
    tif: 'image', tiff: 'image', svg: 'image', heic: 'image', avif: 'image',
    mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', ogv: 'video', avi: 'video', mkv: 'video', mpg: 'video', mpeg: 'video',
    mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', aac: 'audio', wma: 'audio',
    pdf: 'document', txt: 'document', doc: 'document', docx: 'document', odt: 'document', rtf: 'document', htm: 'document', html: 'document',
  };

  /** "photos/Hans.JPG" → "jpg". */
  function mediaFormOf(path) {
    const m = String(path || '').split(/[?#]/)[0].match(/\.([A-Za-z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : '';
  }

  /** image | video | audio | document | other, from FORM or the file name. */
  function mediaKindOf(m) {
    const form = String(m?.form || '').toLowerCase().replace(/^.*\//, '') || mediaFormOf(m?.file);
    return _MEDIA_KIND[form] || 'other';
  }

  /** The GEDCOM 5.5.1 MEDI (source media type) a kind corresponds to. */
  function _mediTypeOf(kind) {
    return { image: 'photo', video: 'video', audio: 'audio', document: 'book' }[kind] || '';
  }

  // ─── Encodings ──────────────────────────────────────────────────────────────
  //
  // GEDCOM predates UTF-8's victory. 5.5.1 allows ANSEL (the library-catalogue
  // character set, with diacritics written *before* their letter), UNICODE
  // (UTF-16) and ASCII; in practice Windows programs also wrote "ANSI"
  // (windows-1252) and old Macs "MACINTOSH". Reading all of those as UTF-8
  // turned every umlaut in an old file into U+FFFD.

  const _ANSEL_SPACING = {
    0xA1: 'Ł', 0xA2: 'Ø', 0xA3: 'Đ', 0xA4: 'Þ', 0xA5: 'Æ', 0xA6: 'Œ', 0xA7: 'ʹ', 0xA8: '·',
    0xA9: '♭', 0xAA: '®', 0xAB: '±', 0xAC: 'Ơ', 0xAD: 'Ư', 0xAE: 'ʼ', 0xB0: 'ʻ', 0xB1: 'ł',
    0xB2: 'ø', 0xB3: 'đ', 0xB4: 'þ', 0xB5: 'æ', 0xB6: 'œ', 0xB7: 'ʺ', 0xB8: 'ı', 0xB9: '£',
    0xBA: 'ð', 0xBC: 'ơ', 0xBD: 'ư', 0xBE: '□', 0xBF: '■', 0xC0: '°', 0xC1: 'ℓ', 0xC2: '℗',
    0xC3: '©', 0xC4: '♯', 0xC5: '¿', 0xC6: '¡', 0xC7: 'ß', 0xC8: '€', 0xCF: 'ß',
  };
  const _ANSEL_COMBINING = {
    0xE0: '\u0309', 0xE1: '\u0300', 0xE2: '\u0301', 0xE3: '\u0302', 0xE4: '\u0303', 0xE5: '\u0304',
    0xE6: '\u0306', 0xE7: '\u0307', 0xE8: '\u0308', 0xE9: '\u030C', 0xEA: '\u030A', 0xEB: '\uFE20',
    0xEC: '\uFE21', 0xED: '\u0315', 0xEE: '\u030B', 0xEF: '\u0310', 0xF0: '\u0327', 0xF1: '\u0328',
    0xF2: '\u0323', 0xF3: '\u0324', 0xF4: '\u0325', 0xF5: '\u0333', 0xF6: '\u0332', 0xF7: '\u0326',
    0xF8: '\u031C', 0xF9: '\u032E', 0xFA: '\uFE22', 0xFB: '\uFE23', 0xFE: '\u0313',
  };

  /** ANSEL bytes → a string, combining marks moved after their base letter. */
  function decodeAnsel(bytes) {
    let out = '';
    let marks = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) {
        out += String.fromCharCode(b) + marks;
        marks = '';
      } else if (_ANSEL_COMBINING[b]) {
        marks += _ANSEL_COMBINING[b];
      } else {
        out += (_ANSEL_SPACING[b] || '\uFFFD') + marks;
        marks = '';
      }
    }
    return (out + marks).normalize('NFC');
  }

  function _tryDecode(label, bytes, fatal) {
    try { return new TextDecoder(label, { fatal }).decode(bytes); } catch (e) { return null; }
  }

  /**
   * Bytes of a .ged file → text, honouring the BOM, then the header's CHAR, then
   * falling back from UTF-8 to windows-1252 when the bytes are not valid UTF-8
   * (the commonest mislabelling there is).
   */
  function decodeGedcom(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return _tryDecode('utf-8', bytes.subarray(3), false);
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return _tryDecode('utf-16le', bytes.subarray(2), false);
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return _tryDecode('utf-16be', bytes.subarray(2), false);
    // UTF-16 without a BOM: the first line is "0 HEAD", so every other byte is 0.
    if (bytes[0] === 0x30 && bytes[1] === 0x00) return _tryDecode('utf-16le', bytes, false);
    if (bytes[0] === 0x00 && bytes[1] === 0x30) return _tryDecode('utf-16be', bytes, false);

    let head = '';
    for (let i = 0; i < Math.min(bytes.length, 4096); i++) head += String.fromCharCode(bytes[i]);
    const charset = ((head.match(/\n\s*1\s+CHAR\s+([^\r\n]+)/) || [])[1] || '').trim().toUpperCase();

    if (charset === 'ANSEL') return decodeAnsel(bytes);
    if (charset === 'MACINTOSH') return _tryDecode('macintosh', bytes, false) ?? _tryDecode('windows-1252', bytes, false);
    if (/^(ANSI|WINDOWS|CP1252|ISO|LATIN|IBM|ASCII)/.test(charset) && !/UTF/.test(charset)) {
      // ASCII files are also valid UTF-8; anything above 0x7F in one labelled
      // ASCII was written by a Windows program regardless of the label.
      return _tryDecode('utf-8', bytes, true) ?? _tryDecode('windows-1252', bytes, false);
    }
    return _tryDecode('utf-8', bytes, true) ?? _tryDecode('windows-1252', bytes, false);
  }

  // ─── GEDCOM parser ───────────────────────────────────────────────────────────

  // Only the safe charset GEDCOM actually uses for pointers: ids get
  // interpolated into onclick handlers in the UI.
  const XREF_RE = /^@[A-Za-z0-9_.+-]+@$/;

  // One line: level, tag, then the value after exactly one delimiter space —
  // anything beyond that space is verbatim value content (it matters for
  // CONT/CONC, where leading spaces are meaningful).
  const LINE_RE = /^\s*(\d+)\s+(\S+)(?:[ \t](.*))?$/;

  /** A node's whole subtree as the raw lines it was read from. */
  function _flat(node, out = []) {
    out.push(node.raw);
    if (node.kids) for (const k of node.kids) _flat(k, out);
    return out;
  }

  function _flatKids(node, skip) {
    const out = [];
    if (node.kids) for (const k of node.kids) if (!skip || !skip.has(k.tag)) _flat(k, out);
    return out;
  }

  /** Shift every line of a subtree by `delta` levels. */
  function _relevel(lines, delta) {
    return lines.map(l => l.replace(/^(\s*)(\d+)/, (_, sp, n) => String(+n + delta)));
  }

  function _keep(bag, key, lines) {
    if (lines && lines.length) bag[key] = lines;
  }

  /**
   * Make the two directions of every family link agree.
   *
   * GEDCOM states each membership twice: the FAM record points at its members
   * (HUSB/WIFE/CHIL) and each member points back at the family (FAMS/FAMC).
   * Plenty of files in the wild state only one of the two — a hand-edited file,
   * a converter that dropped the back-pointers, or this app's own text importer,
   * which builds families and never wrote FAMC/FAMS onto the people.
   *
   * The chart is built from the FAM side (buildGraphData reads husb/wife/chil)
   * while every walk over the tree — focus, ancestors, descendants, the relation
   * finder, marriage ages — reads the INDI side. A one-sided file drew all its
   * connections and then behaved as though nobody was related to anybody.
   *
   * Repairing it here, at the end of every importer, is the one place all three
   * of them pass through. Idempotent.
   */
  function _linkFamilyPointers(individuals, families) {
    const add = (arr, v) => { if (!arr.includes(v)) arr.push(v); };

    for (const [fid, fam] of families) {
      for (const pid of [fam.husb, fam.wife]) {
        const indi = pid && individuals.get(pid);
        if (indi) add(indi.fams = indi.fams || [], fid);
      }
      for (const cid of fam.chil || []) {
        const indi = individuals.get(cid);
        if (indi) add(indi.famc = indi.famc || [], fid);
      }
    }

    // ...and the other way, for a file that names the family on the person but
    // left the FAM record's own member list short.
    for (const [pid, indi] of individuals) {
      for (const fid of indi.fams || []) {
        const fam = families.get(fid);
        if (!fam) continue;
        // Only fill an empty slot. Which of husband/wife an unsexed person
        // belongs in is not ours to decide, and overwriting a stated one would
        // be inventing a fact.
        if (fam.husb === pid || fam.wife === pid) continue;
        if (!fam.husb && indi.sex === 'M')      fam.husb = pid;
        else if (!fam.wife && indi.sex === 'F') fam.wife = pid;
        else if (!fam.husb)                     fam.husb = pid;
        else if (!fam.wife)                     fam.wife = pid;
      }
      for (const fid of indi.famc || []) {
        const fam = families.get(fid);
        if (fam) add(fam.chil = fam.chil || [], pid);
      }
    }
  }

  /** Text with CONT/CONC continuations; other children go into `extra`. */
  function _readText(node, extra) {
    let text = node.rv;
    if (node.kids) for (const k of node.kids) {
      if (k.tag === 'CONT') text += '\n' + k.rv;
      else if (k.tag === 'CONC') text += k.rv;
      else _flat(k, extra);
    }
    return text;
  }

  /** An event (BIRT, DEAT, MARR) into a date/plac field object. */
  function _readEvent(node, ev, opts = {}) {
    const sub = {};
    const extra = [];
    if (node.val === 'Y') ev._y = true;
    if (node.kids) for (const k of node.kids) {
      if (k.tag === 'DATE' && !ev.date) {
        ev.date = k.val;
        _keep(sub, 'DATE', _flatKids(k));
      } else if (k.tag === 'PLAC' && !ev.plac) {
        ev.plac = k.val;
        const placExtra = [];
        if (k.kids) for (const kk of k.kids) {
          if (kk.tag === 'MAP') {
            if (kk.kids) for (const g of kk.kids) {
              const n = _geoNum(g.val);
              if (n == null) continue;
              if (!Array.isArray(ev.map)) ev.map = [null, null];
              if (g.tag === 'LATI') ev.map[0] = n;
              else if (g.tag === 'LONG') ev.map[1] = n;
            }
          } else _flat(kk, placExtra);
        }
        _keep(sub, 'PLAC', placExtra);
      } else if (opts.death && k.tag === 'CAUS' && !ev.caus) {
        ev.caus = k.val;
        _keep(sub, 'CAUS', _flatKids(k));
      } else if (opts.marriage && k.tag === 'TYPE' && !ev.types.length) {
        ev.types = k.val.split(',').map(s => s.trim()).filter(Boolean);
        _keep(sub, 'TYPE', _flatKids(k));
      } else {
        _flat(k, extra);
      }
    }
    // A MAP with only one of the two numbers is not a place on a map.
    if (Array.isArray(ev.map) && !(Number.isFinite(ev.map[0]) && Number.isFinite(ev.map[1]))) delete ev.map;
    _keep(sub, '', extra);
    if (Object.keys(sub).length) ev._sub = sub;
    return ev;
  }

  /** An OBJE structure — a level-0 record or an inline level-1 one. */
  function _readMedia(node, id) {
    const m = { id, file: '', form: '', type: '', title: '' };
    const extra = [], fileExtra = [];
    let prim = false;
    if (node.kids) for (const k of node.kids) {
      if (k.tag === 'FILE' && !m.file) {
        m.file = k.val;
        if (k.kids) for (const kk of k.kids) {
          if (kk.tag === 'FORM' && !m.form) {
            m.form = kk.val;
            if (kk.kids) for (const t of kk.kids) {
              if ((t.tag === 'TYPE' || t.tag === 'MEDI') && !m.type) m.type = t.val;
              else _flat(t, fileExtra);
            }
          } else if (kk.tag === 'TITL' && !m.title) m.title = kk.val;
          else if (kk.tag === 'CONC') m.file += kk.rv;
          else _flat(kk, fileExtra);
        }
      } else if (k.tag === 'FORM' && !m.form) {           // 5.5: FORM beside FILE
        m.form = k.val;
        if (k.kids) for (const t of k.kids) {
          if ((t.tag === 'TYPE' || t.tag === 'MEDI') && !m.type) m.type = t.val;
          else _flat(t, extra);
        }
      } else if (k.tag === 'TITL' && !m.title) {          // 5.5: TITL beside FILE
        m.title = k.val;
      } else if (k.tag === '_PRIM') {
        prim = /^y/i.test(k.val);
      } else {
        _flat(k, extra);
      }
    }
    if (extra.length) m._extra = extra;
    if (fileExtra.length) m._fileExtra = fileExtra;
    return { media: m, prim };
  }

  function _readName(node) {
    const nr = { raw: node.val, givn: '', surn: '', type: '', extra: [], node };
    if (node.kids) for (const k of node.kids) {
      if (k.tag === 'GIVN' && !nr.givn) nr.givn = k.val;
      else if (k.tag === 'SURN' && !nr.surn) nr.surn = k.val;
      else if (k.tag === 'TYPE' && !nr.type) nr.type = k.val.toLowerCase();
      else _flat(k, nr.extra);
    }
    return nr;
  }

  const _surnOf = raw => { const m = raw.match(/\/([^/]*)\//); return m ? m[1].trim() : ''; };
  const _givnOf = raw => { const m = raw.match(/^([^/]*)\//); return m ? m[1].trim() : ''; };

  function _finishNames(indi, names, marnLegacy, sub) {
    let primary = null, birthNameRec = null;
    const isBirthType = ty => ty === 'birth' || ty === 'maiden';

    if (names.length === 1) {
      primary = names[0];
    } else if (names.length >= 2) {
      const marriedRec = names.find(n => n.type === 'married');
      const birthRec   = names.find(n => isBirthType(n.type));
      if (marriedRec) {
        primary      = marriedRec;
        birthNameRec = birthRec || names.find(n => n !== marriedRec && !n.type) || null;
      } else if (birthRec) {
        const other = names.find(n => n !== birthRec && !n.type);
        primary      = other || birthRec;
        birthNameRec = birthRec !== primary ? birthRec : null;
      } else {
        // No TYPE tags: legacy — first NAME = primary, second = maiden. A
        // second name with some other TYPE (aka, immigrant, nickname) is an
        // alternate name, not a maiden name.
        primary      = names[0];
        birthNameRec = names[1] && !names[1].type ? names[1] : null;
      }
    }

    if (primary) {
      const raw   = primary.raw || '';
      const clean = raw.replace(/\//g, '').replace(/\s+/g, ' ').trim();
      if (clean) indi.name = clean;
      indi.surn = primary.surn || _surnOf(raw);
      indi.givn = primary.givn || _givnOf(raw);
      // The NAME line exactly as written ("John /Smith/ Jr."), for as long as
      // the parts it was split into are not edited.
      indi._nameSrc = [raw, indi.givn, indi.surn];
      _keep(sub, 'NAME', primary.extra);
    }

    if (birthNameRec) {
      const raw = birthNameRec.raw || '';
      indi.maidenName = birthNameRec.surn || _surnOf(raw) || raw.replace(/\//g, '').trim();
      indi._birthNameSrc = [raw, indi.givn, indi.maidenName];
      _keep(sub, 'NAME.birth', birthNameRec.extra);
    }

    if (!indi.maidenName && marnLegacy) indi.maidenName = marnLegacy;

    // Every other NAME record (alternate spellings, AKA, religious names) is
    // kept whole and written back after the ones the model edits.
    const rest = [];
    for (const n of names) if (n !== primary && n !== birthNameRec) _flat(n.node, rest);
    _keep(sub, 'NAMES', rest);

    if (!indi.name) indi.name = indi.id.replace(/@/g, '');

    // Derive givn/surn from combined name if still missing
    if (!indi.surn && indi.name) {
      const parts = indi.name.trim().split(/\s+/);
      if (parts.length >= 2) {
        indi.surn = parts[parts.length - 1];
        indi.givn = parts.slice(0, -1).join(' ');
      }
    }

    indi.displayName = displayNameOf(indi.givn, indi.surn, indi.name);
  }

  /**
   * Parse a GEDCOM string.
   * @param {string} raw  Raw GEDCOM text (with or without BOM).
   * @returns {{ individuals: Map, families: Map, media: Map, otherLines: string[] }}
   */
  function parseGEDCOM(raw) {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    const individuals = new Map();
    const families    = new Map();
    const media       = new Map();
    const otherLines  = [];  // raw lines from unrecognized level-0 records (SOUR, REPO, NOTE, SUBM, …)
    const inline      = [];  // [{ owner, media, prim }] for inline OBJE, given ids once every record id is known

    let rec = null;          // level-0 node being built (INDI / FAM / OBJE / HEAD)
    let stack = null;
    let capturingOther = false;

    const handle = () => {
      if (!rec) return;
      const r = rec;
      rec = null;
      if (r.val === 'INDI') _indi(r);
      else if (r.val === 'FAM') _fam(r);
      else if (r.val === 'OBJE') {
        const { media: m } = _readMedia(r, r.tag);
        media.set(r.tag, m);
      }
    };

    const _links = (owner, n, sub) => {
      if (XREF_RE.test(n.val)) {
        const list = owner.media || (owner.media = []);
        if (list.includes(n.val)) return;
        list.push(n.val);
        const kids = [];
        if (n.kids) for (const k of n.kids) {
          if (k.tag === '_PRIM') { if (/^y/i.test(k.val)) owner._primMedia = n.val; }
          else _flat(k, kids);
        }
        _keep(sub, 'OBJE ' + n.val, kids);
      } else if (!n.val) {
        const { media: m, prim } = _readMedia(n, null);
        if (m._extra) m._extra = _relevel(m._extra, -1);
        if (m._fileExtra) m._fileExtra = _relevel(m._fileExtra, -1);
        const list = owner.media || (owner.media = []);
        list.push(m);
        inline.push({ owner, media: m, prim });
      } else {
        (owner._unknown = owner._unknown || []).push(..._flat(n));
      }
    };

    function _indi(r) {
      const indi = _makeIndi(r.tag);
      const names = [];
      const sub = {};
      const unknown = [];
      let marn = '', seenBirt = false, seenDeat = false, seenOccu = false, seenNote = false;
      if (r.kids) for (const n of r.kids) {
        switch (n.tag) {
          case 'NAME': names.push(_readName(n)); break;
          case '_MARN': if (n.val) marn = n.val; break;
          case 'SEX':
            // M, F, U — and X (GEDCOM 7's intersex), kept rather than lost.
            indi.sex = /^m/i.test(n.val) ? 'M' : /^f/i.test(n.val) ? 'F' : /^x$/i.test(n.val) ? 'X' : 'U';
            _keep(sub, 'SEX', _flatKids(n));
            break;
          case 'BIRT':
            if (seenBirt) { _flat(n, unknown); break; }
            seenBirt = true;
            _readEvent(n, indi.birth);
            break;
          case 'DEAT':
            indi.deceased = true;
            if (seenDeat) { _flat(n, unknown); break; }
            seenDeat = true;
            _readEvent(n, indi.death, { death: true });
            break;
          case 'FAMC':
          case 'FAMS': {
            const list = n.tag === 'FAMC' ? indi.famc : indi.fams;
            if (!n.val) break;
            if (!list.includes(n.val)) list.push(n.val);
            _keep(sub, n.tag + ' ' + n.val, _flatKids(n));
            break;
          }
          case 'OCCU': {
            if (seenOccu) { _flat(n, unknown); break; }
            seenOccu = true;
            const extra = [];
            indi.occu = _readText(n, extra).trim();
            _keep(sub, 'OCCU', extra);
            break;
          }
          case 'NOTE': {
            // A pointer to a shared NOTE record, or a second note, is kept as
            // written: the model has one editable note per person.
            if (seenNote || XREF_RE.test(n.val)) { _flat(n, unknown); break; }
            seenNote = true;
            const extra = [];
            indi.note = _readText(n, extra);
            _keep(sub, 'NOTE', extra);
            break;
          }
          case 'OBJE': _links(indi, n, sub); break;
          case 'CHR':
          case 'BAPM':
            if (indi._chrYear == null && n.kids) {
              const d = n.kids.find(k => k.tag === 'DATE');
              const y = d ? yearOf(d.val) : null;
              if (y != null) indi._chrYear = y;
            }
            _flat(n, unknown);
            break;
          default:
            // Unrecognized level-1 tag (SOUR, BURI, RESI, custom _TAG, …) —
            // preserve its whole subtree verbatim instead of dropping it.
            _flat(n, unknown);
        }
      }
      _finishNames(indi, names, marn, sub);
      indi.birthYear = birthYearOf(indi);
      if (unknown.length) indi._unknown = unknown;
      if (Object.keys(sub).length) indi._sub = sub;
      individuals.set(r.tag, indi);
    }

    function _fam(r) {
      const fam = _makeFam(r.tag);
      const sub = {};
      const unknown = [];
      if (r.kids) for (const n of r.kids) {
        switch (n.tag) {
          case 'HUSB':
          case 'WIFE': {
            const key = n.tag === 'HUSB' ? 'husb' : 'wife';
            if (fam[key] || !n.val) { _flat(n, unknown); break; }
            fam[key] = n.val;
            _keep(sub, n.tag, _flatKids(n));
            break;
          }
          case 'CHIL':
            if (!n.val) break;
            if (!fam.chil.includes(n.val)) fam.chil.push(n.val);
            _keep(sub, 'CHIL ' + n.val, _flatKids(n));
            break;
          case 'MARR':
            fam.marriages.push(_readEvent(n, { date: '', plac: '', types: [] }, { marriage: true }));
            break;
          case 'DIV': {
            if (fam.div && (fam.divDate || sub.DIV)) { _flat(n, unknown); break; }
            fam.div = n.val !== 'N';
            const extra = [];
            if (n.kids) for (const k of n.kids) {
              if (k.tag === 'DATE' && !fam.divDate) { fam.divDate = k.val; _keep(sub, 'DIV.DATE', _flatKids(k)); }
              else _flat(k, extra);
            }
            _keep(sub, 'DIV', extra);
            break;
          }
          case 'OBJE': _links(fam, n, sub); break;
          default:
            // NOTE, SOUR, ENGA, custom _TAG, … — kept whole.
            _flat(n, unknown);
        }
      }
      if (unknown.length) fam._unknown = unknown;
      if (Object.keys(sub).length) fam._sub = sub;
      families.set(r.tag, fam);
    }

    const lines = raw.split(/\r\n|\r|\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line) continue;
      const m = LINE_RE.exec(line);
      if (!m) continue;
      const lvl = +m[1];

      if (lvl === 0) {
        handle();
        capturingOther = false;
        const tag = m[2];
        const val = (m[3] || '').trim();
        if (tag === 'HEAD' || tag === 'TRLR') continue;   // regenerated on serialize
        if (tag.startsWith('@') && !XREF_RE.test(tag)) continue;   // hostile/malformed xref
        if (tag.startsWith('@') && (val === 'INDI' || val === 'FAM' || val === 'OBJE')) {
          rec = { lvl, tag, val, rv: val, raw: line, kids: null };
          stack = [rec];
        } else {
          // Unrecognized level-0 record (SOUR, REPO, NOTE, SUBM, custom) —
          // preserve verbatim so it round-trips instead of being dropped.
          capturingOther = true;
          otherLines.push(line);
        }
        continue;
      }

      if (capturingOther) { otherLines.push(line); continue; }
      if (!rec) continue;

      const rv = m[3] || '';
      const node = { lvl, tag: m[2], val: rv.trim(), rv, raw: line, kids: null };
      while (stack.length > 1 && stack[stack.length - 1].lvl >= lvl) stack.pop();
      const parent = stack[stack.length - 1];
      (parent.kids || (parent.kids = [])).push(node);
      stack.push(node);
    }
    handle();

    // Inline media become records. Identical inline files (the same photo
    // attached to three people) become one record.
    if (inline.length) {
      let seq = 1;
      const nextId = () => { let id; do id = `@M${seq++}@`; while (media.has(id)); return id; };
      const byKey = new Map();
      for (const it of inline) {
        const m = it.media;
        const key = m._extra || m._fileExtra ? null : `${m.file}\u0000${m.title}\u0000${m.form}`;
        let id = key && byKey.get(key);
        if (!id) {
          id = nextId();
          m.id = id;
          media.set(id, m);
          if (key) byKey.set(key, id);
        }
        const list = it.owner.media;
        const at = list.indexOf(m);
        if (list.includes(id)) list.splice(at, 1); else list[at] = id;
        if (it.prim) it.owner._primMedia = id;
      }
    }

    _linkFamilyPointers(individuals, families);

    return { individuals, families, media, otherLines };
  }

  // ─── GEDCOM serializer ───────────────────────────────────────────────────────

  const _one = v => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');

  // A GEDCOM 5.5.1 line may be at most 255 characters. Long text is split with
  // CONC, never at a space — readers are allowed to trim the ends of a line.
  const _MAX_CHUNK = 240;
  function _concChunks(s) {
    const out = [];
    while (s.length > _MAX_CHUNK) {
      let cut = _MAX_CHUNK;
      while (cut > 1 && (s[cut - 1] === ' ' || s[cut] === ' ')) cut--;
      if (cut <= 1) cut = _MAX_CHUNK;
      out.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    out.push(s);
    return out;
  }

  /** `level TAG text` with CONT for line breaks and CONC for long lines. */
  function _textLines(level, tag, text) {
    const out = [];
    String(text).replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
      const chunks = _concChunks(line);
      chunks.forEach((c, j) => {
        const t = i === 0 && j === 0 ? `${level} ${tag}` : j === 0 ? `${level + 1} CONT` : `${level + 1} CONC`;
        out.push(c ? `${t} ${c}` : t);
      });
    });
    return out;
  }

  const _subOf = (o, key) => (o && o._sub && o._sub[key]) || [];

  /** The NAME value: as it was written, while its parts are unchanged. */
  function _nameValue(src, givn, surn) {
    if (Array.isArray(src) && src[1] === givn && src[2] === surn && src[0]) return _one(src[0]);
    return _one((givn ? givn + ' ' : '') + '/' + (surn || '') + '/');
  }

  function _eventLines(tag, ev) {
    const has = ev.date || ev.plac || ev.caus || (ev.types && ev.types.length) || _subOf(ev, '').length;
    if (!has) return ev._y ? [`1 ${tag} Y`] : [];
    const out = [`1 ${tag}`];
    if (ev.types && ev.types.length) out.push(`2 TYPE ${_one(ev.types.join(', '))}`, ..._subOf(ev, 'TYPE'));
    if (ev.date) out.push(`2 DATE ${_one(ev.date)}`, ..._subOf(ev, 'DATE'));
    if (ev.plac) out.push(`2 PLAC ${_one(ev.plac)}`, ..._mapLines(3, ev.map), ..._subOf(ev, 'PLAC'));
    if (ev.caus) out.push(`2 CAUS ${_one(ev.caus)}`, ..._subOf(ev, 'CAUS'));
    out.push(..._subOf(ev, ''));
    return out;
  }

  function _mediaLinkLines(owner, known) {
    const out = [];
    for (const id of owner.media || []) {
      if (typeof id !== 'string' || (known && !known.has(id))) continue;
      out.push(`1 OBJE ${id}`);
      if (owner._primMedia === id) out.push('2 _PRIM Y');
      out.push(..._subOf(owner, 'OBJE ' + id));
    }
    return out;
  }

  function _mediaRecordLines(m) {
    const out = [`0 ${m.id} OBJE`];
    const form = (m.form || mediaFormOf(m.file) || 'unknown').toLowerCase();
    const type = m.type || _mediTypeOf(mediaKindOf(m));
    out.push(`1 FILE ${_one(m.file)}`, `2 FORM ${_one(form)}`);
    if (type) out.push(`3 TYPE ${_one(type)}`);
    if (m.title) out.push(`2 TITL ${_one(m.title)}`);
    if (m._fileExtra) out.push(...m._fileExtra);
    if (m._extra) out.push(...m._extra);
    return out;
  }

  /**
   * Serialize individuals and families to a GEDCOM 5.5.1 string.
   * @param {Map} individuals
   * @param {Map} families
   * @param {string[]} [otherLines]  Raw lines from unrecognized level-0 records, re-emitted verbatim before TRLR
   * @param {Map} [media]  OBJE records, id → { file, form, type, title }
   * @returns {string}
   */
  function serializeGEDCOM(individuals, families, otherLines, media) {
    const lines = [];
    const knownMedia = media instanceof Map ? media : null;

    lines.push('0 HEAD');
    lines.push('1 SOUR Stemma');
    lines.push('2 NAME Stemma');
    lines.push('1 GEDC');
    lines.push('2 VERS 5.5.1');
    lines.push('2 FORM LINEAGE-LINKED');
    lines.push('1 CHAR UTF-8');
    // 5.5.1 wants the header to name a submitter. When the file came with one,
    // keep pointing at it.
    for (const l of otherLines || []) {
      const m = l.match(/^0 (@[^@]+@) SUBM\b/);
      if (m) { lines.push(`1 SUBM ${m[1]}`); break; }
    }

    for (const [id, i] of individuals) {
      lines.push(`0 ${id} INDI`);

      const hasMaiden = Boolean(i.maidenName);
      const hasGivnSurn = i.givn || i.surn;

      if (hasMaiden && hasGivnSurn) {
        // Birth name first (maiden surname), then married name
        lines.push(`1 NAME ${_nameValue(i._birthNameSrc, i.givn, i.maidenName)}`);
        if (i.givn) lines.push(`2 GIVN ${_one(i.givn)}`);
        lines.push(`2 SURN ${_one(i.maidenName)}`);
        lines.push('2 TYPE birth');
        lines.push(..._subOf(i, 'NAME.birth'));

        lines.push(`1 NAME ${_nameValue(i._nameSrc, i.givn, i.surn)}`);
        if (i.givn) lines.push(`2 GIVN ${_one(i.givn)}`);
        if (i.surn) lines.push(`2 SURN ${_one(i.surn)}`);
        lines.push('2 TYPE married');
        lines.push(..._subOf(i, 'NAME'));
      } else if (hasGivnSurn) {
        lines.push(`1 NAME ${_nameValue(i._nameSrc, i.givn, i.surn)}`);
        if (i.givn) lines.push(`2 GIVN ${_one(i.givn)}`);
        if (i.surn) lines.push(`2 SURN ${_one(i.surn)}`);
        lines.push(..._subOf(i, 'NAME'));
      } else if (i.name) {
        lines.push(`1 NAME ${_one(i.name)}`);
        lines.push(..._subOf(i, 'NAME'));
      }
      lines.push(..._subOf(i, 'NAMES'));

      if (i.sex && i.sex !== 'U') lines.push(`1 SEX ${_one(i.sex)}`, ..._subOf(i, 'SEX'));

      lines.push(..._eventLines('BIRT', i.birth || {}));

      if (i.deceased || i.death?.date || i.death?.plac || i.death?.caus) {
        const d = _eventLines('DEAT', i.death || {});
        lines.push(...(d.length ? d : ['1 DEAT Y']));
      }

      for (const famId of i.famc || []) lines.push(`1 FAMC ${famId}`, ..._subOf(i, 'FAMC ' + famId));
      for (const famId of i.fams || []) lines.push(`1 FAMS ${famId}`, ..._subOf(i, 'FAMS ' + famId));

      if (i.occu) lines.push(..._textLines(1, 'OCCU', i.occu), ..._subOf(i, 'OCCU'));

      if (i.note) lines.push(..._textLines(1, 'NOTE', i.note), ..._subOf(i, 'NOTE'));

      lines.push(..._mediaLinkLines(i, knownMedia));

      for (const l of (i._unknown || [])) lines.push(l);
    }

    for (const [id, f] of families) {
      lines.push(`0 ${id} FAM`);
      if (f.husb) lines.push(`1 HUSB ${f.husb}`, ..._subOf(f, 'HUSB'));
      if (f.wife) lines.push(`1 WIFE ${f.wife}`, ..._subOf(f, 'WIFE'));
      for (const cid of f.chil || []) lines.push(`1 CHIL ${cid}`, ..._subOf(f, 'CHIL ' + cid));
      for (const mm of (f.marriages || [])) lines.push(..._eventLines('MARR', mm));
      if (f.div) {
        lines.push('1 DIV Y');
        if (f.divDate) lines.push(`2 DATE ${_one(f.divDate)}`, ..._subOf(f, 'DIV.DATE'));
        lines.push(..._subOf(f, 'DIV'));
      }
      lines.push(..._mediaLinkLines(f, knownMedia));

      for (const l of (f._unknown || [])) lines.push(l);
    }

    if (knownMedia) for (const m of knownMedia.values()) lines.push(..._mediaRecordLines(m));

    for (const l of (otherLines || [])) lines.push(l);

    lines.push('0 TRLR');
    return lines.join('\r\n');
  }

  // ─── JSON export/import ──────────────────────────────────────────────────────

  /**
   * Export to a JSON string containing all individuals and families.
   * @param {Map} individuals
   * @param {Map} families
   * @param {{ media?: Map, otherLines?: string[], pretty?: boolean }} [extra]
   * @returns {string}
   */
  function exportJSON(individuals, families, extra = {}) {
    const data = {
      version: 1,
      format: 'gedcom-vis-json',
      exportedAt: new Date().toISOString(),
      individuals: Array.from(individuals.values()),
      families:    Array.from(families.values())
    };
    // Media records and the file's other level-0 records (sources, repositories,
    // shared notes) travel too, or a JSON round trip loses them.
    if (extra.media && extra.media.size) data.media = Array.from(extra.media.values());
    if (extra.otherLines && extra.otherLines.length) data.otherLines = extra.otherLines;
    return extra.pretty === false ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  }

  function _fromData(data, what) {
    if (!data || !Array.isArray(data.individuals)) {
      throw new Error(`Invalid ${what}: missing individuals array`);
    }
    const individuals = new Map();
    const families    = new Map();
    const media       = new Map();
    for (const i of data.individuals) {
      if (!i || i.id == null) continue;
      const indi = Object.assign(_makeIndi(i.id), i);
      indi.birth = Object.assign({ date: '', plac: '' }, i.birth || {});
      indi.death = Object.assign({ date: '', plac: '', caus: '' }, i.death || {});
      indi.famc = Array.isArray(i.famc) ? i.famc : [];
      indi.fams = Array.isArray(i.fams) ? i.fams : [];
      if (!indi.displayName) indi.displayName = displayNameOf(indi.givn, indi.surn, indi.name || String(indi.id));
      individuals.set(indi.id, indi);
    }
    for (const f of (data.families || [])) {
      if (!f || f.id == null) continue;
      const fam = Object.assign(_makeFam(f.id), f);
      fam.chil = Array.isArray(f.chil) ? f.chil : [];
      fam.marriages = Array.isArray(f.marriages) ? f.marriages.map(m => Object.assign({ date: '', plac: '', types: [] }, m)) : [];
      families.set(fam.id, fam);
    }
    for (const m of (Array.isArray(data.media) ? data.media : [])) {
      if (m && m.id) media.set(m.id, Object.assign({ file: '', form: '', type: '', title: '' }, m));
    }
    const otherLines = Array.isArray(data.otherLines) ? data.otherLines.map(String) : [];
    _linkFamilyPointers(individuals, families);
    return { individuals, families, media, otherLines };
  }

  /**
   * Import from a JSON string produced by exportJSON.
   * @param {string} jsonStr
   * @returns {{ individuals: Map, families: Map, media: Map, otherLines: string[] }}
   */
  function importJSON(jsonStr) {
    return _fromData(JSON.parse(jsonStr), 'JSON');
  }

  // ─── YAML export/import ──────────────────────────────────────────────────────

  function _yamlScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number')  return Number.isFinite(v) ? String(v) : 'null';
    const s = String(v);
    const needsQuote =
      s === '' ||
      /[:\[\]{},#&*!|>'"\\%@`\n\r\t]/.test(s) ||
      /^\s|\s$/.test(s) ||
      /^[-?~]/.test(s) ||
      /^(true|false|null|yes|no|on|off|y|n)$/i.test(s) ||
      !Number.isNaN(Number(s));
    if (!needsQuote) return s;
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }

  function _yamlKey(k) {
    return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k);
  }

  // Short lists of short scalars stay on one line (famc: [@F1@]); anything
  // longer — raw GEDCOM lines, mostly — is a block list, one item per line.
  const _inlineList = arr => arr.length <= 8 && arr.every(v => typeof v !== 'string' || v.length <= 40);

  function _serializeYAMLObj(obj, indent) {
    const out = [];
    for (const [rawKey, val] of Object.entries(obj)) {
      const key = _yamlKey(rawKey);
      if (val === null || val === undefined) {
        out.push(`${indent}${key}: null`);
      } else if (Array.isArray(val)) {
        if (val.length === 0) {
          out.push(`${indent}${key}: []`);
        } else if (val.some(x => x && typeof x === 'object')) {
          // Block sequence of objects (e.g. marriages)
          out.push(`${indent}${key}:`);
          const itemIndent = indent + '  ';
          for (const item of val) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              out.push(`${itemIndent}- ${_yamlScalar(Array.isArray(item) ? JSON.stringify(item) : item)}`);
              continue;
            }
            const itemLines = _serializeYAMLObj(item, itemIndent + '  ');
            if (!itemLines.length) { out.push(`${itemIndent}- {}`); continue; }
            // First line: "  - key: val"
            out.push(`${itemIndent}- ${itemLines[0].slice(itemIndent.length + 2)}`);
            for (let k = 1; k < itemLines.length; k++) out.push(itemLines[k]);
          }
        } else if (_inlineList(val)) {
          out.push(`${indent}${key}: [${val.map(_yamlScalar).join(', ')}]`);
        } else {
          out.push(`${indent}${key}:`);
          for (const item of val) out.push(`${indent}  - ${_yamlScalar(item)}`);
        }
      } else if (typeof val === 'object') {
        const inner = _serializeYAMLObj(val, indent + '  ');
        if (!inner.length) { out.push(`${indent}${key}: {}`); continue; }
        out.push(`${indent}${key}:`);
        out.push(...inner);
      } else {
        out.push(`${indent}${key}: ${_yamlScalar(val)}`);
      }
    }
    return out;
  }

  function _yamlRecords(out, name, records) {
    if (!records.length) { out.push(`${name}: []`); return; }
    out.push(`${name}:`);
    for (const r of records) {
      out.push(`  - id: ${_yamlScalar(r.id)}`);
      const rest = Object.assign({}, r);
      delete rest.id;
      out.push(..._serializeYAMLObj(rest, '    '));
    }
  }

  /**
   * Export to a YAML string (human-readable).
   * @param {Map} individuals
   * @param {Map} families
   * @param {{ media?: Map, otherLines?: string[] }} [extra]
   * @returns {string}
   */
  function exportYAML(individuals, families, extra = {}) {
    const out = [
      '# gedcom-vis family tree export (Stemma)',
      'version: 1',
      'format: gedcom-vis-yaml',
      `exportedAt: ${_yamlScalar(new Date().toISOString())}`,
      ''
    ];
    _yamlRecords(out, 'individuals', Array.from(individuals.values()));
    out.push('');
    _yamlRecords(out, 'families', Array.from(families.values()));
    if (extra.media && extra.media.size) {
      out.push('');
      _yamlRecords(out, 'media', Array.from(extra.media.values()));
    }
    if (extra.otherLines && extra.otherLines.length) {
      out.push('', 'otherLines:');
      for (const l of extra.otherLines) out.push(`  - ${_yamlScalar(l)}`);
    }
    return out.join('\n');
  }

  // ── Internal minimal YAML parser ─────────────────────────────────────────────
  // Reads what exportYAML writes (and the common hand-written subset of it).

  /** Where a double-quoted string starting at s[i] ends (index of the quote). */
  function _quoteEnd(s, i) {
    const q = s[i];
    for (let j = i + 1; j < s.length; j++) {
      if (q === '"' && s[j] === '\\') { j++; continue; }
      if (s[j] === q) {
        if (q === "'" && s[j + 1] === "'") { j++; continue; }
        return j;
      }
    }
    return -1;
  }

  function _unquote(s) {
    if (s[0] === '"') {
      return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
        if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
        return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '0' ? '\0' : c;
      });
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }

  function _parseYAMLScalar(s) {
    s = s.trim();
    if (!s || s === 'null' || s === '~') return null;
    if (s === 'true'  || s === 'yes' || s === 'on')  return true;
    if (s === 'false' || s === 'no'  || s === 'off') return false;
    if (s === '[]') return [];
    if (s === '{}') return {};
    if (s.startsWith('[')) {
      const inner = s.slice(1, s.lastIndexOf(']')).trim();
      if (!inner) return [];
      return _splitCSV(inner).map(item => _parseYAMLScalar(item.trim()));
    }
    if ((s[0] === '"' || s[0] === "'") && _quoteEnd(s, 0) === s.length - 1) return _unquote(s);
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
    return s;
  }

  function _splitCSV(s) {
    const parts = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const end = _quoteEnd(s, i);
        const stop = end === -1 ? s.length - 1 : end;
        cur += s.slice(i, stop + 1);
        i = stop;
      } else if (ch === ',') { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  /** "key: value" / "key:" / '"quoted key": value' → { key, val } or null. */
  function _splitKey(text) {
    if (text[0] === '"' || text[0] === "'") {
      const end = _quoteEnd(text, 0);
      if (end === -1 || text[end + 1] !== ':') return null;
      const after = text.slice(end + 2);
      if (after && after[0] !== ' ') return null;
      return { key: _unquote(text.slice(0, end + 1)), val: after.trim() };
    }
    const sep = text.indexOf(': ');
    if (sep !== -1) return { key: text.slice(0, sep), val: text.slice(sep + 2) };
    if (text.endsWith(':')) return { key: text.slice(0, -1), val: '' };
    return null;
  }

  function _parseYAML(text) {
    // Build flat token list (skip empty lines and comments)
    const tokens = [];
    for (const raw of text.split('\n')) {
      const stripped = raw.replace(/\r$/, '');
      const trimmed  = stripped.trimStart();
      if (!trimmed || trimmed.startsWith('#')) continue;
      tokens.push({ text: trimmed, indent: stripped.length - trimmed.length });
    }

    let pos = 0;
    const peek    = () => pos < tokens.length ? tokens[pos] : null;
    const consume = () => pos < tokens.length ? tokens[pos++] : null;
    const isItem  = t => t.text.startsWith('- ') || t.text === '-';

    function parseValue(valText, lineIndent) {
      if (valText !== '' && valText !== '|' && valText !== '>') return _parseYAMLScalar(valText);
      const nxt = peek();
      if (!nxt || nxt.indent <= lineIndent) {
        // "key:" followed by a sequence at the *same* indent is legal YAML.
        if (nxt && nxt.indent === lineIndent && isItem(nxt) && valText === '') return parseSequence(nxt.indent);
        return null;
      }
      return isItem(nxt) ? parseSequence(nxt.indent) : parseMapping(nxt.indent);
    }

    function parseMapping(baseIndent) {
      const obj = {};
      while (peek() && peek().indent === baseIndent && !isItem(peek())) {
        const line = consume();
        const kv = _splitKey(line.text);
        if (!kv) continue;   // malformed line
        obj[kv.key] = parseValue(kv.val, line.indent);
      }
      return obj;
    }

    function parseSequence(baseIndent) {
      const arr = [];
      while (peek() && peek().indent === baseIndent && isItem(peek())) {
        const line = consume();
        const rest = line.text.slice(2).trim();

        if (!rest) {
          const nxt = peek();
          if (nxt && nxt.indent > baseIndent) arr.push(isItem(nxt) ? parseSequence(nxt.indent) : parseMapping(nxt.indent));
          else arr.push(null);
          continue;
        }

        // A quoted scalar item may itself contain ": " — it is not a key.
        const quotedScalar = (rest[0] === '"' || rest[0] === "'") && _quoteEnd(rest, 0) === rest.length - 1;
        const kv = quotedScalar || rest.startsWith('[') || rest.startsWith('{') ? null : _splitKey(rest);
        if (!kv) { arr.push(_parseYAMLScalar(rest)); continue; }

        // First property of an object item inline with "- "
        const item = {};
        const itemIndent = line.indent + 2;
        item[kv.key] = parseValue(kv.val, itemIndent);
        while (peek() && peek().indent > baseIndent && !(peek().indent === baseIndent && isItem(peek()))) {
          const prop = peek();
          if (isItem(prop) && prop.indent <= itemIndent) break;
          consume();
          const pkv = _splitKey(prop.text);
          if (!pkv) continue;
          item[pkv.key] = parseValue(pkv.val, prop.indent);
        }
        arr.push(item);
      }
      return arr;
    }

    return parseMapping(0);
  }

  /**
   * Import from a YAML string produced by exportYAML.
   * @param {string} yamlStr
   * @returns {{ individuals: Map, families: Map, media: Map, otherLines: string[] }}
   */
  function importYAML(yamlStr) {
    const trimmed = yamlStr.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return importJSON(trimmed);
    const data = _parseYAML(yamlStr);
    if (!Object.prototype.hasOwnProperty.call(data, 'individuals') || !Array.isArray(data.individuals)) {
      throw new Error('Invalid YAML: missing individuals array');
    }
    return _fromData(data, 'YAML');
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    parseGEDCOM, serializeGEDCOM, exportJSON, importJSON, exportYAML, importYAML,
    decodeGedcom, decodeAnsel, displayNameOf, birthYearOf, yearOf,
    mediaFormOf, mediaKindOf, _linkFamilyPointers, _makeIndi, _makeFam,
  };
});
