/**
 * Reading an import source into people: name/date normalisation, the text
 * parser, the structured JSON and GEDCOM readers, and the merge itself —
 * which actions a parsed file implies, what applying them does, and whether
 * the result would hang off the existing tree.
 *
 * Split out of import.js, which had grown to hold both this and the whole
 * review dialog. Nothing here touches the DOM: it takes text or objects and
 * returns people and actions, which is why it can be tested on its own.
 */
import { state } from './state.js';

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
