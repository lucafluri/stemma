/**
 * The autocomplete dropdown behind the name, place, occupation and person
 * fields: what to suggest, and the keyboard and mouse handling of the list.
 *
 * Self-contained on purpose — it reads the tree for suggestions and writes into
 * an <input>, and touches nothing else, which is why autocomplete.test.js can
 * drive it on its own.
 *
 * The suggestion lists are built from the whole tree, so they are built once
 * per version of it (state._dataVersion) rather than on every keystroke: on a
 * large file that was a full walk and a sort per key pressed. Person fields do
 * not list anybody up front at all — they ask the search index for the dozen
 * best matches, where they used to render every person in the file into a
 * <datalist>, three times over in the family editor.
 */
import { state } from './state.js';
import { escHtml } from './gedcom-io.js';
import { personLabel, searchPeople } from './search.js';

export function _acInit() {
  if (state._acEl) return;
  state._acEl = document.createElement('div');
  state._acEl.id = 'ac-dropdown';
  state._acEl.setAttribute('role', 'listbox');
  document.body.appendChild(state._acEl);
}

export function _acShow(input, items) {
  _acInit();
  state._acInput = input;
  state._acList  = items;
  state._acIdx   = -1;

  const r = input.getBoundingClientRect();
  state._acEl.style.left  = r.left + 'px';
  state._acEl.style.top   = (r.bottom + 2) + 'px';
  state._acEl.style.width = Math.max(r.width, 180) + 'px';

  state._acEl.innerHTML = items.map((v, i) => {
    const label = (v && typeof v === 'object') ? v.label : v;
    return `<div class="ac-item" role="option" data-i="${i}">${escHtml(label)}</div>`;
  }).join('');
  state._acEl.querySelectorAll('.ac-item').forEach(el =>
    el.addEventListener('mousedown', e => { e.preventDefault(); _acPick(+el.dataset.i); })
  );
  state._acEl.style.display = 'block';
}

export function _acHide() {
  if (state._acEl) state._acEl.style.display = 'none';
  state._acInput = null;
  state._acIdx   = -1;
}

export function _acPick(i) {
  if (!state._acInput || i < 0 || i >= state._acList.length) return;
  const item = state._acList[i];
  const input = state._acInput;
  input.value = (item && typeof item === 'object') ? item.value : item;
  // A person field remembers *who* was picked, not only the text: two people
  // can share a name, and the text alone cannot say which one was meant.
  if (item && typeof item === 'object' && item.id) {
    input.dataset.personId = item.id;
    input.dataset.personLabel = input.value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  _acHide();
}

export function _acNav(dir) {
  if (!state._acEl || state._acEl.style.display === 'none') return false;
  const els = state._acEl.querySelectorAll('.ac-item');
  if (!els.length) return false;
  state._acIdx = Math.max(0, Math.min(els.length - 1, state._acIdx + dir));
  els.forEach((el, i) => el.classList.toggle('ac-active', i === state._acIdx));
  els[state._acIdx]?.scrollIntoView({ block: 'nearest' });
  return true;
}

// One cached list per kind, rebuilt when the tree has changed since.
const _memo = new Map();
function _cached(kind, build) {
  const key = `${state._dataVersion}|${state.individuals.size}|${state.families.size}`;
  const hit = _memo.get(kind);
  if (hit && hit.key === key) return hit.list;
  const list = build();
  _memo.set(kind, { key, list });
  return list;
}

const _byFrequency = m => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([s]) => s);

export function _acPlaces() {
  return _cached('places', () => {
    const m = new Map();
    const add = v => { if (v) m.set(v, (m.get(v) || 0) + 1); };
    for (const [, i] of state.individuals) { add(i.birth?.plac); add(i.death?.plac); }
    for (const [, f] of state.families) for (const mm of (f.marriages || [])) add(mm.plac);
    // Commonest first: in a genealogy the same few villages come back again and
    // again, and the one being typed is nearly always one of them.
    return _byFrequency(m);
  });
}

export function _acSurnames() {
  return _cached('surnames', () => {
    const m = new Map();
    for (const [, i] of state.individuals) {
      // Maiden names belong in this list too: they are surnames the tree already
      // knows, and they are exactly what someone is reaching for when filling in
      // a woman's birth name.
      for (const s of [i.surn, i.maidenName]) if (s) m.set(s, (m.get(s) || 0) + 1);
    }
    return _byFrequency(m);
  });
}

// Given names, commonest first — in a genealogy the same handful come back
// generation after generation, so the top of the list is nearly always the one
// being typed.
export function _acGivenNames() {
  return _cached('given', () => {
    const m = new Map();
    for (const [, i] of state.individuals) {
      const g = (i.givn || '').trim();
      if (!g) continue;
      m.set(g, (m.get(g) || 0) + 1);
      // Offer the parts of a double name as well, so "Hans Peter" also suggests
      // "Hans" — and typing "Peter" finds it, which a whole-string match would not.
      for (const part of g.split(/\s+/)) {
        if (part && part !== g) m.set(part, (m.get(part) || 0) + 1);
      }
    }
    return _byFrequency(m);
  });
}

export function _acOccupations() {
  return _cached('occupations', () => {
    const m = new Map();
    for (const [, i] of state.individuals) if (i.occu) m.set(i.occu, (m.get(i.occu) || 0) + 1);
    return _byFrequency(m);
  });
}

/** The best dozen people for what has been typed, as picker items. */
export function _acPeople(query, exclude) {
  return searchPeople(query, 12, { exclude }).map(h => {
    const label = personLabel(h.id);
    return { label, value: label, id: h.id };
  });
}

export function _acAttach(input, getFn, opts = {}) {
  if (!input || input.dataset.acAttached) return;
  input.dataset.acAttached = '1';
  input.setAttribute('autocomplete', 'off');

  const refresh = () => {
    const q = input.value.trim();
    // Typing over a picked person un-picks them.
    if (input.dataset.personId && input.value !== input.dataset.personLabel) delete input.dataset.personId;
    if (!q) { _acHide(); return; }
    let hits;
    if (opts.query) {
      hits = getFn(q);
    } else {
      const ql = q.toLowerCase();
      hits = [];
      for (const v of getFn()) {
        const text = (v && typeof v === 'object') ? (v.searchText ?? v.label) : v;
        if (text.toLowerCase().includes(ql)) { hits.push(v); if (hits.length >= 12) break; }
      }
    }
    if (hits.length) _acShow(input, hits); else _acHide();
  };

  input.addEventListener('input',  refresh);
  input.addEventListener('focus',  refresh);
  input.addEventListener('blur',   () => setTimeout(_acHide, 160));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); _acNav(+1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _acNav(-1); }
    else if (e.key === 'Enter' && state._acIdx >= 0) { e.preventDefault(); _acPick(state._acIdx); }
    else if (e.key === 'Escape') _acHide();
  });
}

// Which suggestions a field gets, decided by what the field is rather than by
// its id. Every form in the panel builds its inputs with the same suffixes —
// `-givn`, `-surn`, `-bplac` and so on — whether it is the main edit form, a
// quick-add relative, a new partner or a new child. Matching on the suffix wires
// all of them at once, and wires the next one somebody adds.
const _AC_FIELDS = [
  ['-givn',   () => _acGivenNames()],
  ['-surn',   () => _acSurnames()],
  ['-maiden', () => _acSurnames()],
  ['-bplac',  () => _acPlaces()],
  ['-dplac',  () => _acPlaces()],
  ['-mplac',  () => _acPlaces()],
  ['-plac',   () => _acPlaces()],
  ['-occu',   () => _acOccupations()],
];

export function _acAttachFields(root) {
  const scope = root || document.getElementById('detail-content');
  if (!scope) return;
  for (const [suffix, getFn] of _AC_FIELDS) {
    for (const input of scope.querySelectorAll(`input[id$="${suffix}"]`)) {
      _acAttach(input, getFn);
    }
  }
  // Person pickers carry data-person-picker; the value is the id to leave out
  // (the person being edited cannot be their own relative).
  for (const input of scope.querySelectorAll('input[data-person-picker]')) {
    const self = input.dataset.personPicker;
    _acAttach(input, q => _acPeople(q, self ? new Set([self]) : null), { query: true });
  }
}
