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

const PALETTE = [
  '#4e79a7','#e15759','#59a14f','#76b7b2','#edc948',
  '#b07aa1','#ff9da7','#f28e2b','#9c755f','#bab0ac',
  '#d37295','#a0cbe8','#fabfd2','#8cd17d','#b6992d'
];

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
let sortByTime3D   = true;   // Y-stratify 3D sim by birth year + show 3D timeline
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
  nodeOpacity: 0.85,
  linkOpacity: 0.45,
  ambientLight: 0.4,
  pointLight:  0.8,
  linkWidth:   2.4,
  nodeRelSize: 2.0,
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

// ── 3D pinch-to-zoom (OrbitControls has enableZoom=false) ──
let _pinch3d = null;  // { dist0, camDist0 }

function _onTouch3DStart(evt) {
  if (evt.touches.length === 2 && graph3d && _orbitControls3d) {
    evt.preventDefault();
    const dx = evt.touches[0].clientX - evt.touches[1].clientX;
    const dy = evt.touches[0].clientY - evt.touches[1].clientY;
    const dist0 = Math.hypot(dx, dy);
    const camDist0 = graph3d.camera().position.distanceTo(_orbitControls3d.target);
    _pinch3d = { dist0, camDist0 };
  }
}

function _onTouch3DMove(evt) {
  if (!_pinch3d || evt.touches.length !== 2 || !graph3d || !_orbitControls3d) return;
  evt.preventDefault();
  const dx = evt.touches[0].clientX - evt.touches[1].clientX;
  const dy = evt.touches[0].clientY - evt.touches[1].clientY;
  const dist = Math.hypot(dx, dy);
  const scale = _pinch3d.dist0 / Math.max(dist, 1);
  let newDist = _pinch3d.camDist0 * scale;
  newDist = Math.max(25, Math.min(14000, newDist));

  // Move camera along the line from target to camera
  const cam = graph3d.camera();
  const dir = cam.position.clone().sub(_orbitControls3d.target).normalize();
  cam.position.copy(_orbitControls3d.target).addScaledVector(dir, newDist);
  _orbitControls3d.update();
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
          name: '', givn: '', surn: '',
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
          marr: { date: '', plac: '' },
          div: false
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
            // Only accept first non-empty name
            if (!cur.name) {
              // val like "Luca /Fluri/" or "/Kuhn/" or ""
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
            }
            break;
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
          case 'MARR': subCtx = 'MARR'; break;
          case 'DIV':  cur.div = true; break;
        }
      } else if (level === 2 && subCtx === 'MARR') {
        if (tag === 'DATE') cur.marr.date = val;
        else if (tag === 'PLAC') cur.marr.plac = val;
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
  const counts = new Map();
  let noSurnCount = 0;
  for (const [, indi] of individuals) {
    const s = indi.surn;
    if (s) counts.set(s, (counts.get(s) || 0) + 1);
    else noSurnCount++;
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  surnameColors.clear();
  surnameEnabled.clear();
  sorted.forEach(([surn], i) => {
    surnameColors.set(surn, PALETTE[i % PALETTE.length]);
    surnameEnabled.set(surn, true);
  });
  // Persons with no surname — key null, shown at end of list
  if (noSurnCount > 0) {
    surnameEnabled.set(null, true);
    sorted.push([null, noSurnCount]);
  }
  return sorted;
}

function nodeBaseColor(n) {
  if (n.type === 'FAM') return n.data.div ? nodeColors.famDiv : nodeColors.fam;
  const indi = n.data;
  if (indi.sex === 'M') return nodeColors.male;
  if (indi.sex === 'F') return nodeColors.female;
  return nodeColors.unknown;
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
  const depth = new Map();
  for (const [id] of individuals) depth.set(id, 0);

  // Propagate: child depth = max(parent depths) + 1, repeat until stable
  let changed = true;
  while (changed) {
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
  let changed = true;
  while (changed) {
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
  // Compute a reference year-per-generation from people who DO have years
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

  zoomBehavior = d3.zoom()
    .scaleExtent([0.04, 4])
    .on('zoom', evt => {
      gMain.attr('transform', evt.transform);
      currentZoom = evt.transform.k;
      updateLabels();
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
  gMain.selectAll('*').remove();

  // Links layer
  linkSel = gMain.append('g').attr('class', 'links-g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', d => linkColor(d))
    .attr('stroke-dasharray', d => linkDash(d))
    .attr('stroke-width', d => linkWidth(d))
    .attr('opacity', d => linkBaseOpacity(d));

  // Nodes layer
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

  // Draw shapes per node
  nodeSel.each(function(d) {
    const g = d3.select(this);
    if (d.type === 'INDI') {
      g.append('circle')
        .attr('r', 8)
        .attr('fill', nodeBaseColor(d))
        .attr('stroke', '#ffffff44')
        .attr('stroke-width', 0.8)
        .attr('opacity', d.data.deceased ? 0.5 : 1);
      if (d.data.deceased) {
        g.append('text')
          .attr('dy', '4px')
          .attr('text-anchor', 'middle')
          .attr('fill', '#bbb')
          .attr('font-size', '11px')
          .attr('pointer-events', 'none')
          .text('×');
      }
    } else {
      // Family diamond
      const sz = 7;
      g.append('polygon')
        .attr('points', `0,${-sz} ${sz},0 0,${sz} ${-sz},0`)
        .attr('fill', d.data.div ? nodeColors.famDiv : nodeColors.fam)
        .attr('stroke', d.data.div ? nodeColors.famDiv : nodeColors.fam)
        .attr('stroke-width', d.data.div ? 1.5 : 1)
        .attr('stroke-dasharray', d.data.div ? '3 2' : null)
        .attr('opacity', 0.88);
    }
  });

  // Labels layer (INDI only)
  labelSel = gMain.append('g').attr('class', 'labels-g')
    .selectAll('text')
    .data(nodes.filter(n => n.type === 'INDI'), d => d.id)
    .join('text')
    .attr('class', 'node-label')
    .attr('dy', '-12px')
    .text(d => d.data.displayName);

  updateLabels();
}

function updateLabels() {
  if (!labelSel) return;
  if (currentZoom < 0.35) {
    labelSel.style('display', 'none');
  } else if (currentZoom < 1.1) {
    labelSel.style('display', null).text(d => {
      const n = d.data.givn || d.data.displayName;
      return n.length > 10 ? n.slice(0, 10) + '…' : n;
    });
  } else {
    labelSel.style('display', null).text(d => d.data.displayName);
  }
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
  computeEstimatedYears();

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
  const genDepths = computeGenerationDepths();
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

  simulation.on('tick', tick);
  simulation.on('end', onSimEnd);
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

let _autoSettleTimer = null;

function _settleBarStart() {
  const bar = document.getElementById('settle-bar');
  if (!bar) return;
  bar.style.transition = 'none';
  bar.style.width = '0%';
  bar.style.opacity = '1';
  requestAnimationFrame(() => {
    bar.style.transition = 'width 3s linear';
    bar.style.width = '65%';
  });
}

function _settleBarFinish() {
  const bar = document.getElementById('settle-bar');
  if (!bar) return;
  bar.style.transition = 'width 4s linear';
  bar.style.width = '100%';
  setTimeout(() => { bar.style.transition = 'none'; bar.style.opacity = '0'; bar.style.width = '0%'; }, 4100);
}

function autoSettle() {
  if (_autoSettleTimer) { clearTimeout(_autoSettleTimer); _autoSettleTimer = null; }

  _settleBarStart();

  if (currentView === '3d') {
    if (!graph3d) return;
    graph3d.d3AlphaDecay(0.04);
    graph3d.d3ReheatSimulation();
    _autoSettleTimer = setTimeout(() => {
      if (graph3d) {
        graph3d.d3AlphaDecay(physicsParams.alphaDecay);
        graph3d.d3ReheatSimulation();
      }
      _settleBarFinish();
      _autoSettleTimer = null;
    }, 3000);
  } else {
    if (!simulation) return;
    const savedDecay = physicsParams.alphaDecay;
    simulation.alphaDecay(0.04).alpha(1).restart();
    _autoSettleTimer = setTimeout(() => {
      if (simulation) simulation.alphaDecay(savedDecay).alpha(0.3).restart();
      _settleBarFinish();
      _autoSettleTimer = null;
    }, 3000);
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
    if (individuals.has('@I1@')) {
      setTimeout(() => showIndiDetail('@I1@'), 300);
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
    if (i.surn) html += `<div class="tt-detail" style="color:#888">Familienname: ${escHtml(i.surn)}</div>`;
  } else {
    const f = d.data;
    const names = [f.husb, f.wife].filter(Boolean)
      .map(id => escHtml(individuals.get(id)?.name || id)).join(' &amp; ');
    html = `<div class="tt-name">Familie</div>`;
    if (names) html += `<div class="tt-detail">${names}</div>`;
    if (f.marr.date) html += `<div class="tt-detail">⚭ ${escHtml(f.marr.date)}</div>`;
    if (f.div) html += `<div class="tt-detail" style="color:#e74c3c">Geschieden</div>`;
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
      if (ps) parentLines.push(ps);
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
      const mInfo = fam.marr.date ? ` &mdash; ⚭ ${escHtml(fam.marr.date)}${fam.marr.plac ? ', ' + escHtml(fam.marr.plac) : ''}` : '';
      const dInfo = fam.div ? ` <span style="color:#e74c3c">[Geschieden]</span>` : '';
      const kids = fam.chil.length ? `<br><span style="color:#888;font-size:11px">${fam.chil.length} ${fam.chil.length === 1 ? 'Kind' : 'Kinder'}</span>` : '';
      html += `<div class="detail-marriage">${spName}${mInfo}${dInfo}${kids}</div>`;
    }
    html += `</div>`;
  }

  // Note
  if (indi.note) {
    html += row('Notiz', `<span style="font-size:11px;color:#999">${escHtml(indi.note).replace(/\n/g, '<br>')}</span>`);
  }

  document.getElementById('detail-content').innerHTML = html;
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
  if (fam.marr.date || fam.marr.plac) html += row('Heirat', fmtPlace(fam.marr.date, fam.marr.plac));
  if (fam.div) html += row('Status', '<span style="color:#e74c3c">Geschieden</span>');

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
      d3.select(this).select('polygon').attr('fill', d.data.div ? nodeColors.famDiv : nodeColors.fam);
    }
  });
  refresh3D();
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
    const color    = isNoSurn ? '#888' : surnameColors.get(surn);
    const label    = isNoSurn ? '(kein Nachname)' : surn;
    const title    = isNoSurn ? 'Personen ohne Nachname' : escAttr(surn);
    const div = document.createElement('div');
    div.className = 'surname-item';
    div.innerHTML = `
      <input type="checkbox" checked>
      <span class="surname-dot" style="background:${color}${isNoSurn ? ';border:1px solid #666' : ''}"></span>
      <span class="surname-label" title="${title}" style="${isNoSurn ? 'font-style:italic;color:#999' : ''}">${escHtml(label)}</span>
      <span class="surname-count">${count}</span>`;
    div.querySelector('input').addEventListener('change', e => {
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
      document.getElementById('relation-tool-btn').disabled = false;
      window._gedcomFilename = file.name;

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
    if (f.marr.date || f.marr.plac) {
      lines.push('1 MARR');
      if (f.marr.date) lines.push(`2 DATE ${f.marr.date}`);
      if (f.marr.plac) lines.push(`2 PLAC ${f.marr.plac}`);
    }
    if (f.div) lines.push('1 DIV Y');
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
}

// ═══════════════════════════════════════════════════════════════
// GEDCOM EDIT FORMS
// ═══════════════════════════════════════════════════════════════
let _editingId   = null;   // INDI or FAM id currently being edited
let _editingType = null;   // 'INDI' | 'FAM'


// Pending relationships to be committed with the new/edited person
let _pendingRelations = [];  // [{ targetId, type: 'parent'|'child'|'spouse' }]

function _buildPersonDatalist(excludeId) {
  let opts = '';
  for (const [pid, p] of individuals) {
    if (pid === excludeId) continue;
    const display = `${p.name || pid}`;
    opts += `<option value="${escAttr(display)}" data-id="${escAttr(pid)}">`;
  }
  return opts;
}

function _resolvePersonInput(val) {
  if (!val) return null;
  val = val.trim();
  // Direct ID match
  if (individuals.has(val)) return val;
  // Match by name (exact or first match)
  for (const [pid, p] of individuals) {
    if ((p.name || pid) === val) return pid;
  }
  // Partial match
  const lower = val.toLowerCase();
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
    return `<div class="ef-rel-item">
      <span class="ef-rel-type">${labels[r.type]}</span>
      <span class="ef-rel-name">${name}</span>
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
  // Prevent duplicate
  if (_pendingRelations.some(r => r.targetId === targetId && r.type === type)) return;
  _pendingRelations.push({ targetId, type });
  input.value = '';
  _renderPendingRelations();
}

function removeRelation(idx) {
  _pendingRelations.splice(idx, 1);
  _renderPendingRelations();
}

function showIndiEditForm(id) {
  const i = individuals.get(id);
  if (!i) return;

  _pendingRelations = [];

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
      <div class="edit-label">Geschlecht</div>
      <select class="edit-select" id="ef-sex">
        <option value="M"${i.sex==='M'?' selected':''}>männlich</option>
        <option value="F"${i.sex==='F'?' selected':''}>weiblich</option>
        <option value="U"${i.sex==='U'||!i.sex?' selected':''}>unbekannt</option>
      </select>
    </div>
    <div class="edit-section">
      <div class="edit-label">Geburtsdatum</div>
      <input class="edit-input" id="ef-bdate" placeholder="z.B. 15 MAY 1996" value="${escAttr(i.birth.date)}">
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
      <input class="edit-input" id="ef-ddate" placeholder="z.B. 20 JUL 2024" value="${escAttr(i.death.date)}">
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
      <div class="edit-label">Beziehungen</div>
      <div id="ef-rel-list" style="margin-bottom:6px">
        <div style="color:#555;font-size:11px;padding:2px 0">Keine Beziehungen hinzugefügt</div>
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
    </div>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitIndiEdit()">&#x2713; Speichern</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">Abbrechen</button>
    </div>`;
}

function commitIndiEdit() {
  const i = individuals.get(_editingId);
  if (!i) return;

  const givn = document.getElementById('ef-givn').value.trim();
  const surn = document.getElementById('ef-surn').value.trim();

  i.givn = givn;
  i.surn = surn;
  // Rebuild name from parts
  i.name = (givn ? givn + ' ' : '') + (surn ? surn : '');
  if (!i.name.trim()) i.name = _editingId.replace(/@/g, '');
  // Rebuild displayName
  i.displayName = i.name.length > 24
    ? (givn ? givn + (surn ? ' ' + surn[0] + '.' : '') : i.name.slice(0, 22) + '…')
    : i.name;

  i.sex        = document.getElementById('ef-sex').value;
  i.birth.date = document.getElementById('ef-bdate').value.trim();
  i.birth.plac = document.getElementById('ef-bplac').value.trim();
  i.deceased   = document.getElementById('ef-dead').checked;
  i.death.date = document.getElementById('ef-ddate').value.trim();
  i.death.plac = document.getElementById('ef-dplac').value.trim();
  i.death.caus = document.getElementById('ef-dcaus').value.trim();
  i.occu       = document.getElementById('ef-occu').value.trim();
  i.note       = document.getElementById('ef-note').value;

  // Re-extract birth year
  const ym = i.birth.date.match(/\b(\d{4})\b/);
  i.birthYear = ym ? +ym[1] : null;

  // ── Process pending relationships ──
  const needsRebuild = _pendingRelations.length > 0;
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
          marr: { date: '', plac: '' }, div: false
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

  // Update label on graph (existing nodes)
  if (labelSel) {
    labelSel.filter(d => d.id === _editingId).text(i.displayName);
  }

  const id = _editingId;
  _editingId = null; _editingType = null;

  if (_isNewRecord || needsRebuild) {
    _isNewRecord = false;
    const sorted = buildSurnameColorMap();
    buildSurnameList(sorted);
    buildGraphData();
    if (!svgSel) initSVG();
    renderGraph();
    document.getElementById('dl-btn').style.display = 'inline-block';
    document.getElementById('center-view-btn').style.display = 'inline-block';
    document.getElementById('center-view-btn').disabled = false;
    document.getElementById('center-person-btn').style.display = 'inline-block';
    document.getElementById('relation-tool-btn').disabled = false;
    document.getElementById('view-toggle-btn').disabled = false;
    document.getElementById('status').textContent =
      `${individuals.size} Person${individuals.size !== 1 ? 'en' : ''}, ${families.size} Familien`;
    _firstLoad = true;
    buildAndRunSimulation();
    setTimeout(autoSettle, 200);
  }

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
    marr: { date: '', plac: '' }, div: false
  };
  if (person?.sex === 'F') fam.wife = personId;
  else fam.husb = personId;
  families.set(famId, fam);
  if (person && !person.fams.includes(famId)) person.fams.push(famId);
  return fam;
}

function showFamEditForm(id) {
  const f = families.get(id);
  if (!f) return;

  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('detail-buttons').style.display = 'none';

  document.getElementById('detail-content').innerHTML = `
    <div class="edit-section">
      <div class="edit-label">Heiratsdatum</div>
      <input class="edit-input" id="ef-mdate" placeholder="z.B. 5 JUN 1965" value="${escAttr(f.marr.date)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">Heiratsort</div>
      <input class="edit-input" id="ef-mplac" value="${escAttr(f.marr.plac)}">
    </div>
    <label class="edit-checkbox-row">
      <input type="checkbox" id="ef-div"${f.div?' checked':''}>
      Geschieden
    </label>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitFamEdit()">&#x2713; Speichern</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">Abbrechen</button>
    </div>`;
}

function commitFamEdit() {
  const f = families.get(_editingId);
  if (!f) return;

  f.marr.date = document.getElementById('ef-mdate').value.trim();
  f.marr.plac = document.getElementById('ef-mplac').value.trim();
  f.div       = document.getElementById('ef-div').checked;

  // Update diamond color
  if (nodeSel) {
    nodeSel.filter(d => d.id === _editingId)
      .select('polygon')
      .attr('fill',         f.div ? nodeColors.famDiv : nodeColors.fam)
      .attr('stroke',       f.div ? nodeColors.famDiv : nodeColors.fam)
      .attr('stroke-dasharray', f.div ? '3 2' : null);
  }

  const id = _editingId;
  _editingId = null; _editingType = null;
  showFamDetail(id);
}

function cancelEdit() {
  const id = _editingId;
  _editingId = null; _editingType = null;
  _pendingRelations = [];
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
    id, name: '', givn: '', surn: '', sex: 'U',
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
    .nodeVal(n => n.type === 'FAM' ? 0.4 : (n.data.deceased ? 0.7 : 1))
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
    _orbitControls3d.dampingFactor  = 0.08;
    _orbitControls3d.rotateSpeed    = 0.45;
    _orbitControls3d.panSpeed       = 0.9;
    _orbitControls3d.enableZoom     = false;   // zoom handled manually for zoom-to-cursor
    _orbitControls3d.enablePan      = true;
    _orbitControls3d.minDistance    = 20;
    _orbitControls3d.maxDistance    = 14000;
    // Touch: 1-finger = ROTATE, 2-finger = PAN (zoom handled by our pinch handler)
    if (_orbitControls3d.touches) {
      _orbitControls3d.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
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

    setTimeout(() => graph3d?.zoomToFit(800, 60), 2500);
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
    obj.traverse(child => {
      if (child.isMesh && child.material) {
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
    obj.traverse(child => {
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
  updateNodeColors();
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
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: true });
  const sprite = new THREE.Sprite(mat);
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
  if (!sortByTime3D || !_birthYearRange) return;

  const { min: minYr, max: maxYr } = _birthYearRange;
  const span = Math.max(maxYr - minYr, 1);
  // topY/botY derived from the SAME yearTo3DY function — exact match with forceY targets
  const topY = yearTo3DY(minYr); // oldest → positive Y
  const botY = yearTo3DY(maxYr); // newest → negative Y
  const totalH = topY - botY;    // = 2 * _3dYHalfSpan

  const group = new THREE.Group();

  // ── Vertical spine ──
  const spineGeo = new THREE.CylinderGeometry(0.6, 0.6, totalH, 8);
  const spineMat = new THREE.MeshBasicMaterial({ color: 0x4466bb, transparent: true, opacity: 0.75 });
  const spine = new THREE.Mesh(spineGeo, spineMat);
  spine.position.set(0, (topY + botY) / 2, 0);
  group.add(spine);

  // ── Year ticks + labels ──
  const step = span > 200 ? 50 : span > 80 ? 25 : 10;
  const startYr = Math.ceil(minYr / step) * step;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x5588cc, transparent: true, opacity: 0.70, side: THREE.DoubleSide });

  for (let yr = startYr; yr <= maxYr; yr += step) {
    const y = yearTo3DY(yr); // exact same function → rings sit at node level

    // Horizontal ring (torus lying flat)
    const ringGeo = new THREE.TorusGeometry(14, 0.5, 8, 40);
    const ring = new THREE.Mesh(ringGeo, ringMat);
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
  const indi = n.data;
  if (indi.sex === 'M') return indi.deceased ? '#5fa8e0' : '#90d0ff';
  if (indi.sex === 'F') return indi.deceased ? '#d07090' : '#ffb8d0';
  return indi.deceased ? '#8899aa' : '#d0dde8';
}

function makeNameSprite3D(n) {
  if (n.type !== 'INDI') return null;
  const indi = n.data;
  const name = indi.displayName || indi.name || n.id;
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

  const FONT_NAME = _3dFontSize;
  const FONT_YEAR = Math.round(_3dFontSize * 0.72);
  const PAD_X = 8, PAD_Y = 4, LINE_GAP = 2;

  // Measure both lines to pick canvas width
  const tmpCtx = document.createElement('canvas').getContext('2d');
  tmpCtx.font = `bold ${FONT_NAME}px Arial`;
  const nameW = tmpCtx.measureText(name).width;
  tmpCtx.font = `${FONT_YEAR}px Arial`;
  const yearW = yearLine ? tmpCtx.measureText(yearLine).width : 0;

  const LW = Math.ceil(Math.max(nameW, yearW)) + PAD_X * 2;
  const LH = FONT_NAME + (yearLine ? FONT_YEAR + LINE_GAP : 0) + PAD_Y * 2;

  const sprite = makeTextSprite3D((ctx, w, h) => {
    ctx.fillStyle = 'rgba(6, 12, 36, 0.84)';
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, 4);
    ctx.fill();
    ctx.strokeStyle = textColor + '55';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Name
    ctx.font = `bold ${FONT_NAME}px Arial`;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(name, w / 2, PAD_Y);
    // Year line
    if (yearLine) {
      ctx.font = `${FONT_YEAR}px Arial`;
      ctx.fillStyle = textColor + 'aa';
      ctx.fillText(yearLine, w / 2, PAD_Y + FONT_NAME + LINE_GAP);
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
  // Cancel orbit tracking — user is taking manual control
  _orbitTargetAnim = null;
  _orbitTrackNodeId = null;

  const cam   = graph3d.camera();
  const ctrl  = _orbitControls3d;
  const el    = graph3d.renderer().domElement;
  const rect  = el.getBoundingClientRect();

  // Ray direction from camera through the cursor
  const nx  = ((evt.clientX - rect.left) / rect.width)  *  2 - 1;
  const ny  = -((evt.clientY - rect.top)  / rect.height) *  2 + 1;
  const dir = new THREE.Vector3(nx, ny, 0.5)
    .unproject(cam)
    .sub(cam.position)
    .normalize();

  // Zoom step proportional to current camera-to-target distance
  const dist = cam.position.distanceTo(ctrl.target);
  const step = evt.deltaY * 0.0008 * dist;

  const newDist = dist + step;
  if (newDist < 25 || newDist > 14000) return;

  // Move camera along ray (toward cursor); target follows at 25% so camera
  // actually closes in on the scene (true zoom, not just pan)
  cam.position.addScaledVector(dir, step);
  ctrl.target.addScaledVector(dir, step * 0.25);
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

function _renderRelationPanel() {
  const nameA = _relPersonA ? (individuals.get(_relPersonA)?.displayName || _relPersonA) : '—';
  const nameB = _relPersonB ? (individuals.get(_relPersonB)?.displayName || _relPersonB) : '—';
  document.getElementById('rel-name-a').textContent = nameA;
  document.getElementById('rel-name-b').textContent = nameB;
  document.getElementById('rel-pick-a').classList.toggle('rel-picking', _relSlotWaiting === 'A');
  document.getElementById('rel-pick-b').classList.toggle('rel-picking', _relSlotWaiting === 'B');
}

function relPickSlot(slot) {
  _relSlotWaiting = _relSlotWaiting === slot ? null : slot;
  document.body.classList.toggle('relation-picking', !!_relSlotWaiting);
  _renderRelationPanel();
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
window.commitFamEdit     = commitFamEdit;
window.cancelEdit        = cancelEdit;
window.savePreset        = savePreset;
window.deletePreset      = deletePreset;
window.applyPreset       = applyPreset;
window.downloadGEDCOM    = downloadGEDCOM;
window.export3DTopDown   = export3DTopDown;
window.toggleNodeDrag    = toggleNodeDrag;
window.openRelationTool  = openRelationTool;
window.closeRelationTool = closeRelationTool;
window.relPickSlot       = relPickSlot;
window.toggleView        = toggleView;
window.toggleSidebar     = toggleSidebar;
window.addNewPerson      = addNewPerson;
window.centerView        = centerView;
window.centerOnPerson    = centerOnPerson;
window.addRelation       = addRelation;
window.removeRelation    = removeRelation;
