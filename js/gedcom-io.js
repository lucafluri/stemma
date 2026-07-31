import { state } from './state.js';
import { buildSurnameColorMap, buildSurnameList } from './colors.js';
import { DECEASED_AGE_THRESHOLD, buildGraphData, updateFocusUI } from './graph-data.js';
import { applyHighlight } from './relations.js';
import { applyFilter, autoSettle, buildAndRunSimulation, initSVG, renderGraph } from './render-2d.js';
import { _push3DData, _setOrbitTarget3D, apply3DPhysics, build3DTimeline, initGraph3D, update3DNames, updateViewToggleUI } from './render-3d.js';

export function _setDirty(v) {
  state._gedcomDirty = v;
  const btn = document.getElementById('dl-btn');
  if (btn) btn.classList.toggle('has-unsaved', v);
  if (v) _autosave(); else localStorage.removeItem('gedcomAutosave');
}

window.addEventListener('beforeunload', e => {
  if (state._gedcomDirty) { e.preventDefault(); e.returnValue = ''; }
});

export function _autosave() {
  clearTimeout(state._autosaveTimer);
  state._autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem('gedcomAutosave', JSON.stringify({
        filename: window._gedcomFilename || '',
        ts: Date.now(),
        ged: serializeGEDCOM()
      }));
    } catch (e) { /* quota exceeded — silently skip autosave */ }
  }, 2000);
}

export function _tryRestoreAutosave() {
  const raw = localStorage.getItem('gedcomAutosave');
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch (e) { localStorage.removeItem('gedcomAutosave'); return; }
  const when = new Date(data.ts).toLocaleString(currentLang === 'de' ? 'de-CH' : 'en-US');
  const label = data.filename || t('autosave.unnamed');
  if (confirm(t('autosave.found', { name: label, date: when }))) {
    // Autosave content is always GEDCOM — force .ged so a .json/.yaml original
    // filename doesn't route it into the JSON/YAML importer
    const fname = (data.filename || t('autosave.restoredName')).replace(/\.(ged|json|ya?ml)$/i, '') + '.ged';
    _loadDatasetFile(new File([data.ged], fname));
    _autosave(); // loading marks the session clean, but this data is still unsaved to disk
  } else {
    localStorage.removeItem('gedcomAutosave');
  }
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
  console.time('[rebuild] total');
  console.time('[rebuild] surnameColorMap'); const sorted = buildSurnameColorMap(); console.timeEnd('[rebuild] surnameColorMap');
  console.time('[rebuild] surnameList');     buildSurnameList(sorted);               console.timeEnd('[rebuild] surnameList');
  console.time('[rebuild] buildGraphData');  buildGraphData();                        console.timeEnd('[rebuild] buildGraphData');
  if (!state.svgSel) initSVG();
  console.time('[rebuild] renderGraph');     renderGraph();                           console.timeEnd('[rebuild] renderGraph');
  document.getElementById('status').textContent =
    t('topbar.status', { persons: state.individuals.size, personsPlural: state.individuals.size !== 1 ? 'en' : '', families: state.families.size });
  if (!warm) state._firstLoad = true;
  console.time('[rebuild] simulation');      buildAndRunSimulation({ warm });         console.timeEnd('[rebuild] simulation');
  // For 3D: push data directly instead of calling applyFilter() which would
  // run buildAndRunSimulation() a second time (doubles the sim cost).
  if (state.currentView === '3d' && state.graph3d) {
    console.time('[rebuild] 3d data push');
    _push3DData();
    apply3DPhysics();
    build3DTimeline();
    update3DNames();
    console.timeEnd('[rebuild] 3d data push');
  }
  // renderGraph() rebuilds all DOM/3D nodes from scratch, dropping highlight
  // opacity and orbit target — restore them so editing a person/family
  // doesn't visually clear the selection the user was looking at.
  applyHighlight();
  if (state.currentView === '3d' && state.selectedIndiId) _setOrbitTarget3D(state.selectedIndiId);
  updateFocusUI();
  console.timeEnd('[rebuild] total');
}

export function _autoMarkDeceasedByAge() {
  const cutoffYear = new Date().getFullYear() - DECEASED_AGE_THRESHOLD;
  for (const indi of state.individuals.values()) {
    if (!indi.deceased && indi.birthYear && indi.birthYear <= cutoffYear) indi.deceased = true;
  }
}

export function _loadDatasetFile(file) {
  if (!file) return;

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
      document.getElementById('dl-wrap').style.display = 'flex';
      document.getElementById('center-view-btn').style.display = 'inline-block';
      document.getElementById('center-view-btn').disabled = false;
      document.getElementById('center-person-btn').style.display = 'inline-block';
      document.getElementById('relation-tool-btn').style.display = 'inline-block';
      document.getElementById('relation-tool-btn').disabled = false;
      document.getElementById('view-toggle-btn').disabled = false;
      window._gedcomFilename = file.name;
      _setDirty(false);

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
  URL.revokeObjectURL(url);
}

export function _baseFilename() {
  return (window._gedcomFilename || 'stammbaum').replace(/\.\w+$/i, '');
}

export function downloadGEDCOM() {
  const text = serializeGEDCOM();
  _downloadBlob('﻿' + text, _baseFilename() + '_edited.ged', 'text/plain;charset=utf-8');
  _setDirty(false);
}

export function downloadJSON() {
  const text = GEDCOMModule.exportJSON(state.individuals, state.families);
  _downloadBlob(text, _baseFilename() + '.famtree.json', 'application/json;charset=utf-8');
}

export function downloadYAML() {
  const text = GEDCOMModule.exportYAML(state.individuals, state.families);
  _downloadBlob(text, _baseFilename() + '.famtree.yaml', 'text/yaml;charset=utf-8');
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
