/**
 * AQUA Sentence Parser v3
 * ─────────────────────────────────────────────────────────────────────────────
 * Splits a user message into atomic sentences and detects correction intent.
 * Single pass — no repeated scans.
 */
import { detectCorrection } from './memoryConflictResolver.js';

/**
 * Split text into sentences.
 * Handles abbreviations (Mr., Dr., etc.) and common edge cases.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  // Protect abbreviations by temporarily replacing their periods.
  //
  // This list carries more weight than it used to. The split below used to
  // require the next sentence to begin with a capital, which incidentally
  // suppressed splits after "e.g." and friends. That requirement is gone (see
  // the comment on the split), so abbreviation protection is now the ONLY
  // thing standing between "e.g. the billing service" and a bogus boundary.
  const abbrevs = ['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc',
                   'inc', 'ltd', 'co', 'corp', 'approx', 'dept', 'est', 'fig'];
  // Dotted forms need every internal period protected, not just the last.
  const dotted  = ['e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k', 'ph.d'];

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let protected_ = cleaned;
  for (const a of dotted) {
    protected_ = protected_.replace(
      new RegExp(`\\b${esc(a)}\\.`, 'gi'),
      (m) => m.replace(/\./g, '•'),
    );
  }
  for (const a of abbrevs) {
    protected_ = protected_.replace(
      new RegExp(`\\b${esc(a)}\\.`, 'gi'),
      (m) => m.replace('.', '•'),
    );
  }

  // Split on sentence-ending punctuation followed by whitespace.
  //
  // This used to end with `(?=[A-Z"'])` — the next sentence had to start with
  // a capital. People do not type that way in chat. "my brother's name is
  // ananya. he is the co-founder." collapsed into ONE sentence, every
  // per-sentence extraction pattern was then matched against the run-on
  // string, and the whole message silently produced nothing. Lowercase input
  // is normal input, not malformed input.
  //
  // The lookahead was never what protected decimals — "3.14" has no
  // whitespace after the period, so `\s+` already excludes it. Abbreviations
  // are handled above. Removing it costs nothing and un-breaks casual typing.
  const raw = protected_.split(/(?<=[.!?])\s+/);

  // Restore protected periods and trim
  return raw
    .map((s) => s.replace(/•/g, '.').trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a message into sentences + correction metadata.
 * Single entry point for the pipeline.
 *
 * @param {string} message
 * @returns {{
 *   sentences: string[],
 *   isCorrection: boolean,
 *   correctionPhrase: string | undefined,
 *   originalMessage: string,
 *   ts: number,
 * }}
 */
export function parseMessage(message) {
  const ts = Date.now();
  if (!message || typeof message !== 'string') {
    return { sentences: [], isCorrection: false, correctionPhrase: undefined, originalMessage: '', ts };
  }
  const trimmed = message.trim();
  const { isCorrection, phrase } = detectCorrection(trimmed);
  const sentences = splitSentences(trimmed);
  return {
    sentences,
    isCorrection,
    correctionPhrase: phrase,
    originalMessage: trimmed,
    ts,
  };
}