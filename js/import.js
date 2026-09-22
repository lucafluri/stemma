/**
 * The import dialog: picking a file or image, running OCR over it, and the
 * review screen — the diff table, the filter chips, the per-row link editing
 * and the apply.
 *
 * What an import *means* lives in import-parse.js; this is what it looks like.
 * That module is re-exported below so the window bulk-assign in main.js, and
 * callers that still reach for `import.js`, keep seeing one surface.
 */
import { state } from './state.js';
import { _fullRebuildGraph, _loadDatasetFile, escHtml, escJs, fileAccessSupported } from './gedcom-io.js';
import { readMediaArchive } from './media.js';
import {
  _tiApplyActions, _tiCleanText, _tiConnectivity, _tiGenerateActions,
  _tiParseGedcomForMerge, _tiParseStructuredJson, _tiParseText,
} from './import-parse.js';

export * from './import-parse.js';

export const _IMAGE_MIME = /^image\/(jpeg|png|gif|webp)$/;

export function openImport() {
  document.getElementById('import-modal').style.display = 'flex';
  _resetImportUI();
  document.addEventListener('paste', _importPasteHandler);
}

export function closeTextImport() {
  document.removeEventListener('paste', _importPasteHandler);
  clearTimeout(state._importConnTimer);
  document.getElementById('import-modal').style.display = 'none';
  state._importActions = [];
  state._importConn = new Map();
  state._importConnStrict = new Map();
  state._importExpanded = new Set();
  state._importFilter = 'all';
  state._importLoadedFile = null;
  state._importFileHandle = null;
  state._importImageData = null;
}

export function _resetImportUI() {
  document.getElementById('import-step-input').style.display = '';
  document.getElementById('import-step-review').style.display = 'none';
  const overlay = document.getElementById('import-progress-overlay');
  if (overlay) overlay.style.display = 'none';
  const label = document.getElementById('import-progress-label');
  if (label) label.textContent = '';
  document.getElementById('import-text-area').value = '';
  const fi = document.getElementById('import-file-input');
  if (fi) { fi.value = ''; }
  document.getElementById('import-drop-label').style.display = '';
  document.getElementById('import-drop-filename').style.display = 'none';
  document.getElementById('import-image-preview').style.display = 'none';
  document.getElementById('import-image-options').style.display = 'none';
  document.getElementById('import-error-msg').style.display = 'none';
  document.getElementById('import-replace-btn').style.display = 'none';
  document.getElementById('import-ocr-status').textContent = '';
  state._importActions = [];
  state._importConn = new Map();
  state._importConnStrict = new Map();
  state._importExpanded = new Set();
  state._importFilter = 'all';
  state._importJsonPersons = null;
  state._importLoadedFile = null;
  state._importFileHandle = null;
  state._importImageData = null;
}

export function _imShowError(msg) {
  const el = document.getElementById('import-error-msg');
  el.textContent = msg; el.style.display = '';
}

export function _imDragOver(e) { e.preventDefault(); document.getElementById('import-drop-zone').classList.add('drag-over'); }

export function _imDragLeave(e) { document.getElementById('import-drop-zone').classList.remove('drag-over'); }

// Opening the file chooser. Through showOpenFilePicker where it exists, because
// that is the only way of choosing a file that also yields a handle to it — the
// hidden <input type="file"> hands back a detached copy, which is enough to read
// but leaves nothing to reopen or save back to. Falls back to the input
// elsewhere, where reading is all that is on offer anyway.
export async function _imPickFile() {
  if (!fileAccessSupported()) { document.getElementById('import-file-input').click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'GEDCOM / JSON / YAML / text / image',
        accept: { '*/*': ['.ged', '.json', '.yaml', '.yml', '.txt', '.text', '.png', '.jpg', '.jpeg', '.gif', '.webp'] },
      }],
    });
    if (handle) _imLoadFile(await handle.getFile(), handle);
  } catch (err) {
    if (err.name !== 'AbortError') document.getElementById('import-file-input').click();
  }
}

export async function _imDrop(e) {
  e.preventDefault();
  document.getElementById('import-drop-zone').classList.remove('drag-over');
  // A dropped item can yield a handle too, so a file dragged in is as reopenable
  // as one picked from the dialog. Read the item before any await: the
  // DataTransfer is emptied as soon as the event handler yields.
  const item = e.dataTransfer.items?.[0];
  const file = e.dataTransfer.files?.[0];
  let handle = null;
  if (item?.getAsFileSystemHandle) {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h?.kind === 'file') handle = h;
    } catch { /* not a real file, or the browser said no — the File still works */ }
  }
  if (handle) _imLoadFile(await handle.getFile(), handle);
  else if (file) _imLoadFile(file);
}

export function _importPasteHandler(e) {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) _imLoadFile(file);
}

export function handleImportFileSelect(e) {
  const file = e.target.files[0];
  if (file) _imLoadFile(file);
}

export function _imLoadFile(file, handle = null) {
  state._importJsonPersons = null;
  state._importLoadedFile = file;
  // Carried alongside the file so the wizard's "replace" button, which loads it
  // later, can pass it on too — the handle is what makes the file reopenable and
  // saveable, and it must not be dropped just because the load went via a
  // review step.
  state._importFileHandle = handle;
  state._importImageData = null;
  document.getElementById('import-error-msg').style.display = 'none';
  document.getElementById('import-drop-label').style.display = 'none';
  const fn = document.getElementById('import-drop-filename');
  fn.textContent = '📄 ' + file.name;
  fn.style.display = '';
  document.getElementById('import-image-preview').style.display = 'none';
  document.getElementById('import-image-options').style.display = 'none';
  document.getElementById('import-replace-btn').style.display = 'none';
  document.getElementById('import-text-area').value = '';

  const name = file.name.toLowerCase();
  const isGed   = /\.ged$/.test(name);
  const isJson  = /\.json$/.test(name);
  const isYaml  = /\.ya?ml$/.test(name);
  const isArchive = /\.(zip|gdz)$/.test(name);
  const isImage = _IMAGE_MIME.test(file.type) || /\.(png|jpe?g|gif|webp)$/.test(name);

  // First import on empty dataset: load directly, skip the review wizard.
  if ((isGed || isJson || isYaml || isArchive) && state.individuals.size === 0) {
    closeTextImport();
    _loadDatasetFile(file, handle);
    return;
  }

  if (isImage) {
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      state._importImageData = { base64: dataUrl.split(',')[1], mediaType: file.type || 'image/png' };
      const prev = document.getElementById('import-image-preview');
      prev.src = dataUrl;
      prev.style.display = 'block';
      document.getElementById('import-image-options').style.display = 'flex';
    };
    reader.readAsDataURL(file);
    return;
  }

  if (isGed || isJson || isYaml || isArchive) {
    document.getElementById('import-replace-btn').style.display = '';
  }

  // A GEDCOM to merge, read with the same encoding detection as a full load —
  // an ANSEL or windows-1252 file read as UTF-8 merges names full of U+FFFD.
  const mergeGedcom = text => {
    const persons = _tiParseGedcomForMerge(text || '');
    if (persons?.length) {
      state._importJsonPersons = persons;
      document.getElementById('import-text-area').value =
        t('import.gedcomLoaded', { n: persons.length, plural: persons.length !== 1 ? 'en' : '' });
    } else {
      _imShowError(t('import.parseError'));
    }
  };

  const reader = new FileReader();
  if (isGed) {
    file.arrayBuffer().then(buf => mergeGedcom(GEDCOMModule.decodeGedcom(buf)))
      .catch(err => _imShowError(t('errors.loadError', { msg: err.message })));
  } else if (isArchive) {
    readMediaArchive(file).then(arc => mergeGedcom(arc.text))
      .catch(err => _imShowError(t('errors.loadError', { msg: err.message })));
  } else if (isJson) {
    reader.onload = ev => {
      try {
        const obj = JSON.parse(ev.target.result || '{}');
        const persons = _tiParseStructuredJson(obj);
        if (persons && persons.length) {
          state._importJsonPersons = persons;
          document.getElementById('import-text-area').value =
            t('import.jsonLoaded', { n: persons.length, plural: persons.length !== 1 ? 'en' : '' });
        } else {
          document.getElementById('import-text-area').value =
            t('import.jsonFallback');
        }
      } catch(err) {
        _imShowError(t('import.invalidJson', { msg: err.message }));
      }
    };
    reader.readAsText(file, 'utf-8');
  } else if (isYaml) {
    reader.onload = ev => {
      document.getElementById('import-text-area').value =
        t('import.yamlLoaded');
    };
    reader.readAsText(file, 'utf-8');
  } else {
    reader.onload = ev => { document.getElementById('import-text-area').value = ev.target.result || ''; };
    reader.readAsText(file, 'utf-8');
  }
}

export function importReplaceDataset() {
  if (!state._importLoadedFile) { _imShowError(t('import.noFileLoaded')); return; }
  if (state.individuals.size && !confirm(t('import.replaceConfirm'))) return;
  // Both read out before closeTextImport(), which clears them.
  const file = state._importLoadedFile;
  const handle = state._importFileHandle;
  closeTextImport();
  _loadDatasetFile(file, handle);
}

// Left on the CDN, unlike the other bundled libraries: Tesseract pulls its own
// worker script, wasm binary and language data files at runtime — vendoring
// just the entry script would not make OCR import work offline, only move
// where one of several remote fetches comes from. It is also loaded on demand
// (OCR import only), not on every page load.
export function _loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (state._tesseractLoading) return state._tesseractLoading;
  state._tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error(t('import.tesseractLoadError')));
    document.head.appendChild(s);
  });
  return state._tesseractLoading;
}

export async function runImportOcr() {
  if (!state._importImageData) { _imShowError(t('import.noImage')); return; }
  const statusEl = document.getElementById('import-ocr-status');
  const btn = document.getElementById('import-ocr-btn');
  btn.disabled = true;
  statusEl.textContent = t('import.ocrLoading');
  try {
    const Tesseract = await _loadTesseract();
    const dataUrl = 'data:' + state._importImageData.mediaType + ';base64,' + state._importImageData.base64;
    statusEl.textContent = t('import.ocrProgress', { pct: 0 });
    const { data } = await Tesseract.recognize(dataUrl, 'deu+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          statusEl.textContent = t('import.ocrProgress', { pct: Math.round(m.progress*100) });
        }
      }
    });
    const text = (data?.text || '').trim();
    if (!text) { _imShowError(t('import.ocrNoText')); statusEl.textContent = ''; return; }
    document.getElementById('import-text-area').value = text;
    statusEl.textContent = t('import.ocrDone', { chars: text.length });
  } catch (err) {
    _imShowError(t('import.ocrError', { msg: err.message || String(err) }));
    statusEl.textContent = '';
  } finally {
    btn.disabled = false;
  }
}

export function parseImportText() {
  let persons;
  if (state._importJsonPersons) {
    persons = state._importJsonPersons;
  } else {
    const raw = (document.getElementById('import-text-area').value || '').trim();
    if (!raw) { alert(t('import.enterText')); return; }
    const clean = _tiCleanText(raw);
    persons = _tiParseText(clean);
    if (!persons.length) {
      alert(t('import.noPersons'));
      return;
    }
  }

  state._importActions = _tiGenerateActions(persons);
  state._importFilter  = 'all';
  state._importExpanded = new Set();

  if (!state._importActions.some(a => a.kind !== 'same')) {
    alert(t('import.allExisting', { n: persons.length }));
    return;
  }

  document.getElementById('import-step-input').style.display = 'none';
  document.getElementById('import-step-review').style.display = '';
  _renderImportReview();
}

/**
 * Where a proposed person stands:
 *   'island'     — nothing in this import ties them to the tree at all
 *   'unapproved' — the card that would tie them on is still sitting unapproved
 *   'ok'         — they will hang off the existing tree
 * Anything but 'ok' is a person who would land detached, and both are fixable —
 * the second just needs a click on another row rather than a link.
 */
export function _imConnState(action) {
  if (action.kind !== 'person' || action.status === 'skipped') return 'ok';
  if (state._importConn.get(action.id) === false) return 'island';
  if (action.status === 'approved' && state._importConnStrict.get(action.id) === false) return 'unapproved';
  return 'ok';
}

export function _imUnconnectedIds() {
  return state._importActions.filter(a => _imConnState(a) !== 'ok').map(a => a.id);
}

// Both maps, recomputed together. The single owner of _importConn* — everything
// that mutates a card goes through _imRepaintAction, which calls this, so a
// change on one row can never leave the warning on another row stale.
export function _imRefreshConn() {
  const before = { loose: state._importConn, strict: state._importConnStrict };
  state._importConn       = _tiConnectivity(state._importActions);
  state._importConnStrict = _tiConnectivity(state._importActions, a => a.status === 'approved');
  return before;
}

export function _renderImportSummary() {
  const nPers    = state._importActions.filter(a => a.kind === 'person').length;
  const nUpd     = state._importActions.filter(a => a.kind === 'update').length;
  const nMarr    = state._importActions.filter(a => a.kind === 'marriage').length;
  const nSame    = state._importActions.filter(a => a.kind === 'same').length;
  const nApp     = state._importActions.filter(a => a.status === 'approved').length;
  const nSkip    = state._importActions.filter(a => a.status === 'skipped').length;
  const nPend    = state._importActions.filter(a => a.status === 'pending').length;
  const nLoose   = _imUnconnectedIds().length;

  const f = state._importFilter;
  const chip = (key, label, cls, n) =>
    `<button class="import-filter-chip${f === key ? ' import-filter-chip--on' : ''}${cls ? ' ' + cls : ''}"
             onclick="_imSetFilter('${key}')">${label} <b>${n}</b></button>`;

  document.getElementById('import-summary').innerHTML = `
    <div class="import-summary-bar">
      <span class="import-stat"><b>${state._importActions.length}</b> ${t('import.summarySuggestions', { total: state._importActions.length })}</span>
      <span class="import-stat import-stat--approved">&#x2713; <b>${nApp}</b> ${t('import.summaryApproved', { n: nApp })}</span>
      <span class="import-stat import-stat--skipped">&#x2715; <b>${nSkip}</b> ${t('import.summarySkipped', { n: nSkip })}</span>
      <span class="import-stat import-stat--pending">&#x23F3; <b>${nPend}</b> ${t('import.summaryPending', { n: nPend })}</span>
      <span class="import-spacer"></span>
      <button class="import-view-btn${state._importView === 'table' ? ' import-view-btn--on' : ''}"
              onclick="_imSetView('table')">&#x1F4CA; ${t('import.viewTable')}</button>
      <button class="import-view-btn${state._importView === 'cards' ? ' import-view-btn--on' : ''}"
              onclick="_imSetView('cards')">&#x1F5C2; ${t('import.viewCards')}</button>
    </div>
    <div class="import-filter-bar">
      ${chip('all',         t('import.filterAll'),      '',                        state._importActions.length)}
      ${chip('new',         t('import.summaryNew', { n: nPers }), 'import-filter-chip--person',   nPers)}
      ${chip('changed',     t('import.filterChanged'),  'import-filter-chip--update',   nUpd)}
      ${chip('marriage',    t('import.filterMarriage'), 'import-filter-chip--marriage', nMarr)}
      ${chip('same',        t('import.filterSame'),     'import-filter-chip--same',     nSame)}
      ${chip('unconnected', '&#x26A0; ' + t('import.filterUnconnected'), 'import-filter-chip--warn', nLoose)}
    </div>
    <div class="import-bulk-actions">
      <button class="import-bulk-btn import-bulk-btn--approve" onclick="_importApproveAll()">&#x2713; ${t('import.approveAll')}</button>
      <button class="import-bulk-btn import-bulk-btn--skip"    onclick="_importSkipAll()">&#x2715; ${t('import.skipAll')}</button>
      <button class="import-bulk-btn import-bulk-btn--reset"   onclick="_importResetAll()">&#x21BA; ${t('import.resetAll')}</button>
      <label class="import-connect-toggle" title="${t('import.requireConnectedTitle')}">
        <input type="checkbox" ${state._importRequireConnected ? 'checked' : ''}
               onchange="_imToggleRequireConnected(this.checked)">
        ${t('import.requireConnected')}
      </label>
    </div>
  `;
}

export function _imSetFilter(key) {
  state._importFilter = (state._importFilter === key && key !== 'all') ? 'all' : key;
  _renderImportReview();
}

export function _imSetView(view) {
  state._importView = view;
  _renderImportReview();
}

export function _imToggleRequireConnected(on) {
  state._importRequireConnected = !!on;
  _renderImportReview();
}

export function _imVisibleActions() {
  const f = state._importFilter;
  const loose = new Set(_imUnconnectedIds());
  return [...state._importActions]
    .filter(a => {
      switch (f) {
        case 'new':         return a.kind === 'person';
        case 'changed':     return a.kind === 'update';
        case 'marriage':    return a.kind === 'marriage';
        case 'same':        return a.kind === 'same';
        case 'unconnected': return loose.has(a.id);
        default:            return true;
      }
    })
    .sort((a, b) => (a._sourceIdx ?? 0) - (b._sourceIdx ?? 0));
}

export function _renderImportReview() {
  _imRefreshConn();
  _renderImportSummary();
  const list = document.getElementById('import-actions-list');
  const visible = _imVisibleActions();

  if (!visible.length) {
    list.innerHTML = `<div class="import-empty-filter">${t('import.noRowsForFilter')}</div>`;
    return;
  }

  if (state._importView === 'cards') {
    list.innerHTML = visible.map(action => _renderImportCard(action)).join('');
    return;
  }

  list.innerHTML = `<table class="import-diff-table">
    <thead><tr>
      <th class="import-dth-exp"></th>
      <th>${t('import.colKind')}</th>
      <th>${t('import.colPerson')}</th>
      <th>${t('import.colDiff')}</th>
      <th>${t('import.colLink')}</th>
      <th class="import-dth-status">${t('import.colStatus')}</th>
    </tr></thead>
    <tbody>${visible.map(a => _imDiffRowHtml(a)).join('')}</tbody>
  </table>`;
}

// ── The diff table ──────────────────────────────────────────────────────────

const _IM_KIND_META = {
  person:   { cls: 'import-badge--person',   key: 'kindAddPerson' },
  update:   { cls: 'import-badge--update',   key: 'kindUpdate' },
  marriage: { cls: 'import-badge--marriage', key: 'kindMarriage' },
  same:     { cls: 'import-badge--same',     key: 'kindSame' },
};

function _imYears(dateA, dateB) {
  const b = (dateA || '').match(/\b(\d{4})\b/)?.[1] || '';
  const d = (dateB || '').match(/\b(\d{4})\b/)?.[1] || '';
  return (b ? `*${b}` : '') + (b && d ? ' ' : '') + (d ? `†${d}` : '');
}

// One field, both answers side by side, the winning one lit. Clicking swaps it.
function _imDiffPair(action, field, existing, incoming) {
  const label = _imFieldLabel(field);
  const use   = action.fieldApply ? !!action.fieldApply[field] : !!incoming;
  const clickable = !!action.fieldApply && !!existing && !!incoming;
  return `<div class="import-dpair${clickable ? ' import-dpair--pick' : ''}"
       ${clickable ? `onclick="_imToggleFieldApply('${action.id}','${escJs(field)}')" title="${t('import.conflictTitle')}"` : ''}>
    <span class="import-dlabel">${escHtml(label)}</span>
    <span class="import-dold${!use ? ' import-dside--on' : ''}">${existing ? escHtml(existing) : '&mdash;'}</span>
    <span class="import-darrow">&#x2192;</span>
    <span class="import-dnew${use ? ' import-dside--on' : ''}">${incoming ? escHtml(incoming) : '&mdash;'}</span>
  </div>`;
}

export function _imDiffCellHtml(action) {
  if (action.kind === 'same') {
    return `<span class="import-dsame">&#x2713; ${t('import.identical')}</span>`;
  }

  if (action.kind === 'marriage') {
    const kids = action._childrenArr ||
      (action.fields['Children'] || '').split(';').map(s => s.trim()).filter(Boolean);
    const bits = [];
    if (action.existingFamId) {
      bits.push(`<div class="import-dnote">${t('import.intoExistingFamily')}</div>`);
    }
    bits.push(`<div class="import-dpair"><span class="import-dlabel">${t('import.marriage')}</span>
      <span class="import-dnew import-dside--on">${escHtml(action.fields['Husband'] || '?')} &amp; ${escHtml(action.fields['Wife'] || '?')}</span></div>`);
    const md = [action.fields['Marriage Date'], action.fields['Marriage Place']].filter(Boolean).join(', ');
    if (md) bits.push(`<div class="import-dpair"><span class="import-dlabel">${t('import.fieldMarriageDate')}</span>
      <span class="import-dnew import-dside--on">${escHtml(md)}</span></div>`);
    if (kids.length) bits.push(`<div class="import-dpair"><span class="import-dlabel">${t('import.fieldChildren')}</span>
      <span class="import-dnew import-dside--on">${escHtml(kids.join(', '))}</span></div>`);
    return bits.join('');
  }

  const indi = action.existingId ? state.individuals.get(action.existingId) : null;
  const rows = [];
  for (const field of _IM_UPDATE_FIELDS) {
    const incoming = (action.fields[field] || '').trim();
    const existing = indi ? _imExistingValue(indi, field).trim() : '';
    if (!incoming && !existing) continue;
    if (incoming === existing) continue;
    rows.push(_imDiffPair(action, field, existing, incoming));
  }
  for (const field of ['Father', 'Mother']) {
    const v = (action.fields[field] || '').trim();
    if (v) rows.push(`<div class="import-dpair"><span class="import-dlabel">${_imFieldLabel(field)}</span>
      <span class="import-dnew import-dside--on">${escHtml(v)}</span></div>`);
  }
  return rows.length ? rows.join('') : `<span class="import-dsame">${t('import.identical')}</span>`;
}

export function _imConnCellHtml(action) {
  if (action.kind !== 'person') return '';
  const st = _imConnState(action);
  if (st === 'ok') return `<span class="import-conn import-conn--ok">&#x2713; ${t('import.connected')}</span>`;

  // The tie exists in this import, it just is not approved yet. Nothing to
  // link — say so, so the reader goes and approves that row instead of
  // hunting for a person to attach this one to.
  if (st === 'unapproved') {
    return `<span class="import-conn import-conn--pending" title="${t('import.connPendingTitle')}">&#x26A0; ${t('import.connPending')}</span>`;
  }

  return `<span class="import-conn import-conn--warn" title="${t('import.unconnectedTitle')}">&#x26A0; ${t('import.unconnected')}</span>
    <button class="import-dbtn import-dbtn--link" onclick="_imAttachToParent('${action.id}')" title="${t('import.attachTitle')}">&#x1F517; ${t('import.attach')}</button>`;
}

export function _imLinkCellHtml(action) {
  if (action.existingId) {
    const indi = state.individuals.get(action.existingId);
    const badge = `<span class="import-dlinked">&#x1F517; ${escHtml(indi?.name || action.existingId)}</span>`;
    // An identical row has nothing to unlink from — breaking the match would
    // only turn a record the tree already holds into a duplicate of itself.
    if (action.kind === 'same') return badge;
    return badge + `<button class="import-dbtn" onclick="_imUnlink('${action.id}')" title="${t('import.unlinkTitle')}">&#x2715;</button>`;
  }
  if (action.existingFamId) return `<span class="import-dlinked">&#x1F517; ${escHtml(action.existingFamId)}</span>`;
  if (action.kind === 'person') {
    return `<span class="import-dnewtag">${t('import.newBadge')}</span>
      <button class="import-dbtn" onclick="openMatchDialog('${action.id}')" title="${t('import.linkTitle')}">&#x1F517;</button>`;
  }
  return '';
}

export function _imDiffRowHtml(action) {
  const meta = _IM_KIND_META[action.kind] || _IM_KIND_META.person;
  const open = state._importExpanded.has(action.id);
  const loose = _imConnState(action) !== 'ok';
  const name  = action.fields['Name'] ||
    [action.fields['Husband'], action.fields['Wife']].filter(Boolean).join(' & ') || t('import.noName');
  const years = _imYears(action.fields['Birth Date'], action.fields['Death Date']);

  const main = `<tr class="import-drow import-drow--${action.status}${loose ? ' import-drow--loose' : ''}"
      data-drow-id="${action.id}">
    <td class="import-dcell-exp">
      <button class="import-dexp" onclick="_imToggleRowDetails('${action.id}')"
              title="${t('import.editRow')}">${open ? '&#x25BE;' : '&#x25B8;'}</button>
    </td>
    <td><span class="import-badge ${meta.cls}">${t('import.' + meta.key)}</span></td>
    <td class="import-dcell-name">
      <div class="import-dname">${escHtml(name)}</div>
      ${years ? `<div class="import-dyears">${years}</div>` : ''}
      ${_imConnCellHtml(action)}
    </td>
    <td class="import-dcell-diff">${_imDiffCellHtml(action)}</td>
    <td class="import-dcell-link">${_imLinkCellHtml(action)}</td>
    <td class="import-dcell-status">${action.kind === 'same' ? '<span class="import-dsame">&mdash;</span>' : `
      <button class="import-dstatus import-dstatus--approve${action.status === 'approved' ? ' import-btn--active' : ''}"
              data-action="${action.id}" data-status="approved" title="${t('import.approve')}">&#x2713;</button>
      <button class="import-dstatus import-dstatus--skip${action.status === 'skipped' ? ' import-btn--active' : ''}"
              data-action="${action.id}" data-status="skipped" title="${t('import.skip')}">&#x2715;</button>`}
    </td>
  </tr>`;

  if (!open) return main;
  return main + `<tr class="import-drow-details" data-details-for="${action.id}">
    <td colspan="6">${_renderImportCard(action)}</td>
  </tr>`;
}

export function _imToggleRowDetails(actionId) {
  if (state._importExpanded.has(actionId)) state._importExpanded.delete(actionId);
  else state._importExpanded.add(actionId);
  _imRepaintAction(actionId);
}

// Whichever view is on screen, put this one action back on it. Both views can be
// live at once — an expanded row holds a full card — so repaint both.
function _imPaintOne(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  const row = document.querySelector(`tr[data-drow-id="${actionId}"]`);
  if (row) {
    const det = document.querySelector(`tr[data-details-for="${actionId}"]`);
    if (det) det.remove();
    row.outerHTML = _imDiffRowHtml(action);
    return;
  }
  const card = document.querySelector(`.import-action-card[data-action-id="${actionId}"]`);
  if (card) card.outerHTML = _renderImportCard(action);
}

/**
 * Repaint one card and everything its change moved.
 *
 * Approving the marriage card that adopts a child is a change *to that card*
 * which unmarks the child's card — and the child may be anywhere in the list.
 * So every edit recomputes connectivity and repaints whichever other rows the
 * verdict actually moved, rather than only the row that was touched.
 */
export function _imRepaintAction(actionId) {
  const before = _imRefreshConn();
  _imPaintOne(actionId);
  for (const [aid] of state._importConn) {
    if (aid === actionId) continue;
    if (before.loose.get(aid)  !== state._importConn.get(aid) ||
        before.strict.get(aid) !== state._importConnStrict.get(aid)) _imPaintOne(aid);
  }
  _renderImportSummary();
}

export const _IM_PERSON_FIELDS = new Set(['Name','Father','Mother','Husband','Wife']);

export function _imFieldLabel(label) {
  const key = 'import.field' + label.replace(/\s+/g, '');
  const tr = t(key);
  return tr === key ? label : tr;
}

export function _imDropId(actionId, fieldKey) {
  return 'nacd-' + actionId + '-' + fieldKey.replace(/[\s:]/g, '_');
}

export function _imLinkedDisplay(link) {
  if (!link) return null;
  if (link.type === 'existing') {
    const indi = state.individuals.get(link.id);
    if (!indi) return null;
    return {
      name:      indi.name || '',
      maiden:    indi.maidenName || '',
      year:      indi.birth?.date?.match(/\b(\d{4})\b/)?.[1] || '',
      deathYear: indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || '',
      tag:       '',
    };
  }
  const pa = state._importActions.find(a => a.id === link.id);
  if (!pa) return null;
  return {
    name:      pa.fields['Name'] || '',
    maiden:    '',
    year:      (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || '',
    deathYear: (pa.fields['Death Date']||'').match(/\b(\d{4})\b/)?.[1] || '',
    tag:       t('import.badgeImport'),
  };
}

export function _imLinkedTooltipHtml(link) {
  if (!link) return '';
  if (link.type === 'existing') {
    const indi = state.individuals.get(link.id);
    if (!indi) return '';
    const rows = [];
    rows.push(`<div class="import-tt-name">${escHtml(indi.name || t('import.noName'))}</div>`);
    const sub = [];
    if (indi.maidenName) sub.push(`${t('tooltip.born', { name: indi.maidenName })}`);
    if (indi.sex) sub.push(indi.sex);
    if (sub.length) rows.push(`<div class="import-tt-sub">${sub.join(' · ')}</div>`);
    if (indi.birth?.date || indi.birth?.plac)
      rows.push(`<div class="import-tt-line"><b>${t('import.tooltipBorn')}</b>${escHtml(indi.birth?.date || '?')}${indi.birth?.plac ? t('import.tooltipIn') + escHtml(indi.birth.plac) : ''}</div>`);
    if (indi.death?.date || indi.death?.plac)
      rows.push(`<div class="import-tt-line"><b>${t('import.tooltipDied')}</b>${escHtml(indi.death?.date || '?')}${indi.death?.plac ? t('import.tooltipIn') + escHtml(indi.death.plac) : ''}</div>`);
    // Parents
    const famc = (indi.famc || [])[0];
    if (famc) {
      const fam = state.families.get(famc);
      if (fam) {
        const fa = fam.husb ? state.individuals.get(fam.husb)?.name : '';
        const mo = fam.wife ? state.individuals.get(fam.wife)?.name : '';
        if (fa || mo) rows.push(`<div class="import-tt-line">${t('import.parents')}: ${escHtml([fa, mo].filter(Boolean).join(' & '))}</div>`);
      }
    }
    // Spouses
    const spouseNames = (indi.fams || []).map(fId => {
      const f = state.families.get(fId); if (!f) return null;
      const sId = f.husb === link.id ? f.wife : f.husb;
      return sId ? state.individuals.get(sId)?.name : null;
    }).filter(Boolean);
    if (spouseNames.length) rows.push(`<div class="import-tt-line">${t('import.marriage')}: ${escHtml(spouseNames.join(', '))}</div>`);
    // Children
    const children = [];
    for (const fId of (indi.fams || [])) {
      const f = state.families.get(fId); if (!f) continue;
      for (const cId of (f.chil || [])) {
        const c = state.individuals.get(cId);
        if (c) children.push(c.name);
      }
    }
    if (children.length) rows.push(`<div class="import-tt-line">${t('import.children')}: ${escHtml(children.join(', '))}</div>`);
    if (indi.note) rows.push(`<div class="import-tt-note">${escHtml(indi.note.slice(0, 220))}${indi.note.length > 220 ? '…' : ''}</div>`);
    rows.push(`<div class="import-tt-id">${t('import.id')}: ${escHtml(link.id)}</div>`);
    return rows.join('');
  }
  // Pending (another import action)
  const pa = state._importActions.find(a => a.id === link.id);
  if (!pa) return '';
  const rows = [];
  rows.push(`<div class="import-tt-name">${escHtml(pa.fields['Name'] || t('import.noName'))}</div>`);
  rows.push(`<div class="import-tt-sub">${t('import.fromImport')}</div>`);
  for (const [k, v] of Object.entries(pa.fields)) {
    if (k === 'Name' || !v) continue;
    rows.push(`<div class="import-tt-line"><b>${escHtml(_imFieldLabel(k))}:</b> ${escHtml(String(v).slice(0, 200))}</div>`);
  }
  return rows.join('');
}

export function _imLinkedBadge(actionId, fieldKey, link, label) {
  const d = _imLinkedDisplay(link);
  if (!d) return '';
  const maiden    = d.maiden    ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: d.maiden })}</span>` : '';
  const year      = d.year      ? ` <span class="import-linked-year">*${d.year}</span>` : '';
  const deathYear = d.deathYear ? ` <span class="import-linked-year">&#x2020;${d.deathYear}</span>` : '';
  const tag       = d.tag       ? ` <span class="import-linked-tag">${escHtml(d.tag)}</span>` : '';
  const tipHtml   = _imLinkedTooltipHtml(link);
  return `<div class="import-field-row">
    <label class="import-field-label">${escHtml(label)}</label>
    <div class="import-field-linked" tabindex="0">
      <span class="import-field-linked-name">${escHtml(d.name)}</span>${maiden}${year}${deathYear}${tag}
      <button class="import-field-change-btn" onclick="_imChangeFieldLink('${actionId}','${fieldKey}')" title="${t('import.changeFieldLink')}">&#x21BB;</button>
      <button class="import-field-unlink-btn" onclick="_imFieldUnlink('${actionId}','${fieldKey}')" title="${t('import.unlinkTitle')}">&#x2715;</button>
      <div class="import-linked-tip">${tipHtml}</div>
    </div>
  </div>`;
}

export function _imConflictRow(action, field, displayLabel, incoming, existing) {
  const useImported = !!action.fieldApply[field];
  const pick = (active, value, tag) => `
    <div class="import-conflict-side${active ? ' import-conflict-side--on' : ''}">
      <span class="import-conflict-tag">${tag}</span>
      <span class="import-conflict-val">${escHtml(value)}</span>
    </div>`;
  return `<div class="import-field-row import-field-row--conflict">
    <label class="import-field-label">${escHtml(displayLabel)}</label>
    <div class="import-conflict" role="group"
         onclick="_imToggleFieldApply('${action.id}','${escJs(field)}')"
         title="${t('import.conflictTitle')}">
      ${pick(!useImported, existing, t('import.inTree'))}
      ${pick(useImported, incoming, t('import.fromImport'))}
    </div>
  </div>`;
}

export function _imPersonInputRow(action, label, fieldKey, val) {
  const fid = 'if-' + action.id + '-' + fieldKey.replace(/[\s:]/g,'_');
  const dropId = _imDropId(action.id, fieldKey);
  return `<div class="import-field-row">
    <label class="import-field-label" for="${fid}">${escHtml(label)}</label>
    <div class="import-name-ac-wrap">
      <input class="import-field-input" id="${fid}" type="text"
             value="${escHtml(val||'')}"
             data-action="${action.id}" data-field="${fieldKey}"
             data-ac-person="true"
             placeholder="${t('import.emptyPlaceholder')}" autocomplete="off">
      <div class="import-name-drop" id="${dropId}"></div>
    </div>
  </div>`;
}

export function _imChildrenRows(action) {
  // Sync _childrenArr from fields on first render
  if (!action._childrenArr) {
    const raw = action.fields['Children'] || '';
    action._childrenArr = raw ? raw.split(';').map(s => s.trim()).filter(Boolean) : [];
  }
  action.fieldLinks = action.fieldLinks || {};

  const rows = action._childrenArr.map((name, idx) => {
    const key  = `Children:${idx}`;
    const link = action.fieldLinks[key];
    if (link) return _imLinkedBadge(action.id, key, link, idx === 0 ? t('import.fieldChildren') : '');
    const dropId = _imDropId(action.id, key);
    const fid    = 'if-' + action.id + '-Children_' + idx;
    const lbl    = idx === 0 ? t('import.fieldChildren') : '';
    return `<div class="import-field-row import-child-row">
      <label class="import-field-label">${escHtml(lbl)}</label>
      <div class="import-name-ac-wrap" style="flex:1">
        <input class="import-field-input" id="${fid}" type="text"
               value="${escHtml(name)}"
               data-action="${action.id}" data-field="${key}"
               data-ac-person="true"
               placeholder="${t('import.childPlaceholder')}" autocomplete="off">
        <div class="import-name-drop" id="${dropId}"></div>
      </div>
      <button class="import-child-rm-btn" onclick="_imRemoveChild('${action.id}',${idx})">&#x2715;</button>
    </div>`;
  }).join('');

  const addBtn = `<div class="import-field-row import-child-row">
    <label class="import-field-label"></label>
    <button class="import-child-add-btn" onclick="_imAddChild('${action.id}')">+ ${t('import.childPlaceholder')}</button>
  </div>`;

  return rows + addBtn;
}

export function _renderImportCard(action) {
  const meta      = _IM_KIND_META[action.kind] || _IM_KIND_META.person;
  const kindLabel = t('import.' + meta.key);
  const kindClass = meta.cls;

  // Nothing to decide on a record that already matches — just show what the
  // tree holds, so the reader can confirm it really is the same person.
  if (action.kind === 'same') {
    return `<div class="import-action-card import-action-card--skipped" data-action-id="${action.id}">
      <div class="import-card-header">
        <span class="import-badge ${kindClass}">${kindLabel}</span>
        <span class="import-status import-status--skipped">${t('import.identical')}</span>
      </div>
      <div class="import-same-body">${_imLinkedTooltipHtml({ type:'existing', id: action.existingId })}</div>
    </div>`;
  }
  const stCls = { pending:'import-status--pending', approved:'import-status--approved', skipped:'import-status--skipped' }[action.status];
  const stLbl = { pending:`&#x23F3; ${t('import.statusPending')}`, approved:`&#x2713; ${t('import.statusApproved')}`, skipped:`&#x2715; ${t('import.statusSkipped')}` }[action.status];

  action.fieldLinks = action.fieldLinks || {};
  const isPersonAction = action.kind === 'person' || action.kind === 'update';

  const fieldsHtml = Object.entries(action.fields).map(([label, val]) => {
    const displayLabel = _imFieldLabel(label);
    const isPersonField = _IM_PERSON_FIELDS.has(label);
    const link = action.fieldLinks[label];

    // Children: special multi-row list
    if (label === 'Children') return _imChildrenRows(action);

    // Person field that is linked → show badge
    if (isPersonField && link) return _imLinkedBadge(action.id, label, link, displayLabel);

    // Name field when whole action is linked to existing person → show badge with unlink
    if (label === 'Name' && isPersonAction && action.existingId) {
      const linkObj = { type: 'existing', id: action.existingId };
      const d = _imLinkedDisplay(linkObj);
      const name   = d ? d.name   : val;
      const maiden    = d?.maiden    ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: d.maiden })}</span>` : '';
      const year      = d?.year      ? ` <span class="import-linked-year">*${d.year}</span>` : '';
      const deathYear = d?.deathYear ? ` <span class="import-linked-year">&#x2020;${d.deathYear}</span>` : '';
      const tipHtml = _imLinkedTooltipHtml(linkObj);
      return `<div class="import-field-row">
        <label class="import-field-label">${displayLabel}</label>
        <div class="import-field-linked" tabindex="0">
          <span class="import-field-linked-name">${escHtml(name)}</span>${maiden}${year}${deathYear}
          <button class="import-btn-change" onclick="_imChangeMainLink('${action.id}')" title="${t('import.changeLinkTitle')}">&#x21BB; ${t('import.changeLink')}</button>
          <button class="import-btn-unlink" onclick="_imUnlink('${action.id}')" title="${t('import.unlinkTitle')}">&#x2715; ${t('import.unlink')}</button>
          <div class="import-linked-tip">${tipHtml}</div>
        </div>
      </div>`;
    }

    // Person field with autocomplete input
    if (isPersonField) return _imPersonInputRow(action, displayLabel, label, val);

    // On a linked card, a field the tree already answers is a decision, not an
    // input: show both answers and let the reader pick. Silently dropping the
    // imported value — which is what this did — hides the disagreement and the
    // choice along with it.
    if (action.existingId && action.fieldApply && _IM_UPDATE_FIELDS.includes(label)) {
      const indi = state.individuals.get(action.existingId);
      const existing = indi ? _imExistingValue(indi, label).trim() : '';
      const incoming = (val || '').trim();
      if (existing && incoming && existing !== incoming) {
        return _imConflictRow(action, label, displayLabel, incoming, existing);
      }
      if (existing && !incoming) {
        return `<div class="import-field-row">
          <label class="import-field-label">${escHtml(displayLabel)}</label>
          <div class="import-field-kept">${escHtml(existing)}
            <span class="import-field-kept-tag">${t('import.inTree')}</span></div>
        </div>`;
      }
    }

    // Regular non-person field
    const wideClass = ''; // children handled above
    const fid = `if-${action.id}-${label.replace(/\s+/g,'_')}`;
    return `<div class="import-field-row${wideClass}">
      <label class="import-field-label" for="${fid}">${escHtml(displayLabel)}</label>
      <input class="import-field-input" id="${fid}" type="text"
             value="${escHtml(val||'')}"
             data-action="${action.id}" data-field="${label}"
             placeholder="${t('import.emptyPlaceholder')}">
    </div>`;
  }).join('');

  const srcHtml = action.source ? `
    <details class="import-source-details">
      <summary>${t('import.sourceText')}</summary>
      <div class="import-source-text">${escHtml(action.source)}</div>
    </details>` : '';

  const appActive = action.status === 'approved' ? ' import-btn--active' : '';
  const skpActive = action.status === 'skipped'  ? ' import-btn--active' : '';

  // Manual-link button for new-person cards not yet linked to anyone
  const showLinkBtn = isPersonAction && !action.existingId;
  const linkBtnHtml = showLinkBtn
    ? `<button class="import-btn import-btn--link" onclick="openMatchDialog('${action.id}')" title="${t('import.linkTitle')}">&#x1F517; ${t('import.link')}</button>`
    : '';

  return `<div class="import-action-card import-action-card--${action.status}" data-action-id="${action.id}">
    <div class="import-card-header">
      <span class="import-badge ${kindClass}">${kindLabel}</span>
      <span class="import-status ${stCls}">${stLbl}</span>
    </div>
    <div class="import-fields">${fieldsHtml}</div>
    ${srcHtml}
    <div class="import-card-actions">
      ${linkBtnHtml}
      <button class="import-btn import-btn--approve${appActive}" data-action="${action.id}" data-status="approved">&#x2713; ${t('import.approve')}</button>
      <button class="import-btn import-btn--skip${skpActive}"    data-action="${action.id}" data-status="skipped">&#x2715; ${t('import.skip')}</button>
    </div>
  </div>`;
}

export function _imChangeFieldLink(actionId, fieldKey) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};
  const link = action.fieldLinks[fieldKey];
  const prevName = _imLinkedDisplay(link)?.name || '';
  delete action.fieldLinks[fieldKey];
  if (fieldKey.startsWith('Children:')) {
    const idx = parseInt(fieldKey.split(':')[1]);
    if (action._childrenArr) action._childrenArr[idx] = prevName;
    action.fields['Children'] = (action._childrenArr || []).join('; ');
  } else if (_IM_PERSON_FIELDS.has(fieldKey)) {
    action.fields[fieldKey] = prevName;
  }
  _imRepaintAction(actionId);
  // Focus the new input so autocomplete drop opens
  setTimeout(() => {
    const safe = fieldKey.replace(/[\s:]/g,'_').replace('Children:', 'Children_');
    const inp = document.getElementById('if-' + actionId + '-' + safe);
    if (inp) { inp.focus(); inp.select(); }
  }, 0);
}

export function _imChangeMainLink(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  _imUnlink(actionId);
  openMatchDialog(actionId);
}

document.addEventListener('DOMContentLoaded', () => {
  const list = document.getElementById('import-actions-list');
  if (!list) return;

  // Button clicks (approve / skip)
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    const id = btn.dataset.action;
    const wantedStatus = btn.dataset.status;
    const action = state._importActions.find(a => a.id === id);
    if (!action) return;
    action.status = (action.status === wantedStatus) ? 'pending' : wantedStatus;

    // While the reader is working through the strays, approving one changes who
    // is still on the list — so that view has to be rebuilt, not patched.
    if (state._importFilter === 'unconnected') _renderImportReview();
    else _imRepaintAction(id);
  });

  // Field edits (delegated input)
  list.addEventListener('input', e => {
    const inp = e.target.closest('[data-action][data-field]');
    if (!inp) return;
    const action = state._importActions.find(a => a.id === inp.dataset.action);
    if (!action) return;
    const field = inp.dataset.field;
    if (field.startsWith('Children:')) {
      // Update individual child in array and rebuild field string
      action._childrenArr = action._childrenArr || [];
      const idx = parseInt(field.split(':')[1]);
      action._childrenArr[idx] = inp.value;
      action.fields['Children'] = action._childrenArr.join('; ');
    } else {
      action.fields[field] = inp.value;
    }
    if (inp.dataset.acPerson) _imPersonSearch(inp, action.id, field);

    // Typing a name is how a card gets tied to somebody — a spouse, a child —
    // so the warnings have to follow the typing. Debounced: recomputing the
    // whole component map per keystroke is not worth it, and nobody reads a
    // badge mid-word anyway.
    clearTimeout(state._importConnTimer);
    state._importConnTimer = setTimeout(() => {
      const before = _imRefreshConn();
      // Never repaint out from under the cursor — that would eat the rest of
      // the word being typed.
      const typing = document.activeElement?.dataset?.action;
      for (const [aid] of state._importConn) {
        if (aid === typing) continue;
        if (before.loose.get(aid)  !== state._importConn.get(aid) ||
            before.strict.get(aid) !== state._importConnStrict.get(aid)) _imPaintOne(aid);
      }
      _renderImportSummary();
    }, 350);
  });

  // Person-field autocomplete: show on focus, hide on blur
  list.addEventListener('focusin', e => {
    const inp = e.target.closest('[data-ac-person]');
    if (inp) _imPersonSearch(inp, inp.dataset.action, inp.dataset.field);
  });
  list.addEventListener('focusout', e => {
    const inp = e.target.closest('[data-ac-person]');
    if (inp) setTimeout(() => { const d = document.getElementById(_imDropId(inp.dataset.action, inp.dataset.field)); if (d) { d.innerHTML = ''; d.style.display = 'none'; } }, 180);
  });
});

// Bulk actions work on what the filter is showing, so "approve all" after
// narrowing to one kind means that kind. Identical rows are never touched —
// there is nothing to approve or skip about a record that already matches.
function _imBulk(status) {
  for (const a of _imVisibleActions()) { if (a.kind !== 'same') a.status = status; }
  _renderImportReview();
}

export function _importApproveAll() { _imBulk('approved'); }

export function _importSkipAll()    { _imBulk('skipped'); }

export function _importResetAll()   { _imBulk('pending'); }

export function backToInputImport() {
  document.getElementById('import-step-input').style.display = '';
  document.getElementById('import-step-review').style.display = 'none';
}

export function applyImport() {
  const approved = state._importActions.filter(a => a.status === 'approved');
  if (approved.length === 0) {
    alert(t('import.noApprovedChanges'));
    return;
  }

  // Merging is supposed to grow one tree, not park a second one beside it.
  // Judged on what is approved, not on what the preview hoped for: a tie that
  // is still sitting in a pending card will not be written either.
  _imRefreshConn();
  const loose = state._importActions.filter(a =>
    a.kind === 'person' && a.status === 'approved' && _imConnState(a) !== 'ok');
  if (state._importRequireConnected && loose.length) {
    const nPending = loose.filter(a => _imConnState(a) === 'unapproved').length;
    alert(t('import.blockedUnconnected', { n: loose.length }) +
      (nPending ? '\n\n' + t('import.blockedPendingTie', { n: nPending }) : ''));
    state._importFilter = 'unconnected';
    _renderImportReview();
    return;
  }

  // Show progress overlay, hide review step
  document.getElementById('import-step-review').style.display = 'none';
  const overlay  = document.getElementById('import-progress-overlay');
  const bar      = document.getElementById('import-progress-bar');
  const countEl  = document.getElementById('import-progress-count');
  const labelEl  = document.getElementById('import-progress-label');
  overlay.style.display = 'flex';
  bar.style.width = '0%';

  const total = approved.length;
  const BATCH = 50;
  let done = 0;

  function tick() {
    const next = Math.min(done + BATCH, total);
    done = next;
    const pct = Math.round((done / total) * 100);
    bar.style.width = pct + '%';
    countEl.textContent = t('import.progressCount', { done, total });

    if (done < total) {
      setTimeout(tick, 0);
      return;
    }

    // All ticks done — now run the actual synchronous apply + rebuild
    labelEl.textContent = t('import.graphUpdate');
    bar.style.width = '100%';
    // Double rAF: first frame commits the DOM change, second frame runs after paint
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const report = _tiApplyActions(state._importActions);
      _fullRebuildGraph();
      closeTextImport();

      const nAdd  = report.filter(r => r.type === 'add').length;
      const nUpd  = report.filter(r => r.type === 'update').length;
      const nFam  = report.filter(r => r.type === 'fam').length;
      const nSkip = report.filter(r => r.type === 'skip').length;
      alert(t('import.importDone', { add: nAdd, update: nUpd, marriages: nFam, skipped: nSkip }));
    }));
  }

  setTimeout(tick, 0);
}

export function _imAttachToParent(actionId) { openMatchDialog(actionId, 'parent'); }

export function openMatchDialog(actionId, mode = 'link') {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;

  state._currentMatchActionId = actionId;
  state._imMatchMode = mode;

  // Display current entry
  const currentHtml = `
    <div class="import-match-person">
      <div class="import-match-name">${escHtml(action.fields['Name'] || t('import.noName'))}</div>
      <div class="import-match-details">
        ${action.fields['Birth Date'] ? `${t('import.fieldBirthDate')}: ${escHtml(action.fields['Birth Date'])}` : ''}
        ${action.fields['Birth Place'] ? `${t('import.tooltipIn')}${escHtml(action.fields['Birth Place'])}` : ''}
      </div>
      ${mode === 'parent' ? `<div class="import-match-hint">${t('import.attachHint')}</div>` : ''}
    </div>
  `;
  document.getElementById('import-match-current-content').innerHTML = currentHtml;
  
  // Find candidates
  state._currentMatchCandidates = _findMatchCandidates(action);
  renderMatchCandidates(state._currentMatchCandidates);
  
  // Clear search
  document.getElementById('import-match-search-input').value = '';
  
  // Show dialog
  document.getElementById('import-match-dialog').style.display = 'flex';
}

export function closeMatchDialog() {
  document.getElementById('import-match-dialog').style.display = 'none';
  state._currentMatchActionId = null;
  state._currentMatchCandidates = [];
  state._imMatchMode = 'link';
}

export function _findMatchCandidates(action) {
  const candidates = [];
  const searchName = (action.fields['Name'] || '').toLowerCase();
  const searchBirth = (action.fields['Birth Date'] || '').match(/\b(\d{4})\b/)?.[1] || '';
  
  // Search in existing individuals
  for (const [id, indi] of state.individuals) {
    const indiName = (indi.name || '').toLowerCase();
    const indiBirth = (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || '';
    
    let score = 0;
    
    // Exact name match
    if (indiName === searchName) {
      score = 100;
    } else if (indiName.includes(searchName) || searchName.includes(indiName)) {
      score = 50;
    } else if (indiName.split(' ').pop() === searchName.split(' ').pop()) {
      // Same surname
      score = 30;
    }
    
    // Birth year bonus
    if (score > 0 && indiBirth && searchBirth) {
      if (indiBirth === searchBirth) {
        score += 50;
      } else if (Math.abs(parseInt(indiBirth) - parseInt(searchBirth)) <= 2) {
        score += 20;
      }
    }
    
    if (score > 0) {
      candidates.push({
        type: 'existing',
        id: id,
        name: indi.name,
        birth: indi.birth?.date || '',
        death: indi.death?.date || '',
        sex: indi.sex || 'U',
        score: score,
        data: indi
      });
    }
  }
  
  // Also search in other pending import actions
  for (const otherAction of state._importActions) {
    if (otherAction.id === action.id) continue;
    if (otherAction.status === 'skipped') continue;
    
    const otherName = (otherAction.fields['Name'] || '').toLowerCase();
    const otherBirth = (otherAction.fields['Birth Date'] || '').match(/\b(\d{4})\b/)?.[1] || '';
    
    let score = 0;
    if (otherName === searchName) {
      score = 90;
    } else if (otherName.includes(searchName) || searchName.includes(otherName)) {
      score = 40;
    }
    
    if (score > 0 && otherBirth && searchBirth && otherBirth === searchBirth) {
      score += 40;
    }
    
    if (score > 0) {
      candidates.push({
        type: 'pending',
        actionId: otherAction.id,
        name: otherAction.fields['Name'],
        birth: otherAction.fields['Birth Date'] || '',
        death: otherAction.fields['Death Date'] || '',
        sex: otherAction.fields['Sex'] || 'U',
        score: score,
        data: otherAction
      });
    }
  }
  
  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

export function renderMatchCandidates(candidates) {
  const listEl = document.getElementById('import-match-list');
  
  if (candidates.length === 0) {
    listEl.innerHTML = `<div class="import-match-empty">${t('import.noMatchesFound')}</div>`;
    return;
  }

  listEl.innerHTML = candidates.map((c, idx) => `
    <div class="import-match-candidate" onclick="selectMatchCandidate('${c.type}', '${c.type === 'existing' ? c.id : c.actionId}')">
      <div class="import-match-candidate-type ${c.type === 'existing' ? 'type-existing' : 'type-pending'}">
        ${c.type === 'existing' ? t('import.matchExisting') : t('import.matchPending')}
      </div>
      <div class="import-match-candidate-info">
        <div class="import-match-candidate-name">${escHtml(c.name)}</div>
        <div class="import-match-candidate-details">
          ${c.birth ? `${t('import.bornShort')} ${escHtml(c.birth)}` : ''}
          ${c.death ? ` - ${t('import.diedShort')} ${escHtml(c.death)}` : ''}
          [${c.sex}]
        </div>
      </div>
      <div class="import-match-candidate-score">${t('import.score')}: ${c.score}</div>
    </div>
  `).join('');
}

export function searchMatchCandidates() {
  const query = document.getElementById('import-match-search-input').value.toLowerCase().trim();
  if (!query) {
    renderMatchCandidates(state._currentMatchCandidates);
    return;
  }

  // Search the whole dataset + all pending import actions, not just the pre-scored shortlist.
  const results = [];
  for (const [id, indi] of state.individuals) {
    if (!(indi.name || '').toLowerCase().includes(query)) continue;
    results.push({
      type: 'existing',
      id,
      name: indi.name || '',
      birth: indi.birth?.date || '',
      death: indi.death?.date || '',
      sex: indi.sex || 'U',
      score: 0,
      data: indi
    });
  }
  const currentActionId = state._currentMatchActionId;
  for (const a of state._importActions) {
    if (a.id === currentActionId || a.status === 'skipped') continue;
    const name = a.fields?.['Name'] || '';
    if (!name.toLowerCase().includes(query)) continue;
    results.push({
      type: 'pending',
      actionId: a.id,
      name,
      birth: a.fields['Birth Date'] || '',
      death: a.fields['Death Date'] || '',
      sex: a.fields['Sex'] || 'U',
      score: 0,
      data: a
    });
  }
  renderMatchCandidates(results);
}

/**
 * Hang a proposed new person off somebody already in the tree, as their child.
 * The parent's own family is preferred — that is where their other children are —
 * and only when they have none does this open a new one. Expressed as an ordinary
 * marriage card so the apply pass needs to know nothing about it.
 */
export function _imAttachChildTo(action, parentId) {
  const parent = state.individuals.get(parentId);
  if (!parent) return false;
  const childName = (action.fields['Name'] || '').trim();
  if (!childName) return false;

  const famId = (parent.fams || []).find(f => state.families.has(f));
  const attach = {
    id: Math.random().toString(36).slice(2),
    kind: 'marriage',
    status: 'approved',
    _sourceIdx: (action._sourceIdx ?? 0) + 0.5,
    _childrenArr: [childName],
    fieldLinks: { 'Children:0': { type: 'pending', id: action.id } },
    fields: { 'Husband':'', 'Wife':'', 'Marriage Date':'', 'Marriage Place':'', 'Children': childName },
    source: t('import.attachedTo', { name: parent.name || parentId }),
  };

  if (famId) {
    const fam = state.families.get(famId);
    attach.existingFamId = famId;
    attach.fields['Husband'] = state.individuals.get(fam.husb)?.name || '';
    attach.fields['Wife']    = state.individuals.get(fam.wife)?.name || '';
    if (fam.husb) attach.fieldLinks['Husband'] = { type: 'existing', id: fam.husb };
    if (fam.wife) attach.fieldLinks['Wife']    = { type: 'existing', id: fam.wife };
  } else {
    const slot = parent.sex === 'F' ? 'Wife' : 'Husband';
    attach.fields[slot]     = parent.name || '';
    attach.fieldLinks[slot] = { type: 'existing', id: parentId };
  }

  state._importActions.push(attach);
  action.status = 'approved';   // a pending link to a skipped card resolves to nothing
  return true;
}

export function selectMatchCandidate(type, targetId) {
  if (!state._currentMatchActionId) return;

  const action = state._importActions.find(a => a.id === state._currentMatchActionId);
  if (!action) return;

  if (state._imMatchMode === 'parent') {
    if (type !== 'existing' || !_imAttachChildTo(action, targetId)) return;
    state._imMatchMode = 'link';
    _renderImportReview();
    closeMatchDialog();
    return;
  }

  if (type === 'existing') {
    if (!_imLinkExisting(action, targetId)) return;

  } else if (type === 'pending') {
    // Link to another pending action
    const targetAction = state._importActions.find(a => a.id === targetId);
    if (!targetAction) return;
    
    // Merge data into the target action
    if (action.fields['Birth Date'] && !targetAction.fields['Birth Date']) {
      targetAction.fields['Birth Date'] = action.fields['Birth Date'];
    }
    if (action.fields['Birth Place'] && !targetAction.fields['Birth Place']) {
      targetAction.fields['Birth Place'] = action.fields['Birth Place'];
    }
    if (action.fields['Death Date'] && !targetAction.fields['Death Date']) {
      targetAction.fields['Death Date'] = action.fields['Death Date'];
    }
    if (action.fields['Death Place'] && !targetAction.fields['Death Place']) {
      targetAction.fields['Death Place'] = action.fields['Death Place'];
    }
    
    // Mark current action as skip (will be merged into target)
    action.status = 'skipped';
    action._mergedInto = targetId;
  }
  
  // Refresh the import review UI
  _renderImportReview();
  closeMatchDialog();
}

export function _imPersonSearch(inp, actionId, fieldKey) {
  const dropId = _imDropId(actionId, fieldKey);
  const drop   = document.getElementById(dropId);
  if (!drop) return;

  const raw    = inp.value.trim();
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;

  const yearM   = raw.match(/\b(\d{4})\b/);
  const qYear   = yearM ? yearM[1] : '';
  let   qRest   = raw.replace(/\b\d{4}\b/, '').trim();
  const maidenM = qRest.match(/\((?:geb\.?\s*|née\s*)?([^)]+)\)/i) ||
                  qRest.match(/\bgeb\.?\s+([A-Za-zÀ-ž]+)/i) ||
                  qRest.match(/\bnée\s+([A-Za-zÀ-ž]+)/i);
  const qMaiden = maidenM ? maidenM[1].toLowerCase().trim() : '';
  if (maidenM) qRest = qRest.replace(maidenM[0], '').trim();
  const qName = qRest.toLowerCase();

  function scoreStr(iName, iMaiden, iYear) {
    let score = 0;
    if (qName) {
      if (iName === qName)                          score += 1.0;
      else if (iName.startsWith(qName))             score += 0.8;
      else if (iName.includes(qName))               score += 0.6;
      else if (iMaiden && iMaiden.includes(qName))  score += 0.55;
      else {
        const words = qName.split(/\s+/).filter(w => w.length > 1);
        if (words.length) {
          const hits = words.filter(w => iName.includes(w) || iMaiden.includes(w));
          if (hits.length) score += 0.35 * hits.length / words.length;
        }
      }
    } else { score += 0.15; }
    if (score <= 0 && !qYear && !qMaiden) return 0;
    if (qMaiden) {
      if (iMaiden && iMaiden.includes(qMaiden)) score += 0.5;
      else if (iName.includes(qMaiden))          score += 0.3;
      else                                        score -= 0.3;
    }
    if (qYear && iYear) {
      const d = Math.abs(+qYear - +iYear);
      if (d === 0) score += 0.5; else if (d <= 2) score += 0.15; else score -= 0.35;
    }
    return score;
  }

  const results = [];
  for (const [id, indi] of state.individuals) {
    const score = scoreStr(
      (indi.name || '').toLowerCase(),
      (indi.maidenName || '').toLowerCase(),
      (indi.birth?.date || '').match(/\b(\d{4})\b/)?.[1] || ''
    );
    if (score > 0.05) results.push({ score, type: 'existing', id, indi });
  }
  for (const pa of state._importActions) {
    if (pa.id === actionId || pa.status === 'skipped') continue;
    const score = scoreStr(
      (pa.fields['Name'] || '').toLowerCase(), '',
      (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || ''
    );
    if (score > 0.05) results.push({ score, type: 'pending', id: pa.id, pa });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 12);
  if (!top.length) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  drop.innerHTML = top.map(r => {
    if (r.type === 'existing') {
      const { id, indi } = r;
      const bYear  = indi.birth?.date?.match(/\b(\d{4})\b/)?.[1] || '';
      const dYear  = indi.death?.date?.match(/\b(\d{4})\b/)?.[1] || '';
      const maiden = indi.maidenName ? ` <span class="import-sdrop-maiden">${t('tooltip.born', { name: escHtml(indi.maidenName) })}</span>` : '';
      const bPlace = indi.birth?.plac || '';
      const parts  = [];
      if (bYear || bPlace) parts.push((bYear ? '*' + bYear : '') + (bPlace ? (bYear ? ' ' : '') + bPlace : ''));
      if (dYear) parts.push('\u2020' + dYear);
      const detail = parts.join(' \u00b7 ');
      return `<div class="import-sdrop-item" onmousedown="event.preventDefault();_imPersonSelect('${actionId}','${fieldKey}','existing','${id}')">
        <span class="import-sdrop-name">${escHtml(indi.name)}${maiden}</span>
        ${detail ? `<span class="import-sdrop-detail">${detail}</span>` : ''}
      </div>`;
    } else {
      const { id, pa } = r;
      const bYear = (pa.fields['Birth Date']||'').match(/\b(\d{4})\b/)?.[1] || '';
      const dYear = (pa.fields['Death Date']||'').match(/\b(\d{4})\b/)?.[1] || '';
      const parts = [];
      if (bYear) parts.push('*' + bYear);
      if (dYear) parts.push('\u2020' + dYear);
      const detail = parts.join(' \u00b7 ');
      return `<div class="import-sdrop-item import-sdrop-item--pending" onmousedown="event.preventDefault();_imPersonSelect('${actionId}','${fieldKey}','pending','${id}')">
        <span class="import-sdrop-name">${escHtml(pa.fields['Name']||'')}</span>
        ${detail ? `<span class="import-sdrop-detail">${detail}</span>` : ''}
      </div>`;
    }
  }).join('');
  drop.style.display = '';
}

export function _imPersonSelect(actionId, fieldKey, type, targetId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};

  const resolveName = (t, id) => t === 'existing'
    ? (state.individuals.get(id)?.name || '')
    : (state._importActions.find(a => a.id === id)?.fields['Name'] || '');

  if (fieldKey === 'Name') {
    if (type !== 'existing') return;
    if (!_imLinkExisting(action, targetId)) return;
  } else if (fieldKey.startsWith('Children:')) {
    action.fieldLinks[fieldKey] = { type, id: targetId };
    const idx = parseInt(fieldKey.split(':')[1]);
    const name = resolveName(type, targetId);
    if (action._childrenArr) action._childrenArr[idx] = name;
    action.fields['Children'] = (action._childrenArr || []).join('; ');
  } else {
    action.fieldLinks[fieldKey] = { type, id: targetId };
    action.fields[fieldKey] = resolveName(type, targetId);
  }

  _imRepaintAction(actionId);
}

export function _imFieldUnlink(actionId, fieldKey) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.fieldLinks = action.fieldLinks || {};
  delete action.fieldLinks[fieldKey];
  _imRepaintAction(actionId);
}

export const _IM_UPDATE_FIELDS = ['Birth Date', 'Birth Place', 'Death Date', 'Death Place', 'Sex', 'Notes'];

export function _imExistingValue(indi, field) {
  switch (field) {
    case 'Birth Date':  return indi.birth?.date || '';
    case 'Birth Place': return indi.birth?.plac || '';
    case 'Death Date':  return indi.death?.date || '';
    case 'Death Place': return indi.death?.plac || '';
    case 'Sex':         return (indi.sex && indi.sex !== 'U') ? indi.sex : '';
    case 'Notes':       return indi.note || '';
    default:            return '';
  }
}

export function _imLinkExisting(action, targetId) {
  const indi = state.individuals.get(targetId);
  if (!indi) return false;

  // Remember the card as it stands — including manual edits — so unlink is
  // genuinely an undo rather than a re-parse.
  if (!action._preLink) {
    action._preLink = { kind: action.kind, status: action.status, fields: { ...action.fields } };
  }
  action.kind       = 'update';
  action.existingId = targetId;
  action.status     = 'approved';
  action.fields     = { ...action.fields, 'Name': indi.name };

  // Keep every incoming value so the card can show what the two sources say.
  // Fill a gap by default; never overwrite something already recorded without
  // being asked — the tree is the thing being edited, the import is a proposal.
  action.fieldApply = {};
  for (const f of _IM_UPDATE_FIELDS) {
    const incoming = (action.fields[f] || '').trim();
    const existing = _imExistingValue(indi, f).trim();
    action.fieldApply[f] = !!incoming && !existing;
  }
  return true;
}

export function _imToggleFieldApply(actionId, field) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action || !action.fieldApply) return;
  action.fieldApply[field] = !action.fieldApply[field];
  _imRepaintAction(actionId);
}

export function _imUnlink(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action.existingId = undefined;
  action.fieldApply = undefined;

  const pre = action._preLink;
  if (pre) {
    action.kind   = pre.kind;
    action.status = pre.status;
    action.fields = { ...pre.fields };
    action._preLink = undefined;
  } else {
    // No snapshot: this card arrived already matched, so fall back to the parse.
    const p = action._person;
    action.kind   = 'person';
    action.status = 'pending';
    if (p) {
      action.fields = {
        'Name':         p.fullName,
        'Sex':          p.sex || '',
        'Birth Date':   p.birthDate  || '',
        'Birth Place':  p.birthPlace || '',
        'Death Date':   p.deathDate  || '',
        'Death Place':  p.deathPlace || '',
        'Father':       p.fatherName || '',
        'Mother':       p.motherName || '',
        'Notes':        p.notes      || '',
      };
    }
  }
  _imRepaintAction(actionId);
}

export function _imAddChild(actionId) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action) return;
  action._childrenArr = action._childrenArr || [];
  action._childrenArr.push('');
  action.fields['Children'] = action._childrenArr.join('; ');
  _imRepaintAction(actionId);
}

export function _imRemoveChild(actionId, idx) {
  const action = state._importActions.find(a => a.id === actionId);
  if (!action || !action._childrenArr) return;
  action._childrenArr.splice(idx, 1);
  action.fieldLinks = action.fieldLinks || {};
  const newLinks = {};
  for (const [k, v] of Object.entries(action.fieldLinks)) {
    if (!k.startsWith('Children:')) { newLinks[k] = v; continue; }
    const i = parseInt(k.split(':')[1]);
    if (i === idx) continue;
    newLinks['Children:' + (i > idx ? i - 1 : i)] = v;
  }
  action.fieldLinks = newLinks;
  action.fields['Children'] = action._childrenArr.join('; ');
  _imRepaintAction(actionId);
}
