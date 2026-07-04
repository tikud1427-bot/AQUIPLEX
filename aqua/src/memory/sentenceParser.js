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

  // Protect common abbreviations by temporarily replacing their periods
  const abbrevs = ['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp'];
  let protected_ = cleaned;
  abbrevs.forEach((a) => {
    const re = new RegExp(`\\b${a}\\.`, 'gi');
    protected_ = protected_.replace(re, (m) => m.replace('.', '•'));
  });

  // Split on sentence-ending punctuation followed by space or end
  const raw = protected_.split(/(?<=[.!?])\s+(?=[A-Z"'])/);

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