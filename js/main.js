import * as ColorsMod from './colors.js';
import * as GedcomIoMod from './gedcom-io.js';
import * as GraphDataMod from './graph-data.js';
import * as ImportMod from './import.js';
import * as PanelsMod from './panels.js';
import * as RelationsMod from './relations.js';
import * as Render2dMod from './render-2d.js';
import * as Render3dMod from './render-3d.js';
import * as TreeLayoutMod from './tree-layout.js';
import { resetLinkColors, toggleAllSurnames } from './colors.js';
import { _fullRebuildGraph, _tryRestoreAutosave } from './gedcom-io.js';
import { focusOnPerson, updateFocusUI } from './graph-data.js';
import { closeDetailPanel, startEdit } from './panels.js';
import { closeRelationTool, highlightMode, openRelationTool, relPickSlot, relSearch, resetHighlight, updateHLButtons } from './relations.js';
import { SLIDER_MAP, _rerenderNodes, applyFilter, applyPhysicsParams, autoSettle, centerOnPerson, centerView, reheatSimulation, renderPresetList, resetView, toggleNodeDrag, zoomToFit } from './render-2d.js';
import { build3DTimeline, toggleView, updateViewToggleUI } from './render-3d.js';
import { state } from './state.js';
import { applyTimelineYFix } from './tree-layout.js';

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

export function _initTouchDragGuard() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  svg.addEventListener('touchstart', evt => {
    if (evt.touches.length === 1) {
      state._touchDragged = false;
      state._touchStartPos = { x: evt.touches[0].clientX, y: evt.touches[0].clientY };
    }
  }, { passive: true });
  svg.addEventListener('touchmove', evt => {
    if (state._touchStartPos && evt.touches.length === 1) {
      const dx = evt.touches[0].clientX - state._touchStartPos.x;
      const dy = evt.touches[0].clientY - state._touchStartPos.y;
      if (Math.hypot(dx, dy) > 8) state._touchDragged = true;
    }
  }, { passive: true });
  svg.addEventListener('touchend', () => {
    state._touchStartPos = null;
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
    case 'r': case 'R': resetHighlight();         break;
    case 'v': case 'V': toggleView();             break;
    case 'g': case 'G': if (state.selectedIndiId) focusOnPerson(state.selectedIndiId); break;
    case 'Escape':      closeDetailPanel();       break;
    case '+': case '=': if (state.currentView === '2d' && state.simulation) reheatSimulation(); break;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  renderPresetList();
  _tryRestoreAutosave();

  // Touch support
  _initPanelSwipe();
  _initTouchDragGuard();

  // View + focus controls — slider bounds/labels are (re)computed in
  // updateFocusUI() below, since they depend on the loaded file.
  const tlt = document.getElementById('tree-layout-toggle');
  if (tlt) tlt.checked = state.treeLayout;
  updateViewToggleUI();
  updateFocusUI();

  for (const { sid, vid, key, fmt } of SLIDER_MAP) {
    const el = document.getElementById(sid);
    if (!el) continue;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      state.physicsParams[key] = v;
      const vl = document.getElementById(vid);
      if (vl) vl.textContent = fmt(v);
      applyPhysicsParams();
    });
  }

  // Familien-Knoten toggle
  document.getElementById('fam-nodes-toggle').addEventListener('change', function () {
    state.showFamNodes = this.checked;
    applyFilter();
  });

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

  // 3D: time axis spread slider
  document.getElementById('time-spread-slider').addEventListener('input', function () {
    state._3dYHalfSpan = +this.value;
    document.getElementById('time-spread-val').textContent = this.value;
    if (state.graph3d && state.stratify3D !== 'off') {
      applyTimelineYFix();          // recalculate Y pins with new halfSpan
      state.graph3d.d3ReheatSimulation();
      build3DTimeline();            // rebuild rings at new positions
    }
  });

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

  // ── 3D appearance controls ──
  document.getElementById('ap-bg-color')?.addEventListener('input', function () {
    state._3dAppearance.bgColor = this.value;
    if (state.graph3d) state.graph3d.backgroundColor(this.value);
  });

  document.getElementById('ap-node-opacity')?.addEventListener('input', function () {
    state._3dAppearance.nodeOpacity = +this.value;
    document.getElementById('ap-node-opacity-val').textContent = (+this.value).toFixed(2);
    if (state.graph3d) state.graph3d.nodeOpacity(+this.value);
  });

  document.getElementById('ap-link-opacity')?.addEventListener('input', function () {
    state._3dAppearance.linkOpacity = +this.value;
    document.getElementById('ap-link-opacity-val').textContent = (+this.value).toFixed(2);
    if (state.graph3d) state.graph3d.linkOpacity(+this.value);
  });

  document.getElementById('ap-ambient')?.addEventListener('input', function () {
    state._3dAppearance.ambientLight = +this.value;
    document.getElementById('ap-ambient-val').textContent = (+this.value).toFixed(1);
    if (state._3dAmbientLight) state._3dAmbientLight.intensity = +this.value;
  });

  document.getElementById('ap-point')?.addEventListener('input', function () {
    state._3dAppearance.pointLight = +this.value;
    document.getElementById('ap-point-val').textContent = (+this.value).toFixed(1);
    if (state._3dPointLight) state._3dPointLight.intensity = +this.value;
  });

  document.getElementById('ap-link-width')?.addEventListener('input', function () {
    state._3dAppearance.linkWidth = +this.value;
    document.getElementById('ap-link-width-val').textContent = (+this.value).toFixed(1);
    if (state.graph3d) state.graph3d.linkWidth(+this.value);
  });

  document.getElementById('ap-node-size')?.addEventListener('input', function () {
    state._3dAppearance.nodeRelSize = +this.value;
    document.getElementById('ap-node-size-val').textContent = (+this.value).toFixed(1);
    if (state.graph3d) state.graph3d.nodeRelSize(+this.value);
  });

  document.getElementById('ap-font-size')?.addEventListener('input', function () {
    state._3dFontSize = +this.value;
    document.getElementById('ap-font-size-val').textContent = this.value;
    update3DNames();
  });
});

// These labels are built in JS, so data-i18n can't retranslate them.
function _onLanguageChanged() {
  updateViewToggleUI();
  updateFocusUI();
  updateHLButtons();
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
Object.assign(window, ColorsMod, GedcomIoMod, GraphDataMod, ImportMod, PanelsMod,
  RelationsMod, Render2dMod, Render3dMod, TreeLayoutMod, {
    state,
    toggleSidebar,
    _initPanelSwipe,
    _initTouchDragGuard,
    wasTouchDrag,
    _onLanguageChanged,
  });
