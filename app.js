'use strict';

// ═══════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════
let individuals = new Map();   // id -> indi object
let families    = new Map();   // id -> fam object
let otherLines  = [];          // raw lines from unrecognized level-0 GEDCOM records (SOUR, OBJE, …), re-emitted verbatim on save
let allNodes = [];   // complete dataset (all INDI + FAM nodes)
let allLinks = [];   // complete dataset (links with _src/_tgt string IDs, never mutated by D3)

let nodes = [];      // currently active (filtered) nodes passed to simulation
let links = [];      // currently active (filtered) links passed to simulation
let _firstLoad = true;  // controls auto-fit + auto-open on first load only

// id -> graph node object, reused across buildGraphData() calls so an edit that
// doesn't touch a person leaves their {x,y,vx,vy,fx,fy} simulation state intact
// instead of every node restarting from scratch on every save.
let _nodeObjCache = new Map();

let simulation  = null;
let svgSel      = null;   // d3 selection of <svg>
let gMain       = null;   // d3 selection of main <g>
let zoomBehavior = null;  // d3.zoom() instance

let linkSel     = null;
let nodeSel     = null;
let labelSel    = null;
let yearSel     = null;   // the birth–death line under each name

let currentZoom  = 1;
let selectedIndiId = null;    // currently shown in detail panel
let hlMode = null;            // null | 'ancestors' | 'descendants' | 'both'
let hlSet  = new Set();       // highlighted node ids
let _hlAncestorCount   = 0;  // individual ancestors (excl. self)
let _hlDescendantCount = 0;  // individual descendants (excl. self)

let surnameColors  = new Map();   // surname -> color string
let surnameEnabled = new Map();   // surname -> bool
let surnameCustomColors = new Map(); // surname -> user-picked color (persisted)
let colorBySurname = true;        // global toggle for surname coloring
let _surnameColorCache = new Map(); // memoized hash colors

// Load persisted settings
const _lsSurnameColors = localStorage.getItem('surnameCustomColors');
if (_lsSurnameColors) {
  try {
    const parsed = JSON.parse(_lsSurnameColors);
    surnameCustomColors = new Map(Object.entries(parsed));
  } catch (e) { /* ignore */ }
}
colorBySurname = localStorage.getItem('colorBySurname') !== 'false'; // default true

// Label styling state - defaults for fully opaque surname-colored labels
let labelStyle = {
  textColor: '#cccccc',
  textOpacity: 1.0,  // Fully opaque
  fontSize: 13,      // screen px — updateLabels divides by the zoom to keep it constant
  fontWeight: 'normal',
  bgEnabled: false,
  bgColor: '#0a0a0a',
  bgOpacity: 0.7
};

// === Surname Color Functions ===
// Golden angle (≈137.508°) gives maximum perceptual separation for any N colors
const GOLDEN_ANGLE = 137.508;

function surnameHashColor(surname) {
  // Fallback for surnames not in the pre-assigned cache
  if (!surname) return '#888888';
  let hash = 0;
  const s = surname.toLowerCase().trim();
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash = hash & hash;
  }
  const h = Math.abs(hash) % 360;
  return hslToHex(h, 50, 52);
}

function hslToHex(h, s, l) {
  l /= 100;
  const a = s * Math.min(l, 1 - l) / 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function surnameColor(surname) {
  if (!surname) return '#888888';
  // Check for user override
  if (surnameCustomColors.has(surname)) {
    return surnameCustomColors.get(surname);
  }
  // Use cached hash color
  if (!_surnameColorCache.has(surname)) {
    _surnameColorCache.set(surname, surnameHashColor(surname));
  }
  return _surnameColorCache.get(surname);
}

function setSurnameColor(surname, color) {
  if (color === null || color === undefined) {
    surnameCustomColors.delete(surname);
  } else {
    surnameCustomColors.set(surname, color);
  }
  // Persist
  debouncedLsWrite('surnameCustomColors', JSON.stringify(Object.fromEntries(surnameCustomColors)));
}

// Debounced localStorage writer
let _lsWriteTimeouts = {};
function debouncedLsWrite(key, value, delay = 200) {
  clearTimeout(_lsWriteTimeouts[key]);
  _lsWriteTimeouts[key] = setTimeout(() => {
    localStorage.setItem(key, value);
  }, delay);
}

const PALETTE = [
  '#4e79a7','#e15759','#59a14f','#76b7b2','#edc948',
  '#b07aa1','#ff9da7','#f28e2b','#9c755f','#bab0ac',
  '#d37295','#a0cbe8','#fabfd2','#8cd17d','#b6992d'
];

// ── Dirty-state tracking ─────────────────────────────────────
let _gedcomDirty = false;
function _setDirty(v) {
  _gedcomDirty = v;
  const btn = document.getElementById('dl-btn');
  if (btn) btn.classList.toggle('has-unsaved', v);
  if (v) _autosave(); else localStorage.removeItem('gedcomAutosave');
}
window.addEventListener('beforeunload', e => {
  if (_gedcomDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ── Autosave (crash/close protection; not a substitute for downloading) ──────
let _autosaveTimer = null;
function _autosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem('gedcomAutosave', JSON.stringify({
        filename: window._gedcomFilename || '',
        ts: Date.now(),
        ged: serializeGEDCOM()
      }));
    } catch (e) { /* quota exceeded — silently skip autosave */ }
  }, 2000);
}
function _tryRestoreAutosave() {
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

// ═══════════════════════════════════════════════════════════════
// PHYSICS PARAMETERS  (single source of truth)
// ═══════════════════════════════════════════════════════════════
const PHYSICS_DEFAULTS = {
  spouseDist:     31,
  parentDist:     53,
  spouseStrength: 1.00,
  parentStrength: 0.78,
  chargeIndi:     600,
  chargeFam:      200,
  chargeDistMax:  1000,
  collideRadius:  50,
  yStrength:      0.00,
  centerStrength: 0.000,
  velocityDecay:  0.20,
  alphaDecay:     0.005,
};

let physicsParams = { ...PHYSICS_DEFAULTS };

// 3D state
let graph3d        = null;
let currentView    = localStorage.getItem('viewMode') === '2d' ? '2d' : '3d';   // '2d' | '3d'

// 2D focus: the 2D view is laid out around one target person and only keeps
// the `focusLimit` people closest to them in the relationship graph.
let focusRootId = null;
let focusLimit  = parseInt(localStorage.getItem('focusLimit')) || 120;
// How far out the chart follows collateral branches, as a cousin degree: 1 is
// first cousins, 2 second cousins, 0 no cousins at all. Anything past first
// cousins is a lot of people who are barely related, so it is off by default
// and opted into. Parsed explicitly rather than with `||` — 0 is a real choice
// here and `|| 1` would silently turn it back on.
let cousinDegree = parseInt(localStorage.getItem('cousinDegree'));
if (!Number.isFinite(cousinDegree)) cousinDegree = 1;
// Classical ancestry chart (layered rows) instead of the force layout.
let treeLayout  = localStorage.getItem('treeLayout') !== '0';
let _lineageGen = null;   // id -> chart row, filled by computeLineageSet()
let _treeBusY   = null;   // FAM id (and "parent~child") -> y of the sibling bar
let _treeOmitted = null;  // [{x, y, n, anchor:{x,y}}] — "+N" cut-branch markers
// People pulled back in by clicking a "+N" chip. They survive re-focusing on
// the same person, and are dropped when the subject changes — the expansions
// were about *that* chart.
let _revealed = new Set();
let _birthYearRange = null;  // { min, max } saved for 3D stratification
let _3dMousePos    = { x: 0, y: 0 };

// Display mode flags
let showFamNodes   = true;   // show FAM diamond nodes (vs direct parent-child links)
let sortByTime3D   = true;   // Y-stratify 3D sim by birth year
let showTimeline3D = true;   // show the visual timeline axis (spine + rings)
let show3DNames    = true;   // render name+year labels above nodes in 3D
let _nodeDragEnabled = false; // node dragging disabled by default
let _timeline3DObj    = null;   // THREE.Group holding timeline meshes in the 3D scene
let _3dYHalfSpan      = 750;   // half-range of Y axis in 3D sim units (older→+half, newer→-half)
let _3dFontSize       = 18;    // name label font size in 3D view
let _orbitControls3d  = null;  // OrbitControls instance (replaces TrackballControls)
let _orbitTargetAnim  = null;  // { from, to, start, duration } for smooth orbit target transition
let _orbitTrackNodeId = null;  // node id whose live position the orbit target tracks

// 3D appearance
let _3dAppearance = {
  bgColor:     '#000000',
  nodeOpacity: 1.0,   // 1.00 from screenshot
  linkOpacity: 1.0,   // 1.00 from screenshot
  ambientLight: 0.6,  // 0.6 from screenshot
  pointLight:  0.5,   // 0.5 from screenshot
  linkWidth:   3.1,   // 3.1 from screenshot
  nodeRelSize: 5.5,   // 5.5 from screenshot
};
let _3dAmbientLight = null;
let _3dPointLight   = null;
let _isNewRecord      = false; // true while editing a freshly created INDI/FAM

// Link colors (user-configurable)
const LINK_COLOR_DEFAULTS = {
  spouse: '#9b59b6',   // partner / Ehepartner
  father: '#5b9bd5',   // father → child
  mother: '#d5729b',   // mother → child
  parent: '#3498db',   // FAM → child (bipartite mode)
};
let linkColors = { ...LINK_COLOR_DEFAULTS };

// Node colors (user-configurable)
const NODE_COLOR_DEFAULTS = {
  male:    '#4a90d9',
  female:  '#e0608a',
  unknown: '#7e8fa8',
  fam:     '#2ecc71',
  famDiv:  '#e74c3c',
};
let nodeColors = { ...NODE_COLOR_DEFAULTS };

let famNodeSize = parseInt(localStorage.getItem('famNodeSize')) || 1;

// In the classical chart the marriage marker is structural, not decoration:
// every marriage line ends on it and every child line starts from it. At the
// force view's default of 1px it is invisible, so all of those connectors look
// like they stop in mid-air. Give the chart a floor; above it the user's own
// setting still applies.
const FAM_MARKER_MIN = 4;
function famMarkerSize() {
  return useTreeLayout() ? Math.max(FAM_MARKER_MIN, famNodeSize) : famNodeSize;
}

// INDI nodes render as filled rounded-rect "chips" with the name inside —
// the compact box style of mobile family-tree apps — rather than a dot with
// a label floating above it. Fixed in graph units, so the boxes scale with
// zoom exactly like the connectors they sit on.
const NODE_BOX_W  = 92;
const NODE_BOX_H  = 30;   // two lines: name, then the years under it
const NODE_BOX_RX = 5;
const NODE_BOX_FONT = 10; // px, in graph units — scales with the box, not the screen
const NODE_YEAR_FONT = 8;

// Dates the way a printed chart writes them under a name: a span when both
// ends are known, otherwise the one that is, marked with which it is. Death
// years are not parsed onto the individual, so read them off the record here.
function nodeYears(indi) {
  const b = indi.birthYear || null;
  const d = indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || null;
  if (b && d) return `${b}–${d}`;
  if (b) return `*${b}`;
  if (d) return `†${d}`;
  return '';
}

// ═══════════════════════════════════════════════════════════════
// MOBILE SIDEBAR TOGGLE
// ═══════════════════════════════════════════════════════════════
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('sidebar-open');
  document.getElementById('sidebar-overlay').classList.toggle('visible');
}

// ═══════════════════════════════════════════════════════════════
// TOUCH SUPPORT
// ═══════════════════════════════════════════════════════════════

// (Touch zoom + pan handled natively by OrbitControls with DOLLY_PAN)

// ── Detail panel bottom-sheet swipe-to-dismiss ──
let _panelSwipe = null;  // { startY, startTranslate }

function _initPanelSwipe() {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;

  panel.addEventListener('touchstart', evt => {
    // Only handle swipe on the drag handle area (top 40px) or if panel is scrolled to top
    const y = evt.touches[0].clientY;
    const rect = panel.getBoundingClientRect();
    const offsetInPanel = y - rect.top;
    const scrolledToTop = panel.scrollTop <= 0;
    if (offsetInPanel > 40 && !scrolledToTop) return;

    _panelSwipe = { startY: y, currentY: y };
    panel.style.transition = 'none';
  }, { passive: true });

  panel.addEventListener('touchmove', evt => {
    if (!_panelSwipe) return;
    _panelSwipe.currentY = evt.touches[0].clientY;
    const dy = Math.max(0, _panelSwipe.currentY - _panelSwipe.startY);  // only downward
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  panel.addEventListener('touchend', () => {
    if (!_panelSwipe) return;
    panel.style.transition = '';
    const dy = _panelSwipe.currentY - _panelSwipe.startY;
    _panelSwipe = null;
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

// ── 2D: prevent node click firing after a touch-drag ──
let _touchDragged = false;
let _touchStartPos = null;

function _initTouchDragGuard() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  svg.addEventListener('touchstart', evt => {
    if (evt.touches.length === 1) {
      _touchDragged = false;
      _touchStartPos = { x: evt.touches[0].clientX, y: evt.touches[0].clientY };
    }
  }, { passive: true });
  svg.addEventListener('touchmove', evt => {
    if (_touchStartPos && evt.touches.length === 1) {
      const dx = evt.touches[0].clientX - _touchStartPos.x;
      const dy = evt.touches[0].clientY - _touchStartPos.y;
      if (Math.hypot(dx, dy) > 8) _touchDragged = true;
    }
  }, { passive: true });
  svg.addEventListener('touchend', () => {
    _touchStartPos = null;
  }, { passive: true });
}

function wasTouchDrag() { return _touchDragged; }

// ═══════════════════════════════════════════════════════════════
// 1. GEDCOM PARSER  (delegates to GEDCOMModule in gedcom.js)
// ═══════════════════════════════════════════════════════════════
function parseGEDCOM(raw) {
  const result = GEDCOMModule.parseGEDCOM(raw);
  individuals.clear();
  families.clear();
  for (const [k, v] of result.individuals) individuals.set(k, v);
  for (const [k, v] of result.families)    families.set(k, v);
  otherLines = result.otherLines || [];
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// Full in-memory rebuild — call after any structural change.
// Pass { warm: true } for a single add/edit/delete: reuses node identity
// (already the default via _nodeObjCache) and the running simulation with a
// gentle reheat instead of a fresh alpha=1 restart, and skips the
// auto-zoomToFit — so one edit doesn't jitter or re-frame the whole tree.
// Omit warm (default false) for dataset-level changes (load/import/replace),
// which legitimately want a fresh layout and an auto-fit.
// ═══════════════════════════════════════════════════════════════
function _fullRebuildGraph(opts = {}) {
  const warm = !!opts.warm;
  if (!warm) _nodeObjCache = new Map(); // dataset-level change: don't reuse positions from a possibly-unrelated previous dataset
  if (focusRootId && !individuals.has(focusRootId)) focusRootId = null;  // focus person was deleted
  _setDirty(true);
  console.time('[rebuild] total');
  console.time('[rebuild] surnameColorMap'); const sorted = buildSurnameColorMap(); console.timeEnd('[rebuild] surnameColorMap');
  console.time('[rebuild] surnameList');     buildSurnameList(sorted);               console.timeEnd('[rebuild] surnameList');
  console.time('[rebuild] buildGraphData');  buildGraphData();                        console.timeEnd('[rebuild] buildGraphData');
  if (!svgSel) initSVG();
  console.time('[rebuild] renderGraph');     renderGraph();                           console.timeEnd('[rebuild] renderGraph');
  document.getElementById('status').textContent =
    t('topbar.status', { persons: individuals.size, personsPlural: individuals.size !== 1 ? 'en' : '', families: families.size });
  _genDepthsCache = null;  // invalidate depth cache before rebuild
  _estimatedYears = null;
  if (!warm) _firstLoad = true;
  console.time('[rebuild] simulation');      buildAndRunSimulation({ warm });         console.timeEnd('[rebuild] simulation');
  // For 3D: push data directly instead of calling applyFilter() which would
  // run buildAndRunSimulation() a second time (doubles the sim cost).
  if (currentView === '3d' && graph3d) {
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
  if (currentView === '3d' && selectedIndiId) _setOrbitTarget3D(selectedIndiId);
  updateFocusUI();
  console.timeEnd('[rebuild] total');
}

const DECEASED_AGE_THRESHOLD = 110;

// Genealogical convention: presume death once someone would be implausibly
// old, even without a recorded death date. Never un-marks (one-way flip).
function _autoMarkDeceasedByAge() {
  const cutoffYear = new Date().getFullYear() - DECEASED_AGE_THRESHOLD;
  for (const indi of individuals.values()) {
    if (!indi.deceased && indi.birthYear && indi.birthYear <= cutoffYear) indi.deceased = true;
  }
}

// 2. GRAPH DATA BUILDER  (bipartite INDI + FAM nodes)
// ═══════════════════════════════════════════════════════════════
function buildGraphData() {
  _autoMarkDeceasedByAge();
  allNodes = [];
  allLinks = [];
  const nodeById = new Map();
  const nextCache = new Map();

  // Reuse the existing node object for an id if we have one, so its
  // {x,y,vx,vy,fx,fy} simulation state survives this rebuild untouched.
  // Ids that no longer exist are simply not copied into nextCache and drop out.
  const getNode = (id, type, data) => {
    let n = _nodeObjCache.get(id);
    if (n) n.data = data;
    else n = { id, type, data };
    nextCache.set(id, n);
    return n;
  };

  for (const [id, indi] of individuals) {
    const n = getNode(id, 'INDI', indi);
    allNodes.push(n);
    nodeById.set(id, n);
  }

  for (const [id, fam] of families) {
    const n = getNode(id, 'FAM', fam);
    allNodes.push(n);
    nodeById.set(id, n);

    if (fam.husb && nodeById.has(fam.husb))
      allLinks.push({ _src: fam.husb, _tgt: id, ltype: 'spouse' });
    if (fam.wife && nodeById.has(fam.wife))
      allLinks.push({ _src: fam.wife, _tgt: id, ltype: 'spouse' });
    for (const cid of fam.chil) {
      if (nodeById.has(cid))
        allLinks.push({ _src: id, _tgt: cid, ltype: 'parent' });
    }
  }

  _nodeObjCache = nextCache;

  computeActiveData();  // initialise nodes/links from current filter state
}

// ═══════════════════════════════════════════════════════════════
// 3. SURNAME COLOR MAP
// ═══════════════════════════════════════════════════════════════
function buildSurnameColorMap() {
  // 1. Count surname frequencies
  const counts = new Map();
  let noSurnCount = 0;
  for (const [, indi] of individuals) {
    const names = new Set([indi.surn, indi.maidenName].filter(Boolean));
    if (!names.size) noSurnCount++;
    for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // 2. Build surname adjacency graph — two surnames are adjacent when they
  //    appear together in the same family (spouses or parent/child).
  const adj = new Map();
  for (const s of counts.keys()) adj.set(s, new Set());
  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const [, fam] of families) {
    const gs = id => (id ? individuals.get(id)?.surn : null) || null;
    const hS = gs(fam.husb), wS = gs(fam.wife);
    addEdge(hS, wS);
    for (const cid of fam.chil) {
      const cS = gs(cid);
      addEdge(hS, cS);
      addEdge(wS, cS);
    }
  }

  // 3. DSATUR ordering — process most-constrained surnames first so they
  //    get the most freedom when choosing their hue.
  const surns = [...counts.keys()];
  const assignOrder = [];
  const nbSlots = new Map(); // surname -> Set<dummy slot> (just for ordering)
  for (const s of surns) nbSlots.set(s, new Set());
  const unordered = new Set(surns);
  while (unordered.size > 0) {
    let best = null, bestSat = -1, bestDeg = -1, bestFreq = -1;
    for (const s of unordered) {
      const sat = nbSlots.get(s).size, deg = adj.get(s)?.size ?? 0, freq = counts.get(s) || 0;
      if (sat > bestSat || (sat === bestSat && deg > bestDeg) || (sat === bestSat && deg === bestDeg && freq > bestFreq))
        [best, bestSat, bestDeg, bestFreq] = [s, sat, deg, freq];
    }
    assignOrder.push(best);
    const used = nbSlots.get(best);
    let slot = 0; while (used.has(slot)) slot++;
    for (const nb of (adj.get(best) ?? [])) nbSlots.get(nb)?.add(slot);
    unordered.delete(best);
  }

  // 4. Greedy hue assignment: each surname gets a unique hue chosen as the
  //    midpoint of the largest arc on the colour wheel that is free from its
  //    already-coloured neighbours (hard constraint). Surnames with no
  //    neighbours fill the largest gap among all globally assigned hues so
  //    they spread across the remaining space rather than clustering.
  const largestGapMid = (angles) => {
    const pts = [...new Set(angles)].sort((a, b) => a - b);
    let maxGap = 0, mid = pts[0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = i + 1 < pts.length ? pts[i + 1] : pts[0] + 360;
      const gap = b - a;
      if (gap > maxGap) { maxGap = gap; mid = (a + gap / 2) % 360; }
    }
    return mid;
  };

  const assignedHue = new Map(); // surname -> hue [0,360)
  const allHues = [];            // every hue assigned so far (for spreading isolates)

  for (const surn of assignOrder) {
    if (surnameCustomColors.has(surn)) { assignedHue.set(surn, -1); continue; }
    const nbHues = [];
    for (const nb of (adj.get(surn) ?? [])) {
      const h = assignedHue.get(nb);
      if (h != null && h >= 0) nbHues.push(h);
    }
    const hue = nbHues.length > 0
      ? largestGapMid(nbHues)                             // max separation from neighbours
      : (allHues.length > 0 ? largestGapMid(allHues) : 30); // fill global gaps for isolates
    assignedHue.set(surn, hue);
    allHues.push(hue);
  }

  // 5. Apply colours (custom overrides respected)
  surnameColors.clear();
  surnameEnabled.clear();
  _surnameColorCache.clear();
  for (const [surn] of sorted) {
    if (surnameCustomColors.has(surn)) {
      const c = surnameCustomColors.get(surn);
      surnameColors.set(surn, c);
      _surnameColorCache.set(surn, c);
    } else {
      const color = hslToHex(assignedHue.get(surn) ?? 30, 62, 52);
      surnameColors.set(surn, color);
      _surnameColorCache.set(surn, color);
    }
    surnameEnabled.set(surn, true);
  }

  if (noSurnCount > 0) {
    surnameEnabled.set(null, true);
    sorted.push([null, noSurnCount]);
  }
  return sorted;
}

// Single color source for all INDI visuals (circle + label).
// colorBySurname=true  → surname hash color
// colorBySurname=false → sex color
function indiColor(indi) {
  if (colorBySurname && indi.surn) return surnameColor(indi.surn);
  if (indi.sex === 'M') return nodeColors.male;
  if (indi.sex === 'F') return nodeColors.female;
  return nodeColors.unknown;
}

function nodeBaseColor(n) {
  if (n.type === 'FAM') return n.data.div ? nodeColors.famDiv : nodeColors.fam;
  return indiColor(n.data);
}

function labelColor(n) {
  if (n.type !== 'INDI') return '#888888';
  return indiColor(n.data);
}

// The name now sits inside a filled box rather than floating beside a dot,
// so its color has to answer to that fill's brightness or pastel surname
// hues (and the light "unknown" grey) render invisible white-on-white text.
function contrastTextColor(hex) {
  const c = (hex || '').replace('#', '');
  if (c.length !== 6) return '#ffffff';
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? '#1a1a1a' : '#ffffff';
}

// ── Visibility helpers (surname filter) ──
function hasEnabledFamilyName(indi) {
  const names = new Set([indi.surn, indi.maidenName].filter(Boolean));
  if (!names.size) return surnameEnabled.get(null) !== false;
  return [...names].some(name => surnameEnabled.get(name) !== false);
}

function isIndiVisible(id) {
  const indi = individuals.get(id);
  if (!indi || hasEnabledFamilyName(indi)) return true;
  for (const [, fam] of families) {
    const spouseId = fam.husb === id ? fam.wife : fam.wife === id ? fam.husb : null;
    if (spouseId && hasEnabledFamilyName(individuals.get(spouseId) || {})) return true;
  }
  return false;
}
function isFamVisible(id) {
  const fam = families.get(id);
  if (!fam) return true;
  const members = [fam.husb, fam.wife, ...fam.chil].filter(Boolean);
  if (!members.length) return true;
  return members.some(pid => isIndiVisible(pid));
}
function isNodeVisible(n) {
  return n.type === 'INDI' ? isIndiVisible(n.id) : isFamVisible(n.id);
}

// ── 2D focus: keep only the people closest to the focus person ──
// BFS out from the focus person over the INDI↔FAM graph, adding whole
// relationship rings in distance order until the budget runs out. What gets
// dropped is therefore always the *least* related — a ring that only partly
// fits is filled to the budget and the rest is cut.
// Returns a Set of node ids (INDI + FAM), or null when focus is off.
// The classical chart shows a *blood* relationship, not a neighbourhood: the
// subject's ancestors and descendants, plus siblings and first cousins (an
// ancestor's children and grandchildren) — but nothing more distant. A married-in
// person is still shown right beside the blood relative they married (one hop,
// e.g. an uncle's wife), just never a doorway to their own side of the family.
// Rings are taken whole, nearest first, until the budget runs out.

// How far sideways an ancestor's own descendants may fan out before they stop
// counting as "close" collateral relatives. Ancestor generation 1 (parents) may
// fan 1 row down — their other children are the subject's siblings. Generation 2
// (grandparents) may fan 2 rows down — children then grandchildren are aunts/
// uncles then first cousins. Anything further up contributes only itself to the
// direct line, no collateral branch at all.
// Nth cousins share an ancestor n+1 generations up and sit n+1 steps back down
// from them, so the degree the reader asks for maps straight onto how far each
// ancestor's branch may fan out. Beyond that an ancestor contributes only
// themselves to the direct line.
//
// The parents' branch is the exception and is always walked two steps: that is
// siblings and their children, which nobody thinks of as distant relatives.
function _collateralMaxDepth(ancestorGen, degree) {
  if (ancestorGen === 1) return 2;
  if (ancestorGen <= degree + 1) return ancestorGen;
  return 0;
}

function computeLineageSet() {
  const people = new Set([focusRootId]);
  const fams   = new Set();
  const room   = () => people.size < focusLimit;

  // The walk already knows everyone's generation: one step up is one row up,
  // one step down is one row down. Taking the row straight from the walk keeps
  // couples level and children exactly one row under their parents by
  // construction. Deriving rows afterwards from ancestor depth cannot do that —
  // parents have unequal depths, and levelling them after the fact cascades
  // into dozens of phantom generations.
  _lineageGen = new Map([[focusRootId, 0]]);

  // Tracks, for people reached through the sideways "down" walk, which
  // ancestor's collateral branch they belong to and how many rows below that
  // ancestor they sit — the two numbers _collateralMaxDepth() caps. `anc: null`
  // marks the focus person's own direct descendant line, which is never capped.
  const downMeta = new Map([[focusRootId, { anc: null, depth: 0 }]]);

  let up = [focusRootId], down = [focusRootId];
  while ((up.length || down.length) && room()) {
    const nextUp = [], nextDown = [];

    for (const id of up) {
      for (const famId of (individuals.get(id)?.famc || [])) {
        const fam = families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        for (const p of [fam.husb, fam.wife]) {
          if (!p || !individuals.has(p) || people.has(p)) continue;
          if (!room()) break;
          people.add(p);
          _lineageGen.set(p, _lineageGen.get(id) - 1);
          nextUp.push(p);
          // Every ancestor is also walked downwards, which is what puts the
          // subject's siblings and first cousins on the chart — capped below.
          downMeta.set(p, { anc: p, depth: 0 });
          nextDown.push(p);
        }
      }
    }

    for (const id of down) {
      const meta = downMeta.get(id);
      for (const famId of (individuals.get(id)?.fams || [])) {
        const fam = families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        for (const cid of fam.chil) {
          if (!individuals.has(cid) || people.has(cid)) continue;
          let cMeta;
          if (!meta || meta.anc === null) {
            cMeta = { anc: null, depth: 0 };   // focus person's own descendants: unlimited
          } else {
            const ancestorGen = -(_lineageGen.get(meta.anc) ?? 0);
            const depth = meta.depth + 1;
            if (depth > _collateralMaxDepth(ancestorGen, cousinDegree)) continue;   // too distant a cousin
            cMeta = { anc: meta.anc, depth };
          }
          if (!room()) break;
          people.add(cid);
          _lineageGen.set(cid, _lineageGen.get(id) + 1);
          downMeta.set(cid, cMeta);
          nextDown.push(cid);
        }
      }
    }

    up = nextUp; down = nextDown;
  }

  // One more hop: the spouse of every blood relative kept above gets a box
  // right next to them — but their own parents/siblings are not walked, so
  // this never grows the chart past "married in, one column wide."
  for (const id of [...people]) {
    for (const famId of (individuals.get(id)?.fams || [])) {
      const fam = families.get(famId);
      if (!fam) continue;
      const sp = fam.husb === id ? fam.wife : fam.husb;
      if (!sp || sp === id || !individuals.has(sp) || people.has(sp) || !room()) continue;
      people.add(sp);
      fams.add(famId);
      _lineageGen.set(sp, _lineageGen.get(id));
    }
  }

  // People the reader asked for by clicking a "+N" chip. They come in whatever
  // the walk decided, and ignore the budget — the click *is* the budget.
  for (const id of (_revealed || [])) {
    if (!individuals.has(id)) continue;
    // Somebody opened earlier may already be here through the ordinary walk.
    // Skipping the whole entry for them, as this did, also skipped bringing
    // their partner in below — so a branch opened twice lost people the second
    // time and the count stopped adding up.
    if (!people.has(id)) people.add(id);
    if (!_lineageGen.has(id)) {
      // Take the generation from whichever relative is already on the chart.
      for (const famId of (individuals.get(id).famc || [])) {
        const fam = families.get(famId);
        if (!fam) continue;
        for (const p of [fam.husb, fam.wife]) {
          if (p && _lineageGen.has(p)) _lineageGen.set(id, _lineageGen.get(p) + 1);
        }
      }
      for (const famId of (individuals.get(id).fams || [])) {
        const fam = families.get(famId);
        if (!fam) continue;
        for (const c of fam.chil) {
          if (_lineageGen.has(c) && !_lineageGen.has(id)) _lineageGen.set(id, _lineageGen.get(c) - 1);
        }
        const sp = fam.husb === id ? fam.wife : fam.husb;
        if (sp && _lineageGen.has(sp) && !_lineageGen.has(id)) _lineageGen.set(id, _lineageGen.get(sp));
      }
      if (!_lineageGen.has(id)) _lineageGen.set(id, 0);
    }
    for (const famId of [...(individuals.get(id).famc || []), ...(individuals.get(id).fams || [])]) {
      if (families.has(famId)) fams.add(famId);
    }
    // Their partner comes with them, off-budget like the rest of this. The
    // one-hop pass above would otherwise be asked to find room for somebody the
    // reader has explicitly opened, and a "+14" that only ever produces eleven
    // people is a broken promise. Their family is still not walked — the
    // partner arrives, their side of the tree does not.
    for (const famId of (individuals.get(id).fams || [])) {
      const fam = families.get(famId);
      if (!fam) continue;
      const sp = fam.husb === id ? fam.wife : fam.husb;
      if (!sp || sp === id || !individuals.has(sp) || people.has(sp)) continue;
      people.add(sp);
      _lineageGen.set(sp, _lineageGen.get(id));
    }
  }

  for (const famId of [...fams]) {
    const fam = families.get(famId);
    const kept = [fam.husb, fam.wife, ...fam.chil].filter(id => id && people.has(id));
    if (kept.length < 2) fams.delete(famId);
  }
  return new Set([...people, ...fams]);
}

function computeFocusSet() {
  if (!focusRootId || !individuals.has(focusRootId)) return null;
  // Which relatives count is the reader's choice, not the renderer's: keyed to
  // the chart setting rather than to whichever view happens to be on screen, so
  // switching between 2D and 3D shows the same people. Keyed to the view, the
  // two disagreed about who a focus even meant.
  if (treeLayout) return computeLineageSet();

  const people = new Set([focusRootId]);
  const fams   = new Set();
  let frontier = [focusRootId];

  while (frontier.length && people.size < focusLimit) {
    // Collect the whole next ring before admitting any of it, then admit in
    // kinship order: direct line (parents, spouse, children) ahead of siblings.
    // Admitting family-by-family instead would let one large sibship eat the
    // budget before that person's own spouse and children were even looked at.
    const cand = new Map();   // id → priority (0 = direct line, 1 = sibling)
    const offer = (id, prio) => {
      if (!id || people.has(id) || !individuals.has(id)) return;
      const seen = cand.get(id);
      if (seen === undefined || prio < seen) cand.set(id, prio);
    };

    for (const pid of frontier) {
      const indi = individuals.get(pid);
      if (!indi) continue;
      for (const famId of indi.fams) {          // own marriage: spouse + children
        const fam = families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        offer(fam.husb === pid ? fam.wife : fam.husb, 0);
        for (const cid of fam.chil) offer(cid, 0);
      }
      for (const famId of indi.famc) {          // parents' family: parents, then siblings
        const fam = families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        offer(fam.husb, 0);
        offer(fam.wife, 0);
        for (const cid of fam.chil) offer(cid, 1);
      }
    }

    const next = [];
    for (const [id] of [...cand].sort((a, b) => a[1] - b[1])) {
      if (people.size >= focusLimit) break;
      people.add(id);
      next.push(id);
    }
    frontier = next;
  }

  // A FAM node only earns its place if it still joins two kept people;
  // otherwise it hangs off the edge of the cut as a dangling diamond.
  for (const famId of [...fams]) {
    const fam = families.get(famId);
    const kept = [fam.husb, fam.wife, ...fam.chil].filter(id => id && people.has(id));
    if (kept.length < 2) fams.delete(famId);
  }

  return new Set([...people, ...fams]);
}

// Best hub in the tree — most family memberships. A focused 2D view has to
// start somewhere, and the most-connected person reveals the most of the tree.
function _defaultFocusRoot() {
  let best = null, bestN = -1;
  for (const [id, indi] of individuals) {
    const n = (indi.famc?.length || 0) + (indi.fams?.length || 0);
    if (n > bestN) { bestN = n; best = id; }
  }
  return best;
}

// How many people the current focus is hiding (0 when focus is off/fits).
function focusHiddenCount() {
  if (!focusRootId) return 0;
  return Math.max(0, individuals.size - nodes.filter(n => n.type === 'INDI').length);
}

// ═══════════════════════════════════════════════════════════════
// CLASSICAL TREE LAYOUT  (2D ancestry diagram)
// ═══════════════════════════════════════════════════════════════
// A deterministic layered chart instead of the force simulation.
//
//   Y — the generation, and nothing else. Everybody of one generation sits on
//       one line, always. This is the thing a family tree has to get right, so
//       nothing downstream is ever allowed to nudge a row to make room.
//
//   X — solved as a layered graph, the standard treatment for exactly this
//       shape of problem. People of generation g form one layer; the marriages
//       below them form another, so every connector spans a single layer and
//       none of them has to jump a rank. Each layer is ordered to keep
//       relatives together (crossing reduction), then each node is pulled
//       toward the average position of what it connects to, subject to a
//       minimum gap between neighbours in the same row.
//
// The point of doing X this way is that genealogy is a *graph*, not a tree:
// people remarry, cousins marry, a couple's two families of origin both want to
// sit above them. Any scheme that hands out private x-intervals — a block, a
// subtree, a wing — has to break those cases by force, and what it breaks first
// is the generation rows. Relaxation has no such problem: it cannot produce an
// overlap, because non-overlap is the constraint it solves under, and it never
// needs to touch Y to satisfy it. Marriage and child connectors come out short
// because the layout minimises them, not because the structure guaranteed it.

// Spacing is set by the name labels, not the dots: a column narrower than a
// typical "Christian Siegenthaler" makes neighbouring names overlap at any
// zoom that renders them readably.
const TREE_ROW_H     = 128;  // vertical distance between generations
const TREE_COL_W     = 104;  // minimum distance between two people in a row (NODE_BOX_W + 12)
const TREE_SPOUSE_DX = 100;  // nominal width of a couple, used for connector routing
const TREE_FAM_DY    = 0.24; // marriage row sits this fraction of a row below its couple
                             // — far enough to clear the bottom of a NODE_BOX_H box
const TREE_MARK_GAP  = 26;   // minimum distance between two marriage markers in a row
const TREE_GROUP_GAP = 40;   // extra clearance between one family's children and the next's
const TREE_BUS_UP    = 48;   // sibling bar sits this far above the children's row
const TREE_LANE_DY   = 20;   // and stacks up by this much when families must share a span
const TREE_LANE_MIN  = 7;    // ...never less than this, however many lanes a row needs
const TREE_MARR_STEP = 13;   // stacking step for a person's further marriages
const TREE_CHIP_DX   = 22;   // "+N" chip offset from the junction it belongs to
const TREE_CHIP_DY   = 13;
const TREE_ORDER_PASSES = 6; // crossing-reduction sweeps
const TREE_COORD_PASSES = 8; // coordinate relaxation sweeps

// Greedy interval colouring for the horizontal connector runs between two
// rows. Sweeps left to right and gives each run the lowest lane whose previous
// occupant has already finished, so runs that overlap in x are guaranteed
// different lanes while only as many lanes are spent as the busiest point
// needs. Mutates each item's `lane`; returns how many lanes were used.
// Rotating through a fixed set of lanes instead puts two overlapping runs on
// the same lane as soon as more than that many are in play.
const TREE_BUS_CLEARANCE = 24;   // keep consecutive runs in a lane visibly apart

function _assignBusLanes(items) {
  items.sort((a, b) => a.x0 - b.x0);
  const laneEnd = [];              // lane -> x where its last run finished
  for (const it of items) {
    let lane = laneEnd.findIndex(end => end + TREE_BUS_CLEARANCE < it.x0);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(-Infinity); }
    laneEnd[lane] = it.x1;
    it.lane = lane;
  }
  return laneEnd.length;
}

function computeTreeLayout() {
  const visible = new Set(nodes.map(n => n.id));
  const people = [...visible].filter(id => individuals.has(id));
  if (!people.length) return null;

  // The chart is built around somebody, but that somebody need not be a chosen
  // subject — with no focus set it is whoever the chart would naturally read
  // from. `subject` only decides ordering, balance and centring; everything
  // about *who appears* was already settled by the filter.
  const subject = (focusRootId && visible.has(focusRootId)) ? focusRootId
                : (visible.has(treeAnchorId()) ? treeAnchorId() : people[0]);
  if (!people.length) return null;

  // Families that join at least two people on screen. Tested by membership
  // rather than by the FAM node being one of `nodes`, so the chart still works
  // with the "show family nodes" toggle off — the markers are what the child
  // connectors are grouped by either way.
  const visFam = new Map();
  for (const [fid, fam] of families) {
    const par  = [fam.husb, fam.wife].filter(p => p && visible.has(p));
    const kids = fam.chil.filter(c => visible.has(c));
    if (par.length + kids.length >= 2) visFam.set(fid, { fam, par, kids });
  }

  const famsOf = id => (individuals.get(id)?.fams || []).filter(f => visFam.has(f));
  const parentsOf = id => {
    const out = [];
    for (const fid of (individuals.get(id)?.famc || [])) {
      const v = visFam.get(fid);
      if (v) out.push(...v.par);
    }
    return out;
  };

  // ── 1. Rows ──
  // The generation, straight from the lineage walk, which assigns it by
  // construction (one step up is one row up). Ancestor depth is the fallback
  // for anyone it never reached. Nothing below this point changes a row: rows
  // are the one thing the chart has to get right, so every overlap the layout
  // has to resolve is resolved sideways instead.
  const depths  = computeGenerationDepths();
  const rootGen = depths.get(subject) ?? 0;
  const gen = new Map();
  for (const id of people) {
    gen.set(id, _lineageGen?.get(id) ?? ((depths.get(id) ?? rootGen) - rootGen));
  }
  // A couple is one unit on a chart, so the two halves must be level. Repeat:
  // levelling one couple can unlevel another through a remarriage.
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const { par } of visFam.values()) {
      if (par.length < 2) continue;
      const g = Math.min(...par.map(p => gen.get(p)));
      for (const p of par) if (gen.get(p) !== g) { gen.set(p, g); moved = true; }
    }
    if (!moved) break;
  }

  // Marriages get a layer of their own between the couple and their children,
  // so a person→marriage→child path is two single-layer connectors rather than
  // one that has to be routed past a whole rank of boxes.
  const famGen = new Map();
  for (const [fid, v] of visFam) {
    famGen.set(fid, v.par.length
      ? Math.max(...v.par.map(p => gen.get(p)))
      : Math.min(...v.kids.map(c => gen.get(c))) - 1);
  }

  // Layer index: people of generation g at 2g, the marriages under them at 2g+1.
  const layerOf = new Map();
  for (const id of people)    layerOf.set(id, 2 * gen.get(id));
  for (const [fid] of visFam) layerOf.set(fid, 2 * famGen.get(fid) + 1);

  // Connections, weighted. A marriage pulls harder than a descent: when a
  // husband's parents are on one side of the chart and his wife's on the other,
  // something has to give, and it should be the two ancestries stretching
  // rather than the couple coming apart. A couple drawn apart is read as an
  // error; grandparents a little off-centre are not.
  const adj = new Map();
  const link = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ id: b, w });
    adj.get(b).push({ id: a, w });
  };
  for (const [fid, v] of visFam) {
    for (const p of v.par)  link(p, fid, 3);
    for (const c of v.kids) link(fid, c, 1);
    // Spouses also pull on each other directly, not only through their marker.
    // Via the marker alone a couple is only held together as hard as everything
    // else pulling on the marker allows, and they drift apart by a column or
    // two — enough for the marriage line between them to become the longest
    // thing on the row.
    if (v.par.length === 2) link(v.par[0], v.par[1], 2);
  }

  // Only the subject's own blood line gets a "cut ancestry" chip. Every leaf on
  // the chart is missing parents in the sense that they are not drawn — most of
  // them are people who married in, whose families were never in scope, and a
  // chip on each is a row of markers saying nothing. What is worth marking is
  // where the *line* stops: collateral branches run back into the same
  // ancestors, so chipping those once, up on the line, covers them all.
  const bloodLine = new Set([subject]);
  for (let frontier = [subject]; frontier.length;) {
    const next = [];
    for (const id of frontier) {
      for (const famId of (individuals.get(id)?.famc || [])) {
        const fam = families.get(famId);
        if (!fam) continue;
        for (const p of [fam.husb, fam.wife]) {
          if (p && individuals.has(p) && !bloodLine.has(p)) { bloodLine.add(p); next.push(p); }
        }
      }
    }
    frontier = next;
  }


  const slotOf = L => L % 2 === 0 ? TREE_COL_W : TREE_MARK_GAP;

  // ── 2. Order within each layer ──
  // The seed is the whole classical shape of the chart, written as one
  // left-to-right sequence; each layer then just sorts by it. Everything on a
  // father's side is emitted before him and everything on a mother's side after
  // her, recursively, so paternal lines occupy the left of the chart and
  // maternal lines the right at every generation. The subject is emitted
  // between the two halves of their own sibship, which is what puts them near
  // the middle. The sweeps that follow only refine this — they reduce crossings
  // locally and cannot untangle a bad seed, so the seed is where the shape of
  // the chart is actually decided.
  const spousesOf = id => famsOf(id)
    .map(f => { const v = visFam.get(f); return v.fam.husb === id ? v.fam.wife : v.fam.husb; })
    .filter(sp => sp && sp !== id && visible.has(sp));

  // ── Marriage groups ──
  // Everyone linked by marriage forms one group, laid out as one run so that
  // each of them ends up beside somebody they actually married: a widow between
  // her two husbands, and a second husband next to his own first wife. Seating
  // only a person's own spouses strands the far end of such a chain somewhere
  // else, and the marriage line then reaches across whoever landed in between —
  // which is what a stray dashed line is. The group is also the unit the
  // ordering sweeps move, so nothing can be sorted into the middle of a couple.
  const mateGroup = new Map();   // person -> group id
  const chainOf   = [];          // group id -> members, left to right
  for (const id of people) {
    if (mateGroup.has(id)) continue;
    const g = chainOf.length;
    const group = new Set([id]);
    for (const m of group) {
      for (const sp of spousesOf(m)) if (!mateGroup.has(sp)) group.add(sp);
    }
    const deg = m => spousesOf(m).filter(sp => group.has(sp)).length;
    // Start at an end of the chain, so the walk lays it out in one run.
    let start = id;
    for (const m of group) if (deg(m) <= 1) { start = m; break; }
    const chain = [];
    (function walk(m) {
      if (chain.includes(m)) return;
      chain.push(m);
      for (const sp of spousesOf(m)) if (group.has(sp)) walk(sp);
    })(start);
    // Father left, mother right: flip the run if it came out wife-first. It has
    // to be judged on the marriage that actually joins the first two of them —
    // any other marriage of theirs says nothing about which way round this run
    // is. Beyond the first pair the order is fixed by the marriages themselves.
    if (chain.length > 1) {
      const joining = famsOf(chain[0]).find(f => {
        const fam = visFam.get(f).fam;
        return fam.husb === chain[1] || fam.wife === chain[1];
      });
      if (joining && families.get(joining).wife === chain[0]) chain.reverse();
    }
    for (const m of chain) mateGroup.set(m, g);
    chainOf.push(chain);
  }

  const seq = new Map();
  let seqN = 0;
  const push = id => { if (id != null && !seq.has(id)) seq.set(id, seqN++); };
  const famcOf = id => (individuals.get(id)?.famc || []).find(f => visFam.has(f));
  const seenFam = new Set();

  // A person, everyone they are married to, and everything descending from any
  // of them.
  const emitDesc = id => {
    if (seq.has(id)) return;
    const chain = chainOf[mateGroup.get(id)];
    for (const m of chain) push(m);
    for (const m of chain) {
      for (const fid of famsOf(m)) {
        if (seenFam.has(fid)) continue;
        seenFam.add(fid);
        push(fid);
        for (const c of visFam.get(fid).kids) emitDesc(c);
      }
    }
  };

  // Everything on one person's side of the family — their parents, their
  // parents' whole ancestry, and their brothers and sisters with all their
  // issue. The caller decides whether this lands before or after the person, by
  // when it calls; that choice is the paternal-left / maternal-right rule.
  const emitSide = x => {
    const fid = famcOf(x);
    if (!fid || seenFam.has(fid)) return;
    seenFam.add(fid);
    const v = visFam.get(fid);
    const fa = v.par.find(p => p === v.fam.husb) ?? null;
    const mo = v.par.find(p => p === v.fam.wife) ?? null;
    if (fa) emitSide(fa);
    push(fa); push(fid); push(mo);
    if (mo) emitSide(mo);
    for (const c of v.kids) if (c !== x) emitDesc(c);
  };

  const subjFam = famcOf(subject);
  if (subjFam) {
    seenFam.add(subjFam);
    const v = visFam.get(subjFam);
    const fa = v.par.find(p => p === v.fam.husb) ?? null;
    const mo = v.par.find(p => p === v.fam.wife) ?? null;
    const sibs = v.kids.filter(c => c !== subject);
    const half = Math.floor(sibs.length / 2);
    if (fa) emitSide(fa);
    push(fa); push(subjFam); push(mo);
    sibs.slice(0, half).forEach(emitDesc);
    emitDesc(subject);
    sibs.slice(half).forEach(emitDesc);
    if (mo) emitSide(mo);
  } else {
    emitDesc(subject);
  }

  // Anyone the walk never reached — an unconnected fragment of the focus set.
  const byBirth = (a, b) =>
    (gen.get(a) - gen.get(b)) ||
    ((individuals.get(a).birthYear ?? 9999) - (individuals.get(b).birthYear ?? 9999));
  people.filter(id => parentsOf(id).length === 0).sort(byBirth).forEach(emitDesc);
  people.forEach(emitDesc);
  for (const [fid] of visFam) push(fid);

  const layers = new Map();
  for (const [id, L] of layerOf) {
    if (!layers.has(L)) layers.set(L, []);
    layers.get(L).push(id);
  }
  const keys = [...layers.keys()].sort((a, b) => a - b);
  for (const L of keys) layers.get(L).sort((a, b) => seq.get(a) - seq.get(b));

  // Position within the marriage run — the sweeps may reorder the runs, never
  // the people inside one, so a couple can never be pulled apart.
  const inChain = new Map();
  chainOf.forEach(chain => chain.forEach((m, i) => inChain.set(m, i)));

  // Where each married group first appears in the seed. Ties in the sweeps
  // below are broken by this, so equal barycentres — which is the normal case
  // for a row of siblings, who all hang off the same marriage — fall back to
  // the shape the seed laid out rather than to whatever order the groups
  // happened to be discovered in.
  const groupSeq = new Map();
  for (const id of people) {
    const k = mateGroup.get(id);
    groupSeq.set(k, Math.min(groupSeq.get(k) ?? Infinity, seq.get(id) ?? 0));
  }
  const gseq = id => groupSeq.get(mateGroup.get(id)) ?? (seq.get(id) ?? 0);

  const idx = new Map();
  const reindex = L => layers.get(L).forEach((id, i) => idx.set(id, i));
  keys.forEach(reindex);

  // Barycentre sweeps: order each layer by the average position of whatever it
  // connects to in the layer just before it, alternating direction. This is what
  // keeps a family's children together instead of scattered among their cousins.
  for (let pass = 0; pass < TREE_ORDER_PASSES; pass++) {
    const order = pass % 2 ? [...keys].reverse() : keys;
    for (let i = 1; i < order.length; i++) {
      const L = order[i], prev = order[i - 1];
      const ids = layers.get(L);

      // A barycentre is a position in the *reference* layer. A node with no
      // connection into that layer — someone who married in, whose only link
      // runs the other way — has no barycentre at all, and giving it a stand-in
      // taken from this layer's own indices sorts it against numbers measured
      // on a different scale. That is what threw people to the wrong side of
      // the chart. Leave them out here; they are filled in below from a
      // neighbour, which keeps them where they already were.
      const bary = new Map();
      for (const id of ids) {
        const ns = (adj.get(id) || []).filter(o => layerOf.get(o.id) === prev);
        if (ns.length) bary.set(id, ns.reduce((s, o) => s + idx.get(o.id), 0) / ns.length);
      }

      if (L % 2 === 0) {
        // Married people share one barycentre — their group's — so the sort
        // cannot separate them, and a spouse with no line of their own simply
        // rides along with the partner who has one.
        const sum = new Map(), count = new Map();
        for (const id of ids) {
          if (!bary.has(id)) continue;
          const k = mateGroup.get(id);
          sum.set(k, (sum.get(k) ?? 0) + bary.get(id));
          count.set(k, (count.get(k) ?? 0) + 1);
        }
        for (const id of ids) {
          const k = mateGroup.get(id);
          if (count.has(k)) bary.set(id, sum.get(k) / count.get(k));
        }
      }

      // Anyone still without one keeps their place, just after whoever precedes
      // them in the order as it stands.
      let last = -1;
      for (const id of ids) {
        if (bary.has(id)) last = bary.get(id);
        else bary.set(id, last + 1e-6);
      }

      // Marriage runs sort as a unit and keep their internal order, so the
      // father stays on the left of his wife and nobody is dropped between them.
      ids.sort((a, b) => bary.get(a) - bary.get(b) ||
                         gseq(a) - gseq(b) ||
                         (inChain.get(a) ?? 0) - (inChain.get(b) ?? 0) ||
                         seq.get(a) - seq.get(b));
      reindex(L);
    }
  }

  // ponytail: a greedy adjacent-swap pass on top of the barycentre sweeps was
  // tried here and measurably made the chart worse — it minimises crossings
  // between the person and marriage layers, which is not the same thing as
  // brackets crossing on the page, and the swaps disturbed the seed order that
  // was carrying the shape. Left out on the numbers: 4343 crossing brackets
  // without it, 4500 with, for 66% more layout time.

  // ── 3. X coordinates ──
  // Order is settled; now pull every node toward the average x of what it
  // connects to, while never letting two neighbours in a row come closer than
  // the minimum gap. Repeated in both directions this settles couples beside
  // each other, marriage markers between their spouses, and children under
  // their parents — the things the old block layout tried to guarantee
  // structurally and could not, because a genealogy is a graph and a block
  // layout only fits a tree.
  const xs = new Map();
  for (const L of keys) {
    let x = 0;
    for (const id of layers.get(L)) { xs.set(id, x); x += TREE_COL_W; }
  }

  // Consecutive people of one marriage group, as they currently sit in a layer.
  const runsIn = (L, gap) => {
    const runs = [];
    for (const id of layers.get(L)) {
      const k = L % 2 === 0 ? mateGroup.get(id) : undefined;
      const tail = runs[runs.length - 1];
      if (tail && k !== undefined && tail.k === k) tail.ids.push(id);
      else runs.push({ k, ids: [id] });
    }
    for (const r of runs) r.w = (r.ids.length - 1) * gap;
    return runs;
  };

  // Pack a row: each run as near its target as the gaps allow. Packing once
  // from each end and taking the midpoint shares out the slack, instead of
  // jamming everything against whichever side happened to be packed first.
  // `gaps[i]` is the clearance required between run i-1 and run i, so different
  // sibling groups can be held further apart than siblings of one family.
  const pack = (runs, target, gaps) => {
    const lo = [], hi = [], n = runs.length;
    for (let i = 0; i < n; i++) {
      lo[i] = i ? Math.max(target[i], lo[i - 1] + runs[i - 1].w + gaps[i]) : target[i];
    }
    for (let i = n - 1; i >= 0; i--) {
      hi[i] = i < n - 1 ? Math.min(target[i], hi[i + 1] - runs[i].w - gaps[i + 1]) : target[i];
    }
    const out = runs.map((_, i) => (lo[i] + hi[i]) / 2);
    for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + runs[i - 1].w + gaps[i]);
    return out;
  };

  // Children of one family belong together; children of the next belong apart.
  // Without the extra clearance the two families' sibling bars run into each
  // other and you cannot tell which bracket a child hangs from — which is the
  // one thing the bracket exists to say.
  const famcKey = id => (individuals.get(id)?.famc || []).find(f => visFam.has(f)) ?? null;
  const gapsFor = (runs, L) => {
    const base = slotOf(L);
    return runs.map((r, i) => {
      if (!i || L % 2 !== 0) return base;
      const prev = runs[i - 1].ids[runs[i - 1].ids.length - 1];
      const here = r.ids[0];
      const a = famcKey(prev), b = famcKey(here);
      return (a && b && a !== b) ? base + TREE_GROUP_GAP : base;
    });
  };

  const place = L => {
    if (!layers.get(L).length) return;
    const gap = slotOf(L);
    // Married people move as one rigid run, fixed a column apart. Placing them
    // individually lets two families pulling in opposite directions stretch a
    // couple, and the marriage line between them then becomes the longest thing
    // on the row — which is the stray dash, arrived at from the other end.
    const runs = runsIn(L, gap);
    const target = runs.map(r => {
      let sum = 0, wt = 0;
      r.ids.forEach((id, i) => {
        for (const o of adj.get(id) || []) {
          if (r.ids.includes(o.id)) continue;   // rigid inside the run already
          sum += (xs.get(o.id) - i * gap) * o.w;
          wt += o.w;
        }
      });
      return wt ? sum / wt : xs.get(r.ids[0]);
    });
    const out = pack(runs, target, gapsFor(runs, L));
    runs.forEach((r, i) => r.ids.forEach((id, j) => xs.set(id, out[i] + j * gap)));
  };

  for (let pass = 0; pass < TREE_COORD_PASSES; pass++) {
    for (const L of (pass % 2 ? [...keys].reverse() : keys)) place(L);
  }

  // The marriage marker belongs *between* the two people it marries — that is
  // what makes it readable as their marriage rather than as one more dot in the
  // row, and with two or three spouses it is the only thing that says which
  // marriage produced which children. Relaxation puts it near the midpoint but
  // the children pull it off; snap it back, then re-pack the row so two markers
  // still cannot land on top of each other.
  for (const L of keys) {
    if (L % 2 === 0 || !layers.get(L).length) continue;
    const midpoint = fid => {
      const par = visFam.get(fid).par;
      return par.length ? par.reduce((s, p) => s + xs.get(p), 0) / par.length : xs.get(fid);
    };
    // Re-order the markers by where they now want to be before packing them.
    // Left in the order the sweeps produced, a marker whose couple has moved
    // past its neighbour's gets shoved back out from between its own parents by
    // the separation constraint — which is exactly what it must not do.
    layers.get(L).sort((a, b) => midpoint(a) - midpoint(b));
    const runs = runsIn(L, TREE_MARK_GAP);
    const out = pack(runs, runs.map(r => midpoint(r.ids[0])), gapsFor(runs, L));
    runs.forEach((r, i) => xs.set(r.ids[0], out[i]));
  }

  const pos = new Map();
  for (const id of people)    pos.set(id, { x: xs.get(id), y: gen.get(id) * TREE_ROW_H });
  // A person can sit beside at most two of their spouses. A third marriage has
  // to reach past somebody, and its marker then lands under an unrelated box —
  // where it reads as *that* person's marriage, and its bar runs along the same
  // line as everyone else's. Give each marriage that has to reach a level of
  // its own, so they stack under the couple the way a drawn chart does, one bar
  // clear of the next. A marriage whose partners are already side by side needs
  // no level and stays where it was.
  // Only as many levels as fit between the first marker and the sibling bar
  // hanging below it — past that they would collide with the children.
  const maxLevel = Math.max(0, Math.floor(
    (TREE_ROW_H * (1 - TREE_FAM_DY) - TREE_BUS_UP - 14) / TREE_MARR_STEP));
  const marrLevel = fid => {
    const par = visFam.get(fid).par;
    if (par.length < 2) return 0;
    const reach = Math.round(Math.abs(xs.get(par[0]) - xs.get(par[1])) / TREE_COL_W) - 1;
    return Math.max(0, Math.min(reach, maxLevel));
  };
  for (const [fid] of visFam) {
    pos.set(fid, {
      x: xs.get(fid),
      y: (famGen.get(fid) + TREE_FAM_DY) * TREE_ROW_H + marrLevel(fid) * TREE_MARR_STEP,
    });
  }


  // Every family's child connectors share one horizontal bar — the sibling bar
  // of a hand-drawn chart. All the bars feeding one row sit at the same height,
  // which is what makes the chart read: a run at its own private height per
  // family is exactly the staircase that looked wrong. The block layout above
  // gives each family a private x-interval, so equal heights are safe.
  // The lane pass is only a fallback for the case it cannot rule out — two
  // marriages of the same person, whose bars can still overlap. It is interval
  // colouring, so a family only leaves the shared height when it genuinely
  // collides with a neighbour, and only by as many lanes as that needs.
  _treeBusY = new Map();

  // Child connectors: one bar per family, from the FAM marker out to its
  // furthest child, sitting a fixed distance above the children's row.
  const famsByChildRow = new Map();

  for (const [id, fam] of families) {
    if (!pos.has(id)) continue;
    const famPos = pos.get(id);
    const kids = fam.chil.filter(c => pos.has(c));
    if (!kids.length) continue;
    const span = [famPos.x, ...kids.map(c => pos.get(c).x)];
    const childY = Math.min(...kids.map(c => pos.get(c).y));
    if (!famsByChildRow.has(childY)) famsByChildRow.set(childY, []);
    famsByChildRow.get(childY).push({
      key: id,
      parents: [fam.husb, fam.wife].filter(p => p && pos.has(p)),
      kids,
      x0: Math.min(...span),
      x1: Math.max(...span),
    });
  }

  for (const [childY, items] of famsByChildRow) {
    const lanes = _assignBusLanes(items);
    for (const it of items) {
      // Bars that overlap in x get different lanes so they never run into each
      // other. A lane cannot go above the markers the bars hang from, though —
      // a bar above its own marker draws as a backwards Z — so with a fixed
      // step per lane the top ones all hit that ceiling and collapse back onto
      // one height, overlapping after all. Share out the band that is actually
      // available instead, so every lane in a row keeps a height of its own.
      const ceiling = pos.get(it.key).y + 14;
      const bottom = childY - TREE_BUS_UP;
      // Give every lane at least a few pixels of its own even where the band is
      // too shallow to hold them all. A bar drawn a little high still reads;
      // two bars on the same line do not.
      const top = Math.min(ceiling, bottom - TREE_LANE_MIN * (lanes - 1));
      const step = lanes > 1 ? Math.min(TREE_LANE_DY, (bottom - top) / (lanes - 1)) : 0;
      const y = bottom - it.lane * step;
      _treeBusY.set(it.key, y);
      // With FAM nodes hidden the links run parent→child directly and there is
      // no family id on either end to look the bar up by, so register it under
      // each parent-child pair too. Same bar, so the bracket still forms.
      for (const p of it.parents) for (const c of it.kids) _treeBusY.set(`${p}~${c}`, y);
    }
  }

  // ── Omission markers ──
  // A "+N" chip for every branch the focus walk had to cut, so the chart says
  // *that* something is hidden and how much rather than ending mid-family.
  //
  // The chip sits *at the junction the branch was cut from* — beside the
  // marriage marker whose other children are missing, above the person whose
  // parents are. That is the whole design: the chip is already at the place a
  // reader is asking the question, so it needs no line drawn to it. Giving it a
  // slot out in the row and a connector back, as this did before, is what put a
  // stray line on the chart no matter what colour the line was painted.
  //
  // The number is everyone standing behind the cut, not just the first row of
  // them: keep walking outward from each hidden person the way the chart would
  // and you get the figure a reader actually wants — "14 more people this way",
  // not "2 more children". A click then brings in only the nearest row, and the
  // chip comes back on the people who just arrived carrying what is left. So
  // the branch opens a generation at a time and the count always says how much
  // further it goes.
  const hiddenBeyond = (seeds, dir) => {
    const seen = new Set();
    let frontier = seeds.filter(id => individuals.has(id) && !visible.has(id));
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const indi = individuals.get(id);
        if (!indi) continue;
        if (dir === 'down') {
          for (const famId of (indi.fams || [])) {
            const fam = families.get(famId);
            if (!fam) continue;
            // The partner arrives with them, so they are part of the count —
            // but their own family is not walked, exactly as the chart does it.
            const sp = fam.husb === id ? fam.wife : fam.husb;
            if (sp && individuals.has(sp) && !visible.has(sp)) seen.add(sp);
            for (const c of fam.chil) {
              if (individuals.has(c) && !visible.has(c) && !seen.has(c)) next.push(c);
            }
          }
        } else {
          for (const famId of (indi.famc || [])) {
            const fam = families.get(famId);
            if (!fam) continue;
            for (const p of [fam.husb, fam.wife]) {
              if (p && individuals.has(p) && !visible.has(p) && !seen.has(p)) next.push(p);
            }
          }
        }
      }
      frontier = next;
    }
    return seen;
  };

  const omitted = [];
  for (const [fid, fam] of families) {
    const missing = fam.chil.filter(c => individuals.has(c) && !visible.has(c));
    if (!missing.length) continue;
    // Hang it off the family's marker where there is one. A person whose only
    // shown relative is a parent has no marker — that is precisely the case a
    // generation-at-a-time reveal creates, and without this the branch would
    // open once and then dead-end with nothing left to click.
    let x, y;
    if (pos.has(fid)) {
      const m = pos.get(fid);
      x = m.x + TREE_CHIP_DX; y = m.y + TREE_CHIP_DY;
    } else {
      const par = [fam.husb, fam.wife].filter(p => p && pos.has(p));
      if (!par.length) continue;
      const p = pos.get(par[0]);
      x = p.x + TREE_CHIP_DX; y = p.y + NODE_BOX_H / 2 + TREE_CHIP_DY;
    }
    omitted.push({
      x, y, n: hiddenBeyond(missing, 'down').size, hidden: missing, kind: 'children',
    });
  }
  for (const id of people) {
    if (!bloodLine.has(id) || !pos.has(id)) continue;
    const parents = [];
    for (const famId of (individuals.get(id).famc || [])) {
      const fam = families.get(famId);
      if (fam) for (const p of [fam.husb, fam.wife]) if (p && individuals.has(p)) parents.push(p);
    }
    const missing = parents.filter(p => !visible.has(p));
    if (!missing.length) continue;
    const p = pos.get(id);
    omitted.push({
      x: p.x, y: p.y - NODE_BOX_H / 2 - TREE_CHIP_DY,
      n: hiddenBeyond(missing, 'up').size, hidden: missing, kind: 'parents',
    });
  }

  // Centre the whole chart on the focus person. Read the offset out first —
  // the focus person's own entry is in pos, so subtracting f.x live zeroes it
  // on the first iteration and every later node then shifts by 0, stranding
  // the subject alone at the origin on top of whoever was already there.
  const f = pos.get(subject);
  if (f) {
    const dx = f.x, dy = f.y;
    for (const p of pos.values()) { p.x -= dx; p.y -= dy; }
    for (const [id, y] of _treeBusY) _treeBusY.set(id, y - dy);
    for (const o of omitted) { o.x -= dx; o.y -= dy; }
  }

  _treeOmitted = omitted;
  return pos;
}

// Tree layout only makes sense rooted at somebody, and only in 2D.
// The chart is the 2D layout, focused or not. Without a subject it simply draws
// everyone who is on screen; the tree is how this view reads, and falling back
// to the force layout the moment focus is cleared made it look like a different
// application.
function useTreeLayout() {
  return treeLayout && currentView === '2d';
}

// Who the chart is built around. The subject when there is one, otherwise the
// most-connected person, which is the reading a chart of everybody wants — it
// only decides ordering and centring, never who is shown.
function treeAnchorId() {
  if (focusRootId && individuals.has(focusRootId)) return focusRootId;
  return _defaultFocusRoot();
}

// Pin every node to its computed slot and paint once — no simulation involved.
function applyTreeLayout() {
  const pos = computeTreeLayout();
  if (!pos) return false;
  if (simulation) simulation.stop();

  // Without a running simulation nothing resolves link endpoints, so they are
  // still the raw id strings computeActiveData() emitted. Do what forceLink
  // would have done, or every path renders as M0,0L0,0.
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const l of links) {
    if (typeof l.source !== 'object') l.source = byId.get(l.source) ?? l.source;
    if (typeof l.target !== 'object') l.target = byId.get(l.target) ?? l.target;
  }

  const svgEl = document.getElementById('graph-svg');
  const cx = (svgEl?.clientWidth  || 1100) / 2;
  const cy = (svgEl?.clientHeight || 700)  / 2;

  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    n.x = n.fx = cx + p.x;
    n.y = n.fy = cy + p.y;
    n._treePinned = true;
  }
  // Bus lanes come out of computeTreeLayout in chart space; move them into the
  // same space as the nodes or _linkPath rejects every one of them as out of
  // range and quietly falls back to the shared midpoint.
  if (_treeBusY) for (const [id, y] of _treeBusY) _treeBusY.set(id, cy + y);
  if (_treeOmitted) for (const o of _treeOmitted) { o.x += cx; o.y += cy; }

  tick();
  renderOmittedMarkers();
  onSimEnd();
  return true;
}

// Drop tree pins so the force layout can move nodes again.
function releaseTreePins() {
  for (const n of nodes) {
    if (n._treePinned) { delete n.fx; delete n.fy; delete n._treePinned; }
  }
  _treeOmitted = null;
  gMain?.select('g.omitted-g').selectAll('*').remove();
}

// "+N" chips marking where a real branch was cut by the focus budget —
// dashed stub out of the anchor (a family's bus, or a person missing a
// parent) to a small dashed box with the hidden count.
function renderOmittedMarkers() {
  if (!gMain) return;
  let g = gMain.select('g.omitted-g');
  if (g.empty()) g = gMain.append('g').attr('class', 'omitted-g');

  const data = _treeOmitted || [];
  const sel = g.selectAll('g.omit-chip').data(data, (d, i) => i);
  sel.exit().remove();
  const entered = sel.enter().append('g').attr('class', 'omit-chip');
  entered.append('rect').attr('class', 'omit-box');
  entered.append('text').attr('class', 'omit-count');

  const merged = entered.merge(sel);
  const W = 30, H = 16;

  // No connector. The chip is placed at the junction it belongs to — beside the
  // marriage marker, or just above the person — so there is nothing to join it
  // to. Every version of this that drew a line ended up looking like something
  // stray on the canvas, whichever way the line was styled, because a line to a
  // thing already sitting at the right place has nothing to say.

  // Shaped like a person's box but smaller, which is enough to read as a
  // placeholder for people.
  merged.select('rect.omit-box')
    .attr('x', -W / 2).attr('y', -H / 2)
    .attr('width', W).attr('height', H)
    .attr('rx', NODE_BOX_RX)
    .attr('fill', '#2a2a2a')
    .attr('stroke', '#8a8a8a')
    .attr('stroke-width', 1);

  merged.select('text.omit-count')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('fill', '#cfcfcf')
    .attr('font-size', '9px')
    .attr('pointer-events', 'none')
    .text(d => '+' + d.n);

  merged.attr('transform', d => `translate(${d.x},${d.y})`)
    .style('cursor', 'pointer')
    .on('click', (evt, d) => {
      evt.stopPropagation();
      revealHidden(d.hidden || []);
    });
}

// Bring a cut branch onto the chart. Re-runs the focus walk with those people
// forced in, so they arrive with a generation and their connectors like anyone
// else rather than being bolted on beside the chip.
function revealHidden(ids) {
  if (!ids.length) return;
  for (const id of ids) _revealed.add(id);
  _refocus();
}

function setTreeLayout(on) {
  treeLayout = !!on;
  localStorage.setItem('treeLayout', treeLayout ? '1' : '0');
  // The chart no longer needs a subject to be picked for it — without one it
  // draws everybody, anchored on the most-connected person. It also decides
  // which relatives a focus means, so both views rebuild.
  if (!treeLayout) releaseTreePins();
  _refocus();
}

// ── Generation depth: iterates until every child is strictly deeper than its parents ──
// Depth = longest chain of ancestors above a person, by memoised DFS.
// The previous fixpoint relaxation only *bounded* cycles (at individuals.size
// iterations) instead of breaking them, so data where somebody ends up their
// own ancestor handed back depths in the thousands. That stayed invisible
// while the only consumer was a force whose strength defaults to 0; the
// classical tree layout reads these as row numbers, where it is fatal.
// Here a back edge simply contributes nothing.
function computeGenerationDepths() {
  if (_genDepthsCache) return _genDepthsCache;
  const depth = new Map();
  const visiting = new Set();

  const walk = id => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0;      // cycle — treat as the top of its line
    visiting.add(id);

    let d = 0;
    for (const famId of (individuals.get(id)?.famc || [])) {
      const fam = families.get(famId);
      if (!fam) continue;
      for (const p of [fam.husb, fam.wife]) {
        if (p && individuals.has(p)) d = Math.max(d, walk(p) + 1);
      }
    }

    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const [id] of individuals) walk(id);

  _genDepthsCache = depth;
  return depth;
}

// ── Family average birth year (used by both 2D sim and 3D forceY) ──
function famAvgYear(fam) {
  const ys = [fam.husb, fam.wife, ...fam.chil]
    .filter(Boolean)
    .map(id => _estimatedYears?.get(id) ?? individuals.get(id)?.birthYear)
    .filter(Boolean);
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}

// ── Shared 3D Y mapping — used by BOTH fy pinning and build3DTimeline so rings are exact ──
function yearTo3DY(yr) {
  if (!yr || !_birthYearRange) return null; // null = no pin (unknown year)
  const { min, max } = _birthYearRange;
  const frac = (yr - min) / Math.max(max - min, 1);
  // older → +_3dYHalfSpan (top), newer → -_3dYHalfSpan (bottom)
  return _3dYHalfSpan - frac * 2 * _3dYHalfSpan;
}

// ── Estimated birth year cache (rebuilt by computeEstimatedYears) ──
let _estimatedYears = null;  // Map<id, number>
let _genDepthsCache = null;   // Map<id, number> — cleared by _fullRebuildGraph
const GEN_GAP = 28;  // average generation gap in years

// Build estimated birth years for every individual using a multi-pass BFS:
//  1. Seed with known birthYears
//  2. Propagate parent→child (+GEN_GAP), child→parent (-GEN_GAP), spouse (same year)
//  3. Fall back to generation depth for anyone still unresolved
function computeEstimatedYears() {
  const est = new Map();
  // Seed known
  for (const [id, indi] of individuals) {
    if (indi.birthYear) est.set(id, indi.birthYear);
  }

  // BFS propagation — repeat until no new estimates emerge
  // Cap iterations to guard against cycles
  let changed = true;
  let iters = 0;
  const MAX_ITERS = individuals.size + 1;
  while (changed && iters++ < MAX_ITERS) {
    changed = false;
    for (const [, fam] of families) {
      const spouses = [fam.husb, fam.wife].filter(Boolean);
      const children = fam.chil || [];

      // Collect known/estimated years for parents and children in this family
      const parentYrs = spouses.map(id => est.get(id)).filter(Boolean);
      const childYrs  = children.map(id => est.get(id)).filter(Boolean);
      const avgParent = parentYrs.length ? parentYrs.reduce((a, b) => a + b, 0) / parentYrs.length : null;
      const avgChild  = childYrs.length  ? childYrs.reduce((a, b) => a + b, 0) / childYrs.length   : null;

      // Parent → child: estimate children from parent years
      if (avgParent !== null) {
        for (const cid of children) {
          if (!est.has(cid)) { est.set(cid, Math.round(avgParent + GEN_GAP)); changed = true; }
        }
      }
      // Child → parent: estimate parents from child years
      if (avgChild !== null) {
        for (const pid of spouses) {
          if (!est.has(pid)) { est.set(pid, Math.round(avgChild - GEN_GAP)); changed = true; }
        }
      }
      // Spouse ↔ spouse: estimate from partner
      if (spouses.length === 2) {
        const [a, b] = spouses;
        if (est.has(a) && !est.has(b)) { est.set(b, est.get(a)); changed = true; }
        if (est.has(b) && !est.has(a)) { est.set(a, est.get(b)); changed = true; }
      }
    }
  }

  // Final fallback: use generation depth + average year per generation
  // Reuse cached depths — computeGenerationDepths() is idempotent and cached
  const genDepths = computeGenerationDepths();
  const yearsByGen = new Map();
  for (const [id, yr] of est) {
    const g = genDepths.get(id) ?? 0;
    if (!yearsByGen.has(g)) yearsByGen.set(g, []);
    yearsByGen.get(g).push(yr);
  }
  // Average year per generation
  const genAvg = new Map();
  for (const [g, yrs] of yearsByGen) {
    genAvg.set(g, yrs.reduce((a, b) => a + b, 0) / yrs.length);
  }

  // If we have at least one generation average, we can interpolate the rest
  if (genAvg.size > 0) {
    // Find a reference generation and its average year
    const sortedGens = [...genAvg.entries()].sort((a, b) => a[0] - b[0]);
    // Linear regression-ish: use median pair or just the overall average slope
    let refGen, refYear;
    if (sortedGens.length >= 2) {
      const first = sortedGens[0], last = sortedGens[sortedGens.length - 1];
      const slope = (last[1] - first[1]) / (last[0] - first[0]);
      // Use slope, but clamp to a reasonable range
      const clampedSlope = Math.max(15, Math.min(40, slope));
      refGen = first[0];
      refYear = first[1];
      // Assign remaining individuals by generation offset
      for (const [id] of individuals) {
        if (!est.has(id)) {
          const g = genDepths.get(id) ?? 0;
          est.set(id, Math.round(refYear + (g - refGen) * clampedSlope));
        }
      }
    } else {
      // Only one generation has data — use GEN_GAP
      [refGen, refYear] = sortedGens[0];
      for (const [id] of individuals) {
        if (!est.has(id)) {
          const g = genDepths.get(id) ?? 0;
          est.set(id, Math.round(refYear + (g - refGen) * GEN_GAP));
        }
      }
    }
  }

  _estimatedYears = est;
  return est;
}

// ── Estimate birth year for a single graph node ──
function estimateBirthYear(n) {
  if (n.type !== 'INDI') {
    return famAvgYear(n.data) || null;
  }
  // Use cached estimated year if available
  if (_estimatedYears && _estimatedYears.has(n.id)) return _estimatedYears.get(n.id);
  // Direct fallback
  return n.data.birthYear || null;
}

// ── Pin / unpin Y positions for all 3D graph nodes ──
function applyTimelineYFix() {
  if (!graph3d) return;
  const gd = graph3d.graphData();
  if (sortByTime3D && _birthYearRange) {
    gd.nodes.forEach(n => {
      const yr = estimateBirthYear(n);
      const y = yearTo3DY(yr);
      n.fy = (y !== null) ? y : undefined; // pin if we have a year, float otherwise
    });
  } else {
    gd.nodes.forEach(n => { n.fy = undefined; });
  }
}

// ── Link style helpers ──
function linkColor(l) {
  return linkColors[l.ltype] ?? linkColors.parent;
}
function linkDash(l)        { return l.ltype === 'spouse' ? '5 3' : null; }
function linkBaseOpacity(l) { return l.ltype === 'spouse' ? 0.65 : 0.50; }
function linkWidth(l)       { return l.ltype === 'spouse' ? 1.5 : 1.0; }

// ── Active data: filter allNodes/allLinks by current visibility ──
function computeActiveData() {
  const visIds = new Set(allNodes.filter(n => isNodeVisible(n)).map(n => n.id));

  // Focus is a filter on the data, not a property of the renderer: pick a
  // person and both views show that person's relatives. It used to be applied
  // only in 2D, so switching to 3D silently threw the selection away and
  // returned the whole file — the one thing a filter must not do.
  const focusIds = computeFocusSet();
  if (focusIds) for (const id of [...visIds]) if (!focusIds.has(id)) visIds.delete(id);

  if (showFamNodes) {
    // Bipartite mode: INDI + FAM nodes
    nodes = allNodes.filter(n => visIds.has(n.id));
    links = allLinks
      .filter(l => visIds.has(l._src) && visIds.has(l._tgt))
      .map(l => ({ source: l._src, target: l._tgt, ltype: l.ltype }));
  } else {
    // Direct mode: only INDI nodes, direct spouse + parent-child links
    nodes = allNodes.filter(n => n.type === 'INDI' && visIds.has(n.id));
    const indiIds = new Set(nodes.map(n => n.id));
    links = [];
    const spousePairs = new Set();   // prevent duplicate spouse links for remarried couples
    for (const [, fam] of families) {
      const hasHusb = fam.husb && indiIds.has(fam.husb);
      const hasWife = fam.wife && indiIds.has(fam.wife);
      // Spouse line (deduplicated)
      if (hasHusb && hasWife) {
        const key = [fam.husb, fam.wife].sort().join('|');
        if (!spousePairs.has(key)) {
          spousePairs.add(key);
          links.push({ source: fam.husb, target: fam.wife, ltype: 'spouse' });
        }
      }
      // Parent → child lines, shaded by parent sex
      for (const cid of fam.chil) {
        if (!indiIds.has(cid)) continue;
        if (hasHusb) links.push({ source: fam.husb, target: cid, ltype: 'father' });
        if (hasWife) links.push({ source: fam.wife, target: cid, ltype: 'mother' });
      }
    }
  }

  updateSurnameShownCount();
}

// ── Sidebar count: how many people are on screen under the current surname filter ──
function updateSurnameShownCount() {
  const el = document.getElementById('surname-shown-count');
  if (!el) return;
  const allEnabled = [...surnameEnabled.values()].every(v => v !== false);
  if (allEnabled) {
    el.style.display = 'none';
    return;
  }
  const shown = nodes.filter(n => n.type === 'INDI');
  const withSpouses = shown.length;
  const direct = shown.filter(n => hasEnabledFamilyName(n.data)).length;
  el.textContent = t('sidebar.shownCount', { direct, withSpouses });
  el.style.display = '';
}

// ── Lightweight re-render: update colors/styles without rebuilding simulation ──
function _rerenderNodes() {
  refreshNodeColors();  // updates circles, FAM polygons, labels, 3D
}

// ── Full filter apply: recompute active data + restart simulation ──
function applyFilter() {
  // Close detail panel if selected person became hidden
  if (selectedIndiId && !isIndiVisible(selectedIndiId)) closeDetailPanel();
  computeActiveData();
  renderGraph();
  applyHighlight();          // re-apply any active ancestor/descendant highlight
  buildAndRunSimulation();   // restart physics on active nodes only
  // Both views draw the same filtered set now, so this is only about not paying
  // for a push while 3D is off screen; setView('3d') re-pushes on the way back.
  if (graph3d && currentView === '3d') {
    _push3DData();
    apply3DPhysics();  // calls applyTimelineYFix internally after graphData is set
    build3DTimeline();
    update3DNames();
  }
  updateFocusUI();
}

// ═══════════════════════════════════════════════════════════════
// 4. SVG INIT
// ═══════════════════════════════════════════════════════════════
function initSVG() {
  svgSel = d3.select('#graph-svg');
  svgSel.selectAll('*').remove();

  // Defs
  const defs = svgSel.append('defs');
  // Glow filter
  const flt = defs.append('filter').attr('id', 'glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
  flt.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '4').attr('result', 'blur');
  const merge = flt.append('feMerge');
  merge.append('feMergeNode').attr('in', 'blur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  gMain = svgSel.append('g').attr('class', 'main-g');

  let _labelRafPending = false;
  let _lastTransform = d3.zoomIdentity;

  zoomBehavior = d3.zoom()
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

      gMain.attr('transform', evt.transform);
      const prev = currentZoom;
      currentZoom = evt.transform.k;
      // Full label update only when crossing visibility thresholds; otherwise RAF-throttled
      const crossedThreshold = (prev < 0.35) !== (currentZoom < 0.35) ||
                               (prev < 1.1)  !== (currentZoom < 1.1);
      if (crossedThreshold) {
        updateLabels();
      } else if (!_labelRafPending) {
        _labelRafPending = true;
        requestAnimationFrame(() => { _labelRafPending = false; updateLabels(); });
      }
    });

  // Auto-recenter if graph centroid is way off-screen (prevents getting "lost")
  setInterval(() => {
    if (!svgSel || !nodes.length) return;
    const W = document.getElementById('graph-svg')?.clientWidth || 800;
    const H = document.getElementById('graph-svg')?.clientHeight || 600;
    const transform = d3.zoomTransform(svgSel.node());

    // Check if any nodes are visible in current viewport
    let anyVisible = false;
    const margin = 100; // Allow some overflow
    for (const n of nodes) {
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
    if (!anyVisible && nodes.length > 0) {
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
      svgSel.transition().duration(200).call(zoomBehavior.scaleBy, 1.3);
    } else if (e.key === '-') {
      e.preventDefault();
      svgSel.transition().duration(200).call(zoomBehavior.scaleBy, 1 / 1.3);
    }
  });

  svgSel.call(zoomBehavior);

  // Click on SVG background → deselect
  svgSel.on('click', evt => {
    if (evt.target === svgSel.node()) closeDetailPanel();
  });
}

// ═══════════════════════════════════════════════════════════════
// 5. RENDER GRAPH
// ═══════════════════════════════════════════════════════════════
function renderGraph() {
  console.time('[rg] clear');       gMain.selectAll('*').remove();                    console.timeEnd('[rg] clear');

  // Links layer — <path> so the tree layout can draw square elbows; the force
  // layout just emits a straight two-point path through the same element.
  console.time('[rg] links');
  linkSel = gMain.append('g').attr('class', 'links-g')
    .selectAll('path')
    .data(links)
    .join('path')
    .attr('fill', 'none')
    .attr('stroke', d => linkColor(d))
    .attr('stroke-dasharray', d => linkDash(d))
    .attr('stroke-width', d => linkWidth(d))
    .attr('opacity', d => linkBaseOpacity(d));
  console.timeEnd('[rg] links');

  // Nodes layer
  console.time('[rg] node join');
  const nodeG = gMain.append('g').attr('class', 'nodes-g');

  nodeSel = nodeG.selectAll('g.ng')
    .data(nodes, d => d.id)
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
    .on('dblclick', (evt, d) => {
      evt.stopPropagation();
      delete d.fx; delete d.fy;
      simulation.alpha(0.15).restart();
    })
    .call(d3.drag()
      .on('start', (evt, d) => {
        if (!_nodeDragEnabled) return;
        if (!evt.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (evt, d) => { if (_nodeDragEnabled) { d.fx = evt.x; d.fy = evt.y; } })
      .on('end', (evt) => { if (_nodeDragEnabled && !evt.active) simulation.alphaTarget(0); })
    );
  console.timeEnd('[rg] node join');

  // Draw shapes per node — batched selections instead of per-node .each()
  console.time('[rg] shapes');
  const indiSel = nodeSel.filter(d => d.type === 'INDI');
  const famSel  = nodeSel.filter(d => d.type === 'FAM');

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
  indiSel.filter(d => d.id === focusRootId)
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
    .attr('fill',   d => d.data.div ? nodeColors.famDiv : nodeColors.fam)
    .attr('stroke', d => d.data.div ? nodeColors.famDiv : nodeColors.fam)
    .attr('stroke-width',     d => d.data.div ? 1.5 : 1)
    .attr('stroke-dasharray', d => d.data.div ? '3 2' : null)
    .attr('opacity', 0.88);
  console.timeEnd('[rg] shapes');

  // Name label — lives inside the box (not a separate layer floating above
  // it), so it moves, scales and z-orders with the node for free.
  console.time('[rg] labels');
  labelSel = indiSel.append('text')
    .attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('dy', '-4px')
    .attr('fill', d => contrastTextColor(nodeBaseColor(d)))
    .attr('fill-opacity', labelStyle.textOpacity)
    .attr('font-size', NODE_BOX_FONT + 'px')
    .attr('font-weight', labelStyle.fontWeight || 'normal')
    .attr('pointer-events', 'none')
    .text(d => d.data.displayName);

  // Years on a second line under the name. Only for people who have one —
  // an empty element still costs a DOM node per person, and on a big chart
  // that is the difference between a snappy repaint and a stuttering one.
  yearSel = indiSel.filter(d => nodeYears(d.data))
    .append('text')
    .attr('class', 'node-years')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('dy', '7px')
    .attr('fill', d => contrastTextColor(nodeBaseColor(d)))
    .attr('fill-opacity', labelStyle.textOpacity * 0.75)
    .attr('font-size', NODE_YEAR_FONT + 'px')
    .attr('pointer-events', 'none')
    .text(d => nodeYears(d.data));

  console.timeEnd('[rg] labels');
  updateLabels();
}

// Smallest the name is allowed to shrink to before truncating is the better
// trade — below this it is a smudge and you may as well cut it and keep it
// legible.
const LABEL_MIN_FONT = 7;

// Fit a name inside the box. The old code budgeted characters from an average
// glyph width, which is wrong in both directions: "Wilhelmine Wyttenbach" ran
// past the edge while "Anna Ith" was cut short of it. Only the rendered width
// knows, so measure — shrink to fit if a little is needed, and truncate only
// what is still too long at the smallest readable size.
function _fitLabel(el, full, avail, size) {
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

function updateLabels() {
  if (!labelSel || labelSel.empty()) return;
  const zoom = currentZoom;
  // Below this the box itself is a few screen px wide — the name would just
  // be noise, so drop it rather than render illegible text.
  const hidden = zoom < 0.28;

  const weight = labelStyle.fontWeight || 'normal';

  labelSel.each(function(d) {
    this.setAttribute('fill',         contrastTextColor(nodeBaseColor(d)));
    this.setAttribute('fill-opacity', labelStyle.textOpacity);
    this.setAttribute('font-weight',  weight);

    if (hidden) { this.style.display = 'none'; return; }
    this.style.display = '';

    // Fitting is a property of the name and the box, not of the zoom, so it is
    // worked out once per name and remembered. updateLabels runs on every zoom
    // change and measuring text forces a layout — doing it here every time
    // would make panning stutter on a large chart.
    const full = d.data.displayName || '';
    const key = full + ' ' + weight;
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
  yearSel?.each(function(d) {
    this.setAttribute('fill',         contrastTextColor(nodeBaseColor(d)));
    this.setAttribute('fill-opacity', labelStyle.textOpacity * 0.75);
    this.style.display = zoom < 0.4 ? 'none' : '';
  });
}

// ═══════════════════════════════════════════════════════════════
// 6. FORCE SIMULATION
// ═══════════════════════════════════════════════════════════════
// opts.warm: reuse the existing simulation object + node positions and apply
// a gentle reheat, instead of building a brand-new simulation at alpha=1.
// Used for single edits so only the changed node(s) actually move.
function buildAndRunSimulation(opts = {}) {
  // Classical chart: positions are computed outright, so there is nothing to
  // simulate. Everything below (forces, warm reheat, headless ticking) is the
  // force layout's business only.
  if (useTreeLayout() && applyTreeLayout()) return;
  releaseTreePins();

  const warm = !!opts.warm && !!simulation;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth  || 1100;
  const H = svgEl.clientHeight || 700;

  // Keep birth year range for the 3D timeline
  const birthYears = nodes
    .filter(n => n.type === 'INDI' && n.data.birthYear)
    .map(n => n.data.birthYear);
  const minBY = birthYears.length ? Math.min(...birthYears) : 1750;
  const maxBY = birthYears.length ? Math.max(...birthYears) : 2025;
  _birthYearRange = { min: minBY, max: maxBY };

  // Compute estimated birth years for persons without one (uses generation & relation info)
  console.time('[sim] computeEstimatedYears'); computeEstimatedYears(); console.timeEnd('[sim] computeEstimatedYears');

  // Expand range to include estimated years so timeline covers everyone
  if (_estimatedYears && _estimatedYears.size) {
    let eMin = minBY, eMax = maxBY;
    for (const yr of _estimatedYears.values()) {
      if (yr < eMin) eMin = yr;
      if (yr > eMax) eMax = yr;
    }
    _birthYearRange = { min: eMin, max: eMax };
  }

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
  nodes.forEach(n => {
    if (n.x == null) {
      n.y = nodeTargetY(n);
      n.x = W * 0.2 + Math.random() * W * 0.6;
    }
  });

  // Focus mode: pin the focus person dead centre so the layout literally
  // grows around them instead of drifting off wherever the forces push it.
  // The _focusPinned flag is what lets us release a *previous* focus person
  // without touching pins the user made by dragging nodes.
  nodes.forEach(n => {
    if (n._focusPinned && n.id !== focusRootId) {
      delete n.fx; delete n.fy; delete n._focusPinned;
    }
  });
  if (focusRootId && currentView === '2d') {
    const root = nodes.find(n => n.id === focusRootId);
    if (root) { root.fx = W / 2; root.fy = H / 2; root._focusPinned = true; }
  }

  const p = physicsParams;

  if (warm) {
    // Same forces, same node/link objects where possible — just tell the
    // running simulation about the new node/link set and nudge it awake.
    simulation.nodes(nodes);
    simulation.force('link').links(links);
    simulation.force('fy').y(d => nodeTargetY(d));
    simulation.alphaDecay(p.alphaDecay).velocityDecay(p.velocityDecay);
    simulation.alpha(Math.max(simulation.alpha(), 0.3));
  } else {
    if (simulation) simulation.stop();
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links)
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
  if (nodes.length > HEADLESS_THRESHOLD || (currentView === '2d' && focusRootId)) {
    // Use a faster decay for headless layout — generation-depth pre-positioning
    // already places nodes well, so we only need enough ticks to detangle.
    const HEADLESS_DECAY = 0.05;
    simulation.stop().alphaDecay(HEADLESS_DECAY);
    const totalTicks = Math.ceil(Math.log(simulation.alphaMin() / simulation.alpha()) / Math.log(1 - HEADLESS_DECAY));
    console.log(`[sim] headless: ${nodes.length} nodes, ${links.length} links, ${totalTicks} ticks`);
    console.time('[sim] headless ticks');
    for (let i = 0; i < totalTicks; i++) simulation.tick();
    console.timeEnd('[sim] headless ticks');
    console.time('[sim] tick() DOM paint');  tick();     console.timeEnd('[sim] tick() DOM paint');
    console.time('[sim] onSimEnd');          onSimEnd(); console.timeEnd('[sim] onSimEnd');
  } else {
    simulation.on('tick', tick);
    simulation.on('end', onSimEnd);
    simulation.restart();
  }
}

// Hot-update all forces on the running simulation and reheat
function applyPhysicsParams() {
  if (!simulation) return;
  const p = physicsParams;

  simulation.force('link')
    .distance(d => d.ltype === 'spouse' ? p.spouseDist    : p.parentDist)
    .strength(d => d.ltype === 'spouse' ? p.spouseStrength : p.parentStrength);

  simulation.force('charge')
    .strength(d => d.type === 'FAM' ? -p.chargeFam : -p.chargeIndi)
    .distanceMax(p.chargeDistMax);

  simulation.force('collide')
    .radius(d => d.type === 'FAM' ? 9 : p.collideRadius);

  simulation.force('fy')
    .strength(p.yStrength);

  simulation.force('center')
    .strength(p.centerStrength);

  simulation
    .alphaDecay(p.alphaDecay)
    .velocityDecay(p.velocityDecay)
    .alpha(Math.max(simulation.alpha(), 0.25))
    .restart();

  document.getElementById('loading-overlay').style.display = 'none';
  if (graph3d) apply3DPhysics();
}

function reheatSimulation() {
  if (!simulation) return;
  simulation.alpha(0.5).restart();
}

let _autoSettleTimer   = null;
let _pendingDeleteId   = null;
let _pendingDeleteType = null;

function _settleBarRun(durationMs) {
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

function autoSettle() {
  if (_autoSettleTimer) { clearTimeout(_autoSettleTimer); _autoSettleTimer = null; }

  // alphaDecay=0.04 → sim dies in ~170 ticks ≈ 2.8s at 60fps
  const SETTLE_MS = 3000;
  _settleBarRun(SETTLE_MS);

  if (currentView === '3d') {
    if (!graph3d) return;
    graph3d.d3AlphaDecay(0.04);
    graph3d.d3ReheatSimulation();
    _autoSettleTimer = setTimeout(() => {
      if (graph3d) graph3d.d3AlphaDecay(physicsParams.alphaDecay);
      _autoSettleTimer = null;
    }, SETTLE_MS);
  } else {
    if (!simulation) return;
    const savedDecay = physicsParams.alphaDecay;
    simulation.alphaDecay(0.04).alpha(1).restart();
    _autoSettleTimer = setTimeout(() => {
      if (simulation) simulation.alphaDecay(savedDecay);
      _autoSettleTimer = null;
    }, SETTLE_MS);
  }
}

function resetPhysics() {
  physicsParams = { ...PHYSICS_DEFAULTS };
  syncPhysicsUI();
  applyPhysicsParams();
}

// Smooth S-curve through the family's shared bus height — the rounded
// "family tree app" look, in place of the old square elbow. Falls back to a
// straight segment within a row.
function _linkPath(d) {
  const sx = d.source.x ?? 0, sy = d.source.y ?? 0;
  const tx = d.target.x ?? 0, ty = d.target.y ?? 0;
  if (!useTreeLayout()) return `M${sx},${sy}L${tx},${ty}`;

  // Marriage line. The couple it joins is nearly always side by side, and then
  // the line belongs at their own height: almost all of it is hidden behind the
  // two boxes, and what shows is a short bar across the gap between them with
  // the marker on it — the marriage bar of a printed chart, which is quiet
  // enough to disappear into the drawing. Routing every one of them down into
  // the gap below instead hangs a visible bracket under every couple on the
  // chart, and a few dozen of those read as dashes strewn everywhere.
  //
  // Only when the two ends are further apart than a column can somebody else's
  // box be in between, and only then does the line have to drop out of the row
  // first. That case is rare and needs the detour; the common one does not.
  if (d.ltype === 'spouse') {
    const sameRow = Math.abs(ty - sy) < 1;
    if (Math.abs(tx - sx) <= TREE_COL_W * (sameRow ? 1.2 : 0.75)) {
      return sameRow ? `M${sx},${sy}L${tx},${ty}` : `M${sx},${sy}H${tx}V${ty}`;
    }
    const bar = sameRow ? sy + TREE_ROW_H * TREE_FAM_DY : ty;
    return `M${sx},${sy}V${bar}H${tx}V${ty}`;
  }

  // Child connector: down from the marriage marker to the family's sibling bar,
  // along it, then down to the child — the bracket of a printed chart, drawn as
  // a smooth S so the corners do not read as noise at small zoom.
  const sid = typeof d.source === 'object' ? d.source.id : d.source;
  const tid = typeof d.target === 'object' ? d.target.id : d.target;
  const bus = _treeBusY?.get(sid) ?? _treeBusY?.get(`${sid}~${tid}`);
  const my = bus != null && bus > Math.min(sy, ty) && bus < Math.max(sy, ty)
    ? bus
    : (sy + ty) / 2;
  return `M${sx},${sy}C${sx},${my} ${tx},${my} ${tx},${ty}`;
}

function tick() {
  if (!linkSel) return;
  linkSel.attr('d', _linkPath);

  nodeSel.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
}

function onSimEnd() {
  document.getElementById('loading-overlay').style.display = 'none';
  if (_firstLoad) {
    _firstLoad = false;
    if (currentView === '2d') {
      useTreeLayout() ? frameTreeChart() : zoomToFit();
    }
  }
}

// Minimum scale at which the 13px labels are still worth rendering.
const TREE_MIN_LEGIBLE_SCALE = 0.5;

// Framing for the classical chart. Fitting the whole thing is only right when
// it fits legibly: one sibship of forty is genuinely wider than any screen, and
// zoom-to-fit turns that into a row of dots. Below the legibility floor, open
// on the subject at a readable scale and let the user pan — which is how a
// printed chart is read anyway.
function frameTreeChart() {
  if (!nodes.length || !svgSel || !zoomBehavior) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth, H = svgEl.clientHeight;

  const xs = nodes.map(n => n.x).filter(v => v != null);
  const ys = nodes.map(n => n.y).filter(v => v != null);
  if (!xs.length) return;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);

  const fit = Math.min(W / ((x1 - x0) + 160), H / ((y1 - y0) + 160), 1.4);
  const legible = fit >= TREE_MIN_LEGIBLE_SCALE;
  const scale = legible ? fit : TREE_MIN_LEGIBLE_SCALE;

  // Centre the whole chart when it fits, otherwise centre the subject.
  const subject = nodes.find(n => n.id === focusRootId);
  const cx = legible || !subject ? (x0 + x1) / 2 : subject.x;
  const cy = legible || !subject ? (y0 + y1) / 2 : subject.y;

  svgSel.transition().duration(600).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(W / 2 - scale * cx, H / 2 - scale * cy).scale(scale)
  );
}

// ═══════════════════════════════════════════════════════════════
// 7. ZOOM HELPERS
// ═══════════════════════════════════════════════════════════════
function zoomToFit() {
  if (!nodes.length || !svgSel) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth, H = svgEl.clientHeight;

  const xs = nodes.map(n => n.x).filter(v => v != null);
  const ys = nodes.map(n => n.y).filter(v => v != null);
  if (!xs.length) return;

  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const dw = x1 - x0 || 1, dh = y1 - y0 || 1;

  const scale = Math.min(W / (dw + 60), H / (dh + 60), 3) * 0.92;
  const tx = W / 2 - scale * ((x0 + x1) / 2);
  const ty = H / 2 - scale * ((y0 + y1) / 2);

  svgSel.transition().duration(750)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

function svgZoomBy(factor) {
  if (svgSel && zoomBehavior) {
    svgSel.transition().duration(220).call(zoomBehavior.scaleBy, factor);
  }
}

function zoomToNode(nid) {
  const n = nodes.find(d => d.id === nid);
  if (!n || n.x == null) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth, H = svgEl.clientHeight;
  const scale = Math.max(currentZoom, 1.4);
  const tx = W / 2 - scale * n.x;
  const ty = H / 2 - scale * n.y;
  svgSel.transition().duration(550)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

// ── Center view / center on person (topbar buttons) ──
function centerView() {
  if (currentView === '3d' && graph3d) {
    _setOrbitTarget3D(null);           // orbit back to origin
    graph3d.zoomToFit(800, 60);
  } else {
    zoomToFit();
  }
}

function centerOnPerson() {
  if (!selectedIndiId) return;
  if (currentView === '3d' && graph3d) {
    _setOrbitTarget3D(selectedIndiId);
    // Also move the camera closer to the node
    const gd = graph3d.graphData();
    const node = gd.nodes.find(n => n.id === selectedIndiId);
    if (node && node.x != null) {
      const cam = graph3d.camera();
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
    zoomToNode(selectedIndiId);
  }
}

// ═══════════════════════════════════════════════════════════════
// 8. TOOLTIP
// ═══════════════════════════════════════════════════════════════
function onHover(evt, d) {
  const tt = document.getElementById('tooltip');
  let html = '';
  if (d.type === 'INDI') {
    const i = d.data;
    html = `<div class="tt-name">${escHtml(i.name || i.id)}</div>`;
    if (i.birth.date) {
      html += `<div class="tt-detail">* ${escHtml(i.birth.date)}${i.birth.plac ? ', ' + escHtml(i.birth.plac) : ''}</div>`;
    } else if (_estimatedYears && _estimatedYears.has(d.id)) {
      html += `<div class="tt-detail" style="color:#888">~${_estimatedYears.get(d.id)} (${t('detail.estimated')})</div>`;
    }
    if (i.deceased) {
      html += `<div class="tt-detail">† ${i.death.date ? escHtml(i.death.date) : t('tooltip.unknownDate')}</div>`;
    }
    if (i.occu) html += `<div class="tt-detail" style="color:#9f9f9f">${escHtml(i.occu)}</div>`;
    if (i.maidenName) html += `<div class="tt-detail" style="color:#888">${t('tooltip.born', { name: escHtml(i.maidenName) })}</div>`;
    else if (i.surn) html += `<div class="tt-detail" style="color:#888">${t('tooltip.familyName', { name: escHtml(i.surn) })}</div>`;
  } else {
    const f = d.data;
    const names = [f.husb, f.wife].filter(Boolean)
      .map(id => escHtml(individuals.get(id)?.name || id)).join(' &amp; ');
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

function onMove(evt) { positionTooltip(evt); }
function onOut() { document.getElementById('tooltip').style.display = 'none'; }

function positionTooltip(evt) {
  const tt = document.getElementById('tooltip');
  const margin = 12;
  let x = evt.clientX + margin;
  let y = evt.clientY - margin;
  if (x + 260 > window.innerWidth) x = evt.clientX - 260 - margin;
  if (y < 0) y = 0;
  tt.style.left = x + 'px';
  tt.style.top  = y + 'px';
}

// ═══════════════════════════════════════════════════════════════
// 9. DETAIL PANEL
// ═══════════════════════════════════════════════════════════════
function _updateCenterPersonBtn() {
  const btn = document.getElementById('center-person-btn');
  if (!btn) return;
  btn.disabled = !selectedIndiId;
  btn.classList.toggle('has-selection', !!selectedIndiId);
}

function showIndiDetail(id) {
  const indi = individuals.get(id);
  if (!indi) return;
  selectedIndiId = id;
  _updateCenterPersonBtn();

  document.getElementById('detail-name').textContent = indi.name || id;

  let html = '';

  // Sex + ID
  const sexLabel = indi.sex === 'M' ? t('detail.male') : indi.sex === 'F' ? t('detail.female') : t('detail.unknown');
  html += row(t('detail.sex'), sexLabel);

  // Birth
  if (indi.birth.date || indi.birth.plac) {
    html += row(t('detail.born'), fmtPlace(indi.birth.date, indi.birth.plac));
  } else if (_estimatedYears && _estimatedYears.has(id)) {
    html += row(t('detail.born'), `<span style="color:#888">~${_estimatedYears.get(id)} (${t('detail.estimated')})</span>`);
  }

  // Death
  if (indi.deceased) {
    const ds = fmtPlace(indi.death.date || t('tooltip.unknownDate'), indi.death.plac);
    const caus = indi.death.caus ? `<br><span style="color:#888;font-size:11px">${escHtml(indi.death.caus)}</span>` : '';
    html += row(t('detail.died'), ds + caus);
  }

  // Occupation
  if (indi.occu) html += row(t('detail.occupation'), escHtml(indi.occu));

  // Maiden name
  if (indi.maidenName) html += row(t('detail.maidenName'), escHtml(indi.maidenName));

  // Parents
  if (indi.famc.length) {
    html += `<div class="detail-section"><div class="detail-label">${t('detail.parents')}</div>`;
    for (const famId of indi.famc) {
      const fam = families.get(famId);
      if (!fam) continue;
      const ps = [fam.husb, fam.wife].filter(Boolean).map(pid => {
        const p = individuals.get(pid);
        return p
          ? `<span class="clickable-name" onclick="event.stopPropagation();showIndiDetail('${escJs(pid)}')">${escHtml(p.name)}</span>`
          : escHtml(pid);
      }).join(' &amp; ');
      html += `<div class="detail-marriage detail-fam-card" onclick="showFamDetail('${escJs(famId)}')" title="${t('detail.openFamily')}">${ps || `<em>${t('detail.unknownName')}</em>`}</div>`;
    }
    html += `</div>`;
  }

  // Marriages / partners
  if (indi.fams.length) {
    html += `<div class="detail-section"><div class="detail-label">${t('detail.marriages')}</div>`;
    for (const famId of indi.fams) {
      const fam = families.get(famId);
      if (!fam) continue;
      const spId = fam.husb === id ? fam.wife : fam.husb;
      const sp = spId ? individuals.get(spId) : null;
      const spName = sp
        ? `<span class="clickable-name" onclick="event.stopPropagation();showIndiDetail('${escJs(spId)}')">${escHtml(sp.name)}</span>`
        : (spId ? escHtml(spId) : `<em>${t('detail.unknownName')}</em>`);
      const m0 = fam.marriages?.[0];
      const mInfo = m0?.date ? ` &mdash; ⚭ ${escHtml(m0.date)}${m0.plac ? ', ' + escHtml(m0.plac) : ''}` : '';
      const dInfo = fam.div ? ` <span style="color:#787878">[${t('tooltip.divorced', { date: fam.divDate ? ' ' + escHtml(fam.divDate) : '' })}]</span>` : '';
      const kids = fam.chil.length ? `<br><span style="color:#888;font-size:11px">${fam.chil.length} ${fam.chil.length === 1 ? t('tooltip.child') : t('tooltip.children')}</span>` : '';
      html += `<div class="detail-marriage detail-fam-card" onclick="showFamDetail('${escJs(famId)}')" title="${t('detail.openFamily')}">${spName}${mInfo}${dInfo}${kids}</div>`;
    }
    html += `</div>`;
  }

  // Note
  if (indi.note) {
    html += row(t('detail.note'), `<span style="font-size:11px;color:#999">${escHtml(indi.note).replace(/\n/g, '<br>')}</span>`);
  }

  // Quick-add relative — one click from the read-only view, no need to enter edit mode
  html += `<div class="detail-section" style="border-top:1px solid #2e2e2e;padding-top:8px;margin-top:4px">
    <datalist id="ef-place-dl">${_buildPlaceDatalist()}</datalist>
    <div class="ef-rel-add-row">
      <button class="ef-new-person-btn" style="width:auto;flex:1;margin-top:0" onclick="toggleQuickAdd('parent')">&#xff0b; ${t('detail.addParent')}</button>
      <button class="ef-new-person-btn" style="width:auto;flex:1;margin-top:0" onclick="toggleQuickAdd('spouse')">&#xff0b; ${t('detail.addSpouse')}</button>
      <button class="ef-new-person-btn" style="width:auto;flex:1;margin-top:0" onclick="toggleQuickAdd('child')">&#xff0b; ${t('detail.addChild')}</button>
    </div>
    ${_quickAddFormHtml('parent', id)}
    ${_quickAddFormHtml('spouse', id)}
    ${_quickAddFormHtml('child', id)}
  </div>`;

  document.getElementById('detail-content').innerHTML = html;
  document.getElementById('delete-confirm-bar').style.display = 'none';
  document.getElementById('detail-edit-bar').style.display = 'block';
  document.getElementById('detail-buttons').style.display = 'flex';
  openPanel();
  updateHLButtons();
  flashNode(id);
  if (currentView === '3d') _setOrbitTarget3D(id);
}

const _QUICK_ADD_LABELS = { parent: 'detail.addParent', spouse: 'detail.addSpouse', child: 'detail.addChild' };

function _quickAddFormHtml(type, personId) {
  if (type === 'parent') return _quickAddParentFormHtml(personId);
  const defaultSurn = type === 'child' ? (individuals.get(personId)?.surn || '') : '';
  return `<div id="qa-${type}-form" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
    <div class="edit-label" style="margin-bottom:6px">${t('detail.newLabel', { type: t(_QUICK_ADD_LABELS[type]) })}</div>
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <input class="edit-input" id="qa-${type}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
      <input class="edit-input" id="qa-${type}-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr(defaultSurn)}">
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <select class="edit-select" id="qa-${type}-sex">
        <option value="U">${t('detail.sexPlaceholder')}</option>
        <option value="M">${t('detail.male')}</option>
        <option value="F">${t('detail.female')}</option>
      </select>
    </div>
    ${type === 'child' ? _personVitalsHtml('qa-child') + _inlineSpouseFormHtml('qa-child') : ''}
    <div style="display:flex;gap:6px;margin-top:8px">
      <button class="edit-save-btn" style="flex:1;padding:5px" onclick="confirmQuickAddRelative('${escJs(personId)}','${type}')">&#x2713; ${t('detail.add')}</button>
      <button class="edit-cancel-btn" style="flex:1;padding:5px" onclick="toggleQuickAdd('${type}')">${t('detail.cancel')}</button>
    </div>
  </div>`;
}

// Two-parent quick-add: entering both father and mother creates ONE family for
// both, instead of one click per parent fragmenting the person into two famc families.
function _quickAddParentFormHtml(personId) {
  const i = individuals.get(personId);
  const fam = i?.famc?.length ? families.get(i.famc[0]) : null;
  const husb = fam?.husb ? individuals.get(fam.husb) : null;
  const wife = fam?.wife ? individuals.get(fam.wife) : null;

  if (husb && wife) {
    return `<div id="qa-parent-form" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
      <div style="color:#888;font-size:11px">${t('detail.bothParentsSet')}</div>
    </div>`;
  }

  const slotHtml = (slot, label, existing, defaultSurn) => existing
    ? `<div class="edit-label" style="margin-top:6px">${label}</div>
       <div style="color:#888;font-size:11px;padding:4px 0">${escHtml(existing.name || existing.id)} ${t('detail.parentAlreadySet')}</div>`
    : `<div class="edit-label" style="margin-top:6px">${label}</div>
       <div style="display:flex;gap:6px;margin-bottom:4px">
         <input class="edit-input" id="qa-parent-${slot}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
         <input class="edit-input" id="qa-parent-${slot}-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr(defaultSurn)}">
       </div>
       ${_gedcomDateWidget('qa-parent-' + slot + '-bdate', '')}`;

  return `<div id="qa-parent-form" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
    <div class="edit-label" style="margin-bottom:6px">${t('detail.newLabel', { type: t('detail.addParent') })}</div>
    ${slotHtml('father', t('detail.relationVater'), husb, i?.surn || '')}
    ${slotHtml('mother', t('detail.relationMutter'), wife, '')}
    <div style="display:flex;gap:6px;margin-top:8px">
      <button class="edit-save-btn" style="flex:1;padding:5px" onclick="confirmQuickAddParents('${escJs(personId)}')">&#x2713; ${t('detail.add')}</button>
      <button class="edit-cancel-btn" style="flex:1;padding:5px" onclick="toggleQuickAdd('parent')">${t('detail.cancel')}</button>
    </div>
  </div>`;
}

function confirmQuickAddParents(personId) {
  const readSlot = slot => {
    if (!document.getElementById(`qa-parent-${slot}-givn`)) return null; // slot already filled, no inputs rendered
    const givn = document.getElementById(`qa-parent-${slot}-givn`)?.value.trim() || '';
    const surn = document.getElementById(`qa-parent-${slot}-surn`)?.value.trim() || '';
    if (!givn && !surn) return null;
    return { givn, surn, birthDate: _gedcomDateValue(`qa-parent-${slot}-bdate`) };
  };
  const father = readSlot('father');
  const mother = readSlot('mother');
  if (!father && !mother) {
    const el = document.getElementById('qa-parent-father-givn') || document.getElementById('qa-parent-mother-givn');
    if (el) { el.style.borderColor = '#787878'; setTimeout(() => { el.style.borderColor = ''; }, 1200); }
    return;
  }

  const fam = _findOrCreateFamAsChild(personId);
  let lastNewId = null;
  if (father && !fam.husb) {
    lastNewId = fam.husb = _makeNewIndi(father.givn, father.surn, 'M', { birthDate: father.birthDate });
    individuals.get(fam.husb).fams.push(fam.id);
  }
  if (mother && !fam.wife) {
    lastNewId = fam.wife = _makeNewIndi(mother.givn, mother.surn, 'F', { birthDate: mother.birthDate });
    individuals.get(fam.wife).fams.push(fam.id);
  }

  _fullRebuildGraph({ warm: true });
  showIndiDetail(personId);
  if (lastNewId) flashNode(lastNewId);
}

function toggleQuickAdd(type) {
  for (const t of ['parent', 'spouse', 'child']) {
    const sf = document.getElementById(`qa-${t}-form`);
    if (!sf) continue;
    if (t === type) {
      const visible = sf.style.display !== 'none';
      sf.style.display = visible ? 'none' : 'block';
      if (!visible) document.getElementById(`qa-${t}-givn`)?.focus();
    } else {
      sf.style.display = 'none';
    }
  }
}

function confirmQuickAddRelative(personId, type) {
  const givn = document.getElementById(`qa-${type}-givn`)?.value.trim() || '';
  const surn = document.getElementById(`qa-${type}-surn`)?.value.trim() || '';
  const sex  = document.getElementById(`qa-${type}-sex`)?.value || 'U';

  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    const el = document.getElementById(`qa-${type}-givn`);
    if (el) { el.style.borderColor = '#787878'; setTimeout(() => { el.style.borderColor = ''; }, 1200); }
    return;
  }

  const extra = type === 'child' ? _readPersonVitals('qa-child') : {};
  const newId = _makeNewIndi(givn, surn, sex, extra);

  // The UI is phrased from the viewed person's perspective ("add a spouse/child to
  // this person"), but _applyRelation's `type` describes personId's relation TO the
  // target — so "add a child" means personId is the PARENT of the new person.
  // ("Add parent" is handled separately by confirmQuickAddParents.)
  const relType = type === 'child' ? 'parent' : 'spouse';
  _applyRelation(personId, { targetId: newId, type: relType });

  if (type === 'child') _attachInlineSpouse(newId, _readInlineSpouse('qa-child'));

  _fullRebuildGraph({ warm: true });
  selectedIndiId = newId;
  _editingId    = newId;
  _editingType  = 'INDI';
  // Deliberately NOT _isNewRecord = true: the relation was already committed above
  // (not staged), so cancelling the new person's own edit form must not delete them
  // and leave the family record pointing at a dangling id.
  _isNewRecord = false;
  document.getElementById('detail-name').textContent = fullName;
  showIndiEditForm(newId);
}

function showFamDetail(id) {
  const fam = families.get(id);
  if (!fam) return;
  _lastShownFamId = id;
  selectedIndiId = null;

  const names = [fam.husb, fam.wife].filter(Boolean)
    .map(pid => individuals.get(pid)?.name || pid).join(' & ');
  document.getElementById('detail-name').textContent = t('detail.family') + (names ? ': ' + names : '');

  let html = '';
  (fam.marriages || []).forEach((m, i) => {
    if (!m.date && !m.plac && !m.types?.length) return;
    let marrVal = fmtPlace(m.date, m.plac);
    if (m.types?.length) marrVal += (marrVal ? ' &mdash; ' : '') + `<span style="color:#9f9f9f;font-size:11px">${escHtml(m.types.join(', '))}</span>`;
    const label = (fam.marriages.length > 1) ? t('detail.marriageN', { n: i + 1 }) : t('detail.marriage');
    html += row(label, marrVal);
  });
  if (fam.div) {
    const divTxt = `<span style="color:#787878">${t('tooltip.divorced', { date: fam.divDate ? ' &mdash; ' + escHtml(fam.divDate) : '' })}</span>`;
    html += row(t('detail.status'), divTxt);
  }

  const spouses = [fam.husb, fam.wife].filter(Boolean);
  if (spouses.length) {
    const sl = spouses.map(pid => {
      const p = individuals.get(pid);
      return p ? `<span class="clickable-name" onclick="showIndiDetail('${escJs(pid)}')">${escHtml(p.name)}</span>` : escHtml(pid);
    }).join(' &amp; ');
    html += row(t('detail.spouses'), sl);
  }

  if (fam.chil.length) {
    html += `<div class="detail-section"><div class="detail-label">${t('detail.children')} (${fam.chil.length})</div>`;
    for (const cid of fam.chil) {
      const c = individuals.get(cid);
      if (c) html += `<div class="detail-value"><span class="clickable-name" onclick="showIndiDetail('${escJs(cid)}')">${escHtml(c.name)}</span></div>`;
    }
    html += `</div>`;
  }

  document.getElementById('detail-content').innerHTML = html;
  document.getElementById('delete-confirm-bar').style.display = 'none';
  document.getElementById('detail-edit-bar').style.display = 'block';
  document.getElementById('detail-buttons').style.display = 'flex';
  openPanel();
  updateHLButtons();
}

function openPanel() {
  document.getElementById('main-layout').classList.add('panel-open');
  document.getElementById('detail-panel').classList.add('panel-visible');
  _hideReopenPill();
}
function closeDetailPanel() {
  document.getElementById('main-layout').classList.remove('panel-open');
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('panel-visible');
  panel.style.transform = '';   // clear any inline transform from swipe gesture
  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('delete-confirm-bar').style.display = 'none';
  _pendingDeleteId = null; _pendingDeleteType = null;
  selectedIndiId = null;
  _updateCenterPersonBtn();
  resetHighlight();
  if (currentView === '3d') _setOrbitTarget3D(null);
  _hideReopenPill();
}

// Minimize: hide the panel but keep the selection (mobile-friendly)
function minimizeDetailPanel() {
  document.getElementById('main-layout').classList.remove('panel-open');
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('panel-visible');
  panel.style.transform = '';
  // Don't clear selectedIndiId or highlights!
  _showReopenPill();
}

function reopenDetailPanel() {
  if (selectedIndiId) {
    openPanel();
    _hideReopenPill();
  }
}

function _isMobile() {
  return window.innerWidth <= 768;
}

function _showReopenPill() {
  let pill = document.getElementById('reopen-panel-pill');
  if (!pill) return;
  if (!selectedIndiId) { _hideReopenPill(); return; }
  const indi = individuals.get(selectedIndiId);
  const name = indi ? (indi.displayName || indi.name || selectedIndiId) : selectedIndiId;
  pill.textContent = '▲ ' + name;
  pill.style.display = 'block';
}

function _hideReopenPill() {
  const pill = document.getElementById('reopen-panel-pill');
  if (pill) pill.style.display = 'none';
}

function row(label, value) {
  return `<div class="detail-section">
    <div class="detail-label">${label}</div>
    <div class="detail-value">${value}</div>
  </div>`;
}

function fmtPlace(date, plac) {
  let s = escHtml(date || '');
  if (plac) s += (s ? ' &mdash; ' : '') + escHtml(plac);
  return s;
}

// ═══════════════════════════════════════════════════════════════
// 10. HIGHLIGHT SYSTEM
// ═══════════════════════════════════════════════════════════════
function flashNode(id) {
  if (!nodeSel) return;
  nodeSel.filter(d => d.id === id)
    .select('rect.indi-box')
    .attr('filter', 'url(#glow)')
    .transition().delay(700).duration(400)
    .attr('filter', null);
}

function collectAncestors(id, visited = new Set()) {
  if (visited.has(id)) return visited;
  visited.add(id);
  const indi = individuals.get(id);
  if (!indi) return visited;
  for (const famId of indi.famc) {
    visited.add(famId);
    const fam = families.get(famId);
    if (!fam) continue;
    [fam.husb, fam.wife].filter(Boolean).forEach(pid => collectAncestors(pid, visited));
  }
  return visited;
}

function collectDescendants(id, visited = new Set(), isRoot = true) {
  if (!isRoot && visited.has(id)) return visited;
  visited.add(id);
  const indi = individuals.get(id);
  if (!indi) return visited;
  for (const famId of indi.fams) {
    visited.add(famId);
    const fam = families.get(famId);
    if (!fam) continue;
    fam.chil.forEach(cid => collectDescendants(cid, visited, false));
  }
  return visited;
}

function _countPeople(idSet) {
  let n = 0;
  for (const id of idSet) if (individuals.has(id)) n++;
  return n;
}

function highlightMode(mode) {
  if (!selectedIndiId) return;

  // Toggle off if same mode + same source
  if (hlMode === mode) {
    resetHighlight();
    return;
  }

  hlMode = mode;
  hlSet = new Set();
  _hlAncestorCount   = 0;
  _hlDescendantCount = 0;

  if (mode === 'ancestors' || mode === 'both') {
    const aSet = new Set();
    collectAncestors(selectedIndiId, aSet);
    aSet.forEach(id => hlSet.add(id));
    _hlAncestorCount = _countPeople(aSet) - 1; // -1 to exclude self
  }
  if (mode === 'descendants' || mode === 'both') {
    const dSet = new Set();
    collectDescendants(selectedIndiId, dSet);
    dSet.forEach(id => hlSet.add(id));
    _hlDescendantCount = _countPeople(dSet) - 1; // -1 to exclude self
  }

  applyHighlight();
  updateHLButtons();
}

function applyHighlight() {
  if (!nodeSel) return;
  const hasHL = hlSet.size > 0;

  nodeSel.each(function(d) {
    const inHL = !hasHL || hlSet.has(d.id);
    const baseOp = (d.type === 'INDI' && d.data.deceased) ? 0.5 : 1.0;
    d3.select(this).selectAll('rect.indi-box, polygon')
      .attr('opacity', inHL ? baseOp : 0.07)
      .attr('filter', inHL && d.id === selectedIndiId ? 'url(#glow)' : null);
  });

  linkSel?.attr('opacity', d => {
    if (!hasHL) return linkBaseOpacity(d);
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return (hlSet.has(sid) && hlSet.has(tid)) ? 0.80 : 0.04;
  });

  const dim = d => (!hasHL || hlSet.has(d.id)) ? 1 : 0.07;
  labelSel?.attr('opacity', dim);
  yearSel?.attr('opacity', dim);
  refresh3D();
}

function resetHighlight() {
  hlMode = null;
  hlSet  = new Set();
  _hlAncestorCount   = 0;
  _hlDescendantCount = 0;
  applyHighlight();
  updateHLButtons();
  refreshNodeColors();
}

function refreshNodeColors() {
  if (!nodeSel) return;
  nodeSel.each(function(d) {
    if (d.type === 'INDI') {
      const col = nodeBaseColor(d);
      d3.select(this).select('rect.indi-box').attr('fill', col);
      // The years line is drawn in the same contrast colour as the name, so it
      // has to follow the fill too — left out, it stays readable against the
      // old colour and vanishes against the new one.
      d3.select(this).selectAll('text.node-label, text.node-years')
        .attr('fill', contrastTextColor(col));
    } else {
      const col = d.data.div ? nodeColors.famDiv : nodeColors.fam;
      d3.select(this).select('.fam-polygon')
        .attr('fill',   col)
        .attr('stroke', col);
    }
  });
  _applyFamNodeSize();
  updateLabels();
  refresh3D();
}

function _famNodeVal(n) {
  if (n.type !== 'FAM') return n.data.deceased ? 0.7 : 1;
  return Math.max(0.05, (famNodeSize / 7) * 0.4);
}

function _applyFamNodeSize() {
  // 2D: update SVG polygon points
  if (svgSel) {
    const s = famNodeSize;
    svgSel.selectAll('.fam-polygon')
      .attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`);
  }
  // 3D: update sphere volume via nodeVal
  if (graph3d) {
    graph3d.nodeVal(n => _famNodeVal(n));
  }
}

function updateHLButtons() {
  const hasSource = selectedIndiId != null;

  // Reset labels and active state
  const btnA = document.getElementById('btn-ancestors');
  const btnD = document.getElementById('btn-descendants');
  const btnB = document.getElementById('btn-both');
  [btnA, btnD, btnB].forEach(btn => {
    btn.disabled = !hasSource;
    btn.classList.remove('active');
  });
  btnA.textContent = '↑ ' + t('highlight.ancestors');
  btnD.textContent = '↓ ' + t('highlight.descendants');
  btnB.textContent = '↕ ' + t('highlight.both');

  const btnF = document.getElementById('btn-focus-2d');
  if (btnF) {
    btnF.disabled = !hasSource;
    btnF.textContent = '◎ ' + t('focus.btn');
    btnF.classList.toggle('active', hasSource && focusRootId === selectedIndiId);
  }

  // Apply counts and active class for current mode
  if (hlMode === 'ancestors') {
    btnA.textContent = `↑ ${t('highlight.ancestors')} (${_hlAncestorCount})`;
    btnA.classList.add('active');
  } else if (hlMode === 'descendants') {
    btnD.textContent = `↓ ${t('highlight.descendants')} (${_hlDescendantCount})`;
    btnD.classList.add('active');
  } else if (hlMode === 'both') {
    btnA.textContent = `↑ ${t('highlight.ancestors')} (${_hlAncestorCount})`;
    btnD.textContent = `↓ ${t('highlight.descendants')} (${_hlDescendantCount})`;
    btnB.classList.add('active');
  }

  // Summary line below the buttons
  const info = document.getElementById('hl-count-info');
  if (!info) return;
  if (!hlMode) {
    info.textContent = '';
    info.style.display = 'none';
  } else if (hlMode === 'ancestors') {
    info.textContent = t('highlight.ancestorsCount', { n: _hlAncestorCount });
    info.style.display = '';
  } else if (hlMode === 'descendants') {
    info.textContent = t('highlight.descendantsCount', { n: _hlDescendantCount });
    info.style.display = '';
  } else if (hlMode === 'both') {
    info.textContent = t('highlight.bothCount', { ancestors: _hlAncestorCount, descendants: _hlDescendantCount });
    info.style.display = '';
  }
}

// ═══════════════════════════════════════════════════════════════
// 11. SURNAME SIDEBAR
// ═══════════════════════════════════════════════════════════════
function buildSurnameList(sorted) {
  const container = document.getElementById('surname-list');
  container.innerHTML = '';
  for (const [surn, count] of sorted) {
    const isNoSurn = surn === null;
    // Use hash color as default, or custom color if set
    const color = isNoSurn ? '#888' : surnameColor(surn);
    const label = isNoSurn ? t('detail.noSurname') : surn;
    const title = isNoSurn ? t('detail.personsWithoutSurname') : escAttr(surn);

    const div = document.createElement('div');
    div.className = 'surname-item';

    if (isNoSurn) {
      // No color picker for "no surname" entry
      div.innerHTML = `
        <input type="checkbox" checked>
        <span class="surname-dot" style="background:${color};border:1px solid #666"></span>
        <span class="surname-label" title="${title}" style="font-style:italic;color:#999">${escHtml(label)}</span>
        <span class="surname-count">${count}</span>`;
    } else {
      // Color picker for surname entries
      const hasCustom = surnameCustomColors.has(surn);
      div.innerHTML = `
        <input type="checkbox" checked>
        <input type="color" class="surname-color-picker" value="${color}" title="${t('detail.chooseColor')}">
        <span class="surname-label" title="${title}">${escHtml(label)}</span>
        <span class="surname-count">${count}</span>`;

      const colorInput = div.querySelector('.surname-color-picker');

      // Color change handler
      colorInput.addEventListener('input', e => {
        setSurnameColor(surn, e.target.value);
        _rerenderNodes(); // Update colors without rebuilding simulation
      });

      // Right-click to reset to hash color
      colorInput.addEventListener('contextmenu', e => {
        e.preventDefault();
        setSurnameColor(surn, null); // Clear custom color
        colorInput.value = surnameHashColor(surn); // Reset to hash color
        _rerenderNodes();
      });
    }

    div.querySelector('input[type="checkbox"]').addEventListener('change', e => {
      surnameEnabled.set(isNoSurn ? null : surn, e.target.checked);
      applyFilter();
    });
    container.appendChild(div);
  }
}

function toggleAllSurnames(state) {
  surnameEnabled.forEach((_, k) => surnameEnabled.set(k, state));
  document.querySelectorAll('#surname-list input[type=checkbox]').forEach(cb => { cb.checked = state; });
  applyFilter();
}

// ═══════════════════════════════════════════════════════════════
// 12. SEARCH
// ═══════════════════════════════════════════════════════════════
document.getElementById('search-input').addEventListener('input', function () {
  const q = this.value.trim().toLowerCase();
  const box = document.getElementById('search-results');
  box.innerHTML = '';
  if (q.length < 2) return;

  const hits = [];
  for (const [id, indi] of individuals) {
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

// Close search results on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#search-input') && !e.target.closest('#search-results')) {
    document.getElementById('search-results').innerHTML = '';
  }
});

// ═══════════════════════════════════════════════════════════════
// 13. FILE LOADER — replaces the current dataset with .ged / .json / .yaml
// Called from the unified Import modal "Ersetzen" button.
// ═══════════════════════════════════════════════════════════════
function _loadDatasetFile(file) {
  if (!file) return;

  document.getElementById('status').textContent = t('graph.loading');
  document.getElementById('loading-overlay').style.display = 'flex';

  const reader = new FileReader();
  reader.onload = evt => {
    try {
      _nodeObjCache = new Map(); // fresh dataset: don't reuse positions from a possibly-unrelated previous one
      focusRootId = null;        // and no focus person carries over
      const ext = file.name.toLowerCase();
      if (ext.endsWith('.json')) {
        const result = GEDCOMModule.importJSON(evt.target.result);
        individuals.clear(); families.clear();
        result.individuals.forEach((v, k) => individuals.set(k, v));
        result.families.forEach((v, k) => families.set(k, v));
        otherLines = [];
      } else if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
        const result = GEDCOMModule.importYAML(evt.target.result);
        individuals.clear(); families.clear();
        result.individuals.forEach((v, k) => individuals.set(k, v));
        result.families.forEach((v, k) => families.set(k, v));
        otherLines = [];
      } else {
        parseGEDCOM(evt.target.result);
      }

      const iCount = individuals.size;
      const fCount = families.size;
      document.getElementById('status').textContent =
        t('topbar.statusLoaded', { persons: iCount, families: fCount });

      const sorted = buildSurnameColorMap();
      buildSurnameList(sorted);
      buildGraphData();
      initSVG();
      renderGraph();
      // Reset 3D state if re-loading
      if (_orbitControls3d) { _orbitControls3d.dispose(); _orbitControls3d = null; }
      if (graph3d) { graph3d.pauseAnimation(); graph3d = null; }
      _3dAmbientLight = null;
      _3dPointLight = null;

      _firstLoad = true;
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
      if (currentView === '3d') {
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
window._loadDatasetFile = _loadDatasetFile;

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// GEDCOM DATE WIDGET
// ═══════════════════════════════════════════════════════════════
const _GD_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function _safeId(gedcomId) {
  return String(gedcomId).replace(/[^a-zA-Z0-9]/g, '_');
}

function _parseGedcomDate(str) {
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

function _buildFamEditSections(personId) {
  const i = individuals.get(personId);
  if (!i || !i.fams.length) return `<div style="color:#555;font-size:11px;padding:2px 0">${t('detail.emptyMarriages')}</div>`;
  return i.fams.map(famId => {
    const fam = families.get(famId);
    if (!fam) return '';
    const spouseId = fam.husb === personId ? fam.wife : fam.husb;
    const spouse   = spouseId ? individuals.get(spouseId) : null;
    const spouseLbl = spouse ? escHtml(spouse.name) : (spouseId ? escHtml(spouseId) : `<em>${t('detail.unknownName')}</em>`);
    const sid = _safeId(famId);
    return `<div class="ef-fam-block">
      <div class="ef-fam-header">&#x26a1; ${spouseLbl}</div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.marriageDate')}</div>
        ${_gedcomDateWidget('ef-fam-' + sid + '-mdate', fam.marriages?.[0]?.date || '')}
      </div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.marriagePlace')}</div>
        <input class="edit-input" id="ef-fam-${sid}-mplac" list="ef-place-dl" autocomplete="off" value="${escAttr(fam.marriages?.[0]?.plac || '')}">
      </div>
      <label class="edit-checkbox-row">
        <input type="checkbox" id="ef-fam-${sid}-div"${fam.div ? ' checked' : ''}>
        ${t('detail.divorced')}
      </label>
    </div>`;
  }).join('');
}

function _gedcomDateWidget(fieldId, value) {
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

function _gedcomDateValue(fieldId) {
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

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttr(s) {
  return escHtml(s);
}
// For interpolating into a JS string literal inside an inline onclick="" attribute:
// backslash-escape first (so the JS engine sees \\ and \'), then entity-escape
// (so the HTML parser decodes back to the right characters before JS runs).
function escJs(s) {
  if (!s) return '';
  return escHtml(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

// ═══════════════════════════════════════════════════════════════
// GEDCOM SERIALIZER + DOWNLOAD  (delegates to GEDCOMModule)
// ═══════════════════════════════════════════════════════════════
function serializeGEDCOM() {
  return GEDCOMModule.serializeGEDCOM(individuals, families, otherLines);
}

function _downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function _baseFilename() {
  return (window._gedcomFilename || 'stammbaum').replace(/\.\w+$/i, '');
}

function downloadGEDCOM() {
  const text = serializeGEDCOM();
  _downloadBlob('﻿' + text, _baseFilename() + '_edited.ged', 'text/plain;charset=utf-8');
  _setDirty(false);
}

function downloadJSON() {
  const text = GEDCOMModule.exportJSON(individuals, families);
  _downloadBlob(text, _baseFilename() + '.famtree.json', 'application/json;charset=utf-8');
}

function downloadYAML() {
  const text = GEDCOMModule.exportYAML(individuals, families);
  _downloadBlob(text, _baseFilename() + '.famtree.yaml', 'text/yaml;charset=utf-8');
}

// ── Export dropdown ───────────────────────────────────────────
function toggleExportMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('export-dropdown');
  const open = dd.classList.toggle('open');
  if (open) {
    document.addEventListener('click', closeExportMenu, { once: true });
  }
}
function closeExportMenu() {
  document.getElementById('export-dropdown').classList.remove('open');
}

// ═══════════════════════════════════════════════════════════════
// GEDCOM EDIT FORMS
// ═══════════════════════════════════════════════════════════════
let _editingId   = null;   // INDI or FAM id currently being edited
let _editingType = null;   // 'INDI' | 'FAM'


// Pending relationships to be committed with the new/edited person
let _pendingRelations = [];   // [{ targetId, type: 'parent'|'child'|'spouse', isNew? }]
let _removedRelations = [];   // [{ targetId, type, famId }]
let _famEditRemovedChil = new Set(); // child IDs removed during fam edit
let _famEditPendingChil = [];        // [{id, name, isNew}] children added during fam edit
let _famEditMarriages   = [];        // working copy of marriages during fam edit
let _famEditNewPartner  = { husb: null, wife: null }; // stub person ids created inline for the partner slots

function _buildPersonDatalist(excludeId) {
  let opts = '';
  for (const [pid, p] of individuals) {
    if (pid === excludeId) continue;
    const yr = p.birthYear || (_estimatedYears?.get(pid));
    const maiden = p.maidenName ? ` (${t('tooltip.born', { name: p.maidenName })})` : '';
    const display = `${p.name || pid}${maiden}${yr ? ` *${yr}` : ''}`;
    opts += `<option value="${escAttr(display)}" data-id="${escAttr(pid)}">`;
  }
  return opts;
}

function _buildPlaceDatalist() {
  const places = new Set();
  for (const i of individuals.values()) {
    if (i.birth?.plac) places.add(i.birth.plac);
    if (i.death?.plac) places.add(i.death.plac);
  }
  for (const f of families.values()) {
    for (const m of f.marriages || []) if (m.plac) places.add(m.plac);
  }
  return [...places].sort().map(p => `<option value="${escAttr(p)}">`).join('');
}

function _resolvePersonInput(val) {
  if (!val) return null;
  val = val.trim();
  // Direct ID match
  if (individuals.has(val)) return val;
  // Strip maiden name / year suffix added by _buildPersonDatalist (e.g. "Name (geb. X) *1900")
  const baseName = val.replace(/\s*\([^)]*\)/, '').replace(/\s*\*\d{4}$/, '').trim();
  // Exact match on full datalist label or base name
  for (const [pid, p] of individuals) {
    const name = p.name || pid;
    if (name === val || name === baseName) return pid;
  }
  // Partial match on base name
  const lower = baseName.toLowerCase();
  for (const [pid, p] of individuals) {
    if ((p.name || pid).toLowerCase().includes(lower)) return pid;
  }
  return null;
}

function _renderPendingRelations() {
  const el = document.getElementById('ef-rel-list');
  if (!el) return;
  if (!_pendingRelations.length) {
    el.innerHTML = `<div style="color:#555;font-size:11px;padding:2px 0">${t('detail.emptyRelations')}</div>`;
    return;
  }
  const labels = { parent: t('detail.relationParent'), child: t('detail.relationChild'), spouse: t('detail.relationSpouse') };
  el.innerHTML = _pendingRelations.map((r, idx) => {
    const p = individuals.get(r.targetId);
    const name = p ? escHtml(p.name || r.targetId) : escHtml(r.targetId);
    const badge = r.isNew ? `<span class="ef-rel-new-badge">${t('import.newBadge')}</span>` : '';
    return `<div class="ef-rel-item">
      <span class="ef-rel-type">${labels[r.type]}</span>
      <span class="ef-rel-name">${name}${badge}</span>
      <button class="ef-rel-remove" onclick="removeRelation(${idx})" title="${t('import.unlinkTitle')}">&#x2715;</button>
    </div>`;
  }).join('');
}

function addRelation() {
  const input = document.getElementById('ef-rel-person');
  const typeEl = document.getElementById('ef-rel-type');
  if (!input || !typeEl) return;
  const type = typeEl.value;
  const targetId = _resolvePersonInput(input.value);
  if (!targetId) {
    input.style.borderColor = '#787878';
    setTimeout(() => { input.style.borderColor = ''; }, 1200);
    return;
  }
  if (_pendingRelations.some(r => r.targetId === targetId && r.type === type)) return;
  _pendingRelations.push({ targetId, type });
  input.value = '';
  _renderPendingRelations();
}

function removeRelation(idx) {
  const rel = _pendingRelations[idx];
  // If this was an inline-created stub, remove it from the individuals map
  if (rel?.isNew) individuals.delete(rel.targetId);
  _pendingRelations.splice(idx, 1);
  _renderPendingRelations();
}

function toggleNewPersonSubform() {
  const sf = document.getElementById('ef-new-person-subform');
  if (!sf) return;
  const visible = sf.style.display !== 'none';
  sf.style.display = visible ? 'none' : 'block';
  if (!visible) document.getElementById('ef-np-givn')?.focus();
}

function confirmNewPersonRelation() {
  const givn = document.getElementById('ef-np-givn')?.value.trim() || '';
  const surn = document.getElementById('ef-np-surn')?.value.trim() || '';
  const sex  = document.getElementById('ef-np-sex')?.value || 'U';
  const type = document.getElementById('ef-np-type')?.value || 'child';

  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    document.getElementById('ef-np-givn').style.borderColor = '#787878';
    setTimeout(() => { document.getElementById('ef-np-givn').style.borderColor = ''; }, 1200);
    return;
  }

  const newId = getNextIndiId();
  const displayName = fullName.length > 24
    ? (givn ? givn + (surn ? ' ' + surn[0] + '.' : '') : fullName.slice(0, 22) + '…')
    : fullName;

  individuals.set(newId, {
    id: newId, name: fullName, givn, surn, maidenName: '', sex,
    birth: { date: '', plac: '' },
    death: { date: '', plac: '', caus: '' },
    deceased: false, birthYear: null,
    famc: [], fams: [], occu: '', note: '', displayName,
  });

  _pendingRelations.push({ targetId: newId, type, isNew: true });
  _renderPendingRelations();

  // Reset and hide the subform
  document.getElementById('ef-np-givn').value = '';
  document.getElementById('ef-np-surn').value = '';
  document.getElementById('ef-np-sex').value  = 'U';
  document.getElementById('ef-new-person-subform').style.display = 'none';
}

function _getExistingRelations(id) {
  const i = individuals.get(id);
  if (!i) return [];
  const rels = [];
  // Parents: families where this person is a child
  for (const famId of i.famc) {
    const fam = families.get(famId);
    if (!fam) continue;
    if (fam.husb) rels.push({ type: 'parent', targetId: fam.husb, famId, label: t('detail.relationVater') });
    if (fam.wife) rels.push({ type: 'parent', targetId: fam.wife, famId, label: t('detail.relationMutter') });
  }
  // Spouses and children: families where this person is a spouse
  for (const famId of i.fams) {
    const fam = families.get(famId);
    if (!fam) continue;
    const spouseId = fam.husb === id ? fam.wife : fam.husb;
    if (spouseId) rels.push({ type: 'spouse', targetId: spouseId, famId, label: t('detail.relationEhepartner') });
    for (const childId of fam.chil) {
      rels.push({ type: 'child', targetId: childId, famId, label: t('detail.relationKind') });
    }
  }
  return rels;
}

function _renderExistingRelations(id) {
  const el = document.getElementById('ef-existing-rel-list');
  if (!el) return;
  const rels = _getExistingRelations(id).filter(
    r => !_removedRelations.some(rem => rem.targetId === r.targetId && rem.type === r.type && rem.famId === r.famId)
  );
  if (!rels.length) { el.innerHTML = ''; return; }
  el.innerHTML = rels.map((r, idx) => {
    const p = individuals.get(r.targetId);
    const name = p ? escHtml(p.displayName || p.name) : escHtml(r.targetId);
    return `<div class="ef-rel-item ef-existing-rel">
      <span class="ef-rel-type">${r.label}</span>
      <span class="ef-rel-name">${name}</span>
      <button class="ef-rel-remove" onclick="removeExistingRelation(${JSON.stringify(r).split('"').join("'")})" title="${t('import.unlinkTitle')}">&#x2715;</button>
    </div>`;
  }).join('');
}

function removeExistingRelation(r) {
  if (!_removedRelations.some(x => x.targetId === r.targetId && x.type === r.type && x.famId === r.famId)) {
    _removedRelations.push(r);
  }
  _renderExistingRelations(_editingId);
}

function showIndiEditForm(id) {
  const i = individuals.get(id);
  if (!i) return;

  _pendingRelations = [];
  _removedRelations = [];

  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('detail-buttons').style.display = 'none';

  const datalistHtml = _buildPersonDatalist(id);
  const placeDatalistHtml = _buildPlaceDatalist();

  document.getElementById('detail-content').innerHTML = `
    <div class="edit-section">
      <div class="edit-label">${t('detail.firstName')}</div>
      <input class="edit-input" id="ef-givn" value="${escAttr(i.givn)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.familyName')}</div>
      <input class="edit-input" id="ef-surn" value="${escAttr(i.surn)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.birthName')}</div>
      <input class="edit-input" id="ef-maiden" value="${escAttr(i.maidenName || '')}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.sex')}</div>
      <select class="edit-select" id="ef-sex">
        <option value="M"${i.sex==='M'?' selected':''}>${t('detail.male')}</option>
        <option value="F"${i.sex==='F'?' selected':''}>${t('detail.female')}</option>
        <option value="U"${i.sex==='U'||!i.sex?' selected':''}>${t('detail.unknown')}</option>
      </select>
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.birthDate')}</div>
      ${_gedcomDateWidget('ef-bdate', i.birth.date)}
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.birthPlace')}</div>
      <input class="edit-input" id="ef-bplac" list="ef-place-dl" autocomplete="off" value="${escAttr(i.birth.plac)}">
    </div>
    <label class="edit-checkbox-row">
      <input type="checkbox" id="ef-dead"${i.deceased?' checked':''} onchange="_toggleDeathFields(this.checked)">
      ${t('detail.deceased')}
    </label>
    <div id="ef-death-fields" style="display:${i.deceased ? 'block' : 'none'}">
      <div class="edit-section">
        <div class="edit-label">${t('detail.deathDate')}</div>
        ${_gedcomDateWidget('ef-ddate', i.death.date)}
      </div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.deathPlace')}</div>
        <input class="edit-input" id="ef-dplac" list="ef-place-dl" autocomplete="off" value="${escAttr(i.death.plac)}">
      </div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.causeOfDeath')}</div>
        <input class="edit-input" id="ef-dcaus" value="${escAttr(i.death.caus)}">
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.occupation')}</div>
      <input class="edit-input" id="ef-occu" value="${escAttr(i.occu)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.note')}</div>
      <textarea class="edit-textarea" id="ef-note">${escHtml(i.note)}</textarea>
    </div>
    <div class="edit-section" style="border-top:1px solid #2e2e2e;padding-top:8px;margin-top:4px">
      <div class="edit-label">${t('detail.marriages')}</div>
      <div id="ef-fam-sections">${_buildFamEditSections(id)}</div>
    </div>
    <div class="edit-section" style="border-top:1px solid #2e2e2e;padding-top:8px;margin-top:4px">
      <div class="edit-label">${t('detail.relations')}</div>
      <div id="ef-existing-rel-list" style="margin-bottom:4px"></div>
      <div id="ef-rel-list" style="margin-bottom:6px">
        <div style="color:#555;font-size:11px;padding:2px 0">${t('detail.emptyNewRelations')}</div>
      </div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-rel-person" list="ef-rel-datalist" placeholder="${t('detail.searchPerson')}" autocomplete="off">
        <datalist id="ef-rel-datalist">${datalistHtml}</datalist>
        <datalist id="ef-place-dl">${placeDatalistHtml}</datalist>
        <select class="edit-select" id="ef-rel-type" style="width:auto;min-width:100px">
          <option value="child">${t('detail.relationChild')}</option>
          <option value="parent">${t('detail.relationParent')}</option>
          <option value="spouse">${t('detail.relationSpouse')}</option>
        </select>
        <button class="ef-rel-add-btn" onclick="addRelation()" title="${t('detail.addRelation')}">+</button>
      </div>
      <button class="ef-new-person-btn" onclick="toggleNewPersonSubform()">&#xff0b; ${t('detail.createNewPerson')}</button>
      <div id="ef-new-person-subform" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
        <div class="edit-label" style="margin-bottom:6px">${t('detail.newPerson')}</div>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="edit-input" id="ef-np-givn" placeholder="${t('detail.firstName')}" style="flex:1">
          <input class="edit-input" id="ef-np-surn" placeholder="${t('detail.familyName')}" style="flex:1">
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <select class="edit-select" id="ef-np-sex" style="flex:1">
            <option value="U">${t('detail.sexPlaceholder')}</option>
            <option value="M">${t('detail.male')}</option>
            <option value="F">${t('detail.female')}</option>
          </select>
          <select class="edit-select" id="ef-np-type" style="flex:1">
            <option value="child">${t('detail.relationChild')}</option>
            <option value="parent">${t('detail.relationParent')}</option>
            <option value="spouse">${t('detail.relationSpouse')}</option>
          </select>
        </div>
        <div style="display:flex;gap:6px">
          <button class="edit-save-btn" style="flex:1;padding:5px" onclick="confirmNewPersonRelation()">&#x2713; ${t('detail.add')}</button>
          <button class="edit-cancel-btn" style="flex:1;padding:5px" onclick="toggleNewPersonSubform()">${t('detail.cancel')}</button>
        </div>
      </div>
    </div>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitIndiEdit()">&#x2713; ${t('detail.save')}</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">${t('detail.cancel')}</button>
    </div>`;

  _renderExistingRelations(id);
  _acAttachEditForm();
}

function _toggleDeathFields(checked) {
  const el = document.getElementById('ef-death-fields');
  if (el) el.style.display = checked ? 'block' : 'none';
}

function commitIndiEdit() {
  const i = individuals.get(_editingId);
  if (!i) return;

  const givn = document.getElementById('ef-givn').value.trim();
  const surn = document.getElementById('ef-surn').value.trim();

  i.givn       = givn;
  i.surn       = surn;
  i.maidenName = (document.getElementById('ef-maiden')?.value || '').trim();
  // Rebuild name from parts
  i.name = (givn ? givn + ' ' : '') + (surn ? surn : '');
  if (!i.name.trim()) i.name = _editingId.replace(/@/g, '');
  // Rebuild displayName
  i.displayName = i.name.length > 24
    ? (givn ? givn + (surn ? ' ' + surn[0] + '.' : '') : i.name.slice(0, 22) + '…')
    : i.name;

  i.sex        = document.getElementById('ef-sex').value;
  i.birth.date = _gedcomDateValue('ef-bdate');
  i.birth.plac = document.getElementById('ef-bplac').value.trim();
  i.deceased   = document.getElementById('ef-dead').checked;
  i.death.date = _gedcomDateValue('ef-ddate');
  i.death.plac = document.getElementById('ef-dplac').value.trim();
  i.death.caus = document.getElementById('ef-dcaus').value.trim();
  i.occu       = document.getElementById('ef-occu').value.trim();
  i.note       = document.getElementById('ef-note').value;

  // Re-extract birth year
  const ym = i.birth.date.match(/\b(\d{4})\b/);
  i.birthYear = ym ? +ym[1] : null;

  // ── Save inline family (marriage) edits ──
  for (const famId of i.fams) {
    const fam = families.get(famId);
    const sid = _safeId(famId);
    const mdateEl = document.getElementById('ef-fam-' + sid + '-mdate');
    if (fam && mdateEl) {
      if (!fam.marriages[0]) fam.marriages[0] = { date: '', plac: '', types: [] };
      fam.marriages[0].date = _gedcomDateValue('ef-fam-' + sid + '-mdate');
      fam.marriages[0].plac = (document.getElementById('ef-fam-' + sid + '-mplac')?.value || '').trim();
      fam.div       = document.getElementById('ef-fam-' + sid + '-div')?.checked ?? fam.div;
    }
  }

  // ── Process removed relationships ──
  for (const r of _removedRelations) {
    const fam = families.get(r.famId);
    if (!fam) continue;
    if (r.type === 'parent') {
      // Remove this person as a child from that family
      fam.chil = fam.chil.filter(c => c !== _editingId);
      i.famc = i.famc.filter(f => f !== r.famId);
      // Nullify the specific parent slot
      if (fam.husb === r.targetId) fam.husb = null;
      else if (fam.wife === r.targetId) fam.wife = null;
    } else if (r.type === 'spouse') {
      const spouse = individuals.get(r.targetId);
      fam.husb === _editingId ? (fam.husb = null) : (fam.wife = null);
      i.fams = i.fams.filter(f => f !== r.famId);
      if (spouse) spouse.fams = spouse.fams.filter(f => f !== r.famId);
    } else if (r.type === 'child') {
      const child = individuals.get(r.targetId);
      fam.chil = fam.chil.filter(c => c !== r.targetId);
      if (child) child.famc = child.famc.filter(f => f !== r.famId);
    }
    // Clean up empty families
    if (!fam.husb && !fam.wife && !fam.chil.length) {
      families.delete(r.famId);
      for (const [, p] of individuals) {
        p.famc = p.famc.filter(f => f !== r.famId);
        p.fams = p.fams.filter(f => f !== r.famId);
      }
    }
  }
  const hadRemovals = _removedRelations.length > 0;
  _removedRelations = [];

  // ── Process pending relationships ──
  const needsRebuild = _pendingRelations.length > 0 || hadRemovals;
  for (const rel of _pendingRelations) _applyRelation(_editingId, rel);
  _pendingRelations = [];

  const id = _editingId;
  _editingId = null; _editingType = null;

  _isNewRecord = false;
  if (needsRebuild) {
    document.getElementById('dl-wrap').style.display = 'flex';
    document.getElementById('center-view-btn').style.display = 'inline-block';
    document.getElementById('center-view-btn').disabled = false;
    document.getElementById('center-person-btn').style.display = 'inline-block';
    document.getElementById('relation-tool-btn').style.display = 'inline-block';
    document.getElementById('relation-tool-btn').disabled = false;
    document.getElementById('view-toggle-btn').disabled = false;
  }
  _fullRebuildGraph({ warm: true });
  showIndiDetail(id);
}

// Applies one relation ({targetId, type}) between editingPersonId and the target,
// wiring up famc/fams/husb/wife/chil directly on the model. Shared by commitIndiEdit's
// staged _pendingRelations loop and the instant one-click "add relative" flow.
function _applyRelation(editingPersonId, rel) {
  const i = individuals.get(editingPersonId);
  const target = individuals.get(rel.targetId);
  if (!i || !target) return;

  if (rel.type === 'child') {
    // New person is a CHILD OF target → target is parent
    // Find an existing family where target is husb or wife that we can add the child to
    let fam = _findOrCreateFamAsParent(rel.targetId);
    if (!fam.chil.includes(editingPersonId)) fam.chil.push(editingPersonId);
    if (!i.famc.includes(fam.id)) i.famc.push(fam.id);

  } else if (rel.type === 'parent') {
    // New person is a PARENT OF target → target is child
    let fam = _findOrCreateFamAsParent(editingPersonId);
    if (!fam.chil.includes(rel.targetId)) fam.chil.push(rel.targetId);
    if (!target.famc.includes(fam.id)) target.famc.push(fam.id);

  } else if (rel.type === 'spouse') {
    // Create a new family with both as spouses
    let existingFam = null;
    // Check if they already share a family as spouses
    for (const fid of i.fams) {
      const f = families.get(fid);
      if (!f) continue;
      if (f.husb === rel.targetId || f.wife === rel.targetId) { existingFam = f; break; }
    }
    if (!existingFam) {
      const famId = getNextFamId();
      const newFam = {
        id: famId, husb: null, wife: null, chil: [],
        marriages: [{ date: '', plac: '', types: [] }], div: false, divDate: ''
      };
      // Assign husb/wife based on sex
      if (i.sex === 'M') { newFam.husb = editingPersonId; newFam.wife = rel.targetId; }
      else if (i.sex === 'F') { newFam.wife = editingPersonId; newFam.husb = rel.targetId; }
      else if (target.sex === 'M') { newFam.husb = rel.targetId; newFam.wife = editingPersonId; }
      else if (target.sex === 'F') { newFam.wife = rel.targetId; newFam.husb = editingPersonId; }
      else { newFam.husb = editingPersonId; newFam.wife = rel.targetId; }
      families.set(famId, newFam);
      if (!i.fams.includes(famId)) i.fams.push(famId);
      if (!target.fams.includes(famId)) target.fams.push(famId);
    }
  }
}

// Helper: find an existing family where personId is husb or wife, or create one
function _findOrCreateFamAsParent(personId) {
  const person = individuals.get(personId);
  // Try to find an existing family where this person is a spouse
  for (const fid of (person?.fams || [])) {
    const f = families.get(fid);
    if (f) return f;
  }
  // Create a new family with this person as a spouse
  const famId = getNextFamId();
  const fam = {
    id: famId, husb: null, wife: null, chil: [],
    marriages: [{ date: '', plac: '', types: [] }], div: false, divDate: ''
  };
  if (person?.sex === 'F') fam.wife = personId;
  else fam.husb = personId;
  families.set(famId, fam);
  if (person && !person.fams.includes(famId)) person.fams.push(famId);
  return fam;
}

// Helper: find the family where personId is a child, or create one
function _findOrCreateFamAsChild(personId) {
  const person = individuals.get(personId);
  for (const fid of (person?.famc || [])) {
    const f = families.get(fid);
    if (f) return f;
  }
  const famId = getNextFamId();
  const fam = {
    id: famId, husb: null, wife: null, chil: [personId],
    marriages: [{ date: '', plac: '', types: [] }], div: false, divDate: ''
  };
  families.set(famId, fam);
  if (person && !person.famc.includes(famId)) person.famc.push(famId);
  return fam;
}

// Creates and registers a new INDI record; shared by every "create person inline" form.
function _makeNewIndi(givn, surn, sex, extra = {}) {
  const fullName = (givn + ' ' + surn).trim();
  const newId = getNextIndiId();
  const birthDate = extra.birthDate || '';
  // Same year-extraction as commitIndiEdit — without it birthYear stays null and
  // the graph label/position silently fall back to an *estimated* year instead
  // of the one just entered.
  const ym = birthDate.match(/\b(\d{4})\b/);
  individuals.set(newId, {
    id: newId, name: fullName, givn, surn, maidenName: '', sex,
    birth: { date: birthDate, plac: extra.birthPlac || '' },
    death: { date: extra.deathDate || '', plac: extra.deathPlac || '', caus: '' },
    deceased: !!extra.deceased, birthYear: ym ? +ym[1] : null, famc: [], fams: [], occu: '', note: '',
    displayName: fullName.length > 24 ? (givn || fullName.slice(0, 22) + '…') : fullName,
  });
  return newId;
}

// First/family name + sex fields, shared by every "create person inline" form.
function _personNameSexHtml(prefix, defaultSurn = '') {
  return `<div style="display:flex;gap:6px;margin-bottom:4px">
      <input class="edit-input" id="${prefix}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
      <input class="edit-input" id="${prefix}-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr(defaultSurn)}">
    </div>
    <select class="edit-select" id="${prefix}-sex" style="width:100%;margin-bottom:4px">
      <option value="U">${t('detail.sexSelect')}</option>
      <option value="M">${t('detail.maleCap')}</option>
      <option value="F">${t('detail.femaleCap')}</option>
    </select>`;
}

// Birth/death date+place fields, shared by every "create person inline" form.
// Requires a #ef-place-dl <datalist> to already be present in the surrounding form.
function _personVitalsHtml(prefix) {
  return `<div class="edit-label" style="font-size:11px;margin-top:4px">${t('detail.birthDate')}</div>
    ${_gedcomDateWidget(prefix + '-bdate', '')}
    <input class="edit-input" id="${prefix}-bplac" list="ef-place-dl" autocomplete="off" placeholder="${t('detail.birthPlace')}" style="margin-top:4px">
    <label class="edit-checkbox-row" style="margin-top:6px">
      <input type="checkbox" id="${prefix}-dead" onchange="document.getElementById('${prefix}-death-fields').style.display=this.checked?'block':'none'">
      ${t('detail.deceased')}
    </label>
    <div id="${prefix}-death-fields" style="display:none;margin-top:4px">
      <div class="edit-label" style="font-size:11px">${t('detail.deathDate')}</div>
      ${_gedcomDateWidget(prefix + '-ddate', '')}
      <input class="edit-input" id="${prefix}-dplac" list="ef-place-dl" autocomplete="off" placeholder="${t('detail.deathPlace')}" style="margin-top:4px">
    </div>`;
}
function _readPersonVitals(prefix) {
  const extra = {
    birthDate: _gedcomDateValue(prefix + '-bdate'),
    birthPlac: (document.getElementById(`${prefix}-bplac`)?.value || '').trim(),
  };
  if (document.getElementById(`${prefix}-dead`)?.checked) {
    extra.deceased = true;
    extra.deathDate = _gedcomDateValue(prefix + '-ddate');
    extra.deathPlac = (document.getElementById(`${prefix}-dplac`)?.value || '').trim();
  }
  return extra;
}

// Optional collapsible "+ Add spouse" block for a person being created inline
// (e.g. a new child) — lets a whole couple be entered in one form instead of
// creating the child, then switching to their detail view to add a partner.
function _inlineSpouseFormHtml(prefix) {
  return `<button type="button" class="ef-toggle-new-btn" onclick="_toggleInlineSpouseForm('${prefix}')" style="margin-top:8px">&#x2795; ${t('detail.addSpouse')}</button>
    <div id="${prefix}-sp-form" style="display:none;margin-top:6px;padding:8px;background:#161616;border:1px solid #2b2b2b;border-radius:6px">
      ${_personNameSexHtml(prefix + '-sp')}
      ${_personVitalsHtml(prefix + '-sp')}
      <div class="edit-label" style="font-size:11px;margin-top:8px">${t('detail.marriageDate')}</div>
      ${_gedcomDateWidget(prefix + '-sp-mdate', '')}
    </div>`;
}
function _toggleInlineSpouseForm(prefix) {
  const el = document.getElementById(`${prefix}-sp-form`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function _readInlineSpouse(prefix) {
  const givn = document.getElementById(`${prefix}-sp-givn`)?.value.trim() || '';
  const surn = document.getElementById(`${prefix}-sp-surn`)?.value.trim() || '';
  if (!givn && !surn) return null;
  const sex = document.getElementById(`${prefix}-sp-sex`)?.value || 'U';
  const marriageDate = _gedcomDateValue(`${prefix}-sp-mdate`);
  return { givn, surn, sex, marriageDate, ..._readPersonVitals(prefix + '-sp') };
}
function _resetGedcomDateWidget(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  const p = el.querySelector('.gd-prefix'); if (p) p.value = '';
  const d = el.querySelector('.gd-day');    if (d) d.value = '';
  const m = el.querySelector('.gd-month');  if (m) m.value = '';
  const y = el.querySelector('.gd-year');   if (y) y.value = '';
}

// Clears a _personNameSexHtml/_personVitalsHtml block's inputs back to blank,
// so a form that stays open (e.g. family edit) is ready for the next entry.
// Without this, a leftover birth/death date from the previous person would
// silently carry over onto the next one added in the same session.
function _resetPersonFormFields(prefix) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set(`${prefix}-givn`, '');
  set(`${prefix}-surn`, '');
  set(`${prefix}-sex`, 'U');
  set(`${prefix}-bplac`, '');
  set(`${prefix}-dplac`, '');
  _resetGedcomDateWidget(`${prefix}-bdate`);
  _resetGedcomDateWidget(`${prefix}-ddate`);
  _resetGedcomDateWidget(`${prefix}-mdate`); // no-op unless prefix is a spouse block
  const dead = document.getElementById(`${prefix}-dead`);
  if (dead) dead.checked = false;
  const df = document.getElementById(`${prefix}-death-fields`);
  if (df) df.style.display = 'none';
}

// Creates the spouse and a new FAM linking them to personId as a couple.
function _attachInlineSpouse(personId, spouse) {
  if (!spouse) return null;
  const spouseId = _makeNewIndi(spouse.givn, spouse.surn, spouse.sex, spouse);
  const person = individuals.get(personId);
  const famId = getNextFamId();
  const fam = { id: famId, husb: null, wife: null, chil: [], marriages: [{ date: spouse.marriageDate || '', plac: '', types: [] }], div: false, divDate: '' };
  if (person.sex === 'M') { fam.husb = personId; fam.wife = spouseId; }
  else if (person.sex === 'F') { fam.wife = personId; fam.husb = spouseId; }
  else if (spouse.sex === 'M') { fam.husb = spouseId; fam.wife = personId; }
  else if (spouse.sex === 'F') { fam.wife = spouseId; fam.husb = personId; }
  else { fam.husb = personId; fam.wife = spouseId; }
  families.set(famId, fam);
  person.fams.push(famId);
  individuals.get(spouseId).fams.push(famId);
  return spouseId;
}

const _FAM_MARR_TYPES = [
  { val: 'civil',         label: 'marriageType.civil' },
  { val: 'kirchlich',     label: 'marriageType.kirchlich' },
  { val: 'partnerschaft', label: 'marriageType.partnerschaft' },
  { val: 'eheähnlich',   label: 'marriageType.eheaehnlich' },
];

function showFamEditForm(id) {
  const f = families.get(id);
  if (!f) return;

  _famEditRemovedChil = new Set();
  _famEditPendingChil = [];
  _famEditNewPartner  = { husb: null, wife: null };

  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('detail-buttons').style.display = 'none';

  const dl = _buildPersonDatalist(null);
  const placeDl = _buildPlaceDatalist();
  const husbName = f.husb ? (individuals.get(f.husb)?.name || f.husb) : '';
  const wifeName = f.wife ? (individuals.get(f.wife)?.name || f.wife) : '';

  _famEditMarriages = (f.marriages && f.marriages.length)
    ? f.marriages.map(m => ({ date: m.date || '', plac: m.plac || '', types: [...(m.types || [])] }))
    : [{ date: '', plac: '', types: [] }];

  document.getElementById('detail-content').innerHTML = `
    <div class="edit-section">
      <div class="edit-label">${t('detail.partner1')}</div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-husb" list="ef-husb-dl" value="${escAttr(husbName)}" placeholder="${t('detail.searchPerson')}" autocomplete="off">
        <datalist id="ef-husb-dl">${dl}</datalist>
        <button class="ef-rel-remove" onclick="document.getElementById('ef-husb').value=''" title="${t('import.unlinkTitle')}">&#x2715;</button>
      </div>
      ${_famEditNewPartnerFormHtml('husb')}
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.partner2')}</div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-wife" list="ef-wife-dl" value="${escAttr(wifeName)}" placeholder="${t('detail.searchPerson')}" autocomplete="off">
        <datalist id="ef-wife-dl">${dl}</datalist>
        <button class="ef-rel-remove" onclick="document.getElementById('ef-wife').value=''" title="${t('import.unlinkTitle')}">&#x2715;</button>
      </div>
      ${_famEditNewPartnerFormHtml('wife')}
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.ceremonies')}</div>
      <datalist id="ef-place-dl">${placeDl}</datalist>
      <div id="ef-fam-marr-list"></div>
      <button class="ef-toggle-new-btn" onclick="_famEditAddMarr()" style="margin-top:4px">&#x2795; ${t('detail.addCeremony')}</button>
    </div>
    <div class="edit-section">
      <label class="edit-checkbox-row" style="margin-bottom:4px">
        <input type="checkbox" id="ef-div"${f.div ? ' checked' : ''} onchange="_famEditToggleDivDate(this.checked)">
        ${t('detail.divorced')}
      </label>
      <div id="ef-div-date-row" style="display:${f.div ? 'block' : 'none'}">
        <div class="edit-label" style="margin-top:4px">${t('detail.divorceDate')}</div>
        ${_gedcomDateWidget('ef-divdate', f.divDate || '')}
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.children')}</div>
      <div id="ef-fam-chil-list"></div>
      <div class="ef-rel-add-row" style="margin-top:4px">
        <input class="edit-input" id="ef-fam-chil-search" list="ef-fam-chil-dl" placeholder="${t('detail.searchChild')}" autocomplete="off">
        <datalist id="ef-fam-chil-dl">${dl}</datalist>
        <button class="ef-rel-add-btn" onclick="_famEditAddChild()" title="${t('detail.addChildTitle')}">+</button>
      </div>
      <button class="ef-toggle-new-btn" onclick="_famEditToggleNewChild()" style="margin-top:4px">&#x2795; ${t('detail.newChild')}</button>
      <div id="ef-fam-new-child-form" style="display:none;margin-top:6px">
        <div class="ef-rel-add-row">
          <input class="edit-input" id="ef-fnc-givn" placeholder="${t('detail.firstName')}" style="flex:1">
          <input class="edit-input" id="ef-fnc-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr((f.husb && individuals.get(f.husb)?.surn) || (f.wife && individuals.get(f.wife)?.surn) || '')}">
        </div>
        <div class="ef-rel-add-row" style="margin-top:4px">
          <select class="edit-select" id="ef-fnc-sex" style="flex:1">
            <option value="U">${t('detail.sexSelect')}</option>
            <option value="M">${t('detail.maleCap')}</option>
            <option value="F">${t('detail.femaleCap')}</option>
          </select>
        </div>
        ${_personVitalsHtml('ef-fnc')}
        ${_inlineSpouseFormHtml('ef-fnc')}
        <button class="ef-rel-add-btn" onclick="_famEditCreateChild()" title="${t('detail.addChildTitle')}" style="width:100%;padding:5px;margin-top:6px">${t('detail.add')}</button>
      </div>
    </div>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitFamEdit()">&#x2713; ${t('detail.save')}</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">${t('detail.cancel')}</button>
    </div>`;

  _famEditRenderMarriages();
  _famEditRenderChildren(f);
}

const _FAM_PARTNER_PREFIX = { husb: 'nh', wife: 'nw' };

function _famEditNewPartnerFormHtml(slot) {
  const p = _FAM_PARTNER_PREFIX[slot];
  return `<button class="ef-toggle-new-btn" onclick="_famEditToggleNewPartner('${slot}')" style="margin-top:4px">&#x2795; ${t('detail.newPerson')}</button>
    <div id="ef-new-${slot}-form" style="display:none;margin-top:6px">
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-${p}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
        <input class="edit-input" id="ef-${p}-surn" placeholder="${t('detail.familyName')}" style="flex:1">
      </div>
      <div class="ef-rel-add-row" style="margin-top:4px">
        <select class="edit-select" id="ef-${p}-sex" style="flex:1">
          <option value="U">${t('detail.sexSelect')}</option>
          <option value="M">${t('detail.maleCap')}</option>
          <option value="F">${t('detail.femaleCap')}</option>
        </select>
        <button class="ef-rel-add-btn" onclick="_famEditCreatePartner('${slot}')" title="${t('detail.add')}" style="width:auto;padding:0 10px">${t('detail.add')}</button>
      </div>
    </div>`;
}

function _famEditToggleNewPartner(slot) {
  const sf = document.getElementById(`ef-new-${slot}-form`);
  if (!sf) return;
  const showing = sf.style.display !== 'none';
  sf.style.display = showing ? 'none' : 'block';
  if (!showing) document.getElementById(`ef-${_FAM_PARTNER_PREFIX[slot]}-givn`)?.focus();
}

function _famEditCreatePartner(slot) {
  const p = _FAM_PARTNER_PREFIX[slot];
  const givn = document.getElementById(`ef-${p}-givn`)?.value.trim() || '';
  const surn = document.getElementById(`ef-${p}-surn`)?.value.trim() || '';
  const sex  = document.getElementById(`ef-${p}-sex`)?.value || 'U';
  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    const el = document.getElementById(`ef-${p}-givn`);
    if (el) { el.style.borderColor = '#787878'; setTimeout(() => { el.style.borderColor = ''; }, 1200); }
    return;
  }
  // Discard a stub from a previous "new person" click on this slot that never got saved
  if (_famEditNewPartner[slot]) individuals.delete(_famEditNewPartner[slot]);

  _famEditNewPartner[slot] = _makeNewIndi(givn, surn, sex);

  document.getElementById(slot === 'husb' ? 'ef-husb' : 'ef-wife').value = fullName;
  document.getElementById(`ef-${p}-givn`).value = '';
  document.getElementById(`ef-${p}-surn`).value = '';
  document.getElementById(`ef-${p}-sex`).value  = 'U';
  document.getElementById(`ef-new-${slot}-form`).style.display = 'none';
}

function _famEditRenderMarriages() {
  const el = document.getElementById('ef-fam-marr-list');
  if (!el) return;
  el.innerHTML = _famEditMarriages.map((m, i) => {
    const typesHtml = _FAM_MARR_TYPES.map(mt =>
      `<label class="fam-type-check"><input type="checkbox" data-marr-idx="${i}" data-marr-type="${escAttr(mt.val)}"${m.types.includes(mt.val) ? ' checked' : ''}> ${escHtml(t(mt.label))}</label>`
    ).join('');
    const canRemove = _famEditMarriages.length > 1;
    return `<div class="fam-marr-block">
      <div class="fam-marr-block-header">
        <span>${t('detail.marriageN', { n: i + 1 })}</span>
        ${canRemove ? `<button class="ef-rel-remove" onclick="_famEditRemoveMarr(${i})" title="${t('import.unlinkTitle')}">&#x2715;</button>` : ''}
      </div>
      <div class="fam-type-checks" style="margin-bottom:6px">${typesHtml}</div>
      <div class="edit-label" style="font-size:11px">${t('detail.date')}</div>
      ${_gedcomDateWidget('ef-marr-' + i + '-date', m.date)}
      <div class="edit-label" style="font-size:11px;margin-top:4px">${t('detail.place')}</div>
      <input class="edit-input" id="ef-marr-${i}-plac" list="ef-place-dl" autocomplete="off" value="${escAttr(m.plac)}" placeholder="${t('detail.place')}">
    </div>`;
  }).join('');
}

function _famEditAddMarr() {
  _famEditSyncMarriagesFromDom();
  _famEditMarriages.push({ date: '', plac: '', types: [] });
  _famEditRenderMarriages();
}

function _famEditRemoveMarr(idx) {
  _famEditSyncMarriagesFromDom();
  _famEditMarriages.splice(idx, 1);
  _famEditRenderMarriages();
}

function _famEditSyncMarriagesFromDom() {
  _famEditMarriages.forEach((m, i) => {
    m.date = _gedcomDateValue('ef-marr-' + i + '-date');
    m.plac = (document.getElementById('ef-marr-' + i + '-plac')?.value || '').trim();
    m.types = [...document.querySelectorAll(`input[data-marr-idx="${i}"][data-marr-type]:checked`)].map(cb => cb.dataset.marrType);
  });
}

function _famEditToggleDivDate(checked) {
  const row = document.getElementById('ef-div-date-row');
  if (row) row.style.display = checked ? 'block' : 'none';
}

function _famEditRenderChildren(f) {
  const el = document.getElementById('ef-fam-chil-list');
  if (!el) return;
  const existing = (f.chil || [])
    .filter(cid => !_famEditRemovedChil.has(cid))
    .map(cid => {
      const p = individuals.get(cid);
      const name = p ? escHtml(p.name || cid) : escHtml(cid);
      return `<div class="ef-rel-item">
        <span class="ef-rel-name">${name}</span>
        <button class="ef-rel-remove" onclick="_famEditRemoveChild('${escJs(cid)}')" title="${t('import.unlinkTitle')}">&#x2715;</button>
      </div>`;
    });
  const pending = _famEditPendingChil.map((c, i) => {
    return `<div class="ef-rel-item">
      <span class="ef-rel-name">${escHtml(c.name)}</span>
      <span class="ef-rel-new-badge">${t('import.newBadge')}</span>
      <button class="ef-rel-remove" onclick="_famEditRemovePending(${i})" title="${t('import.unlinkTitle')}">&#x2715;</button>
    </div>`;
  });
  el.innerHTML = (existing.length || pending.length)
    ? existing.join('') + pending.join('')
    : `<div style="color:#555;font-size:11px;padding:2px 0">${t('detail.noChildren')}</div>`;
}

function _famEditRemoveChild(cid) {
  _famEditRemovedChil.add(cid);
  const f = families.get(_editingId);
  if (f) _famEditRenderChildren(f);
}

function _famEditRemovePending(idx) {
  const removed = _famEditPendingChil.splice(idx, 1)[0];
  if (removed?.isNew) individuals.delete(removed.id);
  const f = families.get(_editingId);
  if (f) _famEditRenderChildren(f);
}

function _famEditAddChild() {
  const inp = document.getElementById('ef-fam-chil-search');
  if (!inp) return;
  const val = inp.value.trim();
  if (!val) return;
  const id = _resolvePersonInput(val);
  if (!id) { inp.style.borderColor = '#787878'; setTimeout(() => { inp.style.borderColor = ''; }, 1200); return; }
  const f = families.get(_editingId);
  if (!f) return;
  if (f.chil.includes(id) && !_famEditRemovedChil.has(id)) return;
  if (_famEditPendingChil.some(c => c.id === id)) return;
  const p = individuals.get(id);
  _famEditPendingChil.push({ id, name: p?.name || id, isNew: false });
  _famEditRemovedChil.delete(id);
  inp.value = '';
  _famEditRenderChildren(f);
}

function _famEditToggleNewChild() {
  const sf = document.getElementById('ef-fam-new-child-form');
  if (!sf) return;
  sf.style.display = sf.style.display === 'none' ? 'block' : 'none';
  if (sf.style.display !== 'none') document.getElementById('ef-fnc-givn')?.focus();
}

function _famEditCreateChild() {
  const givn = document.getElementById('ef-fnc-givn')?.value.trim() || '';
  const surn = document.getElementById('ef-fnc-surn')?.value.trim() || '';
  const sex  = document.getElementById('ef-fnc-sex')?.value || 'U';
  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    document.getElementById('ef-fnc-givn').style.borderColor = '#787878';
    setTimeout(() => { document.getElementById('ef-fnc-givn').style.borderColor = ''; }, 1200);
    return;
  }
  const newId = _makeNewIndi(givn, surn, sex, _readPersonVitals('ef-fnc'));
  _attachInlineSpouse(newId, _readInlineSpouse('ef-fnc'));
  _famEditPendingChil.push({ id: newId, name: fullName, isNew: true });
  _resetPersonFormFields('ef-fnc');
  _resetPersonFormFields('ef-fnc-sp');
  document.getElementById('ef-fnc-sp-form').style.display = 'none';
  document.getElementById('ef-fam-new-child-form').style.display = 'none';
  const f = families.get(_editingId);
  if (f) _famEditRenderChildren(f);
}

function commitFamEdit() {
  const f = families.get(_editingId);
  if (!f) return;

  // Marriages
  _famEditSyncMarriagesFromDom();
  f.marriages = _famEditMarriages.filter(m => m.date || m.plac || m.types.length);
  if (!f.marriages.length) f.marriages = [{ date: '', plac: '', types: [] }];
  _famEditMarriages = [];

  // Divorce
  f.div     = document.getElementById('ef-div').checked;
  f.divDate = f.div ? _gedcomDateValue('ef-divdate') : '';

  // Parents
  const oldHusb = f.husb;
  const oldWife = f.wife;
  const husbVal = document.getElementById('ef-husb').value.trim();
  const wifeVal = document.getElementById('ef-wife').value.trim();
  // Only re-resolve a slot from its text when it actually changed. Otherwise
  // a same-named person elsewhere in the tree ("+ New Person" stub, or just a
  // duplicate name) would win the fuzzy text search and silently bump the
  // untouched original spouse out of the family.
  const resolveSlot = (slot, val, oldId) => {
    const stubId = _famEditNewPartner[slot];
    if (stubId && individuals.get(stubId)?.name === val) return stubId;
    if (oldId && individuals.get(oldId)?.name === val) return oldId;
    return _resolvePersonInput(val);
  };
  f.husb = husbVal ? (resolveSlot('husb', husbVal, oldHusb) || f.husb) : null;
  f.wife = wifeVal ? (resolveSlot('wife', wifeVal, oldWife) || f.wife) : null;

  // Discard inline-created partner stubs that ended up unused (field was cleared/retyped)
  for (const slot of ['husb', 'wife']) {
    const stubId = _famEditNewPartner[slot];
    if (stubId && stubId !== f.husb && stubId !== f.wife) individuals.delete(stubId);
  }
  _famEditNewPartner = { husb: null, wife: null };

  if (oldHusb !== f.husb) {
    if (oldHusb) { const p = individuals.get(oldHusb); if (p) p.fams = p.fams.filter(fid => fid !== _editingId); }
    if (f.husb)  { const p = individuals.get(f.husb);  if (p && !p.fams.includes(_editingId)) p.fams.push(_editingId); }
  }
  if (oldWife !== f.wife) {
    if (oldWife) { const p = individuals.get(oldWife); if (p) p.fams = p.fams.filter(fid => fid !== _editingId); }
    if (f.wife)  { const p = individuals.get(f.wife);  if (p && !p.fams.includes(_editingId)) p.fams.push(_editingId); }
  }

  // Remove children
  for (const cid of _famEditRemovedChil) {
    f.chil = f.chil.filter(c => c !== cid);
    const c = individuals.get(cid);
    if (c) c.famc = c.famc.filter(fid => fid !== _editingId);
  }

  // Add pending children
  for (const { id: cid } of _famEditPendingChil) {
    if (!f.chil.includes(cid)) f.chil.push(cid);
    const c = individuals.get(cid);
    if (c && !c.famc.includes(_editingId)) c.famc.push(_editingId);
  }

  _famEditRemovedChil = new Set();
  _famEditPendingChil = [];

  const id = _editingId;
  _editingId = null; _editingType = null;
  _fullRebuildGraph({ warm: true });
  showFamDetail(id);
}

function cancelEdit() {
  const id = _editingId;
  _editingId = null; _editingType = null;
  for (const rel of _pendingRelations) {
    if (rel.isNew) individuals.delete(rel.targetId);
  }
  _pendingRelations = [];
  _removedRelations = [];
  for (const c of _famEditPendingChil) {
    if (c.isNew) individuals.delete(c.id);
  }
  _famEditPendingChil = [];
  _famEditRemovedChil = new Set();
  _famEditMarriages   = [];
  for (const slot of ['husb', 'wife']) {
    if (_famEditNewPartner[slot]) individuals.delete(_famEditNewPartner[slot]);
  }
  _famEditNewPartner = { husb: null, wife: null };
  if (_isNewRecord) {
    _isNewRecord = false;
    // Discard the stub record that was created for this cancelled new entry
    individuals.delete(id);
    closeDetailPanel();
    return;
  }
  if (id) {
    if (individuals.has(id)) showIndiDetail(id);
    else showFamDetail(id);
  } else {
    closeDetailPanel();
  }
}

function deleteCurrentRecord() {
  const id   = selectedIndiId || _lastShownFamId;
  const type = selectedIndiId ? 'INDI' : 'FAM';
  if (!id) return;
  _pendingDeleteId   = id;
  _pendingDeleteType = type;
  const name = type === 'INDI'
    ? (individuals.get(id)?.name || id)
    : (() => { const f = families.get(id); return t('detail.family') + (f ? ': ' + [f.husb, f.wife].filter(Boolean).map(p => individuals.get(p)?.name || p).join(' & ') : ''); })();
  document.getElementById('delete-confirm-msg').textContent = t('detail.deleteConfirm', { name });
  document.getElementById('delete-confirm-bar').style.display = 'flex';
  document.getElementById('detail-edit-bar').style.display   = 'none';
}

function cancelDeleteRecord() {
  _pendingDeleteId = null; _pendingDeleteType = null;
  document.getElementById('delete-confirm-bar').style.display = 'none';
  document.getElementById('detail-edit-bar').style.display   = 'block';
}

function confirmDeleteRecord() {
  const id   = _pendingDeleteId;
  const type = _pendingDeleteType;
  _pendingDeleteId = null; _pendingDeleteType = null;
  document.getElementById('delete-confirm-bar').style.display = 'none';

  if (type === 'INDI') {
    // Remove person from all families
    for (const [famId, fam] of families) {
      if (fam.husb === id) fam.husb = null;
      if (fam.wife === id) fam.wife = null;
      fam.chil = fam.chil.filter(c => c !== id);
    }
    // Remove empty families
    for (const [famId, fam] of [...families]) {
      if (!fam.husb && !fam.wife && fam.chil.length === 0) {
        families.delete(famId);
        for (const indi of individuals.values()) {
          indi.famc = indi.famc.filter(f => f !== famId);
          indi.fams = indi.fams.filter(f => f !== famId);
        }
      }
    }
    individuals.delete(id);
  } else {
    // Remove FAM — clean up member refs
    const fam = families.get(id);
    if (fam) {
      for (const pid of [fam.husb, fam.wife].filter(Boolean)) {
        const p = individuals.get(pid);
        if (p) p.fams = p.fams.filter(f => f !== id);
      }
      for (const cid of fam.chil) {
        const c = individuals.get(cid);
        if (c) c.famc = c.famc.filter(f => f !== id);
      }
    }
    families.delete(id);
  }

  closeDetailPanel();
  _fullRebuildGraph({ warm: true });
}

function startEdit() {
  const famId = _lastShownFamId;
  const indiId = selectedIndiId;
  if (indiId && individuals.has(indiId)) {
    _editingId = indiId; _editingType = 'INDI';
    showIndiEditForm(indiId);
  } else if (famId && families.has(famId)) {
    _editingId = famId; _editingType = 'FAM';
    showFamEditForm(famId);
  }
}
let _lastShownFamId = null;

// ═══════════════════════════════════════════════════════════════
// ADD PERSON
// ═══════════════════════════════════════════════════════════════
function getNextIndiId() {
  let i = 1;
  while (individuals.has(`@I${i}@`)) i++;
  return `@I${i}@`;
}

function getNextFamId() {
  let i = 1;
  while (families.has(`@F${i}@`)) i++;
  return `@F${i}@`;
}

function addNewPerson() {
  const id = getNextIndiId();
  individuals.set(id, {
    id, name: '', givn: '', surn: '', maidenName: '', sex: 'U',
    birth: { date: '', plac: '' },
    death: { date: '', plac: '', caus: '' },
    deceased: false, birthYear: null,
    famc: [], fams: [], occu: '', note: '', displayName: ''
  });
  _isNewRecord  = true;
  _editingId    = id;
  _editingType  = 'INDI';
  document.getElementById('detail-name').textContent = t('detail.newPerson');
  document.getElementById('detail-edit-bar').style.display  = 'none';
  document.getElementById('detail-buttons').style.display   = 'none';
  openPanel();
  showIndiEditForm(id);
}

// ═══════════════════════════════════════════════════════════════
// PHYSICS PRESETS
// ═══════════════════════════════════════════════════════════════
const PRESETS_KEY = 'stammbaum_physics_presets_v1';

const BUILTIN_PRESETS = {
  'Standard':  { spouseDist:50,  parentDist:65,  spouseStrength:0.45, parentStrength:0.65, chargeIndi:170, chargeFam:25, chargeDistMax:380, collideRadius:16, yStrength:0.35, centerStrength:0.04, velocityDecay:0.40, alphaDecay:0.028 },
  'Baum':      { spouseDist:42,  parentDist:80,  spouseStrength:0.55, parentStrength:0.85, chargeIndi:190, chargeFam:15, chargeDistMax:420, collideRadius:18, yStrength:0.55, centerStrength:0.05, velocityDecay:0.44, alphaDecay:0.025 },
  'Kompakt':   { spouseDist:26,  parentDist:36,  spouseStrength:0.82, parentStrength:0.92, chargeIndi:65,  chargeFam:8,  chargeDistMax:170, collideRadius:10, yStrength:0.50, centerStrength:0.08, velocityDecay:0.50, alphaDecay:0.030 },
  'Locker':    { spouseDist:95,  parentDist:115, spouseStrength:0.25, parentStrength:0.30, chargeIndi:340, chargeFam:55, chargeDistMax:680, collideRadius:28, yStrength:0.18, centerStrength:0.02, velocityDecay:0.34, alphaDecay:0.022 },
  'Zeitlinie': { spouseDist:50,  parentDist:65,  spouseStrength:0.28, parentStrength:0.48, chargeIndi:140, chargeFam:18, chargeDistMax:340, collideRadius:16, yStrength:0.75, centerStrength:0.03, velocityDecay:0.42, alphaDecay:0.025 },
  'Spiral':    { spouseDist:60,  parentDist:70,  spouseStrength:0.35, parentStrength:0.55, chargeIndi:220, chargeFam:30, chargeDistMax:500, collideRadius:20, yStrength:0.20, centerStrength:0.08, velocityDecay:0.38, alphaDecay:0.020 },
};

function getUserPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); }
  catch { return {}; }
}

function savePreset() {
  const name = document.getElementById('preset-name-input').value.trim();
  if (!name) return;
  const all = getUserPresets();
  all[name] = { ...physicsParams };
  localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
  document.getElementById('preset-name-input').value = '';
  renderPresetList();
}

function deletePreset(name) {
  const all = getUserPresets();
  delete all[name];
  localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
  renderPresetList();
}

function applyPreset(name, builtin) {
  const src = builtin ? BUILTIN_PRESETS[name] : getUserPresets()[name];
  physicsParams = { ...PHYSICS_DEFAULTS, ...src };
  syncPhysicsUI();
  applyPhysicsParams();
}

function renderPresetList() {
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

// ═══════════════════════════════════════════════════════════════
// 3D VIEW
// ═══════════════════════════════════════════════════════════════

function toggleView() { setView(currentView === '2d' ? '3d' : '2d'); }

// Single entry point for 2D↔3D. Both views read the same `nodes`/`links`, but
// the 2D one is focus-filtered, so switching has to recompute the active data
// and re-run whichever layout is now on screen.
function setView(view) {
  if (view !== '2d' && view !== '3d') return;
  if (!allNodes.length) return;

  const changed = view !== currentView;
  currentView = view;
  localStorage.setItem('viewMode', view);
  updateViewToggleUI();               // swaps containers + 3D-only sidebar rows

  if (view === '3d') {
    if (changed) computeActiveData();   // focus filter no longer applies — restore full set
    if (!graph3d) {
      initGraph3D();
    } else {
      graph3d.resumeAnimation();
      resize3D();
      if (changed) {
        _push3DData(); apply3DPhysics(); build3DTimeline(); update3DNames();
        // Re-pushing restarts the 3D layout, so the old camera no longer frames
        // anything — refit once it has had a moment to spread out.
        setTimeout(() => graph3d?.zoomToFit(700, 80), 900);
      }
    }
    setTimeout(() => {
      if (selectedIndiId) _setOrbitTarget3D(selectedIndiId);
      else if (_orbitControls3d) _orbitControls3d.target.copy(_graphCentroid3D());
    }, 200);
  } else {
    if (graph3d) graph3d.pauseAnimation();

    // A 2D view of a big tree with no focus is an unreadable dust cloud, so
    // never enter one: fall back to the selected person, else the best hub.
    // Trees that fit inside the budget need no focus at all.
    if (!focusRootId && individuals.size > focusLimit) {
      focusRootId = selectedIndiId || _defaultFocusRoot();
    }

    if (changed) {
      computeActiveData();
      if (!svgSel) initSVG();
      renderGraph();
      applyHighlight();
      _firstLoad = true;              // makes onSimEnd auto-fit the new layout
      buildAndRunSimulation();
    }
  }

  updateFocusUI();
  updateHLButtons();
}

// These labels are built in JS, so data-i18n can't retranslate them.
window._onLanguageChanged = () => {
  updateViewToggleUI();
  updateFocusUI();
  updateHLButtons();
};

function _push3DData() {
  if (!graph3d) return;
  graph3d.graphData({
    nodes: nodes.map(n => ({ id: n.id, type: n.type, data: n.data })),
    links: links.map(l => ({
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
      ltype:  l.ltype,
    })),
  });
}

// Single place that makes the DOM agree with `currentView`: containers,
// topbar button label, and the sidebar rows that only mean something in 3D.
function updateViewToggleUI() {
  const in3d = currentView === '3d';

  const c2d = document.getElementById('graph-container');
  const c3d = document.getElementById('graph-3d-container');
  if (c2d) c2d.style.display = in3d ? 'none' : 'block';
  if (c3d) c3d.style.display = in3d ? 'block' : 'none';

  const rows = {
    'sort-time-3d-row':  'flex',
    'show-names-3d-row': 'flex',
    'time-spread-row':   sortByTime3D ? 'block' : 'none',
  };
  for (const [id, shown] of Object.entries(rows)) {
    const el = document.getElementById(id);
    if (el) el.style.display = in3d ? shown : 'none';
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

// ── 2D focus controls ──

// Rebuild the 2D view after a focus change. `_firstLoad` is the existing
// "zoom to fit once the simulation settles" flag — a new focus set is a new
// layout, so it deserves the same framing a freshly loaded file gets.
function _refocus() {
  _firstLoad = true;
  applyFilter();
  updateFocusUI();
  updateHLButtons();
}

// Focus the 2D view on a person, switching to 2D if needed.
// Focusing is filtering, so it applies wherever you are: no view switch, the
// view you are in narrows to that person's relatives.
function focusOnPerson(id) {
  if (!id || !individuals.has(id)) return;
  if (id !== focusRootId) _revealed.clear();   // expansions belonged to the old chart
  focusRootId = id;
  _refocus();
}

function clearFocus() {
  if (!focusRootId) return;
  focusRootId = null;
  _revealed.clear();
  _refocus();
}

function setCousinDegree(v) {
  cousinDegree = Math.max(0, Math.min(4, parseInt(v)));
  if (!Number.isFinite(cousinDegree)) cousinDegree = 1;
  localStorage.setItem('cousinDegree', cousinDegree);
  const out = document.getElementById('cousin-degree-val');
  if (out) out.textContent = t('focus.cousinLevel' + cousinDegree);
  if (focusRootId) _refocus();
}

function setFocusLimit(v) {
  focusLimit = Math.max(10, parseInt(v) || 120);
  localStorage.setItem('focusLimit', focusLimit);
  const out = document.getElementById('focus-limit-val');
  if (out) out.textContent = focusLimit;
  if (focusRootId) _refocus();
}

function updateFocusUI() {
  const panel = document.getElementById('focus-panel');
  if (!panel) return;
  // The panel starts hidden in the markup and used to be revealed by the same
  // line that hid it again in 3D. It belongs to both views now, so it is simply
  // shown once there is a tree to focus within.
  panel.style.display = individuals.size ? '' : 'none';

  const nameEl   = document.getElementById('focus-current-name');
  const hiddenEl = document.getElementById('focus-hidden-info');
  const clearBtn = document.getElementById('focus-clear-btn');
  if (!nameEl) return;

  if (focusRootId && individuals.has(focusRootId)) {
    nameEl.textContent = individuals.get(focusRootId).displayName || focusRootId;
    nameEl.classList.remove('focus-none');
    if (clearBtn) clearBtn.style.display = '';
    const hidden = focusHiddenCount();
    if (hiddenEl) {
      hiddenEl.textContent = hidden ? t('focus.hidden', { n: hidden }) : t('focus.allShown');
      hiddenEl.style.display = '';
    }
  } else {
    nameEl.textContent = t('focus.none');
    nameEl.classList.add('focus-none');
    if (clearBtn) clearBtn.style.display = 'none';
    if (hiddenEl) { hiddenEl.textContent = ''; hiddenEl.style.display = 'none'; }
  }
}

function resize3D() {
  if (!graph3d) return;
  const el = document.getElementById('graph-3d-container');
  graph3d.width(el.clientWidth).height(el.clientHeight);
}

function compute3DNodeColor(n) {
  const hasHL = hlSet.size > 0;
  if (hasHL && !hlSet.has(n.id)) return '#0d0d0d';
  return nodeBaseColor(n);
}


function initGraph3D() {
  const container = document.getElementById('graph-3d-container');
  container.innerHTML = '';

  // Build 3D node and link arrays (keep data references intact)
  const gNodes = nodes.map(n => ({
    id:   n.id,
    type: n.type,
    data: n.data,
  }));
  const gLinks = links.map(l => ({
    source: typeof l.source === 'object' ? l.source.id : l.source,
    target: typeof l.target === 'object' ? l.target.id : l.target,
    ltype:  l.ltype,
  }));

  // Track mouse/touch for tooltip positioning
  container.addEventListener('mousemove', e => {
    _3dMousePos.x = e.clientX;
    _3dMousePos.y = e.clientY;
  });
  container.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      _3dMousePos.x = e.touches[0].clientX;
      _3dMousePos.y = e.touches[0].clientY;
    }
  }, { passive: true });

  graph3d = ForceGraph3D()(container)
    .backgroundColor(_3dAppearance.bgColor)
    .width(container.clientWidth)
    .height(container.clientHeight)
    .graphData({ nodes: gNodes, links: gLinks })
    // ── Nodes ──
    .nodeColor(n => compute3DNodeColor(n))
    .nodeVal(n => _famNodeVal(n))
    .nodeRelSize(_3dAppearance.nodeRelSize)
    .nodeOpacity(_3dAppearance.nodeOpacity)
    .nodeResolution(12)
    .nodeLabel(n => {
      if (n.type !== 'INDI') return '';
      const i = n.data;
      let born = i.birthYear ? ` *${i.birthYear}` : '';
      if (!born && _estimatedYears && _estimatedYears.has(n.id)) born = ` ~${_estimatedYears.get(n.id)}`;
      const died = i.deceased
        ? (i.death.date ? ` †${i.death.date.match(/\d{4}/)?.[0] || ''}` : ' †')
        : '';
      return `<span style="background:rgba(20,20,20,.92);padding:3px 7px;border-radius:3px;font-size:12px;color:#e0e0e0">${escHtml(i.displayName || i.name)}${born}${died}</span>`;
    })
    // ── Links ──
    .linkColor(l => linkColor(l))
    .linkWidth(_3dAppearance.linkWidth)
    .linkOpacity(_3dAppearance.linkOpacity)
    // ── Events ──
    .onNodeClick((n, evt) => {
      if (evt) evt.stopPropagation();
      if (n.type === 'INDI' && _tryPickRelationPerson(n.id)) return;
      if (n.type === 'INDI') showIndiDetail(n.id);
      else showFamDetail(n.id);
      _setOrbitTarget3D(n.type === 'INDI' ? n.id : null);
    })
    .onNodeHover(n => {
      if (n) {
        const fakeEvt = { clientX: _3dMousePos.x, clientY: _3dMousePos.y };
        onHover(fakeEvt, n);
      } else {
        onOut();
      }
    })
    .onBackgroundClick(() => { _isMobile() ? minimizeDetailPanel() : closeDetailPanel(); })
    .enableNodeDrag(_nodeDragEnabled);

  // Delay setup so the library's internal controls finish initialising first
  setTimeout(() => {
    if (!graph3d) return;

    // ── Swap TrackballControls → OrbitControls (keeps Y-axis upright) ──
    const old = graph3d.controls();
    old.dispose();

    const cam = graph3d.camera();
    const domEl = graph3d.renderer().domElement;

    _orbitControls3d = new THREE.OrbitControls(cam, domEl);
    _orbitControls3d.enableDamping  = true;
    _orbitControls3d.dampingFactor  = 0.10;
    _orbitControls3d.rotateSpeed    = 0.5;
    _orbitControls3d.panSpeed       = 0.9;
    _orbitControls3d.enableZoom     = true;    // needed for touch dolly; wheel intercepted below
    _orbitControls3d.enablePan      = true;
    _orbitControls3d.minDistance    = 1;
    _orbitControls3d.maxDistance    = Infinity;
    // Touch: 1-finger = ROTATE, 2-finger = DOLLY (zoom) + PAN
    if (_orbitControls3d.touches) {
      _orbitControls3d.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      };
    }
    cam.up.set(0, 1, 0);
    _orbitControls3d.update();

    // Zoom toward cursor position (scroll wheel) — capture phase + stopImmediatePropagation
    // so our custom zoom-to-cursor fires instead of OrbitControls' default wheel zoom
    domEl.addEventListener('wheel', (evt) => {
      evt.stopImmediatePropagation();
      _onWheel3D(evt);
    }, { passive: false, capture: true });

    // Before a rotate drag starts, pull the pivot back onto the tree
    // (pan/zoom can leave the orbit target floating in empty space)
    domEl.addEventListener('pointerdown', (evt) => {
      if (evt.button === 0) _snapOrbitPivot3D();
    });

    // Redirect the render-loop's update() call to our OrbitControls + orbit target tracking
    old.update = () => { _tickOrbitTarget(); _orbitControls3d.update(); };

    // ── Lighting setup — replace ForceGraph3D defaults ──
    const scene = graph3d.scene();
    // Remove existing lights
    const oldLights = [];
    scene.traverse(obj => { if (obj.isLight) oldLights.push(obj); });
    oldLights.forEach(l => { if (l.parent) l.parent.remove(l); });

    // Add controllable ambient light
    _3dAmbientLight = new THREE.AmbientLight(0xffffff, _3dAppearance.ambientLight);
    scene.add(_3dAmbientLight);

    // Add controllable point light (attached to camera so it follows view)
    _3dPointLight = new THREE.PointLight(0xffffff, _3dAppearance.pointLight, 0);
    cam.add(_3dPointLight);
    scene.add(cam); // ensure camera is part of scene graph so its children render

    apply3DPhysics();
    build3DTimeline();
    update3DNames();

    // Set render orders after the scene has first rendered
    setTimeout(() => { refresh3D(); graph3d?.zoomToFit(800, 60); }, 2500);
  }, 150);
}

function apply3DPhysics() {
  if (!graph3d) return;
  const p = physicsParams;

  // Only modify forces the library already created — don't inject foreign d3-force objects
  const lf = graph3d.d3Force('link');
  if (lf) lf
    .distance(l => l.ltype === 'spouse' ? p.spouseDist    : p.parentDist)
    .strength(l => l.ltype === 'spouse' ? p.spouseStrength : p.parentStrength);

  const cf = graph3d.d3Force('charge');
  if (cf) cf
    .strength(n => n.type === 'FAM' ? -p.chargeFam : -p.chargeIndi)
    .distanceMax(p.chargeDistMax);

  graph3d.d3AlphaDecay(0.028);
  graph3d.d3VelocityDecay(p.velocityDecay);

  // Pin nodes to exact Y positions based on (estimated) birth year.
  // Using node.fy is exact — unlike forceY which fights link/charge forces.
  // Remove any leftover soft forceY from previous sessions.
  graph3d.d3Force('fy3d', null);
  applyTimelineYFix();

  graph3d.d3ReheatSimulation();
}

function refresh3D() {
  if (!graph3d) return;
  const hasHL = hlSet.size > 0;
  const gd = graph3d.graphData();

  // ── Update accessors for future mesh creation ──
  graph3d.nodeColor(n => compute3DNodeColor(n));
  graph3d.linkColor(l => _compute3DLinkColor(l, hasHL));

  // ── Directly update node Three.js materials (color + opacity) ──
  for (const n of gd.nodes) {
    const obj = n.__threeObj;
    if (!obj) continue;
    const color = new THREE.Color(compute3DNodeColor(n));
    const inHL = !hasHL || hlSet.has(n.id);
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
    const inHL = !hasHL || (hlSet.has(sid) && hlSet.has(tid));
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
          child.material.opacity = _3dAppearance.linkOpacity;
          child.material.transparent = _3dAppearance.linkOpacity < 1;
          child.material.depthWrite = _3dAppearance.linkOpacity >= 1;
        }
      }
    });
  }

  // Fallback: if links don't have individual __lineObj (e.g. thin lines / LineSegments),
  // update via scene traversal for any LineSegments geometry
  if (!linksUpdated) {
    graph3d.linkOpacity(hasHL ? 0.8 : _3dAppearance.linkOpacity);
    // Re-supply graphData to force link rebuild (nodes keep positions via same refs)
    graph3d.graphData({ nodes: [...gd.nodes], links: [...gd.links] });
  }
}

function _compute3DLinkColor(l, hasHL) {
  if (!hasHL) return linkColor(l);
  const sid = typeof l.source === 'object' ? l.source.id : l.source;
  const tid = typeof l.target === 'object' ? l.target.id : l.target;
  return (hlSet.has(sid) && hlSet.has(tid)) ? linkColor(l) : '#111111';
}

// ── Link color customization ──
function updateLinkColors() {
  // Update SVG links (2D)
  if (linkSel) {
    linkSel.attr('stroke', d => linkColor(d));
  }
  // Update 3D links
  refresh3D();
}

function resetLinkColors() {
  Object.assign(linkColors, LINK_COLOR_DEFAULTS);
  // Sync pickers
  for (const [key, val] of Object.entries(LINK_COLOR_DEFAULTS)) {
    const el = document.getElementById('lc-' + key);
    if (el) el.value = val;
  }
  updateLinkColors();
}

// ── Node color customization ──
function updateNodeColors() {
  refreshNodeColors();
}

function resetNodeColors() {
  Object.assign(nodeColors, NODE_COLOR_DEFAULTS);
  const map = { male: 'nc-male', female: 'nc-female', unknown: 'nc-unknown', fam: 'nc-fam', famDiv: 'nc-fam-div' };
  for (const [key, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.value = NODE_COLOR_DEFAULTS[key];
  }
  famNodeSize = 1;
  localStorage.setItem('famNodeSize', famNodeSize);
  const famSizeSlider = document.getElementById('fam-node-size');
  const famSizeVal    = document.getElementById('fam-node-size-val');
  if (famSizeSlider) famSizeSlider.value = famNodeSize;
  if (famSizeVal)    famSizeVal.textContent = famNodeSize;
  updateNodeColors();
  _applyFamNodeSize();
}

// ── 3D Timeline (Three.js scene objects) ──

// Polyfill roundRect for browsers that don't support it
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

// Helper: make a sharp canvas sprite. Renders at DPR× resolution for crisp WebGL text.
function makeTextSprite3D(drawFn, logicalW, logicalH) {
  const DPR = 4;
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

// Creates a canvas-texture sprite for a year label
function makeYearSprite(yr) {
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

function build3DTimeline() {
  if (!graph3d) return;
  // Remove any existing timeline
  if (_timeline3DObj) {
    graph3d.scene().remove(_timeline3DObj);
    _timeline3DObj = null;
  }
  if (!sortByTime3D || !_birthYearRange || !showTimeline3D) return;

  const { min: minYr, max: maxYr } = _birthYearRange;
  const span = Math.max(maxYr - minYr, 1);
  // topY/botY derived from the SAME yearTo3DY function — exact match with forceY targets
  const topY = yearTo3DY(minYr); // oldest → positive Y
  const botY = yearTo3DY(maxYr); // newest → negative Y
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

  // ── Year ticks + labels ──
  const step = span > 200 ? 50 : span > 80 ? 25 : 10;
  const startYr = Math.ceil(minYr / step) * step;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x5588cc, transparent: true, opacity: 0.70, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });

  for (let yr = startYr; yr <= maxYr; yr += step) {
    const y = yearTo3DY(yr); // exact same function → rings sit at node level

    // Horizontal ring (torus lying flat)
    const ringGeo = new THREE.TorusGeometry(14, 0.5, 8, 40);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.renderOrder = 0;
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, y, 0);
    group.add(ring);

    // Year label sprite — placed just outside the ring
    const sprite = makeYearSprite(yr);
    sprite.position.set(22, y, 0);
    group.add(sprite);
  }

  _timeline3DObj = group;
  graph3d.scene().add(group);
}

// ── 3D name sprites (replace spheres with name text) ──
function _nameTextColor(n) {
  // Use same color logic as 2D — surname hash or sex color
  return indiColor(n.data);
}

function makeNameSprite3D(n) {
  if (n.type !== 'INDI') return null;
  const indi = n.data;
  const name = indi.displayName || indi.name || n.id;
  const maidenLine = indi.maidenName ? t('tooltip.born', { name: indi.maidenName }) : '';
  let born = '';
  if (indi.birthYear) {
    born = `*${indi.birthYear}`;
  } else if (_estimatedYears && _estimatedYears.has(n.id)) {
    born = `~${_estimatedYears.get(n.id)}`;
  }
  const died = indi.deceased
    ? '†' + (indi.death.date?.match(/\d{4}/)?.[0] ?? '')
    : '';
  const yearLine = [born, died].filter(Boolean).join('  ');
  const textColor = _nameTextColor(n);

  const FONT_NAME   = _3dFontSize;
  const FONT_MAIDEN = Math.round(_3dFontSize * 0.72);
  const FONT_YEAR   = Math.round(_3dFontSize * 0.72);
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

function update3DNames() {
  if (!graph3d) return;
  if (show3DNames) {
    graph3d
      .nodeThreeObject(n => makeNameSprite3D(n) || undefined)
      .nodeThreeObjectExtend(true);   // label sits on top of the sphere
  } else {
    graph3d
      .nodeThreeObject(null)
      .nodeThreeObjectExtend(false);
  }
}

function toggleNodeDrag() {
  _nodeDragEnabled = !_nodeDragEnabled;
  if (graph3d) graph3d.enableNodeDrag(_nodeDragEnabled);
  const btn = document.getElementById('node-drag-btn');
  if (btn) {
    btn.textContent = _nodeDragEnabled
      ? '🔓 ' + t('sidebar.dragOn')
      : '🔒 ' + t('sidebar.dragOff');
    btn.style.opacity = _nodeDragEnabled ? '1' : '0.6';
  }
}

// ── Top-down high-res export ──
function export3DTopDown() {
  if (!graph3d) return;

  const btn = document.querySelector('button[onclick="export3DTopDown()"]');
  if (btn) { btn.textContent = '⏳ ' + t('appearance.rendering'); btn.disabled = true; }

  const origHalfSpan = _3dYHalfSpan;

  // Flatten all nodes to Y=0, let XZ forces settle
  _3dYHalfSpan = 0;
  applyTimelineYFix();
  graph3d.d3ReheatSimulation();

  setTimeout(() => {
    const gd = graph3d.graphData();

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
    const FONT_NAME   = Math.round(_3dFontSize * scale * 0.45);   // matches sprite scale
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

    ctx.fillStyle = _3dAppearance.bgColor || '#000000';
    ctx.fillRect(0, 0, CW, CH);

    // Draw links
    ctx.lineWidth = Math.max(1, scale * 0.4);
    for (const lk of gd.links) {
      const srcId = typeof lk.source === 'object' ? lk.source.id : (lk._src || lk.source);
      const tgtId = typeof lk.target === 'object' ? lk.target.id : (lk._tgt || lk.target);
      const s = posMap.get(srcId);
      const t = posMap.get(tgtId);
      if (!s || !t) continue;
      const col = lk.ltype === 'spouse' ? linkColors.spouse
                : lk.ltype === 'father' ? linkColors.father
                : lk.ltype === 'mother' ? linkColors.mother
                : linkColors.parent;
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
      const col = p.n.data?.div ? nodeColors.famDiv : nodeColors.fam;
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
      if (!born && _estimatedYears?.has(p.n.id)) born = `~${_estimatedYears.get(p.n.id)}`;
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
    _3dYHalfSpan = origHalfSpan;
    applyTimelineYFix();
    graph3d.d3ReheatSimulation();

    if (btn) { btn.textContent = '📥 ' + t('appearance.exportTopDown'); btn.disabled = false; }

    const a = document.createElement('a');
    a.download = t('appearance.exportFileName') + '.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }, 2500);
}

// ═══════════════════════════════════════════════════════════════
// 2D IMAGE EXPORT
// ═══════════════════════════════════════════════════════════════
// The chart is already an SVG, so the export is that same drawing rather than a
// second one: clone the live <svg>, frame it to its own contents and rasterise.
// Nothing here needs to know how a person, a marriage marker or a connector is
// drawn — unlike the 3D export, which has to redraw the scene from scratch onto
// a canvas and therefore has to be kept in step with the renderer by hand.
const EXPORT_MARGIN = 40;
const EXPORT_LONG_EDGE = 6000;   // target for the longer side, in pixels
const EXPORT_MAX_PIXELS = 40e6;  // browsers refuse to rasterise much beyond this
const EXPORT_MAX_EDGE = 16384;   // ...and refuse any single dimension past this

// Standalone SVG has no page around it to inherit from, and CSS beats a
// presentation attribute — so anything styled in the stylesheet has to travel
// with the copy or the export will not match the screen.
const EXPORT_SVG_CSS = `
  .node-label { text-anchor: middle; dominant-baseline: auto; }
`;

// How much to blow the chart up when rasterising: sharp enough to print, but
// inside what a browser will actually allocate. A family tree is a wide, short
// thing, so a full-file chart runs into the ceilings long before its long edge
// reaches the target.
//
// Both ceilings are enforced by the browser refusing to allocate the canvas, so
// a chart that is already past them at 1:1 has to be scaled *down*. A slightly
// soft image is worth having; a failed export is not.
function _exportScale(w, h) {
  const long = Math.max(w, h) || 1;
  return Math.min(
    Math.max(1, EXPORT_LONG_EDGE / long),      // sharp enough to print
    EXPORT_MAX_EDGE / long,                    // no dimension past the cap
    Math.sqrt(EXPORT_MAX_PIXELS / (w * h || 1)) // and not too many pixels in total
  );
}

function _svgForExport() {
  const src = document.getElementById('graph-svg');
  const main = gMain?.node();
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

function export2DImage() {
  if (currentView !== '2d') { alert(t('focus.exportNeeds2D')); return; }
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

// The same drawing, kept as vector — worth having for a chart that gets
// printed, and free given the copy already exists.
function export2DSVG() {
  if (currentView !== '2d') { alert(t('focus.exportNeeds2D')); return; }
  const svg = _svgForExport();
  if (!svg) { alert(t('focus.exportEmpty')); return; }
  _downloadBlob(svg.markup, _baseFilename() + '_2d.svg', 'image/svg+xml;charset=utf-8');
}

// Resize 3D view when window resizes
window.addEventListener('resize', () => { if (currentView === '3d') resize3D(); });

function _graphCentroid3D() {
  if (!graph3d) return new THREE.Vector3(0, 0, 0);
  const nodes = graph3d.graphData().nodes;
  if (!nodes.length) return new THREE.Vector3(0, 0, 0);
  let sx = 0, sy = 0, sz = 0;
  for (const n of nodes) { sx += n.x || 0; sy += n.y || 0; sz += n.z || 0; }
  return new THREE.Vector3(sx / nodes.length, sy / nodes.length, sz / nodes.length);
}

// ── Orbit target: smoothly animate to a node or back to graph centroid ──
function _setOrbitTarget3D(nodeId) {
  if (!_orbitControls3d) return;
  _orbitTrackNodeId = nodeId || null;
  const ctrl = _orbitControls3d;
  const from = ctrl.target.clone();
  let to;
  if (nodeId && graph3d) {
    const gd = graph3d.graphData();
    const n = gd.nodes.find(nd => nd.id === nodeId);
    if (n) to = new THREE.Vector3(n.x || 0, n.y || 0, n.z || 0);
  }
  if (!to) to = _graphCentroid3D();
  if (from.distanceTo(to) < 0.5) return; // already there
  _orbitTargetAnim = { from, to, start: performance.now(), duration: 600 };
}

// Called every frame from the render loop redirect
function _tickOrbitTarget() {
  if (!_orbitControls3d || !graph3d) return;
  // Smooth transition animation
  if (_orbitTargetAnim) {
    const { from, to, start, duration } = _orbitTargetAnim;
    const t = Math.min((performance.now() - start) / duration, 1);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    _orbitControls3d.target.lerpVectors(from, to, ease);
    _orbitControls3d.update();
    if (t >= 1) _orbitTargetAnim = null;
    return;
  }
  // Continuous tracking: follow the tracked node as it moves in the simulation
  if (_orbitTrackNodeId) {
    const gd = graph3d.graphData();
    const n = gd.nodes.find(nd => nd.id === _orbitTrackNodeId);
    if (n) {
      const pos = new THREE.Vector3(n.x || 0, n.y || 0, n.z || 0);
      _orbitControls3d.target.lerp(pos, 0.08);
      _orbitControls3d.update();
    }
  }
}

// Depth of the graph along a ray: distance (from origin) of the node closest
// to the ray. Keeps the orbit pivot / zoom focus on actual tree geometry.
// ponytail: O(n) scan per event; spatial index if trees ever get huge.
function _depthAlongRay3D(origin, dir) {
  if (!graph3d) return null;
  let best = null, bestPerp = Infinity;
  const v = new THREE.Vector3();
  for (const n of graph3d.graphData().nodes) {
    v.set(n.x || 0, n.y || 0, n.z || 0).sub(origin);
    const t = v.dot(dir);
    if (t <= 0) continue;
    const perp = v.addScaledVector(dir, -t).length();
    if (perp < bestPerp) { bestPerp = perp; best = t; }
  }
  return best;
}

// Move the orbit target along the current view ray to tree depth.
// View direction is unchanged → no visual jump, but rotation now pivots on the tree.
function _snapOrbitPivot3D() {
  if (!graph3d || !_orbitControls3d || _orbitTrackNodeId || _orbitTargetAnim) return;
  const cam = graph3d.camera();
  const ctrl = _orbitControls3d;
  const dir = ctrl.target.clone().sub(cam.position).normalize();
  const d = _depthAlongRay3D(cam.position, dir);
  if (d) ctrl.target.copy(cam.position).addScaledVector(dir, d);
}

// ── Zoom toward cursor position in 3D ──
function _onWheel3D(evt) {
  evt.preventDefault();
  if (!graph3d || !_orbitControls3d) return;
  _orbitTargetAnim = null;
  _orbitTrackNodeId = null;

  const cam  = graph3d.camera();
  const ctrl = _orbitControls3d;
  const el   = graph3d.renderer().domElement;
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

// ═══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════
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
    case 'g': case 'G': if (selectedIndiId) focusOnPerson(selectedIndiId); break;
    case 'Escape':      closeDetailPanel();       break;
    case '+': case '=': if (currentView === '2d' && simulation) reheatSimulation(); break;
  }
});

// ═══════════════════════════════════════════════════════════════
// PHYSICS SLIDERS — wiring
// ═══════════════════════════════════════════════════════════════

// Map: slider-id → { param key, display id, format fn }
const SLIDER_MAP = [
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

// Sync slider positions + value labels from physicsParams
function syncPhysicsUI() {
  for (const { sid, vid, key, fmt } of SLIDER_MAP) {
    const el = document.getElementById(sid);
    const vl = document.getElementById(vid);
    if (el) el.value = physicsParams[key];
    if (vl) vl.textContent = fmt(physicsParams[key]);
  }
}

// Attach listeners after DOM ready
document.addEventListener('DOMContentLoaded', () => {
  renderPresetList();
  _tryRestoreAutosave();

  // Touch support
  _initPanelSwipe();
  _initTouchDragGuard();

  // View + focus controls
  const fls = document.getElementById('focus-limit-slider');
  if (fls) {
    fls.value = focusLimit;
    document.getElementById('focus-limit-val').textContent = focusLimit;
  }
  const cds = document.getElementById('cousin-degree-slider');
  if (cds) {
    cds.value = cousinDegree;
    document.getElementById('cousin-degree-val').textContent = t('focus.cousinLevel' + cousinDegree);
  }
  const tlt = document.getElementById('tree-layout-toggle');
  if (tlt) tlt.checked = treeLayout;
  updateViewToggleUI();
  updateFocusUI();

  for (const { sid, vid, key, fmt } of SLIDER_MAP) {
    const el = document.getElementById(sid);
    if (!el) continue;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      physicsParams[key] = v;
      const vl = document.getElementById(vid);
      if (vl) vl.textContent = fmt(v);
      applyPhysicsParams();
    });
  }

  // Familien-Knoten toggle
  document.getElementById('fam-nodes-toggle').addEventListener('change', function () {
    showFamNodes = this.checked;
    applyFilter();
  });

  // Color-by-surname toggle
  const colorBySurnameToggle = document.getElementById('color-by-surname');
  const colorModeLabelEl = document.getElementById('color-mode-label');
  function _syncColorModeLabel() {
    if (colorModeLabelEl) colorModeLabelEl.textContent = colorBySurname ? t('sidebar.colorModeSurname') : t('sidebar.colorModeSex');
  }
  if (colorBySurnameToggle) {
    colorBySurnameToggle.checked = colorBySurname;
    _syncColorModeLabel();
    colorBySurnameToggle.addEventListener('change', function () {
      colorBySurname = this.checked;
      localStorage.setItem('colorBySurname', colorBySurname);
      _syncColorModeLabel();
      _rerenderNodes();       // 2D circles + labels
      update3DNames();        // rebuild 3D name sprites with new color
    });
  }

  // 3D: sort by time + show timeline
  document.getElementById('sort-time-3d-toggle').addEventListener('change', function () {
    sortByTime3D = this.checked;
    document.getElementById('time-spread-row').style.display = sortByTime3D ? 'block' : 'none';
    if (graph3d) {
      applyTimelineYFix();        // pin/unpin Y positions immediately
      graph3d.d3ReheatSimulation(); // let X/Z settle
      build3DTimeline();
    }
  });

  // 3D: time axis spread slider
  document.getElementById('time-spread-slider').addEventListener('input', function () {
    _3dYHalfSpan = +this.value;
    document.getElementById('time-spread-val').textContent = this.value;
    if (graph3d && sortByTime3D) {
      applyTimelineYFix();          // recalculate Y pins with new halfSpan
      graph3d.d3ReheatSimulation();
      build3DTimeline();            // rebuild rings at new positions
    }
  });

  // 3D: show/hide visual timeline axis (independent of Y stratification)
  document.getElementById('show-timeline-toggle').addEventListener('change', function () {
    showTimeline3D = this.checked;
    build3DTimeline();
  });

  // 3D: show names instead of spheres
  document.getElementById('show-names-3d-toggle').addEventListener('change', function () {
    show3DNames = this.checked;
    update3DNames();
  });

  // Link color pickers
  for (const key of ['spouse', 'father', 'mother', 'parent']) {
    const el = document.getElementById('lc-' + key);
    if (el) el.addEventListener('input', function () {
      linkColors[key] = this.value;
      updateLinkColors();
    });
  }

  // Node color pickers
  const NC_MAP = { male: 'nc-male', female: 'nc-female', unknown: 'nc-unknown', fam: 'nc-fam', famDiv: 'nc-fam-div' };
  for (const [key, id] of Object.entries(NC_MAP)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', function () {
      nodeColors[key] = this.value;
      updateNodeColors();
    });
  }

  // FAM node size slider
  const famSizeSlider = document.getElementById('fam-node-size');
  const famSizeVal    = document.getElementById('fam-node-size-val');
  if (famSizeSlider) {
    famSizeSlider.value = famNodeSize;
    if (famSizeVal) famSizeVal.textContent = famNodeSize;
    famSizeSlider.addEventListener('input', function () {
      famNodeSize = parseInt(this.value);
      if (famSizeVal) famSizeVal.textContent = famNodeSize;
      localStorage.setItem('famNodeSize', famNodeSize);
      _applyFamNodeSize();
    });
  }

  // ── 3D appearance controls ──
  document.getElementById('ap-bg-color')?.addEventListener('input', function () {
    _3dAppearance.bgColor = this.value;
    if (graph3d) graph3d.backgroundColor(this.value);
  });

  document.getElementById('ap-node-opacity')?.addEventListener('input', function () {
    _3dAppearance.nodeOpacity = +this.value;
    document.getElementById('ap-node-opacity-val').textContent = (+this.value).toFixed(2);
    if (graph3d) graph3d.nodeOpacity(+this.value);
  });

  document.getElementById('ap-link-opacity')?.addEventListener('input', function () {
    _3dAppearance.linkOpacity = +this.value;
    document.getElementById('ap-link-opacity-val').textContent = (+this.value).toFixed(2);
    if (graph3d) graph3d.linkOpacity(+this.value);
  });

  document.getElementById('ap-ambient')?.addEventListener('input', function () {
    _3dAppearance.ambientLight = +this.value;
    document.getElementById('ap-ambient-val').textContent = (+this.value).toFixed(1);
    if (_3dAmbientLight) _3dAmbientLight.intensity = +this.value;
  });

  document.getElementById('ap-point')?.addEventListener('input', function () {
    _3dAppearance.pointLight = +this.value;
    document.getElementById('ap-point-val').textContent = (+this.value).toFixed(1);
    if (_3dPointLight) _3dPointLight.intensity = +this.value;
  });

  document.getElementById('ap-link-width')?.addEventListener('input', function () {
    _3dAppearance.linkWidth = +this.value;
    document.getElementById('ap-link-width-val').textContent = (+this.value).toFixed(1);
    if (graph3d) graph3d.linkWidth(+this.value);
  });

  document.getElementById('ap-node-size')?.addEventListener('input', function () {
    _3dAppearance.nodeRelSize = +this.value;
    document.getElementById('ap-node-size-val').textContent = (+this.value).toFixed(1);
    if (graph3d) graph3d.nodeRelSize(+this.value);
  });

  document.getElementById('ap-font-size')?.addEventListener('input', function () {
    _3dFontSize = +this.value;
    document.getElementById('ap-font-size-val').textContent = this.value;
    update3DNames();
  });
});

// ═══════════════════════════════════════════════════════════════
// RELATION TOOL
// ═══════════════════════════════════════════════════════════════
let _relSlotWaiting = null;   // 'A' | 'B' | null — which slot is awaiting a click
let _relPersonA = null;
let _relPersonB = null;

function openRelationTool() {
  document.getElementById('relation-panel').classList.add('panel-visible');
  _renderRelationPanel();
  // Close dropdowns on outside click
  if (!openRelationTool._outsideHandler) {
    openRelationTool._outsideHandler = e => {
      if (!e.target.closest('#relation-panel')) {
        document.getElementById('rel-drop-a').style.display = 'none';
        document.getElementById('rel-drop-b').style.display = 'none';
      }
    };
    document.addEventListener('mousedown', openRelationTool._outsideHandler);
  }
}

function closeRelationTool() {
  document.getElementById('relation-panel').classList.remove('panel-visible');
  _relSlotWaiting = null;
  document.body.classList.remove('relation-picking');
}

// Called by node clicks when the relation tool is waiting for a pick
function _tryPickRelationPerson(id) {
  if (!_relSlotWaiting) return false;
  if (_relSlotWaiting === 'A') _relPersonA = id;
  else                          _relPersonB = id;
  _relSlotWaiting = null;
  document.body.classList.remove('relation-picking');
  _renderRelationPanel();
  if (_relPersonA && _relPersonB) _computeAndShowRelation();
  return true;
}

function _relPersonLabel(id) {
  if (!id) return '—';
  const p = individuals.get(id);
  if (!p) return id;
  const yr = p.birthYear || (_estimatedYears?.get(id));
  return p.displayName + (yr ? ` *${yr}` : '');
}

function _renderRelationPanel() {
  document.getElementById('rel-name-a').textContent = _relPersonLabel(_relPersonA);
  document.getElementById('rel-name-b').textContent = _relPersonLabel(_relPersonB);
  document.getElementById('rel-pick-a').classList.toggle('rel-picking', _relSlotWaiting === 'A');
  document.getElementById('rel-pick-b').classList.toggle('rel-picking', _relSlotWaiting === 'B');
  // Clear search inputs when a person is set via click
  if (_relPersonA) { const el = document.getElementById('rel-search-a'); if (el) el.value = ''; }
  if (_relPersonB) { const el = document.getElementById('rel-search-b'); if (el) el.value = ''; }
}

function relPickSlot(slot) {
  _relSlotWaiting = _relSlotWaiting === slot ? null : slot;
  document.body.classList.toggle('relation-picking', !!_relSlotWaiting);
  _renderRelationPanel();
}

function relSearch(slot, query) {
  const dropId = slot === 'A' ? 'rel-drop-a' : 'rel-drop-b';
  const drop = document.getElementById(dropId);
  if (!drop) return;
  const q = query.trim().toLowerCase();
  if (!q) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  const matches = [];
  for (const [id, p] of individuals) {
    const yr = p.birthYear || (_estimatedYears?.get(id));
    const label = (p.name || id) + (yr ? ` *${yr}` : '');
    if ((p.name || id).toLowerCase().includes(q)) matches.push({ id, label, yr });
    if (matches.length >= 8) break;
  }

  if (!matches.length) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  drop.innerHTML = matches.map(m =>
    `<div class="rel-drop-item" onmousedown="relSelectPerson('${slot}','${escJs(m.id)}')">${escHtml(m.label)}</div>`
  ).join('');
  drop.style.display = 'block';
}

function relSelectPerson(slot, id) {
  if (slot === 'A') _relPersonA = id;
  else              _relPersonB = id;
  // Hide dropdown
  const dropId = slot === 'A' ? 'rel-drop-a' : 'rel-drop-b';
  const searchId = slot === 'A' ? 'rel-search-a' : 'rel-search-b';
  const drop = document.getElementById(dropId);
  if (drop) { drop.innerHTML = ''; drop.style.display = 'none'; }
  const inp = document.getElementById(searchId);
  if (inp) inp.value = '';
  _renderRelationPanel();
  if (_relPersonA && _relPersonB) _computeAndShowRelation();
}

// ── Relationship algorithm ────────────────────────────────────
function _computeAndShowRelation() {
  const idA = _relPersonA, idB = _relPersonB;
  const result = document.getElementById('rel-result');
  if (!idA || !idB) { result.textContent = ''; return; }
  if (idA === idB)  { result.textContent = t('relationTool.samePerson'); return; }

  const indiA = individuals.get(idA);
  const indiB = individuals.get(idB);
  if (!indiA || !indiB) { result.textContent = t('relationTool.personNotFound'); return; }

  // --- Check spouse ---
  for (const famId of indiA.fams) {
    const fam = families.get(famId);
    if (!fam) continue;
    if (fam.husb === idB || fam.wife === idB) {
      result.innerHTML = _relLine('💍', t('relationTool.spouse'));
      return;
    }
  }

  // --- Collect ancestors with generation depth ---
  // Returns Map<id, number>  (0 = self, 1 = parent, …)
  function ancestors(startId) {
    const map = new Map([[startId, 0]]);
    const queue = [[startId, 0]];
    while (queue.length) {
      const [id, gen] = queue.shift();
      const indi = individuals.get(id);
      if (!indi) continue;
      for (const famId of indi.famc) {
        const fam = families.get(famId);
        if (!fam) continue;
        for (const pid of [fam.husb, fam.wife]) {
          if (pid && !map.has(pid)) {
            map.set(pid, gen + 1);
            queue.push([pid, gen + 1]);
          }
        }
      }
    }
    return map;
  }

  const ancA = ancestors(idA);
  const ancB = ancestors(idB);

  // --- Direct descendant / ancestor ---
  if (ancA.has(idB)) {
    const g = ancA.get(idB);
    result.innerHTML = _relLine(_sexIcon(indiB), _ancestorLabel(g, indiB.sex));
    return;
  }
  if (ancB.has(idA)) {
    const g = ancB.get(idA);
    result.innerHTML = _relLine(_sexIcon(indiA), _descendantLabel(g, indiA.sex));
    return;
  }

  // --- Find lowest common ancestor(s) ---
  let bestGenA = Infinity, bestGenB = Infinity, lcas = [];
  for (const [id, gA] of ancA) {
    if (!ancB.has(id)) continue;
    const gB = ancB.get(id);
    const total = gA + gB;
    if (total < bestGenA + bestGenB) {
      bestGenA = gA; bestGenB = gB; lcas = [id];
    } else if (total === bestGenA + bestGenB) {
      lcas.push(id);
    }
  }

  if (!lcas.length) {
    // Fall back to BFS path for step/in-law relations
    result.innerHTML = _relLine('🔗', _bfsPathLabel(idA, idB));
    return;
  }

  // --- Classify via LCA ---
  // siblings: genA=1, genB=1
  if (bestGenA === 1 && bestGenB === 1) {
    // full vs half sibling: check if they share both parents
    const parentsA = new Set();
    for (const famId of indiA.famc) {
      const fam = families.get(famId);
      if (fam) { if (fam.husb) parentsA.add(fam.husb); if (fam.wife) parentsA.add(fam.wife); }
    }
    const parentsB = new Set();
    for (const famId of indiB.famc) {
      const fam = families.get(famId);
      if (fam) { if (fam.husb) parentsB.add(fam.husb); if (fam.wife) parentsB.add(fam.wife); }
    }
    const shared = [...parentsA].filter(p => parentsB.has(p)).length;
    const label = shared >= 2 ? _siblingLabel(indiB.sex) : _halfSiblingLabel(indiB.sex);
    result.innerHTML = _relLine(_sexIcon(indiB), label);
    return;
  }

  // aunt/uncle: genA=1, genB=2 (B is grandparent of A's parent)
  if (bestGenA === 1 && bestGenB === 2) {
    result.innerHTML = _relLine(_sexIcon(indiB), indiB.sex === 'M' ? t('relationTool.uncle') : indiB.sex === 'F' ? t('relationTool.aunt') : t('relationTool.uncleAunt'));
    return;
  }
  if (bestGenA === 2 && bestGenB === 1) {
    result.innerHTML = _relLine(_sexIcon(indiA), indiA.sex === 'M' ? t('relationTool.nephew') : indiA.sex === 'F' ? t('relationTool.niece') : t('relationTool.nephewNiece'));
    return;
  }

  // great-aunt/uncle
  if (bestGenA === 1 && bestGenB === 3) {
    result.innerHTML = _relLine(_sexIcon(indiB), indiB.sex === 'M' ? t('relationTool.greatUncle') : indiB.sex === 'F' ? t('relationTool.greatAunt') : t('relationTool.greatUncleAunt'));
    return;
  }
  if (bestGenA === 3 && bestGenB === 1) {
    result.innerHTML = _relLine(_sexIcon(indiA), indiA.sex === 'M' ? t('relationTool.greatNephew') : indiA.sex === 'F' ? t('relationTool.greatNiece') : t('relationTool.greatNephewNiece'));
    return;
  }

  // cousins: both ≥ 2 from LCA
  const degree  = Math.min(bestGenA, bestGenB) - 1;   // 1st cousin = degree 1
  const removed = Math.abs(bestGenA - bestGenB);
  result.innerHTML = _relLine('👥', _cousinLabel(degree, removed, indiB.sex));
}

function _relLine(icon, text) {
  return `<span class="rel-icon">${icon}</span><span class="rel-text">${text}</span>`;
}
function _sexIcon(indi) {
  return indi.sex === 'M' ? '👨' : indi.sex === 'F' ? '👩' : '🧑';
}

function _ancestorLabel(gen, sex) {
  const m = sex === 'M', f = sex === 'F';
  if (gen === 1) return m ? t('relationTool.father') : f ? t('relationTool.mother') : t('relationTool.parent');
  if (gen === 2) return m ? t('relationTool.grandfather') : f ? t('relationTool.grandmother') : t('relationTool.grandparent');
  const prefix = t('relationTool.greatPrefix').repeat(gen - 2);
  return prefix + (m ? t('relationTool.greatGrandfather') : f ? t('relationTool.greatGrandmother') : t('relationTool.greatGrandparent'));
}
function _descendantLabel(gen, sex) {
  const m = sex === 'M', f = sex === 'F';
  if (gen === 1) return m ? t('relationTool.son') : f ? t('relationTool.daughter') : t('relationTool.child');
  if (gen === 2) return m ? t('relationTool.grandson') : f ? t('relationTool.granddaughter') : t('relationTool.grandchild');
  const prefix = t('relationTool.greatPrefix').repeat(gen - 2);
  return prefix + (m ? t('relationTool.greatGrandson') : f ? t('relationTool.greatGranddaughter') : t('relationTool.greatGrandchild'));
}
function _siblingLabel(sex) {
  return sex === 'M' ? t('relationTool.brother') : sex === 'F' ? t('relationTool.sister') : t('relationTool.sibling');
}
function _halfSiblingLabel(sex) {
  return sex === 'M' ? t('relationTool.halfBrother') : sex === 'F' ? t('relationTool.halfSister') : t('relationTool.halfSibling');
}
function _cousinLabel(degree, removed, sex) {
  let base;
  if (degree === 1) base = sex === 'F' ? t('relationTool.femaleCousin') : t('relationTool.cousin');
  else              base = t('relationTool.cousinDegree', { degree });
  return removed > 0 ? t('relationTool.cousinRemoved', { base, removed }) : base;
}

// BFS path label — fallback for step/in-law/blended families
function _bfsPathLabel(idA, idB) {
  // Build full undirected adjacency including spouses
  const adj = new Map();
  const edge = (a, b, type) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, type });
  };
  for (const [id, indi] of individuals) {
    for (const famId of indi.famc) {
      const fam = families.get(famId);
      if (!fam) continue;
      if (fam.husb) { edge(id, fam.husb, 'parent'); edge(fam.husb, id, 'child'); }
      if (fam.wife) { edge(id, fam.wife, 'parent'); edge(fam.wife, id, 'child'); }
    }
    for (const famId of indi.fams) {
      const fam = families.get(famId);
      if (!fam) continue;
      const sp = fam.husb === id ? fam.wife : fam.husb;
      if (sp) edge(id, sp, 'spouse');
    }
  }
  const visited = new Map([[idA, null]]);
  const queue = [idA];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === idB) {
      // Reconstruct path
      const path = [];
      let c = cur;
      while (c) { path.unshift(c); c = visited.get(c)?.from; }
      const steps = path.length - 1;
      return steps > 0 ? t('relationTool.stepsAway', { steps }) : t('relationTool.connected');
    }
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb.id)) {
        visited.set(nb.id, { from: cur });
        queue.push(nb.id);
      }
    }
  }
  return t('relationTool.noConnection');
}

// ═══════════════════════════════════════════════════════════════
// Expose for inline onclick handlers
// ═══════════════════════════════════════════════════════════════
window.showIndiDetail    = showIndiDetail;
window.showFamDetail     = showFamDetail;
window.highlightMode     = highlightMode;
window.resetHighlight    = resetHighlight;
window.closeDetailPanel    = closeDetailPanel;
window.minimizeDetailPanel = minimizeDetailPanel;
window.reopenDetailPanel   = reopenDetailPanel;
window.toggleAllSurnames = toggleAllSurnames;
window.resetLinkColors   = resetLinkColors;
window.resetNodeColors   = resetNodeColors;
window.zoomToFit         = zoomToFit;
window.reheatSimulation  = reheatSimulation;
window.autoSettle        = autoSettle;
window.resetPhysics      = resetPhysics;
window.startEdit         = startEdit;
window.commitIndiEdit    = commitIndiEdit;
window._toggleDeathFields = _toggleDeathFields;
window.commitFamEdit          = commitFamEdit;
window.cancelEdit             = cancelEdit;
window._famEditRemoveChild    = _famEditRemoveChild;
window._famEditRemovePending  = _famEditRemovePending;
window._famEditAddChild       = _famEditAddChild;
window._famEditToggleNewChild = _famEditToggleNewChild;
window._famEditCreateChild    = _famEditCreateChild;
window._famEditAddMarr        = _famEditAddMarr;
window._famEditRemoveMarr     = _famEditRemoveMarr;
window._famEditToggleDivDate  = _famEditToggleDivDate;
window._famEditToggleNewPartner = _famEditToggleNewPartner;
window._famEditCreatePartner    = _famEditCreatePartner;
window.savePreset        = savePreset;
window.deletePreset      = deletePreset;
window.applyPreset       = applyPreset;
window.downloadGEDCOM    = downloadGEDCOM;
window.downloadJSON      = downloadJSON;
window.downloadYAML      = downloadYAML;
window.toggleExportMenu  = toggleExportMenu;
window.closeExportMenu   = closeExportMenu;
window.export3DTopDown   = export3DTopDown;
window.toggleNodeDrag    = toggleNodeDrag;
window.openRelationTool  = openRelationTool;
window.closeRelationTool = closeRelationTool;
window.relPickSlot       = relPickSlot;
window.relSearch         = relSearch;
window.relSelectPerson   = relSelectPerson;
window.toggleView        = toggleView;
window.toggleSidebar     = toggleSidebar;
window.addNewPerson      = addNewPerson;
window.centerView        = centerView;
window.centerOnPerson    = centerOnPerson;
window.addRelation              = addRelation;
window.removeRelation           = removeRelation;
window.removeExistingRelation   = removeExistingRelation;
window.toggleNewPersonSubform   = toggleNewPersonSubform;
window.confirmNewPersonRelation = confirmNewPersonRelation;
window.toggleQuickAdd           = toggleQuickAdd;
window.confirmQuickAddRelative  = confirmQuickAddRelative;
window.confirmQuickAddParents   = confirmQuickAddParents;
window._toggleInlineSpouseForm  = _toggleInlineSpouseForm;
window.deleteCurrentRecord   = deleteCurrentRecord;
window.confirmDeleteRecord   = confirmDeleteRecord;
window.cancelDeleteRecord    = cancelDeleteRecord;
window._fullRebuildGraph     = _fullRebuildGraph;
window._rerenderNodes        = _rerenderNodes;

// ── Reset View Function ──
function resetView() {
  if (!svgSel || !zoomBehavior) return;
  svgSel.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);
}
window.resetView = resetView;

// ═══════════════════════════════════════════════════════════════
// TEXT IMPORT ENGINE  (port of scripts/pdf_to_gedcom.py)
// ═══════════════════════════════════════════════════════════════

const _TI_MONTH_MAP = {
  jan:'JAN',feb:'FEB',mar:'MAR',apr:'APR',may:'MAY',jun:'JUN',
  jul:'JUL',aug:'AUG',sep:'SEP',oct:'OCT',nov:'NOV',dec:'DEC',
  januar:'JAN',februar:'FEB','märz':'MAR',april:'APR',mai:'MAY',
  juni:'JUN',juli:'JUL',august:'AUG',september:'SEP',
  oktober:'OCT',november:'NOV',dezember:'DEC',
};

function _tiNormName(name) {
  let n = (name || '').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  n = n.replace(/\bfluri\b/g, 'flury');
  return n;
}

// Parse a name into { first, surnames[] } handling maiden-name markers.
// "Anna Flury geb. Schmid"  → { first:'anna', surnames:['flury','schmid'] }
// "Anita Berner (Fluri)"    → { first:'anita', surnames:['berner','flury'] }
// "Marie-Louise von Arx"    → { first:'marie-louise', surnames:['arx'] }
function _tiParseName(name) {
  let n = _tiNormName(name);
  // Extract parenthesised maiden names e.g. "Berner (Fluri)" before stripping
  const parenSurnames = [];
  n = n.replace(/\(([^)]+)\)/g, (_, inner) => {
    inner.trim().split(/\s+/).forEach(t => parenSurnames.push(t));
    return '';
  });
  // Normalise maiden-name keyword markers to a separator
  n = n.replace(/\b(?:geb\.?|geborene?|n[eé]{1,2}e?|verh\.?|verheiratete?)\s+/gi, '__SEP__');
  const parts = n.split('__SEP__').map(s => s.trim()).filter(Boolean);
  const firstSegTokens = parts[0].split(/\s+/);
  const first = firstSegTokens[0] || '';
  const surnames = new Set(parenSurnames);
  for (const seg of parts) {
    const toks = seg.split(/\s+/);
    if (toks.length > 1) surnames.add(toks[toks.length - 1]);
    else if (toks.length === 1 && seg !== parts[0]) surnames.add(toks[0]);
  }
  if (firstSegTokens.length > 1) surnames.add(firstSegTokens[firstSegTokens.length - 1]);
  return { first, surnames: [...surnames] };
}

// Score how well two parsed names match. Returns 0–1.
function _tiNameScore(a, b) {
  // First name must match (exact or prefix)
  if (!a.first || !b.first) return 0;
  const fmatch = a.first === b.first ? 1
               : (a.first.startsWith(b.first) || b.first.startsWith(a.first)) ? 0.7
               : 0;
  if (fmatch === 0) return 0;
  // Best surname overlap
  let bestSurn = 0;
  for (const sa of a.surnames) {
    for (const sb of b.surnames) {
      if (sa === sb) { bestSurn = 1; break; }
      // Allow 1-char Levenshtein for typos (Müller/Mueller handled by NFD strip above)
      if (Math.abs(sa.length - sb.length) <= 2 && _tiLevenshtein(sa, sb) <= 1)
        bestSurn = Math.max(bestSurn, 0.85);
    }
    if (bestSurn === 1) break;
  }
  return fmatch * (0.4 + 0.6 * bestSurn);
}

function _tiLevenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({length: m+1}, (_,i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1]
               : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function _tiNormDate(raw) {
  raw = (raw || '').trim();
  let m = raw.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
  if (m) {
    const mo = _TI_MONTH_MAP[m[2].toLowerCase()] || m[2].toUpperCase();
    return `${parseInt(m[1],10)} ${mo} ${m[3]}`;
  }
  m = raw.match(/^(\w+)\s+(\d{4})$/);
  if (m) {
    const mo = _TI_MONTH_MAP[m[1].toLowerCase()] || m[1].toUpperCase();
    return `${mo} ${m[2]}`;
  }
  if (/^\d{4}$/.test(raw)) return raw;
  return raw;
}

function _tiInferSex(block, fullName) {
  if (/\bdaughter\s+of\b/i.test(block)) return 'F';
  if (/\bson\s+of\b/i.test(block)) return 'M';
  const hm = block.match(/\b(She|He)\b/i);
  if (hm) return hm[1].toLowerCase() === 'she' ? 'F' : 'M';
  const first = ((fullName || '').split(' ')[0] || '').toLowerCase();
  const fem = ['a','e','ina','ine','ette','itha','ith','burg','hild','traud','gard','linde'];
  const mal = ['us','old','olf','helm','bert','hard','fried','rich','mann','hans','anz'];
  for (const s of fem) { if (first.endsWith(s) && first.length > s.length) return 'F'; }
  for (const s of mal) { if (first.endsWith(s) && first.length > s.length) return 'M'; }
  return null;
}

// Regex building blocks
const _TI_DATE_PAT   = '(?:\\d{1,2}\\s+)?(?:Jan(?:uar)?|Feb(?:ruar)?|M[aä]r(?:z)?|Apr(?:il)?|Mai|May|Jun(?:i)?|Jul(?:i)?|Aug(?:ust)?|Sep(?:tember)?|O[ck]t(?:ober)?|Nov(?:ember)?|De[cz](?:ember)?)\\s+\\d{4}|\\d{4}';
const _TI_DATE_CAP   = '(' + _TI_DATE_PAT + ')';
const _TI_PLACE_PAT  = '([A-ZÄÖÜ][^,.\\n]+(?:,\\s*[A-ZÄÖÜ][^,.\\n]+)*)';
const _TI_PFX        = '(?:von|van|de|der|den|di|du|le|la|zum|zur|am|im|auf|ten|ter)\\s+';
const _TI_WORD       = '[A-ZÄÖÜ][a-zäöüß]+';
const _TI_NAME_PAT   = '(?:' + _TI_PFX + ')?' + _TI_WORD + '(?:\\s+(?:' + _TI_PFX + ')?' + _TI_WORD + '){0,4}';

const _TI_BORN_RE     = new RegExp('was born on\\s+' + _TI_DATE_CAP + '(?:\\s+in\\s+' + _TI_PLACE_PAT + ')?', 'i');
const _TI_DIED_RE     = new RegExp('(?:died|death)\\s+(?:on\\s+)?' + _TI_DATE_CAP + '(?:\\s+in\\s+' + _TI_PLACE_PAT + ')?', 'i');
const _TI_MARRIED_RE  = new RegExp('married\\s+(' + _TI_NAME_PAT + ')(?:\\s+on\\s+' + _TI_DATE_CAP + ')?(?:\\s+in\\s+' + _TI_PLACE_PAT + ')?', 'gi');
const _TI_PARENTS_RE  = new RegExp(',\\s*(?:son|daughter)\\s+of\\s+(' + _TI_NAME_PAT + ')\\s+and\\s+(' + _TI_NAME_PAT + ')', 'i');
const _TI_CHILDREN_RE = new RegExp('(' + _TI_NAME_PAT + ')\\s+and\\s+(' + _TI_NAME_PAT + ')\\s+had the following children?:', 'i');
const _TI_CHILD_SOLE_RE = new RegExp('(' + _TI_NAME_PAT + ')\\s+had the following children?:', 'i');
const _TI_CHILD_RE    = new RegExp('^([ivxlc]+)\\.\\s+(' + _TI_NAME_PAT + ')(?=\\s+was\\b|\\s+died\\b|\\s+married\\b|\\.\\s*$|\\s*$)', 'i');
const _TI_INTRO_RE    = new RegExp('^(' + _TI_NAME_PAT + ')(?=\\s*,|\\s+was\\b|\\s+died\\b)');

function _tiCleanText(raw) {
  return raw
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/-\n(?=[a-z])/g, '');
}

function _tiParsePersonBlock(block) {
  block = (block || '').trim();
  if (!block) return null;
  const im = _TI_INTRO_RE.exec(block);
  if (!im) return null;

  const p = {
    fullName:    im[1].trim(),
    sex:         _tiInferSex(block, im[1].trim()),
    birthDate:   '', birthPlace: '',
    deathDate:   '', deathPlace: '',
    fatherName:  '', motherName: '',
    marriages:   [],
    sourceNote:  block.slice(0,300),
  };

  const pm = _TI_PARENTS_RE.exec(block);
  if (pm) { p.fatherName = pm[1].trim(); p.motherName = pm[2].trim(); }

  const bm = _TI_BORN_RE.exec(block);
  if (bm) { p.birthDate = _tiNormDate(bm[1]); p.birthPlace = bm[2] ? bm[2].trim() : ''; }

  const dm = _TI_DIED_RE.exec(block);
  if (dm) { p.deathDate = _tiNormDate(dm[1]); p.deathPlace = dm[2] ? dm[2].trim() : ''; }

  _TI_MARRIED_RE.lastIndex = 0;
  let mm;
  while ((mm = _TI_MARRIED_RE.exec(block)) !== null) {
    p.marriages.push({
      spouseName: mm[1].trim(),
      date:       mm[2] ? _tiNormDate(mm[2]) : '',
      place:      mm[3] ? mm[3].trim() : '',
      children:   [],
    });
  }
  return p;
}

function _tiParseText(text) {
  const persons = [];
  const seenKey = new Map();  // normName|birthYear -> index in persons[]

  function mergeInto(existing, p) {
    if (!existing.birthDate  && p.birthDate)  existing.birthDate  = p.birthDate;
    if (!existing.birthPlace && p.birthPlace) existing.birthPlace = p.birthPlace;
    if (!existing.deathDate  && p.deathDate)  existing.deathDate  = p.deathDate;
    if (!existing.deathPlace && p.deathPlace) existing.deathPlace = p.deathPlace;
    if (!existing.fatherName && p.fatherName) existing.fatherName = p.fatherName;
    if (!existing.motherName && p.motherName) existing.motherName = p.motherName;
    for (const m of p.marriages) {
      const mn = _tiNormName(m.spouseName);
      if (!existing.marriages.find(em => _tiNormName(em.spouseName) === mn))
        existing.marriages.push(m);
    }
  }

  function addPerson(p) {
    if (!p || !p.fullName) return;
    const yr = (p.birthDate||'').match(/\b(\d{4})\b/)?.[1] || '';
    const key = _tiNormName(p.fullName) + '|' + yr;
    if (seenKey.has(key)) { mergeInto(persons[seenKey.get(key)], p); return; }
    seenKey.set(key, persons.length);
    persons.push(p);
  }

  // Step 1: strip Generation/Ancestors prefixes and Notes blocks line by line
  const rawLines = text.split('\n');
  const lines = [];
  let inNotes = false;
  for (const line of rawLines) {
    const t = line.trim();
    if (/^Notes for /i.test(t)) { inNotes = true; continue; }
    if (inNotes) {
      // Notes end at a structural marker
      if (!t || /^\d+\./.test(t) || /^[ivxlc]+\./i.test(t) ||
          /had the following child/i.test(t)) {
        inNotes = false;
        if (t) lines.push(t);
      }
      continue;
    }
    // Strip "Ancestors of X" preamble and inline "Generation N" markers
    const stripped = t
      .replace(/^Ancestors\s+of\b[^.]*\.?\s*/i, '')
      .replace(/\bGeneration\s+\d+\s*/g, '')
      .trim();
    if (stripped) lines.push(stripped);
  }

  // Step 2: group lines into main person blocks.
  // A new block starts when a line opens with "N. Name" (digit+period+space+uppercase),
  // but NOT "N. i." (digit+period+roman = back-reference child entry).
  // Also "N." alone on a line → next line starts the block content.
  const blocks = [];
  let current = [];
  let expectName = false;  // true after a bare "N." line

  function flush() { if (current.length) blocks.push(current.join('\n')); current = []; }

  for (const line of lines) {
    const mainM  = line.match(/^(\d+)\.\s+([A-ZÄÖÜ])/);  // "8. Viktor"
    const bareN  = line.match(/^(\d+)\.\s*$/);             // "4." alone
    if (mainM) {
      flush();
      current = [line.slice(line.indexOf(mainM[2]))];  // drop the leading "N. "
      expectName = false;
    } else if (bareN) {
      flush();
      expectName = true;
    } else if (expectName) {
      current = [line];
      expectName = false;
    } else {
      current.push(line);
    }
  }
  flush();

  // Step 3: parse each block
  for (const block of blocks) {
    const b = block.trim();
    if (!b || b.length < 4) continue;

    // Try two-parent family block first, then single-parent
    const cb   = _TI_CHILDREN_RE.exec(b);
    const cbS  = !cb ? _TI_CHILD_SOLE_RE.exec(b) : null;
    const anyC = cb || cbS;

    if (anyC) {
      const parent2   = cb ? cb[2].trim() : '';
      const parentSrc = b.slice(0, anyC.index).trim();
      const afterSrc  = b.slice(anyC.index + anyC[0].length);

      // Parse children; handle "ii.\nName" splits and "N. ii. Name" back-refs
      const childRefs  = [];
      const childLines = afterSrc.split('\n').map(l => l.trim()).filter(Boolean);
      let pendingRoman = null;
      for (const cl of childLines) {
        // Roman numeral alone on a line ("ii." or "iii.")
        if (/^[ivxlc]+\.\s*$/i.test(cl)) { pendingRoman = cl; continue; }
        // Strip back-reference number prefix: "4. ii. " → "ii. "
        const stripped = cl.replace(/^\d+\.\s+(?=[ivxlc]+\.)/i, '');
        const combined = pendingRoman ? pendingRoman + ' ' + stripped : stripped;
        pendingRoman = null;
        const cm = _TI_CHILD_RE.exec(combined);
        if (!cm) continue;
        const childContent = combined.slice(combined.indexOf(cm[2]));
        const child = _tiParsePersonBlock(childContent) || {
          fullName: cm[2].trim(), sex: null,
          birthDate:'', birthPlace:'', deathDate:'', deathPlace:'',
          fatherName:'', motherName:'', marriages:[], sourceNote:'',
        };
        childRefs.push(child);
        addPerson(child);
      }

      const p = parentSrc ? _tiParsePersonBlock(parentSrc) : null;
      if (p) {
        if (parent2) {
          const n2      = _tiNormName(parent2);
          const matched = p.marriages.find(m => _tiNormName(m.spouseName) === n2);
          if (matched) matched.children = childRefs;
          else if (p.marriages.length) p.marriages[0].children = childRefs;
          else p.marriages.push({ spouseName: parent2, date:'', place:'', children: childRefs });
        } else if (p.marriages.length) {
          p.marriages[0].children = childRefs;
        }
        addPerson(p);
      }
    } else {
      addPerson(_tiParsePersonBlock(b));
    }
  }

  return persons;
}

function _tiGenerateActions(persons) {
  const actions = [];

  // Index existing GEDCOM data for fast exact lookup and fuzzy candidate search
  const keyToId  = new Map();   // "normname|year" → id
  const nameToId = new Map();   // normname       → id  (last wins, for name-only fallback)
  const allIndis = [];          // [{id, parsed, yr}] for fuzzy scan
  for (const [id, indi] of individuals) {
    const nn = _tiNormName(indi.name || '');
    if (!nn) continue;
    const yr = (indi.birth.date || '').match(/\b(\d{4})\b/)?.[1] || '';
    keyToId.set(`${nn}|${yr}`, id);
    nameToId.set(nn, id);
    allIndis.push({ id, parsed: _tiParseName(indi.name || ''), yr });
  }

  function _famKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  const famPairs = new Set();
  for (const [,fam] of families) {
    const h = individuals.get(fam.husb); const w = individuals.get(fam.wife);
    if (h || w) famPairs.add(_famKey(_tiNormName((h||w)?.name||''), _tiNormName((w||h)?.name||'')));
  }

  const pendingNames = new Map();  // normname → '__new__'

  function lookup(person) {
    const nn  = _tiNormName(person.fullName);
    const yr  = (person.birthDate||'').match(/\b(\d{4})\b/)?.[1] || '';

    // 1. Exact key match (name + year)
    if (yr && keyToId.has(`${nn}|${yr}`)) return keyToId.get(`${nn}|${yr}`);

    // 2. Exact name, ignore year when one side is unknown
    if (keyToId.has(`${nn}|`)) {
      if (!yr) return keyToId.get(`${nn}|`);          // both year-unknown
    }
    if (nameToId.has(nn)) {
      const eid = nameToId.get(nn);
      const eyr = (individuals.get(eid)?.birth?.date||'').match(/\b(\d{4})\b/)?.[1] || '';
      if (!eyr || !yr) return eid;                     // one side year-unknown
    }

    // 3. Fuzzy: score all existing persons, pick best above threshold
    const parsed = _tiParseName(person.fullName);
    let bestId = null, bestScore = 0;
    for (const cand of allIndis) {
      let score = _tiNameScore(parsed, cand.parsed);
      if (score < 0.6) continue;
      // Birth-year bonus/penalty
      if (yr && cand.yr) {
        const diff = Math.abs(parseInt(yr) - parseInt(cand.yr));
        if (diff === 0)       score += 0.3;
        else if (diff <= 2)   score += 0.1;  // data-entry slop
        else                  score -= 0.4;  // different person
      }
      if (score > bestScore) { bestScore = score; bestId = cand.id; }
    }
    if (bestScore >= 0.75) return bestId;

    // 4. Already queued in this import batch
    if (pendingNames.has(nn)) return pendingNames.get(nn);
    return null;
  }

  for (let pi = 0; pi < persons.length; pi++) {
    const person = persons[pi];
    const existing = lookup(person);
    if (existing === null) {
      actions.push({
        id:     Math.random().toString(36).slice(2),
        kind:   'person',
        status: 'pending',
        _sourceIdx: pi * 2,
        fields: {
          'Name':         person.fullName,
          'Sex':          person.sex || '',
          'Birth Date':   person.birthDate,
          'Birth Place':  person.birthPlace,
          'Death Date':   person.deathDate,
          'Death Place':  person.deathPlace,
          'Father':       person.fatherName,
          'Mother':       person.motherName,
          'Notes':        person.notes || '',
        },
        source:  person.sourceNote,
        _person: person,
      });
      const nn = _tiNormName(person.fullName);
      pendingNames.set(nn, '__new__');
    } else {
      // Person already exists — generate an update action for any missing fields
      const indi = individuals.get(existing);
      if (indi) {
        const missing = {};
        if (!indi.birth?.date  && person.birthDate)  missing['Birth Date']  = person.birthDate;
        if (!indi.birth?.plac  && person.birthPlace) missing['Birth Place'] = person.birthPlace;
        if (!indi.death?.date  && person.deathDate)  missing['Death Date']  = person.deathDate;
        if (!indi.death?.plac  && person.deathPlace) missing['Death Place'] = person.deathPlace;
        if ((!indi.sex || indi.sex === 'U') && person.sex) missing['Sex'] = person.sex;
        if (person.notes && !(indi.note||'').includes(person.notes)) missing['Notes'] = person.notes;
        if (Object.keys(missing).length) {
          actions.push({
            id:       Math.random().toString(36).slice(2),
            kind:     'update',
            status:   'pending',
            _sourceIdx: pi * 2,
            existingId: existing,
            fields:   Object.assign({ 'Name': person.fullName }, missing),
            source:   person.sourceNote,
            _person:  person,
          });
        }
      }
    }

    for (const marriage of person.marriages) {
      let husbName, wifeName;
      if (person.sex === 'F') { husbName = marriage.spouseName; wifeName = person.fullName; }
      else                    { husbName = person.fullName;     wifeName = marriage.spouseName; }

      const hn = _tiNormName(husbName);
      const wn = _tiNormName(wifeName);
      const pairKey = _famKey(hn, wn);
      if (famPairs.has(pairKey)) continue;

      actions.push({
        id:       Math.random().toString(36).slice(2),
        kind:     'marriage',
        status:   'pending',
        _sourceIdx: pi * 2 + 1,
        fields: {
          'Husband':        husbName,
          'Wife':           wifeName,
          'Marriage Date':  marriage.date,
          'Marriage Place': marriage.place,
          'Children':       marriage.children.map(c => c.fullName).join('; '),
        },
        source:    person.sourceNote,
        _person:   person,
        _marriage: marriage,
      });
      famPairs.add(pairKey);
    }
  }

  return actions;
}

function _tiApplyActions(actions) {
  let maxIndi = 0, maxFam = 0;
  for (const [id] of individuals) { const m = id.match(/\d+/); if (m) maxIndi = Math.max(maxIndi,+m[0]); }
  for (const [id] of families)    { const m = id.match(/\d+/); if (m) maxFam  = Math.max(maxFam, +m[0]); }

  const nameToId = new Map();
  for (const [id, indi] of individuals) nameToId.set(_tiNormName(indi.name||''), id);

  const famsOf = new Map();   // indiId -> [famId]
  const famcOf = new Map();   // childId -> famId
  const report = [];
  const actionXref = new Map();  // action.id -> indiId

  // Pass 0: apply updates to existing individuals
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'update') continue;
    const indi = individuals.get(action.existingId);
    if (!indi) continue;
    // Only the fields the reader left switched on. Where the card offered a
    // choice between what the import says and what the tree already holds,
    // this is that choice; an older card without the map keeps the previous
    // behaviour of filling anything non-empty.
    const use = f => action.fieldApply ? !!action.fieldApply[f] : !!action.fields[f];
    if (use('Birth Date'))  indi.birth.date = action.fields['Birth Date'];
    if (use('Birth Place')) indi.birth.plac = action.fields['Birth Place'];
    if (use('Death Date')) { indi.death.date = action.fields['Death Date']; indi.deceased = true; }
    if (use('Death Place')) indi.death.plac = action.fields['Death Place'];
    if (use('Sex')) indi.sex = action.fields['Sex'];
    if (use('Notes')) {
      indi.note = indi.note ? indi.note + '; ' + action.fields['Notes'] : action.fields['Notes'];
    }
    report.push({ type:'update', msg:`${indi.name} — updated` });
  }

  // Pass 1: allocate INDI xrefs for approved persons
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'person') continue;
    const name = (action.fields['Name'] || '').trim();
    if (!name) continue;
    const nn = _tiNormName(name);
    if (nameToId.has(nn)) {
      report.push({ type:'skip', msg:`${name} — already exists` });
      actionXref.set(action.id, nameToId.get(nn));
    } else {
      const xref = `@I${++maxIndi}@`;
      nameToId.set(nn, xref);
      actionXref.set(action.id, xref);
      report.push({ type:'add', msg:`${name} → ${xref}` });
    }
  }

  // Pass 2: create FAM records for approved marriages
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'marriage') continue;
    const links = action.fieldLinks || {};

    // Resolve a person field: explicit link (exact id) beats name-based lookup
    const resolveField = (fieldKey, name) => {
      const lnk = links[fieldKey];
      if (lnk?.type === 'existing') return lnk.id;
      if (lnk?.type === 'pending')  return actionXref.get(lnk.id) || nameToId.get(_tiNormName(name)) || null;
      return nameToId.get(_tiNormName(name)) || null;
    };

    const husbName = (action.fields['Husband']||'').trim();
    const wifeName = (action.fields['Wife']||'').trim();
    const husbId = resolveField('Husband', husbName);
    const wifeId = resolveField('Wife', wifeName);
    const famXref = `@F${++maxFam}@`;

    const childIds = [];
    const childArr = action._childrenArr ||
      (action.fields['Children']||'').split(';').map(s=>s.trim()).filter(Boolean);
    for (let ci = 0; ci < childArr.length; ci++) {
      const cname = childArr[ci];
      const cid = resolveField(`Children:${ci}`, cname);
      if (cid) { childIds.push(cid); if (!famcOf.has(cid)) famcOf.set(cid, famXref); }
    }

    if (husbId) { if (!famsOf.has(husbId)) famsOf.set(husbId,[]); famsOf.get(husbId).push(famXref); }
    if (wifeId) { if (!famsOf.has(wifeId)) famsOf.set(wifeId,[]); famsOf.get(wifeId).push(famXref); }

    families.set(famXref, {
      id: famXref, husb: husbId, wife: wifeId, chil: childIds,
      marriages: [{ date: action.fields['Marriage Date']||'', plac: action.fields['Marriage Place']||'', types: [] }], div: false, divDate: '',
      div: false,
    });
    report.push({ type:'fam', msg:`${husbName} + ${wifeName} → ${famXref}` });
  }

  // Pass 3: create INDI records
  for (const action of actions) {
    if (action.status !== 'approved' || action.kind !== 'person') continue;
    const xref = actionXref.get(action.id);
    if (!xref || individuals.has(xref)) continue;

    const name  = (action.fields['Name']||'').trim();
    const parts = name.split(/\s+/);
    const givn  = parts.length >= 2 ? parts.slice(0,-1).join(' ') : name;
    const surn  = parts.length >= 2 ? parts[parts.length-1] : '';
    const bdate = action.fields['Birth Date'] || '';
    const yrm   = bdate.match(/\b(\d{4})\b/);

    let displayName = givn && surn ? `${givn} ${surn}` : name;
    if (displayName.length > 24) {
      displayName = givn ? givn + (surn ? ' ' + surn[0] + '.' : '') : displayName.slice(0,22) + '…';
    }

    const noteParts = [];
    if (action.fields['Father']) noteParts.push('Father: ' + action.fields['Father']);
    if (action.fields['Mother']) noteParts.push('Mother: ' + action.fields['Mother']);
    if (action.fields['Notes'])  noteParts.push(action.fields['Notes']);

    individuals.set(xref, {
      id: xref, name, givn, surn,
      sex: (action.fields['Sex']||'U').trim() || 'U',
      birth: { date: bdate, plac: action.fields['Birth Place']||'' },
      death: { date: action.fields['Death Date']||'', plac: action.fields['Death Place']||'', caus:'' },
      deceased: !!(action.fields['Death Date']),
      birthYear: yrm ? +yrm[1] : null,
      famc: famcOf.has(xref) ? [famcOf.get(xref)] : [],
      fams: famsOf.get(xref) || [],
      occu: '',
      note: noteParts.join('; '),
      displayName,
    });
  }

  // Pass 4: patch FAMS/FAMC on pre-existing individuals
  for (const [indiId, famIds] of famsOf) {
    const indi = individuals.get(indiId);
    if (!indi) continue;
    for (const famId of famIds) { if (!indi.fams.includes(famId)) indi.fams.push(famId); }
  }
  for (const [childId, famId] of famcOf) {
    const indi = individuals.get(childId);
    if (!indi) continue;
    if (!indi.famc.includes(famId)) indi.famc.push(famId);
  }

  return report;
}

// ═══════════════════════════════════════════════════════════════
// STRUCTURED JSON IMPORT
// ═══════════════════════════════════════════════════════════════

function _tiParseStructuredJson(obj) {
  if (!obj || !Array.isArray(obj.individuals)) return null;

  // Build a map from JSON person id → full name (for children lookup)
  const idToName = new Map();
  for (const raw of obj.individuals) {
    const fullName = [raw.given_name, raw.surname].filter(Boolean).join(' ').trim();
    if (raw.id && fullName) idToName.set(raw.id, fullName);
  }

  // Build a map from sorted(husbId,wifeId) → children names, from families[]
  const famChildrenByParents = new Map();
  if (Array.isArray(obj.families)) {
    for (const fam of obj.families) {
      const key = [fam.husband_id, fam.wife_id].sort().join('|');
      const childNames = (fam.children || []).map(cid => idToName.get(cid)).filter(Boolean);
      famChildrenByParents.set(key, childNames);
    }
  }

  const persons = [];
  for (const raw of obj.individuals) {
    const fullName = [raw.given_name, raw.surname].filter(Boolean).join(' ').trim();
    if (!fullName) continue;

    const p = {
      fullName,
      sex:         raw.sex || null,
      birthDate:   _tiNormDate(raw.birth_date || ''),
      birthPlace:  (raw.birth_place || '').trim(),
      deathDate:   _tiNormDate(raw.death_date || ''),
      deathPlace:  (raw.death_place || '').trim(),
      fatherName:  '',
      motherName:  '',
      marriages:   [],
      notes:       (raw.notes || '').trim(),
      sourceNote:  `[structured JSON] id=${raw.id}` + (raw.notes ? ` | ${raw.notes}` : ''),
    };

    for (const m of (raw.marriages || [])) {
      const spouseName = [m.spouse_given, m.spouse_surname].filter(Boolean).join(' ').trim();
      if (!spouseName) continue;
      // Look up children for this couple from the families array
      const coupleKey = [raw.id, ''].sort().join('|');  // placeholder
      p.marriages.push({
        spouseName,
        date:     _tiNormDate(m.marriage_date || ''),
        place:    (m.marriage_place || '').trim(),
        children: [],
      });
    }

    persons.push(p);
  }

  // Second pass: wire children into marriages using families[]
  if (Array.isArray(obj.families)) {
    const personByName = new Map();
    for (const p of persons) personByName.set(_tiNormName(p.fullName), p);

    for (const fam of obj.families) {
      const husbName = idToName.get(fam.husband_id) || '';
      const wifeName = idToName.get(fam.wife_id)   || '';
      const childNames = (fam.children || []).map(cid => idToName.get(cid)).filter(Boolean);
      if (!childNames.length) continue;

      // Find the husband/wife person objects and set children on matching marriage
      for (const parentName of [husbName, wifeName]) {
        if (!parentName) continue;
        const parentP = personByName.get(_tiNormName(parentName));
        if (!parentP) continue;
        const spouseName = parentName === husbName ? wifeName : husbName;
        const sn = _tiNormName(spouseName);
        let marriage = parentP.marriages.find(m => _tiNormName(m.spouseName) === sn);
        if (!marriage && parentP.marriages.length === 1) marriage = parentP.marriages[0];
        if (!marriage && spouseName) {
          marriage = { spouseName, date: _tiNormDate(fam.marriage_date||''), place: (fam.marriage_place||'').trim(), children: [] };
          parentP.marriages.push(marriage);
        }
        if (marriage) marriage.children = childNames.map(n => ({ fullName: n }));
      }
    }
  }

  return persons;
}

// ═══════════════════════════════════════════════════════════════
// GEDCOM MERGE IMPORT
// ═══════════════════════════════════════════════════════════════

function _tiParseGedcomForMerge(raw) {
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  const indiMap = new Map(); // id -> {name,sex,birth,death,fams,famc,note}
  const famMap  = new Map(); // id -> {husb,wife,chil,marr}

  const lines = raw.split(/\r?\n/);
  let cur = null, curType = null, subCtx = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s*(.*)/);
    if (!m) continue;
    const level = +m[1], tag = m[2], val = m[3].trim();

    if (level === 0) {
      subCtx = null;
      if (tag.startsWith('@') && val === 'INDI') {
        cur = { id: tag, name:'', sex:'', birth:{date:'',plac:''}, death:{date:'',plac:''}, fams:[], famc:[], note:'' };
        indiMap.set(tag, cur); curType = 'INDI';
      } else if (tag.startsWith('@') && val === 'FAM') {
        cur = { id: tag, husb:null, wife:null, chil:[], marriages:[{date:'',plac:'',types:[]}] };
        famMap.set(tag, cur); curType = 'FAM';
      } else { cur = null; curType = null; }
      continue;
    }

    if (!cur) continue;

    if (curType === 'INDI') {
      if (level === 1) {
        subCtx = null;
        if      (tag === 'NAME' && !cur.name) { const c = val.replace(/\//g,'').replace(/\s+/g,' ').trim(); if (c) cur.name = c; }
        else if (tag === 'SEX')  cur.sex  = val;
        else if (tag === 'BIRT') subCtx = 'BIRT';
        else if (tag === 'DEAT') subCtx = 'DEAT';
        else if (tag === 'FAMS' && val) cur.fams.push(val);
        else if (tag === 'FAMC' && val) cur.famc.push(val);
        else if (tag === 'NOTE') cur.note = val;
      } else if (level === 2) {
        if      (subCtx === 'BIRT' && tag === 'DATE') cur.birth.date = val;
        else if (subCtx === 'BIRT' && tag === 'PLAC') cur.birth.plac = val;
        else if (subCtx === 'DEAT' && tag === 'DATE') cur.death.date = val;
        else if (subCtx === 'DEAT' && tag === 'PLAC') cur.death.plac = val;
        else if (tag === 'CONT') cur.note += '\n' + val;
      } else if (level === 3 && tag === 'CONT') { cur.note += '\n' + val; }

    } else if (curType === 'FAM') {
      if (level === 1) {
        subCtx = null;
        if      (tag === 'HUSB') cur.husb = val;
        else if (tag === 'WIFE') cur.wife = val;
        else if (tag === 'CHIL' && val) cur.chil.push(val);
        else if (tag === 'MARR') { if (!cur.marriages.length) cur.marriages.push({date:'',plac:'',types:[]}); subCtx = 'MARR'; }
      } else if (level === 2 && subCtx === 'MARR') {
        const m = cur.marriages[cur.marriages.length - 1];
        if (m) {
          if (tag === 'DATE') m.date = val;
          else if (tag === 'PLAC') m.plac = val;
        }
      }
    }
  }

  // Convert to persons[] format understood by _tiGenerateActions
  const persons = [];
  for (const [id, indi] of indiMap) {
    if (!indi.name) continue;

    // Normalise Fluri→Flury for persons born before 1940
    let displayName = indi.name;
    if (/Fluri/.test(displayName)) {
      const birthYr = parseInt((indi.birth.date || '').match(/\b(\d{4})\b/)?.[1] || '9999', 10);
      if (birthYr < 1940) displayName = displayName.replace(/Fluri/g, 'Flury');
    }

    const p = {
      fullName:   displayName,
      sex:        indi.sex || null,
      birthDate:  indi.birth.date,
      birthPlace: indi.birth.plac,
      deathDate:  indi.death.date,
      deathPlace: indi.death.plac,
      fatherName: '', motherName: '',
      marriages:  [],
      notes:      indi.note.trim(),
      sourceNote: `[GEDCOM merge] ${id}`,
    };

    // Derive father/mother from FAMC
    for (const famcId of indi.famc) {
      const fam = famMap.get(famcId);
      if (!fam) continue;
      const f = fam.husb ? indiMap.get(fam.husb) : null;
      const mo = fam.wife ? indiMap.get(fam.wife) : null;
      if (f?.name  && !p.fatherName) p.fatherName = f.name;
      if (mo?.name && !p.motherName) p.motherName = mo.name;
    }

    // Build marriages from FAMS
    for (const famsId of indi.fams) {
      const fam = famMap.get(famsId);
      if (!fam) continue;
      const spouseId = fam.husb === id ? fam.wife : fam.husb;
      const spouse   = spouseId ? indiMap.get(spouseId) : null;
      if (!spouse?.name) continue;
      p.marriages.push({
        spouseName: spouse.name,
        date:       fam.marriages?.[0]?.date || '',
        place:      fam.marriages?.[0]?.plac || '',
        children:   fam.chil.map(cid => indiMap.get(cid))
                            .filter(c => c?.name)
                            .map(c => ({ fullName: c.name })),
      });
    }

    persons.push(p);
  }

  return persons;
}

// ═══════════════════════════════════════════════════════════════
// TEXT IMPORT UI
// ═══════════════════════════════════════════════════════════════

let _importActions = [];
let _importJsonPersons = null;  // set when a .json/.ged/.yaml file is loaded
let _importLoadedFile  = null;  // raw File handle, for "replace dataset" path
let _importImageData   = null;  // { base64, mediaType } for AI fallback
const _IMAGE_MIME = /^image\/(jpeg|png|gif|webp)$/;

function openImport() {
  document.getElementById('import-modal').style.display = 'flex';
  _resetImportUI();
  document.addEventListener('paste', _importPasteHandler);
}
const openTextImport = openImport; // backwards alias

function closeTextImport() {
  document.removeEventListener('paste', _importPasteHandler);
  document.getElementById('import-modal').style.display = 'none';
  _importActions = [];
  _importLoadedFile = null;
  _importImageData = null;
}

function _resetImportUI() {
  document.getElementById('import-step-input').style.display = '';
  document.getElementById('import-step-review').style.display = 'none';
  const overlay = document.getElementById('import-progress-overlay');
  if (overlay) overlay.style.display = 'none';
  const label = document.getElementById('import-progress-label');
  if (label) label.textContent = '';
  document.getElementById('import-text-area').value = '';
  const fi = document.getElementById('import-file-input');
  if (fi) { fi.value = ''; }
  document.getElementById('import-drop-label').style.display = '';
  document.getElementById('import-drop-filename').style.display = 'none';
  document.getElementById('import-image-preview').style.display = 'none';
  document.getElementById('import-image-options').style.display = 'none';
  document.getElementById('import-ai-key-row').style.display = 'none';
  document.getElementById('import-error-msg').style.display = 'none';
  document.getElementById('import-replace-btn').style.display = 'none';
  document.getElementById('import-ocr-status').textContent = '';
  _importActions = [];
  _importJsonPersons = null;
  _importLoadedFile = null;
  _importImageData = null;
}

function _imShowError(msg) {
  const el = document.getElementById('import-error-msg');
  el.textContent = msg; el.style.display = '';
}

function _imDragOver(e) { e.preventDefault(); document.getElementById('import-drop-zone').classList.add('drag-over'); }
function _imDragLeave(e) { document.getElementById('import-drop-zone').classList.remove('drag-over'); }
function _imDrop(e) {
  e.preventDefault();
  document.getElementById('import-drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files?.[0];
  if (file) _imLoadFile(file);
}
function _importPasteHandler(e) {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) _imLoadFile(file);
}

function handleImportFileSelect(e) {
  const file = e.target.files[0];
  if (file) _imLoadFile(file);
}

function _imLoadFile(file) {
  _importJsonPersons = null;
  _importLoadedFile = file;
  _importImageData = null;
  document.getElementById('import-error-msg').style.display = 'none';
  document.getElementById('import-drop-label').style.display = 'none';
  const fn = document.getElementById('import-drop-filename');
  fn.textContent = '📄 ' + file.name;
  fn.style.display = '';
  document.getElementById('import-image-preview').style.display = 'none';
  document.getElementById('import-image-options').style.display = 'none';
  document.getElementById('import-replace-btn').style.display = 'none';
  document.getElementById('import-text-area').value = '';

  const name = file.name.toLowerCase();
  const isGed   = /\.ged$/.test(name);
  const isJson  = /\.json$/.test(name);
  const isYaml  = /\.ya?ml$/.test(name);
  const isImage = _IMAGE_MIME.test(file.type) || /\.(png|jpe?g|gif|webp)$/.test(name);

  // First import on empty dataset: load directly, skip the review wizard.
  if ((isGed || isJson || isYaml) && individuals.size === 0) {
    closeTextImport();
    _loadDatasetFile(file);
    return;
  }

  if (isImage) {
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      _importImageData = { base64: dataUrl.split(',')[1], mediaType: file.type || 'image/png' };
      const prev = document.getElementById('import-image-preview');
      prev.src = dataUrl;
      prev.style.display = 'block';
      document.getElementById('import-image-options').style.display = 'flex';
    };
    reader.readAsDataURL(file);
    return;
  }

  if (isGed || isJson || isYaml) {
    document.getElementById('import-replace-btn').style.display = '';
  }

  const reader = new FileReader();
  if (isGed) {
    reader.onload = ev => {
      const persons = _tiParseGedcomForMerge(ev.target.result || '');
      if (persons?.length) {
        _importJsonPersons = persons;
        document.getElementById('import-text-area').value =
          t('import.gedcomLoaded', { n: persons.length, plural: persons.length !== 1 ? 'en' : '' });
      } else {
        _imShowError(t('import.parseError'));
      }
    };
    reader.readAsText(file, 'utf-8');
  } else if (isJson) {
    reader.onload = ev => {
      try {
        const obj = JSON.parse(ev.target.result || '{}');
        const persons = _tiParseStructuredJson(obj);
        if (persons && persons.length) {
          _importJsonPersons = persons;
          document.getElementById('import-text-area').value =
            t('import.jsonLoaded', { n: persons.length, plural: persons.length !== 1 ? 'en' : '' });
        } else {
          document.getElementById('import-text-area').value =
            t('import.jsonFallback');
        }
      } catch(err) {
        _imShowError(t('import.invalidJson', { msg: err.message }));
      }
    };
    reader.readAsText(file, 'utf-8');
  } else if (isYaml) {
    reader.onload = ev => {
      document.getElementById('import-text-area').value =
        t('import.yamlLoaded');
    };
    reader.readAsText(file, 'utf-8');
  } else {
    reader.onload = ev => { document.getElementById('import-text-area').value = ev.target.result || ''; };
    reader.readAsText(file, 'utf-8');
  }
}

function importReplaceDataset() {
  if (!_importLoadedFile) { _imShowError(t('import.noFileLoaded')); return; }
  if (individuals.size && !confirm(t('import.replaceConfirm'))) return;
  const file = _importLoadedFile;
  closeTextImport();
  _loadDatasetFile(file);
}

// ── Tesseract OCR (lazy-loaded) ──────────────────────────────────────────
let _tesseractLoading = null;
function _loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tesseractLoading) return _tesseractLoading;
  _tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error(t('import.tesseractLoadError')));
    document.head.appendChild(s);
  });
  return _tesseractLoading;
}

async function runImportOcr() {
  if (!_importImageData) { _imShowError(t('import.noImage')); return; }
  const statusEl = document.getElementById('import-ocr-status');
  const btn = document.getElementById('import-ocr-btn');
  btn.disabled = true;
  statusEl.textContent = t('import.ocrLoading');
  try {
    const Tesseract = await _loadTesseract();
    const dataUrl = 'data:' + _importImageData.mediaType + ';base64,' + _importImageData.base64;
    statusEl.textContent = t('import.ocrProgress', { pct: 0 });
    const { data } = await Tesseract.recognize(dataUrl, 'deu+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          statusEl.textContent = t('import.ocrProgress', { pct: Math.round(m.progress*100) });
        }
      }
    });
    const text = (data?.text || '').trim();
    if (!text) { _imShowError(t('import.ocrNoText')); statusEl.textContent = ''; return; }
    document.getElementById('import-text-area').value = text;
    statusEl.textContent = t('import.ocrDone', { chars: text.length });
  } catch (err) {
    _imShowError(t('import.ocrError', { msg: err.message || String(err) }));
    statusEl.textContent = '';
  } finally {
    btn.disabled = false;
  }
}

async function runImportAi(mode) {
  // mode: 'image' (default if image loaded) | 'text'
  const useText = mode === 'text' || (!_importImageData && mode !== 'image');
  const textVal = (document.getElementById('import-text-area').value || '').trim();
  if (useText) {
    if (!textVal || textVal.startsWith('[')) { _imShowError(t('import.noTextToAnalyze')); return; }
  } else if (!_importImageData) {
    _imShowError(t('import.noImage')); return;
  }

  document.getElementById('import-ai-key-row').style.display = 'flex';
  const keyInput = document.getElementById('ai-api-key-input');
  if (!keyInput.value) {
    if (window.ANTHROPIC_API_KEY) keyInput.value = window.ANTHROPIC_API_KEY;
    else {
      const saved = localStorage.getItem('ai_api_key');
      if (saved) keyInput.value = saved;
    }
  }
  const apiKey = _aiGetKey();
  if (!apiKey) { _imShowError(t('import.enterApiKey')); keyInput.focus(); return; }
  const model = document.getElementById('ai-model-select').value;
  const imgBtn  = document.getElementById('import-ai-btn');
  const textBtn = document.getElementById('import-ai-text-btn');
  if (imgBtn)  imgBtn.disabled  = true;
  if (textBtn) textBtn.disabled = true;
  const statusEl = document.getElementById('import-ocr-status');
  statusEl.textContent = t('import.aiAnalyzing');
  try {
    const persons = await _aiParseContent(apiKey, model, useText ? textVal : null, useText ? null : _importImageData);
    if (!persons || !persons.length) { _imShowError(t('import.aiNoPersons')); statusEl.textContent = ''; return; }
    _importJsonPersons = persons;
    document.getElementById('import-text-area').value =
      t('import.aiSummary', { n: persons.length, plural: persons.length !== 1 ? 'en' : '' });
    statusEl.textContent = t('import.aiDone');
  } catch (err) {
    _imShowError(t('import.aiError', { msg: err.message || String(err) }));
    statusEl.textContent = '';
  } finally {
    if (imgBtn)  imgBtn.disabled  = false;
    if (textBtn) textBtn.disabled = false;
  }
}

function parseImportText() {
  let persons;
  if (_importJsonPersons) {
    persons = _importJsonPersons;
  } else {
    const raw = (document.getElementById('import-text-area').value || '').trim();
    if (!raw) { alert(t('import.enterText')); return; }
    const clean = _tiCleanText(raw);
    persons = _tiParseText(clean);
    if (!persons.length) {
      alert(t('import.noPersons'));
      return;
    }
  }

  _importActions = _tiGenerateActions(persons);

  if (!_importActions.length) {
    alert(t('import.allExisting', { n: persons.length }));
    return;
  }

  document.getElementById('import-step-input').style.display = 'none';
  document.getElementById('import-step-review').style.display = '';
  _renderImportReview();
}

function _renderImportSummary() {
  const nPers    = _importActions.filter(a => a.kind === 'person').length;
  const nUpd     = _importActions.filter(a => a.kind === 'update').length;
  const nMarr    = _importActions.filter(a => a.kind === 'marriage').length;
  const nApp     = _importActions.filter(a => a.status === 'approved').length;
  const nSkip    = _importActions.filter(a => a.status === 'skipped').length;
  const nPend    = _importActions.filter(a => a.status === 'pending').length;

  document.getElementById('import-summary').innerHTML = `
    <div class="import-summary-bar">
      <span class="import-stat"><b>${_importActions.length}</b> ${t('import.summarySuggestions', { total: _importActions.length })}</span>
      <span class="import-stat import-stat--person">&#x1F464; <b>${nPers}</b> ${t('import.summaryNew', { n: nPers })}</span>
      <span class="import-stat import-stat--update">&#x270F; <b>${nUpd}</b> ${t('import.summaryUpdate', { n: nUpd, plural: nUpd !== 1 ? 'en' : '' })}</span>
      <span class="import-stat import-stat--marriage">&#x1F48D; <b>${nMarr}</b> ${t('import.summaryMarriage', { n: nMarr, plural: nMarr !== 1 ? 'n' : '' })}</span>
      <span class="import-stat import-stat--approved">&#x2713; <b>${nApp}</b> ${t('import.summaryApproved', { n: nApp })}</span>
      <span class="import-stat import-stat--skipped">&#x2715; <b>${nSkip}</b> ${t('import.summarySkipped', { n: nSkip })}</span>
      <span class="import-stat import-stat--pending">&#x23F3; <b>${nPend}</b> ${t('import.summaryPending', { n: nPend })}</span>
    </div>
    <div class="import-bulk-actions">
      <button class="import-bulk-btn import-bulk-btn--approve" onclick="_importApproveAll()">&#x2713; ${t('import.approveAll')}</button>
      <button class="import-bulk-btn import-bulk-btn--skip"    onclick="_importSkipAll()">&#x2715; ${t('import.skipAll')}</button>
      <button class="import-bulk-btn import-bulk-btn--reset"   onclick="_importResetAll()">&#x21BA; ${t('import.resetAll')}</button>
    </div>
  `;
}

function _renderImportReview() {
  _renderImportSummary();
  const sorted = [..._importActions].sort((a, b) => (a._sourceIdx ?? 0) - (b._sourceIdx ?? 0));
  document.getElementById('import-actions-list').innerHTML =
    sorted.map((action, idx) => _renderImportCard(action, idx)).join('');
}

// Person-reference fields that get autocomplete + link/unlink in import cards
const _IM_PERSON_FIELDS = new Set(['Name','Father','Mother','Husband','Wife']);

function _imFieldLabel(label) {
  const key = 'import.field' + label.replace(/\s+/g, '');
  const tr = t(key);
  return tr === key ? label : tr;
}

function _imDropId(actionId, fieldKey) {
  return 'nacd-' + actionId + '-' + fieldKey.replace(/[\s:]/g, '_');
}

function _imLinkedDisplay(link) {
  if (!link) return null;
  if (link.type === 'existing') {
    const indi = individuals.get(link.id);
    if (!indi) return null;
    return {
      name:      indi.name || '',
      maiden:    indi.maidenName || '',
      year:      indi.birth?.date?.match(/\b(\d{4})\b/)?.[1] || '',
      deathYear: indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || '',
      tag:       '',
    };
  }
  const pa = _importActions.find(a => a.id === link.id);
  if (!pa) return null;
  return {
    name:      pa.fields['Name'] || '',
    maiden:    '',
    year:      (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || '',
    deathYear: (pa.fields['Death Date']||'').match(/\b(\d{4})\b/)?.[1] || '',
    tag:       t('import.badgeImport'),
  };
}

// Rich tooltip HTML for a linked person — shows everything needed to differentiate.
function _imLinkedTooltipHtml(link) {
  if (!link) return '';
  if (link.type === 'existing') {
    const indi = individuals.get(link.id);
    if (!indi) return '';
    const rows = [];
    rows.push(`<div class="import-tt-name">${escHtml(indi.name || t('import.noName'))}</div>`);
    const sub = [];
    if (indi.maidenName) sub.push(`${t('tooltip.born', { name: indi.maidenName })}`);
    if (indi.sex) sub.push(indi.sex);
    if (sub.length) rows.push(`<div class="import-tt-sub">${sub.join(' · ')}</div>`);
    if (indi.birth?.date || indi.birth?.plac)
      rows.push(`<div class="import-tt-line"><b>${t('import.tooltipBorn')}</b>${escHtml(indi.birth?.date || '?')}${indi.birth?.plac ? t('import.tooltipIn') + escHtml(indi.birth.plac) : ''}</div>`);
    if (indi.death?.date || indi.death?.plac)
      rows.push(`<div class="import-tt-line"><b>${t('import.tooltipDied')}</b>${escHtml(indi.death?.date || '?')}${indi.death?.plac ? t('import.tooltipIn') + escHtml(indi.death.plac) : ''}</div>`);
    // Parents
    const famc = (indi.famc || [])[0];
    if (famc) {
      const fam = families.get(famc);
      if (fam) {
        const fa = fam.husb ? individuals.get(fam.husb)?.name : '';
        const mo = fam.wife ? individuals.get(fam.wife)?.name : '';
        if (fa || mo) rows.push(`<div class="import-tt-line">${t('import.parents')}: ${escHtml([fa, mo].filter(Boolean).join(' & '))}</div>`);
      }
    }
    // Spouses
    const spouseNames = (indi.fams || []).map(fId => {
      const f = families.get(fId); if (!f) return null;
      const sId = f.husb === link.id ? f.wife : f.husb;
      return sId ? individuals.get(sId)?.name : null;
    }).filter(Boolean);
    if (spouseNames.length) rows.push(`<div class="import-tt-line">${t('import.marriage')}: ${escHtml(spouseNames.join(', '))}</div>`);
    // Children
    const children = [];
    for (const fId of (indi.fams || [])) {
      const f = families.get(fId); if (!f) continue;
      for (const cId of (f.chil || [])) {
        const c = individuals.get(cId);
        if (c) children.push(c.name);
      }
    }
    if (children.length) rows.push(`<div class="import-tt-line">${t('import.children')}: ${escHtml(children.join(', '))}</div>`);
    if (indi.note) rows.push(`<div class="import-tt-note">${escHtml(indi.note.slice(0, 220))}${indi.note.length > 220 ? '…' : ''}</div>`);
    rows.push(`<div class="import-tt-id">${t('import.id')}: ${escHtml(link.id)}</div>`);
    return rows.join('');
  }
  // Pending (another import action)
  const pa = _importActions.find(a => a.id === link.id);
  if (!pa) return '';
  const rows = [];
  rows.push(`<div class="import-tt-name">${escHtml(pa.fields['Name'] || t('import.noName'))}</div>`);
  rows.push(`<div class="import-tt-sub">${t('import.fromImport')}</div>`);
  for (const [k, v] of Object.entries(pa.fields)) {
    if (k === 'Name' || !v) continue;
    rows.push(`<div class="import-tt-line"><b>${escHtml(_imFieldLabel(k))}:</b> ${escHtml(String(v).slice(0, 200))}</div>`);
  }
  return rows.join('');
}

function _imLinkedBadge(actionId, fieldKey, link, label) {
  const d = _imLinkedDisplay(link);
  if (!d) return '';
  const maiden    = d.maiden    ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: d.maiden })}</span>` : '';
  const year      = d.year      ? ` <span class="import-linked-year">*${d.year}</span>` : '';
  const deathYear = d.deathYear ? ` <span class="import-linked-year">&#x2020;${d.deathYear}</span>` : '';
  const tag       = d.tag       ? ` <span class="import-linked-tag">${escHtml(d.tag)}</span>` : '';
  const tipHtml   = _imLinkedTooltipHtml(link);
  return `<div class="import-field-row">
    <label class="import-field-label">${escHtml(label)}</label>
    <div class="import-field-linked" tabindex="0">
      <span class="import-field-linked-name">${escHtml(d.name)}</span>${maiden}${year}${deathYear}${tag}
      <button class="import-field-change-btn" onclick="_imChangeFieldLink('${actionId}','${fieldKey}')" title="${t('import.changeFieldLink')}">&#x21BB;</button>
      <button class="import-field-unlink-btn" onclick="_imFieldUnlink('${actionId}','${fieldKey}')" title="${t('import.unlinkTitle')}">&#x2715;</button>
      <div class="import-linked-tip">${tipHtml}</div>
    </div>
  </div>`;
}

// Two sources disagree about one field. Show both, say which one will be
// written, and make swapping a single click.
function _imConflictRow(action, field, displayLabel, incoming, existing) {
  const useImported = !!action.fieldApply[field];
  const pick = (active, value, tag) => `
    <div class="import-conflict-side${active ? ' import-conflict-side--on' : ''}">
      <span class="import-conflict-tag">${tag}</span>
      <span class="import-conflict-val">${escHtml(value)}</span>
    </div>`;
  return `<div class="import-field-row import-field-row--conflict">
    <label class="import-field-label">${escHtml(displayLabel)}</label>
    <div class="import-conflict" role="group"
         onclick="_imToggleFieldApply('${action.id}','${escJs(field)}')"
         title="${t('import.conflictTitle')}">
      ${pick(!useImported, existing, t('import.inTree'))}
      ${pick(useImported, incoming, t('import.fromImport'))}
    </div>
  </div>`;
}

function _imPersonInputRow(action, label, fieldKey, val) {
  const fid = 'if-' + action.id + '-' + fieldKey.replace(/[\s:]/g,'_');
  const dropId = _imDropId(action.id, fieldKey);
  return `<div class="import-field-row">
    <label class="import-field-label" for="${fid}">${escHtml(label)}</label>
    <div class="import-name-ac-wrap">
      <input class="import-field-input" id="${fid}" type="text"
             value="${escHtml(val||'')}"
             data-action="${action.id}" data-field="${fieldKey}"
             data-ac-person="true"
             placeholder="${t('import.emptyPlaceholder')}" autocomplete="off">
      <div class="import-name-drop" id="${dropId}"></div>
    </div>
  </div>`;
}

function _imChildrenRows(action) {
  // Sync _childrenArr from fields on first render
  if (!action._childrenArr) {
    const raw = action.fields['Children'] || '';
    action._childrenArr = raw ? raw.split(';').map(s => s.trim()).filter(Boolean) : [];
  }
  action.fieldLinks = action.fieldLinks || {};

  const rows = action._childrenArr.map((name, idx) => {
    const key  = `Children:${idx}`;
    const link = action.fieldLinks[key];
    if (link) return _imLinkedBadge(action.id, key, link, idx === 0 ? t('import.fieldChildren') : '');
    const dropId = _imDropId(action.id, key);
    const fid    = 'if-' + action.id + '-Children_' + idx;
    const lbl    = idx === 0 ? t('import.fieldChildren') : '';
    return `<div class="import-field-row import-child-row">
      <label class="import-field-label">${escHtml(lbl)}</label>
      <div class="import-name-ac-wrap" style="flex:1">
        <input class="import-field-input" id="${fid}" type="text"
               value="${escHtml(name)}"
               data-action="${action.id}" data-field="${key}"
               data-ac-person="true"
               placeholder="${t('import.childPlaceholder')}" autocomplete="off">
        <div class="import-name-drop" id="${dropId}"></div>
      </div>
      <button class="import-child-rm-btn" onclick="_imRemoveChild('${action.id}',${idx})">&#x2715;</button>
    </div>`;
  }).join('');

  const addBtn = `<div class="import-field-row import-child-row">
    <label class="import-field-label"></label>
    <button class="import-child-add-btn" onclick="_imAddChild('${action.id}')">+ ${t('import.childPlaceholder')}</button>
  </div>`;

  return rows + addBtn;
}

function _renderImportCard(action) {
  const kindLabel = action.kind === 'person' ? t('import.kindAddPerson') : action.kind === 'update' ? t('import.kindUpdate') : t('import.kindMarriage');
  const kindClass = action.kind === 'person' ? 'import-badge--person' : action.kind === 'update' ? 'import-badge--update' : 'import-badge--marriage';
  const stCls = { pending:'import-status--pending', approved:'import-status--approved', skipped:'import-status--skipped' }[action.status];
  const stLbl = { pending:`&#x23F3; ${t('import.statusPending')}`, approved:`&#x2713; ${t('import.statusApproved')}`, skipped:`&#x2715; ${t('import.statusSkipped')}` }[action.status];

  action.fieldLinks = action.fieldLinks || {};
  const isPersonAction = action.kind === 'person' || action.kind === 'update';

  const fieldsHtml = Object.entries(action.fields).map(([label, val]) => {
    const displayLabel = _imFieldLabel(label);
    const isPersonField = _IM_PERSON_FIELDS.has(label);
    const link = action.fieldLinks[label];

    // Children: special multi-row list
    if (label === 'Children') return _imChildrenRows(action);

    // Person field that is linked → show badge
    if (isPersonField && link) return _imLinkedBadge(action.id, label, link, displayLabel);

    // Name field when whole action is linked to existing person → show badge with unlink
    if (label === 'Name' && isPersonAction && action.existingId) {
      const linkObj = { type: 'existing', id: action.existingId };
      const d = _imLinkedDisplay(linkObj);
      const name   = d ? d.name   : val;
      const maiden    = d?.maiden    ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: d.maiden })}</span>` : '';
      const year      = d?.year      ? ` <span class="import-linked-year">*${d.year}</span>` : '';
      const deathYear = d?.deathYear ? ` <span class="import-linked-year">&#x2020;${d.deathYear}</span>` : '';
      const tipHtml = _imLinkedTooltipHtml(linkObj);
      return `<div class="import-field-row">
        <label class="import-field-label">${displayLabel}</label>
        <div class="import-field-linked" tabindex="0">
          <span class="import-field-linked-name">${escHtml(name)}</span>${maiden}${year}${deathYear}
          <button class="import-btn-change" onclick="_imChangeMainLink('${action.id}')" title="${t('import.changeLinkTitle')}">&#x21BB; ${t('import.changeLink')}</button>
          <button class="import-btn-unlink" onclick="_imUnlink('${action.id}')" title="${t('import.unlinkTitle')}">&#x2715; ${t('import.unlink')}</button>
          <div class="import-linked-tip">${tipHtml}</div>
        </div>
      </div>`;
    }

    // Person field with autocomplete input
    if (isPersonField) return _imPersonInputRow(action, displayLabel, label, val);

    // On a linked card, a field the tree already answers is a decision, not an
    // input: show both answers and let the reader pick. Silently dropping the
    // imported value — which is what this did — hides the disagreement and the
    // choice along with it.
    if (action.existingId && action.fieldApply && _IM_UPDATE_FIELDS.includes(label)) {
      const indi = individuals.get(action.existingId);
      const existing = indi ? _imExistingValue(indi, label).trim() : '';
      const incoming = (val || '').trim();
      if (existing && incoming && existing !== incoming) {
        return _imConflictRow(action, label, displayLabel, incoming, existing);
      }
      if (existing && !incoming) {
        return `<div class="import-field-row">
          <label class="import-field-label">${escHtml(displayLabel)}</label>
          <div class="import-field-kept">${escHtml(existing)}
            <span class="import-field-kept-tag">${t('import.inTree')}</span></div>
        </div>`;
      }
    }

    // Regular non-person field
    const wideClass = ''; // children handled above
    const fid = `if-${action.id}-${label.replace(/\s+/g,'_')}`;
    return `<div class="import-field-row${wideClass}">
      <label class="import-field-label" for="${fid}">${escHtml(displayLabel)}</label>
      <input class="import-field-input" id="${fid}" type="text"
             value="${escHtml(val||'')}"
             data-action="${action.id}" data-field="${label}"
             placeholder="${t('import.emptyPlaceholder')}">
    </div>`;
  }).join('');

  const srcHtml = action.source ? `
    <details class="import-source-details">
      <summary>${t('import.sourceText')}</summary>
      <div class="import-source-text">${escHtml(action.source)}</div>
    </details>` : '';

  const appActive = action.status === 'approved' ? ' import-btn--active' : '';
  const skpActive = action.status === 'skipped'  ? ' import-btn--active' : '';

  // Manual-link button for new-person cards not yet linked to anyone
  const showLinkBtn = isPersonAction && !action.existingId;
  const linkBtnHtml = showLinkBtn
    ? `<button class="import-btn import-btn--link" onclick="openMatchDialog('${action.id}')" title="${t('import.linkTitle')}">&#x1F517; ${t('import.link')}</button>`
    : '';

  return `<div class="import-action-card import-action-card--${action.status}" data-action-id="${action.id}">
    <div class="import-card-header">
      <span class="import-badge ${kindClass}">${kindLabel}</span>
      <span class="import-status ${stCls}">${stLbl}</span>
    </div>
    <div class="import-fields">${fieldsHtml}</div>
    ${srcHtml}
    <div class="import-card-actions">
      ${linkBtnHtml}
      <button class="import-btn import-btn--approve${appActive}" data-action="${action.id}" data-status="approved">&#x2713; ${t('import.approve')}</button>
      <button class="import-btn import-btn--skip${skpActive}"    data-action="${action.id}" data-status="skipped">&#x2715; ${t('import.skip')}</button>
    </div>
  </div>`;
}

// Replace a linked field with an editable input pre-populated by the linked name, then focus + open suggestions.
function _imChangeFieldLink(actionId, fieldKey) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};
  const link = action.fieldLinks[fieldKey];
  const prevName = _imLinkedDisplay(link)?.name || '';
  delete action.fieldLinks[fieldKey];
  if (fieldKey.startsWith('Children:')) {
    const idx = parseInt(fieldKey.split(':')[1]);
    if (action._childrenArr) action._childrenArr[idx] = prevName;
    action.fields['Children'] = (action._childrenArr || []).join('; ');
  } else if (_IM_PERSON_FIELDS.has(fieldKey)) {
    action.fields[fieldKey] = prevName;
  }
  const card = document.querySelector(`[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
  // Focus the new input so autocomplete drop opens
  setTimeout(() => {
    const safe = fieldKey.replace(/[\s:]/g,'_').replace('Children:', 'Children_');
    const inp = document.getElementById('if-' + actionId + '-' + safe);
    if (inp) { inp.focus(); inp.select(); }
  }, 0);
}

// "Ändern" on a fully-linked main-person card: detach + open match dialog for re-selection.
function _imChangeMainLink(actionId) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;
  _imUnlink(actionId);
  openMatchDialog(actionId);
}

// Single delegated listener on the list container (set up once)
document.addEventListener('DOMContentLoaded', () => {
  const list = document.getElementById('import-actions-list');
  if (!list) return;

  // Button clicks (approve / skip)
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    const id = btn.dataset.action;
    const wantedStatus = btn.dataset.status;
    const action = _importActions.find(a => a.id === id);
    if (!action) return;
    action.status = (action.status === wantedStatus) ? 'pending' : wantedStatus;

    // Patch only the affected card — avoid full list re-render
    const card = list.querySelector(`[data-action-id="${id}"]`);
    if (card) {
      card.className = `import-action-card import-action-card--${action.status}`;
      const stCls = { pending:'import-status--pending', approved:'import-status--approved', skipped:'import-status--skipped' }[action.status];
      const stLbl = { pending:`&#x23F3; ${t('import.statusPending')}`, approved:`&#x2713; ${t('import.statusApproved')}`, skipped:`&#x2715; ${t('import.statusSkipped')}` }[action.status];
      const badge = card.querySelector('.import-status');
      if (badge) { badge.className = `import-status ${stCls}`; badge.innerHTML = stLbl; }
      card.querySelectorAll('[data-status]').forEach(b => {
        b.classList.toggle('import-btn--active', b.dataset.status === action.status);
      });
    }

    // Update only the summary counts (cheap)
    _renderImportSummary();
  });

  // Field edits (delegated input)
  list.addEventListener('input', e => {
    const inp = e.target.closest('[data-action][data-field]');
    if (!inp) return;
    const action = _importActions.find(a => a.id === inp.dataset.action);
    if (!action) return;
    const field = inp.dataset.field;
    if (field.startsWith('Children:')) {
      // Update individual child in array and rebuild field string
      action._childrenArr = action._childrenArr || [];
      const idx = parseInt(field.split(':')[1]);
      action._childrenArr[idx] = inp.value;
      action.fields['Children'] = action._childrenArr.join('; ');
    } else {
      action.fields[field] = inp.value;
    }
    if (inp.dataset.acPerson) _imPersonSearch(inp, action.id, field);
  });

  // Person-field autocomplete: show on focus, hide on blur
  list.addEventListener('focusin', e => {
    const inp = e.target.closest('[data-ac-person]');
    if (inp) _imPersonSearch(inp, inp.dataset.action, inp.dataset.field);
  });
  list.addEventListener('focusout', e => {
    const inp = e.target.closest('[data-ac-person]');
    if (inp) setTimeout(() => { const d = document.getElementById(_imDropId(inp.dataset.action, inp.dataset.field)); if (d) { d.innerHTML = ''; d.style.display = 'none'; } }, 180);
  });
});

function _importApproveAll() { _importActions.forEach(a => a.status = 'approved'); _renderImportReview(); }
function _importSkipAll()    { _importActions.forEach(a => a.status = 'skipped');  _renderImportReview(); }
function _importResetAll()   { _importActions.forEach(a => a.status = 'pending');  _renderImportReview(); }

function backToInputImport() {
  document.getElementById('import-step-input').style.display = '';
  document.getElementById('import-step-review').style.display = 'none';
}

function applyImport() {
  const approved = _importActions.filter(a => a.status === 'approved');
  if (approved.length === 0) {
    alert(t('import.noApprovedChanges'));
    return;
  }

  // Show progress overlay, hide review step
  document.getElementById('import-step-review').style.display = 'none';
  const overlay  = document.getElementById('import-progress-overlay');
  const bar      = document.getElementById('import-progress-bar');
  const countEl  = document.getElementById('import-progress-count');
  const labelEl  = document.getElementById('import-progress-label');
  overlay.style.display = 'flex';
  bar.style.width = '0%';

  const total = approved.length;
  const BATCH = 50;
  let done = 0;

  function tick() {
    const next = Math.min(done + BATCH, total);
    done = next;
    const pct = Math.round((done / total) * 100);
    bar.style.width = pct + '%';
    countEl.textContent = t('import.progressCount', { done, total });

    if (done < total) {
      setTimeout(tick, 0);
      return;
    }

    // All ticks done — now run the actual synchronous apply + rebuild
    labelEl.textContent = t('import.graphUpdate');
    bar.style.width = '100%';
    // Double rAF: first frame commits the DOM change, second frame runs after paint
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const report = _tiApplyActions(_importActions);
      _fullRebuildGraph();
      closeTextImport();

      const nAdd  = report.filter(r => r.type === 'add').length;
      const nUpd  = report.filter(r => r.type === 'update').length;
      const nFam  = report.filter(r => r.type === 'fam').length;
      const nSkip = report.filter(r => r.type === 'skip').length;
      alert(t('import.importDone', { add: nAdd, update: nUpd, marriages: nFam, skipped: nSkip }));
    }));
  }

  setTimeout(tick, 0);
}

window.openImport        = openImport;
window.openTextImport    = openTextImport;
window.closeTextImport   = closeTextImport;
window.handleImportFileSelect = handleImportFileSelect;
window.parseImportText   = parseImportText;
window.backToInputImport = backToInputImport;
window.applyImport       = applyImport;
window._importApproveAll = _importApproveAll;
window._importSkipAll    = _importSkipAll;
window._importResetAll   = _importResetAll;
window._imDragOver       = _imDragOver;
window._imDragLeave      = _imDragLeave;
window._imDrop           = _imDrop;
window.runImportOcr      = runImportOcr;
window.runImportAi       = runImportAi;
window.importReplaceDataset = importReplaceDataset;

// ═══════════════════════════════════════════════════════════════
// INTERACTIVE MATCH SELECTION FOR IMPORT
// ═══════════════════════════════════════════════════════════════

let _currentMatchActionId = null;
let _currentMatchCandidates = [];

function openMatchDialog(actionId) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;
  
  _currentMatchActionId = actionId;
  
  // Display current entry
  const currentHtml = `
    <div class="import-match-person">
      <div class="import-match-name">${escHtml(action.fields['Name'] || t('import.noName'))}</div>
      <div class="import-match-details">
        ${action.fields['Birth Date'] ? `${t('import.fieldBirthDate')}: ${escHtml(action.fields['Birth Date'])}` : ''}
        ${action.fields['Birth Place'] ? `${t('import.tooltipIn')}${escHtml(action.fields['Birth Place'])}` : ''}
      </div>
    </div>
  `;
  document.getElementById('import-match-current-content').innerHTML = currentHtml;
  
  // Find candidates
  _currentMatchCandidates = _findMatchCandidates(action);
  renderMatchCandidates(_currentMatchCandidates);
  
  // Clear search
  document.getElementById('import-match-search-input').value = '';
  
  // Show dialog
  document.getElementById('import-match-dialog').style.display = 'flex';
}

function closeMatchDialog() {
  document.getElementById('import-match-dialog').style.display = 'none';
  _currentMatchActionId = null;
  _currentMatchCandidates = [];
}

function _findMatchCandidates(action) {
  const candidates = [];
  const searchName = (action.fields['Name'] || '').toLowerCase();
  const searchBirth = (action.fields['Birth Date'] || '').match(/\b(\d{4})\b/)?.[1] || '';
  
  // Search in existing individuals
  for (const [id, indi] of individuals) {
    const indiName = (indi.name || '').toLowerCase();
    const indiBirth = (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || '';
    
    let score = 0;
    
    // Exact name match
    if (indiName === searchName) {
      score = 100;
    } else if (indiName.includes(searchName) || searchName.includes(indiName)) {
      score = 50;
    } else if (indiName.split(' ').pop() === searchName.split(' ').pop()) {
      // Same surname
      score = 30;
    }
    
    // Birth year bonus
    if (score > 0 && indiBirth && searchBirth) {
      if (indiBirth === searchBirth) {
        score += 50;
      } else if (Math.abs(parseInt(indiBirth) - parseInt(searchBirth)) <= 2) {
        score += 20;
      }
    }
    
    if (score > 0) {
      candidates.push({
        type: 'existing',
        id: id,
        name: indi.name,
        birth: indi.birth?.date || '',
        death: indi.death?.date || '',
        sex: indi.sex || 'U',
        score: score,
        data: indi
      });
    }
  }
  
  // Also search in other pending import actions
  for (const otherAction of _importActions) {
    if (otherAction.id === action.id) continue;
    if (otherAction.status === 'skipped') continue;
    
    const otherName = (otherAction.fields['Name'] || '').toLowerCase();
    const otherBirth = (otherAction.fields['Birth Date'] || '').match(/\b(\d{4})\b/)?.[1] || '';
    
    let score = 0;
    if (otherName === searchName) {
      score = 90;
    } else if (otherName.includes(searchName) || searchName.includes(otherName)) {
      score = 40;
    }
    
    if (score > 0 && otherBirth && searchBirth && otherBirth === searchBirth) {
      score += 40;
    }
    
    if (score > 0) {
      candidates.push({
        type: 'pending',
        actionId: otherAction.id,
        name: otherAction.fields['Name'],
        birth: otherAction.fields['Birth Date'] || '',
        death: otherAction.fields['Death Date'] || '',
        sex: otherAction.fields['Sex'] || 'U',
        score: score,
        data: otherAction
      });
    }
  }
  
  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function renderMatchCandidates(candidates) {
  const listEl = document.getElementById('import-match-list');
  
  if (candidates.length === 0) {
    listEl.innerHTML = `<div class="import-match-empty">${t('import.noMatchesFound')}</div>`;
    return;
  }

  listEl.innerHTML = candidates.map((c, idx) => `
    <div class="import-match-candidate" onclick="selectMatchCandidate('${c.type}', '${c.type === 'existing' ? c.id : c.actionId}')">
      <div class="import-match-candidate-type ${c.type === 'existing' ? 'type-existing' : 'type-pending'}">
        ${c.type === 'existing' ? t('import.matchExisting') : t('import.matchPending')}
      </div>
      <div class="import-match-candidate-info">
        <div class="import-match-candidate-name">${escHtml(c.name)}</div>
        <div class="import-match-candidate-details">
          ${c.birth ? `${t('import.bornShort')} ${escHtml(c.birth)}` : ''}
          ${c.death ? ` - ${t('import.diedShort')} ${escHtml(c.death)}` : ''}
          [${c.sex}]
        </div>
      </div>
      <div class="import-match-candidate-score">${t('import.score')}: ${c.score}</div>
    </div>
  `).join('');
}

function searchMatchCandidates() {
  const query = document.getElementById('import-match-search-input').value.toLowerCase().trim();
  if (!query) {
    renderMatchCandidates(_currentMatchCandidates);
    return;
  }

  // Search the whole dataset + all pending import actions, not just the pre-scored shortlist.
  const results = [];
  for (const [id, indi] of individuals) {
    if (!(indi.name || '').toLowerCase().includes(query)) continue;
    results.push({
      type: 'existing',
      id,
      name: indi.name || '',
      birth: indi.birth?.date || '',
      death: indi.death?.date || '',
      sex: indi.sex || 'U',
      score: 0,
      data: indi
    });
  }
  const currentActionId = _currentMatchActionId;
  for (const a of _importActions) {
    if (a.id === currentActionId || a.status === 'skipped') continue;
    const name = a.fields?.['Name'] || '';
    if (!name.toLowerCase().includes(query)) continue;
    results.push({
      type: 'pending',
      actionId: a.id,
      name,
      birth: a.fields['Birth Date'] || '',
      death: a.fields['Death Date'] || '',
      sex: a.fields['Sex'] || 'U',
      score: 0,
      data: a
    });
  }
  renderMatchCandidates(results);
}

function selectMatchCandidate(type, targetId) {
  if (!_currentMatchActionId) return;
  
  const action = _importActions.find(a => a.id === _currentMatchActionId);
  if (!action) return;
  
  if (type === 'existing') {
    if (!_imLinkExisting(action, targetId)) return;
    
  } else if (type === 'pending') {
    // Link to another pending action
    const targetAction = _importActions.find(a => a.id === targetId);
    if (!targetAction) return;
    
    // Merge data into the target action
    if (action.fields['Birth Date'] && !targetAction.fields['Birth Date']) {
      targetAction.fields['Birth Date'] = action.fields['Birth Date'];
    }
    if (action.fields['Birth Place'] && !targetAction.fields['Birth Place']) {
      targetAction.fields['Birth Place'] = action.fields['Birth Place'];
    }
    if (action.fields['Death Date'] && !targetAction.fields['Death Date']) {
      targetAction.fields['Death Date'] = action.fields['Death Date'];
    }
    if (action.fields['Death Place'] && !targetAction.fields['Death Place']) {
      targetAction.fields['Death Place'] = action.fields['Death Place'];
    }
    
    // Mark current action as skip (will be merged into target)
    action.status = 'skipped';
    action._mergedInto = targetId;
  }
  
  // Refresh the import review UI
  _renderImportReview();
  closeMatchDialog();
}

window.openMatchDialog      = openMatchDialog;
window.closeMatchDialog     = closeMatchDialog;
window.searchMatchCandidates = searchMatchCandidates;
window.selectMatchCandidate = selectMatchCandidate;

// ── Import card: inline person-field search & linking ──────────────────────

function _imPersonSearch(inp, actionId, fieldKey) {
  const dropId = _imDropId(actionId, fieldKey);
  const drop   = document.getElementById(dropId);
  if (!drop) return;

  const raw    = inp.value.trim();
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;

  const yearM   = raw.match(/\b(\d{4})\b/);
  const qYear   = yearM ? yearM[1] : '';
  let   qRest   = raw.replace(/\b\d{4}\b/, '').trim();
  const maidenM = qRest.match(/\((?:geb\.?\s*|née\s*)?([^)]+)\)/i) ||
                  qRest.match(/\bgeb\.?\s+([A-Za-zÀ-ž]+)/i) ||
                  qRest.match(/\bnée\s+([A-Za-zÀ-ž]+)/i);
  const qMaiden = maidenM ? maidenM[1].toLowerCase().trim() : '';
  if (maidenM) qRest = qRest.replace(maidenM[0], '').trim();
  const qName = qRest.toLowerCase();

  function scoreStr(iName, iMaiden, iYear) {
    let score = 0;
    if (qName) {
      if (iName === qName)                          score += 1.0;
      else if (iName.startsWith(qName))             score += 0.8;
      else if (iName.includes(qName))               score += 0.6;
      else if (iMaiden && iMaiden.includes(qName))  score += 0.55;
      else {
        const words = qName.split(/\s+/).filter(w => w.length > 1);
        if (words.length) {
          const hits = words.filter(w => iName.includes(w) || iMaiden.includes(w));
          if (hits.length) score += 0.35 * hits.length / words.length;
        }
      }
    } else { score += 0.15; }
    if (score <= 0 && !qYear && !qMaiden) return 0;
    if (qMaiden) {
      if (iMaiden && iMaiden.includes(qMaiden)) score += 0.5;
      else if (iName.includes(qMaiden))          score += 0.3;
      else                                        score -= 0.3;
    }
    if (qYear && iYear) {
      const d = Math.abs(+qYear - +iYear);
      if (d === 0) score += 0.5; else if (d <= 2) score += 0.15; else score -= 0.35;
    }
    return score;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const score = scoreStr(
      (indi.name || '').toLowerCase(),
      (indi.maidenName || '').toLowerCase(),
      (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || ''
    );
    if (score > 0.05) results.push({ score, type: 'existing', id, indi });
  }
  for (const pa of _importActions) {
    if (pa.id === actionId || pa.status === 'skipped') continue;
    const score = scoreStr(
      (pa.fields['Name'] || '').toLowerCase(), '',
      (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || ''
    );
    if (score > 0.05) results.push({ score, type: 'pending', id: pa.id, pa });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 12);
  if (!top.length) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  drop.innerHTML = top.map(r => {
    if (r.type === 'existing') {
      const { id, indi } = r;
      const bYear  = indi.birth?.date?.match(/\b(\d{4})\b/)?.[1] || '';
      const dYear  = indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || '';
      const maiden = indi.maidenName ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: escHtml(indi.maidenName) })}</span>` : '';
      const bPlace = indi.birth?.plac || '';
      const parts  = [];
      if (bYear || bPlace) parts.push((bYear ? '*' + bYear : '') + (bPlace ? (bYear ? ' ' : '') + bPlace : ''));
      if (dYear) parts.push('\u2020' + dYear);
      const detail = parts.join(' \u00b7 ');
      return `<div class="import-sdrop-item" onmousedown="event.preventDefault();_imPersonSelect('${actionId}','${fieldKey}','existing','${id}')">
        <span class="import-sdrop-name">${escHtml(indi.name)}${maiden}</span>
        ${detail ? `<span class="import-sdrop-detail">${detail}</span>` : ''}
      </div>`;
    } else {
      const { id, pa } = r;
      const bYear = (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || '';
      const dYear = (pa.fields['Death Date']||'').match(/\b(\d{4})\b/)?.[1] || '';
      const parts = [];
      if (bYear) parts.push('*' + bYear);
      if (dYear) parts.push('\u2020' + dYear);
      const detail = parts.join(' \u00b7 ');
      return `<div class="import-sdrop-item import-sdrop-item--pending" onmousedown="event.preventDefault();_imPersonSelect('${actionId}','${fieldKey}','pending','${id}')">
        <span class="import-sdrop-name">${escHtml(pa.fields['Name']||'')}</span>
        ${detail ? `<span class="import-sdrop-detail">${detail}</span>` : ''}
      </div>`;
    }
  }).join('');
  drop.style.display = '';
}

function _imPersonSelect(actionId, fieldKey, type, targetId) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};

  const resolveName = (t, id) => t === 'existing'
    ? (individuals.get(id)?.name || '')
    : (_importActions.find(a => a.id === id)?.fields['Name'] || '');

  if (fieldKey === 'Name') {
    if (type !== 'existing') return;
    if (!_imLinkExisting(action, targetId)) return;
  } else if (fieldKey.startsWith('Children:')) {
    action.fieldLinks[fieldKey] = { type, id: targetId };
    const idx = parseInt(fieldKey.split(':')[1]);
    const name = resolveName(type, targetId);
    if (action._childrenArr) action._childrenArr[idx] = name;
    action.fields['Children'] = (action._childrenArr || []).join('; ');
  } else {
    action.fieldLinks[fieldKey] = { type, id: targetId };
    action.fields[fieldKey] = resolveName(type, targetId);
  }

  const card = document.querySelector(`[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
  _renderImportSummary();
}

function _imFieldUnlink(actionId, fieldKey) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};
  delete action.fieldLinks[fieldKey];
  const card = document.querySelector(`[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
  _renderImportSummary();
}

// ── Linking an import card to somebody already in the tree ──
// The fields an update can write, and where each one lives on a person.
const _IM_UPDATE_FIELDS = ['Birth Date', 'Birth Place', 'Death Date', 'Death Place', 'Sex', 'Notes'];

function _imExistingValue(indi, field) {
  switch (field) {
    case 'Birth Date':  return indi.birth?.date || '';
    case 'Birth Place': return indi.birth?.plac || '';
    case 'Death Date':  return indi.death?.date || '';
    case 'Death Place': return indi.death?.plac || '';
    case 'Sex':         return (indi.sex && indi.sex !== 'U') ? indi.sex : '';
    case 'Notes':       return indi.note || '';
    default:            return '';
  }
}

// One way in and one way out, so the two are exact opposites.
//
// Linking used to throw away every imported value the tree already had, which
// meant a disagreement between the two sources simply vanished — the reader was
// never shown that the import said 1901 where the tree says 1902, let alone
// asked which to keep. And unlinking rebuilt the card from the original parse,
// so anything typed by hand before linking was lost. Both of those make a link
// something you avoid touching rather than something you try.
function _imLinkExisting(action, targetId) {
  const indi = individuals.get(targetId);
  if (!indi) return false;

  // Remember the card as it stands — including manual edits — so unlink is
  // genuinely an undo rather than a re-parse.
  if (!action._preLink) {
    action._preLink = { kind: action.kind, status: action.status, fields: { ...action.fields } };
  }
  action.kind       = 'update';
  action.existingId = targetId;
  action.status     = 'approved';
  action.fields     = { ...action.fields, 'Name': indi.name };

  // Keep every incoming value so the card can show what the two sources say.
  // Fill a gap by default; never overwrite something already recorded without
  // being asked — the tree is the thing being edited, the import is a proposal.
  action.fieldApply = {};
  for (const f of _IM_UPDATE_FIELDS) {
    const incoming = (action.fields[f] || '').trim();
    const existing = _imExistingValue(indi, f).trim();
    action.fieldApply[f] = !!incoming && !existing;
  }
  return true;
}

// Which side of a disagreement wins, for one field.
function _imToggleFieldApply(actionId, field) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action || !action.fieldApply) return;
  action.fieldApply[field] = !action.fieldApply[field];
  const card = document.querySelector(`[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
}

function _imUnlink(actionId) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;
  action.existingId = undefined;
  action.fieldApply = undefined;

  const pre = action._preLink;
  if (pre) {
    action.kind   = pre.kind;
    action.status = pre.status;
    action.fields = { ...pre.fields };
    action._preLink = undefined;
  } else {
    // No snapshot: this card arrived already matched, so fall back to the parse.
    const p = action._person;
    action.kind   = 'person';
    action.status = 'pending';
    if (p) {
      action.fields = {
        'Name':         p.fullName,
        'Sex':          p.sex || '',
        'Birth Date':   p.birthDate  || '',
        'Birth Place':  p.birthPlace || '',
        'Death Date':   p.deathDate  || '',
        'Death Place':  p.deathPlace || '',
        'Father':       p.fatherName || '',
        'Mother':       p.motherName || '',
        'Notes':        p.notes      || '',
      };
    }
  }
  const card = document.querySelector(`[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
  _renderImportSummary();
}

function _imAddChild(actionId) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action) return;
  action._childrenArr = action._childrenArr || [];
  action._childrenArr.push('');
  action.fields['Children'] = action._childrenArr.join('; ');
  const card = document.querySelector(`[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
}

function _imRemoveChild(actionId, idx) {
  const action = _importActions.find(a => a.id === actionId);
  if (!action || !action._childrenArr) return;
  action._childrenArr.splice(idx, 1);
  action.fieldLinks = action.fieldLinks || {};
  const newLinks = {};
  for (const [k, v] of Object.entries(action.fieldLinks)) {
    if (!k.startsWith('Children:')) { newLinks[k] = v; continue; }
    const i = parseInt(k.split(':')[1]);
    if (i === idx) continue;
    newLinks['Children:' + (i > idx ? i - 1 : i)] = v;
  }
  action.fieldLinks = newLinks;
  action.fields['Children'] = action._childrenArr.join('; ');
  const card = document.querySelector(`[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
}

window._imUnlink       = _imUnlink;
window._imToggleFieldApply = _imToggleFieldApply;
window._imFieldUnlink  = _imFieldUnlink;
window._imChangeFieldLink = _imChangeFieldLink;
window._imChangeMainLink  = _imChangeMainLink;
window._imPersonSearch = _imPersonSearch;
window._imPersonSelect = _imPersonSelect;
window._imAddChild     = _imAddChild;
window._imRemoveChild  = _imRemoveChild;

// ═══════════════════════════════════════════════════════════════
// AUTOCOMPLETE
// ═══════════════════════════════════════════════════════════════

let _acEl    = null;  // singleton dropdown element
let _acInput = null;  // currently active input
let _acList  = [];    // current item list
let _acIdx   = -1;    // keyboard-selected index

function _acInit() {
  if (_acEl) return;
  _acEl = document.createElement('div');
  _acEl.id = 'ac-dropdown';
  document.body.appendChild(_acEl);
}

function _acShow(input, items) {
  _acInit();
  _acInput = input;
  _acList  = items;
  _acIdx   = -1;

  const r = input.getBoundingClientRect();
  _acEl.style.left  = r.left + 'px';
  _acEl.style.top   = (r.bottom + 2) + 'px';
  _acEl.style.width = r.width + 'px';

  _acEl.innerHTML = items.map((v, i) => {
    const label = (v && typeof v === 'object') ? v.label : v;
    return `<div class="ac-item" data-i="${i}">${escHtml(label)}</div>`;
  }).join('');
  _acEl.querySelectorAll('.ac-item').forEach(el =>
    el.addEventListener('mousedown', e => { e.preventDefault(); _acPick(+el.dataset.i); })
  );
  _acEl.style.display = 'block';
}

function _acHide() {
  if (_acEl) _acEl.style.display = 'none';
  _acInput = null;
  _acIdx   = -1;
}

function _acPick(i) {
  if (!_acInput || i < 0 || i >= _acList.length) return;
  const item = _acList[i];
  _acInput.value = (item && typeof item === 'object') ? item.value : item;
  _acInput.dispatchEvent(new Event('input', { bubbles: true }));
  _acHide();
}

function _acNav(dir) {
  if (!_acEl || _acEl.style.display === 'none') return false;
  const els = _acEl.querySelectorAll('.ac-item');
  if (!els.length) return false;
  _acIdx = Math.max(0, Math.min(els.length - 1, _acIdx + dir));
  els.forEach((el, i) => el.classList.toggle('ac-active', i === _acIdx));
  els[_acIdx]?.scrollIntoView({ block: 'nearest' });
  return true;
}

// Data source helpers — called lazily so they always reflect current data
function _acPlaces() {
  const s = new Set();
  for (const [, i] of individuals) {
    if (i.birth.plac) s.add(i.birth.plac);
    if (i.death.plac) s.add(i.death.plac);
  }
  for (const [, f] of families) for (const m of (f.marriages || [])) if (m.plac) s.add(m.plac);
  return [...s].sort();
}
function _acSurnames() {
  const m = new Map();
  for (const [, i] of individuals) if (i.surn) m.set(i.surn, (m.get(i.surn) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}
function _acOccupations() {
  const s = new Set();
  for (const [, i] of individuals) if (i.occu) s.add(i.occu);
  return [...s].sort();
}
function _acNames() {
  // Returns {label, value, searchText} objects; label includes maiden name for display.
  const seen = new Map(); // name -> {count, maidenName}
  for (const [, i] of individuals) {
    if (!i.name) continue;
    const prev = seen.get(i.name);
    seen.set(i.name, {
      count:      (prev?.count || 0) + 1,
      maidenName: prev?.maidenName || i.maidenName || '',
    });
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, { maidenName }]) => ({
      value:      name,
      label:      maidenName ? `${name} (${t('tooltip.born', { name: maidenName })})` : name,
      searchText: (name + ' ' + maidenName).toLowerCase(),
    }));
}

// Attach autocomplete to a single input.
// getFn() returns the full candidate list; called on each keystroke so it's always fresh.
function _acAttach(input, getFn) {
  if (!input || input.dataset.acAttached) return;
  input.dataset.acAttached = '1';
  input.setAttribute('autocomplete', 'off');

  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { _acHide(); return; }
    const hits = getFn().filter(v => {
      const text = (v && typeof v === 'object') ? (v.searchText ?? v.label) : v;
      return text.toLowerCase().includes(q);
    }).slice(0, 12);
    if (hits.length) _acShow(input, hits); else _acHide();
  };

  input.addEventListener('input',  refresh);
  input.addEventListener('focus',  refresh);
  input.addEventListener('blur',   () => setTimeout(_acHide, 160));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); _acNav(+1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _acNav(-1); }
    else if (e.key === 'Enter' && _acIdx >= 0) { e.preventDefault(); _acPick(_acIdx); }
    else if (e.key === 'Escape') _acHide();
  });
}

// Attach to the dynamically-rendered edit form fields (called after innerHTML is set)
function _acAttachEditForm() {
  _acAttach(document.getElementById('ef-surn'),   _acSurnames);
  _acAttach(document.getElementById('ef-maiden'), _acSurnames);
  _acAttach(document.getElementById('ef-bplac'),  _acPlaces);
  _acAttach(document.getElementById('ef-dplac'),  _acPlaces);
  _acAttach(document.getElementById('ef-occu'),   _acOccupations);
  // new-person subform inside edit form
  _acAttach(document.getElementById('ef-np-surn'), _acSurnames);
}

// ═══════════════════════════════════════════════════════════════
// AI IMPORT — Claude /v1/messages tool-use → persons[]
// ═══════════════════════════════════════════════════════════════

function _aiGetKey() {
  const el = document.getElementById('ai-api-key-input');
  const inp = el ? (el.value || '').trim() : '';
  return inp || window.ANTHROPIC_API_KEY || localStorage.getItem('ai_api_key') || '';
}

function _aiSaveKey() {
  const k = _aiGetKey();
  if (!k) return;
  localStorage.setItem('ai_api_key', k);
  const s = document.getElementById('ai-key-status');
  if (s) { s.textContent = t('import.saved'); setTimeout(() => s.textContent = '', 1500); }
}

function _aiToggleKeyVisibility() {
  const el = document.getElementById('ai-api-key-input');
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}

async function _aiParseContent(apiKey, model, text, imageData) {
  const SYSTEM = `You are a genealogy data extraction assistant. Extract EVERY person named in the source via the record_persons tool.

COMPLETENESS — critical:
- Include subjects, every spouse (even later marriages), all parents, all children, twin/sibling, and anyone named only inside notes (e.g. mother of a spouse, stepfather, grandfather).
- Children listed as "i.", "ii.", "iii." etc. are SEPARATE persons — record each one. Do not stop after the first item in such a list.
- If the source mentions N distinct people, the persons array MUST contain N entries. Skipping anyone is a failure.

Reproduce names, places and notes VERBATIM as they appear in the source. Do NOT translate, normalise, modernise or anglicise. Keep German notes in German.
Dates: "DD MON YYYY" preferred (e.g. "15 JUN 1840"); partial like "JUN 1840" or "1840" is acceptable. Month abbreviations must be English 3-letter (JAN, FEB, MAR, APR, MAY, JUN, JUL, AUG, SEP, OCT, NOV, DEC).
Empty string "" for any unknown field — never null.
List children only under the marriage they belong to. Each marriage is a separate entry in the marriages array.`;

  const tool = {
    name: 'record_persons',
    description: 'Records all persons and family relationships from the source.',
    input_schema: {
      type: 'object',
      properties: {
        persons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fullName:   { type: 'string' },
              sex:        { type: 'string', description: 'M, F oder ""' },
              birthDate:  { type: 'string' },
              birthPlace: { type: 'string' },
              deathDate:  { type: 'string' },
              deathPlace: { type: 'string' },
              fatherName: { type: 'string' },
              motherName: { type: 'string' },
              notes:      { type: 'string' },
              marriages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    spouseName: { type: 'string' },
                    date:       { type: 'string' },
                    place:      { type: 'string' },
                    children: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { fullName: { type: 'string' } },
                        required: ['fullName']
                      }
                    }
                  },
                  required: ['spouseName']
                }
              }
            },
            required: ['fullName']
          }
        }
      },
      required: ['persons']
    }
  };

  const userContent = [];
  if (imageData) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } });
    userContent.push({ type: 'text', text: 'Extract every person from this image via the record_persons tool. Copy names, places and notes verbatim.' });
  } else {
    userContent.push({ type: 'text', text: `Extract every person mentioned in the source below via the record_persons tool — including people named only inside notes (parents of spouses, stepfathers, earlier marriages, twin siblings, etc.). Copy names, places and notes verbatim.\n\n---\n${text}` });
  }

  const endpoint = window.AI_PROXY_URL
    ? window.AI_PROXY_URL.replace(/\/$/, '') + '/v1/messages'
    : 'https://api.anthropic.com/v1/messages';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      system: SYSTEM,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_persons' },
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log('[KI Import] response:', data);

  const toolBlock = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'record_persons');
  if (!toolBlock) throw new Error(t('errors.aiNoToolCall', { reason: data.stop_reason || '?' }));

  let persons = toolBlock.input?.persons;
  if (typeof persons === 'string') {
    // Sonnet sometimes writes ASCII `"` as the closing typographic quote inside German
    // emphasis like „Meieli" — that quote is unescaped and breaks JSON.parse. Repair.
    persons = JSON.parse(persons.replace(/„([^"„]*)"/g, '„$1”'));
  }
  if (!Array.isArray(persons)) throw new Error(t('errors.aiParseNotArray', { shape: JSON.stringify(toolBlock.input).slice(0,200) }));
  return _aiMapToPersons(persons);
}

function _aiMapToPersons(arr) {
  return arr.map(p => ({
    fullName:   (p.fullName   || '').trim(),
    sex:        (p.sex        || '').toUpperCase().replace(/[^MF]/g, ''),
    birthDate:  _tiNormDate(p.birthDate  || ''),
    birthPlace: (p.birthPlace || '').trim(),
    deathDate:  _tiNormDate(p.deathDate  || ''),
    deathPlace: (p.deathPlace || '').trim(),
    fatherName: (p.fatherName || '').trim(),
    motherName: (p.motherName || '').trim(),
    notes:      (p.notes      || '').trim(),
    sourceNote: 'KI Import',
    marriages:  (p.marriages  || []).map(m => ({
      spouseName: (m.spouseName || '').trim(),
      date:       _tiNormDate(m.date || ''),
      place:      (m.place || '').trim(),
      children:   (m.children || []).map(c => ({ fullName: (c.fullName || '').trim() })).filter(c => c.fullName)
    })).filter(m => m.spouseName)
  })).filter(p => p.fullName);
}

window._aiToggleKeyVisibility = _aiToggleKeyVisibility;
window._aiSaveKey              = _aiSaveKey;
