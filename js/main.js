import * as ChangesMod from './changes.js';
import * as ColorsMod from './colors.js';
import * as GedcomIoMod from './gedcom-io.js';
import * as GraphDataMod from './graph-data.js';
import * as FindMod from './find.js';
import * as ImportMod from './import.js';
import * as MapViewMod from './map-view.js';
import * as MediaMod from './media.js';
import * as SearchMod from './search.js';
import * as PanelsMod from './panels.js';
import * as PlacesMod from './places.js';
import * as RelationsMod from './relations.js';
import * as Render2dMod from './render-2d.js';
import * as Render3dMod from './render-3d.js';
import * as StatsMod from './stats.js';
import * as TreeLayoutMod from './tree-layout.js';
import { resetLinkColors, toggleAllSurnames } from './colors.js';
import { _downloadBlob, _fullRebuildGraph, _tryRestoreAutosave, showDataUI, syncMediaUI, updateFileButtons } from './gedcom-io.js';
import { focusOnPerson, goToPerson, updateFocusUI } from './graph-data.js';
import { openNodeContextMenu } from './context-menu.js';
import { _initPanelMediaDrop, closeDetailPanel, showFamDetail, showIndiDetail, startEdit } from './panels.js';
import { closeRelationTool, highlightMode, openRelationTool, relPickSlot, relSearch, resetHighlight, updateHLButtons } from './relations.js';
import { SLIDER_MAP, _rerenderNodes, applyFilter, applyPhysicsParams, autoSettle, centerOnPerson, centerView, reheatSimulation, refreshTreeLineageColoring, renderPresetList, resetView, schedulePhysicsParams, syncLabelStyleUI, syncNodeDragBtn, syncPhysicsUI, toggleNodeDrag, zoomToFit } from './render-2d.js';
import { _push3DData, apply3DPhysics, build3DTimeline, cull3D, setCull3D, toggleView, update3DNames, update3DSceneInfo, updateViewToggleUI } from './render-3d.js';
import { exportSettings, importSettings, readSetting, resetSettings, saveSetting, writeSetting } from './settings.js';
import { state } from './state.js';
import { applyTimelineYFix } from './tree-layout.js';
import { MOBILE_MAX_WIDTH, placeTopbarMenu } from './constants.js';
import { linkMediaFolder, mediaAvailability, pruneStoredMedia } from './media.js';
import { personLabel, searchPeople } from './search.js';

// The topbar "Tools" menu. Same shape as the export split button's dropdown:
// a one-shot outside-click listener closes it, so nothing has to be torn down
// when it goes away by being used.
export function toggleToolsMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('tools-dropdown');
  const open = dd.classList.toggle('open');
  document.getElementById('tools-btn')?.setAttribute('aria-expanded', String(open));
  if (open) {
    placeTopbarMenu(dd);
    document.addEventListener('click', closeToolsMenu, { once: true });
  }
}

export function closeToolsMenu() {
  document.getElementById('tools-dropdown')?.classList.remove('open');
  document.getElementById('tools-btn')?.setAttribute('aria-expanded', 'false');
}

export function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('sidebar-open');
  document.getElementById('sidebar-overlay').classList.toggle('visible');
}

// On a phone the sidebar is a drawer over the whole screen, so anything in it
// whose result appears *behind* it has to shut it on the way out — otherwise
// picking a name looks like it did nothing at all.
function _closeMobileSidebar() {
  if (window.innerWidth > MOBILE_MAX_WIDTH) return;
  document.getElementById('sidebar')?.classList.remove('sidebar-open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
}

export function _initPanelSwipe() {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;

  panel.addEventListener('touchstart', evt => {
    // Only handle swipe on the drag handle area (top 40px) or if panel is scrolled to top
    const y = evt.touches[0].clientY;
    const rect = panel.getBoundingClientRect();
    const offsetInPanel = y - rect.top;
    const scrolledToTop = panel.scrollTop <= 0;
    if (offsetInPanel > 40 && !scrolledToTop) return;

    state._panelSwipe = { startY: y, currentY: y };
    panel.style.transition = 'none';
  }, { passive: true });

  panel.addEventListener('touchmove', evt => {
    if (!state._panelSwipe) return;
    state._panelSwipe.currentY = evt.touches[0].clientY;
    const dy = Math.max(0, state._panelSwipe.currentY - state._panelSwipe.startY);  // only downward
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  panel.addEventListener('touchend', () => {
    if (!state._panelSwipe) return;
    panel.style.transition = '';
    const dy = state._panelSwipe.currentY - state._panelSwipe.startY;
    state._panelSwipe = null;
    if (dy > 80) {
      minimizeDetailPanel();
    } else {
      // Snap back
      if (panel.classList.contains('panel-visible')) {
        panel.style.transform = 'translateY(0)';
      }
    }
  }, { passive: true });
}

// Long-press timing for the node context menu on touch — no right mouse
// button to reach it with there, so a hold takes its place.
const LONG_PRESS_MS = 550;
let _longPressTimer = null;

function _cancelLongPress() {
  if (_longPressTimer) clearTimeout(_longPressTimer);
  _longPressTimer = null;
}

/** The node under a touch point, read off the DOM rather than threaded through
 * from the event target's d3 datum, so both the SVG (2D) and the 3D canvas
 * (whose hit-testing already happens in render-3d.js) can share this for the
 * SVG side without an extra prop being carried around. */
function _svgNodeAt(target) {
  const g = target?.closest?.('.ng');
  if (!g) return null;
  const id = g.dataset.nid;
  return state.nodes.find(n => n.id === id) || null;
}

export function _initTouchDragGuard() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  svg.addEventListener('touchstart', evt => {
    if (evt.touches.length === 1) {
      state._touchDragged = false;
      state._touchStartPos = { x: evt.touches[0].clientX, y: evt.touches[0].clientY };
      const touch = evt.touches[0];
      const node = _svgNodeAt(evt.target);
      _cancelLongPress();
      if (node) {
        _longPressTimer = setTimeout(() => {
          _longPressTimer = null;
          state._touchDragged = true;   // suppress the tap-to-select that follows
          openNodeContextMenu({ clientX: touch.clientX, clientY: touch.clientY }, node.id, node.type);
        }, LONG_PRESS_MS);
      }
    }
  }, { passive: true });
  svg.addEventListener('touchmove', evt => {
    if (state._touchStartPos && evt.touches.length === 1) {
      const dx = evt.touches[0].clientX - state._touchStartPos.x;
      const dy = evt.touches[0].clientY - state._touchStartPos.y;
      if (Math.hypot(dx, dy) > 8) { state._touchDragged = true; _cancelLongPress(); }
    }
  }, { passive: true });
  svg.addEventListener('touchend', () => {
    state._touchStartPos = null;
    _cancelLongPress();
  }, { passive: true });
}

export function wasTouchDrag() { return state._touchDragged; }

// The sidebar search: ranked, accent-insensitive, and able to reach anybody in
// the file — picking someone the chart is not drawing re-centres it on them.
let _searchHits = [];
function _runSidebarSearch() {
  const input = document.getElementById('search-input');
  const box = document.getElementById('search-results');
  const q = input.value.trim();
  box.innerHTML = '';
  _searchHits = [];
  if (q.length < 2) return;

  _searchHits = searchPeople(q, 25).map(h => h.id);
  for (const id of _searchHits) {
    const el = document.createElement('div');
    el.className = 'result-item';
    el.textContent = personLabel(id);
    el.addEventListener('click', () => _pickSearchHit(id));
    box.appendChild(el);
  }

  if (!_searchHits.length) {
    const el = document.createElement('div');
    el.className = 'result-item result-item--empty';
    el.textContent = t('detail.noMatches');
    box.appendChild(el);
  }
}

function _pickSearchHit(id) {
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  _searchHits = [];
  _closeMobileSidebar();
  goToPerson(id);
}

document.getElementById('search-input').addEventListener('input', _runSidebarSearch);
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && _searchHits.length) { e.preventDefault(); _pickSearchHit(_searchHits[0]); }
  else if (e.key === 'Escape') { e.target.value = ''; _runSidebarSearch(); e.target.blur(); }
});

document.addEventListener('click', e => {
  if (!e.target.closest('#search-input') && !e.target.closest('#search-results')) {
    document.getElementById('search-results').innerHTML = '';
  }
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case 'a': case 'A': toggleAllSurnames(true);  break;
    case 'n': case 'N': toggleAllSurnames(false); break;
    case 'f': case 'F': zoomToFit();              break;
    case 'c': case 'C': centerView();             break;
    case 'p': case 'P': centerOnPerson();         break;
    case 'e': case 'E': startEdit();              break;
    case 'r':
      resetHighlight();
      break;
    case 'R':
      // Shift+R reheats the simulation; plain R (or caps lock) still clears
      // the highlight — '+' used to double as reheat, fighting its own zoom.
      if (e.shiftKey && state.currentView === '2d' && state.simulation) reheatSimulation();
      else resetHighlight();
      break;
    case 'v': case 'V': toggleView();             break;
    case 'g': case 'G': if (state.selectedIndiId) focusOnPerson(state.selectedIndiId); break;
    case 'Escape':
      // A dialog or menu that is open takes Escape first.
      if (document.getElementById('media-viewer')?.style.display === 'flex') break;
      closeDetailPanel();
      break;
    case '/':
      // Jump to the search box, as in most apps with one.
      e.preventDefault();
      document.getElementById('search-input')?.focus();
      break;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  renderPresetList();
  // Names the last-opened file on the button before anything is loaded — that
  // offer is the whole point of it surviving the reload.
  updateFileButtons();
  _tryRestoreAutosave();

  // Touch support
  _initPanelSwipe();
  _initTouchDragGuard();
  _initPanelMediaDrop();

  // View + focus controls — slider bounds/labels are (re)computed in
  // updateFocusUI() below, since they depend on the loaded file.
  const tlt = document.getElementById('tree-layout-toggle');
  if (tlt) tlt.checked = state.treeLayout;
  const sft = document.getElementById('spouse-family-toggle');
  if (sft) sft.checked = state.includeSpouseFamily;
  updateViewToggleUI();
  updateFocusUI();
  showDataUI();   // sets the first-run state; the autosave restore above may already have replaced it

  // The physics sliders are restored from storage now, so the panel has to be
  // put where the settings actually are before any listener is attached —
  // otherwise it shows the markup's shipped numbers over a differently-tuned
  // simulation, and the first touch of any slider jumps the layout.
  syncPhysicsUI();

  for (const { sid, nid, key, fmt } of SLIDER_MAP) {
    const slider = document.getElementById(sid);
    const numIn  = document.getElementById(nid);
    if (!slider && !numIn) continue;

    if (slider) {
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        state.physicsParams[key] = v;
        if (numIn) numIn.value = fmt(v);
        // Coalesced to one apply per frame, and no Y repin: no physics slider
        // changes what the stratification pins depend on.
        schedulePhysicsParams({ repin: false });
        saveSetting('physics', state.physicsParams);
      });
    }

    if (numIn) {
      numIn.addEventListener('input', () => {
        const raw = numIn.value;
        if (raw === '' || raw === '-') return;
        const v = parseFloat(raw);
        if (!Number.isFinite(v)) return;
        state.physicsParams[key] = v;
        if (slider) slider.value = v;
        schedulePhysicsParams({ repin: false });
        saveSetting('physics', state.physicsParams);
      });
    }
  }

  // Color-by-surname toggle
  const colorBySurnameToggle = document.getElementById('color-by-surname');
  const colorModeLabelEl = document.getElementById('color-mode-label');
  function _syncColorModeLabel() {
    if (colorModeLabelEl) colorModeLabelEl.textContent = state.colorBySurname ? t('sidebar.colorModeSurname') : t('sidebar.colorModeSex');
  }
  if (colorBySurnameToggle) {
    colorBySurnameToggle.checked = state.colorBySurname;
    _syncColorModeLabel();
    colorBySurnameToggle.addEventListener('change', function () {
      state.colorBySurname = this.checked;
      saveSetting('colorBySurname', state.colorBySurname);
      _syncColorModeLabel();
      _rerenderNodes();       // 2D circles + labels
      update3DNames();        // rebuild 3D name sprites with new color
    });
  }

  // 3D: sort by time + show timeline
  const stratSel = document.getElementById('stratify-3d-select');
  if (stratSel) {
    stratSel.value = state.stratify3D;
    document.getElementById('time-spread-row').style.display =
      state.stratify3D !== 'off' ? 'block' : 'none';
    stratSel.addEventListener('change', function () {
      state.stratify3D = this.value;
      saveSetting('stratify3D', state.stratify3D);
      document.getElementById('time-spread-row').style.display =
        state.stratify3D !== 'off' ? 'block' : 'none';
      if (state.graph3d) {
        applyTimelineYFix();          // pin/unpin Y positions immediately
        state.graph3d.d3ReheatSimulation(); // let X/Z settle
        build3DTimeline();
      }
    });
  }

  // 3D: time axis spread slider + number input
  const spreadSlider = document.getElementById('time-spread-slider');
  const spreadNum    = document.getElementById('time-spread-num');

  function updateSpread(v) {
    state._3dYHalfSpanAuto = false;   // the reader has an opinion now — stop overriding it on rebuild
    state._3dYHalfSpan = v;
    saveSetting('timeSpread3D', v);   // ...and it survives the reload, like every other slider
    if (spreadSlider) spreadSlider.value = v;
    if (spreadNum) spreadNum.value = v;
    if (state.graph3d && state.stratify3D !== 'off') {
      applyTimelineYFix();          // recalculate Y pins with new halfSpan
      state.graph3d.d3ReheatSimulation();
      build3DTimeline();            // rebuild rings at new positions
    }
  }

  if (spreadSlider) {
    spreadSlider.addEventListener('input', () => updateSpread(+spreadSlider.value));
  }
  if (spreadNum) {
    spreadNum.addEventListener('input', () => {
      const raw = spreadNum.value;
      if (raw === '' || raw === '-') return;
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) return;
      updateSpread(v);
    });
  }

  // 3D: show/hide visual timeline axis (independent of Y stratification).
  // Both of these boxes are written `checked` in the markup and used to be left
  // that way, so the panel stated the opposite of the setting whenever the
  // setting was off — which show3DNames is by default on anything under 768px.
  const tlCb = document.getElementById('show-timeline-toggle');
  if (tlCb) {
    tlCb.checked = state.showTimeline3D;
    tlCb.addEventListener('change', function () {
      state.showTimeline3D = this.checked;
      saveSetting('showTimeline3D', state.showTimeline3D);
      build3DTimeline();
    });
  }

  // 3D: show names instead of spheres
  const namesCb = document.getElementById('show-names-3d-toggle');
  if (namesCb) {
    namesCb.checked = state.show3DNames;
    namesCb.addEventListener('change', function () {
      state.show3DNames = this.checked;
      saveSetting('show3DNames', state.show3DNames);
      update3DNames();
    });
  }

  // The instanced-rendering switch is persisted, so the box has to be set from
  // the setting rather than from whatever the markup happens to say.
  const instCb = document.getElementById('instanced-3d-toggle');
  if (instCb) instCb.checked = state.instanced3d;
  const cullCb = document.getElementById('cull-3d-toggle');
  if (cullCb) cullCb.checked = state.cull3d;
  // ...and the budget slider only shows while the budget applies.
  const cullRow = document.getElementById('sc-draw-max-row');
  if (cullRow) cullRow.style.display = state.cull3d ? '' : 'none';

  // Link and node colour pickers. Both used to change the running app and
  // nothing else: the value was never written to storage and the input was
  // never read back from it, so a recoloured chart came back in the shipped
  // colours on reload while the tree spacing beside it survived.
  for (const key of ['spouse', 'father', 'mother', 'parent']) {
    const el = document.getElementById('lc-' + key);
    if (!el) continue;
    el.value = state.linkColors[key];
    el.addEventListener('input', function () {
      state.linkColors[key] = this.value;
      saveSetting('linkColors', state.linkColors);
      updateLinkColors();
    });
  }

  const NC_MAP = { male: 'nc-male', female: 'nc-female', unknown: 'nc-unknown', fam: 'nc-fam', famDiv: 'nc-fam-div' };
  for (const [key, id] of Object.entries(NC_MAP)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = state.nodeColors[key];
    el.addEventListener('input', function () {
      state.nodeColors[key] = this.value;
      saveSetting('nodeColors', state.nodeColors);
      updateNodeColors();
    });
  }

  // FAM node size slider
  const famSizeSlider = document.getElementById('fam-node-size');
  const famSizeVal    = document.getElementById('fam-node-size-val');
  if (famSizeSlider) {
    famSizeSlider.value = state.famNodeSize;
    if (famSizeVal) famSizeVal.textContent = state.famNodeSize;
    famSizeSlider.addEventListener('input', function () {
      state.famNodeSize = parseInt(this.value);
      if (famSizeVal) famSizeVal.textContent = state.famNodeSize;
      saveSetting('famNodeSize', state.famNodeSize);
      _applyFamNodeSize();
    });
  }

  // Tree-spacing sliders (classical 2D chart only)
  for (const key of ['row', 'col', 'group', 'side']) {
    const slider = document.getElementById('tree-spacing-' + key);
    const num    = document.getElementById('tree-spacing-' + key + '-num');
    if (slider) slider.value = state.treeSpacing[key];
    if (num)    num.value = state.treeSpacing[key];
  }
  const lineageColorToggle = document.getElementById('tree-lineage-color-toggle');
  if (lineageColorToggle) {
    lineageColorToggle.checked = state.treeLineageColoring;
    lineageColorToggle.addEventListener('change', function () {
      state.treeLineageColoring = this.checked;
      saveSetting('treeLineageColoring', state.treeLineageColoring);
      refreshTreeLineageColoring();
    });
  }

  // ── 3D appearance controls ──
  // Driven off one table rather than eight near-identical listeners, so that
  // initialising the inputs *from* state costs nothing extra. That was the bug:
  // the markup's defaults (0.85 opacity, 2.4 link width, …) were a different set
  // of numbers than the ones actually being rendered, so the panel lied until
  // you touched a slider — and then the first touch jumped the scene.
  for (const c of AP_CONTROLS) {
    const el  = document.getElementById(c.id);
    if (!el) continue;
    // The typed box, where there is one. It deliberately accepts a wider range
    // than its slider — same bargain the physics panel already makes: the slider
    // covers the useful span, the box lets you go past it when you mean to.
    const num = c.dp == null ? null : document.getElementById(c.id + '-num');

    const show = v => {
      el.value = v;                                    // the slider clamps itself
      if (num && document.activeElement !== num) num.value = Number(v).toFixed(c.dp);
    };
    show(apValue(c));

    const commit = v => {
      if (c.dp == null) { apSet(c, v); c.apply(v); apPersist(c); return; }
      if (!Number.isFinite(v)) return;                 // half-typed "-" or ""
      apSet(c, v);
      c.apply(v);
      apPersist(c);
    };

    el.addEventListener('input', function () {
      const v = c.dp == null ? this.value : parseFloat(this.value);
      commit(v);
      if (c.dp != null && num) num.value = Number(v).toFixed(c.dp);
    });
    num?.addEventListener('input', function () {
      const v = parseFloat(this.value);
      commit(v);
      if (Number.isFinite(v)) el.value = v;
    });
    // Typing is allowed to leave the box mid-edit ("0.", "" while retyping);
    // leaving it is where the value gets tidied back to what actually took.
    num?.addEventListener('blur', () => show(apValue(c)));
  }
  // The label panel and the perf-log switch, both from the stored setting
  // rather than from whatever the markup happens to say.
  syncLabelStyleUI();
  const perfCb = document.getElementById('perf-log-toggle');
  if (perfCb) {
    perfCb.checked = readSetting('perfLog');
    // constants.js reads this once at module scope (it cannot import settings.js
    // without a cycle), so the switch only takes effect on the next load. That
    // is what the tooltip says.
    perfCb.addEventListener('change', function () { writeSetting('perfLog', this.checked); });
  }

  // Media attachments: the whole feature can be switched off.
  const mediaCb = document.getElementById('media-enabled-toggle');
  if (mediaCb) {
    mediaCb.checked = state.mediaEnabled;
    mediaCb.addEventListener('change', function () {
      state.mediaEnabled = this.checked;
      writeSetting('mediaEnabled', this.checked);
      syncMediaUI();
      _refreshDetailPanel();
    });
  }
  const deadCb = document.getElementById('auto-deceased-toggle');
  if (deadCb) {
    deadCb.checked = state.autoDeceased;
    deadCb.addEventListener('change', function () {
      state.autoDeceased = this.checked;
      writeSetting('autoDeceased', this.checked);
    });
  }
  syncMediaUI();

  update3DSceneInfo();
});

// `store` says where the value lives: the 3D appearance bag by default, `top`
// for the one that sits on state directly, `scene` for the scene budgets.
// `dp` is the decimal places shown in the box beside the slider (absent = it is
// a colour input with no readout).
const AP_CONTROLS = [
  { id: 'ap-bg-color',     key: 'bgColor',                apply: v => state.graph3d?.backgroundColor(v) },
  { id: 'ap-node-opacity', key: 'nodeOpacity',  dp: 2,    apply: v => state.graph3d?.nodeOpacity(v) },
  { id: 'ap-link-opacity', key: 'linkOpacity',  dp: 2,    apply: v => state.graph3d?.linkOpacity(v) },
  { id: 'ap-ambient',      key: 'ambientLight', dp: 1,    apply: v => { if (state._3dAmbientLight) state._3dAmbientLight.intensity = v; } },
  { id: 'ap-point',        key: 'pointLight',   dp: 1,    apply: v => { if (state._3dPointLight)   state._3dPointLight.intensity   = v; } },
  { id: 'ap-link-width',   key: 'linkWidth',    dp: 1,    apply: v => state.graph3d?.linkWidth(v) },
  { id: 'ap-node-size',    key: 'nodeRelSize',  dp: 1,    apply: v => state.graph3d?.nodeRelSize(v) },
  { id: 'ap-font-size',    key: '_3dFontSize',  dp: 0, store: 'top', setting: 'font3D', apply: () => update3DNames() },

  // ── Scene budgets ──
  // How many people the scene builds and how many it draws. Changing what is
  // *built* means handing the library a different set, which is a rebuild;
  // changing what is *drawn* is only a different answer from the cull, so it
  // takes effect on the next frame with nothing rebuilt.
  { id: 'sc-max-nodes',   key: 'maxNodes',  dp: 0, store: 'scene', apply: _apRebuildScene },
  { id: 'sc-draw-max',    key: 'drawMax',   dp: 0, store: 'scene', apply: () => { cull3D(true); update3DSceneInfo(); } },
  { id: 'sc-detail-max',  key: 'detailMax', dp: 0, store: 'scene', apply: _apRebuildScene },
];

const apBag = c => c.store === 'top' ? state : c.store === 'scene' ? state.scene3d : state._3dAppearance;
function apValue(c) { return apBag(c)[c.key]; }
function apSet(c, v) { apBag(c)[c.key] = v; }
function apPersist(c) {
  // `top` is the one control whose value does not live in the _3dAppearance
  // bag, so writing that bag saved everything about it except itself — the 3D
  // label size was the one slider in the panel that did not survive a reload.
  if (c.setting)                saveSetting(c.setting, state[c.key]);
  else if (c.store === 'scene') saveSetting('scene3d', state.scene3d);
  else                          saveSetting('appearance3d', state._3dAppearance);
}

// Rebuilding the scene is a visible pause on a large file, and these arrive one
// input event per pixel of slider travel. Coalesce to one rebuild once the
// dragging stops.
let _apSceneTimer = null;
function _apRebuildScene() {
  clearTimeout(_apSceneTimer);
  _apSceneTimer = setTimeout(() => {
    _apSceneTimer = null;
    if (!state.graph3d || state.currentView !== '3d') return;
    _push3DData();
    apply3DPhysics();
    update3DNames();
    updateFocusUI();          // the omitted-people count just changed
  }, 350);
}

// ── The settings themselves, as a thing you can carry ──────────────────────
//
// Everything the app remembers is one JSON object (see js/settings.js). That
// makes three operations possible that were not before: put it all back, take
// it to another browser, and bring it from one. A tuned physics/appearance
// setup is half an hour of slider dragging, and it used to be locked to the
// machine it was made on.

export function exportSettingsFile() {
  _downloadBlob(JSON.stringify(exportSettings(), null, 2),
    'stemma-settings.json', 'application/json');
}

function _refreshDetailPanel() {
  if (state._editingId) return;
  if (state.selectedIndiId) showIndiDetail(state.selectedIndiId);
  else if (state._lastShownFamId) showFamDetail(state._lastShownFamId);
}

/** Settings → "Locate media files…": pick the folder a tree's pictures live in. */
export async function locateMediaFiles() {
  const status = document.getElementById('status');
  const res = await linkMediaFolder();
  if (!res) return;
  status.textContent = t('media.linked', { n: res.matched, missing: res.missing });
  _refreshDetailPanel();
}

/** Settings → "Clean up stored media": drop files no record of this tree uses. */
export async function cleanStoredMedia() {
  if (!confirm(t('media.pruneConfirm'))) return;
  const n = await pruneStoredMedia();
  document.getElementById('status').textContent = t('media.pruned', { n });
}

/** Settings → how many of the tree's media files this browser actually has. */
export async function reportMediaStatus() {
  const a = await mediaAvailability();
  document.getElementById('status').textContent = t('media.status', a);
}

export function importSettingsFile(input) {
  const file = input?.files?.[0];
  if (!file) return;
  input.value = '';   // so choosing the same file twice still fires
  file.text().then(text => {
    let bag;
    try { bag = JSON.parse(text); }
    catch { alert(t('settings.importBadFile')); return; }
    const n = importSettings(bag);
    if (!n) { alert(t('settings.importBadFile')); return; }
    // Half of these are read once at module scope and half are baked into a
    // live simulation, so there is no honest way to apply them in place.
    if (confirm(t('settings.importDone', { n }))) location.reload();
  });
}

export function resetAllSettings() {
  if (!confirm(t('settings.resetConfirm'))) return;
  // resetSettings() touches only the keys the registry owns — the autosaved
  // GEDCOM and the geocoded place cache live in the same storage and are not
  // settings. Losing either to a "put the colours back" click would be
  // unforgivable.
  resetSettings();
  location.reload();
}

// These labels are built in JS, so data-i18n can't retranslate them.
function _onLanguageChanged() {
  updateViewToggleUI();
  updateFocusUI();
  updateHLButtons();
  syncNodeDragBtn();
  renderPresetList();   // built-in preset names are translated, so they restale
  // The axis labels are drawn into textures, not DOM, so applyTranslations
  // cannot reach them -- "Gen 1" would stay in the old language until something
  // else happened to rebuild the axis.
  if (state.graph3d && state.stratify3D === 'generation') build3DTimeline();
}

// Expose every module's exported functions on window, plus this module's own
// (toggleSidebar, _initPanelSwipe, ...) and `state` itself.
//
// The original monolithic app.js was a classic (non-module) script, where
// every top-level `function` declaration is automatically a `window.`
// property -- that's what let inline HTML handlers (both in index.html and
// in HTML generated by the panels/import modules) call things like
// `focusOnPerson(...)` or read `state.selectedIndiId` directly. ES modules
// don't do that implicitly, so it's done explicitly here for the whole
// module graph rather than trying to enumerate just the subset actually
// referenced from HTML -- missing even one silently breaks a button.
//
// Deferred to a microtask rather than run inline here: this module graph is
// full of import cycles (e.g. render-2d.js imports from main.js), and which
// modules have *finished* evaluating by the time this line runs depends on
// which module the browser/loader treated as the entry point. Since
// index.html always loads main.js itself as the entry, that's a non-issue in
// the browser -- main.js's own body is guaranteed to run only after every
// module it (transitively) imports has finished, cycles included -- but
// importing any other module first (as e.g. a test or dev tool might) can
// observe some of these namespaces mid-initialization. Queuing a microtask
// runs this after the *whole* graph's synchronous evaluation has settled,
// regardless of which module happened to be the entry point.
queueMicrotask(() => Object.assign(window, ChangesMod, ColorsMod, FindMod, GedcomIoMod, GraphDataMod, ImportMod,
  MapViewMod, MediaMod, PanelsMod, PlacesMod, RelationsMod, Render2dMod, Render3dMod, SearchMod, StatsMod, TreeLayoutMod, {
    state,
    toggleSidebar,
    toggleToolsMenu,
    closeToolsMenu,
    _initPanelSwipe,
    _initTouchDragGuard,
    wasTouchDrag,
    _onLanguageChanged,
    exportSettingsFile,
    importSettingsFile,
    resetAllSettings,
    locateMediaFiles,
    cleanStoredMedia,
    reportMediaStatus,
  }));
