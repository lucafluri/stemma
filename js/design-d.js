// Design D chrome: the view switcher, the focus bar and the status-bar counts.
// None of it owns state; each control calls the function that already did the
// job from the sidebar or the Tools menu, and syncDesignChrome() reads back.
import { state } from './state.js';
import { clearFocus, cousinLevelLabel, generationNumbers, goToPerson, maxCousinDegree, setCousinDegree, setIncludeSpouseFamily } from './graph-data.js';
import { checkTree, openCheckTool } from './check.js';
import { escHtml, escJs } from './gedcom-io.js';
import { personLabel, searchPeople } from './search.js';
import { nodeBaseColor } from './colors.js';
import { setView } from './render-3d.js';
import { setTreeLayout } from './tree-layout.js';
import { closeMapView, openMapView } from './map-view.js';
import { closeStatsTool, openStatsTool } from './stats.js';
import { openRelationTool } from './relations.js';

const $ = id => document.getElementById(id);

export function currentDesignView() {
  if (state.currentView === '3d') return '3d';
  return state.treeLayout ? 'chart' : 'force';
}

// Map and Statistics are dialogs over the chart, so a switch made from inside
// one has to put the other away first.
function closeViewDialogs() {
  for (const [id, close] of [['map-modal', closeMapView], ['stats-modal', closeStatsTool]]) {
    if ($(id)?.style.display !== 'none') close();
  }
}

export function selectDesignView(v) {
  closeViewDialogs();
  if (v === 'map') return openMapView();
  if (v === 'stats') return openStatsTool();
  if (v === 'relations') return openRelationTool();
  if (v === '3d') { if (state.currentView !== '3d') setView('3d'); }
  else {
    if (state.currentView !== '2d') setView('2d');
    setTreeLayout(v === 'chart');
  }
  syncDesignChrome();
}

export function cycleCousinDegree() {
  const max = maxCousinDegree();
  setCousinDegree(state.cousinDegree >= Math.min(max, 4) ? 0 : state.cousinDegree + 1);
  syncDesignChrome();
}

export function toggleSpouseFamily() {
  setIncludeSpouseFamily(!state.includeSpouseFamily);
  syncDesignChrome();
}

export function syncDesignChrome() {
  const cur = currentDesignView();
  document.querySelectorAll('.view-switch-clone button').forEach(b => {
    const on = b.dataset.view === (b.closest('#map-panel') ? 'map' : 'stats');
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('#view-switch button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === cur);
    b.setAttribute('aria-pressed', String(b.dataset.view === cur));
  });
  const bar = $('focus-bar');
  if (bar) {
    const focused = !!(state.focusRootId && state.individuals.has(state.focusRootId));
    bar.style.display = focused ? '' : 'none';
    if (focused) {
      $('fb-name').textContent = state.individuals.get(state.focusRootId).displayName || state.focusRootId;
      $('fb-cousins').textContent = t('design.cousins', { level: cousinLevelLabel(state.cousinDegree, maxCousinDegree()) });
      $('fb-cousins').style.display = state.currentView === '2d' ? '' : 'none';
      const sp = $('fb-spouse');
      sp.style.display = state.treeLayout && state.currentView === '2d' ? '' : 'none';
      sp.classList.toggle('active', !!state.includeSpouseFamily);
      sp.setAttribute('aria-pressed', String(!!state.includeSpouseFamily));
      $('fb-anc').classList.toggle('active', state.hlMode === 'ancestors');
      $('fb-desc').classList.toggle('active', state.hlMode === 'descendants');
    }
  }
  document.body.classList.toggle('view-3d', state.currentView === '3d');
  syncColorButton();
  refreshRail();
  const c = $('sb-counts');
  if (c) {
    const n = state.individuals.size, f = state.families.size;
    c.textContent = n ? `${n} · ${f}` : '';
  }
}

// ── Colour mode ─────────────────────────────────────────────────────────────
// The sidebar checkbox owns the setting; this button is a second handle on it.
export function toggleColorMode() {
  const cb = $('color-by-surname');
  if (!cb) return;
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change'));
  syncColorButton();
}

export function syncColorButton() {
  const b = $('color-mode-btn');
  if (b) b.textContent = t('design.colour', { mode: t(state.colorBySurname ? 'design.bySurname' : 'design.bySex') });
}

// ── Left rail: surnames / generations / issues ──────────────────────────────
let _railTab = 'surnames';

export function railTab(name) {
  _railTab = name;
  for (const n of ['surnames', 'gens', 'issues']) {
    $('rt-' + n)?.setAttribute('aria-selected', String(n === name));
    const pane = $('rail-' + n);
    if (pane) pane.style.display = n === name ? '' : 'none';
  }
  if (name === 'gens') renderGenerations();
  if (name === 'issues') renderIssues();
}

const RAIL_CAP = 40;
const _openGens = new Set();

function _year(id) { return state.individuals.get(id)?.birthYear || 9999; }

export function renderGenerations() {
  const box = $('rail-gens');
  if (!box) return;
  if (!state.individuals.size) { box.innerHTML = ''; return; }
  const groups = new Map();
  for (const [id, g] of generationNumbers()) {
    if (!state.individuals.has(id)) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(id);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  box.innerHTML = keys.map(g => {
    const ids = groups.get(g).sort((a, b) => _year(a) - _year(b));
    const open = _openGens.has(g);
    const rows = open ? ids.slice(0, RAIL_CAP).map(id => {
      const col = nodeBaseColor({ type: 'INDI', data: state.individuals.get(id) });
      return `<button class="rail-person${id === state.selectedIndiId ? ' active' : ''}" onclick="goToPerson('${escJs(id)}')"><span class="surname-dot" style="background:${col}"></span>${escHtml(personLabel(id))}</button>`;
    }).join('') + (ids.length > RAIL_CAP ? `<div class="rail-more">${escHtml(t('design.moreN', { n: ids.length - RAIL_CAP }))}</div>` : '') : '';
    return `<div class="rail-group${open ? ' open' : ''}">
      <button class="rail-group-head" aria-expanded="${open}" onclick="toggleRailGen(${g})">
        <span>${escHtml(t('design.generation', { n: g + 1 }))}</span><span class="rail-count">${ids.length}</span>
      </button>${rows}</div>`;
  }).join('');
}

export function toggleRailGen(g) {
  if (_openGens.has(g)) _openGens.delete(g); else _openGens.add(g);
  renderGenerations();
}

export function renderIssues() {
  const box = $('rail-issues');
  if (!box) return;
  const list = state.individuals.size <= 20000 ? checkTree() : [];
  const n = $('rt-issues-n');
  if (n) n.textContent = list.length ? String(list.length) : '';
  if (!list.length) { box.innerHTML = `<div class="rail-more">${escHtml(t('design.noIssues'))}</div>`; return; }
  const name = id => state.individuals.get(id)?.displayName || id;
  box.innerHTML = list.slice(0, 100).map(i => `
    <button class="rail-issue rail-issue--${i.level}" onclick="goToPerson('${escJs(i.ids[0])}')">
      <span class="rail-issue-name">${escHtml(name(i.ids[0]))}</span>
      <span class="rail-issue-kind">${escHtml(t('check.kind.' + i.kind))}</span>
    </button>`).join('') +
    (list.length > 100 ? `<div class="rail-more">${escHtml(t('design.moreN', { n: list.length - 100 }))}</div>` : '') +
    `<button class="rail-link" onclick="openCheckTool()">${escHtml(t('life.openCheck'))}</button>`;
}

let _issueTimer = 0;
function refreshRail() {
  clearTimeout(_issueTimer);
  _issueTimer = setTimeout(() => {
    if (_railTab === 'gens') renderGenerations();
    if (_railTab === 'issues') renderIssues();
    else {
      const n = $('rt-issues-n');
      if (n) n.textContent = state.individuals.size && state.individuals.size <= 4000
        ? (() => { const c = checkTree().length; return c ? String(c) : ''; })() : '';
    }
  }, 250);
}

// Opening the view options brings them into view — they open below the people
// list, which can be taller than the sidebar.
$('sidebar-more')?.addEventListener('toggle', e => {
  if (e.target.open) e.target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
});

// ── Minimap ─────────────────────────────────────────────────────────────────
const MM_W = 150, MM_H = 100;
let _mmSig = '', _mmBox = null;

function _mmBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of state.nodes) {
    if (n.x == null || n.y == null) continue;
    if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y;
  }
  return x0 === Infinity ? null : { x0: x0 - 46, y0: y0 - 15, x1: x1 + 46, y1: y1 + 15 };
}

function paintMinimap() {
  const c = $('minimap');
  if (!c) return;
  const show = state.currentView === '2d' && state.nodes?.length > 1 && !!state.svgSel && typeof d3 !== 'undefined';
  c.style.display = show ? '' : 'none';
  if (!show) return;
  const svg = $('graph-svg');
  const t = d3.zoomTransform(state.svgSel.node());
  const W = svg.clientWidth || 1, H = svg.clientHeight || 1;
  const first = state.nodes[0], last = state.nodes[state.nodes.length - 1];
  const sig = [state.nodes.length, Math.round(first?.x), Math.round(last?.y), t.k.toFixed(3), Math.round(t.x), Math.round(t.y), W, H].join('|');
  if (sig === _mmSig) return;
  _mmSig = sig;
  const b = _mmBox = _mmBounds();
  if (!b) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (c.width !== MM_W * dpr) { c.width = MM_W * dpr; c.height = MM_H * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, MM_W, MM_H);
  const vx0 = -t.x / t.k, vy0 = -t.y / t.k, vx1 = (W - t.x) / t.k, vy1 = (H - t.y) / t.k;
  // The map covers the chart and the window, so panning away from the chart still shows where you are.
  const X0 = Math.min(b.x0, vx0), Y0 = Math.min(b.y0, vy0), X1 = Math.max(b.x1, vx1), Y1 = Math.max(b.y1, vy1);
  const sc = Math.min((MM_W - 8) / (X1 - X0), (MM_H - 8) / (Y1 - Y0));
  const ox = (MM_W - (X1 - X0) * sc) / 2 - X0 * sc, oy = (MM_H - (Y1 - Y0) * sc) / 2 - Y0 * sc;
  _mmBox = { sc, ox, oy, k: t.k, W, H };
  ctx.fillStyle = '#5a6577';
  for (const n of state.nodes) {
    if (n.x == null || n.type !== 'INDI') continue;
    ctx.fillRect(n.x * sc + ox - 1.5, n.y * sc + oy - 1, 3, 2);
  }
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7aa2f7';
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
  ctx.strokeRect(vx0 * sc + ox, vy0 * sc + oy, (vx1 - vx0) * sc, (vy1 - vy0) * sc);
}

function _mmClick(e) {
  if (!_mmBox || !state.svgSel || !state.zoomBehavior) return;
  const r = e.currentTarget.getBoundingClientRect();
  const gx = ((e.clientX - r.left) * (MM_W / r.width) - _mmBox.ox) / _mmBox.sc;
  const gy = ((e.clientY - r.top) * (MM_H / r.height) - _mmBox.oy) / _mmBox.sc;
  const k = _mmBox.k;
  state.svgSel.transition().duration(250)
    .call(state.zoomBehavior.transform, d3.zoomIdentity.translate(_mmBox.W / 2 - gx * k, _mmBox.H / 2 - gy * k).scale(k));
}

// ── Command palette ─────────────────────────────────────────────────────────
let _cmdItems = [], _cmdSel = 0;

const W = name => (...a) => window[name]?.(...a);
function commands() {
  return [
    { label: t('topbar.import'), run: W('openImport') },
    { label: t('topbar.newPerson'), run: W('addNewPerson') },
    { label: t('topbar.save'), run: W('downloadGEDCOM') },
    { label: t('history.undo'), run: W('undo') },
    { label: t('history.redo'), run: W('redo') },
    { label: t('design.chart'), hint: 'view', run: () => selectDesignView('chart') },
    { label: t('design.force'), hint: 'view', run: () => selectDesignView('force') },
    { label: '3D', hint: 'view', run: () => selectDesignView('3d') },
    { label: t('map.title'), hint: 'view', run: () => selectDesignView('map') },
    { label: t('stats.title'), hint: 'view', run: () => selectDesignView('stats') },
    { label: t('topbar.relation'), hint: 'view', run: () => selectDesignView('relations') },
    { label: t('find.title'), run: W('openFindTool') },
    { label: t('check.title'), run: () => openCheckTool() },
    { label: t('places.title'), run: W('openPlacesTool') },
    { label: t('changes.title'), run: W('openChangesTool') },
    { label: t('sidebar.fitAll'), run: W('zoomToFit') },
    { label: t('focus.exportPNG'), run: W('export2DImage') },
    { label: t('focus.exportSVG'), run: W('export2DSVG') },
    { label: t('focus.clear'), run: () => clearFocus() },
    { label: t('design.lang'), run: () => { const s = $('lang-switcher'); if (s) { s.value = s.value === 'de' ? 'en' : 'de'; window.setLanguage?.(s.value); } } },
  ];
}

export function openCmdK() {
  const m = $('cmdk');
  if (!m) return;
  m.style.display = 'flex';
  const inp = $('cmdk-input');
  inp.value = '';
  renderCmdK();
  inp.focus();
}

export function closeCmdK() {
  const m = $('cmdk');
  if (m) m.style.display = 'none';
}

function _fold(s) { return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

export function renderCmdK() {
  const q = $('cmdk-input').value.trim();
  const fq = _fold(q);
  const people = q.length >= 1 ? searchPeople(q, 8).map(h => ({ kind: 'person', id: h.id, label: personLabel(h.id) })) : [];
  const cmds = commands().filter(c => !fq || _fold(c.label).includes(fq)).slice(0, q ? 8 : 20).map(c => ({ ...c, kind: 'cmd' }));
  _cmdItems = [...people, ...cmds];
  _cmdSel = 0;
  let html = '';
  if (people.length) html += `<div class="cmdk-group">${escHtml(t('design.cmdPeople'))}</div>`;
  _cmdItems.forEach((it, i) => {
    if (it.kind === 'cmd' && (i === 0 || _cmdItems[i - 1].kind === 'person' || i === people.length)) {
      if (i === people.length) html += `<div class="cmdk-group">${escHtml(t('design.cmdCommands'))}</div>`;
    }
    html += `<button class="cmdk-item${i === 0 ? ' active' : ''}" role="option" data-i="${i}" onmousemove="cmdkHover(${i})" onclick="cmdkRun(${i})">${escHtml(it.label)}</button>`;
  });
  if (!_cmdItems.length) html = `<div class="cmdk-empty">${escHtml(t('design.cmdNone'))}</div>`;
  $('cmdk-list').innerHTML = html;
}

export function cmdkHover(i) { _setCmdSel(i); }

function _setCmdSel(i) {
  if (!_cmdItems.length) return;
  _cmdSel = (i + _cmdItems.length) % _cmdItems.length;
  document.querySelectorAll('#cmdk-list .cmdk-item').forEach(el => el.classList.toggle('active', +el.dataset.i === _cmdSel));
  document.querySelector('#cmdk-list .cmdk-item.active')?.scrollIntoView({ block: 'nearest' });
}

export function cmdkRun(i = _cmdSel) {
  const it = _cmdItems[i];
  if (!it) return;
  closeCmdK();
  if (it.kind === 'person') goToPerson(it.id);
  else it.run();
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdK(); return; }
  if ($('cmdk')?.style.display === 'none' || !$('cmdk')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeCmdK(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); _setCmdSel(_cmdSel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _setCmdSel(_cmdSel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); cmdkRun(); }
});
$('cmdk-input')?.addEventListener('input', renderCmdK);
$('minimap')?.addEventListener('click', _mmClick);

// ── Wiring ──────────────────────────────────────────────────────────────────

// Everything that can change what the chrome shows already refreshes the focus
// panel, the view toggle or the highlight buttons; piggy-back on those.
if (typeof MutationObserver !== 'undefined') {
  let _raf = 0;
  const schedule = () => { cancelAnimationFrame(_raf); _raf = requestAnimationFrame(syncDesignChrome); };
  const watch = (id, opts) => { const el = $(id); if (el) new MutationObserver(schedule).observe(el, opts); };
  watch('focus-current-name', { childList: true, characterData: true, subtree: true });
  watch('status', { childList: true, characterData: true, subtree: true });
  watch('view-toggle-btn', { childList: true, attributes: true });
  watch('detail-buttons', { attributes: true, subtree: true, attributeFilter: ['class'] });
  schedule();
  // Per frame is cheap: paintMinimap() returns early on an unchanged signature.
  (function loop() { paintMinimap(); requestAnimationFrame(loop); })();
}

// The same switcher inside the Map and Statistics dialogs, so they read as
// views and not as something to dismiss before going anywhere else.
const _src = $('view-switch');
if (_src) {
  for (const sel of ['#map-panel .modal-header', '#stats-panel .modal-header']) {
    const head = document.querySelector(sel);
    if (!head) continue;
    const clone = _src.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.add('view-switch-clone');
    head.insertBefore(clone, head.querySelector('h2')?.nextSibling || null);
  }
}
