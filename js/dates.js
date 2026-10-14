// Forgiving date entry: whatever a person would naturally type for a date,
// turned into the GEDCOM form the file stores.
//
//   31.7.1980   31/7/1980   1980-07-31   31 July 1980   Jul 31, 1980   7.1980
//   um 1900     ca. 1900    about 1900    vor 1900      nach 1900     est 1900
//   1850-1860   zwischen 1850 und 1860    von 1900 bis 1910
//
// Anything that is not recognised is reported as such (ok: false) and the
// caller keeps the text exactly as typed — a date the file already holds in
// some odd form ("INT 1900 (census)", "1700/01") must never be mangled.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// German and English, with the spellings people actually use.
const MONTH_WORDS = {
  jan: 1, januar: 1, january: 1, jänner: 1, janner: 1,
  feb: 2, februar: 2, february: 2,
  mar: 3, mär: 3, mrz: 3, maerz: 3, märz: 3, march: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};

const MAX_YEAR = 2200;

function daysIn(month, year) {
  if (month === 2) return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function compose(d, m, y) {
  if (!y || y < 1 || y > MAX_YEAR) return null;
  if (m != null && (m < 1 || m > 12)) return null;
  if (d != null && (!m || d < 1 || d > daysIn(m, y))) return null;
  return [d != null ? String(d) : '', m ? MONTHS[m - 1] : '', String(y)].filter(Boolean).join(' ');
}

const monthOf = w => MONTH_WORDS[w.replace(/\.$/, '').toLowerCase()] || null;

/** One plain date (no prefix, no range) → "31 JUL 1980" | "JUL 1980" | "1980", or null. */
function parseOne(input) {
  const s = input.trim().replace(/[,;]+$/, '').replace(/\s+/g, ' ').toLowerCase();
  let m;
  if ((m = s.match(/^(\d{3,4})$/))) return compose(null, null, +m[1]);
  // 1980-07-31, 1980/07/31, 1980.07.31 and 1980-07
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return compose(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return compose(null, +m[2], +m[1]);
  // 31.7.1980 — day first. With slashes 7/31/1980 can only be month first, so
  // that reading is taken when the second number cannot be a month.
  if ((m = s.match(/^(\d{1,2})([./-])(\d{1,2})\2(\d{3,4})$/))) {
    let d = +m[1], mo = +m[3];
    if (m[2] === '/' && mo > 12 && d <= 12) [d, mo] = [mo, d];
    return compose(d, mo, +m[4]);
  }
  if ((m = s.match(/^(\d{1,2})[./-](\d{3,4})$/))) return compose(null, +m[1], +m[2]);
  // 31 July 1980, 31. Juli 1980, 31 Jul. 1980
  if ((m = s.match(/^(\d{1,2})\.?\s*(?:of\s+)?([a-zäöüß]+\.?),?\s*(\d{3,4})$/))) {
    const mo = monthOf(m[2]);
    return mo ? compose(+m[1], mo, +m[3]) : null;
  }
  // Jul 31, 1980 / July 31st 1980
  if ((m = s.match(/^([a-zäöüß]+\.?)\s*(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{3,4})$/))) {
    const mo = monthOf(m[1]);
    return mo ? compose(+m[2], mo, +m[3]) : null;
  }
  // July 1980
  if ((m = s.match(/^([a-zäöüß]+\.?),?\s*(\d{3,4})$/))) {
    const mo = monthOf(m[1]);
    return mo ? compose(null, mo, +m[2]) : null;
  }
  return null;
}

// Longest alternatives first; each needs a word boundary so "um" does not eat
// the front of some longer word.
const PREFIXES = [
  [/^(?:abt\.?|about|approx\.?|circa|ca\.?|c\.|um|etwa|~)(?=\s|\d|$)\s*/, 'ABT'],
  [/^(?:bef\.?|before|vor|<)(?=\s|\d|$)\s*/, 'BEF'],
  [/^(?:aft\.?|after|nach|seit|>)(?=\s|\d|$)\s*/, 'AFT'],
  [/^(?:est\.?|estimated|gesch[aä]tzt)(?=\s|\d|$)\s*/, 'EST'],
  [/^(?:cal\.?|calc\.?|calculated|berechnet)(?=\s|\d|$)\s*/, 'CAL'],
  [/^(?:from|von)\s+/, 'FROM'],
  [/^(?:to|bis|until)\s+/, 'TO'],
];

/**
 * @returns {{ ok: boolean, value: string }}  ok: understood; value: the GEDCOM
 *   date when ok, otherwise the input with its whitespace tidied.
 */
export function parseLooseDate(input) {
  const raw = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: true, value: '' };
  const bad = { ok: false, value: raw };
  const s = raw.replace(/[–—]/g, '-');
  let m;

  if ((m = s.match(/^(?:bet\.?|between|zwischen)\s+(.+?)\s+(?:and|und)\s+(.+)$/i))) {
    const a = parseOne(m[1]), b = parseOne(m[2]);
    return a && b ? { ok: true, value: `BET ${a} AND ${b}` } : bad;
  }
  if ((m = s.match(/^(?:from|von)\s+(.+?)\s+(?:to|bis)\s+(.+)$/i))) {
    const a = parseOne(m[1]), b = parseOne(m[2]);
    return a && b ? { ok: true, value: `FROM ${a} TO ${b}` } : bad;
  }
  // 1850-1860 — only for bare years, since 1980-07 is a month.
  if ((m = s.match(/^(\d{3,4})\s*-\s*(\d{3,4})$/))) {
    const a = parseOne(m[1]), b = parseOne(m[2]);
    return a && b ? { ok: true, value: `BET ${a} AND ${b}` } : bad;
  }

  const lower = s.toLowerCase();
  for (const [re, tag] of PREFIXES) {
    const hit = lower.match(re);
    if (!hit) continue;
    const rest = parseOne(s.slice(hit[0].length));
    return rest ? { ok: true, value: `${tag} ${rest}` } : bad;
  }

  const one = parseOne(s);
  return one ? { ok: true, value: one } : bad;
}
