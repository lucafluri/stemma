/**
 * Finding people by more than their name.
 *
 * The sidebar box answers "where is Hans Fluri". This answers the questions a
 * tree is actually built to ask — everyone born in Luterbach before 1850,
 * every woman who married in the 1890s, everyone whose death is still
 * unrecorded — which no amount of scrolling the chart will.
 *
 * Every criterion is optional and they all narrow together (AND). An empty
 * form matches everybody, which is a useful thing to ask for: sorted by name,
 * it is the index of the tree.
 */

import { escAttr, escHtml } from './gedcom-io.js';
import { foldText } from './places.js';
import { applyHighlight, updateHLButtons } from './relations.js';
import { goToPerson } from './graph-data.js';
import { state } from './state.js';

// Dates in a GEDCOM are free text — "ABT 1850", "12 MAR 1901", "BEF 1900".
// A year is all a range filter can honestly use.
const yearOf = s => {
  const m = String(s || '').match(/\b(\d{3,4})\b/);
  return m ? +m[1] : null;
};

/** Every place recorded against a person, including where they married. */
function placesOf(indi) {
  const out = [indi.birth?.plac, indi.death?.plac];
  for (const famId of indi.fams || []) {
    for (const m of state.families.get(famId)?.marriages || []) out.push(m.plac);
  }
  return out.filter(Boolean);
}

/** Every marriage year recorded for a person. */
function marriageYearsOf(indi) {
  const out = [];
  for (const famId of indi.fams || []) {
    for (const m of state.families.get(famId)?.marriages || []) {
      const y = yearOf(m.date);
      if (y) out.push(y);
    }
  }
  return out;
}

const inRange = (v, from, to) =>
  (from == null || (v != null && v >= from)) &&
  (to == null || (v != null && v <= to));

/**
 * Does one person match the criteria? Split out from the search so the rules
 * can be tested without a DOM.
 *
 * Criteria (all optional):
 *   name, place, occupation  — folded substring match
 *   sex                      — 'M' | 'F' | 'U'
 *   status                   — 'living' | 'deceased'
 *   bornFrom/bornTo, diedFrom/diedTo, marriedFrom/marriedTo — years
 *   missing                  — 'birth' | 'death' | 'place' | 'sex' | 'parents'
 */
export function matchPerson(indi, c = {}) {
  if (c.name) {
    const q = foldText(c.name);
    // Maiden name included: looking for "Anna Meier" has to find the woman
    // filed under her married name, which is the whole point of recording it.
    const hay = foldText([indi.name, indi.givn, indi.surn, indi.maidenName].filter(Boolean).join(' '));
    if (q && !hay.includes(q)) return false;
  }

  if (c.place) {
    const q = foldText(c.place);
    if (q && !placesOf(indi).some(p => foldText(p).includes(q))) return false;
  }

  if (c.occupation) {
    const q = foldText(c.occupation);
    if (q && !foldText(indi.occu).includes(q)) return false;
  }

  if (c.sex) {
    const sex = indi.sex === 'M' || indi.sex === 'F' ? indi.sex : 'U';
    if (sex !== c.sex) return false;
  }

  if (c.status === 'living' && indi.deceased) return false;
  if (c.status === 'deceased' && !indi.deceased) return false;

  // The estimated birth year the layout uses is deliberately not consulted: a
  // filter that answers "born before 1850" partly from guesses reads as a
  // finding and is not one.
  if (c.bornFrom != null || c.bornTo != null) {
    if (!inRange(yearOf(indi.birth?.date), c.bornFrom, c.bornTo)) return false;
  }
  if (c.diedFrom != null || c.diedTo != null) {
    if (!inRange(yearOf(indi.death?.date), c.diedFrom, c.diedTo)) return false;
  }
  if (c.marriedFrom != null || c.marriedTo != null) {
    const years = marriageYearsOf(indi);
    if (!years.some(y => inRange(y, c.marriedFrom, c.marriedTo))) return false;
  }

  // The inverse search: what still needs doing. Every genealogy has a list of
  // people whose dates were never filled in, and it is invisible in the chart.
  switch (c.missing) {
    case 'birth':   if (yearOf(indi.birth?.date)) return false; break;
    case 'death':   if (!indi.deceased || yearOf(indi.death?.date)) return false; break;
    case 'place':   if (placesOf(indi).length) return false; break;
    case 'sex':     if (indi.sex === 'M' || indi.sex === 'F') return false; break;
    case 'parents': if ((indi.famc || []).length) return false; break;
  }

  return true;
}

// String#localeCompare builds a collator per call; one shared one sorts a
// 50,000-name result in a fraction of the time.
const _collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Everyone matching, by name. */
export function findPeople(criteria = {}) {
  const hits = [];
  for (const [id, indi] of state.individuals) {
    if (matchPerson(indi, criteria)) hits.push({ id, indi });
  }
  hits.sort((a, b) =>
    _collator.compare(a.indi.displayName || a.indi.name || a.id, b.indi.displayName || b.indi.name || b.id));
  return hits;
}

// ── The dialog ────────────────────────────────────────────────────────────

const NUM = id => {
  const v = document.getElementById(id)?.value.trim();
  return v ? Number(v) : null;
};
const STR = id => document.getElementById(id)?.value.trim() || '';

/** Read the form. Exported so a test can drive the dialog end to end. */
export function findCriteria() {
  return {
    name: STR('find-name'),
    place: STR('find-place'),
    occupation: STR('find-occupation'),
    sex: STR('find-sex'),
    status: STR('find-status'),
    missing: STR('find-missing'),
    bornFrom: NUM('find-born-from'), bornTo: NUM('find-born-to'),
    diedFrom: NUM('find-died-from'), diedTo: NUM('find-died-to'),
    marriedFrom: NUM('find-married-from'), marriedTo: NUM('find-married-to'),
  };
}

export function openFindTool() {
  const modal = document.getElementById('find-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  runFind();
  document.getElementById('find-name')?.focus();
}

export function closeFindTool() {
  const modal = document.getElementById('find-modal');
  if (modal) modal.style.display = 'none';
}

export function resetFindTool() {
  for (const el of document.querySelectorAll('#find-form input, #find-form select')) el.value = '';
  runFind();
}

// The form runs the search on every keystroke. A small tree answers at once;
// a large one waits for the typing to pause, so a name typed letter by letter
// is one search rather than eight.
let _findTimer = 0;
export function scheduleFind() {
  clearTimeout(_findTimer);
  _findTimer = setTimeout(runFind, state.individuals.size > 5000 ? 180 : 0);
}

export function runFind() {
  const box = document.getElementById('find-results');
  if (!box) return;
  const hits = findPeople(findCriteria());
  state._findHits = hits.map(h => h.id);

  document.getElementById('find-count').textContent =
    t('find.count', { n: hits.length, total: state.individuals.size });
  const hlBtn = document.getElementById('find-highlight-btn');
  if (hlBtn) hlBtn.disabled = !hits.length;

  if (!hits.length) {
    box.innerHTML = `<div class="pl-empty">${escHtml(t('find.none'))}</div>`;
    return;
  }

  // Capped like the sidebar search: a list of two thousand rows helps nobody,
  // and the count above already says how many there really are.
  const LIMIT = 300;
  box.innerHTML = hits.slice(0, LIMIT).map(({ id, indi }) => {
    const born = yearOf(indi.birth?.date);
    const died = yearOf(indi.death?.date);
    const years = born || died ? `${born || '?'}–${died || (indi.deceased ? '?' : '')}` : '';
    const where = (indi.birth?.plac || indi.death?.plac || '').trim();
    return `<button class="find-row" onclick="findGoTo('${escAttr(id).replace(/'/g, "\\'")}')">
      <span class="find-row-name">${escHtml(indi.displayName || indi.name || id)}</span>
      ${years ? `<span class="find-row-years">${escHtml(years)}</span>` : ''}
      ${where ? `<span class="find-row-place">${escHtml(where)}</span>` : ''}
    </button>`;
  }).join('') +
    (hits.length > LIMIT ? `<div class="pl-empty">${escHtml(t('find.capped', { n: LIMIT }))}</div>` : '');
}

/**
 * Light up every match in the chart at once.
 *
 * Reuses the highlight the ancestor/descendant buttons drive, so "clear
 * highlight" in the sidebar undoes this too, and the 3D view follows along.
 * `hlMode` stays null: the mode names which walk produced the set, and this
 * set came from a query rather than from a walk out of one person.
 */
export function highlightFindMatches() {
  const ids = state._findHits || [];
  if (!ids.length) return;
  state.hlMode = null;
  state.hlSet = new Set(ids);
  state._hlAncestorCount = 0;
  state._hlDescendantCount = 0;
  applyHighlight();
  updateHLButtons();
  closeFindTool();
  document.getElementById('status').textContent = t('find.highlighted', { n: ids.length });
}

/** Open a result in the detail panel and bring it into view. */
export function findGoTo(id) {
  closeFindTool();
  goToPerson(id);
}
