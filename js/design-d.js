// Design D chrome: the view switcher, the focus bar and the status-bar counts.
// None of it owns state; each control calls the function that already did the
// job from the sidebar or the Tools menu, and syncDesignChrome() reads back.
import { state } from './state.js';
import { clearFocus, cousinLevelLabel, maxCousinDegree, setCousinDegree, setIncludeSpouseFamily } from './graph-data.js';
import { setView } from './render-3d.js';
import { setTreeLayout } from './tree-layout.js';
import { openMapView } from './map-view.js';
import { openStatsTool } from './stats.js';
import { openRelationTool } from './relations.js';

const $ = id => document.getElementById(id);

export function currentDesignView() {
  if (state.currentView === '3d') return '3d';
  return state.treeLayout ? 'chart' : 'force';
}

export function selectDesignView(v) {
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

export function focusFindBox() {
  document.getElementById('sidebar')?.classList.add('sidebar-open');
  const el = $('search-input');
  if (el) { el.focus(); el.select(); }
}

export function syncDesignChrome() {
  const cur = currentDesignView();
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
  const c = $('sb-counts');
  if (c) {
    const n = state.individuals.size, f = state.families.size;
    c.textContent = n ? `${n} · ${f}` : '';
  }
}

// Ctrl/Cmd+K opens the person search, as the topbar chip advertises.
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusFindBox(); }
});

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
}
