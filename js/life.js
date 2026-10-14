// Pieces of the detail panel that are built from a person's record rather than
// shown as stored: initials, the one-line summary, the life timeline and the
// data-issue banner.
import { state } from './state.js';
import { escHtml, escJs } from './gedcom-io.js';
import { issuesFor } from './check.js';

const yearOf = s => { const m = String(s || '').match(/\b(\d{4})\b/); return m ? +m[1] : null; };
const shortName = id => state.individuals.get(id)?.displayName || state.individuals.get(id)?.name || id;

export function initials(name) {
  const w = String(name || '').replace(/[()"'“”]/g, ' ').split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  const a = w[0][0], b = w.length > 1 ? w[w.length - 1][0] : '';
  return (a + b).toUpperCase();
}

/** "Born 31 JUL 1980 · Godric's Hollow" — or the death, or nothing. */
export function subline(indi) {
  const b = [indi.birth?.date, indi.birth?.plac].filter(Boolean).join(' · ');
  if (b) return t('life.born') + ' ' + b;
  const d = [indi.death?.date, indi.death?.plac].filter(Boolean).join(' · ');
  return d ? t('life.died') + ' ' + d : '';
}

export function setDetailHeader(name, sub) {
  const av = document.getElementById('detail-avatar');
  if (av) av.textContent = initials(name);
  const s = document.getElementById('detail-sub');
  if (s) s.textContent = sub || '';
}

/** [{ year, label, sub }] in the order they happened. Undated events keep their
 *  natural place: birth first, death last, the rest where the record has them. */
export function lifeEvents(id) {
  const indi = state.individuals.get(id);
  if (!indi) return [];
  const ev = [];
  const place = p => p ? escHtml(p) : '';
  if (indi.birth?.date || indi.birth?.plac) {
    ev.push({ rank: 0, year: yearOf(indi.birth.date), when: indi.birth.date, label: t('life.born'), sub: place(indi.birth.plac) });
  }
  for (const famId of indi.fams || []) {
    const f = state.families.get(famId);
    if (!f) continue;
    const spId = f.husb === id ? f.wife : f.husb;
    const m = f.marriages?.[0];
    if (m?.date || m?.plac) {
      const who = spId ? ` <span class="clickable-name" onclick="showIndiDetail('${escJs(spId)}')">${escHtml(shortName(spId))}</span>` : '';
      ev.push({ rank: 1, year: yearOf(m.date), when: m.date, label: t('life.married') + who, sub: place(m.plac) });
    }
    if (f.div) ev.push({ rank: 1, year: yearOf(f.divDate), when: f.divDate, label: t('life.divorced'), sub: '' });
    for (const cid of f.chil || []) {
      const c = state.individuals.get(cid);
      if (!c) continue;
      const cy = c.birthYear || yearOf(c.birth?.date);
      if (!cy) continue;
      ev.push({ rank: 2, year: cy, when: c.birth?.date || String(cy),
        label: t('life.child') + ` <span class="clickable-name" onclick="showIndiDetail('${escJs(cid)}')">${escHtml(shortName(cid))}</span>`,
        sub: place(c.birth?.plac) });
    }
  }
  if (indi.deceased || indi.death?.date || indi.death?.plac) {
    const sub = [place(indi.death?.plac), indi.death?.caus ? escHtml(indi.death.caus) : ''].filter(Boolean).join(' · ');
    ev.push({ rank: 9, year: yearOf(indi.death?.date), when: indi.death?.date || t('tooltip.unknownDate'), label: t('life.died'), sub });
  }
  // Dated events sort by year; a stable sort keeps the rest in record order.
  return ev.map((e, i) => ({ ...e, i }))
    .sort((a, b) => {
      if (a.year != null && b.year != null && a.year !== b.year) return a.year - b.year;
      return a.rank - b.rank || a.i - b.i;
    });
}

export function lifeTimelineHtml(id) {
  const ev = lifeEvents(id);
  if (!ev.length) return '';
  return `<section class="detail-section life">
    <div class="detail-label">${escHtml(t('life.title'))}</div>
    <ol class="life-list">${ev.map(e => `<li>
      <div class="life-head"><span class="life-when">${escHtml(e.when || '—')}</span><span class="life-what">${e.label}</span></div>
      ${e.sub ? `<div class="life-sub">${e.sub}</div>` : ''}
    </li>`).join('')}</ol>
  </section>`;
}

export function issueBannerHtml(id) {
  const list = issuesFor(id);
  if (!list.length) return '';
  const shown = list.slice(0, 3);
  return `<div class="detail-issues" role="note">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18v.01"/></svg>
    <div>${shown.map(i => `<div>${escHtml(i.text)}</div>`).join('')}
    ${list.length > shown.length ? `<div class="detail-issues-more">${escHtml(t('life.moreIssues', { n: list.length - shown.length }))}</div>` : ''}
    <a href="#" onclick="event.preventDefault();openCheckTool()">${escHtml(t('life.openCheck'))}</a></div>
  </div>`;
}
