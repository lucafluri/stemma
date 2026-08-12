import * as ChangesMod from './changes.js';
import * as ColorsMod from './colors.js';
import * as GedcomIoMod from './gedcom-io.js';
import * as GraphDataMod from './graph-data.js';
import * as FindMod from './find.js';
import * as ImportMod from './import.js';
import * as MapViewMod from './map-view.js';
import * as PanelsMod from './panels.js';
import * as PlacesMod from './places.js';
import * as RelationsMod from './relations.js';
import * as Render2dMod from './render-2d.js';
import * as Render3dMod from './render-3d.js';
import * as StatsMod from './stats.js';
import * as TreeLayoutMod from './tree-layout.js';
import { resetLinkColors, toggleAllSurnames } from './colors.js';
import { _fullRebuildGraph, _tryRestoreAutosave, showDataUI, updateFileButtons } from './gedcom-io.js';
import { focusOnPerson, updateFocusUI } from './graph-data.js';
import { openNodeContextMenu } from './context-menu.js';
import { closeDetailPanel, startEdit } from './panels.js';
import { closeRelationTool, highlightMode, openRelationTool, relPickSlot, relSearch, resetHighlight, updateHLButtons } from './relations.js';
import { SLIDER_MAP, _rerenderNodes, applyFilter, applyPhysicsParams, autoSettle, centerOnPerson, centerView, reheatSimulation, refreshTreeLineageColoring, renderPresetList, resetView, schedulePhysicsParams, syncNodeDragBtn, toggleNodeDrag, zoomToFit } from './render-2d.js';
import { _push3DData, apply3DPhysics, build3DTimeline, cull3D, setCull3D, toggleView, update3DNames, update3DSceneInfo, updateViewToggleUI } from './render-3d.js';
import { state } from './state.js';
import { applyTimelineYFix } from './tree-layout.js';

// The topbar "Tools" menu. Same shape as the export split button's dropdown:
// a one-shot outside-click listener closes it, so nothing has to be torn down
// when it goes away by being used.
export function toggleToolsMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('tools-dropdown');
  const open = dd.classList.toggle('open');
  document.getElementById('tools-btn')?.setAttribute('aria-expanded', String(open));
  if (open) document.addEventListener('click', closeToolsMenu, { once: true });
}

export function closeToolsMenu() {
  document.getElementById('tools-dropdown')?.classList.remove('open');
  document.getElementById('tools-btn')?.setAttribute('aria-expanded', 'false');
}

export function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('sidebar-open');
  document.getElementById('sidebar-overlay').classList.toggle('visible');
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

document.getElementById('search-input').addEventListener('input', function () {
  const q = this.value.trim().toLowerCase();
  const box = document.getElementById('search-results');
  box.innerHTML = '';
  if (q.length < 2) return;

  const hits = [];
  for (const [id, indi] of state.individuals) {
    if ((indi.name || '').toLowerCase().includes(q) ||
        (indi.surn || '').toLowerCase().includes(q) ||
        (indi.givn || '').toLowerCase().includes(q)) {
      hits.push({ id, indi });
      if (hits.length >= 25) break;
    }
  }

  for (const { id, indi } of hits) {
    const el = document.createElement('div');
    el.className = 'result-item';
    const yr = indi.birthYear ? ` (${indi.birthYear})` : '';
    el.textContent = (indi.name || id) + yr;
    el.addEventListener('click', () => {
      document.getElementById('search-input').value = '';
      box.innerHTML = '';
      showIndiDetail(id);
      zoomToNode(id);
    });
    box.appendChild(el);
  }

  if (!hits.length) {
    const el = document.createElement('div');
    el.className = 'result-item';
    el.style.color = '#666';
    el.textContent = t('detail.noMatches');
    box.appendChild(el);
  }
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
    case 'Escape':      closeDetailPanel();       break;
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

  // View + focus controls — slider bounds/labels are (re)computed in
  // updateFocusUI() below, since they depend on the loaded file.
  const tlt = document.getElementById('tree-layout-toggle');
  if (tlt) tlt.checked = state.treeLayout;
  const sft = document.getElementById('spouse-family-toggle');
  if (sft) sft.checked = state.includeSpouseFamily;
  updateViewToggleUI();
  updateFocusUI();
  showDataUI();   // sets the first-run state; the autosave restore above may already have replaced it

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
      localStorage.setItem('colorBySurname', state.colorBySurname);
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
      localStorage.setItem('stratify3D', state.stratify3D);
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

  // 3D: show/hide visual timeline axis (independent of Y stratification)
  document.getElementById('show-timeline-toggle').addEventListener('change', function () {
    state.showTimeline3D = this.checked;
    build3DTimeline();
  });

  // 3D: show names instead of spheres
  document.getElementById('show-names-3d-toggle').addEventListener('change', function () {
    state.show3DNames = this.checked;
    update3DNames();
  });

  // The instanced-rendering switch is persisted, so the box has to be set from
  // the setting rather than from whatever the markup happens to say.
  const instCb = document.getElementById('instanced-3d-toggle');
  if (instCb) instCb.checked = state.instanced3d;
  const cullCb = document.getElementById('cull-3d-toggle');
  if (cullCb) cullCb.checked = state.cull3d;
  // ...and the budget slider only shows while the budget applies.
  const cullRow = document.getElementById('sc-draw-max-row');
  if (cullRow) cullRow.style.display = state.cull3d ? '' : 'none';

  // Link color pickers
  for (const key of ['spouse', 'father', 'mother', 'parent']) {
    const el = document.getElementById('lc-' + key);
    if (el) el.addEventListener('input', function () {
      state.linkColors[key] = this.value;
      updateLinkColors();
    });
  }

  // Node color pickers
  const NC_MAP = { male: 'nc-male', female: 'nc-female', unknown: 'nc-unknown', fam: 'nc-fam', famDiv: 'nc-fam-div' };
  for (const [key, id] of Object.entries(NC_MAP)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', function () {
      state.nodeColors[key] = this.value;
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
      localStorage.setItem('famNodeSize', state.famNodeSize);
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
      localStorage.setItem('treeLineageColoring', state.treeLineageColoring ? '1' : '0');
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
  { id: 'ap-font-size',    key: '_3dFontSize',  dp: 0, store: 'top', apply: () => update3DNames() },

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
  if (c.store === 'scene') localStorage.setItem('scene3d', JSON.stringify(state.scene3d));
  else localStorage.setItem('appearance3d', JSON.stringify(state._3dAppearance));
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
  MapViewMod, PanelsMod, PlacesMod, RelationsMod, Render2dMod, Render3dMod, StatsMod, TreeLayoutMod, {
    state,
    toggleSidebar,
    toggleToolsMenu,
    closeToolsMenu,
    _initPanelSwipe,
    _initTouchDragGuard,
    wasTouchDrag,
    _onLanguageChanged,
  }));
