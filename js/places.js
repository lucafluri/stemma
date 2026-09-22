/**
 * Place-name cleanup.
 *
 * A tree assembled from several sources spells the same village a dozen ways:
 * "Zürich", "Zurich", "zürich ", "Zürich, CH". They are different strings, so
 * every list built off them (the place autocomplete, any future grouping)
 * treats them as different places.
 *
 * This module finds the variants, proposes one spelling per group, and — only
 * once the user has confirmed each group — rewrites the records. Nothing here
 * changes data on its own: merging place names is not reversible from inside
 * the app, so every rename is something the user ticked.
 */

import { _setDirty, escAttr, escHtml } from './gedcom-io.js';
import { showFamDetail, showIndiDetail } from './panels.js';
import { state } from './state.js';

// ── Where places live ─────────────────────────────────────────────────────
//
// Three fields, and the tool has to agree with the exporter about which they
// are — a place the collector misses is a place the merge silently leaves
// behind. Both the read and the write below go through this one walk.
export function* placeFields() {
  for (const indi of state.individuals.values()) {
    if (indi.birth) yield indi.birth;
    if (indi.death) yield indi.death;
  }
  for (const fam of state.families.values()) {
    for (const m of fam.marriages || []) yield m;
  }
}

/**
 * The one way to write a place onto a record.
 *
 * A place field may carry `map: [lat, lon]`, looked up for the name that was
 * there when it was looked up. Change the name and that coordinate is a claim
 * about a different village — so every writer goes through here and the two
 * fields cannot drift apart. Detail-panel edits, import merges and the
 * place-name tool all used to set `.plac` directly, which is how a person moved
 * from Bern to Basel and kept Bern's pin on the map.
 *
 * Returns true when the name actually changed.
 */
export function setPlace(field, value) {
  const next = String(value == null ? '' : value).trim();
  if (!field || next === field.plac) return false;
  field.plac = next;
  delete field.map;
  return true;
}

/**
 * Fold text for comparison: case, accents and punctuation dropped, whitespace
 * collapsed. "St. Gallen", "St Gallen" and "ST.  GALLEN" all fold to
 * "st gallen". Names want the same treatment as places — nobody types the
 * umlaut in "Müller" when they are looking something up.
 */
export function foldText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')            // combining accents left by NFD
    .replace(/ß/gi, 'ss')              // NFD leaves this one alone
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The folded form of a place name, under the name the rest of this file uses. */
export const placeKey = foldText;

/** Every distinct place string in the tree, with how many fields use it. */
export function collectPlaces() {
  const counts = new Map();
  for (const f of placeFields()) {
    const v = f.plac;
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

/** True when two keys differ by at most one insert, delete or substitution. */
export function within1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (short.length === long.length) i++;   // substitution
    j++;                                     // insertion into `long`
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

/**
 * The locality: everything before the first comma, folded.
 *
 * Places are written "town, municipality, country", and it is the tail that
 * varies between sources — "Luterbach", "Luterbach, CH" and "Luterbach,
 * Solothurn, Schweiz" are one village written by three people. Comparing the
 * whole string misses all three; comparing the first component catches them.
 */
export function placeLocality(s) {
  return placeKey(String(s == null ? '' : s).split(',')[0]);
}

// A typo check is only safe on a name long enough that one edit is unlikely to
// land on a different real place. "Bern"/"Born" and "Sion"/"Sitten" are each a
// single edit apart and are not the same village.
const TYPO_MIN_LEN = 5;

/**
 * Do two place names look like the same place written differently?
 *
 * In order of how much it is trusted:
 *   1. same locality — the tails may disagree entirely ("Luterbach, CH" vs
 *      "Luterbach, Solothurn, Schweiz");
 *   2. locality one typo apart, if it is long enough to risk it;
 *   3. the whole string one typo apart;
 *   4. one name's words are a subset of the other's ("Bern" ⊂ "Bern Schweiz"),
 *      which covers the files that use spaces where others use commas.
 *
 * Nothing here decides anything on its own: only spellings that fold to the
 * *same* key arrive pre-ticked, everything matched by these rules is offered
 * unticked. Same locality with a contradicting tail — "Neuchâtel, Suisse" and
 * "Neuchâtel, France" — is exactly the case that has to stay a suggestion.
 */
export function looksRelated(a, b) {
  return _related(placeKey(a), new Set([placeLocality(a)]),
                  placeKey(b), new Set([placeLocality(b)]));
}

// Split out from looksRelated so the O(k²) pass in groupPlaces can fold each
// name once instead of once per comparison.
function _related(ka, la, kb, lb) {
  if (ka === kb) return true;

  for (const x of la) {
    if (!x) continue;
    for (const y of lb) {
      if (!y) continue;
      if (x === y) return true;
      if (x.length >= TYPO_MIN_LEN && y.length >= TYPO_MIN_LEN && within1(x, y)) return true;
    }
  }

  if (ka.length >= TYPO_MIN_LEN && kb.length >= TYPO_MIN_LEN && within1(ka, kb)) return true;

  const ta = new Set(ka.split(' ')), tb = new Set(kb.split(' '));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size === 0 || small.size === big.size) return false;
  for (const tok of small) if (!big.has(tok)) return false;
  return true;
}

/**
 * How well-formed a spelling looks, for choosing between equally common ones.
 * Capitalisation matters most (it is what makes "zurich" the wrong pick),
 * then accents — a name that kept them is the one that was typed carefully —
 * then tidy punctuation.
 */
function _spellingScore(v) {
  const titled = /^\p{Lu}/u.test(v) && v !== v.toUpperCase();
  const accented = v !== v.normalize('NFD').replace(/\p{M}/gu, '');
  return (titled ? 4 : 0) + (accented ? 2 : 0) + (tidyPlace(v) === v ? 1 : 0);
}

/**
 * Group the tree's places into candidate merges.
 *
 * Returns one entry per group of two or more spellings, commonest first:
 *   { canonical, total, variants: [{ value, count, exact, forced }] }
 *
 * `exact` marks a variant that differs from the canonical only in case,
 * accents or punctuation — those are safe enough to arrive pre-ticked. The
 * looser matches (typos, extra qualifiers) come in unticked.
 *
 * `merges` are groupings the user made by hand: arrays of place names that
 * belong in one group whatever the heuristics think. No rule catches every
 * pair — "Sankt Gallen" and "S. Gallen" share neither a locality nor a token —
 * so saying so directly has to be possible. Hand-picked variants are `forced`,
 * and arrive ticked: they were named on purpose.
 *
 * A hand-made group is *exactly* its members. Naming a place that the
 * heuristics had already put somewhere takes it out of there — otherwise
 * picking two spellings and asking for a new group would silently drag both
 * their old groups in with them, which is the opposite of what was asked.
 * Whatever is left behind goes back to being grouped automatically.
 */
export function groupPlaces(counts = collectPlaces(), { merges = [] } = {}) {
  // The union-find runs over place *values*, not over folded keys: only values
  // can express "these two spellings, and not the third one that folds like
  // them". The exact-match tier is the first thing it unions, so folded-equal
  // spellings still travel together unless a hand merge separates them.
  const values = [...counts.keys()].filter(v => placeKey(v));
  const parent = new Map(values.map(v => [v, v]));
  const find = v => { while (parent.get(v) !== v) { parent.set(v, parent.get(parent.get(v))); v = parent.get(v); } return v; };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };

  const forced = new Set();
  for (const group of merges) for (const v of group) if (parent.has(v)) forced.add(v);

  // Hand-picked places sit out the automatic pass entirely — being named is
  // the whole statement, and an automatic edge would put back the grouping the
  // user just overrode.
  const free = values.filter(v => !forced.has(v));

  const byKey = new Map();
  for (const v of free) {
    const k = placeKey(v);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(v);
  }
  for (const vs of byKey.values()) for (let i = 1; i < vs.length; i++) union(vs[0], vs[i]);

  // Then join keys that only look related. Comparing every pair of distinct
  // spellings is O(k²) — a large tree has thousands of places, and that was
  // seventeen seconds before the dialog appeared. Instead each rule of
  // _related() gets an index that can only produce pairs it might accept, and
  // _related() itself still has the last word on every pair, so the groups are
  // exactly the ones the pairwise loop made.
  const keys = [...byKey.keys()];
  // Folding drops commas, so a key cannot say where its locality ended. Both
  // spellings behind one key are asked: "Bern, CH" and "Bern CH" fold alike
  // but only the first knows that "bern" is the town.
  const locs = new Map(keys.map(k => [k, new Set(byKey.get(k).map(placeLocality))]));
  const join = (a, b) => union(byKey.get(a)[0], byKey.get(b)[0]);
  const tryJoin = (a, b) => { if (a !== b && _related(a, locs.get(a), b, locs.get(b))) join(a, b); };
  const bucket = (m, k, v) => { let arr = m.get(k); if (!arr) m.set(k, arr = []); arr.push(v); };

  // 1. The same locality: everything in one bucket belongs together.
  const byLoc = new Map();
  for (const k of keys) for (const l of locs.get(k)) if (l) bucket(byLoc, l, k);
  for (const ks of byLoc.values()) for (let i = 1; i < ks.length; i++) join(ks[0], ks[i]);

  // 2./3. One typo apart — in the locality or in the whole name. Two strings one
  // edit apart always share a "delete one letter" variant.
  const byDel = new Map();
  const delKeys = w => { const out = new Set([w]); for (let i = 0; i < w.length; i++) out.add(w.slice(0, i) + w.slice(i + 1)); return out; };
  for (const k of keys) {
    const words = new Set([k, ...locs.get(k)]);
    for (const w of words) if (w && w.length >= TYPO_MIN_LEN) for (const d of delKeys(w)) bucket(byDel, d, k);
  }
  for (const ks of byDel.values()) {
    if (ks.length < 2) continue;
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) tryJoin(ks[i], ks[j]);
  }

  // 4. One name's words a proper subset of the other's: look only at names
  //    that contain the smaller one's rarest word.
  const byTok = new Map();
  const toks = new Map(keys.map(k => [k, [...new Set(k.split(' '))]]));
  for (const k of keys) for (const tk of toks.get(k)) bucket(byTok, tk, k);
  for (const k of keys) {
    const mine = toks.get(k);
    let rarest = null;
    for (const tk of mine) if (!rarest || byTok.get(tk).length < byTok.get(rarest).length) rarest = tk;
    if (!rarest) continue;
    for (const other of byTok.get(rarest)) if (toks.get(other).length > mine.length) tryJoin(k, other);
  }

  for (const group of merges) {
    const vs = group.filter(v => parent.has(v));
    for (let i = 1; i < vs.length; i++) union(vs[0], vs[i]);
  }

  const merged = new Map();
  for (const v of values) {
    const root = find(v);
    if (!merged.has(root)) merged.set(root, []);
    merged.get(root).push({ value: v, count: counts.get(v) });
  }

  const groups = [];
  for (const variants of merged.values()) {
    if (variants.length < 2) continue;
    // Commonest spelling wins. Between equally common ones, care about the
    // shape before the length: an alphabetical tie-break picks "zurich" over
    // "Zürich", which is the one spelling nobody wants adopted. Only then
    // prefer the longer, more specific name ("Bern, Schweiz" over "Bern"),
    // since adopting it drops no information.
    variants.sort((x, y) =>
      y.count - x.count
      || _spellingScore(y.value) - _spellingScore(x.value)
      || y.value.length - x.value.length
      || x.value.localeCompare(y.value));
    const canonical = variants[0].value;
    const canonKey = placeKey(canonical);
    groups.push({
      canonical,
      total: variants.reduce((n, v) => n + v.count, 0),
      variants: variants.map(v => ({
        ...v,
        exact: placeKey(v.value) === canonKey,
        forced: forced.has(v.value),
      })),
    });
  }
  groups.sort((a, b) => b.total - a.total || a.canonical.localeCompare(b.canonical));
  return groups;
}

/**
 * Even without merging anything, the same place written "Bern ,CH" and
 * "Bern, CH" reads as two. This is the punctuation/whitespace half of "one
 * coherent style", and it is safe to offer wholesale: it never changes which
 * characters a name is made of, only the spacing around them.
 */
export function tidyPlace(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/(\s*,\s*)+/g, ', ')   // "Bern ,CH" and "Bern,,CH" both settle here
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

/**
 * Rewrite place fields. `renames` maps an exact current spelling to its
 * replacement; `tidy` additionally normalises spacing on every place.
 * Returns how many fields actually changed.
 */
export function applyPlaceRenames(renames, { tidy = false } = {}) {
  let changed = 0;
  for (const f of placeFields()) {
    if (!f.plac) continue;
    const before = f.plac;
    const renamed = renames.get(before);
    let next = renamed ?? before;
    if (tidy) next = tidyPlace(next);
    if (next !== before) { f.plac = next; changed++; }
    // Coordinates were looked up for the old name and are only trustworthy for
    // it. Tidying spacing does not change which place is meant, so those keep
    // theirs; an actual rename drops them and the map offers a fresh lookup.
    if (renamed != null && renamed !== before) delete f.map;
  }
  return changed;
}

// ── The dialog ────────────────────────────────────────────────────────────

export function openPlacesTool() {
  const modal = document.getElementById('places-modal');
  if (!modal) return;
  // Hand-made groupings and edited spellings last as long as the dialog does,
  // not longer: reopening it starts from what the file actually says.
  state._placeMerges = [];
  state._placeCanonEdits = new Map();
  state._placeTicks = new Map();
  const filter = document.getElementById('places-filter');
  if (filter) filter.value = '';
  renderPlacesTool();
  modal.style.display = 'flex';
}

export function closePlacesTool() {
  const modal = document.getElementById('places-modal');
  if (modal) modal.style.display = 'none';
}

/** Tick or untick every variant in the dialog at once. */
export function setAllPlaceVariants(on) {
  document.querySelectorAll('#places-groups .pl-variant input[type=checkbox]')
    .forEach(cb => { if (!cb.disabled) cb.checked = on; });
}

/**
 * Remember a spelling the user typed into a group's box, so that re-rendering
 * after a hand-merge does not throw it away. Keyed by the group's *proposed*
 * canonical, which is what the next render will compute again.
 */
export function notePlaceCanonEdit(gi, value) {
  const g = (state._placeGroups || [])[gi];
  if (g) (state._placeCanonEdits ||= new Map()).set(g.canonical, value);
}

/**
 * Put the ticked places into one group — with each other, or into an existing
 * group chosen in the dropdown. This is the escape hatch for pairs no rule
 * catches: nothing about "Sankt Gallen" and "S. Gallen" says they match.
 *
 * Any place can be picked, including one already in a group. Picking two of
 * those and asking for a new group takes exactly those two out and leaves the
 * rest of their old groups behind — the new group is what was selected, not
 * the union of everything the selection touched.
 */
export function mergeSelectedPlaces() {
  const picked = [...document.querySelectorAll('#places-all input[type=checkbox]')]
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.value);
  if (!picked.length) return;

  // '' is the "as a new group" option, and Number('') is 0 — which would send
  // every new group into whichever group happened to be listed first.
  const target = document.getElementById('places-merge-target')?.value;
  const group = target ? (state._placeGroups || [])[+target] : null;
  // Merging *into* a group means joining all of it, not just the spelling on
  // its title bar — otherwise adding one place to a group would tear the
  // group's own variants apart to do it.
  if (group) picked.push(...group.variants.map(v => v.value));
  else if (picked.length < 2) return;   // one name on its own is not a merge

  const members = [...new Set(picked)];
  // A place can only be in one hand-made group, and the newest choice is the
  // one that counts: picking A with B and then A with C moves A rather than
  // fusing all three. Groups left with nothing to say are dropped, and their
  // members go back to being grouped automatically.
  const kept = (state._placeMerges || [])
    .map(g => g.filter(v => !members.includes(v)))
    .filter(g => g.length > 1);
  state._placeMerges = [...kept, members];
  renderPlacesTool();
}

export function filterPlacesTool() {
  renderPlacesTool();
}

/**
 * Ticks live in the DOM, and the dialog re-renders whenever the filter or a
 * hand-merge changes it. Reading them into `state` first means a tick survives
 * that — and means applying does not depend on what happens to be on screen,
 * so filtering the list down cannot quietly drop the rest of the work.
 */
function _capturePlaceTicks() {
  const ticks = (state._placeTicks ||= new Map());
  for (const cb of document.querySelectorAll('#places-groups input[data-group]')) {
    const g = (state._placeGroups || [])[+cb.dataset.group];
    const v = g?.variants[+cb.dataset.variant];
    if (v && !cb.disabled) ticks.set(v.value, cb.checked);
  }
  return ticks;
}

function _variantRow(gi, vi, v, isCanon) {
  const remembered = state._placeTicks?.get(v.value);
  const tick = isCanon || (remembered != null ? remembered : (v.exact || v.forced));
  const tag = isCanon ? `<span class="pl-tag">${escHtml(t('places.keeps'))}</span>`
    : v.forced ? `<span class="pl-tag pl-tag--forced">${escHtml(t('places.byHand'))}</span>`
    : v.exact ? ''
    : `<span class="pl-tag pl-tag--loose">${escHtml(t('places.similar'))}</span>`;
  return `<label class="pl-variant${v.exact || v.forced ? '' : ' pl-variant--loose'}">
    <input type="checkbox" data-group="${gi}" data-variant="${vi}"
           ${tick ? 'checked' : ''}${isCanon ? ' disabled' : ''}>
    <span class="pl-value">${escHtml(v.value)}</span>
    <span class="pl-count">${v.count}</span>
    ${tag}
  </label>`;
}

export function renderPlacesTool() {
  const body = document.getElementById('places-groups');
  const summary = document.getElementById('places-summary');
  if (!body) return;

  _capturePlaceTicks();
  const counts = collectPlaces();
  const groups = groupPlaces(counts, { merges: state._placeMerges || [] });
  // A spelling the user typed earlier wins over the one the ranking proposes.
  for (const g of groups) {
    const edited = state._placeCanonEdits?.get(g.canonical);
    if (edited != null) g.typed = edited;
  }
  state._placeGroups = groups;

  // Which group, if any, each place currently sits in. The list below shows
  // every place — a search that could only find the ones nothing matched was
  // no help at all for the case this dialog exists for.
  const groupOf = new Map();
  groups.forEach((g, gi) => g.variants.forEach(v => groupOf.set(v.value, gi)));
  const all = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  summary.textContent = t('places.summary', { places: counts.size, groups: groups.length });

  // Searched against the folded form as well as the literal one: typing "zur"
  // has to find "Zürich", and "st gallen" has to find "St. Gallen". Nobody
  // reaches for the umlaut to look something up.
  const q = (document.getElementById('places-filter')?.value || '').trim().toLowerCase();
  const qk = placeKey(q);
  const hit = v => !q || v.toLowerCase().includes(q) || (!!qk && placeKey(v).includes(qk));
  const shownGroups = q ? groups.filter(g => g.variants.some(v => hit(v.value))) : groups;
  const shownAll = all.filter(([v]) => hit(v));

  // Both lists are capped: a large file has thousands of places, and the
  // filter box is the way to the rest. Groups beyond the cap are still applied
  // with their default ticks (exact spellings on, loose matches off).
  const GROUP_LIMIT = 300, PLACE_LIMIT = 1000;
  const groupHtml = shownGroups.slice(0, GROUP_LIMIT).map(g => {
    const gi = groups.indexOf(g);
    return `
    <div class="pl-group">
      <div class="pl-group-head">
        <input class="pl-canon edit-input" id="pl-canon-${gi}" value="${escAttr(g.typed ?? g.canonical)}"
               oninput="notePlaceCanonEdit(${gi}, this.value)"
               aria-label="${escAttr(t('places.canonical'))}">
        <span class="pl-total">${g.total}&times;</span>
      </div>
      <div class="pl-variants">
        ${g.variants.map((v, vi) => _variantRow(gi, vi, v, v.value === g.canonical)).join('')}
      </div>
    </div>`;
  }).join('');

  body.innerHTML = groups.length
    ? (groupHtml || `<div class="pl-empty">${escHtml(t('places.noMatch'))}</div>`) +
      (shownGroups.length > GROUP_LIMIT ? `<div class="pl-empty">${escHtml(t('places.moreGroups', { n: shownGroups.length - GROUP_LIMIT }))}</div>` : '')
    : `<div class="pl-empty">${escHtml(t('places.noneFound'))}</div>`;

  // Every place in the file, so any two can be put together by hand. Each row
  // says which group it is in already, because merging one pulls that group
  // along with it.
  const list = document.getElementById('places-all');
  if (!list) return;
  document.getElementById('places-all-count').textContent = String(all.length);
  list.innerHTML = shownAll.slice(0, PLACE_LIMIT).map(([v, n]) => {
    const gi = groupOf.get(v);
    const badge = gi == null ? ''
      : `<span class="pl-in-group" title="${escAttr(t('places.inGroup'))}">${escHtml(groups[gi].typed ?? groups[gi].canonical)}</span>`;
    return `<label class="pl-variant">
      <input type="checkbox" data-value="${escAttr(v)}">
      <span class="pl-value">${escHtml(v)}</span>
      ${badge}
      <span class="pl-count">${n}</span>
    </label>`;
  }).join('') + (shownAll.length > PLACE_LIMIT ? `<div class="pl-empty">${escHtml(t('find.capped', { n: PLACE_LIMIT }))}</div>` : '')
    || `<div class="pl-empty">${escHtml(t('places.noMatch'))}</div>`;

  const target = document.getElementById('places-merge-target');
  const keep = target.value;
  target.innerHTML = [`<option value="">${escHtml(t('places.mergeIntoNew'))}</option>`]
    .concat(groups.map((g, gi) => `<option value="${gi}">${escHtml(g.typed ?? g.canonical)}</option>`))
    .join('');
  if (keep && groups[+keep]) target.value = keep;
}

export function applyPlacesTool() {
  const ticks = _capturePlaceTicks();
  const groups = state._placeGroups || [];
  const renames = new Map();

  for (const g of groups) {
    const canonical = String(g.typed ?? g.canonical).trim();
    if (!canonical) continue;   // blanked out: leave this group alone
    for (const v of g.variants) {
      const on = v.value === g.canonical || (ticks.has(v.value) ? ticks.get(v.value) : (v.exact || v.forced));
      if (on && v.value !== canonical) renames.set(v.value, canonical);
    }
  }

  const tidy = !!document.getElementById('places-tidy')?.checked;
  const changed = applyPlaceRenames(renames, { tidy });

  if (changed) {
    _setDirty(true);
    // Places show up in the detail panel; whatever is open is now stale.
    if (state.selectedIndiId) showIndiDetail(state.selectedIndiId);
    else if (state._lastShownFamId) showFamDetail(state._lastShownFamId);
  }

  document.getElementById('status').textContent =
    changed ? t('places.applied', { count: changed }) : t('places.nothingToDo');
  closePlacesTool();
}
