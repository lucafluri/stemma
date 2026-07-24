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

  // ─── GEDCOM parser ───────────────────────────────────────────────────────────

  /**
   * Parse a GEDCOM string.
   * @param {string} raw  Raw GEDCOM text (UTF-8, with or without BOM).
   * @returns {{ individuals: Map, families: Map }}
   */
  function parseGEDCOM(raw) {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM

    const individuals = new Map();
    const families    = new Map();
    const otherLines  = [];  // raw lines from unrecognized level-0 records (SOUR, OBJE, SUBM, …)
    const lines = raw.split(/\r?\n/);

    let cur     = null;
    let curType = null;  // 'INDI' | 'FAM' | null
    let subCtx  = null;  // tag context string or null
    let capturingOther = false;  // inside an unrecognized level-0 record

    for (const rawLine of lines) {
      if (!rawLine.trim()) continue;

      // Single delimiter space between tag and value per GEDCOM spec — anything
      // beyond that first space is verbatim value content (matters for CONT/CONC
      // lines, where leading spaces are meaningful and must not be trimmed away).
      const m = rawLine.match(/^\s*(\d+)\s+(\S+)(?:\s(.*))?$/);
      if (!m) continue;

      const level  = +m[1];
      const tag    = m[2];
      const rawVal = m[3] || '';
      const val    = rawVal.trim();

      // ── Level 0: new top-level record ──────────────────────────────────────
      if (level === 0) {
        subCtx = null;
        capturingOther = false;  // re-decided below for this record

        // Reject malformed/hostile xref ids (e.g. containing quotes) — these get
        // interpolated into onclick handlers in the UI, so only allow the safe
        // charset GEDCOM actually uses for pointers.
        if (tag.startsWith('@') && !/^@[A-Za-z0-9_.+-]+@$/.test(tag)) {
          cur = null; curType = null;
          continue;
        }
        if (tag.startsWith('@') && val === 'INDI') {
          cur = _makeIndi(tag);
          cur._names      = [];  // accumulate NAME records before committing
          cur._marnLegacy = '';  // legacy _MARN value
          individuals.set(tag, cur);
          curType = 'INDI';
        } else if (tag.startsWith('@') && val === 'FAM') {
          cur = _makeFam(tag);
          families.set(tag, cur);
          curType = 'FAM';
        } else if (tag === 'HEAD' || tag === 'TRLR') {
          // Own HEAD/TRLR is regenerated on serialize — not preserved.
          cur = null; curType = null;
        } else {
          // Unrecognized level-0 record (SOUR, OBJE, SUBM, custom @X@ TAG, …) —
          // preserve verbatim so it round-trips instead of being silently dropped.
          cur = null; curType = null;
          capturingOther = true;
          otherLines.push(rawLine);
        }
        continue;
      }

      if (capturingOther) { otherLines.push(rawLine); continue; }
      if (!cur) continue;

      // ── INDI record ─────────────────────────────────────────────────────────
      if (curType === 'INDI') {
        if (level === 1) {
          subCtx = null;
          switch (tag) {
            case 'NAME': {
              const nr = { raw: val, givn: '', surn: '', type: '' };
              cur._names.push(nr);
              subCtx = 'NAME_' + (cur._names.length - 1);
              break;
            }
            case '_MARN': if (val) cur._marnLegacy = val; break;
            case 'SEX':   cur.sex = val; break;
            case 'BIRT':  subCtx = 'BIRT'; break;
            case 'DEAT':  cur.deceased = true; subCtx = 'DEAT'; break;
            case 'FAMC':  if (val) cur.famc.push(val); break;
            case 'FAMS':  if (val) cur.fams.push(val); break;
            case 'OCCU':  cur.occu = val; break;
            case 'NOTE':  cur.note = val; subCtx = 'NOTE'; break;
            default:
              // Unrecognized level-1 tag (SOUR, CHR, BURI, OBJE, custom _TAG, …) —
              // preserve its whole subtree verbatim instead of dropping it.
              (cur._unknown = cur._unknown || []).push(rawLine);
              subCtx = '_UNK';
          }
        } else if (subCtx === '_UNK') {
          cur._unknown.push(rawLine);
        } else if (level === 2) {
          if (subCtx && subCtx.startsWith('NAME_')) {
            const nr = cur._names[parseInt(subCtx.slice(5), 10)];
            if (nr) {
              if      (tag === 'GIVN') nr.givn = val;
              else if (tag === 'SURN') nr.surn = val;
              else if (tag === 'TYPE') nr.type = val.toLowerCase();
            }
          } else if (subCtx === 'BIRT') {
            if (tag === 'DATE') {
              cur.birth.date = val;
              const ym = val.match(/\b(\d{4})\b/);
              if (ym) cur.birthYear = +ym[1];
            } else if (tag === 'PLAC') {
              cur.birth.plac = val;
            }
          } else if (subCtx === 'DEAT') {
            if      (tag === 'DATE') cur.death.date = val;
            else if (tag === 'PLAC') cur.death.plac = val;
            else if (tag === 'CAUS') cur.death.caus = val;
          } else if (subCtx === 'NOTE') {
            if      (tag === 'CONT') cur.note += '\n' + rawVal;
            else if (tag === 'CONC') cur.note += rawVal;
          } else {
            if      (tag === 'GIVN' && !cur.givn) cur.givn = val;
            else if (tag === 'SURN' && !cur.surn) cur.surn = val;
            else if (tag === 'CONT') cur.note += '\n' + rawVal;
            else if (tag === 'CONC') cur.note += rawVal;
          }
        } else if (level === 3 && tag === 'CONT') {
          cur.note += '\n' + rawVal;
        } else if (level === 3 && tag === 'CONC') {
          cur.note += rawVal;
        }

      // ── FAM record ─────────────────────────────────────────────────────────
      } else if (curType === 'FAM') {
        if (level === 1) {
          subCtx = null;
          switch (tag) {
            case 'HUSB': cur.husb = val; break;
            case 'WIFE': cur.wife = val; break;
            case 'CHIL': if (val) cur.chil.push(val); break;
            case 'MARR':
              cur.marriages.push({ date: '', plac: '', types: [] });
              subCtx = 'MARR';
              break;
            case 'DIV': cur.div = true; subCtx = 'DIV'; break;
            default:
              // Unrecognized level-1 tag (NOTE, SOUR, custom _TAG, …) — preserve
              // its whole subtree verbatim; this is also how FAM NOTE survives.
              (cur._unknown = cur._unknown || []).push(rawLine);
              subCtx = '_UNK';
          }
        } else if (subCtx === '_UNK') {
          cur._unknown.push(rawLine);
        } else if (level === 2) {
          if (subCtx === 'MARR') {
            const mm = cur.marriages[cur.marriages.length - 1];
            if (mm) {
              if      (tag === 'DATE') mm.date  = val;
              else if (tag === 'PLAC') mm.plac  = val;
              else if (tag === 'TYPE') mm.types = val.split(',').map(s => s.trim()).filter(Boolean);
            }
          } else if (subCtx === 'DIV') {
            if (tag === 'DATE') cur.divDate = val;
          }
        }
      }
    }

    // ── Post-process individuals ──────────────────────────────────────────────
    for (const [, indi] of individuals) {
      const names = indi._names || [];
      delete indi._names;

      let primary      = null;
      let birthNameRec = null;

      if (names.length === 1) {
        primary = names[0];
        // A single NAME record typed 'birth' is still used as display name
      } else if (names.length >= 2) {
        const marriedRec = names.find(n => n.type === 'married');
        const birthRec   = names.find(n => n.type === 'birth');

        if (marriedRec) {
          primary      = marriedRec;
          birthNameRec = birthRec || names.find(n => n !== marriedRec) || null;
        } else if (birthRec) {
          const other = names.find(n => n !== birthRec);
          primary      = other || birthRec;
          birthNameRec = birthRec !== primary ? birthRec : null;
        } else {
          // No TYPE tags: legacy — first NAME = primary, second = maiden
          primary      = names[0];
          birthNameRec = names[1] || null;
        }
      }

      if (primary) {
        const raw   = primary.raw || '';
        const clean = raw.replace(/\//g, '').replace(/\s+/g, ' ').trim();
        if (clean) indi.name = clean;
        const surnM = raw.match(/\/([^/]+)\//);
        const givnM = raw.match(/^([^/]*)\s*\//);
        indi.surn = primary.surn || (surnM ? surnM[1].trim() : '');
        indi.givn = primary.givn || (givnM ? givnM[1].trim() : '');
      }

      if (birthNameRec) {
        const raw   = birthNameRec.raw || '';
        const surnM = raw.match(/\/([^/]+)\//);
        indi.maidenName = birthNameRec.surn ||
          (surnM ? surnM[1].trim() : raw.replace(/\//g, '').trim());
      }

      // Legacy _MARN fallback
      if (!indi.maidenName && indi._marnLegacy) {
        indi.maidenName = indi._marnLegacy;
      }
      delete indi._marnLegacy;

      // Fallback name
      if (!indi.name) indi.name = indi.id.replace(/@/g, '');

      // Derive givn/surn from combined name if still missing
      if (!indi.surn && indi.name) {
        const parts = indi.name.trim().split(/\s+/);
        if (parts.length >= 2) {
          indi.surn = parts[parts.length - 1];
          indi.givn = parts.slice(0, -1).join(' ');
        }
      }

      // Display name (shortened for UI)
      indi.displayName = (indi.givn && indi.surn)
        ? indi.givn + ' ' + indi.surn
        : indi.name;
      if (indi.displayName.length > 24) {
        indi.displayName = indi.givn
          ? indi.givn + (indi.surn ? ' ' + indi.surn[0] + '.' : '')
          : indi.displayName.slice(0, 22) + '…';
      }
    }

    return { individuals, families, otherLines };
  }

  // ─── GEDCOM serializer ───────────────────────────────────────────────────────

  /**
   * Serialize individuals and families to a GEDCOM 5.5.1 string.
   * Maiden names are written as a second NAME record with TYPE birth + TYPE married.
   * @param {Map} individuals
   * @param {Map} families
   * @param {string[]} [otherLines]  Raw lines from unrecognized level-0 records, re-emitted verbatim before TRLR
   * @returns {string}
   */
  function serializeGEDCOM(individuals, families, otherLines) {
    const lines = [];

    lines.push('0 HEAD');
    lines.push('1 SOUR Stammbaum Vis');
    lines.push('1 GEDC');
    lines.push('2 VERS 5.5.1');
    lines.push('2 FORM LINEAGE-LINKED');
    lines.push('1 CHAR UTF-8');

    for (const [id, i] of individuals) {
      lines.push(`0 ${id} INDI`);

      const hasMaiden = Boolean(i.maidenName);
      const hasGivnSurn = i.givn || i.surn;

      if (hasMaiden && hasGivnSurn) {
        // Birth name first (maiden surname), then married name
        const birthLine = (i.givn ? i.givn + ' ' : '') + '/' + i.maidenName + '/';
        lines.push(`1 NAME ${birthLine}`);
        if (i.givn)       lines.push(`2 GIVN ${i.givn}`);
        lines.push(`2 SURN ${i.maidenName}`);
        lines.push('2 TYPE birth');

        const marriedLine = (i.givn ? i.givn + ' ' : '') + '/' + (i.surn || '') + '/';
        lines.push(`1 NAME ${marriedLine}`);
        if (i.givn) lines.push(`2 GIVN ${i.givn}`);
        if (i.surn) lines.push(`2 SURN ${i.surn}`);
        lines.push('2 TYPE married');
      } else if (hasGivnSurn) {
        const nameLine = (i.givn ? i.givn + ' ' : '') + '/' + (i.surn || '') + '/';
        lines.push(`1 NAME ${nameLine}`);
        if (i.givn) lines.push(`2 GIVN ${i.givn}`);
        if (i.surn) lines.push(`2 SURN ${i.surn}`);
      } else if (i.name) {
        lines.push(`1 NAME ${i.name}`);
      }

      if (i.sex && i.sex !== 'U') lines.push(`1 SEX ${i.sex}`);

      if (i.birth.date || i.birth.plac) {
        lines.push('1 BIRT');
        if (i.birth.date) lines.push(`2 DATE ${i.birth.date}`);
        if (i.birth.plac) lines.push(`2 PLAC ${i.birth.plac}`);
      }

      if (i.deceased || i.death.date || i.death.plac || i.death.caus) {
        if (i.death.date || i.death.plac || i.death.caus) {
          lines.push('1 DEAT');
          if (i.death.date) lines.push(`2 DATE ${i.death.date}`);
          if (i.death.plac) lines.push(`2 PLAC ${i.death.plac}`);
          if (i.death.caus) lines.push(`2 CAUS ${i.death.caus}`);
        } else {
          lines.push('1 DEAT Y');
        }
      }

      for (const famId of i.famc) lines.push(`1 FAMC ${famId}`);
      for (const famId of i.fams) lines.push(`1 FAMS ${famId}`);

      if (i.occu) lines.push(`1 OCCU ${i.occu}`);

      if (i.note) {
        const noteLines = i.note.split('\n');
        lines.push(`1 NOTE ${noteLines[0]}`);
        for (let k = 1; k < noteLines.length; k++) lines.push(`2 CONT ${noteLines[k]}`);
        // ponytail: CONC not emitted (no line-length limit enforced); add 255-char splitting if a strict consumer requires it
      }

      for (const l of (i._unknown || [])) lines.push(l);
    }

    for (const [id, f] of families) {
      lines.push(`0 ${id} FAM`);
      if (f.husb) lines.push(`1 HUSB ${f.husb}`);
      if (f.wife) lines.push(`1 WIFE ${f.wife}`);
      for (const cid of f.chil) lines.push(`1 CHIL ${cid}`);
      for (const mm of (f.marriages || [])) {
        if (!mm.date && !mm.plac && !(mm.types && mm.types.length)) continue;
        lines.push('1 MARR');
        if (mm.date)           lines.push(`2 DATE ${mm.date}`);
        if (mm.plac)           lines.push(`2 PLAC ${mm.plac}`);
        if (mm.types && mm.types.length) lines.push(`2 TYPE ${mm.types.join(', ')}`);
      }
      if (f.div) {
        lines.push('1 DIV Y');
        if (f.divDate) lines.push(`2 DATE ${f.divDate}`);
      }

      for (const l of (f._unknown || [])) lines.push(l);
    }

    for (const l of (otherLines || [])) lines.push(l);

    lines.push('0 TRLR');
    return lines.join('\r\n');
  }

  // ─── JSON export/import ──────────────────────────────────────────────────────

  /**
   * Export to a JSON string containing all individuals and families.
   * @param {Map} individuals
   * @param {Map} families
   * @returns {string}
   */
  function exportJSON(individuals, families) {
    const data = {
      version: 1,
      format: 'gedcom-vis-json',
      exportedAt: new Date().toISOString(),
      individuals: Array.from(individuals.values()),
      families:    Array.from(families.values())
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import from a JSON string produced by exportJSON.
   * @param {string} jsonStr
   * @returns {{ individuals: Map, families: Map }}
   */
  function importJSON(jsonStr) {
    const data = JSON.parse(jsonStr);
    if (!data.individuals || !Array.isArray(data.individuals)) {
      throw new Error('Invalid JSON: missing individuals array');
    }
    const individuals = new Map();
    const families    = new Map();
    for (const i of data.individuals) {
      individuals.set(i.id, Object.assign(_makeIndi(i.id), i));
    }
    for (const f of (data.families || [])) {
      families.set(f.id, Object.assign(_makeFam(f.id), f));
    }
    return { individuals, families };
  }

  // ─── YAML export/import ──────────────────────────────────────────────────────

  function _yamlScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number')  return isNaN(v) ? 'null' : String(v);
    const s = String(v);
    const needsQuote =
      s === '' ||
      /[:\[\]{},#&*!|>'"\\%@`\n\r]/.test(s) ||
      /^\s|\s$/.test(s) ||
      /^[-?]/.test(s) ||
      /^(true|false|null|yes|no|on|off)$/i.test(s) ||
      /^\d+(\.\d+)?$/.test(s);
    if (!needsQuote) return s;
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
  }

  function _serializeYAMLObj(obj, indent) {
    const out = [];
    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) {
        out.push(`${indent}${key}: null`);
      } else if (Array.isArray(val)) {
        if (val.length === 0) {
          out.push(`${indent}${key}: []`);
        } else if (typeof val[0] === 'object' && val[0] !== null) {
          // Block sequence of objects (e.g. marriages)
          out.push(`${indent}${key}:`);
          const itemIndent = indent + '  ';
          for (const item of val) {
            const itemLines = _serializeYAMLObj(item, itemIndent + '  ');
            // First line: "  - key: val"
            out.push(`${itemIndent}- ${itemLines[0].slice(itemIndent.length + 2)}`);
            for (let k = 1; k < itemLines.length; k++) out.push(itemLines[k]);
          }
        } else {
          // Inline sequence of scalars (e.g. famc, fams, chil)
          out.push(`${indent}${key}: [${val.map(_yamlScalar).join(', ')}]`);
        }
      } else if (typeof val === 'object') {
        // Nested object (e.g. birth, death)
        out.push(`${indent}${key}:`);
        out.push(..._serializeYAMLObj(val, indent + '  '));
      } else {
        out.push(`${indent}${key}: ${_yamlScalar(val)}`);
      }
    }
    return out;
  }

  /**
   * Export to a YAML string (human-readable).
   * @param {Map} individuals
   * @param {Map} families
   * @returns {string}
   */
  function exportYAML(individuals, families) {
    const out = [
      '# gedcom-vis family tree export',
      'version: 1',
      'format: gedcom-vis-yaml',
      `exportedAt: ${_yamlScalar(new Date().toISOString())}`,
      ''
    ];
    if (individuals.size === 0) {
      out.push('individuals: []');
    } else {
      out.push('individuals:');
      for (const indi of individuals.values()) {
        out.push(`  - id: ${_yamlScalar(indi.id)}`);
        const rest = Object.assign({}, indi);
        delete rest.id;
        out.push(..._serializeYAMLObj(rest, '    '));
      }
    }
    out.push('');
    if (families.size === 0) {
      out.push('families: []');
    } else {
      out.push('families:');
      for (const fam of families.values()) {
        out.push(`  - id: ${_yamlScalar(fam.id)}`);
        const rest = Object.assign({}, fam);
        delete rest.id;
        out.push(..._serializeYAMLObj(rest, '    '));
      }
    }
    return out.join('\n');
  }

  // ── Internal minimal YAML parser ─────────────────────────────────────────────

  function _parseYAMLScalar(s) {
    if (!s || s === 'null' || s === '~') return null;
    if (s === 'true'  || s === 'yes' || s === 'on')  return true;
    if (s === 'false' || s === 'no'  || s === 'off') return false;
    if (s === '[]') return [];
    if (s.startsWith('[')) {
      // Inline sequence
      const inner = s.slice(1, s.lastIndexOf(']')).trim();
      if (!inner) return [];
      return _splitCSV(inner).map(item => _parseYAMLScalar(item.trim()));
    }
    if ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    const n = Number(s);
    if (s !== '' && !isNaN(n)) return n;
    return s;
  }

  function _splitCSV(s) {
    const parts = [];
    let cur = '', inQ = false, qc = '';
    for (const ch of s) {
      if (!inQ && (ch === '"' || ch === "'")) { inQ = true;  qc = ch; cur += ch; }
      else if (inQ && ch === qc)              { inQ = false; cur += ch; }
      else if (!inQ && ch === ',')            { parts.push(cur); cur = ''; }
      else                                    { cur += ch; }
    }
    if (cur) parts.push(cur);
    return parts;
  }

  function _parseYAML(text) {
    // Build flat token list (skip empty lines and comments)
    const tokens = [];
    for (const raw of text.split('\n')) {
      const stripped = raw.replace(/\r$/, '');
      const trimmed  = stripped.trimStart();
      if (!trimmed || trimmed.startsWith('#')) continue;
      tokens.push({
        text:   trimmed,
        indent: stripped.length - trimmed.length
      });
    }

    let pos = 0;
    const peek    = () => pos < tokens.length ? tokens[pos] : null;
    const consume = () => pos < tokens.length ? tokens[pos++] : null;

    function parseValue(valText, lineIndent) {
      // Inline value on the same line
      if (valText !== '' && valText !== '|' && valText !== '>') {
        return _parseYAMLScalar(valText);
      }
      // Block value on next lines
      const nxt = peek();
      if (!nxt || nxt.indent <= lineIndent) return null;
      if (nxt.text.startsWith('- ') || nxt.text === '-') {
        return parseSequence(nxt.indent);
      }
      return parseMapping(nxt.indent);
    }

    function parseMapping(baseIndent) {
      const obj = {};
      while (peek() && peek().indent === baseIndent && !peek().text.startsWith('- ')) {
        const line = consume();
        const sep  = line.text.indexOf(': ');
        // "key:" with nothing after colon
        const keyOnly = sep === -1 && line.text.endsWith(':');
        if (sep === -1 && !keyOnly) continue; // skip malformed lines

        const key    = keyOnly ? line.text.slice(0, -1) : line.text.slice(0, sep);
        const valTxt = keyOnly ? ''                     : line.text.slice(sep + 2);
        obj[key] = parseValue(valTxt, line.indent);
      }
      return obj;
    }

    function parseSequence(baseIndent) {
      const arr = [];
      while (peek() && peek().indent === baseIndent && peek().text.startsWith('- ')) {
        const line = consume();
        const rest = line.text.slice(2); // strip leading "- "

        if (!rest) {
          // "- " with nothing: block item at next indent
          const nxt = peek();
          if (nxt && nxt.indent > baseIndent) {
            arr.push(nxt.text.startsWith('- ')
              ? parseSequence(nxt.indent)
              : parseMapping(nxt.indent));
          } else {
            arr.push(null);
          }
          continue;
        }

        const sep     = rest.indexOf(': ');
        const keyOnly = sep === -1 && rest.endsWith(':');

        if (sep !== -1 || keyOnly) {
          // First property of an object item inline with "- "
          const key    = keyOnly ? rest.slice(0, -1) : rest.slice(0, sep);
          const valTxt = keyOnly ? ''                : rest.slice(sep + 2);
          const item   = {};
          item[key]    = parseValue(valTxt, line.indent);

          // Read remaining properties of this object (indented deeper than "- ")
          while (peek() && peek().indent > baseIndent) {
            const prop = peek();
            if (prop.text.startsWith('- ')) break; // next sequence item

            consume();
            const pSep  = prop.text.indexOf(': ');
            const pOnly = pSep === -1 && prop.text.endsWith(':');
            if (pSep === -1 && !pOnly) continue;

            const pk = pOnly ? prop.text.slice(0, -1) : prop.text.slice(0, pSep);
            const pv = pOnly ? ''                     : prop.text.slice(pSep + 2);
            item[pk] = parseValue(pv, prop.indent);
          }
          arr.push(item);
        } else {
          arr.push(_parseYAMLScalar(rest));
        }
      }
      return arr;
    }

    return parseMapping(0);
  }

  /**
   * Import from a YAML string produced by exportYAML.
   * @param {string} yamlStr
   * @returns {{ individuals: Map, families: Map }}
   */
  function importYAML(yamlStr) {
    const trimmed = yamlStr.trim();
    // If it looks like JSON, delegate
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return importJSON(trimmed);
    }
    const data = _parseYAML(yamlStr);
    // null means the key was absent; [] is a valid empty array
    if (!Object.prototype.hasOwnProperty.call(data, 'individuals') || data.individuals === null) {
      throw new Error('Invalid YAML: missing individuals array');
    }
    if (!Array.isArray(data.individuals)) {
      throw new Error('Invalid YAML: missing individuals array');
    }
    const individuals = new Map();
    const families    = new Map();
    for (const i of data.individuals) {
      individuals.set(i.id, Object.assign(_makeIndi(i.id), i));
    }
    for (const f of (data.families || [])) {
      families.set(f.id, Object.assign(_makeFam(f.id), f));
    }
    return { individuals, families };
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return { parseGEDCOM, serializeGEDCOM, exportJSON, importJSON, exportYAML, importYAML };
});
