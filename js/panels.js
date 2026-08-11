import { state } from './state.js';
import { _fullRebuildGraph, _gedcomDateValue, _gedcomDateWidget, _resetGedcomDateWidget, _safeId, escAttr, escHtml, escJs, showDataUI } from './gedcom-io.js';
import { _updateCenterPersonBtn } from './graph-data.js';
import { resetHighlight, updateHLButtons } from './relations.js';
import { flashNode } from './render-2d.js';
import { _setOrbitTarget3D } from './render-3d.js';

export function showIndiDetail(id) {
  const indi = state.individuals.get(id);
  if (!indi) return;
  state.selectedIndiId = id;
  _updateCenterPersonBtn();

  document.getElementById('detail-name').textContent = indi.name || id;

  let html = '';

  // Sex + ID
  const sexLabel = indi.sex === 'M' ? t('detail.male') : indi.sex === 'F' ? t('detail.female') : t('detail.unknown');
  html += row(t('detail.sex'), sexLabel);

  // Birth
  if (indi.birth.date || indi.birth.plac) {
    html += row(t('detail.born'), fmtPlace(indi.birth.date, indi.birth.plac));
  } else if (state._estimatedYears && state._estimatedYears.has(id)) {
    html += row(t('detail.born'), `<span style="color:#888">~${state._estimatedYears.get(id)} (${t('detail.estimated')})</span>`);
  }

  // Death
  if (indi.deceased) {
    const ds = fmtPlace(indi.death.date || t('tooltip.unknownDate'), indi.death.plac);
    const caus = indi.death.caus ? `<br><span style="color:#888;font-size:11px">${escHtml(indi.death.caus)}</span>` : '';
    html += row(t('detail.died'), ds + caus);
  }

  // Occupation
  if (indi.occu) html += row(t('detail.occupation'), escHtml(indi.occu));

  // Maiden name
  if (indi.maidenName) html += row(t('detail.maidenName'), escHtml(indi.maidenName));

  // Parents
  if (indi.famc.length) {
    html += `<div class="detail-section"><div class="detail-label">${t('detail.parents')}</div>`;
    for (const famId of indi.famc) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      const ps = [fam.husb, fam.wife].filter(Boolean).map(pid => {
        const p = state.individuals.get(pid);
        return p
          ? `<span class="clickable-name" onclick="event.stopPropagation();showIndiDetail('${escJs(pid)}')">${escHtml(p.name)}</span>`
          : escHtml(pid);
      }).join(' &amp; ');
      html += `<div class="detail-marriage detail-fam-card" onclick="showFamDetail('${escJs(famId)}')" title="${t('detail.openFamily')}">${ps || `<em>${t('detail.unknownName')}</em>`}</div>`;
    }
    html += `</div>`;
  }

  // Marriages / partners
  if (indi.fams.length) {
    html += `<div class="detail-section"><div class="detail-label">${t('detail.marriages')}</div>`;
    for (const famId of indi.fams) {
      const fam = state.families.get(famId);
      if (!fam) continue;
      const spId = fam.husb === id ? fam.wife : fam.husb;
      const sp = spId ? state.individuals.get(spId) : null;
      const spName = sp
        ? `<span class="clickable-name" onclick="event.stopPropagation();showIndiDetail('${escJs(spId)}')">${escHtml(sp.name)}</span>`
        : (spId ? escHtml(spId) : `<em>${t('detail.unknownName')}</em>`);
      const m0 = fam.marriages?.[0];
      const mInfo = m0?.date ? ` &mdash; ⚭ ${escHtml(m0.date)}${m0.plac ? ', ' + escHtml(m0.plac) : ''}` : '';
      const dInfo = fam.div ? ` <span style="color:#787878">[${t('tooltip.divorced', { date: fam.divDate ? ' ' + escHtml(fam.divDate) : '' })}]</span>` : '';
      const kids = fam.chil.length ? `<br><span style="color:#888;font-size:11px">${fam.chil.length} ${fam.chil.length === 1 ? t('tooltip.child') : t('tooltip.children')}</span>` : '';
      html += `<div class="detail-marriage detail-fam-card" onclick="showFamDetail('${escJs(famId)}')" title="${t('detail.openFamily')}">${spName}${mInfo}${dInfo}${kids}</div>`;
    }
    html += `</div>`;
  }

  // Note
  if (indi.note) {
    html += row(t('detail.note'), `<span style="font-size:11px;color:#999">${escHtml(indi.note).replace(/\n/g, '<br>')}</span>`);
  }

  // Quick-add relative — one click from the read-only view, no need to enter edit mode
  html += `<div class="detail-section" style="border-top:1px solid #2e2e2e;padding-top:8px;margin-top:4px">
    <datalist id="ef-place-dl">${_buildPlaceDatalist()}</datalist>
    <div class="ef-rel-add-row">
      <button class="ef-new-person-btn" style="width:auto;flex:1;margin-top:0" onclick="toggleQuickAdd('parent')">&#xff0b; ${t('detail.addParent')}</button>
      <button class="ef-new-person-btn" style="width:auto;flex:1;margin-top:0" onclick="toggleQuickAdd('spouse')">&#xff0b; ${t('detail.addSpouse')}</button>
      <button class="ef-new-person-btn" style="width:auto;flex:1;margin-top:0" onclick="toggleQuickAdd('child')">&#xff0b; ${t('detail.addChild')}</button>
    </div>
    ${_quickAddFormHtml('parent', id)}
    ${_quickAddFormHtml('spouse', id)}
    ${_quickAddFormHtml('child', id)}
  </div>`;

  _setPanelContent(html);
  document.getElementById('delete-confirm-bar').style.display = 'none';
  document.getElementById('detail-edit-bar').style.display = 'block';
  document.getElementById('detail-buttons').style.display = 'flex';
  openPanel();
  updateHLButtons();
  flashNode(id);
  if (state.currentView === '3d') _setOrbitTarget3D(id);
}

export const _QUICK_ADD_LABELS = { parent: 'detail.addParent', spouse: 'detail.addSpouse', child: 'detail.addChild' };

export function _quickAddFormHtml(type, personId) {
  if (type === 'parent') return _quickAddParentFormHtml(personId);
  const defaultSurn = type === 'child' ? (state.individuals.get(personId)?.surn || '') : '';
  return `<div id="qa-${type}-form" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
    <div class="edit-label" style="margin-bottom:6px">${t('detail.newLabel', { type: t(_QUICK_ADD_LABELS[type]) })}</div>
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <input class="edit-input" id="qa-${type}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
      <input class="edit-input" id="qa-${type}-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr(defaultSurn)}">
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <select class="edit-select" id="qa-${type}-sex">
        <option value="U">${t('detail.sexPlaceholder')}</option>
        <option value="M">${t('detail.male')}</option>
        <option value="F">${t('detail.female')}</option>
      </select>
    </div>
    ${type === 'child' ? _personVitalsHtml('qa-child') + _inlineSpouseFormHtml('qa-child') : ''}
    <div style="display:flex;gap:6px;margin-top:8px">
      <button class="edit-save-btn" style="flex:1;padding:5px" onclick="confirmQuickAddRelative('${escJs(personId)}','${type}')">&#x2713; ${t('detail.add')}</button>
      <button class="edit-cancel-btn" style="flex:1;padding:5px" onclick="toggleQuickAdd('${type}')">${t('detail.cancel')}</button>
    </div>
  </div>`;
}

export function _quickAddParentFormHtml(personId) {
  const i = state.individuals.get(personId);
  const fam = i?.famc?.length ? state.families.get(i.famc[0]) : null;
  const husb = fam?.husb ? state.individuals.get(fam.husb) : null;
  const wife = fam?.wife ? state.individuals.get(fam.wife) : null;

  if (husb && wife) {
    return `<div id="qa-parent-form" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
      <div style="color:#888;font-size:11px">${t('detail.bothParentsSet')}</div>
    </div>`;
  }

  const slotHtml = (slot, label, existing, defaultSurn) => existing
    ? `<div class="edit-label" style="margin-top:6px">${label}</div>
       <div style="color:#888;font-size:11px;padding:4px 0">${escHtml(existing.name || existing.id)} ${t('detail.parentAlreadySet')}</div>`
    : `<div class="edit-label" style="margin-top:6px">${label}</div>
       <div style="display:flex;gap:6px;margin-bottom:4px">
         <input class="edit-input" id="qa-parent-${slot}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
         <input class="edit-input" id="qa-parent-${slot}-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr(defaultSurn)}">
       </div>
       ${_gedcomDateWidget('qa-parent-' + slot + '-bdate', '')}`;

  return `<div id="qa-parent-form" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
    <div class="edit-label" style="margin-bottom:6px">${t('detail.newLabel', { type: t('detail.addParent') })}</div>
    ${slotHtml('father', t('detail.relationVater'), husb, i?.surn || '')}
    ${slotHtml('mother', t('detail.relationMutter'), wife, '')}
    <div style="display:flex;gap:6px;margin-top:8px">
      <button class="edit-save-btn" style="flex:1;padding:5px" onclick="confirmQuickAddParents('${escJs(personId)}')">&#x2713; ${t('detail.add')}</button>
      <button class="edit-cancel-btn" style="flex:1;padding:5px" onclick="toggleQuickAdd('parent')">${t('detail.cancel')}</button>
    </div>
  </div>`;
}

export function confirmQuickAddParents(personId) {
  const readSlot = slot => {
    if (!document.getElementById(`qa-parent-${slot}-givn`)) return null; // slot already filled, no inputs rendered
    const givn = document.getElementById(`qa-parent-${slot}-givn`)?.value.trim() || '';
    const surn = document.getElementById(`qa-parent-${slot}-surn`)?.value.trim() || '';
    if (!givn && !surn) return null;
    return { givn, surn, birthDate: _gedcomDateValue(`qa-parent-${slot}-bdate`) };
  };
  const father = readSlot('father');
  const mother = readSlot('mother');
  if (!father && !mother) {
    const el = document.getElementById('qa-parent-father-givn') || document.getElementById('qa-parent-mother-givn');
    if (el) { el.style.borderColor = '#787878'; setTimeout(() => { el.style.borderColor = ''; }, 1200); }
    return;
  }

  const fam = _findOrCreateFamAsChild(personId);
  let lastNewId = null;
  if (father && !fam.husb) {
    lastNewId = fam.husb = _makeNewIndi(father.givn, father.surn, 'M', { birthDate: father.birthDate });
    state.individuals.get(fam.husb).fams.push(fam.id);
  }
  if (mother && !fam.wife) {
    lastNewId = fam.wife = _makeNewIndi(mother.givn, mother.surn, 'F', { birthDate: mother.birthDate });
    state.individuals.get(fam.wife).fams.push(fam.id);
  }

  _fullRebuildGraph({ warm: true });
  showIndiDetail(personId);
  if (lastNewId) flashNode(lastNewId);
}

export function toggleQuickAdd(type) {
  for (const t of ['parent', 'spouse', 'child']) {
    const sf = document.getElementById(`qa-${t}-form`);
    if (!sf) continue;
    if (t === type) {
      const visible = sf.style.display !== 'none';
      sf.style.display = visible ? 'none' : 'block';
      if (!visible) document.getElementById(`qa-${t}-givn`)?.focus();
    } else {
      sf.style.display = 'none';
    }
  }
}

export function confirmQuickAddRelative(personId, type) {
  const givn = document.getElementById(`qa-${type}-givn`)?.value.trim() || '';
  const surn = document.getElementById(`qa-${type}-surn`)?.value.trim() || '';
  const sex  = document.getElementById(`qa-${type}-sex`)?.value || 'U';

  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    const el = document.getElementById(`qa-${type}-givn`);
    if (el) { el.style.borderColor = '#787878'; setTimeout(() => { el.style.borderColor = ''; }, 1200); }
    return;
  }

  const extra = type === 'child' ? _readPersonVitals('qa-child') : {};
  const newId = _makeNewIndi(givn, surn, sex, extra);

  // The UI is phrased from the viewed person's perspective ("add a spouse/child to
  // this person"), but _applyRelation's `type` describes personId's relation TO the
  // target — so "add a child" means personId is the PARENT of the new person.
  // ("Add parent" is handled separately by confirmQuickAddParents.)
  const relType = type === 'child' ? 'parent' : 'spouse';
  _applyRelation(personId, { targetId: newId, type: relType });

  if (type === 'child') _attachInlineSpouse(newId, _readInlineSpouse('qa-child'));

  _fullRebuildGraph({ warm: true });
  state.selectedIndiId = newId;
  state._editingId    = newId;
  state._editingType  = 'INDI';
  // Deliberately NOT _isNewRecord = true: the relation was already committed above
  // (not staged), so cancelling the new person's own edit form must not delete them
  // and leave the family record pointing at a dangling id.
  state._isNewRecord = false;
  document.getElementById('detail-name').textContent = fullName;
  showIndiEditForm(newId);
}

export function showFamDetail(id) {
  const fam = state.families.get(id);
  if (!fam) return;
  state._lastShownFamId = id;
  state.selectedIndiId = null;

  const names = [fam.husb, fam.wife].filter(Boolean)
    .map(pid => state.individuals.get(pid)?.name || pid).join(' & ');
  document.getElementById('detail-name').textContent = t('detail.family') + (names ? ': ' + names : '');

  let html = '';
  (fam.marriages || []).forEach((m, i) => {
    if (!m.date && !m.plac && !m.types?.length) return;
    let marrVal = fmtPlace(m.date, m.plac);
    if (m.types?.length) marrVal += (marrVal ? ' &mdash; ' : '') + `<span style="color:#9f9f9f;font-size:11px">${escHtml(m.types.join(', '))}</span>`;
    const label = (fam.marriages.length > 1) ? t('detail.marriageN', { n: i + 1 }) : t('detail.marriage');
    html += row(label, marrVal);
  });
  if (fam.div) {
    const divTxt = `<span style="color:#787878">${t('tooltip.divorced', { date: fam.divDate ? ' &mdash; ' + escHtml(fam.divDate) : '' })}</span>`;
    html += row(t('detail.status'), divTxt);
  }

  const spouses = [fam.husb, fam.wife].filter(Boolean);
  if (spouses.length) {
    const sl = spouses.map(pid => {
      const p = state.individuals.get(pid);
      return p ? `<span class="clickable-name" onclick="showIndiDetail('${escJs(pid)}')">${escHtml(p.name)}</span>` : escHtml(pid);
    }).join(' &amp; ');
    html += row(t('detail.spouses'), sl);
  }

  if (fam.chil.length) {
    html += `<div class="detail-section"><div class="detail-label">${t('detail.children')} (${fam.chil.length})</div>`;
    for (const cid of fam.chil) {
      const c = state.individuals.get(cid);
      if (c) html += `<div class="detail-value"><span class="clickable-name" onclick="showIndiDetail('${escJs(cid)}')">${escHtml(c.name)}</span></div>`;
    }
    html += `</div>`;
  }

  _setPanelContent(html);
  document.getElementById('delete-confirm-bar').style.display = 'none';
  document.getElementById('detail-edit-bar').style.display = 'block';
  document.getElementById('detail-buttons').style.display = 'flex';
  openPanel();
  updateHLButtons();
}

export function openPanel() {
  document.getElementById('main-layout').classList.add('panel-open');
  document.getElementById('detail-panel').classList.add('panel-visible');
  _hideReopenPill();
}

export function closeDetailPanel() {
  document.getElementById('main-layout').classList.remove('panel-open');
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('panel-visible');
  panel.style.transform = '';   // clear any inline transform from swipe gesture
  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('delete-confirm-bar').style.display = 'none';
  state._pendingDeleteId = null; state._pendingDeleteType = null;
  state.selectedIndiId = null;
  _updateCenterPersonBtn();
  resetHighlight();
  if (state.currentView === '3d') _setOrbitTarget3D(null);
  _hideReopenPill();
  // Cancelling the very first person discards the stub, which leaves the tree
  // empty again — the empty state has to come back rather than leaving a blank
  // canvas with no way on from it.
  showDataUI();
}

export function minimizeDetailPanel() {
  document.getElementById('main-layout').classList.remove('panel-open');
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('panel-visible');
  panel.style.transform = '';
  // Don't clear selectedIndiId or highlights!
  _showReopenPill();
}

export function reopenDetailPanel() {
  if (state.selectedIndiId) {
    openPanel();
    _hideReopenPill();
  }
}

export function _isMobile() {
  return window.innerWidth <= 768;
}

export function _showReopenPill() {
  let pill = document.getElementById('reopen-panel-pill');
  if (!pill) return;
  if (!state.selectedIndiId) { _hideReopenPill(); return; }
  const indi = state.individuals.get(state.selectedIndiId);
  const name = indi ? (indi.displayName || indi.name || state.selectedIndiId) : state.selectedIndiId;
  pill.textContent = '▲ ' + name;
  pill.style.display = 'block';
}

export function _hideReopenPill() {
  const pill = document.getElementById('reopen-panel-pill');
  if (pill) pill.style.display = 'none';
}

export function row(label, value) {
  return `<div class="detail-section">
    <div class="detail-label">${label}</div>
    <div class="detail-value">${value}</div>
  </div>`;
}

export function fmtPlace(date, plac) {
  let s = escHtml(date || '');
  if (plac) s += (s ? ' &mdash; ' : '') + escHtml(plac);
  return s;
}

export function _buildFamEditSections(personId) {
  const i = state.individuals.get(personId);
  if (!i || !i.fams.length) return `<div style="color:#555;font-size:11px;padding:2px 0">${t('detail.emptyMarriages')}</div>`;
  return i.fams.map(famId => {
    const fam = state.families.get(famId);
    if (!fam) return '';
    const spouseId = fam.husb === personId ? fam.wife : fam.husb;
    const spouse   = spouseId ? state.individuals.get(spouseId) : null;
    const spouseLbl = spouse ? escHtml(spouse.name) : (spouseId ? escHtml(spouseId) : `<em>${t('detail.unknownName')}</em>`);
    const sid = _safeId(famId);
    return `<div class="ef-fam-block">
      <div class="ef-fam-header">&#x26a1; ${spouseLbl}</div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.marriageDate')}</div>
        ${_gedcomDateWidget('ef-fam-' + sid + '-mdate', fam.marriages?.[0]?.date || '')}
      </div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.marriagePlace')}</div>
        <input class="edit-input" id="ef-fam-${sid}-mplac" list="ef-place-dl" autocomplete="off" value="${escAttr(fam.marriages?.[0]?.plac || '')}">
      </div>
      <label class="edit-checkbox-row">
        <input type="checkbox" id="ef-fam-${sid}-div"${fam.div ? ' checked' : ''}>
        ${t('detail.divorced')}
      </label>
    </div>`;
  }).join('');
}

export function _buildPersonDatalist(excludeId) {
  let opts = '';
  for (const [pid, p] of state.individuals) {
    if (pid === excludeId) continue;
    const yr = p.birthYear || (state._estimatedYears?.get(pid));
    const maiden = p.maidenName ? ` (${t('tooltip.born', { name: p.maidenName })})` : '';
    const display = `${p.name || pid}${maiden}${yr ? ` *${yr}` : ''}`;
    opts += `<option value="${escAttr(display)}" data-id="${escAttr(pid)}">`;
  }
  return opts;
}

export function _buildPlaceDatalist() {
  const places = new Set();
  for (const i of state.individuals.values()) {
    if (i.birth?.plac) places.add(i.birth.plac);
    if (i.death?.plac) places.add(i.death.plac);
  }
  for (const f of state.families.values()) {
    for (const m of f.marriages || []) if (m.plac) places.add(m.plac);
  }
  return [...places].sort().map(p => `<option value="${escAttr(p)}">`).join('');
}

export function _resolvePersonInput(val) {
  if (!val) return null;
  val = val.trim();
  // Direct ID match
  if (state.individuals.has(val)) return val;
  // Strip maiden name / year suffix added by _buildPersonDatalist (e.g. "Name (geb. X) *1900")
  const baseName = val.replace(/\s*\([^)]*\)/, '').replace(/\s*\*\d{4}$/, '').trim();
  // Exact match on full datalist label or base name
  for (const [pid, p] of state.individuals) {
    const name = p.name || pid;
    if (name === val || name === baseName) return pid;
  }
  // Partial match on base name
  const lower = baseName.toLowerCase();
  for (const [pid, p] of state.individuals) {
    if ((p.name || pid).toLowerCase().includes(lower)) return pid;
  }
  return null;
}

export function _renderPendingRelations() {
  const el = document.getElementById('ef-rel-list');
  if (!el) return;
  if (!state._pendingRelations.length) {
    el.innerHTML = `<div style="color:#555;font-size:11px;padding:2px 0">${t('detail.emptyRelations')}</div>`;
    return;
  }
  const labels = { parent: t('detail.relationParent'), child: t('detail.relationChild'), spouse: t('detail.relationSpouse') };
  el.innerHTML = state._pendingRelations.map((r, idx) => {
    const p = state.individuals.get(r.targetId);
    const name = p ? escHtml(p.name || r.targetId) : escHtml(r.targetId);
    const badge = r.isNew ? `<span class="ef-rel-new-badge">${t('import.newBadge')}</span>` : '';
    return `<div class="ef-rel-item">
      <span class="ef-rel-type">${labels[r.type]}</span>
      <span class="ef-rel-name">${name}${badge}</span>
      <button class="ef-rel-remove" onclick="removeRelation(${idx})" title="${t('import.unlinkTitle')}">&#x2715;</button>
    </div>`;
  }).join('');
}

export function addRelation() {
  const input = document.getElementById('ef-rel-person');
  const typeEl = document.getElementById('ef-rel-type');
  if (!input || !typeEl) return;
  const type = typeEl.value;
  const targetId = _resolvePersonInput(input.value);
  if (!targetId) {
    input.style.borderColor = '#787878';
    setTimeout(() => { input.style.borderColor = ''; }, 1200);
    return;
  }
  if (state._pendingRelations.some(r => r.targetId === targetId && r.type === type)) return;
  state._pendingRelations.push({ targetId, type });
  input.value = '';
  _renderPendingRelations();
}

export function removeRelation(idx) {
  const rel = state._pendingRelations[idx];
  // If this was an inline-created stub, remove it from the individuals map
  if (rel?.isNew) state.individuals.delete(rel.targetId);
  state._pendingRelations.splice(idx, 1);
  _renderPendingRelations();
}

export function toggleNewPersonSubform() {
  const sf = document.getElementById('ef-new-person-subform');
  if (!sf) return;
  const visible = sf.style.display !== 'none';
  sf.style.display = visible ? 'none' : 'block';
  if (!visible) document.getElementById('ef-np-givn')?.focus();
}

export function confirmNewPersonRelation() {
  const givn = document.getElementById('ef-np-givn')?.value.trim() || '';
  const surn = document.getElementById('ef-np-surn')?.value.trim() || '';
  const sex  = document.getElementById('ef-np-sex')?.value || 'U';
  const type = document.getElementById('ef-np-type')?.value || 'child';

  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    document.getElementById('ef-np-givn').style.borderColor = '#787878';
    setTimeout(() => { document.getElementById('ef-np-givn').style.borderColor = ''; }, 1200);
    return;
  }

  const newId = getNextIndiId();
  const displayName = fullName.length > 24
    ? (givn ? givn + (surn ? ' ' + surn[0] + '.' : '') : fullName.slice(0, 22) + '…')
    : fullName;

  state.individuals.set(newId, {
    id: newId, name: fullName, givn, surn, maidenName: '', sex,
    birth: { date: '', plac: '' },
    death: { date: '', plac: '', caus: '' },
    deceased: false, birthYear: null,
    famc: [], fams: [], occu: '', note: '', displayName,
  });

  state._pendingRelations.push({ targetId: newId, type, isNew: true });
  _renderPendingRelations();

  // Reset and hide the subform
  document.getElementById('ef-np-givn').value = '';
  document.getElementById('ef-np-surn').value = '';
  document.getElementById('ef-np-sex').value  = 'U';
  document.getElementById('ef-new-person-subform').style.display = 'none';
}

export function _getExistingRelations(id) {
  const i = state.individuals.get(id);
  if (!i) return [];
  const rels = [];
  // Parents: families where this person is a child
  for (const famId of i.famc) {
    const fam = state.families.get(famId);
    if (!fam) continue;
    if (fam.husb) rels.push({ type: 'parent', targetId: fam.husb, famId, label: t('detail.relationVater') });
    if (fam.wife) rels.push({ type: 'parent', targetId: fam.wife, famId, label: t('detail.relationMutter') });
  }
  // Spouses and children: families where this person is a spouse
  for (const famId of i.fams) {
    const fam = state.families.get(famId);
    if (!fam) continue;
    const spouseId = fam.husb === id ? fam.wife : fam.husb;
    if (spouseId) rels.push({ type: 'spouse', targetId: spouseId, famId, label: t('detail.relationEhepartner') });
    for (const childId of fam.chil) {
      rels.push({ type: 'child', targetId: childId, famId, label: t('detail.relationKind') });
    }
  }
  return rels;
}

export function _renderExistingRelations(id) {
  const el = document.getElementById('ef-existing-rel-list');
  if (!el) return;
  const rels = _getExistingRelations(id).filter(
    r => !state._removedRelations.some(rem => rem.targetId === r.targetId && rem.type === r.type && rem.famId === r.famId)
  );
  if (!rels.length) { el.innerHTML = ''; return; }
  el.innerHTML = rels.map((r, idx) => {
    const p = state.individuals.get(r.targetId);
    const name = p ? escHtml(p.displayName || p.name) : escHtml(r.targetId);
    return `<div class="ef-rel-item ef-existing-rel">
      <span class="ef-rel-type">${r.label}</span>
      <span class="ef-rel-name">${name}</span>
      <button class="ef-rel-remove" onclick="removeExistingRelation(${JSON.stringify(r).split('"').join("'")})" title="${t('import.unlinkTitle')}">&#x2715;</button>
    </div>`;
  }).join('');
}

export function removeExistingRelation(r) {
  if (!state._removedRelations.some(x => x.targetId === r.targetId && x.type === r.type && x.famId === r.famId)) {
    state._removedRelations.push(r);
  }
  _renderExistingRelations(state._editingId);
}

export function showIndiEditForm(id) {
  const i = state.individuals.get(id);
  if (!i) return;

  state._pendingRelations = [];
  state._removedRelations = [];

  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('detail-buttons').style.display = 'none';

  const datalistHtml = _buildPersonDatalist(id);
  const placeDatalistHtml = _buildPlaceDatalist();

  _setPanelContent(`
    <div class="edit-section">
      <div class="edit-label">${t('detail.firstName')}</div>
      <input class="edit-input" id="ef-givn" value="${escAttr(i.givn)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.familyName')}</div>
      <input class="edit-input" id="ef-surn" value="${escAttr(i.surn)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.birthName')}</div>
      <input class="edit-input" id="ef-maiden" value="${escAttr(i.maidenName || '')}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.sex')}</div>
      <select class="edit-select" id="ef-sex">
        <option value="M"${i.sex==='M'?' selected':''}>${t('detail.male')}</option>
        <option value="F"${i.sex==='F'?' selected':''}>${t('detail.female')}</option>
        <option value="U"${i.sex==='U'||!i.sex?' selected':''}>${t('detail.unknown')}</option>
      </select>
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.birthDate')}</div>
      ${_gedcomDateWidget('ef-bdate', i.birth.date)}
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.birthPlace')}</div>
      <input class="edit-input" id="ef-bplac" list="ef-place-dl" autocomplete="off" value="${escAttr(i.birth.plac)}">
    </div>
    <label class="edit-checkbox-row">
      <input type="checkbox" id="ef-dead"${i.deceased?' checked':''} onchange="_toggleDeathFields(this.checked)">
      ${t('detail.deceased')}
    </label>
    <div id="ef-death-fields" style="display:${i.deceased ? 'block' : 'none'}">
      <div class="edit-section">
        <div class="edit-label">${t('detail.deathDate')}</div>
        ${_gedcomDateWidget('ef-ddate', i.death.date)}
      </div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.deathPlace')}</div>
        <input class="edit-input" id="ef-dplac" list="ef-place-dl" autocomplete="off" value="${escAttr(i.death.plac)}">
      </div>
      <div class="edit-section">
        <div class="edit-label">${t('detail.causeOfDeath')}</div>
        <input class="edit-input" id="ef-dcaus" value="${escAttr(i.death.caus)}">
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.occupation')}</div>
      <input class="edit-input" id="ef-occu" value="${escAttr(i.occu)}">
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.note')}</div>
      <textarea class="edit-textarea" id="ef-note">${escHtml(i.note)}</textarea>
    </div>
    <div class="edit-section" style="border-top:1px solid #2e2e2e;padding-top:8px;margin-top:4px">
      <div class="edit-label">${t('detail.marriages')}</div>
      <div id="ef-fam-sections">${_buildFamEditSections(id)}</div>
    </div>
    <div class="edit-section" style="border-top:1px solid #2e2e2e;padding-top:8px;margin-top:4px">
      <div class="edit-label">${t('detail.relations')}</div>
      <div id="ef-existing-rel-list" style="margin-bottom:4px"></div>
      <div id="ef-rel-list" style="margin-bottom:6px">
        <div style="color:#555;font-size:11px;padding:2px 0">${t('detail.emptyNewRelations')}</div>
      </div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-rel-person" list="ef-rel-datalist" placeholder="${t('detail.searchPerson')}" autocomplete="off">
        <datalist id="ef-rel-datalist">${datalistHtml}</datalist>
        <datalist id="ef-place-dl">${placeDatalistHtml}</datalist>
        <select class="edit-select" id="ef-rel-type" style="width:auto;min-width:100px">
          <option value="child">${t('detail.relationChild')}</option>
          <option value="parent">${t('detail.relationParent')}</option>
          <option value="spouse">${t('detail.relationSpouse')}</option>
        </select>
        <button class="ef-rel-add-btn" onclick="addRelation()" title="${t('detail.addRelation')}">+</button>
      </div>
      <button class="ef-new-person-btn" onclick="toggleNewPersonSubform()">&#xff0b; ${t('detail.createNewPerson')}</button>
      <div id="ef-new-person-subform" style="display:none;margin-top:8px;padding:8px;background:#1b1b1b;border:1px solid #2b2b2b;border-radius:6px">
        <div class="edit-label" style="margin-bottom:6px">${t('detail.newPerson')}</div>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="edit-input" id="ef-np-givn" placeholder="${t('detail.firstName')}" style="flex:1">
          <input class="edit-input" id="ef-np-surn" placeholder="${t('detail.familyName')}" style="flex:1">
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <select class="edit-select" id="ef-np-sex" style="flex:1">
            <option value="U">${t('detail.sexPlaceholder')}</option>
            <option value="M">${t('detail.male')}</option>
            <option value="F">${t('detail.female')}</option>
          </select>
          <select class="edit-select" id="ef-np-type" style="flex:1">
            <option value="child">${t('detail.relationChild')}</option>
            <option value="parent">${t('detail.relationParent')}</option>
            <option value="spouse">${t('detail.relationSpouse')}</option>
          </select>
        </div>
        <div style="display:flex;gap:6px">
          <button class="edit-save-btn" style="flex:1;padding:5px" onclick="confirmNewPersonRelation()">&#x2713; ${t('detail.add')}</button>
          <button class="edit-cancel-btn" style="flex:1;padding:5px" onclick="toggleNewPersonSubform()">${t('detail.cancel')}</button>
        </div>
      </div>
    </div>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitIndiEdit()">&#x2713; ${t('detail.save')}</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">${t('detail.cancel')}</button>
    </div>`);

  _renderExistingRelations(id);
}

export function _toggleDeathFields(checked) {
  const el = document.getElementById('ef-death-fields');
  if (el) el.style.display = checked ? 'block' : 'none';
}

export function commitIndiEdit() {
  const i = state.individuals.get(state._editingId);
  if (!i) return;

  const givn = document.getElementById('ef-givn').value.trim();
  const surn = document.getElementById('ef-surn').value.trim();

  i.givn       = givn;
  i.surn       = surn;
  i.maidenName = (document.getElementById('ef-maiden')?.value || '').trim();
  // Rebuild name from parts
  i.name = (givn ? givn + ' ' : '') + (surn ? surn : '');
  if (!i.name.trim()) i.name = state._editingId.replace(/@/g, '');
  // Rebuild displayName
  i.displayName = i.name.length > 24
    ? (givn ? givn + (surn ? ' ' + surn[0] + '.' : '') : i.name.slice(0, 22) + '…')
    : i.name;

  i.sex        = document.getElementById('ef-sex').value;
  i.birth.date = _gedcomDateValue('ef-bdate');
  i.birth.plac = document.getElementById('ef-bplac').value.trim();
  i.deceased   = document.getElementById('ef-dead').checked;
  i.death.date = _gedcomDateValue('ef-ddate');
  i.death.plac = document.getElementById('ef-dplac').value.trim();
  i.death.caus = document.getElementById('ef-dcaus').value.trim();
  i.occu       = document.getElementById('ef-occu').value.trim();
  i.note       = document.getElementById('ef-note').value;

  // Re-extract birth year
  const ym = i.birth.date.match(/\b(\d{4})\b/);
  i.birthYear = ym ? +ym[1] : null;

  // ── Save inline family (marriage) edits ──
  for (const famId of i.fams) {
    const fam = state.families.get(famId);
    const sid = _safeId(famId);
    const mdateEl = document.getElementById('ef-fam-' + sid + '-mdate');
    if (fam && mdateEl) {
      if (!fam.marriages[0]) fam.marriages[0] = { date: '', plac: '', types: [] };
      fam.marriages[0].date = _gedcomDateValue('ef-fam-' + sid + '-mdate');
      fam.marriages[0].plac = (document.getElementById('ef-fam-' + sid + '-mplac')?.value || '').trim();
      fam.div       = document.getElementById('ef-fam-' + sid + '-div')?.checked ?? fam.div;
    }
  }

  // ── Process removed relationships ──
  for (const r of state._removedRelations) {
    const fam = state.families.get(r.famId);
    if (!fam) continue;
    if (r.type === 'parent') {
      // Remove this person as a child from that family
      fam.chil = fam.chil.filter(c => c !== state._editingId);
      i.famc = i.famc.filter(f => f !== r.famId);
      // Nullify the specific parent slot
      if (fam.husb === r.targetId) fam.husb = null;
      else if (fam.wife === r.targetId) fam.wife = null;
    } else if (r.type === 'spouse') {
      const spouse = state.individuals.get(r.targetId);
      fam.husb === state._editingId ? (fam.husb = null) : (fam.wife = null);
      i.fams = i.fams.filter(f => f !== r.famId);
      if (spouse) spouse.fams = spouse.fams.filter(f => f !== r.famId);
    } else if (r.type === 'child') {
      const child = state.individuals.get(r.targetId);
      fam.chil = fam.chil.filter(c => c !== r.targetId);
      if (child) child.famc = child.famc.filter(f => f !== r.famId);
    }
    // Clean up empty families
    if (!fam.husb && !fam.wife && !fam.chil.length) {
      state.families.delete(r.famId);
      for (const [, p] of state.individuals) {
        p.famc = p.famc.filter(f => f !== r.famId);
        p.fams = p.fams.filter(f => f !== r.famId);
      }
    }
  }
  state._removedRelations = [];

  // ── Process pending relationships ──
  for (const rel of state._pendingRelations) _applyRelation(state._editingId, rel);
  state._pendingRelations = [];

  const id = state._editingId;
  state._editingId = null; state._editingType = null;

  state._isNewRecord = false;
  // Unconditional, not gated on needsRebuild: saving a first person who has no
  // relations yet still means the tree is no longer empty, and it used to leave
  // the export and view buttons hidden until you happened to add a relative.
  showDataUI();
  _fullRebuildGraph({ warm: true });
  showIndiDetail(id);
}

export function _applyRelation(editingPersonId, rel) {
  const i = state.individuals.get(editingPersonId);
  const target = state.individuals.get(rel.targetId);
  if (!i || !target) return;

  if (rel.type === 'child') {
    // New person is a CHILD OF target → target is parent
    // Find an existing family where target is husb or wife that we can add the child to
    let fam = _findOrCreateFamAsParent(rel.targetId);
    if (!fam.chil.includes(editingPersonId)) fam.chil.push(editingPersonId);
    if (!i.famc.includes(fam.id)) i.famc.push(fam.id);

  } else if (rel.type === 'parent') {
    // New person is a PARENT OF target → target is child
    let fam = _findOrCreateFamAsParent(editingPersonId);
    if (!fam.chil.includes(rel.targetId)) fam.chil.push(rel.targetId);
    if (!target.famc.includes(fam.id)) target.famc.push(fam.id);

  } else if (rel.type === 'spouse') {
    // Create a new family with both as spouses
    let existingFam = null;
    // Check if they already share a family as spouses
    for (const fid of i.fams) {
      const f = state.families.get(fid);
      if (!f) continue;
      if (f.husb === rel.targetId || f.wife === rel.targetId) { existingFam = f; break; }
    }
    if (!existingFam) {
      const famId = getNextFamId();
      const newFam = {
        id: famId, husb: null, wife: null, chil: [],
        marriages: [{ date: '', plac: '', types: [] }], div: false, divDate: ''
      };
      // Assign husb/wife based on sex
      if (i.sex === 'M') { newFam.husb = editingPersonId; newFam.wife = rel.targetId; }
      else if (i.sex === 'F') { newFam.wife = editingPersonId; newFam.husb = rel.targetId; }
      else if (target.sex === 'M') { newFam.husb = rel.targetId; newFam.wife = editingPersonId; }
      else if (target.sex === 'F') { newFam.wife = rel.targetId; newFam.husb = editingPersonId; }
      else { newFam.husb = editingPersonId; newFam.wife = rel.targetId; }
      state.families.set(famId, newFam);
      if (!i.fams.includes(famId)) i.fams.push(famId);
      if (!target.fams.includes(famId)) target.fams.push(famId);
    }
  }
}

export function _findOrCreateFamAsParent(personId) {
  const person = state.individuals.get(personId);
  // Try to find an existing family where this person is a spouse
  for (const fid of (person?.fams || [])) {
    const f = state.families.get(fid);
    if (f) return f;
  }
  // Create a new family with this person as a spouse
  const famId = getNextFamId();
  const fam = {
    id: famId, husb: null, wife: null, chil: [],
    marriages: [{ date: '', plac: '', types: [] }], div: false, divDate: ''
  };
  if (person?.sex === 'F') fam.wife = personId;
  else fam.husb = personId;
  state.families.set(famId, fam);
  if (person && !person.fams.includes(famId)) person.fams.push(famId);
  return fam;
}

export function _findOrCreateFamAsChild(personId) {
  const person = state.individuals.get(personId);
  for (const fid of (person?.famc || [])) {
    const f = state.families.get(fid);
    if (f) return f;
  }
  const famId = getNextFamId();
  const fam = {
    id: famId, husb: null, wife: null, chil: [personId],
    marriages: [{ date: '', plac: '', types: [] }], div: false, divDate: ''
  };
  state.families.set(famId, fam);
  if (person && !person.famc.includes(famId)) person.famc.push(famId);
  return fam;
}

export function _makeNewIndi(givn, surn, sex, extra = {}) {
  const fullName = (givn + ' ' + surn).trim();
  const newId = getNextIndiId();
  const birthDate = extra.birthDate || '';
  // Same year-extraction as commitIndiEdit — without it birthYear stays null and
  // the graph label/position silently fall back to an *estimated* year instead
  // of the one just entered.
  const ym = birthDate.match(/\b(\d{4})\b/);
  state.individuals.set(newId, {
    id: newId, name: fullName, givn, surn, maidenName: '', sex,
    birth: { date: birthDate, plac: extra.birthPlac || '' },
    death: { date: extra.deathDate || '', plac: extra.deathPlac || '', caus: '' },
    deceased: !!extra.deceased, birthYear: ym ? +ym[1] : null, famc: [], fams: [], occu: '', note: '',
    displayName: fullName.length > 24 ? (givn || fullName.slice(0, 22) + '…') : fullName,
  });
  return newId;
}

export function _personNameSexHtml(prefix, defaultSurn = '') {
  return `<div style="display:flex;gap:6px;margin-bottom:4px">
      <input class="edit-input" id="${prefix}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
      <input class="edit-input" id="${prefix}-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr(defaultSurn)}">
    </div>
    <select class="edit-select" id="${prefix}-sex" style="width:100%;margin-bottom:4px">
      <option value="U">${t('detail.sexSelect')}</option>
      <option value="M">${t('detail.maleCap')}</option>
      <option value="F">${t('detail.femaleCap')}</option>
    </select>`;
}

export function _personVitalsHtml(prefix) {
  return `<div class="edit-label" style="font-size:11px;margin-top:4px">${t('detail.birthDate')}</div>
    ${_gedcomDateWidget(prefix + '-bdate', '')}
    <input class="edit-input" id="${prefix}-bplac" list="ef-place-dl" autocomplete="off" placeholder="${t('detail.birthPlace')}" style="margin-top:4px">
    <label class="edit-checkbox-row" style="margin-top:6px">
      <input type="checkbox" id="${prefix}-dead" onchange="document.getElementById('${prefix}-death-fields').style.display=this.checked?'block':'none'">
      ${t('detail.deceased')}
    </label>
    <div id="${prefix}-death-fields" style="display:none;margin-top:4px">
      <div class="edit-label" style="font-size:11px">${t('detail.deathDate')}</div>
      ${_gedcomDateWidget(prefix + '-ddate', '')}
      <input class="edit-input" id="${prefix}-dplac" list="ef-place-dl" autocomplete="off" placeholder="${t('detail.deathPlace')}" style="margin-top:4px">
    </div>`;
}

export function _readPersonVitals(prefix) {
  const extra = {
    birthDate: _gedcomDateValue(prefix + '-bdate'),
    birthPlac: (document.getElementById(`${prefix}-bplac`)?.value || '').trim(),
  };
  if (document.getElementById(`${prefix}-dead`)?.checked) {
    extra.deceased = true;
    extra.deathDate = _gedcomDateValue(prefix + '-ddate');
    extra.deathPlac = (document.getElementById(`${prefix}-dplac`)?.value || '').trim();
  }
  return extra;
}

export function _inlineSpouseFormHtml(prefix) {
  return `<button type="button" class="ef-toggle-new-btn" onclick="_toggleInlineSpouseForm('${prefix}')" style="margin-top:8px">&#x2795; ${t('detail.addSpouse')}</button>
    <div id="${prefix}-sp-form" style="display:none;margin-top:6px;padding:8px;background:#161616;border:1px solid #2b2b2b;border-radius:6px">
      ${_personNameSexHtml(prefix + '-sp')}
      ${_personVitalsHtml(prefix + '-sp')}
      <div class="edit-label" style="font-size:11px;margin-top:8px">${t('detail.marriageDate')}</div>
      ${_gedcomDateWidget(prefix + '-sp-mdate', '')}
    </div>`;
}

export function _toggleInlineSpouseForm(prefix) {
  const el = document.getElementById(`${prefix}-sp-form`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

export function _readInlineSpouse(prefix) {
  const givn = document.getElementById(`${prefix}-sp-givn`)?.value.trim() || '';
  const surn = document.getElementById(`${prefix}-sp-surn`)?.value.trim() || '';
  if (!givn && !surn) return null;
  const sex = document.getElementById(`${prefix}-sp-sex`)?.value || 'U';
  const marriageDate = _gedcomDateValue(`${prefix}-sp-mdate`);
  return { givn, surn, sex, marriageDate, ..._readPersonVitals(prefix + '-sp') };
}

export function _resetPersonFormFields(prefix) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set(`${prefix}-givn`, '');
  set(`${prefix}-surn`, '');
  set(`${prefix}-sex`, 'U');
  set(`${prefix}-bplac`, '');
  set(`${prefix}-dplac`, '');
  _resetGedcomDateWidget(`${prefix}-bdate`);
  _resetGedcomDateWidget(`${prefix}-ddate`);
  _resetGedcomDateWidget(`${prefix}-mdate`); // no-op unless prefix is a spouse block
  const dead = document.getElementById(`${prefix}-dead`);
  if (dead) dead.checked = false;
  const df = document.getElementById(`${prefix}-death-fields`);
  if (df) df.style.display = 'none';
}

export function _attachInlineSpouse(personId, spouse) {
  if (!spouse) return null;
  const spouseId = _makeNewIndi(spouse.givn, spouse.surn, spouse.sex, spouse);
  const person = state.individuals.get(personId);
  const famId = getNextFamId();
  const fam = { id: famId, husb: null, wife: null, chil: [], marriages: [{ date: spouse.marriageDate || '', plac: '', types: [] }], div: false, divDate: '' };
  if (person.sex === 'M') { fam.husb = personId; fam.wife = spouseId; }
  else if (person.sex === 'F') { fam.wife = personId; fam.husb = spouseId; }
  else if (spouse.sex === 'M') { fam.husb = spouseId; fam.wife = personId; }
  else if (spouse.sex === 'F') { fam.wife = spouseId; fam.husb = personId; }
  else { fam.husb = personId; fam.wife = spouseId; }
  state.families.set(famId, fam);
  person.fams.push(famId);
  state.individuals.get(spouseId).fams.push(famId);
  return spouseId;
}

export const _FAM_MARR_TYPES = [
  { val: 'civil',         label: 'marriageType.civil' },
  { val: 'kirchlich',     label: 'marriageType.kirchlich' },
  { val: 'partnerschaft', label: 'marriageType.partnerschaft' },
  { val: 'eheähnlich',   label: 'marriageType.eheaehnlich' },
];

export function showFamEditForm(id) {
  const f = state.families.get(id);
  if (!f) return;

  state._famEditRemovedChil = new Set();
  state._famEditPendingChil = [];
  state._famEditNewPartner  = { husb: null, wife: null };

  document.getElementById('detail-edit-bar').style.display = 'none';
  document.getElementById('detail-buttons').style.display = 'none';

  const dl = _buildPersonDatalist(null);
  const placeDl = _buildPlaceDatalist();
  const husbName = f.husb ? (state.individuals.get(f.husb)?.name || f.husb) : '';
  const wifeName = f.wife ? (state.individuals.get(f.wife)?.name || f.wife) : '';

  state._famEditMarriages = (f.marriages && f.marriages.length)
    ? f.marriages.map(m => ({ date: m.date || '', plac: m.plac || '', types: [...(m.types || [])] }))
    : [{ date: '', plac: '', types: [] }];

  _setPanelContent(`
    <div class="edit-section">
      <div class="edit-label">${t('detail.partner1')}</div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-husb" list="ef-husb-dl" value="${escAttr(husbName)}" placeholder="${t('detail.searchPerson')}" autocomplete="off">
        <datalist id="ef-husb-dl">${dl}</datalist>
        <button class="ef-rel-remove" onclick="document.getElementById('ef-husb').value=''" title="${t('import.unlinkTitle')}">&#x2715;</button>
      </div>
      ${_famEditNewPartnerFormHtml('husb')}
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.partner2')}</div>
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-wife" list="ef-wife-dl" value="${escAttr(wifeName)}" placeholder="${t('detail.searchPerson')}" autocomplete="off">
        <datalist id="ef-wife-dl">${dl}</datalist>
        <button class="ef-rel-remove" onclick="document.getElementById('ef-wife').value=''" title="${t('import.unlinkTitle')}">&#x2715;</button>
      </div>
      ${_famEditNewPartnerFormHtml('wife')}
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.ceremonies')}</div>
      <datalist id="ef-place-dl">${placeDl}</datalist>
      <div id="ef-fam-marr-list"></div>
      <button class="ef-toggle-new-btn" onclick="_famEditAddMarr()" style="margin-top:4px">&#x2795; ${t('detail.addCeremony')}</button>
    </div>
    <div class="edit-section">
      <label class="edit-checkbox-row" style="margin-bottom:4px">
        <input type="checkbox" id="ef-div"${f.div ? ' checked' : ''} onchange="_famEditToggleDivDate(this.checked)">
        ${t('detail.divorced')}
      </label>
      <div id="ef-div-date-row" style="display:${f.div ? 'block' : 'none'}">
        <div class="edit-label" style="margin-top:4px">${t('detail.divorceDate')}</div>
        ${_gedcomDateWidget('ef-divdate', f.divDate || '')}
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-label">${t('detail.children')}</div>
      <div id="ef-fam-chil-list"></div>
      <div class="ef-rel-add-row" style="margin-top:4px">
        <input class="edit-input" id="ef-fam-chil-search" list="ef-fam-chil-dl" placeholder="${t('detail.searchChild')}" autocomplete="off">
        <datalist id="ef-fam-chil-dl">${dl}</datalist>
        <button class="ef-rel-add-btn" onclick="_famEditAddChild()" title="${t('detail.addChildTitle')}">+</button>
      </div>
      <button class="ef-toggle-new-btn" onclick="_famEditToggleNewChild()" style="margin-top:4px">&#x2795; ${t('detail.newChild')}</button>
      <div id="ef-fam-new-child-form" style="display:none;margin-top:6px">
        <div class="ef-rel-add-row">
          <input class="edit-input" id="ef-fnc-givn" placeholder="${t('detail.firstName')}" style="flex:1">
          <input class="edit-input" id="ef-fnc-surn" placeholder="${t('detail.familyName')}" style="flex:1" value="${escAttr((f.husb && state.individuals.get(f.husb)?.surn) || (f.wife && state.individuals.get(f.wife)?.surn) || '')}">
        </div>
        <div class="ef-rel-add-row" style="margin-top:4px">
          <select class="edit-select" id="ef-fnc-sex" style="flex:1">
            <option value="U">${t('detail.sexSelect')}</option>
            <option value="M">${t('detail.maleCap')}</option>
            <option value="F">${t('detail.femaleCap')}</option>
          </select>
        </div>
        ${_personVitalsHtml('ef-fnc')}
        ${_inlineSpouseFormHtml('ef-fnc')}
        <button class="ef-rel-add-btn" onclick="_famEditCreateChild()" title="${t('detail.addChildTitle')}" style="width:100%;padding:5px;margin-top:6px">${t('detail.add')}</button>
      </div>
    </div>
    <div class="edit-form-buttons">
      <button class="edit-save-btn" onclick="commitFamEdit()">&#x2713; ${t('detail.save')}</button>
      <button class="edit-cancel-btn" onclick="cancelEdit()">${t('detail.cancel')}</button>
    </div>`);

  _famEditRenderMarriages();
  _famEditRenderChildren(f);
}

export const _FAM_PARTNER_PREFIX = { husb: 'nh', wife: 'nw' };

export function _famEditNewPartnerFormHtml(slot) {
  const p = _FAM_PARTNER_PREFIX[slot];
  return `<button class="ef-toggle-new-btn" onclick="_famEditToggleNewPartner('${slot}')" style="margin-top:4px">&#x2795; ${t('detail.newPerson')}</button>
    <div id="ef-new-${slot}-form" style="display:none;margin-top:6px">
      <div class="ef-rel-add-row">
        <input class="edit-input" id="ef-${p}-givn" placeholder="${t('detail.firstName')}" style="flex:1">
        <input class="edit-input" id="ef-${p}-surn" placeholder="${t('detail.familyName')}" style="flex:1">
      </div>
      <div class="ef-rel-add-row" style="margin-top:4px">
        <select class="edit-select" id="ef-${p}-sex" style="flex:1">
          <option value="U">${t('detail.sexSelect')}</option>
          <option value="M">${t('detail.maleCap')}</option>
          <option value="F">${t('detail.femaleCap')}</option>
        </select>
        <button class="ef-rel-add-btn" onclick="_famEditCreatePartner('${slot}')" title="${t('detail.add')}" style="width:auto;padding:0 10px">${t('detail.add')}</button>
      </div>
    </div>`;
}

export function _famEditToggleNewPartner(slot) {
  const sf = document.getElementById(`ef-new-${slot}-form`);
  if (!sf) return;
  const showing = sf.style.display !== 'none';
  sf.style.display = showing ? 'none' : 'block';
  if (!showing) document.getElementById(`ef-${_FAM_PARTNER_PREFIX[slot]}-givn`)?.focus();
}

export function _famEditCreatePartner(slot) {
  const p = _FAM_PARTNER_PREFIX[slot];
  const givn = document.getElementById(`ef-${p}-givn`)?.value.trim() || '';
  const surn = document.getElementById(`ef-${p}-surn`)?.value.trim() || '';
  const sex  = document.getElementById(`ef-${p}-sex`)?.value || 'U';
  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    const el = document.getElementById(`ef-${p}-givn`);
    if (el) { el.style.borderColor = '#787878'; setTimeout(() => { el.style.borderColor = ''; }, 1200); }
    return;
  }
  // Discard a stub from a previous "new person" click on this slot that never got saved
  if (state._famEditNewPartner[slot]) state.individuals.delete(state._famEditNewPartner[slot]);

  state._famEditNewPartner[slot] = _makeNewIndi(givn, surn, sex);

  document.getElementById(slot === 'husb' ? 'ef-husb' : 'ef-wife').value = fullName;
  document.getElementById(`ef-${p}-givn`).value = '';
  document.getElementById(`ef-${p}-surn`).value = '';
  document.getElementById(`ef-${p}-sex`).value  = 'U';
  document.getElementById(`ef-new-${slot}-form`).style.display = 'none';
}

export function _famEditRenderMarriages() {
  const el = document.getElementById('ef-fam-marr-list');
  if (!el) return;
  el.innerHTML = state._famEditMarriages.map((m, i) => {
    const typesHtml = _FAM_MARR_TYPES.map(mt =>
      `<label class="fam-type-check"><input type="checkbox" data-marr-idx="${i}" data-marr-type="${escAttr(mt.val)}"${m.types.includes(mt.val) ? ' checked' : ''}> ${escHtml(t(mt.label))}</label>`
    ).join('');
    const canRemove = state._famEditMarriages.length > 1;
    return `<div class="fam-marr-block">
      <div class="fam-marr-block-header">
        <span>${t('detail.marriageN', { n: i + 1 })}</span>
        ${canRemove ? `<button class="ef-rel-remove" onclick="_famEditRemoveMarr(${i})" title="${t('import.unlinkTitle')}">&#x2715;</button>` : ''}
      </div>
      <div class="fam-type-checks" style="margin-bottom:6px">${typesHtml}</div>
      <div class="edit-label" style="font-size:11px">${t('detail.date')}</div>
      ${_gedcomDateWidget('ef-marr-' + i + '-date', m.date)}
      <div class="edit-label" style="font-size:11px;margin-top:4px">${t('detail.place')}</div>
      <input class="edit-input" id="ef-marr-${i}-plac" list="ef-place-dl" autocomplete="off" value="${escAttr(m.plac)}" placeholder="${t('detail.place')}">
    </div>`;
  }).join('');
}

export function _famEditAddMarr() {
  _famEditSyncMarriagesFromDom();
  state._famEditMarriages.push({ date: '', plac: '', types: [] });
  _famEditRenderMarriages();
}

export function _famEditRemoveMarr(idx) {
  _famEditSyncMarriagesFromDom();
  state._famEditMarriages.splice(idx, 1);
  _famEditRenderMarriages();
}

export function _famEditSyncMarriagesFromDom() {
  state._famEditMarriages.forEach((m, i) => {
    m.date = _gedcomDateValue('ef-marr-' + i + '-date');
    m.plac = (document.getElementById('ef-marr-' + i + '-plac')?.value || '').trim();
    m.types = [...document.querySelectorAll(`input[data-marr-idx="${i}"][data-marr-type]:checked`)].map(cb => cb.dataset.marrType);
  });
}

export function _famEditToggleDivDate(checked) {
  const row = document.getElementById('ef-div-date-row');
  if (row) row.style.display = checked ? 'block' : 'none';
}

export function _famEditRenderChildren(f) {
  const el = document.getElementById('ef-fam-chil-list');
  if (!el) return;
  const existing = (f.chil || [])
    .filter(cid => !state._famEditRemovedChil.has(cid))
    .map(cid => {
      const p = state.individuals.get(cid);
      const name = p ? escHtml(p.name || cid) : escHtml(cid);
      return `<div class="ef-rel-item">
        <span class="ef-rel-name">${name}</span>
        <button class="ef-rel-remove" onclick="_famEditRemoveChild('${escJs(cid)}')" title="${t('import.unlinkTitle')}">&#x2715;</button>
      </div>`;
    });
  const pending = state._famEditPendingChil.map((c, i) => {
    return `<div class="ef-rel-item">
      <span class="ef-rel-name">${escHtml(c.name)}</span>
      <span class="ef-rel-new-badge">${t('import.newBadge')}</span>
      <button class="ef-rel-remove" onclick="_famEditRemovePending(${i})" title="${t('import.unlinkTitle')}">&#x2715;</button>
    </div>`;
  });
  el.innerHTML = (existing.length || pending.length)
    ? existing.join('') + pending.join('')
    : `<div style="color:#555;font-size:11px;padding:2px 0">${t('detail.noChildren')}</div>`;
}

export function _famEditRemoveChild(cid) {
  state._famEditRemovedChil.add(cid);
  const f = state.families.get(state._editingId);
  if (f) _famEditRenderChildren(f);
}

export function _famEditRemovePending(idx) {
  const removed = state._famEditPendingChil.splice(idx, 1)[0];
  if (removed?.isNew) state.individuals.delete(removed.id);
  const f = state.families.get(state._editingId);
  if (f) _famEditRenderChildren(f);
}

export function _famEditAddChild() {
  const inp = document.getElementById('ef-fam-chil-search');
  if (!inp) return;
  const val = inp.value.trim();
  if (!val) return;
  const id = _resolvePersonInput(val);
  if (!id) { inp.style.borderColor = '#787878'; setTimeout(() => { inp.style.borderColor = ''; }, 1200); return; }
  const f = state.families.get(state._editingId);
  if (!f) return;
  if (f.chil.includes(id) && !state._famEditRemovedChil.has(id)) return;
  if (state._famEditPendingChil.some(c => c.id === id)) return;
  const p = state.individuals.get(id);
  state._famEditPendingChil.push({ id, name: p?.name || id, isNew: false });
  state._famEditRemovedChil.delete(id);
  inp.value = '';
  _famEditRenderChildren(f);
}

export function _famEditToggleNewChild() {
  const sf = document.getElementById('ef-fam-new-child-form');
  if (!sf) return;
  sf.style.display = sf.style.display === 'none' ? 'block' : 'none';
  if (sf.style.display !== 'none') document.getElementById('ef-fnc-givn')?.focus();
}

export function _famEditCreateChild() {
  const givn = document.getElementById('ef-fnc-givn')?.value.trim() || '';
  const surn = document.getElementById('ef-fnc-surn')?.value.trim() || '';
  const sex  = document.getElementById('ef-fnc-sex')?.value || 'U';
  const fullName = (givn + ' ' + surn).trim();
  if (!fullName) {
    document.getElementById('ef-fnc-givn').style.borderColor = '#787878';
    setTimeout(() => { document.getElementById('ef-fnc-givn').style.borderColor = ''; }, 1200);
    return;
  }
  const newId = _makeNewIndi(givn, surn, sex, _readPersonVitals('ef-fnc'));
  _attachInlineSpouse(newId, _readInlineSpouse('ef-fnc'));
  state._famEditPendingChil.push({ id: newId, name: fullName, isNew: true });
  _resetPersonFormFields('ef-fnc');
  _resetPersonFormFields('ef-fnc-sp');
  document.getElementById('ef-fnc-sp-form').style.display = 'none';
  document.getElementById('ef-fam-new-child-form').style.display = 'none';
  const f = state.families.get(state._editingId);
  if (f) _famEditRenderChildren(f);
}

export function commitFamEdit() {
  const f = state.families.get(state._editingId);
  if (!f) return;

  // Marriages
  _famEditSyncMarriagesFromDom();
  f.marriages = state._famEditMarriages.filter(m => m.date || m.plac || m.types.length);
  if (!f.marriages.length) f.marriages = [{ date: '', plac: '', types: [] }];
  state._famEditMarriages = [];

  // Divorce
  f.div     = document.getElementById('ef-div').checked;
  f.divDate = f.div ? _gedcomDateValue('ef-divdate') : '';

  // Parents
  const oldHusb = f.husb;
  const oldWife = f.wife;
  const husbVal = document.getElementById('ef-husb').value.trim();
  const wifeVal = document.getElementById('ef-wife').value.trim();
  // Only re-resolve a slot from its text when it actually changed. Otherwise
  // a same-named person elsewhere in the tree ("+ New Person" stub, or just a
  // duplicate name) would win the fuzzy text search and silently bump the
  // untouched original spouse out of the family.
  const resolveSlot = (slot, val, oldId) => {
    const stubId = state._famEditNewPartner[slot];
    if (stubId && state.individuals.get(stubId)?.name === val) return stubId;
    if (oldId && state.individuals.get(oldId)?.name === val) return oldId;
    return _resolvePersonInput(val);
  };
  f.husb = husbVal ? (resolveSlot('husb', husbVal, oldHusb) || f.husb) : null;
  f.wife = wifeVal ? (resolveSlot('wife', wifeVal, oldWife) || f.wife) : null;

  // Discard inline-created partner stubs that ended up unused (field was cleared/retyped)
  for (const slot of ['husb', 'wife']) {
    const stubId = state._famEditNewPartner[slot];
    if (stubId && stubId !== f.husb && stubId !== f.wife) state.individuals.delete(stubId);
  }
  state._famEditNewPartner = { husb: null, wife: null };

  if (oldHusb !== f.husb) {
    if (oldHusb) { const p = state.individuals.get(oldHusb); if (p) p.fams = p.fams.filter(fid => fid !== state._editingId); }
    if (f.husb)  { const p = state.individuals.get(f.husb);  if (p && !p.fams.includes(state._editingId)) p.fams.push(state._editingId); }
  }
  if (oldWife !== f.wife) {
    if (oldWife) { const p = state.individuals.get(oldWife); if (p) p.fams = p.fams.filter(fid => fid !== state._editingId); }
    if (f.wife)  { const p = state.individuals.get(f.wife);  if (p && !p.fams.includes(state._editingId)) p.fams.push(state._editingId); }
  }

  // Remove children
  for (const cid of state._famEditRemovedChil) {
    f.chil = f.chil.filter(c => c !== cid);
    const c = state.individuals.get(cid);
    if (c) c.famc = c.famc.filter(fid => fid !== state._editingId);
  }

  // Add pending children
  for (const { id: cid } of state._famEditPendingChil) {
    if (!f.chil.includes(cid)) f.chil.push(cid);
    const c = state.individuals.get(cid);
    if (c && !c.famc.includes(state._editingId)) c.famc.push(state._editingId);
  }

  state._famEditRemovedChil = new Set();
  state._famEditPendingChil = [];

  const id = state._editingId;
  state._editingId = null; state._editingType = null;
  _fullRebuildGraph({ warm: true });
  showFamDetail(id);
}

export function cancelEdit() {
  const id = state._editingId;
  state._editingId = null; state._editingType = null;
  for (const rel of state._pendingRelations) {
    if (rel.isNew) state.individuals.delete(rel.targetId);
  }
  state._pendingRelations = [];
  state._removedRelations = [];
  for (const c of state._famEditPendingChil) {
    if (c.isNew) state.individuals.delete(c.id);
  }
  state._famEditPendingChil = [];
  state._famEditRemovedChil = new Set();
  state._famEditMarriages   = [];
  for (const slot of ['husb', 'wife']) {
    if (state._famEditNewPartner[slot]) state.individuals.delete(state._famEditNewPartner[slot]);
  }
  state._famEditNewPartner = { husb: null, wife: null };
  if (state._isNewRecord) {
    state._isNewRecord = false;
    // Discard the stub record that was created for this cancelled new entry
    state.individuals.delete(id);
    closeDetailPanel();
    return;
  }
  if (id) {
    if (state.individuals.has(id)) showIndiDetail(id);
    else showFamDetail(id);
  } else {
    closeDetailPanel();
  }
}

export function deleteCurrentRecord() {
  const id   = state.selectedIndiId || state._lastShownFamId;
  const type = state.selectedIndiId ? 'INDI' : 'FAM';
  if (!id) return;
  state._pendingDeleteId   = id;
  state._pendingDeleteType = type;
  const name = type === 'INDI'
    ? (state.individuals.get(id)?.name || id)
    : (() => { const f = state.families.get(id); return t('detail.family') + (f ? ': ' + [f.husb, f.wife].filter(Boolean).map(p => state.individuals.get(p)?.name || p).join(' & ') : ''); })();
  document.getElementById('delete-confirm-msg').textContent = t('detail.deleteConfirm', { name });
  document.getElementById('delete-confirm-bar').style.display = 'flex';
  document.getElementById('detail-edit-bar').style.display   = 'none';
}

export function cancelDeleteRecord() {
  state._pendingDeleteId = null; state._pendingDeleteType = null;
  document.getElementById('delete-confirm-bar').style.display = 'none';
  document.getElementById('detail-edit-bar').style.display   = 'block';
}

export function confirmDeleteRecord() {
  const id   = state._pendingDeleteId;
  const type = state._pendingDeleteType;
  state._pendingDeleteId = null; state._pendingDeleteType = null;
  document.getElementById('delete-confirm-bar').style.display = 'none';

  if (type === 'INDI') {
    // Remove person from all families
    for (const [famId, fam] of state.families) {
      if (fam.husb === id) fam.husb = null;
      if (fam.wife === id) fam.wife = null;
      fam.chil = fam.chil.filter(c => c !== id);
    }
    // Remove empty families
    for (const [famId, fam] of [...state.families]) {
      if (!fam.husb && !fam.wife && fam.chil.length === 0) {
        state.families.delete(famId);
        for (const indi of state.individuals.values()) {
          indi.famc = indi.famc.filter(f => f !== famId);
          indi.fams = indi.fams.filter(f => f !== famId);
        }
      }
    }
    state.individuals.delete(id);
  } else {
    // Remove FAM — clean up member refs
    const fam = state.families.get(id);
    if (fam) {
      for (const pid of [fam.husb, fam.wife].filter(Boolean)) {
        const p = state.individuals.get(pid);
        if (p) p.fams = p.fams.filter(f => f !== id);
      }
      for (const cid of fam.chil) {
        const c = state.individuals.get(cid);
        if (c) c.famc = c.famc.filter(f => f !== id);
      }
    }
    state.families.delete(id);
  }

  closeDetailPanel();
  _fullRebuildGraph({ warm: true });
}

export function startEdit() {
  const famId = state._lastShownFamId;
  const indiId = state.selectedIndiId;
  if (indiId && state.individuals.has(indiId)) {
    state._editingId = indiId; state._editingType = 'INDI';
    showIndiEditForm(indiId);
  } else if (famId && state.families.has(famId)) {
    state._editingId = famId; state._editingType = 'FAM';
    showFamEditForm(famId);
  }
}

export function getNextIndiId() {
  let i = 1;
  while (state.individuals.has(`@I${i}@`)) i++;
  return `@I${i}@`;
}

export function getNextFamId() {
  let i = 1;
  while (state.families.has(`@F${i}@`)) i++;
  return `@F${i}@`;
}

export function addNewPerson() {
  const id = getNextIndiId();
  state.individuals.set(id, {
    id, name: '', givn: '', surn: '', maidenName: '', sex: 'U',
    birth: { date: '', plac: '' },
    death: { date: '', plac: '', caus: '' },
    deceased: false, birthYear: null,
    famc: [], fams: [], occu: '', note: '', displayName: ''
  });
  state._isNewRecord  = true;
  state._editingId    = id;
  state._editingType  = 'INDI';
  // Filling in the first person while the canvas still insists there is no tree
  // yet reads as a contradiction. closeDetailPanel() puts it back if this is
  // cancelled; committing hides it for good.
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = 'none';
  document.getElementById('detail-name').textContent = t('detail.newPerson');
  document.getElementById('detail-edit-bar').style.display  = 'none';
  document.getElementById('detail-buttons').style.display   = 'none';
  openPanel();
  showIndiEditForm(id);
}

export function _acInit() {
  if (state._acEl) return;
  state._acEl = document.createElement('div');
  state._acEl.id = 'ac-dropdown';
  document.body.appendChild(state._acEl);
}

export function _acShow(input, items) {
  _acInit();
  state._acInput = input;
  state._acList  = items;
  state._acIdx   = -1;

  const r = input.getBoundingClientRect();
  state._acEl.style.left  = r.left + 'px';
  state._acEl.style.top   = (r.bottom + 2) + 'px';
  state._acEl.style.width = r.width + 'px';

  state._acEl.innerHTML = items.map((v, i) => {
    const label = (v && typeof v === 'object') ? v.label : v;
    return `<div class="ac-item" data-i="${i}">${escHtml(label)}</div>`;
  }).join('');
  state._acEl.querySelectorAll('.ac-item').forEach(el =>
    el.addEventListener('mousedown', e => { e.preventDefault(); _acPick(+el.dataset.i); })
  );
  state._acEl.style.display = 'block';
}

export function _acHide() {
  if (state._acEl) state._acEl.style.display = 'none';
  state._acInput = null;
  state._acIdx   = -1;
}

export function _acPick(i) {
  if (!state._acInput || i < 0 || i >= state._acList.length) return;
  const item = state._acList[i];
  state._acInput.value = (item && typeof item === 'object') ? item.value : item;
  state._acInput.dispatchEvent(new Event('input', { bubbles: true }));
  _acHide();
}

export function _acNav(dir) {
  if (!state._acEl || state._acEl.style.display === 'none') return false;
  const els = state._acEl.querySelectorAll('.ac-item');
  if (!els.length) return false;
  state._acIdx = Math.max(0, Math.min(els.length - 1, state._acIdx + dir));
  els.forEach((el, i) => el.classList.toggle('ac-active', i === state._acIdx));
  els[state._acIdx]?.scrollIntoView({ block: 'nearest' });
  return true;
}

export function _acPlaces() {
  const s = new Set();
  for (const [, i] of state.individuals) {
    if (i.birth.plac) s.add(i.birth.plac);
    if (i.death.plac) s.add(i.death.plac);
  }
  for (const [, f] of state.families) for (const m of (f.marriages || [])) if (m.plac) s.add(m.plac);
  return [...s].sort();
}

export function _acSurnames() {
  const m = new Map();
  for (const [, i] of state.individuals) {
    // Maiden names belong in this list too: they are surnames the tree already
    // knows, and they are exactly what someone is reaching for when filling in a
    // woman's birth name.
    for (const s of [i.surn, i.maidenName]) if (s) m.set(s, (m.get(s) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

// Given names, commonest first — in a genealogy the same handful come back
// generation after generation, so the top of the list is nearly always the one
// being typed.
export function _acGivenNames() {
  const m = new Map();
  for (const [, i] of state.individuals) {
    const g = (i.givn || '').trim();
    if (!g) continue;
    m.set(g, (m.get(g) || 0) + 1);
    // Offer the parts of a double name as well, so "Hans Peter" also suggests
    // "Hans" — and typing "Peter" finds it, which a whole-string match would not.
    for (const part of g.split(/\s+/)) {
      if (part && part !== g) m.set(part, (m.get(part) || 0) + 1);
    }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

export function _acOccupations() {
  const s = new Set();
  for (const [, i] of state.individuals) if (i.occu) s.add(i.occu);
  return [...s].sort();
}

export function _acAttach(input, getFn) {
  if (!input || input.dataset.acAttached) return;
  input.dataset.acAttached = '1';
  input.setAttribute('autocomplete', 'off');

  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { _acHide(); return; }
    const hits = getFn().filter(v => {
      const text = (v && typeof v === 'object') ? (v.searchText ?? v.label) : v;
      return text.toLowerCase().includes(q);
    }).slice(0, 12);
    if (hits.length) _acShow(input, hits); else _acHide();
  };

  input.addEventListener('input',  refresh);
  input.addEventListener('focus',  refresh);
  input.addEventListener('blur',   () => setTimeout(_acHide, 160));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); _acNav(+1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _acNav(-1); }
    else if (e.key === 'Enter' && state._acIdx >= 0) { e.preventDefault(); _acPick(state._acIdx); }
    else if (e.key === 'Escape') _acHide();
  });
}

// Which suggestions a field gets, decided by what the field is rather than by
// its id. Every form in the panel builds its inputs with the same suffixes —
// `-givn`, `-surn`, `-bplac` and so on — whether it is the main edit form, a
// quick-add relative, a new partner or a new child. Matching on the suffix wires
// all of them at once, and wires the next one somebody adds without their having
// to remember a list. The previous version named six specific ids, which is why
// only the main edit form ever had this.
const _AC_FIELDS = [
  ['-givn',   () => _acGivenNames()],
  ['-surn',   () => _acSurnames()],
  ['-maiden', () => _acSurnames()],
  ['-bplac',  () => _acPlaces()],
  ['-dplac',  () => _acPlaces()],
  ['-occu',   () => _acOccupations()],
];

export function _acAttachFields(root) {
  const scope = root || document.getElementById('detail-content');
  if (!scope) return;
  for (const [suffix, getFn] of _AC_FIELDS) {
    for (const input of scope.querySelectorAll(`input[id$="${suffix}"]`)) {
      _acAttach(input, getFn);
    }
  }
}

// Every form lives in the detail panel and arrives by having its HTML written
// here, so this is the one place that can promise the fields are wired.
export function _setPanelContent(html) {
  const el = document.getElementById('detail-content');
  if (!el) return;
  el.innerHTML = html;
  _acAttachFields(el);
}
