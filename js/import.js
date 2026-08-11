import { state } from './state.js';
import { _fullRebuildGraph, _loadDatasetFile, escHtml, escJs, fileAccessSupported } from './gedcom-io.js';
import { row } from './panels.js';
import { tick } from './render-2d.js';

export const _TI_MONTH_MAP = {
  jan:'JAN',feb:'FEB',mar:'MAR',apr:'APR',may:'MAY',jun:'JUN',
  jul:'JUL',aug:'AUG',sep:'SEP',oct:'OCT',nov:'NOV',dec:'DEC',
  januar:'JAN',februar:'FEB','märz':'MAR',april:'APR',mai:'MAY',
  juni:'JUN',juli:'JUL',august:'AUG',september:'SEP',
  oktober:'OCT',november:'NOV',dezember:'DEC',
};

export function _tiNormName(name) {
  let n = (name || '').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  n = n.replace(/\bfluri\b/g, 'flury');
  return n;
}

export function _tiParseName(name) {
  let n = _tiNormName(name);
  // Extract parenthesised maiden names e.g. "Berner (Fluri)" before stripping
  const parenSurnames = [];
  n = n.replace(/\(([^)]+)\)/g, (_, inner) => {
    inner.trim().split(/\s+/).forEach(t => parenSurnames.push(t));
    return '';
  });
  // Normalise maiden-name keyword markers to a separator
  n = n.replace(/\b(?:geb\.?|geborene?|n[eé]{1,2}e?|verh\.?|verheiratete?)\s+/gi, '__SEP__');
  const parts = n.split('__SEP__').map(s => s.trim()).filter(Boolean);
  const firstSegTokens = parts[0].split(/\s+/);
  const first = firstSegTokens[0] || '';
  const surnames = new Set(parenSurnames);
  for (const seg of parts) {
    const toks = seg.split(/\s+/);
    if (toks.length > 1) surnames.add(toks[toks.length - 1]);
    else if (toks.length === 1 && seg !== parts[0]) surnames.add(toks[0]);
  }
  if (firstSegTokens.length > 1) surnames.add(firstSegTokens[firstSegTokens.length - 1]);
  return { first, surnames: [...surnames] };
}

export function _tiNameScore(a, b) {
  // First name must match (exact or prefix)
  if (!a.first || !b.first) return 0;
  const fmatch = a.first === b.first ? 1
               : (a.first.startsWith(b.first) || b.first.startsWith(a.first)) ? 0.7
               : 0;
  if (fmatch === 0) return 0;
  // Best surname overlap
  let bestSurn = 0;
  for (const sa of a.surnames) {
    for (const sb of b.surnames) {
      if (sa === sb) { bestSurn = 1; break; }
      // Allow 1-char Levenshtein for typos (Müller/Mueller handled by NFD strip above)
      if (Math.abs(sa.length - sb.length) <= 2 && _tiLevenshtein(sa, sb) <= 1)
        bestSurn = Math.max(bestSurn, 0.85);
    }
    if (bestSurn === 1) break;
  }
  return fmatch * (0.4 + 0.6 * bestSurn);
}

export function _tiLevenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({length: m+1}, (_,i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1]
               : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

export function _tiNormDate(raw) {
  raw = (raw || '').trim();
  let m = raw.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
  if (m) {
    const mo = _TI_MONTH_MAP[m[2].toLowerCase()] || m[2].toUpperCase();
    return `${parseInt(m[1],10)} ${mo} ${m[3]}`;
  }
  m = raw.match(/^(\w+)\s+(\d{4})$/);
  if (m) {
    const mo = _TI_MONTH_MAP[m[1].toLowerCase()] || m[1].toUpperCase();
    return `${mo} ${m[2]}`;
  }
  if (/^\d{4}$/.test(raw)) return raw;
  return raw;
}

export function _tiInferSex(block, fullName) {
  if (/\bdaughter\s+of\b/i.test(block)) return 'F';
  if (/\bson\s+of\b/i.test(block)) return 'M';
  const hm = block.match(/\b(She|He)\b/i);
  if (hm) return hm[1].toLowerCase() === 'she' ? 'F' : 'M';
  const first = ((fullName || '').split(' ')[0] || '').toLowerCase();
  const fem = ['a','e','ina','ine','ette','itha','ith','burg','hild','traud','gard','linde'];
  const mal = ['us','old','olf','helm','bert','hard','fried','rich','mann','hans','anz'];
  for (const s of fem) { if (first.endsWith(s) && first.length > s.length) return 'F'; }
  for (const s of mal) { if (first.endsWith(s) && first.length > s.length) return 'M'; }
  return null;
}

export const _TI_DATE_PAT   = '(?:\\d{1,2}\\s+)?(?:Jan(?:uar)?|Feb(?:ruar)?|M[aä]r(?:z)?|Apr(?:il)?|Mai|May|Jun(?:i)?|Jul(?:i)?|Aug(?:ust)?|Sep(?:tember)?|O[ck]t(?:ober)?|Nov(?:ember)?|De[cz](?:ember)?)\\s+\\d{4}|\\d{4}';

export const _TI_DATE_CAP   = '(' + _TI_DATE_PAT + ')';

export const _TI_PLACE_PAT  = '([A-ZÄÖÜ][^,.\\n]+(?:,\\s*[A-ZÄÖÜ][^,.\\n]+)*)';

export const _TI_PFX        = '(?:von|van|de|der|den|di|du|le|la|zum|zur|am|im|auf|ten|ter)\\s+';

export const _TI_WORD       = '[A-ZÄÖÜ][a-zäöüß]+';

export const _TI_NAME_PAT   = '(?:' + _TI_PFX + ')?' + _TI_WORD + '(?:\\s+(?:' + _TI_PFX + ')?' + _TI_WORD + '){0,4}';

export const _TI_BORN_RE     = new RegExp('was born on\\s+' + _TI_DATE_CAP + '(?:\\s+in\\s+' + _TI_PLACE_PAT + ')?', 'i');

export const _TI_DIED_RE     = new RegExp('(?:died|death)\\s+(?:on\\s+)?' + _TI_DATE_CAP + '(?:\\s+in\\s+' + _TI_PLACE_PAT + ')?', 'i');

export const _TI_MARRIED_RE  = new RegExp('married\\s+(' + _TI_NAME_PAT + ')(?:\\s+on\\s+' + _TI_DATE_CAP + ')?(?:\\s+in\\s+' + _TI_PLACE_PAT + ')?', 'gi');

export const _TI_PARENTS_RE  = new RegExp(',\\s*(?:son|daughter)\\s+of\\s+(' + _TI_NAME_PAT + ')\\s+and\\s+(' + _TI_NAME_PAT + ')', 'i');

export const _TI_CHILDREN_RE = new RegExp('(' + _TI_NAME_PAT + ')\\s+and\\s+(' + _TI_NAME_PAT + ')\\s+had the following children?:', 'i');

export const _TI_CHILD_SOLE_RE = new RegExp('(' + _TI_NAME_PAT + ')\\s+had the following children?:', 'i');

export const _TI_CHILD_RE    = new RegExp('^([ivxlc]+)\\.\\s+(' + _TI_NAME_PAT + ')(?=\\s+was\\b|\\s+died\\b|\\s+married\\b|\\.\\s*$|\\s*$)', 'i');

export const _TI_INTRO_RE    = new RegExp('^(' + _TI_NAME_PAT + ')(?=\\s*,|\\s+was\\b|\\s+died\\b)');

export function _tiCleanText(raw) {
  return raw
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/-\n(?=[a-z])/g, '');
}

export function _tiParsePersonBlock(block) {
  block = (block || '').trim();
  if (!block) return null;
  const im = _TI_INTRO_RE.exec(block);
  if (!im) return null;

  const p = {
    fullName:    im[1].trim(),
    sex:         _tiInferSex(block, im[1].trim()),
    birthDate:   '', birthPlace: '',
    deathDate:   '', deathPlace: '',
    fatherName:  '', motherName: '',
    marriages:   [],
    sourceNote:  block.slice(0,300),
  };

  const pm = _TI_PARENTS_RE.exec(block);
  if (pm) { p.fatherName = pm[1].trim(); p.motherName = pm[2].trim(); }

  const bm = _TI_BORN_RE.exec(block);
  if (bm) { p.birthDate = _tiNormDate(bm[1]); p.birthPlace = bm[2] ? bm[2].trim() : ''; }

  const dm = _TI_DIED_RE.exec(block);
  if (dm) { p.deathDate = _tiNormDate(dm[1]); p.deathPlace = dm[2] ? dm[2].trim() : ''; }

  _TI_MARRIED_RE.lastIndex = 0;
  let mm;
  while ((mm = _TI_MARRIED_RE.exec(block)) !== null) {
    p.marriages.push({
      spouseName: mm[1].trim(),
      date:       mm[2] ? _tiNormDate(mm[2]) : '',
      place:      mm[3] ? mm[3].trim() : '',
      children:   [],
    });
  }
  return p;
}

export function _tiParseText(text) {
  const persons = [];
  const seenKey = new Map();  // normName|birthYear -> index in persons[]

  function mergeInto(existing, p) {
    if (!existing.birthDate  && p.birthDate)  existing.birthDate  = p.birthDate;
    if (!existing.birthPlace && p.birthPlace) existing.birthPlace = p.birthPlace;
    if (!existing.deathDate  && p.deathDate)  existing.deathDate  = p.deathDate;
    if (!existing.deathPlace && p.deathPlace) existing.deathPlace = p.deathPlace;
    if (!existing.fatherName && p.fatherName) existing.fatherName = p.fatherName;
    if (!existing.motherName && p.motherName) existing.motherName = p.motherName;
    for (const m of p.marriages) {
      const mn = _tiNormName(m.spouseName);
      if (!existing.marriages.find(em => _tiNormName(em.spouseName) === mn))
        existing.marriages.push(m);
    }
  }

  function addPerson(p) {
    if (!p || !p.fullName) return;
    const yr = (p.birthDate||'').match(/\b(\d{4})\b/)?.[1] || '';
    const key = _tiNormName(p.fullName) + '|' + yr;
    if (seenKey.has(key)) { mergeInto(persons[seenKey.get(key)], p); return; }
    seenKey.set(key, persons.length);
    persons.push(p);
  }

  // Step 1: strip Generation/Ancestors prefixes and Notes blocks line by line
  const rawLines = text.split('\n');
  const lines = [];
  let inNotes = false;
  for (const line of rawLines) {
    const t = line.trim();
    if (/^Notes for /i.test(t)) { inNotes = true; continue; }
    if (inNotes) {
      // Notes end at a structural marker
      if (!t || /^\d+\./.test(t) || /^[ivxlc]+\./i.test(t) ||
          /had the following child/i.test(t)) {
        inNotes = false;
        if (t) lines.push(t);
      }
      continue;
    }
    // Strip "Ancestors of X" preamble and inline "Generation N" markers
    const stripped = t
      .replace(/^Ancestors\s+of\b[^.]*\.?\s*/i, '')
      .replace(/\bGeneration\s+\d+\s*/g, '')
      .trim();
    if (stripped) lines.push(stripped);
  }

  // Step 2: group lines into main person blocks.
  // A new block starts when a line opens with "N. Name" (digit+period+space+uppercase),
  // but NOT "N. i." (digit+period+roman = back-reference child entry).
  // Also "N." alone on a line → next line starts the block content.
  const blocks = [];
  let current = [];
  let expectName = false;  // true after a bare "N." line

  function flush() { if (current.length) blocks.push(current.join('\n')); current = []; }

  for (const line of lines) {
    const mainM  = line.match(/^(\d+)\.\s+([A-ZÄÖÜ])/);  // "8. Viktor"
    const bareN  = line.match(/^(\d+)\.\s*$/);             // "4." alone
    if (mainM) {
      flush();
      current = [line.slice(line.indexOf(mainM[2]))];  // drop the leading "N. "
      expectName = false;
    } else if (bareN) {
      flush();
      expectName = true;
    } else if (expectName) {
      current = [line];
      expectName = false;
    } else {
      current.push(line);
    }
  }
  flush();

  // Step 3: parse each block
  for (const block of blocks) {
    const b = block.trim();
    if (!b || b.length < 4) continue;

    // Try two-parent family block first, then single-parent
    const cb   = _TI_CHILDREN_RE.exec(b);
    const cbS  = !cb ? _TI_CHILD_SOLE_RE.exec(b) : null;
    const anyC = cb || cbS;

    if (anyC) {
      const parent2   = cb ? cb[2].trim() : '';
      const parentSrc = b.slice(0, anyC.index).trim();
      const afterSrc  = b.slice(anyC.index + anyC[0].length);

      // Parse children; handle "ii.\nName" splits and "N. ii. Name" back-refs
      const childRefs  = [];
      const childLines = afterSrc.split('\n').map(l => l.trim()).filter(Boolean);
      let pendingRoman = null;
      for (const cl of childLines) {
        // Roman numeral alone on a line ("ii." or "iii.")
        if (/^[ivxlc]+\.\s*$/i.test(cl)) { pendingRoman = cl; continue; }
        // Strip back-reference number prefix: "4. ii. " → "ii. "
        const stripped = cl.replace(/^\d+\.\s+(?=[ivxlc]+\.)/i, '');
        const combined = pendingRoman ? pendingRoman + ' ' + stripped : stripped;
        pendingRoman = null;
        const cm = _TI_CHILD_RE.exec(combined);
        if (!cm) continue;
        const childContent = combined.slice(combined.indexOf(cm[2]));
        const child = _tiParsePersonBlock(childContent) || {
          fullName: cm[2].trim(), sex: null,
          birthDate:'', birthPlace:'', deathDate:'', deathPlace:'',
          fatherName:'', motherName:'', marriages:[], sourceNote:'',
        };
        childRefs.push(child);
        addPerson(child);
      }

      const p = parentSrc ? _tiParsePersonBlock(parentSrc) : null;
      if (p) {
        if (parent2) {
          const n2      = _tiNormName(parent2);
          const matched = p.marriages.find(m => _tiNormName(m.spouseName) === n2);
          if (matched) matched.children = childRefs;
          else if (p.marriages.length) p.marriages[0].children = childRefs;
          else p.marriages.push({ spouseName: parent2, date:'', place:'', children: childRefs });
        } else if (p.marriages.length) {
          p.marriages[0].children = childRefs;
        }
        addPerson(p);
      }
    } else {
      addPerson(_tiParsePersonBlock(b));
    }
  }

  return persons;
}

export function _tiGenerateActions(persons) {
  const actions = [];

  // Index existing GEDCOM data for fast exact lookup and fuzzy candidate search
  const keyToId  = new Map();   // "normname|year" → id
  const nameToId = new Map();   // normname       → id  (last wins, for name-only fallback)
  const allIndis = [];          // [{id, parsed, yr}] for fuzzy scan
  for (const [id, indi] of state.individuals) {
    const nn = _tiNormName(indi.name || '');
    if (!nn) continue;
    const yr = (indi.birth.date || '').match(/\b(\d{4})\b/)?.[1] || '';
    keyToId.set(`${nn}|${yr}`, id);
    nameToId.set(nn, id);
    allIndis.push({ id, parsed: _tiParseName(indi.name || ''), yr });
  }

  function _famKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  // pairKey → family id, or null for a couple queued earlier in this same batch.
  // The id is what lets a second file's children be hung off the family the tree
  // already has instead of being dropped on the floor as unattached people.
  const famPairs = new Map();
  for (const [,fam] of state.families) {
    const h = state.individuals.get(fam.husb); const w = state.individuals.get(fam.wife);
    if (h || w) famPairs.set(_famKey(_tiNormName((h||w)?.name||''), _tiNormName((w||h)?.name||'')), fam.id);
  }

  const pendingNames = new Map();  // normname → '__new__'

  function lookup(person) {
    const nn  = _tiNormName(person.fullName);
    const yr  = (person.birthDate||'').match(/\b(\d{4})\b/)?.[1] || '';

    // 1. Exact key match (name + year)
    if (yr && keyToId.has(`${nn}|${yr}`)) return keyToId.get(`${nn}|${yr}`);

    // 2. Exact name, ignore year when one side is unknown
    if (keyToId.has(`${nn}|`)) {
      if (!yr) return keyToId.get(`${nn}|`);          // both year-unknown
    }
    if (nameToId.has(nn)) {
      const eid = nameToId.get(nn);
      const eyr = (state.individuals.get(eid)?.birth?.date||'').match(/\b(\d{4})\b/)?.[1] || '';
      if (!eyr || !yr) return eid;                     // one side year-unknown
    }

    // 3. Fuzzy: score all existing persons, pick best above threshold
    const parsed = _tiParseName(person.fullName);
    let bestId = null, bestScore = 0;
    for (const cand of allIndis) {
      let score = _tiNameScore(parsed, cand.parsed);
      if (score < 0.6) continue;
      // Birth-year bonus/penalty
      if (yr && cand.yr) {
        const diff = Math.abs(parseInt(yr) - parseInt(cand.yr));
        if (diff === 0)       score += 0.3;
        else if (diff <= 2)   score += 0.1;  // data-entry slop
        else                  score -= 0.4;  // different person
      }
      if (score > bestScore) { bestScore = score; bestId = cand.id; }
    }
    if (bestScore >= 0.75) return bestId;

    // 4. Already queued in this import batch
    if (pendingNames.has(nn)) return pendingNames.get(nn);
    return null;
  }

  for (let pi = 0; pi < persons.length; pi++) {
    const person = persons[pi];
    const existing = lookup(person);
    if (existing === null) {
      actions.push({
        id:     Math.random().toString(36).slice(2),
        kind:   'person',
        status: 'pending',
        _sourceIdx: pi * 2,
        fields: {
          'Name':         person.fullName,
          'Sex':          person.sex || '',
          'Birth Date':   person.birthDate,
          'Birth Place':  person.birthPlace,
          'Death Date':   person.deathDate,
          'Death Place':  person.deathPlace,
          'Father':       person.fatherName,
          'Mother':       person.motherName,
          'Notes':        person.notes || '',
        },
        source:  person.sourceNote,
        _person: person,
      });
      const nn = _tiNormName(person.fullName);
      pendingNames.set(nn, '__new__');
    } else {
      // Person already exists — generate an update action for any missing fields
      const indi = state.individuals.get(existing);
      if (indi) {
        const missing = {};
        if (!indi.birth?.date  && person.birthDate)  missing['Birth Date']  = person.birthDate;
        if (!indi.birth?.plac  && person.birthPlace) missing['Birth Place'] = person.birthPlace;
        if (!indi.death?.date  && person.deathDate)  missing['Death Date']  = person.deathDate;
        if (!indi.death?.plac  && person.deathPlace) missing['Death Place'] = person.deathPlace;
        if ((!indi.sex || indi.sex === 'U') && person.sex) missing['Sex'] = person.sex;
        if (person.notes && !(indi.note||'').includes(person.notes)) missing['Notes'] = person.notes;
        if (Object.keys(missing).length) {
          actions.push({
            id:       Math.random().toString(36).slice(2),
            kind:     'update',
            status:   'pending',
            _sourceIdx: pi * 2,
            existingId: existing,
            fields:   Object.assign({ 'Name': person.fullName }, missing),
            source:   person.sourceNote,
            _person:  person,
          });
        } else {
          // Nothing to add. Kept as a row anyway so the diff accounts for every
          // person in the file — "not listed" and "identical" are different
          // answers, and only one of them means the reader can stop looking.
          actions.push({
            id:       Math.random().toString(36).slice(2),
            kind:     'same',
            status:   'skipped',
            _sourceIdx: pi * 2,
            existingId: existing,
            fields:   { 'Name': person.fullName },
            source:   person.sourceNote,
            _person:  person,
          });
        }
      }
    }

    for (const marriage of person.marriages) {
      let husbName, wifeName;
      if (person.sex === 'F') { husbName = marriage.spouseName; wifeName = person.fullName; }
      else                    { husbName = person.fullName;     wifeName = marriage.spouseName; }

      const hn = _tiNormName(husbName);
      const wn = _tiNormName(wifeName);
      const pairKey = _famKey(hn, wn);
      if (famPairs.has(pairKey)) {
        const existFamId = famPairs.get(pairKey);
        if (!existFamId) continue;        // queued by an earlier card in this batch
        const fam = state.families.get(existFamId);
        if (!fam) continue;
        // The couple is in the tree already, but the file being merged may know
        // children the tree does not. Those are the ones that used to land as
        // parentless strangers.
        const known = new Set((fam.chil || []).map(cid => _tiNormName(state.individuals.get(cid)?.name || '')));
        const newKids = marriage.children.filter(c => !known.has(_tiNormName(c.fullName)));
        if (!newKids.length) continue;
        const hIndi = state.individuals.get(fam.husb);
        const wIndi = state.individuals.get(fam.wife);
        actions.push({
          id:       Math.random().toString(36).slice(2),
          kind:     'marriage',
          status:   'pending',
          _sourceIdx: pi * 2 + 1,
          existingFamId: existFamId,
          fieldLinks: Object.assign({},
            fam.husb ? { 'Husband': { type:'existing', id: fam.husb } } : null,
            fam.wife ? { 'Wife':    { type:'existing', id: fam.wife } } : null),
          fields: {
            'Husband':        hIndi?.name || husbName,
            'Wife':           wIndi?.name || wifeName,
            'Marriage Date':  marriage.date,
            'Marriage Place': marriage.place,
            'Children':       newKids.map(c => c.fullName).join('; '),
          },
          source:    person.sourceNote,
          _person:   person,
          _marriage: marriage,
        });
        continue;
      }

      actions.push({
        id:       Math.random().toString(36).slice(2),
        kind:     'marriage',
        status:   'pending',
        _sourceIdx: pi * 2 + 1,
        fields: {
          'Husband':        husbName,
          'Wife':           wifeName,
          'Marriage Date':  marriage.date,
          'Marriage Place': marriage.place,
          'Children':       marriage.children.map(c => c.fullName).join('; '),
        },
        source:    person.sourceNote,
        _person:   person,
        _marriage: marriage,
      });
      famPairs.set(pairKey, null);
    }
  }

  return actions;
}

export function _tiApplyActions(actions) {
  let maxIndi = 0, maxFam = 0;
  for (const [id] of state.individuals) { const m = id.match(/\d+/); if (m) maxIndi = Math.max(maxIndi,+m[0]); }
  for (const [id] of state.families)    { const m = id.match(/\d+/); if (m) maxFam  = Math.max(maxFam, +m[0]); }

  const nameToId = new Map();
  for (const [id, indi] of state.individuals) nameToId.set(_tiNormName(indi.name||''), id);

  const famsOf = new Map();   // indiId -> [famId]
  const famcOf = new Map();   // childId -> famId
  const report = [];
  const actionXref = new Map();  // action.id -> indiId

  // Pass 0: apply updates to existing individuals
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'update') continue;
    const indi = state.individuals.get(action.existingId);
    if (!indi) continue;
    // Only the fields the reader left switched on. Where the card offered a
    // choice between what the import says and what the tree already holds,
    // this is that choice; an older card without the map keeps the previous
    // behaviour of filling anything non-empty.
    const use = f => action.fieldApply ? !!action.fieldApply[f] : !!action.fields[f];
    if (use('Birth Date'))  indi.birth.date = action.fields['Birth Date'];
    if (use('Birth Place')) indi.birth.plac = action.fields['Birth Place'];
    if (use('Death Date')) { indi.death.date = action.fields['Death Date']; indi.deceased = true; }
    if (use('Death Place')) indi.death.plac = action.fields['Death Place'];
    if (use('Sex')) indi.sex = action.fields['Sex'];
    if (use('Notes')) {
      indi.note = indi.note ? indi.note + '; ' + action.fields['Notes'] : action.fields['Notes'];
    }
    report.push({ type:'update', msg:`${indi.name} — updated` });
  }

  // Pass 1: allocate INDI xrefs for approved persons
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'person') continue;
    const name = (action.fields['Name'] || '').trim();
    if (!name) continue;
    const nn = _tiNormName(name);
    if (nameToId.has(nn)) {
      report.push({ type:'skip', msg:`${name} — already exists` });
      actionXref.set(action.id, nameToId.get(nn));
    } else {
      const xref = `@I${++maxIndi}@`;
      nameToId.set(nn, xref);
      actionXref.set(action.id, xref);
      report.push({ type:'add', msg:`${name} → ${xref}` });
    }
  }

  // Pass 2: create FAM records for approved marriages
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'marriage') continue;
    const links = action.fieldLinks || {};

    // Resolve a person field: explicit link (exact id) beats name-based lookup
    const resolveField = (fieldKey, name) => {
      const lnk = links[fieldKey];
      if (lnk?.type === 'existing') return lnk.id;
      if (lnk?.type === 'pending')  return actionXref.get(lnk.id) || nameToId.get(_tiNormName(name)) || null;
      return nameToId.get(_tiNormName(name)) || null;
    };

    const husbName = (action.fields['Husband']||'').trim();
    const wifeName = (action.fields['Wife']||'').trim();

    // Merging into a family the tree already holds: only the children are new.
    if (action.existingFamId) {
      const fam = state.families.get(action.existingFamId);
      if (!fam) continue;
      const kids = action._childrenArr ||
        (action.fields['Children']||'').split(';').map(s=>s.trim()).filter(Boolean);
      let added = 0;
      for (let ci = 0; ci < kids.length; ci++) {
        const cid = resolveField(`Children:${ci}`, kids[ci]);
        if (!cid || fam.chil.includes(cid)) continue;
        fam.chil.push(cid);
        if (!famcOf.has(cid)) famcOf.set(cid, fam.id);
        added++;
      }
      if (!fam.marriages.length) fam.marriages.push({ date:'', plac:'', types:[] });
      const m0 = fam.marriages[0];
      if (!m0.date && action.fields['Marriage Date'])  m0.date = action.fields['Marriage Date'];
      if (!m0.plac && action.fields['Marriage Place']) m0.plac = action.fields['Marriage Place'];
      if (added) report.push({ type:'fam', msg:`${husbName} + ${wifeName} → ${fam.id} (+${added})` });
      continue;
    }

    const husbId = resolveField('Husband', husbName);
    const wifeId = resolveField('Wife', wifeName);
    const famXref = `@F${++maxFam}@`;

    const childIds = [];
    const childArr = action._childrenArr ||
      (action.fields['Children']||'').split(';').map(s=>s.trim()).filter(Boolean);
    for (let ci = 0; ci < childArr.length; ci++) {
      const cname = childArr[ci];
      const cid = resolveField(`Children:${ci}`, cname);
      if (cid) { childIds.push(cid); if (!famcOf.has(cid)) famcOf.set(cid, famXref); }
    }

    if (husbId) { if (!famsOf.has(husbId)) famsOf.set(husbId,[]); famsOf.get(husbId).push(famXref); }
    if (wifeId) { if (!famsOf.has(wifeId)) famsOf.set(wifeId,[]); famsOf.get(wifeId).push(famXref); }

    state.families.set(famXref, {
      id: famXref, husb: husbId, wife: wifeId, chil: childIds,
      marriages: [{ date: action.fields['Marriage Date']||'', plac: action.fields['Marriage Place']||'', types: [] }], div: false, divDate: '',
      div: false,
    });
    report.push({ type:'fam', msg:`${husbName} + ${wifeName} → ${famXref}` });
  }

  // Pass 3: create INDI records
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'person') continue;
    const xref = actionXref.get(action.id);
    if (!xref || state.individuals.has(xref)) continue;

    const name  = (action.fields['Name']||'').trim();
    const parts = name.split(/\s+/);
    const givn  = parts.length >= 2 ? parts.slice(0,-1).join(' ') : name;
    const surn  = parts.length >= 2 ? parts[parts.length-1] : '';
    const bdate = action.fields['Birth Date'] || '';
    const yrm   = bdate.match(/\b(\d{4})\b/);

    let displayName = givn && surn ? `${givn} ${surn}` : name;
    if (displayName.length > 24) {
      displayName = givn ? givn + (surn ? ' ' + surn[0] + '.' : '') : displayName.slice(0,22) + '…';
    }

    const noteParts = [];
    if (action.fields['Father']) noteParts.push('Father: ' + action.fields['Father']);
    if (action.fields['Mother']) noteParts.push('Mother: ' + action.fields['Mother']);
    if (action.fields['Notes'])  noteParts.push(action.fields['Notes']);

    state.individuals.set(xref, {
      id: xref, name, givn, surn,
      sex: (action.fields['Sex']||'U').trim() || 'U',
      birth: { date: bdate, plac: action.fields['Birth Place']||'' },
      death: { date: action.fields['Death Date']||'', plac: action.fields['Death Place']||'', caus:'' },
      deceased: !!(action.fields['Death Date']),
      birthYear: yrm ? +yrm[1] : null,
      famc: famcOf.has(xref) ? [famcOf.get(xref)] : [],
      fams: famsOf.get(xref) || [],
      occu: '',
      note: noteParts.join('; '),
      displayName,
    });
  }

  // Pass 4: patch FAMS/FAMC on pre-existing individuals
  for (const [indiId, famIds] of famsOf) {
    const indi = state.individuals.get(indiId);
    if (!indi) continue;
    for (const famId of famIds) { if (!indi.fams.includes(famId)) indi.fams.push(famId); }
  }
  for (const [childId, famId] of famcOf) {
    const indi = state.individuals.get(childId);
    if (!indi) continue;
    if (!indi.famc.includes(famId)) indi.famc.push(famId);
  }

  return report;
}

/**
 * Which of the proposed new people would end up attached to the tree that is
 * already loaded, and which would float off as their own island.
 *
 * Union-find over everyone the merge would produce: existing individuals joined
 * by existing families, plus the person cards joined by the marriage cards.
 * A new person is "connected" when their component contains at least one person
 * who was already in the tree.
 *
 * `isLive` decides which cards count. Two answers are wanted and they are not
 * the same: the review shows what would happen if the batch were approved
 * (everything not skipped), while the apply guard has to judge what will
 * actually be written (approved only) — a person whose only tie sits in a card
 * still marked pending lands detached no matter how the preview looked.
 *
 * Returns Map actionId → true|false, for person cards only.
 */
export function _tiConnectivity(actions, isLive) {
  const parent = new Map();
  const add  = x => { if (!parent.has(x)) parent.set(x, x); return x; };
  const find = x => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const join = list => {
    const m = list.filter(Boolean).map(add);
    for (let i = 1; i < m.length; i++) {
      const a = find(m[0]), b = find(m[i]);
      if (a !== b) parent.set(a, b);
    }
  };

  for (const [id] of state.individuals) add(id);
  for (const [,fam] of state.families) {
    join([fam.husb, fam.wife, ...(fam.chil || [])].filter(m => state.individuals.has(m)));
  }

  const live = isLive || (a => a.status !== 'skipped');
  const nameToNew = new Map();
  for (const a of actions) {
    if (a.kind !== 'person' || !live(a)) continue;
    add('a:' + a.id);
    const nn = _tiNormName(a.fields['Name'] || '');
    if (nn && !nameToNew.has(nn)) nameToNew.set(nn, 'a:' + a.id);
  }
  const nameToOld = new Map();
  for (const [id, indi] of state.individuals) nameToOld.set(_tiNormName(indi.name || ''), id);

  // Mirrors how _tiApplyActions resolves a person field, so the picture the
  // reader is shown is the one the apply pass will actually build.
  const resolve = (a, fieldKey, name) => {
    const lnk = a.fieldLinks?.[fieldKey];
    if (lnk?.type === 'existing') return state.individuals.has(lnk.id) ? lnk.id : null;
    if (lnk?.type === 'pending')  return parent.has('a:' + lnk.id) ? 'a:' + lnk.id : null;
    const nn = _tiNormName(name || '');
    if (!nn) return null;
    return nameToOld.get(nn) || nameToNew.get(nn) || null;
  };

  for (const a of actions) {
    if (a.kind !== 'marriage' || !live(a)) continue;
    const members = [resolve(a, 'Husband', a.fields['Husband']), resolve(a, 'Wife', a.fields['Wife'])];
    if (a.existingFamId) {
      const f = state.families.get(a.existingFamId);
      if (f) members.push(f.husb, f.wife, ...(f.chil || []));
    }
    const kids = a._childrenArr ||
      (a.fields['Children'] || '').split(';').map(s => s.trim()).filter(Boolean);
    kids.forEach((c, i) => members.push(resolve(a, `Children:${i}`, c)));
    join(members);
  }

  const rooted = new Set();
  for (const [id] of state.individuals) rooted.add(find(id));

  const res = new Map();
  for (const a of actions) {
    if (a.kind !== 'person') continue;
    const k = 'a:' + a.id;
    res.set(a.id, parent.has(k) && rooted.has(find(k)));
  }
  return res;
}

export function _tiParseStructuredJson(obj) {
  if (!obj || !Array.isArray(obj.individuals)) return null;

  // Build a map from JSON person id → full name (for children lookup)
  const idToName = new Map();
  for (const raw of obj.individuals) {
    const fullName = [raw.given_name, raw.surname].filter(Boolean).join(' ').trim();
    if (raw.id && fullName) idToName.set(raw.id, fullName);
  }

  // Build a map from sorted(husbId,wifeId) → children names, from families[]
  const famChildrenByParents = new Map();
  if (Array.isArray(obj.families)) {
    for (const fam of obj.families) {
      const key = [fam.husband_id, fam.wife_id].sort().join('|');
      const childNames = (fam.children || []).map(cid => idToName.get(cid)).filter(Boolean);
      famChildrenByParents.set(key, childNames);
    }
  }

  const persons = [];
  for (const raw of obj.individuals) {
    const fullName = [raw.given_name, raw.surname].filter(Boolean).join(' ').trim();
    if (!fullName) continue;

    const p = {
      fullName,
      sex:         raw.sex || null,
      birthDate:   _tiNormDate(raw.birth_date || ''),
      birthPlace:  (raw.birth_place || '').trim(),
      deathDate:   _tiNormDate(raw.death_date || ''),
      deathPlace:  (raw.death_place || '').trim(),
      fatherName:  '',
      motherName:  '',
      marriages:   [],
      notes:       (raw.notes || '').trim(),
      sourceNote:  `[structured JSON] id=${raw.id}` + (raw.notes ? ` | ${raw.notes}` : ''),
    };

    for (const m of (raw.marriages || [])) {
      const spouseName = [m.spouse_given, m.spouse_surname].filter(Boolean).join(' ').trim();
      if (!spouseName) continue;
      // Look up children for this couple from the families array
      const coupleKey = [raw.id, ''].sort().join('|');  // placeholder
      p.marriages.push({
        spouseName,
        date:     _tiNormDate(m.marriage_date || ''),
        place:    (m.marriage_place || '').trim(),
        children: [],
      });
    }

    persons.push(p);
  }

  // Second pass: wire children into marriages using families[]
  if (Array.isArray(obj.families)) {
    const personByName = new Map();
    for (const p of persons) personByName.set(_tiNormName(p.fullName), p);

    for (const fam of obj.families) {
      const husbName = idToName.get(fam.husband_id) || '';
      const wifeName = idToName.get(fam.wife_id)   || '';
      const childNames = (fam.children || []).map(cid => idToName.get(cid)).filter(Boolean);
      if (!childNames.length) continue;

      // Find the husband/wife person objects and set children on matching marriage
      for (const parentName of [husbName, wifeName]) {
        if (!parentName) continue;
        const parentP = personByName.get(_tiNormName(parentName));
        if (!parentP) continue;
        const spouseName = parentName === husbName ? wifeName : husbName;
        const sn = _tiNormName(spouseName);
        let marriage = parentP.marriages.find(m => _tiNormName(m.spouseName) === sn);
        if (!marriage && parentP.marriages.length === 1) marriage = parentP.marriages[0];
        if (!marriage && spouseName) {
          marriage = { spouseName, date: _tiNormDate(fam.marriage_date||''), place: (fam.marriage_place||'').trim(), children: [] };
          parentP.marriages.push(marriage);
        }
        if (marriage) marriage.children = childNames.map(n => ({ fullName: n }));
      }
    }
  }

  return persons;
}

export function _tiParseGedcomForMerge(raw) {
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  const indiMap = new Map(); // id -> {name,sex,birth,death,fams,famc,note}
  const famMap  = new Map(); // id -> {husb,wife,chil,marr}

  const lines = raw.split(/\r?\n/);
  let cur = null, curType = null, subCtx = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s*(.*)/);
    if (!m) continue;
    const level = +m[1], tag = m[2], val = m[3].trim();

    if (level === 0) {
      subCtx = null;
      if (tag.startsWith('@') && val === 'INDI') {
        cur = { id: tag, name:'', sex:'', birth:{date:'',plac:''}, death:{date:'',plac:''}, fams:[], famc:[], note:'' };
        indiMap.set(tag, cur); curType = 'INDI';
      } else if (tag.startsWith('@') && val === 'FAM') {
        cur = { id: tag, husb:null, wife:null, chil:[], marriages:[{date:'',plac:'',types:[]}] };
        famMap.set(tag, cur); curType = 'FAM';
      } else { cur = null; curType = null; }
      continue;
    }

    if (!cur) continue;

    if (curType === 'INDI') {
      if (level === 1) {
        subCtx = null;
        if      (tag === 'NAME' && !cur.name) { const c = val.replace(/\//g,'').replace(/\s+/g,' ').trim(); if (c) cur.name = c; }
        else if (tag === 'SEX')  cur.sex  = val;
        else if (tag === 'BIRT') subCtx = 'BIRT';
        else if (tag === 'DEAT') subCtx = 'DEAT';
        else if (tag === 'FAMS' && val) cur.fams.push(val);
        else if (tag === 'FAMC' && val) cur.famc.push(val);
        else if (tag === 'NOTE') cur.note = val;
      } else if (level === 2) {
        if      (subCtx === 'BIRT' && tag === 'DATE') cur.birth.date = val;
        else if (subCtx === 'BIRT' && tag === 'PLAC') cur.birth.plac = val;
        else if (subCtx === 'DEAT' && tag === 'DATE') cur.death.date = val;
        else if (subCtx === 'DEAT' && tag === 'PLAC') cur.death.plac = val;
        else if (tag === 'CONT') cur.note += '\n' + val;
      } else if (level === 3 && tag === 'CONT') { cur.note += '\n' + val; }

    } else if (curType === 'FAM') {
      if (level === 1) {
        subCtx = null;
        if      (tag === 'HUSB') cur.husb = val;
        else if (tag === 'WIFE') cur.wife = val;
        else if (tag === 'CHIL' && val) cur.chil.push(val);
        else if (tag === 'MARR') { if (!cur.marriages.length) cur.marriages.push({date:'',plac:'',types:[]}); subCtx = 'MARR'; }
      } else if (level === 2 && subCtx === 'MARR') {
        const m = cur.marriages[cur.marriages.length - 1];
        if (m) {
          if (tag === 'DATE') m.date = val;
          else if (tag === 'PLAC') m.plac = val;
        }
      }
    }
  }

  // Convert to persons[] format understood by _tiGenerateActions
  const persons = [];
  for (const [id, indi] of indiMap) {
    if (!indi.name) continue;

    // Normalise Fluri→Flury for persons born before 1940
    let displayName = indi.name;
    if (/Fluri/.test(displayName)) {
      const birthYr = parseInt((indi.birth.date || '').match(/\b(\d{4})\b/)?.[1] || '9999', 10);
      if (birthYr < 1940) displayName = displayName.replace(/Fluri/g, 'Flury');
    }

    const p = {
      fullName:   displayName,
      sex:        indi.sex || null,
      birthDate:  indi.birth.date,
      birthPlace: indi.birth.plac,
      deathDate:  indi.death.date,
      deathPlace: indi.death.plac,
      fatherName: '', motherName: '',
      marriages:  [],
      notes:      indi.note.trim(),
      sourceNote: `[GEDCOM merge] ${id}`,
    };

    // Derive father/mother from FAMC
    for (const famcId of indi.famc) {
      const fam = famMap.get(famcId);
      if (!fam) continue;
      const f = fam.husb ? indiMap.get(fam.husb) : null;
      const mo = fam.wife ? indiMap.get(fam.wife) : null;
      if (f?.name  && !p.fatherName) p.fatherName = f.name;
      if (mo?.name && !p.motherName) p.motherName = mo.name;
    }

    // Build marriages from FAMS
    for (const famsId of indi.fams) {
      const fam = famMap.get(famsId);
      if (!fam) continue;
      const spouseId = fam.husb === id ? fam.wife : fam.husb;
      const spouse   = spouseId ? indiMap.get(spouseId) : null;
      if (!spouse?.name) continue;
      p.marriages.push({
        spouseName: spouse.name,
        date:       fam.marriages?.[0]?.date || '',
        place:      fam.marriages?.[0]?.plac || '',
        children:   fam.chil.map(cid => indiMap.get(cid))
                            .filter(c => c?.name)
                            .map(c => ({ fullName: c.name })),
      });
    }

    persons.push(p);
  }

  return persons;
}

export const _IMAGE_MIME = /^image\/(jpeg|png|gif|webp)$/;

export function openImport() {
  document.getElementById('import-modal').style.display = 'flex';
  _resetImportUI();
  document.addEventListener('paste', _importPasteHandler);
}

export function closeTextImport() {
  document.removeEventListener('paste', _importPasteHandler);
  clearTimeout(state._importConnTimer);
  document.getElementById('import-modal').style.display = 'none';
  state._importActions = [];
  state._importConn = new Map();
  state._importConnStrict = new Map();
  state._importExpanded = new Set();
  state._importFilter = 'all';
  state._importLoadedFile = null;
  state._importFileHandle = null;
  state._importImageData = null;
}

export function _resetImportUI() {
  document.getElementById('import-step-input').style.display = '';
  document.getElementById('import-step-review').style.display = 'none';
  const overlay = document.getElementById('import-progress-overlay');
  if (overlay) overlay.style.display = 'none';
  const label = document.getElementById('import-progress-label');
  if (label) label.textContent = '';
  document.getElementById('import-text-area').value = '';
  const fi = document.getElementById('import-file-input');
  if (fi) { fi.value = ''; }
  document.getElementById('import-drop-label').style.display = '';
  document.getElementById('import-drop-filename').style.display = 'none';
  document.getElementById('import-image-preview').style.display = 'none';
  document.getElementById('import-image-options').style.display = 'none';
  document.getElementById('import-error-msg').style.display = 'none';
  document.getElementById('import-replace-btn').style.display = 'none';
  document.getElementById('import-ocr-status').textContent = '';
  state._importActions = [];
  state._importConn = new Map();
  state._importConnStrict = new Map();
  state._importExpanded = new Set();
  state._importFilter = 'all';
  state._importJsonPersons = null;
  state._importLoadedFile = null;
  state._importFileHandle = null;
  state._importImageData = null;
}

export function _imShowError(msg) {
  const el = document.getElementById('import-error-msg');
  el.textContent = msg; el.style.display = '';
}

export function _imDragOver(e) { e.preventDefault(); document.getElementById('import-drop-zone').classList.add('drag-over'); }

export function _imDragLeave(e) { document.getElementById('import-drop-zone').classList.remove('drag-over'); }

// Opening the file chooser. Through showOpenFilePicker where it exists, because
// that is the only way of choosing a file that also yields a handle to it — the
// hidden <input type="file"> hands back a detached copy, which is enough to read
// but leaves nothing to reopen or save back to. Falls back to the input
// elsewhere, where reading is all that is on offer anyway.
export async function _imPickFile() {
  if (!fileAccessSupported()) { document.getElementById('import-file-input').click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'GEDCOM / JSON / YAML / text / image',
        accept: { '*/*': ['.ged', '.json', '.yaml', '.yml', '.txt', '.text', '.png', '.jpg', '.jpeg', '.gif', '.webp'] },
      }],
    });
    if (handle) _imLoadFile(await handle.getFile(), handle);
  } catch (err) {
    if (err.name !== 'AbortError') document.getElementById('import-file-input').click();
  }
}

export async function _imDrop(e) {
  e.preventDefault();
  document.getElementById('import-drop-zone').classList.remove('drag-over');
  // A dropped item can yield a handle too, so a file dragged in is as reopenable
  // as one picked from the dialog. Read the item before any await: the
  // DataTransfer is emptied as soon as the event handler yields.
  const item = e.dataTransfer.items?.[0];
  const file = e.dataTransfer.files?.[0];
  let handle = null;
  if (item?.getAsFileSystemHandle) {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h?.kind === 'file') handle = h;
    } catch { /* not a real file, or the browser said no — the File still works */ }
  }
  if (handle) _imLoadFile(await handle.getFile(), handle);
  else if (file) _imLoadFile(file);
}

export function _importPasteHandler(e) {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) _imLoadFile(file);
}

export function handleImportFileSelect(e) {
  const file = e.target.files[0];
  if (file) _imLoadFile(file);
}

export function _imLoadFile(file, handle = null) {
  state._importJsonPersons = null;
  state._importLoadedFile = file;
  // Carried alongside the file so the wizard's "replace" button, which loads it
  // later, can pass it on too — the handle is what makes the file reopenable and
  // saveable, and it must not be dropped just because the load went via a
  // review step.
  state._importFileHandle = handle;
  state._importImageData = null;
  document.getElementById('import-error-msg').style.display = 'none';
  document.getElementById('import-drop-label').style.display = 'none';
  const fn = document.getElementById('import-drop-filename');
  fn.textContent = '📄 ' + file.name;
  fn.style.display = '';
  document.getElementById('import-image-preview').style.display = 'none';
  document.getElementById('import-image-options').style.display = 'none';
  document.getElementById('import-replace-btn').style.display = 'none';
  document.getElementById('import-text-area').value = '';

  const name = file.name.toLowerCase();
  const isGed   = /\.ged$/.test(name);
  const isJson  = /\.json$/.test(name);
  const isYaml  = /\.ya?ml$/.test(name);
  const isImage = _IMAGE_MIME.test(file.type) || /\.(png|jpe?g|gif|webp)$/.test(name);

  // First import on empty dataset: load directly, skip the review wizard.
  if ((isGed || isJson || isYaml) && state.individuals.size === 0) {
    closeTextImport();
    _loadDatasetFile(file, handle);
    return;
  }

  if (isImage) {
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      state._importImageData = { base64: dataUrl.split(',')[1], mediaType: file.type || 'image/png' };
      const prev = document.getElementById('import-image-preview');
      prev.src = dataUrl;
      prev.style.display = 'block';
      document.getElementById('import-image-options').style.display = 'flex';
    };
    reader.readAsDataURL(file);
    return;
  }

  if (isGed || isJson || isYaml) {
    document.getElementById('import-replace-btn').style.display = '';
  }

  const reader = new FileReader();
  if (isGed) {
    reader.onload = ev => {
      const persons = _tiParseGedcomForMerge(ev.target.result || '');
      if (persons?.length) {
        state._importJsonPersons = persons;
        document.getElementById('import-text-area').value =
          t('import.gedcomLoaded', { n: persons.length, plural: persons.length !== 1 ? 'en' : '' });
      } else {
        _imShowError(t('import.parseError'));
      }
    };
    reader.readAsText(file, 'utf-8');
  } else if (isJson) {
    reader.onload = ev => {
      try {
        const obj = JSON.parse(ev.target.result || '{}');
        const persons = _tiParseStructuredJson(obj);
        if (persons && persons.length) {
          state._importJsonPersons = persons;
          document.getElementById('import-text-area').value =
            t('import.jsonLoaded', { n: persons.length, plural: persons.length !== 1 ? 'en' : '' });
        } else {
          document.getElementById('import-text-area').value =
            t('import.jsonFallback');
        }
      } catch(err) {
        _imShowError(t('import.invalidJson', { msg: err.message }));
      }
    };
    reader.readAsText(file, 'utf-8');
  } else if (isYaml) {
    reader.onload = ev => {
      document.getElementById('import-text-area').value =
        t('import.yamlLoaded');
    };
    reader.readAsText(file, 'utf-8');
  } else {
    reader.onload = ev => { document.getElementById('import-text-area').value = ev.target.result || ''; };
    reader.readAsText(file, 'utf-8');
  }
}

export function importReplaceDataset() {
  if (!state._importLoadedFile) { _imShowError(t('import.noFileLoaded')); return; }
  if (state.individuals.size && !confirm(t('import.replaceConfirm'))) return;
  // Both read out before closeTextImport(), which clears them.
  const file = state._importLoadedFile;
  const handle = state._importFileHandle;
  closeTextImport();
  _loadDatasetFile(file, handle);
}

// Left on the CDN, unlike the other bundled libraries: Tesseract pulls its own
// worker script, wasm binary and language data files at runtime — vendoring
// just the entry script would not make OCR import work offline, only move
// where one of several remote fetches comes from. It is also loaded on demand
// (OCR import only), not on every page load.
export function _loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (state._tesseractLoading) return state._tesseractLoading;
  state._tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error(t('import.tesseractLoadError')));
    document.head.appendChild(s);
  });
  return state._tesseractLoading;
}

export async function runImportOcr() {
  if (!state._importImageData) { _imShowError(t('import.noImage')); return; }
  const statusEl = document.getElementById('import-ocr-status');
  const btn = document.getElementById('import-ocr-btn');
  btn.disabled = true;
  statusEl.textContent = t('import.ocrLoading');
  try {
    const Tesseract = await _loadTesseract();
    const dataUrl = 'data:' + state._importImageData.mediaType + ';base64,' + state._importImageData.base64;
    statusEl.textContent = t('import.ocrProgress', { pct: 0 });
    const { data } = await Tesseract.recognize(dataUrl, 'deu+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          statusEl.textContent = t('import.ocrProgress', { pct: Math.round(m.progress*100) });
        }
      }
    });
    const text = (data?.text || '').trim();
    if (!text) { _imShowError(t('import.ocrNoText')); statusEl.textContent = ''; return; }
    document.getElementById('import-text-area').value = text;
    statusEl.textContent = t('import.ocrDone', { chars: text.length });
  } catch (err) {
    _imShowError(t('import.ocrError', { msg: err.message || String(err) }));
    statusEl.textContent = '';
  } finally {
    btn.disabled = false;
  }
}

export function parseImportText() {
  let persons;
  if (state._importJsonPersons) {
    persons = state._importJsonPersons;
  } else {
    const raw = (document.getElementById('import-text-area').value || '').trim();
    if (!raw) { alert(t('import.enterText')); return; }
    const clean = _tiCleanText(raw);
    persons = _tiParseText(clean);
    if (!persons.length) {
      alert(t('import.noPersons'));
      return;
    }
  }

  state._importActions = _tiGenerateActions(persons);
  state._importFilter  = 'all';
  state._importExpanded = new Set();

  if (!state._importActions.some(a => a.kind !== 'same')) {
    alert(t('import.allExisting', { n: persons.length }));
    return;
  }

  document.getElementById('import-step-input').style.display = 'none';
  document.getElementById('import-step-review').style.display = '';
  _renderImportReview();
}

/**
 * Where a proposed person stands:
 *   'island'     — nothing in this import ties them to the tree at all
 *   'unapproved' — the card that would tie them on is still sitting unapproved
 *   'ok'         — they will hang off the existing tree
 * Anything but 'ok' is a person who would land detached, and both are fixable —
 * the second just needs a click on another row rather than a link.
 */
export function _imConnState(action) {
  if (action.kind !== 'person' || action.status === 'skipped') return 'ok';
  if (state._importConn.get(action.id) === false) return 'island';
  if (action.status === 'approved' && state._importConnStrict.get(action.id) === false) return 'unapproved';
  return 'ok';
}

export function _imUnconnectedIds() {
  return state._importActions.filter(a => _imConnState(a) !== 'ok').map(a => a.id);
}

// Both maps, recomputed together. The single owner of _importConn* — everything
// that mutates a card goes through _imRepaintAction, which calls this, so a
// change on one row can never leave the warning on another row stale.
export function _imRefreshConn() {
  const before = { loose: state._importConn, strict: state._importConnStrict };
  state._importConn       = _tiConnectivity(state._importActions);
  state._importConnStrict = _tiConnectivity(state._importActions, a => a.status === 'approved');
  return before;
}

export function _renderImportSummary() {
  const nPers    = state._importActions.filter(a => a.kind === 'person').length;
  const nUpd     = state._importActions.filter(a => a.kind === 'update').length;
  const nMarr    = state._importActions.filter(a => a.kind === 'marriage').length;
  const nSame    = state._importActions.filter(a => a.kind === 'same').length;
  const nApp     = state._importActions.filter(a => a.status === 'approved').length;
  const nSkip    = state._importActions.filter(a => a.status === 'skipped').length;
  const nPend    = state._importActions.filter(a => a.status === 'pending').length;
  const nLoose   = _imUnconnectedIds().length;

  const f = state._importFilter;
  const chip = (key, label, cls, n) =>
    `<button class="import-filter-chip${f === key ? ' import-filter-chip--on' : ''}${cls ? ' ' + cls : ''}"
             onclick="_imSetFilter('${key}')">${label} <b>${n}</b></button>`;

  document.getElementById('import-summary').innerHTML = `
    <div class="import-summary-bar">
      <span class="import-stat"><b>${state._importActions.length}</b> ${t('import.summarySuggestions', { total: state._importActions.length })}</span>
      <span class="import-stat import-stat--approved">&#x2713; <b>${nApp}</b> ${t('import.summaryApproved', { n: nApp })}</span>
      <span class="import-stat import-stat--skipped">&#x2715; <b>${nSkip}</b> ${t('import.summarySkipped', { n: nSkip })}</span>
      <span class="import-stat import-stat--pending">&#x23F3; <b>${nPend}</b> ${t('import.summaryPending', { n: nPend })}</span>
      <span class="import-spacer"></span>
      <button class="import-view-btn${state._importView === 'table' ? ' import-view-btn--on' : ''}"
              onclick="_imSetView('table')">&#x1F4CA; ${t('import.viewTable')}</button>
      <button class="import-view-btn${state._importView === 'cards' ? ' import-view-btn--on' : ''}"
              onclick="_imSetView('cards')">&#x1F5C2; ${t('import.viewCards')}</button>
    </div>
    <div class="import-filter-bar">
      ${chip('all',         t('import.filterAll'),      '',                        state._importActions.length)}
      ${chip('new',         t('import.summaryNew', { n: nPers }), 'import-filter-chip--person',   nPers)}
      ${chip('changed',     t('import.filterChanged'),  'import-filter-chip--update',   nUpd)}
      ${chip('marriage',    t('import.filterMarriage'), 'import-filter-chip--marriage', nMarr)}
      ${chip('same',        t('import.filterSame'),     'import-filter-chip--same',     nSame)}
      ${chip('unconnected', '&#x26A0; ' + t('import.filterUnconnected'), 'import-filter-chip--warn', nLoose)}
    </div>
    <div class="import-bulk-actions">
      <button class="import-bulk-btn import-bulk-btn--approve" onclick="_importApproveAll()">&#x2713; ${t('import.approveAll')}</button>
      <button class="import-bulk-btn import-bulk-btn--skip"    onclick="_importSkipAll()">&#x2715; ${t('import.skipAll')}</button>
      <button class="import-bulk-btn import-bulk-btn--reset"   onclick="_importResetAll()">&#x21BA; ${t('import.resetAll')}</button>
      <label class="import-connect-toggle" title="${t('import.requireConnectedTitle')}">
        <input type="checkbox" ${state._importRequireConnected ? 'checked' : ''}
               onchange="_imToggleRequireConnected(this.checked)">
        ${t('import.requireConnected')}
      </label>
    </div>
  `;
}

export function _imSetFilter(key) {
  state._importFilter = (state._importFilter === key && key !== 'all') ? 'all' : key;
  _renderImportReview();
}

export function _imSetView(view) {
  state._importView = view;
  _renderImportReview();
}

export function _imToggleRequireConnected(on) {
  state._importRequireConnected = !!on;
  _renderImportReview();
}

export function _imVisibleActions() {
  const f = state._importFilter;
  const loose = new Set(_imUnconnectedIds());
  return [...state._importActions]
    .filter(a => {
      switch (f) {
        case 'new':         return a.kind === 'person';
        case 'changed':     return a.kind === 'update';
        case 'marriage':    return a.kind === 'marriage';
        case 'same':        return a.kind === 'same';
        case 'unconnected': return loose.has(a.id);
        default:            return true;
      }
    })
    .sort((a, b) => (a._sourceIdx ?? 0) - (b._sourceIdx ?? 0));
}

export function _renderImportReview() {
  _imRefreshConn();
  _renderImportSummary();
  const list = document.getElementById('import-actions-list');
  const visible = _imVisibleActions();

  if (!visible.length) {
    list.innerHTML = `<div class="import-empty-filter">${t('import.noRowsForFilter')}</div>`;
    return;
  }

  if (state._importView === 'cards') {
    list.innerHTML = visible.map(action => _renderImportCard(action)).join('');
    return;
  }

  list.innerHTML = `<table class="import-diff-table">
    <thead><tr>
      <th class="import-dth-exp"></th>
      <th>${t('import.colKind')}</th>
      <th>${t('import.colPerson')}</th>
      <th>${t('import.colDiff')}</th>
      <th>${t('import.colLink')}</th>
      <th class="import-dth-status">${t('import.colStatus')}</th>
    </tr></thead>
    <tbody>${visible.map(a => _imDiffRowHtml(a)).join('')}</tbody>
  </table>`;
}

// ── The diff table ──────────────────────────────────────────────────────────

const _IM_KIND_META = {
  person:   { cls: 'import-badge--person',   key: 'kindAddPerson' },
  update:   { cls: 'import-badge--update',   key: 'kindUpdate' },
  marriage: { cls: 'import-badge--marriage', key: 'kindMarriage' },
  same:     { cls: 'import-badge--same',     key: 'kindSame' },
};

function _imYears(dateA, dateB) {
  const b = (dateA || '').match(/\b(\d{4})\b/)?.[1] || '';
  const d = (dateB || '').match(/\b(\d{4})\b/)?.[1] || '';
  return (b ? `*${b}` : '') + (b && d ? ' ' : '') + (d ? `†${d}` : '');
}

// One field, both answers side by side, the winning one lit. Clicking swaps it.
function _imDiffPair(action, field, existing, incoming) {
  const label = _imFieldLabel(field);
  const use   = action.fieldApply ? !!action.fieldApply[field] : !!incoming;
  const clickable = !!action.fieldApply && !!existing && !!incoming;
  return `<div class="import-dpair${clickable ? ' import-dpair--pick' : ''}"
       ${clickable ? `onclick="_imToggleFieldApply('${action.id}','${escJs(field)}')" title="${t('import.conflictTitle')}"` : ''}>
    <span class="import-dlabel">${escHtml(label)}</span>
    <span class="import-dold${!use ? ' import-dside--on' : ''}">${existing ? escHtml(existing) : '&mdash;'}</span>
    <span class="import-darrow">&#x2192;</span>
    <span class="import-dnew${use ? ' import-dside--on' : ''}">${incoming ? escHtml(incoming) : '&mdash;'}</span>
  </div>`;
}

export function _imDiffCellHtml(action) {
  if (action.kind === 'same') {
    return `<span class="import-dsame">&#x2713; ${t('import.identical')}</span>`;
  }

  if (action.kind === 'marriage') {
    const kids = action._childrenArr ||
      (action.fields['Children'] || '').split(';').map(s => s.trim()).filter(Boolean);
    const bits = [];
    if (action.existingFamId) {
      bits.push(`<div class="import-dnote">${t('import.intoExistingFamily')}</div>`);
    }
    bits.push(`<div class="import-dpair"><span class="import-dlabel">${t('import.marriage')}</span>
      <span class="import-dnew import-dside--on">${escHtml(action.fields['Husband'] || '?')} &amp; ${escHtml(action.fields['Wife'] || '?')}</span></div>`);
    const md = [action.fields['Marriage Date'], action.fields['Marriage Place']].filter(Boolean).join(', ');
    if (md) bits.push(`<div class="import-dpair"><span class="import-dlabel">${t('import.fieldMarriageDate')}</span>
      <span class="import-dnew import-dside--on">${escHtml(md)}</span></div>`);
    if (kids.length) bits.push(`<div class="import-dpair"><span class="import-dlabel">${t('import.fieldChildren')}</span>
      <span class="import-dnew import-dside--on">${escHtml(kids.join(', '))}</span></div>`);
    return bits.join('');
  }

  const indi = action.existingId ? state.individuals.get(action.existingId) : null;
  const rows = [];
  for (const field of _IM_UPDATE_FIELDS) {
    const incoming = (action.fields[field] || '').trim();
    const existing = indi ? _imExistingValue(indi, field).trim() : '';
    if (!incoming && !existing) continue;
    if (incoming === existing) continue;
    rows.push(_imDiffPair(action, field, existing, incoming));
  }
  for (const field of ['Father', 'Mother']) {
    const v = (action.fields[field] || '').trim();
    if (v) rows.push(`<div class="import-dpair"><span class="import-dlabel">${_imFieldLabel(field)}</span>
      <span class="import-dnew import-dside--on">${escHtml(v)}</span></div>`);
  }
  return rows.length ? rows.join('') : `<span class="import-dsame">${t('import.identical')}</span>`;
}

export function _imConnCellHtml(action) {
  if (action.kind !== 'person') return '';
  const st = _imConnState(action);
  if (st === 'ok') return `<span class="import-conn import-conn--ok">&#x2713; ${t('import.connected')}</span>`;

  // The tie exists in this import, it just is not approved yet. Nothing to
  // link — say so, so the reader goes and approves that row instead of
  // hunting for a person to attach this one to.
  if (st === 'unapproved') {
    return `<span class="import-conn import-conn--pending" title="${t('import.connPendingTitle')}">&#x26A0; ${t('import.connPending')}</span>`;
  }

  return `<span class="import-conn import-conn--warn" title="${t('import.unconnectedTitle')}">&#x26A0; ${t('import.unconnected')}</span>
    <button class="import-dbtn import-dbtn--link" onclick="_imAttachToParent('${action.id}')" title="${t('import.attachTitle')}">&#x1F517; ${t('import.attach')}</button>`;
}

export function _imLinkCellHtml(action) {
  if (action.existingId) {
    const indi = state.individuals.get(action.existingId);
    const badge = `<span class="import-dlinked">&#x1F517; ${escHtml(indi?.name || action.existingId)}</span>`;
    // An identical row has nothing to unlink from — breaking the match would
    // only turn a record the tree already holds into a duplicate of itself.
    if (action.kind === 'same') return badge;
    return badge + `<button class="import-dbtn" onclick="_imUnlink('${action.id}')" title="${t('import.unlinkTitle')}">&#x2715;</button>`;
  }
  if (action.existingFamId) return `<span class="import-dlinked">&#x1F517; ${escHtml(action.existingFamId)}</span>`;
  if (action.kind === 'person') {
    return `<span class="import-dnewtag">${t('import.newBadge')}</span>
      <button class="import-dbtn" onclick="openMatchDialog('${action.id}')" title="${t('import.linkTitle')}">&#x1F517;</button>`;
  }
  return '';
}

export function _imDiffRowHtml(action) {
  const meta = _IM_KIND_META[action.kind] || _IM_KIND_META.person;
  const open = state._importExpanded.has(action.id);
  const loose = _imConnState(action) !== 'ok';
  const name  = action.fields['Name'] ||
    [action.fields['Husband'], action.fields['Wife']].filter(Boolean).join(' & ') || t('import.noName');
  const years = _imYears(action.fields['Birth Date'], action.fields['Death Date']);

  const main = `<tr class="import-drow import-drow--${action.status}${loose ? ' import-drow--loose' : ''}"
      data-drow-id="${action.id}">
    <td class="import-dcell-exp">
      <button class="import-dexp" onclick="_imToggleRowDetails('${action.id}')"
              title="${t('import.editRow')}">${open ? '&#x25BE;' : '&#x25B8;'}</button>
    </td>
    <td><span class="import-badge ${meta.cls}">${t('import.' + meta.key)}</span></td>
    <td class="import-dcell-name">
      <div class="import-dname">${escHtml(name)}</div>
      ${years ? `<div class="import-dyears">${years}</div>` : ''}
      ${_imConnCellHtml(action)}
    </td>
    <td class="import-dcell-diff">${_imDiffCellHtml(action)}</td>
    <td class="import-dcell-link">${_imLinkCellHtml(action)}</td>
    <td class="import-dcell-status">${action.kind === 'same' ? '<span class="import-dsame">&mdash;</span>' : `
      <button class="import-dstatus import-dstatus--approve${action.status === 'approved' ? ' import-btn--active' : ''}"
              data-action="${action.id}" data-status="approved" title="${t('import.approve')}">&#x2713;</button>
      <button class="import-dstatus import-dstatus--skip${action.status === 'skipped' ? ' import-btn--active' : ''}"
              data-action="${action.id}" data-status="skipped" title="${t('import.skip')}">&#x2715;</button>`}
    </td>
  </tr>`;

  if (!open) return main;
  return main + `<tr class="import-drow-details" data-details-for="${action.id}">
    <td colspan="6">${_renderImportCard(action)}</td>
  </tr>`;
}

export function _imToggleRowDetails(actionId) {
  if (state._importExpanded.has(actionId)) state._importExpanded.delete(actionId);
  else state._importExpanded.add(actionId);
  _imRepaintAction(actionId);
}

// Whichever view is on screen, put this one action back on it. Both views can be
// live at once — an expanded row holds a full card — so repaint both.
function _imPaintOne(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  const row = document.querySelector(`tr[data-drow-id="${actionId}"]`);
  if (row) {
    const det = document.querySelector(`tr[data-details-for="${actionId}"]`);
    if (det) det.remove();
    row.outerHTML = _imDiffRowHtml(action);
    return;
  }
  const card = document.querySelector(`.import-action-card[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
}

/**
 * Repaint one card and everything its change moved.
 *
 * Approving the marriage card that adopts a child is a change *to that card*
 * which unmarks the child's card — and the child may be anywhere in the list.
 * So every edit recomputes connectivity and repaints whichever other rows the
 * verdict actually moved, rather than only the row that was touched.
 */
export function _imRepaintAction(actionId) {
  const before = _imRefreshConn();
  _imPaintOne(actionId);
  for (const [aid] of state._importConn) {
    if (aid === actionId) continue;
    if (before.loose.get(aid)  !== state._importConn.get(aid) ||
        before.strict.get(aid) !== state._importConnStrict.get(aid)) _imPaintOne(aid);
  }
  _renderImportSummary();
}

export const _IM_PERSON_FIELDS = new Set(['Name','Father','Mother','Husband','Wife']);

export function _imFieldLabel(label) {
  const key = 'import.field' + label.replace(/\s+/g, '');
  const tr = t(key);
  return tr === key ? label : tr;
}

export function _imDropId(actionId, fieldKey) {
  return 'nacd-' + actionId + '-' + fieldKey.replace(/[\s:]/g, '_');
}

export function _imLinkedDisplay(link) {
  if (!link) return null;
  if (link.type === 'existing') {
    const indi = state.individuals.get(link.id);
    if (!indi) return null;
    return {
      name:      indi.name || '',
      maiden:    indi.maidenName || '',
      year:      indi.birth?.date?.match(/\b(\d{4})\b/)?.[1] || '',
      deathYear: indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || '',
      tag:       '',
    };
  }
  const pa = state._importActions.find(a => a.id === link.id);
  if (!pa) return null;
  return {
    name:      pa.fields['Name'] || '',
    maiden:    '',
    year:      (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || '',
    deathYear: (pa.fields['Death Date']||'').match(/\b(\d{4})\b/)?.[1] || '',
    tag:       t('import.badgeImport'),
  };
}

export function _imLinkedTooltipHtml(link) {
  if (!link) return '';
  if (link.type === 'existing') {
    const indi = state.individuals.get(link.id);
    if (!indi) return '';
    const rows = [];
    rows.push(`<div class="import-tt-name">${escHtml(indi.name || t('import.noName'))}</div>`);
    const sub = [];
    if (indi.maidenName) sub.push(`${t('tooltip.born', { name: indi.maidenName })}`);
    if (indi.sex) sub.push(indi.sex);
    if (sub.length) rows.push(`<div class="import-tt-sub">${sub.join(' · ')}</div>`);
    if (indi.birth?.date || indi.birth?.plac)
      rows.push(`<div class="import-tt-line"><b>${t('import.tooltipBorn')}</b>${escHtml(indi.birth?.date || '?')}${indi.birth?.plac ? t('import.tooltipIn') + escHtml(indi.birth.plac) : ''}</div>`);
    if (indi.death?.date || indi.death?.plac)
      rows.push(`<div class="import-tt-line"><b>${t('import.tooltipDied')}</b>${escHtml(indi.death?.date || '?')}${indi.death?.plac ? t('import.tooltipIn') + escHtml(indi.death.plac) : ''}</div>`);
    // Parents
    const famc = (indi.famc || [])[0];
    if (famc) {
      const fam = state.families.get(famc);
      if (fam) {
        const fa = fam.husb ? state.individuals.get(fam.husb)?.name : '';
        const mo = fam.wife ? state.individuals.get(fam.wife)?.name : '';
        if (fa || mo) rows.push(`<div class="import-tt-line">${t('import.parents')}: ${escHtml([fa, mo].filter(Boolean).join(' & '))}</div>`);
      }
    }
    // Spouses
    const spouseNames = (indi.fams || []).map(fId => {
      const f = state.families.get(fId); if (!f) return null;
      const sId = f.husb === link.id ? f.wife : f.husb;
      return sId ? state.individuals.get(sId)?.name : null;
    }).filter(Boolean);
    if (spouseNames.length) rows.push(`<div class="import-tt-line">${t('import.marriage')}: ${escHtml(spouseNames.join(', '))}</div>`);
    // Children
    const children = [];
    for (const fId of (indi.fams || [])) {
      const f = state.families.get(fId); if (!f) continue;
      for (const cId of (f.chil || [])) {
        const c = state.individuals.get(cId);
        if (c) children.push(c.name);
      }
    }
    if (children.length) rows.push(`<div class="import-tt-line">${t('import.children')}: ${escHtml(children.join(', '))}</div>`);
    if (indi.note) rows.push(`<div class="import-tt-note">${escHtml(indi.note.slice(0, 220))}${indi.note.length > 220 ? '…' : ''}</div>`);
    rows.push(`<div class="import-tt-id">${t('import.id')}: ${escHtml(link.id)}</div>`);
    return rows.join('');
  }
  // Pending (another import action)
  const pa = state._importActions.find(a => a.id === link.id);
  if (!pa) return '';
  const rows = [];
  rows.push(`<div class="import-tt-name">${escHtml(pa.fields['Name'] || t('import.noName'))}</div>`);
  rows.push(`<div class="import-tt-sub">${t('import.fromImport')}</div>`);
  for (const [k, v] of Object.entries(pa.fields)) {
    if (k === 'Name' || !v) continue;
    rows.push(`<div class="import-tt-line"><b>${escHtml(_imFieldLabel(k))}:</b> ${escHtml(String(v).slice(0, 200))}</div>`);
  }
  return rows.join('');
}

export function _imLinkedBadge(actionId, fieldKey, link, label) {
  const d = _imLinkedDisplay(link);
  if (!d) return '';
  const maiden    = d.maiden    ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: d.maiden })}</span>` : '';
  const year      = d.year      ? ` <span class="import-linked-year">*${d.year}</span>` : '';
  const deathYear = d.deathYear ? ` <span class="import-linked-year">&#x2020;${d.deathYear}</span>` : '';
  const tag       = d.tag       ? ` <span class="import-linked-tag">${escHtml(d.tag)}</span>` : '';
  const tipHtml   = _imLinkedTooltipHtml(link);
  return `<div class="import-field-row">
    <label class="import-field-label">${escHtml(label)}</label>
    <div class="import-field-linked" tabindex="0">
      <span class="import-field-linked-name">${escHtml(d.name)}</span>${maiden}${year}${deathYear}${tag}
      <button class="import-field-change-btn" onclick="_imChangeFieldLink('${actionId}','${fieldKey}')" title="${t('import.changeFieldLink')}">&#x21BB;</button>
      <button class="import-field-unlink-btn" onclick="_imFieldUnlink('${actionId}','${fieldKey}')" title="${t('import.unlinkTitle')}">&#x2715;</button>
      <div class="import-linked-tip">${tipHtml}</div>
    </div>
  </div>`;
}

export function _imConflictRow(action, field, displayLabel, incoming, existing) {
  const useImported = !!action.fieldApply[field];
  const pick = (active, value, tag) => `
    <div class="import-conflict-side${active ? ' import-conflict-side--on' : ''}">
      <span class="import-conflict-tag">${tag}</span>
      <span class="import-conflict-val">${escHtml(value)}</span>
    </div>`;
  return `<div class="import-field-row import-field-row--conflict">
    <label class="import-field-label">${escHtml(displayLabel)}</label>
    <div class="import-conflict" role="group"
         onclick="_imToggleFieldApply('${action.id}','${escJs(field)}')"
         title="${t('import.conflictTitle')}">
      ${pick(!useImported, existing, t('import.inTree'))}
      ${pick(useImported, incoming, t('import.fromImport'))}
    </div>
  </div>`;
}

export function _imPersonInputRow(action, label, fieldKey, val) {
  const fid = 'if-' + action.id + '-' + fieldKey.replace(/[\s:]/g,'_');
  const dropId = _imDropId(action.id, fieldKey);
  return `<div class="import-field-row">
    <label class="import-field-label" for="${fid}">${escHtml(label)}</label>
    <div class="import-name-ac-wrap">
      <input class="import-field-input" id="${fid}" type="text"
             value="${escHtml(val||'')}"
             data-action="${action.id}" data-field="${fieldKey}"
             data-ac-person="true"
             placeholder="${t('import.emptyPlaceholder')}" autocomplete="off">
      <div class="import-name-drop" id="${dropId}"></div>
    </div>
  </div>`;
}

export function _imChildrenRows(action) {
  // Sync _childrenArr from fields on first render
  if (!action._childrenArr) {
    const raw = action.fields['Children'] || '';
    action._childrenArr = raw ? raw.split(';').map(s => s.trim()).filter(Boolean) : [];
  }
  action.fieldLinks = action.fieldLinks || {};

  const rows = action._childrenArr.map((name, idx) => {
    const key  = `Children:${idx}`;
    const link = action.fieldLinks[key];
    if (link) return _imLinkedBadge(action.id, key, link, idx === 0 ? t('import.fieldChildren') : '');
    const dropId = _imDropId(action.id, key);
    const fid    = 'if-' + action.id + '-Children_' + idx;
    const lbl    = idx === 0 ? t('import.fieldChildren') : '';
    return `<div class="import-field-row import-child-row">
      <label class="import-field-label">${escHtml(lbl)}</label>
      <div class="import-name-ac-wrap" style="flex:1">
        <input class="import-field-input" id="${fid}" type="text"
               value="${escHtml(name)}"
               data-action="${action.id}" data-field="${key}"
               data-ac-person="true"
               placeholder="${t('import.childPlaceholder')}" autocomplete="off">
        <div class="import-name-drop" id="${dropId}"></div>
      </div>
      <button class="import-child-rm-btn" onclick="_imRemoveChild('${action.id}',${idx})">&#x2715;</button>
    </div>`;
  }).join('');

  const addBtn = `<div class="import-field-row import-child-row">
    <label class="import-field-label"></label>
    <button class="import-child-add-btn" onclick="_imAddChild('${action.id}')">+ ${t('import.childPlaceholder')}</button>
  </div>`;

  return rows + addBtn;
}

export function _renderImportCard(action) {
  const meta      = _IM_KIND_META[action.kind] || _IM_KIND_META.person;
  const kindLabel = t('import.' + meta.key);
  const kindClass = meta.cls;

  // Nothing to decide on a record that already matches — just show what the
  // tree holds, so the reader can confirm it really is the same person.
  if (action.kind === 'same') {
    return `<div class="import-action-card import-action-card--skipped" data-action-id="${action.id}">
      <div class="import-card-header">
        <span class="import-badge ${kindClass}">${kindLabel}</span>
        <span class="import-status import-status--skipped">${t('import.identical')}</span>
      </div>
      <div class="import-same-body">${_imLinkedTooltipHtml({ type:'existing', id: action.existingId })}</div>
    </div>`;
  }
  const stCls = { pending:'import-status--pending', approved:'import-status--approved', skipped:'import-status--skipped' }[action.status];
  const stLbl = { pending:`&#x23F3; ${t('import.statusPending')}`, approved:`&#x2713; ${t('import.statusApproved')}`, skipped:`&#x2715; ${t('import.statusSkipped')}` }[action.status];

  action.fieldLinks = action.fieldLinks || {};
  const isPersonAction = action.kind === 'person' || action.kind === 'update';

  const fieldsHtml = Object.entries(action.fields).map(([label, val]) => {
    const displayLabel = _imFieldLabel(label);
    const isPersonField = _IM_PERSON_FIELDS.has(label);
    const link = action.fieldLinks[label];

    // Children: special multi-row list
    if (label === 'Children') return _imChildrenRows(action);

    // Person field that is linked → show badge
    if (isPersonField && link) return _imLinkedBadge(action.id, label, link, displayLabel);

    // Name field when whole action is linked to existing person → show badge with unlink
    if (label === 'Name' && isPersonAction && action.existingId) {
      const linkObj = { type: 'existing', id: action.existingId };
      const d = _imLinkedDisplay(linkObj);
      const name   = d ? d.name   : val;
      const maiden    = d?.maiden    ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: d.maiden })}</span>` : '';
      const year      = d?.year      ? ` <span class="import-linked-year">*${d.year}</span>` : '';
      const deathYear = d?.deathYear ? ` <span class="import-linked-year">&#x2020;${d.deathYear}</span>` : '';
      const tipHtml = _imLinkedTooltipHtml(linkObj);
      return `<div class="import-field-row">
        <label class="import-field-label">${displayLabel}</label>
        <div class="import-field-linked" tabindex="0">
          <span class="import-field-linked-name">${escHtml(name)}</span>${maiden}${year}${deathYear}
          <button class="import-btn-change" onclick="_imChangeMainLink('${action.id}')" title="${t('import.changeLinkTitle')}">&#x21BB; ${t('import.changeLink')}</button>
          <button class="import-btn-unlink" onclick="_imUnlink('${action.id}')" title="${t('import.unlinkTitle')}">&#x2715; ${t('import.unlink')}</button>
          <div class="import-linked-tip">${tipHtml}</div>
        </div>
      </div>`;
    }

    // Person field with autocomplete input
    if (isPersonField) return _imPersonInputRow(action, displayLabel, label, val);

    // On a linked card, a field the tree already answers is a decision, not an
    // input: show both answers and let the reader pick. Silently dropping the
    // imported value — which is what this did — hides the disagreement and the
    // choice along with it.
    if (action.existingId && action.fieldApply && _IM_UPDATE_FIELDS.includes(label)) {
      const indi = state.individuals.get(action.existingId);
      const existing = indi ? _imExistingValue(indi, label).trim() : '';
      const incoming = (val || '').trim();
      if (existing && incoming && existing !== incoming) {
        return _imConflictRow(action, label, displayLabel, incoming, existing);
      }
      if (existing && !incoming) {
        return `<div class="import-field-row">
          <label class="import-field-label">${escHtml(displayLabel)}</label>
          <div class="import-field-kept">${escHtml(existing)}
            <span class="import-field-kept-tag">${t('import.inTree')}</span></div>
        </div>`;
      }
    }

    // Regular non-person field
    const wideClass = ''; // children handled above
    const fid = `if-${action.id}-${label.replace(/\s+/g,'_')}`;
    return `<div class="import-field-row${wideClass}">
      <label class="import-field-label" for="${fid}">${escHtml(displayLabel)}</label>
      <input class="import-field-input" id="${fid}" type="text"
             value="${escHtml(val||'')}"
             data-action="${action.id}" data-field="${label}"
             placeholder="${t('import.emptyPlaceholder')}">
    </div>`;
  }).join('');

  const srcHtml = action.source ? `
    <details class="import-source-details">
      <summary>${t('import.sourceText')}</summary>
      <div class="import-source-text">${escHtml(action.source)}</div>
    </details>` : '';

  const appActive = action.status === 'approved' ? ' import-btn--active' : '';
  const skpActive = action.status === 'skipped'  ? ' import-btn--active' : '';

  // Manual-link button for new-person cards not yet linked to anyone
  const showLinkBtn = isPersonAction && !action.existingId;
  const linkBtnHtml = showLinkBtn
    ? `<button class="import-btn import-btn--link" onclick="openMatchDialog('${action.id}')" title="${t('import.linkTitle')}">&#x1F517; ${t('import.link')}</button>`
    : '';

  return `<div class="import-action-card import-action-card--${action.status}" data-action-id="${action.id}">
    <div class="import-card-header">
      <span class="import-badge ${kindClass}">${kindLabel}</span>
      <span class="import-status ${stCls}">${stLbl}</span>
    </div>
    <div class="import-fields">${fieldsHtml}</div>
    ${srcHtml}
    <div class="import-card-actions">
      ${linkBtnHtml}
      <button class="import-btn import-btn--approve${appActive}" data-action="${action.id}" data-status="approved">&#x2713; ${t('import.approve')}</button>
      <button class="import-btn import-btn--skip${skpActive}"    data-action="${action.id}" data-status="skipped">&#x2715; ${t('import.skip')}</button>
    </div>
  </div>`;
}

export function _imChangeFieldLink(actionId, fieldKey) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};
  const link = action.fieldLinks[fieldKey];
  const prevName = _imLinkedDisplay(link)?.name || '';
  delete action.fieldLinks[fieldKey];
  if (fieldKey.startsWith('Children:')) {
    const idx = parseInt(fieldKey.split(':')[1]);
    if (action._childrenArr) action._childrenArr[idx] = prevName;
    action.fields['Children'] = (action._childrenArr || []).join('; ');
  } else if (_IM_PERSON_FIELDS.has(fieldKey)) {
    action.fields[fieldKey] = prevName;
  }
  _imRepaintAction(actionId);
  // Focus the new input so autocomplete drop opens
  setTimeout(() => {
    const safe = fieldKey.replace(/[\s:]/g,'_').replace('Children:', 'Children_');
    const inp = document.getElementById('if-' + actionId + '-' + safe);
    if (inp) { inp.focus(); inp.select(); }
  }, 0);
}

export function _imChangeMainLink(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  _imUnlink(actionId);
  openMatchDialog(actionId);
}

document.addEventListener('DOMContentLoaded', () => {
  const list = document.getElementById('import-actions-list');
  if (!list) return;

  // Button clicks (approve / skip)
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    const id = btn.dataset.action;
    const wantedStatus = btn.dataset.status;
    const action = state._importActions.find(a => a.id === id);
    if (!action) return;
    action.status = (action.status === wantedStatus) ? 'pending' : wantedStatus;

    // While the reader is working through the strays, approving one changes who
    // is still on the list — so that view has to be rebuilt, not patched.
    if (state._importFilter === 'unconnected') _renderImportReview();
    else _imRepaintAction(id);
  });

  // Field edits (delegated input)
  list.addEventListener('input', e => {
    const inp = e.target.closest('[data-action][data-field]');
    if (!inp) return;
    const action = state._importActions.find(a => a.id === inp.dataset.action);
    if (!action) return;
    const field = inp.dataset.field;
    if (field.startsWith('Children:')) {
      // Update individual child in array and rebuild field string
      action._childrenArr = action._childrenArr || [];
      const idx = parseInt(field.split(':')[1]);
      action._childrenArr[idx] = inp.value;
      action.fields['Children'] = action._childrenArr.join('; ');
    } else {
      action.fields[field] = inp.value;
    }
    if (inp.dataset.acPerson) _imPersonSearch(inp, action.id, field);

    // Typing a name is how a card gets tied to somebody — a spouse, a child —
    // so the warnings have to follow the typing. Debounced: recomputing the
    // whole component map per keystroke is not worth it, and nobody reads a
    // badge mid-word anyway.
    clearTimeout(state._importConnTimer);
    state._importConnTimer = setTimeout(() => {
      const before = _imRefreshConn();
      // Never repaint out from under the cursor — that would eat the rest of
      // the word being typed.
      const typing = document.activeElement?.dataset?.action;
      for (const [aid] of state._importConn) {
        if (aid === typing) continue;
        if (before.loose.get(aid)  !== state._importConn.get(aid) ||
            before.strict.get(aid) !== state._importConnStrict.get(aid)) _imPaintOne(aid);
      }
      _renderImportSummary();
    }, 350);
  });

  // Person-field autocomplete: show on focus, hide on blur
  list.addEventListener('focusin', e => {
    const inp = e.target.closest('[data-ac-person]');
    if (inp) _imPersonSearch(inp, inp.dataset.action, inp.dataset.field);
  });
  list.addEventListener('focusout', e => {
    const inp = e.target.closest('[data-ac-person]');
    if (inp) setTimeout(() => { const d = document.getElementById(_imDropId(inp.dataset.action, inp.dataset.field)); if (d) { d.innerHTML = ''; d.style.display = 'none'; } }, 180);
  });
});

// Bulk actions work on what the filter is showing, so "approve all" after
// narrowing to one kind means that kind. Identical rows are never touched —
// there is nothing to approve or skip about a record that already matches.
function _imBulk(status) {
  for (const a of _imVisibleActions()) { if (a.kind !== 'same') a.status = status; }
  _renderImportReview();
}

export function _importApproveAll() { _imBulk('approved'); }

export function _importSkipAll()    { _imBulk('skipped'); }

export function _importResetAll()   { _imBulk('pending'); }

export function backToInputImport() {
  document.getElementById('import-step-input').style.display = '';
  document.getElementById('import-step-review').style.display = 'none';
}

export function applyImport() {
  const approved = state._importActions.filter(a => a.status === 'approved');
  if (approved.length === 0) {
    alert(t('import.noApprovedChanges'));
    return;
  }

  // Merging is supposed to grow one tree, not park a second one beside it.
  // Judged on what is approved, not on what the preview hoped for: a tie that
  // is still sitting in a pending card will not be written either.
  _imRefreshConn();
  const loose = state._importActions.filter(a =>
    a.kind === 'person' && a.status === 'approved' && _imConnState(a) !== 'ok');
  if (state._importRequireConnected && loose.length) {
    const nPending = loose.filter(a => _imConnState(a) === 'unapproved').length;
    alert(t('import.blockedUnconnected', { n: loose.length }) +
      (nPending ? '\n\n' + t('import.blockedPendingTie', { n: nPending }) : ''));
    state._importFilter = 'unconnected';
    _renderImportReview();
    return;
  }

  // Show progress overlay, hide review step
  document.getElementById('import-step-review').style.display = 'none';
  const overlay  = document.getElementById('import-progress-overlay');
  const bar      = document.getElementById('import-progress-bar');
  const countEl  = document.getElementById('import-progress-count');
  const labelEl  = document.getElementById('import-progress-label');
  overlay.style.display = 'flex';
  bar.style.width = '0%';

  const total = approved.length;
  const BATCH = 50;
  let done = 0;

  function tick() {
    const next = Math.min(done + BATCH, total);
    done = next;
    const pct = Math.round((done / total) * 100);
    bar.style.width = pct + '%';
    countEl.textContent = t('import.progressCount', { done, total });

    if (done < total) {
      setTimeout(tick, 0);
      return;
    }

    // All ticks done — now run the actual synchronous apply + rebuild
    labelEl.textContent = t('import.graphUpdate');
    bar.style.width = '100%';
    // Double rAF: first frame commits the DOM change, second frame runs after paint
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const report = _tiApplyActions(state._importActions);
      _fullRebuildGraph();
      closeTextImport();

      const nAdd  = report.filter(r => r.type === 'add').length;
      const nUpd  = report.filter(r => r.type === 'update').length;
      const nFam  = report.filter(r => r.type === 'fam').length;
      const nSkip = report.filter(r => r.type === 'skip').length;
      alert(t('import.importDone', { add: nAdd, update: nUpd, marriages: nFam, skipped: nSkip }));
    }));
  }

  setTimeout(tick, 0);
}

export function _imAttachToParent(actionId) { openMatchDialog(actionId, 'parent'); }

export function openMatchDialog(actionId, mode = 'link') {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;

  state._currentMatchActionId = actionId;
  state._imMatchMode = mode;

  // Display current entry
  const currentHtml = `
    <div class="import-match-person">
      <div class="import-match-name">${escHtml(action.fields['Name'] || t('import.noName'))}</div>
      <div class="import-match-details">
        ${action.fields['Birth Date'] ? `${t('import.fieldBirthDate')}: ${escHtml(action.fields['Birth Date'])}` : ''}
        ${action.fields['Birth Place'] ? `${t('import.tooltipIn')}${escHtml(action.fields['Birth Place'])}` : ''}
      </div>
      ${mode === 'parent' ? `<div class="import-match-hint">${t('import.attachHint')}</div>` : ''}
    </div>
  `;
  document.getElementById('import-match-current-content').innerHTML = currentHtml;
  
  // Find candidates
  state._currentMatchCandidates = _findMatchCandidates(action);
  renderMatchCandidates(state._currentMatchCandidates);
  
  // Clear search
  document.getElementById('import-match-search-input').value = '';
  
  // Show dialog
  document.getElementById('import-match-dialog').style.display = 'flex';
}

export function closeMatchDialog() {
  document.getElementById('import-match-dialog').style.display = 'none';
  state._currentMatchActionId = null;
  state._currentMatchCandidates = [];
  state._imMatchMode = 'link';
}

export function _findMatchCandidates(action) {
  const candidates = [];
  const searchName = (action.fields['Name'] || '').toLowerCase();
  const searchBirth = (action.fields['Birth Date'] || '').match(/\b(\d{4})\b/)?.[1] || '';
  
  // Search in existing individuals
  for (const [id, indi] of state.individuals) {
    const indiName = (indi.name || '').toLowerCase();
    const indiBirth = (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || '';
    
    let score = 0;
    
    // Exact name match
    if (indiName === searchName) {
      score = 100;
    } else if (indiName.includes(searchName) || searchName.includes(indiName)) {
      score = 50;
    } else if (indiName.split(' ').pop() === searchName.split(' ').pop()) {
      // Same surname
      score = 30;
    }
    
    // Birth year bonus
    if (score > 0 && indiBirth && searchBirth) {
      if (indiBirth === searchBirth) {
        score += 50;
      } else if (Math.abs(parseInt(indiBirth) - parseInt(searchBirth)) <= 2) {
        score += 20;
      }
    }
    
    if (score > 0) {
      candidates.push({
        type: 'existing',
        id: id,
        name: indi.name,
        birth: indi.birth?.date || '',
        death: indi.death?.date || '',
        sex: indi.sex || 'U',
        score: score,
        data: indi
      });
    }
  }
  
  // Also search in other pending import actions
  for (const otherAction of state._importActions) {
    if (otherAction.id === action.id) continue;
    if (otherAction.status === 'skipped') continue;
    
    const otherName = (otherAction.fields['Name'] || '').toLowerCase();
    const otherBirth = (otherAction.fields['Birth Date'] || '').match(/\b(\d{4})\b/)?.[1] || '';
    
    let score = 0;
    if (otherName === searchName) {
      score = 90;
    } else if (otherName.includes(searchName) || searchName.includes(otherName)) {
      score = 40;
    }
    
    if (score > 0 && otherBirth && searchBirth && otherBirth === searchBirth) {
      score += 40;
    }
    
    if (score > 0) {
      candidates.push({
        type: 'pending',
        actionId: otherAction.id,
        name: otherAction.fields['Name'],
        birth: otherAction.fields['Birth Date'] || '',
        death: otherAction.fields['Death Date'] || '',
        sex: otherAction.fields['Sex'] || 'U',
        score: score,
        data: otherAction
      });
    }
  }
  
  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

export function renderMatchCandidates(candidates) {
  const listEl = document.getElementById('import-match-list');
  
  if (candidates.length === 0) {
    listEl.innerHTML = `<div class="import-match-empty">${t('import.noMatchesFound')}</div>`;
    return;
  }

  listEl.innerHTML = candidates.map((c, idx) => `
    <div class="import-match-candidate" onclick="selectMatchCandidate('${c.type}', '${c.type === 'existing' ? c.id : c.actionId}')">
      <div class="import-match-candidate-type ${c.type === 'existing' ? 'type-existing' : 'type-pending'}">
        ${c.type === 'existing' ? t('import.matchExisting') : t('import.matchPending')}
      </div>
      <div class="import-match-candidate-info">
        <div class="import-match-candidate-name">${escHtml(c.name)}</div>
        <div class="import-match-candidate-details">
          ${c.birth ? `${t('import.bornShort')} ${escHtml(c.birth)}` : ''}
          ${c.death ? ` - ${t('import.diedShort')} ${escHtml(c.death)}` : ''}
          [${c.sex}]
        </div>
      </div>
      <div class="import-match-candidate-score">${t('import.score')}: ${c.score}</div>
    </div>
  `).join('');
}

export function searchMatchCandidates() {
  const query = document.getElementById('import-match-search-input').value.toLowerCase().trim();
  if (!query) {
    renderMatchCandidates(state._currentMatchCandidates);
    return;
  }

  // Search the whole dataset + all pending import actions, not just the pre-scored shortlist.
  const results = [];
  for (const [id, indi] of state.individuals) {
    if (!(indi.name || '').toLowerCase().includes(query)) continue;
    results.push({
      type: 'existing',
      id,
      name: indi.name || '',
      birth: indi.birth?.date || '',
      death: indi.death?.date || '',
      sex: indi.sex || 'U',
      score: 0,
      data: indi
    });
  }
  const currentActionId = state._currentMatchActionId;
  for (const a of state._importActions) {
    if (a.id === currentActionId || a.status === 'skipped') continue;
    const name = a.fields?.['Name'] || '';
    if (!name.toLowerCase().includes(query)) continue;
    results.push({
      type: 'pending',
      actionId: a.id,
      name,
      birth: a.fields['Birth Date'] || '',
      death: a.fields['Death Date'] || '',
      sex: a.fields['Sex'] || 'U',
      score: 0,
      data: a
    });
  }
  renderMatchCandidates(results);
}

/**
 * Hang a proposed new person off somebody already in the tree, as their child.
 * The parent's own family is preferred — that is where their other children are —
 * and only when they have none does this open a new one. Expressed as an ordinary
 * marriage card so the apply pass needs to know nothing about it.
 */
export function _imAttachChildTo(action, parentId) {
  const parent = state.individuals.get(parentId);
  if (!parent) return false;
  const childName = (action.fields['Name'] || '').trim();
  if (!childName) return false;

  const famId = (parent.fams || []).find(f => state.families.has(f));
  const attach = {
    id: Math.random().toString(36).slice(2),
    kind: 'marriage',
    status: 'approved',
    _sourceIdx: (action._sourceIdx ?? 0) + 0.5,
    _childrenArr: [childName],
    fieldLinks: { 'Children:0': { type: 'pending', id: action.id } },
    fields: { 'Husband':'', 'Wife':'', 'Marriage Date':'', 'Marriage Place':'', 'Children': childName },
    source: t('import.attachedTo', { name: parent.name || parentId }),
  };

  if (famId) {
    const fam = state.families.get(famId);
    attach.existingFamId = famId;
    attach.fields['Husband'] = state.individuals.get(fam.husb)?.name || '';
    attach.fields['Wife']    = state.individuals.get(fam.wife)?.name || '';
    if (fam.husb) attach.fieldLinks['Husband'] = { type: 'existing', id: fam.husb };
    if (fam.wife) attach.fieldLinks['Wife']    = { type: 'existing', id: fam.wife };
  } else {
    const slot = parent.sex === 'F' ? 'Wife' : 'Husband';
    attach.fields[slot]     = parent.name || '';
    attach.fieldLinks[slot] = { type: 'existing', id: parentId };
  }

  state._importActions.push(attach);
  action.status = 'approved';   // a pending link to a skipped card resolves to nothing
  return true;
}

export function selectMatchCandidate(type, targetId) {
  if (!state._currentMatchActionId) return;

  const action = state._importActions.find(a => a.id === state._currentMatchActionId);
  if (!action) return;

  if (state._imMatchMode === 'parent') {
    if (type !== 'existing' || !_imAttachChildTo(action, targetId)) return;
    state._imMatchMode = 'link';
    _renderImportReview();
    closeMatchDialog();
    return;
  }

  if (type === 'existing') {
    if (!_imLinkExisting(action, targetId)) return;

  } else if (type === 'pending') {
    // Link to another pending action
    const targetAction = state._importActions.find(a => a.id === targetId);
    if (!targetAction) return;
    
    // Merge data into the target action
    if (action.fields['Birth Date'] && !targetAction.fields['Birth Date']) {
      targetAction.fields['Birth Date'] = action.fields['Birth Date'];
    }
    if (action.fields['Birth Place'] && !targetAction.fields['Birth Place']) {
      targetAction.fields['Birth Place'] = action.fields['Birth Place'];
    }
    if (action.fields['Death Date'] && !targetAction.fields['Death Date']) {
      targetAction.fields['Death Date'] = action.fields['Death Date'];
    }
    if (action.fields['Death Place'] && !targetAction.fields['Death Place']) {
      targetAction.fields['Death Place'] = action.fields['Death Place'];
    }
    
    // Mark current action as skip (will be merged into target)
    action.status = 'skipped';
    action._mergedInto = targetId;
  }
  
  // Refresh the import review UI
  _renderImportReview();
  closeMatchDialog();
}

export function _imPersonSearch(inp, actionId, fieldKey) {
  const dropId = _imDropId(actionId, fieldKey);
  const drop   = document.getElementById(dropId);
  if (!drop) return;

  const raw    = inp.value.trim();
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;

  const yearM   = raw.match(/\b(\d{4})\b/);
  const qYear   = yearM ? yearM[1] : '';
  let   qRest   = raw.replace(/\b\d{4}\b/, '').trim();
  const maidenM = qRest.match(/\((?:geb\.?\s*|née\s*)?([^)]+)\)/i) ||
                  qRest.match(/\bgeb\.?\s+([A-Za-zÀ-ž]+)/i) ||
                  qRest.match(/\bnée\s+([A-Za-zÀ-ž]+)/i);
  const qMaiden = maidenM ? maidenM[1].toLowerCase().trim() : '';
  if (maidenM) qRest = qRest.replace(maidenM[0], '').trim();
  const qName = qRest.toLowerCase();

  function scoreStr(iName, iMaiden, iYear) {
    let score = 0;
    if (qName) {
      if (iName === qName)                          score += 1.0;
      else if (iName.startsWith(qName))             score += 0.8;
      else if (iName.includes(qName))               score += 0.6;
      else if (iMaiden && iMaiden.includes(qName))  score += 0.55;
      else {
        const words = qName.split(/\s+/).filter(w => w.length > 1);
        if (words.length) {
          const hits = words.filter(w => iName.includes(w) || iMaiden.includes(w));
          if (hits.length) score += 0.35 * hits.length / words.length;
        }
      }
    } else { score += 0.15; }
    if (score <= 0 && !qYear && !qMaiden) return 0;
    if (qMaiden) {
      if (iMaiden && iMaiden.includes(qMaiden)) score += 0.5;
      else if (iName.includes(qMaiden))          score += 0.3;
      else                                        score -= 0.3;
    }
    if (qYear && iYear) {
      const d = Math.abs(+qYear - +iYear);
      if (d === 0) score += 0.5; else if (d <= 2) score += 0.15; else score -= 0.35;
    }
    return score;
  }

  const results = [];
  for (const [id, indi] of state.individuals) {
    const score = scoreStr(
      (indi.name || '').toLowerCase(),
      (indi.maidenName || '').toLowerCase(),
      (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || ''
    );
    if (score > 0.05) results.push({ score, type: 'existing', id, indi });
  }
  for (const pa of state._importActions) {
    if (pa.id === actionId || pa.status === 'skipped') continue;
    const score = scoreStr(
      (pa.fields['Name'] || '').toLowerCase(), '',
      (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || ''
    );
    if (score > 0.05) results.push({ score, type: 'pending', id: pa.id, pa });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 12);
  if (!top.length) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  drop.innerHTML = top.map(r => {
    if (r.type === 'existing') {
      const { id, indi } = r;
      const bYear  = indi.birth?.date?.match(/\b(\d{4})\b/)?.[1] || '';
      const dYear  = indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || '';
      const maiden = indi.maidenName ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: escHtml(indi.maidenName) })}</span>` : '';
      const bPlace = indi.birth?.plac || '';
      const parts  = [];
      if (bYear || bPlace) parts.push((bYear ? '*' + bYear : '') + (bPlace ? (bYear ? ' ' : '') + bPlace : ''));
      if (dYear) parts.push('\u2020' + dYear);
      const detail = parts.join(' \u00b7 ');
      return `<div class="import-sdrop-item" onmousedown="event.preventDefault();_imPersonSelect('${actionId}','${fieldKey}','existing','${id}')">
        <span class="import-sdrop-name">${escHtml(indi.name)}${maiden}</span>
        ${detail ? `<span class="import-sdrop-detail">${detail}</span>` : ''}
      </div>`;
    } else {
      const { id, pa } = r;
      const bYear = (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || '';
      const dYear = (pa.fields['Death Date']||'').match(/\b(\d{4})\b/)?.[1] || '';
      const parts = [];
      if (bYear) parts.push('*' + bYear);
      if (dYear) parts.push('\u2020' + dYear);
      const detail = parts.join(' \u00b7 ');
      return `<div class="import-sdrop-item import-sdrop-item--pending" onmousedown="event.preventDefault();_imPersonSelect('${actionId}','${fieldKey}','pending','${id}')">
        <span class="import-sdrop-name">${escHtml(pa.fields['Name']||'')}</span>
        ${detail ? `<span class="import-sdrop-detail">${detail}</span>` : ''}
      </div>`;
    }
  }).join('');
  drop.style.display = '';
}

export function _imPersonSelect(actionId, fieldKey, type, targetId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};

  const resolveName = (t, id) => t === 'existing'
    ? (state.individuals.get(id)?.name || '')
    : (state._importActions.find(a => a.id === id)?.fields['Name'] || '');

  if (fieldKey === 'Name') {
    if (type !== 'existing') return;
    if (!_imLinkExisting(action, targetId)) return;
  } else if (fieldKey.startsWith('Children:')) {
    action.fieldLinks[fieldKey] = { type, id: targetId };
    const idx = parseInt(fieldKey.split(':')[1]);
    const name = resolveName(type, targetId);
    if (action._childrenArr) action._childrenArr[idx] = name;
    action.fields['Children'] = (action._childrenArr || []).join('; ');
  } else {
    action.fieldLinks[fieldKey] = { type, id: targetId };
    action.fields[fieldKey] = resolveName(type, targetId);
  }

  _imRepaintAction(actionId);
}

export function _imFieldUnlink(actionId, fieldKey) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};
  delete action.fieldLinks[fieldKey];
  _imRepaintAction(actionId);
}

export const _IM_UPDATE_FIELDS = ['Birth Date', 'Birth Place', 'Death Date', 'Death Place', 'Sex', 'Notes'];

export function _imExistingValue(indi, field) {
  switch (field) {
    case 'Birth Date':  return indi.birth?.date || '';
    case 'Birth Place': return indi.birth?.plac || '';
    case 'Death Date':  return indi.death?.date || '';
    case 'Death Place': return indi.death?.plac || '';
    case 'Sex':         return (indi.sex && indi.sex !== 'U') ? indi.sex : '';
    case 'Notes':       return indi.note || '';
    default:            return '';
  }
}

export function _imLinkExisting(action, targetId) {
  const indi = state.individuals.get(targetId);
  if (!indi) return false;

  // Remember the card as it stands — including manual edits — so unlink is
  // genuinely an undo rather than a re-parse.
  if (!action._preLink) {
    action._preLink = { kind: action.kind, status: action.status, fields: { ...action.fields } };
  }
  action.kind       = 'update';
  action.existingId = targetId;
  action.status     = 'approved';
  action.fields     = { ...action.fields, 'Name': indi.name };

  // Keep every incoming value so the card can show what the two sources say.
  // Fill a gap by default; never overwrite something already recorded without
  // being asked — the tree is the thing being edited, the import is a proposal.
  action.fieldApply = {};
  for (const f of _IM_UPDATE_FIELDS) {
    const incoming = (action.fields[f] || '').trim();
    const existing = _imExistingValue(indi, f).trim();
    action.fieldApply[f] = !!incoming && !existing;
  }
  return true;
}

export function _imToggleFieldApply(actionId, field) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action || !action.fieldApply) return;
  action.fieldApply[field] = !action.fieldApply[field];
  _imRepaintAction(actionId);
}

export function _imUnlink(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.existingId = undefined;
  action.fieldApply = undefined;

  const pre = action._preLink;
  if (pre) {
    action.kind   = pre.kind;
    action.status = pre.status;
    action.fields = { ...pre.fields };
    action._preLink = undefined;
  } else {
    // No snapshot: this card arrived already matched, so fall back to the parse.
    const p = action._person;
    action.kind   = 'person';
    action.status = 'pending';
    if (p) {
      action.fields = {
        'Name':         p.fullName,
        'Sex':          p.sex || '',
        'Birth Date':   p.birthDate  || '',
        'Birth Place':  p.birthPlace || '',
        'Death Date':   p.deathDate  || '',
        'Death Place':  p.deathPlace || '',
        'Father':       p.fatherName || '',
        'Mother':       p.motherName || '',
        'Notes':        p.notes      || '',
      };
    }
  }
  _imRepaintAction(actionId);
}

export function _imAddChild(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action._childrenArr = action._childrenArr || [];
  action._childrenArr.push('');
  action.fields['Children'] = action._childrenArr.join('; ');
  _imRepaintAction(actionId);
}

export function _imRemoveChild(actionId, idx) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action || !action._childrenArr) return;
  action._childrenArr.splice(idx, 1);
  action.fieldLinks = action.fieldLinks || {};
  const newLinks = {};
  for (const [k, v] of Object.entries(action.fieldLinks)) {
    if (!k.startsWith('Children:')) { newLinks[k] = v; continue; }
    const i = parseInt(k.split(':')[1]);
    if (i === idx) continue;
    newLinks['Children:' + (i > idx ? i - 1 : i)] = v;
  }
  action.fieldLinks = newLinks;
  action.fields['Children'] = action._childrenArr.join('; ');
  _imRepaintAction(actionId);
}
