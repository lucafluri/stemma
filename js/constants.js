// Shared numeric/style constants used by more than one module.

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
