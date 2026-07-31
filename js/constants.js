// Shared numeric/style constants used by more than one module.

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
};

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
