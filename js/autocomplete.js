/**
 * The autocomplete dropdown behind the name, place and occupation fields:
 * what to suggest, and the keyboard and mouse handling of the list.
 *
 * Split out of panels.js. Self-contained on purpose — it reads the tree for
 * suggestions and writes into an <input>, and touches nothing else, which is
 * why autocomplete.test.js can drive it on its own.
 */
import { state } from './state.js';
import { escHtml } from './gedcom-io.js';

export function _acInit() {
  if (state._acEl) return;
  state._acEl = document.createElement('div');
  state._acEl.id = 'ac-dropdown';
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
  state._acEl.style.width = r.width + 'px';

  state._acEl.innerHTML = items.map((v, i) => {
    const label = (v && typeof v === 'object') ? v.label : v;
    return `<div class="ac-item" data-i="${i}">${escHtml(label)}</div>`;
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
  state._acInput.value = (item && typeof item === 'object') ? item.value : item;
  state._acInput.dispatchEvent(new Event('input', { bubbles: true }));
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

export function _acPlaces() {
  const s = new Set();
  for (const [, i] of state.individuals) {
    if (i.birth.plac) s.add(i.birth.plac);
    if (i.death.plac) s.add(i.death.plac);
  }
  for (const [, f] of state.families) for (const m of (f.marriages || [])) if (m.plac) s.add(m.plac);
  return [...s].sort();
}

export function _acSurnames() {
  const m = new Map();
  for (const [, i] of state.individuals) {
    // Maiden names belong in this list too: they are surnames the tree already
    // knows, and they are exactly what someone is reaching for when filling in a
    // woman's birth name.
    for (const s of [i.surn, i.maidenName]) if (s) m.set(s, (m.get(s) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

// Given names, commonest first — in a genealogy the same handful come back
// generation after generation, so the top of the list is nearly always the one
// being typed.
export function _acGivenNames() {
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
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

export function _acOccupations() {
  const s = new Set();
  for (const [, i] of state.individuals) if (i.occu) s.add(i.occu);
  return [...s].sort();
}

export function _acAttach(input, getFn) {
  if (!input || input.dataset.acAttached) return;
  input.dataset.acAttached = '1';
  input.setAttribute('autocomplete', 'off');

  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { _acHide(); return; }
    const hits = getFn().filter(v => {
      const text = (v && typeof v === 'object') ? (v.searchText ?? v.label) : v;
      return text.toLowerCase().includes(q);
    }).slice(0, 12);
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
// all of them at once, and wires the next one somebody adds without their having
// to remember a list. The previous version named six specific ids, which is why
// only the main edit form ever had this.
const _AC_FIELDS = [
  ['-givn',   () => _acGivenNames()],
  ['-surn',   () => _acSurnames()],
  ['-maiden', () => _acSurnames()],
  ['-bplac',  () => _acPlaces()],
  ['-dplac',  () => _acPlaces()],
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
}
