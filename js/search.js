/**
 * Finding a person by name, fast enough to run on every keystroke of a
 * 100,000-person file.
 *
 * The sidebar box, the relation tool and every "pick a person" field used to
 * each walk the whole tree their own way, and stop at the first handful of
 * hits in file order — so typing "Anna" offered whichever eight Annas happened
 * to be listed first, not the one called Anna. This builds one folded index per
 * version of the tree and ranks what matches: the whole name, then names whose
 * words start with what was typed, then anything containing it.
 */

import { state } from './state.js';
import { foldText } from './places.js';

let _index = null;
let _indexKey = '';

function _entries() {
  const key = `${state._dataVersion}|${state.individuals.size}`;
  if (_index && _indexKey === key) return _index;
  _index = [];
  for (const [id, p] of state.individuals) {
    const hay = foldText([p.name, p.givn, p.surn, p.maidenName].filter(Boolean).join(' '));
    _index.push({ id, hay, words: hay.split(' '), name: foldText(p.name || '') });
  }
  _indexKey = key;
  return _index;
}

/** Forget the index (the tree changed in a way the version does not show). */
export function invalidateSearch() { _index = null; }

/**
 * People matching `query`, best first: [{ id, score }].
 * Every typed word has to appear; words that start a name word rank above
 * words found in the middle of one. The id itself matches too ("@I12@", "I12").
 */
export function searchPeople(query, limit = 25, { exclude = null } = {}) {
  const q = foldText(query);
  if (!q) return [];
  const qt = q.split(' ');
  const hits = [];
  const idq = String(query).trim().replace(/^@|@$/g, '').toUpperCase();
  for (const e of _entries()) {
    if (exclude && exclude.has?.(e.id)) continue;
    let score;
    if (e.name === q) score = 0;
    else {
      let prefixAll = true, ok = true;
      for (const tok of qt) {
        if (e.words.some(w => w.startsWith(tok))) continue;
        prefixAll = false;
        if (!e.hay.includes(tok)) { ok = false; break; }
      }
      if (!ok) {
        if (idq && e.id.replace(/@/g, '').toUpperCase() === idq) score = 0.5;
        else continue;
      } else score = prefixAll ? 1 : 2;
    }
    hits.push({ id: e.id, score, len: e.hay.length });
  }
  hits.sort((a, b) => a.score - b.score || a.len - b.len);
  return hits.slice(0, limit);
}

/** "Anna Muster (née Beispiel) *1901" — the label every picker shows. */
export function personLabel(id) {
  const p = state.individuals.get(id);
  if (!p) return id;
  const yr = p.birthYear || state._estimatedYears?.get(id);
  const est = !p.birthYear && yr ? '~' : '';
  const maiden = p.maidenName && !(p.name || '').includes(p.maidenName)
    ? ` (${t('tooltip.born', { name: p.maidenName })})` : '';
  return `${p.name || id}${maiden}${yr ? ` *${est}${yr}` : ''}`;
}
