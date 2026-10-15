/**
 * AQUA — deadline dates for the proactive layer (Phase 4, 2026-10-06).
 *
 * The World Model stores a deadline the way the user said it: a time object
 * when S5 could anchor it ("October 24, 2026", ISO), otherwise the literal
 * ("May 5", "January 15"). S5 rightly refuses to invent a year. A proactive
 * trigger needs a DAY, so this module — and only for this purpose — resolves a
 * yearless month-day against WHEN IT WAS SAID: the first occurrence on or after
 * (asserted_at − 7 days). "Due May 5" said in April is this May; said on May 3
 * it is still this May; said in June it is next May. Never against "now", so a
 * re-read of an old claim cannot drift.
 *
 * Month-only or vague expressions ("in October", "next spring", "by
 * September") are NOT resolved: a trigger acting on an invented day is exactly
 * the insufficient-evidence interruption the policy exists to prevent.
 *
 * Pure. UTC throughout (temporalNormaliser's rule).
 */
import { normaliseTemporal } from '../understanding/temporalNormaliser.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MONTH_RE = MONTHS.map(m => `${m}|${m.slice(0, 3)}`).join('|');
const MONTH_DAY = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})`, 'i');
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?!\\s*,?\\s*\\d{4})`, 'i');
const LOOKBACK_MS = 7 * 86_400_000;

const monthIndex = name => MONTHS.findIndex(m => m.startsWith(String(name).toLowerCase().slice(0, 3)));

/**
 * @param {{object?:object, assertedAt?:any}} claim  a canonical claim (read-model shape)
 * @returns {{date:Date, precision:'day', how:string}|null}
 */
export function deadlineDate(claim) {
  const o = claim?.object ?? {};
  // 1. A time object S5 anchored.
  const t = o.kind === 'time' ? o.from : (o.time ?? null);
  if (t) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return { date: startOfDay(d), precision: 'day', how: 'time-object' };
  }
  const text = String(o.kind === 'literal' ? o.value : (o.literal ?? o.value ?? '')).trim();
  if (!text) return null;
  const asserted = claim?.assertedAt ? new Date(claim.assertedAt) : null;
  // 2. An explicit dated literal ("October 24, 2026", "2026-11-03").
  if (asserted && !Number.isNaN(asserted.getTime())) {
    const n = normaliseTemporal(text, asserted);
    if (n?.precision === 'day' && n.validFrom) return { date: startOfDay(new Date(n.validFrom)), precision: 'day', how: n.reason };
  }
  // 3. A yearless month-day, resolved against when it was said.
  if (!asserted || Number.isNaN(asserted.getTime())) return null;
  const md = MONTH_DAY.exec(text);
  const dm = md ? null : DAY_MONTH.exec(text);
  const month = md ? monthIndex(md[1]) : dm ? monthIndex(dm[2]) : -1;
  const day = Number(md ? md[2] : dm ? dm[1] : NaN);
  if (month < 0 || !(day >= 1 && day <= 31)) return null;
  const floor = asserted.getTime() - LOOKBACK_MS;
  for (let y = asserted.getUTCFullYear() - 1; y <= asserted.getUTCFullYear() + 1; y++) {
    const d = new Date(Date.UTC(y, month, day));
    if (d.getUTCMonth() !== month) continue;                    // Feb 30 etc.
    if (d.getTime() >= floor) return { date: d, precision: 'day', how: 'yearless-next-occurrence' };
  }
  return null;
}

export function startOfDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Whole days from `now` to `date` (negative once passed). */
export function daysUntil(date, now) {
  return Math.round((startOfDay(date).getTime() - startOfDay(new Date(now)).getTime()) / 86_400_000);
}
