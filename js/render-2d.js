import { lsGet, lsSet, saveSetting } from './settings.js';
import { state } from './state.js';
import { nodeBaseColor, nodeOpacity, nodeTextColor, refreshNodeColors } from './colors.js';
import { LABEL_FONT_MAX, LABEL_STYLE_DEFAULTS, PHYSICS_DEFAULTS, arrMax, minMax, perf, physicsScale } from './constants.js';
import { _baseFilename, _downloadBlob, escAttr, escHtml, escJs } from './gedcom-io.js';
import { buildGraphData, computeActiveData, computeEstimatedYears, computeGenerationDepths, famAvgYear, generationNumbers, isIndiVisible, personAgeYears, updateFocusUI } from './graph-data.js';
import { wasTouchDrag } from './main.js';
import { openNodeContextMenu } from './context-menu.js';
import { closeDetailPanel, row, showFamDetail, showIndiDetail } from './panels.js';
import { _tryPickRelationPerson, applyHighlight } from './relations.js';
import { _push3DData, _setOrbitTarget3D, apply3DPhysics, build3DTimeline, fit3D, setView, update3DNames } from './render-3d.js';
import { _linkPath, applyTimelineYFix, applyTreeLayout, famMarkerSize, frameTreeChart, releaseTreePins, useTreeLayout } from './tree-layout.js';

export const NODE_BOX_W  = 92;

export const NODE_BOX_H  = 30;   // two lines: name, then the years under it

export const NODE_BOX_RX = 5;

export const NODE_BOX_FONT = 10; // px, in graph units — scales with the box, not the screen

/** The size the name line is actually drawn at: NODE_BOX_FONT is the default,
 *  state.labelStyle.fontSize is what the reader has set it to. Clamped here
 *  rather than at the control, so a hand-edited setting cannot push text
 *  through the bottom of the box. */
export function labelFontSize() {
  const v = Number(state.labelStyle?.fontSize);
  if (!Number.isFinite(v)) return NODE_BOX_FONT;
  return Math.min(LABEL_FONT_MAX, Math.max(LABEL_MIN_FONT, v));
}

export const NODE_YEAR_FONT = 8;

// ── Viewport culling and zoom level-of-detail ───────────────────────────────
//
// A chart of any size is only ever drawn twice over: as boxes you can read, or
// as a shape you can navigate. Below LOD_ZOOM a box is a few pixels across and
// its name is already hidden, so what is on screen is the shape — and a shape
// does not need a quarter of a million SVG elements to say what it is. It is
// painted onto a canvas in one pass instead. Above LOD_ZOOM the boxes are real
// SVG again, but only the ones inside the window: at any legible zoom that is a
// few hundred of them however large the file is.
//
// None of this touches a chart under CULL_MIN_NODES, which is every ordinary
// one — there the whole thing goes into the DOM at once exactly as before, and
// re-deciding that on every pan would cost more than it saved.
export const CULL_MIN_NODES = 2000;

// The zoom at which names stop being legible; updateLabels() hides them at the
// same point, which is what makes this the honest place to change technique.
export const LOD_ZOOM = 0.28;

// Drawn a little beyond the window so a box entering from the edge is already
// there, and a short pan needs no re-join at all. Half a screen either way.
export const CULL_SLACK_PX = 400;

export function _cullActive() {
  return state.nodes.length >= CULL_MIN_NODES;
}

/**
 * The window in graph coordinates, grown by the slack above — the inverse of
 * the zoom transform applied to the two screen corners. Kept as plain arithmetic
 * over {k, x, y} rather than reaching for the DOM itself so the direction of
 * that inversion can actually be tested; getting it backwards puts the window
 * on the wrong side of the origin and culls everything.
 */
export function _cullRect(W, H, t) {
  // A node is placed by its centre, so half a box either way is what stops one
  // straddling the edge from popping in and out; the slack is on top of that.
  // The slack is a screen distance, so it shrinks in graph units as you zoom in.
  const m = NODE_BOX_W / 2 + CULL_SLACK_PX / t.k;
  return {
    x0: (0 - t.x) / t.k - m, x1: (W - t.x) / t.k + m,
    y0: (0 - t.y) / t.k - m, y1: (H - t.y) / t.k + m,
  };
}

function _visibleRect() {
  const svgEl = document.getElementById('graph-svg');
  return _cullRect(
    svgEl?.clientWidth  || 1100,
    svgEl?.clientHeight || 700,
    d3.zoomTransform(state.svgSel.node()),
  );
}

const _lid = v => (typeof v === 'object' && v ? v.id : v);

// Links carry no id of their own and computeActiveData() builds fresh objects
// each time, so the join is keyed on what the link *is* — otherwise every pan
// would rebind by index and rewrite every path it kept.
const _linkKey = l => `${_lid(l.source)}|${_lid(l.target)}|${l.ltype}`;

function _joinLinks(links) {
  const sel = state.linkG.selectAll('path').data(links, _linkKey);
  sel.exit().remove();
  const entered = sel.enter().append('path')
    .attr('fill', 'none')
    .attr('stroke', d => linkColor(d))
    .attr('stroke-dasharray', d => linkDash(d))
    .attr('stroke-width', d => linkWidth(d))
    .attr('opacity', d => linkBaseOpacity(d));
  state.linkSel = entered.merge(sel);
}

function _joinNodes(nodes) {
  const sel = state.nodeG.selectAll('g.ng').data(nodes, d => d.id);
  sel.exit().remove();

  const entered = sel.enter().append('g')
    .attr('class', 'ng')
    .attr('data-nid', d => d.id)
    .on('click', (evt, d) => {
      evt.stopPropagation();
      if (wasTouchDrag()) return;
      if (d.type === 'INDI' && _tryPickRelationPerson(d.id)) return;
      if (d.type === 'INDI') showIndiDetail(d.id);
      else showFamDetail(d.id);
    })
    .on('mouseover', onHover)
    .on('mouseout', onOut)
    .on('contextmenu', (evt, d) => openNodeContextMenu(evt, d.id, d.type))
    .on('dblclick', (evt, d) => {
      evt.stopPropagation();
      delete d.fx; delete d.fy;
      state.simulation.alpha(0.15).restart();
    })
    .call(d3.drag()
      .on('start', (evt, d) => {
        if (!state._nodeDragEnabled) return;
        if (!evt.active) state.simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (evt, d) => { if (state._nodeDragEnabled) { d.fx = evt.x; d.fy = evt.y; } })
      .on('end', (evt) => { if (state._nodeDragEnabled && !evt.active) state.simulation.alphaTarget(0); })
    );

  // Shapes are appended to the nodes that just arrived, never to the ones
  // already on screen — those already have theirs.
  const indiE = entered.filter(d => d.type === 'INDI');
  const famE  = entered.filter(d => d.type === 'FAM');

  indiE.append('rect')
    .attr('class', 'indi-box')
    .attr('x', -NODE_BOX_W / 2)
    .attr('y', -NODE_BOX_H / 2)
    .attr('width', NODE_BOX_W)
    .attr('height', NODE_BOX_H)
    .attr('rx', NODE_BOX_RX)
    .attr('fill', d => nodeBaseColor(d))
    .attr('stroke', d => _lineageStroke(d))
    .attr('stroke-width', d => _lineageSideOf(d) ? 2.5 : 0.8)
    .attr('stroke-dasharray', d => d.data.deceased ? '3 2' : null)
    .attr('opacity', d => nodeOpacity(d));

  // Ring the focus person — otherwise they're just another box in the middle
  // of the tree that was built around them.
  indiE.filter(d => d.id === state.focusRootId)
    .append('rect')
    .attr('class', 'focus-ring')
    .attr('x', -NODE_BOX_W / 2 - 4)
    .attr('y', -NODE_BOX_H / 2 - 4)
    .attr('width', NODE_BOX_W + 8)
    .attr('height', NODE_BOX_H + 8)
    .attr('rx', NODE_BOX_RX + 3)
    .attr('fill', 'none')
    // Colour lives in styles.css (.focus-ring) so it follows --accent.
    .attr('stroke-width', 1.5)
    .attr('pointer-events', 'none');

  famE.append('polygon')
    .attr('class', 'fam-polygon')
    .attr('points', () => { const s = famMarkerSize(); return `0,${-s} ${s},0 0,${s} ${-s},0`; })
    .attr('fill',   d => d.data.div ? state.nodeColors.famDiv : state.nodeColors.fam)
    .attr('stroke', d => d.data.div ? state.nodeColors.famDiv : state.nodeColors.fam)
    .attr('stroke-width',     d => d.data.div ? 1.5 : 1)
    .attr('stroke-dasharray', d => d.data.div ? '3 2' : null)
    .attr('opacity', 0.88);

  // Name label — lives inside the box (not a separate layer floating above
  // it), so it moves, scales and z-orders with the node for free.
  indiE.append('text')
    .attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('dy', '-4px')
    .attr('fill', d => nodeTextColor(d))
    .attr('fill-opacity', state.labelStyle.textOpacity)
    .attr('font-size', labelFontSize() + 'px')
    .attr('font-weight', state.labelStyle.fontWeight || 'normal')
    .attr('pointer-events', 'none')
    .text(d => nodeLabelText(d.data));

  // Years on a second line under the name. Only for people who have one —
  // an empty element still costs a DOM node per person, and on a big chart
  // that is the difference between a snappy repaint and a stuttering one.
  indiE.filter(d => nodeYears(d.data))
    .append('text')
    .attr('class', 'node-years')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('dy', '7px')
    .attr('fill', d => nodeTextColor(d))
    .attr('fill-opacity', state.labelStyle.textOpacity * 0.75)
    .attr('font-size', NODE_YEAR_FONT + 'px')
    .attr('pointer-events', 'none')
    .text(d => nodeYears(d.data));

  state.nodeSel  = entered.merge(sel);
  // Read back off the layer rather than kept from the append above: after an
  // incremental join the labels on screen are the ones that survived plus the
  // ones that just arrived, and only the DOM knows which those are.
  state.labelSel = state.nodeG.selectAll('text.node-label');
  state.yearSel  = state.nodeG.selectAll('text.node-years');
}

/** Clears the overview canvas and hands the chart back to the SVG. */
function _clearOverview() {
  const c = document.getElementById('graph-canvas');
  const ctx = c?.getContext?.('2d');
  if (ctx) ctx.clearRect(0, 0, c.width, c.height);
}

// The whole chart as filled rectangles and straight lines, in screen space.
// Everything that makes a box readable — text, rounded corners, elbowed
// connectors, per-node event handlers — is what costs, and none of it survives
// being drawn three pixels wide, so none of it is drawn.
function _paintOverview() {
  const c = document.getElementById('graph-canvas');
  if (!c || !state.svgSel) return;
  const W = c.clientWidth || 1100, H = c.clientHeight || 700;
  // Cap the backing store at 2× — past that this is redrawing four times the
  // pixels to describe a chart nobody is reading the detail of.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const t = d3.zoomTransform(state.svgSel.node());
  const px = n => t.x + n.x * t.k, py = n => t.y + n.y * t.k;

  // Two passes over the links rather than one path per link: there are only
  // ever the two kinds, so this is two canvas paths for the whole chart.
  ctx.lineWidth = 1;
  for (const ltype of ['parent', 'spouse']) {
    ctx.strokeStyle = state.linkColors[ltype] ?? state.linkColors.parent;
    ctx.globalAlpha = ltype === 'spouse' ? 0.5 : 0.35;
    ctx.beginPath();
    let any = false;
    for (const l of state.links) {
      if (l.ltype !== ltype) continue;
      const s = l.source, g = l.target;
      // Endpoints are still id strings until a layout resolves them.
      if (typeof s !== 'object' || typeof g !== 'object' || s?.x == null || g?.x == null) continue;
      ctx.moveTo(px(s), py(s));
      ctx.lineTo(px(g), py(g));
      any = true;
    }
    if (any) ctx.stroke();
  }

  const hasHL = state.hlSet.size > 0;
  const bw = Math.max(1, NODE_BOX_W * t.k), bh = Math.max(1, NODE_BOX_H * t.k);
  const fs = Math.max(1, famMarkerSize() * 2 * t.k);
  for (const n of state.nodes) {
    if (n.x == null || n.y == null) continue;
    const x = px(n), y = py(n);
    const w = n.type === 'INDI' ? bw : fs;
    const h = n.type === 'INDI' ? bh : fs;
    if (x < -w || y < -h || x > W + w || y > H + h) continue;
    ctx.globalAlpha = hasHL && !state.hlSet.has(n.id) ? 0.07
                    : nodeOpacity(n);
    ctx.fillStyle = nodeBaseColor(n);
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
  }
  ctx.globalAlpha = 1;
}

/**
 * Draws whatever the current view calls for: everything, the window's worth, or
 * the canvas overview. Cheap to call — it works out what it would draw, and
 * returns without touching the DOM when that is what is already on screen,
 * which is the common case while panning.
 */
export function renderViewport(force = false) {
  if (!state.gMain || !state.nodeG || !state.svgSel) return;

  // Small chart: the whole thing, once, and never reconsidered.
  if (!_cullActive()) {
    if (!force && state._cullSig === 'all') return;
    _clearOverview();
    _joinLinks(state.links);
    _joinNodes(state.nodes);
    state._cullSig = 'all';
    tick();
    updateLabels(true);
    _reapplyHighlight();
    return;
  }

  if (state.currentZoom < LOD_ZOOM) {
    // Nothing legible at this zoom, so nothing goes in the DOM. Emptying the
    // SVG layers is what actually buys the frame rate back.
    if (state._cullSig !== 'overview') {
      _joinLinks([]);
      _joinNodes([]);
      state._cullSig = 'overview';
    }
    _paintOverview();   // repainted every frame — it is drawn in screen space
    return;
  }

  const r = _visibleRect();
  const inRect = n => n.x != null && n.y != null &&
                      n.x >= r.x0 && n.x <= r.x1 && n.y >= r.y0 && n.y <= r.y1;
  const nodes = state.nodes.filter(inRect);
  const shown = new Set(nodes.map(n => n.id));
  // A link is drawn when either end is on screen, so a connector running in
  // from a box just outside the window is not cut off at the edge.
  const links = state.links.filter(l => shown.has(_lid(l.source)) || shown.has(_lid(l.target)));

  // No cheaper check stands in for the join here. A signature over the set was
  // the obvious one and is a trap: two different windows can hold the same
  // number of people, and the frame that follows then keeps the boxes from the
  // last one. The keyed joins below already do exactly this comparison and are
  // no-ops when the set has not moved — everything past this point is bounded
  // by what is on screen, not by the size of the file.
  if (state._cullSig !== 'svg') { _clearOverview(); state._cullSig = 'svg'; }
  _joinLinks(links);
  _joinNodes(nodes);
  tick();
  // Forced: the labels that just entered have never been measured, and
  // updateLabels' own band check would skip the pass that measures them.
  updateLabels(true);
  _reapplyHighlight();
}

// Nodes that just entered are drawn at full strength. That is right when there
// is nothing highlighted, and wrong the moment there is — so the highlight is
// re-applied only when there is one to apply, rather than on every pan.
function _reapplyHighlight() {
  if (state.hlSet.size || state.selectedIndiId) applyHighlight();
}

// Optional 2D-tree display setting: outline each ancestor in the colour their
// own line already uses for parent→child links (state.linkColors.father/
// mother), so the two halves of the chart read apart from the subject without
// having to trace connectors. Only means something with a subject and the
// classical layout — computeTreeLayout() is what actually fills _treeLineageSide.
function _lineageSideOf(d) {
  if (!state.treeLineageColoring || !useTreeLayout() || d.type !== 'INDI') return null;
  return state._treeLineageSide?.get(d.id) || null;
}

function _lineageStroke(d) {
  const side = _lineageSideOf(d);
  if (side === 'father') return state.linkColors.father;
  if (side === 'mother') return state.linkColors.mother;
  return '#00000033';
}

/** Re-applies the outline above to nodes already on screen — the side map
 * itself only changes when the layout runs, so toggling the setting or
 * recolouring the father/mother link colours just needs to repaint it. */
export function refreshTreeLineageColoring() {
  if (!state.nodeSel) return;
  state.nodeSel.select('rect.indi-box')
    .attr('stroke', d => _lineageStroke(d))
    .attr('stroke-width', d => _lineageSideOf(d) ? 2.5 : 0.8);
}

// What goes on the name line of a person's box: the married name with the
// maiden surname after it in brackets, the compact form a printed chart uses.
// displayName is already capped at 24 characters when the file is parsed, so the
// bracket is the only thing that can lengthen the line — and _fitLabel shrinks
// or clips it exactly as it does any other long name.
//
// Used by both the initial render and the re-fit in updateLabels(): if those two
// disagreed about the text, the fit cache would be keyed on one string while
// another was on screen.
export function nodeLabelText(indi) {
  const name   = indi.displayName || '';
  const maiden = (indi.maidenName || '').trim();
  // Nothing to say when she is already shown under her birth name — a woman who
  // kept it, or a record that filled both fields in with the same surname.
  if (!maiden || name.includes(maiden)) return name;
  return name ? `${name} (${maiden})` : maiden;
}

export function nodeYears(indi) {
  const b = indi.birthYear || null;
  const d = indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || null;
  if (b && d) return `${b}–${d}`;
  if (b) return `*${b}`;
  if (d) return `†${d}`;
  return '';
}

export function linkColor(l) {
  return state.linkColors[l.ltype] ?? state.linkColors.parent;
}

export function linkDash(l)        { return l.ltype === 'spouse' ? '5 3' : null; }

export function linkBaseOpacity(l) { return l.ltype === 'spouse' ? 0.65 : 0.50; }

export function linkWidth(l)       { return l.ltype === 'spouse' ? 1.5 : 1.0; }

export function _rerenderNodes() {
  refreshNodeColors();  // updates circles, FAM polygons, labels, 3D
}

export function applyFilter() {
  // Close detail panel if selected person became hidden
  if (state.selectedIndiId && !isIndiVisible(state.selectedIndiId)) closeDetailPanel();
  computeActiveData();
  renderGraph();
  applyHighlight();          // re-apply any active ancestor/descendant highlight
  buildAndRunSimulation();   // restart physics on active nodes only
  // Both views draw the same filtered set now, so this is only about not paying
  // for a push while 3D is off screen; setView('3d') re-pushes on the way back.
  if (state.graph3d && state.currentView === '3d') {
    _push3DData();
    apply3DPhysics();  // calls applyTimelineYFix internally after graphData is set
    build3DTimeline();
    update3DNames();
  }
  updateFocusUI();
}

// Every frame of a pan or zoom fires the handler below, so the work it triggers
// is coalesced to one pass per frame. A pan on a small chart still costs
// nothing: the whole chart is already in the DOM and moves with one transform,
// and updateLabels() returns immediately unless the legibility band changed.
let _viewFrame = 0, _viewPrevZoom = null;
function scheduleViewportRender(prevZoom) {
  if (_viewPrevZoom === null) _viewPrevZoom = prevZoom;
  if (_viewFrame) return;
  _viewFrame = requestAnimationFrame(() => {
    _viewFrame = 0;
    const prev = _viewPrevZoom;
    _viewPrevZoom = null;
    if (_cullActive()) renderViewport();
    // Nothing about a label depends on where the layer is, only on how big it
    // is drawn — so a pure pan never has to walk them.
    if (prev !== state.currentZoom) updateLabels();
  });
}

export function initSVG() {
  state.svgSel = d3.select('#graph-svg');
  state.svgSel.selectAll('*').remove();

  // Defs
  const defs = state.svgSel.append('defs');
  // Glow filter
  const flt = defs.append('filter').attr('id', 'glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
  flt.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '4').attr('result', 'blur');
  const merge = flt.append('feMerge');
  merge.append('feMergeNode').attr('in', 'blur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  state.gMain = state.svgSel.append('g').attr('class', 'main-g');

  let _lastTransform = d3.zoomIdentity;

  state.zoomBehavior = d3.zoom()
    .scaleExtent([0.005, 20])
    .constrain((transform, extent, translateExtent) => {
      // Custom constraint: prevent translate drift when hitting zoom limits
      // Allow small epsilon for floating point comparisons
      const k = transform.k;
      const minK = 0.005;
      const maxK = 20;
      const epsilon = 0.0001;

      // If we're trying to go below min and already near min - clamp and prevent drift
      if (k <= minK && _lastTransform.k <= minK + epsilon) {
        return d3.zoomIdentity.translate(_lastTransform.x, _lastTransform.y).scale(minK);
      }
      // If we're trying to go above max and already near max - clamp and prevent drift
      if (k >= maxK && _lastTransform.k >= maxK - epsilon) {
        return d3.zoomIdentity.translate(_lastTransform.x, _lastTransform.y).scale(maxK);
      }

      // Otherwise allow normal transform (including zooming away from limits)
      return transform;
    })
    .on('start', () => { _userPanning = true; })
    .on('end', () => { _userPanning = false; _lastUserPanEnd = Date.now(); })
    .on('zoom', evt => {
      // Store current transform before applying
      _lastTransform = evt.transform;

      state.gMain.attr('transform', evt.transform);
      const prev = state.currentZoom;
      state.currentZoom = evt.transform.k;
      scheduleViewportRender(prev);
    });

  state.svgSel.call(state.zoomBehavior);

  // Click on SVG background → deselect
  state.svgSel.on('click', evt => {
    if (evt.target === state.svgSel.node()) closeDetailPanel();
  });

  // Tooltip tracking, bound once here rather than on every node. Per node it was
  // a listener on each of a thousand-odd elements, all of them dispatched
  // through on every pixel of pointer movement across the chart — and all but
  // one of them with nothing to do. The early return means the common case,
  // moving over empty space, costs a single property read.
  state.svgSel.on('mousemove', evt => {
    if (document.getElementById('tooltip').style.display === 'none') return;
    positionTooltip(evt);
  });
}

// Both of these used to live inside initSVG(), which runs again on every file
// load — so opening a second file left two auto-recenter timers running and two
// keyboard handlers on the document, and "+" zoomed twice as far per press.
// Module scope runs once, whatever happens to the SVG afterwards.

// Whether a drag/zoom gesture is in flight, and when the last one ended — set
// from the zoomBehavior 'start'/'end' handlers in initSVG(). The auto-recenter
// below must not fight a pan the user is still mid-gesture on, or immediately
// yank the view back the moment they let go.
let _userPanning = false;
let _lastUserPanEnd = 0;

// If the whole graph has drifted off screen there is no way back by dragging —
// you cannot aim at something you cannot see. Bring it back — but not while the
// user is panning on purpose, and not in the couple of seconds right after.
const _recenterTimer = setInterval(() => {
  if (!state.svgSel || !state.nodes.length) return;
  if (_userPanning || Date.now() - _lastUserPanEnd < 2000) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl?.clientWidth  || 800;
  const H = svgEl?.clientHeight || 600;
  const transform = d3.zoomTransform(state.svgSel.node());

  const margin = 100; // a node just off the edge still counts as findable
  const anyVisible = state.nodes.some(n => {
    if (n.x == null || n.y == null) return false;
    const x = transform.x + n.x * transform.k;
    const y = transform.y + n.y * transform.k;
    return x > -margin && x < W + margin && y > -margin && y < H + margin;
  });

  if (!anyVisible) zoomToFit();
}, 2000);
// In a browser setInterval returns a number and this is a no-op; under Node
// (the test suite imports this module) it returns a handle whose mere existence
// would hold the process open after the tests have finished.
_recenterTimer?.unref?.();

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (!state.svgSel || !state.zoomBehavior) return;
  if (e.key === '0') {
    e.preventDefault();
    resetView();
  } else if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    svgZoomBy(1.3);
  } else if (e.key === '-') {
    e.preventDefault();
    svgZoomBy(1 / 1.3);
  }
});

export function renderGraph() {
  perf.start('[rg] clear');
  state.gMain.selectAll('*').remove();
  // Links first so they sit under the boxes. <path> rather than <line> so the
  // tree layout can draw square elbows; the force layout just emits a straight
  // two-point path through the same element.
  state.linkG = state.gMain.append('g').attr('class', 'links-g');
  state.nodeG = state.gMain.append('g').attr('class', 'nodes-g');
  state._cullSig = null;   // the layers are empty, whatever was drawn is gone
  perf.end('[rg] clear');

  // What actually goes into those layers is renderViewport's decision — on a
  // large chart that is a window's worth or the canvas overview, and only on a
  // small one the whole set. Called again from onSimEnd() once the positions
  // are final: this first pass runs before any layout has placed anybody, so on
  // a fresh file there is deliberately nothing yet to put on screen.
  perf.start('[rg] viewport'); renderViewport(true); perf.end('[rg] viewport');
}

export const LABEL_MIN_FONT = 7;

export function _fitLabel(el, full, avail, size) {
  el.setAttribute('font-size', size + 'px');
  el.textContent = full;
  const w = el.getComputedTextLength();
  if (w <= avail || !w) return;

  // Width scales with the font size, so the size that fits follows from the one
  // measurement — no search, and measuring is what costs.
  const shrunk = Math.max(LABEL_MIN_FONT, size * avail / w);
  el.setAttribute('font-size', shrunk + 'px');
  if (el.getComputedTextLength() <= avail) return;

  let lo = 1, hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    el.textContent = full.slice(0, mid) + '…';
    if (el.getComputedTextLength() <= avail) lo = mid; else hi = mid - 1;
  }
  el.textContent = full.slice(0, lo) + '…';
}

export function updateLabelColors() {
  if (!state.labelSel || state.labelSel.empty()) return;
  const weight = state.labelStyle.fontWeight || 'normal';
  state.labelSel.each(function(d) {
    this.setAttribute('fill',         nodeTextColor(d));
    this.setAttribute('fill-opacity', state.labelStyle.textOpacity);
    this.setAttribute('font-weight',  weight);
  });
  state.yearSel?.each(function(d) {
    this.setAttribute('fill',         nodeTextColor(d));
    this.setAttribute('fill-opacity', state.labelStyle.textOpacity * 0.75);
  });
}

export function updateLabels(force = false) {
  if (!state.labelSel || state.labelSel.empty()) return;
  const zoom = state.currentZoom;
  // Below this the box itself is a few screen px wide — the name would just
  // be noise, so drop it rather than render illegible text. Past the same point
  // a large chart stops being SVG at all; see LOD_ZOOM.
  const hidden = zoom < LOD_ZOOM;
  // The years are set smaller than the name and go to mush one step earlier.
  const yearsHidden = zoom < 0.4;
  const weight = state.labelStyle.fontWeight || 'normal';

  // Everything below depends only on which legibility band the zoom is in, and
  // a zoom that stays inside its band changes none of it. Bail before touching a
  // couple of thousand elements: this ran on every animation frame of a pan and
  // rewrote the text, size and display of every label on the chart, which is
  // what made dragging a large tree crawl.
  const sig = `${hidden}|${yearsHidden}|${weight}|${labelFontSize()}`;
  if (!force && state._labelSig === sig) return;
  state._labelSig = sig;

  state.labelSel.each(function (d) {
    if (hidden) { this.style.display = 'none'; return; }
    this.style.display = '';

    // Fitting is a property of the name and the box, not of the zoom, so it is
    // worked out once per name and then left alone — the element keeps the text
    // and size _fitLabel gave it until the name itself changes. Re-applying both
    // from a cache on every pass, as this did, is a DOM write per label to put
    // back the value already there.
    const full = nodeLabelText(d.data);
    const key = full + '\\0' + weight + '\\0' + labelFontSize();
    if (this.__fitKey !== key) {
      _fitLabel(this, full, NODE_BOX_W - 10, labelFontSize());
      this.__fitKey = key;
    }
  });

  state.yearSel?.each(function () {
    this.style.display = yearsHidden ? 'none' : '';
  });
}

export function buildAndRunSimulation(opts = {}) {
  // Keep birth year range for the 3D timeline, and the generation range for
  // the other way of stacking them. The 3D view reads both regardless of
  // which 2D layout is active, so this has to run even when the tree layout
  // is about to make the rest of this function a no-op below.
  const byRange = minMax(function* () {
    for (const n of state.nodes) if (n.type === 'INDI' && n.data.birthYear) yield n.data.birthYear;
  }());
  const minBY = byRange ? byRange.min : 1750;
  const maxBY = byRange ? byRange.max : 2025;
  state._birthYearRange = { min: minBY, max: maxBY };

  const gd = computeGenerationDepths();
  state._genRange3D = minMax(function* () {
    for (const n of state.nodes) if (n.type === 'INDI' && gd.has(n.id)) yield gd.get(n.id);
  }());

  // The 3D axis-spread default used to be one fixed number regardless of how
  // many generations were actually on screen — cramped for a 12-generation
  // file, needlessly stretched for a 3-generation one. Scale it to the tree
  // instead, and keep doing so on every rebuild until the reader drags the
  // slider by hand, at which point their choice wins from then on.
  if (state._3dYHalfSpanAuto && state._genRange3D) {
    const genSpan = Math.max(1, state._genRange3D.max - state._genRange3D.min);
    // Two different things set the size of this axis, and it needs both.
    //
    // How many generations there are decides how many layers have to fit —
    // that part was already here. How many *people* there are decides how far
    // apart everything else sits, and that part was missing: the horizontal
    // spread scales with the tree (see physicsScale) while this stayed put, so
    // a large file came out as a pancake — measured at 16,700 wide and 1,980
    // tall. Scaling the axis by the same factor keeps the gap between two
    // generations in proportion to the gap between two siblings, which is what
    // actually makes a big tree look like a big version of a small one rather
    // than a squashed one.
    const S = physicsScale(state.nodes.length);
    const span = Math.round(Math.max(200 * S, Math.min(2400 * S, genSpan * 110 * S)));
    state._3dYHalfSpan = span;
    const spreadSlider = document.getElementById('time-spread-slider');
    const spreadNum    = document.getElementById('time-spread-num');
    // The slider only covers the hand-tuned range; let it sit at its own
    // maximum rather than silently reporting a smaller number than is in use.
    if (spreadSlider) spreadSlider.value = Math.min(span, +spreadSlider.max || span);
    if (spreadNum)    spreadNum.value    = span;
  }

  // Compute estimated birth years for persons without one (uses generation & relation info)
  perf.start('[sim] computeEstimatedYears'); computeEstimatedYears(); perf.end('[sim] computeEstimatedYears');

  // Expand range to include estimated years so timeline covers everyone
  if (state._estimatedYears && state._estimatedYears.size) {
    let eMin = minBY, eMax = maxBY;
    for (const yr of state._estimatedYears.values()) {
      if (yr < eMin) eMin = yr;
      if (yr > eMax) eMax = yr;
    }
    state._birthYearRange = { min: eMin, max: eMax };
  }

  // A recorded marriage date can fall outside every member's own birth-year
  // range (e.g. a couple with a marriage date but no birth dates on file), so
  // widen the range once more to include where FAM nodes will actually be
  // pinned -- otherwise they'd be stratified past either end of the timeline.
  const famRange = minMax(function* () {
    for (const n of state.nodes) {
      if (n.type !== 'FAM') continue;
      const yr = famAvgYear(n.data);
      if (yr != null) yield yr;
    }
  }());
  if (famRange) {
    state._birthYearRange = {
      min: Math.min(state._birthYearRange.min, famRange.min),
      max: Math.max(state._birthYearRange.max, famRange.max),
    };
  }

  // Everything above is shared: the year and generation ranges the 3D timeline
  // stratifies against, and the estimated years both views label with. The 2D
  // force layout below is not — and useTreeLayout() is false in the 3D view, so
  // every filter change made while looking at the 3D scene was building and
  // headlessly ticking a 2D simulation nobody could see. On a 50,000-person file
  // that was eighty-odd seconds of frozen tab per change, for a layout thrown
  // away unlooked-at. Arriving in 2D builds it: setView('2d') calls this again.
  if (state.currentView === '3d') return;

  // Classical chart: positions are computed outright, so there is nothing to
  // simulate. Everything below (forces, warm reheat, headless ticking) is the
  // force layout's business only.
  if (useTreeLayout() && applyTreeLayout()) return;
  releaseTreePins();

  const warm = !!opts.warm && !!state.simulation;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth  || 1100;
  const H = svgEl.clientHeight || 700;

  // Generation-depth based Y positioning: children are always below parents
  perf.start('[sim] computeGenerationDepths');
  const genDepths = computeGenerationDepths();
  perf.end('[sim] computeGenerationDepths');
  const maxGen = arrMax(genDepths.values()) ?? 0;

  const genToY = gen => maxGen === 0 ? H / 2 : 30 + (gen / maxGen) * (H - 60);

  // FAM node Y = midpoint between its parents' depth and its children's depth
  const famGenY = fam => {
    const parentDepths = [fam.husb, fam.wife].filter(Boolean).map(id => genDepths.get(id) ?? 0);
    const childDepths  = fam.chil.map(id => genDepths.get(id) ?? 0);
    const allDepths    = [...parentDepths, ...childDepths];
    const avg = allDepths.length ? allDepths.reduce((a, b) => a + b, 0) / allDepths.length : 0;
    return genToY(avg);
  };

  const nodeTargetY = n => n.type === 'INDI' ? genToY(genDepths.get(n.id) ?? 0) : famGenY(n.data);

  // Pre-position brand-new nodes near their settle spot so they need less
  // travel; nodes that already have a position (identity preserved by
  // _nodeObjCache in buildGraphData) are left exactly where they are.
  state.nodes.forEach(n => {
    if (n.x == null) {
      n.y = nodeTargetY(n);
      n.x = W * 0.2 + Math.random() * W * 0.6;
    }
  });

  // Focus mode: pin the focus person dead centre so the layout literally
  // grows around them instead of drifting off wherever the forces push it.
  // The _focusPinned flag is what lets us release a *previous* focus person
  // without touching pins the user made by dragging nodes.
  state.nodes.forEach(n => {
    if (n._focusPinned && n.id !== state.focusRootId) {
      delete n.fx; delete n.fy; delete n._focusPinned;
    }
  });
  if (state.focusRootId && state.currentView === '2d') {
    const root = state.nodes.find(n => n.id === state.focusRootId);
    if (root) { root.fx = W / 2; root.fy = H / 2; root._focusPinned = true; }
  }

  const p = state.physicsParams;

  if (warm) {
    // Same forces, same node/link objects where possible — just tell the
    // running simulation about the new node/link set and nudge it awake.
    state.simulation.nodes(state.nodes);
    state.simulation.force('link').links(state.links);
    state.simulation.force('fy').y(d => nodeTargetY(d));
    state.simulation.alphaDecay(p.alphaDecay).velocityDecay(p.velocityDecay);
    state.simulation.alpha(Math.max(state.simulation.alpha(), 0.3));
  } else {
    if (state.simulation) state.simulation.stop();
    const S = physicsScale(state.nodes.length);
    state.simulation = d3.forceSimulation(state.nodes)
      .force('link', d3.forceLink(state.links)
        .id(d => d.id)
        .distance(d => (d.ltype === 'spouse' ? p.spouseDist : p.parentDist) * S)
        .strength(d => d.ltype === 'spouse' ? p.spouseStrength : p.parentStrength)
      )
      .force('charge', d3.forceManyBody()
        .strength(d => (d.type === 'FAM' ? -p.chargeFam : -p.chargeIndi) * S)
        .distanceMax(p.chargeDistMax * S)
      )
      .force('center', d3.forceCenter(W / 2, H / 2).strength(p.centerStrength))
      .force('collide', d3.forceCollide(d => (d.type === 'FAM' ? 9 : p.collideRadius) * S).strength(0.7))
      .force('fy', d3.forceY(d => nodeTargetY(d)).strength(p.yStrength))
      .alpha(1)
      .alphaDecay(p.alphaDecay)
      .velocityDecay(p.velocityDecay);
  }

  // For large graphs run the simulation headlessly (no per-tick DOM writes)
  // then paint once at the end — avoids hundreds of synchronous reflows.
  // A focused set is small and wants to appear settled immediately — with the
  // default alphaDecay the live path takes ~20s to converge, which is 20s
  // before onSimEnd gets to frame it.
  const HEADLESS_THRESHOLD = 200;
  if (state.nodes.length > HEADLESS_THRESHOLD || (state.currentView === '2d' && state.focusRootId)) {
    // Use a faster decay for headless layout — generation-depth pre-positioning
    // already places nodes well, so we only need enough ticks to detangle.
    const HEADLESS_DECAY = 0.05;
    state.simulation.stop().alphaDecay(HEADLESS_DECAY);
    const totalTicks = Math.ceil(Math.log(state.simulation.alphaMin() / state.simulation.alpha()) / Math.log(1 - HEADLESS_DECAY));
    perf.log(`[sim] headless: ${state.nodes.length} nodes, ${state.links.length} links, ${totalTicks} ticks`);
    perf.start('[sim] headless ticks');
    for (let i = 0; i < totalTicks; i++) state.simulation.tick();
    perf.end('[sim] headless ticks');
    perf.start('[sim] tick() DOM paint');  tick();     perf.end('[sim] tick() DOM paint');
    perf.start('[sim] onSimEnd');          onSimEnd(); perf.end('[sim] onSimEnd');
  } else {
    state.simulation.on('tick', tick);
    state.simulation.on('end', onSimEnd);
    state.simulation.restart();
  }
}

// Slider-rate entry point. `input` fires on every pixel a slider travels — well
// past once per frame — and each event restarted a 1,400-node simulation from
// alpha 1. Coalescing to one apply per frame means a drag costs one, not a
// backlog the browser works through after your finger has stopped.
let _physFrame = 0, _physOpts = {};
export function schedulePhysicsParams(opts = {}) {
  _physOpts = opts;
  if (_physFrame) return;
  _physFrame = requestAnimationFrame(() => { _physFrame = 0; applyPhysicsParams(_physOpts); });
}

// `opts.repin` is passed through to the 3D side; see apply3DPhysics.
export function applyPhysicsParams(opts = {}) {
  const p = state.physicsParams;

  // The 2D force layout and the 3D graph each own an independent simulation
  // -- e.g. the classical tree chart never creates state.simulation at all,
  // and a user can easily be looking at the 3D view with no 2D one ever
  // built. Neither one existing is a reason to skip the other: a slider
  // change must reach whichever simulation(s) are actually live.
  if (state.simulation) {
    // Same scaling the simulation was built with — see physicsScale(). Left out
    // here, dragging any slider would quietly drop a large layout back to
    // unscaled forces and collapse it.
    const S = physicsScale(state.nodes.length);

    state.simulation.force('link')
      .distance(d => (d.ltype === 'spouse' ? p.spouseDist : p.parentDist) * S)
      .strength(d => d.ltype === 'spouse' ? p.spouseStrength : p.parentStrength);

    state.simulation.force('charge')
      .strength(d => (d.type === 'FAM' ? -p.chargeFam : -p.chargeIndi) * S)
      .distanceMax(p.chargeDistMax * S);

    state.simulation.force('collide')
      .radius(d => (d.type === 'FAM' ? 9 : p.collideRadius) * S);

    state.simulation.force('fy')
      .strength(p.yStrength);

    state.simulation.force('center')
      .strength(p.centerStrength);

    state.simulation
      .alphaDecay(p.alphaDecay)
      .velocityDecay(p.velocityDecay);

    // Setting the forces above is cheap and has to happen either way, so the
    // parameters are never out of date. Waking the simulation up is not cheap,
    // and there is no reason to do it to a layout nobody is looking at — the
    // view switch reheats whichever one you arrive at.
    if (state.currentView === '2d') {
      state.simulation.alpha(Math.max(state.simulation.alpha(), 0.25)).restart();
    }
  }

  document.getElementById('loading-overlay').style.display = 'none';
  // Same rule for the 3D side: keep its forces current whichever view is up, so
  // nothing is stale on arrival, but only wake it if it is the one on screen.
  if (state.graph3d) apply3DPhysics({ ...opts, reheat: state.currentView === '3d' });
}

export function reheatSimulation() {
  if (!state.simulation) return;
  state.simulation.alpha(0.5).restart();
}

export function _settleBarRun(durationMs) {
  const bar = document.getElementById('settle-bar');
  if (!bar) return;
  bar.style.transition = 'none';
  bar.style.width = '0%';
  bar.style.opacity = '1';
  requestAnimationFrame(() => {
    bar.style.transition = `width ${durationMs}ms linear`;
    bar.style.width = '100%';
    setTimeout(() => {
      bar.style.transition = 'none';
      bar.style.opacity = '0';
      bar.style.width = '0%';
    }, durationMs + 100);
  });
}

export function autoSettle() {
  if (state._autoSettleTimer) { clearTimeout(state._autoSettleTimer); state._autoSettleTimer = null; }

  // The classical chart has no simulation to anneal — its positions are computed
  // outright. The button still has an honest job there: recompute the layout and
  // frame it, which is what "reload the graph" means when there is no physics.
  // Without this it ran a progress bar over three seconds of nothing.
  if (useTreeLayout()) {
    applyTreeLayout();
    tick();
    frameTreeChart();
    return;
  }

  // alphaDecay=0.04 → sim dies in ~170 ticks ≈ 2.8s at 60fps
  const SETTLE_MS = 3000;
  _settleBarRun(SETTLE_MS);

  if (state.currentView === '3d') {
    if (!state.graph3d) return;
    state.graph3d.d3AlphaDecay(0.04);
    state.graph3d.d3ReheatSimulation();
    state._autoSettleTimer = setTimeout(() => {
      if (state.graph3d) state.graph3d.d3AlphaDecay(state.physicsParams.alphaDecay);
      state._autoSettleTimer = null;
    }, SETTLE_MS);
  } else {
    if (!state.simulation) return;
    const savedDecay = state.physicsParams.alphaDecay;
    state.simulation.alphaDecay(0.04).alpha(1).restart();
    state._autoSettleTimer = setTimeout(() => {
      if (state.simulation) state.simulation.alphaDecay(savedDecay);
      state._autoSettleTimer = null;
    }, SETTLE_MS);
  }
}

export function resetPhysics() {
  state.physicsParams = { ...PHYSICS_DEFAULTS };
  saveSetting('physics', state.physicsParams);
  syncPhysicsUI();
  applyPhysicsParams();
}

export function tick() {
  if (!state.linkSel) return;
  state.linkSel.attr('d', _linkPath);

  state.nodeSel.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
}

export function onSimEnd() {
  document.getElementById('loading-overlay').style.display = 'none';
  if (state._firstLoad) {
    state._firstLoad = false;
    if (state.currentView === '2d') {
      useTreeLayout() ? frameTreeChart() : zoomToFit();
    }
  }
  // The one point every layout — classical, headless force, live force — passes
  // through once the positions are final. renderGraph() ran before any of them
  // and so had nothing placed to cull against; this is the pass that actually
  // puts the chart on screen. The framing above is a transition, and each of
  // its frames re-fires the zoom handler, so the window follows it in.
  if (_cullActive()) renderViewport(true);
}

export function zoomToFit() {
  if (!state.nodes.length || !state.svgSel) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth, H = svgEl.clientHeight;

  // One pass, and only over coordinates that are actually numbers. A single NaN
  // slipping in from a degenerate layout used to poison the min/max and hand the
  // zoom a NaN transform, which d3 applies without complaint — the chart simply
  // vanished with nothing in the console to say why.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of state.nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    if (n.x < x0) x0 = n.x;
    if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.y > y1) y1 = n.y;
  }
  if (x0 === Infinity) return;

  const dw = x1 - x0 || 1, dh = y1 - y0 || 1;

  const scale = Math.min(W / (dw + 60), H / (dh + 60), 3) * 0.92;
  const tx = W / 2 - scale * ((x0 + x1) / 2);
  const ty = H / 2 - scale * ((y0 + y1) / 2);

  state.svgSel.transition().duration(750)
    .call(state.zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

export function svgZoomBy(factor) {
  if (state.svgSel && state.zoomBehavior) {
    state.svgSel.transition().duration(220).call(state.zoomBehavior.scaleBy, factor);
  }
}

export function zoomToNode(nid) {
  const n = state.nodes.find(d => d.id === nid);
  if (!n || n.x == null) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth, H = svgEl.clientHeight;
  const scale = Math.max(state.currentZoom, 1.4);
  const tx = W / 2 - scale * n.x;
  const ty = H / 2 - scale * n.y;
  state.svgSel.transition().duration(550)
    .call(state.zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

export function centerView() {
  if (state.currentView === '3d' && state.graph3d) {
    _setOrbitTarget3D(null);           // orbit back to origin
    fit3D();
  } else {
    zoomToFit();
  }
}

export function centerOnPerson() {
  if (!state.selectedIndiId) return;
  if (state.currentView === '3d' && state.graph3d) {
    _setOrbitTarget3D(state.selectedIndiId);
    // Also move the camera closer to the node
    const gd = state.graph3d.graphData();
    const node = gd.nodes.find(n => n.id === state.selectedIndiId);
    if (node && node.x != null) {
      const cam = state.graph3d.camera();
      const target = new THREE.Vector3(node.x, node.y || 0, node.z || 0);
      const dist = Math.min(cam.position.distanceTo(target), 300);
      const dir = cam.position.clone().sub(target).normalize();
      const newPos = target.clone().addScaledVector(dir, dist);
      // Animate camera position smoothly
      const start = cam.position.clone();
      const t0 = performance.now();
      const dur = 600;
      (function animCam() {
        const t = Math.min((performance.now() - t0) / dur, 1);
        const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
        cam.position.lerpVectors(start, newPos, ease);
        if (t < 1) requestAnimationFrame(animCam);
      })();
    }
  } else {
    zoomToNode(state.selectedIndiId);
  }
}

export function onHover(evt, d) {
  const tt = document.getElementById('tooltip');
  let html = '';
  if (d.type === 'INDI') {
    const i = d.data;
    html = `<div class="tt-name">${escHtml(i.name || i.id)}</div>`;
    if (i.birth.date) {
      html += `<div class="tt-detail">* ${escHtml(i.birth.date)}${i.birth.plac ? ', ' + escHtml(i.birth.plac) : ''}</div>`;
    } else if (state._estimatedYears && state._estimatedYears.has(d.id)) {
      html += `<div class="tt-detail" style="color:#888">~${state._estimatedYears.get(d.id)} (${t('detail.estimated')})</div>`;
    }
    if (i.deceased) {
      html += `<div class="tt-detail">† ${i.death.date ? escHtml(i.death.date) : t('tooltip.unknownDate')}</div>`;
    }
    if (i.occu) html += `<div class="tt-detail" style="color:#9f9f9f">${escHtml(i.occu)}</div>`;
    if (i.maidenName) html += `<div class="tt-detail" style="color:#888">${t('tooltip.born', { name: escHtml(i.maidenName) })}</div>`;
    else if (i.surn) html += `<div class="tt-detail" style="color:#888">${t('tooltip.familyName', { name: escHtml(i.surn) })}</div>`;
    const age = personAgeYears(d.id);
    if (age) {
      const ageStr = (age.approx ? '~' : '') + age.age;
      html += `<div class="tt-detail">${t(age.atDeath ? 'tooltip.ageAtDeath' : 'tooltip.age', { age: ageStr })}</div>`;
    }
    const genNum = generationNumbers().get(d.id);
    if (genNum != null) html += `<div class="tt-detail" style="color:#888">${t('tooltip.generation', { n: genNum })}</div>`;
  } else {
    const f = d.data;
    const names = [f.husb, f.wife].filter(Boolean)
      .map(id => escHtml(state.individuals.get(id)?.name || id)).join(' &amp; ');
    html = `<div class="tt-name">${t('tooltip.family')}</div>`;
    if (names) html += `<div class="tt-detail">${names}</div>`;
    if (f.marriages?.[0]?.date) html += `<div class="tt-detail">⚭ ${escHtml(f.marriages[0].date)}</div>`;
    if (f.div) html += `<div class="tt-detail" style="color:#787878">${t('tooltip.divorced', { date: f.divDate ? ' ' + escHtml(f.divDate) : '' })}</div>`;
    html += `<div class="tt-detail">${f.chil.length} ${f.chil.length === 1 ? t('tooltip.child') : t('tooltip.children')}</div>`;
  }
  tt.innerHTML = html;
  tt.style.display = 'block';
  positionTooltip(evt);
}

export function onOut() { document.getElementById('tooltip').style.display = 'none'; }

export function positionTooltip(evt) {
  const tt = document.getElementById('tooltip');
  const margin = 12;
  let x = evt.clientX + margin;
  let y = evt.clientY - margin;
  if (x + 260 > window.innerWidth) x = evt.clientX - 260 - margin;
  if (y < 0) y = 0;
  tt.style.left = x + 'px';
  tt.style.top  = y + 'px';
}

export function flashNode(id) {
  if (!state.nodeSel) return;
  state.nodeSel.filter(d => d.id === id)
    .select('rect.indi-box')
    .attr('filter', 'url(#glow)')
    .transition().delay(700).duration(400)
    .attr('filter', null);
}

export const PRESETS_KEY = 'stammbaum_physics_presets_v1';

export const BUILTIN_PRESETS = {
  'Standard':  { spouseDist:50,  parentDist:65,  spouseStrength:0.45, parentStrength:0.65, chargeIndi:170, chargeFam:25, chargeDistMax:380, collideRadius:16, yStrength:0.35, centerStrength:0.04, velocityDecay:0.40, alphaDecay:0.028 },
  'Baum':      { spouseDist:42,  parentDist:80,  spouseStrength:0.55, parentStrength:0.85, chargeIndi:190, chargeFam:15, chargeDistMax:420, collideRadius:18, yStrength:0.55, centerStrength:0.05, velocityDecay:0.44, alphaDecay:0.025 },
  'Kompakt':   { spouseDist:26,  parentDist:36,  spouseStrength:0.82, parentStrength:0.92, chargeIndi:65,  chargeFam:8,  chargeDistMax:170, collideRadius:10, yStrength:0.50, centerStrength:0.08, velocityDecay:0.50, alphaDecay:0.030 },
  'Locker':    { spouseDist:95,  parentDist:115, spouseStrength:0.25, parentStrength:0.30, chargeIndi:340, chargeFam:55, chargeDistMax:680, collideRadius:28, yStrength:0.18, centerStrength:0.02, velocityDecay:0.34, alphaDecay:0.022 },
  'Zeitlinie': { spouseDist:50,  parentDist:65,  spouseStrength:0.28, parentStrength:0.48, chargeIndi:140, chargeFam:18, chargeDistMax:340, collideRadius:16, yStrength:0.75, centerStrength:0.03, velocityDecay:0.42, alphaDecay:0.025 },
  'Spiral':    { spouseDist:60,  parentDist:70,  spouseStrength:0.35, parentStrength:0.55, chargeIndi:220, chargeFam:30, chargeDistMax:500, collideRadius:20, yStrength:0.20, centerStrength:0.08, velocityDecay:0.38, alphaDecay:0.020 },
};

// The keys above are identifiers, not labels — they are what applyPreset() and
// the stored user presets are keyed by, so they stay German whatever the UI
// language is. This is only what the reader sees. The translations already
// existed; the list simply printed the raw key instead of asking for them.
const BUILTIN_PRESET_LABELS = {
  'Standard': 'presets.standard',
  'Baum':      'presets.tree',
  'Kompakt':   'presets.compact',
  'Locker':    'presets.loose',
  'Zeitlinie': 'presets.timeline',
  'Spiral':    'presets.spiral',
};

export function presetLabel(name) {
  const key = BUILTIN_PRESET_LABELS[name];
  return key ? t(key) : name;   // user presets are named by the user; leave them
}

export function getUserPresets() {
  try { return JSON.parse(lsGet(PRESETS_KEY) || '{}'); }
  catch { return {}; }
}

export function savePreset() {
  const name = document.getElementById('preset-name-input').value.trim();
  if (!name) return;
  const all = getUserPresets();
  all[name] = { ...state.physicsParams };
  lsSet(PRESETS_KEY, JSON.stringify(all));
  document.getElementById('preset-name-input').value = '';
  renderPresetList();
}

export function deletePreset(name) {
  const all = getUserPresets();
  delete all[name];
  lsSet(PRESETS_KEY, JSON.stringify(all));
  renderPresetList();
}

export function applyPreset(name, builtin) {
  const src = builtin ? BUILTIN_PRESETS[name] : getUserPresets()[name];
  state.physicsParams = { ...PHYSICS_DEFAULTS, ...src };
  saveSetting('physics', state.physicsParams);
  syncPhysicsUI();
  applyPhysicsParams();
}

export function renderPresetList() {
  const container = document.getElementById('preset-list');
  if (!container) return;
  container.innerHTML = '';

  // Built-in presets
  for (const name of Object.keys(BUILTIN_PRESETS)) {
    const row = document.createElement('div');
    row.className = 'preset-row builtin';
    const label = presetLabel(name);
    row.innerHTML = `<span class="preset-name" title="${escAttr(label)}" onclick="applyPreset('${escJs(name)}',true)">${escHtml(label)}</span>`;
    container.appendChild(row);
  }

  // User presets
  const user = getUserPresets();
  const names = Object.keys(user);
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'preset-row user';
    row.innerHTML = `
      <span class="preset-name" title="${escAttr(name)}" onclick="applyPreset('${escJs(name)}',false)">${escHtml(name)}</span>
      <button class="preset-del" onclick="deletePreset('${escJs(name)}')" title="${t('detail.delete')}">&#x2715;</button>`;
    container.appendChild(row);
  }

  if (!names.length && !Object.keys(BUILTIN_PRESETS).length) {
    container.innerHTML = `<div style="color:#555;font-size:11px;font-style:italic;padding:2px 4px">${t('physics.noPresets')}</div>`;
  }
}

export function toggleNodeDrag() {
  state._nodeDragEnabled = !state._nodeDragEnabled;
  if (state.graph3d) state.graph3d.enableNodeDrag(state._nodeDragEnabled);
  syncNodeDragBtn();
}

// Writing the label replaces the <span data-i18n> the markup shipped with, so
// switching language afterwards left this one button in the old language.
// Called from _onLanguageChanged too, which is what puts it right.
export function syncNodeDragBtn() {
  const btn = document.getElementById('node-drag-btn');
  if (!btn) return;
  btn.textContent = state._nodeDragEnabled
    ? '🔓 ' + t('sidebar.dragOn')
    : '🔒 ' + t('sidebar.dragOff');
  btn.style.opacity = state._nodeDragEnabled ? '1' : '0.6';
}

export const EXPORT_MARGIN = 40;

export const EXPORT_LONG_EDGE = 6000;   // target for the longer side, in pixels

export const EXPORT_MAX_PIXELS = 40e6;  // browsers refuse to rasterise much beyond this

export const EXPORT_MAX_EDGE = 16384;   // ...and refuse any single dimension past this

// The exported SVG is standalone — it cannot reach styles.css, so anything
// styled by class there has to be repeated here.
export const EXPORT_SVG_CSS = `
  .node-label { text-anchor: middle; dominant-baseline: auto; }
  .focus-ring { stroke: #7aa2f7; }
`;

export function _exportScale(w, h) {
  const long = Math.max(w, h) || 1;
  return Math.min(
    Math.max(1, EXPORT_LONG_EDGE / long),      // sharp enough to print
    EXPORT_MAX_EDGE / long,                    // no dimension past the cap
    Math.sqrt(EXPORT_MAX_PIXELS / (w * h || 1)) // and not too many pixels in total
  );
}

export function _svgForExport() {
  const src = document.getElementById('graph-svg');
  const main = state.gMain?.node();
  if (!src || !main) return null;

  const box = main.getBBox();
  if (!box.width || !box.height) return null;

  const clone = src.cloneNode(true);
  clone.removeAttribute('id');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Names and years are hidden on screen once the zoom drops far enough that
  // they would be unreadable. The export has no zoom — it is the whole chart at
  // full size — so exporting while zoomed out must not produce a chart of empty
  // boxes. Unhide them on the copy, which leaves the live view alone.
  clone.querySelectorAll('.node-label, .node-years').forEach(el => { el.style.display = ''; });

  // The bounding box is in the main group's own coordinates, so dropping the
  // zoom transform and framing on the box exports the whole chart at its
  // natural size — not whatever happens to be on screen right now.
  const mainClone = clone.querySelector('g.main-g');
  if (mainClone) mainClone.removeAttribute('transform');

  const x = box.x - EXPORT_MARGIN, y = box.y - EXPORT_MARGIN;
  const w = box.width + EXPORT_MARGIN * 2, h = box.height + EXPORT_MARGIN * 2;
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.style.width = '';
  clone.style.height = '';

  // Fonts and background come from the page, which the copy leaves behind.
  clone.setAttribute('font-family', getComputedStyle(src).fontFamily || 'sans-serif');
  const bg = getComputedStyle(document.getElementById('graph-container')).backgroundColor;
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', x); rect.setAttribute('y', y);
  rect.setAttribute('width', w); rect.setAttribute('height', h);
  rect.setAttribute('fill', bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#000000');
  clone.insertBefore(rect, clone.firstChild);

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = EXPORT_SVG_CSS;
  clone.insertBefore(style, clone.firstChild);

  return { markup: new XMLSerializer().serializeToString(clone), w, h };
}

export function export2DImage() {
  if (state.currentView !== '2d') { alert(t('focus.exportNeeds2D')); return; }
  const svg = _svgForExport();
  if (!svg) { alert(t('focus.exportEmpty')); return; }

  const scale = _exportScale(svg.w, svg.h);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(svg.w * scale);
    canvas.height = Math.round(svg.h * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) { alert(t('focus.exportFailed')); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = _baseFilename() + '_2d.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);   // see _downloadBlob
    }, 'image/png');
  };
  img.onerror = () => alert(t('focus.exportFailed'));
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.markup);
}

export function export2DSVG() {
  if (state.currentView !== '2d') { alert(t('focus.exportNeeds2D')); return; }
  const svg = _svgForExport();
  if (!svg) { alert(t('focus.exportEmpty')); return; }
  _downloadBlob(svg.markup, _baseFilename() + '_2d.svg', 'image/svg+xml;charset=utf-8');
}

export const SLIDER_MAP = [
  { sid: 'ps-spouse-dist',  nid: 'pn-spouse-dist',  key: 'spouseDist',     fmt: v => Math.round(v) },
  { sid: 'ps-parent-dist',  nid: 'pn-parent-dist',  key: 'parentDist',     fmt: v => Math.round(v) },
  { sid: 'ps-spouse-str',   nid: 'pn-spouse-str',   key: 'spouseStrength', fmt: v => v.toFixed(2) },
  { sid: 'ps-parent-str',   nid: 'pn-parent-str',   key: 'parentStrength', fmt: v => v.toFixed(2) },
  { sid: 'ps-charge-indi',  nid: 'pn-charge-indi',  key: 'chargeIndi',     fmt: v => Math.round(v) },
  { sid: 'ps-charge-fam',   nid: 'pn-charge-fam',   key: 'chargeFam',      fmt: v => Math.round(v) },
  { sid: 'ps-charge-dist',  nid: 'pn-charge-dist',  key: 'chargeDistMax',  fmt: v => Math.round(v) },
  { sid: 'ps-collide',      nid: 'pn-collide',      key: 'collideRadius',  fmt: v => Math.round(v) },
  { sid: 'ps-ystr',         nid: 'pn-ystr',         key: 'yStrength',      fmt: v => v.toFixed(2) },
  { sid: 'ps-center',       nid: 'pn-center',       key: 'centerStrength', fmt: v => v.toFixed(3) },
  { sid: 'ps-vdecay',       nid: 'pn-vdecay',       key: 'velocityDecay',  fmt: v => v.toFixed(2) },
  { sid: 'ps-alphadecay',   nid: 'pn-alphadecay',   key: 'alphaDecay',     fmt: v => v.toFixed(3) },
];

export function syncPhysicsUI() {
  for (const { sid, nid, key, fmt } of SLIDER_MAP) {
    const slider = document.getElementById(sid);
    const numIn  = document.getElementById(nid);
    const v = state.physicsParams[key];
    if (slider) slider.value = v;
    if (numIn) numIn.value = fmt(v);
  }
}

/** The three things about a 2D name label a reader can change. Applied to what
 *  is already on screen and written straight through to storage — every other
 *  panel in the app does both, and this one used to do neither: labelStyle was
 *  read by the renderer and had no control anywhere in the UI. */
export function setLabelStyle(key, value) {
  if (!(key in LABEL_STYLE_DEFAULTS)) return;
  state.labelStyle[key] = key === 'fontWeight' ? value : Number(value);
  saveSetting('labelStyle', state.labelStyle);
  syncLabelStyleUI();
  updateLabelColors();
  updateLabels(true);   // forced: the fit cache is keyed on the size that just changed
}

export function resetLabelStyle() {
  Object.assign(state.labelStyle, LABEL_STYLE_DEFAULTS);
  saveSetting('labelStyle', state.labelStyle);
  syncLabelStyleUI();
  updateLabelColors();
  updateLabels(true);
}

export function syncLabelStyleUI() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('label-font-size', labelFontSize());
  set('label-font-size-num', labelFontSize());
  set('label-opacity', state.labelStyle.textOpacity);
  set('label-opacity-num', Number(state.labelStyle.textOpacity).toFixed(2));
  const bold = document.getElementById('label-bold-toggle');
  if (bold) bold.checked = state.labelStyle.fontWeight === 'bold';
}

export function resetView() {
  if (!state.svgSel || !state.zoomBehavior) return;
  state.svgSel.transition().duration(500).call(state.zoomBehavior.transform, d3.zoomIdentity);
}
