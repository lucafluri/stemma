/**
 * Media attachments — photos, video, audio and documents on people and
 * families.
 *
 * ── How it stays portable ────────────────────────────────────────────────────
 * The tree records media the way GEDCOM always has: an OBJE record with a FILE
 * path, linked from the person (`1 OBJE @O1@`). Every genealogy program reads
 * that. What no .ged file can carry is the file itself, so:
 *
 *  · New attachments get a relative path, `media/<name>`. That is the layout
 *    every program expects when the .ged and a media folder travel together.
 *  · "GEDCOM + media (.zip)" writes exactly that: the .ged at the root and the
 *    files under the paths it names. Unzip it anywhere and Gramps, RootsMagic,
 *    Family Tree Maker or webtrees find the pictures; GEDZIP (.gdz) readers
 *    open it directly.
 *  · Opening a .zip/.gdz, or pointing the app at the folder a .ged's pictures
 *    live in, matches files to FILE paths — by full path first, then by the
 *    longest matching tail, so an absolute Windows path written by another
 *    program still finds "photos/hans.jpg".
 *
 * The bytes live in IndexedDB keyed by FILE path, so a reload (or the autosave
 * restore) still has them. Nothing here is required: a tree without media, or
 * with the feature switched off in the settings, behaves exactly as before, and
 * the plain GEDCOM download never changes.
 */

import { state } from './state.js';
import { idbAvailable, idbDel, idbGet, idbKeys, idbSet } from './store.js';
import { makeZip, readZip } from './zip.js';

// ── Paths ─────────────────────────────────────────────────────────────────

export const isExternal = p => /^(https?:|data:|blob:)/i.test(String(p || '').trim());

const _slashes = p => String(p || '').trim().replace(/\\/g, '/');

export function baseName(p) {
  return _slashes(p).split('/').pop() || '';
}

/** A path safe to put in a zip and in a GEDCOM FILE line: relative, forward
 *  slashes, no drive letter, no "..". */
export function relativePath(p) {
  const s = _slashes(p);
  if (!s || isExternal(s)) return '';
  if (/^[A-Za-z]:\//.test(s) || s.startsWith('/') || s.split('/').includes('..')) return '';
  return s.replace(/^\.\//, '');
}

function _safeName(name) {
  const n = String(name || 'file').normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_')
    .replace(/\s+/g, ' ').trim();
  return n || 'file';
}

const _MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', htm: 'text/html', html: 'text/html',
};
export const mimeOf = path => _MIME[GEDCOMModule.mediaFormOf(path)] || '';

export const mediaKind = m => GEDCOMModule.mediaKindOf(m);

// ── Bytes ─────────────────────────────────────────────────────────────────
//
// A session map in front of IndexedDB: the store is asynchronous and may be
// missing altogether (private windows in some browsers), and neither of those
// should stop a picture just added from showing.

const _blobs = new Map();   // FILE path → Blob, for this session
const _urls  = new Map();   // FILE path → object URL

export async function putMediaFile(path, blob) {
  _blobs.set(path, blob);
  const old = _urls.get(path);
  if (old) { URL.revokeObjectURL(old); _urls.delete(path); }
  if (!idbAvailable()) return false;
  try { await idbSet('media', path, blob); return true; } catch { return false; }
}

export async function getMediaFile(path) {
  if (!path || isExternal(path)) return null;
  if (_blobs.has(path)) return _blobs.get(path);
  if (!idbAvailable()) return null;
  try {
    const b = await idbGet('media', path);
    if (b) _blobs.set(path, b);
    return b || null;
  } catch { return null; }
}

/** Something an <img>/<video> can point at, or null when the file is not here. */
export async function mediaUrl(m) {
  if (!m?.file) return null;
  if (isExternal(m.file)) return m.file;
  if (_urls.has(m.file)) return _urls.get(m.file);
  const blob = await getMediaFile(m.file);
  if (!blob) return null;
  const typed = blob.type ? blob : new Blob([blob], { type: mimeOf(m.file) });
  const url = URL.createObjectURL(typed);
  _urls.set(m.file, url);
  return url;
}

/** Forget this session's files (a different tree is being opened). */
export function resetMediaSession() {
  for (const u of _urls.values()) URL.revokeObjectURL(u);
  _urls.clear();
  _blobs.clear();
}

/** Delete stored files no record of the current tree points at. */
export async function pruneStoredMedia() {
  if (!idbAvailable()) return 0;
  const used = new Set([...state.media.values()].map(m => m.file));
  let n = 0;
  for (const key of await idbKeys('media')) {
    if (!used.has(key)) { await idbDel('media', key); n++; }
  }
  return n;
}

// ── Records and links ─────────────────────────────────────────────────────

export function mediaEnabled() {
  return state.mediaEnabled !== false;
}

/** The person or family with this id. */
export function mediaOwner(id) {
  return state.individuals.get(id) || state.families.get(id) || null;
}

export function mediaOf(owner) {
  return (owner?.media || []).map(id => state.media.get(id)).filter(Boolean);
}

/** The picture that stands for this person: the one marked primary, else the
 *  first image. */
export function portraitOf(owner) {
  const list = mediaOf(owner);
  const prim = owner?._primMedia && state.media.get(owner._primMedia);
  if (prim && mediaKind(prim) === 'image') return prim;
  return list.find(m => mediaKind(m) === 'image') || null;
}

export function mediaLabel(m) {
  return m?.title || baseName(m?.file) || m?.id || '';
}

let _nextObje = 1;
function _newMediaId() {
  let id;
  do id = `@O${_nextObje++}@`; while (state.media.has(id));
  return id;
}

/** A FILE path under media/ that no other record already uses. */
function _freePath(name) {
  const used = new Set([...state.media.values()].map(m => m.file));
  const clean = _safeName(name);
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  let path = `media/${clean}`, n = 2;
  while (used.has(path)) path = `media/${stem}-${n++}${ext}`;
  return path;
}

function _link(owner, id) {
  owner.media = owner.media || [];
  if (!owner.media.includes(id)) owner.media.push(id);
}

/**
 * Attach local files to a person or family. The same file added twice (same
 * name, same size) is linked, not stored twice. Resolves to the new ids.
 */
export async function addMediaFiles(ownerId, files) {
  const owner = mediaOwner(ownerId);
  if (!owner) return [];
  const ids = [];
  for (const file of files) {
    let existing = null;
    for (const m of state.media.values()) {
      if (baseName(m.file) !== _safeName(file.name) && baseName(m.file) !== file.name) continue;
      const b = await getMediaFile(m.file);
      if (b && b.size === file.size) { existing = m; break; }
    }
    let id;
    if (existing) {
      id = existing.id;
    } else {
      const path = _freePath(file.name);
      id = _newMediaId();
      const form = GEDCOMModule.mediaFormOf(file.name) || (file.type.split('/')[1] || '');
      state.media.set(id, { id, file: path, form, type: '', title: file.name.replace(/\.[^.]+$/, '') });
      await putMediaFile(path, file);
    }
    _link(owner, id);
    ids.push(id);
  }
  return ids;
}

/** Attach a web address (an archive page, a video on a site) by reference. */
export function addMediaUrl(ownerId, url, title = '') {
  const owner = mediaOwner(ownerId);
  const u = String(url || '').trim();
  if (!owner || !/^https?:\/\//i.test(u)) return null;
  let rec = [...state.media.values()].find(m => m.file === u);
  if (!rec) {
    rec = { id: _newMediaId(), file: u, form: GEDCOMModule.mediaFormOf(u) || 'url', type: '', title: title || '' };
    state.media.set(rec.id, rec);
  }
  _link(owner, rec.id);
  return rec.id;
}

/** Take a medium off one person; the record goes once nobody links it. */
export function unlinkMedia(ownerId, mediaId) {
  const owner = mediaOwner(ownerId);
  if (!owner?.media) return;
  owner.media = owner.media.filter(x => x !== mediaId);
  if (!owner.media.length) delete owner.media;
  if (owner._primMedia === mediaId) delete owner._primMedia;
  if (owner._sub) delete owner._sub['OBJE ' + mediaId];
  if (!_isLinked(mediaId)) state.media.delete(mediaId);
}

function _isLinked(mediaId) {
  for (const i of state.individuals.values()) if (i.media?.includes(mediaId)) return true;
  for (const f of state.families.values()) if (f.media?.includes(mediaId)) return true;
  return false;
}

/** Make this the person's portrait: first in the list, and marked _PRIM. */
export function setPrimaryMedia(ownerId, mediaId) {
  const owner = mediaOwner(ownerId);
  if (!owner?.media?.includes(mediaId)) return;
  owner.media = [mediaId, ...owner.media.filter(x => x !== mediaId)];
  owner._primMedia = mediaId;
}

/** Drop links to media records that do not exist (a trimmed subset, a
 *  hand-edited file). */
export function pruneDanglingMediaLinks() {
  for (const o of [...state.individuals.values(), ...state.families.values()]) {
    if (!o.media) continue;
    o.media = o.media.filter(id => typeof id === 'string' && state.media.has(id));
    if (!o.media.length) delete o.media;
  }
}

// ── Matching files to FILE paths ──────────────────────────────────────────

const _segs = p => _slashes(p).toLowerCase().split('/').filter(Boolean);

/**
 * For each record whose file is not here yet, find it among `candidates`
 * ([{ path, get: () => Promise<Blob> }]) and store it under the record's own
 * FILE path. Returns { matched, missing }.
 */
export async function attachCandidates(candidates, { onProgress } = {}) {
  const byBase = new Map();
  for (const c of candidates) {
    const b = baseName(c.path).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(c);
  }
  let matched = 0, missing = 0, done = 0;
  const records = [...state.media.values()].filter(m => m.file && !isExternal(m.file));
  for (const m of records) {
    done++;
    const pool = byBase.get(baseName(m.file).toLowerCase());
    if (!pool) { if (!(await getMediaFile(m.file))) missing++; continue; }
    const want = _segs(m.file);
    let best = null, bestScore = -1;
    for (const c of pool) {
      const have = _segs(c.path);
      let k = 0;
      while (k < want.length && k < have.length && want[want.length - 1 - k] === have[have.length - 1 - k]) k++;
      if (k > bestScore) { best = c; bestScore = k; }
    }
    const blob = await best.get();
    const typed = blob.type ? blob : new Blob([blob], { type: mimeOf(m.file) });
    await putMediaFile(m.file, typed);
    matched++;
    onProgress?.(done, records.length);
  }
  return { matched, missing };
}

/** Files picked from a folder (webkitdirectory) or a multi-select. */
export function candidatesFromFiles(files) {
  return [...files].map(f => ({ path: f.webkitRelativePath || f.name, get: async () => f }));
}

// ── Archives ──────────────────────────────────────────────────────────────

const _GED_RE = /\.ged$/i;

/**
 * Open a .zip/.gdz: the GEDCOM inside (GEDZIP's gedcom.ged, else the shallowest
 * .ged) as text, plus the other entries as candidates for its FILE paths,
 * relative to the folder the .ged sits in.
 */
export async function readMediaArchive(file) {
  const entries = await readZip(file);
  const geds = entries.filter(e => _GED_RE.test(e.name));
  if (!geds.length) throw new Error(t('media.noGedInZip'));
  const ged = geds.find(e => /(^|\/)gedcom\.ged$/i.test(e.name))
    || geds.sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  const dir = ged.name.includes('/') ? ged.name.slice(0, ged.name.lastIndexOf('/') + 1) : '';
  const text = GEDCOMModule.decodeGedcom(await (await ged.blob()).arrayBuffer());
  const candidates = entries
    .filter(e => e !== ged && !_GED_RE.test(e.name))
    .map(e => ({
      path: dir && e.name.startsWith(dir) ? e.name.slice(dir.length) : e.name,
      get: () => e.blob(mimeOf(e.name)),
    }));
  return { text, candidates, gedName: baseName(ged.name) };
}

/**
 * The tree and every media file it links, as one zip: `<name>.ged` at the root
 * and each file under the relative path its FILE line gives. Records whose
 * path is absolute are given `media/<name>` inside the archive. The tree in
 * memory keeps its own paths — only the copy in the zip is rewritten.
 */
export async function buildMediaArchive({ individuals, families, otherLines, media, baseName: name }, { onProgress } = {}) {
  const entries = [];
  const out = new Map();
  const taken = new Map();   // zip path → media id
  let missing = 0;
  const list = [...media.values()];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const copy = { ...m };
    out.set(m.id, copy);
    onProgress?.(i, list.length);
    if (!m.file || isExternal(m.file)) continue;
    const blob = await getMediaFile(m.file);
    if (!blob) { missing++; continue; }
    let path = relativePath(m.file) || `media/${_safeName(baseName(m.file))}`;
    if (taken.has(path) && taken.get(path) !== m.id) {
      const dot = path.lastIndexOf('.');
      let n = 2, p2;
      do p2 = dot > 0 ? `${path.slice(0, dot)}-${n++}${path.slice(dot)}` : `${path}-${n++}`; while (taken.has(p2));
      path = p2;
    }
    taken.set(path, m.id);
    copy.file = path;
    entries.push({ name: path, data: blob, compress: false });
  }
  const ged = '﻿' + GEDCOMModule.serializeGEDCOM(individuals, families, otherLines, out);
  entries.unshift({ name: `${name}.ged`, data: ged, compress: true });
  const blob = await makeZip(entries);
  return { blob, files: entries.length - 1, missing };
}

// ── The gallery in the detail panel ───────────────────────────────────────

const _ICON = { image: '🖼', video: '🎞', audio: '🎵', document: '📄', other: '📎' };

const _esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The media block of a person's or family's detail view. */
export function mediaSectionHtml(ownerId) {
  if (!mediaEnabled()) return '';
  const owner = mediaOwner(ownerId);
  if (!owner) return '';
  const list = mediaOf(owner);
  const portrait = portraitOf(owner);
  const tiles = list.map(m => {
    const kind = mediaKind(m);
    const star = portrait && portrait.id === m.id ? `<span class="media-star" title="${_esc(t('media.portrait'))}">★</span>` : '';
    const inner = kind === 'image'
      ? `<img data-media-src="${_esc(m.id)}" alt="" loading="lazy">`
      : `<span class="media-icon">${_ICON[kind] || _ICON.other}</span>`;
    return `<button type="button" class="media-tile media-tile--${kind}" data-media-tile="${_esc(m.id)}"
        onclick="openMediaViewer('${_esc(ownerId)}','${_esc(m.id)}')" title="${_esc(mediaLabel(m))}">
        ${inner}${star}<span class="media-cap">${_esc(mediaLabel(m))}</span></button>`;
  }).join('');
  return `<div class="detail-section media-section" data-media-owner="${_esc(ownerId)}">
    <div class="detail-label media-head">
      <span>${_esc(t('media.title'))}${list.length ? ` (${list.length})` : ''}</span>
      <span class="media-actions">
        <button type="button" class="media-add-btn" onclick="pickMediaFor('${_esc(ownerId)}')" title="${_esc(t('media.addTitle'))}">＋ ${_esc(t('media.add'))}</button>
        <button type="button" class="media-add-btn" onclick="addMediaLinkFor('${_esc(ownerId)}')" title="${_esc(t('media.addUrlTitle'))}">🔗</button>
      </span>
    </div>
    ${list.length ? `<div class="media-grid">${tiles}</div>` : `<div class="media-empty">${_esc(t('media.empty'))}</div>`}
  </div>`;
}

/** Fill in thumbnails, and mark tiles whose file is not in this browser. */
export async function hydrateMedia(root) {
  if (!root) return;
  for (const tile of root.querySelectorAll('[data-media-tile]')) {
    const m = state.media.get(tile.dataset.mediaTile);
    if (!m) continue;
    const url = await mediaUrl(m);
    if (!url) { tile.classList.add('media-tile--missing'); continue; }
    const img = tile.querySelector('img[data-media-src]');
    if (img) {
      img.onerror = () => tile.classList.add('media-tile--missing');
      img.src = url;
    }
  }
  const p = root.querySelector?.('#detail-portrait-img') || document.getElementById('detail-portrait-img');
  if (p?.dataset.mediaSrc) {
    const m = state.media.get(p.dataset.mediaSrc);
    const url = m && await mediaUrl(m);
    if (url) { p.src = url; p.parentElement.style.display = ''; }
  }
}

/** The small portrait beside the name at the top of the panel. */
export function renderPortrait(ownerId) {
  const box = document.getElementById('detail-portrait');
  if (!box) return;
  const owner = mediaEnabled() ? mediaOwner(ownerId) : null;
  const m = owner && portraitOf(owner);
  box.style.display = 'none';
  box.innerHTML = '';
  if (!m) return;
  box.innerHTML = `<img id="detail-portrait-img" data-media-src="${_esc(m.id)}" alt="" onclick="openMediaViewer('${_esc(ownerId)}','${_esc(m.id)}')">`;
  hydrateMedia(box);
}

// ── The viewer ────────────────────────────────────────────────────────────

let _view = null;   // { ownerId, mediaId }

export async function openMediaViewer(ownerId, mediaId) {
  const modal = document.getElementById('media-viewer');
  const m = state.media.get(mediaId);
  if (!modal || !m) return;
  _view = { ownerId, mediaId };
  modal.style.display = 'flex';
  await renderMediaViewer();
  document.addEventListener('keydown', _viewerKey);
}

export function closeMediaViewer() {
  const modal = document.getElementById('media-viewer');
  if (modal) modal.style.display = 'none';
  const stage = document.getElementById('media-viewer-stage');
  if (stage) stage.innerHTML = '';   // stops a playing video
  _view = null;
  document.removeEventListener('keydown', _viewerKey);
}

function _viewerKey(e) {
  if (e.target.matches?.('input, textarea')) return;
  if (e.key === 'Escape') closeMediaViewer();
  else if (e.key === 'ArrowRight') stepMediaViewer(1);
  else if (e.key === 'ArrowLeft') stepMediaViewer(-1);
}

export function stepMediaViewer(dir) {
  if (!_view) return;
  const list = mediaOwner(_view.ownerId)?.media || [];
  const i = list.indexOf(_view.mediaId);
  if (i < 0 || list.length < 2) return;
  _view.mediaId = list[(i + dir + list.length) % list.length];
  renderMediaViewer();
}

export async function renderMediaViewer() {
  if (!_view) return;
  const m = state.media.get(_view.mediaId);
  const owner = mediaOwner(_view.ownerId);
  const stage = document.getElementById('media-viewer-stage');
  const side = document.getElementById('media-viewer-side');
  if (!m || !owner || !stage || !side) { closeMediaViewer(); return; }

  const kind = mediaKind(m);
  const url = await mediaUrl(m);
  const title = _esc(mediaLabel(m));
  if (!url) {
    stage.innerHTML = `<div class="media-missing-note">${_esc(t('media.missing', { file: m.file }))}</div>`;
  } else if (kind === 'image') {
    stage.innerHTML = `<img src="${_esc(url)}" alt="${title}">`;
  } else if (kind === 'video') {
    stage.innerHTML = `<video src="${_esc(url)}" controls preload="metadata"></video>`;
  } else if (kind === 'audio') {
    stage.innerHTML = `<audio src="${_esc(url)}" controls preload="metadata"></audio>`;
  } else if (GEDCOMModule.mediaFormOf(m.file) === 'pdf' || m.form === 'pdf') {
    stage.innerHTML = `<iframe src="${_esc(url)}" title="${title}"></iframe>`;
  } else {
    stage.innerHTML = `<a class="media-open-link" href="${_esc(url)}" target="_blank" rel="noopener">${_ICON[kind] || _ICON.other} ${_esc(t('media.openFile'))}</a>`;
  }

  const list = owner.media || [];
  const isPortrait = portraitOf(owner)?.id === m.id;
  const others = _ownersOf(m.id).filter(o => o.id !== owner.id).length;
  side.innerHTML = `
    <label class="edit-label" for="media-title-input">${_esc(t('media.caption'))}</label>
    <input class="edit-input" id="media-title-input" value="${_esc(m.title || '')}" placeholder="${_esc(baseName(m.file))}"
           onchange="setMediaTitle(this.value)">
    <div class="media-file" title="${_esc(m.file)}">${_esc(m.file)}</div>
    ${others ? `<div class="media-note">${_esc(t('media.sharedWith', { n: others }))}</div>` : ''}
    <div class="media-side-btns">
      ${kind === 'image' && !isPortrait ? `<button class="sidebar-btn" onclick="setMediaPortrait()">★ ${_esc(t('media.makePortrait'))}</button>` : ''}
      ${url ? `<a class="sidebar-btn" href="${_esc(url)}" download="${_esc(baseName(m.file))}" target="_blank" rel="noopener">⬇ ${_esc(t('media.download'))}</a>` : ''}
      ${isExternal(m.file) ? '' : `<button class="sidebar-btn" onclick="replaceMediaFile()">📂 ${_esc(url ? t('media.replace') : t('media.locate'))}</button>`}
      <button class="sidebar-btn media-danger" onclick="removeMediaFromOwner()">🗑 ${_esc(t('media.remove'))}</button>
    </div>
    ${list.length > 1 ? `<div class="media-nav">
      <button class="sidebar-btn" onclick="stepMediaViewer(-1)" aria-label="${_esc(t('media.prev'))}">←</button>
      <span>${list.indexOf(m.id) + 1} / ${list.length}</span>
      <button class="sidebar-btn" onclick="stepMediaViewer(1)" aria-label="${_esc(t('media.next'))}">→</button>
    </div>` : ''}`;
}

function _ownersOf(mediaId) {
  const out = [];
  for (const i of state.individuals.values()) if (i.media?.includes(mediaId)) out.push(i);
  for (const f of state.families.values()) if (f.media?.includes(mediaId)) out.push(f);
  return out;
}

// ── Hooks the rest of the app supplies ────────────────────────────────────
//
// Marking the tree dirty and re-drawing the panel live in gedcom-io.js and
// panels.js, which both import this module; taking them as callbacks keeps
// this file free of that cycle.

let _changed = () => {};
export function onMediaChanged(fn) { _changed = fn; }
let _before = () => {};
/** Called just before the tree's media records or links are changed (undo). */
export function onBeforeMediaChange(fn) { _before = fn; }

export function setMediaTitle(value) {
  const m = _view && state.media.get(_view.mediaId);
  if (!m) return;
  _before();
  m.title = String(value || '').trim();
  _changed(_view.ownerId);
}

export function setMediaPortrait() {
  if (!_view) return;
  _before();
  setPrimaryMedia(_view.ownerId, _view.mediaId);
  _changed(_view.ownerId);
  renderMediaViewer();
}

export function removeMediaFromOwner() {
  if (!_view) return;
  const { ownerId, mediaId } = _view;
  if (!confirm(t('media.removeConfirm'))) return;
  _before();
  unlinkMedia(ownerId, mediaId);
  closeMediaViewer();
  _changed(ownerId);
}

function _pick({ multiple = true, directory = false, accept = '' } = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    if (directory) input.webkitdirectory = true;
    input.style.display = 'none';
    input.onchange = () => { resolve([...(input.files || [])]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

export async function replaceMediaFile() {
  const m = _view && state.media.get(_view.mediaId);
  if (!m || isExternal(m.file)) return;
  const [file] = await _pick({ multiple: false });
  if (!file) return;
  await putMediaFile(m.file, file);
  _changed(_view.ownerId);
  renderMediaViewer();
}

export async function pickMediaFor(ownerId) {
  const files = await _pick({ accept: 'image/*,video/*,audio/*,application/pdf,.pdf,.txt,.doc,.docx,.odt' });
  if (!files.length) return;
  _before();
  await addMediaFiles(ownerId, files);
  _changed(ownerId);
}

export function addMediaLinkFor(ownerId) {
  const url = prompt(t('media.urlPrompt'), 'https://');
  if (!url || !/^https?:\/\/./i.test(url.trim())) return;
  _before();
  if (!addMediaUrl(ownerId, url)) return;
  _changed(ownerId);
}

/** Files dropped on the detail panel attach to whoever it is showing. */
export async function dropMediaOn(ownerId, files) {
  const list = [...files].filter(f => f.size);
  if (!list.length || !mediaEnabled()) return false;
  _before();
  await addMediaFiles(ownerId, list);
  _changed(ownerId);
  return true;
}

/** "Locate media files…": point at the folder the tree's pictures live in. */
export async function linkMediaFolder() {
  const files = await _pick({ directory: true });
  if (!files.length) return null;
  return attachCandidates(candidatesFromFiles(files));
}

/** How many of the tree's media records have their file in this browser. */
export async function mediaAvailability() {
  let local = 0, present = 0, external = 0;
  for (const m of state.media.values()) {
    if (isExternal(m.file)) { external++; continue; }
    local++;
    if (await getMediaFile(m.file)) present++;
  }
  return { total: state.media.size, local, present, external };
}
