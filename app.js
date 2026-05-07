'use strict';

// ═══════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════
let individuals = new Map();   // id -> indi object
let families    = new Map();   // id -> fam object
let allNodes = [];   // complete dataset (all INDI + FAM nodes)
let allLinks = [];   // complete dataset (links with _src/_tgt string IDs, never mutated by D3)

let nodes = [];      // currently active (filtered) nodes passed to simulation
let links = [];      // currently active (filtered) links passed to simulation
let _firstLoad = true;  // controls auto-fit + auto-open on first load only

let simulation  = null;
let svgSel      = null;   // d3 selection of <svg>
let gMain       = null;   // d3 selection of main <g>
let zoomBehavior = null;  // d3.zoom() instance

let linkSel     = null;
let nodeSel     = null;
let labelSel    = null;

let currentZoom  = 1;
let selectedIndiId = null;    // currently shown in detail panel
let hlMode = null;            // null | 'ancestors' | 'descendants' | 'both'
let hlSet  = new Set();       // highlighted node ids

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
  fontSize: 32,      // 32 from screenshot
  fontWeight: 'normal',
  bgEnabled: false,
  bgColor: '#1a1a2e',
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
}
window.addEventListener('beforeunload', e => {
  if (_gedcomDirty) { e.preventDefault(); e.returnValue = ''; }
});

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
  velocityDecay:  0.05,
  alphaDecay:     0.005,
};

let physicsParams = { ...PHYSICS_DEFAULTS };

// 3D state
let graph3d        = null;
let currentView    = '3d';   // '2d' | '3d'
let _birthYearRange = null;  // { min, max } saved for 3D stratification
let _3dMousePos    = { x: 0, y: 0 };

// Display mode flags
let showFamNodes   = true;   // show FAM diamond nodes (vs direct parent-child links)
let sortByTime3D   = true;   // Y-stratify 3D sim by birth year
let showTimeline3D = true;   // show the visual timeline axis (spine + rings)
let show3DNames    = true;   // render name+year labels above nodes in 3D
let _nodeDragEnabled = false; // node dragging disabled by default
let _timeline3DObj    = null;   // THREE.Group holding timeline meshes in the 3D scene
let _3dYHalfSpan      = 500;   // half-range of Y axis in 3D sim units (older→+half, newer→-half)
let _3dFontSize       = 18;    // name label font size in 3D view
let _orbitControls3d  = null;  // OrbitControls instance (replaces TrackballControls)
let _orbitTargetAnim  = null;  // { from, to, start, duration } for smooth orbit target transition
let _orbitTrackNodeId = null;  // node id whose live position the orbit target tracks

// 3D appearance
let _3dAppearance = {
  bgColor:     '#04060f',
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

// ── 3D pinch-to-zoom ──
let _pinch3d = null;  // { dist0, camDist0, midX, midY }

function _onTouch3DStart(evt) {
  if (evt.touches.length === 2 && graph3d && _orbitControls3d) {
    evt.preventDefault();
    const t0 = evt.touches[0], t1 = evt.touches[1];
    _pinch3d = {
      dist0:    Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
      camDist0: graph3d.camera().position.distanceTo(_orbitControls3d.target),
      midX: (t0.clientX + t1.clientX) / 2,
      midY: (t0.clientY + t1.clientY) / 2,
    };
  }
}

function _onTouch3DMove(evt) {
  if (!_pinch3d || evt.touches.length !== 2 || !graph3d || !_orbitControls3d) return;
  evt.preventDefault();
  const t0 = evt.touches[0], t1 = evt.touches[1];
  const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);

  // Correct scale: wider pinch = smaller distance (zoom in)
  const scale = _pinch3d.dist0 / Math.max(dist, 1);
  const newDist = Math.max(1, _pinch3d.camDist0 * scale);

  const cam = graph3d.camera();
  const ctrl = _orbitControls3d;
  const dir = cam.position.clone().sub(ctrl.target).normalize();
  cam.position.copy(ctrl.target).addScaledVector(dir, newDist);
  ctrl.update();
}

function _onTouch3DEnd(evt) {
  if (evt.touches.length < 2) _pinch3d = null;
}

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
// 1. GEDCOM PARSER
// ═══════════════════════════════════════════════════════════════
function parseGEDCOM(raw) {
  // Strip UTF-8 BOM if present
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  individuals.clear();
  families.clear();

  const lines = raw.split(/\r?\n/);

  let cur     = null;
  let curType = null;   // 'INDI' | 'FAM' | null
  let subCtx  = null;  // 'BIRT' | 'DEAT' | 'MARR' | null

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // GEDCOM line: level tag [value]
    const m = line.match(/^(\d+)\s+(\S+)\s*(.*)/);
    if (!m) continue;

    const level = +m[1];
    const tag   = m[2];
    const val   = m[3].trim();

    // Level 0 — new record
    if (level === 0) {
      subCtx = null;
      if (tag.startsWith('@') && val === 'INDI') {
        cur = {
          id: tag,
          name: '', givn: '', surn: '', maidenName: '',
          sex: 'U',
          birth: { date: '', plac: '' },
          death: { date: '', plac: '', caus: '' },
          deceased: false,
          birthYear: null,
          famc: [], fams: [],
          occu: '', note: '',
          displayName: ''
        };
        individuals.set(tag, cur);
        curType = 'INDI';
      } else if (tag.startsWith('@') && val === 'FAM') {
        cur = {
          id: tag,
          husb: null, wife: null, chil: [],
          marriages: [], div: false, divDate: ''
        };
        families.set(tag, cur);
        curType = 'FAM';
      } else {
        cur = null; curType = null;
      }
      continue;
    }

    if (!cur) continue;

    if (curType === 'INDI') {
      if (level === 1) {
        subCtx = null;
        switch (tag) {
          case 'NAME':
            if (!cur.name) {
              // First NAME record — primary name like "Luca /Fluri/" or "/Kuhn/"
              if (val && val !== '//' && val.trim()) {
                const clean = val.replace(/\//g, '').replace(/\s+/g, ' ').trim();
                if (clean) {
                  cur.name = clean;
                  const sm = val.match(/\/([^/]+)\//);
                  if (sm) cur.surn = sm[1].trim();
                  const gm = val.match(/^([^/]*)\s*\//);
                  if (gm) cur.givn = gm[1].trim();
                }
              }
              subCtx = 'NAME';
            } else if (!cur.maidenName) {
              // Second NAME record — treat as maiden/birth name
              const sm2 = val.match(/\/([^/]+)\//);
              cur.maidenName = sm2 ? sm2[1].trim() : val.replace(/\//g, '').trim();
              subCtx = 'NAME2';
            }
            break;
          case '_MARN': if (val && !cur.maidenName) cur.maidenName = val; break;
          case 'SEX':  cur.sex = val; break;
          case 'BIRT': subCtx = 'BIRT'; break;
          case 'DEAT':
            subCtx = 'DEAT';
            cur.deceased = true;
            break;
          case 'FAMC': if (val) cur.famc.push(val); break;
          case 'FAMS': if (val) cur.fams.push(val); break;
          case 'OCCU': cur.occu = val; break;
          case 'NOTE': cur.note = val; break;
        }
      } else if (level === 2) {
        switch (subCtx) {
          case 'BIRT':
            if (tag === 'DATE') {
              cur.birth.date = val;
              const ym = val.match(/\b(\d{4})\b/);
              if (ym) cur.birthYear = +ym[1];
            } else if (tag === 'PLAC') cur.birth.plac = val;
            break;
          case 'DEAT':
            if (tag === 'DATE') cur.death.date = val;
            else if (tag === 'PLAC') cur.death.plac = val;
            else if (tag === 'CAUS') cur.death.caus = val;
            break;
          case 'NAME':
            if (tag === 'GIVN') cur.givn = cur.givn || val;
            else if (tag === 'SURN') cur.surn = cur.surn || val;
            else if (tag === 'CONT') cur.note += '\n' + val;
            break;
          case 'NAME2':
            if (tag === 'SURN') cur.maidenName = val;  // explicit SURN beats parsed value
            break;
          default:
            if (tag === 'GIVN' && !cur.givn) cur.givn = val;
            else if (tag === 'SURN' && !cur.surn) cur.surn = val;
            else if (tag === 'CONT') cur.note += '\n' + val;
        }
      } else if (level === 3 && tag === 'CONT') {
        cur.note += '\n' + val;
      }

    } else if (curType === 'FAM') {
      if (level === 1) {
        subCtx = null;
        switch (tag) {
          case 'HUSB': cur.husb = val; break;
          case 'WIFE': cur.wife = val; break;
          case 'CHIL': if (val) cur.chil.push(val); break;
          case 'MARR': cur.marriages.push({ date: '', plac: '', types: [] }); subCtx = 'MARR'; break;
          case 'DIV':  cur.div = true; subCtx = 'DIV'; break;
        }
      } else if (level === 2) {
        if (subCtx === 'MARR') {
          const m = cur.marriages[cur.marriages.length - 1];
          if (m) {
            if (tag === 'DATE') m.date = val;
            else if (tag === 'PLAC') m.plac = val;
            else if (tag === 'TYPE') m.types = val.split(',').map(s => s.trim()).filter(Boolean);
          }
        } else if (subCtx === 'DIV') {
          if (tag === 'DATE') cur.divDate = val;
        }
      }
    }
  }

  // Post-process individuals
  for (const [id, indi] of individuals) {
    // Fallback name
    if (!indi.name) {
      indi.name = id.replace(/@/g, '');
    }
    // Fallback given/surname if only one part parsed
    if (!indi.surn && indi.name) {
      const parts = indi.name.trim().split(/\s+/);
      if (parts.length >= 2) {
        indi.surn = parts[parts.length - 1];
        indi.givn = parts.slice(0, -1).join(' ');
      }
    }
    // Display name (shorter)
    if (indi.givn && indi.surn) {
      indi.displayName = indi.givn + ' ' + indi.surn;
    } else {
      indi.displayName = indi.name;
    }
    if (indi.displayName.length > 24) {
      indi.displayName = indi.givn
        ? indi.givn + (indi.surn ? ' ' + indi.surn[0] + '.' : '')
        : indi.displayName.slice(0, 22) + '…';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// Full in-memory rebuild — call after any structural change
// ═══════════════════════════════════════════════════════════════
function _fullRebuildGraph() {
  _setDirty(true);
  console.time('[rebuild] total');
  console.time('[rebuild] surnameColorMap'); const sorted = buildSurnameColorMap(); console.timeEnd('[rebuild] surnameColorMap');
  console.time('[rebuild] surnameList');     buildSurnameList(sorted);               console.timeEnd('[rebuild] surnameList');
  console.time('[rebuild] buildGraphData');  buildGraphData();                        console.timeEnd('[rebuild] buildGraphData');
  if (!svgSel) initSVG();
  console.time('[rebuild] renderGraph');     renderGraph();                           console.timeEnd('[rebuild] renderGraph');
  document.getElementById('status').textContent =
    `${individuals.size} Person${individuals.size !== 1 ? 'en' : ''}, ${families.size} Familien`;
  _genDepthsCache = null;  // invalidate depth cache before rebuild
  _estimatedYears = null;
  _firstLoad = true;
  console.time('[rebuild] simulation');      buildAndRunSimulation();                 console.timeEnd('[rebuild] simulation');
  // For 3D: push data directly instead of calling applyFilter() which would
  // run buildAndRunSimulation() a second time (doubles the sim cost).
  if (currentView === '3d' && graph3d) {
    console.time('[rebuild] 3d data push');
    const gNodes = nodes.map(n => ({ id: n.id, type: n.type, data: n.data }));
    const gLinks = links.map(l => ({
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
      ltype: l.ltype,
    }));
    graph3d.graphData({ nodes: gNodes, links: gLinks });
    apply3DPhysics();
    build3DTimeline();
    update3DNames();
    console.timeEnd('[rebuild] 3d data push');
  }
  console.timeEnd('[rebuild] total');
}

// 2. GRAPH DATA BUILDER  (bipartite INDI + FAM nodes)
// ═══════════════════════════════════════════════════════════════
function buildGraphData() {
  allNodes = [];
  allLinks = [];
  const nodeById = new Map();

  for (const [id, indi] of individuals) {
    const n = { id, type: 'INDI', data: indi };
    allNodes.push(n);
    nodeById.set(id, n);
  }

  for (const [id, fam] of families) {
    const n = { id, type: 'FAM', data: fam };
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
    const s = indi.surn;
    if (s) counts.set(s, (counts.get(s) || 0) + 1);
    else noSurnCount++;
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

// ── Visibility helpers (surname filter) ──
function isIndiVisible(id) {
  const indi = individuals.get(id);
  if (!indi) return true;
  const key = indi.surn || null;  // null = no surname
  return surnameEnabled.get(key) !== false;
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

// ── Generation depth: iterates until every child is strictly deeper than its parents ──
function computeGenerationDepths() {
  if (_genDepthsCache) return _genDepthsCache;
  const depth = new Map();
  for (const [id] of individuals) depth.set(id, 0);

  // Propagate: child depth = max(parent depths) + 1, repeat until stable
  // Cap at individuals.size iterations to guard against cycles in malformed data
  let changed = true;
  let iters = 0;
  const MAX_ITERS = individuals.size + 1;
  while (changed && iters++ < MAX_ITERS) {
    changed = false;
    for (const [, fam] of families) {
      const pd = Math.max(
        ...[fam.husb, fam.wife].filter(Boolean).map(id => depth.get(id) ?? 0),
        -1
      );
      if (pd < 0) continue;
      for (const cid of fam.chil) {
        if ((depth.get(cid) ?? 0) < pd + 1) {
          depth.set(cid, pd + 1);
          changed = true;
        }
      }
    }
  }
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
  // Update 3D graph data if the 3D view is initialized
  if (graph3d) {
    const gNodes = nodes.map(n => ({ id: n.id, type: n.type, data: n.data }));
    const gLinks = links.map(l => ({
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
      ltype: l.ltype,
    }));
    graph3d.graphData({ nodes: gNodes, links: gLinks });
    apply3DPhysics();  // calls applyTimelineYFix internally after graphData is set
    build3DTimeline();
    update3DNames();
  }
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

  // Links layer
  console.time('[rg] links');
  linkSel = gMain.append('g').attr('class', 'links-g')
    .selectAll('line')
    .data(links)
    .join('line')
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

  indiSel.append('circle')
    .attr('r', 8)
    .attr('fill', d => nodeBaseColor(d))
    .attr('stroke', '#ffffff44')
    .attr('stroke-width', 0.8)
    .attr('opacity', d => d.data.deceased ? 0.5 : 1);

  indiSel.filter(d => d.data.deceased)
    .append('text')
    .attr('dy', '4px')
    .attr('text-anchor', 'middle')
    .attr('fill', '#bbb')
    .attr('font-size', '11px')
    .attr('pointer-events', 'none')
    .text('×');

  famSel.append('polygon')
    .attr('class', 'fam-polygon')
    .attr('points', d => { const s = famNodeSize; return `0,${-s} ${s},0 0,${s} ${-s},0`; })
    .attr('fill',   d => d.data.div ? nodeColors.famDiv : nodeColors.fam)
    .attr('stroke', d => d.data.div ? nodeColors.famDiv : nodeColors.fam)
    .attr('stroke-width',     d => d.data.div ? 1.5 : 1)
    .attr('stroke-dasharray', d => d.data.div ? '3 2' : null)
    .attr('opacity', 0.88);
  console.timeEnd('[rg] shapes');

  // Labels layer (INDI only)
  console.time('[rg] labels');
  labelSel = gMain.append('g').attr('class', 'labels-g')
    .selectAll('text')
    .data(nodes.filter(n => n.type === 'INDI'), d => d.id)
    .join('text')
    .attr('class', 'node-label')
    .attr('dy', '-12px')
    .attr('text-anchor', 'middle')
    .attr('fill', d => labelColor(d))
    .attr('fill-opacity', labelStyle.textOpacity)
    .attr('font-size', labelStyle.fontSize + 'px')
    .attr('font-weight', labelStyle.fontWeight || 'normal')
    .text(d => d.data.displayName);

  console.timeEnd('[rg] labels');
  updateLabels();
}

function updateLabels() {
  if (!labelSel || labelSel.empty()) return;
  const zoom = currentZoom;
  const hidden = zoom < 0.35;
  const brief  = zoom < 1.1;

  labelSel.each(function(d) {
    // All visual properties as SVG presentation attributes — never CSS style(),
    // which would enter the CSS cascade and could override the fill attribute.
    this.setAttribute('fill',         labelColor(d));
    this.setAttribute('fill-opacity', labelStyle.textOpacity);
    this.setAttribute('font-size',    labelStyle.fontSize + 'px');
    this.setAttribute('font-weight',  labelStyle.fontWeight || 'normal');

    if (hidden) {
      this.style.display = 'none';
    } else {
      this.style.display = '';
      const name = d.data.givn || d.data.displayName || '';
      this.textContent = brief && name.length > 10 ? name.slice(0, 10) + '…' : d.data.displayName;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// 6. FORCE SIMULATION
// ═══════════════════════════════════════════════════════════════
function buildAndRunSimulation() {
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

  // Pre-position new nodes so the simulation converges faster
  nodes.forEach(n => {
    if (!n.x) {
      n.y = nodeTargetY(n);
      n.x = W * 0.2 + Math.random() * W * 0.6;
    }
  });

  if (simulation) simulation.stop();

  const p = physicsParams;

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
    .alphaDecay(p.alphaDecay)
    .velocityDecay(p.velocityDecay);

  // For large graphs run the simulation headlessly (no per-tick DOM writes)
  // then paint once at the end — avoids hundreds of synchronous reflows.
  const HEADLESS_THRESHOLD = 200;
  if (nodes.length > HEADLESS_THRESHOLD) {
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

function tick() {
  if (!linkSel) return;
  linkSel
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y);

  nodeSel.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
  labelSel?.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
}

function onSimEnd() {
  document.getElementById('loading-overlay').style.display = 'none';
  if (_firstLoad) {
    _firstLoad = false;
    if (currentView === '2d') {
      zoomToFit();
    }
  }
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
      html += `<div class="tt-detail" style="color:#888">~${_estimatedYears.get(d.id)} (geschätzt)</div>`;
    }
    if (i.deceased) {
      html += `<div class="tt-detail">† ${i.death.date ? escHtml(i.death.date) : 'Datum unbekannt'}</div>`;
    }
    if (i.occu) html += `<div class="tt-detail" style="color:#7ac">${escHtml(i.occu)}</div>`;
    if (i.maidenName) html += `<div class="tt-detail" style="color:#888">geb. ${escHtml(i.maidenName)}</div>`;
    else if (i.surn) html += `<div class="tt-detail" style="color:#888">Familienname: ${escHtml(i.surn)}</div>`;
  } else {
    const f = d.data;
    const names = [f.husb, f.wife].filter(Boolean)
      .map(id => escHtml(individuals.get(id)?.name || id)).join(' &amp; ');
    html = `<div class="tt-name">Familie</div>`;
    if (names) html += `<div class="tt-detail">${names}</div>`;
    if (f.marriages?.[0]?.date) html += `<div class="tt-detail">⚭ ${escHtml(f.marriages[0].date)}</div>`;
    if (f.div) html += `<div class="tt-detail" style="color:#e74c3c">Geschieden${f.divDate ? ' ' + escHtml(f.divDate) : ''}</div>`;
    html += `<div class="tt-detail">${f.chil.length} ${f.chil.length === 1 ? 'Kind' : 'Kinder'}</div>`;
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
  const sexLabel = indi.sex === 'M' ? 'männlich' : indi.sex === 'F' ? 'weiblich' : 'unbekannt';
  html += row('Geschlecht', sexLabel);

  // Birth
  if (indi.birth.date || indi.birth.plac) {
    html += row('Geboren', fmtPlace(indi.birth.date, indi.birth.plac));
  } else if (_estimatedYears && _estimatedYears.has(id)) {
    html += row('Geboren', `<span style="color:#888">~${_estimatedYears.get(id)} (geschätzt)</span>`);
  }

  // Death
  if (indi.deceased) {
    const ds = fmtPlace(indi.death.date || 'Datum unbekannt', indi.death.plac);
    const caus = indi.death.caus ? `<br><span style="color:#888;font-size:11px">${escHtml(indi.death.caus)}</span>` : '';
    html += row('Gestorben', ds + caus);
  }

  // Occupation
  if (indi.occu) html += row('Beruf', escHtml(indi.occu));

  // Maiden name
  if (indi.maidenName) html += row('Geburtsname', escHtml(indi.maidenName));

  // Parents
  if (indi.famc.length) {
    const parentLines = [];
    for (const famId of indi.famc) {
      const fam = families.get(famId);
      if (!fam) continue;
      const ps = [fam.husb, fam.wife].filter(Boolean).map(pid => {
        const p = individuals.get(pid);
        return p ? `<span class="clickable-name" onclick="showIndiDetail('${escAttr(pid)}')">${escHtml(p.name)}</span>` : escHtml(pid);
      }).join(' &amp; ');
      const famLink = `<span class="clickable-fam-badge" onclick="showFamDetail('${escAttr(famId)}')" title="Familie öffnen">&#x25C6;</span>`;
      if (ps || famLink) parentLines.push((ps || '') + ' ' + famLink);
    }
    if (parentLines.length) html += row('Eltern', parentLines.join('<br>'));
  }

  // Marriages / partners
  if (indi.fams.length) {
    html += `<div class="detail-section"><div class="detail-label">Ehe / Partnerschaft</div>`;
    for (const famId of indi.fams) {
      const fam = families.get(famId);
      if (!fam) continue;
      const spId = fam.husb === id ? fam.wife : fam.husb;
      const sp = spId ? individuals.get(spId) : null;
      const spName = sp ? `<span class="clickable-name" onclick="showIndiDetail('${escAttr(spId)}')">${escHtml(sp.name)}</span>` : (spId ? escHtml(spId) : '<em>unbekannt</em>');
      const m0 = fam.marriages?.[0];
      const mInfo = m0?.date ? ` &mdash; ⚭ ${escHtml(m0.date)}${m0.plac ? ', ' + escHtml(m0.plac) : ''}` : '';
      const dInfo = fam.div ? ` <span style="color:#e74c3c">[Geschieden${fam.divDate ? ' ' + escHtml(fam.divDate) : ''}]</span>` : '';
      const kids = fam.chil.length ? `<br><span style="color:#888;font-size:11px">${fam.chil.length} ${fam.chil.length === 1 ? 'Kind' : 'Kinder'}</span>` : '';
      const famLink = `<span class="clickable-fam-badge" onclick="showFamDetail('${escAttr(famId)}')" title="Familie öffnen">&#x25C6;</span>`;
      html += `<div class="detail-marriage">${spName}${famLink}${mInfo}${dInfo}${kids}</div>`;
    }
    html += `</div>`;
  }

  // Note
  if (indi.note) {
    html += row('Notiz', `<span style="font-size:11px;color:#999">${escHtml(indi.note).replace(/\n/g, '<br>')}</span>`);
  }

  document.getElementById('detail-content').innerHTML = html;
  document.getElementById('delete-confirm-bar').style.display = 'none';
  document.getElementById('detail-edit-bar').style.display = 'block';
  document.getElementById('detail-buttons').style.display = 'flex';
  openPanel();
  updateHLButtons();
  flashNode(id);
  if (currentView === '3d') _setOrbitTarget3D(id);
}

function showFamDetail(id) {
  const fam = families.get(id);
  if (!fam) return;
  _lastShownFamId = id;
  selectedIndiId = null;

  const names = [fam.husb, fam.wife].filter(Boolean)
    .map(pid => individuals.get(pid)?.name || pid).join(' & ');
  document.getElementById('detail-name').textContent = 'Familie' + (names ? ': ' + names : '');

  let html = '';
  (fam.marriages || []).forEach((m, i) => {
    if (!m.date && !m.plac && !m.types?.length) return;
    let marrVal = fmtPlace(m.date, m.plac);
    if (m.types?.length) marrVal += (marrVal ? ' &mdash; ' : '') + `<span style="color:#7ac;font-size:11px">${escHtml(m.types.join(', '))}</span>`;
    const label = (fam.marriages.length > 1) ? `Heirat ${i + 1}` : 'Heirat';
    html += row(label, marrVal);
  });
  if (fam.div) {
    const divTxt = `<span style="color:#e74c3c">Geschieden${fam.divDate ? ' &mdash; ' + escHtml(fam.divDate) : ''}</span>`;
    html += row('Status', divTxt);
  }

  const spouses = [fam.husb, fam.wife].filter(Boolean);
  if (spouses.length) {
    const sl = spouses.map(pid => {
      const p = individuals.get(pid);
      return p ? `<span class="clickable-name" onclick="showIndiDetail('${escAttr(pid)}')">${escHtml(p.name)}</span>` : escHtml(pid);
    }).join(' &amp; ');
    html += row('Eheleute', sl);
  }

  if (fam.chil.length) {
    html += `<div class="detail-section"><div class="detail-label">Kinder (${fam.chil.length})</div>`;
    for (const cid of fam.chil) {
      const c = individuals.get(cid);
      if (c) html += `<div class="detail-value"><span class="clickable-name" onclick="showIndiDetail('${escAttr(cid)}')">${escHtml(c.name)}</span></div>`;
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
    .select('circle')
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

function highlightMode(mode) {
  if (!selectedIndiId) return;

  // Toggle off if same mode + same source
  if (hlMode === mode) {
    resetHighlight();
    return;
  }

  hlMode = mode;
  hlSet = new Set();
  if (mode === 'ancestors' || mode === 'both') collectAncestors(selectedIndiId, hlSet);
  if (mode === 'descendants' || mode === 'both') collectDescendants(selectedIndiId, hlSet);

  applyHighlight();
  updateHLButtons();
}

function applyHighlight() {
  if (!nodeSel) return;
  const hasHL = hlSet.size > 0;

  nodeSel.each(function(d) {
    const inHL = !hasHL || hlSet.has(d.id);
    const baseOp = (d.type === 'INDI' && d.data.deceased) ? 0.5 : 1.0;
    d3.select(this).selectAll('circle, polygon')
      .attr('opacity', inHL ? baseOp : 0.07)
      .attr('filter', inHL && d.id === selectedIndiId ? 'url(#glow)' : null);
  });

  linkSel?.attr('opacity', d => {
    if (!hasHL) return linkBaseOpacity(d);
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return (hlSet.has(sid) && hlSet.has(tid)) ? 0.80 : 0.04;
  });

  labelSel?.attr('opacity', d => (!hasHL || hlSet.has(d.id)) ? 1 : 0.07);
  refresh3D();
}

function resetHighlight() {
  hlMode = null;
  hlSet = new Set();
  applyHighlight();
  updateHLButtons();
  refreshNodeColors();
}

function refreshNodeColors() {
  if (!nodeSel) return;
  nodeSel.each(function(d) {
    if (d.type === 'INDI') {
      d3.select(this).select('circle').attr('fill', nodeBaseColor(d));
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
  ['btn-ancestors', 'btn-descendants', 'btn-both'].forEach(bid => {
    const btn = document.getElementById(bid);
    btn.disabled = !hasSource;
    btn.classList.remove('active');
  });
  if (hlMode === 'ancestors')   document.getElementById('btn-ancestors').classList.add('active');
  if (hlMode === 'descendants') document.getElementById('btn-descendants').classList.add('active');
  if (hlMode === 'both')        document.getElementById('btn-both').classList.add('active');
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
    const label = isNoSurn ? '(kein Nachname)' : surn;
    const title = isNoSurn ? 'Personen ohne Nachname' : escAttr(surn);

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
        <input type="color" class="surname-color-picker" value="${color}" title="Farbe wählen (Rechtsklick zum Zurücksetzen)">
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
    el.textContent = 'Keine Treffer';
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
// 13. FILE LOADER — entry point
// ═══════════════════════════════════════════════════════════════
document.getElementById('file-input').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (!file) return;

  document.getElementById('status').textContent = 'Lade Datei…';
  document.getElementById('loading-overlay').style.display = 'flex';

  const reader = new FileReader();
  reader.onload = evt => {
    try {
      parseGEDCOM(evt.target.result);

      const iCount = individuals.size;
      const fCount = families.size;
      document.getElementById('status').textContent =
        `${iCount} Personen, ${fCount} Familien geladen`;

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
      document.getElementById('dl-btn').style.display = 'inline-block';
      document.getElementById('center-view-btn').style.display = 'inline-block';
      document.getElementById('center-view-btn').disabled = false;
      document.getElementById('center-person-btn').style.display = 'inline-block';
      document.getElementById('relation-tool-btn').style.display = 'inline-block';
      document.getElementById('relation-tool-btn').disabled = false;
      window._gedcomFilename = file.name;
      _setDirty(false);

      // Ensure we're in 3D view
      currentView = '3d';
      document.getElementById('graph-container').style.display = 'none';
      document.getElementById('graph-3d-container').style.display = 'block';
      initGraph3D();
      setTimeout(autoSettle, 400); // let initGraph3D finish before annealing

    } catch (err) {
      document.getElementById('loading-overlay').style.display = 'none';
      document.getElementById('status').textContent = 'Fehler beim Laden: ' + err.message;
      console.error(err);
    }
  };
  reader.onerror = () => {
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('status').textContent = 'Datei konnte nicht gelesen werden.';
  };
  reader.readAsText(file, 'UTF-8');

  // Reset file input so same file can be reloaded
  this.value = '';
});

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
  if (!i || !i.fams.length) return '<div style="color:#555;font-size:11px;padding:2px 0">Keine Ehe / Partnerschaft</div>';
  return i.fams.map(famId => {
    const fam = families.get(famId);
    if (!fam) return '';
    const spouseId = fam.husb === personId ? fam.wife : fam.husb;
    const spouse   = spouseId ? individuals.get(spouseId) : null;
    const spouseLbl = spouse ? escHtml(spouse.name) : (spouseId ? escHtml(spouseId) : '<em>unbekannt</em>');
    const sid = _safeId(famId);
    return `<div class="ef-fam-block">
      <div class="ef-fam-header">&#x26a1; ${spouseLbl}</div>
      <div class="edit-section">
        <div class="edit-label">Heiratsdatum</div>
        ${_gedcomDateWidget('ef-fam-' + sid + '-mdate', fam.marriages?.[0]?.date || '')}
      </div>
      <div class="edit-section">
        <div class="edit-label">Heiratsort</div>
        <input class="edit-input" id="ef-fam-${sid}-mplac" value="${escAttr(fam.marriages?.[0]?.plac || '')}">
      </div>
      <label class="edit-checkbox-row">
        <input type="checkbox" id="ef-fam-${sid}-div"${fam.div ? ' checked' : ''}>
        Geschieden
      </label>
    </div>`;
  }).join('');
}

function _gedcomDateWidget(fieldId, value) {
  const { prefix, day, month, year } = _parseGedcomDate(value);
  const monthOpts = _GD_MONTHS.map(m =>
    `<option value="${m}"${month===m?' selected':''}>${m[0]}${m.slice(1).toLowerCase()}</option>`
  ).join('');
  const prefixOpts = [['','exakt'],['ABT','ca.'],['BEF','vor'],['AFT','nach'],['EST','gesch.']]
    .map(([v,l]) => `<option value="${v}"${prefix===v?' selected':''}>${l}</option>`).join('');
  return `<div class="gd-widget" id="${fieldId}">` +
    `<select class="gd-prefix">${prefixOpts}</select>` +
    `<input  class="gd-day"    type="number" min="1" max="31" placeholder="TT"   value="${day}"  title="Tag">` +
    `<select class="gd-month"><option value="">Mon.</option>${monthOpts}</select>` +
    `<input  class="gd-year"   type="number" min="1" max="2200" placeholder="JJJJ" value="${year}" title="Jahr">` +
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
    .replace(/"/g, '&quot;');
}
function escAttr(s) {
  if (!s) return '';
  return String(s).replace(/'/g, "\\'");
}

// ═══════════════════════════════════════════════════════════════
// GEDCOM SERIALIZER + DOWNLOAD
// ═══════════════════════════════════════════════════════════════
function serializeGEDCOM() {
  const lines = [];

  lines.push('0 HEAD');
  lines.push('1 SOUR Stammbaum Vis');
  lines.push('1 GEDC');
  lines.push('2 VERS 5.5.1');
  lines.push('2 FORM LINEAGE-LINKED');
  lines.push('1 CHAR UTF-8');

  for (const [id, i] of individuals) {
    lines.push(`0 ${id} INDI`);

    // NAME line: "Givn /Surn/" or just "/Surn/" or givn
    if (i.givn || i.surn) {
      const nameLine = (i.givn ? i.givn + ' ' : '') + '/' + (i.surn || '') + '/';
      lines.push(`1 NAME ${nameLine}`);
      if (i.givn) lines.push(`2 GIVN ${i.givn}`);
      if (i.surn) lines.push(`2 SURN ${i.surn}`);
    } else if (i.name) {
      lines.push(`1 NAME ${i.name}`);
    }

    if (i.maidenName) lines.push(`1 _MARN ${i.maidenName}`);
    if (i.sex && i.sex !== 'U') lines.push(`1 SEX ${i.sex}`);

    if (i.birth.date || i.birth.plac) {
      lines.push('1 BIRT');
      if (i.birth.date) lines.push(`2 DATE ${i.birth.date}`);
      if (i.birth.plac) lines.push(`2 PLAC ${i.birth.plac}`);
    }

    if (i.deceased || i.death.date || i.death.plac || i.death.caus) {
      if (i.death.date || i.death.plac || i.death.caus) {
        lines.push('1 DEAT');
        if (i.death.date) lines.push(`2 DATE ${i.death.date}`);
        if (i.death.plac) lines.push(`2 PLAC ${i.death.plac}`);
        if (i.death.caus) lines.push(`2 CAUS ${i.death.caus}`);
      } else {
        lines.push('1 DEAT Y');
      }
    }

    for (const famId of i.famc) lines.push(`1 FAMC ${famId}`);
    for (const famId of i.fams) lines.push(`1 FAMS ${famId}`);

    if (i.occu) lines.push(`1 OCCU ${i.occu}`);

    if (i.note) {
      const noteLines = i.note.split('\n');
      lines.push(`1 NOTE ${noteLines[0]}`);
      for (let k = 1; k < noteLines.length; k++) lines.push(`2 CONT ${noteLines[k]}`);
    }
  }

  for (const [id, f] of families) {
    lines.push(`0 ${id} FAM`);
    if (f.husb) lines.push(`1 HUSB ${f.husb}`);
    if (f.wife) lines.push(`1 WIFE ${f.wife}`);
    for (const cid of f.chil) lines.push(`1 CHIL ${cid}`);
    for (const m of (f.marriages || [])) {
      if (!m.date && !m.plac && !m.types?.length) continue;
      lines.push('1 MARR');
      if (m.date) lines.push(`2 DATE ${m.date}`);
      if (m.plac) lines.push(`2 PLAC ${m.plac}`);
      if (m.types?.length) lines.push(`2 TYPE ${m.types.join(', ')}`);
    }
    if (f.div) {
      lines.push('1 DIV Y');
      if (f.divDate) lines.push(`2 DATE ${f.divDate}`);
    }
  }

  lines.push('0 TRLR');
  return lines.join('\r\n');
}

function downloadGEDCOM() {
  const text = serializeGEDCOM();
  const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const base = (window._gedcomFilename || 'stammbaum').replace(/\.ged$/i, '');
  a.href     = url;
  a.download = base + '_edited.ged';
  a.click();
  URL.revokeObjectURL(url);
  _setDirty(false);
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

function _buildPersonDatalist(excludeId) {
  let opts = '';
  for (const [pid, p] of individuals) {
    if (pid === excludeId) continue;
    const yr = p.birthYear || (_estimatedYears?.get(pid));
    const maiden = p.maidenName ? ` (geb. ${p.maidenName})` : '';
    const display = `${p.name || pid}${maiden}${yr ? ` *${yr}` : ''}`;
    opts += `<option value="${escAttr(display)}" data-id="${escAttr(pid)}">`;
  }
  return opts;
}

function _resolvePersonInput(val) {
  if (!val) return null;
  val = val.trim();
  // Direct ID match
  if (individuals.has(val)) return val;
  // Strip maiden name / year suffix added by _buildPersonDatalist (e.g. "Name (geb. X) *1900")
  const baseName = val.replace(/\s*\(geb\.[^)]*\)/, '').replace(/\s*\*\d{4}$/, '').trim();
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
    el.innerHTML = '<div style="color:#555;font-size:11px;padding:2px 0">Keine Beziehungen hinzugefügt</div>';
    return;
  }
  const labels = { parent: 'Elternteil von', child: 'Kind von', spouse: 'Ehepartner von' };
  el.innerHTML = _pendingRelations.map((r, idx) => {
    const p = individuals.get(r.targetId);
    const name = p ? escHtml(p.name || r.targetId) : escHtml(r.targetId);
    const badge = r.isNew ? '<span class="ef-rel-new-badge">neu</span>' : '';
    return `<div class="ef-rel-item">
      <span class="ef-rel-type">${labels[r.type]}</span>
      <span class="ef-rel-name">${name}${badge}</span>
      <button class="ef-rel-remove" onclick="removeRelation(${idx})" title="Entfernen">&#x2715;</button>
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
    input.style.borderColor = '#e74c3c';
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
    document.getElementById('ef-np-givn').style.borderColor = '#e74c3c';
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
    if (fam.husb) rels.push({ type: 'parent', targetId: fam.husb, famId, label: 'Vater' });
    if (fam.wife) rels.push({ type: 'parent', targetId: fam.wife, famId, label: 'Mutter' });
  }
  // Spouses and children: families where this person is a spouse
  for (const famId of i.fams) {
    const fam = families.get(famId);
    if (!fam) continue;
    const spouseId = fam.husb === id ? fam.wife : fam.husb;
    if (spouseId) rels.push({ type: 'spouse', targetId: spouseId, famId, label: 'Ehepartner' });
    for (const childId of fam.chil) {
      rels.push({ type: 'child', targetId: childId, famId, label: 'Kind' });
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
      <button class="ef-rel-remove" onclick="removeExistingRelation(${JSON.stringify(r).split('"').join("'")})" title="Entfernen">&#x2715;</button>
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

  document.getElementById('detail-content').innerHTML = `
    <div class="edit-section">
      <div class="edit-label">Vorname</div>
      <input class="edit-input" id="ef-givn" value="${escAttr(i.givn)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">Familienname</div>
      <input class="edit-input" id="ef-surn" value="${escAttr(i.surn)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">Geburtsname (Mädchenname)</div>
      <input class="edit-input" id="ef-maiden" value="${escAttr(i.maidenName || '')}">
    </div>
    <div class="edit-section">
      <div class="edit-label">Geschlecht</div>
      <select class="edit-select" id="ef-sex">
        <option value="M"${i.sex==='M'?' selected':''}>männlich</option>
        <option value="F"${i.sex==='F'?' selected':''}>weiblich</option>
        <option value="U"${i.sex==='U'||!i.sex?' selected':''}>unbekannt</option>
      </select>
    </div>
    <div class="edit-section">
      <div class="edit-label">Geburtsdatum</div>
      ${_gedcomDateWidget('ef-bdate', i.birth.date)}
    </div>
    <div class="edit-section">
      <div class="edit-label">Geburtsort</div>
      <input class="edit-input" id="ef-bplac" value="${escAttr(i.birth.plac)}">
    </div>
    <label class="edit-checkbox-row">
      <input type="checkbox" id="ef-dead"${i.deceased?' checked':''}>
      Verstorben
    </label>
    <div class="edit-section">
      <div class="edit-label">Sterbedatum</div>
      ${_gedcomDateWidget('ef-ddate', i.death.date)}
    </div>
    <div class="edit-section">
      <div class="edit-label">Sterbeort</div>
      <input class="edit-input" id="ef-dplac" value="${escAttr(i.death.plac)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">Todesursache</div>
      <input class="edit-input" id="ef-dcaus" value="${escAttr(i.death.caus)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">Beruf</div>
      <input class="edit-input" id="ef-occu" value="${escAttr(i.occu)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">Notiz</div>
      <textarea class="edit-textarea" id="ef-note">${escHtml(i.note)}</textarea>
    </div>
    <div class="edit-section" style="border-top:1px solid #0f3460;padding-top:8px;margin-top:4px">
      <div class="edit-label">Ehen &amp; Partnerschaften</div>
      <div id="ef-fam-sections">${_buildFamEditSections(id)}</div>
    </div>
    <div class="edit-section" style="border-top:1px solid #0f3460;padding-top:8px;margin-top:4px">
      <div class="edit-label">Beziehungen</div>
      <div id="ef-existing-rel-list" style="margin-bottom:4px"></div>
      <div id="ef-rel-list" style="margin-bottom:6px">
        <div style="color:#555;font-size:11px;padding:2px 0">Keine neuen Beziehungen</div>
      </div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-rel-person" list="ef-rel-datalist" placeholder="Person suchen…" autocomplete="off">
        <datalist id="ef-rel-datalist">${datalistHtml}</datalist>
        <select class="edit-select" id="ef-rel-type" style="width:auto;min-width:100px">
          <option value="child">Kind von</option>
          <option value="parent">Elternteil von</option>
          <option value="spouse">Ehepartner von</option>
        </select>
        <button class="ef-rel-add-btn" onclick="addRelation()" title="Beziehung hinzufügen">+</button>
      </div>
      <button class="ef-new-person-btn" onclick="toggleNewPersonSubform()">&#xff0b; Neue Person erstellen</button>
      <div id="ef-new-person-subform" style="display:none;margin-top:8px;padding:8px;background:#0d1b3e;border:1px solid #1a2a5e;border-radius:6px">
        <div class="edit-label" style="margin-bottom:6px">Neue Person</div>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="edit-input" id="ef-np-givn" placeholder="Vorname" style="flex:1">
          <input class="edit-input" id="ef-np-surn" placeholder="Familienname" style="flex:1">
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <select class="edit-select" id="ef-np-sex" style="flex:1">
            <option value="U">Geschlecht…</option>
            <option value="M">männlich</option>
            <option value="F">weiblich</option>
          </select>
          <select class="edit-select" id="ef-np-type" style="flex:1">
            <option value="child">Kind von</option>
            <option value="parent">Elternteil von</option>
            <option value="spouse">Ehepartner von</option>
          </select>
        </div>
        <div style="display:flex;gap:6px">
          <button class="edit-save-btn" style="flex:1;padding:5px" onclick="confirmNewPersonRelation()">&#x2713; Hinzufügen</button>
          <button class="edit-cancel-btn" style="flex:1;padding:5px" onclick="toggleNewPersonSubform()">Abbrechen</button>
        </div>
      </div>
    </div>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitIndiEdit()">&#x2713; Speichern</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">Abbrechen</button>
    </div>`;

  _renderExistingRelations(id);
  _acAttachEditForm();
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
  for (const rel of _pendingRelations) {
    const target = individuals.get(rel.targetId);
    if (!target) continue;

    if (rel.type === 'child') {
      // New person is a CHILD OF target → target is parent
      // Find an existing family where target is husb or wife that we can add the child to
      let fam = _findOrCreateFamAsParent(rel.targetId);
      if (!fam.chil.includes(_editingId)) fam.chil.push(_editingId);
      if (!i.famc.includes(fam.id)) i.famc.push(fam.id);

    } else if (rel.type === 'parent') {
      // New person is a PARENT OF target → target is child
      let fam = _findOrCreateFamAsParent(_editingId);
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
        if (i.sex === 'M') { newFam.husb = _editingId; newFam.wife = rel.targetId; }
        else if (i.sex === 'F') { newFam.wife = _editingId; newFam.husb = rel.targetId; }
        else if (target.sex === 'M') { newFam.husb = rel.targetId; newFam.wife = _editingId; }
        else if (target.sex === 'F') { newFam.wife = rel.targetId; newFam.husb = _editingId; }
        else { newFam.husb = _editingId; newFam.wife = rel.targetId; }
        families.set(famId, newFam);
        if (!i.fams.includes(famId)) i.fams.push(famId);
        if (!target.fams.includes(famId)) target.fams.push(famId);
      }
    }
  }
  _pendingRelations = [];

  const id = _editingId;
  _editingId = null; _editingType = null;

  _isNewRecord = false;
  if (needsRebuild) {
    document.getElementById('dl-btn').style.display = 'inline-block';
    document.getElementById('center-view-btn').style.display = 'inline-block';
    document.getElementById('center-view-btn').disabled = false;
    document.getElementById('center-person-btn').style.display = 'inline-block';
    document.getElementById('relation-tool-btn').style.display = 'inline-block';
    document.getElementById('relation-tool-btn').disabled = false;
    document.getElementById('view-toggle-btn').disabled = false;
  }
  _fullRebuildGraph();
  showIndiDetail(id);
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

const _FAM_MARR_TYPES = [
  { val: 'civil',         label: 'Standesamtlich' },
  { val: 'kirchlich',     label: 'Kirchlich' },
  { val: 'partnerschaft', label: 'Partnerschaft' },
  { val: 'eheähnlich',   label: 'Eheähnlich' },
];

function showFamEditForm(id) {
  const f = families.get(id);
  if (!f) return;

  _famEditRemovedChil = new Set();
  _famEditPendingChil = [];

  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('detail-buttons').style.display = 'none';

  const dl = _buildPersonDatalist(null);
  const husbName = f.husb ? (individuals.get(f.husb)?.name || f.husb) : '';
  const wifeName = f.wife ? (individuals.get(f.wife)?.name || f.wife) : '';

  _famEditMarriages = (f.marriages && f.marriages.length)
    ? f.marriages.map(m => ({ date: m.date || '', plac: m.plac || '', types: [...(m.types || [])] }))
    : [{ date: '', plac: '', types: [] }];

  document.getElementById('detail-content').innerHTML = `
    <div class="edit-section">
      <div class="edit-label">Partner 1</div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-husb" list="ef-husb-dl" value="${escAttr(husbName)}" placeholder="Person suchen…" autocomplete="off">
        <datalist id="ef-husb-dl">${dl}</datalist>
        <button class="ef-rel-remove" onclick="document.getElementById('ef-husb').value=''" title="Leeren">&#x2715;</button>
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-label">Partner 2</div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-wife" list="ef-wife-dl" value="${escAttr(wifeName)}" placeholder="Person suchen…" autocomplete="off">
        <datalist id="ef-wife-dl">${dl}</datalist>
        <button class="ef-rel-remove" onclick="document.getElementById('ef-wife').value=''" title="Leeren">&#x2715;</button>
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-label">Zeremonien</div>
      <div id="ef-fam-marr-list"></div>
      <button class="ef-toggle-new-btn" onclick="_famEditAddMarr()" style="margin-top:4px">&#x2795; Zeremonie hinzufügen</button>
    </div>
    <div class="edit-section">
      <label class="edit-checkbox-row" style="margin-bottom:4px">
        <input type="checkbox" id="ef-div"${f.div ? ' checked' : ''} onchange="_famEditToggleDivDate(this.checked)">
        Geschieden
      </label>
      <div id="ef-div-date-row" style="display:${f.div ? 'block' : 'none'}">
        <div class="edit-label" style="margin-top:4px">Scheidungsdatum</div>
        ${_gedcomDateWidget('ef-divdate', f.divDate || '')}
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-label">Kinder</div>
      <div id="ef-fam-chil-list"></div>
      <div class="ef-rel-add-row" style="margin-top:4px">
        <input class="edit-input" id="ef-fam-chil-search" list="ef-fam-chil-dl" placeholder="Kind suchen…" autocomplete="off">
        <datalist id="ef-fam-chil-dl">${dl}</datalist>
        <button class="ef-rel-add-btn" onclick="_famEditAddChild()" title="Kind hinzufügen">+</button>
      </div>
      <button class="ef-toggle-new-btn" onclick="_famEditToggleNewChild()" style="margin-top:4px">&#x2795; Neues Kind</button>
      <div id="ef-fam-new-child-form" style="display:none;margin-top:6px">
        <div class="ef-rel-add-row">
          <input class="edit-input" id="ef-fnc-givn" placeholder="Vorname" style="flex:1">
          <input class="edit-input" id="ef-fnc-surn" placeholder="Familienname" style="flex:1">
        </div>
        <div class="ef-rel-add-row" style="margin-top:4px">
          <select class="edit-select" id="ef-fnc-sex" style="flex:1">
            <option value="U">Geschlecht</option>
            <option value="M">Männlich</option>
            <option value="F">Weiblich</option>
          </select>
          <button class="ef-rel-add-btn" onclick="_famEditCreateChild()" title="Kind erstellen" style="width:auto;padding:0 10px">Hinzufügen</button>
        </div>
      </div>
    </div>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitFamEdit()">&#x2713; Speichern</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">Abbrechen</button>
    </div>`;

  _famEditRenderMarriages();
  _famEditRenderChildren(f);
}

function _famEditRenderMarriages() {
  const el = document.getElementById('ef-fam-marr-list');
  if (!el) return;
  el.innerHTML = _famEditMarriages.map((m, i) => {
    const typesHtml = _FAM_MARR_TYPES.map(t =>
      `<label class="fam-type-check"><input type="checkbox" data-marr-idx="${i}" data-marr-type="${escAttr(t.val)}"${m.types.includes(t.val) ? ' checked' : ''}> ${escHtml(t.label)}</label>`
    ).join('');
    const canRemove = _famEditMarriages.length > 1;
    return `<div class="fam-marr-block">
      <div class="fam-marr-block-header">
        <span>Zeremonie ${i + 1}</span>
        ${canRemove ? `<button class="ef-rel-remove" onclick="_famEditRemoveMarr(${i})" title="Entfernen">&#x2715;</button>` : ''}
      </div>
      <div class="fam-type-checks" style="margin-bottom:6px">${typesHtml}</div>
      <div class="edit-label" style="font-size:11px">Datum</div>
      ${_gedcomDateWidget('ef-marr-' + i + '-date', m.date)}
      <div class="edit-label" style="font-size:11px;margin-top:4px">Ort</div>
      <input class="edit-input" id="ef-marr-${i}-plac" value="${escAttr(m.plac)}" placeholder="Ort">
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
        <button class="ef-rel-remove" onclick="_famEditRemoveChild('${escAttr(cid)}')" title="Entfernen">&#x2715;</button>
      </div>`;
    });
  const pending = _famEditPendingChil.map((c, i) => {
    return `<div class="ef-rel-item">
      <span class="ef-rel-name">${escHtml(c.name)}</span>
      <span class="ef-rel-new-badge">neu</span>
      <button class="ef-rel-remove" onclick="_famEditRemovePending(${i})" title="Entfernen">&#x2715;</button>
    </div>`;
  });
  el.innerHTML = (existing.length || pending.length)
    ? existing.join('') + pending.join('')
    : '<div style="color:#555;font-size:11px;padding:2px 0">Keine Kinder</div>';
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
  if (!id) { inp.style.borderColor = '#e74c3c'; setTimeout(() => { inp.style.borderColor = ''; }, 1200); return; }
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
    document.getElementById('ef-fnc-givn').style.borderColor = '#e74c3c';
    setTimeout(() => { document.getElementById('ef-fnc-givn').style.borderColor = ''; }, 1200);
    return;
  }
  const newId = getNextIndiId();
  individuals.set(newId, {
    id: newId, name: fullName, givn, surn, maidenName: '', sex,
    birth: { date: '', plac: '' }, death: { date: '', plac: '', caus: '' },
    deceased: false, birthYear: null, famc: [], fams: [], occu: '', note: '',
    displayName: fullName.length > 24 ? (givn || fullName.slice(0, 22) + '…') : fullName,
  });
  _famEditPendingChil.push({ id: newId, name: fullName, isNew: true });
  document.getElementById('ef-fnc-givn').value = '';
  document.getElementById('ef-fnc-surn').value = '';
  document.getElementById('ef-fnc-sex').value  = 'U';
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
  f.husb = husbVal ? (_resolvePersonInput(husbVal) || f.husb) : null;
  f.wife = wifeVal ? (_resolvePersonInput(wifeVal) || f.wife) : null;

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
  _fullRebuildGraph();
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
    : (() => { const f = families.get(id); return 'Familie' + (f ? ': ' + [f.husb, f.wife].filter(Boolean).map(p => individuals.get(p)?.name || p).join(' & ') : ''); })();
  document.getElementById('delete-confirm-msg').textContent = `„${name}" wirklich löschen?`;
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
  _fullRebuildGraph();
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
  document.getElementById('detail-name').textContent = 'Neue Person';
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
    row.innerHTML = `<span class="preset-name" title="${escAttr(name)}" onclick="applyPreset('${escAttr(name)}',true)">${escHtml(name)}</span>`;
    container.appendChild(row);
  }

  // User presets
  const user = getUserPresets();
  const names = Object.keys(user);
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'preset-row user';
    row.innerHTML = `
      <span class="preset-name" title="${escAttr(name)}" onclick="applyPreset('${escAttr(name)}',false)">${escHtml(name)}</span>
      <button class="preset-del" onclick="deletePreset('${escAttr(name)}')" title="Löschen">&#x2715;</button>`;
    container.appendChild(row);
  }

  if (!names.length && !Object.keys(BUILTIN_PRESETS).length) {
    container.innerHTML = '<div style="color:#555;font-size:11px;font-style:italic;padding:2px 4px">Keine Presets</div>';
  }
}

// ═══════════════════════════════════════════════════════════════
// 3D VIEW
// ═══════════════════════════════════════════════════════════════

function toggleView() {
  if (!nodes.length) return;
  const btn = document.getElementById('view-toggle-btn');
  const c2d = document.getElementById('graph-container');
  const c3d = document.getElementById('graph-3d-container');

  if (currentView === '2d') {
    currentView = '3d';
    c2d.style.display = 'none';
    c3d.style.display = 'block';
    btn.textContent = '◨ 2D'; btn.classList.add('active-3d');
    document.getElementById('sort-time-3d-row').style.display = 'flex';
    document.getElementById('time-spread-row').style.display = sortByTime3D ? 'block' : 'none';
    document.getElementById('show-names-3d-row').style.display = 'flex';
    if (!graph3d) initGraph3D();
    else { graph3d.resumeAnimation(); resize3D(); }
    // If a person is already selected, orbit around them
    if (selectedIndiId) setTimeout(() => _setOrbitTarget3D(selectedIndiId), 200);
  } else {
    currentView = '2d';
    c3d.style.display = 'none';
    c2d.style.display = 'block';
    btn.textContent = '◧ 3D'; btn.classList.remove('active-3d');
    document.getElementById('sort-time-3d-row').style.display = 'none';
    document.getElementById('time-spread-row').style.display = 'none';
    document.getElementById('show-names-3d-row').style.display = 'none';
    if (graph3d) graph3d.pauseAnimation();
  }
}

function resize3D() {
  if (!graph3d) return;
  const el = document.getElementById('graph-3d-container');
  graph3d.width(el.clientWidth).height(el.clientHeight);
}

function compute3DNodeColor(n) {
  const hasHL = hlSet.size > 0;
  if (hasHL && !hlSet.has(n.id)) return '#0d0d1a';
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
      return `<span style="background:rgba(10,20,50,.92);padding:3px 7px;border-radius:3px;font-size:12px;color:#e0e0e0">${escHtml(i.displayName || i.name)}${born}${died}</span>`;
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
    _orbitControls3d.enableZoom     = false;   // wheel zoom handled manually (zoom-to-cursor)
    _orbitControls3d.enablePan      = true;
    _orbitControls3d.minDistance    = 1;       // unrestricted — no hard floor
    _orbitControls3d.maxDistance    = Infinity;
    // Touch: 1-finger = ROTATE, 2-finger = PAN only (zoom via our pinch handler)
    if (_orbitControls3d.touches) {
      _orbitControls3d.touches = {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.ROTATE,
      };
    }
    cam.up.set(0, 1, 0);
    _orbitControls3d.update();

    // Zoom toward cursor position (scroll wheel)
    domEl.addEventListener('wheel', _onWheel3D, { passive: false });

    // Touch pinch-to-zoom (since OrbitControls zoom is disabled for custom cursor-zoom)
    domEl.addEventListener('touchstart', _onTouch3DStart, { passive: false });
    domEl.addEventListener('touchmove', _onTouch3DMove, { passive: false });
    domEl.addEventListener('touchend', _onTouch3DEnd, { passive: true });

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
        } else {
          child.material.opacity = 1.0;
          child.material.transparent = false;
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
        } else {
          child.material.opacity = _3dAppearance.linkOpacity;
          child.material.transparent = _3dAppearance.linkOpacity < 1;
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
  return (hlSet.has(sid) && hlSet.has(tid)) ? linkColor(l) : '#111122';
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
    ctx.fillStyle = 'rgba(8, 16, 48, 0.88)';
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, 5);
    ctx.fill();
    // Bright border
    ctx.strokeStyle = 'rgba(100, 160, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Year text
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#c8e0ff';
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
  const spineMat = new THREE.MeshBasicMaterial({ color: 0x4466bb, transparent: true, opacity: 0.75,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  const spine = new THREE.Mesh(spineGeo, spineMat);
  spine.renderOrder = 0;
  spine.position.set(0, (topY + botY) / 2, 0);
  group.add(spine);

  // ── Year ticks + labels ──
  const step = span > 200 ? 50 : span > 80 ? 25 : 10;
  const startYr = Math.ceil(minYr / step) * step;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x5588cc, transparent: true, opacity: 0.70, side: THREE.DoubleSide,
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
  const maidenLine = indi.maidenName ? `geb. ${indi.maidenName}` : '';
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
    btn.textContent = _nodeDragEnabled ? '🔓 Ziehen an' : '🔒 Ziehen aus';
    btn.style.opacity = _nodeDragEnabled ? '1' : '0.6';
  }
}

// ── Top-down high-res export ──
function export3DTopDown() {
  if (!graph3d) return;

  const btn = document.querySelector('button[onclick="export3DTopDown()"]');
  if (btn) { btn.textContent = '⏳ Wird gerendert…'; btn.disabled = true; }

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
    const FONT_NAME = Math.round(_3dFontSize * scale * 0.45);   // matches sprite scale
    const FONT_YEAR = Math.round(FONT_NAME * 0.72);
    const PAD_X = Math.round(FONT_NAME * 0.6);
    const PAD_Y = Math.round(FONT_NAME * 0.3);
    const FAM_R  = Math.max(4, Math.round(scale * 1.5));

    const canvas = document.createElement('canvas');
    canvas.width  = CW;
    canvas.height = CH;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = _3dAppearance.bgColor || '#04060f';
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
      let born = indi.birthYear ? `*${indi.birthYear}` : '';
      if (!born && _estimatedYears?.has(p.n.id)) born = `~${_estimatedYears.get(p.n.id)}`;
      const died = indi.deceased ? '†' + (indi.death.date?.match(/\d{4}/)?.[0] ?? '') : '';
      const yearLine = [born, died].filter(Boolean).join('  ');

      tmpCtx.font = `bold ${FONT_NAME}px Arial`;
      const nameW = tmpCtx.measureText(name).width;
      tmpCtx.font = `${FONT_YEAR}px Arial`;
      const yearW = yearLine ? tmpCtx.measureText(yearLine).width : 0;

      const boxW = Math.ceil(Math.max(nameW, yearW)) + PAD_X * 2;
      const boxH = FONT_NAME + (yearLine ? FONT_YEAR + Math.round(FONT_NAME * 0.15) : 0) + PAD_Y * 2;
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
      ctx.font = `bold ${FONT_NAME}px Arial`;
      ctx.fillStyle = textColor;
      ctx.fillText(name, cx, by + PAD_Y);

      if (yearLine) {
        ctx.font = `${FONT_YEAR}px Arial`;
        ctx.fillStyle = textColor + 'bb';
        ctx.fillText(yearLine, cx, by + PAD_Y + FONT_NAME + Math.round(FONT_NAME * 0.15));
      }
    }

    // Restore
    _3dYHalfSpan = origHalfSpan;
    applyTimelineYFix();
    graph3d.d3ReheatSimulation();

    if (btn) { btn.textContent = '📥 Export Top-Down'; btn.disabled = false; }

    const a = document.createElement('a');
    a.download = 'stammbaum_export.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }, 2500);
}

// Resize 3D view when window resizes
window.addEventListener('resize', () => { if (currentView === '3d') resize3D(); });

// ── Orbit target: smoothly animate to a node or back to origin ──
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
  if (!to) to = new THREE.Vector3(0, 0, 0);
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
  const dist    = cam.position.distanceTo(ctrl.target);
  const newDist = Math.max(1, dist * factor);

  // Zoom-to-cursor: find scene point under cursor at cam-target depth,
  // move camera toward it, shift target by the same delta (orbit geometry preserved).
  const focusPoint = cam.position.clone().addScaledVector(ray, dist);
  const newCamPos  = focusPoint.clone().addScaledVector(ray, -newDist);
  const shift      = newCamPos.clone().sub(cam.position);
  cam.position.copy(newCamPos);
  ctrl.target.add(shift);   // same shift — keeps cam↔target vector intact
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
    case 'r': case 'R': resetHighlight();         break;
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

  // Touch support
  _initPanelSwipe();
  _initTouchDragGuard();

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
    if (colorModeLabelEl) colorModeLabelEl.textContent = colorBySurname ? 'Nachname' : 'Geschlecht';
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
    `<div class="rel-drop-item" onmousedown="relSelectPerson('${slot}','${escAttr(m.id)}')">${escHtml(m.label)}</div>`
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
  if (idA === idB)  { result.textContent = 'Dieselbe Person'; return; }

  const indiA = individuals.get(idA);
  const indiB = individuals.get(idB);
  if (!indiA || !indiB) { result.textContent = 'Person nicht gefunden'; return; }

  // --- Check spouse ---
  for (const famId of indiA.fams) {
    const fam = families.get(famId);
    if (!fam) continue;
    if (fam.husb === idB || fam.wife === idB) {
      result.innerHTML = _relLine('💍', 'Ehepartner/in');
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
    result.innerHTML = _relLine(_sexIcon(indiB), indiB.sex === 'M' ? 'Onkel' : indiB.sex === 'F' ? 'Tante' : 'Onkel/Tante');
    return;
  }
  if (bestGenA === 2 && bestGenB === 1) {
    result.innerHTML = _relLine(_sexIcon(indiA), indiA.sex === 'M' ? 'Neffe' : indiA.sex === 'F' ? 'Nichte' : 'Neffe/Nichte');
    return;
  }

  // great-aunt/uncle
  if (bestGenA === 1 && bestGenB === 3) {
    result.innerHTML = _relLine(_sexIcon(indiB), indiB.sex === 'M' ? 'Großonkel' : indiB.sex === 'F' ? 'Großtante' : 'Großonkel/-tante');
    return;
  }
  if (bestGenA === 3 && bestGenB === 1) {
    result.innerHTML = _relLine(_sexIcon(indiA), indiA.sex === 'M' ? 'Großneffe' : indiA.sex === 'F' ? 'Großnichte' : 'Großneffe/-nichte');
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
  if (gen === 1) return m ? 'Vater' : f ? 'Mutter' : 'Elternteil';
  if (gen === 2) return m ? 'Großvater' : f ? 'Großmutter' : 'Großelternteil';
  const prefix = 'Ur-'.repeat(gen - 2);
  return prefix + (m ? 'Urgroßvater' : f ? 'Urgroßmutter' : 'Urgroßelternteil');
}
function _descendantLabel(gen, sex) {
  const m = sex === 'M', f = sex === 'F';
  if (gen === 1) return m ? 'Sohn' : f ? 'Tochter' : 'Kind';
  if (gen === 2) return m ? 'Enkel' : f ? 'Enkelin' : 'Enkelkind';
  const prefix = 'Ur-'.repeat(gen - 2);
  return prefix + (m ? 'Urenkel' : f ? 'Urenkelin' : 'Urenkelkind');
}
function _siblingLabel(sex) {
  return sex === 'M' ? 'Bruder' : sex === 'F' ? 'Schwester' : 'Geschwister';
}
function _halfSiblingLabel(sex) {
  return sex === 'M' ? 'Halbbruder' : sex === 'F' ? 'Halbschwester' : 'Halbgeschwister';
}
function _cousinLabel(degree, removed, sex) {
  let base;
  if (degree === 1) base = sex === 'F' ? 'Cousine' : 'Cousin';
  else              base = (sex === 'F' ? 'Cousine' : 'Cousin') + ` ${degree}. Grades`;
  return removed > 0 ? `${base}, ${removed}× entfernt` : base;
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
      return steps > 0 ? `${steps} Verwandtschaftsschritte entfernt` : 'Verbunden';
    }
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb.id)) {
        visited.set(nb.id, { from: cur });
        queue.push(nb.id);
      }
    }
  }
  return 'Keine Verbindung gefunden';
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
window.savePreset        = savePreset;
window.deletePreset      = deletePreset;
window.applyPreset       = applyPreset;
window.downloadGEDCOM    = downloadGEDCOM;
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

  for (const person of persons) {
    const existing = lookup(person);
    if (existing === null) {
      actions.push({
        id:     Math.random().toString(36).slice(2),
        kind:   'person',
        status: 'pending',
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
            existingId: existing,
            fields:   Object.assign({ 'Name': person.fullName }, missing),
            source:   person.sourceNote,
            _person:  person,
          });
        }
      }
    }
  }

  for (const person of persons) {
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
    if (action.fields['Birth Date'])  indi.birth.date = action.fields['Birth Date'];
    if (action.fields['Birth Place']) indi.birth.plac = action.fields['Birth Place'];
    if (action.fields['Death Date']) { indi.death.date = action.fields['Death Date']; indi.deceased = true; }
    if (action.fields['Death Place']) indi.death.plac = action.fields['Death Place'];
    if (action.fields['Sex'] && (!indi.sex || indi.sex === 'U')) indi.sex = action.fields['Sex'];
    if (action.fields['Notes']) {
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
    const husbName = (action.fields['Husband']||'').trim();
    const wifeName = (action.fields['Wife']||'').trim();
    const husbId = nameToId.get(_tiNormName(husbName)) || null;
    const wifeId = nameToId.get(_tiNormName(wifeName)) || null;
    const famXref = `@F${++maxFam}@`;

    const childIds = [];
    const childrenStr = action.fields['Children'] || '';
    for (const cname of childrenStr.split(';').map(s=>s.trim()).filter(Boolean)) {
      const cid = nameToId.get(_tiNormName(cname));
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
let _importJsonPersons = null;  // set when a .json file is loaded

function openTextImport() {
  document.getElementById('import-modal').style.display = 'flex';
  _resetImportUI();
}

function closeTextImport() {
  document.getElementById('import-modal').style.display = 'none';
  _importActions = [];
}

function _resetImportUI() {
  document.getElementById('import-step-input').style.display = '';
  document.getElementById('import-step-review').style.display = 'none';
  document.getElementById('import-text-area').value = '';
  const fi = document.getElementById('import-file-input');
  if (fi) { fi.value = ''; }
  document.getElementById('import-file-name').textContent = 'Keine Datei gewählt';
  _importActions = [];
  _importJsonPersons = null;
}

function handleImportFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('import-file-name').textContent = file.name;
  _importJsonPersons = null;
  const isGed  = /\.ged$/i.test(file.name);
  const isJson = /\.json$/i.test(file.name);
  const reader = new FileReader();
  if (isGed) {
    reader.onload = ev => {
      const persons = _tiParseGedcomForMerge(ev.target.result || '');
      if (persons?.length) {
        _importJsonPersons = persons;
        document.getElementById('import-text-area').value =
          `[GEDCOM geladen: ${persons.length} Person${persons.length !== 1 ? 'en' : ''} erkannt. Klicke «Analysieren» um fortzufahren.]`;
      } else {
        document.getElementById('import-text-area').value = '';
        alert('GEDCOM-Datei konnte nicht geparst werden oder enthält keine Personen.');
      }
    };
  } else if (isJson) {
    reader.onload = ev => {
      try {
        const obj = JSON.parse(ev.target.result || '{}');
        const persons = _tiParseStructuredJson(obj);
        if (persons && persons.length) {
          _importJsonPersons = persons;
          document.getElementById('import-text-area').value =
            `[Strukturierte JSON-Datei geladen: ${persons.length} Person${persons.length!==1?'en':''} erkannt. Klicke «Analysieren» um fortzufahren.]`;
        } else {
          document.getElementById('import-text-area').value = '';
          alert('JSON-Datei konnte nicht geparst werden oder enthält keine Personen.');
        }
      } catch(err) {
        document.getElementById('import-text-area').value = '';
        alert('Ungültige JSON-Datei: ' + err.message);
      }
    };
  } else {
    reader.onload = ev => { document.getElementById('import-text-area').value = ev.target.result || ''; };
  }
  reader.readAsText(file, 'utf-8');
}

function parseImportText() {
  let persons;
  if (_importJsonPersons) {
    persons = _importJsonPersons;
  } else {
    const raw = (document.getElementById('import-text-area').value || '').trim();
    if (!raw) { alert('Bitte Text eingeben oder Datei laden.'); return; }
    const clean = _tiCleanText(raw);
    persons = _tiParseText(clean);
    if (!persons.length) {
      alert('Keine Personen erkannt.\nErwartet wird englischer Genealogietext mit Mustern wie:\n  «was born on … married … son/daughter of …»');
      return;
    }
  }

  _importActions = _tiGenerateActions(persons);

  if (!_importActions.length) {
    alert(`${persons.length} Person(en) erkannt, aber alle sind bereits in der GEDCOM-Datei vorhanden.`);
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
      <span class="import-stat"><b>${_importActions.length}</b> Vorschläge</span>
      <span class="import-stat import-stat--person">&#x1F464; <b>${nPers}</b> neu</span>
      <span class="import-stat import-stat--update">&#x270F; <b>${nUpd}</b> Erg\u00e4nzung${nUpd!==1?'en':''}</span>
      <span class="import-stat import-stat--marriage">&#x1F48D; <b>${nMarr}</b> Ehe${nMarr!==1?'n':''}</span>
      <span class="import-stat import-stat--approved">&#x2713; <b>${nApp}</b> genehmigt</span>
      <span class="import-stat import-stat--skipped">&#x2715; <b>${nSkip}</b> übersprungen</span>
      <span class="import-stat import-stat--pending">&#x23F3; <b>${nPend}</b> ausstehend</span>
    </div>
    <div class="import-bulk-actions">
      <button class="import-bulk-btn import-bulk-btn--approve" onclick="_importApproveAll()">&#x2713; Alle genehmigen</button>
      <button class="import-bulk-btn import-bulk-btn--skip"    onclick="_importSkipAll()">&#x2715; Alle überspringen</button>
      <button class="import-bulk-btn import-bulk-btn--reset"   onclick="_importResetAll()">&#x21BA; Zurücksetzen</button>
    </div>
  `;
}

function _renderImportReview() {
  _renderImportSummary();
  document.getElementById('import-actions-list').innerHTML =
    _importActions.map((action, idx) => _renderImportCard(action, idx)).join('');
}

function _renderImportCard(action) {
  const kindLabel = action.kind === 'person' ? 'Person hinzufügen' : action.kind === 'update' ? 'Person ergänzen' : 'Ehe hinzufügen';
  const kindClass = action.kind === 'person' ? 'import-badge--person' : action.kind === 'update' ? 'import-badge--update' : 'import-badge--marriage';
  const stCls = { pending:'import-status--pending', approved:'import-status--approved', skipped:'import-status--skipped' }[action.status];
  const stLbl = { pending:'&#x23F3; Ausstehend', approved:'&#x2713; Genehmigt', skipped:'&#x2715; \xdcbersprungen' }[action.status];

  const fieldsHtml = Object.entries(action.fields).map(([label, val]) => {
    const wideClass = label === 'Children' ? ' import-field-row--wide' : '';
    const fid = `if-${action.id}-${label.replace(/\s+/g,'_')}`;
    return `<div class="import-field-row${wideClass}">
      <label class="import-field-label" for="${fid}">${escHtml(label)}</label>
      <input class="import-field-input" id="${fid}" type="text"
             value="${escHtml(val||'')}"
             data-action="${action.id}" data-field="${label}"
             placeholder="(leer)">
    </div>`;
  }).join('');

  // Add match selection button for person actions
  const matchBtn = (action.kind === 'person' || action.kind === 'update') ? `
    <button class="import-btn import-btn--match" onclick="openMatchDialog('${action.id}')">
      &#x1F50D; Person auswählen
    </button>
  ` : '';

  const srcHtml = action.source ? `
    <details class="import-source-details">
      <summary>Quelltext</summary>
      <div class="import-source-text">${escHtml(action.source)}</div>
    </details>` : '';

  const appActive = action.status === 'approved' ? ' import-btn--active' : '';
  const skpActive = action.status === 'skipped'  ? ' import-btn--active' : '';

  return `<div class="import-action-card import-action-card--${action.status}" data-action-id="${action.id}">
    <div class="import-card-header">
      <span class="import-badge ${kindClass}">${kindLabel}</span>
      <span class="import-status ${stCls}">${stLbl}</span>
    </div>
    <div class="import-fields">${fieldsHtml}</div>
    ${srcHtml}
    <div class="import-card-actions">
      <button class="import-btn import-btn--approve${appActive}" data-action="${action.id}" data-status="approved">&#x2713; Genehmigen</button>
      <button class="import-btn import-btn--skip${skpActive}"    data-action="${action.id}" data-status="skipped">&#x2715; \xdcberspringen</button>
      ${matchBtn}
    </div>
  </div>`;
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
      const stLbl = { pending:'&#x23F3; Ausstehend', approved:'&#x2713; Genehmigt', skipped:'&#x2715; \xdcbersprungen' }[action.status];
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
    if (action) action.fields[inp.dataset.field] = inp.value;
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
    alert('Keine Änderungen genehmigt.\nBitte mindestens eine Änderung genehmigen.');
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
    countEl.textContent = `${done} / ${total}`;

    if (done < total) {
      setTimeout(tick, 0);
      return;
    }

    // All ticks done — now run the actual synchronous apply + rebuild
    labelEl.textContent = 'Graph wird aktualisiert…';
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
      alert(`Import abgeschlossen:\n• ${nAdd} Person${nAdd!==1?'en':''} hinzugef\xfcgt\n• ${nUpd} Person${nUpd!==1?'en':''} erg\u00e4nzt\n• ${nFam} Famili${nFam!==1?'en':'e'} erstellt\n• ${nSkip} bereits vorhanden`);
    }));
  }

  setTimeout(tick, 0);
}

window.openTextImport    = openTextImport;
window.closeTextImport   = closeTextImport;
window.handleImportFileSelect = handleImportFileSelect;
window.parseImportText   = parseImportText;
window.backToInputImport = backToInputImport;
window.applyImport       = applyImport;
window._importApproveAll = _importApproveAll;
window._importSkipAll    = _importSkipAll;
window._importResetAll   = _importResetAll;

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
      <div class="import-match-name">${escHtml(action.fields['Name'] || 'Unnamed')}</div>
      <div class="import-match-details">
        ${action.fields['Birth Date'] ? `Geb: ${escHtml(action.fields['Birth Date'])}` : ''}
        ${action.fields['Birth Place'] ? ` in ${escHtml(action.fields['Birth Place'])}` : ''}
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
    listEl.innerHTML = '<div class="import-match-empty">Keine Treffer gefunden.</div>';
    return;
  }
  
  listEl.innerHTML = candidates.map((c, idx) => `
    <div class="import-match-candidate" onclick="selectMatchCandidate('${c.type}', '${c.type === 'existing' ? c.id : c.actionId}')">
      <div class="import-match-candidate-type ${c.type === 'existing' ? 'type-existing' : 'type-pending'}">
        ${c.type === 'existing' ? 'GEDCOM' : 'NEU'}
      </div>
      <div class="import-match-candidate-info">
        <div class="import-match-candidate-name">${escHtml(c.name)}</div>
        <div class="import-match-candidate-details">
          ${c.birth ? `geb. ${escHtml(c.birth)}` : ''}
          ${c.death ? ` - gest. ${escHtml(c.death)}` : ''}
          [${c.sex}]
        </div>
      </div>
      <div class="import-match-candidate-score">Score: ${c.score}</div>
    </div>
  `).join('');
}

function searchMatchCandidates() {
  const query = document.getElementById('import-match-search-input').value.toLowerCase().trim();
  if (!query) {
    renderMatchCandidates(_currentMatchCandidates);
    return;
  }
  
  const filtered = _currentMatchCandidates.filter(c => 
    c.name.toLowerCase().includes(query)
  );
  renderMatchCandidates(filtered);
}

function selectMatchCandidate(type, targetId) {
  if (!_currentMatchActionId) return;
  
  const action = _importActions.find(a => a.id === _currentMatchActionId);
  if (!action) return;
  
  if (type === 'existing') {
    // Link to existing GEDCOM person
    const indi = individuals.get(targetId);
    if (!indi) return;
    
    // Convert to update action
    action.kind = 'update';
    action.existingId = targetId;
    action.status = 'approved';
    
    // Determine what fields to update
    const missing = {};
    if (!indi.birth?.date && action.fields['Birth Date']) missing['Birth Date'] = action.fields['Birth Date'];
    if (!indi.birth?.plac && action.fields['Birth Place']) missing['Birth Place'] = action.fields['Birth Place'];
    if (!indi.death?.date && action.fields['Death Date']) missing['Death Date'] = action.fields['Death Date'];
    if (!indi.death?.plac && action.fields['Death Place']) missing['Death Place'] = action.fields['Death Place'];
    if ((!indi.sex || indi.sex === 'U') && action.fields['Sex']) missing['Sex'] = action.fields['Sex'];
    
    // Keep name but update fields
    action.fields = Object.assign({ 'Name': action.fields['Name'] }, missing);
    
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

// ═══════════════════════════════════════════════════════════════
// STEP-BY-STEP WIZARD FUNCTIONS
// ═══════════════════════════════════════════════════════════════

let _wizardEntries = [];        // Parsed person entries
let _wizardCurrentIdx = 0;      // Current entry being reviewed
let _wizardDecisions = new Map(); // entry idx -> decision
let _wizardAutoSkippedCount = 0;  // Count of auto-skipped entries

function openWizard() {
  document.getElementById('wizard-modal').style.display = 'flex';
  _resetWizard();
}

function closeWizard() {
  document.getElementById('wizard-modal').style.display = 'none';
  _wizardEntries = [];
  _wizardDecisions.clear();
  _wizardCurrentIdx = 0;
}

function _resetWizard() {
  // Show load step
  document.getElementById('wizard-step-load').style.display = '';
  document.getElementById('wizard-step-review').style.display = 'none';
  document.getElementById('wizard-step-summary').style.display = 'none';
  document.getElementById('wizard-progress-fill').style.width = '33%';
  document.getElementById('wizard-progress-text').textContent = 'Schritt 1/3: Text laden';

  // Clear inputs
  document.getElementById('wizard-text-area').value = '';
  document.getElementById('wizard-file-input').value = '';
  document.getElementById('wizard-file-name').textContent = 'Keine Datei gewählt';

  _wizardEntries = [];
  _wizardDecisions.clear();
  _wizardCurrentIdx = 0;
  _wizardAutoSkippedCount = 0;

  // Hide notifications
  document.getElementById('wizard-auto-skip-notice').style.display = 'none';
}

function handleWizardFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('wizard-file-name').textContent = file.name;

  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('wizard-text-area').value = ev.target.result || '';
  };
  reader.readAsText(file, 'utf-8');
}

function wizardParseText() {
  const raw = (document.getElementById('wizard-text-area').value || '').trim();
  if (!raw) {
    alert('Bitte Text eingeben oder Datei laden.');
    return;
  }

  // Parse using existing text import logic
  const clean = _tiCleanText(raw);
  const persons = _tiParseText(clean);

  if (!persons.length) {
    alert('Keine Personen erkannt.\nErwartet wird englischer Genealogietext mit Mustern wie:\n  «was born on … married … son/daughter of …»');
    return;
  }

  _wizardEntries = persons.map((p, idx) => ({
    ...p,
    entryId: `entry_${idx}`,
    status: 'pending'
  }));

  // Switch to review step
  document.getElementById('wizard-step-load').style.display = 'none';
  document.getElementById('wizard-step-review').style.display = '';
  document.getElementById('wizard-progress-fill').style.width = '66%';
  document.getElementById('wizard-progress-text').textContent = 'Schritt 2/3: Einträge prüfen';

  // Show first entry
  _wizardCurrentIdx = 0;
  wizardShowEntry(0);
}

function wizardShowEntry(idx) {
  if (idx < 0 || idx >= _wizardEntries.length) return;

  // Check if this entry should be auto-skipped (already processed)
  const existingDecision = _wizardDecisions.get(idx);
  if (existingDecision) {
    // Already has a decision, show it normally
    _wizardRenderEntry(idx);
    return;
  }

  // Check if entry needs attention (has changes or is new)
  const needsAttention = _wizardEntryNeedsAttention(idx);

  if (!needsAttention) {
    // Auto-skip: mark and move to next
    _wizardDecisions.set(idx, { action: 'skip', reason: 'no_changes_needed' });
    _wizardAutoSkippedCount++;

    if (idx < _wizardEntries.length - 1) {
      wizardShowEntry(idx + 1);
    } else {
      wizardShowSummary();
    }
    return;
  }

  // Check for high-confidence match for auto-linking
  const autoLinkMatch = _wizardFindBestMatchForAutoLink(idx);
  if (autoLinkMatch && autoLinkMatch.score >= 150) {
    // Auto-link to existing person with high confidence
    _wizardDecisions.set(idx, {
      action: 'link',
      targetId: autoLinkMatch.id,
      entry: entry,
      autoLinked: true
    });
    _wizardAutoSkippedCount++;

    if (idx < _wizardEntries.length - 1) {
      wizardShowEntry(idx + 1);
    } else {
      wizardShowSummary();
    }
    return;
  }

  // Show notification if we auto-skipped some entries to get here
  if (_wizardAutoSkippedCount > 0) {
    const noticeEl = document.getElementById('wizard-auto-skip-notice');
    const textEl = document.getElementById('wizard-auto-skip-text');
    const skipped = _wizardAutoSkippedCount;
    textEl.textContent = `${skipped} Eintrag(e) übersprungen (keine Änderungen oder auto-verknüpft)`;
    noticeEl.style.display = 'flex';
    _wizardAutoSkippedCount = 0;
  } else {
    document.getElementById('wizard-auto-skip-notice').style.display = 'none';
  }

  _wizardRenderEntry(idx);
}

function _wizardEntryNeedsAttention(idx) {
  const entry = _wizardEntries[idx];

  // Find existing match
  const existingId = _wizardFindExistingMatch(entry);
  const existing = existingId ? individuals.get(existingId) : null;

  if (!existing) {
    // New person - needs attention if has any data
    return !!(entry.fullName || entry.birthDate || entry.deathDate);
  }

  // Check if there are any actual changes to make
  const hasChanges =
    (entry.birthDate && !existing.birth?.date) ||
    (entry.birthPlace && !existing.birth?.plac) ||
    (entry.deathDate && !existing.death?.date) ||
    (entry.deathPlace && !existing.death?.plac) ||
    (entry.sex && entry.sex !== 'U' && (!existing.sex || existing.sex === 'U')) ||
    (entry.notes && !existing.note?.includes(entry.notes));

  return hasChanges;
}

function _wizardFindBestMatchForAutoLink(idx) {
  const entry = _wizardEntries[idx];
  const searchName = (entry.fullName || '').toLowerCase();
  const searchBirth = (entry.birthDate || '').match(/\b(\d{4})\b/)?.[1] || '';

  let bestMatch = null;
  let bestScore = 0;

  for (const [id, indi] of individuals) {
    const indiName = (indi.name || '').toLowerCase();
    const indiBirth = (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || '';

    let score = 0;

    // Exact name match
    if (indiName === searchName) {
      score = 100;
    } else if (indiName.includes(searchName) || searchName.includes(indiName)) {
      score = 60;
    }

    // Birth year match
    if (score > 0 && indiBirth && searchBirth) {
      if (indiBirth === searchBirth) {
        score += 50;
      } else if (Math.abs(parseInt(indiBirth) - parseInt(searchBirth)) <= 1) {
        score += 30;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { id, name: indi.name, score };
    }
  }

  return bestMatch;
}

function _wizardRenderEntry(idx) {
  if (idx < 0 || idx >= _wizardEntries.length) return;

  _wizardCurrentIdx = idx;
  const entry = _wizardEntries[idx];

  // Update counter
  document.getElementById('wizard-current-idx').textContent = idx + 1;
  document.getElementById('wizard-total-count').textContent = _wizardEntries.length;

  // Show source text
  document.getElementById('wizard-source-text').textContent = entry.sourceNote || '(Kein Quelltext verfügbar)';

  // Populate fields
  document.getElementById('wizard-field-name').value = entry.fullName || '';
  document.getElementById('wizard-field-sex').value = entry.sex || '';
  document.getElementById('wizard-field-birth-date').value = entry.birthDate || '';
  document.getElementById('wizard-field-birth-place').value = entry.birthPlace || '';
  document.getElementById('wizard-field-death-date').value = entry.deathDate || '';
  document.getElementById('wizard-field-death-place').value = entry.deathPlace || '';
  document.getElementById('wizard-field-father').value = entry.fatherName || '';
  document.getElementById('wizard-field-mother').value = entry.motherName || '';
  document.getElementById('wizard-field-notes').value = entry.notes || '';

  // Check if already decided
  const currentDecision = _wizardDecisions.get(idx);

  // Populate marriages with enhanced spouse search
  const marriagesHtml = (entry.marriages || []).map((m, i) => {
    const spouseId = m._linkedSpouseId || '';
    return `
    <div class="wizard-marriage-row" data-idx="${i}">
      <div class="wizard-marriage-spouse-section">
        <input type="text" placeholder="Ehepartner suchen..." value="${escHtml(m.spouseName || '')}" class="wiz-marr-spouse"
               oninput="wizardSearchSpouseForMarriage(${i}, this.value)"
               onfocus="wizardShowSpouseSearch(${i})">
        <div id="wiz-marr-search-${i}" class="wizard-marriage-spouse-search" style="display:none"></div>
        ${spouseId ? `<span class="wizard-marriage-spouse-linked">&#x1F517; Verknüpft</span>` : ''}
        <input type="hidden" class="wiz-marr-spouse-id" value="${spouseId}">
      </div>
      <div class="wizard-marriage-dates">
        <input type="text" placeholder="Hochzeitsdatum" value="${escHtml(m.date || '')}" class="wiz-marr-date">
        <input type="text" placeholder="Hochzeitsort" value="${escHtml(m.place || '')}" class="wiz-marr-place">
      </div>
      <button onclick="wizardRemoveMarriage(${i})" title="Ehe entfernen">&#x2715;</button>
    </div>
  `}).join('');
  document.getElementById('wizard-marriages-list').innerHTML = marriagesHtml || '<div style="color:#567;font-size:12px;">Keine Ehen erkannt</div>';

  // Calculate and show proposed changes (with auto-link info)
  wizardCalculateChanges(entry, currentDecision);

  // Find and show matches
  wizardFindMatches(entry);

  // Show auto-link status if applicable
  if (currentDecision?.autoLinked) {
    const noticeEl = document.getElementById('wizard-auto-link-notice');
    const textEl = document.getElementById('wizard-auto-link-text');
    const indi = individuals.get(currentDecision.targetId);
    textEl.textContent = `Auto-verknüpft mit: ${indi?.name || currentDecision.targetId} (Score: 150+)`;
    noticeEl.style.display = 'flex';
  } else {
    document.getElementById('wizard-auto-link-notice').style.display = 'none';
  }

  // Update button states based on decision
  _wizardUpdateButtonStates(currentDecision);
}

function wizardCalculateChanges(entry, currentDecision) {
  const changes = [];

  // Show auto-link status
  if (currentDecision?.autoLinked && currentDecision?.targetId) {
    const indi = individuals.get(currentDecision.targetId);
    changes.push({ field: 'Status', old: '(neu)', new: `Auto-verknüpft mit ${indi?.name || currentDecision.targetId}` });
    return; // No other changes needed for auto-linked entries
  }

  // Find existing match
  const existingId = _wizardFindExistingMatch(entry);
  const existing = existingId ? individuals.get(existingId) : null;

  if (existing) {
    // Compare fields
    if (entry.birthDate && entry.birthDate !== (existing.birth?.date || '')) {
      changes.push({ field: 'Geburtsdatum', old: existing.birth?.date || '(leer)', new: entry.birthDate });
    }
    if (entry.birthPlace && entry.birthPlace !== (existing.birth?.plac || '')) {
      changes.push({ field: 'Geburtsort', old: existing.birth?.plac || '(leer)', new: entry.birthPlace });
    }
    if (entry.deathDate && entry.deathDate !== (existing.death?.date || '')) {
      changes.push({ field: 'Sterbedatum', old: existing.death?.date || '(leer)', new: entry.deathDate });
    }
    if (entry.deathPlace && entry.deathPlace !== (existing.death?.plac || '')) {
      changes.push({ field: 'Sterbeort', old: existing.death?.plac || '(leer)', new: entry.deathPlace });
    }
    if (entry.sex && entry.sex !== 'U' && entry.sex !== (existing.sex || 'U')) {
      changes.push({ field: 'Geschlecht', old: existing.sex || '(leer)', new: entry.sex });
    }
  } else {
    // New person - show what will be added
    if (entry.fullName) changes.push({ field: 'Name', old: '(neu)', new: entry.fullName });
    if (entry.birthDate) changes.push({ field: 'Geburtsdatum', old: '(neu)', new: entry.birthDate });
    if (entry.birthPlace) changes.push({ field: 'Geburtsort', old: '(neu)', new: entry.birthPlace });
  }

  const changesHtml = changes.length ? changes.map(c => `
    <div class="wizard-change-item">
      <span class="wizard-change-field">${escHtml(c.field)}:</span>
      <span class="wizard-change-old">${escHtml(c.old)}</span>
      <span class="wizard-change-arrow">&#x2192;</span>
      <span class="wizard-change-new">${escHtml(c.new)}</span>
    </div>
  `).join('') : '<div style="color:#567;font-size:12px;">Keine Änderungen vorgeschlagen</div>';

  document.getElementById('wizard-changes-list').innerHTML = changesHtml;
}

function wizardFindMatches(entry) {
  const candidates = [];
  const searchName = (entry.fullName || '').toLowerCase();
  const searchBirth = (entry.birthDate || '').match(/\b(\d{4})\b/)?.[1] || '';

  // Search in existing individuals
  for (const [id, indi] of individuals) {
    const indiName = (indi.name || '').toLowerCase();
    const indiBirth = (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || '';

    let score = 0;
    if (indiName === searchName) {
      score = 100;
    } else if (indiName.includes(searchName) || searchName.includes(indiName)) {
      score = 50;
    } else if (indiName.split(' ').pop() === searchName.split(' ').pop()) {
      score = 30;
    }

    if (score > 0 && indiBirth && searchBirth) {
      if (indiBirth === searchBirth) score += 50;
      else if (Math.abs(parseInt(indiBirth) - parseInt(searchBirth)) <= 2) score += 20;
    }

    if (score > 0) {
      candidates.push({ type: 'existing', id, name: indi.name, birth: indi.birth?.date || '', death: indi.death?.date || '', sex: indi.sex || 'U', score });
    }
  }

  // Search in other entries
  _wizardEntries.forEach((other, idx) => {
    if (idx === _wizardCurrentIdx) return;
    const otherName = (other.fullName || '').toLowerCase();
    const otherBirth = (other.birthDate || '').match(/\b(\d{4})\b/)?.[1] || '';

    let score = 0;
    if (otherName === searchName) score = 90;
    else if (otherName.includes(searchName) || searchName.includes(otherName)) score = 40;

    if (score > 0 && otherBirth && searchBirth && otherBirth === searchBirth) score += 40;

    if (score > 0) {
      candidates.push({ type: 'new', idx, name: other.fullName, birth: other.birthDate || '', death: other.deathDate || '', sex: other.sex || 'U', score });
    }
  });

  candidates.sort((a, b) => b.score - a.score);

  const matchesHtml = candidates.slice(0, 5).map(c => `
    <div class="wizard-match-item" onclick="wizardSelectMatch('${c.type}', '${c.type === 'existing' ? c.id : c.idx}')">
      <span class="wizard-match-type ${c.type}">${c.type === 'existing' ? 'GEDCOM' : 'NEU'}</span>
      <div class="wizard-match-info">
        <div class="wizard-match-name">${escHtml(c.name)}</div>
        <div class="wizard-match-details">${c.birth ? `geb. ${escHtml(c.birth)}` : ''} ${c.death ? `- gest. ${escHtml(c.death)}` : ''} [${c.sex}]</div>
      </div>
      <span class="wizard-match-score">${c.score}</span>
    </div>
  `).join('');

  document.getElementById('wizard-matches-list').innerHTML = matchesHtml || '<div style="color:#567;font-size:12px;">Keine Treffer gefunden</div>';
}

function _wizardFindExistingMatch(entry) {
  const searchName = _tiNormName(entry.fullName || '');
  const searchBirth = (entry.birthDate || '').match(/\b(\d{4})\b/)?.[1] || '';

  for (const [id, indi] of individuals) {
    const indiName = _tiNormName(indi.name || '');
    const indiBirth = (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || '';

    if (indiName === searchName) {
      if (!searchBirth || !indiBirth || indiBirth === searchBirth) {
        return id;
      }
    }
  }
  return null;
}

function wizardSelectMatch(type, targetId) {
  const entry = _wizardEntries[_wizardCurrentIdx];

  if (type === 'existing') {
    // Mark for linking to existing
    _wizardDecisions.set(_wizardCurrentIdx, {
      action: 'link',
      targetId: targetId,
      entry: _wizardCollectFieldData()
    });
  } else {
    // Mark for linking to another new entry
    _wizardDecisions.set(_wizardCurrentIdx, {
      action: 'merge',
      targetIdx: parseInt(targetId),
      entry: _wizardCollectFieldData()
    });
  }

  _wizardUpdateButtonStates(_wizardDecisions.get(_wizardCurrentIdx));
  wizardNextEntry();
}

function wizardCollectFieldData() {
  const marriages = [];
  document.querySelectorAll('.wizard-marriage-row').forEach(row => {
    marriages.push({
      spouseName: row.querySelector('.wiz-marr-spouse')?.value || '',
      spouseId: row.querySelector('.wiz-marr-spouse-id')?.value || '',
      date: row.querySelector('.wiz-marr-date')?.value || '',
      place: row.querySelector('.wiz-marr-place')?.value || ''
    });
  });

  return {
    fullName: document.getElementById('wizard-field-name').value,
    sex: document.getElementById('wizard-field-sex').value,
    birthDate: document.getElementById('wizard-field-birth-date').value,
    birthPlace: document.getElementById('wizard-field-birth-place').value,
    deathDate: document.getElementById('wizard-field-death-date').value,
    deathPlace: document.getElementById('wizard-field-death-place').value,
    fatherName: document.getElementById('wizard-field-father').value,
    motherName: document.getElementById('wizard-field-mother').value,
    notes: document.getElementById('wizard-field-notes').value,
    marriages: marriages
  };
}

function wizardApproveEntry() {
  _wizardDecisions.set(_wizardCurrentIdx, {
    action: 'add',
    entry: wizardCollectFieldData()
  });
  wizardNextEntry();
}

function wizardLinkToExisting() {
  // Show matches box if hidden
  const matchesBox = document.getElementById('wizard-matches-box');
  matchesBox.scrollIntoView({ behavior: 'smooth' });
}

function wizardUpdateExisting() {
  const existingId = _wizardFindExistingMatch(_wizardEntries[_wizardCurrentIdx]);
  if (!existingId) {
    alert('Keine passende bestehende Person gefunden.');
    return;
  }

  _wizardDecisions.set(_wizardCurrentIdx, {
    action: 'update',
    targetId: existingId,
    entry: wizardCollectFieldData()
  });
  wizardNextEntry();
}

function wizardSkipEntry() {
  _wizardDecisions.set(_wizardCurrentIdx, { action: 'skip' });
  wizardNextEntry();
}

function wizardPrevEntry() {
  if (_wizardCurrentIdx > 0) {
    wizardShowEntry(_wizardCurrentIdx - 1);
  }
}

function wizardNextEntry() {
  if (_wizardCurrentIdx < _wizardEntries.length - 1) {
    wizardShowEntry(_wizardCurrentIdx + 1);
  } else {
    // Show summary
    wizardShowSummary();
  }
}

function wizardShowSummary() {
  document.getElementById('wizard-step-review').style.display = 'none';
  document.getElementById('wizard-step-summary').style.display = '';
  document.getElementById('wizard-progress-fill').style.width = '100%';
  document.getElementById('wizard-progress-text').textContent = 'Schritt 3/3: Zusammenfassung';

  // Calculate stats
  let addCount = 0, linkCount = 0, updateCount = 0, skipCount = 0, pendingCount = 0;
  const pendingItems = [];

  _wizardEntries.forEach((entry, idx) => {
    const decision = _wizardDecisions.get(idx);
    if (!decision) {
      pendingCount++;
      pendingItems.push({ status: 'pending', name: entry.fullName });
    } else if (decision.action === 'add') addCount++;
    else if (decision.action === 'link') linkCount++;
    else if (decision.action === 'update') updateCount++;
    else if (decision.action === 'skip') skipCount++;
    else if (decision.action === 'merge') linkCount++;

    if (decision && decision.action !== 'pending') {
      pendingItems.push({
        status: decision.action,
        name: decision.entry?.fullName || entry.fullName
      });
    }
  });

  // Render stats
  const statsHtml = `
    <div class="wizard-stat-card">
      <div class="wizard-stat-number" style="color:#7de0a0">${addCount}</div>
      <div class="wizard-stat-label">Neu hinzufügen</div>
    </div>
    <div class="wizard-stat-card">
      <div class="wizard-stat-number" style="color:#a0d0f0">${linkCount}</div>
      <div class="wizard-stat-label">Verknüpfen</div>
    </div>
    <div class="wizard-stat-card">
      <div class="wizard-stat-number" style="color:#e0e080">${updateCount}</div>
      <div class="wizard-stat-label">Aktualisieren</div>
    </div>
    <div class="wizard-stat-card">
      <div class="wizard-stat-number" style="color:#e0a0a0">${skipCount}</div>
      <div class="wizard-stat-label">Übersprungen</div>
    </div>
    <div class="wizard-stat-card">
      <div class="wizard-stat-number" style="color:#789">${pendingCount}</div>
      <div class="wizard-stat-label">Ausstehend</div>
    </div>
  `;
  document.getElementById('wizard-stats').innerHTML = statsHtml;

  // Render pending list
  const pendingHtml = pendingItems.map(item => `
    <div class="wizard-pending-item">
      <span class="wizard-pending-status ${item.status}">${item.status}</span>
      <span class="wizard-pending-name">${escHtml(item.name || 'Unnamed')}</span>
    </div>
  `).join('');
  document.getElementById('wizard-pending-list').innerHTML = pendingHtml || '<div style="color:#567;font-size:12px;padding:8px;">Keine Einträge</div>';
}

function wizardBackToReview() {
  document.getElementById('wizard-step-summary').style.display = 'none';
  document.getElementById('wizard-step-review').style.display = '';
  document.getElementById('wizard-progress-fill').style.width = '66%';
  document.getElementById('wizard-progress-text').textContent = 'Schritt 2/3: Einträge prüfen';
}

function wizardApplyAll() {
  const toApply = [];

  // Convert wizard decisions to import actions
  for (const [idx, decision] of _wizardDecisions) {
    if (decision.action === 'skip') continue;

    const entry = decision.entry || _wizardEntries[idx];

    if (decision.action === 'add') {
      toApply.push({
        kind: 'person',
        status: 'approved',
        fields: {
          'Name': entry.fullName,
          'Sex': entry.sex,
          'Birth Date': entry.birthDate,
          'Birth Place': entry.birthPlace,
          'Death Date': entry.deathDate,
          'Death Place': entry.deathPlace,
          'Father': entry.fatherName,
          'Mother': entry.motherName,
          'Notes': entry.notes
        },
        _person: entry
      });
    } else if (decision.action === 'update') {
      toApply.push({
        kind: 'update',
        status: 'approved',
        existingId: decision.targetId,
        fields: {
          'Name': entry.fullName,
          'Birth Date': entry.birthDate,
          'Birth Place': entry.birthPlace,
          'Death Date': entry.deathDate,
          'Death Place': entry.deathPlace,
          'Sex': entry.sex,
          'Notes': entry.notes
        }
      });
    }
  }

  if (toApply.length === 0) {
    alert('Keine Änderungen zum Anwenden.');
    return;
  }

  // Apply using existing import logic
  const report = _tiApplyWizardActions(toApply);
  _fullRebuildGraph();
  closeWizard();

  const nAdd = report.filter(r => r.type === 'add').length;
  const nUpd = report.filter(r => r.type === 'update').length;
  const nFam = report.filter(r => r.type === 'fam').length;
  alert(`Import abgeschlossen:\n• ${nAdd} Person(en) hinzugefügt\n• ${nUpd} Person(en) aktualisiert\n• ${nFam} Familie(n) erstellt`);
}

function _tiApplyWizardActions(actions) {
  // Similar to _tiApplyActions but for wizard
  let maxIndi = 0, maxFam = 0;
  for (const [id] of individuals) { const m = id.match(/\d+/); if (m) maxIndi = Math.max(maxIndi,+m[0]); }
  for (const [id] of families)    { const m = id.match(/\d+/); if (m) maxFam  = Math.max(maxFam, +m[0]); }

  const nameToId = new Map();
  for (const [id, indi] of individuals) nameToId.set(_tiNormName(indi.name||''), id);

  const report = [];

  // Apply updates
  for (const action of actions) {
    if (action.kind !== 'update') continue;
    const indi = individuals.get(action.existingId);
    if (!indi) continue;

    if (action.fields['Birth Date']) indi.birth.date = action.fields['Birth Date'];
    if (action.fields['Birth Place']) indi.birth.plac = action.fields['Birth Place'];
    if (action.fields['Death Date']) { indi.death.date = action.fields['Death Date']; indi.deceased = true; }
    if (action.fields['Death Place']) indi.death.plac = action.fields['Death Place'];
    if (action.fields['Sex'] && (!indi.sex || indi.sex === 'U')) indi.sex = action.fields['Sex'];
    if (action.fields['Notes']) indi.note = indi.note ? indi.note + '; ' + action.fields['Notes'] : action.fields['Notes'];

    report.push({ type: 'update', msg: `${indi.name} updated` });
  }

  // Add new persons
  for (const action of actions) {
    if (action.kind !== 'person') continue;

    const name = action.fields['Name'];
    const nn = _tiNormName(name);

    if (nameToId.has(nn)) {
      report.push({ type: 'skip', msg: `${name} already exists` });
      continue;
    }

    const xref = `@I${++maxIndi}@`;
    nameToId.set(nn, xref);

    individuals.set(xref, {
      id: xref,
      name: name,
      sex: action.fields['Sex'] || 'U',
      birth: { date: action.fields['Birth Date'] || '', plac: action.fields['Birth Place'] || '' },
      death: { date: action.fields['Death Date'] || '', plac: action.fields['Death Place'] || '', caus: '' },
      deceased: !!action.fields['Death Date'],
      occu: '',
      note: action.fields['Notes'] || '',
      fams: [],
      famc: ''
    });

    report.push({ type: 'add', msg: `${name} → ${xref}` });
  }

  return report;
}

function wizardAddMarriage() {
  const container = document.getElementById('wizard-marriages-list');
  const idx = container.children.length;

  const row = document.createElement('div');
  row.className = 'wizard-marriage-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="wizard-marriage-spouse-section">
      <input type="text" placeholder="Ehepartner suchen..." class="wiz-marr-spouse"
             oninput="wizardSearchSpouseForMarriage(${idx}, this.value)"
             onfocus="wizardShowSpouseSearch(${idx})">
      <div id="wiz-marr-search-${idx}" class="wizard-marriage-spouse-search" style="display:none"></div>
      <input type="hidden" class="wiz-marr-spouse-id" value="">
    </div>
    <div class="wizard-marriage-dates">
      <input type="text" placeholder="Hochzeitsdatum" class="wiz-marr-date">
      <input type="text" placeholder="Hochzeitsort" class="wiz-marr-place">
    </div>
    <button onclick="wizardRemoveMarriage(${idx})" title="Ehe entfernen">&#x2715;</button>
  `;

  if (container.children[0]?.textContent?.includes('Keine Ehen')) {
    container.innerHTML = '';
  }
  container.appendChild(row);

  // Show spouse search immediately
  wizardShowSpouseSearch(idx);
}

function wizardRemoveMarriage(idx) {
  const row = document.querySelector(`.wizard-marriage-row[data-idx="${idx}"]`);
  if (row) row.remove();
}

function _wizardUpdateButtonStates(decision) {
  // Visual feedback for button states could be added here
  // For now, the decision is stored and applied on next/prev
}

function wizardHideAutoSkipNotice() {
  document.getElementById('wizard-auto-skip-notice').style.display = 'none';
}

function wizardShowAutoLinkDetails() {
  const decision = _wizardDecisions.get(_wizardCurrentIdx);
  if (!decision?.autoLinked || !decision?.targetId) return;

  const indi = individuals.get(decision.targetId);
  if (indi) {
    alert(`Auto-Verknüpfungsdetails:\n\nName: ${indi.name}\nID: ${decision.targetId}\nGeburt: ${indi.birth?.date || 'unbekannt'} ${indi.birth?.plac || ''}\nGeschlecht: ${indi.sex || 'U'}\n\nDiese Person wurde basierend auf hoher Übereinstimmung automatisch verknüpft.`);
  }
}

function wizardBreakAutoLink() {
  const decision = _wizardDecisions.get(_wizardCurrentIdx);
  if (!decision?.autoLinked) return;

  // Remove the auto-link and show entry for manual review
  _wizardDecisions.delete(_wizardCurrentIdx);
  document.getElementById('wizard-auto-link-notice').style.display = 'none';

  // Re-render to show as new entry
  _wizardRenderEntry(_wizardCurrentIdx);

  alert('Auto-Verknüpfung aufgehoben. Sie können nun manuell entscheiden.');
}

// Spouse search for marriages
let _wizardActiveSpouseSearchIdx = null;

function wizardShowSpouseSearch(idx) {
  _wizardActiveSpouseSearchIdx = idx;
  const searchEl = document.getElementById(`wiz-marr-search-${idx}`);
  if (searchEl) {
    searchEl.style.display = 'block';
    // Populate with top matches initially
    wizardSearchSpouseForMarriage(idx, '');
  }
}

function wizardHideSpouseSearch(idx) {
  const searchEl = document.getElementById(`wiz-marr-search-${idx}`);
  if (searchEl) {
    searchEl.style.display = 'none';
  }
  if (_wizardActiveSpouseSearchIdx === idx) {
    _wizardActiveSpouseSearchIdx = null;
  }
}

function wizardSearchSpouseForMarriage(idx, query) {
  const searchEl = document.getElementById(`wiz-marr-search-${idx}`);
  if (!searchEl) return;

  query = query.toLowerCase().trim();

  // Search in existing individuals and import entries
  const candidates = [];

  // Search GEDCOM
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    const birth = (indi.birth?.date || '').toLowerCase();
    if (!query || name.includes(query) || birth.includes(query)) {
      let score = 0;
      if (query && name.includes(query)) score += 50;
      if (query && birth.includes(query)) score += 30;
      candidates.push({
        type: 'gedcom',
        id: id,
        name: indi.name,
        birth: indi.birth?.date || '',
        sex: indi.sex || 'U',
        score: score || 10
      });
    }
  }

  // Search import entries
  _wizardEntries.forEach((entry, eIdx) => {
    if (eIdx === _wizardCurrentIdx) return; // Skip self
    const name = (entry.fullName || '').toLowerCase();
    const birth = (entry.birthDate || '').toLowerCase();
    if (!query || name.includes(query) || birth.includes(query)) {
      let score = 0;
      if (query && name.includes(query)) score += 40;
      if (query && birth.includes(query)) score += 30;
      candidates.push({
        type: 'import',
        idx: eIdx,
        name: entry.fullName,
        birth: entry.birthDate || '',
        sex: entry.sex || 'U',
        score: score || 5
      });
    }
  });

  // Sort by score and take top 5
  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, 5);

  if (topCandidates.length === 0) {
    searchEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    searchEl.innerHTML = topCandidates.map(c => `
      <div class="wizard-spouse-search-item" onclick="wizardSelectSpouseForMarriage(${idx}, '${c.type}', '${c.type === 'gedcom' ? c.id : c.idx}', '${escHtml(c.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(c.name)}</span>
        <span class="details">${c.birth ? escHtml(c.birth) : ''} [${c.sex}]</span>
        <span class="score">${c.type === 'gedcom' ? 'GEDCOM' : 'IMPORT'}</span>
      </div>
    `).join('');
  }

  searchEl.style.display = 'block';
}

function wizardSelectSpouseForMarriage(marriageIdx, type, targetId, name) {
  const row = document.querySelector(`.wizard-marriage-row[data-idx="${marriageIdx}"]`);
  if (!row) return;

  // Update the spouse input
  const spouseInput = row.querySelector('.wiz-marr-spouse');
  const spouseIdInput = row.querySelector('.wiz-marr-spouse-id');
  if (spouseInput) spouseInput.value = name;
  if (spouseIdInput) spouseIdInput.value = type === 'gedcom' ? targetId : '';

  // Mark as linked
  const spouseSection = row.querySelector('.wizard-marriage-spouse-section');
  let linkedBadge = spouseSection.querySelector('.wizard-marriage-spouse-linked');
  if (!linkedBadge) {
    linkedBadge = document.createElement('span');
    linkedBadge.className = 'wizard-marriage-spouse-linked';
    linkedBadge.innerHTML = '&#x1F517; Verknüpft';
    spouseSection.appendChild(linkedBadge);
  }

  // Hide search
  wizardHideSpouseSearch(marriageIdx);
}

function wizardSearchPersons() {
  const query = document.getElementById('wizard-search-input').value.toLowerCase().trim();
  if (!query) {
    wizardCloseSearch();
    return;
  }

  const results = [];

  // Search in existing GEDCOM individuals
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    const birth = (indi.birth?.date || '').toLowerCase();
    const place = (indi.birth?.plac || '').toLowerCase();

    if (name.includes(query) || birth.includes(query) || place.includes(query)) {
      results.push({
        type: 'gedcom',
        id: id,
        name: indi.name,
        birth: indi.birth?.date || '',
        death: indi.death?.date || '',
        sex: indi.sex || 'U'
      });
    }
  }

  // Search in wizard import entries
  _wizardEntries.forEach((entry, idx) => {
    const name = (entry.fullName || '').toLowerCase();
    const birth = (entry.birthDate || '').toLowerCase();
    const place = (entry.birthPlace || '').toLowerCase();

    if (name.includes(query) || birth.includes(query) || place.includes(query)) {
      results.push({
        type: 'import',
        idx: idx,
        name: entry.fullName,
        birth: entry.birthDate || '',
        death: entry.deathDate || '',
        sex: entry.sex || 'U',
        current: idx === _wizardCurrentIdx
      });
    }
  });

  // Render results
  const resultsEl = document.getElementById('wizard-search-results');
  const contentEl = document.getElementById('wizard-search-results-content');

  if (results.length === 0) {
    contentEl.innerHTML = '<div style="color:#567;font-size:13px;text-align:center;padding:20px;">Keine Treffer gefunden</div>';
  } else {
    contentEl.innerHTML = results.slice(0, 10).map(r => `
      <div class="wizard-search-result-item" onclick="wizardGotoSearchResult('${r.type}', '${r.type === 'gedcom' ? r.id : r.idx}')">
        <span class="wizard-search-result-type ${r.type}">${r.type === 'gedcom' ? 'GEDCOM' : 'IMPORT'}</span>
        <div class="wizard-search-result-info">
          <div class="wizard-search-result-name">${escHtml(r.name)} ${r.current ? '<span style="color:#4caf7d;">(aktuell)</span>' : ''}</div>
          <div class="wizard-search-result-details">${r.birth ? `geb. ${escHtml(r.birth)}` : ''} ${r.death ? `- gest. ${escHtml(r.death)}` : ''} [${r.sex}]</div>
        </div>
        <div class="wizard-search-result-actions">
          <button class="btn-goto" onclick="event.stopPropagation();wizardGotoSearchResult('${r.type}', '${r.type === 'gedcom' ? r.id : r.idx}')">Gehe zu</button>
          ${r.type === 'gedcom' ? `<button class="btn-link" onclick="event.stopPropagation();wizardLinkToSearchResult('${r.id}')">Verknüpfen</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  resultsEl.style.display = 'block';
}

function wizardCloseSearch() {
  document.getElementById('wizard-search-results').style.display = 'none';
  document.getElementById('wizard-search-input').value = '';
}

function wizardGotoSearchResult(type, target) {
  if (type === 'import') {
    const idx = parseInt(target);
    wizardCloseSearch();
    wizardShowEntry(idx);
  } else {
    // For GEDCOM entries, we could highlight them in the main view
    // For now, just show a message
    const indi = individuals.get(target);
    if (indi) {
      alert(`GEDCOM Person: ${indi.name}\nGeburt: ${indi.birth?.date || 'unbekannt'}\nID: ${target}`);
    }
  }
}

function wizardLinkToSearchResult(existingId) {
  const indi = individuals.get(existingId);
  if (!indi) return;

  // Mark current entry as linked to this existing person
  _wizardDecisions.set(_wizardCurrentIdx, {
    action: 'link',
    targetId: existingId,
    entry: wizardCollectFieldData()
  });

  wizardCloseSearch();
  wizardNextEntry();
}

window.openWizard              = openWizard;
window.closeWizard             = closeWizard;
window.handleWizardFileSelect  = handleWizardFileSelect;
window.wizardParseText         = wizardParseText;
window.wizardShowEntry         = wizardShowEntry;
window._wizardRenderEntry      = _wizardRenderEntry;
window.wizardPrevEntry         = wizardPrevEntry;
window.wizardNextEntry         = wizardNextEntry;
window.wizardApproveEntry      = wizardApproveEntry;
window.wizardLinkToExisting    = wizardLinkToExisting;
window.wizardUpdateExisting    = wizardUpdateExisting;
window.wizardSkipEntry         = wizardSkipEntry;
window.wizardSelectMatch       = wizardSelectMatch;
window.wizardAddMarriage       = wizardAddMarriage;
window.wizardRemoveMarriage    = wizardRemoveMarriage;
window.wizardShowSummary       = wizardShowSummary;
window.wizardBackToReview      = wizardBackToReview;
window.wizardApplyAll          = wizardApplyAll;
window.wizardHideAutoSkipNotice = wizardHideAutoSkipNotice;
window.wizardShowAutoLinkDetails = wizardShowAutoLinkDetails;
window.wizardBreakAutoLink     = wizardBreakAutoLink;
window.wizardSearchPersons     = wizardSearchPersons;
window.wizardCloseSearch       = wizardCloseSearch;
window.wizardGotoSearchResult  = wizardGotoSearchResult;
window.wizardLinkToSearchResult = wizardLinkToSearchResult;
window.wizardShowSpouseSearch  = wizardShowSpouseSearch;
window.wizardHideSpouseSearch  = wizardHideSpouseSearch;
window.wizardSearchSpouseForMarriage = wizardSearchSpouseForMarriage;
window.wizardSelectSpouseForMarriage = wizardSelectSpouseForMarriage;

// ═══════════════════════════════════════════════════════════════
// QUICK ENTRY FUNCTIONS - Fast Manual Data Entry
// ═══════════════════════════════════════════════════════════════

let _qeRecentPersons = []; // Recently edited persons
let _qeCurrentTab = 'new';
let _qeSpouseCount = 0;
let _qeChildCount = 0;
let _qeLinkMode = 'spouse'; // 'spouse' or 'parent'

function openQuickEntry() {
  document.getElementById('quick-entry-modal').style.display = 'flex';
  _qeResetForm();
  _qeUpdateRecentList();
  document.getElementById('qe-name').focus();
}

function closeQuickEntry() {
  document.getElementById('quick-entry-modal').style.display = 'none';
  // Hide all dropdowns
  document.querySelectorAll('.quick-dropdown').forEach(el => el.style.display = 'none');
}

function switchQuickTab(tab) {
  _qeCurrentTab = tab;
  // Update tab buttons
  document.querySelectorAll('.quick-tab').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.quick-tab[onclick="switchQuickTab('${tab}')"]`).classList.add('active');
  // Show/hide content
  document.querySelectorAll('.quick-tab-content').forEach(content => content.style.display = 'none');
  document.getElementById(`quick-tab-${tab}`).style.display = 'flex';
}

function _qeResetForm() {
  // Reset all fields
  document.getElementById('qe-name').value = '';
  document.getElementById('qe-sex').value = '';
  document.getElementById('qe-birth-date').value = '';
  document.getElementById('qe-birth-place').value = '';
  document.getElementById('qe-death-date').value = '';
  document.getElementById('qe-death-place').value = '';
  document.getElementById('qe-father').value = '';
  document.getElementById('qe-father-id').value = '';
  document.getElementById('qe-mother').value = '';
  document.getElementById('qe-mother-id').value = '';
  document.getElementById('qe-notes').value = '';

  // Reset lists
  document.getElementById('qe-spouses-list').innerHTML = '';
  document.getElementById('qe-children-list').innerHTML = '';
  _qeSpouseCount = 0;
  _qeChildCount = 0;

  // Reset link tab
  document.getElementById('qe-link-person1').value = '';
  document.getElementById('qe-link-person1-id').value = '';
  document.getElementById('qe-link-person2').value = '';
  document.getElementById('qe-link-person2-id').value = '';

  switchQuickTab('new');
}

function quickClearForm() {
  _qeResetForm();
  document.getElementById('qe-name').focus();
}

// Search for parents
function quickSearchParent(type, query) {
  const searchEl = document.getElementById(`qe-${type}-search`);
  if (!searchEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    searchEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    const birth = (indi.birth?.date || '').toLowerCase();
    if (name.includes(query) || birth.includes(query)) {
      // Filter by sex for parents
      if (type === 'father' && indi.sex !== 'M') continue;
      if (type === 'mother' && indi.sex !== 'F') continue;
      results.push({ id, name: indi.name, birth: indi.birth?.date || '', sex: indi.sex });
    }
  }

  if (results.length === 0) {
    searchEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    searchEl.innerHTML = results.slice(0, 5).map(r => `
      <div class="quick-search-item" onclick="quickSelectParent('${type}', '${r.id}', '${escHtml(r.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''} [${r.sex}]</span>
      </div>
    `).join('');
  }
  searchEl.style.display = 'block';
}

function quickShowParentSearch(type) {
  const searchEl = document.getElementById(`qe-${type}-search`);
  if (searchEl) {
    quickSearchParent(type, document.getElementById(`qe-${type}`).value);
  }
}

function quickSelectParent(type, id, name) {
  document.getElementById(`qe-${type}`).value = name;
  document.getElementById(`qe-${type}-id`).value = id;
  document.getElementById(`qe-${type}-search`).style.display = 'none';
}

function quickCreateParent(type) {
  // Show inline form for creating parent
  const container = document.getElementById(`qe-${type}-search`);
  if (!container) return;

  container.innerHTML = `
    <div class="quick-new-person-inline" data-type="${type}">
      <div class="quick-field-row" style="padding:8px;">
        <input type="text" class="quick-input qe-parent-new-name" placeholder="Vorname Nachname *" style="flex:1">
        <input type="text" class="quick-input qe-parent-new-birth" placeholder="Geburtsdatum" style="width:100px">
        <input type="text" class="quick-input qe-parent-new-death" placeholder="Sterbedatum" style="width:100px">
        <button class="quick-btn-small" onclick="quickSaveNewParent('${type}')">&#x2713;</button>
        <button class="quick-btn-small" onclick="document.getElementById('qe-${type}-search').style.display='none'">&#x2715;</button>
      </div>
    </div>
  `;
  container.style.display = 'block';

  // Focus name field
  setTimeout(() => container.querySelector('.qe-parent-new-name')?.focus(), 10);
}

function quickSaveNewParent(type) {
  const container = document.getElementById(`qe-${type}-search`);
  const name = container.querySelector('.qe-parent-new-name')?.value?.trim();
  if (!name) {
    alert('Bitte einen Namen eingeben');
    return;
  }

  const sex = type === 'father' ? 'M' : 'F';
  const birthDate = container.querySelector('.qe-parent-new-birth')?.value || '';
  const deathDate = container.querySelector('.qe-parent-new-death')?.value || '';

  const newId = _qeCreateNewPerson({
    fullName: name,
    sex,
    birthDate,
    deathDate
  });

  // Link as parent
  document.getElementById(`qe-${type}`).value = name;
  document.getElementById(`qe-${type}-id`).value = newId;
  container.style.display = 'none';

  // Add to recent
  _qeAddToRecent({ id: newId, name, birth: birthDate });
}

// Spouses
function quickAddSpouse() {
  const container = document.getElementById('qe-spouses-list');
  const idx = _qeSpouseCount++;

  const row = document.createElement('div');
  row.className = 'quick-spouse-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" placeholder="Ehepartner suchen..." class="quick-input"
             oninput="quickSearchSpouse(${idx}, this.value)"
             onfocus="quickShowSpouseSearch(${idx})">
      <div id="qe-spouse-search-${idx}" class="quick-dropdown" style="display:none"></div>
      <input type="hidden" class="qe-spouse-id">
    </div>
    <input type="text" placeholder="Hochzeitsdatum" class="quick-input" style="width:120px">
    <input type="text" placeholder="Ort" class="quick-input" style="width:100px">
    <button class="quick-btn-small" onclick="quickRemoveSpouse(${idx})">&#x2715;</button>
  `;
  container.appendChild(row);
}

function quickSearchSpouse(idx, query) {
  const searchEl = document.getElementById(`qe-spouse-search-${idx}`);
  if (!searchEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    searchEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    if (name.includes(query)) {
      results.push({ id, name: indi.name, birth: indi.birth?.date || '' });
    }
  }

  if (results.length === 0) {
    searchEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer - Klicken um neu zu erstellen</div>';
  } else {
    searchEl.innerHTML = results.slice(0, 5).map(r => `
      <div class="quick-search-item" onclick="quickSelectSpouse(${idx}, '${r.id}', '${escHtml(r.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''}</span>
      </div>
    `).join('');
  }
  searchEl.style.display = 'block';
}

function quickShowSpouseSearch(idx) {
  const searchEl = document.getElementById(`qe-spouse-search-${idx}`);
  if (searchEl) searchEl.style.display = 'block';
}

function quickSelectSpouse(idx, id, name) {
  const row = document.querySelector(`.quick-spouse-row[data-idx="${idx}"]`);
  if (row) {
    row.querySelector('input[type="text"]').value = name;
    row.querySelector('.qe-spouse-id').value = id;
  }
  document.getElementById(`qe-spouse-search-${idx}`).style.display = 'none';
}

function quickRemoveSpouse(idx) {
  const row = document.querySelector(`.quick-spouse-row[data-idx="${idx}"]`);
  if (row) row.remove();
}

function quickCreateNewSpouse() {
  // Add to spouses list with inline edit form
  const container = document.getElementById('qe-spouses-list');
  const idx = _qeSpouseCount++;

  const row = document.createElement('div');
  row.className = 'quick-spouse-row quick-new-person-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-new-person-form" data-type="spouse" data-idx="${idx}">
      <div class="quick-new-person-header">Neuen Ehepartner erstellen:</div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-name" placeholder="Vorname Nachname *" style="flex:2">
        <select class="quick-select qe-new-sex" style="width:70px">
          <option value="">Sex</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-birth-date" placeholder="Geburtsdatum">
        <input type="text" class="quick-input qe-new-birth-place" placeholder="Geburtsort">
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-death-date" placeholder="Sterbedatum">
        <input type="text" class="quick-input qe-new-death-place" placeholder="Sterbeort">
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input" placeholder="Hochzeitsdatum" style="width:120px">
        <input type="text" class="quick-input" placeholder="Hochzeitsort" style="width:120px">
        <button class="quick-btn-small qe-btn-save" onclick="quickSaveNewPersonFromRow(${idx}, 'spouse')">&#x2713;</button>
        <button class="quick-btn-small" onclick="quickRemoveSpouse(${idx})">&#x2715;</button>
      </div>
    </div>
  `;
  container.appendChild(row);

  // Focus name field
  row.querySelector('.qe-new-name').focus();
}

// Children
function quickAddChild() {
  const container = document.getElementById('qe-children-list');
  const idx = _qeChildCount++;

  const row = document.createElement('div');
  row.className = 'quick-child-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" placeholder="Kind suchen..." class="quick-input"
             oninput="quickSearchChild(${idx}, this.value)"
             onfocus="quickShowChildSearch(${idx})">
      <div id="qe-child-search-${idx}" class="quick-dropdown" style="display:none"></div>
      <input type="hidden" class="qe-child-id">
    </div>
    <button class="quick-btn-small" onclick="quickRemoveChild(${idx})">&#x2715;</button>
  `;
  container.appendChild(row);
}

function quickSearchChild(idx, query) {
  const searchEl = document.getElementById(`qe-child-search-${idx}`);
  if (!searchEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    searchEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    if (name.includes(query)) {
      results.push({ id, name: indi.name, birth: indi.birth?.date || '' });
    }
  }

  if (results.length === 0) {
    searchEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    searchEl.innerHTML = results.slice(0, 5).map(r => `
      <div class="quick-search-item" onclick="quickSelectChild(${idx}, '${r.id}', '${escHtml(r.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''}</span>
      </div>
    `).join('');
  }
  searchEl.style.display = 'block';
}

function quickShowChildSearch(idx) {
  const searchEl = document.getElementById(`qe-child-search-${idx}`);
  if (searchEl) searchEl.style.display = 'block';
}

function quickSelectChild(idx, id, name) {
  const row = document.querySelector(`.quick-child-row[data-idx="${idx}"]`);
  if (row) {
    row.querySelector('input[type="text"]').value = name;
    row.querySelector('.qe-child-id').value = id;
  }
  document.getElementById(`qe-child-search-${idx}`).style.display = 'none';
}

function quickRemoveChild(idx) {
  const row = document.querySelector(`.quick-child-row[data-idx="${idx}"]`);
  if (row) row.remove();
}

function quickSaveNewPersonFromRow(idx, type) {
  const row = document.querySelector(`.quick-new-person-row[data-idx="${idx}"]`);
  if (!row) return;

  const form = row.querySelector('.quick-new-person-form');
  const name = form.querySelector('.qe-new-name')?.value?.trim();
  if (!name) {
    alert('Bitte einen Namen eingeben');
    return;
  }

  const sex = form.querySelector('.qe-new-sex')?.value || 'U';
  const birthDate = form.querySelector('.qe-new-birth-date')?.value || '';
  const birthPlace = form.querySelector('.qe-new-birth-place')?.value || '';
  const deathDate = form.querySelector('.qe-new-death-date')?.value || '';
  const deathPlace = form.querySelector('.qe-new-death-place')?.value || '';

  const newId = _qeCreateNewPerson({
    fullName: name,
    sex,
    birthDate,
    birthPlace,
    deathDate,
    deathPlace
  });

  // Convert form to display mode with ID stored
  if (type === 'spouse') {
    const marriageDate = form.querySelector('input[placeholder="Hochzeitsdatum"]')?.value || '';
    const marriagePlace = form.querySelector('input[placeholder="Hochzeitsort"]')?.value || '';

    row.innerHTML = `
      <div class="quick-search-wrap">
        <input type="text" class="quick-input" value="${escHtml(name)}" readonly>
        <input type="hidden" class="qe-spouse-id" value="${newId}">
      </div>
      <input type="text" placeholder="Hochzeitsdatum" class="quick-input" value="${escHtml(marriageDate)}" style="width:120px">
      <input type="text" placeholder="Hochzeitsort" class="quick-input" value="${escHtml(marriagePlace)}" style="width:100px">
      <button class="quick-btn-small" onclick="quickRemoveSpouse(${idx})">&#x2715;</button>
    `;
  } else if (type === 'child') {
    row.innerHTML = `
      <div class="quick-search-wrap">
        <input type="text" class="quick-input" value="${escHtml(name)}" readonly>
        <input type="hidden" class="qe-child-id" value="${newId}">
      </div>
      <button class="quick-btn-small" onclick="quickRemoveChild(${idx})">&#x2715;</button>
    `;
  }

  // Add to recent
  _qeAddToRecent({ id: newId, name, birth: birthDate });
}

function quickCreateNewChild() {
  // Add to children list with inline edit form
  const container = document.getElementById('qe-children-list');
  const idx = _qeChildCount++;

  const row = document.createElement('div');
  row.className = 'quick-child-row quick-new-person-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-new-person-form" data-type="child" data-idx="${idx}">
      <div class="quick-new-person-header">Neues Kind erstellen:</div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-name" placeholder="Vorname Nachname *" style="flex:2">
        <select class="quick-select qe-new-sex" style="width:70px">
          <option value="">Sex</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
        <button class="quick-btn-small qe-btn-save" onclick="quickSaveNewPersonFromRow(${idx}, 'child')">&#x2713;</button>
        <button class="quick-btn-small" onclick="quickRemoveChild(${idx})">&#x2715;</button>
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-birth-date" placeholder="Geburtsdatum">
        <input type="text" class="quick-input qe-new-birth-place" placeholder="Geburtsort">
        <input type="text" class="quick-input qe-new-death-date" placeholder="Sterbedatum">
      </div>
    </div>
  `;
  container.appendChild(row);

  // Focus name field
  row.querySelector('.qe-new-name').focus();
}

// Save functions
function quickSavePerson() {
  const person = _qeCollectFormData();
  if (!person.fullName) {
    alert('Bitte einen Namen eingeben');
    return;
  }

  const newId = _qeCreateNewPerson(person);
  _qeAddToRecent({ id: newId, name: person.fullName, birth: person.birthDate });

  alert(`Gespeichert: ${person.fullName}`);
  _qeResetForm();
  document.getElementById('qe-name').focus();
}

function quickSaveAndNext() {
  quickSavePerson();
}

function _qeCollectFormData() {
  const spouses = [];
  document.querySelectorAll('.quick-spouse-row').forEach(row => {
    const inputs = row.querySelectorAll('input[type="text"]');
    spouses.push({
      spouseName: inputs[0]?.value || '',
      spouseId: row.querySelector('.qe-spouse-id')?.value || '',
      date: inputs[1]?.value || '',
      place: inputs[2]?.value || ''
    });
  });

  const children = [];
  document.querySelectorAll('.quick-child-row').forEach(row => {
    children.push({
      childName: row.querySelector('input[type="text"]')?.value || '',
      childId: row.querySelector('.qe-child-id')?.value || ''
    });
  });

  return {
    fullName: document.getElementById('qe-name').value,
    sex: document.getElementById('qe-sex').value,
    birthDate: document.getElementById('qe-birth-date').value,
    birthPlace: document.getElementById('qe-birth-place').value,
    deathDate: document.getElementById('qe-death-date').value,
    deathPlace: document.getElementById('qe-death-place').value,
    fatherName: document.getElementById('qe-father').value,
    fatherId: document.getElementById('qe-father-id').value,
    motherName: document.getElementById('qe-mother').value,
    motherId: document.getElementById('qe-mother-id').value,
    notes: document.getElementById('qe-notes').value,
    spouses,
    children,
    deceased: document.getElementById('qe-deceased')?.checked || false,
    divorced: document.getElementById('qe-divorced')?.checked || false,
    adopted: document.getElementById('qe-adopted')?.checked || false
  };
}

function _qeCreateNewPerson(person) {
  // Get next ID
  let maxIndi = 0;
  for (const [id] of individuals) {
    const m = id.match(/\d+/);
    if (m) maxIndi = Math.max(maxIndi, +m[0]);
  }
  const xref = `@I${++maxIndi}@`;

  // Create person
  const note = person.notes || '';
  const statusNote = [];
  if (person.divorced) statusNote.push('Geschieden');
  if (person.adopted) statusNote.push('Adoptiert');
  const fullNote = note + (statusNote.length ? (note ? '; ' : '') + statusNote.join(', ') : '');

  individuals.set(xref, {
    id: xref,
    name: person.fullName,
    sex: person.sex || 'U',
    birth: { date: person.birthDate || '', plac: person.birthPlace || '' },
    death: { date: person.deathDate || '', plac: person.deathPlace || '', caus: '' },
    deceased: !!person.deathDate || person.deceased,
    occu: '',
    note: fullNote,
    fams: [],
    famc: ''
  });

  // Handle family creation with spouse
  if (person.spouses && person.spouses.length > 0) {
    person.spouses.forEach(s => {
      if (s.spouseId) {
        _qeCreateFamily(xref, s.spouseId, s.date, s.place);
      }
    });
  }

  // Handle parent link
  if (person.fatherId || person.motherId) {
    _qeLinkToParents(xref, person.fatherId, person.motherId);
  }

  _fullRebuildGraph();
  return xref;
}

function _qeCreateFamily(husbId, wifeId, date, place) {
  let maxFam = 0;
  for (const [id] of families) {
    const m = id.match(/\d+/);
    if (m) maxFam = Math.max(maxFam, +m[0]);
  }
  const famXref = `@F${++maxFam}@`;

  families.set(famXref, {
    id: famXref,
    husb: husbId,
    wife: wifeId,
    marriages: [{ date: date || '', plac: place || '', types: [] }], div: false, divDate: '',
    children: []
  });

  // Update individuals
  const husb = individuals.get(husbId);
  const wife = individuals.get(wifeId);
  if (husb && !husb.fams.includes(famXref)) husb.fams.push(famXref);
  if (wife && !wife.fams.includes(famXref)) wife.fams.push(famXref);

  return famXref;
}

function _qeLinkToParents(childId, fatherId, motherId) {
  // Find or create family
  let fam = null;
  for (const [id, f] of families) {
    if ((fatherId && f.husb === fatherId) || (motherId && f.wife === motherId)) {
      fam = id;
      break;
    }
  }

  if (!fam && (fatherId || motherId)) {
    fam = _qeCreateFamily(fatherId || '', motherId || '', '', '');
  }

  if (fam) {
    const family = families.get(fam);
    if (!family.children.includes(childId)) {
      family.children.push(childId);
    }
    const child = individuals.get(childId);
    if (child) child.famc = fam;
  }
}

// Recent persons
function _qeAddToRecent(person) {
  // Remove if already exists
  _qeRecentPersons = _qeRecentPersons.filter(p => p.id !== person.id);
  // Add to front
  _qeRecentPersons.unshift(person);
  // Keep only 10
  if (_qeRecentPersons.length > 10) _qeRecentPersons.pop();
  _qeUpdateRecentList();
}

function _qeUpdateRecentList() {
  const listEl = document.getElementById('quick-recent-list');
  if (!listEl) return;

  if (_qeRecentPersons.length === 0) {
    listEl.innerHTML = '<div style="color:#567;font-size:12px;padding:8px;">Noch keine Einträge</div>';
  } else {
    listEl.innerHTML = _qeRecentPersons.map(p => `
      <div class="quick-recent-item" onclick="quickEditPerson('${p.id}')">
        <span class="name">${escHtml(p.name)}</span>
        <span class="details">${p.birth ? escHtml(p.birth) : ''}</span>
      </div>
    `).join('');
  }
}

// Edit mode
function quickSearchForEdit(query) {
  const resultsEl = document.getElementById('qe-edit-results');
  if (!resultsEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    resultsEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    if (name.includes(query)) {
      results.push({ id, name: indi.name, birth: indi.birth?.date || '' });
    }
  }

  if (results.length === 0) {
    resultsEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    resultsEl.innerHTML = results.slice(0, 8).map(r => `
      <div class="quick-search-item" onclick="quickLoadPersonForEdit('${r.id}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''}</span>
      </div>
    `).join('');
  }
  resultsEl.style.display = 'block';
}

let _qeEditSpouseCount = 0;
let _qeEditChildCount = 0;

function quickLoadPersonForEdit(id) {
  const indi = individuals.get(id);
  if (!indi) return;

  // Show edit form, hide search
  document.getElementById('quick-edit-search').style.display = 'none';
  document.getElementById('quick-edit-form').style.display = 'flex';
  document.getElementById('qe-edit-id').value = id;

  // Basic info
  document.getElementById('qe-edit-name').value = indi.name || '';
  document.getElementById('qe-edit-sex').value = indi.sex || '';
  document.getElementById('qe-edit-birth-date').value = indi.birth?.date || '';
  document.getElementById('qe-edit-birth-place').value = indi.birth?.plac || '';
  document.getElementById('qe-edit-death-date').value = indi.death?.date || '';
  document.getElementById('qe-edit-death-place').value = indi.death?.plac || '';
  document.getElementById('qe-edit-notes').value = indi.note || '';

  // Status checkboxes
  document.getElementById('qe-edit-deceased').checked = indi.deceased || !!indi.death?.date;
  document.getElementById('qe-edit-divorced').checked = (indi.note || '').includes('Geschieden');
  document.getElementById('qe-edit-adopted').checked = (indi.note || '').includes('Adoptiert');

  // Load parents
  _qeLoadParentsForEdit(indi);

  // Load spouses and children
  _qeLoadSpousesAndChildrenForEdit(indi);

  // Hide search results
  document.getElementById('qe-edit-results').style.display = 'none';
}

function _qeLoadParentsForEdit(indi) {
  // Clear parent fields
  document.getElementById('qe-edit-father').value = '';
  document.getElementById('qe-edit-father-id').value = '';
  document.getElementById('qe-edit-mother').value = '';
  document.getElementById('qe-edit-mother-id').value = '';

  if (!indi.famc) return;

  const fam = families.get(indi.famc);
  if (!fam) return;

  // Load father
  if (fam.husb) {
    const father = individuals.get(fam.husb);
    if (father) {
      document.getElementById('qe-edit-father').value = father.name;
      document.getElementById('qe-edit-father-id').value = fam.husb;
    }
  }

  // Load mother
  if (fam.wife) {
    const mother = individuals.get(fam.wife);
    if (mother) {
      document.getElementById('qe-edit-mother').value = mother.name;
      document.getElementById('qe-edit-mother-id').value = fam.wife;
    }
  }
}

function _qeLoadSpousesAndChildrenForEdit(indi) {
  // Reset counters and lists
  _qeEditSpouseCount = 0;
  _qeEditChildCount = 0;
  document.getElementById('qe-edit-spouses-list').innerHTML = '';
  document.getElementById('qe-edit-children-list').innerHTML = '';

  // Load spouses from families
  const processedChildren = new Set();

  for (const famId of indi.fams || []) {
    const fam = families.get(famId);
    if (!fam) continue;

    // Find spouse
    const isHusb = fam.husb === indi.id;
    const spouseId = isHusb ? fam.wife : fam.husb;

    if (spouseId) {
      const spouse = individuals.get(spouseId);
      _qeAddSpouseToEditList(spouseId, spouse?.name || '', fam.marriages?.[0]?.date || '', fam.marriages?.[0]?.plac || '');
    }

    // Collect children from this family
    for (const childId of fam.children || []) {
      if (!processedChildren.has(childId)) {
        processedChildren.add(childId);
        const child = individuals.get(childId);
        _qeAddChildToEditList(childId, child?.name || '');
      }
    }
  }
}

function _qeAddSpouseToEditList(spouseId, name, marriageDate, marriagePlace) {
  const container = document.getElementById('qe-edit-spouses-list');
  const idx = _qeEditSpouseCount++;

  const row = document.createElement('div');
  row.className = 'quick-spouse-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" class="quick-input" value="${escHtml(name)}" readonly>
      <input type="hidden" class="qe-edit-spouse-id" value="${spouseId}">
    </div>
    <input type="text" placeholder="Hochzeitsdatum" class="quick-input qe-edit-marr-date" value="${escHtml(marriageDate)}" style="width:120px">
    <input type="text" placeholder="Hochzeitsort" class="quick-input qe-edit-marr-place" value="${escHtml(marriagePlace)}" style="width:100px">
    <button class="quick-btn-small" onclick="quickRemoveSpouseEdit(${idx})">&#x2715;</button>
  `;
  container.appendChild(row);
}

function _qeAddChildToEditList(childId, name) {
  const container = document.getElementById('qe-edit-children-list');
  const idx = _qeEditChildCount++;

  const row = document.createElement('div');
  row.className = 'quick-child-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" class="quick-input" value="${escHtml(name)}" readonly>
      <input type="hidden" class="qe-edit-child-id" value="${childId}">
    </div>
    <button class="quick-btn-small" onclick="quickRemoveChildEdit(${idx})">&#x2715;</button>
  `;
  container.appendChild(row);
}

function quickCancelEdit() {
  document.getElementById('quick-edit-search').style.display = 'block';
  document.getElementById('quick-edit-form').style.display = 'none';
  document.getElementById('qe-edit-search-input').value = '';
}

function quickSaveEditPerson() {
  const id = document.getElementById('qe-edit-id').value;
  const indi = individuals.get(id);
  if (!indi) return;

  // Update basic info
  indi.name = document.getElementById('qe-edit-name').value;
  indi.sex = document.getElementById('qe-edit-sex').value;
  indi.birth = {
    date: document.getElementById('qe-edit-birth-date').value,
    plac: document.getElementById('qe-edit-birth-place').value
  };
  indi.death = {
    date: document.getElementById('qe-edit-death-date').value,
    plac: document.getElementById('qe-edit-death-place').value,
    caus: indi.death?.caus || ''
  };
  indi.deceased = document.getElementById('qe-edit-deceased').checked || !!indi.death.date;

  // Update notes with status
  let note = document.getElementById('qe-edit-notes').value || '';
  const isDivorced = document.getElementById('qe-edit-divorced').checked;
  const isAdopted = document.getElementById('qe-edit-adopted').checked;

  const statusTags = [];
  if (isDivorced) statusTags.push('Geschieden');
  if (isAdopted) statusTags.push('Adoptiert');

  if (statusTags.length > 0) {
    note = note + (note ? '; ' : '') + statusTags.join(', ');
  }
  indi.note = note;

  // Update parent links
  _qeSaveParentLinks(id);

  // Update marriage info
  _qeSaveMarriageInfo(id);

  // Refresh
  _fullRebuildGraph();
  _qeAddToRecent({ id, name: indi.name, birth: indi.birth?.date });

  alert('Gespeichert: ' + indi.name);
  quickCancelEdit();
}

function _qeSaveParentLinks(childId) {
  const fatherId = document.getElementById('qe-edit-father-id').value;
  const motherId = document.getElementById('qe-edit-mother-id').value;

  if (!fatherId && !motherId) return;

  // Find or create family with these parents
  let famId = null;
  for (const [id, fam] of families) {
    if ((fatherId && fam.husb === fatherId) || (motherId && fam.wife === motherId)) {
      famId = id;
      break;
    }
  }

  if (!famId) {
    // Create new family
    let maxFam = 0;
    for (const [id] of families) {
      const m = id.match(/\d+/);
      if (m) maxFam = Math.max(maxFam, +m[0]);
    }
    famId = `@F${++maxFam}@`;
    families.set(famId, {
      id: famId,
      husb: fatherId,
      wife: motherId,
      marriages: [{ date: '', plac: '', types: [] }], div: false, divDate: '',
      chil: []
    });

    // Update parents' fams arrays
    if (fatherId) {
      const father = individuals.get(fatherId);
      if (father && !father.fams.includes(famId)) father.fams.push(famId);
    }
    if (motherId) {
      const mother = individuals.get(motherId);
      if (mother && !mother.fams.includes(famId)) mother.fams.push(famId);
    }
  }

  // Add child to family if not already there
  const fam = families.get(famId);
  if (!fam.children.includes(childId)) {
    fam.children.push(childId);
  }

  // Update child's famc
  const child = individuals.get(childId);
  if (child) child.famc = famId;
}

function _qeSaveMarriageInfo(indiId) {
  // Update marriage dates/places from edit form
  const rows = document.querySelectorAll('#qe-edit-spouses-list .quick-spouse-row');

  rows.forEach(row => {
    const spouseId = row.querySelector('.qe-edit-spouse-id')?.value;
    const marriageDate = row.querySelector('.qe-edit-marr-date')?.value;
    const marriagePlace = row.querySelector('.qe-edit-marr-place')?.value;

    if (!spouseId) return;

    // Find the family for this couple
    for (const famId of individuals.get(indiId)?.fams || []) {
      const fam = families.get(famId);
      if (!fam) continue;

      const isSpouse = fam.husb === spouseId || fam.wife === spouseId;
      if (isSpouse) {
        if (!fam.marriages) fam.marriages = [];
        if (!fam.marriages[0]) fam.marriages[0] = { date: '', plac: '', types: [] };
        fam.marriages[0].date = marriageDate || '';
        fam.marriages[0].plac = marriagePlace || '';
        break;
      }
    }
  });
}

// Edit mode helpers
function quickSearchParentEdit(type, query) {
  const searchEl = document.getElementById(`qe-edit-${type}-search`);
  if (!searchEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    searchEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    if (name.includes(query)) {
      if (type === 'father' && indi.sex !== 'M') continue;
      if (type === 'mother' && indi.sex !== 'F') continue;
      results.push({ id, name: indi.name, birth: indi.birth?.date || '', sex: indi.sex });
    }
  }

  if (results.length === 0) {
    searchEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    searchEl.innerHTML = results.slice(0, 5).map(r => `
      <div class="quick-search-item" onclick="quickSelectParentEdit('${type}', '${r.id}', '${escHtml(r.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''} [${r.sex}]</span>
      </div>
    `).join('');
  }
  searchEl.style.display = 'block';
}

function quickShowParentEditSearch(type) {
  const searchEl = document.getElementById(`qe-edit-${type}-search`);
  if (searchEl) {
    quickSearchParentEdit(type, document.getElementById(`qe-edit-${type}`).value);
  }
}

function quickSelectParentEdit(type, id, name) {
  document.getElementById(`qe-edit-${type}`).value = name;
  document.getElementById(`qe-edit-${type}-id`).value = id;
  document.getElementById(`qe-edit-${type}-search`).style.display = 'none';
}

function quickCreateParentEdit(type) {
  const container = document.getElementById(`qe-edit-${type}-search`);
  if (!container) return;

  container.innerHTML = `
    <div class="quick-new-person-inline">
      <div class="quick-field-row" style="padding:8px;">
        <input type="text" class="quick-input qe-parent-new-name" placeholder="Vorname Nachname *" style="flex:1">
        <input type="text" class="quick-input qe-parent-new-birth" placeholder="Geburtsdatum" style="width:100px">
        <input type="text" class="quick-input qe-parent-new-death" placeholder="Sterbedatum" style="width:100px">
        <button class="quick-btn-small" onclick="quickSaveNewParentEdit('${type}')">&#x2713;</button>
        <button class="quick-btn-small" onclick="document.getElementById('qe-edit-${type}-search').style.display='none'">&#x2715;</button>
      </div>
    </div>
  `;
  container.style.display = 'block';
  setTimeout(() => container.querySelector('.qe-parent-new-name')?.focus(), 10);
}

function quickSaveNewParentEdit(type) {
  const container = document.getElementById(`qe-edit-${type}-search`);
  const name = container.querySelector('.qe-parent-new-name')?.value?.trim();
  if (!name) {
    alert('Bitte einen Namen eingeben');
    return;
  }

  const sex = type === 'father' ? 'M' : 'F';
  const birthDate = container.querySelector('.qe-parent-new-birth')?.value || '';
  const deathDate = container.querySelector('.qe-parent-new-death')?.value || '';

  const newId = _qeCreateNewPerson({ fullName: name, sex, birthDate, deathDate });

  document.getElementById(`qe-edit-${type}`).value = name;
  document.getElementById(`qe-edit-${type}-id`).value = newId;
  container.style.display = 'none';

  _qeAddToRecent({ id: newId, name, birth: birthDate });
}

function quickAddSpouseEdit() {
  const container = document.getElementById('qe-edit-spouses-list');
  const idx = _qeEditSpouseCount++;

  const row = document.createElement('div');
  row.className = 'quick-spouse-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" placeholder="Ehepartner suchen..." class="quick-input"
             oninput="quickSearchSpouseEdit(${idx}, this.value)"
             onfocus="quickShowSpouseEditSearch(${idx})">
      <div id="qe-edit-spouse-search-${idx}" class="quick-dropdown" style="display:none"></div>
      <input type="hidden" class="qe-edit-spouse-id">
    </div>
    <input type="text" placeholder="Hochzeitsdatum" class="quick-input qe-edit-marr-date" style="width:120px">
    <input type="text" placeholder="Hochzeitsort" class="quick-input qe-edit-marr-place" style="width:100px">
    <button class="quick-btn-small" onclick="quickRemoveSpouseEdit(${idx})">&#x2715;</button>
  `;
  container.appendChild(row);
}

function quickSearchSpouseEdit(idx, query) {
  const searchEl = document.getElementById(`qe-edit-spouse-search-${idx}`);
  if (!searchEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    searchEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    if (name.includes(query)) {
      results.push({ id, name: indi.name, birth: indi.birth?.date || '' });
    }
  }

  if (results.length === 0) {
    searchEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    searchEl.innerHTML = results.slice(0, 5).map(r => `
      <div class="quick-search-item" onclick="quickSelectSpouseEdit(${idx}, '${r.id}', '${escHtml(r.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''}</span>
      </div>
    `).join('');
  }
  searchEl.style.display = 'block';
}

function quickShowSpouseEditSearch(idx) {
  const searchEl = document.getElementById(`qe-edit-spouse-search-${idx}`);
  if (searchEl) searchEl.style.display = 'block';
}

function quickSelectSpouseEdit(idx, id, name) {
  const row = document.querySelector(`#qe-edit-spouses-list .quick-spouse-row[data-idx="${idx}"]`);
  if (row) {
    row.querySelector('input[type="text"]').value = name;
    row.querySelector('.qe-edit-spouse-id').value = id;
  }
  document.getElementById(`qe-edit-spouse-search-${idx}`).style.display = 'none';
}

function quickRemoveSpouseEdit(idx) {
  const row = document.querySelector(`#qe-edit-spouses-list .quick-spouse-row[data-idx="${idx}"]`);
  if (row) row.remove();
}

function quickCreateNewSpouseEdit() {
  const container = document.getElementById('qe-edit-spouses-list');
  const idx = _qeEditSpouseCount++;

  const row = document.createElement('div');
  row.className = 'quick-spouse-row quick-new-person-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-new-person-form" style="width:100%;">
      <div class="quick-new-person-header">Neuen Ehepartner erstellen:</div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-name" placeholder="Vorname Nachname *" style="flex:2">
        <select class="quick-select qe-new-sex" style="width:70px">
          <option value="">Sex</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-birth-date" placeholder="Geburtsdatum">
        <input type="text" class="quick-input qe-new-birth-place" placeholder="Geburtsort">
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-death-date" placeholder="Sterbedatum">
        <input type="text" class="quick-input qe-new-death-place" placeholder="Sterbeort">
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-marr-date" placeholder="Hochzeitsdatum" style="width:120px">
        <input type="text" class="quick-input qe-marr-place" placeholder="Hochzeitsort" style="width:120px">
        <button class="quick-btn-small" onclick="quickSaveNewSpouseFromEditRow(${idx})">&#x2713;</button>
        <button class="quick-btn-small" onclick="quickRemoveSpouseEdit(${idx})">&#x2715;</button>
      </div>
    </div>
  `;
  container.appendChild(row);
  row.querySelector('.qe-new-name').focus();
}

function quickSaveNewSpouseFromEditRow(idx) {
  const row = document.querySelector(`#qe-edit-spouses-list .quick-spouse-row[data-idx="${idx}"]`);
  if (!row) return;

  const name = row.querySelector('.qe-new-name')?.value?.trim();
  if (!name) {
    alert('Bitte einen Namen eingeben');
    return;
  }

  const sex = row.querySelector('.qe-new-sex')?.value || 'U';
  const birthDate = row.querySelector('.qe-new-birth-date')?.value || '';
  const birthPlace = row.querySelector('.qe-new-birth-place')?.value || '';
  const deathDate = row.querySelector('.qe-new-death-date')?.value || '';
  const deathPlace = row.querySelector('.qe-new-death-place')?.value || '';
  const marrDate = row.querySelector('.qe-marr-date')?.value || '';
  const marrPlace = row.querySelector('.qe-marr-place')?.value || '';

  const newId = _qeCreateNewPerson({ fullName: name, sex, birthDate, birthPlace, deathDate, deathPlace });

  // Convert to display row
  row.className = 'quick-spouse-row';
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" class="quick-input" value="${escHtml(name)}" readonly>
      <input type="hidden" class="qe-edit-spouse-id" value="${newId}">
    </div>
    <input type="text" placeholder="Hochzeitsdatum" class="quick-input qe-edit-marr-date" value="${escHtml(marrDate)}" style="width:120px">
    <input type="text" placeholder="Hochzeitsort" class="quick-input qe-edit-marr-place" value="${escHtml(marrPlace)}" style="width:100px">
    <button class="quick-btn-small" onclick="quickRemoveSpouseEdit(${idx})">&#x2715;</button>
  `;

  _qeAddToRecent({ id: newId, name, birth: birthDate });

  // Link to current person being edited
  const currentId = document.getElementById('qe-edit-id').value;
  if (currentId) {
    _qeCreateFamily(currentId, newId, marrDate, marrPlace);
  }
}

function quickAddChildEdit() {
  const container = document.getElementById('qe-edit-children-list');
  const idx = _qeEditChildCount++;

  const row = document.createElement('div');
  row.className = 'quick-child-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" placeholder="Kind suchen..." class="quick-input"
             oninput="quickSearchChildEdit(${idx}, this.value)"
             onfocus="quickShowChildEditSearch(${idx})">
      <div id="qe-edit-child-search-${idx}" class="quick-dropdown" style="display:none"></div>
      <input type="hidden" class="qe-edit-child-id">
    </div>
    <button class="quick-btn-small" onclick="quickRemoveChildEdit(${idx})">&#x2715;</button>
  `;
  container.appendChild(row);
}

function quickSearchChildEdit(idx, query) {
  const searchEl = document.getElementById(`qe-edit-child-search-${idx}`);
  if (!searchEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    searchEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    if (name.includes(query)) {
      results.push({ id, name: indi.name, birth: indi.birth?.date || '' });
    }
  }

  if (results.length === 0) {
    searchEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    searchEl.innerHTML = results.slice(0, 5).map(r => `
      <div class="quick-search-item" onclick="quickSelectChildEdit(${idx}, '${r.id}', '${escHtml(r.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''}</span>
      </div>
    `).join('');
  }
  searchEl.style.display = 'block';
}

function quickShowChildEditSearch(idx) {
  const searchEl = document.getElementById(`qe-edit-child-search-${idx}`);
  if (searchEl) searchEl.style.display = 'block';
}

function quickSelectChildEdit(idx, id, name) {
  const row = document.querySelector(`#qe-edit-children-list .quick-child-row[data-idx="${idx}"]`);
  if (row) {
    row.querySelector('input[type="text"]').value = name;
    row.querySelector('.qe-edit-child-id').value = id;
  }
  document.getElementById(`qe-edit-child-search-${idx}`).style.display = 'none';
}

function quickRemoveChildEdit(idx) {
  const row = document.querySelector(`#qe-edit-children-list .quick-child-row[data-idx="${idx}"]`);
  if (row) row.remove();
}

function quickCreateNewChildEdit() {
  const container = document.getElementById('qe-edit-children-list');
  const idx = _qeEditChildCount++;

  const row = document.createElement('div');
  row.className = 'quick-child-row quick-new-person-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="quick-new-person-form" style="width:100%;">
      <div class="quick-new-person-header">Neues Kind erstellen:</div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-name" placeholder="Vorname Nachname *" style="flex:2">
        <select class="quick-select qe-new-sex" style="width:70px">
          <option value="">Sex</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
        <button class="quick-btn-small" onclick="quickSaveNewChildFromEditRow(${idx})">&#x2713;</button>
        <button class="quick-btn-small" onclick="quickRemoveChildEdit(${idx})">&#x2715;</button>
      </div>
      <div class="quick-field-row">
        <input type="text" class="quick-input qe-new-birth-date" placeholder="Geburtsdatum">
        <input type="text" class="quick-input qe-new-birth-place" placeholder="Geburtsort">
        <input type="text" class="quick-input qe-new-death-date" placeholder="Sterbedatum">
      </div>
    </div>
  `;
  container.appendChild(row);
  row.querySelector('.qe-new-name').focus();
}

function quickSaveNewChildFromEditRow(idx) {
  const row = document.querySelector(`#qe-edit-children-list .quick-child-row[data-idx="${idx}"]`);
  if (!row) return;

  const name = row.querySelector('.qe-new-name')?.value?.trim();
  if (!name) {
    alert('Bitte einen Namen eingeben');
    return;
  }

  const sex = row.querySelector('.qe-new-sex')?.value || 'U';
  const birthDate = row.querySelector('.qe-new-birth-date')?.value || '';
  const birthPlace = row.querySelector('.qe-new-birth-place')?.value || '';
  const deathDate = row.querySelector('.qe-new-death-date')?.value || '';

  const newId = _qeCreateNewPerson({ fullName: name, sex, birthDate, birthPlace, deathDate });

  // Convert to display row
  row.className = 'quick-child-row';
  row.innerHTML = `
    <div class="quick-search-wrap">
      <input type="text" class="quick-input" value="${escHtml(name)}" readonly>
      <input type="hidden" class="qe-edit-child-id" value="${newId}">
    </div>
    <button class="quick-btn-small" onclick="quickRemoveChildEdit(${idx})">&#x2715;</button>
  `;

  _qeAddToRecent({ id: newId, name, birth: birthDate });

  // Link as child to current person's families
  const currentId = document.getElementById('qe-edit-id').value;
  if (currentId) {
    // Find a family where current person is parent
    for (const famId of individuals.get(currentId)?.fams || []) {
      const fam = families.get(famId);
      if (fam) {
        if (!fam.children.includes(newId)) {
          fam.children.push(newId);
        }
        const child = individuals.get(newId);
        if (child) child.famc = famId;
        break;
      }
    }
  }
}

function quickEditPerson(id) {
  quickLoadPersonForEdit(id);
  openQuickEntry();
}

// Link mode
function setQuickRel(mode) {
  _qeLinkMode = mode;
  document.querySelectorAll('.quick-rel-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.quick-rel-btn[onclick="setQuickRel('${mode}')"]`).classList.add('active');

  // Show/hide marriage fields
  document.getElementById('qe-link-spouse-fields').style.display = mode === 'spouse' ? 'block' : 'none';
}

function quickSearchForLink(personNum, query) {
  const resultsEl = document.getElementById(`qe-link-${personNum}-results`);
  if (!resultsEl) return;

  query = query.toLowerCase().trim();
  if (!query) {
    resultsEl.style.display = 'none';
    return;
  }

  const results = [];
  for (const [id, indi] of individuals) {
    const name = (indi.name || '').toLowerCase();
    if (name.includes(query)) {
      results.push({ id, name: indi.name, birth: indi.birth?.date || '' });
    }
  }

  if (results.length === 0) {
    resultsEl.innerHTML = '<div style="padding:8px;color:#789;font-size:12px;">Keine Treffer</div>';
  } else {
    resultsEl.innerHTML = results.slice(0, 6).map(r => `
      <div class="quick-search-item" onclick="quickSelectLinkPerson('${personNum}', '${r.id}', '${escHtml(r.name).replace(/'/g, "\\'")}')">
        <span class="name">${escHtml(r.name)}</span>
        <span class="details">${r.birth ? escHtml(r.birth) : ''}</span>
      </div>
    `).join('');
  }
  resultsEl.style.display = 'block';
}

function quickSelectLinkPerson(personNum, id, name) {
  document.getElementById(`qe-link-${personNum}`).value = name;
  document.getElementById(`qe-link-${personNum}-id`).value = id;
  document.getElementById(`qe-link-${personNum}-results`).style.display = 'none';
}

function quickCreateLink() {
  const id1 = document.getElementById('qe-link-person1-id').value;
  const id2 = document.getElementById('qe-link-person2-id').value;

  if (!id1 || !id2) {
    alert('Bitte beide Personen auswählen');
    return;
  }

  if (_qeLinkMode === 'spouse') {
    const date = document.getElementById('qe-link-marriage-date').value;
    const place = document.getElementById('qe-link-marriage-place').value;
    _qeCreateFamily(id1, id2, date, place);
    alert('Ehe erstellt');
  } else {
    // Parent-child: id1 is parent, id2 is child
    const parent = individuals.get(id1);
    const isFather = parent?.sex === 'M';
    _qeLinkToParents(id2, isFather ? id1 : '', isFather ? '' : id1);
    alert('Eltern-Kind-Verknüpfung erstellt');
  }

  _fullRebuildGraph();

  // Clear
  document.getElementById('qe-link-person1').value = '';
  document.getElementById('qe-link-person1-id').value = '';
  document.getElementById('qe-link-person2').value = '';
  document.getElementById('qe-link-person2-id').value = '';
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (document.getElementById('quick-entry-modal').style.display === 'none') return;

  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    quickSavePerson();
  } else if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    quickSaveAndNext();
  }
});

// Window exports
window.openQuickEntry = openQuickEntry;
window.closeQuickEntry = closeQuickEntry;
window.switchQuickTab = switchQuickTab;
window.quickClearForm = quickClearForm;
window.quickSavePerson = quickSavePerson;
window.quickSaveAndNext = quickSaveAndNext;
window.quickSearchParent = quickSearchParent;
window.quickShowParentSearch = quickShowParentSearch;
window.quickSelectParent = quickSelectParent;
window.quickCreateParent = quickCreateParent;
window.quickSaveNewParent = quickSaveNewParent;
window.quickSearchParentEdit = quickSearchParentEdit;
window.quickShowParentEditSearch = quickShowParentEditSearch;
window.quickSelectParentEdit = quickSelectParentEdit;
window.quickCreateParentEdit = quickCreateParentEdit;
window.quickSaveNewParentEdit = quickSaveNewParentEdit;
window.quickAddSpouse = quickAddSpouse;
window.quickAddSpouseEdit = quickAddSpouseEdit;
window.quickSearchSpouseEdit = quickSearchSpouseEdit;
window.quickShowSpouseEditSearch = quickShowSpouseEditSearch;
window.quickSelectSpouseEdit = quickSelectSpouseEdit;
window.quickRemoveSpouseEdit = quickRemoveSpouseEdit;
window.quickCreateNewSpouseEdit = quickCreateNewSpouseEdit;
window.quickSaveNewSpouseFromEditRow = quickSaveNewSpouseFromEditRow;
window.quickAddChildEdit = quickAddChildEdit;
window.quickSearchChildEdit = quickSearchChildEdit;
window.quickShowChildEditSearch = quickShowChildEditSearch;
window.quickSelectChildEdit = quickSelectChildEdit;
window.quickRemoveChildEdit = quickRemoveChildEdit;
window.quickCreateNewChildEdit = quickCreateNewChildEdit;
window.quickSaveNewChildFromEditRow = quickSaveNewChildFromEditRow;
window.quickSaveEditPerson = quickSaveEditPerson;
window.quickCancelEdit = quickCancelEdit;
window.quickSearchSpouse = quickSearchSpouse;
window.quickShowSpouseSearch = quickShowSpouseSearch;
window.quickSelectSpouse = quickSelectSpouse;
window.quickRemoveSpouse = quickRemoveSpouse;
window.quickCreateNewSpouse = quickCreateNewSpouse;
window.quickSaveNewPersonFromRow = quickSaveNewPersonFromRow;
window.quickAddChild = quickAddChild;
window.quickSearchChild = quickSearchChild;
window.quickShowChildSearch = quickShowChildSearch;
window.quickSelectChild = quickSelectChild;
window.quickRemoveChild = quickRemoveChild;
window.quickCreateNewChild = quickCreateNewChild;
window.quickSearchForEdit = quickSearchForEdit;
window.quickLoadPersonForEdit = quickLoadPersonForEdit;
window.quickEditPerson = quickEditPerson;
window.setQuickRel = setQuickRel;
window.quickSearchForLink = quickSearchForLink;
window.quickSelectLinkPerson = quickSelectLinkPerson;
window.quickCreateLink = quickCreateLink;

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
      label:      maidenName ? `${name} (geb. ${maidenName})` : name,
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

// Attach to static quick-entry form fields (called once on DOMContentLoaded)
function _acAttachQuickEntry() {
  _acAttach(document.getElementById('qe-name'),              _acNames);
  _acAttach(document.getElementById('qe-birth-place'),       _acPlaces);
  _acAttach(document.getElementById('qe-death-place'),       _acPlaces);
  _acAttach(document.getElementById('qe-edit-birth-place'),  _acPlaces);
  _acAttach(document.getElementById('qe-edit-death-place'),  _acPlaces);
}

document.addEventListener('DOMContentLoaded', _acAttachQuickEntry);
