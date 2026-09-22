// Every setting that survives a reload, in one table.
//
// Before this file each setting did its own localStorage dance at whichever
// call site happened to change it: a `'1'`/`'0'` here, a `String(bool)` there,
// a bare `JSON.stringify` somewhere else, and the matching read a hundred lines
// away in state.js. Three consequences, all of which were live bugs:
//
//  · Settings that had a control but no write. The node and link colour
//    pickers, the label style, the physics sliders and both 3D toggles changed
//    the running app and were gone on reload — while everything beside them in
//    the same panel came back. Nothing said which was which.
//  · No shared validation. scene3d checked that what came back was a finite
//    number (a hand-edited zero there empties the 3D view with no way back);
//    the other four object settings did not, so a corrupt entry put a string
//    into an opacity and the scene rendered blank.
//  · No way out. There was no "put it all back", and no way to carry a tuned
//    setup to another machine.
//
// Storage keys are unchanged from what the scattered code wrote, so an existing
// install keeps its settings. The readers accept both spellings of a stored
// boolean ('1'/'0' and 'true'/'false') for the same reason.
import {
  APPEARANCE_3D_DEFAULTS, LABEL_STYLE_DEFAULTS, LINK_COLOR_DEFAULTS, MAP_DOT_COLOR_DEFAULT,
  NODE_COLOR_DEFAULTS, PHYSICS_DEFAULTS, SCENE_DEFAULTS, TREE_SPACING_DEFAULTS,
} from './constants.js';

// localStorage throws rather than returning null when a browser has storage
// disabled — Safari's private mode is the usual one. state.js read it at module
// scope, so that throw took down the entire module graph and the app showed a
// blank page. Nothing here can throw; a browser without storage just gets the
// defaults every time.
export function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
export function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* nothing to remove from */ }
}

/**
 * The registry. `def` is both the default value and the declaration of the
 * setting's type — a boolean default means the stored string is read back as a
 * boolean, an object default means the stored JSON is merged over it key by key
 * and any key the default does not have is dropped.
 *
 * `def` may be a function for the few whose default depends on the device.
 * `values` restricts a string setting to a fixed set; anything else read back
 * falls to the default rather than being handed on to the renderer.
 */
export const SETTINGS = {
  // ── View and focus ──
  viewMode:            { def: '3d', values: ['2d', '3d'] },
  treeLayout:          { def: true },
  focusLimit:          { def: 120, min: 1 },
  cousinDegree:        { def: 1, min: 0, max: 8 },
  includeSpouseFamily: { def: false },

  // ── Colour ──
  colorBySurname:      { def: true },
  surnameCustomColors: { def: {}, freeform: true },   // surname -> hex, keys are data
  linkColors:          { def: LINK_COLOR_DEFAULTS },
  nodeColors:          { def: NODE_COLOR_DEFAULTS },
  mapDotColor:         { def: MAP_DOT_COLOR_DEFAULT },
  treeLineageColoring: { def: false },

  // ── 2D chart ──
  labelStyle:          { def: LABEL_STYLE_DEFAULTS },
  treeSpacing:         { def: TREE_SPACING_DEFAULTS, min: 0 },
  famNodeSize:         { def: 7, min: 0, max: 40 },
  physics:             { def: PHYSICS_DEFAULTS },

  // ── 3D scene ──
  stratify3D:          { def: 'time', values: ['time', 'generation', 'off'] },
  showTimeline3D:      { def: true },
  // Every 3D name label is its own canvas texture. A hundred of them on a
  // 390px screen is an unreadable mat of boxes that also costs more texture
  // memory than the rest of the scene, so a phone starts without them.
  show3DNames:         { def: () => typeof window === 'undefined' || window.innerWidth > 768 },
  appearance3d:        { def: APPEARANCE_3D_DEFAULTS },
  scene3d:             { def: SCENE_DEFAULTS, min: 0 },
  instanced3d:         { def: true },
  cull3d:              { def: false },
  timeSpread3D:        { def: null },   // null = follow the tree size; a number = the reader's own
  font3D:              { def: 18, min: 1, max: 200 },

  // ── Data ──
  // Photos, video and documents on people and families. Off hides every media
  // control; the records themselves are still read and written back untouched.
  mediaEnabled:        { def: true },
  // Mark people born (or estimated born) over 110 years ago as deceased. On by
  // default — it is how the app has always behaved — but it writes `1 DEAT Y`
  // from a guess, and some researchers want no guess in their file at all.
  autoDeceased:        { def: true },

  // ── Diagnostics ──
  // Render timings, off by default: on, every repaint writes a dozen lines into
  // the console of anyone actually using the app.
  perfLog:             { def: false },
};

export function defaultOf(key) {
  const d = SETTINGS[key]?.def;
  const v = typeof d === 'function' ? d() : d;
  return v && typeof v === 'object' ? structuredClone(v) : v;
}

function coerceNumber(v, spec) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (spec.min != null && n < spec.min) return null;
  if (spec.max != null && n > spec.max) return null;
  return n;
}

/** Read one setting, falling back to its default whenever what came back is
 *  missing, malformed, or outside the range the setting is declared with. */
export function readSetting(key) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`unknown setting: ${key}`);
  const def = defaultOf(key);
  const raw = lsGet(key);
  if (raw == null) return def;

  if (typeof def === 'boolean') {
    if (raw === '1' || raw === 'true')  return true;
    if (raw === '0' || raw === 'false') return false;
    return def;
  }
  if (typeof def === 'number' || (def === null && spec.def === null)) {
    return coerceNumber(raw, spec) ?? def;
  }
  if (typeof def === 'string') {
    if (spec.values && !spec.values.includes(raw)) return def;
    return raw;
  }
  // Object: merge over the default, one key at a time, so a partial or
  // half-corrupt entry costs only the keys that are actually bad.
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return def; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return def;
  if (spec.freeform) {
    // The keys are data (surnames), not a fixed schema — keep the strings.
    const out = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  }
  for (const k of Object.keys(def)) {
    if (!(k in parsed)) continue;
    const dv = def[k];
    const pv = parsed[k];
    if (typeof dv === 'number') {
      const n = coerceNumber(pv, spec);
      if (n !== null) def[k] = n;
    } else if (typeof dv === typeof pv) {
      def[k] = pv;
    }
  }
  return def;
}

/** Write one setting. Objects go in as JSON, booleans as '1'/'0'. */
export function writeSetting(key, value) {
  if (!SETTINGS[key]) throw new Error(`unknown setting: ${key}`);
  if (value === undefined || value === null) return lsRemove(key);
  if (typeof value === 'boolean')            return lsSet(key, value ? '1' : '0');
  if (typeof value === 'object')             return lsSet(key, JSON.stringify(value));
  return lsSet(key, String(value));
}

// Writes arrive at slider rate — one per pixel of travel — and localStorage is
// synchronous and hits the disk. Coalesce to one write per key.
const _writeTimers = new Map();
export function saveSetting(key, value, delay = 200) {
  clearTimeout(_writeTimers.get(key));
  _writeTimers.set(key, setTimeout(() => {
    _writeTimers.delete(key);
    writeSetting(key, value);
  }, delay));
}

/** Everything currently stored, defaults included — the shape import() takes. */
export function exportSettings() {
  const out = {};
  for (const key of Object.keys(SETTINGS)) out[key] = readSetting(key);
  return out;
}

/** Apply a previously exported bag. Unknown keys are ignored rather than
 *  stored, so a file from a newer version cannot wedge an older one. Returns
 *  how many settings were actually taken. */
export function importSettings(bag) {
  if (!bag || typeof bag !== 'object') return 0;
  let n = 0;
  for (const [key, value] of Object.entries(bag)) {
    if (!SETTINGS[key]) continue;
    writeSetting(key, value);
    n++;
  }
  return n;
}

/** Clear every setting this registry owns, and nothing else — the autosaved
 *  GEDCOM and the geocoded place cache live in localStorage too, and losing
 *  either to a "reset the colours" click would be unforgivable. */
export function resetSettings() {
  for (const key of Object.keys(SETTINGS)) lsRemove(key);
}
