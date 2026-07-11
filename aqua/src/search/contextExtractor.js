/**
 * AQUA Web Search — Context Extractor
 *
 * Converts ranked results into the SINGLE compact block that gets injected
 * into the system prompt. This is the spec's "Do NOT dump raw search
 * results" stage — raw provider payloads never reach the LLM:
 *
 *   • Snippets are whitespace-collapsed and hard-capped (SNIPPET_MAX chars,
 *     cut at a word boundary with an ellipsis).
 *   • Exact-duplicate sentences across snippets are dropped (aggregators
 *     frequently syndicate the same paragraph).
 *   • The provider's direct answer (Tavily answer / Serper answerBox), when
 *     present, leads the block — it is usually the highest-signal text.
 *   • The whole block is fitted to SEARCH_CONTEXT_TOKENS using the same
 *     estimateTokens() the rest of the prompt pipeline uses: lowest-ranked
 *     sources are dropped first until the block fits. Sources keep their
 *     rank order and are numbered [1]..[n] so the model can cite them.
 *
 * Output shape:
 *   { block: string, tokens: number, sources: [{ n, title, url }], usedResults: object[] }
 * Empty results → { block: '', ... } — promptBuilder treats '' as absent.
 */

import { estimateTokens } from '../core/tokenManager.js';

const SNIPPET_MAX = 320;
const ANSWER_MAX  = 450;

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function clip(text, max) {
  const t = collapse(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

/** Split into rough sentences for cross-snippet dedupe. */
function sentences(text) {
  return collapse(text).split(/(?<=[.!?])\s+/).filter(s => s.length > 25);
}

function buildSourceLine(r, n, seenSentences) {
  const kept = [];
  for (const s of sentences(r.snippet)) {
    const key = s.toLowerCase();
    if (seenSentences.has(key)) continue;
    seenSentences.add(key);
    kept.push(s);
  }
  const snippet = clip(kept.join(' ') || r.snippet, SNIPPET_MAX);
  const date    = r.publishedDate ? ` — ${collapse(r.publishedDate)}` : '';
  return `[${n}] ${collapse(r.title) || hostOf(r.url)} (${hostOf(r.url)}${date})\n    ${snippet}`;
}

/**
 * @param {object[]} rankedResults  from rankResults() — already deduped/sorted/capped
 * @param {string|null} answer      provider direct answer, if any
 * @param {string} query
 * @param {{ tokenBudget: number, now?: Date }} opts
 * @returns {{ block: string, tokens: number, sources: {n:number,title:string,url:string}[], usedResults: object[] }}
 */
export function extractSearchContext(rankedResults, answer, query, { tokenBudget, now = new Date() } = {}) {
  const results = rankedResults ?? [];
  if (!results.length && !answer) {
    return { block: '', tokens: 0, sources: [], usedResults: [] };
  }

  const header = [
    '=== LIVE WEB SEARCH RESULTS ===',
    `Retrieved ${now.toISOString().slice(0, 10)} for: "${clip(query, 160)}"`,
    'These results are CURRENT — for time-sensitive facts, prefer them over prior knowledge. Cite sources as [n] when you rely on them. If they do not cover the question, say so rather than guessing.',
  ].join('\n');

  const answerLine = answer ? `Direct answer: ${clip(answer, ANSWER_MAX)}` : '';

  // Fit-to-budget: assemble with as many sources as the budget allows,
  // dropping from the bottom (lowest rank) first.
  for (let count = results.length; count >= 0; count--) {
    const seenSentences = new Set();
    const lines = results.slice(0, count).map((r, i) => buildSourceLine(r, i + 1, seenSentences));
    const block = [header, answerLine, ...(lines.length ? ['Sources:', ...lines] : [])]
      .filter(Boolean)
      .join('\n\n');
    const tokens = estimateTokens(block);

    if (tokens <= tokenBudget || count === 0) {
      const used = results.slice(0, count);
      return {
        block: (count === 0 && !answer) ? '' : block,
        tokens: (count === 0 && !answer) ? 0 : tokens,
        sources: used.map((r, i) => ({ n: i + 1, title: collapse(r.title) || hostOf(r.url), url: r.url })),
        usedResults: used,
      };
    }
  }

  /* istanbul ignore next -- loop above always returns */
  return { block: '', tokens: 0, sources: [], usedResults: [] };
}
