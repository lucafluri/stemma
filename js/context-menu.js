/**
 * Right-click menu on a graph node — the detail panel's own actions (focus,
 * highlight ancestors/descendants, centre) reached without opening the panel
 * first. Shared between the 2D SVG nodes and the 3D scene, which is why it is
 * its own module rather than living inside either renderer.
 */
import { toggleFocusOnPerson } from './graph-data.js';
import { showFamDetail, showIndiDetail } from './panels.js';
import { centerOnPerson } from './render-2d.js';
import { highlightMode, resetHighlight } from './relations.js';
import { state } from './state.js';

function _el(id) { return document.getElementById(id); }

function _menuItems(id, type) {
  if (type === 'FAM') {
    return [{ label: t('ctxMenu.show'), run: () => showFamDetail(id) }];
  }
  const isFocus = state.focusRootId === id;
  return [
    { label: t('ctxMenu.show'), run: () => showIndiDetail(id) },
    { label: isFocus ? t('ctxMenu.clearFocus') : t('ctxMenu.focus'), run: () => toggleFocusOnPerson(id) },
    { label: t('ctxMenu.ancestors'),   run: () => { showIndiDetail(id); highlightMode('ancestors'); } },
    { label: t('ctxMenu.descendants'), run: () => { showIndiDetail(id); highlightMode('descendants'); } },
    { label: t('ctxMenu.both'),        run: () => { showIndiDetail(id); highlightMode('both'); } },
    { label: t('ctxMenu.clearHighlight'), run: () => resetHighlight() },
    { label: t('ctxMenu.center'), run: () => { showIndiDetail(id); centerOnPerson(); } },
  ];
}

function _closeContextMenu() {
  const menu = _el('node-context-menu');
  if (menu) menu.style.display = 'none';
  document.removeEventListener('keydown', _onMenuKey);
}

function _onMenuKey(e) {
  if (e.key === 'Escape') _closeContextMenu();
}

/** `evt` needs only clientX/clientY — the 2D SVG handler passes the native
 * event, the 3D one (onNodeRightClick) passes its MouseEvent straight through. */
export function openNodeContextMenu(evt, id, type) {
  evt.preventDefault?.();
  evt.stopPropagation?.();
  const menu = _el('node-context-menu');
  if (!menu || !id) return;

  menu.innerHTML = '';
  for (const item of _menuItems(id, type)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.onclick = () => { _closeContextMenu(); item.run(); };
    menu.appendChild(btn);
  }

  menu.style.display = 'block';
  // Keep it on screen — a right-click near an edge must not open a menu that
  // partly runs off it.
  const x = evt.clientX ?? 0, y = evt.clientY ?? 0;
  menu.style.left = Math.max(0, Math.min(x, window.innerWidth  - menu.offsetWidth  - 8)) + 'px';
  menu.style.top  = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';

  // Bound after this click has finished bubbling, or the same right-click that
  // opened the menu would close it again via the listener below.
  setTimeout(() => {
    document.addEventListener('click', _closeContextMenu, { once: true });
    document.addEventListener('contextmenu', _closeContextMenu, { once: true });
    document.addEventListener('keydown', _onMenuKey);
  }, 0);
}
