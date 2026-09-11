/**
 * AQUA — Temporal normalisation, stage S5 (Blueprint E6/PR-7)
 *
 * Three rules, verbatim from the S5 box:
 *
 *   "last month" + asserted_at → valid_from/valid_to + precision
 *   tense → default validity (past: closed range; present: open)
 *   no anchor derivable → precision='relative', range NULL, quote kept
 *
 * THREE TIMES, NEVER ONE (L: "Three timestamps, never one")
 * ---------------------------------------------------------
 * `valid_from`/`valid_to` are when the WORLD was that way. `asserted_at` is
 * when it was SAID. They differ constantly — "I moved to Bangalore last year"
 * is asserted today about a world twelve months ago. This module turns the
 * second into the first, and is the only place allowed to do that arithmetic.
 *
 * IT NEVER INVENTS A DATE
 * -----------------------
 * The single most damaging thing a temporal normaliser can do is default to
 * "now". A claim wrongly stamped today outranks every correctly-dated claim in
 * a recency-ordered read, and the error is invisible — the row looks like a
 * confident recent fact rather than an unanchored one. So when nothing is
 * derivable the answer is `precision:'relative'` with BOTH bounds null and the
 * quote preserved, which is exactly what the blueprint's third rule asks for
 * and what the extraction prompt already tells the model.
 *
 * PRECISION IS NOT CONFIDENCE
 * ---------------------------
 * "last month" and "2026-07-15" are both real. `occurred_precision` exists so
 * they are not stored as if equally precise, and so a month-granular claim is
 * not silently read as a day-granular one. A wide range with honest precision
 * beats a narrow range with invented precision.
 *
 * EVERYTHING IS UTC. `asserted_at` is a timestamptz and "yesterday" computed
 * in local time would shift by a day for half the world's users, silently, and
 * only for some of them.
 *
 * WHAT THIS DOES NOT REPLACE
 * --------------------------
 * `timelineEngine.js`'s `parseDate` handles ISO and "Jan 5, 2026" — absolute
 * dates carrying a day — and remains the floor for the existing timeline. This
 * module is additive and has no production caller. E6/PR-12 flips writers
 * behind `AQUA_EXTRACT_V2`.
 */

/** Matches the claims schema CHECK. `none` means "no temporal content at all". */
export const PRECISION = Object.freeze(
  ['exact', 'day', 'month', 'quarter', 'year', 'relative', 'none']);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const utc = (y, m, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, m, d, h, mi, s, ms));
const iso = d => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

/** Inclusive end of a day/month/quarter/year, to the millisecond. */
const endOfDay     = (y, m, d) => utc(y, m, d, 23, 59, 59, 999);
const endOfMonth   = (y, m)    => utc(y, m + 1, 0, 23, 59, 59, 999);
const endOfQuarter = (y, q)    => endOfMonth(y, q * 3 + 2);
const endOfYear    = y         => utc(y, 11, 31, 23, 59, 59, 999);

const nothing = (reason, quote) => ({
  validFrom: null, validTo: null, precision: 'none', anchor: null, reason, quote: quote ?? null,
});

const unanchored = (reason, quote) => ({
  // The blueprint's third rule. Range NULL, precision relative, quote kept —
  // the claim is still worth storing, it just cannot be placed on a line.
  validFrom: null, validTo: null, precision: 'relative', anchor: null, reason, quote: quote ?? null,
});

const span = (from, to, precision, anchor, reason) => ({
  validFrom: iso(from), validTo: to === null ? null : iso(to), precision, anchor, reason, quote: null,
});

/**
 * Does this text describe a state that is still true?
 *
 * Present tense leaves `valid_to` OPEN; past tense closes it. Getting this
 * backwards is how "I worked at Intercom" and "I work at Nummo" end up both
 * looking current, which is the superseded-at-20% failure seen from the
 * ingest side.
 */
const PAST_TENSE = /\b(?:was|were|had|did|used\s+to|previously|formerly|left|joined|quit|moved|ended|finished|completed|stopped|shipped|launched|resigned|graduated)\b/i;
const PRESENT_TENSE = /\b(?:am|is|are|have|has|currently|these\s+days|now|still|these|work|works|live|lives|run|runs)\b/i;

export function tenseOf(text) {
  const t = String(text ?? '');
  // Past wins a tie: "I used to work at X and now work at Y" describes a
  // closed period for X, and treating the sentence as present would leave
  // both open. A closed range that should have been open is recoverable from
  // the quote; two overlapping open ranges are a contradiction nobody asked for.
  if (PAST_TENSE.test(t)) return 'past';
  if (PRESENT_TENSE.test(t)) return 'present';
  return 'unknown';
}

/**
 * Resolve a temporal expression against when it was said.
 *
 * @param {string} text        the segment or quote carrying the expression
 * @param {Date|string|number} assertedAt  when it was SAID — required for any
 *   relative expression. Without it "last month" is unresolvable, and guessing
 *   from the process clock would date a re-ingested five-year-old export to
 *   today.
 * @returns {{validFrom:string|null, validTo:string|null, precision:string,
 *            anchor:string|null, reason:string, quote:string|null}}
 */
export function normaliseTemporal(text, assertedAt = null) {
  const raw = String(text ?? '');
  if (!raw.trim()) return nothing('empty-text');

  const t = raw.toLowerCase();
  const said = assertedAt == null ? null : new Date(assertedAt);
  const haveAnchor = said instanceof Date && !Number.isNaN(said.getTime());

  // ── Absolute: full ISO date ────────────────────────────────────────────────
  const isoDate = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    const [y, m, d] = [+isoDate[1], +isoDate[2] - 1, +isoDate[3]];
    // Reject an impossible date rather than letting Date roll it over —
    // 2026-02-30 silently becomes March 2nd, which is a fact about a different
    // month.
    const probe = utc(y, m, d);
    if (probe.getUTCMonth() !== m || probe.getUTCDate() !== d) {
      return unanchored('impossible-date', isoDate[0]);
    }
    return span(probe, endOfDay(y, m, d), 'day', isoDate[0], 'iso-date');
  }

  // ── Absolute: "5 July 2026" / "July 5, 2026" ───────────────────────────────
  const named = t.match(new RegExp(`\\b(?:(\\d{1,2})\\s+)?(${MONTHS.join('|')})[a-z]*\\.?\\s*(?:(\\d{1,2})\\s*,?\\s*)?(\\d{4})\\b`));
  if (named) {
    const m = MONTHS.indexOf(named[2]);
    const day = named[1] ? +named[1] : (named[3] ? +named[3] : null);
    const y = +named[4];
    if (day) {
      const probe = utc(y, m, day);
      if (probe.getUTCMonth() !== m) return unanchored('impossible-date', named[0]);
      return span(probe, endOfDay(y, m, day), 'day', named[0], 'named-date');
    }
    return span(utc(y, m, 1), endOfMonth(y, m), 'month', named[0], 'named-month');
  }

  // ── Absolute: quarter and bare year ────────────────────────────────────────
  const quarter = t.match(/\bq([1-4])\s*,?\s*(\d{4})\b|\b(\d{4})\s*q([1-4])\b/);
  if (quarter) {
    const q = +(quarter[1] ?? quarter[4]) - 1;
    const y = +(quarter[2] ?? quarter[3]);
    return span(utc(y, q * 3, 1), endOfQuarter(y, q), 'quarter', quarter[0], 'quarter');
  }
  const year = t.match(/\b(?:in|since|during|from)\s+(\d{4})\b|\b(19|20)(\d{2})\b/);
  if (year) {
    const y = year[1] ? +year[1] : +`${year[2]}${year[3]}`;
    // "since 2024" is open-ended by construction; "in 2024" is the year.
    const open = /\bsince\s+\d{4}\b/.test(t);
    return span(utc(y, 0, 1), open ? null : endOfYear(y), 'year', String(y), open ? 'since-year' : 'year');
  }

  // ── Relative: everything below needs an anchor ─────────────────────────────
  const RELATIVE = /\b(?:yesterday|today|tomorrow|last\s+(?:week|month|quarter|year)|next\s+(?:week|month|quarter|year)|this\s+(?:week|month|quarter|year)|\d+\s+(?:day|week|month|year)s?\s+ago|a\s+(?:day|week|month|year)\s+ago)\b/;
  const rel = t.match(RELATIVE);
  if (!rel) {
    // No temporal expression at all is different from one we could not
    // resolve. `none` means the claim is timeless; `relative` means it has a
    // time we failed to place. Collapsing them would hide a parser gap as a
    // property of the data.
    return nothing('no-temporal-expression');
  }
  if (!haveAnchor) {
    return unanchored('relative-without-asserted-at', rel[0]);
  }

  const Y = said.getUTCFullYear(), M = said.getUTCMonth(), D = said.getUTCDate();
  const phrase = rel[0];

  if (phrase === 'today')     return span(utc(Y, M, D), endOfDay(Y, M, D), 'day', phrase, 'relative-day');
  if (phrase === 'yesterday') { const d = utc(Y, M, D - 1); return span(d, endOfDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), 'day', phrase, 'relative-day'); }
  if (phrase === 'tomorrow')  { const d = utc(Y, M, D + 1); return span(d, endOfDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), 'day', phrase, 'relative-day'); }

  const nAgo = phrase.match(/^(\d+|a)\s+(day|week|month|year)s?\s+ago$/);
  if (nAgo) {
    const n = nAgo[1] === 'a' ? 1 : +nAgo[1];
    const unit = nAgo[2];
    if (unit === 'day')   { const d = utc(Y, M, D - n);       return span(d, endOfDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), 'day', phrase, 'relative-ago'); }
    if (unit === 'week')  { const s = utc(Y, M, D - n * 7);   return span(s, endOfDay(Y, M, D - n * 7 + 6), 'day', phrase, 'relative-ago'); }
    if (unit === 'month') { const s = utc(Y, M - n, 1);       return span(s, endOfMonth(s.getUTCFullYear(), s.getUTCMonth()), 'month', phrase, 'relative-ago'); }
    const s = utc(Y - n, 0, 1);                                return span(s, endOfYear(Y - n), 'year', phrase, 'relative-ago');
  }

  // last/this/next + week|month|quarter|year. `utc()` normalises overflow, so
  // January's "last month" becomes December of the previous year without a
  // special case — the classic off-by-one-year bug in this code.
  const step = phrase.startsWith('last') ? -1 : phrase.startsWith('next') ? 1 : 0;
  const unit = phrase.split(/\s+/)[1];

  if (unit === 'week') {
    const s = utc(Y, M, D + step * 7);
    return span(s, endOfDay(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 6), 'day', phrase, 'relative-week');
  }
  if (unit === 'month') {
    const s = utc(Y, M + step, 1);
    return span(s, endOfMonth(s.getUTCFullYear(), s.getUTCMonth()), 'month', phrase, 'relative-month');
  }
  if (unit === 'quarter') {
    const q = Math.floor(M / 3) + step;
    const s = utc(Y, q * 3, 1);
    return span(s, endOfQuarter(s.getUTCFullYear(), Math.floor(s.getUTCMonth() / 3)), 'quarter', phrase, 'relative-quarter');
  }
  const s = utc(Y + step, 0, 1);
  return span(s, endOfYear(Y + step), 'year', phrase, 'relative-year');
}

/**
 * Apply S5 to a validated claim.
 *
 * Tense only opens or closes a range that already exists — it never creates
 * one. "I work at Nummo" with no temporal expression stays unbounded at both
 * ends, which is the honest representation of a fact with no stated period.
 */
export function applyTemporal(claim, assertedAt, opts = {}) {
  const text = opts.text ?? claim?.statementText ?? claim?.statement_text ?? '';
  const t = normaliseTemporal(text, assertedAt);
  const tense = tenseOf(text);

  let validTo = t.validTo;
  if (t.validFrom && tense === 'present') {
    // Present tense: the state is still true, so the range is open even though
    // the expression named a start.
    validTo = null;
  }

  return {
    ...claim,
    validFrom: t.validFrom,
    validTo,
    timePrecision: t.precision,
    temporal: Object.freeze({
      anchor: t.anchor, reason: t.reason, tense,
      // Kept so a later reader can tell an open range meant "still true" from
      // one that meant "we never knew when it ended".
      openedByTense: Boolean(t.validFrom && tense === 'present' && t.validTo),
    }),
  };
}
