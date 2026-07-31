import { state } from './state.js';
import { LINK_COLOR_DEFAULTS, NODE_COLOR_DEFAULTS } from './constants.js';
import { escAttr, escHtml } from './gedcom-io.js';
import { _applyFamNodeSize } from './relations.js';
import { _rerenderNodes, applyFilter, linkColor, updateLabelColors, updateLabels } from './render-2d.js';
import { refresh3D } from './render-3d.js';

export const GOLDEN_ANGLE = 137.508;

export function surnameHashColor(surname) {
  // Fallback for surnames not in the pre-assigned cache
  if (!surname) return '#888888';
  let hash = 0;
  const s = surname.toLowerCase().trim();
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash = hash & hash;
  }
  const h = Math.abs(hash) % 360;
  return hslToHex(h, 50, 52);
}

export function hslToHex(h, s, l) {
  l /= 100;
  const a = s * Math.min(l, 1 - l) / 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function surnameColor(surname) {
  if (!surname) return '#888888';
  // Check for user override
  if (state.surnameCustomColors.has(surname)) {
    return state.surnameCustomColors.get(surname);
  }
  // Use cached hash color
  if (!state._surnameColorCache.has(surname)) {
    state._surnameColorCache.set(surname, surnameHashColor(surname));
  }
  return state._surnameColorCache.get(surname);
}

export function setSurnameColor(surname, color) {
  if (color === null || color === undefined) {
    state.surnameCustomColors.delete(surname);
  } else {
    state.surnameCustomColors.set(surname, color);
  }
  // Persist
  debouncedLsWrite('surnameCustomColors', JSON.stringify(Object.fromEntries(state.surnameCustomColors)));
}

export function debouncedLsWrite(key, value, delay = 200) {
  clearTimeout(state._lsWriteTimeouts[key]);
  state._lsWriteTimeouts[key] = setTimeout(() => {
    localStorage.setItem(key, value);
  }, delay);
}

export const PALETTE = [
  '#4e79a7','#e15759','#59a14f','#76b7b2','#edc948',
  '#b07aa1','#ff9da7','#f28e2b','#9c755f','#bab0ac',
  '#d37295','#a0cbe8','#fabfd2','#8cd17d','#b6992d'
];

export function buildSurnameColorMap() {
  // 1. Count surname frequencies
  const counts = new Map();
  let noSurnCount = 0;
  for (const [, indi] of state.individuals) {
    const names = new Set([indi.surn, indi.maidenName].filter(Boolean));
    if (!names.size) noSurnCount++;
    for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // 2. Build surname adjacency graph — two surnames are adjacent when they
  //    appear together in the same family (spouses or parent/child).
  const adj = new Map();
  for (const s of counts.keys()) adj.set(s, new Set());
  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const [, fam] of state.families) {
    const gs = id => (id ? state.individuals.get(id)?.surn : null) || null;
    const hS = gs(fam.husb), wS = gs(fam.wife);
    addEdge(hS, wS);
    for (const cid of fam.chil) {
      const cS = gs(cid);
      addEdge(hS, cS);
      addEdge(wS, cS);
    }
  }

  // 3. DSATUR ordering — process most-constrained surnames first so they
  //    get the most freedom when choosing their hue.
  const surns = [...counts.keys()];
  const assignOrder = [];
  const nbSlots = new Map(); // surname -> Set<dummy slot> (just for ordering)
  for (const s of surns) nbSlots.set(s, new Set());
  const unordered = new Set(surns);
  while (unordered.size > 0) {
    let best = null, bestSat = -1, bestDeg = -1, bestFreq = -1;
    for (const s of unordered) {
      const sat = nbSlots.get(s).size, deg = adj.get(s)?.size ?? 0, freq = counts.get(s) || 0;
      if (sat > bestSat || (sat === bestSat && deg > bestDeg) || (sat === bestSat && deg === bestDeg && freq > bestFreq))
        [best, bestSat, bestDeg, bestFreq] = [s, sat, deg, freq];
    }
    assignOrder.push(best);
    const used = nbSlots.get(best);
    let slot = 0; while (used.has(slot)) slot++;
    for (const nb of (adj.get(best) ?? [])) nbSlots.get(nb)?.add(slot);
    unordered.delete(best);
  }

  // 4. Greedy hue assignment: each surname gets a unique hue chosen as the
  //    midpoint of the largest arc on the colour wheel that is free from its
  //    already-coloured neighbours (hard constraint). Surnames with no
  //    neighbours fill the largest gap among all globally assigned hues so
  //    they spread across the remaining space rather than clustering.
  const largestGapMid = (angles) => {
    const pts = [...new Set(angles)].sort((a, b) => a - b);
    let maxGap = 0, mid = pts[0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = i + 1 < pts.length ? pts[i + 1] : pts[0] + 360;
      const gap = b - a;
      if (gap > maxGap) { maxGap = gap; mid = (a + gap / 2) % 360; }
    }
    return mid;
  };

  const assignedHue = new Map(); // surname -> hue [0,360)
  const allHues = [];            // every hue assigned so far (for spreading isolates)

  for (const surn of assignOrder) {
    if (state.surnameCustomColors.has(surn)) { assignedHue.set(surn, -1); continue; }
    const nbHues = [];
    for (const nb of (adj.get(surn) ?? [])) {
      const h = assignedHue.get(nb);
      if (h != null && h >= 0) nbHues.push(h);
    }
    const hue = nbHues.length > 0
      ? largestGapMid(nbHues)                             // max separation from neighbours
      : (allHues.length > 0 ? largestGapMid(allHues) : 30); // fill global gaps for isolates
    assignedHue.set(surn, hue);
    allHues.push(hue);
  }

  // 5. Apply colours (custom overrides respected)
  state.surnameColors.clear();
  state.surnameEnabled.clear();
  state._surnameColorCache.clear();
  for (const [surn] of sorted) {
    if (state.surnameCustomColors.has(surn)) {
      const c = state.surnameCustomColors.get(surn);
      state.surnameColors.set(surn, c);
      state._surnameColorCache.set(surn, c);
    } else {
      const color = hslToHex(assignedHue.get(surn) ?? 30, 62, 52);
      state.surnameColors.set(surn, color);
      state._surnameColorCache.set(surn, color);
    }
    state.surnameEnabled.set(surn, true);
  }

  if (noSurnCount > 0) {
    state.surnameEnabled.set(null, true);
    sorted.push([null, noSurnCount]);
  }
  return sorted;
}

export function indiColor(indi) {
  if (state.colorBySurname && indi.surn) return surnameColor(indi.surn);
  if (indi.sex === 'M') return state.nodeColors.male;
  if (indi.sex === 'F') return state.nodeColors.female;
  return state.nodeColors.unknown;
}

export function nodeBaseColor(n) {
  if (n.type === 'FAM') return n.data.div ? state.nodeColors.famDiv : state.nodeColors.fam;
  return indiColor(n.data);
}

export function labelColor(n) {
  if (n.type !== 'INDI') return '#888888';
  return indiColor(n.data);
}

export function contrastTextColor(hex) {
  const c = (hex || '').replace('#', '');
  if (c.length !== 6) return '#ffffff';
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? '#1a1a1a' : '#ffffff';
}

export function hasEnabledFamilyName(indi) {
  const names = new Set([indi.surn, indi.maidenName].filter(Boolean));
  if (!names.size) return state.surnameEnabled.get(null) !== false;
  return [...names].some(name => state.surnameEnabled.get(name) !== false);
}

export function updateSurnameShownCount() {
  const el = document.getElementById('surname-shown-count');
  if (!el) return;
  const allEnabled = [...state.surnameEnabled.values()].every(v => v !== false);
  if (allEnabled) {
    el.style.display = 'none';
    return;
  }
  const shown = state.nodes.filter(n => n.type === 'INDI');
  const withSpouses = shown.length;
  const direct = shown.filter(n => hasEnabledFamilyName(n.data)).length;
  el.textContent = t('sidebar.shownCount', { direct, withSpouses });
  el.style.display = '';
}

export function refreshNodeColors() {
  if (!state.nodeSel) return;
  state.nodeSel.each(function(d) {
    if (d.type === 'INDI') {
      d3.select(this).select('rect.indi-box').attr('fill', nodeBaseColor(d));
    } else {
      const col = d.data.div ? state.nodeColors.famDiv : state.nodeColors.fam;
      d3.select(this).select('.fam-polygon')
        .attr('fill',   col)
        .attr('stroke', col);
    }
  });
  _applyFamNodeSize();
  updateLabelColors();
  updateLabels();
  refresh3D();
}

export function buildSurnameList(sorted) {
  const container = document.getElementById('surname-list');
  container.innerHTML = '';
  for (const [surn, count] of sorted) {
    const isNoSurn = surn === null;
    // Use hash color as default, or custom color if set
    const color = isNoSurn ? '#888' : surnameColor(surn);
    const label = isNoSurn ? t('detail.noSurname') : surn;
    const title = isNoSurn ? t('detail.personsWithoutSurname') : escAttr(surn);

    const div = document.createElement('div');
    div.className = 'surname-item';

    if (isNoSurn) {
      // No color picker for "no surname" entry
      div.innerHTML = `
        <input type="checkbox" checked>
        <span class="surname-dot" style="background:${color};border:1px solid #666"></span>
        <span class="surname-label" title="${title}" style="font-style:italic;color:#999">${escHtml(label)}</span>
        <span class="surname-count">${count}</span>`;
    } else {
      // Color picker for surname entries
      const hasCustom = state.surnameCustomColors.has(surn);
      div.innerHTML = `
        <input type="checkbox" checked>
        <input type="color" class="surname-color-picker" value="${color}" title="${t('detail.chooseColor')}">
        <span class="surname-label" title="${title}">${escHtml(label)}</span>
        <span class="surname-count">${count}</span>`;

      const colorInput = div.querySelector('.surname-color-picker');

      // Color change handler
      colorInput.addEventListener('input', e => {
        setSurnameColor(surn, e.target.value);
        _rerenderNodes(); // Update colors without rebuilding simulation
      });

      // Right-click to reset to hash color
      colorInput.addEventListener('contextmenu', e => {
        e.preventDefault();
        setSurnameColor(surn, null); // Clear custom color
        colorInput.value = surnameHashColor(surn); // Reset to hash color
        _rerenderNodes();
      });
    }

    div.querySelector('input[type="checkbox"]').addEventListener('change', e => {
      state.surnameEnabled.set(isNoSurn ? null : surn, e.target.checked);
      applyFilter();
    });
    container.appendChild(div);
  }
}

export function toggleAllSurnames(enabled) {
  state.surnameEnabled.forEach((_, k) => state.surnameEnabled.set(k, enabled));
  document.querySelectorAll('#surname-list input[type=checkbox]').forEach(cb => { cb.checked = enabled; });
  applyFilter();
}

export function compute3DNodeColor(n) {
  const hasHL = state.hlSet.size > 0;
  if (hasHL && !state.hlSet.has(n.id)) return '#0d0d0d';
  return nodeBaseColor(n);
}

export function _compute3DLinkColor(l, hasHL) {
  if (!hasHL) return linkColor(l);
  const sid = typeof l.source === 'object' ? l.source.id : l.source;
  const tid = typeof l.target === 'object' ? l.target.id : l.target;
  return (state.hlSet.has(sid) && state.hlSet.has(tid)) ? linkColor(l) : '#111111';
}

export function updateLinkColors() {
  // Update SVG links (2D)
  if (state.linkSel) {
    state.linkSel.attr('stroke', d => linkColor(d));
  }
  // Update 3D links
  refresh3D();
}

export function resetLinkColors() {
  Object.assign(state.linkColors, LINK_COLOR_DEFAULTS);
  // Sync pickers
  for (const [key, val] of Object.entries(LINK_COLOR_DEFAULTS)) {
    const el = document.getElementById('lc-' + key);
    if (el) el.value = val;
  }
  updateLinkColors();
}

export function updateNodeColors() {
  refreshNodeColors();
}

export function resetNodeColors() {
  Object.assign(state.nodeColors, NODE_COLOR_DEFAULTS);
  const map = { male: 'nc-male', female: 'nc-female', unknown: 'nc-unknown', fam: 'nc-fam', famDiv: 'nc-fam-div' };
  for (const [key, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.value = NODE_COLOR_DEFAULTS[key];
  }
  state.famNodeSize = 1;
  localStorage.setItem('famNodeSize', state.famNodeSize);
  const famSizeSlider = document.getElementById('fam-node-size');
  const famSizeVal    = document.getElementById('fam-node-size-val');
  if (famSizeSlider) famSizeSlider.value = state.famNodeSize;
  if (famSizeVal)    famSizeVal.textContent = state.famNodeSize;
  updateNodeColors();
  _applyFamNodeSize();
}

export function _nameTextColor(n) {
  // Use same color logic as 2D — surname hash or sex color
  return indiColor(n.data);
}
