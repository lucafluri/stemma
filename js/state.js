// Central mutable application state, shared across modules.
// Everything here used to be a top-level `let` in the original monolithic
// app.js; call sites elsewhere now read/write it as `state.<name>` instead of
// a bare identifier.
import { LINK_COLOR_DEFAULTS, MAP_DOT_COLOR_DEFAULT, NODE_COLOR_DEFAULTS, PHYSICS_DEFAULTS, SCENE_DEFAULTS, TREE_SPACING_DEFAULTS } from './constants.js';

export const state = {
  individuals: new Map(),   // id -> indi object
  families: new Map(),   // id -> fam object
  otherLines: [],          // raw lines from unrecognized level-0 GEDCOM records (SOUR, OBJE, …), re-emitted verbatim on save
  _fileHandle: null,       // FileSystemFileHandle the loaded data came from, when it came from one
  _importFileHandle: null, // ...and the one the import wizard is holding, until it loads or is closed
  allNodes: [],   // complete dataset (all INDI + FAM nodes)
  allLinks: [],   // complete dataset (links with _src/_tgt string IDs, never mutated by D3)
  nodes: [],      // currently active (filtered) nodes passed to simulation
  links: [],      // currently active (filtered) links passed to simulation
  _firstLoad: true,  // controls auto-fit + auto-open on first load only
  _nodeObjCache: new Map(),
  simulation: null,
  svgSel: null,   // d3 selection of <svg>
  gMain: null,   // d3 selection of main <g>
  zoomBehavior: null,  // d3.zoom() instance
  linkG: null,   // the <g> the link paths are joined into
  nodeG: null,   // ...and the one the node groups go in
  _cullSig: null,  // what renderViewport() last drew, so a pan that changes nothing costs nothing
  linkSel: null,
  nodeSel: null,
  labelSel: null,
  yearSel: null,   // the birth–death line under each name
  currentZoom: 1,
  _labelSig: null,  // which legibility band the labels were last laid out for
  selectedIndiId: null,    // currently shown in detail panel
  hlMode: null,            // null | 'ancestors' | 'descendants' | 'both'
  hlSet: new Set(),       // highlighted node ids
  _relHighlightActive: false,
  _relLastPath: null,     // { idA, idB, path, edges } for relation highlight
  _hlAncestorCount: 0,  // individual ancestors (excl. self)
  _hlDescendantCount: 0,  // individual descendants (excl. self)
  surnameColors: new Map(),   // surname -> color string
  surnameEnabled: new Map(),   // surname -> bool
  surnameCustomColors: new Map(), // surname -> user-picked color (persisted)
  colorBySurname: true,        // global toggle for surname coloring
  _surnameColorCache: new Map(), // memoized hash colors
  labelStyle: {
  textColor: '#cccccc',
  textOpacity: 1.0,  // Fully opaque
  fontSize: 13,      // screen px — updateLabels divides by the zoom to keep it constant
  fontWeight: 'normal',
  bgEnabled: false,
  bgColor: '#0a0a0a',
  bgOpacity: 0.7
},
  _lsWriteTimeouts: {},
  _gedcomDirty: false,
  _autosaveTimer: null,
  _autosaveCaptured: false,   // the current edits have been written to the autosave slot
  physicsParams: { ...PHYSICS_DEFAULTS },
  graph3d: null,
  _g3dById: null,     // Map<id, node> over what the 3D scene actually holds
  _3dOmitted: 0,      // people the scene budget left out, reported in the focus panel
  scene3d: { ...SCENE_DEFAULTS },   // the budgets above, as the reader has set them
  // Draw the 3D scene as three instanced layers instead of one Three.js object
  // per node and per link. Strictly faster, but it replaces the library's own
  // rendering and picking, so the switch stays reachable — off falls back to
  // the per-object path, which is still there and still works.
  instanced3d: localStorage.getItem('instanced3d') !== '0',
  // Draw only the nearest `scene3d.drawMax` nodes and hide the rest. This
  // existed because every node was its own draw call and a few thousand of them
  // was all a frame could carry. With the instanced renderer the whole scene is
  // three draw calls whatever its size, so the reason is gone and the default is
  // off — everything in the scene is drawn. The switch stays for the case the
  // budget still helps: a weak GPU, or a scene pushed far past what fits.
  cull3d: localStorage.getItem('cull3d') === '1',
  currentView: localStorage.getItem('viewMode') === '2d' ? '2d' : '3d',   // '2d' | '3d'
  focusRootId: null,
  focusLimit: parseInt(localStorage.getItem('focusLimit')) || 120,
  cousinDegree: parseInt(localStorage.getItem('cousinDegree')),
  genRange: null,   // { min, max } | null
  treeLayout: localStorage.getItem('treeLayout') !== '0',
  // Tree-layout focus normally stops at the focus person's blood relatives —
  // a spouse gets a box but their own parents/siblings are not walked. This
  // pulls those in too, one hop, when the reader wants the in-laws on screen.
  includeSpouseFamily: localStorage.getItem('includeSpouseFamily') === '1',
  _lineageGen: null,   // id -> chart row, filled by computeLineageSet()
  _treeBusY: null,   // FAM id, "fam>child" and "parent~child" -> y of the sibling bar
  _treeOmitted: null,  // [{x, y, n, anchor:{x,y}}] — "+N" cut-branch markers
  _treeLineageSide: null,  // id -> 'father' | 'mother', for the optional side colouring
  treeLineageColoring: localStorage.getItem('treeLineageColoring') === '1',
  _revealed: new Set(),
  _birthYearRange: null,  // { min, max } saved for 3D stratification
  _genRange3D: null,  // { min, max } generation depth, same purpose
  _3dMousePos: { x: 0, y: 0 },
  _3dGestureDragged: false,  // the pointer travelled, so the click that follows is not a tap
  stratify3D: localStorage.getItem('stratify3D') || 'time',
  showTimeline3D: true,   // show the visual timeline axis (spine + rings)
  // Labels default off on a phone. Every one of them is its own canvas texture,
  // and a hundred of them on a 390px screen is an unreadable mat of boxes that
  // also costs more texture memory than the whole rest of the scene. The toggle
  // is still there for anyone who wants them.
  show3DNames: typeof window === 'undefined' || window.innerWidth > 768,
  _nodeDragEnabled: false, // node dragging disabled by default
  _timeline3DObj: null,   // THREE.Group holding timeline meshes in the 3D scene
  _3dYHalfSpan: 750,   // half-range of Y axis in 3D sim units (older→+half, newer→-half)
  _3dFontSize: 18,    // name label font size in 3D view
  _orbitControls3d: null,  // OrbitControls instance (replaces TrackballControls)
  _orbitTargetAnim: null,  // { from, to, start, duration } for smooth orbit target transition
  _orbitTrackNodeId: null,  // node id whose live position the orbit target tracks
  _3dAppearance: {
  bgColor:     '#000000',
  nodeOpacity: 1.0,   // 1.00 from screenshot
  linkOpacity: 1.0,   // 1.00 from screenshot
  ambientLight: 0.6,  // 0.6 from screenshot
  pointLight:  0.5,   // 0.5 from screenshot
  linkWidth:   3.1,   // 3.1 from screenshot
  nodeRelSize: 5.5,   // 5.5 from screenshot
},
  _3dAmbientLight: null,
  _3dPointLight: null,
  _isNewRecord: false, // true while editing a freshly created INDI/FAM
  linkColors: { ...LINK_COLOR_DEFAULTS },
  nodeColors: { ...NODE_COLOR_DEFAULTS },
  // 7 is the reference size the 3D sphere volume is scaled against (see
  // _famNodeVal); `|| 1` here meant a fresh install started at 1 — a marker one
  // pixel across — and made 0 (the slider's own minimum) unselectable.
  famNodeSize: Number.isFinite(parseInt(localStorage.getItem('famNodeSize')))
    ? parseInt(localStorage.getItem('famNodeSize')) : 7,
  mapDotColor: localStorage.getItem('mapDotColor') || MAP_DOT_COLOR_DEFAULT,
  treeSpacing: { ...TREE_SPACING_DEFAULTS },
  // Stays true until the user drags the 3D axis-spread slider by hand — until
  // then the default tracks how many generations are actually on screen
  // instead of sitting at one fixed number regardless of tree size.
  _3dYHalfSpanAuto: true,
  _panelSwipe: null,  // { startY, startTranslate }
  _touchDragged: false,
  _touchStartPos: null,
  _estimatedYears: null,  // Map<id, number>
  _spouseIds: null,   // Map<id, id[]> — see spouseIndex() in graph-data.js
  _genDepthsCache: null,   // Map<id, number> — cleared by _fullRebuildGraph
  _genNumbers: null,   // Map<id, number> — the same thing counted the other way
  _autoSettleTimer: null,
  _pendingDeleteId: null,
  _pendingDeleteType: null,
  _editingId: null,   // INDI or FAM id currently being edited
  _editingType: null,   // 'INDI' | 'FAM'
  _pendingRelations: [],   // [{ targetId, type: 'parent'|'child'|'spouse', isNew? }]
  _removedRelations: [],   // [{ targetId, type, famId }]
  _famEditRemovedChil: new Set(), // child IDs removed during fam edit
  _famEditPendingChil: [],        // [{id, name, isNew}] children added during fam edit
  _famEditMarriages: [],        // working copy of marriages during fam edit
  _famEditNewPartner: { husb: null, wife: null }, // stub person ids created inline for the partner slots
  _lastShownFamId: null,
  _relSlotWaiting: null,   // 'A' | 'B' | null — which slot is awaiting a click
  _relPersonA: null,
  _relPersonB: null,
  _importActions: [],
  _importView: 'table',      // 'table' (diff) | 'cards'
  _importFilter: 'all',      // all | new | changed | same | marriage | unconnected
  _importConn: new Map(),       // actionId → would this new person hang off the tree, if the batch were approved
  _importConnStrict: new Map(), // …and given only what is actually approved right now
  _importRequireConnected: true,  // block apply while approved people would float free
  _importExpanded: new Set(),     // action ids whose full editing card is open
  _importJsonPersons: null,  // set when a .json/.ged/.yaml file is loaded
  _importLoadedFile: null,  // raw File handle, for "replace dataset" path
  _importImageData: null,  // { base64, mediaType } of a dropped image, for OCR
  _tesseractLoading: null,
  _currentMatchActionId: null,
  _imMatchMode: 'link',      // 'link' = same person, 'parent' = attach as their child
  _currentMatchCandidates: [],
  _acEl: null,  // singleton dropdown element
  _acInput: null,  // currently active input
  _acList: [],    // current item list
  _acIdx: -1,    // keyboard-selected index
};

// One-time initialization from persisted (localStorage) settings.
const _lsSurnameColors = localStorage.getItem('surnameCustomColors');
if (_lsSurnameColors) {
  try {
    const parsed = JSON.parse(_lsSurnameColors);
    state.surnameCustomColors = new Map(Object.entries(parsed));
  } catch (e) { /* ignore */ }
}
state.colorBySurname = localStorage.getItem('colorBySurname') !== 'false'; // default true
if (!Number.isFinite(state.cousinDegree)) state.cousinDegree = 1;

// Every other display setting survives a reload; these did not, so a tuned 3D
// scene reset itself every time the page was opened.
try {
  const saved = JSON.parse(localStorage.getItem('appearance3d') || '{}');
  Object.assign(state._3dAppearance, saved);
} catch (e) { /* ignore */ }

try {
  const saved = JSON.parse(localStorage.getItem('treeSpacing') || '{}');
  Object.assign(state.treeSpacing, saved);
} catch (e) { /* ignore */ }

try {
  const saved = JSON.parse(localStorage.getItem('scene3d') || '{}');
  // Only finite positive numbers: a corrupted or hand-edited entry that put a
  // zero or a string in here would empty the 3D scene with no way back short of
  // clearing site data.
  for (const k of Object.keys(SCENE_DEFAULTS)) {
    const v = Number(saved[k]);
    if (Number.isFinite(v) && v >= 0) state.scene3d[k] = v;
  }
} catch (e) { /* ignore */ }
