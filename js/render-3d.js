import { state } from './state.js';
import { _compute3DLinkColor, _nameTextColor, compute3DNodeColor } from './colors.js';
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

export function _push3DData() {
  if (!state.graph3d) return;
  state.graph3d.graphData({
    nodes: state.nodes.map(n => ({ id: n.id, type: n.type, data: n.data })),
    links: state.links.map(l => ({
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
      ltype:  l.ltype,
    })),
  });
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

  // Physics and node dragging act on a force simulation. The classical chart
  // computes its positions outright and has none, so in that mode both were
  // controls that visibly did nothing — a whole panel of them.
  const simLive = in3d || !state.treeLayout;
  for (const id of ['physics-panel', 'node-drag-btn']) {
    const el = document.getElementById(id);
    if (el) el.style.display = simLive ? 'block' : 'none';
  }

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
  state.graph3d?.zoomToFit(ms, _isMobile() ? 20 : 60);
}

export function resize3D() {
  if (!state.graph3d) return;
  const el = document.getElementById('graph-3d-container');
  state.graph3d.width(el.clientWidth).height(el.clientHeight);
}

export function initGraph3D() {
  const container = document.getElementById('graph-3d-container');
  container.innerHTML = '';

  // Build 3D node and link arrays (keep data references intact)
  const gNodes = state.nodes.map(n => ({
    id:   n.id,
    type: n.type,
    data: n.data,
  }));
  const gLinks = state.links.map(l => ({
    source: typeof l.source === 'object' ? l.source.id : l.source,
    target: typeof l.target === 'object' ? l.target.id : l.target,
    ltype:  l.ltype,
  }));

  // Track mouse/touch for tooltip positioning
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

  state.graph3d = ForceGraph3D()(container)
    .backgroundColor(state._3dAppearance.bgColor)
    .width(container.clientWidth)
    .height(container.clientHeight)
    .graphData({ nodes: gNodes, links: gLinks })
    // ── Nodes ──
    .nodeColor(n => compute3DNodeColor(n))
    .nodeVal(n => _famNodeVal(n))
    .nodeRelSize(state._3dAppearance.nodeRelSize)
    .nodeOpacity(state._3dAppearance.nodeOpacity)
    // Spheres are small on a phone screen; the facets do not show, the triangles
    // still cost.
    .nodeResolution(_isMobile() ? 8 : 12)
    // No .nodeLabel() here: the library's own hover tooltip would show
    // alongside the custom #tooltip div that onNodeHover()/onHover() already
    // drive (shared with the 2D view) — showing both at once is the "two
    // tooltips" bug. That one is the richer, kept one.
    // ── Links ──
    .linkColor(l => linkColor(l))
    .linkWidth(state._3dAppearance.linkWidth)
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
    .enableNodeDrag(state._nodeDragEnabled);

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
    old.update = () => { _tickOrbitTarget(); state._orbitControls3d.update(); };

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

  // Only modify forces the library already created — don't inject foreign d3-force objects
  const lf = state.graph3d.d3Force('link');
  if (lf) lf
    .distance(l => l.ltype === 'spouse' ? p.spouseDist    : p.parentDist)
    .strength(l => l.ltype === 'spouse' ? p.spouseStrength : p.parentStrength);

  const cf = state.graph3d.d3Force('charge');
  if (cf) cf
    .strength(n => n.type === 'FAM' ? -p.chargeFam : -p.chargeIndi)
    .distanceMax(p.chargeDistMax);

  state.graph3d.d3AlphaDecay(0.028);
  state.graph3d.d3VelocityDecay(p.velocityDecay);

  // Pin nodes to exact Y positions based on (estimated) birth year.
  // Using node.fy is exact — unlike forceY which fights link/charge forces.
  // Remove any leftover soft forceY from previous sessions.
  if (repin) {
    state.graph3d.d3Force('fy3d', null);
    applyTimelineYFix();
  }

  if (reheat) state.graph3d.d3ReheatSimulation();
}

export function refresh3D() {
  if (!state.graph3d) return;
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
  if (state.show3DNames) {
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
    const gd = state.graph3d.graphData();
    const n = gd.nodes.find(nd => nd.id === nodeId);
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
  // Continuous tracking: follow the tracked node as it moves in the simulation
  if (state._orbitTrackNodeId) {
    const gd = state.graph3d.graphData();
    const n = gd.nodes.find(nd => nd.id === state._orbitTrackNodeId);
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
