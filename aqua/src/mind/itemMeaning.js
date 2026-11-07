/**
 * Is a Mind item about the question BY MEANING? (C9, 2026-11-07)
 *
 * The Mind's question-aware selection (mindRetriever.js) is lexical: a goal or
 * blocker is kept on a targeted question only when it shares a word with it.
 * "How far is a 21 km race?" therefore lost "run a half marathon in October".
 *
 * Production already scores the question against every statement the user made
 * (Brain.canonicalSemanticScores → PIC Lane 6), and PIC trusts those scores
 * under one measured rule (pic/denseAdmission.js). A Mind item keeps no link to
 * the statement that stated it, so it could not use them. This module makes the
 * link at read time, by provenance:
 *
 *   an item is stated by the owner's LIVE statements (not archived — which is
 *   what a forget does —, not superseded, not disputed) that contain every
 *   content word of the item's text;
 *   it is about the question by meaning when one of those statements is among
 *   the trusted dense matches (cosine ≥ DENSE_LANE_FLOOR, top DENSE_LANE_MAX,
 *   corpus ≥ DENSE_MIN_CORPUS, margin ≥ DENSE_MARGIN_FLOOR).
 *
 * Meaning decides ABOUT, never CURRENT: the caller offers only items it would
 * show anyway (active goals, live working items), so a completed, abandoned or
 * forgotten item cannot come back by similarity. No vectors, no provider, no
 * I/O here: the scores are the caller's, the statements are passed in.
 *
 * Scores in tests are injected, deterministic test inputs — never described as
 * model embeddings.
 */
import { DENSE_LANE_FLOOR, DENSE_LANE_MAX, denseAdmission } from '../pic/denseAdmission.js';
import { contentTerms } from '../pic/questionShape.js';
import { stem } from '../understanding/stateTransition.js';

const termsOf = text => new Set(contentTerms(String(text ?? '')).map(stem).filter(t => t.length >= 2 && !/^\d+$/.test(t)));
const live = f => f && !f.archived && !f.supersededBy && !f.disputed && typeof f.statement === 'string';

/**
 * @param {object} args
 * @param {Map<string, number>|null} args.claimScores  evidence-store fact id → cosine for this question
 * @param {Array<object>} args.statements               the owner's evidence-store facts (ES.listFacts)
 * @returns {{ meaningOf: ((text: string) => ({ statementId: string, cosine: number } | null)) | null,
 *             stats: { reason: string, margin: number|null, corpus: number, matches: number } }}
 *   meaningOf is null when the signal is absent or not trusted — the caller then
 *   behaves exactly as without it.
 */
export function buildMeaningOf({ claimScores = null, statements = [] } = {}) {
  const adm = denseAdmission(claimScores);
  const stats = { reason: adm.reason, margin: adm.margin, corpus: adm.corpus, matches: 0 };
  if (!adm.trusted) return { meaningOf: null, stats };
  // Only this owner's live statements: a score for an id the owner does not hold
  // (another owner's, a deleted one) has nothing to attach to and is ignored.
  const byId = new Map(statements.filter(live).map(f => [String(f.id), f]));
  const matches = [...adm.trusted.entries()]
    .filter(([id, c]) => byId.has(String(id)) && Number.isFinite(c) && c >= DENSE_LANE_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, DENSE_LANE_MAX)
    .map(([id, cosine]) => ({ statementId: String(id), cosine, terms: termsOf(byId.get(String(id)).statement) }));
  stats.matches = matches.length;
  if (!matches.length) return { meaningOf: null, stats };
  const meaningOf = text => {
    const want = termsOf(text);
    if (!want.size) return null;
    const hit = matches.find(m => [...want].every(t => m.terms.has(t)));
    return hit ? { statementId: hit.statementId, cosine: hit.cosine } : null;
  };
  return { meaningOf, stats };
}
