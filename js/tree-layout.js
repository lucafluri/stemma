import { state } from './state.js';
import { TREE_SPACING_DEFAULTS } from './constants.js';
import { saveSetting } from './settings.js';
import { _defaultFocusRoot, _refocus, computeActiveData, computeGenerationDepths, estimateBirthYear } from './graph-data.js';
import { row } from './panels.js';
import { NODE_BOX_H, NODE_BOX_RX, NODE_BOX_W, onSimEnd, refreshTreeLineageColoring, tick } from './render-2d.js';
import { updateViewToggleUI } from './render-3d.js';

export const FAM_MARKER_MIN = 4;

export function famMarkerSize() {
  return useTreeLayout() ? Math.max(FAM_MARKER_MIN, state.famNodeSize) : state.famNodeSize;
}

// Base values a display setting scales by (see applyTreeSpacing / setTreeSpacing
// below) — everything else in this file reads the scaled `let`s, never these.
const BASE_TREE_ROW_H     = 160;  // vertical distance between generations
const BASE_TREE_COL_W     = 104;  // minimum distance between two people in a row (NODE_BOX_W + 12)
const BASE_TREE_GROUP_GAP = 40;   // extra clearance between one family's children and the next's
const BASE_TREE_SIDE_GAP  = 60;   // extra clearance where the father's and mother's ancestry meet

export let TREE_ROW_H     = BASE_TREE_ROW_H;

export let TREE_COL_W     = BASE_TREE_COL_W;

export const TREE_SPOUSE_DX = 100;  // nominal width of a couple, used for connector routing

export const TREE_FAM_DY    = 0.24; // marriage row sits this fraction of a row below its couple

export const TREE_MARK_GAP  = 26;   // minimum distance between two marriage markers in a row

export let TREE_GROUP_GAP = BASE_TREE_GROUP_GAP;

export let TREE_SIDE_GAP  = BASE_TREE_SIDE_GAP;

/** Recompute the scaled spacing constants from state.treeSpacing. Called once
 * at load (to pick up whatever localStorage restored) and again whenever the
 * display setting changes. */
export function applyTreeSpacing() {
  TREE_ROW_H     = Math.round(BASE_TREE_ROW_H     * state.treeSpacing.row);
  TREE_COL_W     = Math.round(BASE_TREE_COL_W     * state.treeSpacing.col);
  TREE_GROUP_GAP = Math.round(BASE_TREE_GROUP_GAP * state.treeSpacing.group);
  TREE_SIDE_GAP  = Math.round(BASE_TREE_SIDE_GAP  * state.treeSpacing.side);
}
applyTreeSpacing();

/** Sidebar sliders for the classical chart's spacing — how far generations sit
 * apart, how close two people in a row may come, how much extra clearance
 * separates one family's children from the next's, and how far the father's
 * and mother's ancestry are pushed apart specifically (on top of the family
 * gap above, since that one gap applies to every family boundary, not just
 * the one either side of the focus person). 0 on the side gap turns that
 * extra push off; the others stop at 0.5 because a chart cannot usefully
 * compress people or generations past half size. The slider's own max tops
 * out well below that ceiling for a comfortable drag range — the number box
 * beside it is where a larger value actually gets typed in. */
export function setTreeSpacing(key, v) {
  const lo = key === 'side' ? 0 : 0.5;
  const val = Math.max(lo, Math.min(10, parseFloat(v)));
  if (!Number.isFinite(val) || !(key in state.treeSpacing)) return;
  state.treeSpacing[key] = val;
  saveSetting('treeSpacing', state.treeSpacing);
  applyTreeSpacing();
  _syncTreeSpacingInput(key, val);
  if (useTreeLayout()) applyTreeLayout();
}

function _syncTreeSpacingInput(key, val) {
  const slider = document.getElementById('tree-spacing-' + key);
  const num    = document.getElementById('tree-spacing-' + key + '-num');
  // The slider clamps itself to its own (smaller) max when the number box
  // holds a bigger value — expected, matching the physics panel's sliders.
  if (slider) slider.value = val;
  if (num)    num.value = Math.round(val * 100) / 100;
}

export function resetTreeSpacing() {
  Object.assign(state.treeSpacing, TREE_SPACING_DEFAULTS);
  saveSetting('treeSpacing', state.treeSpacing);
  applyTreeSpacing();
  for (const key of Object.keys(TREE_SPACING_DEFAULTS)) _syncTreeSpacingInput(key, state.treeSpacing[key]);
  if (useTreeLayout()) applyTreeLayout();
}

export const TREE_BUS_UP    = 48;   // sibling bar sits this far above the children's row

export const TREE_LANE_DY   = 20;   // and stacks up by this much when families must share a span

export const TREE_LANE_MIN  = 7;    // ...never less than this, however many lanes a row needs

export const TREE_MARR_STEP = 13;   // stacking step for a person's further marriages

export const TREE_CHIP_DX   = 22;   // "+N" chip offset from the junction it belongs to

export const TREE_CHIP_DY   = 13;

export const TREE_ORDER_PASSES = 6; // crossing-reduction sweeps

export const TREE_COORD_PASSES = 8; // coordinate relaxation sweeps

export const TREE_BUS_CLEARANCE = 24;   // keep consecutive runs in a lane visibly apart

export function _assignBusLanes(items) {
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

/** Which of `subject`'s two ancestral sides each visible person's own line
 * runs through — 'father', 'mother', or untagged (the subject, their own full
 * siblings, descendants, in-laws, and anyone the walk never reaches). Deals
 * only in `state.individuals` / `state.families` and `visible`, so it does
 * not depend on computeTreeLayout's own visFam (a stricter "at least two
 * visible members" test built for deciding whether a marriage marker earns a
 * connector, not for this). Exported standalone so it can be tested and
 * reasoned about apart from the layout algorithm.
 */
export function computeLineageSides(visible, subject) {
  const sideOf = new Map();
  if (!subject) return sideOf;

  const famcRec = id => {
    for (const fid of (state.individuals.get(id)?.famc || [])) {
      const f = state.families.get(fid);
      if (f) return f;
    }
    return null;
  };
  const famsRecs = id => (state.individuals.get(id)?.fams || [])
    .map(fid => state.families.get(fid)).filter(Boolean);
  const tag = (id, side) => { if (side && visible.has(id) && !sideOf.has(id)) sideOf.set(id, side); };

  // Two separate seen-sets on purpose: "have we walked up through this
  // person's ancestry" and "have we swept this person's own marriages and
  // descendants" are different questions. A single shared set was the actual
  // bug here — walkUp marked an ancestor seen the moment it started on their
  // *parents*, which then made the marriage-sweep below silently skip that
  // very ancestor's own remarriage, the one case the whole rewrite was for.
  const seenUp = new Set();
  const seenDown = new Set();

  // A person, everyone they ever married — every marriage, not just the one
  // that matters at whichever level called this — and everyone descending
  // from any of those marriages. An aunt/uncle's whole line, or a remarried
  // ancestor's second family.
  const walkDown = (id, side) => {
    if (seenDown.has(id)) return;
    seenDown.add(id);
    tag(id, side);
    for (const fam of famsRecs(id)) {
      const spouse = fam.husb === id ? fam.wife : fam.husb;
      if (spouse) tag(spouse, side);
      for (const c of fam.chil || []) walkDown(c, side);
    }
  };
  // `id`'s own parents, their whole ancestry the same way, and every one of
  // `id`'s siblings — full or half, from any marriage either parent had —
  // with everything descending from them. Deliberately not a plain
  // walkDown(parent, side): that would also re-descend into `id`'s own
  // marriage, which is exactly the boundary this walk must not cross — `id`
  // reached that marriage from one side, and whoever they married is not
  // necessarily on it (at the very top, that other spouse is the subject's
  // *other* parent, on the *other* side entirely).
  const walkUp = (id, side) => {
    if (seenUp.has(id)) return;
    seenUp.add(id);
    const fam = famcRec(id);
    if (!fam) return;
    for (const par of [fam.husb, fam.wife]) {
      if (!par) continue;
      tag(par, side);
      walkUp(par, side);
      for (const fam2 of famsRecs(par)) {
        const otherSpouse = fam2.husb === par ? fam2.wife : fam2.husb;
        if (otherSpouse) tag(otherSpouse, side);
        for (const c of fam2.chil || []) if (c !== id) walkDown(c, side);
      }
    }
  };

  const subjFam = famcRec(subject);
  if (!subjFam) return sideOf;
  const { husb: fa, wife: mo } = subjFam;
  if (fa) { tag(fa, 'father'); walkUp(fa, 'father'); }
  if (mo) { tag(mo, 'mother'); walkUp(mo, 'mother'); }
  // The one thing walkUp deliberately does not do for the subject's own
  // parents: sweep *their* marriages wholesale would pull subjFam in too and
  // tag the subject's full siblings, who are meant to stay neutral. So this
  // is done by hand here, one marriage at a time, skipping subjFam — fa's/
  // mo's own remarriage partner is tagged too, and every half-sibling reads
  // as the shared parent's side rather than neutral like a full sibling.
  for (const [p, side] of [[fa, 'father'], [mo, 'mother']]) {
    if (!p) continue;
    for (const fam2 of famsRecs(p)) {
      if (fam2 === subjFam) continue;
      const otherSpouse = fam2.husb === p ? fam2.wife : fam2.husb;
      if (otherSpouse) tag(otherSpouse, side);
      for (const c of fam2.chil || []) walkDown(c, side);
    }
  }
  return sideOf;
}

export function computeTreeLayout() {
  const visible = new Set(state.nodes.map(n => n.id));
  const people = [...visible].filter(id => state.individuals.has(id));
  if (!people.length) return null;

  // The chart is built around somebody, but that somebody need not be a chosen
  // subject — with no focus set it is whoever the chart would naturally read
  // from. `subject` only decides ordering, balance and centring; everything
  // about *who appears* was already settled by the filter.
  const subject = (state.focusRootId && visible.has(state.focusRootId)) ? state.focusRootId
                : (visible.has(treeAnchorId()) ? treeAnchorId() : people[0]);
  if (!people.length) return null;

  // Families that join at least two people on screen. Tested by membership
  // rather than by the FAM node being one of `nodes`, so the chart still works
  // with the "show family nodes" toggle off — the markers are what the child
  // connectors are grouped by either way.
  const visFam = new Map();
  for (const [fid, fam] of state.families) {
    const par  = [fam.husb, fam.wife].filter(p => p && visible.has(p));
    const kids = fam.chil.filter(c => visible.has(c));
    if (par.length + kids.length >= 2) visFam.set(fid, { fam, par, kids });
  }

  const famsOf = id => (state.individuals.get(id)?.fams || []).filter(f => visFam.has(f));
  const parentsOf = id => {
    const out = [];
    for (const fid of (state.individuals.get(id)?.famc || [])) {
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
    gen.set(id, state._lineageGen?.get(id) ?? ((depths.get(id) ?? rootGen) - rootGen));
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
      for (const famId of (state.individuals.get(id)?.famc || [])) {
        const fam = state.families.get(famId);
        if (!fam) continue;
        for (const p of [fam.husb, fam.wife]) {
          if (p && state.individuals.has(p) && !bloodLine.has(p)) { bloodLine.add(p); next.push(p); }
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
      if (joining && state.families.get(joining).wife === chain[0]) chain.reverse();
    }
    for (const m of chain) mateGroup.set(m, g);
    chainOf.push(chain);
  }

  const seq = new Map();
  let seqN = 0;
  const push = id => { if (id != null && !seq.has(id)) seq.set(id, seqN++); };
  const famcOf = id => (state.individuals.get(id)?.famc || []).find(f => visFam.has(f));
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
    ((state.individuals.get(a).birthYear ?? 9999) - (state.individuals.get(b).birthYear ?? 9999));
  people.filter(id => parentsOf(id).length === 0).sort(byBirth).forEach(emitDesc);
  people.forEach(emitDesc);
  for (const [fid] of visFam) push(fid);

  // Which of the subject's two ancestral sides each visible person's own line
  // runs through, for the optional father-/mother-side colouring — computed
  // independently of the ordering walk just above rather than piggybacked on
  // it. That walk (and visFam, which it and the ordering below both lean on)
  // only admits a family once it joins at least two *visible* members, a rule
  // that exists to decide whether a marriage marker is worth drawing and has
  // nothing to do with whether someone still counts as a paternal or maternal
  // relative. Tagging alongside it left an ancestor untagged the moment their
  // own parents' record had only one visible spouse, or children who did not
  // happen to be on screen — which read as the colouring randomly giving out
  // partway up a branch instead of running the whole way.
  const sideOf = computeLineageSides(visible, subject);

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
  const famcKey = id => (state.individuals.get(id)?.famc || []).find(f => visFam.has(f)) ?? null;
  const gapsFor = (runs, L) => {
    const base = slotOf(L);
    return runs.map((r, i) => {
      if (!i || L % 2 !== 0) return base;
      const prev = runs[i - 1].ids[runs[i - 1].ids.length - 1];
      const here = r.ids[0];
      let gap = base;
      const a = famcKey(prev), b = famcKey(here);
      if (a && b && a !== b) gap += TREE_GROUP_GAP;
      // The one boundary that is specifically the father/mother split, not
      // just any two families landing next to each other — pushed apart
      // further still, independent of the general family gap above.
      const sa = sideOf.get(prev), sb = sideOf.get(here);
      if (sa && sb && sa !== sb) gap += TREE_SIDE_GAP;
      return gap;
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
  // A marriage hangs below its couple to leave room for the sibling bar and the
  // children on it. A couple with no children on the chart has nothing hanging
  // there, and dropping the marker anyway pushes it into the empty band between
  // the generations, where it reads as a child of the couple rather than as
  // their marriage. Put it in the gap between the two people instead — which is
  // where a hand-drawn chart puts it.
  // Only when it genuinely fits in that gap: the same span test the spouse
  // connector uses, so the marker and the line agree about whether the couple
  // is side by side, plus room for the marker itself between the two boxes.
  // A couple that had to reach past somebody keeps the old placement, or the
  // marker would land on top of whoever is sitting between them.
  const marrSize = famMarkerSize();
  const between = fid => {
    const { par, kids } = visFam.get(fid);
    if (kids.length || par.length < 2) return null;
    const ax = xs.get(par[0]), bx = xs.get(par[1]);
    const span = Math.abs(ax - bx);
    if (span > TREE_COL_W * 1.2) return null;                 // reaches past someone
    if (span - NODE_BOX_W < 2 * marrSize + 2) return null;    // no room between the boxes
    return (ax + bx) / 2;
  };
  for (const [fid] of visFam) {
    const mid = between(fid);
    pos.set(fid, mid === null ? {
      x: xs.get(fid),
      y: (famGen.get(fid) + TREE_FAM_DY) * TREE_ROW_H + marrLevel(fid) * TREE_MARR_STEP,
    } : {
      x: mid,
      y: famGen.get(fid) * TREE_ROW_H,
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
  state._treeBusY = new Map();

  // Child connectors: one bar per family, from the FAM marker out to its
  // furthest child, sitting a fixed distance above the children's row.
  const famsByChildRow = new Map();

  for (const [id, fam] of state.families) {
    if (!pos.has(id)) continue;
    const famPos = pos.get(id);
    // A bar per family *per row its children sit on*. Where the generations
    // disagree — an uncle recorded as his own nephew's brother, which real files
    // are full of — a family's children land on two different rows, and one bar
    // can only be at one height. The row the bar is not on then has no bracket
    // at all: those connectors fall back to the shared midpoint in _linkPath and
    // draw straight along every other family's bar. That fallback is where most
    // of the overlapping lines came from.
    const byRow = new Map();
    for (const c of fam.chil) {
      if (!pos.has(c)) continue;
      const y = pos.get(c).y;
      if (!byRow.has(y)) byRow.set(y, []);
      byRow.get(y).push(c);
    }
    for (const [childY, kids] of byRow) {
      const span = [famPos.x, ...kids.map(c => pos.get(c).x)];
      if (!famsByChildRow.has(childY)) famsByChildRow.set(childY, []);
      famsByChildRow.get(childY).push({
        key: id,
        parents: [fam.husb, fam.wife].filter(p => p && pos.has(p)),
        kids,
        x0: Math.min(...span),
        x1: Math.max(...span),
      });
    }
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
      const bottom = childY - TREE_BUS_UP;
      // One step for the whole row, measured from the lowest marker in it, so
      // every lane clears every marker and the lanes stay evenly spaced. Worked
      // out per bar instead, two bars on neighbouring lanes get different steps
      // and land a couple of pixels apart, which reads as one thick line.
      //
      // A lane must never rise above the marker its bar hangs from. That used to
      // be allowed when the band was too shallow to hold every lane — but
      // _linkPath rejects a bus outside the marker→child span, so such a bar was
      // not drawn high, it was not drawn at all: the connector fell back to the
      // shared midpoint and ran along everybody else's. Clamping is the lesser
      // evil, and with the deeper band it almost never bites.
      const roof = Math.max(...items.map(o => pos.get(o.key).y + 14));
      const step = lanes > 1
        ? Math.max(TREE_LANE_MIN, Math.min(TREE_LANE_DY, (bottom - roof) / (lanes - 1)))
        : 0;
      const y = Math.max(bottom - it.lane * step, pos.get(it.key).y + 14);
      state._treeBusY.set(it.key, y);
      // Keyed by the pair as well: a family with children on two rows has two
      // bars, and only the child says which of them a connector belongs to.
      for (const c of it.kids) state._treeBusY.set(`${it.key}>${c}`, y);
      // With FAM nodes hidden the links run parent→child directly and there is
      // no family id on either end to look the bar up by, so register it under
      // each parent-child pair too. Same bar, so the bracket still forms.
      for (const p of it.parents) for (const c of it.kids) state._treeBusY.set(`${p}~${c}`, y);
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
    let frontier = seeds.filter(id => state.individuals.has(id) && !visible.has(id));
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const indi = state.individuals.get(id);
        if (!indi) continue;
        if (dir === 'down') {
          for (const famId of (indi.fams || [])) {
            const fam = state.families.get(famId);
            if (!fam) continue;
            // The partner arrives with them, so they are part of the count —
            // but their own family is not walked, exactly as the chart does it.
            const sp = fam.husb === id ? fam.wife : fam.husb;
            if (sp && state.individuals.has(sp) && !visible.has(sp)) seen.add(sp);
            for (const c of fam.chil) {
              if (state.individuals.has(c) && !visible.has(c) && !seen.has(c)) next.push(c);
            }
          }
        } else {
          for (const famId of (indi.famc || [])) {
            const fam = state.families.get(famId);
            if (!fam) continue;
            for (const p of [fam.husb, fam.wife]) {
              if (p && state.individuals.has(p) && !visible.has(p) && !seen.has(p)) next.push(p);
            }
          }
        }
      }
      frontier = next;
    }
    return seen;
  };

  const omitted = [];
  for (const [fid, fam] of state.families) {
    const missing = fam.chil.filter(c => state.individuals.has(c) && !visible.has(c));
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
    for (const famId of (state.individuals.get(id).famc || [])) {
      const fam = state.families.get(famId);
      if (fam) for (const p of [fam.husb, fam.wife]) if (p && state.individuals.has(p)) parents.push(p);
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
    for (const [id, y] of state._treeBusY) state._treeBusY.set(id, y - dy);
    for (const o of omitted) { o.x -= dx; o.y -= dy; }
  }

  state._treeOmitted = omitted;
  state._treeLineageSide = sideOf;
  return pos;
}

export function useTreeLayout() {
  return state.treeLayout && state.currentView === '2d';
}

export function treeAnchorId() {
  if (state.focusRootId && state.individuals.has(state.focusRootId)) return state.focusRootId;
  return _defaultFocusRoot();
}

export function applyTreeLayout() {
  const pos = computeTreeLayout();
  if (!pos) return false;
  if (state.simulation) state.simulation.stop();

  // Without a running simulation nothing resolves link endpoints, so they are
  // still the raw id strings computeActiveData() emitted. Do what forceLink
  // would have done, or every path renders as M0,0L0,0.
  const byId = new Map(state.nodes.map(n => [n.id, n]));
  for (const l of state.links) {
    if (typeof l.source !== 'object') l.source = byId.get(l.source) ?? l.source;
    if (typeof l.target !== 'object') l.target = byId.get(l.target) ?? l.target;
  }

  const svgEl = document.getElementById('graph-svg');
  const cx = (svgEl?.clientWidth  || 1100) / 2;
  const cy = (svgEl?.clientHeight || 700)  / 2;

  for (const n of state.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    n.x = n.fx = cx + p.x;
    n.y = n.fy = cy + p.y;
    n._treePinned = true;
  }
  // Bus lanes come out of computeTreeLayout in chart space; move them into the
  // same space as the nodes or _linkPath rejects every one of them as out of
  // range and quietly falls back to the shared midpoint.
  if (state._treeBusY) for (const [id, y] of state._treeBusY) state._treeBusY.set(id, cy + y);
  if (state._treeOmitted) for (const o of state._treeOmitted) { o.x += cx; o.y += cy; }

  tick();
  renderOmittedMarkers();
  // The boxes were drawn by the renderGraph() call that always precedes this
  // one, using whatever _treeLineageSide held from the *previous* layout —
  // stale for a chart that just got a new subject, or empty on the very first
  // paint. Repaint now that computeTreeLayout() above has just refreshed it.
  refreshTreeLineageColoring();
  onSimEnd();
  return true;
}

export function releaseTreePins() {
  for (const n of state.nodes) {
    if (n._treePinned) { delete n.fx; delete n.fy; delete n._treePinned; }
  }
  state._treeOmitted = null;
  state._treeLineageSide = null;
  state.gMain?.select('g.omitted-g').selectAll('*').remove();
}

export function renderOmittedMarkers() {
  if (!state.gMain) return;
  let g = state.gMain.select('g.omitted-g');
  if (g.empty()) g = state.gMain.append('g').attr('class', 'omitted-g');

  const data = state._treeOmitted || [];
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

export function revealHidden(ids) {
  if (!ids.length) return;
  for (const id of ids) state._revealed.add(id);
  _refocus();
}

export function setTreeLayout(on) {
  state.treeLayout = !!on;
  saveSetting('treeLayout', state.treeLayout);
  // The chart no longer needs a subject to be picked for it — without one it
  // draws everybody, anchored on the most-connected person. It also decides
  // which relatives a focus means, so both views rebuild.
  if (!state.treeLayout) releaseTreePins();
  _refocus();
  updateViewToggleUI();   // the physics controls appear/disappear with the layout
}

export function yearTo3DY(yr) {
  if (!yr || !state._birthYearRange) return null; // null = no pin (unknown year)
  const { min, max } = state._birthYearRange;
  const frac = (yr - min) / Math.max(max - min, 1);
  // older → +_3dYHalfSpan (top), newer → -_3dYHalfSpan (bottom)
  return state._3dYHalfSpan - frac * 2 * state._3dYHalfSpan;
}

export function genTo3DY(g) {
  if (g == null || !state._genRange3D) return null;
  const { min, max } = state._genRange3D;
  const frac = (g - min) / Math.max(max - min, 1);
  return state._3dYHalfSpan - frac * 2 * state._3dYHalfSpan;
}

export function nodeStratY(n) {
  if (state.stratify3D === 'time') return yearTo3DY(estimateBirthYear(n));
  if (state.stratify3D !== 'generation') return null;
  const depths = computeGenerationDepths();
  if (n.type === 'INDI') return genTo3DY(depths.get(n.id));
  // A marriage sits between the couple's row and their children's — but a
  // childless couple has no children's row to sit above, and half a generation
  // down just floats it away from the only two people it relates to.
  const fam = n.data;
  const par = [fam.husb, fam.wife].filter(x => x && depths.has(x));
  if (par.length) {
    const row = Math.max(...par.map(x => depths.get(x)));
    return genTo3DY((fam.chil || []).some(c => depths.has(c)) ? row + 0.5 : row);
  }
  const kids = (fam.chil || []).filter(c => depths.has(c));
  return kids.length ? genTo3DY(Math.min(...kids.map(c => depths.get(c))) - 0.5) : null;
}

export function applyTimelineYFix() {
  if (!state.graph3d) return;
  const gd = state.graph3d.graphData();
  if (state.stratify3D !== 'off') {
    gd.nodes.forEach(n => {
      const y = nodeStratY(n);
      n.fy = (y !== null) ? y : undefined; // pin where we can place them, float otherwise
    });
  } else {
    gd.nodes.forEach(n => { n.fy = undefined; });
  }
}

export function _linkPath(d) {
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
  const bus = state._treeBusY?.get(`${sid}>${tid}`) ?? state._treeBusY?.get(`${sid}~${tid}`);
  const my = bus != null && bus > Math.min(sy, ty) && bus < Math.max(sy, ty)
    ? bus
    : (sy + ty) / 2;
  return `M${sx},${sy}C${sx},${my} ${tx},${my} ${tx},${ty}`;
}

export const TREE_MIN_LEGIBLE_SCALE = 0.5;

export function frameTreeChart() {
  if (!state.nodes.length || !state.svgSel || !state.zoomBehavior) return;
  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth, H = svgEl.clientHeight;

  // One pass over the nodes, skipping any coordinate that is not a real
  // number — see zoomToFit(), which had the same NaN-poisons-the-extent trap.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of state.nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    if (n.x < x0) x0 = n.x;
    if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.y > y1) y1 = n.y;
  }
  if (x0 === Infinity) return;

  // 160px of breathing room around the chart is a comfortable margin on a
  // desktop and a third of the width of a phone held upright — the same trap
  // fit3D() already sidesteps for the 3D scene. Scale it to the viewport, so a
  // narrow screen spends its pixels on the chart rather than on the gap
  // around it.
  const pad = Math.min(160, W * 0.14, H * 0.14);
  const fit = Math.min(W / ((x1 - x0) + pad), H / ((y1 - y0) + pad), 1.4);
  const legible = fit >= TREE_MIN_LEGIBLE_SCALE;
  const scale = legible ? fit : TREE_MIN_LEGIBLE_SCALE;

  // Centre the whole chart when it fits, otherwise centre the subject.
  const subject = state.nodes.find(n => n.id === state.focusRootId);
  const cx = legible || !subject ? (x0 + x1) / 2 : subject.x;
  const cy = legible || !subject ? (y0 + y1) / 2 : subject.y;

  state.svgSel.transition().duration(600).call(
    state.zoomBehavior.transform,
    d3.zoomIdentity.translate(W / 2 - scale * cx, H / 2 - scale * cy).scale(scale)
  );
}
