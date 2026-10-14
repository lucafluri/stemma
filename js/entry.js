// Keyboard and typing conveniences for the entry forms in the detail panel.
// Everything here is delegated from the document, because the forms are
// rebuilt as HTML every time the panel changes.
//
//  - dates: a live preview of how a typed date will be stored, and tidying it
//    into that form when the field is left
//  - sex: filled in from the first name when the tree already knows it
//  - Enter saves / adds, Esc cancels, from any field of a form
import { state } from './state.js';
import { parseLooseDate } from './dates.js';
import { initials } from './life.js';

// ── Dates ───────────────────────────────────────────────────────────────────

const _year = v => { const m = String(v || '').match(/\b(\d{3,4})\b/); return m ? +m[1] : null; };

/** True when this is a birth or death date and the pair, both filled in, is the wrong way round. */
function _deathBeforeBirth(wrap) {
  const m = wrap?.id?.match(/^(.*)-(bdate|ddate)$/);
  if (!m) return false;
  const other = document.getElementById(`${m[1]}-${m[2] === 'bdate' ? 'ddate' : 'bdate'}`);
  const val = el => parseLooseDate(el?.querySelector('.gd-text')?.value || '').value;
  const b = _year(val(m[2] === 'bdate' ? wrap : other)), d = _year(val(m[2] === 'bdate' ? other : wrap));
  return !!(b && d && d < b);
}

function _preview(input) {
  const wrap = input.closest('.gd-widget');
  const pv = wrap?.querySelector('.gd-preview');
  if (!pv) return;
  const typed = input.value.replace(/\s+/g, ' ').trim();
  const r = parseLooseDate(typed);
  pv.className = 'gd-preview';
  if (!typed) { pv.textContent = ''; return; }
  // Somebody cannot die before they are born; say so the moment both are typed.
  const order = _deathBeforeBirth(wrap);
  if (order) {
    pv.textContent = (r.ok && r.value !== typed ? '→ ' + r.value + ' · ' : '') + t('dateWidget.deathBeforeBirth');
    pv.classList.add('gd-preview--warn');
    return;
  }
  if (!r.ok) {
    pv.textContent = t('dateWidget.keptAsTyped');
    pv.classList.add('gd-preview--warn');
  } else if (r.value !== typed) {
    pv.textContent = '→ ' + r.value;
    pv.classList.add('gd-preview--ok');
  } else {
    pv.textContent = '';
  }
}

document.addEventListener('input', e => {
  const el = e.target;
  if (el?.matches?.('.gd-text')) _preview(el);
});

// Leaving the field writes the understood form back, so what is on screen is
// what will be saved. An unrecognised date is left alone.
document.addEventListener('focusout', e => {
  const el = e.target;
  if (!el?.matches?.('.gd-text')) return;
  const r = parseLooseDate(el.value);
  if (r.ok && r.value !== el.value) el.value = r.value;
  _preview(el);
});

// ── Sex from the first name ─────────────────────────────────────────────────

let _sexKey = '', _sexMap = null;

function _sexByGiven() {
  const key = `${state._dataVersion}|${state.individuals.size}`;
  if (_sexMap && key === _sexKey) return _sexMap;
  _sexKey = key;
  _sexMap = new Map();
  for (const [, p] of state.individuals) {
    if (p.sex !== 'M' && p.sex !== 'F') continue;
    const g = (p.givn || '').trim().split(/\s+/)[0]?.toLowerCase();
    if (!g) continue;
    const c = _sexMap.get(g) || { M: 0, F: 0 };
    c[p.sex]++;
    _sexMap.set(g, c);
  }
  return _sexMap;
}

/** 'M' | 'F' when the tree is clear about it for this first name, else ''. */
export function guessSex(givn) {
  const g = String(givn || '').trim().split(/\s+/)[0]?.toLowerCase();
  if (!g) return '';
  const c = _sexByGiven().get(g);
  if (!c) return '';
  const n = c.M + c.F;
  if (n < 2 && Math.abs(c.M - c.F) < 1) return '';
  if (c.M / n >= 0.85) return 'M';
  if (c.F / n >= 0.85) return 'F';
  return '';
}

document.addEventListener('input', e => {
  const el = e.target;
  if (!el?.id || !/-givn$/.test(el.id) || !el.closest?.('#detail-content')) return;
  const sel = document.getElementById(el.id.replace(/givn$/, 'sex'));
  if (!sel) return;
  // Only ever fill in a blank, or a value this code put there: a choice the
  // person made is theirs.
  if (sel.value !== 'U' && sel.dataset.auto !== '1') return;
  const g = guessSex(el.value);
  sel.value = g || 'U';
  sel.dataset.auto = g ? '1' : '';
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el?.matches?.('#detail-content select[id$="-sex"]')) el.dataset.auto = '';
});

// ── Enter / Esc ─────────────────────────────────────────────────────────────

const SUBFORMS = '#qa-parent-form, #qa-spouse-form, #qa-child-form, #qa-sibling-form, #ef-new-person-subform, ' +
  '#ef-fam-new-child-form, #ef-new-husb-form, #ef-new-wife-form';
// What a sub-form's Enter presses: the quick-add forms say "Add" with the save
// style, the family editor's inline forms with the small "+" style.
const SUBMIT = '.edit-save-btn, .ef-rel-add-btn';

function _acOpen() {
  return !!state._acEl && state._acEl.style.display === 'block' && state._acIdx >= 0;
}

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  const el = e.target;
  if (!el?.closest?.('#detail-content')) return;

  if (e.key === 'Enter') {
    if (e.shiftKey || !el.matches('input:not([type=checkbox]):not([type=button]):not([type=file])')) return;
    if (_acOpen()) return;
    // A person search box next to its "+": Enter is the +.
    if (el.matches('#ef-rel-person, #ef-fam-chil-search')) {
      const go = el.closest('.ef-rel-add-row')?.querySelector('.ef-rel-add-btn');
      if (go) { e.preventDefault(); go.click(); }
      return;
    }
    const sub = el.closest(SUBFORMS);
    if (sub) {
      const go = sub.querySelector(SUBMIT);
      if (go) { e.preventDefault(); go.click(); }
      return;
    }
    if (state._editingId) {
      const go = document.querySelector('#detail-content .edit-form-buttons .edit-save-btn');
      if (go) { e.preventDefault(); go.click(); }
    }
  } else if (e.key === 'Escape') {
    if (_acOpen() || (state._acEl && state._acEl.style.display === 'block')) return;
    const sub = el.closest(SUBFORMS);
    if (sub) {
      const no = sub.querySelector('.edit-cancel-btn');
      if (no) { e.preventDefault(); no.click(); }
      return;
    }
    if (state._editingId) {
      const no = document.querySelector('#detail-content .edit-form-buttons .edit-cancel-btn');
      if (no) { e.preventDefault(); no.click(); }
    }
  }
});

// ── Deceased follows the death fields ───────────────────────────────────────
document.addEventListener('input', e => {
  const el = e.target;
  if (!el?.closest?.('#ef-death-fields') || !el.value) return;
  const box = document.getElementById('ef-dead');
  if (box && !box.checked) box.checked = true;
});

// ── The panel header follows the name being typed ───────────────────────────
document.addEventListener('input', e => {
  const el = e.target;
  if (!el?.id || (el.id !== 'ef-givn' && el.id !== 'ef-surn')) return;
  if (!state._isNewRecord) return;
  const name = `${document.getElementById('ef-givn')?.value || ''} ${document.getElementById('ef-surn')?.value || ''}`.replace(/\s+/g, ' ').trim();
  const h = document.getElementById('detail-name');
  if (h) h.textContent = name || t('detail.newPerson');
  const av = document.getElementById('detail-avatar');
  if (av) av.textContent = initials(name);
});
