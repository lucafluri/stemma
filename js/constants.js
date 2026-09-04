// Shared numeric/style constants used by more than one module.

// `Math.max(...arr)` passes every element as a separate argument, and every
// engine caps how many a call can take — V8 gives up somewhere above 100k with
// a RangeError. That is not a theoretical limit here: this app is built for
// files of 50,000 people and reduces over "every birth year", "every generation
// depth", "every x coordinate". One of those arrays crossing the line takes the
// whole load down. These walk the iterable instead, so size stops mattering.
export function minMax(iter) {
  let min = Infinity, max = -Infinity;
  for (const v of iter) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : { min, max };
}
export function arrMin(iter) { return minMax(iter)?.min ?? null; }
export function arrMax(iter) { return minMax(iter)?.max ?? null; }

// Render and rebuild timings. These used to be bare console.time calls, so every
// repaint wrote a dozen lines into the console of anyone actually using the app —
// and on a big tree that is a repaint per interaction. Kept rather than deleted,
// because the timings are how the slow paths in here were found in the first
// place; turn them back on with `localStorage.perfLog = '1'` and reload.
const _perfOn = (() => {
  try { return localStorage.getItem('perfLog') === '1'; } catch { return false; }
})();
export const perf = {
  start: _perfOn ? label => console.time(label)    : () => {},
  end:   _perfOn ? label => console.timeEnd(label) : () => {},
  log:   _perfOn ? (...a) => console.log(...a)     : () => {},
};

// Above this many people a file cannot be drawn whole: 50k people is 200k-odd
// SVG elements and a force layout that takes minutes to settle, and the result
// is a chart too large to read anyway. Past it the loader picks the
// best-connected person and opens their relatives instead — the focus panel
// says who, and how many of the file are off screen, so nothing is hidden
// silently. Clearing the focus still shows everything, for anyone who wants it.
export const AUTO_FOCUS_THRESHOLD = 1500;

// ── 3D scene budgets ────────────────────────────────────────────────────────
//
// The 2D cull works because SVG elements can be added and dropped at will, so
// the chart is only ever as heavy as the window it is being read through. The
// 3D view cannot be culled that way: ForceGraph3D builds one Three.js object per
// node and per link the moment the data is handed to it, before a single frame
// is drawn. Measured on a 50,000-person file, that is roughly 118,000 meshes and
// 50,000 canvas-texture labels — the tab froze for 111 seconds and never became
// responsive again. There is no later point to cull from, so the 3D limit is
// applied where the objects are created: at the push.
//
// These three are defaults, not limits — every one of them is on a slider in
// the 3D appearance panel, because the right value depends on the machine and
// only the person watching the scene can say whether it is running well.
export const SCENE_DEFAULTS = {
  // How many nodes get *built*. Bounded by construction time and memory, which
  // are paid once per push rather than per frame — so this can be generous.
  maxNodes: 12000,

  // How many get *drawn* in a frame. A separate and smaller number, because
  // drawing a node is one GPU call every frame and each link adds another.
  // Measured on this scene: ~2,400 objects drew at 52 fps, ~6,000 at 53,
  // ~8,000 at 26. The nearest `drawMax` nodes and the links between them are
  // kept and the rest switched off — the same bargain the 2D view makes with
  // its window: near enough to read, drawn; too far to resolve, not drawn.
  drawMax: 4000,

  // Below this the scene can still afford full detail: a name label per person
  // (each its own canvas texture) and a cylinder per link. Above it labels are
  // dropped and links become plain line segments, which is what takes one mesh
  // per link out of the scene.
  detailMax: 1200,
};

// ── Physics at scale ────────────────────────────────────────────────────────
//
// Every number below is an absolute distance or an absolute force, so a layout
// tuned on a few hundred people does not merely look different on twelve
// thousand — it collapses. Two reasons, and the second is the one that bites:
//
//  · The springs have a fixed rest length, so ten times the people are pulled
//    into roughly the same volume: ten times the density.
//  · Repulsion is cut off at chargeDistMax. On a graph a few thousand units
//    across, almost every pair is further apart than that and pushes on nothing
//    at all, while every link goes on pulling inward. That is the "huge trees
//    bundle into a ball" — there is no long-range force left to hold them open.
//
// Constant density means the drawing has to grow with the people in it: volume
// ∝ n, so every distance ∝ n^(1/3). The force law then fixes the rest. d3's
// many-body gives an acceleration of about Q/d, so the repulsion a node feels
// from a uniform cloud of density ρ out to a cutoff R goes as Q·ρ·R². Balancing
// that against a spring at rest length L, with ρ ∝ 1/L³ and the cutoff scaled
// alongside (R ∝ L), leaves Q ∝ L — the cube root again, not n itself.
//
// So: distances, collision radius and the repulsion cutoff all scale by the
// cube root of the node count; the charge scales by the same factor. Scaling
// the charge by n instead — the answer you get if you forget to scale the
// cutoff too — overshoots by a factor of n^(2/3) and blows the graph apart.
export const PHYSICS_REF_NODES = 250;

/** Multipliers for the current node count, relative to a chart of ~250 people. */
export function physicsScale(n) {
  const s = Math.cbrt(Math.max(1, n) / PHYSICS_REF_NODES);
  // Below the reference size, leave everything exactly as the sliders say —
  // shrinking a small chart's forces has no upside and would quietly change
  // every layout anybody has already tuned.
  return Math.max(1, s);
}

export const PHYSICS_DEFAULTS = {
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

export const LINK_COLOR_DEFAULTS = {
  spouse: '#9b59b6',   // partner / Ehepartner
  father: '#5b9bd5',   // father → child
  mother: '#d5729b',   // mother → child
  parent: '#3498db',   // FAM → child (bipartite mode)
};

export const NODE_COLOR_DEFAULTS = {
  male:    '#4a90d9',
  female:  '#e0608a',
  unknown: '#7e8fa8',
  fam:     '#2ecc71',
  famDiv:  '#e74c3c',
};

// A saturated orange reads against both the pale-grey OSM basemap and its blue
// water — the previous default (a soft blue at 45% opacity) all but vanished
// over water and over the tile grid's own blue road shields.
export const MAP_DOT_COLOR_DEFAULT = '#ff7a1a';

// How the name and the birth–death line inside each 2D box are drawn.
//
// This bag used to carry four more keys — textColor, bgEnabled, bgColor,
// bgOpacity — that nothing read. They were left over from a design where the
// label floated over the chart on its own background; it lives inside the box
// now, so the colour is computed for contrast against the box fill
// (contrastTextColor) and a background behind it would be a rectangle drawn on
// top of a rectangle. Settings that do nothing are worse than no setting: they
// are a control the reader turns and is told nothing by.
// A dead person's box is drawn faded. One number, because it used to be two
// that disagreed: the initial draw used 0.55 and applyHighlight() — which runs
// on any selection or highlight — repainted the same boxes at 0.5, so a chart
// changed appearance slightly the first time anything was clicked.
export const DECEASED_OPACITY = 0.55;

// What the chart is drawn on: --c-0 in styles.css. Needed as a number here
// because a faded box is part box colour and part whatever is behind it, and
// that mixture is what the label has to stay legible against.
export const GRAPH_BG = '#07090c';

export const LABEL_STYLE_DEFAULTS = {
  // In graph units, so it scales with the box rather than with the screen.
  // NODE_BOX_H is 30 and holds two lines, which is what caps this at 14.
  fontSize:    10,
  textOpacity: 1.0,
  fontWeight:  'normal',
};
export const LABEL_FONT_MAX = 14;

// The 3D scene's look. Same story as LABEL_STYLE_DEFAULTS: these were inline
// on state with nothing to reset them to.
export const APPEARANCE_3D_DEFAULTS = {
  bgColor:      '#000000',
  nodeOpacity:  1.0,
  linkOpacity:  1.0,
  ambientLight: 0.6,
  pointLight:   0.5,
  linkWidth:    3.1,
  nodeRelSize:  5.5,
};

export const TREE_SPACING_DEFAULTS = {
  row:   1,   // vertical distance between generations
  col:   1,   // horizontal distance between people in a row
  group: 1,   // extra clearance between one family's children and the next's
  side:  1,   // extra clearance where the father's and mother's ancestry meet
};

// The width below which the app lays itself out for a phone. One number rather
// than a literal repeated across the modules and the stylesheet's media
// queries — they have to agree, or a control styled as a phone control keeps
// its desktop behaviour (or the reverse).
export const MOBILE_MAX_WIDTH = 768;

// Both top-bar menus hang off a wrapper that sits partway along the bar, so
// they are anchored to that wrapper's edge. On a phone the menu is wider than
// the room on the side it opens towards and it runs clean off the screen —
// which is what the Tools menu did, taking half its labels with it. There the
// stylesheet pins the menu to the viewport instead (`position: fixed`, an inset
// on both sides); only the vertical placement needs a measurement, because the
// bar wraps to a different number of rows depending on how much fits.
export function placeTopbarMenu(dd) {
  if (!dd) return;
  if (window.innerWidth > MOBILE_MAX_WIDTH) { dd.style.top = ''; return; }
  const bar = document.getElementById('topbar');
  dd.style.top = (bar ? Math.round(bar.getBoundingClientRect().bottom) + 4 : 48) + 'px';
}
