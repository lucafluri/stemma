import { state } from './state.js';
import { nodeOpacity } from './colors.js';
import { refreshNodeColors } from './colors.js';
import { escHtml, escJs } from './gedcom-io.js';
import { linkBaseOpacity } from './render-2d.js';
import { refresh3D } from './render-3d.js';
import { personLabel, searchPeople } from './search.js';

export function collectAncestors(id, visited = new Set()) {
  if (visited.has(id)) return visited;
  visited.add(id);
  const indi = state.individuals.get(id);
  if (!indi) return visited;
  for (const famId of indi.famc) {
    visited.add(famId);
    const fam = state.families.get(famId);
    if (!fam) continue;
    [fam.husb, fam.wife].filter(Boolean).forEach(pid => collectAncestors(pid, visited));
  }
  return visited;
}

export function collectDescendants(id, visited = new Set(), isRoot = true) {
  if (!isRoot && visited.has(id)) return visited;
  visited.add(id);
  const indi = state.individuals.get(id);
  if (!indi) return visited;
  for (const famId of indi.fams) {
    visited.add(famId);
    const fam = state.families.get(famId);
    if (!fam) continue;
    fam.chil.forEach(cid => collectDescendants(cid, visited, false));
  }
  return visited;
}

export function _countPeople(idSet) {
  let n = 0;
  for (const id of idSet) if (state.individuals.has(id)) n++;
  return n;
}

export function highlightMode(mode) {
  if (!state.selectedIndiId) return;

  // Toggle off if same mode + same source
  if (state.hlMode === mode) {
    resetHighlight();
    return;
  }

  state.hlMode = mode;
  state.hlSet = new Set();
  state._hlAncestorCount   = 0;
  state._hlDescendantCount = 0;

  if (mode === 'ancestors' || mode === 'both') {
    const aSet = new Set();
    collectAncestors(state.selectedIndiId, aSet);
    aSet.forEach(id => state.hlSet.add(id));
    state._hlAncestorCount = _countPeople(aSet) - 1; // -1 to exclude self
  }
  if (mode === 'descendants' || mode === 'both') {
    const dSet = new Set();
    collectDescendants(state.selectedIndiId, dSet);
    dSet.forEach(id => state.hlSet.add(id));
    state._hlDescendantCount = _countPeople(dSet) - 1; // -1 to exclude self
  }

  applyHighlight();
  updateHLButtons();
}

export function applyHighlight() {
  if (!state.nodeSel) return;
  const hasHL = state.hlSet.size > 0;

  state.nodeSel.each(function(d) {
    const inHL = !hasHL || state.hlSet.has(d.id);
    const baseOp = nodeOpacity(d);
    d3.select(this).selectAll('rect.indi-box, polygon')
      .attr('opacity', inHL ? baseOp : 0.07)
      .attr('filter', inHL && d.id === state.selectedIndiId ? 'url(#glow)' : null);
  });

  state.linkSel?.attr('opacity', d => {
    if (!hasHL) return linkBaseOpacity(d);
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return (state.hlSet.has(sid) && state.hlSet.has(tid)) ? 0.80 : 0.04;
  });

  const dim = d => (!hasHL || state.hlSet.has(d.id)) ? 1 : 0.07;
  state.labelSel?.attr('opacity', dim);
  state.yearSel?.attr('opacity', dim);
  refresh3D();
}

export function resetHighlight() {
  state.hlMode = null;
  state.hlSet  = new Set();
  state._relHighlightActive = false;
  state._hlAncestorCount   = 0;
  state._hlDescendantCount = 0;
  applyHighlight();
  updateHLButtons();
  refreshNodeColors();
}

export function _famNodeVal(n) {
  if (n.type !== 'FAM') return n.data.deceased ? 0.7 : 1;
  return Math.max(0.05, (state.famNodeSize / 7) * 0.4);
}

export function _applyFamNodeSize() {
  // 2D: update SVG polygon points
  if (state.svgSel) {
    const s = state.famNodeSize;
    state.svgSel.selectAll('.fam-polygon')
      .attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`);
  }
  // 3D: update sphere volume via nodeVal
  if (state.graph3d) {
    state.graph3d.nodeVal(n => _famNodeVal(n));
  }
}

export function updateHLButtons() {
  const hasSource = state.selectedIndiId != null;

  // Reset labels and active state
  const btnA = document.getElementById('btn-ancestors');
  const btnD = document.getElementById('btn-descendants');
  const btnB = document.getElementById('btn-both');
  [btnA, btnD, btnB].forEach(btn => {
    btn.disabled = !hasSource;
    btn.classList.remove('active');
  });
  btnA.textContent = '↑ ' + t('highlight.ancestors');
  btnD.textContent = '↓ ' + t('highlight.descendants');
  btnB.textContent = '↕ ' + t('highlight.both');

  const btnF = document.getElementById('btn-focus-2d');
  if (btnF) {
    btnF.disabled = !hasSource;
    btnF.textContent = '◎ ' + t('focus.btn');
    btnF.classList.toggle('active', hasSource && state.focusRootId === state.selectedIndiId);
  }

  // Apply counts and active class for current mode
  if (state.hlMode === 'ancestors') {
    btnA.textContent = `↑ ${t('highlight.ancestors')} (${state._hlAncestorCount})`;
    btnA.classList.add('active');
  } else if (state.hlMode === 'descendants') {
    btnD.textContent = `↓ ${t('highlight.descendants')} (${state._hlDescendantCount})`;
    btnD.classList.add('active');
  } else if (state.hlMode === 'both') {
    btnA.textContent = `↑ ${t('highlight.ancestors')} (${state._hlAncestorCount})`;
    btnD.textContent = `↓ ${t('highlight.descendants')} (${state._hlDescendantCount})`;
    btnB.classList.add('active');
  }

  // Summary line below the buttons
  const info = document.getElementById('hl-count-info');
  if (!info) return;
  if (!state.hlMode) {
    info.textContent = '';
    info.style.display = 'none';
  } else if (state.hlMode === 'ancestors') {
    info.textContent = t('highlight.ancestorsCount', { n: state._hlAncestorCount });
    info.style.display = '';
  } else if (state.hlMode === 'descendants') {
    info.textContent = t('highlight.descendantsCount', { n: state._hlDescendantCount });
    info.style.display = '';
  } else if (state.hlMode === 'both') {
    info.textContent = t('highlight.bothCount', { ancestors: state._hlAncestorCount, descendants: state._hlDescendantCount });
    info.style.display = '';
  }
}

export function openRelationTool() {
  document.getElementById('relation-panel').classList.add('panel-visible');
  _renderRelationPanel();
  // Close dropdowns on outside click
  if (!openRelationTool._outsideHandler) {
    openRelationTool._outsideHandler = e => {
      if (!e.target.closest('#relation-panel')) {
        document.getElementById('rel-drop-a').style.display = 'none';
        document.getElementById('rel-drop-b').style.display = 'none';
      }
    };
    document.addEventListener('mousedown', openRelationTool._outsideHandler);
  }
}

export function closeRelationTool() {
  document.getElementById('relation-panel').classList.remove('panel-visible');
  state._relSlotWaiting = null;
  document.body.classList.remove('relation-picking');
}

export function _tryPickRelationPerson(id) {
  if (!state._relSlotWaiting) return false;
  if (state._relSlotWaiting === 'A') state._relPersonA = id;
  else                          state._relPersonB = id;
  state._relSlotWaiting = null;
  document.body.classList.remove('relation-picking');
  _renderRelationPanel();
  if (state._relPersonA && state._relPersonB) _computeAndShowRelation();
  return true;
}

export function _relPersonLabel(id) {
  if (!id) return '—';
  const p = state.individuals.get(id);
  if (!p) return id;
  const yr = p.birthYear || (state._estimatedYears?.get(id));
  return p.displayName + (yr ? ` *${yr}` : '');
}

export function _renderRelationPanel() {
  document.getElementById('rel-name-a').textContent = _relPersonLabel(state._relPersonA);
  document.getElementById('rel-name-b').textContent = _relPersonLabel(state._relPersonB);
  document.getElementById('rel-pick-a').classList.toggle('rel-picking', state._relSlotWaiting === 'A');
  document.getElementById('rel-pick-b').classList.toggle('rel-picking', state._relSlotWaiting === 'B');
  // Clear search inputs when a person is set via click
  if (state._relPersonA) { const el = document.getElementById('rel-search-a'); if (el) el.value = ''; }
  if (state._relPersonB) { const el = document.getElementById('rel-search-b'); if (el) el.value = ''; }
}

export function relPickSlot(slot) {
  state._relSlotWaiting = state._relSlotWaiting === slot ? null : slot;
  document.body.classList.toggle('relation-picking', !!state._relSlotWaiting);
  _renderRelationPanel();
}

export function relSearch(slot, query) {
  const dropId = slot === 'A' ? 'rel-drop-a' : 'rel-drop-b';
  const drop = document.getElementById(dropId);
  if (!drop) return;
  const q = query.trim().toLowerCase();
  if (!q) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  // Best matches first, accent-insensitive — not the first eight in file order.
  const matches = searchPeople(query, 8).map(h => ({ id: h.id, label: personLabel(h.id) }));

  if (!matches.length) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  drop.innerHTML = matches.map(m =>
    `<div class="rel-drop-item" onmousedown="relSelectPerson('${slot}','${escJs(m.id)}')">${escHtml(m.label)}</div>`
  ).join('');
  drop.style.display = 'block';
}

export function relSelectPerson(slot, id) {
  if (slot === 'A') state._relPersonA = id;
  else              state._relPersonB = id;
  // Hide dropdown
  const dropId = slot === 'A' ? 'rel-drop-a' : 'rel-drop-b';
  const searchId = slot === 'A' ? 'rel-search-a' : 'rel-search-b';
  const drop = document.getElementById(dropId);
  if (drop) { drop.innerHTML = ''; drop.style.display = 'none'; }
  const inp = document.getElementById(searchId);
  if (inp) inp.value = '';
  _renderRelationPanel();
  if (state._relPersonA && state._relPersonB) _computeAndShowRelation();
}

export function _computeAndShowRelation() {
  const idA = state._relPersonA, idB = state._relPersonB;
  const result = document.getElementById('rel-result');
  const commonEl = document.getElementById('rel-common');
  const hlBtn = document.getElementById('rel-highlight');

  const hideExtras = () => {
    if (commonEl) commonEl.style.display = 'none';
    if (hlBtn) hlBtn.style.display = 'none';
  };
  const showCommon = (commonId) => {
    if (!commonEl || !commonId) { commonEl && (commonEl.style.display = 'none'); return; }
    const p = state.individuals.get(commonId);
    const text = p ? `${t('relationTool.via')} ${escHtml(_relPersonLabel(commonId))}` : '';
    commonEl.innerHTML = text;
    commonEl.style.display = text ? '' : 'none';
  };

  if (state._relHighlightActive) {
    resetHighlight();
    state._relHighlightActive = false;
  }

  if (!idA || !idB) { result.innerHTML = ''; hideExtras(); return; }
  if (idA === idB) { result.innerHTML = _relLine('🧑', t('relationTool.samePerson')); hideExtras(); return; }

  const indiA = state.individuals.get(idA);
  const indiB = state.individuals.get(idB);
  if (!indiA || !indiB) { result.innerHTML = _relLine('❓', t('relationTool.personNotFound')); hideExtras(); return; }

  let icon, label, common = null;
  const blood = _bloodRelationLabel(idA, idB);
  if (blood) {
    icon = blood.icon;
    label = blood.label;
    common = blood.common;
    state._relLastPath = null;
  } else {
    const bfs = _bfsRelation(idA, idB);
    if (bfs) {
      icon = bfs.icon;
      label = bfs.label;
      common = bfs.common;
      state._relLastPath = { idA, idB, path: bfs.path, edges: bfs.edges };
    } else {
      icon = '❓';
      label = t('relationTool.noConnection');
      state._relLastPath = null;
    }
  }

  result.innerHTML = _relLine(icon, label);
  showCommon(common);

  if (hlBtn) {
    hlBtn.style.display = (state._relLastPath || blood) ? '' : 'none';
  }
}

export function _relLine(icon, text) {
  return `<span class="rel-icon">${icon}</span><span class="rel-text">${text}</span>`;
}

export function _sexIcon(indi) {
  return indi.sex === 'M' ? '👨' : indi.sex === 'F' ? '👩' : '🧑';
}

function _nGreatLabel(base, n) {
  return n > 1 ? t('relationTool.nGreat', { n }) + ' ' + base : base;
}

export function _bloodRelationLabel(idA, idB) {
  if (idA === idB) return { label: t('relationTool.samePerson'), common: idA, icon: '🧑' };

  const indiA = state.individuals.get(idA);
  const indiB = state.individuals.get(idB);
  if (!indiA || !indiB) return { label: t('relationTool.personNotFound'), common: null, icon: '❓' };

  // Spouse
  for (const famId of indiA.fams) {
    const fam = state.families.get(famId);
    if (fam && (fam.husb === idB || fam.wife === idB)) {
      return { label: t('relationTool.spouse'), common: null, icon: '💍' };
    }
  }

  // Returns Map<id, number> (0 = self, 1 = parent, ...)
  function ancestors(startId) {
    const map = new Map([[startId, 0]]);
    const queue = [[startId, 0]];
    // An index, not queue.shift(): shifting a long array moves every element,
    // which turns a walk over a big ancestry into a quadratic one.
    for (let qi = 0; qi < queue.length; qi++) {
      const [id, gen] = queue[qi];
      const indi = state.individuals.get(id);
      if (!indi) continue;
      for (const famId of indi.famc) {
        const fam = state.families.get(famId);
        if (!fam) continue;
        for (const pid of [fam.husb, fam.wife]) {
          if (pid && !map.has(pid)) {
            map.set(pid, gen + 1);
            queue.push([pid, gen + 1]);
          }
        }
      }
    }
    return map;
  }

  const ancA = ancestors(idA);
  const ancB = ancestors(idB);

  // Direct ancestor / descendant
  if (ancA.has(idB)) {
    const g = ancA.get(idB);
    return { label: _ancestorLabel(g, indiB.sex), common: idB, icon: _sexIcon(indiB) };
  }
  if (ancB.has(idA)) {
    const g = ancB.get(idA);
    return { label: _descendantLabel(g, indiB.sex), common: idA, icon: _sexIcon(indiB) };
  }

  // Lowest common ancestor(s)
  let bestGenA = Infinity, bestGenB = Infinity, lcas = [];
  for (const [id, gA] of ancA) {
    if (!ancB.has(id)) continue;
    const gB = ancB.get(id);
    const total = gA + gB;
    if (total < bestGenA + bestGenB) {
      bestGenA = gA; bestGenB = gB; lcas = [id];
    } else if (total === bestGenA + bestGenB) {
      lcas.push(id);
    }
  }

  if (!lcas.length) return null;

  // Siblings
  if (bestGenA === 1 && bestGenB === 1) {
    const parentsA = new Set();
    for (const famId of indiA.famc) {
      const fam = state.families.get(famId);
      if (fam) { if (fam.husb) parentsA.add(fam.husb); if (fam.wife) parentsA.add(fam.wife); }
    }
    const parentsB = new Set();
    for (const famId of indiB.famc) {
      const fam = state.families.get(famId);
      if (fam) { if (fam.husb) parentsB.add(fam.husb); if (fam.wife) parentsB.add(fam.wife); }
    }
    const shared = [...parentsA].filter(p => parentsB.has(p)).length;
    const label = shared >= 2 ? _siblingLabel(indiB.sex) : _halfSiblingLabel(indiB.sex);
    return { label, common: lcas[0], icon: _sexIcon(indiB) };
  }

  // B is A's uncle / aunt (B is a child of the LCA, A is further down)
  if (bestGenB === 1 && bestGenA >= 2) {
    const n = bestGenA - 2;
    let base = indiB.sex === 'M' ? t('relationTool.uncle')
             : indiB.sex === 'F' ? t('relationTool.aunt')
             : t('relationTool.uncleAunt');
    if (n > 0) {
      const greatBase = indiB.sex === 'M' ? t('relationTool.greatUncle')
                      : indiB.sex === 'F' ? t('relationTool.greatAunt')
                      : t('relationTool.greatUncleAunt');
      base = _nGreatLabel(greatBase, n);
    }
    return { label: base, common: lcas[0], icon: _sexIcon(indiB) };
  }

  // B is A's nephew / niece (A is a child of the LCA, B is further down)
  if (bestGenA === 1 && bestGenB >= 2) {
    const n = bestGenB - 2;
    let base = indiB.sex === 'M' ? t('relationTool.nephew')
             : indiB.sex === 'F' ? t('relationTool.niece')
             : t('relationTool.nephewNiece');
    if (n > 0) {
      const greatBase = indiB.sex === 'M' ? t('relationTool.greatNephew')
                      : indiB.sex === 'F' ? t('relationTool.greatNiece')
                      : t('relationTool.greatNephewNiece');
      base = _nGreatLabel(greatBase, n);
    }
    return { label: base, common: lcas[0], icon: _sexIcon(indiB) };
  }

  // Cousins
  const degree = Math.min(bestGenA, bestGenB) - 1;
  const removed = Math.abs(bestGenA - bestGenB);
  return { label: _cousinLabel(degree, removed, indiB.sex), common: lcas[0], icon: '👥' };
}

export function _ancestorLabel(gen, sex) {
  const m = sex === 'M', f = sex === 'F';
  if (gen === 1) return m ? t('relationTool.father') : f ? t('relationTool.mother') : t('relationTool.parent');
  if (gen === 2) return m ? t('relationTool.grandfather') : f ? t('relationTool.grandmother') : t('relationTool.grandparent');
  const n = gen - 2;
  const base = m ? t('relationTool.greatGrandfather') : f ? t('relationTool.greatGrandmother') : t('relationTool.greatGrandparent');
  return _nGreatLabel(base, n);
}

export function _descendantLabel(gen, sex) {
  const m = sex === 'M', f = sex === 'F';
  if (gen === 1) return m ? t('relationTool.son') : f ? t('relationTool.daughter') : t('relationTool.child');
  if (gen === 2) return m ? t('relationTool.grandson') : f ? t('relationTool.granddaughter') : t('relationTool.grandchild');
  const n = gen - 2;
  const base = m ? t('relationTool.greatGrandson') : f ? t('relationTool.greatGranddaughter') : t('relationTool.greatGrandchild');
  return _nGreatLabel(base, n);
}

export function _siblingLabel(sex) {
  return sex === 'M' ? t('relationTool.brother') : sex === 'F' ? t('relationTool.sister') : t('relationTool.sibling');
}

export function _halfSiblingLabel(sex) {
  return sex === 'M' ? t('relationTool.halfBrother') : sex === 'F' ? t('relationTool.halfSister') : t('relationTool.halfSibling');
}

export function _cousinLabel(degree, removed, sex) {
  let base;
  if (degree === 1) base = sex === 'F' ? t('relationTool.femaleCousin') : t('relationTool.cousin');
  else              base = t('relationTool.cousinDegree', { degree });
  return removed > 0 ? t('relationTool.cousinRemoved', { base, removed }) : base;
}

function _spouseTerm(indi) {
  if (indi.sex === 'F') return t('relationTool.wife');
  if (indi.sex === 'M') return t('relationTool.husband');
  return t('relationTool.spouse');
}

function _familyBetween(aId, bId, type) {
  const a = state.individuals.get(aId);
  if (!a) return null;
  if (type === 'spouse') {
    for (const famId of a.fams) {
      const fam = state.families.get(famId);
      if (fam && (fam.husb === bId || fam.wife === bId)) return famId;
    }
  } else if (type === 'parent') {
    for (const famId of a.famc) {
      const fam = state.families.get(famId);
      if (fam && (fam.husb === bId || fam.wife === bId)) return famId;
    }
  } else if (type === 'child') {
    for (const famId of a.fams) {
      const fam = state.families.get(famId);
      if (fam && fam.chil.includes(bId)) return famId;
    }
  }
  return null;
}

function _pathRelationLabel(idA, idB, path, edges) {
  const steps = edges.length;
  if (steps === 0) return t('relationTool.samePerson');
  if (steps === 1 && edges[0] === 'spouse') return t('relationTool.spouse');

  const indiB = state.individuals.get(idB);

  // B is the spouse of someone on A's side
  if (edges[steps - 1] === 'spouse') {
    const pId = path[steps - 1];
    const blood = _bloodRelationLabel(idA, pId);
    const rel = (blood && blood.label && blood.label !== t('relationTool.personNotFound') && blood.label !== t('relationTool.noConnection') && blood.label !== t('relationTool.samePerson'))
      ? blood.label
      : _relPersonLabel(pId);
    return `${_spouseTerm(indiB)} ${t('relationTool.of')} ${rel}`;
  }

  // B is a relative of A's spouse
  if (edges[0] === 'spouse') {
    const sId = path[1];
    const blood = _bloodRelationLabel(sId, idB);
    if (blood && blood.label && blood.label !== t('relationTool.personNotFound') && blood.label !== t('relationTool.noConnection') && blood.label !== t('relationTool.samePerson')) {
      return `${blood.label} ${t('relationTool.ofSpouse')}`;
    }
  }

  // A spouse edge somewhere in the middle: B is a blood relative of whoever
  // married into A's side at that point, not of A. "rel" is that relative's
  // blood relation to B, so the "of" has to name the spouse it was computed
  // from — naming the node before the spouse edge instead said "sister of
  // A" for A's own sister-in-law, which reads as a blood sibling of A.
  const spouseIdx = edges.indexOf('spouse');
  if (spouseIdx !== -1) {
    const afterSpouseId = path[spouseIdx + 1];
    const blood = _bloodRelationLabel(afterSpouseId, idB);
    const rel = (blood && blood.label && blood.label !== t('relationTool.personNotFound') && blood.label !== t('relationTool.noConnection') && blood.label !== t('relationTool.samePerson'))
      ? blood.label
      : _relPersonLabel(afterSpouseId);
    return `${rel} ${t('relationTool.of')} ${_relPersonLabel(afterSpouseId)}`;
  }

  return t('relationTool.stepsAway', { steps });
}

function _pathCommon(path, edges) {
  const lastSpouseIdx = edges.lastIndexOf('spouse');
  if (lastSpouseIdx !== -1) {
    return lastSpouseIdx === edges.length - 1
      ? path[lastSpouseIdx]
      : path[lastSpouseIdx + 1];
  }
  // Pure blood path: the "peak" where we stop going up and start down
  let peakIdx = 0;
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] === 'parent') peakIdx = i + 1;
    else break;
  }
  return path[peakIdx] ?? null;
}

function _bfsRelation(idA, idB) {
  const adj = new Map();
  const edge = (a, b, type) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, type });
  };
  for (const [id, indi] of state.individuals) {
    for (const famId of indi.famc) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      if (fam.husb) { edge(id, fam.husb, 'parent'); edge(fam.husb, id, 'child'); }
      if (fam.wife) { edge(id, fam.wife, 'parent'); edge(fam.wife, id, 'child'); }
    }
    for (const famId of indi.fams) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      const sp = fam.husb === id ? fam.wife : fam.husb;
      if (sp) edge(id, sp, 'spouse');
    }
  }

  const visited = new Map([[idA, null]]);
  const queue = [idA];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === idB) {
      const path = [];
      const edges = [];
      let c = cur;
      while (c) {
        path.unshift(c);
        const info = visited.get(c);
        if (info) {
          edges.unshift(info.type);
          c = info.from;
        } else {
          c = null;
        }
      }
      const label = _pathRelationLabel(idA, idB, path, edges);
      const common = _pathCommon(path, edges);
      const indiB = state.individuals.get(idB);
      return { path, edges, label, common, icon: _sexIcon(indiB) };
    }
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb.id)) {
        visited.set(nb.id, { from: cur, type: nb.type });
        queue.push(nb.id);
      }
    }
  }
  return null;
}

export function _bfsPathLabel(idA, idB) {
  const rel = _bfsRelation(idA, idB);
  return rel ? rel.label : t('relationTool.noConnection');
}

export function relHighlightPath() {
  const idA = state._relPersonA, idB = state._relPersonB;
  if (!idA || !idB) return;

  if (state._relHighlightActive) {
    resetHighlight();
    state._relHighlightActive = false;
    return;
  }

  let pathData = state._relLastPath;
  if (!pathData || pathData.idA !== idA || pathData.idB !== idB) {
    const bfs = _bfsRelation(idA, idB);
    if (!bfs) return;
    pathData = { idA, idB, path: bfs.path, edges: bfs.edges };
  }

  const set = new Set(pathData.path);
  for (let i = 0; i < pathData.edges.length; i++) {
    const famId = _familyBetween(pathData.path[i], pathData.path[i + 1], pathData.edges[i]);
    if (famId) set.add(famId);
  }

  state.hlMode = null;
  state.hlSet = set;
  state._relHighlightActive = true;
  applyHighlight();
}
