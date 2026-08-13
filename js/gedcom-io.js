import { state } from './state.js';
import { lsGet, lsRemove, lsSet } from './settings.js';
import { AUTO_FOCUS_THRESHOLD, perf } from './constants.js';
import { buildSurnameColorMap, buildSurnameList } from './colors.js';
import { DECEASED_AGE_THRESHOLD, _defaultFocusRoot, buildGraphData, computeEstimatedYears, updateFocusUI } from './graph-data.js';
import { applyHighlight } from './relations.js';
import { applyFilter, autoSettle, buildAndRunSimulation, initSVG, renderGraph } from './render-2d.js';
import { captureBaseline, refreshChanges } from './changes.js';
import { refreshMap } from './map-view.js';
import { refreshStats } from './stats.js';
import { _push3DData, _setOrbitTarget3D, apply3DPhysics, build3DTimeline, initGraph3D, update3DNames, updateViewToggleUI } from './render-3d.js';

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
  if (v) _autosave(); else { lsRemove('gedcomAutosave'); state._autosaveCaptured = false; }
}

// Leaving with edits that exist nowhere but this tab is worth interrupting for.
// Once the autosave has written *these* edits, it is not: the restore bar
// offers them back on the next load, so the prompt would be asking about work
// that is already safe. A failed autosave (quota) never sets the flag, so the
// warning stands exactly when the data really is only here.
window.addEventListener('beforeunload', e => {
  if (state._gedcomDirty && !state._autosaveCaptured) { e.preventDefault(); e.returnValue = ''; }
});

export function _autosave() {
  clearTimeout(state._autosaveTimer);
  state._autosaveTimer = setTimeout(() => {
    // lsSet reports whether the write landed rather than throwing. A false here
    // is quota (or storage switched off entirely), and leaving _autosaveCaptured
    // alone is what keeps the beforeunload warning up: the edits really are only
    // in this tab.
    if (lsSet('gedcomAutosave', JSON.stringify({
      filename: window._gedcomFilename || '',
      ts: Date.now(),
      ged: serializeGEDCOM(),
    }))) state._autosaveCaptured = true;
  }, 2000);
}

export function _tryRestoreAutosave() {
  const raw = lsGet('gedcomAutosave');
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch (e) { lsRemove('gedcomAutosave'); return; }
  const when = new Date(data.ts).toLocaleString(currentLang === 'de' ? 'de-CH' : 'en-US');
  const label = data.filename || t('autosave.unnamed');

  const bar = document.getElementById('autosave-bar');
  if (!bar) return;   // headless/test environment with no DOM shell
  document.getElementById('autosave-bar-text').textContent = t('autosave.found', { name: label, date: when });
  bar.style.display = 'flex';

  const restoreBtn = document.getElementById('autosave-restore-btn');
  const discardBtn = document.getElementById('autosave-discard-btn');
  restoreBtn.onclick = () => {
    bar.style.display = 'none';
    // Autosave content is always GEDCOM — force .ged so a .json/.yaml original
    // filename doesn't route it into the JSON/YAML importer
    const fname = (data.filename || t('autosave.restoredName')).replace(/\.(ged|json|ya?ml)$/i, '') + '.ged';
    _loadDatasetFile(new File([data.ged], fname));
    _autosave(); // loading marks the session clean, but this data is still unsaved to disk
  };
  discardBtn.onclick = () => {
    bar.style.display = 'none';
    lsRemove('gedcomAutosave');
  };
}

export function parseGEDCOM(raw) {
  const result = GEDCOMModule.parseGEDCOM(raw);
  state.individuals.clear();
  state.families.clear();
  for (const [k, v] of result.individuals) state.individuals.set(k, v);
  for (const [k, v] of result.families)    state.families.set(k, v);
  state.otherLines = result.otherLines || [];
}

export function _fullRebuildGraph(opts = {}) {
  const warm = !!opts.warm;
  if (!warm) state._nodeObjCache = new Map(); // dataset-level change: don't reuse positions from a possibly-unrelated previous dataset
  if (state.focusRootId && !state.individuals.has(state.focusRootId)) state.focusRootId = null;  // focus person was deleted
  // Generation numbers are only meaningful for the file that produced them.
  // (The caches they come from are cleared in buildGraphData(), which every
  // path that changes the data goes through — including the file loader,
  // which never calls this function.)
  if (!warm) state.genRange = null;
  _setDirty(true);
  perf.start('[rebuild] total');
  perf.start('[rebuild] surnameColorMap'); const sorted = buildSurnameColorMap(); perf.end('[rebuild] surnameColorMap');
  perf.start('[rebuild] surnameList');     buildSurnameList(sorted);               perf.end('[rebuild] surnameList');
  perf.start('[rebuild] buildGraphData');  buildGraphData();                        perf.end('[rebuild] buildGraphData');
  if (!state.svgSel) initSVG();
  perf.start('[rebuild] renderGraph');     renderGraph();                           perf.end('[rebuild] renderGraph');
  document.getElementById('status').textContent =
    t('topbar.status', { persons: state.individuals.size, personsPlural: state.individuals.size !== 1 ? 'en' : '', families: state.families.size });
  if (!warm) state._firstLoad = true;
  perf.start('[rebuild] simulation');      buildAndRunSimulation({ warm });         perf.end('[rebuild] simulation');
  // For 3D: push data directly instead of calling applyFilter() which would
  // run buildAndRunSimulation() a second time (doubles the sim cost).
  if (state.currentView === '3d') {
    perf.start('[rebuild] 3d data push');
    if (!state.graph3d) {
      // Nothing has built the scene yet. That happens when the tree was created
      // from scratch rather than loaded from a file — the file loader is what
      // used to call this, so building the very first person on an empty page
      // in the 3D view drew nothing at all, for good: the person existed and
      // was listed in the sidebar, and the canvas stayed black.
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

// Nobody born more than DECEASED_AGE_THRESHOLD years ago is still alive, so a
// record that never said so is simply incomplete rather than a claim that they
// are living.
//
// Most people in a genealogy have no birth date at all, and leaving all of them
// unmarked is the case this used to miss entirely — the tree is full of
// 18th-century ancestors drawn as though they might be about. Where there is no
// recorded year the estimate stands in: it is derived from the years their
// relatives do have, so someone three generations above a person born in 1900 is
// placed around 1810 and marked, on the same rule.
//
// The estimate is a guess, and this writes `1 DEAT Y` into the file on save.
// It only ever fills a blank — a recorded birth year always decides for itself,
// and anyone already marked is left alone.
export function _autoMarkDeceasedByAge() {
  const cutoffYear = new Date().getFullYear() - DECEASED_AGE_THRESHOLD;
  // Computing the estimates walks the whole tree, so only pay for it if somebody
  // actually lacks a year.
  let est = null;
  // Rebuilt on every call (i.e. every rebuild) rather than accumulated, so a
  // person who gains a recorded year, or is edited back off the deceased list,
  // drops out of the save notice instead of lingering there forever.
  state._autoDeceasedEstimated = [];
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
// recorded one — see the comment on _autoMarkDeceasedByAge above.
export function _estimatedDeceasedNote() {
  const list = state._autoDeceasedEstimated;
  if (!list || !list.length) return '';
  const names = list.map(p => `${p.name} (~${p.year})`).join(', ');
  return ' ' + t('topbar.estimatedDeceasedNote', { count: list.length, names });
}

// `handle` is the File System Access handle the file came from, when it came
// from one. Every other caller — the import wizard, the autosave restore — hands
// over a detached File and so clears it: without that, "save" would still be
// pointing at whatever file was opened before this one and would write the new
// data straight over it.
export function _loadDatasetFile(file, handle = null) {
  if (!file) return;
  state._fileHandle = handle;
  // Whatever was opened last is what the reopen button should offer, so the
  // remembering happens here — the one point every route into the app funnels
  // through — rather than at each of them. Doing it per entry point is how the
  // import paths ended up leaving the button pointing at a file opened long ago.
  if (handle) _saveRecentHandle(handle).catch(() => { /* private mode, no store */ });

  document.getElementById('status').textContent = t('graph.loading');
  document.getElementById('loading-overlay').style.display = 'flex';

  const reader = new FileReader();
  reader.onload = evt => {
    try {
      state._nodeObjCache = new Map(); // fresh dataset: don't reuse positions from a possibly-unrelated previous one
      state.focusRootId = null;        // and no focus person carries over
      state.genRange = null;           // nor a band of generations this file may not have
      const ext = file.name.toLowerCase();
      if (ext.endsWith('.json')) {
        const result = GEDCOMModule.importJSON(evt.target.result);
        state.individuals.clear(); state.families.clear();
        result.individuals.forEach((v, k) => state.individuals.set(k, v));
        result.families.forEach((v, k) => state.families.set(k, v));
        state.otherLines = [];
      } else if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
        const result = GEDCOMModule.importYAML(evt.target.result);
        state.individuals.clear(); state.families.clear();
        result.individuals.forEach((v, k) => state.individuals.set(k, v));
        result.families.forEach((v, k) => state.families.set(k, v));
        state.otherLines = [];
      } else {
        parseGEDCOM(evt.target.result);
      }

      const iCount = state.individuals.size;
      const fCount = state.families.size;
      document.getElementById('status').textContent =
        t('topbar.statusLoaded', { persons: iCount, families: fCount });

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
      window._gedcomFilename = file.name;
      _setDirty(false);
      updateFileButtons();

      updateViewToggleUI();
      updateFocusUI();
      if (state.currentView === '3d') {
        initGraph3D();
        setTimeout(autoSettle, 400); // let initGraph3D finish before annealing
      }

    } catch (err) {
      document.getElementById('loading-overlay').style.display = 'none';
      document.getElementById('status').textContent = t('errors.loadError', { msg: err.message });
      console.error(err);
    }
  };
  reader.onerror = () => {
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('status').textContent = t('errors.readError');
  };
  reader.readAsText(file, 'UTF-8');
}

// Everything that only makes sense once there are people to look at: the export
// menu, the view and framing buttons, and — inversely — the empty-state card
// over the canvas. Driven off `individuals.size` rather than "a file was just
// opened", so deleting the last person puts the empty state back instead of
// leaving a set of buttons that act on nothing.
//
// Both routes into a populated tree (opening a file, adding the first person by
// hand) used to spell out the same six lines and had already drifted apart.
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
  // Hiding the wrapper takes an open dropdown with it — it is a child.
  document.getElementById('tools-wrap').style.display = has ? 'flex' : 'none';
  document.getElementById('view-toggle-btn').disabled = !has;
}

// ── The working file ────────────────────────────────────────────────────────
// Reopening the last file and saving back over it both need a handle to the
// file itself, which only the File System Access API gives. A file chosen
// through <input type="file"> is a detached copy: there is no way back to where
// it came from, which is why "save" has always meant "download another copy".
//
// Handles survive a reload, but only in IndexedDB — they are structured-clone
// values, not strings, so localStorage cannot hold one. Permission does not
// survive, and re-granting it must happen inside a user gesture; both entry
// points here are click handlers, which is what makes that legal.

export function fileAccessSupported() {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

function _idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('gedcomVis', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      // Read the result inside oncomplete: the transaction commits on its own
      // as soon as the event loop runs dry, so it cannot outlive this callback.
      const req = fn(db.transaction('handles', mode).objectStore('handles'));
      req.transaction.oncomplete = () => { db.close(); resolve(req.result); };
      req.transaction.onerror    = () => { db.close(); reject(req.transaction.error); };
    };
  });
}

export const _saveRecentHandle = h  => _idb('readwrite', s => s.put(h, 'recent'));
export const _readRecentHandle = () => _idb('readonly',  s => s.get('recent'));

// Whether we may touch the file yet. Asking is only allowed from a gesture, so
// `ask` is false for the passive check that decides how to label the buttons.
async function _permitted(handle, ask) {
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return ask && await handle.requestPermission(opts) === 'granted';
}

// Save in the format the file already is, not the one we happen to prefer —
// writing GEDCOM text into a file called .json is how you corrupt somebody's
// data while telling them it was saved.
function _textForFile(name) {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.json')) return GEDCOMModule.exportJSON(state.individuals, state.families);
  if (n.endsWith('.yaml') || n.endsWith('.yml')) return GEDCOMModule.exportYAML(state.individuals, state.families);
  return '﻿' + serializeGEDCOM();
}

export async function openRecentFile() {
  if (!fileAccessSupported()) return;
  try {
    let handle = state._fileHandle || await _readRecentHandle();
    // Nothing remembered yet, or the file is gone — pick one, and that becomes
    // the file both buttons mean from now on.
    if (!handle || !await _permitted(handle, true)) {
      if (handle) return;   // permission was refused; not our place to override
      [handle] = await window.showOpenFilePicker({
        types: [{ description: 'GEDCOM / JSON / YAML', accept: { 'text/plain': ['.ged', '.json', '.yaml', '.yml'] } }],
      });
      if (!handle || !await _permitted(handle, true)) return;
    }
    const file = await handle.getFile();
    _loadDatasetFile(file, handle);   // which is what records it as the recent one
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
    const w = await handle.createWritable();
    await w.write(_textForFile(name));
    await w.close();

    window._gedcomFilename = name;
    await _saveRecentHandle(handle);
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
    // Offering the buttons anyway would promise something they cannot do.
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
    ? '↻ <span>' + escHtml(recent) + '</span>'
    : '\u{1F4C1} <span>' + escHtml(t('topbar.openFile')) + '</span>';
  openBtn.title = recent ? t('topbar.openRecentTitle', { name: recent }) : t('topbar.openFileTitle');

  // The save button only appears once the data on screen came from a file we
  // can write back to, so what it would overwrite is never in doubt.
  const live = state._fileHandle?.name;
  saveBtn.style.display = live ? 'inline-block' : 'none';
  if (live) {
    saveBtn.innerHTML = '\u{1F4BE} <span>' + escHtml(live) + '</span>';
    saveBtn.title = t('topbar.saveToTitle', { name: live });
  }
}

export const _GD_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

export function _safeId(gedcomId) {
  return String(gedcomId).replace(/[^a-zA-Z0-9]/g, '_');
}

export function _parseGedcomDate(str) {
  if (!str) return { prefix: '', day: '', month: '', year: '' };
  str = str.trim().toUpperCase();
  let prefix = '';
  for (const p of ['ABT','BEF','AFT','EST','CAL','INT']) {
    if (str.startsWith(p + ' ') || str === p) {
      prefix = p; str = str.slice(p.length).trim(); break;
    }
  }
  if (str.startsWith('BET ')) {
    prefix = 'BET'; str = str.slice(4).trim();
    const ai = str.indexOf(' AND ');
    if (ai >= 0) str = str.slice(0, ai).trim();
  }
  let day = '', month = '', year = '';
  for (const part of str.split(/\s+/)) {
    if (!day && !year && /^\d{1,2}$/.test(part)) { day = part; continue; }
    if (!month && _GD_MONTHS.includes(part))      { month = part; continue; }
    if (!year  && /^\d{3,4}$/.test(part))         { year = part; }
  }
  return { prefix, day, month, year };
}

export function _gedcomDateWidget(fieldId, value) {
  const { prefix, day, month, year } = _parseGedcomDate(value);
  const monthOpts = _GD_MONTHS.map(m =>
    `<option value="${m}"${month===m?' selected':''}>${m[0]}${m.slice(1).toLowerCase()}</option>`
  ).join('');
  const prefixOpts = [['', t('dateWidget.exact')],['ABT', t('dateWidget.about')],['BEF', t('dateWidget.before')],['AFT', t('dateWidget.after')],['EST', t('dateWidget.estimated')]]
    .map(([v,l]) => `<option value="${v}"${prefix===v?' selected':''}>${l}</option>`).join('');
  return `<div class="gd-widget" id="${fieldId}">` +
    `<select class="gd-prefix">${prefixOpts}</select>` +
    `<input  class="gd-day"    type="number" min="1" max="31" placeholder="${t('dateWidget.dayPlaceholder')}"   value="${day}"  title="${t('dateWidget.day')}">` +
    `<select class="gd-month"><option value="">${t('dateWidget.monthPlaceholder')}</option>${monthOpts}</select>` +
    `<input  class="gd-year"   type="number" min="1" max="2200" placeholder="${t('dateWidget.yearPlaceholder')}" value="${year}" title="${t('dateWidget.year')}">` +
    `</div>`;
}

export function _gedcomDateValue(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return '';
  const prefix = el.querySelector('.gd-prefix').value;
  const day    = el.querySelector('.gd-day').value.trim();
  const month  = el.querySelector('.gd-month').value;
  const year   = el.querySelector('.gd-year').value.trim();
  const parts  = [];
  if (prefix) parts.push(prefix);
  if (day)    parts.push(String(parseInt(day, 10)));
  if (month)  parts.push(month);
  if (year)   parts.push(year);
  return parts.join(' ');
}

export function escHtml(s) {
  if (!s) return '';
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
  if (!s) return '';
  return escHtml(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

export function serializeGEDCOM() {
  return GEDCOMModule.serializeGEDCOM(state.individuals, state.families, state.otherLines);
}

export function _downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  // Revoking in the same tick races the download the click just started —
  // Chromium happens to get away with it, Firefox drops the file. One turn of
  // the event loop is enough for the browser to have taken hold of the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function _baseFilename() {
  return (window._gedcomFilename || 'stammbaum').replace(/\.\w+$/i, '');
}

export function downloadGEDCOM() {
  const text = serializeGEDCOM();
  _downloadBlob('﻿' + text, _baseFilename() + '_edited.ged', 'text/plain;charset=utf-8');
  _setDirty(false);
  const note = _estimatedDeceasedNote();
  if (note) document.getElementById('status').textContent = note.trim();
}

export function downloadJSON() {
  const text = GEDCOMModule.exportJSON(state.individuals, state.families);
  _downloadBlob(text, _baseFilename() + '.famtree.json', 'application/json;charset=utf-8');
  const note = _estimatedDeceasedNote();
  if (note) document.getElementById('status').textContent = note.trim();
}

export function downloadYAML() {
  const text = GEDCOMModule.exportYAML(state.individuals, state.families);
  _downloadBlob(text, _baseFilename() + '.famtree.yaml', 'text/yaml;charset=utf-8');
  const note = _estimatedDeceasedNote();
  if (note) document.getElementById('status').textContent = note.trim();
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

  // A family is worth exporting while it still says something. One surviving
  // spouse is enough — dropping the marriage because the *other* spouse is
  // off-screen would throw away the marriage date, which is a fact about the
  // person who is in the selection. Two surviving children are enough too, since
  // that is what records them as siblings. A family reduced to a single child
  // and no parents states nothing at all, so it is left out rather than
  // exported as an empty shell.
  for (const [fid, fam] of state.families) {
    const husb = fam.husb && keep.has(fam.husb) ? fam.husb : null;
    const wife = fam.wife && keep.has(fam.wife) ? fam.wife : null;
    const chil = (fam.chil || []).filter(c => keep.has(c));
    if (!husb && !wife && chil.length < 2) continue;
    families.set(fid, { ...fam, id: fid, husb, wife, chil });
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
  }
  return { individuals, families };
}

export function downloadSelectionGEDCOM() {
  const { individuals, families } = visibleSubset();
  // otherLines are the file's own SOUR/OBJE/SUBM records — metadata about the
  // source, not about anybody, so they travel with any subset.
  const text = GEDCOMModule.serializeGEDCOM(individuals, families, state.otherLines);
  _downloadBlob('﻿' + text, _baseFilename() + '_selection.ged', 'text/plain;charset=utf-8');
}

export function downloadSelectionJSON() {
  const { individuals, families } = visibleSubset();
  const text = GEDCOMModule.exportJSON(individuals, families);
  _downloadBlob(text, _baseFilename() + '_selection.famtree.json', 'application/json;charset=utf-8');
}

export function toggleExportMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('export-dropdown');
  const open = dd.classList.toggle('open');
  if (open) {
    document.addEventListener('click', closeExportMenu, { once: true });
  }
}

export function closeExportMenu() {
  document.getElementById('export-dropdown').classList.remove('open');
}

export function _resetGedcomDateWidget(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  const p = el.querySelector('.gd-prefix'); if (p) p.value = '';
  const d = el.querySelector('.gd-day');    if (d) d.value = '';
  const m = el.querySelector('.gd-month');  if (m) m.value = '';
  const y = el.querySelector('.gd-year');   if (y) y.value = '';
}
