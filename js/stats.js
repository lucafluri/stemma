import { state } from './state.js';
import { familyNamesOf } from './colors.js';
import { escAttr, escHtml, escJs } from './gedcom-io.js';
import { arrMax, arrMin, minMax } from './constants.js';
import { computeGenerationDepths } from './graph-data.js';
import { showIndiDetail } from './panels.js';
import { collectAncestors, collectDescendants } from './relations.js';
import { positionTooltip, zoomToNode } from './render-2d.js';

// Figures about the tree as a whole.
//
// Everything here is counted from *recorded* facts only — never from the
// estimated birth years the layout uses. An average lifespan computed partly
// from guesses is a number that looks like evidence and is not, and this panel
// is the one place in the app a reader is most likely to believe what it says.
// Where a figure rests on a subset, the size of that subset is reported with it
// so the reader can judge it.

const year = s => {
  const m = (s || '').match(/\b(\d{3,4})\b/);
  return m ? +m[1] : null;
};

const mean   = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
// Not Math.max(...a): these run over whole-file arrays, which spread onto the
// call stack and throw RangeError once a file is big enough. See minMax().
const max = arrMax;
const min = arrMin;

const topN = (counts, n) => [...counts.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, n);

export function computeStats() {
  const people = [...state.individuals.values()];
  const fams   = [...state.families.values()];
  if (!people.length) return null;

  const sex = { M: 0, F: 0, U: 0 };
  const sexIds = { M: [], F: [], U: [] };
  const livingIds = [], deceasedIds = [], childDeathIds = [], lifespanIds = [];
  const withBirthIds = [], withDeathIds = [], withPlaceIds = [];
  const surnames = new Map(), places = new Map(), occupations = new Map(), causes = new Map();
  // Given names are tallied per sex rather than into one list. Pooled, the
  // ranking is really two rankings interleaved by how many men and women the
  // tree happens to hold, and the naming pattern within each — which is what
  // anyone reads this list for — is not visible in it.
  const givenBySex = { M: new Map(), F: new Map(), U: new Map() };
  const allDeathAges = [];         // every recorded death age, for child mortality
  const lifespans = [];            // recorded death ages of 5 or older
  let childDeaths = 0;
  let deceased = 0, withBirth = 0, withDeath = 0, withPlace = 0, withOccupation = 0;
  let oldest = null;

  for (const p of people) {
    const sexKey = p.sex === 'M' || p.sex === 'F' ? p.sex : 'U';
    sex[sexKey]++;
    sexIds[sexKey].push(p.id);
    if (p.deceased) { deceased++; deceasedIds.push(p.id); } else livingIds.push(p.id);

    const b = p.birthYear || year(p.birth?.date);
    const d = year(p.death?.date);
    if (b) { withBirth++; withBirthIds.push(p.id); }
    if (d) { withDeath++; withDeathIds.push(p.id); }
    if (p.birth?.plac || p.death?.plac) { withPlace++; withPlaceIds.push(p.id); }
    if ((p.occu || '').trim()) {
      withOccupation++;
      const key = p.occu.trim();
      occupations.set(key, (occupations.get(key) || 0) + 1);
    }

    // A lifespan needs both ends recorded, must be an actual death, and is not
    // counted for the average if the person died in early childhood. Child
    // deaths are tracked separately because they would otherwise pull the
    // "average age" figure down without the reader noticing.
    // Negative or absurd spans are data errors — a transcription slip, or two
    // people merged into one — and averaging them in would quietly drag the
    // figure around.
    if (p.deceased && b && d && d >= b && d - b <= 120) {
      const age = d - b;
      allDeathAges.push(age);
      if (age >= 5) {
        lifespans.push(age);
        lifespanIds.push(p.id);
        if (!oldest || age > oldest.age) oldest = { id: p.id, age, name: p.displayName || p.id, born: b, died: d };
      } else {
        childDeaths++;
        childDeathIds.push(p.id);
      }
    }
    // Both the surname carried and the maiden name, from the same definition
    // the sidebar legend uses — counting only `surn` here made this list
    // disagree with that one about the size of every family a woman married
    // into or out of.
    for (const s of familyNamesOf(p)) surnames.set(s, (surnames.get(s) || 0) + 1);
    // First given name only: "Hans Peter" and "Hans" are the same name being
    // handed down, which is the thing worth seeing.
    const g = (p.givn || '').trim().split(/\s+/)[0];
    if (g) {
      const m = givenBySex[sexKey];
      m.set(g, (m.get(g) || 0) + 1);
    }
    for (const pl of [p.birth?.plac, p.death?.plac]) {
      const v = (pl || '').trim();
      if (v) places.set(v, (places.get(v) || 0) + 1);
    }
    const c = (p.death?.caus || '').trim();
    if (c) causes.set(c, (causes.get(c) || 0) + 1);
  }

  // ── Families ──
  const childCounts = fams.map(f => (f.chil || []).filter(c => state.individuals.has(c)).length);
  const withChildren = childCounts.filter(n => n > 0);
  let biggest = null;
  const childlessIds = new Set();
  for (const f of fams) {
    const kids = (f.chil || []).filter(c => state.individuals.has(c));
    const par  = [f.husb, f.wife].filter(x => state.individuals.has(x));
    if (!kids.length) par.forEach(x => childlessIds.add(x));
    if (!biggest || kids.length > biggest.n) {
      biggest = {
        n: kids.length,
        parents: par.map(x => state.individuals.get(x).displayName || x),
        ids: [...par, ...kids],
      };
    }
  }
  const divorced = fams.filter(f => f.div).length;
  const divorcedIds = fams.filter(f => f.div).flatMap(f => [f.husb, f.wife]).filter(x => state.individuals.has(x));
  const marriageYears = fams.flatMap(f => (f.marriages || []).map(m => year(m.date))).filter(Boolean);

  // ── Marriage age and generation gap ──
  // Each entry keeps the id it belongs to, not just the number — the row
  // shows an average, but the click behind it has to land on real people.
  const marriageAges = [];
  for (const p of people) {
    const b = p.birthYear || year(p.birth?.date);
    if (!b) continue;
    let firstYear = null;
    for (const famId of p.fams || []) {
      const f = state.families.get(famId);
      if (!f) continue;
      for (const m of f.marriages || []) {
        const y = year(m.date);
        if (y && (firstYear == null || y < firstYear)) firstYear = y;
      }
    }
    if (firstYear != null && firstYear >= b && firstYear - b <= 120) {
      marriageAges.push({ age: firstYear - b, id: p.id });
    }
  }

  const parentAges = [];
  for (const f of fams) {
    const parents = [f.husb, f.wife]
      .filter(id => id && state.individuals.has(id))
      .map(id => state.individuals.get(id));
    if (!parents.length) continue;
    for (const cid of f.chil || []) {
      const child = state.individuals.get(cid);
      if (!child) continue;
      const cb = child.birthYear || year(child.birth?.date);
      if (!cb) continue;
      for (const par of parents) {
        const pb = par.birthYear || year(par.birth?.date);
        if (pb && cb >= pb && cb - pb <= 100) {
          parentAges.push({ age: cb - pb, id: par.id });
        }
      }
    }
  }

  const minAge = min(marriageAges.map(x => x.age));
  const minParentAge = min(parentAges.map(x => x.age));

  // ── Time span and generations ──
  const birthYears = people.map(p => p.birthYear || year(p.birth?.date)).filter(Boolean);
  const depths = computeGenerationDepths();
  const depthSpan = minMax(depths.values());
  const generations = depthSpan ? depthSpan.max - depthSpan.min + 1 : 0;

  // ── Spread of the tree ──
  // How many people carry the tree forward versus how many are leaves. A
  // genealogy is mostly leaves; the ratio says how much of it is a line and how
  // much is breadth.
  const hasChildren = new Set();
  for (const f of fams) {
    for (const s of [f.husb, f.wife]) {
      if (s && state.individuals.has(s) && (f.chil || []).some(c => state.individuals.has(c))) hasChildren.add(s);
    }
  }
  const marriedPeople = new Set();
  for (const f of fams) for (const s of [f.husb, f.wife]) if (s && state.individuals.has(s)) marriedPeople.add(s);

  // ── Births by decade — the shape of the tree over time ──
  const decadeCounts = new Map();
  for (const y of birthYears) {
    const d = Math.floor(y / 10) * 10;
    decadeCounts.set(d, (decadeCounts.get(d) || 0) + 1);
  }
  const timeline = [];
  if (birthYears.length) {
    // Every decade in the span, not only the ones with a birth — a gap decade
    // is itself the finding (a war, an emigration), and dropping it would
    // silently pull its neighbours together and hide exactly that.
    const d0 = Math.floor(min(birthYears) / 10) * 10;
    const d1 = Math.floor(max(birthYears) / 10) * 10;
    for (let d = d0; d <= d1; d += 10) timeline.push({ decade: d, n: decadeCounts.get(d) || 0 });
  }

  // ── Most descendants — who the tree actually branches from ──
  // Memoised per id rather than one collectDescendants() BFS per person: that
  // walk revisits the same shared descendants for every one of their
  // ancestors, which is O(people × subtree) instead of O(people).
  const descCount = new Map();
  const countDescendants = id => {
    if (descCount.has(id)) return descCount.get(id);
    descCount.set(id, 0);   // cycle guard for malformed data
    let n = 0;
    const seenKids = new Set();
    for (const famId of state.individuals.get(id)?.fams || []) {
      for (const cid of state.families.get(famId)?.chil || []) {
        if (seenKids.has(cid) || !state.individuals.has(cid)) continue;
        seenKids.add(cid);
        n += 1 + countDescendants(cid);
      }
    }
    descCount.set(id, n);
    return n;
  };
  for (const p of people) countDescendants(p.id);
  const prolific = [...descCount.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([id, n]) => ({ id, n, name: state.individuals.get(id)?.displayName || id }));

  // ── Multiple births — same family, same recorded birth year ──
  // A year, not a full date: most GEDCOMs this old do not carry the day, and
  // requiring one would miss the very twins whose birth year is all that
  // survived.
  let twinGroups = 0;
  const twinIds = [];
  for (const f of fams) {
    const byYear = new Map();
    for (const cid of f.chil || []) {
      const c = state.individuals.get(cid);
      const by = c?.birthYear || year(c?.birth?.date);
      if (by) { if (!byYear.has(by)) byYear.set(by, []); byYear.get(by).push(cid); }
    }
    for (const ids of byYear.values()) if (ids.length >= 2) { twinGroups++; twinIds.push(...ids); }
  }

  // ── Remarriage ──
  let remarried = 0, mostMarried = null;
  const remarriedIds = [];
  for (const p of people) {
    const n = (p.fams || []).filter(fid => state.families.has(fid)).length;
    if (n > 1) { remarried++; remarriedIds.push(p.id); }
    if (n > 1 && (!mostMarried || n > mostMarried.n)) mostMarried = { id: p.id, n, name: p.displayName || p.id };
  }

  // ── Spousal age gap ──
  const spouseGaps = [];
  let maxSpouseGap = -1, maxSpouseGapIds = [];
  for (const f of fams) {
    const h = state.individuals.get(f.husb), w = state.individuals.get(f.wife);
    if (!h || !w) continue;
    const hb = h.birthYear || year(h.birth?.date), wb = w.birthYear || year(w.birth?.date);
    if (!hb || !wb) continue;
    const gap = Math.abs(hb - wb);
    spouseGaps.push(gap);
    if (gap > maxSpouseGap) { maxSpouseGap = gap; maxSpouseGapIds = [f.husb, f.wife]; }
    else if (gap === maxSpouseGap) maxSpouseGapIds.push(f.husb, f.wife);
  }

  // ── Consanguinity — couples who share a known common ancestor ──
  // Reuses the same ancestor walk the highlight/relation tools use, so a
  // "shared ancestor" here means exactly what it means everywhere else in
  // the app. Bounded by how many families have both parents recorded, not by
  // the size of the tree, so this stays cheap even on a large file.
  let cousinCouples = 0;
  const cousinCoupleIds = [];
  for (const f of fams) {
    if (!f.husb || !f.wife || !state.individuals.has(f.husb) || !state.individuals.has(f.wife)) continue;
    const aH = collectAncestors(f.husb); aH.delete(f.husb);
    const aW = collectAncestors(f.wife); aW.delete(f.wife);
    for (const x of aH) {
      if (state.individuals.has(x) && aW.has(x)) { cousinCouples++; cousinCoupleIds.push(f.husb, f.wife); break; }
    }
  }
  const neverMarriedIds = people.map(p => p.id).filter(id => !marriedPeople.has(id));

  return {
    people: people.length,
    families: fams.length,
    sex,
    sexIds,
    deceased,
    living: people.length - deceased,
    livingIds,
    deceasedIds,

    lifespan: {
      n: lifespans.length,
      mean: mean(lifespans),
      median: median(lifespans),
      ids: lifespanIds,
      oldest,
      childDeaths,
      childDeathIds,
      childRate: allDeathAges.length ? childDeaths / allDeathAges.length : null,
    },

    marriageAge: {
      n: marriageAges.length,
      mean: mean(marriageAges.map(x => x.age)),
      min: min(marriageAges.map(x => x.age)),
      ids: marriageAges.map(x => x.id),
      minIds: marriageAges.filter(x => x.age === minAge).map(x => x.id),
    },
    parentAge: {
      n: parentAges.length,
      mean: mean(parentAges.map(x => x.age)),
      min: min(parentAges.map(x => x.age)),
      ids: parentAges.map(x => x.id),
      minIds: parentAges.filter(x => x.age === minParentAge).map(x => x.id),
    },

    children: {
      meanAll: mean(childCounts),
      meanWithChildren: mean(withChildren),
      childless: childCounts.length - withChildren.length,
      childlessIds: [...childlessIds],
      biggest,
    },

    span: {
      earliest: min(birthYears),
      latest:   max(birthYears),
      generations,
      firstMarriage: min(marriageYears),
    },

    families2: {
      divorced, divorcedIds, married: marriedPeople.size, parents: hasChildren.size,
      neverMarried: people.length - marriedPeople.size,
      neverMarriedIds,
      remarried, remarriedIds, mostMarried,
      spouseGap: { n: spouseGaps.length, mean: mean(spouseGaps), max: max(spouseGaps), maxIds: maxSpouseGapIds },
      cousinCouples, cousinCoupleIds,
    },

    completeness: {
      birth: withBirth / people.length,
      death: withDeath / people.length,
      place: withPlace / people.length,
      occupation: withOccupation / people.length,
      birthIds: withBirthIds, deathIds: withDeathIds, placeIds: withPlaceIds,
    },

    timeline,
    prolific,
    twinGroups,
    twinIds,

    // Names and places are the lists worth reading down: five entries only ever
    // showed the handful of families and villages anyone already knew about.
    // Occupations and causes of death stay short — they are free text, so their
    // tail is mostly one-offs and spelling variants rather than a ranking.
    top: {
      surnames:   topN(surnames, 10),
      // Ten each, not ten between them.
      givenM:     topN(givenBySex.M, 10),
      givenF:     topN(givenBySex.F, 10),
      // Only worth a list when the tree actually has people of unrecorded sex;
      // leaving their names out entirely would quietly shrink the totals a
      // reader is comparing against the sex breakdown above.
      givenU:     topN(givenBySex.U, 10),
      places:     topN(places, 10),
      occupations: topN(occupations, 3),
      causes:     topN(causes, 3),
    },
  };
}

// ── Rendering ──

const pct = v => Math.round(v * 100) + '%';
const num = (v, digits = 1) => v == null ? '–' : (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString();

// The figures the panel last drew, so a click on one of them can hand back
// the exact ids that made it up without re-walking the whole tree — and so a
// click still resolves correctly against whatever is now selected even if
// the reader has since scrolled.
let _lastStats = null;

/** `call` is a ready-made `fn(arg)` JS expression (already quoted/escaped by
 * the caller) or null/undefined for a row that is information only. */
function statRow(label, value, hint, call) {
  const clickable = call ? ' stat-row--clickable' : '';
  const attrs = call ? ` onclick="${call}" tabindex="0" role="button"` : '';
  return `<div class="stat-row${clickable}"${attrs}><span class="stat-label">${escHtml(label)}</span>` +
         `<span class="stat-value">${escHtml(String(value))}` +
         (hint ? `<span class="stat-hint">${escHtml(hint)}</span>` : '') +
         `</span></div>`;
}

/** `kind` names one of the switch cases in personIdsForKind() below; each
 * entry's own name doubles as the lookup value and the detail title. */
function statList(label, entries, kind) {
  if (!entries.length) return '';
  // The name carries its own title: a 220px sidebar clips "Tettnang,
  // Bodenseekreis, Tübingen…" to the point of being unreadable, and hovering is
  // the only way back to it.
  const items = entries.map(([name, n]) =>
    `<li class="stat-row--clickable" tabindex="0" role="button" ` +
    `onclick="showStatSubset('${kind}','${escJs(name)}','${escJs(name)}')">` +
    `<span title="${escAttr(name)}">${escHtml(name)}</span><span class="stat-hint">${n}</span></li>`).join('');
  return `<div class="stat-group"><div class="stat-group-title">${escHtml(label)}</div><ul class="stat-list">${items}</ul></div>`;
}

/** Births per decade, as a column chart. Single series — position already
 * carries the magnitude, so every column is one flat colour rather than
 * shaded by height, and there is no legend to draw for it. Spans both
 * #stats-body columns (`column-span: all`), since a timeline squeezed into
 * one 240px column is unreadable. Hover gets the app's own cursor-following
 * tooltip rather than the browser's native title="", and a click drills into
 * who was actually born that decade. */
function statTimeline(label, timeline) {
  if (timeline.length < 2) return '';
  const maxN = Math.max(arrMax(timeline.map(d => d.n)) ?? 1, 1);
  // A label on every column collides past a dozen or so decades; thin them
  // out to roughly eight, spread evenly, rather than truncating the axis.
  const labelEvery = Math.max(1, Math.round(timeline.length / 8));
  const bars = timeline.map((d, i) => {
    const h = Math.round((d.n / maxN) * 100);
    const lbl = i % labelEvery === 0 || i === timeline.length - 1
      ? `<span class="stat-timeline-label">${d.decade}</span>` : '';
    const dis = d.n ? '' : ' stat-timeline-bar--empty';
    return `<div class="stat-timeline-bar${dis}" style="height:${Math.max(h, d.n ? 3 : 0)}%" ` +
      `onmousemove="statBarHover(event,${d.decade},${d.n})" onmouseleave="statBarOut()" ` +
      `onclick="showStatSubset('decade',${d.decade},'${d.decade}–${d.decade + 9}')">${lbl}</div>`;
  }).join('');
  return `<div class="stat-group stat-timeline"><div class="stat-group-title">${escHtml(label)}</div>` +
    `<div class="stat-timeline-chart">${bars}</div></div>`;
}

function statTile(label, value) {
  return `<div class="stat-tile"><div class="stat-tile-value">${escHtml(String(value))}</div>` +
    `<div class="stat-tile-label">${escHtml(label)}</div></div>`;
}

function statCard(icon, title, rows) {
  const body = rows.filter(Boolean).join('');
  if (!body) return '';
  return `<div class="stat-card"><div class="stat-card-title">${icon ? icon + ' ' : ''}${escHtml(title)}</div>${body}</div>`;
}

export function renderStats() {
  const box = document.getElementById('stats-body');
  if (!box) return;
  const s = computeStats();
  _lastStats = s;
  backToStatsOverview();
  if (!s) { box.innerHTML = `<div class="stat-empty">${escHtml(t('stats.empty'))}</div>`; return; }

  const sexBar = ['M', 'F', 'U']
    .filter(k => s.sex[k])
    .map(k => `<span class="stat-seg stat-seg-${k}" style="flex:${s.sex[k]}" onclick="showStatSubset('sex','${k}','${escJs(t('stats.sex' + k))}')" title="${escHtml(t('stats.sex' + k))}: ${s.sex[k]}"></span>`)
    .join('');

  box.innerHTML = [
    `<div class="stat-tiles">`,
    statTile(t('stats.people'), s.people.toLocaleString()),
    statTile(t('stats.living'), s.living.toLocaleString()),
    statTile(t('stats.families'), s.families.toLocaleString()),
    statTile(t('stats.generations'), s.span.generations),
    `</div>`,
    `<div class="stat-bar">${sexBar}</div>`,

    statCard('&#x1F465;', t('stats.cardPeople'), [
      statRow(t('stats.people'), s.people.toLocaleString(), null, `showStatSubset('sex',null,'${escJs(t('stats.people'))}')`),
      statRow(t('stats.male'),   `${s.sex.M} (${pct(s.sex.M / s.people)})`, null, `showStatSubset('sex','M','${escJs(t('stats.male'))}')`),
      statRow(t('stats.female'), `${s.sex.F} (${pct(s.sex.F / s.people)})`, null, `showStatSubset('sex','F','${escJs(t('stats.female'))}')`),
      s.sex.U ? statRow(t('stats.unknownSex'), `${s.sex.U} (${pct(s.sex.U / s.people)})`, null,
        `showStatSubset('sex','U','${escJs(t('stats.unknownSex'))}')`) : '',
      statRow(t('stats.living'), `${s.living} / ${s.deceased}`, t('stats.livingHint'),
        `showStatSubset('living',null,'${escJs(t('stats.living'))}')`),
    ]),

    statCard('&#x231B;', t('stats.cardLifespan'), [
      // The subset size travels with the average: on a tree where few people have
      // both dates, the number is a curiosity rather than a finding.
      statRow(t('stats.avgLifespan'), s.lifespan.mean == null ? '–' : num(s.lifespan.mean) + ' ' + t('stats.years'),
        t('stats.basedOn', { n: s.lifespan.n }),
        s.lifespan.n ? `showStatSubset('lifespan',null,'${escJs(t('stats.avgLifespan'))}')` : null),
      statRow(t('stats.medianLifespan'), s.lifespan.median == null ? '–' : num(s.lifespan.median, 0) + ' ' + t('stats.years'),
        null, s.lifespan.n ? `showStatSubset('lifespan',null,'${escJs(t('stats.medianLifespan'))}')` : null),
      s.lifespan.oldest ? statRow(t('stats.oldest'),
        `${s.lifespan.oldest.age} ${t('stats.years')}`,
        `${s.lifespan.oldest.name} (${s.lifespan.oldest.born}–${s.lifespan.oldest.died})`,
        `showStatSubset('oldest',null,'${escJs(t('stats.oldest'))}')`) : '',
      s.lifespan.childDeaths ? statRow(t('stats.childMortality'),
        s.lifespan.childDeaths.toLocaleString(),
        t('stats.childMortalityHint', { rate: pct(s.lifespan.childRate) }),
        `showStatSubset('childDeaths',null,'${escJs(t('stats.childMortality'))}')`) : '',
      s.marriageAge.n ? statRow(t('stats.avgMarriageAge'),
        num(s.marriageAge.mean) + ' ' + t('stats.years'),
        t('stats.avgMarriageAgeHint', { n: s.marriageAge.n }),
        `showStatSubset('marriageAge',null,'${escJs(t('stats.avgMarriageAge'))}')`) : '',
      s.marriageAge.n ? statRow(t('stats.youngestMarriage'), `${s.marriageAge.min} ${t('stats.years')}`, null,
        `showStatSubset('youngestMarriage',null,'${escJs(t('stats.youngestMarriage'))}')`) : '',
      s.parentAge.n ? statRow(t('stats.avgParentAge'),
        num(s.parentAge.mean) + ' ' + t('stats.years'),
        t('stats.avgParentAgeHint', { n: s.parentAge.n }),
        `showStatSubset('parentAge',null,'${escJs(t('stats.avgParentAge'))}')`) : '',
      s.parentAge.n ? statRow(t('stats.youngestParent'), `${s.parentAge.min} ${t('stats.years')}`, null,
        `showStatSubset('youngestParent',null,'${escJs(t('stats.youngestParent'))}')`) : '',
    ]),

    statCard('&#x1F46A;', t('stats.cardFamilies'), [
      statRow(t('stats.families'), s.families.toLocaleString()),
      statRow(t('stats.avgChildren'), num(s.children.meanWithChildren), t('stats.avgChildrenHint')),
      statRow(t('stats.childless'), s.children.childless, null,
        s.children.childless ? `showStatSubset('childless',null,'${escJs(t('stats.childless'))}')` : null),
      s.children.biggest && s.children.biggest.n > 0 ? statRow(t('stats.biggestFamily'),
        `${s.children.biggest.n} ${t('stats.childrenWord')}`, s.children.biggest.parents.join(' & '),
        `showStatSubset('biggest',null,'${escJs(t('stats.biggestFamily'))}')`) : '',
      s.families2.divorced ? statRow(t('stats.divorced'), s.families2.divorced, null,
        `showStatSubset('divorced',null,'${escJs(t('stats.divorced'))}')`) : '',
      s.twinGroups ? statRow(t('stats.twins'), s.twinGroups, t('stats.twinsHint'),
        `showStatSubset('twins',null,'${escJs(t('stats.twins'))}')`) : '',
    ]),

    statCard('&#x1F491;', t('stats.patterns'), [
      statRow(t('stats.neverMarried'), `${s.families2.neverMarried} (${pct(s.families2.neverMarried / s.people)})`, null,
        `showStatSubset('neverMarried',null,'${escJs(t('stats.neverMarried'))}')`),
      s.families2.remarried ? statRow(t('stats.remarried'), s.families2.remarried, null,
        `showStatSubset('remarried',null,'${escJs(t('stats.remarried'))}')`) : '',
      s.families2.mostMarried ? statRow(t('stats.mostMarried'),
        t('stats.mostMarriedCount', { n: s.families2.mostMarried.n }), s.families2.mostMarried.name,
        `showStatSubset('mostMarried',null,'${escJs(t('stats.mostMarried'))}')`) : '',
      s.families2.spouseGap.n ? statRow(t('stats.spouseGap'),
        num(s.families2.spouseGap.mean) + ' ' + t('stats.years'),
        t('stats.spouseGapHint', { n: s.families2.spouseGap.max }),
        `showStatSubset('spouseGapMax',null,'${escJs(t('stats.spouseGapMaxTitle'))}')`) : '',
      s.families2.cousinCouples ? statRow(t('stats.cousinCouples'), s.families2.cousinCouples,
        t('stats.cousinCouplesHint'), `showStatSubset('cousinCouples',null,'${escJs(t('stats.cousinCouples'))}')`) : '',
    ]),

    statCard('&#x1F4C5;', t('stats.cardTimeline'), [
      s.span.earliest ? statRow(t('stats.span'), `${s.span.earliest} – ${s.span.latest}`,
        t('stats.spanHint', { n: s.span.latest - s.span.earliest })) : '',
      statRow(t('stats.generations'), s.span.generations),
    ]),
    statTimeline(t('stats.timeline'), s.timeline),

    s.prolific.length ? statCard('&#x1F333;', t('stats.prolific'),
      s.prolific.map(p => statRow(p.name, t('stats.descendantCount', { n: p.n }), null,
        `showStatSubset('descendants','${escJs(p.id)}','${escJs(p.name)}')`))) : '',

    statCard('&#x1F4CB;', t('stats.completeness'), [
      statRow(t('stats.hasBirth'), pct(s.completeness.birth), null,
        `showStatSubset('hasBirth',null,'${escJs(t('stats.hasBirth'))}')`),
      statRow(t('stats.hasDeath'), pct(s.completeness.death), null,
        `showStatSubset('hasDeath',null,'${escJs(t('stats.hasDeath'))}')`),
      statRow(t('stats.hasPlace'), pct(s.completeness.place), null,
        `showStatSubset('hasPlace',null,'${escJs(t('stats.hasPlace'))}')`),
    ]),

    statList(t('stats.topSurnames'), s.top.surnames, 'surname'),
    statList(t('stats.topGivenM'), s.top.givenM, 'givenM'),
    statList(t('stats.topGivenF'), s.top.givenF, 'givenF'),
    statList(t('stats.topGivenU'), s.top.givenU, 'givenU'),
    statList(t('stats.topPlaces'), s.top.places, 'place'),
    statList(t('stats.topOccupations'), s.top.occupations, 'occupation'),
    statList(t('stats.topCauses'), s.top.causes, 'cause'),
  ].filter(Boolean).join('');
}

// ── Drilling into who a figure is actually counting ─────────────────────────

function personIdsForKind(kind, param) {
  const s = _lastStats;
  if (!s) return [];
  switch (kind) {
    case 'sex':           return param ? (s.sexIds[param] || []) : [...s.livingIds, ...s.deceasedIds];
    case 'living':        return s.livingIds;
    case 'deceased':      return s.deceasedIds;
    case 'childDeaths':   return s.lifespan.childDeathIds;
    case 'oldest':        return s.lifespan.oldest ? [s.lifespan.oldest.id] : [];
    case 'childless':     return s.children.childlessIds;
    case 'biggest':       return s.children.biggest?.ids || [];
    case 'neverMarried':  return s.families2.neverMarriedIds;
    case 'remarried':     return s.families2.remarriedIds;
    case 'mostMarried':   return s.families2.mostMarried ? [s.families2.mostMarried.id] : [];
    case 'cousinCouples': return s.families2.cousinCoupleIds;
    case 'twins':         return s.twinIds;
    case 'divorced':      return s.families2.divorcedIds;
    case 'spouseGapMax':  return s.families2.spouseGap.maxIds;
    case 'lifespan':      return s.lifespan.ids;
    case 'marriageAge':   return s.marriageAge.ids;
    case 'youngestMarriage': return s.marriageAge.minIds;
    case 'parentAge':     return s.parentAge.ids;
    case 'youngestParent':   return s.parentAge.minIds;
    case 'hasBirth':      return s.completeness.birthIds;
    case 'hasDeath':      return s.completeness.deathIds;
    case 'hasPlace':      return s.completeness.placeIds;
    case 'descendants':   return [...collectDescendants(param)].filter(id => id !== param && state.individuals.has(id));
    case 'surname':
      return [...state.individuals.values()].filter(p => familyNamesOf(p).has(param)).map(p => p.id);
    case 'givenM': case 'givenF': case 'givenU': {
      const sexKey = kind.slice(-1);
      return [...state.individuals.values()].filter(p => {
        const g = (p.givn || '').trim().split(/\s+/)[0];
        const pk = p.sex === 'M' || p.sex === 'F' ? p.sex : 'U';
        return g === param && pk === sexKey;
      }).map(p => p.id);
    }
    case 'place':
      return [...state.individuals.values()]
        .filter(p => [p.birth?.plac, p.death?.plac].some(pl => (pl || '').trim() === param)).map(p => p.id);
    case 'occupation':
      return [...state.individuals.values()].filter(p => (p.occu || '').trim() === param).map(p => p.id);
    case 'cause':
      return [...state.individuals.values()].filter(p => (p.death?.caus || '').trim() === param).map(p => p.id);
    case 'decade': {
      const d = Number(param);
      return [...state.individuals.values()].filter(p => {
        const y = p.birthYear || year(p.birth?.date);
        return y != null && y >= d && y < d + 10;
      }).map(p => p.id);
    }
    default: return [];
  }
}

function personRow(id) {
  const indi = state.individuals.get(id);
  if (!indi) return '';
  const born = year(indi.birth?.date) || indi.birthYear;
  const died = year(indi.death?.date);
  const years = born || died ? `${born || '?'}–${died || (indi.deceased ? '?' : '')}` : '';
  const where = (indi.birth?.plac || indi.death?.plac || '').trim();
  return `<button class="find-row" onclick="statGoTo('${escJs(id)}')">
    <span class="find-row-name">${escHtml(indi.displayName || indi.name || id)}</span>
    ${years ? `<span class="find-row-years">${escHtml(years)}</span>` : ''}
    ${where ? `<span class="find-row-place">${escHtml(where)}</span>` : ''}
  </button>`;
}

/** Swap the overview for the people behind one figure — same row style as the
 * Find tool, so a reader who has used that already knows this list. */
export function showStatSubset(kind, param, title) {
  const ids = [...new Set(personIdsForKind(kind, param))].filter(id => state.individuals.has(id));
  ids.sort((a, b) => {
    const A = state.individuals.get(a), B = state.individuals.get(b);
    return (A.displayName || A.name || a).localeCompare(B.displayName || B.name || b);
  });

  const list  = document.getElementById('stats-detail-list');
  const titleEl = document.getElementById('stats-detail-title');
  const countEl = document.getElementById('stats-detail-count');
  const body  = document.getElementById('stats-body');
  const panel = document.getElementById('stats-detail');
  if (!list || !titleEl || !countEl || !body || !panel) return;

  titleEl.textContent = title;
  countEl.textContent = t('stats.detailCount', { n: ids.length });
  list.innerHTML = ids.length ? ids.map(personRow).join('')
    : `<div class="pl-empty">${escHtml(t('find.none'))}</div>`;
  body.style.display = 'none';
  panel.style.display = 'flex';
}

export function backToStatsOverview() {
  const body  = document.getElementById('stats-body');
  const panel = document.getElementById('stats-detail');
  if (panel) panel.style.display = 'none';
  if (body)  body.style.display = '';
}

/** Open a person from the detail list, the same way the Find tool does. */
export function statGoTo(id) {
  closeStatsTool();
  showIndiDetail(id);
  zoomToNode(id);
}

// ── Timeline hover ────────────────────────────────────────────────────────

export function statBarHover(evt, decade, n) {
  const tt = document.getElementById('tooltip');
  if (!tt) return;
  tt.innerHTML = `<div class="tt-name">${decade}–${decade + 9}</div>` +
    `<div class="tt-detail">${escHtml(t('stats.timelineTooltip', { n }))}</div>`;
  tt.style.display = 'block';
  positionTooltip(evt);
}

export function statBarOut() {
  const tt = document.getElementById('tooltip');
  if (tt) tt.style.display = 'none';
}

// The figures used to live in a sidebar accordion, squeezed into 220px next to
// the family-name list. They are a report about the whole tree, not a control,
// so they now open as their own window from the Tools menu and get the width
// the tables actually need.
export function openStatsTool() {
  const modal = document.getElementById('stats-modal');
  if (!modal) return;
  renderStats();
  modal.style.display = 'flex';
}

export function closeStatsTool() {
  const modal = document.getElementById('stats-modal');
  if (modal) modal.style.display = 'none';
}

// Recomputing walks the whole tree, so it is only ever done for a window that is
// actually open — but it must be done for *every* change to the tree, not only
// when it is opened. Rendering on open alone is what let the figures sit there
// going stale while the sidebar's family-name list, which is rebuilt on every
// change, moved on without them: the same family then had two different sizes
// on screen at once, a few centimetres apart.
export function refreshStats() {
  if (document.getElementById('stats-modal')?.style.display === 'flex') renderStats();
}
