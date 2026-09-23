/**
 * Data check — the mistakes a tree accumulates without anybody noticing.
 *
 * A transcription slip that puts a birth after a death, a child born after its
 * mother died, somebody entered twice from two sources, a record that has made
 * a person their own grandparent. None of it is visible in the chart until you
 * happen to look at the one box it is on, and a large tree has thousands of
 * boxes. This lists them all, each one a click away from the person.
 *
 * Dates are free text, so every rule compares years only and says nothing about
 * a year it cannot read. Every rule is one pass over the tree (the duplicate
 * check only ever compares namesakes), so it runs on 100,000 people.
 */

import { state } from './state.js';
import { escHtml, escJs } from './gedcom-io.js';
import { goToPerson } from './graph-data.js';
import { applyHighlight, updateHLButtons } from './relations.js';
import { foldText } from './places.js';

const yearOf = s => {
  const m = String(s || '').match(/\b(\d{3,4})\b/);
  return m ? +m[1] : null;
};

// Deliberately generous: these flag what is very probably wrong, not what is
// merely unusual.
export const CHECK_LIMITS = {
  maxAge: 115,
  motherMin: 12, motherMax: 56,
  fatherMin: 13, fatherMax: 85,
  marriageMin: 13,
};

/** Every problem found: [{ kind, level, ids, params }]. `level` is error |
 *  warning | info; `ids` are the people involved, the first the one to open. */
export function checkTree() {
  const P = state.individuals, F = state.families;
  const L = CHECK_LIMITS;
  const out = [];
  const add = (kind, level, ids, params = {}) => out.push({ kind, level, ids, params });
  const by = new Map(), dy = new Map();
  for (const [id, p] of P) {
    const b = p.birthYear || yearOf(p.birth?.date);
    const d = yearOf(p.death?.date);
    if (b) by.set(id, b);
    if (d) dy.set(id, d);
    if (b && d && d < b) add('deathBeforeBirth', 'error', [id], { b, d });
    else if (b && d && d - b > L.maxAge) add('tooOld', 'warning', [id], { age: d - b });
  }

  for (const [fid, f] of F) {
    const members = [f.husb, f.wife, ...(f.chil || [])].filter(x => x && P.has(x));
    if (members.length <= 1 && !(f.marriages || []).some(m => m.date || m.plac)) {
      add('emptyFamily', 'info', members, { fam: fid });
    }
    const h = f.husb && P.get(f.husb), w = f.wife && P.get(f.wife);
    if (h && h.sex === 'F' && w && w.sex !== 'F') add('sexRole', 'warning', [f.husb], {});
    if (w && w.sex === 'M' && h && h.sex !== 'M') add('sexRole', 'warning', [f.wife], {});

    for (const m of f.marriages || []) {
      const my = yearOf(m.date);
      if (!my) continue;
      for (const pid of [f.husb, f.wife]) {
        if (!pid || !P.has(pid)) continue;
        const b = by.get(pid), d = dy.get(pid);
        if (b && my < b) add('marriedBeforeBirth', 'error', [pid], { y: my, b });
        else if (b && my - b < L.marriageMin) add('marriedYoung', 'warning', [pid], { age: my - b });
        if (d && my > d) add('marriedAfterDeath', 'error', [pid], { y: my, d });
      }
    }

    for (const cid of f.chil || []) {
      const cb = by.get(cid);
      if (!cb || !P.has(cid)) continue;
      for (const [pid, role] of [[f.wife, 'mother'], [f.husb, 'father']]) {
        if (!pid || !P.has(pid)) continue;
        const pb = by.get(pid), pd = dy.get(pid);
        if (pb) {
          const age = cb - pb;
          if (age < 0) add('childBeforeParent', 'error', [cid, pid], { role });
          else if (age < (role === 'mother' ? L.motherMin : L.fatherMin)) add('parentYoung', 'warning', [cid, pid], { role, age });
          else if (age > (role === 'mother' ? L.motherMax : L.fatherMax)) add('parentOld', 'warning', [cid, pid], { role, age });
        }
        // A father can die before a child is born — by up to a year.
        if (pd && (role === 'mother' ? cb > pd : cb > pd + 1)) add('bornAfterParentDeath', 'error', [cid, pid], { role });
      }
    }
  }

  // Somebody who is their own ancestor: a cycle in the parent links. Iterative
  // three-colour DFS (a deep line would overflow a recursive one).
  const parents = id => {
    const out2 = [];
    for (const fid of P.get(id)?.famc || []) {
      const f = F.get(fid);
      if (!f) continue;
      if (f.husb && P.has(f.husb)) out2.push(f.husb);
      if (f.wife && P.has(f.wife)) out2.push(f.wife);
    }
    return out2;
  };
  const colour = new Map();   // 1 = on the current path, 2 = done
  const reported = new Set();
  for (const start of P.keys()) {
    if (colour.has(start)) continue;
    const stack = [[start, parents(start), 0]];
    colour.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[2] >= top[1].length) { colour.set(top[0], 2); stack.pop(); continue; }
      const next = top[1][top[2]++];
      const c = colour.get(next);
      if (c === 1) {
        if (!reported.has(next)) { reported.add(next); add('ownAncestor', 'error', [next], {}); }
      } else if (!c) {
        colour.set(next, 1);
        stack.push([next, parents(next), 0]);
      }
    }
  }

  // Possible duplicates: the same name, with something that agrees (birth year
  // or parents) and nothing that disagrees. Two siblings given the same name —
  // the second child named after one who died young — share their parents but
  // not their birth year, and are not flagged. Grouped by name first, so only
  // namesakes are ever compared with each other.
  const byName = new Map();
  for (const [id, p] of P) {
    const name = foldText(p.name);
    if (!name || !name.includes(' ')) continue;
    (byName.get(name) || byName.set(name, []).get(name)).push(id);
  }
  const dupParent = new Map();
  const find = x => { while (dupParent.get(x) !== x) x = dupParent.get(x); return x; };
  for (const ids of byName.values()) {
    if (ids.length < 2 || ids.length > 2000) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const ya = by.get(a), yb = by.get(b);
        const pa = (P.get(a).famc || []).join(','), pb = (P.get(b).famc || []).join(',');
        const agree = (ya && yb && ya === yb) || (pa && pb && pa === pb);
        const clash = (ya && yb && ya !== yb) || (pa && pb && pa !== pb) ||
          (P.get(a).sex !== P.get(b).sex && /^[MF]$/.test(P.get(a).sex) && /^[MF]$/.test(P.get(b).sex));
        if (!agree || clash) continue;
        for (const x of [a, b]) if (!dupParent.has(x)) dupParent.set(x, x);
        const ra = find(a), rb = find(b);
        if (ra !== rb) dupParent.set(ra, rb);
      }
    }
  }
  const dupGroups = new Map();
  for (const x of dupParent.keys()) {
    const r = find(x);
    (dupGroups.get(r) || dupGroups.set(r, []).get(r)).push(x);
  }
  for (const ids of dupGroups.values()) if (ids.length > 1) add('duplicate', 'info', ids, { n: ids.length });

  const rank = { error: 0, warning: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return out;
}

// ── The dialog ─────────────────────────────────────────────────────────────

let _issues = [];
let _filter = 'all';

export function openCheckTool() {
  const modal = document.getElementById('check-modal');
  if (!modal) return;
  _filter = 'all';
  modal.style.display = 'flex';
  runCheck();
}

export function closeCheckTool() {
  const modal = document.getElementById('check-modal');
  if (modal) modal.style.display = 'none';
}

export function runCheck() {
  _issues = checkTree();
  renderCheck();
}

export function setCheckFilter(kind) {
  _filter = kind;
  renderCheck();
}

const _name = id => state.individuals.get(id)?.displayName || state.individuals.get(id)?.name || id;

function _text(issue) {
  const p = { ...issue.params };
  if (p.role) p.role = t('check.role.' + p.role);
  if (issue.ids[1]) p.other = _name(issue.ids[1]);
  return t('check.msg.' + issue.kind, p);
}

export function renderCheck() {
  const list = document.getElementById('check-results');
  const summary = document.getElementById('check-summary');
  const chips = document.getElementById('check-filters');
  if (!list || !summary) return;

  const counts = new Map();
  for (const i of _issues) counts.set(i.kind, (counts.get(i.kind) || 0) + 1);
  const levels = { error: 0, warning: 0, info: 0 };
  for (const i of _issues) levels[i.level]++;
  summary.textContent = _issues.length
    ? t('check.summary', { errors: levels.error, warnings: levels.warning, infos: levels.info })
    : t('check.none');

  if (chips) {
    chips.innerHTML = [['all', _issues.length], ...counts].map(([k, n]) =>
      `<button class="check-chip${_filter === k ? ' active' : ''}" onclick="setCheckFilter('${escJs(k)}')">` +
      `${escHtml(k === 'all' ? t('check.all') : t('check.kind.' + k))} <span>${n}</span></button>`).join('');
  }

  const shown = _filter === 'all' ? _issues : _issues.filter(i => i.kind === _filter);
  const LIMIT = 500;
  list.innerHTML = shown.slice(0, LIMIT).map(i => {
    const who = i.kind === 'duplicate'
      ? i.ids.map(id => `<a href="#" onclick="event.preventDefault();checkGoTo('${escJs(id)}')">${escHtml(_name(id))}</a>`).join(' · ')
      : `<a href="#" onclick="event.preventDefault();checkGoTo('${escJs(i.ids[0])}')">${escHtml(_name(i.ids[0]))}</a>`;
    return `<div class="check-row check-row--${i.level}">
      <span class="check-level" title="${escHtml(t('check.level.' + i.level))}"></span>
      <span class="check-who">${who}</span>
      <span class="check-text">${escHtml(_text(i))}</span>
    </div>`;
  }).join('') + (shown.length > LIMIT ? `<div class="pl-empty">${escHtml(t('find.capped', { n: LIMIT }))}</div>` : '');
  if (!shown.length) list.innerHTML = `<div class="pl-empty">${escHtml(t('check.none'))}</div>`;
  const hl = document.getElementById('check-highlight-btn');
  if (hl) hl.disabled = !shown.length;
}

export function checkGoTo(id) {
  closeCheckTool();
  goToPerson(id);
}

/** Light up everybody the current filter lists, like the Find tool does. */
export function highlightCheckIssues() {
  const shown = _filter === 'all' ? _issues : _issues.filter(i => i.kind === _filter);
  const ids = new Set(shown.flatMap(i => i.ids));
  if (!ids.size) return;
  state.hlMode = null;
  state.hlSet = ids;
  state._hlAncestorCount = state._hlDescendantCount = 0;
  applyHighlight();
  updateHLButtons();
  closeCheckTool();
  document.getElementById('status').textContent = t('find.highlighted', { n: ids.size });
}
