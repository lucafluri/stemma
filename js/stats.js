import { state } from './state.js';
import { familyNamesOf } from './colors.js';
import { escAttr, escHtml } from './gedcom-io.js';
import { computeGenerationDepths } from './graph-data.js';

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

const topN = (counts, n) => [...counts.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, n);

export function computeStats() {
  const people = [...state.individuals.values()];
  const fams   = [...state.families.values()];
  if (!people.length) return null;

  const sex = { M: 0, F: 0, U: 0 };
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
    if (p.deceased) deceased++;

    const b = p.birthYear || year(p.birth?.date);
    const d = year(p.death?.date);
    if (b) withBirth++;
    if (d) withDeath++;
    if (p.birth?.plac || p.death?.plac) withPlace++;
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
        if (!oldest || age > oldest.age) oldest = { age, name: p.displayName || p.id, born: b, died: d };
      } else {
        childDeaths++;
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
  for (const f of fams) {
    const n = (f.chil || []).filter(c => state.individuals.has(c)).length;
    if (!biggest || n > biggest.n) {
      const parents = [f.husb, f.wife].filter(x => state.individuals.has(x))
        .map(x => state.individuals.get(x).displayName || x);
      biggest = { n, parents };
    }
  }
  const divorced = fams.filter(f => f.div).length;
  const marriageYears = fams.flatMap(f => (f.marriages || []).map(m => year(m.date))).filter(Boolean);

  // ── Marriage age and generation gap ──
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
      marriageAges.push(firstYear - b);
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
          parentAges.push(cb - pb);
        }
      }
    }
  }

  // ── Time span and generations ──
  const birthYears = people.map(p => p.birthYear || year(p.birth?.date)).filter(Boolean);
  const depths = computeGenerationDepths();
  const generations = depths.size ? (Math.max(...depths.values()) - Math.min(...depths.values()) + 1) : 0;

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

  return {
    people: people.length,
    families: fams.length,
    sex,
    deceased,
    living: people.length - deceased,

    lifespan: {
      n: lifespans.length,
      mean: mean(lifespans),
      median: median(lifespans),
      oldest,
      childDeaths,
      childRate: allDeathAges.length ? childDeaths / allDeathAges.length : null,
    },

    marriageAge: { n: marriageAges.length, mean: mean(marriageAges) },
    parentAge: { n: parentAges.length, mean: mean(parentAges) },

    children: {
      meanAll: mean(childCounts),
      meanWithChildren: mean(withChildren),
      childless: childCounts.length - withChildren.length,
      biggest,
    },

    span: {
      earliest: birthYears.length ? Math.min(...birthYears) : null,
      latest:   birthYears.length ? Math.max(...birthYears) : null,
      generations,
      firstMarriage: marriageYears.length ? Math.min(...marriageYears) : null,
    },

    families2: { divorced, married: marriedPeople.size, parents: hasChildren.size },

    completeness: {
      birth: withBirth / people.length,
      death: withDeath / people.length,
      place: withPlace / people.length,
      occupation: withOccupation / people.length,
    },

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

function statRow(label, value, hint) {
  return `<div class="stat-row"><span class="stat-label">${escHtml(label)}</span>` +
         `<span class="stat-value">${escHtml(String(value))}` +
         (hint ? `<span class="stat-hint">${escHtml(hint)}</span>` : '') +
         `</span></div>`;
}

function statList(label, entries) {
  if (!entries.length) return '';
  // The name carries its own title: a 220px sidebar clips "Tettnang,
  // Bodenseekreis, Tübingen…" to the point of being unreadable, and hovering is
  // the only way back to it.
  const items = entries.map(([name, n]) =>
    `<li><span title="${escAttr(name)}">${escHtml(name)}</span><span class="stat-hint">${n}</span></li>`).join('');
  return `<div class="stat-group"><div class="stat-group-title">${escHtml(label)}</div><ul class="stat-list">${items}</ul></div>`;
}

export function renderStats() {
  const box = document.getElementById('stats-body');
  if (!box) return;
  const s = computeStats();
  if (!s) { box.innerHTML = `<div class="stat-empty">${escHtml(t('stats.empty'))}</div>`; return; }

  const sexBar = ['M', 'F', 'U']
    .filter(k => s.sex[k])
    .map(k => `<span class="stat-seg stat-seg-${k}" style="flex:${s.sex[k]}" title="${escHtml(t('stats.sex' + k))}: ${s.sex[k]}"></span>`)
    .join('');

  box.innerHTML = [
    `<div class="stat-bar">${sexBar}</div>`,
    statRow(t('stats.people'), s.people.toLocaleString()),
    statRow(t('stats.male'),   `${s.sex.M} (${pct(s.sex.M / s.people)})`),
    statRow(t('stats.female'), `${s.sex.F} (${pct(s.sex.F / s.people)})`),
    s.sex.U ? statRow(t('stats.unknownSex'), `${s.sex.U} (${pct(s.sex.U / s.people)})`) : '',
    statRow(t('stats.living'), `${s.living} / ${s.deceased}`, t('stats.livingHint')),

    `<div class="stat-sep"></div>`,
    // The subset size travels with the average: on a tree where few people have
    // both dates, the number is a curiosity rather than a finding.
    statRow(t('stats.avgLifespan'), s.lifespan.mean == null ? '–' : num(s.lifespan.mean) + ' ' + t('stats.years'),
      t('stats.basedOn', { n: s.lifespan.n })),
    statRow(t('stats.medianLifespan'), s.lifespan.median == null ? '–' : num(s.lifespan.median, 0) + ' ' + t('stats.years')),
    s.lifespan.oldest ? statRow(t('stats.oldest'),
      `${s.lifespan.oldest.age} ${t('stats.years')}`,
      `${s.lifespan.oldest.name} (${s.lifespan.oldest.born}–${s.lifespan.oldest.died})`) : '',
    s.lifespan.childDeaths ? statRow(t('stats.childMortality'),
      s.lifespan.childDeaths.toLocaleString(),
      t('stats.childMortalityHint', { rate: pct(s.lifespan.childRate) })) : '',
    s.marriageAge.n ? statRow(t('stats.avgMarriageAge'),
      num(s.marriageAge.mean) + ' ' + t('stats.years'),
      t('stats.avgMarriageAgeHint', { n: s.marriageAge.n })) : '',
    s.parentAge.n ? statRow(t('stats.avgParentAge'),
      num(s.parentAge.mean) + ' ' + t('stats.years'),
      t('stats.avgParentAgeHint', { n: s.parentAge.n })) : '',

    `<div class="stat-sep"></div>`,
    statRow(t('stats.families'), s.families.toLocaleString()),
    statRow(t('stats.avgChildren'), num(s.children.meanWithChildren), t('stats.avgChildrenHint')),
    statRow(t('stats.childless'), s.children.childless),
    s.children.biggest && s.children.biggest.n > 0 ? statRow(t('stats.biggestFamily'),
      `${s.children.biggest.n} ${t('stats.childrenWord')}`, s.children.biggest.parents.join(' & ')) : '',
    s.families2.divorced ? statRow(t('stats.divorced'), s.families2.divorced) : '',

    `<div class="stat-sep"></div>`,
    s.span.earliest ? statRow(t('stats.span'), `${s.span.earliest} – ${s.span.latest}`,
      t('stats.spanHint', { n: s.span.latest - s.span.earliest })) : '',
    statRow(t('stats.generations'), s.span.generations),

    `<div class="stat-sep"></div>`,
    `<div class="stat-group-title">${escHtml(t('stats.completeness'))}</div>`,
    statRow(t('stats.hasBirth'), pct(s.completeness.birth)),
    statRow(t('stats.hasDeath'), pct(s.completeness.death)),
    statRow(t('stats.hasPlace'), pct(s.completeness.place)),

    `<div class="stat-sep"></div>`,
    statList(t('stats.topSurnames'), s.top.surnames),
    statList(t('stats.topGivenM'), s.top.givenM),
    statList(t('stats.topGivenF'), s.top.givenF),
    statList(t('stats.topGivenU'), s.top.givenU),
    statList(t('stats.topPlaces'), s.top.places),
    statList(t('stats.topOccupations'), s.top.occupations),
    statList(t('stats.topCauses'), s.top.causes),
  ].filter(Boolean).join('');
}

// Recomputing walks the whole tree, so it is only ever done for a panel that is
// actually open — but it must be done for *every* change to the tree, not only
// when the panel is opened. Rendering on open alone is what let the figures sit
// there going stale while the sidebar's family-name list, which is rebuilt on
// every change, moved on without them: the same family then had two different
// sizes on screen at once, a few centimetres apart.
export function refreshStats() {
  if (document.getElementById('stats-panel')?.open) renderStats();
}

export function toggleStatsPanel() {
  refreshStats();
}
