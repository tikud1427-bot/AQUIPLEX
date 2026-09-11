/**
 * AQUA — Segmentation service (Blueprint E6/PR-1)
 *
 * Turns a user message into ordered segments, each carrying the EXACT
 * character range it occupies in the ORIGINAL text.
 *
 * WHY CHAR RANGES, AND WHY THEY ARE THE WHOLE POINT OF THIS PR
 * ------------------------------------------------------------
 * Every later stage of E6 depends on being able to point back at source text.
 * A claim's evidence is a span; validation (PR-6) checks that an extracted
 * claim is supported by the segment it came from; provenance survives into
 * retrieval only if the span survives first. An approximate range is worse
 * than none — it silently attributes a claim to text that does not say it.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `splitSentences` normalises whitespace BEFORE splitting
 * (`text.replace(/\s+/g, ' ')`), so its output strings frequently do not occur
 * in the original at all. Measured over seven ordinary message shapes, three
 * were unlocatable by `indexOf`:
 *
 *   "I work at\nNummo. …"                 → "I work at Nummo."   not found
 *   "  I work at   Nummo.  …"             → "I work at Nummo."   not found
 *   "Line one about churn\nLine two …"    → joined into one      not found
 *
 * Newlines and repeated spaces are what pasted text looks like. So this module
 * builds an explicit index map from normalised offsets back to original
 * offsets, rather than searching for the segment text and hoping.
 *
 * WHAT IS DELIBERATELY NOT REIMPLEMENTED
 * --------------------------------------
 * Sentence BOUNDARIES come from `splitSentences` and nowhere else. That
 * function carries hard-won behaviour — the abbreviation list, and the removal
 * of a capital-letter lookahead that used to collapse casual lowercase typing
 * into one run-on sentence and silently produce zero extractions. A second
 * splitter here would drift from it, and the drift would surface as claims
 * attributed to the wrong span. This module decides WHERE segments sit in the
 * original text; it does not decide where they begin and end.
 *
 * NO RANGE IS EVER GUESSED
 * ------------------------
 * A segment that cannot be located is returned with `start: null, end: null`
 * and `located: false`. Downstream stages can refuse to build evidence from an
 * unlocated segment. Returning a plausible-looking wrong offset would be the
 * more dangerous failure, because nothing downstream could detect it.
 *
 * NOT WIRED. No production caller. E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2`; until then this is a library with tests and no callers,
 * which is why it carries no flag of its own — there is no behaviour to gate.
 */
import { splitSentences } from '../../memory/sentenceParser.js';

/**
 * Normalise exactly as `splitSentences` does, while recording where every
 * character of the result came from.
 *
 * The normalisation is `replace(/\s+/g, ' ')` then `trim()`. Reproduced here
 * character by character rather than called, because `String.replace` does not
 * report offsets. The round-trip is asserted by the test suite against the
 * real `splitSentences`, so a change to the parser's normalisation shows up as
 * a failure here instead of as silently wrong spans.
 *
 * @param {string} text
 * @returns {{ cleaned: string, map: number[] }} map[i] = index in `text` of cleaned[i]
 */
export function normalizeWithMap(text) {
  const src = String(text ?? '');
  const out = [];
  const map = [];

  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      // A whitespace RUN collapses to one space, attributed to the first
      // character of the run — so a range that starts at a collapsed space
      // still points inside the original run rather than past it.
      const runStart = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      out.push(' ');
      map.push(runStart);
    } else {
      out.push(src[i]);
      map.push(i);
      i++;
    }
  }

  // trim() — drop leading/trailing single spaces the collapse produced.
  let lo = 0, hi = out.length;
  while (lo < hi && out[lo] === ' ') lo++;
  while (hi > lo && out[hi - 1] === ' ') hi--;

  return { cleaned: out.slice(lo, hi).join(''), map: map.slice(lo, hi) };
}

/**
 * Segment a message into sentences with exact original-text ranges.
 *
 * @param {string} text
 * @returns {Array<{ index: number, text: string, start: number|null, end: number|null, located: boolean }>}
 *   `text.slice(start, end)` is the original span; it may contain newlines and
 *   repeated spaces that the segment text does not.
 */
export function segmentMessage(text) {
  // Mirror the parser's type contract EXACTLY rather than coercing first.
  // `String(42)` then delegating produced one segment "42" while
  // `splitSentences(42)` produces none — a divergence caught by this module's
  // own "boundaries come from the parser" test. Coercion looks harmless and
  // is precisely how the two drift apart.
  if (typeof text !== 'string') return [];
  const src = text;
  if (!src.trim()) return [];

  const sentences = splitSentences(src);
  if (sentences.length === 0) return [];

  const { cleaned, map } = normalizeWithMap(src);

  const segments = [];
  // A cursor, not a bare indexOf. Two identical sentences in one message
  // ("Yes. Yes.") must not both resolve to the first occurrence — an
  // off-by-one-sentence provenance error is exactly the kind that survives
  // review because both spans look reasonable in isolation.
  let cursor = 0;

  for (const [index, sentence] of sentences.entries()) {
    const at = cleaned.indexOf(sentence, cursor);
    if (at === -1) {
      segments.push({ index, text: sentence, start: null, end: null, located: false });
      continue;
    }
    cursor = at + sentence.length;

    const start = map[at];
    // The END is the original offset one past the segment's LAST character —
    // not `map[at + length]`, which would be the start of whatever follows and
    // would swallow the whitespace between sentences into the span.
    const lastCleanedIdx = at + sentence.length - 1;
    const end = map[lastCleanedIdx] + 1;

    segments.push({ index, text: sentence, start, end, located: true });
  }

  return segments;
}

/**
 * Does every located segment's original span normalise back to its text?
 *
 * Exposed rather than kept in the test file so a later stage can assert the
 * invariant on real traffic before building evidence from a span.
 */
export function verifySegments(text, segments) {
  const src = String(text ?? '');
  const failures = [];
  for (const s of segments) {
    if (!s.located) { failures.push({ index: s.index, reason: 'not-located' }); continue; }
    const slice = src.slice(s.start, s.end);
    const renormalised = slice.replace(/\s+/g, ' ').trim();
    if (renormalised !== s.text) {
      failures.push({ index: s.index, reason: 'span-mismatch', expected: s.text, got: renormalised });
    }
  }
  return { ok: failures.length === 0, failures };
}
