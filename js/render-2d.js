import { state } from './state.js';
import { contrastTextColor, nodeBaseColor, refreshNodeColors } from './colors.js';
import { PHYSICS_DEFAULTS } from './constants.js';
import { _baseFilename, _downloadBlob, escAttr, escHtml, escJs } from './gedcom-io.js';
import { buildGraphData, computeActiveData, computeEstimatedYears, computeGenerationDepths, generationNumbers, isIndiVisible, personAgeYears, updateFocusUI } from './graph-data.js';
import { wasTouchDrag } from './main.js';
import { closeDetailPanel, quickAddChildFromHover, quickAddFromHover, row, showFamDetail, showIndiDetail } from './panels.js';
import { _tryPickRelationPerson, applyHighlight } from './relations.js';
import { _push3DData, _setOrbitTarget3D, apply3DPhysics, build3DTimeline, setView, update3DNames } from './render-3d.js';
import { _linkPath, applyTimelineYFix, applyTreeLayout, famMarkerSize, frameTreeChart, releaseTreePins, useTreeLayout } from './tree-layout.js';

export const NODE_BOX_W  = 92;

export const NODE_BOX_H  = 30;   // two lines: name, then the years under it

export const NODE_BOX_RX = 5;

export const NODE_BOX_FONT = 10; // px, in graph units — scales with the box, not the screen

export const NODE_YEAR_FONT = 8;

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

  let _labelRafPending = false;
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
    .on('zoom', evt => {
      // Store current transform before applying
      _lastTransform = evt.transform;

      state.gMain.attr('transform', evt.transform);
      const prev = state.currentZoom;
      state.currentZoom = evt.transform.k;
      // Full label update only when crossing visibility thresholds; otherwise RAF-throttled
      const crossedThreshold = (prev < 0.35) !== (state.currentZoom < 0.35) ||
                               (prev < 1.1)  !== (state.currentZoom < 1.1);
      if (crossedThreshold) {
        updateLabels();
      } else if (!_labelRafPending) {
        _labelRafPending = true;
        requestAnimationFrame(() => { _labelRafPending = false; updateLabels(); });
      }
    });

  // Auto-recenter if graph centroid is way off-screen (prevents getting "lost")
  setInterval(() => {
    if (!state.svgSel || !state.nodes.length) return;
    const W = document.getElementById('graph-svg')?.clientWidth || 800;
    const H = document.getElementById('graph-svg')?.clientHeight || 600;
    const transform = d3.zoomTransform(state.svgSel.node());

    // Check if any nodes are visible in current viewport
    let anyVisible = false;
    const margin = 100; // Allow some overflow
    for (const n of state.nodes) {
      if (n.x == null || n.y == null) continue;
      const screenX = transform.x + n.x * transform.k;
      const screenY = transform.y + n.y * transform.k;
      if (screenX > -margin && screenX < W + margin &&
          screenY > -margin && screenY < H + margin) {
        anyVisible = true;
        break;
      }
    }

    // If nothing is visible, auto-recenter
    if (!anyVisible && state.nodes.length > 0) {
      zoomToFit();
    }
  }, 2000); // Check every 2 seconds

  // Keyboard shortcuts for zoom
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '0') {
      e.preventDefault();
      resetView();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      state.svgSel.transition().duration(200).call(state.zoomBehavior.scaleBy, 1.3);
    } else if (e.key === '-') {
      e.preventDefault();
      state.svgSel.transition().duration(200).call(state.zoomBehavior.scaleBy, 1 / 1.3);
    }
  });

  state.svgSel.call(state.zoomBehavior);

  // Click on SVG background → deselect
  state.svgSel.on('click', evt => {
    if (evt.target === state.svgSel.node()) closeDetailPanel();
  });
}

export const QA_BTN_R = 9;

export function _appendQaButton(sel, dx, dy, title, onClick) {
  const g = sel.append('g')
    .attr('class', 'qa-hover-btn')
    .attr('transform', `translate(${dx},${dy})`)
    .style('display', 'none')
    .style('cursor', 'pointer')
    .on('click', (evt, d) => { evt.stopPropagation(); onClick(d); })
    .on('mousedown', evt => evt.stopPropagation()); // don't let it start a node drag
  g.append('circle')
    .attr('r', QA_BTN_R)
    .attr('fill', '#1e1e1e')
    .attr('stroke', '#888')
    .attr('stroke-width', 1);
  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('dy', '0.5px')
    .attr('font-size', '13px')
    .attr('fill', '#ddd')
    .attr('pointer-events', 'none')
    .text('+');
  g.append('title').text(title);
  return g;
}

export const QA_BTN_OFFSET = QA_BTN_R - 2;

export function _addQuickAddButtons(indiSel, famSel) {
  _appendQaButton(indiSel, 0, -(NODE_BOX_H / 2 + QA_BTN_OFFSET), t('detail.addParent'), d => quickAddFromHover(d.id, 'parent'));
  _appendQaButton(indiSel, NODE_BOX_W / 2 + QA_BTN_OFFSET, 0,     t('detail.addSpouse'), d => quickAddFromHover(d.id, 'spouse'));
  _appendQaButton(indiSel, 0, NODE_BOX_H / 2 + QA_BTN_OFFSET,     t('detail.addChild'), d => quickAddFromHover(d.id, 'child'));
  _appendQaButton(famSel, 0, famMarkerSize() + QA_BTN_OFFSET,     t('detail.addChild'), d => quickAddChildFromHover(d.id));
}

export function renderGraph() {
  console.time('[rg] clear');       state.gMain.selectAll('*').remove();                    console.timeEnd('[rg] clear');

  // Links layer — <path> so the tree layout can draw square elbows; the force
  // layout just emits a straight two-point path through the same element.
  console.time('[rg] links');
  state.linkSel = state.gMain.append('g').attr('class', 'links-g')
    .selectAll('path')
    .data(state.links)
    .join('path')
    .attr('fill', 'none')
    .attr('stroke', d => linkColor(d))
    .attr('stroke-dasharray', d => linkDash(d))
    .attr('stroke-width', d => linkWidth(d))
    .attr('opacity', d => linkBaseOpacity(d));
  console.timeEnd('[rg] links');

  // Nodes layer
  console.time('[rg] node join');
  const nodeG = state.gMain.append('g').attr('class', 'nodes-g');

  state.nodeSel = nodeG.selectAll('g.ng')
    .data(state.nodes, d => d.id)
    .join('g')
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
    .on('mousemove', onMove)
    .on('mouseout', onOut)
    // mouseenter/mouseleave (not mouseover/mouseout) so moving onto one of the
    // quick-add buttons — a child of this same <g> — doesn't count as leaving
    // it and hide the very button the cursor is over.
    .on('mouseenter', function () {
      // A button reaches slightly past this node's own box, which can be
      // sitting right next to another one (a spouse, typically) that would
      // otherwise paint over it — raise() moves this <g> to the end of its
      // parent so the hovered node and its buttons are always on top.
      d3.select(this).raise();
      d3.select(this).selectAll('.qa-hover-btn').style('display', '');
    })
    .on('mouseleave', function () { d3.select(this).selectAll('.qa-hover-btn').style('display', 'none'); })
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
  console.timeEnd('[rg] node join');

  // Draw shapes per node — batched selections instead of per-node .each()
  console.time('[rg] shapes');
  const indiSel = state.nodeSel.filter(d => d.type === 'INDI');
  const famSel  = state.nodeSel.filter(d => d.type === 'FAM');

  indiSel.append('rect')
    .attr('class', 'indi-box')
    .attr('x', -NODE_BOX_W / 2)
    .attr('y', -NODE_BOX_H / 2)
    .attr('width', NODE_BOX_W)
    .attr('height', NODE_BOX_H)
    .attr('rx', NODE_BOX_RX)
    .attr('fill', d => nodeBaseColor(d))
    .attr('stroke', '#00000033')
    .attr('stroke-width', 0.8)
    .attr('stroke-dasharray', d => d.data.deceased ? '3 2' : null)
    .attr('opacity', d => d.data.deceased ? 0.55 : 1);

  // Ring the focus person — otherwise they're just another box in the middle
  // of the tree that was built around them.
  indiSel.filter(d => d.id === state.focusRootId)
    .append('rect')
    .attr('class', 'focus-ring')
    .attr('x', -NODE_BOX_W / 2 - 4)
    .attr('y', -NODE_BOX_H / 2 - 4)
    .attr('width', NODE_BOX_W + 8)
    .attr('height', NODE_BOX_H + 8)
    .attr('rx', NODE_BOX_RX + 3)
    .attr('fill', 'none')
    .attr('stroke', '#f2f2f2')
    .attr('stroke-width', 1.5)
    .attr('pointer-events', 'none');

  famSel.append('polygon')
    .attr('class', 'fam-polygon')
    .attr('points', () => { const s = famMarkerSize(); return `0,${-s} ${s},0 0,${s} ${-s},0`; })
    .attr('fill',   d => d.data.div ? state.nodeColors.famDiv : state.nodeColors.fam)
    .attr('stroke', d => d.data.div ? state.nodeColors.famDiv : state.nodeColors.fam)
    .attr('stroke-width',     d => d.data.div ? 1.5 : 1)
    .attr('stroke-dasharray', d => d.data.div ? '3 2' : null)
    .attr('opacity', 0.88);
  console.timeEnd('[rg] shapes');

  _addQuickAddButtons(indiSel, famSel);

  // Name label — lives inside the box (not a separate layer floating above
  // it), so it moves, scales and z-orders with the node for free.
  console.time('[rg] labels');
  state.labelSel = indiSel.append('text')
    .attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('dy', '-4px')
    .attr('fill', d => contrastTextColor(nodeBaseColor(d)))
    .attr('fill-opacity', state.labelStyle.textOpacity)
    .attr('font-size', NODE_BOX_FONT + 'px')
    .attr('font-weight', state.labelStyle.fontWeight || 'normal')
    .attr('pointer-events', 'none')
    .text(d => d.data.displayName);

  // Years on a second line under the name. Only for people who have one —
  // an empty element still costs a DOM node per person, and on a big chart
  // that is the difference between a snappy repaint and a stuttering one.
  state.yearSel = indiSel.filter(d => nodeYears(d.data))
    .append('text')
    .attr('class', 'node-years')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('dy', '7px')
    .attr('fill', d => contrastTextColor(nodeBaseColor(d)))
    .attr('fill-opacity', state.labelStyle.textOpacity * 0.75)
    .attr('font-size', NODE_YEAR_FONT + 'px')
    .attr('pointer-events', 'none')
    .text(d => nodeYears(d.data));

  console.timeEnd('[rg] labels');
  updateLabels();
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
    this.setAttribute('fill',         contrastTextColor(nodeBaseColor(d)));
    this.setAttribute('fill-opacity', state.labelStyle.textOpacity);
    this.setAttribute('font-weight',  weight);
  });
  state.yearSel?.each(function(d) {
    this.setAttribute('fill',         contrastTextColor(nodeBaseColor(d)));
    this.setAttribute('fill-opacity', state.labelStyle.textOpacity * 0.75);
  });
}

export function updateLabels() {
  if (!state.labelSel || state.labelSel.empty()) return;
  const zoom = state.currentZoom;
  // Below this the box itself is a few screen px wide — the name would just
  // be noise, so drop it rather than render illegible text.
  const hidden = zoom < 0.28;

  const weight = state.labelStyle.fontWeight || 'normal';

  state.labelSel.each(function(d) {
    if (hidden) { this.style.display = 'none'; return; }
    this.style.display = '';

    // Fitting is a property of the name and the box, not of the zoom, so it is
    // worked out once per name and remembered. updateLabels runs on every zoom
    // change and measuring text forces a layout — doing it here every time
    // would make panning stutter on a large chart.
    const full = d.data.displayName || '';
    const key = full + '\\0' + weight;
    if (this.__fitKey !== key) {
      _fitLabel(this, full, NODE_BOX_W - 10, NODE_BOX_FONT);
      this.__fitKey  = key;
      this.__fitText = this.textContent;
      this.__fitSize = this.getAttribute('font-size');
    } else {
      this.textContent = this.__fitText;
      this.setAttribute('font-size', this.__fitSize);
    }
  });

  // The years are already short enough to fit, so they only need the colour
  // refresh and the same legibility cutoff — one step earlier, since they are
  // set smaller than the name and go to mush first.
  state.yearSel?.each(function(d) {
    this.style.display = zoom < 0.4 ? 'none' : '';
  });
}

export function buildAndRunSimulation(opts = {}) {
  // Keep birth year range for the 3D timeline, and the generation range for
  // the other way of stacking them. The 3D view reads both regardless of
  // which 2D layout is active, so this has to run even when the tree layout
  // is about to make the rest of this function a no-op below.
  const birthYears = state.nodes
    .filter(n => n.type === 'INDI' && n.data.birthYear)
    .map(n => n.data.birthYear);
  const minBY = birthYears.length ? Math.min(...birthYears) : 1750;
  const maxBY = birthYears.length ? Math.max(...birthYears) : 2025;
  state._birthYearRange = { min: minBY, max: maxBY };

  const gd = computeGenerationDepths();
  const gs = state.nodes.filter(n => n.type === 'INDI' && gd.has(n.id)).map(n => gd.get(n.id));
  state._genRange3D = gs.length ? { min: Math.min(...gs), max: Math.max(...gs) } : null;

  // Compute estimated birth years for persons without one (uses generation & relation info)
  console.time('[sim] computeEstimatedYears'); computeEstimatedYears(); console.timeEnd('[sim] computeEstimatedYears');

  // Expand range to include estimated years so timeline covers everyone
  if (state._estimatedYears && state._estimatedYears.size) {
    let eMin = minBY, eMax = maxBY;
    for (const yr of state._estimatedYears.values()) {
      if (yr < eMin) eMin = yr;
      if (yr > eMax) eMax = yr;
    }
    state._birthYearRange = { min: eMin, max: eMax };
  }

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
  console.time('[sim] computeGenerationDepths');
  const genDepths = computeGenerationDepths();
  console.timeEnd('[sim] computeGenerationDepths');
  const maxGen = genDepths.size ? Math.max(...genDepths.values()) : 0;

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
    state.simulation = d3.forceSimulation(state.nodes)
      .force('link', d3.forceLink(state.links)
        .id(d => d.id)
        .distance(d => d.ltype === 'spouse' ? p.spouseDist    : p.parentDist)
        .strength(d => d.ltype === 'spouse' ? p.spouseStrength : p.parentStrength)
      )
      .force('charge', d3.forceManyBody()
        .strength(d => d.type === 'FAM' ? -p.chargeFam : -p.chargeIndi)
        .distanceMax(p.chargeDistMax)
      )
      .force('center', d3.forceCenter(W / 2, H / 2).strength(p.centerStrength))
      .force('collide', d3.forceCollide(d => d.type === 'FAM' ? 9 : p.collideRadius).strength(0.7))
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
    console.log(`[sim] headless: ${state.nodes.length} nodes, ${state.links.length} links, ${totalTicks} ticks`);
    console.time('[sim] headless ticks');
    for (let i = 0; i < totalTicks; i++) state.simulation.tick();
    console.timeEnd('[sim] headless ticks');
    console.time('[sim] tick() DOM paint');  tick();     console.timeEnd('[sim] tick() DOM paint');
    console.time('[sim] onSimEnd');          onSimEnd(); console.timeEnd('[sim] onSimEnd');
  } else {
    state.simulation.on('tick', tick);
    state.simulation.on('end', onSimEnd);
    state.simulation.restart();
  }
}

export function applyPhysicsParams() {
  if (!state.simulation) return;
  const p = state.physicsParams;

  state.simulation.force('link')
    .distance(d => d.ltype === 'spouse' ? p.spouseDist    : p.parentDist)
    .strength(d => d.ltype === 'spouse' ? p.spouseStrength : p.parentStrength);

  state.simulation.force('charge')
    .strength(d => d.type === 'FAM' ? -p.chargeFam : -p.chargeIndi)
    .distanceMax(p.chargeDistMax);

  state.simulation.force('collide')
    .radius(d => d.type === 'FAM' ? 9 : p.collideRadius);

  state.simulation.force('fy')
    .strength(p.yStrength);

  state.simulation.force('center')
    .strength(p.centerStrength);

  state.simulation
    .alphaDecay(p.alphaDecay)
    .velocityDecay(p.velocityDecay)
    .alpha(Math.max(state.simulation.alpha(), 0.25))
    .restart();

  document.getElementById('loading-overlay').style.display = 'none';
  if (state.graph3d) apply3DPhysics();
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
}

export function zoomToFit() {
  if (!state.nodes.length || !state.svgSel) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth, H = svgEl.clientHeight;

  const xs = state.nodes.map(n => n.x).filter(v => v != null);
  const ys = state.nodes.map(n => n.y).filter(v => v != null);
  if (!xs.length) return;

  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
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
    state.graph3d.zoomToFit(800, 60);
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

export function onMove(evt) { positionTooltip(evt); }

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

export function getUserPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); }
  catch { return {}; }
}

export function savePreset() {
  const name = document.getElementById('preset-name-input').value.trim();
  if (!name) return;
  const all = getUserPresets();
  all[name] = { ...state.physicsParams };
  localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
  document.getElementById('preset-name-input').value = '';
  renderPresetList();
}

export function deletePreset(name) {
  const all = getUserPresets();
  delete all[name];
  localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
  renderPresetList();
}

export function applyPreset(name, builtin) {
  const src = builtin ? BUILTIN_PRESETS[name] : getUserPresets()[name];
  state.physicsParams = { ...PHYSICS_DEFAULTS, ...src };
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
    row.innerHTML = `<span class="preset-name" title="${escAttr(name)}" onclick="applyPreset('${escJs(name)}',true)">${escHtml(name)}</span>`;
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
  const btn = document.getElementById('node-drag-btn');
  if (btn) {
    btn.textContent = state._nodeDragEnabled
      ? '🔓 ' + t('sidebar.dragOn')
      : '🔒 ' + t('sidebar.dragOff');
    btn.style.opacity = state._nodeDragEnabled ? '1' : '0.6';
  }
}

export const EXPORT_MARGIN = 40;

export const EXPORT_LONG_EDGE = 6000;   // target for the longer side, in pixels

export const EXPORT_MAX_PIXELS = 40e6;  // browsers refuse to rasterise much beyond this

export const EXPORT_MAX_EDGE = 16384;   // ...and refuse any single dimension past this

export const EXPORT_SVG_CSS = `
  .node-label { text-anchor: middle; dominant-baseline: auto; }
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
      URL.revokeObjectURL(url);
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
  { sid: 'ps-spouse-dist',  vid: 'pv-spouse-dist',  key: 'spouseDist',     fmt: v => Math.round(v) },
  { sid: 'ps-parent-dist',  vid: 'pv-parent-dist',  key: 'parentDist',     fmt: v => Math.round(v) },
  { sid: 'ps-spouse-str',   vid: 'pv-spouse-str',   key: 'spouseStrength', fmt: v => v.toFixed(2) },
  { sid: 'ps-parent-str',   vid: 'pv-parent-str',   key: 'parentStrength', fmt: v => v.toFixed(2) },
  { sid: 'ps-charge-indi',  vid: 'pv-charge-indi',  key: 'chargeIndi',     fmt: v => Math.round(v) },
  { sid: 'ps-charge-fam',   vid: 'pv-charge-fam',   key: 'chargeFam',      fmt: v => Math.round(v) },
  { sid: 'ps-charge-dist',  vid: 'pv-charge-dist',  key: 'chargeDistMax',  fmt: v => Math.round(v) },
  { sid: 'ps-collide',      vid: 'pv-collide',       key: 'collideRadius',  fmt: v => Math.round(v) },
  { sid: 'ps-ystr',         vid: 'pv-ystr',          key: 'yStrength',      fmt: v => v.toFixed(2) },
  { sid: 'ps-center',       vid: 'pv-center',        key: 'centerStrength', fmt: v => v.toFixed(3) },
  { sid: 'ps-vdecay',       vid: 'pv-vdecay',        key: 'velocityDecay',  fmt: v => v.toFixed(2) },
  { sid: 'ps-alphadecay',  vid: 'pv-alphadecay',    key: 'alphaDecay',     fmt: v => v.toFixed(3) },
];

export function syncPhysicsUI() {
  for (const { sid, vid, key, fmt } of SLIDER_MAP) {
    const el = document.getElementById(sid);
    const vl = document.getElementById(vid);
    if (el) el.value = state.physicsParams[key];
    if (vl) vl.textContent = fmt(state.physicsParams[key]);
  }
}

export function resetView() {
  if (!state.svgSel || !state.zoomBehavior) return;
  state.svgSel.transition().duration(500).call(state.zoomBehavior.transform, d3.zoomIdentity);
}
