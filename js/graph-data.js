import { state } from './state.js';
import { hasEnabledFamilyName, updateSurnameShownCount } from './colors.js';
import { _autoMarkDeceasedByAge, _fullRebuildGraph } from './gedcom-io.js';
import { row } from './panels.js';
import { updateHLButtons } from './relations.js';
import { applyFilter, tick } from './render-2d.js';

export const DECEASED_AGE_THRESHOLD = 110;

export function buildGraphData() {
  // Everything derived from the shape of the tree is invalidated here, where
  // the tree is read, rather than in _fullRebuildGraph() — the file loader
  // does not go through that function, it open-codes its own rebuild and calls
  // this one. Caches cleared only there survived a file load, so a chart built
  // while the app was still empty left every generation depth at "none": the
  // generation slider then had no generations to offer and hid itself, and 3D
  // generation mode had nothing to sort by. Clearing them at the point the
  // data is consumed cannot be skipped by a path that forgets to ask.
  state._genDepthsCache = null;
  state._genNumbers     = null;
  state._estimatedYears = null;
  _autoMarkDeceasedByAge();
  state.allNodes = [];
  state.allLinks = [];
  const nodeById = new Map();
  const nextCache = new Map();

  // Reuse the existing node object for an id if we have one, so its
  // {x,y,vx,vy,fx,fy} simulation state survives this rebuild untouched.
  // Ids that no longer exist are simply not copied into nextCache and drop out.
  const getNode = (id, type, data) => {
    let n = state._nodeObjCache.get(id);
    if (n) n.data = data;
    else n = { id, type, data };
    nextCache.set(id, n);
    return n;
  };

  for (const [id, indi] of state.individuals) {
    const n = getNode(id, 'INDI', indi);
    state.allNodes.push(n);
    nodeById.set(id, n);
  }

  for (const [id, fam] of state.families) {
    const n = getNode(id, 'FAM', fam);
    state.allNodes.push(n);
    nodeById.set(id, n);

    if (fam.husb && nodeById.has(fam.husb))
      state.allLinks.push({ _src: fam.husb, _tgt: id, ltype: 'spouse' });
    if (fam.wife && nodeById.has(fam.wife))
      state.allLinks.push({ _src: fam.wife, _tgt: id, ltype: 'spouse' });
    for (const cid of fam.chil) {
      if (nodeById.has(cid))
        state.allLinks.push({ _src: id, _tgt: cid, ltype: 'parent' });
    }
  }

  state._nodeObjCache = nextCache;

  computeActiveData();  // initialise nodes/links from current filter state
}

export function inGenRange(id) {
  if (!state.genRange) return true;
  const g = generationNumbers().get(id);
  // Someone the layering never placed has no generation to judge, so the band
  // does not get to drop them.
  return g === undefined || (g >= state.genRange.min && g <= state.genRange.max);
}

export function isIndiVisible(id) {
  const indi = state.individuals.get(id);
  if (!inGenRange(id)) return false;
  if (!indi || hasEnabledFamilyName(indi)) return true;
  for (const [, fam] of state.families) {
    const spouseId = fam.husb === id ? fam.wife : fam.wife === id ? fam.husb : null;
    if (spouseId && hasEnabledFamilyName(state.individuals.get(spouseId) || {})) return true;
  }
  return false;
}

export function isFamVisible(id) {
  const fam = state.families.get(id);
  if (!fam) return true;
  const members = [fam.husb, fam.wife, ...fam.chil].filter(Boolean);
  if (!members.length) return true;
  return members.some(pid => isIndiVisible(pid));
}

export function isNodeVisible(n) {
  return n.type === 'INDI' ? isIndiVisible(n.id) : isFamVisible(n.id);
}

export function _collateralMaxDepth(ancestorGen, degree) {
  if (ancestorGen === 1) return 2;
  if (ancestorGen <= degree + 1) return ancestorGen;
  return 0;
}

export function computeLineageSet() {
  const people = new Set([state.focusRootId]);
  const fams   = new Set();
  const room   = () => people.size < state.focusLimit;

  // The walk already knows everyone's generation: one step up is one row up,
  // one step down is one row down. Taking the row straight from the walk keeps
  // couples level and children exactly one row under their parents by
  // construction. Deriving rows afterwards from ancestor depth cannot do that —
  // parents have unequal depths, and levelling them after the fact cascades
  // into dozens of phantom generations.
  state._lineageGen = new Map([[state.focusRootId, 0]]);

  // Tracks, for people reached through the sideways "down" walk, which
  // ancestor's collateral branch they belong to and how many rows below that
  // ancestor they sit — the two numbers _collateralMaxDepth() caps. `anc: null`
  // marks the focus person's own direct descendant line, which is never capped.
  const downMeta = new Map([[state.focusRootId, { anc: null, depth: 0 }]]);

  let up = [state.focusRootId], down = [state.focusRootId];
  while ((up.length || down.length) && room()) {
    const nextUp = [], nextDown = [];

    for (const id of up) {
      for (const famId of (state.individuals.get(id)?.famc || [])) {
        const fam = state.families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        for (const p of [fam.husb, fam.wife]) {
          if (!p || !state.individuals.has(p) || people.has(p)) continue;
          if (!room()) break;
          people.add(p);
          state._lineageGen.set(p, state._lineageGen.get(id) - 1);
          nextUp.push(p);
          // Every ancestor is also walked downwards, which is what puts the
          // subject's siblings and first cousins on the chart — capped below.
          downMeta.set(p, { anc: p, depth: 0 });
          nextDown.push(p);
        }
      }
    }

    for (const id of down) {
      const meta = downMeta.get(id);
      for (const famId of (state.individuals.get(id)?.fams || [])) {
        const fam = state.families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        for (const cid of fam.chil) {
          if (!state.individuals.has(cid) || people.has(cid)) continue;
          let cMeta;
          if (!meta || meta.anc === null) {
            cMeta = { anc: null, depth: 0 };   // focus person's own descendants: unlimited
          } else {
            const ancestorGen = -(state._lineageGen.get(meta.anc) ?? 0);
            const depth = meta.depth + 1;
            if (depth > _collateralMaxDepth(ancestorGen, state.cousinDegree)) continue;   // too distant a cousin
            cMeta = { anc: meta.anc, depth };
          }
          if (!room()) break;
          people.add(cid);
          state._lineageGen.set(cid, state._lineageGen.get(id) + 1);
          downMeta.set(cid, cMeta);
          nextDown.push(cid);
        }
      }
    }

    up = nextUp; down = nextDown;
  }

  // One more hop: the spouse of every blood relative kept above gets a box
  // right next to them — but their own parents/siblings are not walked, so
  // this never grows the chart past "married in, one column wide."
  for (const id of [...people]) {
    for (const famId of (state.individuals.get(id)?.fams || [])) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      const sp = fam.husb === id ? fam.wife : fam.husb;
      if (!sp || sp === id || !state.individuals.has(sp) || people.has(sp) || !room()) continue;
      people.add(sp);
      fams.add(famId);
      state._lineageGen.set(sp, state._lineageGen.get(id));
    }
  }

  // People the reader asked for by clicking a "+N" chip. They come in whatever
  // the walk decided, and ignore the budget — the click *is* the budget.
  for (const id of (state._revealed || [])) {
    if (!state.individuals.has(id)) continue;
    // Somebody opened earlier may already be here through the ordinary walk.
    // Skipping the whole entry for them, as this did, also skipped bringing
    // their partner in below — so a branch opened twice lost people the second
    // time and the count stopped adding up.
    if (!people.has(id)) people.add(id);
    if (!state._lineageGen.has(id)) {
      // Take the generation from whichever relative is already on the chart.
      for (const famId of (state.individuals.get(id).famc || [])) {
        const fam = state.families.get(famId);
        if (!fam) continue;
        for (const p of [fam.husb, fam.wife]) {
          if (p && state._lineageGen.has(p)) state._lineageGen.set(id, state._lineageGen.get(p) + 1);
        }
      }
      for (const famId of (state.individuals.get(id).fams || [])) {
        const fam = state.families.get(famId);
        if (!fam) continue;
        for (const c of fam.chil) {
          if (state._lineageGen.has(c) && !state._lineageGen.has(id)) state._lineageGen.set(id, state._lineageGen.get(c) - 1);
        }
        const sp = fam.husb === id ? fam.wife : fam.husb;
        if (sp && state._lineageGen.has(sp) && !state._lineageGen.has(id)) state._lineageGen.set(id, state._lineageGen.get(sp));
      }
      if (!state._lineageGen.has(id)) state._lineageGen.set(id, 0);
    }
    for (const famId of [...(state.individuals.get(id).famc || []), ...(state.individuals.get(id).fams || [])]) {
      if (state.families.has(famId)) fams.add(famId);
    }
    // Their partner comes with them, off-budget like the rest of this. The
    // one-hop pass above would otherwise be asked to find room for somebody the
    // reader has explicitly opened, and a "+14" that only ever produces eleven
    // people is a broken promise. Their family is still not walked — the
    // partner arrives, their side of the tree does not.
    for (const famId of (state.individuals.get(id).fams || [])) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      const sp = fam.husb === id ? fam.wife : fam.husb;
      if (!sp || sp === id || !state.individuals.has(sp) || people.has(sp)) continue;
      people.add(sp);
      state._lineageGen.set(sp, state._lineageGen.get(id));
    }
  }

  for (const famId of [...fams]) {
    const fam = state.families.get(famId);
    const kept = [fam.husb, fam.wife, ...fam.chil].filter(id => id && people.has(id));
    if (kept.length < 2) fams.delete(famId);
  }
  return new Set([...people, ...fams]);
}

export function computeFocusSet() {
  if (!state.focusRootId || !state.individuals.has(state.focusRootId)) return null;
  // Which relatives count is the reader's choice, not the renderer's: keyed to
  // the chart setting rather than to whichever view happens to be on screen, so
  // switching between 2D and 3D shows the same people. Keyed to the view, the
  // two disagreed about who a focus even meant.
  if (state.treeLayout) return computeLineageSet();

  const people = new Set([state.focusRootId]);
  const fams   = new Set();
  let frontier = [state.focusRootId];

  while (frontier.length && people.size < state.focusLimit) {
    // Collect the whole next ring before admitting any of it, then admit in
    // kinship order: direct line (parents, spouse, children) ahead of siblings.
    // Admitting family-by-family instead would let one large sibship eat the
    // budget before that person's own spouse and children were even looked at.
    const cand = new Map();   // id → priority (0 = direct line, 1 = sibling)
    const offer = (id, prio) => {
      if (!id || people.has(id) || !state.individuals.has(id)) return;
      const seen = cand.get(id);
      if (seen === undefined || prio < seen) cand.set(id, prio);
    };

    for (const pid of frontier) {
      const indi = state.individuals.get(pid);
      if (!indi) continue;
      for (const famId of indi.fams) {          // own marriage: spouse + children
        const fam = state.families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        offer(fam.husb === pid ? fam.wife : fam.husb, 0);
        for (const cid of fam.chil) offer(cid, 0);
      }
      for (const famId of indi.famc) {          // parents' family: parents, then siblings
        const fam = state.families.get(famId);
        if (!fam) continue;
        fams.add(famId);
        offer(fam.husb, 0);
        offer(fam.wife, 0);
        for (const cid of fam.chil) offer(cid, 1);
      }
    }

    const next = [];
    for (const [id] of [...cand].sort((a, b) => a[1] - b[1])) {
      if (people.size >= state.focusLimit) break;
      people.add(id);
      next.push(id);
    }
    frontier = next;
  }

  // A FAM node only earns its place if it still joins two kept people;
  // otherwise it hangs off the edge of the cut as a dangling diamond.
  for (const famId of [...fams]) {
    const fam = state.families.get(famId);
    const kept = [fam.husb, fam.wife, ...fam.chil].filter(id => id && people.has(id));
    if (kept.length < 2) fams.delete(famId);
  }

  return new Set([...people, ...fams]);
}

export function _defaultFocusRoot() {
  let best = null, bestN = -1;
  for (const [id, indi] of state.individuals) {
    const n = (indi.famc?.length || 0) + (indi.fams?.length || 0);
    if (n > bestN) { bestN = n; best = id; }
  }
  return best;
}

export function focusHiddenCount() {
  if (!state.focusRootId) return 0;
  return Math.max(0, state.individuals.size - state.nodes.filter(n => n.type === 'INDI').length);
}

export function computeGenerationDepths() {
  if (state._genDepthsCache) return state._genDepthsCache;

  // Relations are offsets: a child is one generation below their parents, a
  // spouse is level with them. Walk the relations and give each edge the length
  // it actually has.
  //
  // The obvious alternative — layer everyone by their longest chain of
  // ancestors — gives every person the depth of the deepest route *to* them,
  // which is not the same thing. A man whose own line is recorded two deep,
  // married to a woman whose line is recorded twelve deep, is pushed down to
  // her level; his parents then sit ten generations above their own son. On
  // this file that produced jumps of up to twenty-six generations across a
  // single parent-child link, and even children drawn above their parents.
  //
  // Breadth-first also settles conflicts the right way round: where cousins
  // marry, the relations genuinely disagree about who is a generation above
  // whom, and the first assignment to reach a person wins — which is the one
  // through their closest relation.
  const gen = new Map();

  const parentsOf = id => {
    const out = [];
    for (const famId of (state.individuals.get(id)?.famc || [])) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      for (const p of [fam.husb, fam.wife]) if (p && state.individuals.has(p)) out.push(p);
    }
    return out;
  };
  const kidsAndSpouses = id => {
    const kids = [], spouses = [];
    for (const famId of (state.individuals.get(id)?.fams || [])) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      const sp = fam.husb === id ? fam.wife : fam.husb;
      if (sp && state.individuals.has(sp)) spouses.push(sp);
      for (const c of fam.chil) if (state.individuals.has(c)) kids.push(c);
    }
    return { kids, spouses };
  };

  // Start each disconnected part at its best-connected person, so the walk
  // begins somewhere central rather than at whichever id came first in the file.
  const seeds = [...state.individuals.keys()].sort((a, b) => {
    const w = id => (state.individuals.get(id).fams?.length || 0) + (state.individuals.get(id).famc?.length || 0);
    return w(b) - w(a);
  });

  for (const seed of seeds) {
    if (gen.has(seed)) continue;
    gen.set(seed, 0);
    let frontier = [seed];
    while (frontier.length) {
      // Settle marriages before stepping outward. A marriage costs nothing —
      // the two are the same generation — so everyone reachable across marriages
      // belongs to this step, not the next. Left to the ordinary queue a spouse
      // could instead be reached by some longer route through the family and be
      // given that route's generation, splitting the couple. Appending while
      // iterating walks a chain of remarriages to its end.
      for (let i = 0; i < frontier.length; i++) {
        const g = gen.get(frontier[i]);
        for (const sp of kidsAndSpouses(frontier[i]).spouses) {
          if (!gen.has(sp)) { gen.set(sp, g); frontier.push(sp); }
        }
      }
      const next = [];
      for (const id of frontier) {
        const g = gen.get(id);
        for (const p of parentsOf(id)) {
          if (!gen.has(p)) { gen.set(p, g - 1); next.push(p); }
        }
        for (const c of kidsAndSpouses(id).kids) {
          if (!gen.has(c)) { gen.set(c, g + 1); next.push(c); }
        }
      }
      frontier = next;
    }
  }

  // ── Line up the separate trees ──
  // A file often holds several families with no relation between them. Each is
  // laid out from its own seed, so each starts at generation 0 — which stacks a
  // family living in the 1500s onto one living in the 1900s and puts four
  // centuries of people on a single layer. Nothing inside a tree can say where
  // it belongs relative to another; only the dates can. Slide each tree so its
  // generations agree with the rest on roughly when a generation happened.
  // Shifting a whole tree cannot change any relation inside it, so this is free.
  // Group from the family records themselves, not from each person's own list
  // of families. GEDCOM links are not always written both ways — a family can
  // name a child who does not name the family back — and a group built from one
  // side then splits people the other side treats as related. Sliding such a
  // "separate" tree would drag one end of a real parent-child link away from
  // the other, which is precisely what this shift must never do.
  const compOf = new Map();
  {
    const parent = new Map();
    const find = x => {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
      return x;
    };
    for (const [id] of state.individuals) parent.set(id, id);
    for (const [, fam] of state.families) {
      const members = [fam.husb, fam.wife, ...(fam.chil || [])].filter(m => m && state.individuals.has(m));
      for (let i = 1; i < members.length; i++) {
        const ra = find(members[0]), rb = find(members[i]);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
    for (const [id] of state.individuals) compOf.set(id, find(id));
  }

  const stats = new Map();   // component -> running mean of year and generation
  for (const [id, indi] of state.individuals) {
    const yr = indi.birthYear || (indi.birth?.date || '').match(/\d{4}/)?.[0];
    if (!yr) continue;
    const c = compOf.get(id);
    if (!stats.has(c)) stats.set(c, { n: 0, year: 0, g: 0 });
    const st = stats.get(c);
    st.n++; st.year += +yr; st.g += gen.get(id);
  }
  const sizes = new Map();
  for (const c of compOf.values()) sizes.set(c, (sizes.get(c) || 0) + 1);
  // The biggest dated tree sets the reference; anything undated cannot be
  // placed by date and simply keeps the generation the walk gave it.
  let ref = null;
  for (const [c, st] of stats) {
    if (!ref || sizes.get(c) > sizes.get(ref)) ref = c;
  }
  const shift = new Map();
  if (ref !== null) {
    const r = stats.get(ref);
    const refYearAtZero = r.year / r.n - GEN_GAP * (r.g / r.n);
    for (const [c, st] of stats) {
      const yearAtZero = st.year / st.n - GEN_GAP * (st.g / st.n);
      shift.set(c, Math.round((yearAtZero - refYearAtZero) / GEN_GAP));
    }
  }

  for (const [id, g] of gen) gen.set(id, g + (shift.get(compOf.get(id)) || 0));

  // Shift so the earliest generation is 0 — everything downstream reads these
  // as depths counting down from the top of the chart.
  let min = 0;
  for (const g of gen.values()) if (g < min) min = g;
  const depth = new Map();
  for (const [id, g] of gen) depth.set(id, g - min);

  state._genDepthsCache = depth;
  return depth;
}

export function famAvgYear(fam) {
  const ys = [fam.husb, fam.wife, ...fam.chil]
    .filter(Boolean)
    .map(id => state._estimatedYears?.get(id) ?? state.individuals.get(id)?.birthYear)
    .filter(Boolean);
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}

export const GEN_GAP = 28;  // average generation gap in years

export function generationNumbers() {
  if (state._genNumbers) return state._genNumbers;
  const depths = computeGenerationDepths();
  const max = depths.size ? Math.max(...depths.values()) : 0;
  state._genNumbers = new Map();
  for (const [id, d] of depths) state._genNumbers.set(id, max - d);
  return state._genNumbers;
}

export function generationCount() {
  const g = generationNumbers();
  return g.size ? Math.max(...g.values()) + 1 : 0;
}

export function personAgeYears(id) {
  const indi = state.individuals.get(id);
  if (!indi) return null;
  const bRaw  = indi.birthYear || (indi.birth?.date || '').match(/\d{4}/)?.[0];
  const bYear = bRaw ? +bRaw : (state._estimatedYears?.get(id) ?? null);
  if (bYear == null) return null;
  const approx = !bRaw;
  if (indi.deceased) {
    const dYear = indi.death?.date?.match(/\d{4}/)?.[0];
    if (!dYear) return null; // known dead but no year to subtract from
    return { age: +dYear - bYear, atDeath: true, approx };
  }
  return { age: new Date().getFullYear() - bYear, atDeath: false, approx };
}

export function computeEstimatedYears() {
  const est = new Map();
  // Seed known
  for (const [id, indi] of state.individuals) {
    if (indi.birthYear) est.set(id, indi.birthYear);
  }

  // BFS propagation — repeat until no new estimates emerge
  // Cap iterations to guard against cycles
  let changed = true;
  let iters = 0;
  const MAX_ITERS = state.individuals.size + 1;
  while (changed && iters++ < MAX_ITERS) {
    changed = false;
    for (const [, fam] of state.families) {
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
      for (const [id] of state.individuals) {
        if (!est.has(id)) {
          const g = genDepths.get(id) ?? 0;
          est.set(id, Math.round(refYear + (g - refGen) * clampedSlope));
        }
      }
    } else {
      // Only one generation has data — use GEN_GAP
      [refGen, refYear] = sortedGens[0];
      for (const [id] of state.individuals) {
        if (!est.has(id)) {
          const g = genDepths.get(id) ?? 0;
          est.set(id, Math.round(refYear + (g - refGen) * GEN_GAP));
        }
      }
    }
  }

  state._estimatedYears = est;
  return est;
}

export function estimateBirthYear(n) {
  if (n.type !== 'INDI') {
    return famAvgYear(n.data) || null;
  }
  // Use cached estimated year if available
  if (state._estimatedYears && state._estimatedYears.has(n.id)) return state._estimatedYears.get(n.id);
  // Direct fallback
  return n.data.birthYear || null;
}

export function computeActiveData() {
  const visIds = new Set(state.allNodes.filter(n => isNodeVisible(n)).map(n => n.id));

  // Focus is a filter on the data, not a property of the renderer: pick a
  // person and both views show that person's relatives. It used to be applied
  // only in 2D, so switching to 3D silently threw the selection away and
  // returned the whole file — the one thing a filter must not do.
  const focusIds = computeFocusSet();
  if (focusIds) for (const id of [...visIds]) if (!focusIds.has(id)) visIds.delete(id);

  if (state.showFamNodes) {
    // Bipartite mode: INDI + FAM nodes
    state.nodes = state.allNodes.filter(n => visIds.has(n.id));
    state.links = state.allLinks
      .filter(l => visIds.has(l._src) && visIds.has(l._tgt))
      .map(l => ({ source: l._src, target: l._tgt, ltype: l.ltype }));
  } else {
    // Direct mode: only INDI nodes, direct spouse + parent-child links
    state.nodes = state.allNodes.filter(n => n.type === 'INDI' && visIds.has(n.id));
    const indiIds = new Set(state.nodes.map(n => n.id));
    state.links = [];
    const spousePairs = new Set();   // prevent duplicate spouse links for remarried couples
    for (const [, fam] of state.families) {
      const hasHusb = fam.husb && indiIds.has(fam.husb);
      const hasWife = fam.wife && indiIds.has(fam.wife);
      // Spouse line (deduplicated)
      if (hasHusb && hasWife) {
        const key = [fam.husb, fam.wife].sort().join('|');
        if (!spousePairs.has(key)) {
          spousePairs.add(key);
          state.links.push({ source: fam.husb, target: fam.wife, ltype: 'spouse' });
        }
      }
      // Parent → child lines, shaded by parent sex
      for (const cid of fam.chil) {
        if (!indiIds.has(cid)) continue;
        if (hasHusb) state.links.push({ source: fam.husb, target: cid, ltype: 'father' });
        if (hasWife) state.links.push({ source: fam.wife, target: cid, ltype: 'mother' });
      }
    }
  }

  updateSurnameShownCount();
}

export function _updateCenterPersonBtn() {
  const btn = document.getElementById('center-person-btn');
  if (!btn) return;
  btn.disabled = !state.selectedIndiId;
  btn.classList.toggle('has-selection', !!state.selectedIndiId);
}

export function _refocus() {
  state._firstLoad = true;
  applyFilter();
  updateFocusUI();
  updateHLButtons();
}

export function focusOnPerson(id) {
  if (!id || !state.individuals.has(id)) return;
  if (id !== state.focusRootId) state._revealed.clear();   // expansions belonged to the old chart
  state.focusRootId = id;
  _refocus();
}

export function clearFocus() {
  if (!state.focusRootId) return;
  state.focusRootId = null;
  state._revealed.clear();
  _refocus();
}

export function maxCousinDegree() {
  return Math.max(1, generationCount() - 1);
}

export function cousinLevelLabel(deg, max) {
  if (deg >= max && max > 4) return t('focus.cousinLevelAll');
  if (deg <= 4) return t('focus.cousinLevel' + deg);
  return t('focus.cousinLevelN', { n: deg });
}

export function setCousinDegree(v) {
  const max = maxCousinDegree();
  state.cousinDegree = Math.max(0, Math.min(max, parseInt(v)));
  if (!Number.isFinite(state.cousinDegree)) state.cousinDegree = 1;
  localStorage.setItem('cousinDegree', state.cousinDegree);
  const out = document.getElementById('cousin-degree-val');
  if (out) out.textContent = cousinLevelLabel(state.cousinDegree, max);
  if (state.focusRootId) _refocus();
}

export function updateCousinDegreeUI() {
  const slider = document.getElementById('cousin-degree-slider');
  const tick   = document.getElementById('cousin-degree-ticks');
  const out    = document.getElementById('cousin-degree-val');
  if (!slider) return;
  const max = maxCousinDegree();
  slider.max = max;
  if (state.cousinDegree > max) state.cousinDegree = max;
  slider.value = state.cousinDegree;
  if (out) out.textContent = cousinLevelLabel(state.cousinDegree, max);
  if (tick && tick.childElementCount !== max + 1) {
    tick.innerHTML = '';
    for (let d = 0; d <= max; d++) {
      const o = document.createElement('option');
      o.value = d;
      o.label = String(d);
      tick.appendChild(o);
    }
  }
}

export function maxFocusLimit() {
  return Math.max(10, state.individuals.size);
}

export function setFocusLimit(v) {
  state.focusLimit = Math.max(10, parseInt(v) || 120);
  localStorage.setItem('focusLimit', state.focusLimit);
  const out = document.getElementById('focus-limit-val');
  if (out) out.textContent = state.focusLimit;
  if (state.focusRootId) _refocus();
}

export function updateFocusLimitUI() {
  const slider = document.getElementById('focus-limit-slider');
  const out    = document.getElementById('focus-limit-val');
  if (!slider) return;
  slider.max = maxFocusLimit();
  slider.value = Math.min(state.focusLimit, +slider.max);
  if (out) out.textContent = state.focusLimit;
}

export function _genRangePair(min, max) {
  const last = generationCount() - 1;
  if (last < 0) return null;
  let lo = Math.max(0, Math.min(last, parseInt(min)));
  let hi = Math.max(0, Math.min(last, parseInt(max)));
  if (lo > hi) [lo, hi] = [hi, lo];
  return { lo, hi, last };
}

export function previewGenRange(min, max) {
  const p = _genRangePair(min, max);
  if (p) _paintGenRange(p.lo, p.hi, p.last);
}

export function setGenRange(min, max) {
  const p = _genRangePair(min, max);
  if (!p) return;
  state.genRange = (p.lo === 0 && p.hi === p.last) ? null : { min: p.lo, max: p.hi };
  updateGenRangeUI();
  applyFilter();
}

export function _paintGenRange(lo, hi, last) {
  const out = document.getElementById('gen-range-val');
  const box = document.getElementById('gen-range');
  if (out) out.textContent = lo === hi ? lo : `${lo} – ${hi}`;
  if (box && last > 0) {
    box.style.setProperty('--gen-lo', (lo / last) * 100 + '%');
    box.style.setProperty('--gen-hi', (hi / last) * 100 + '%');
  }
}

export function updateGenRangeUI() {
  const row  = document.getElementById('gen-range-row');
  const box  = document.getElementById('gen-range');
  const lo   = document.getElementById('gen-range-min');
  const hi   = document.getElementById('gen-range-max');
  const tick = document.getElementById('gen-range-ticks');
  if (!row || !box || !lo || !hi) return;

  const last = generationCount() - 1;
  // One generation is not a range, and no generations is not a control.
  const show = last > 0 ? '' : 'none';
  row.style.display = box.style.display = show;
  if (tick) tick.style.display = show;
  if (last <= 0) return;

  const sel = state.genRange || { min: 0, max: last };
  for (const el of [lo, hi]) { el.min = 0; el.max = last; }
  lo.value = sel.min;
  hi.value = sel.max;

  // Ticks are the datalist, rendered as its own flex row of labels. Past a
  // handful of generations every label would not fit, so thin them out and
  // keep the two ends — those are the ones the reader is aiming at.
  if (tick && tick.childElementCount !== last + 1) {
    const step = Math.ceil((last + 1) / 12);
    tick.innerHTML = '';
    for (let g = 0; g <= last; g++) {
      const o = document.createElement('option');
      o.value = g;
      o.label = (g % step === 0 || g === last) ? g : '';
      tick.appendChild(o);
    }
  }

  _paintGenRange(sel.min, sel.max, last);
}

export function updateFocusUI() {
  const panel = document.getElementById('focus-panel');
  if (!panel) return;
  updateGenRangeUI();
  updateCousinDegreeUI();
  updateFocusLimitUI();
  // The panel starts hidden in the markup and used to be revealed by the same
  // line that hid it again in 3D. It belongs to both views now, so it is simply
  // shown once there is a tree to focus within.
  panel.style.display = state.individuals.size ? '' : 'none';

  const nameEl   = document.getElementById('focus-current-name');
  const hiddenEl = document.getElementById('focus-hidden-info');
  const clearBtn = document.getElementById('focus-clear-btn');
  if (!nameEl) return;

  if (state.focusRootId && state.individuals.has(state.focusRootId)) {
    nameEl.textContent = state.individuals.get(state.focusRootId).displayName || state.focusRootId;
    nameEl.classList.remove('focus-none');
    if (clearBtn) clearBtn.style.display = '';
    const hidden = focusHiddenCount();
    if (hiddenEl) {
      hiddenEl.textContent = hidden ? t('focus.hidden', { n: hidden }) : t('focus.allShown');
      hiddenEl.style.display = '';
    }
  } else {
    nameEl.textContent = t('focus.none');
    nameEl.classList.add('focus-none');
    if (clearBtn) clearBtn.style.display = 'none';
    if (hiddenEl) { hiddenEl.textContent = ''; hiddenEl.style.display = 'none'; }
  }
}
