/**
 * What has changed since the file was opened.
 *
 * Everything in this app edits a tree held in memory; the file on disk only
 * catches up when you save. Between those two moments there is no way to see
 * what you actually did — an afternoon of small corrections comes out as one
 * opaque "save", and the only way to check a fix landed is to save and diff the
 * files outside the app.
 *
 * This is that diff, before the save rather than after it: a snapshot taken
 * whenever the tree matches the file, compared against the tree as it stands.
 *
 * ── Where the baseline comes from ────────────────────────────────────────────
 * `_setDirty(false)` is the app's own statement that memory and disk agree —
 * it fires on load, on save-in-place and on download, and nowhere else. Hooking
 * the snapshot to that one call means every path that makes the tree "clean"
 * re-bases the comparison, including any added later, and no path can quietly
 * leave a stale baseline behind.
 *
 * The snapshot is the JSON export, kept as a string. It is the serialiser the
 * save itself uses, so a field that survives a save is a field this can see,
 * and holding it as text rather than as live objects makes it impossible to
 * alias the very records it is supposed to be compared against.
 */

import { escHtml } from './gedcom-io.js';
import { state } from './state.js';

let _baseline = null;   // { json, at } | null

/** Record the tree as it stands as the thing future edits are measured against. */
export function captureBaseline() {
  try {
    // Compact rather than pretty-printed: on a large tree the indentation alone
    // is tens of megabytes held for as long as the session lasts.
    _baseline = {
      json: GEDCOMModule.exportJSON(state.individuals, state.families, { media: state.media, pretty: false }),
      at: Date.now(),
    };
  } catch (e) {
    _baseline = null;   // nothing to compare against is better than a wrong one
  }
}

/** The baseline tree, parsed back into maps, or null when there is none. */
export function baselineTree() {
  if (!_baseline) return null;
  try {
    return GEDCOMModule.importJSON(_baseline.json);
  } catch (e) {
    return null;
  }
}

export function baselineTakenAt() {
  return _baseline ? _baseline.at : null;
}

// ── What counts as a change ───────────────────────────────────────────────────
//
// An explicit field list, not a generic object walk. The records carry derived
// and internal properties too — `displayName`, `birthYear`, the `_unknown`
// passthrough lines — and a diff that reported those would announce a change
// every time a name was retyped in the same shape. Each entry is also a label
// the reader has to recognise, which a generic walk cannot supply.

const _s = v => (v == null ? '' : String(v));
const _yn = v => (v ? 'yes' : 'no');
const _coords = ll => (Array.isArray(ll) && Number.isFinite(ll[0]) && Number.isFinite(ll[1])
  ? `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}` : '');

const INDI_FIELDS = [
  ['name',        i => _s(i.name)],
  ['givenName',   i => _s(i.givn)],
  ['surname',     i => _s(i.surn)],
  ['maidenName',  i => _s(i.maidenName)],
  ['sex',         i => _s(i.sex)],
  ['deceased',    i => _yn(i.deceased)],
  ['birthDate',   i => _s(i.birth?.date)],
  ['birthPlace',  i => _s(i.birth?.plac)],
  ['birthCoords', i => _coords(i.birth?.map)],
  ['deathDate',   i => _s(i.death?.date)],
  ['deathPlace',  i => _s(i.death?.plac)],
  ['deathCoords', i => _coords(i.death?.map)],
  ['deathCause',  i => _s(i.death?.caus)],
  ['occupation',  i => _s(i.occu)],
  ['note',        i => _s(i.note)],
  ['media',       (i, t) => _mediaList(i, t)],
];

// A person's FAMC/FAMS are the same facts as a family's HUSB/WIFE/CHIL, seen
// from the other end. Reporting both would double every relationship change,
// and the family's version is the readable one — it can name everybody
// involved instead of listing xrefs.
const FAM_FIELDS = [
  ['husband',      (f, t) => _nameOf(t, f.husb)],
  ['wife',         (f, t) => _nameOf(t, f.wife)],
  ['children',     (f, t) => (f.chil || []).map(id => _nameOf(t, id)).join(', ')],
  ['marriages',    f => (f.marriages || [])
    .map(m => [m.date, m.plac].filter(Boolean).join(', ') || '—').join('; ')],
  ['divorced',     f => _yn(f.div)],
  ['divorceDate',  f => _s(f.divDate)],
  ['media',        (f, t) => _mediaList(f, t)],
];

// Media by caption (or file name), so renaming a picture or making a different
// one the portrait shows up as the change it is.
function _mediaList(rec, tree) {
  return (rec.media || []).map(id => {
    const m = tree?.media?.get(id);
    return m ? (m.title || String(m.file || '').replace(/\\/g, '/').split('/').pop() || id) : id;
  }).join(', ');
}

function _nameOf(tree, id) {
  if (!id) return '';
  return tree?.individuals?.get(id)?.name || id;
}

function _famLabel(fam, tree) {
  const names = [fam.husb, fam.wife].map(id => _nameOf(tree, id)).filter(Boolean);
  return names.length ? names.join(' & ') : fam.id;
}

function _diffRecords(beforeMap, afterMap, fields, label, beforeTree, afterTree) {
  const out = [];
  for (const [id, after] of afterMap) {
    const before = beforeMap.get(id);
    if (!before) {
      out.push({ kind: 'added', id, label: label(after, afterTree), fields: [] });
      continue;
    }
    const changed = [];
    for (const [key, get] of fields) {
      const b = get(before, beforeTree), a = get(after, afterTree);
      if (b !== a) changed.push({ key, before: b, after: a });
    }
    if (changed.length) out.push({ kind: 'changed', id, label: label(after, afterTree), fields: changed });
  }
  for (const [id, before] of beforeMap) {
    if (!afterMap.has(id)) out.push({ kind: 'removed', id, label: label(before, beforeTree), fields: [] });
  }
  // Added first, then edits, then deletions: the order someone reviewing their
  // own afternoon reads them in, and it puts the destructive ones last where
  // they are hardest to skim past.
  const rank = { added: 0, changed: 1, removed: 2 };
  return out.sort((x, y) => rank[x.kind] - rank[y.kind] || x.label.localeCompare(y.label));
}

/**
 * Compare two trees. Both are `{ individuals, families }` maps; `before` may be
 * null, which means there is no baseline to compare against rather than that
 * everything is new.
 */
export function diffTrees(before, after) {
  if (!before) return null;
  const people = _diffRecords(before.individuals, after.individuals, INDI_FIELDS,
    p => p.name || p.id, before, after);
  const families = _diffRecords(before.families, after.families, FAM_FIELDS,
    _famLabel, before, after);
  const all = [...people, ...families];
  return {
    people,
    families,
    counts: {
      added: all.filter(r => r.kind === 'added').length,
      changed: all.filter(r => r.kind === 'changed').length,
      removed: all.filter(r => r.kind === 'removed').length,
      total: all.length,
    },
  };
}

/** The diff between the baseline and the tree as it stands right now. */
export function currentChanges() {
  return diffTrees(baselineTree(), { individuals: state.individuals, families: state.families, media: state.media });
}

// ── The dialog ────────────────────────────────────────────────────────────────

export function openChangesTool() {
  const modal = document.getElementById('changes-modal');
  if (!modal) return;
  renderChangesTool();
  modal.style.display = 'flex';
}

export function closeChangesTool() {
  const modal = document.getElementById('changes-modal');
  if (modal) modal.style.display = 'none';
}

function _valueCell(v, cls) {
  return v === ''
    ? `<span class="ch-val ch-val--empty ${cls}">${escHtml(t('changes.empty'))}</span>`
    : `<span class="ch-val ${cls}">${escHtml(v)}</span>`;
}

function _recordBlock(r) {
  const rows = r.fields.map(f => `<div class="ch-field">
      <span class="ch-key">${escHtml(t('changes.field.' + f.key))}</span>
      ${_valueCell(f.before, 'ch-val--before')}
      <span class="ch-arrow">&rarr;</span>
      ${_valueCell(f.after, 'ch-val--after')}
    </div>`).join('');
  return `<div class="ch-rec ch-rec--${r.kind}">
    <div class="ch-rec-head">
      <span class="ch-badge ch-badge--${r.kind}">${escHtml(t('changes.kind.' + r.kind))}</span>
      <span class="ch-rec-name">${escHtml(r.label)}</span>
    </div>
    ${rows}
  </div>`;
}

export function renderChangesTool() {
  const body = document.getElementById('changes-body');
  const summary = document.getElementById('changes-summary');
  if (!body) return;

  const diff = currentChanges();
  if (!diff) {
    summary.textContent = '';
    body.innerHTML = `<div class="pl-empty">${escHtml(t('changes.noBaseline'))}</div>`;
    return;
  }

  summary.textContent = t('changes.summary', diff.counts);

  if (!diff.counts.total) {
    body.innerHTML = `<div class="pl-empty">${escHtml(t('changes.none'))}</div>`;
    return;
  }

  const section = (title, records) => records.length
    ? `<div class="ch-section-title">${escHtml(title)}</div>${records.map(_recordBlock).join('')}`
    : '';

  body.innerHTML = section(t('changes.people'), diff.people)
    + section(t('changes.families'), diff.families);
}

// Any edit anywhere changes what this would say, so an open window follows the
// tree the way the statistics window does.
export function refreshChanges() {
  if (document.getElementById('changes-modal')?.style.display === 'flex') renderChangesTool();
}
