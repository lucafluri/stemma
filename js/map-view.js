/**
 * Map view — where the tree happened, and when.
 *
 * Every birth, death and marriage in the file carries a place name and (often)
 * a year. Those two fields are already in the data; nothing in the app has ever
 * put them on a map. This does: one circle per place, sized by how much
 * happened there, filtered by a year range that can be swept forwards to watch
 * a family drift across a valley over three centuries.
 *
 * ── Coordinates ──────────────────────────────────────────────────────────────
 * GEDCOM place names are free text: "Luterbach", "Bern, Schweiz". There are no
 * coordinates in the file, so they have to come from somewhere. They come from
 * Nominatim (OpenStreetMap's geocoder), one place at a time, *only* when the
 * user presses the button — the rest of this app never sends anything anywhere,
 * and looking up a place name means sending that place name to a third party.
 * Results are cached in localStorage, so the trip is made once per spelling.
 *
 * The basemap tiles are the other network call, and that one is unavoidable for
 * a map worth looking at. It reveals which part of the world is being looked at
 * and nothing from the file. Without a connection the circles still draw, just
 * over an empty background.
 */

import { MAP_DOT_COLOR_DEFAULT } from './constants.js';
import { _setDirty, escHtml, escJs } from './gedcom-io.js';
import { showIndiDetail } from './panels.js';
import { placeFields, placeKey } from './places.js';
import { zoomToNode } from './render-2d.js';
import { state } from './state.js';

const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const COORD_LS = 'placeCoords';

// Nominatim's usage policy is one request per second. Undercutting it is not
// clever, it just gets the whole app blocked.
const GEOCODE_DELAY = 1100;

const EVENT_TYPES = ['birth', 'death', 'marriage'];

// ── Coordinate cache ──────────────────────────────────────────────────────────
//
// Keyed by the folded place name (see places.js), so "Zürich" and "zurich "
// share one lookup. A `null` value means "asked, nothing found" — recorded so
// the next run does not ask again for a place that is not going to resolve.

let _coords = null;

export function placeCoords() {
  if (_coords) return _coords;
  _coords = new Map();
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(COORD_LS) || '{}'))) {
      _coords.set(k, v);
    }
  } catch (e) { /* corrupt cache is an empty cache */ }
  return _coords;
}

function _saveCoords() {
  try {
    localStorage.setItem(COORD_LS, JSON.stringify(Object.fromEntries(placeCoords())));
  } catch (e) { /* quota — the map still works, it just re-looks-up next time */ }
}

/**
 * Note a coordinate someone else already knew — currently the import wizard,
 * whose reader flattens people to string fields and so has nowhere on the
 * record to keep a MAP subtree it found.
 *
 * It does not overwrite: a coordinate the user looked up or corrected in this
 * browser is a deliberate answer, and an imported file's guess should not
 * silently replace it.
 */
export function rememberPlaceCoords(plac, ll) {
  const key = placeKey(plac);
  if (!key || !Array.isArray(ll) || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return false;
  const coords = placeCoords();
  if (coords.get(key)) return false;
  coords.set(key, [ll[0], ll[1]]);
  _saveCoords();
  return true;
}

// ── The events ────────────────────────────────────────────────────────────────

/** First 3–4 digit run in a GEDCOM date. "12 MAR 1876" → 1876. */
export function eventYear(s) {
  const m = String(s == null ? '' : s).match(/\b(\d{3,4})\b/);
  return m ? +m[1] : null;
}

/**
 * Every placed event in the file: births, deaths and marriages that name a
 * place. `year` is null when the record has no usable date — those are real
 * events at real places and are not dropped, they simply cannot take part in
 * the time filter (see `filterEvents`).
 *
 * Read straight off `state.individuals` / `state.families` rather than off the
 * graph: the map is about the whole file, and the graph may be narrowed to one
 * person's relatives.
 */
export function collectMapEvents() {
  const out = [];
  // `ll` is whatever the record itself already says, which is how a GEDCOM that
  // arrives with MAP subtrees draws on the map without being geocoded at all.
  const ll = f => (Array.isArray(f.map) && Number.isFinite(f.map[0]) && Number.isFinite(f.map[1]))
    ? [f.map[0], f.map[1]] : null;

  for (const p of state.individuals.values()) {
    const name = p.name || p.id;
    if (p.birth?.plac) {
      out.push({ type: 'birth', plac: p.birth.plac, year: eventYear(p.birth.date) ?? p.birthYear ?? null, id: p.id, name, ll: ll(p.birth) });
    }
    if (p.death?.plac) {
      out.push({ type: 'death', plac: p.death.plac, year: eventYear(p.death.date), id: p.id, name, ll: ll(p.death) });
    }
  }
  for (const f of state.families.values()) {
    for (const m of f.marriages || []) {
      if (!m.plac) continue;
      const partners = [f.husb, f.wife]
        .map(id => state.individuals.get(id)?.name)
        .filter(Boolean);
      out.push({
        type: 'marriage', plac: m.plac, year: eventYear(m.date),
        id: f.husb || f.wife || null,
        name: partners.length ? partners.join(' & ') : f.id,
        ll: ll(m),
      });
    }
  }
  return out;
}

/** The year range the events cover, or null when none of them is dated. */
export function eventYearRange(events) {
  const years = events.map(e => e.year).filter(y => y != null);
  if (!years.length) return null;
  return { min: Math.min(...years), max: Math.max(...years) };
}

/**
 * Narrow to what the controls currently ask for. Undated events are in or out
 * as a whole — there is no honest way to place them on a timeline, and quietly
 * showing them at every position would make the sweep say things the file does
 * not.
 */
export function filterEvents(events, { from, to, types, undated }) {
  return events.filter(e => {
    if (types && !types[e.type]) return false;
    if (e.year == null) return !!undated;
    return e.year >= from && e.year <= to;
  });
}

/**
 * Group events by place name, attaching coordinates where they are known.
 * Places that have never been looked up (or that came back empty) still get an
 * entry, with `ll: null` — the count of those is what the "look up places"
 * button reports on.
 *
 * The cache is consulted before the record: it holds what the user has most
 * recently looked up or corrected, and a correction has to move the pin
 * straight away rather than only after it has been written to the tree.
 */
export function groupByPlace(events, coords = placeCoords()) {
  const byPlace = new Map();
  for (const e of events) {
    let g = byPlace.get(e.plac);
    if (!g) byPlace.set(e.plac, g = { plac: e.plac, events: [], ll: coords.get(placeKey(e.plac)) || null });
    if (!g.ll && e.ll) g.ll = e.ll;
    g.events.push(e);
  }
  return [...byPlace.values()].sort((a, b) => b.events.length - a.events.length);
}

// ── Writing coordinates into the records ──────────────────────────────────────
//
// The cache above is a browser thing: it survives a reload and nothing else.
// Coordinates only become part of the family tree once they are written onto
// the event fields as `map: [lat, lon]`, where the GEDCOM/JSON/YAML exporters
// pick them up (GEDCOM emits the standard `3 MAP / 4 LATI / 4 LONG` subtree
// under the event's PLAC, which is what other genealogy software reads).
//
// That write is not automatic. A geocoder guesses: ask it for "Freiburg" and it
// picks one of two countries, and it will not tell you it had a choice. Putting
// that guess into the file the moment it arrives would quietly fill a
// hand-checked tree with plausible mistakes — so the map only offers it, one
// place at a time, and the user ticks what goes in.

/**
 * Which places have a cached coordinate that is not yet in the records, and
 * which fields each of them would write to.
 *
 * Returns Map<placeName, { plac, ll, fields }>. A place whose fields already
 * carry exactly this coordinate is not listed — there is nothing to approve.
 */
export function coordWriteTargets(coords = placeCoords()) {
  const out = new Map();
  for (const f of placeFields()) {
    if (!f.plac) continue;
    const ll = coords.get(placeKey(f.plac));
    if (!ll) continue;
    if (Array.isArray(f.map) && f.map[0] === ll[0] && f.map[1] === ll[1]) continue;
    let g = out.get(f.plac);
    if (!g) out.set(f.plac, g = { plac: f.plac, ll, fields: [] });
    g.fields.push(f);
  }
  return out;
}

/**
 * Write the approved places' coordinates onto their event fields and mark the
 * file dirty, so the next save carries them. Returns how many fields changed.
 */
export function applyMapCoords(approved, coords = placeCoords()) {
  let changed = 0;
  for (const g of coordWriteTargets(coords).values()) {
    if (!approved.has(g.plac)) continue;
    for (const f of g.fields) { f.map = [g.ll[0], g.ll[1]]; changed++; }
  }
  if (changed) _setDirty(true);
  return changed;
}

// ── Web Mercator ──────────────────────────────────────────────────────────────

// Latitudes past this do not exist in Web Mercator (the projection runs to
// infinity at the poles); every tile server clips here.
const MAX_LAT = 85.05112878;

/** lon/lat in degrees → x/y in the unit square, north-west at (0, 0). */
export function project(lon, lat) {
  const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/**
 * Which raster tiles cover the viewport, given a d3 zoom transform whose `k` is
 * the width of the whole world in screen pixels.
 *
 * `i` is allowed to run outside [0, 2^z) so the map keeps drawing when it is
 * panned past the antimeridian; the tile actually fetched is the wrapped one.
 */
export function visibleTiles(t, w, h, maxZoom = 19) {
  const z = Math.max(0, Math.min(maxZoom, Math.round(Math.log2(t.k / 256))));
  const n = 2 ** z, size = t.k / n;
  const out = [];
  if (!(size > 0)) return out;
  const i0 = Math.floor(-t.x / size), i1 = Math.ceil((w - t.x) / size);
  const j0 = Math.max(0, Math.floor(-t.y / size)), j1 = Math.min(n, Math.ceil((h - t.y) / size));
  for (let i = i0; i < i1; i++) {
    const wx = ((i % n) + n) % n;
    for (let j = j0; j < j1; j++) {
      out.push({ key: `${z}/${wx}/${j}/${i}`, z, x: wx, y: j, sx: t.x + i * size, sy: t.y + j * size, size });
    }
  }
  return out;
}

// ── View state ────────────────────────────────────────────────────────────────
//
// Lives in the module rather than in `state`: nothing outside the dialog reads
// any of it, and it is rebuilt from the file every time the dialog opens.

const M = {
  events: [],
  groups: [],         // the filtered events, grouped by place
  range: null,        // { min, max } over the file, for the slider bounds
  from: 0, to: 0,
  types: { birth: true, death: true, marriage: true },
  undated: false,
  unticked: new Set(),   // places the user took the coordinate tick off
  fixQuery: null,        // what is in the correction box (survives its re-render)
  fixResults: null,      // candidates from the last correction search
  fixBusy: false,
  fixError: null,
  transform: null,    // { k, x, y }; k is the width of the whole world in px
  selected: null,     // place name whose event list is open
  play: null,         // interval handle
  geocoding: false,
};

function _el(id) { return document.getElementById(id); }

export function openMapView() {
  const modal = _el('map-modal');
  if (!modal) return;

  M.events = collectMapEvents();
  M.range = eventYearRange(M.events);
  M.selected = null;
  M.fixQuery = M.fixResults = M.fixError = null;
  M.fixBusy = false;
  if (M.range) { M.from = M.range.min; M.to = M.range.max; }
  else { M.from = 0; M.to = 0; }

  for (const type of EVENT_TYPES) {
    const cb = _el('map-type-' + type);
    if (cb) cb.checked = M.types[type];
  }
  const und = _el('map-undated');
  if (und) und.checked = M.undated;
  const dotColor = _el('map-dot-color');
  if (dotColor) dotColor.value = state.mapDotColor;

  _syncSliders();
  modal.style.display = 'flex';
  _watchMapSize();
  // The SVG has no size until it is on screen, so the first fit has to wait for
  // layout — measuring a display:none element gives 0×0 and a NaN transform.
  requestAnimationFrame(() => { M.transform = null; renderMap(); });
}

let _sizeObserver = null;

/**
 * Redraw whenever the canvas changes size. Every tile position is computed from
 * a measurement, so a stale one leaves an unpainted band along whichever edge
 * grew — which is what the first paint did, drawing before the flex layout had
 * settled to its final height. Window resizes and phone rotations were the same
 * bug, just triggered later.
 */
function _watchMapSize() {
  if (_sizeObserver || typeof ResizeObserver === 'undefined') return;
  const canvas = _el('map-canvas');
  if (!canvas) return;
  // A resize that lands *before* the first draw has to be handled too, or the
  // draw that follows keeps the size it was measured at and leaves a strip of
  // background along the edge that grew. Whether that happens is a race with
  // font loading, which is exactly the kind of bug that reproduces on one
  // machine and not the next — so both orders go down the same path.
  _sizeObserver = new ResizeObserver(() => {
    if (_el('map-modal')?.style.display !== 'flex') return;
    if (M.transform) _draw(); else renderMap();
  });
  _sizeObserver.observe(canvas);
}

export function closeMapView() {
  stopMapPlay();
  const modal = _el('map-modal');
  if (modal) modal.style.display = 'none';
}

function _syncSliders() {
  const lo = _el('map-year-from'), hi = _el('map-year-to');
  if (!lo || !hi) return;
  const { min, max } = M.range || { min: 0, max: 0 };
  for (const s of [lo, hi]) { s.min = min; s.max = max; s.disabled = !M.range; }
  lo.value = M.from;
  hi.value = M.to;
  const out = _el('map-year-label');
  if (out) out.textContent = M.range ? `${M.from} – ${M.to}` : '–';
}

/** Both handles read together, so dragging one never puts it past the other. */
export function onMapYearInput() {
  const lo = _el('map-year-from'), hi = _el('map-year-to');
  if (!lo || !hi) return;
  M.from = Math.min(+lo.value, +hi.value);
  M.to = Math.max(+lo.value, +hi.value);
  _syncSliders();
  renderMap();
}

export function onMapFilterChange() {
  for (const type of EVENT_TYPES) M.types[type] = !!_el('map-type-' + type)?.checked;
  M.undated = !!_el('map-undated')?.checked;
  renderMap();
}

/** The dots' fill color, user-adjustable for contrast against whatever basemap
 * area they land on — a single hue can never suit every tile colour, so this
 * is a preference rather than a fixed choice. */
export function setMapDotColor(color) {
  state.mapDotColor = color;
  localStorage.setItem('mapDotColor', color);
  if (M.transform) _draw(); else renderMap();
}

export function resetMapDotColor() {
  state.mapDotColor = MAP_DOT_COLOR_DEFAULT;
  localStorage.setItem('mapDotColor', state.mapDotColor);
  const el = _el('map-dot-color');
  if (el) el.value = state.mapDotColor;
  if (M.transform) _draw(); else renderMap();
}

// ── Sweeping through time ─────────────────────────────────────────────────────

/**
 * Grow the window forward from the "from" year the user set, which stays put —
 * only "to" sweeps upward. That keeps the animation anchored on the start year
 * the reader picked instead of silently overriding it, and it still shows
 * movement: everything born or married after "from" accumulates on the map as
 * "to" advances, then the sweep restarts from a thin window once it tops out.
 */
export function toggleMapPlay() {
  if (M.play) return stopMapPlay();
  if (!M.range) return;
  const span = Math.max(1, M.range.max - M.from);
  const step = Math.max(1, Math.round(span / 60));
  const restart = () => Math.min(M.range.max, M.from + Math.max(1, Math.round(span / 8)));
  if (M.to >= M.range.max) M.to = restart();
  M.play = setInterval(() => {
    M.to += step;
    if (M.to > M.range.max) M.to = restart();
    _syncSliders();
    renderMap();
  }, 350);
  _syncPlayBtn();
}

export function stopMapPlay() {
  if (M.play) clearInterval(M.play);
  M.play = null;
  _syncPlayBtn();
}

function _syncPlayBtn() {
  const btn = _el('map-play-btn');
  if (!btn) return;
  btn.textContent = M.play ? '⏸' : '▶';
  btn.title = t(M.play ? 'map.pause' : 'map.play');
}

// ── Geocoding ─────────────────────────────────────────────────────────────────

/**
 * Look up every place that has no coordinates yet, one per second, writing each
 * result into the cache as it arrives so the map fills in while it runs and a
 * cancelled run keeps what it already found.
 */
/**
 * Places nothing can locate — no cached lookup and no coordinate in the record.
 * Counted over the whole file, not the filtered view: it is a statement about
 * how much work is left, not about what is on screen.
 */
function _unlocatedPlaces() {
  const coords = placeCoords();
  return groupByPlace(M.events, coords).filter(g => !g.ll).map(g => g.plac);
}

export async function geocodeMapPlaces() {
  if (M.geocoding) { M.geocoding = false; return; }   // second press cancels

  const coords = placeCoords();
  // Places the file already located are left alone. Re-asking about them would
  // spend a second each to replace something the file was more sure of.
  const missing = _unlocatedPlaces().filter(p => !coords.has(placeKey(p)));
  if (!missing.length) { _setMapStatus(t('map.allLocated')); return; }

  if (!confirm(t('map.geocodeConfirm', { count: missing.length }))) return;

  M.geocoding = true;
  _syncGeocodeBtn();
  let found = 0;
  for (let i = 0; i < missing.length; i++) {
    if (!M.geocoding) break;
    const plac = missing[i];
    _setMapStatus(t('map.geocoding', { done: i, total: missing.length, place: plac }));
    let hit = null, answered = false;
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(plac)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const json = await res.json();
        answered = true;
        if (json[0]) hit = [+json[0].lat, +json[0].lon];
      }
    } catch (e) { /* offline or blocked */ }

    // "Not found" is cached, a failed request is not. A dropped connection or a
    // rate-limit 429 is not an answer about the place, and caching it as one
    // would quietly retire that spelling forever.
    if (answered) coords.set(placeKey(plac), hit);
    if (hit) found++;
    _saveCoords();
    renderMap();
    if (i < missing.length - 1) await new Promise(r => setTimeout(r, GEOCODE_DELAY));
  }

  M.geocoding = false;
  _syncGeocodeBtn();
  _setMapStatus(t('map.geocodeDone', { found, total: missing.length }));
}

function _syncGeocodeBtn() {
  const btn = _el('map-geocode-btn');
  if (btn) btn.textContent = M.geocoding ? t('map.geocodeStop') : t('map.geocode');
}

// ── Correcting a geocode ──────────────────────────────────────────────────────
//
// The batch lookup takes the geocoder's first answer, and the first answer is
// often the wrong one: "Freiburg" is a city in Germany and a canton in
// Switzerland, "Basel" is also a village in Ohio. The batch cannot ask, so this
// is where it gets asked — the same query, its first few answers, and the one
// the reader recognises. The corrected coordinate goes into the cache, which
// moves the pin at once and offers itself for writing like any other.

/** Ask Nominatim for several candidates rather than the single best guess. */
export async function searchPlaceCandidates(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `${NOMINATIM}?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).map(r => ({
    label: r.display_name || q,
    ll: [+r.lat, +r.lon],
  })).filter(c => Number.isFinite(c.ll[0]) && Number.isFinite(c.ll[1]));
}

/** Run the search for the open place and list what came back. */
export async function runPlaceFix() {
  const plac = M.selected;
  const input = _el('map-fix-query');
  if (!plac || !input) return;
  // Captured before the re-render below wipes the box out from under it.
  M.fixQuery = input.value;
  M.fixResults = null;
  M.fixError = null;
  M.fixBusy = true;
  _renderPlaceList();
  try {
    M.fixResults = await searchPlaceCandidates(M.fixQuery);
  } catch (e) {
    M.fixError = String(e.message || e);
  }
  M.fixBusy = false;
  // The dialog may have moved on while the request was in flight.
  if (M.selected === plac) _renderPlaceList();
}

/** Adopt one of the candidates as this place's coordinate. */
export function pickPlaceCandidate(idx) {
  const c = (M.fixResults || [])[idx];
  if (!c || !M.selected) return;
  placeCoords().set(placeKey(M.selected), [c.ll[0], c.ll[1]]);
  _saveCoords();
  // A place the user just corrected is a place they want written, whatever they
  // had ticked before seeing the wrong pin.
  M.unticked.delete(M.selected);
  M.fixResults = null;
  renderMap();
  selectMapPlace(M.selected);
  _setMapStatus(t('map.fixed', { place: M.selected }));
}

/**
 * Forget this place's coordinate — from the cache and from the records both.
 * Half a removal is worse than none: leaving it on the records would keep the
 * pin exactly where the reader just said it does not belong.
 */
export function clearPlaceCoord() {
  const plac = M.selected;
  if (!plac) return;
  placeCoords().delete(placeKey(plac));
  _saveCoords();
  let cleared = 0;
  for (const f of placeFields()) {
    if (f.plac === plac && f.map) { delete f.map; cleared++; }
  }
  if (cleared) _setDirty(true);
  M.fixResults = null;
  renderMap();
  selectMapPlace(plac);
  _setMapStatus(t('map.coordCleared', { place: plac }));
}

function _setMapStatus(msg) {
  const el = _el('map-status');
  if (el) el.textContent = msg;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const R_MIN = 4, R_MAX = 26;

function _radius(n, maxN) {
  if (maxN <= 1) return R_MIN + 4;
  return R_MIN + (R_MAX - R_MIN) * Math.sqrt(n) / Math.sqrt(maxN);
}

/** Fit the transform around the located places, or the whole world if none. */
function _fitTransform(located, w, h) {
  const k0 = Math.max(w, h);
  if (!located.length) return { k: k0, x: (w - k0) / 2, y: (h - k0) / 2 };

  const pts = located.map(g => project(g.ll[1], g.ll[0]));
  const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
  const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
  // A single place has no extent at all, and dividing by it gives Infinity —
  // fall back to a street-level scale so one located place is still readable.
  const pad = 60;
  const k = Math.min(
    (x1 - x0) > 1e-9 ? (w - 2 * pad) / (x1 - x0) : 1 << 18,
    (y1 - y0) > 1e-9 ? (h - 2 * pad) / (y1 - y0) : 1 << 18,
  );
  const kk = Math.max(256, Math.min(k, 1 << 21));
  return { k: kk, x: w / 2 - kk * (x0 + x1) / 2, y: h / 2 - kk * (y0 + y1) / 2 };
}

let _zoom = null;

/**
 * Move the map. d3.zoom keeps its own transform on the node, so every
 * programmatic move goes through `zoom.transform` — setting `M.transform`
 * directly would leave the next wheel gesture snapping back to wherever the
 * behaviour still thought it was.
 */
function _applyTransform(svg, tr) {
  M.transform = tr;
  if (typeof d3 !== 'undefined' && d3.zoom) {
    if (!_zoom) {
      _zoom = d3.zoom()
        .scaleExtent([256, 1 << 22])
        .on('zoom', ev => { M.transform = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y }; _draw(); });
      d3.select(svg).call(_zoom);
    }
    d3.select(svg).call(_zoom.transform, d3.zoomIdentity.translate(tr.x, tr.y).scale(tr.k));
  }
  // The line above already redraws by way of the zoom event, but only when d3
  // is really there and really fires it. Drawing here as well costs one extra
  // pass on a programmatic move and means the map is never left blank.
  _draw();
}

export function renderMap() {
  const svg = _el('map-svg');
  if (!svg) return;

  const shown = filterEvents(M.events, { from: M.from, to: M.to, types: M.types, undated: M.undated });
  M.groups = groupByPlace(shown);

  const rect = svg.getBoundingClientRect();
  const w = rect.width || 800, h = rect.height || 600;

  const summary = _el('map-summary');
  if (summary) {
    summary.textContent = t('map.summary', {
      shown: shown.length, total: M.events.length, places: M.groups.length,
      missing: _unlocatedPlaces().length,
    });
  }
  _syncGeocodeBtn();

  _renderPlaceList();

  if (!M.transform) _applyTransform(svg, _fitTransform(groupByPlace(M.events).filter(g => g.ll), w, h));
  else _draw();
}

// The size the last draw was laid out for. Every tile position comes from a
// measurement, and a draw that happens while the flex layout is still settling
// measures a box that is about to grow — leaving an unpainted strip along the
// edge that grew. Rather than trying to be called at exactly the right moment
// (a race against font loading, which lands differently on every machine), a
// draw that finds the size has moved since the last one simply schedules
// another. It converges after one extra frame and costs nothing once still.
let _lastDrawSize = '';

function _draw() {
  const svg = _el('map-svg');
  if (!svg || !M.transform) return;
  const rect = svg.getBoundingClientRect();
  const w = rect.width || 800, h = rect.height || 600;
  const t0 = M.transform;

  const size = `${Math.round(w)}x${Math.round(h)}`;
  if (size !== _lastDrawSize) {
    _lastDrawSize = size;
    requestAnimationFrame(_draw);
  }

  // Tiles are plain <image> elements keyed by z/x/y, reused across redraws so
  // panning does not re-request a tile the browser already has decoded.
  const tiles = _el('map-tiles'), points = _el('map-points');
  if (!tiles || !points) return;
  const keep = new Set();
  for (const tile of visibleTiles(t0, w, h)) {
    keep.add(tile.key);
    let img = tiles.querySelector(`[data-key="${tile.key}"]`);
    if (!img) {
      img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      img.dataset.key = tile.key;
      img.setAttribute('href', TILE_URL(tile.z, tile.x, tile.y));
      img.setAttribute('preserveAspectRatio', 'none');
      tiles.appendChild(img);
    }
    img.setAttribute('x', tile.sx);
    img.setAttribute('y', tile.sy);
    // A hair of overlap: the sizes are fractional and exact edges leave seams.
    img.setAttribute('width', tile.size + 1);
    img.setAttribute('height', tile.size + 1);
  }
  for (const img of [...tiles.children]) if (!keep.has(img.dataset.key)) img.remove();

  const located = (M.groups || []).filter(g => g.ll);
  const maxN = located.reduce((m, g) => Math.max(m, g.events.length), 0);
  points.innerHTML = located.map(g => {
    const [px, py] = project(g.ll[1], g.ll[0]);
    const cx = t0.x + t0.k * px, cy = t0.y + t0.k * py;
    if (cx < -50 || cy < -50 || cx > w + 50 || cy > h + 50) return '';
    const r = _radius(g.events.length, maxN);
    const sel = g.plac === M.selected ? ' map-dot--sel' : '';
    // A CSS class rule always wins over a plain fill="" attribute (a
    // presentation attribute sits below the stylesheet in the cascade), so
    // .map-dot's own `fill` silently ate the picked colour every time. An
    // inline style="" outranks the stylesheet and actually shows through.
    const fill = sel ? '' : ` style="fill:${state.mapDotColor}"`;
    return `<circle class="map-dot${sel}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"${fill}
              onclick="selectMapPlace('${escJs(g.plac)}')"><title>${escHtml(g.plac)} — ${g.events.length}</title></circle>`;
  }).join('');
}

/**
 * The list beside the map. With nothing selected it ranks the places in view;
 * selecting one swaps it for that place's events, so the map is a way into the
 * people rather than a picture of them.
 *
 * Rendered from `renderMap`, not from `_draw`: it depends on the filters and
 * not on the viewport, and re-emitting it on every wheel tick would throw away
 * the coordinate tick-boxes mid-decision.
 */
function _renderPlaceList() {
  const box = _el('map-list');
  if (!box) return;
  const groups = M.groups || [];
  const pending = coordWriteTargets();

  if (M.selected) {
    const g = groups.find(x => x.plac === M.selected);
    if (g) {
      const rows = [...g.events]
        .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
        .map(e => `<button class="map-row" onclick="mapGoToPerson('${escJs(e.id)}')">
            <span class="map-row-year">${e.year ?? '—'}</span>
            <span class="map-row-name">${escHtml(e.name)}</span>
            <span class="map-row-type map-row-type--${e.type}">${escHtml(t('map.type.' + e.type))}</span>
          </button>`).join('');
      box.innerHTML = `<button class="map-back" onclick="selectMapPlace(null)">&#x2190; ${escHtml(t('map.allPlaces'))}</button>
        <div class="map-list-title">${escHtml(g.plac)}</div>${_fixBlock(g)}${rows}`;
      return;
    }
    M.selected = null;
  }

  // A place with a coordinate the records do not have yet gets a tick-box: that
  // tick is the approval, and nothing is written to the tree without it.
  const row = g => {
    const p = pending.get(g.plac);
    const btn = `<button class="map-row${g.ll ? '' : ' map-row--unlocated'}" onclick="selectMapPlace('${escJs(g.plac)}')"
             title="${escHtml(g.ll ? g.plac : t('map.unlocated'))}">
       <span class="map-row-name">${escHtml(g.plac)}</span>
       <span class="map-row-year">${g.events.length}</span>
     </button>`;
    if (!p) return btn;
    const tick = M.unticked.has(g.plac) ? '' : ' checked';
    return `<div class="map-row-wrap">
      <input type="checkbox" class="map-tick" data-plac="${escHtml(g.plac)}"${tick}
             onchange="onMapTick('${escJs(g.plac)}', this.checked)"
             title="${escHtml(t('map.writeOne', { lat: p.ll[0].toFixed(4), lon: p.ll[1].toFixed(4) }))}">
      ${btn}</div>`;
  };

  box.innerHTML = `<div class="map-list-title">${escHtml(t('map.places'))}</div>`
    + (groups.map(row).join('') || `<div class="pl-empty">${escHtml(t('map.noEvents'))}</div>`);

  // The button counts only what is both ticked and on screen, because that is
  // exactly what pressing it will write.
  const btn = _el('map-save-coords-btn');
  if (btn) {
    const n = groups.filter(g => pending.has(g.plac) && !M.unticked.has(g.plac)).length;
    btn.style.display = n ? '' : 'none';
    btn.textContent = t('map.writeCoords', { count: n });
  }
}

/**
 * The correction panel for the open place: where it currently sits, a query to
 * search again with, and whatever came back. Shown for every selected place,
 * located or not — "wrong" and "missing" are the same job from the reader's
 * side, and a place the batch skipped is fixed here too.
 */
function _fixBlock(g) {
  const here = g.ll
    ? `<span class="map-coord">${g.ll[0].toFixed(4)}, ${g.ll[1].toFixed(4)}</span>
       <button class="map-fix-clear" onclick="clearPlaceCoord()">${escHtml(t('map.clearCoord'))}</button>`
    : `<span class="map-coord map-coord--none">${escHtml(t('map.unlocated'))}</span>`;

  let results = '';
  if (M.fixBusy) {
    results = `<div class="map-fix-note">${escHtml(t('map.searching'))}</div>`;
  } else if (M.fixError) {
    results = `<div class="map-fix-note map-fix-note--err">${escHtml(t('map.searchFailed', { error: M.fixError }))}</div>`;
  } else if (M.fixResults) {
    results = M.fixResults.length
      ? M.fixResults.map((c, i) =>
          `<button class="map-cand" onclick="pickPlaceCandidate(${i})" title="${escHtml(c.label)}">
             <span class="map-cand-name">${escHtml(c.label)}</span>
             <span class="map-cand-ll">${c.ll[0].toFixed(3)}, ${c.ll[1].toFixed(3)}</span>
           </button>`).join('')
      : `<div class="map-fix-note">${escHtml(t('map.noCandidates'))}</div>`;
  }

  return `<div class="map-fix">
    <div class="map-fix-here">${here}</div>
    <div class="map-fix-row">
      <input type="text" id="map-fix-query" class="edit-input" value="${escHtml(M.fixQuery ?? g.plac)}"
             onkeydown="if(event.key==='Enter')runPlaceFix()"
             data-i18n-placeholder="map.fixPlaceholder" placeholder="${escHtml(t('map.fixPlaceholder'))}">
      <button class="pl-bulk-btn" onclick="runPlaceFix()">${escHtml(t('map.fixSearch'))}</button>
    </div>
    <p class="map-fix-hint">${escHtml(t('map.fixHint'))}</p>
    ${results}
  </div>`;
}

/** Remembered across re-renders, so filtering the list does not re-tick a place. */
export function onMapTick(plac, on) {
  if (on) M.unticked.delete(plac); else M.unticked.add(plac);
  _renderPlaceList();
}

/** Write the ticked places' coordinates into the records. */
export function saveMapCoords() {
  const approved = new Set((M.groups || [])
    .map(g => g.plac)
    .filter(p => !M.unticked.has(p)));
  const changed = applyMapCoords(approved);
  // The events carry no coordinates themselves, but the pending set just shrank
  // and the list has to stop offering what it has already written.
  renderMap();
  _setMapStatus(changed ? t('map.coordsWritten', { count: changed }) : t('map.nothingToWrite'));
}

export function selectMapPlace(plac) {
  // A correction belongs to the place it was typed for.
  if (plac !== M.selected) { M.fixQuery = null; M.fixResults = null; M.fixError = null; }
  M.selected = plac;
  // Selecting a located place walks the map over to it; the list is the only
  // way to reach a place whose circle is off screen.
  const g = (M.groups || []).find(x => x.plac === plac);
  const svg = _el('map-svg');
  if (g?.ll && M.transform && svg) {
    const rect = svg.getBoundingClientRect();
    const [px, py] = project(g.ll[1], g.ll[0]);
    const k = M.transform.k;
    _applyTransform(svg, { k, x: (rect.width || 800) / 2 - k * px, y: (rect.height || 600) / 2 - k * py });
  } else {
    _draw();
  }
  _renderPlaceList();
}

export function mapGoToPerson(id) {
  if (!id || !state.individuals.has(id)) return;
  closeMapView();
  showIndiDetail(id);
  zoomToNode(id);
}

// Placed events move when a record is edited, and the dialog holds its own copy
// of them — so re-collect whenever it is open and the tree changed.
export function refreshMap() {
  if (_el('map-modal')?.style.display === 'flex') {
    M.events = collectMapEvents();
    renderMap();
  }
}
