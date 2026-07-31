import { state } from './state.js';
import { refreshNodeColors } from './colors.js';
import { escHtml, escJs } from './gedcom-io.js';
import { linkBaseOpacity } from './render-2d.js';
import { refresh3D } from './render-3d.js';

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
    const baseOp = (d.type === 'INDI' && d.data.deceased) ? 0.5 : 1.0;
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

  const matches = [];
  for (const [id, p] of state.individuals) {
    const yr = p.birthYear || (state._estimatedYears?.get(id));
    const label = (p.name || id) + (yr ? ` *${yr}` : '');
    if ((p.name || id).toLowerCase().includes(q)) matches.push({ id, label, yr });
    if (matches.length >= 8) break;
  }

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
  if (!idA || !idB) { result.textContent = ''; return; }
  if (idA === idB)  { result.textContent = t('relationTool.samePerson'); return; }

  const indiA = state.individuals.get(idA);
  const indiB = state.individuals.get(idB);
  if (!indiA || !indiB) { result.textContent = t('relationTool.personNotFound'); return; }

  // --- Check spouse ---
  for (const famId of indiA.fams) {
    const fam = state.families.get(famId);
    if (!fam) continue;
    if (fam.husb === idB || fam.wife === idB) {
      result.innerHTML = _relLine('💍', t('relationTool.spouse'));
      return;
    }
  }

  // --- Collect ancestors with generation depth ---
  // Returns Map<id, number>  (0 = self, 1 = parent, …)
  function ancestors(startId) {
    const map = new Map([[startId, 0]]);
    const queue = [[startId, 0]];
    while (queue.length) {
      const [id, gen] = queue.shift();
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

  // --- Direct descendant / ancestor ---
  if (ancA.has(idB)) {
    const g = ancA.get(idB);
    result.innerHTML = _relLine(_sexIcon(indiB), _ancestorLabel(g, indiB.sex));
    return;
  }
  if (ancB.has(idA)) {
    const g = ancB.get(idA);
    result.innerHTML = _relLine(_sexIcon(indiA), _descendantLabel(g, indiA.sex));
    return;
  }

  // --- Find lowest common ancestor(s) ---
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

  if (!lcas.length) {
    // Fall back to BFS path for step/in-law relations
    result.innerHTML = _relLine('🔗', _bfsPathLabel(idA, idB));
    return;
  }

  // --- Classify via LCA ---
  // siblings: genA=1, genB=1
  if (bestGenA === 1 && bestGenB === 1) {
    // full vs half sibling: check if they share both parents
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
    result.innerHTML = _relLine(_sexIcon(indiB), label);
    return;
  }

  // aunt/uncle: genA=1, genB=2 (B is grandparent of A's parent)
  if (bestGenA === 1 && bestGenB === 2) {
    result.innerHTML = _relLine(_sexIcon(indiB), indiB.sex === 'M' ? t('relationTool.uncle') : indiB.sex === 'F' ? t('relationTool.aunt') : t('relationTool.uncleAunt'));
    return;
  }
  if (bestGenA === 2 && bestGenB === 1) {
    result.innerHTML = _relLine(_sexIcon(indiA), indiA.sex === 'M' ? t('relationTool.nephew') : indiA.sex === 'F' ? t('relationTool.niece') : t('relationTool.nephewNiece'));
    return;
  }

  // great-aunt/uncle
  if (bestGenA === 1 && bestGenB === 3) {
    result.innerHTML = _relLine(_sexIcon(indiB), indiB.sex === 'M' ? t('relationTool.greatUncle') : indiB.sex === 'F' ? t('relationTool.greatAunt') : t('relationTool.greatUncleAunt'));
    return;
  }
  if (bestGenA === 3 && bestGenB === 1) {
    result.innerHTML = _relLine(_sexIcon(indiA), indiA.sex === 'M' ? t('relationTool.greatNephew') : indiA.sex === 'F' ? t('relationTool.greatNiece') : t('relationTool.greatNephewNiece'));
    return;
  }

  // cousins: both ≥ 2 from LCA
  const degree  = Math.min(bestGenA, bestGenB) - 1;   // 1st cousin = degree 1
  const removed = Math.abs(bestGenA - bestGenB);
  result.innerHTML = _relLine('👥', _cousinLabel(degree, removed, indiB.sex));
}

export function _relLine(icon, text) {
  return `<span class="rel-icon">${icon}</span><span class="rel-text">${text}</span>`;
}

export function _sexIcon(indi) {
  return indi.sex === 'M' ? '👨' : indi.sex === 'F' ? '👩' : '🧑';
}

export function _ancestorLabel(gen, sex) {
  const m = sex === 'M', f = sex === 'F';
  if (gen === 1) return m ? t('relationTool.father') : f ? t('relationTool.mother') : t('relationTool.parent');
  if (gen === 2) return m ? t('relationTool.grandfather') : f ? t('relationTool.grandmother') : t('relationTool.grandparent');
  const prefix = t('relationTool.greatPrefix').repeat(gen - 2);
  return prefix + (m ? t('relationTool.greatGrandfather') : f ? t('relationTool.greatGrandmother') : t('relationTool.greatGrandparent'));
}

export function _descendantLabel(gen, sex) {
  const m = sex === 'M', f = sex === 'F';
  if (gen === 1) return m ? t('relationTool.son') : f ? t('relationTool.daughter') : t('relationTool.child');
  if (gen === 2) return m ? t('relationTool.grandson') : f ? t('relationTool.granddaughter') : t('relationTool.grandchild');
  const prefix = t('relationTool.greatPrefix').repeat(gen - 2);
  return prefix + (m ? t('relationTool.greatGrandson') : f ? t('relationTool.greatGranddaughter') : t('relationTool.greatGrandchild'));
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

export function _bfsPathLabel(idA, idB) {
  // Build full undirected adjacency including spouses
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
  while (queue.length) {
    const cur = queue.shift();
    if (cur === idB) {
      // Reconstruct path
      const path = [];
      let c = cur;
      while (c) { path.unshift(c); c = visited.get(c)?.from; }
      const steps = path.length - 1;
      return steps > 0 ? t('relationTool.stepsAway', { steps }) : t('relationTool.connected');
    }
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb.id)) {
        visited.set(nb.id, { from: cur });
        queue.push(nb.id);
      }
    }
  }
  return t('relationTool.noConnection');
}
