import { state } from './state.js';
import { lsGet, lsRemove, lsSet } from './settings.js';
import { AUTO_FOCUS_THRESHOLD, perf, placeTopbarMenu } from './constants.js';
import { buildSurnameColorMap, buildSurnameList } from './colors.js';
import { DECEASED_AGE_THRESHOLD, _defaultFocusRoot, buildGraphData, computeEstimatedYears, updateFocusUI } from './graph-data.js';
import { applyHighlight } from './relations.js';
import { applyFilter, autoSettle, buildAndRunSimulation, initSVG, renderGraph } from './render-2d.js';
import { captureBaseline, refreshChanges } from './changes.js';
import { refreshMap } from './map-view.js';
import { refreshStats } from './stats.js';
import { _push3DData, _setOrbitTarget3D, apply3DPhysics, build3DTimeline, initGraph3D, update3DNames, updateViewToggleUI } from './render-3d.js';
import { idbAvailable, idbDel, idbGet, idbSet } from './store.js';
import { attachCandidates, buildMediaArchive, mediaEnabled, readMediaArchive, resetMediaSession } from './media.js';
import { isZip } from './zip.js';
import { clearUndo, syncUndoUI } from './history.js';

export function _setDirty(v) {
  state._gedcomDirty = v;
  // Clean means memory and disk agree, which is exactly the moment the change
  // log has to start counting from again — on load, on save, on download, and
  // on anything added later that goes through here.
  if (!v) captureBaseline();
  refreshChanges();
  // These edits are newer than whatever the last autosave captured, until the
  // debounced write below actually lands.
  if (v) state._autosaveCaptured = false;
  for (const id of ['dl-btn', 'save-file-btn']) {
    document.getElementById(id)?.classList.toggle('has-unsaved', v);
  }
  if (v) _autosave();
  else _clearAutosave();
}

// Leaving with edits that exist nowhere but this tab is worth interrupting for.
// Once the autosave has written *these* edits, it is not: the restore bar
// offers them back on the next load, so the prompt would be asking about work
// that is already safe. A failed autosave (quota) never sets the flag, so the
// warning stands exactly when the data really is only here.
window.addEventListener('beforeunload', e => {
  if (state._gedcomDirty && !state._autosaveCaptured) { e.preventDefault(); e.returnValue = ''; }
});

// ── Autosave ─────────────────────────────────────────────────────────────────
//
// IndexedDB first: localStorage stops at about five megabytes, which a few
// thousand people already exceed — on a large tree the autosave used to fail on
// every edit, silently, and the "your work is safe" promise with it.
// localStorage stays as the fallback for browsers without IndexedDB, and is
// still read on startup so an autosave written by an older version is found.

const AUTOSAVE_LS = 'gedcomAutosave';
let _autosaveGen = 0;

export function _autosave() {
  clearTimeout(state._autosaveTimer);
  const gen = ++_autosaveGen;
  // Serialising is the expensive part and grows with the tree, so a big tree
  // waits a little longer for the typing to stop.
  const delay = 2000 + Math.min(4000, state.individuals.size / 25);
  state._autosaveTimer = setTimeout(async () => {
    const payload = { filename: window._gedcomFilename || '', ts: Date.now(), ged: serializeGEDCOM() };
    let ok = false;
    if (idbAvailable()) {
      try { await idbSet('autosave', 'current', payload); ok = true; lsRemove(AUTOSAVE_LS); } catch { /* fall through */ }
    }
    // lsSet reports whether the write landed rather than throwing. A false here
    // is quota (or storage switched off entirely), and leaving _autosaveCaptured
    // alone is what keeps the beforeunload warning up.
    if (!ok) ok = lsSet(AUTOSAVE_LS, JSON.stringify(payload));
    // A save, a reload or another edit may have happened while this was
    // writing — only the newest write for a still-dirty tree counts.
    if (ok && gen === _autosaveGen && state._gedcomDirty) state._autosaveCaptured = true;
    else if (ok && !state._gedcomDirty) _clearAutosave();
  }, delay);
}

function _clearAutosave() {
  clearTimeout(state._autosaveTimer);
  _autosaveGen++;
  state._autosaveCaptured = false;
  lsRemove(AUTOSAVE_LS);
  if (idbAvailable()) idbDel('autosave', 'current').catch(() => {});
}

async function _readAutosave() {
  if (idbAvailable()) {
    try {
      const v = await idbGet('autosave', 'current');
      if (v && v.ged) return v;
    } catch { /* fall back */ }
  }
  const raw = lsGet(AUTOSAVE_LS);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { lsRemove(AUTOSAVE_LS); return null; }
}

export async function _tryRestoreAutosave() {
  const data = await _readAutosave();
  if (!data || !data.ged) return;
  // Something was opened while the store was being read — that wins.
  if (state.individuals.size) return;
  const when = new Date(data.ts).toLocaleString(currentLang === 'de' ? 'de-CH' : 'en-US');
  const label = data.filename || t('autosave.unnamed');

  const bar = document.getElementById('autosave-bar');
  if (!bar) return;   // headless/test environment with no DOM shell
  document.getElementById('autosave-bar-text').textContent = t('autosave.found', { name: label, date: when });
  bar.style.display = 'flex';

  const restoreBtn = document.getElementById('autosave-restore-btn');
  const discardBtn = document.getElementById('autosave-discard-btn');
  restoreBtn.onclick = async () => {
    bar.style.display = 'none';
    // Autosave content is always GEDCOM — force .ged so a .json/.yaml original
    // filename doesn't route it into the JSON/YAML importer
    const fname = (data.filename || t('autosave.restoredName')).replace(/\.(ged|json|ya?ml|zip|gdz)$/i, '') + '.ged';
    await _loadDatasetFile(new File([data.ged], fname), null, { keepMedia: true });
    // Loading marks the session clean, but this data is still unsaved to disk.
    state._gedcomDirty = true;
    for (const id of ['dl-btn', 'save-file-btn']) document.getElementById(id)?.classList.add('has-unsaved');
    _autosave();
  };
  discardBtn.onclick = () => {
    bar.style.display = 'none';
    _clearAutosave();
  };
}

// ── Loading ──────────────────────────────────────────────────────────────────

export function parseGEDCOM(raw) {
  _adoptTree(GEDCOMModule.parseGEDCOM(raw));
}

function _adoptTree(result) {
  state.individuals.clear();
  state.families.clear();
  for (const [k, v] of result.individuals) state.individuals.set(k, v);
  for (const [k, v] of result.families)    state.families.set(k, v);
  state.media = result.media instanceof Map ? result.media : new Map();
  state.otherLines = result.otherLines || [];
}

/** File → { individuals, families, media, otherLines, candidates? }, by what
 *  the file is rather than only by what it is called. */
async function _readDataset(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.(zip|gdz)$/.test(name) || await isZip(file)) {
    const arc = await readMediaArchive(file);
    const result = GEDCOMModule.parseGEDCOM(arc.text);
    result.candidates = arc.candidates;
    return result;
  }
  if (name.endsWith('.json')) return GEDCOMModule.importJSON(await file.text());
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return GEDCOMModule.importYAML(await file.text());
  return GEDCOMModule.parseGEDCOM(GEDCOMModule.decodeGedcom(await file.arrayBuffer()));
}

export function _fullRebuildGraph(opts = {}) {
  const warm = !!opts.warm;
  if (!warm) state._nodeObjCache = new Map(); // dataset-level change: don't reuse positions from a possibly-unrelated previous dataset
  if (state.focusRootId && !state.individuals.has(state.focusRootId)) state.focusRootId = null;  // focus person was deleted
  // Generation numbers are only meaningful for the file that produced them.
  if (!warm) state.genRange = null;
  _setDirty(true);
  perf.start('[rebuild] total');
  perf.start('[rebuild] surnameColorMap'); const sorted = buildSurnameColorMap(); perf.end('[rebuild] surnameColorMap');
  perf.start('[rebuild] surnameList');     buildSurnameList(sorted);               perf.end('[rebuild] surnameList');
  perf.start('[rebuild] buildGraphData');  buildGraphData();                        perf.end('[rebuild] buildGraphData');
  if (!state.svgSel) initSVG();
  perf.start('[rebuild] renderGraph');     renderGraph();                           perf.end('[rebuild] renderGraph');
  _statusCounts();
  if (!warm) state._firstLoad = true;
  perf.start('[rebuild] simulation');      buildAndRunSimulation({ warm });         perf.end('[rebuild] simulation');
  // For 3D: push data directly instead of calling applyFilter() which would
  // run buildAndRunSimulation() a second time (doubles the sim cost).
  if (state.currentView === '3d') {
    perf.start('[rebuild] 3d data push');
    if (!state.graph3d) {
      // Nothing has built the scene yet — the tree was created from scratch
      // rather than loaded from a file.
      initGraph3D();
    } else {
      _push3DData();
      apply3DPhysics();
      build3DTimeline();
      update3DNames();
    }
    perf.end('[rebuild] 3d data push');
  }
  // renderGraph() rebuilds all DOM/3D nodes from scratch, dropping highlight
  // opacity and orbit target — restore them so editing a person/family
  // doesn't visually clear the selection the user was looking at.
  applyHighlight();
  if (state.currentView === '3d' && state.selectedIndiId) _setOrbitTarget3D(state.selectedIndiId);
  updateFocusUI();
  showDataUI();   // deleting the last record has to put the empty state back
  refreshStats(); // ...and an open statistics window must not keep the old figures
  refreshMap();   // ...nor an open map keep an event whose place just changed
  perf.end('[rebuild] total');
}

function _statusCounts() {
  const n = state.individuals.size;
  document.getElementById('status').textContent =
    t('topbar.status', { n, persons: n.toLocaleString(), families: state.families.size.toLocaleString() });
}

// Nobody born more than DECEASED_AGE_THRESHOLD years ago is still alive, so a
// record that never said so is simply incomplete rather than a claim that they
// are living.
//
// Most people in a genealogy have no birth date at all. Where there is no
// recorded year the estimate stands in: it is derived from the years their
// relatives do have, so someone three generations above a person born in 1900 is
// placed around 1810 and marked, on the same rule.
//
// The estimate is a guess, and this writes `1 DEAT Y` into the file on save.
// It only ever fills a blank — a recorded birth year always decides for itself,
// and anyone already marked is left alone. Switched off in the settings, it
// does nothing at all.
export function _autoMarkDeceasedByAge() {
  state._autoDeceasedEstimated = [];
  if (state.autoDeceased === false) return;
  const cutoffYear = new Date().getFullYear() - DECEASED_AGE_THRESHOLD;
  // Computing the estimates walks the whole tree, so only pay for it if somebody
  // actually lacks a year.
  let est = null;
  for (const [id, indi] of state.individuals) {
    if (indi.deceased) continue;
    if (indi.birthYear) {
      if (indi.birthYear <= cutoffYear) indi.deceased = true;
      continue;
    }
    est ??= computeEstimatedYears();
    const guess = est.get(id);
    if (guess && guess <= cutoffYear) {
      indi.deceased = true;
      // This one is written to disk on save from a guessed year, not a
      // recorded one — worth telling the user, not just inferring quietly.
      state._autoDeceasedEstimated.push({ id, name: indi.displayName || indi.name || id, year: guess });
    }
  }
}

// A one-line addition to the save/export status text naming anyone whose
// `1 DEAT Y` is about to be written from a guessed birth year rather than a
// recorded one — see the comment on _autoMarkDeceasedByAge above. Long lists
// are cut: on a big file this can be thousands of names.
export function _estimatedDeceasedNote() {
  const list = state._autoDeceasedEstimated;
  if (!list || !list.length) return '';
  const shown = list.slice(0, 8).map(p => `${p.name} (~${p.year})`);
  if (list.length > shown.length) shown.push('…');
  return ' ' + t('topbar.estimatedDeceasedNote', { count: list.length, names: shown.join(', ') });
}

// `handle` is the File System Access handle the file came from, when it came
// from one. Every other caller — the import wizard, the autosave restore — hands
// over a detached File and so clears it: without that, "save" would still be
// pointing at whatever file was opened before this one and would write the new
// data straight over it.
//
// Returns a promise that settles once the tree is on screen (or the load failed).
export function _loadDatasetFile(file, handle = null, opts = {}) {
  if (!file) return Promise.resolve();
  state._fileHandle = handle;
  // Whatever was opened last is what the reopen button should offer, so the
  // remembering happens here — the one point every route into the app funnels
  // through.
  if (handle) _saveRecentHandle(handle).catch(() => { /* private mode, no store */ });

  document.getElementById('status').textContent = t('graph.loading');
  document.getElementById('loading-overlay').style.display = 'flex';

  return _readDataset(file).then(result => {
    _applyDataset(result, file.name, opts);
  }).catch(err => {
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('status').textContent = t('errors.loadError', { msg: err.message });
    console.error(err);
  });
}

function _applyDataset(result, fileName, opts = {}) {
  state._nodeObjCache = new Map(); // fresh dataset: don't reuse positions from a possibly-unrelated previous one
  state.focusRootId = null;        // and no focus person carries over
  state.genRange = null;           // nor a band of generations this file may not have
  state._revealed.clear();
  // Anything still pointing into the previous tree would now point at whoever
  // happens to have the same id in this one.
  state.selectedIndiId = null;
  state._lastShownFamId = null;
  // A form left open on the previous tree: its stubs belong to that tree.
  state._editingId = state._editingType = null;
  state._isNewRecord = false;
  state._pendingRelations = [];
  state._removedRelations = [];
  state._famEditPendingChil = [];
  state._famEditNewPartner = { husb: null, wife: null };
  state.hlMode = null;
  state.hlSet = new Set();
  state._relPersonA = state._relPersonB = null;
  document.getElementById('main-layout')?.classList.remove('panel-open');
  document.getElementById('detail-panel')?.classList.remove('panel-visible');
  if (!opts.keepMedia) resetMediaSession();
  state.surnameEnabled.clear();   // a new file starts with every family shown
  clearUndo();                    // ...and with no history of somebody else's edits

  _adoptTree(result);

  const iCount = state.individuals.size;
  const fCount = state.families.size;
  document.getElementById('status').textContent =
    t('topbar.statusLoaded', { persons: iCount.toLocaleString(), families: fCount.toLocaleString() });

  // Too big to draw whole — see AUTO_FOCUS_THRESHOLD. Set before the rebuild
  // below, because buildGraphData() runs the focus walk as part of deciding
  // what is active: choosing afterwards would mean laying the whole file out
  // once and throwing it away, which is the cost this is here to avoid.
  if (iCount > AUTO_FOCUS_THRESHOLD) state.focusRootId = _defaultFocusRoot();

  const sorted = buildSurnameColorMap();
  buildSurnameList(sorted);
  buildGraphData();
  initSVG();
  renderGraph();
  // Reset 3D state if re-loading
  if (state._orbitControls3d) { state._orbitControls3d.dispose(); state._orbitControls3d = null; }
  if (state.graph3d) { state.graph3d.pauseAnimation(); state.graph3d = null; }
  state._3dAmbientLight = null;
  state._3dPointLight = null;

  state._firstLoad = true;
  buildAndRunSimulation();
  showDataUI();
  refreshStats();
  window._gedcomFilename = fileName;
  _setDirty(false);
  updateFileButtons();

  updateViewToggleUI();
  updateFocusUI();
  if (state.currentView === '3d') {
    initGraph3D();
    setTimeout(autoSettle, 400); // let initGraph3D finish before annealing
  }

  // An archive's pictures are matched to the tree's FILE paths once the tree
  // is on screen — storing them can take a moment and nothing waits on it.
  if (result.candidates?.length && state.media.size) {
    attachCandidates(result.candidates).then(({ matched }) => {
      if (matched) document.getElementById('status').textContent = t('media.archiveLoaded', { n: matched });
      if (state.selectedIndiId) window.showIndiDetail?.(state.selectedIndiId);
    }).catch(err => console.error(err));
  }
}

// Everything that only makes sense once there are people to look at: the export
// menu, the view and framing buttons, and — inversely — the empty-state card
// over the canvas. Driven off `individuals.size` rather than "a file was just
// opened", so deleting the last person puts the empty state back.
export function showDataUI() {
  const has = state.individuals.size > 0;
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = has ? 'none' : 'flex';
  document.getElementById('main-layout')?.classList.toggle('no-data', !has);
  const menuBtn = document.getElementById('sidebar-toggle-btn');
  if (menuBtn) menuBtn.style.display = has ? '' : 'none';   // it would open an empty drawer

  document.getElementById('dl-wrap').style.display = has ? 'flex' : 'none';
  for (const id of ['center-view-btn', 'center-person-btn']) {
    document.getElementById(id).style.display = has ? 'inline-block' : 'none';
  }
  document.getElementById('center-view-btn').disabled = !has;
  // Both tools behind it act on the whole tree, so the menu is all-or-nothing.
  document.getElementById('tools-wrap').style.display = has ? 'flex' : 'none';
  document.getElementById('view-toggle-btn').disabled = !has;
  const hist = document.getElementById('history-wrap');
  if (hist) hist.style.display = has ? 'flex' : 'none';
  syncUndoUI();
  syncMediaUI();
}

/** The media entries in the menus only exist while the feature is on. */
export function syncMediaUI() {
  const on = mediaEnabled();
  for (const el of document.querySelectorAll('.media-only')) el.style.display = on ? '' : 'none';
}

// ── The working file ────────────────────────────────────────────────────────
// Reopening the last file and saving back over it both need a handle to the
// file itself, which only the File System Access API gives. A file chosen
// through <input type="file"> is a detached copy: there is no way back to where
// it came from, which is why "save" has always meant "download another copy".
//
// Handles survive a reload, but only in IndexedDB — they are structured-clone
// values, not strings. Permission does not survive, and re-granting it must
// happen inside a user gesture; both entry points here are click handlers.

export function fileAccessSupported() {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

export const _saveRecentHandle = h  => idbSet('handles', 'recent', h);
export const _readRecentHandle = () => idbGet('handles', 'recent');

// Whether we may touch the file yet. Asking is only allowed from a gesture, so
// `ask` is false for the passive check that decides how to label the buttons.
async function _permitted(handle, ask) {
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return ask && await handle.requestPermission(opts) === 'granted';
}

const _exportExtra = () => ({ media: state.media, otherLines: state.otherLines });

// Save in the format the file already is, not the one we happen to prefer —
// writing GEDCOM text into a file called .json is how you corrupt somebody's
// data while telling them it was saved.
async function _contentForFile(name) {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.json')) return GEDCOMModule.exportJSON(state.individuals, state.families, _exportExtra());
  if (n.endsWith('.yaml') || n.endsWith('.yml')) return GEDCOMModule.exportYAML(state.individuals, state.families, _exportExtra());
  if (n.endsWith('.zip') || n.endsWith('.gdz')) return (await _archive(name.replace(/\.\w+$/, ''))).blob;
  return '﻿' + serializeGEDCOM();
}

export async function openRecentFile() {
  if (!fileAccessSupported()) return;
  try {
    let handle = state._fileHandle || await _readRecentHandle().catch(() => null);
    // Nothing remembered yet, or the file is gone — pick one, and that becomes
    // the file both buttons mean from now on.
    if (!handle || !await _permitted(handle, true)) {
      if (handle) return;   // permission was refused; not our place to override
      [handle] = await window.showOpenFilePicker({
        types: [{ description: 'GEDCOM / JSON / YAML / ZIP',
          accept: { 'text/plain': ['.ged', '.json', '.yaml', '.yml'], 'application/zip': ['.zip', '.gdz'] } }],
      });
      if (!handle || !await _permitted(handle, true)) return;
    }
    const file = await handle.getFile();
    await _loadDatasetFile(file, handle);   // which is what records it as the recent one
  } catch (err) {
    if (err.name === 'AbortError') return;          // the picker was dismissed
    document.getElementById('status').textContent = t('errors.loadError', { msg: err.message });
  }
}

// Writes over the file the loaded data actually came from. Deliberately does not
// fall back to the *remembered* handle: after an ordinary import the dataset on
// screen has nothing to do with the last file opened, and quietly overwriting it
// would destroy a file the user never named.
export async function saveToFile() {
  if (!fileAccessSupported()) { downloadGEDCOM(); return; }
  try {
    const handle = state._fileHandle;
    if (!handle || !await _permitted(handle, true)) return;

    const name = handle.name || window._gedcomFilename;
    const content = await _contentForFile(name);
    const w = await handle.createWritable();
    await w.write(content);
    await w.close();

    window._gedcomFilename = name;
    await _saveRecentHandle(handle).catch(() => {});
    _setDirty(false);
    updateFileButtons();
    document.getElementById('status').textContent = t('topbar.savedTo', { name }) + _estimatedDeceasedNote();
  } catch (err) {
    if (err.name === 'AbortError') return;
    document.getElementById('status').textContent = t('errors.saveError', { msg: err.message });
  }
}

// Both buttons name the file they act on, so it is never a guess which one gets
// written. Called on startup too, when only the remembered handle knows the name.
export async function updateFileButtons() {
  const openBtn = document.getElementById('open-recent-btn');
  const saveBtn = document.getElementById('save-file-btn');
  if (!openBtn || !saveBtn) return;
  if (!fileAccessSupported()) {
    // Firefox and mobile browsers have no way to write back to a chosen file.
    openBtn.style.display = saveBtn.style.display = 'none';
    return;
  }

  // The open button offers whatever was last opened, even across a reload.
  let recent = state._fileHandle?.name;
  if (!recent) {
    try { recent = (await _readRecentHandle())?.name; } catch { /* no store yet */ }
  }
  openBtn.style.display = 'inline-block';
  openBtn.innerHTML = recent
    ? '↻ <span class="btn-label">' + escHtml(recent) + '</span>'
    : '\u{1F4C1} <span class="btn-label">' + escHtml(t('topbar.openFile')) + '</span>';
  openBtn.title = recent ? t('topbar.openRecentTitle', { name: recent }) : t('topbar.openFileTitle');

  // The save button only appears once the data on screen came from a file we
  // can write back to, so what it would overwrite is never in doubt.
  const live = state._fileHandle?.name;
  saveBtn.style.display = live ? 'inline-block' : 'none';
  if (live) {
    saveBtn.innerHTML = '\u{1F4BE} <span class="btn-label">' + escHtml(live) + '</span>';
    saveBtn.title = t('topbar.saveToTitle', { name: live });
  }
}

// ── The date widget ──────────────────────────────────────────────────────────
//
// GEDCOM dates are richer than day/month/year: "BET 1850 AND 1860",
// "FROM 1914 TO 1918", "CAL 1720", dual years "1700/01", calendar escapes,
// "INT 1900 (from the census)". The widget used to understand four prefixes
// and a single date, and rebuilt the value from its fields on every save — so
// opening a person to fix their name quietly rewrote "BET 1850 AND 1860" as
// "1850". It now covers ranges and periods, keeps anything it cannot represent
// as free text, and hands the original back untouched when nothing was changed.

export const _GD_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const _GD_PREFIXES = ['ABT', 'CAL', 'EST', 'BEF', 'AFT'];
const _GD_RANGES = { BET: 'AND', FROM: 'TO' };

export function _safeId(gedcomId) {
  return String(gedcomId).replace(/[^a-zA-Z0-9]/g, '_');
}

function _gdSimple(str) {
  // "[d] [MON] yyyy" or "MON yyyy" or "yyyy", nothing else.
  const parts = str.split(/\s+/).filter(Boolean);
  let day = '', month = '', year = '';
  if (parts.length === 3 && /^\d{1,2}$/.test(parts[0]) && _GD_MONTHS.includes(parts[1]) && /^\d{1,4}$/.test(parts[2])) {
    [day, month, year] = parts;
  } else if (parts.length === 2 && _GD_MONTHS.includes(parts[0]) && /^\d{1,4}$/.test(parts[1])) {
    [month, year] = parts;
  } else if (parts.length === 1 && /^\d{1,4}$/.test(parts[0])) {
    [year] = parts;
  } else {
    return null;
  }
  if (day && (+day < 1 || +day > 31)) return null;
  return { day: day ? String(+day) : '', month, year };
}

/**
 * A GEDCOM date → the widget's fields. `exact` says whether the fields hold the
 * whole of it; when they do not, the widget opens in free-text mode.
 */
export function _parseGedcomDate(str) {
  const raw = String(str || '').trim();
  const out = { prefix: '', day: '', month: '', year: '', day2: '', month2: '', year2: '', raw, exact: true };
  if (!raw) return out;
  const s = raw.toUpperCase().replace(/\s+/g, ' ');

  let m = s.match(/^(BET|FROM) (.+?)(?: (AND|TO) (.+))?$/);
  if (m && (!m[3] || _GD_RANGES[m[1]] === m[3])) {
    const a = _gdSimple(m[2]), b = m[4] ? _gdSimple(m[4]) : null;
    if (a && (b || !m[4])) {
      Object.assign(out, a, { prefix: m[1] });
      if (b) { out.day2 = b.day; out.month2 = b.month; out.year2 = b.year; }
      // "BET x" alone is not a valid date; show it as text rather than guess.
      if (m[1] === 'BET' && !b) out.exact = false;
      return out;
    }
  }
  m = s.match(/^TO (.+)$/);
  if (m) {
    const b = _gdSimple(m[1]);
    if (b) return Object.assign(out, { prefix: 'TO', day2: '', month2: '', year2: '' }, b);
  }
  m = s.match(/^(ABT|CAL|EST|BEF|AFT) (.+)$/);
  if (m) {
    const a = _gdSimple(m[2]);
    if (a) return Object.assign(out, a, { prefix: m[1] });
  }
  const a = _gdSimple(s);
  if (a) return Object.assign(out, a);

  // Anything else is kept as written. The year is still pulled out so a caller
  // that only wants it (the charts) gets one.
  out.exact = false;
  const y = raw.match(/\b(\d{3,4})\b/);
  if (y) out.year = y[1];
  return out;
}

function _gdCompose(d, m, y) {
  return [d ? String(parseInt(d, 10)) : '', m, y ? String(parseInt(y, 10)) : ''].filter(Boolean).join(' ');
}

function _gdComposeAll(f) {
  const a = _gdCompose(f.day, f.month, f.year);
  const b = _gdCompose(f.day2, f.month2, f.year2);
  const p = f.prefix;
  if (p === 'BET') return a && b ? `BET ${a} AND ${b}` : (a ? `AFT ${a}` : (b ? `BEF ${b}` : ''));
  if (p === 'FROM') return a && b ? `FROM ${a} TO ${b}` : (a ? `FROM ${a}` : (b ? `TO ${b}` : ''));
  if (p === 'TO') return a ? `TO ${a}` : '';
  return a ? (p ? `${p} ${a}` : a) : '';
}

export function _gedcomDateWidget(fieldId, value) {
  const f = _parseGedcomDate(value);
  const monthOpts = sel => _GD_MONTHS.map(m =>
    `<option value="${m}"${sel === m ? ' selected' : ''}>${m[0]}${m.slice(1).toLowerCase()}</option>`
  ).join('');
  const prefixOpts = [
    ['', t('dateWidget.exact')], ['ABT', t('dateWidget.about')], ['CAL', t('dateWidget.calculated')],
    ['EST', t('dateWidget.estimated')], ['BEF', t('dateWidget.before')], ['AFT', t('dateWidget.after')],
    ['BET', t('dateWidget.between')], ['FROM', t('dateWidget.from')], ['TO', t('dateWidget.to')],
  ].map(([v, l]) => `<option value="${v}"${f.prefix === v ? ' selected' : ''}>${l}</option>`).join('');
  const range = f.prefix === 'BET' || f.prefix === 'FROM';
  const joiner = f.prefix === 'FROM' ? t('dateWidget.until') : t('dateWidget.and');
  const dateInputs = (sfx, d, m, y) =>
    `<input class="gd-day${sfx}" type="number" min="1" max="31" placeholder="${t('dateWidget.dayPlaceholder')}" value="${d}" title="${t('dateWidget.day')}">` +
    `<select class="gd-month${sfx}"><option value="">${t('dateWidget.monthPlaceholder')}</option>${monthOpts(m)}</select>` +
    `<input class="gd-year${sfx}" type="number" min="1" max="2200" placeholder="${t('dateWidget.yearPlaceholder')}" value="${y}" title="${t('dateWidget.year')}">`;
  return `<div class="gd-widget" id="${fieldId}" data-orig="${escAttr(f.raw)}" data-mode="${f.exact ? 'parts' : 'text'}">` +
    `<div class="gd-row gd-parts">` +
      `<select class="gd-prefix" onchange="_gdPrefixChange('${fieldId}')">${prefixOpts}</select>` +
      dateInputs('', f.day, f.month, f.year) +
      `<button type="button" class="gd-mode-btn" onclick="_gdToggleMode('${fieldId}')" title="${t('dateWidget.asText')}">&#x270E;</button>` +
    `</div>` +
    `<div class="gd-row gd-parts2"${range ? '' : ' style="display:none"'}>` +
      `<span class="gd-joiner">${joiner}</span>` +
      dateInputs('2', f.day2, f.month2, f.year2).replace(/class="gd-(day|month|year)2"/g, 'class="gd-$12 gd-$1"') +
    `</div>` +
    `<div class="gd-row gd-text-row">` +
      `<input class="gd-text edit-input" type="text" value="${escAttr(f.raw)}" placeholder="${t('dateWidget.textPlaceholder')}" spellcheck="false">` +
      `<button type="button" class="gd-mode-btn" onclick="_gdToggleMode('${fieldId}')" title="${t('dateWidget.asFields')}">&#x25A6;</button>` +
    `</div>` +
    `</div>`;
}

function _gdFields(el) {
  const v = sel => el.querySelector(sel)?.value?.trim() || '';
  return {
    prefix: v('.gd-prefix'),
    day: v('.gd-day:not(.gd-day2)'), month: v('.gd-month:not(.gd-month2)'), year: v('.gd-year:not(.gd-year2)'),
    day2: v('.gd-day2'), month2: v('.gd-month2'), year2: v('.gd-year2'),
  };
}

function _gdFill(el, f) {
  const set = (sel, val) => { const x = el.querySelector(sel); if (x) x.value = val || ''; };
  set('.gd-prefix', f.prefix);
  set('.gd-day:not(.gd-day2)', f.day); set('.gd-month:not(.gd-month2)', f.month); set('.gd-year:not(.gd-year2)', f.year);
  set('.gd-day2', f.day2); set('.gd-month2', f.month2); set('.gd-year2', f.year2);
  _gdPrefixChange(el.id);
}

/** Show the second date only for the prefixes that have one. */
export function _gdPrefixChange(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  const p = el.querySelector('.gd-prefix')?.value;
  const row = el.querySelector('.gd-parts2');
  if (row) row.style.display = p === 'BET' || p === 'FROM' ? '' : 'none';
  const j = el.querySelector('.gd-joiner');
  if (j) j.textContent = p === 'FROM' ? t('dateWidget.until') : t('dateWidget.and');
}

/** Switch between the fields and free text, carrying the value across. */
export function _gdToggleMode(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  if (el.dataset.mode === 'text') {
    const f = _parseGedcomDate(el.querySelector('.gd-text')?.value || '');
    if (!f.exact && f.raw) {
      // Not something the fields can hold; say so rather than drop half of it.
      const txt = el.querySelector('.gd-text');
      txt?.classList.add('gd-invalid');
      setTimeout(() => txt?.classList.remove('gd-invalid'), 1200);
      return;
    }
    _gdFill(el, f);
    el.dataset.mode = 'parts';
  } else {
    const txt = el.querySelector('.gd-text');
    if (txt) txt.value = _gdComposeAll(_gdFields(el));
    el.dataset.mode = 'text';
    txt?.focus();
  }
}

export function _gedcomDateValue(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return '';
  const orig = el.dataset.orig || '';
  let value;
  if (el.dataset.mode === 'text') {
    value = (el.querySelector('.gd-text')?.value || '').replace(/\s+/g, ' ').trim();
  } else {
    value = _gdComposeAll(_gdFields(el));
  }
  // Untouched, or the same date spelled the same way modulo case and spacing:
  // hand back exactly what was there.
  const norm = s => s.toUpperCase().replace(/\s+/g, ' ').trim();
  if (norm(value) === norm(orig) || (!value && !orig)) return orig;
  if (el.dataset.mode === 'parts' && orig && value === _gdComposeAll(_parseGedcomDate(orig))) return orig;
  return value;
}

export function _resetGedcomDateWidget(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  el.dataset.orig = '';
  el.dataset.mode = 'parts';
  _gdFill(el, {});
  const txt = el.querySelector('.gd-text');
  if (txt) txt.value = '';
}

// ── Escaping ─────────────────────────────────────────────────────────────────

export function escHtml(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escAttr(s) {
  return escHtml(s);
}

export function escJs(s) {
  if (s == null || s === '') return '';
  return escHtml(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n'));
}

// ── Saving and exporting ─────────────────────────────────────────────────────

export function serializeGEDCOM() {
  return GEDCOMModule.serializeGEDCOM(state.individuals, state.families, state.otherLines, state.media);
}

export function _downloadBlob(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking in the same tick races the download the click just started —
  // Chromium happens to get away with it, Firefox drops the file. Give the
  // browser a moment to have taken hold of the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function _baseFilename() {
  return (window._gedcomFilename || 'family-tree').replace(/\.\w+$/i, '').replace(/_edited$/, '');
}

function _noteEstimated() {
  const note = _estimatedDeceasedNote();
  if (note) document.getElementById('status').textContent = note.trim();
}

export function downloadGEDCOM() {
  const text = serializeGEDCOM();
  _downloadBlob('﻿' + text, _baseFilename() + '_edited.ged', 'text/plain;charset=utf-8');
  _setDirty(false);
  _noteEstimated();
}

export function downloadJSON() {
  const text = GEDCOMModule.exportJSON(state.individuals, state.families, _exportExtra());
  _downloadBlob(text, _baseFilename() + '.famtree.json', 'application/json;charset=utf-8');
  _noteEstimated();
}

export function downloadYAML() {
  const text = GEDCOMModule.exportYAML(state.individuals, state.families, _exportExtra());
  _downloadBlob(text, _baseFilename() + '.famtree.yaml', 'text/yaml;charset=utf-8');
  _noteEstimated();
}

async function _archive(name, subset = null) {
  const src = subset || { individuals: state.individuals, families: state.families, media: state.media };
  const status = document.getElementById('status');
  return buildMediaArchive({ ...src, otherLines: state.otherLines, baseName: name }, {
    onProgress: (i, n) => { if (status && n > 20) status.textContent = t('media.packing', { i, n }); },
  });
}

/** The tree and its media files as one .zip — what another program imports. */
export async function downloadWithMedia() {
  const status = document.getElementById('status');
  try {
    const { blob, files, missing } = await _archive(_baseFilename());
    _downloadBlob(blob, _baseFilename() + '.zip', 'application/zip');
    _setDirty(false);
    status.textContent = t('media.zipDone', { n: files }) + (missing ? ' ' + t('media.zipMissing', { n: missing }) : '');
  } catch (err) {
    status.textContent = t('errors.saveError', { msg: err.message });
  }
}

// The people the chart is currently drawing, as standalone individuals/families
// maps the ordinary serializers can take. Read off state.nodes rather than
// recomputing the focus walk, so it is exactly what is on screen — the
// generation band and the surname filter cut into the focus set after it.
//
// Every reference that leaves the selection is pruned: a FAMC naming a family
// that was not exported, or a HUSB naming somebody who was not, is a dangling
// pointer that breaks the file on the way back in. The originals are left
// untouched — these are copies.
export function visibleSubset() {
  const keep = new Set(state.nodes.filter(n => n.type === 'INDI').map(n => n.id));
  const individuals = new Map();
  const families    = new Map();
  const media       = new Map();
  const useMedia = o => { for (const id of o.media || []) if (state.media.has(id)) media.set(id, state.media.get(id)); };

  // A family is worth exporting while it still says something. One surviving
  // spouse is enough — dropping the marriage because the *other* spouse is
  // off-screen would throw away the marriage date. Two surviving children are
  // enough too, since that is what records them as siblings. A family reduced
  // to a single child and no parents states nothing at all.
  for (const [fid, fam] of state.families) {
    const husb = fam.husb && keep.has(fam.husb) ? fam.husb : null;
    const wife = fam.wife && keep.has(fam.wife) ? fam.wife : null;
    const chil = (fam.chil || []).filter(c => keep.has(c));
    if (!husb && !wife && chil.length < 2) continue;
    families.set(fid, { ...fam, id: fid, husb, wife, chil });
    useMedia(fam);
  }
  for (const id of keep) {
    const indi = state.individuals.get(id);
    if (!indi) continue;
    individuals.set(id, {
      ...indi,
      id,
      famc: (indi.famc || []).filter(f => families.has(f)),
      fams: (indi.fams || []).filter(f => families.has(f)),
    });
    useMedia(indi);
  }
  return { individuals, families, media };
}

export function downloadSelectionGEDCOM() {
  const { individuals, families, media } = visibleSubset();
  // otherLines are the file's own SOUR/REPO/SUBM records — metadata about the
  // source, not about anybody, so they travel with any subset.
  const text = GEDCOMModule.serializeGEDCOM(individuals, families, state.otherLines, media);
  _downloadBlob('﻿' + text, _baseFilename() + '_selection.ged', 'text/plain;charset=utf-8');
}

export function downloadSelectionJSON() {
  const { individuals, families, media } = visibleSubset();
  const text = GEDCOMModule.exportJSON(individuals, families, { media, otherLines: state.otherLines });
  _downloadBlob(text, _baseFilename() + '_selection.famtree.json', 'application/json;charset=utf-8');
}

export function toggleExportMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('export-dropdown');
  const open = dd.classList.toggle('open');
  if (open) {
    placeTopbarMenu(dd);
    document.addEventListener('click', closeExportMenu, { once: true });
  }
}

export function closeExportMenu() {
  document.getElementById('export-dropdown').classList.remove('open');
}
