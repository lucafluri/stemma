import { state } from './state.js';
import { physicsScale } from './constants.js';
import { seedScene3D } from './seed-3d.js';
import { buildInstanced3D, instancedActive, pickInstanced3D, teardownInstanced3D, updateInstanced3D } from './render-3d-instanced.js';

import { _compute3DLinkColor, _nameTextColor, compute3DNodeColor } from './colors.js';
import { openNodeContextMenu } from './context-menu.js';
import { computeActiveData, updateFocusUI } from './graph-data.js';
import { _isMobile, closeDetailPanel, minimizeDetailPanel, row, showFamDetail, showIndiDetail } from './panels.js';
import { _famNodeVal, _tryPickRelationPerson, applyHighlight, updateHLButtons } from './relations.js';
import { buildAndRunSimulation, initSVG, linkColor, linkWidth, onHover, onOut, onSimEnd, renderGraph, zoomToFit } from './render-2d.js';
import { applyTimelineYFix, genTo3DY, yearTo3DY } from './tree-layout.js';

export function toggleView() { setView(state.currentView === '2d' ? '3d' : '2d'); }

export function setView(view) {
  if (view !== '2d' && view !== '3d') return;
  if (!state.allNodes.length) return;

  const changed = view !== state.currentView;
  state.currentView = view;
  localStorage.setItem('viewMode', view);
  updateViewToggleUI();               // swaps containers + 3D-only sidebar rows

  if (view === '3d') {
    if (changed) computeActiveData();   // focus filter no longer applies — restore full set
    if (!state.graph3d) {
      initGraph3D();
    } else {
      state.graph3d.resumeAnimation();
      resize3D();
      if (changed) {
        _push3DData(); apply3DPhysics(); build3DTimeline(); update3DNames();
        // Re-pushing restarts the 3D layout, so the old camera no longer frames
        // anything — refit once it has had a moment to spread out.
        setTimeout(() => fit3D(700), 900);
      }
    }
    setTimeout(() => {
      if (state.selectedIndiId) _setOrbitTarget3D(state.selectedIndiId);
      else if (state._orbitControls3d) state._orbitControls3d.target.copy(_graphCentroid3D());
    }, 200);
  } else {
    if (state.graph3d) state.graph3d.pauseAnimation();

    // No focus is picked on the way in. Switching to 2D used to quietly appoint
    // one — the selected person, or the best-connected hub — on the grounds that
    // an unfocused force layout is a dust cloud. But the chart layout is the
    // default now, and that draws a whole file as a readable, if wide, tree; and
    // a filter the reader never asked for is worse than a big picture, because
    // nothing on screen says people are missing. Focus stays something you turn
    // on deliberately.

    if (changed) {
      computeActiveData();
      if (!state.svgSel) initSVG();
      renderGraph();
      applyHighlight();
      state._firstLoad = true;              // makes onSimEnd auto-fit the new layout
      buildAndRunSimulation();
    }
  }

  updateFocusUI();
  updateHLButtons();
}

const _id3 = v => (typeof v === 'object' && v ? v.id : v);

/**
 * The slice of the active set the scene can actually carry — see
 * state.scene3d.maxNodes. Taken as a connected ball grown outward from the
 * best-connected person on screen rather than as the first N of the array: an
 * arbitrary slice of a large file is mostly people with no relative in it, and
 * a scene of unconnected dots says less than a smaller scene that holds
 * together.
 */
function _sceneBall(budget) {
  const adj = new Map();
  const link = (a, b) => {
    const at = adj.get(a);
    if (at) at.push(b); else adj.set(a, [b]);
  };
  for (const l of state.links) {
    const s = _id3(l.source), t = _id3(l.target);
    link(s, t); link(t, s);
  }

  // Best-connected first, so the scene fills with the parts of the file that
  // have the most to show. A GEDCOM is very often several unrelated trees, and
  // one ball then runs out of people long before it runs out of budget — the
  // first version of this filled 141 of a 4,000 slot scene for exactly that
  // reason. So seeds are taken in turn until the budget is met, which fills it
  // with whole families rather than a fragment of one.
  const order = state.nodes.map(n => n.id)
    .sort((a, b) => (adj.get(b)?.length ?? 0) - (adj.get(a)?.length ?? 0));
  // A focus person is the reader's own answer to "who is this scene about", and
  // outranks the merely well-connected one.
  if (state.focusRootId && state.individuals.has(state.focusRootId)) {
    order.unshift(state.focusRootId);
  }

  const keep = new Set();
  for (const seed of order) {
    if (keep.size >= budget) break;
    if (keep.has(seed)) continue;
    keep.add(seed);
    let frontier = [seed];
    while (frontier.length && keep.size < budget) {
      const next = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) || []) {
          if (keep.size >= budget) break;
          if (keep.has(nb)) continue;
          keep.add(nb);
          next.push(nb);
        }
        if (keep.size >= budget) break;
      }
      frontier = next;
    }
  }
  return keep;
}

/** What to hand ForceGraph3D: the whole active set, or a budgeted ball of it. */
export function scene3DData() {
  let nodes = state.nodes, links = state.links;
  if (nodes.length > state.scene3d.maxNodes) {
    const keep = _sceneBall(state.scene3d.maxNodes);
    nodes = nodes.filter(n => keep.has(n.id));
    links = links.filter(l => keep.has(_id3(l.source)) && keep.has(_id3(l.target)));
  }
  state._3dOmitted = state.nodes.filter(n => n.type === 'INDI').length
                   - nodes.filter(n => n.type === 'INDI').length;
  return {
    nodes: nodes.map(n => ({ id: n.id, type: n.type, data: n.data })),
    links: links.map(l => ({ source: _id3(l.source), target: _id3(l.target), ltype: l.ltype })),
  };
}

/**
 * Level of detail, chosen from how much is in the scene rather than from the
 * camera: the objects are built once at push time and kept, so this is the only
 * moment the choice can be made. Link cylinders become plain line segments —
 * one mesh per link is what puts tens of thousands of draw calls in a frame —
 * and the spheres lose facets nobody can resolve at that density anyway.
 */
function _apply3DDetail(g, nodeCount) {
  // Instanced: the library draws nothing at all. An empty Object3D per node is
  // still created — that is how it tracks positions — but it has no geometry and
  // so costs no draw call, and the links are switched off outright. Everything
  // visible comes from render-3d-instanced.js instead.
  if (state.instanced3d) {
    g.nodeThreeObject(() => new THREE.Object3D())
     .nodeThreeObjectExtend(false)
     .linkVisibility(false);
    return true;
  }
  g.linkVisibility(true);
  const dense = nodeCount > state.scene3d.detailMax;
  g.linkWidth(dense ? 0 : state._3dAppearance.linkWidth)
   .nodeResolution(dense ? 6 : (_isMobile() ? 8 : 12));
  return dense;
}

export function _push3DData() {
  if (!state.graph3d) return;
  const data = scene3DData();

  // A changed set is a new layout: give it the computed starting shape rather
  // than making the simulation discover one. An unchanged set is a repaint —
  // re-seeding there would throw away a settled layout to no purpose.
  const sameSet = state._g3dById
    && state._g3dById.size === data.nodes.length
    && data.nodes.every(n => state._g3dById.has(n.id));
  if (!sameSet) seedScene3D(data);

  _apply3DDetail(state.graph3d, data.nodes.length);
  state.graph3d.graphData(data);
  // Built from what was just pushed rather than read back out of the library:
  // these are the very objects it keeps and writes x/y/z onto, so the map holds
  // live positions, and the scene's size stays a number this file owns.
  //
  // Both the orbit target and the pivot snap used to look a node up with a
  // linear .find() over the whole scene — the tracking one on every rendered
  // frame.
  state._g3dById = new Map(data.nodes.map(n => [n.id, n]));

  // ForceGraph3D leaves its layout engine stopped when new data arrives through
  // graphData(): the people change but no force ever acts on them, so a focus
  // change or a cleared focus left whatever positions happened to be there
  // frozen on screen. Measured directly — scattering every node to a mean radius
  // of 1,578 and calling graphData() alone left it at 1,578; refresh() alone
  // left it at 1,553; refresh() *and* a reheat pulled it back to 893 and kept
  // going. Neither resumeAnimation nor cooldownTime/cooldownTicks nor
  // numDimensions revived it. This is not new — the unmodified app behaves the
  // same way — and rebuilding the whole instance also works but throws the
  // canvas and the camera away with it.
  state.graph3d.refresh();
  state.graph3d.d3ReheatSimulation();

  // The scene it was culled against no longer exists.
  _lastCullPos.x = _lastCullPos.y = _lastCullPos.z = NaN;
  if (state.instanced3d) buildInstanced3D();
  update3DSceneInfo();
}

/**
 * The line of plain figures under the scene sliders: what the scene is holding
 * right now, so the budgets are not set blind. Lives here rather than with the
 * rest of the sidebar wiring because every one of these numbers is a property of
 * the scene, and this is the file that changes them — put in the panel, it went
 * stale on every push that did not happen to come from a slider.
 */
/**
 * Switch between the instanced layers and the library's own per-object
 * rendering. Both paths build their objects at push time, so this re-pushes
 * rather than trying to convert one into the other in place.
 */
export function setInstanced3D(on) {
  state.instanced3d = !!on;
  localStorage.setItem('instanced3d', state.instanced3d ? '1' : '0');
  const cb = document.getElementById('instanced-3d-toggle');
  if (cb) cb.checked = state.instanced3d;
  if (!state.graph3d) return;
  teardownInstanced3D();
  _push3DData();          // rebuilds whichever set of objects now applies
  apply3DPhysics({ reheat: false });
  update3DNames();
  refresh3D();
}

/**
 * Turn distance culling on or off. Off is the default now that the whole scene
 * costs three draw calls; on reinstates the nearest-N budget for a machine that
 * still wants it.
 */
export function setCull3D(on) {
  state.cull3d = !!on;
  localStorage.setItem('cull3d', state.cull3d ? '1' : '0');
  const cb = document.getElementById('cull-3d-toggle');
  if (cb) cb.checked = state.cull3d;
  // The "drawn at once" budget only means something while culling is on.
  const row = document.getElementById('sc-draw-max-row');
  if (row) row.style.display = state.cull3d ? '' : 'none';
  cull3D(true);              // forced: this is what puts everything back on
  update3DSceneInfo();
}

export function update3DSceneInfo() {
  const el = document.getElementById('sc-scene-info');
  if (!el) return;
  const built = state._g3dById?.size ?? 0;
  el.textContent = built
    ? t('appearance.sceneInfo', {
        built,
        drawn: state.cull3d ? Math.min(built, state.scene3d.drawMax) : built,
        omitted: state._3dOmitted || 0,
        scale: physicsScale(built).toFixed(1),
      })
    : '';
}

export function updateViewToggleUI() {
  const in3d = state.currentView === '3d';

  const c2d = document.getElementById('graph-container');
  const c3d = document.getElementById('graph-3d-container');
  if (c2d) c2d.style.display = in3d ? 'none' : 'block';
  if (c3d) c3d.style.display = in3d ? 'block' : 'none';

  const rows = {
    'sort-time-3d-row':  'block',
    'show-names-3d-row': 'flex',
    'time-spread-row':   state.stratify3D !== 'off' ? 'block' : 'none',
    'appearance-panel':  'block',   // background, lights, sphere size: 3D only
  };
  for (const [id, shown] of Object.entries(rows)) {
    const el = document.getElementById(id);
    if (el) el.style.display = in3d ? shown : 'none';
  }

  // ...and the mirror image: things that only exist in the 2D view.
  for (const [id, shown] of Object.entries({ 'export-2d-row': 'block', 'tree-layout-row': 'flex' })) {
    const el = document.getElementById(id);
    if (el) el.style.display = in3d ? 'none' : shown;
  }

  // Physics acts on a force simulation. The classical chart computes its
  // positions outright and has none, so in that mode the panel was controls
  // that visibly did nothing.
  const simLive = in3d || !state.treeLayout;
  const physicsPanel = document.getElementById('physics-panel');
  if (physicsPanel) physicsPanel.style.display = simLive ? 'block' : 'none';

  // The mirror image: spacing only means something for the classical chart.
  const spacingPanel = document.getElementById('tree-spacing-panel');
  if (spacingPanel) spacingPanel.style.display = (!in3d && state.treeLayout) ? 'block' : 'none';

  // Node dragging is 2D-force-only — the 3D drag handler does not work.
  const dragBtn = document.getElementById('node-drag-btn');
  if (dragBtn) dragBtn.style.display = (!in3d && !state.treeLayout) ? 'block' : 'none';

  const btn = document.getElementById('view-toggle-btn');
  if (btn) {
    // Label names the view you'd switch *to*.
    btn.innerHTML = in3d ? '◧ <span>' + t('topbar.view2d') + '</span>'
                         : '◨ <span>' + t('topbar.view3d') + '</span>';
    btn.classList.toggle('active-3d', in3d);
    btn.title = t('topbar.viewTitle');
  }
}

// Frame the whole graph. The padding is in screen pixels, so the desktop value
// eats a third of the width of a phone held upright — the graph ends up framed
// into the middle of the screen with margins nobody asked for.
export function fit3D(ms = 800) {
  if (!state.graph3d) return;
  // A single node has no extent to fit, and zoomToFit answers that by putting
  // the camera practically inside the sphere — which is exactly what someone
  // starting a tree from scratch would see as their first frame. Back off to a
  // fixed, sensible distance until there is a second person to frame against.
  if (state.nodes.length === 1) {
    state.graph3d.cameraPosition({ x: 0, y: 0, z: 260 }, { x: 0, y: 0, z: 0 }, ms);
    return;
  }
  state.graph3d.zoomToFit(ms, _isMobile() ? 20 : 60);
}

export function resize3D() {
  if (!state.graph3d) return;
  const el = document.getElementById('graph-3d-container');
  state.graph3d.width(el.clientWidth).height(el.clientHeight);
}

// Where the pointer is, for placing the tooltip. The container outlives every
// graph instance — `innerHTML = ''` clears its children, not its own listeners
// — so registering these inside initGraph3D() stacked another pair on every
// file load, and each one fires on every mousemove over the scene. Same shape
// as the initSVG leak; once is enough, and the graph is read off state.
let _3dPointerTracked = false;
function _track3DPointer(container) {
  if (_3dPointerTracked) return;
  _3dPointerTracked = true;
  container.addEventListener('mousemove', e => {
    state._3dMousePos.x = e.clientX;
    state._3dMousePos.y = e.clientY;
  });
  container.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      state._3dMousePos.x = e.touches[0].clientX;
      state._3dMousePos.y = e.touches[0].clientY;
    }
  }, { passive: true });
}

export function initGraph3D() {
  const container = document.getElementById('graph-3d-container');
  container.innerHTML = '';

  // Budgeted, exactly as a later _push3DData() would be — this is the path a
  // freshly loaded file takes, and pushing the whole set here was what froze
  // the tab for two minutes before the first frame.
  const data = scene3DData();
  seedScene3D(data);                 // as _push3DData does — never start tangled
  const dense = data.nodes.length > state.scene3d.detailMax;

  _track3DPointer(container);

  state.graph3d = ForceGraph3D()(container)
    .backgroundColor(state._3dAppearance.bgColor)
    .width(container.clientWidth)
    .height(container.clientHeight)
    .graphData(data)
    // ── Nodes ──
    .nodeColor(n => compute3DNodeColor(n))
    .nodeVal(n => _famNodeVal(n))
    .nodeRelSize(state._3dAppearance.nodeRelSize)
    .nodeOpacity(state._3dAppearance.nodeOpacity)
    // Spheres are small on a phone screen; the facets do not show, the triangles
    // still cost. A crowded scene is the same argument at any screen size.
    .nodeResolution(dense ? 6 : (_isMobile() ? 8 : 12))
    // No .nodeLabel() here: the library's own hover tooltip would show
    // alongside the custom #tooltip div that onNodeHover()/onHover() already
    // drive (shared with the 2D view) — showing both at once is the "two
    // tooltips" bug. That one is the richer, kept one.
    // ── Links ──
    .linkColor(l => linkColor(l))
    // A width above zero makes ForceGraph3D build a cylinder mesh per link; at
    // zero it draws the lot as line segments instead.
    .linkWidth(dense ? 0 : state._3dAppearance.linkWidth)
    .linkOpacity(state._3dAppearance.linkOpacity)
    // ── Events ──
    .onNodeClick((n, evt) => {
      if (evt) evt.stopPropagation();
      if (state._3dGestureDragged) return;   // this "tap" was the end of an orbit
      if (n.type === 'INDI' && _tryPickRelationPerson(n.id)) return;
      if (n.type === 'INDI') showIndiDetail(n.id);
      else showFamDetail(n.id);
      _setOrbitTarget3D(n.type === 'INDI' ? n.id : null);
    })
    .onNodeRightClick((n, evt) => openNodeContextMenu(evt, n.id, n.type))
    .onNodeHover(n => {
      if (n) {
        const fakeEvt = { clientX: state._3dMousePos.x, clientY: state._3dMousePos.y };
        onHover(fakeEvt, n);
      } else {
        onOut();
      }
    })
    .onBackgroundClick(() => {
      if (state._3dGestureDragged) return;
      _isMobile() ? minimizeDetailPanel() : closeDetailPanel();
    })
    .enableNodeDrag(false);   // broken in 3D — orbit controls fight the drag handler

  // The same call _push3DData() makes, so both routes into a scene agree about
  // what it draws. Spelling the flags out again here instead is how this path
  // ended up building 11,948 link objects behind the instanced layer: the
  // per-node meshes were suppressed (update3DNames does that) and the links
  // were not, so only one half of the switch had been made.
  _apply3DDetail(state.graph3d, data.nodes.length);

  state._g3dById = new Map(data.nodes.map(n => [n.id, n]));

  // Delay setup so the library's internal controls finish initialising first
  setTimeout(() => {
    if (!state.graph3d) return;

    // ── Swap TrackballControls → OrbitControls (keeps Y-axis upright) ──
    const old = state.graph3d.controls();
    old.dispose();

    const cam = state.graph3d.camera();
    const renderer = state.graph3d.renderer();
    const domEl = renderer.domElement;

    // A phone reports a device pixel ratio of 3, so the renderer shades nine
    // fragments for every one you can see — the single biggest thing between
    // this scene and a usable frame rate on mobile. Two is past the point where
    // the difference is visible on a screen held at arm's length.
    //
    // Only on mobile: whatever the library picked is right for a desktop GPU,
    // and quietly changing it there would be a regression nobody asked for.
    // setPixelRatio reaches the drawing buffer on the next setSize only, and the
    // renderer has been sized already, so re-apply the size rather than waiting
    // for a resize that may never come.
    if (_isMobile()) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(container.clientWidth, container.clientHeight, false);
    }

    state._orbitControls3d = new THREE.OrbitControls(cam, domEl);
    state._orbitControls3d.enableDamping  = true;
    state._orbitControls3d.dampingFactor  = 0.10;
    state._orbitControls3d.rotateSpeed    = 0.5;
    state._orbitControls3d.panSpeed       = 0.9;
    state._orbitControls3d.enableZoom     = true;    // needed for touch dolly; wheel intercepted below
    state._orbitControls3d.enablePan      = true;
    state._orbitControls3d.minDistance    = 1;
    state._orbitControls3d.maxDistance    = Infinity;
    // Touch: 1-finger = ROTATE, 2-finger = DOLLY (zoom) + PAN
    if (state._orbitControls3d.touches) {
      state._orbitControls3d.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      };
    }
    cam.up.set(0, 1, 0);
    state._orbitControls3d.update();

    // Zoom toward cursor position (scroll wheel) — capture phase + stopImmediatePropagation
    // so our custom zoom-to-cursor fires instead of OrbitControls' default wheel zoom
    domEl.addEventListener('wheel', (evt) => {
      evt.stopImmediatePropagation();
      _onWheel3D(evt);
    }, { passive: false, capture: true });

    // Before a rotate drag starts, pull the pivot back onto the tree
    // (pan/zoom can leave the orbit target floating in empty space)
    //
    // The same listeners answer "was this a tap or the end of a drag?". A rotate
    // gesture finishes with a click event, and when it happens to finish over a
    // node the library reports it as a tap on that node — so on a touch screen,
    // where one finger orbits, turning the scene kept throwing open the detail
    // panel of whatever the finger landed on. Slop is wider for a finger than
    // for a mouse: nobody holds a phone still enough for 4px.
    let downAt = null, slop = 4;
    domEl.addEventListener('pointerdown', (evt) => {
      if (evt.isPrimary) {
        downAt = { x: evt.clientX, y: evt.clientY };
        slop = evt.pointerType === 'touch' ? 10 : 4;
        state._3dGestureDragged = false;
      }
      if (evt.button === 0) _snapOrbitPivot3D();
    });
    domEl.addEventListener('pointermove', (evt) => {
      if (!downAt || !evt.isPrimary) return;
      if (Math.hypot(evt.clientX - downAt.x, evt.clientY - downAt.y) > slop) {
        state._3dGestureDragged = true;
      }
    });
    // Leave the flag standing until the click that follows has been judged by it.
    for (const ev of ['pointerup', 'pointercancel']) {
      domEl.addEventListener(ev, () => { downAt = null; });
    }

    // Redirect the render-loop's update() call to our OrbitControls + orbit target tracking
    old.update = () => { _tickOrbitTarget(); state._orbitControls3d.update(); _scheduleCull3D(); };

    // ── Lighting setup — replace ForceGraph3D defaults ──
    const scene = state.graph3d.scene();
    // Remove existing lights
    const oldLights = [];
    scene.traverse(obj => { if (obj.isLight) oldLights.push(obj); });
    oldLights.forEach(l => { if (l.parent) l.parent.remove(l); });

    // Add controllable ambient light
    state._3dAmbientLight = new THREE.AmbientLight(0xffffff, state._3dAppearance.ambientLight);
    scene.add(state._3dAmbientLight);

    // Add controllable point light (attached to camera so it follows view)
    state._3dPointLight = new THREE.PointLight(0xffffff, state._3dAppearance.pointLight, 0);
    cam.add(state._3dPointLight);
    scene.add(cam); // ensure camera is part of scene graph so its children render

    _bindInstancedPicking(domEl);
    // The scene only exists once the library has built it, which is why the
    // instanced layers are added here rather than alongside the graphData call.
    if (state.instanced3d) buildInstanced3D();

    apply3DPhysics();
    build3DTimeline();
    update3DNames();

    // Set render orders after the scene has first rendered
    setTimeout(() => { refresh3D(); fit3D(); }, 2500);
  }, 150);
}

// `repin` recomputes every node's Y from the stratification. That depends on the
// stratify mode and the axis spread and on nothing else — no physics slider
// touches either — so dragging one used to pay for a full repin of every node on
// every input event for no change at all. The controls that *do* change it (the
// mode select, the spread slider) drive applyTimelineYFix themselves.
export function apply3DPhysics({ repin = true, reheat = true } = {}) {
  if (!state.graph3d) return;
  const p = state.physicsParams;

  // The sliders describe the *shape* of the layout at a chart's worth of people;
  // this is what turns that into the absolute numbers a scene of this size
  // needs. Without it a large tree bundles into a ball — see physicsScale().
  const S = physicsScale(state._g3dById?.size ?? state.nodes.length);

  // Only modify forces the library already created — don't inject foreign d3-force objects
  const lf = state.graph3d.d3Force('link');
  if (lf) lf
    .distance(l => (l.ltype === 'spouse' ? p.spouseDist : p.parentDist) * S)
    .strength(l => l.ltype === 'spouse' ? p.spouseStrength : p.parentStrength);

  const cf = state.graph3d.d3Force('charge');
  if (cf) {
    cf.strength(n => (n.type === 'FAM' ? -p.chargeFam : -p.chargeIndi) * S)
      // Scaling this is the whole fix: left at its slider value the repulsion
      // simply stops existing past a fixed radius, and a graph wider than that
      // radius has nothing holding it open.
      .distanceMax(p.chargeDistMax * S);
    // Barnes-Hut accuracy. theta is how large a distant cluster may look before
    // the octree stops descending into it and treats it as one mass — so it
    // trades exactness of the repulsion for the cost of computing it, and it is
    // by far the largest lever on that cost. Measured on a 12,000-node scene:
    // 173 ms per tick at d3's default 0.9, 92 ms at 1.5, 49 ms at 2.5.
    //
    // What the looser value buys is invisible at that size: the error is in
    // where individual people sit within a cluster of thousands, which nobody is
    // reading. A small tree is another matter — there every position is looked
    // at, so it keeps the accurate default.
    if (cf.theta) {
      const n = state._g3dById?.size ?? state.nodes.length;
      cf.theta(n > 8000 ? 2.5 : n > 3000 ? 1.5 : 0.9);
    }
  }

  // The cooling slider is the reader's, and 3D used to ignore it and hard-code
  // its own number — so the one control that says how long the layout keeps
  // moving did nothing in the view where settling actually takes a while.
  //
  // A bigger graph needs more ticks to reach the same quality: alpha has to
  // carry information across a longer graph. Slowing the decay in proportion to
  // the scale gives it those ticks, and the settle time below bounds the wall
  // clock so a huge scene still stops rather than grinding indefinitely.
  state.graph3d.d3AlphaDecay(Math.max(0.002, p.alphaDecay / S));
  state.graph3d.d3VelocityDecay(p.velocityDecay);
  // Ticks are far more expensive on a large scene (measured: 45 ms each at
  // 12,000 nodes against well under 1 ms at a few hundred), so a fixed fifteen
  // seconds buys a settled layout at chart size and barely a start at file size.
  if (state.graph3d.cooldownTime) {
    state.graph3d.cooldownTime(Math.round(Math.min(60000, 8000 * S)));
  }

  // Pin nodes to exact Y positions based on (estimated) birth year.
  // Using node.fy is exact — unlike forceY which fights link/charge forces.
  // Remove any leftover soft forceY from previous sessions.
  if (repin) {
    state.graph3d.d3Force('fy3d', null);
    applyTimelineYFix();
  }

  if (reheat) state.graph3d.d3ReheatSimulation();
}

// ── Distance culling ────────────────────────────────────────────────────────
//
// The 2D view culls to a rectangle because that is what a window is. Here the
// camera sits inside the scene, so the equivalent question is "how far away",
// and the answer is applied by switching objects off rather than by removing
// them: the objects are expensive to build and cheap to hide, and hiding one
// takes its draw call out of the frame just the same.
//
// A link is drawn only when both of its ends are, which needs no second sort
// and is also the right answer visually — a connector to somewhere off in the
// dark says nothing.
let _cullPending = false;
// The simulation keeps moving nodes while the camera sits still, so a still
// camera is not on its own a reason to keep last frame's answer. This counts
// frames since the last pass and forces one about twice a second regardless.
let _cullIdle = 0;
const _lastCullPos = { x: NaN, y: NaN, z: NaN };

export function cull3D(force = false) {
  if (!state.graph3d || !state._g3dById) return;
  // Instanced: there are no per-node objects to switch on and off. Culling is
  // the same decision, applied one step earlier — which nodes get written into
  // the instance buffers at all. This also has to run every frame regardless of
  // whether the camera moved, because it is what carries the simulation's new
  // positions into the buffers.
  if (instancedActive()) { updateInstanced3D(force); return; }

  const nodes = [...state._g3dById.values()];
  const gd = state.graph3d.graphData();

  // Switched off, or a scene small enough not to need it: everything on, and
  // nothing to recompute until that changes.
  if (!state.cull3d || nodes.length <= state.scene3d.drawMax) {
    if (force) {
      for (const n of nodes) if (n.__threeObj) n.__threeObj.visible = true;
      for (const l of gd.links || []) if (l.__lineObj) l.__lineObj.visible = true;
    }
    return;
  }

  const cam = state.graph3d.camera();
  const p = cam.position;
  // The simulation keeps moving nodes, so this cannot be skipped purely on a
  // still camera — but it can be skipped while neither has moved much.
  // NaN on the first pass after a push, and NaN <= 2 is false — so a freshly
  // built scene culls immediately rather than drawing everything until the
  // reader happens to orbit. Written this way round deliberately: the negated
  // form skips on NaN and leaves the scene uncut for good.
  const moved = Math.abs(p.x - _lastCullPos.x) + Math.abs(p.y - _lastCullPos.y) + Math.abs(p.z - _lastCullPos.z);
  if (!force && moved <= 2 && ++_cullIdle < 30) return;
  _cullIdle = 0;
  _lastCullPos.x = p.x; _lastCullPos.y = p.y; _lastCullPos.z = p.z;

  // Squared distance — the ordering is the same and there is no square root.
  const d2 = new Map();
  for (const n of nodes) {
    const dx = (n.x || 0) - p.x, dy = (n.y || 0) - p.y, dz = (n.z || 0) - p.z;
    d2.set(n.id, dx * dx + dy * dy + dz * dz);
  }
  const near = [...d2.entries()].sort((a, b) => a[1] - b[1]).slice(0, state.scene3d.drawMax);
  const shown = new Set(near.map(e => e[0]));

  for (const n of nodes) {
    if (n.__threeObj) n.__threeObj.visible = shown.has(n.id);
  }
  for (const l of gd.links || []) {
    if (!l.__lineObj) continue;
    l.__lineObj.visible = shown.has(_id3(l.source)) && shown.has(_id3(l.target));
  }
}

/** Coalesced to one pass per frame — the render loop calls this every frame. */
function _scheduleCull3D() {
  // Instanced buffers hold the positions themselves, so they have to be
  // rewritten before the frame that uses them, not a frame later — deferring
  // this one to a rAF draws the scene one step behind the simulation, which
  // reads as everything lagging the layout while it settles.
  if (instancedActive()) { updateInstanced3D(); return; }
  if (_cullPending) return;
  _cullPending = true;
  requestAnimationFrame(() => { _cullPending = false; cull3D(); });
}

/**
 * Pointer handling for the instanced renderer. ForceGraph3D finds the node
 * under the cursor by raycasting the objects it built per node; those are empty
 * now, so its onNodeClick/onNodeHover never fire and this stands in for them,
 * raycasting the InstancedMesh instead. Registered once, on the container, for
 * the same reason the pointer tracker above is.
 */
let _instancedPickBound = false;
function _bindInstancedPicking(domEl) {
  if (_instancedPickBound) return;
  _instancedPickBound = true;
  let hovered = null;

  domEl.addEventListener('mousemove', evt => {
    if (!instancedActive()) return;
    const n = pickInstanced3D(evt.clientX, evt.clientY);
    if (n === hovered) { if (n) onHover(evt, n); return; }
    hovered = n;
    n ? onHover(evt, n) : onOut();
    domEl.style.cursor = n ? 'pointer' : '';
  });

  domEl.addEventListener('click', evt => {
    if (!instancedActive() || state._3dGestureDragged) return;
    const n = pickInstanced3D(evt.clientX, evt.clientY);
    if (!n) { _isMobile() ? minimizeDetailPanel() : closeDetailPanel(); return; }
    if (n.type === 'INDI' && _tryPickRelationPerson(n.id)) return;
    if (n.type === 'INDI') showIndiDetail(n.id); else showFamDetail(n.id);
    _setOrbitTarget3D(n.type === 'INDI' ? n.id : null);
  });

  domEl.addEventListener('contextmenu', evt => {
    if (!instancedActive()) return;
    const n = pickInstanced3D(evt.clientX, evt.clientY);
    if (n) { evt.preventDefault(); openNodeContextMenu(evt, n.id, n.type); }
  });
}

export function refresh3D() {
  if (!state.graph3d) return;
  // Instanced: colour and highlight are per-instance values in a buffer, not
  // per-object materials, so rewriting the buffers is the whole job. None of the
  // material walking below has anything to walk — the objects it looks for were
  // never built.
  if (instancedActive()) { updateInstanced3D(true); return; }

  const hasHL = state.hlSet.size > 0;
  const gd = state.graph3d.graphData();

  // ── Update accessors for future mesh creation ──
  state.graph3d.nodeColor(n => compute3DNodeColor(n));
  state.graph3d.linkColor(l => _compute3DLinkColor(l, hasHL));

  // ── Directly update node Three.js materials (color + opacity) ──
  for (const n of gd.nodes) {
    const obj = n.__threeObj;
    if (!obj) continue;
    const color = new THREE.Color(compute3DNodeColor(n));
    const inHL = !hasHL || state.hlSet.has(n.id);
    obj.renderOrder = 2;
    obj.traverse(child => {
      if (child.isMesh && child.material) {
        child.renderOrder = 2;
        if (child.material.color) child.material.color.copy(color);
        if (hasHL) {
          child.material.opacity = inHL ? 1.0 : 0.06;
          child.material.transparent = true;
          // Transparent meshes must not write depth, or whichever one
          // happens to draw first this frame permanently occludes the
          // others behind it — the "z-sorting" flicker when orbiting.
          child.material.depthWrite = false;
        } else {
          child.material.opacity = 1.0;
          child.material.transparent = false;
          child.material.depthWrite = true;
        }
      }
      // Dim/show sprite labels (name tags)
      if (child.isSprite && child.material) {
        if (hasHL) {
          child.material.opacity = inHL ? 1.0 : 0.05;
          child.material.transparent = true;
        } else {
          child.material.opacity = 1.0;
          child.material.transparent = false;
        }
      }
    });
  }

  // ── Directly update link Three.js materials (color + opacity) ──
  // When linkWidth > 0, ForceGraph3D creates a cylinder Mesh per link stored as __lineObj
  let linksUpdated = false;
  for (const l of gd.links) {
    const obj = l.__lineObj;
    if (!obj) continue;
    linksUpdated = true;
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    const inHL = !hasHL || (state.hlSet.has(sid) && state.hlSet.has(tid));
    const lColor = new THREE.Color(_compute3DLinkColor(l, hasHL));
    obj.renderOrder = 1;
    obj.traverse(child => {
      child.renderOrder = 1;
      if (child.material) {
        if (child.material.color) child.material.color.copy(lColor);
        if (hasHL) {
          child.material.opacity = inHL ? 0.8 : 0.03;
          child.material.transparent = true;
          child.material.depthWrite = false;
        } else {
          child.material.opacity = state._3dAppearance.linkOpacity;
          child.material.transparent = state._3dAppearance.linkOpacity < 1;
          child.material.depthWrite = state._3dAppearance.linkOpacity >= 1;
        }
      }
    });
  }

  // Fallback: if links don't have individual __lineObj (e.g. thin lines / LineSegments),
  // update via scene traversal for any LineSegments geometry
  if (!linksUpdated) {
    state.graph3d.linkOpacity(hasHL ? 0.8 : state._3dAppearance.linkOpacity);
    // Re-supply graphData to force link rebuild (nodes keep positions via same refs)
    state.graph3d.graphData({ nodes: [...gd.nodes], links: [...gd.links] });
  }
}

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    const R = Math.min(r, w / 2, h / 2);
    this.moveTo(x + R, y);
    this.lineTo(x + w - R, y);
    this.arcTo(x + w, y, x + w, y + R, R);
    this.lineTo(x + w, y + h - R);
    this.arcTo(x + w, y + h, x + w - R, y + h, R);
    this.lineTo(x + R, y + h);
    this.arcTo(x, y + h, x, y + h - R, R);
    this.lineTo(x, y + R);
    this.arcTo(x, y, x + R, y, R);
    this.closePath();
    return this;
  };
}

export function makeTextSprite3D(drawFn, logicalW, logicalH) {
  // 4× is for a desktop GPU. Each sprite is its own canvas texture, so on a
  // phone that is 16× the memory per label for detail no phone screen resolves —
  // and running out of texture memory drops the whole scene, not just the text.
  const DPR = _isMobile() ? 2 : 4;
  const canvas = document.createElement('canvas');
  canvas.width  = logicalW * DPR;
  canvas.height = logicalH * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  drawFn(ctx, logicalW, logicalH);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: true });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 3;
  return sprite;
}

export function makeYearSprite(yr) {
  const LW = 88, LH = 28;
  const sprite = makeTextSprite3D((ctx, w, h) => {
    // Dark pill background
    ctx.fillStyle = 'rgba(20, 20, 20, 0.88)';
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, 5);
    ctx.fill();
    // Bright border
    ctx.strokeStyle = 'rgba(220, 220, 220, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Year text
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#e0e0e0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(yr), w / 2, h / 2);
  }, LW, LH);
  sprite.scale.set(LW * 0.22, LH * 0.22, 1); // ~19 × 6 world units
  return sprite;
}

export function build3DTimeline() {
  if (!state.graph3d) return;
  // Remove any existing timeline
  if (state._timeline3DObj) {
    state.graph3d.scene().remove(state._timeline3DObj);
    state._timeline3DObj = null;
  }
  if (state.stratify3D === 'off' || !state.showTimeline3D) return;
  const byGen = state.stratify3D === 'generation';
  if (byGen ? !state._genRange3D : !state._birthYearRange) return;

  // One axis, two scales. The ticks come from whichever range is in play and
  // the ends from the same mapping the nodes were pinned with, so the rings sit
  // exactly at node level rather than approximately.
  const { min: minTick, max: maxTick } = byGen ? state._genRange3D : state._birthYearRange;
  const toY = byGen ? genTo3DY : yearTo3DY;
  const span = Math.max(maxTick - minTick, 1);
  const topY = toY(minTick); // earliest → positive Y
  const botY = toY(maxTick); // latest   → negative Y
  const totalH = topY - botY;    // = 2 * _3dYHalfSpan

  const group = new THREE.Group();

  // ── Vertical spine ──
  const spineGeo = new THREE.CylinderGeometry(0.6, 0.6, totalH, 8);
  const spineMat = new THREE.MeshBasicMaterial({ color: 0x4466bb, transparent: true, opacity: 0.75, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  const spine = new THREE.Mesh(spineGeo, spineMat);
  spine.renderOrder = 0;
  spine.position.set(0, (topY + botY) / 2, 0);
  group.add(spine);

  // ── Ticks + labels ──
  // Every generation gets a ring; years get a round step so the axis is not a
  // wall of labels.
  const step = byGen ? 1 : span > 200 ? 50 : span > 80 ? 25 : 10;
  const startYr = byGen ? minTick : Math.ceil(minTick / step) * step;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x5588cc, transparent: true, opacity: 0.70, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });

  for (let yr = startYr; yr <= maxTick; yr += step) {
    const y = toY(yr); // exact same function → rings sit at node level

    // Horizontal ring (torus lying flat)
    const ringGeo = new THREE.TorusGeometry(14, 0.5, 8, 40);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.renderOrder = 0;
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, y, 0);
    group.add(ring);

    // Label sprite — placed just outside the ring.
    // Generations are numbered from the bottom up: the youngest people on the
    // chart are generation 0 and the count rises going back in time, so the
    // number reads as "how many generations back from the present" and does not
    // shift when an older branch is added above. Depth runs the other way —
    // it counts ancestors above a person — hence the subtraction.
    const sprite = makeYearSprite(byGen ? t('sidebar.genLabel', { n: maxTick - yr }) : yr);
    sprite.position.set(22, y, 0);
    group.add(sprite);
  }

  state._timeline3DObj = group;
  state.graph3d.scene().add(group);
}

export function makeNameSprite3D(n) {
  if (n.type !== 'INDI') return null;
  const indi = n.data;
  const name = indi.displayName || indi.name || n.id;
  const maidenLine = indi.maidenName ? t('tooltip.born', { name: indi.maidenName }) : '';
  let born = '';
  if (indi.birthYear) {
    born = `*${indi.birthYear}`;
  } else if (state._estimatedYears && state._estimatedYears.has(n.id)) {
    born = `~${state._estimatedYears.get(n.id)}`;
  }
  const died = indi.deceased
    ? '†' + (indi.death.date?.match(/\d{4}/)?.[0] ?? '')
    : '';
  const yearLine = [born, died].filter(Boolean).join('  ');
  const textColor = _nameTextColor(n);

  const FONT_NAME   = state._3dFontSize;
  const FONT_MAIDEN = Math.round(state._3dFontSize * 0.72);
  const FONT_YEAR   = Math.round(state._3dFontSize * 0.72);
  const PAD_X = 8, PAD_Y = 4, LINE_GAP = 2;

  // Measure all lines to pick canvas width
  const tmpCtx = document.createElement('canvas').getContext('2d');
  tmpCtx.font = `bold ${FONT_NAME}px Arial`;
  const nameW = tmpCtx.measureText(name).width;
  tmpCtx.font = `italic ${FONT_MAIDEN}px Arial`;
  const maidenW = maidenLine ? tmpCtx.measureText(maidenLine).width : 0;
  tmpCtx.font = `${FONT_YEAR}px Arial`;
  const yearW = yearLine ? tmpCtx.measureText(yearLine).width : 0;

  const LW = Math.ceil(Math.max(nameW, maidenW, yearW)) + PAD_X * 2;
  const LH = FONT_NAME
    + (maidenLine ? FONT_MAIDEN + LINE_GAP : 0)
    + (yearLine   ? FONT_YEAR   + LINE_GAP : 0)
    + PAD_Y * 2;

  const sprite = makeTextSprite3D((ctx, w, h) => {
    ctx.fillStyle = 'rgba(6, 12, 36, 0.84)';
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, 4);
    ctx.fill();
    ctx.strokeStyle = textColor + '55';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let y = PAD_Y;
    // Name line
    ctx.font = `bold ${FONT_NAME}px Arial`;
    ctx.fillStyle = textColor;
    ctx.fillText(name, w / 2, y);
    y += FONT_NAME + LINE_GAP;
    // Maiden name line
    if (maidenLine) {
      ctx.font = `italic ${FONT_MAIDEN}px Arial`;
      ctx.fillStyle = textColor + 'cc';
      ctx.fillText(maidenLine, w / 2, y);
      y += FONT_MAIDEN + LINE_GAP;
    }
    // Year line
    if (yearLine) {
      ctx.font = `${FONT_YEAR}px Arial`;
      ctx.fillStyle = textColor + 'aa';
      ctx.fillText(yearLine, w / 2, y);
    }
  }, LW, LH);

  const scaleX = LW * 0.45;
  const scaleY = LH * 0.45;
  sprite.scale.set(scaleX, scaleY, 1);

  // Wrap in a Group so the label floats above the sphere
  const group = new THREE.Group();
  sprite.position.set(0, scaleY * 0.5 + 4, 0);
  group.add(sprite);
  return group;
}

export function update3DNames() {
  if (!state.graph3d) return;
  // With the instanced renderer every name lives in one texture atlas and is
  // drawn by one instanced quad layer, so there is no per-label cost to ration
  // and no threshold to apply — rebuilding the layers repacks the atlas.
  if (state.instanced3d) {
    // Must stay the empty object, not null: null puts the library's *default*
    // sphere back, which is exactly the per-node mesh this renderer exists to
    // avoid — 12,000 of them reappeared behind the instanced layer, invisible
    // in the picture and fully paid for in the frame.
    state.graph3d.nodeThreeObject(() => new THREE.Object3D()).nodeThreeObjectExtend(false);
    buildInstanced3D();
    return;
  }
  // Sprite path: each label is its own canvas and its own GPU texture. A few
  // hundred is a readable scene; a few thousand is texture memory the scene does
  // not get back, and at that density they overlap into an unreadable mat
  // anyway. The toggle still decides whether labels are wanted at all — this
  // only decides whether the scene can afford them.
  const affordable = (state._g3dById?.size ?? 0) <= state.scene3d.detailMax;
  if (state.show3DNames && affordable) {
    state.graph3d
      .nodeThreeObject(n => makeNameSprite3D(n) || undefined)
      .nodeThreeObjectExtend(true);   // label sits on top of the sphere
  } else {
    state.graph3d
      .nodeThreeObject(null)
      .nodeThreeObjectExtend(false);
  }
}

export function export3DTopDown() {
  if (!state.graph3d) return;

  const btn = document.querySelector('button[onclick="export3DTopDown()"]');
  if (btn) { btn.textContent = '⏳ ' + t('appearance.rendering'); btn.disabled = true; }

  const origHalfSpan = state._3dYHalfSpan;

  // Flatten all nodes to Y=0, let XZ forces settle
  state._3dYHalfSpan = 0;
  applyTimelineYFix();
  state.graph3d.d3ReheatSimulation();

  setTimeout(() => {
    const gd = state.graph3d.graphData();

    // Map id → XZ position (top-down projection: x stays x, 3D-z becomes canvas-y)
    const posMap = new Map();
    for (const n of gd.nodes) posMap.set(n.id, { x: n.x || 0, y: n.z || 0, n });

    // World-space bounds
    let wx0 = Infinity, wx1 = -Infinity, wy0 = Infinity, wy1 = -Infinity;
    for (const [, p] of posMap) {
      wx0 = Math.min(wx0, p.x); wx1 = Math.max(wx1, p.x);
      wy0 = Math.min(wy0, p.y); wy1 = Math.max(wy1, p.y);
    }

    // Scale world coords → canvas pixels so the long side hits TARGET_LONG
    const TARGET_LONG = 8192;
    const worldW = wx1 - wx0 || 1;
    const worldH = wy1 - wy0 || 1;
    const scale  = TARGET_LONG / Math.max(worldW, worldH);

    const MARGIN  = 120;
    const CW = Math.round(worldW * scale) + MARGIN * 2;
    const CH = Math.round(worldH * scale) + MARGIN * 2;
    const toX = p => (p.x - wx0) * scale + MARGIN;
    const toY = p => (p.y - wy0) * scale + MARGIN;

    // Font sizes scale with world→canvas ratio
    const FONT_NAME   = Math.round(state._3dFontSize * scale * 0.45);   // matches sprite scale
    const FONT_MAIDEN = Math.round(FONT_NAME * 0.72);
    const FONT_YEAR   = Math.round(FONT_NAME * 0.72);
    const LINE_GAP    = Math.round(FONT_NAME * 0.1);
    const PAD_X = Math.round(FONT_NAME * 0.6);
    const PAD_Y = Math.round(FONT_NAME * 0.3);
    const FAM_R  = Math.max(4, Math.round(scale * 1.5));

    const canvas = document.createElement('canvas');
    canvas.width  = CW;
    canvas.height = CH;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = state._3dAppearance.bgColor || '#000000';
    ctx.fillRect(0, 0, CW, CH);

    // Draw links
    ctx.lineWidth = Math.max(1, scale * 0.4);
    for (const lk of gd.links) {
      const srcId = typeof lk.source === 'object' ? lk.source.id : (lk._src || lk.source);
      const tgtId = typeof lk.target === 'object' ? lk.target.id : (lk._tgt || lk.target);
      const s = posMap.get(srcId);
      const t = posMap.get(tgtId);
      if (!s || !t) continue;
      const col = lk.ltype === 'spouse' ? state.linkColors.spouse
                : lk.ltype === 'father' ? state.linkColors.father
                : lk.ltype === 'mother' ? state.linkColors.mother
                : state.linkColors.parent;
      ctx.strokeStyle = col + 'aa';
      ctx.beginPath();
      ctx.moveTo(toX(s), toY(s));
      ctx.lineTo(toX(t), toY(t));
      ctx.stroke();
    }

    // Draw FAM diamonds
    for (const [, p] of posMap) {
      if (p.n.type !== 'FAM') continue;
      const cx = toX(p), cy = toY(p);
      const col = p.n.data?.div ? state.nodeColors.famDiv : state.nodeColors.fam;
      ctx.fillStyle = col + 'cc';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx,         cy - FAM_R);
      ctx.lineTo(cx + FAM_R, cy);
      ctx.lineTo(cx,         cy + FAM_R);
      ctx.lineTo(cx - FAM_R, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Draw INDI label boxes
    const tmpCtx = document.createElement('canvas').getContext('2d');
    for (const [, p] of posMap) {
      if (p.n.type !== 'INDI') continue;
      const indi = p.n.data;
      const name = indi.displayName || indi.name || p.n.id;
      const maidenLine = indi.maidenName ? t('tooltip.born', { name: indi.maidenName }) : '';
      let born = indi.birthYear ? `*${indi.birthYear}` : '';
      if (!born && state._estimatedYears?.has(p.n.id)) born = `~${state._estimatedYears.get(p.n.id)}`;
      const died = indi.deceased ? '†' + (indi.death.date?.match(/\d{4}/)?.[0] ?? '') : '';
      const yearLine = [born, died].filter(Boolean).join('  ');

      tmpCtx.font = `bold ${FONT_NAME}px Arial`;
      const nameW = tmpCtx.measureText(name).width;
      tmpCtx.font = `italic ${FONT_MAIDEN}px Arial`;
      const maidenW = maidenLine ? tmpCtx.measureText(maidenLine).width : 0;
      tmpCtx.font = `${FONT_YEAR}px Arial`;
      const yearW = yearLine ? tmpCtx.measureText(yearLine).width : 0;

      const boxW = Math.ceil(Math.max(nameW, maidenW, yearW)) + PAD_X * 2;
      const boxH = FONT_NAME
        + (maidenLine ? FONT_MAIDEN + LINE_GAP : 0)
        + (yearLine   ? FONT_YEAR   + LINE_GAP : 0)
        + PAD_Y * 2;
      const cx = toX(p), cy = toY(p);
      const bx = cx - boxW / 2, by = cy - boxH / 2;

      const textColor = _nameTextColor(p.n);

      ctx.fillStyle = 'rgba(6,12,36,0.92)';
      ctx.strokeStyle = textColor + '66';
      ctx.lineWidth = Math.max(1, scale * 0.15);
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, Math.round(FONT_NAME * 0.3));
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      let ty = by + PAD_Y;
      ctx.font = `bold ${FONT_NAME}px Arial`;
      ctx.fillStyle = textColor;
      ctx.fillText(name, cx, ty);
      ty += FONT_NAME + LINE_GAP;

      if (maidenLine) {
        ctx.font = `italic ${FONT_MAIDEN}px Arial`;
        ctx.fillStyle = textColor + 'cc';
        ctx.fillText(maidenLine, cx, ty);
        ty += FONT_MAIDEN + LINE_GAP;
      }

      if (yearLine) {
        ctx.font = `${FONT_YEAR}px Arial`;
        ctx.fillStyle = textColor + 'bb';
        ctx.fillText(yearLine, cx, ty);
      }
    }

    // Restore
    state._3dYHalfSpan = origHalfSpan;
    applyTimelineYFix();
    state.graph3d.d3ReheatSimulation();

    if (btn) { btn.textContent = '📥 ' + t('appearance.exportTopDown'); btn.disabled = false; }

    const a = document.createElement('a');
    a.download = t('appearance.exportFileName') + '.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }, 2500);
}

window.addEventListener('resize', () => { if (state.currentView === '3d') resize3D(); });
// Rotating a phone fires resize while the browser still reports the old
// dimensions, which leaves the canvas the wrong shape until something else
// happens to resize it. Measure again once the new layout has settled.
window.addEventListener('orientationchange', () => {
  if (state.currentView !== '3d') return;
  setTimeout(resize3D, 300);
});

export function _graphCentroid3D() {
  if (!state.graph3d) return new THREE.Vector3(0, 0, 0);
  const nodes = state.graph3d.graphData().nodes;
  if (!nodes.length) return new THREE.Vector3(0, 0, 0);
  let sx = 0, sy = 0, sz = 0;
  for (const n of nodes) { sx += n.x || 0; sy += n.y || 0; sz += n.z || 0; }
  return new THREE.Vector3(sx / nodes.length, sy / nodes.length, sz / nodes.length);
}

export function _setOrbitTarget3D(nodeId) {
  if (!state._orbitControls3d) return;
  state._orbitTrackNodeId = nodeId || null;
  const ctrl = state._orbitControls3d;
  const from = ctrl.target.clone();
  let to;
  if (nodeId && state.graph3d) {
    // Not necessarily in the scene: the budget may have left this person out.
    const n = state._g3dById?.get(nodeId);
    if (n) to = new THREE.Vector3(n.x || 0, n.y || 0, n.z || 0);
  }
  if (!to) to = _graphCentroid3D();
  if (from.distanceTo(to) < 0.5) return; // already there
  state._orbitTargetAnim = { from, to, start: performance.now(), duration: 600 };
}

export function _tickOrbitTarget() {
  if (!state._orbitControls3d || !state.graph3d) return;
  // Smooth transition animation
  if (state._orbitTargetAnim) {
    const { from, to, start, duration } = state._orbitTargetAnim;
    const t = Math.min((performance.now() - start) / duration, 1);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    state._orbitControls3d.target.lerpVectors(from, to, ease);
    state._orbitControls3d.update();
    if (t >= 1) state._orbitTargetAnim = null;
    return;
  }
  // Continuous tracking: follow the tracked node as it moves in the simulation.
  // This runs on every rendered frame, so the lookup has to be a lookup — a
  // linear scan here was the camera walking the whole scene sixty times a second.
  if (state._orbitTrackNodeId) {
    const n = state._g3dById?.get(state._orbitTrackNodeId);
    if (n) {
      const pos = new THREE.Vector3(n.x || 0, n.y || 0, n.z || 0);
      state._orbitControls3d.target.lerp(pos, 0.08);
      state._orbitControls3d.update();
    }
  }
}

export function _depthAlongRay3D(origin, dir) {
  if (!state.graph3d) return null;
  let best = null, bestPerp = Infinity;
  const v = new THREE.Vector3();
  for (const n of state.graph3d.graphData().nodes) {
    v.set(n.x || 0, n.y || 0, n.z || 0).sub(origin);
    const t = v.dot(dir);
    if (t <= 0) continue;
    const perp = v.addScaledVector(dir, -t).length();
    if (perp < bestPerp) { bestPerp = perp; best = t; }
  }
  return best;
}

export function _snapOrbitPivot3D() {
  if (!state.graph3d || !state._orbitControls3d || state._orbitTrackNodeId || state._orbitTargetAnim) return;
  const cam = state.graph3d.camera();
  const ctrl = state._orbitControls3d;
  const dir = ctrl.target.clone().sub(cam.position).normalize();
  const d = _depthAlongRay3D(cam.position, dir);
  if (d) ctrl.target.copy(cam.position).addScaledVector(dir, d);
}

export function _onWheel3D(evt) {
  evt.preventDefault();
  if (!state.graph3d || !state._orbitControls3d) return;
  state._orbitTargetAnim = null;
  state._orbitTrackNodeId = null;

  const cam  = state.graph3d.camera();
  const ctrl = state._orbitControls3d;
  const el   = state.graph3d.renderer().domElement;
  const rect = el.getBoundingClientRect();

  // Normalise delta across mouse wheels (deltaMode 0=px,1=line,2=page) and trackpads
  let delta = evt.deltaY;
  if (evt.deltaMode === 1) delta *= 33;
  if (evt.deltaMode === 2) delta *= 800;

  // Cursor ray into the scene
  const nx  = ((evt.clientX - rect.left) / rect.width)  *  2 - 1;
  const ny  = -((evt.clientY - rect.top)  / rect.height) *  2 + 1;
  const ray = new THREE.Vector3(nx, ny, 0.5).unproject(cam).sub(cam.position).normalize();

  // Exponential factor: consistent feel at any distance, no hard cutoff
  const factor  = Math.pow(1.0015, delta);   // >1 = zoom out, <1 = zoom in
  // Focus depth: actual tree geometry under the cursor, not the (drift-prone) cam↔target distance
  const dist    = _depthAlongRay3D(cam.position, ray) || cam.position.distanceTo(ctrl.target);
  const newDist = Math.max(1, dist * factor);

  // Zoom-to-cursor: find scene point under cursor at cam-target depth,
  // move camera toward it, shift target by the same delta (orbit geometry preserved).
  const focusPoint = cam.position.clone().addScaledVector(ray, dist);
  const newCamPos  = focusPoint.clone().addScaledVector(ray, -newDist);
  const shift      = newCamPos.clone().sub(cam.position);
  cam.position.copy(newCamPos);
  ctrl.target.add(shift);   // same shift — keeps cam↔target vector intact
  _snapOrbitPivot3D();      // re-depth pivot onto the tree so later rotation feels anchored
  ctrl.update();
}
