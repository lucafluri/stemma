// A starting layout for the 3D scene, computed rather than simulated.
//
// A force layout begins by untangling a random cloud, and at twelve thousand
// people that untangling costs 45 ms a tick and never finishes inside the
// settle window — which is why a large tree ends up as a dense knot with links
// crossing the whole of it.
//
// But a genealogy is not an arbitrary graph, and almost all of the answer is
// already known before any force is applied:
//
//  · Generations are a strict vertical order, and the 3D view already pins Y to
//    it (applyTimelineYFix). Only X and Z are ever in question.
//  · Descent is a forest. If a family occupies an angular wedge and its children
//    occupy sub-wedges of that wedge, then every relative is close to every
//    other relative by construction, and no two branches overlap.
//
// So each person is placed on the ring for their generation, at an angle
// inherited from their parents. That is a cone tree: parents and children sit
// at nearly the same angle one row apart, siblings sit side by side, and two
// unrelated branches never start on top of each other. The simulation then only
// has to relax it locally instead of discovering the shape from nothing.
//
// The previous attempt at this seeded a golden-angle spiral by breadth-first
// index. That spreads points evenly over a disc — which is the opposite of what
// is wanted here, because consecutive indices land on opposite sides, so
// relatives started as far apart as possible. It measured a mean link length of
// 8,115 against a rest length of 193. Structure, not even coverage, is the point.
import { state } from './state.js';
import { computeGenerationDepths } from './graph-data.js';
import { physicsScale } from './constants.js';

const TWO_PI = Math.PI * 2;

/** Descent within the scene: who are a person's children, and who their parent. */
function _descent(inScene) {
  const kids = new Map();       // parent id -> [child ids]
  const hasParent = new Set();  // children with a parent also in the scene
  const partners = new Map();   // id -> [partner ids]
  const famMembers = new Map(); // fam id -> [member ids in scene]

  const push = (map, k, v) => {
    const a = map.get(k);
    if (a) a.push(v); else map.set(k, [v]);
  };

  for (const [fid, fam] of state.families) {
    const par = [fam.husb, fam.wife].filter(p => p && inScene.has(p));
    const ch  = (fam.chil || []).filter(c => inScene.has(c));
    if (!par.length && !ch.length) continue;
    if (inScene.has(fid)) famMembers.set(fid, [...par, ...ch]);
    if (par.length === 2) { push(partners, par[0], par[1]); push(partners, par[1], par[0]); }
    for (const p of par) {
      for (const c of ch) { push(kids, p, c); hasParent.add(c); }
    }
  }
  return { kids, hasParent, partners, famMembers };
}

/**
 * Lay the scene out from its own structure. Mutates x/z on the given node
 * objects; y is left alone, because the stratification owns it.
 */
export function seedScene3D(data) {
  const nodes = data.nodes;
  if (!nodes.length) return;
  const inScene = new Set(nodes.map(n => n.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const { kids, hasParent, partners, famMembers } = _descent(inScene);

  const depths = computeGenerationDepths();
  const genOf = id => depths.get(id) ?? 0;

  // How crowded a generation is decides how wide its *disc* has to be: k people
  // at a given spacing need an area of k·spacing², so the radius goes as the
  // square root of the count.
  //
  // Sizing it by circumference instead — k spacings around a ring — is what the
  // first version did, and it explodes: a three-thousand-person generation asked
  // for a radius of 92,000 while the generation above it sat at 1,000, so every
  // parent-child link spanned the whole scene. It measured a mean link length of
  // 9,581 against a rest length of 193.
  const perGen = new Map();
  for (const n of nodes) {
    if (n.type !== 'INDI') continue;
    const g = genOf(n.id);
    perGen.set(g, (perGen.get(g) || 0) + 1);
  }
  const spacing = state.physicsParams.parentDist * physicsScale(nodes.length);
  const radiusOf = g => Math.max(spacing, spacing * Math.sqrt((perGen.get(g) || 1) / Math.PI));

  // ── Angles, inherited down the descent forest ──
  // Every root gets a slice of the circle in proportion to how many descendants
  // it has, so a large branch is not crushed into the same wedge as a lone
  // person. Each person then splits their own wedge among their children.
  const weight = new Map();     // id -> descendant leaf weight
  const order = [];             // roots first, then a stable DFS order

  const roots = [];
  for (const n of nodes) {
    if (n.type !== 'INDI') continue;
    if (!hasParent.has(n.id)) roots.push(n.id);
  }
  // A file can be entirely cyclic, or every person can have a parent inside a
  // component with no entry point. Falling back to *some* root keeps the walk
  // total rather than silently placing nobody.
  if (!roots.length) for (const n of nodes) { if (n.type === 'INDI') { roots.push(n.id); break; } }

  // Iterative post-order for the weights — a deep pedigree would blow the stack
  // on the recursive form, and GEDCOM files with a cycle in them exist.
  const seen = new Set();
  {
    const stack = roots.map(id => [id, false]);
    while (stack.length) {
      const frame = stack.pop();
      const [id, expanded] = frame;
      if (expanded) {
        let w = 0;
        for (const c of kids.get(id) || []) w += weight.get(c) || 0;
        weight.set(id, Math.max(1, w));
        continue;
      }
      if (seen.has(id)) { weight.set(id, weight.get(id) || 1); continue; }
      seen.add(id);
      order.push(id);
      stack.push([id, true]);
      for (const c of kids.get(id) || []) if (!seen.has(c)) stack.push([c, false]);
    }
  }

  // The wedge belongs to a *couple*, not to a person. Splitting it per
  // individual puts a husband and wife in different sectors of the circle, and
  // then their children are next to one parent and across the chart from the
  // other — which measured as no better than placing everyone at random.
  const angle = new Map();
  const frac  = new Map();   // where in its generation's disc a person sits, 0..1
  const placed = new Set();
  {
    const unitOf = id => {
      const u = [id];
      for (const p of partners.get(id) || []) if (!placed.has(p) && !u.includes(p)) u.push(p);
      return u;
    };

    const rootUnits = [];
    const takenAsRoot = new Set();
    for (const id of roots) {
      if (takenAsRoot.has(id)) continue;
      const u = [id];
      takenAsRoot.add(id);
      for (const p of partners.get(id) || []) {
        if (!takenAsRoot.has(p) && inScene.has(p)) { takenAsRoot.add(p); u.push(p); }
      }
      rootUnits.push(u);
    }

    const unitWeight = u => u.reduce((s, id) => s + (weight.get(id) || 1), 0) || 1;
    const total = rootUnits.reduce((s, u) => s + unitWeight(u), 0) || 1;

    const stack = [];
    let a = 0;
    rootUnits.forEach((u, i) => {
      const w = unitWeight(u) / total * TWO_PI;
      // Root families start spread across the disc; everyone below inherits.
      stack.push([u, a, a + w, (i + 0.5) / rootUnits.length]);
      a += w;
    });

    while (stack.length) {
      const [unit, a0, a1, f] = stack.pop();
      const members = unit.filter(id => !placed.has(id));
      if (!members.length) continue;
      const mid = (a0 + a1) / 2;
      // Partners share the wedge, nudged apart just enough not to be coincident
      // — the simulation separates them properly, this only has to avoid a
      // divide-by-zero pile-up at exactly the same point.
      members.forEach((id, i) => {
        placed.add(id);
        angle.set(id, mid + (i - (members.length - 1) / 2) * Math.min(0.02, (a1 - a0) * 0.1));
        frac.set(id, f);
      });

      // Children of the couple, each taken together with their own partners so
      // the next generation is grouped the same way.
      const seenChild = new Set();
      const childUnits = [];
      for (const m of members) {
        for (const c of kids.get(m) || []) {
          if (placed.has(c) || seenChild.has(c)) continue;
          seenChild.add(c);
          const cu = unitOf(c);
          for (const x of cu) seenChild.add(x);
          childUnits.push(cu);
        }
      }
      if (!childUnits.length) continue;
      const wTotal = childUnits.reduce((s, u) => s + unitWeight(u), 0) || 1;
      let cur = a0;
      childUnits.forEach((cu, i) => {
        const w = unitWeight(cu) / wTotal * (a1 - a0);
        // Children keep their parents' place in the disc, nudged apart so
        // siblings do not stack. Inheriting this as well as the angle is what
        // keeps a parent-child link short: both ends stay near the same point
        // of the disc, one generation apart in Y.
        const spread = childUnits.length > 1 ? (i / (childUnits.length - 1) - 0.5) * 0.12 : 0;
        stack.push([cu, cur, cur + w, Math.min(1, Math.max(0, f + spread))]);
        cur += w;
      });
    }
  }

  // Anyone the descent walk never reached — most often somebody who married in
  // and has no children in the scene — sits beside their partner rather than at
  // an arbitrary angle, which is where the layout would put them anyway.
  for (const n of nodes) {
    if (n.type !== 'INDI' || angle.has(n.id)) continue;
    let a = null;
    for (const p of partners.get(n.id) || []) {
      if (angle.has(p)) { a = angle.get(p) + 0.01; break; }
    }
    let f = null;
    for (const p of partners.get(n.id) || []) if (frac.has(p)) { f = frac.get(p); break; }
    angle.set(n.id, a ?? Math.random() * TWO_PI);
    frac.set(n.id, f ?? Math.random());
  }

  for (const n of nodes) {
    if (n.type !== 'INDI') continue;
    // sqrt of the fraction, so an evenly spread set of fractions fills the disc
    // evenly instead of crowding the middle.
    const r = radiusOf(genOf(n.id)) * Math.sqrt(frac.get(n.id) ?? 0.5);
    const a = angle.get(n.id) ?? 0;
    n.x = Math.cos(a) * r;
    n.z = Math.sin(a) * r;
  }

  // Family markers go where their members already are — they have no generation
  // of their own, and a marker is only ever meaningful between the people it
  // joins.
  for (const n of nodes) {
    if (n.type !== 'FAM') continue;
    const mem = (famMembers.get(n.id) || []).map(id => byId.get(id)).filter(Boolean);
    if (!mem.length) { n.x = 0; n.z = 0; continue; }
    let sx = 0, sz = 0;
    for (const m of mem) { sx += m.x || 0; sz += m.z || 0; }
    n.x = sx / mem.length;
    n.z = sz / mem.length;
  }
}
