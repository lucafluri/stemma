// Central mutable application state, shared across modules.
// Everything here used to be a top-level `let` in the original monolithic
// app.js; call sites elsewhere now read/write it as `state.<name>` instead of
// a bare identifier.
import { LINK_COLOR_DEFAULTS, NODE_COLOR_DEFAULTS, PHYSICS_DEFAULTS } from './constants.js';

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
  linkSel: null,
  nodeSel: null,
  labelSel: null,
  yearSel: null,   // the birth–death line under each name
  currentZoom: 1,
  _labelSig: null,  // which legibility band the labels were last laid out for
  selectedIndiId: null,    // currently shown in detail panel
  hlMode: null,            // null | 'ancestors' | 'descendants' | 'both'
  hlSet: new Set(),       // highlighted node ids
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
  physicsParams: { ...PHYSICS_DEFAULTS },
  graph3d: null,
  currentView: localStorage.getItem('viewMode') === '2d' ? '2d' : '3d',   // '2d' | '3d'
  focusRootId: null,
  focusLimit: parseInt(localStorage.getItem('focusLimit')) || 120,
  cousinDegree: parseInt(localStorage.getItem('cousinDegree')),
  genRange: null,   // { min, max } | null
  treeLayout: localStorage.getItem('treeLayout') !== '0',
  _lineageGen: null,   // id -> chart row, filled by computeLineageSet()
  _treeBusY: null,   // FAM id, "fam>child" and "parent~child" -> y of the sibling bar
  _treeOmitted: null,  // [{x, y, n, anchor:{x,y}}] — "+N" cut-branch markers
  _revealed: new Set(),
  _birthYearRange: null,  // { min, max } saved for 3D stratification
  _genRange3D: null,  // { min, max } generation depth, same purpose
  _3dMousePos: { x: 0, y: 0 },
  _3dGestureDragged: false,  // the pointer travelled, so the click that follows is not a tap
  showFamNodes: true,   // show FAM diamond nodes (vs direct parent-child links)
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
  famNodeSize: parseInt(localStorage.getItem('famNodeSize')) || 1,
  _panelSwipe: null,  // { startY, startTranslate }
  _touchDragged: false,
  _touchStartPos: null,
  _estimatedYears: null,  // Map<id, number>
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
  _importImageData: null,  // { base64, mediaType } for AI fallback
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
