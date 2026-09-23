/**
 * Undo and redo.
 *
 * Every change the app makes — an edit, a deletion, an import, a place-name
 * merge, a picture removed — used to be final. The only way back was the file
 * on disk, which loses everything else done since the last save.
 *
 * Each step is a compact JSON snapshot of the tree taken *before* the change,
 * the same serialisation the change log compares against, so whatever a save
 * would write, an undo restores. Snapshots are kept within a memory budget
 * rather than a fixed count: on an ordinary tree that is fifty steps; on a
 * 100,000-person tree it is two or three, which is what fits.
 *
 * Edits made through a form are recorded when the form opens, not when it is
 * saved: by then the form may already have added stub people to the tree (a new
 * relative typed in inline), and a snapshot taken on save would bring them
 * back as strays.
 */

import { state } from './state.js';

const BUDGET_CHARS = 80e6;   // roughly 160 MB of UTF-16 at the very most
const MAX_STEPS = 50;

const _undo = [];
const _redo = [];
let _pending = null;

let _restoreHook = () => {};
/** gedcom-io.js supplies the rebuild; this module stays free of that cycle. */
export function onHistoryRestore(fn) { _restoreHook = fn; }

function _snapshot() {
  return GEDCOMModule.exportJSON(state.individuals, state.families, { media: state.media, pretty: false });
}

function _trim() {
  let total = 0;
  for (let i = _undo.length - 1; i >= 0; i--) {
    total += _undo[i].snap.length;
    if ((total > BUDGET_CHARS && i < _undo.length - 1) || _undo.length - i > MAX_STEPS) {
      _undo.splice(0, i + 1);
      break;
    }
  }
}

/** Snapshot now; the step only counts once commitUndo() says the change happened. */
export function beginUndo(label) {
  _pending = { label, snap: _snapshot() };
}

export function commitUndo(label) {
  if (!_pending) return;
  _undo.push({ label: label || _pending.label, snap: _pending.snap });
  _pending = null;
  _redo.length = 0;
  _trim();
  syncUndoUI();
}

export function cancelUndo() { _pending = null; }

/** Snapshot and record in one go, for changes that happen immediately. */
export function recordUndo(label) {
  beginUndo(label);
  commitUndo();
}

/** A different tree was opened: its history is not this one's. */
export function clearUndo() {
  _undo.length = 0;
  _redo.length = 0;
  _pending = null;
  syncUndoUI();
}

function _step(from, to, verb) {
  const entry = from.pop();
  if (!entry) return false;
  to.push({ label: entry.label, snap: _snapshot() });
  const r = GEDCOMModule.importJSON(entry.snap);
  state.individuals.clear();
  state.families.clear();
  for (const [k, v] of r.individuals) state.individuals.set(k, v);
  for (const [k, v] of r.families) state.families.set(k, v);
  state.media = r.media;
  _restoreHook();
  syncUndoUI();
  const status = document.getElementById('status');
  if (status) status.textContent = t(verb, { what: entry.label });
  return true;
}

export function undo() { return _step(_undo, _redo, 'history.undone'); }
export function redo() { return _step(_redo, _undo, 'history.redone'); }

export function canUndo() { return _undo.length > 0; }
export function canRedo() { return _redo.length > 0; }

export function syncUndoUI() {
  const u = document.getElementById('undo-btn');
  const r = document.getElementById('redo-btn');
  if (u) {
    u.disabled = !_undo.length;
    u.title = _undo.length ? t('history.undoTitle', { what: _undo[_undo.length - 1].label }) : t('history.nothing');
  }
  if (r) {
    r.disabled = !_redo.length;
    r.title = _redo.length ? t('history.redoTitle', { what: _redo[_redo.length - 1].label }) : t('history.nothing');
  }
}
