/**
 * AQUA Evidence Retrieval — Phase 2 (interfaces, not reasoning)
 *
 * "Search results should know where the answer came from." This module is
 * the evidence-aware retrieval surface the reasoning phases will consume:
 * given an owner + query, return FACTS with their hydrated Evidence and a
 * ready-to-render citation — instead of anonymous text chunks.
 *
 * What this phase ships: the retrieval INTERFACE and the ranking that
 * prioritizes grounded, higher-confidence evidence. What it does NOT do:
 * cross-file correlation, timeline reasoning, contradiction resolution, or
 * answer synthesis — those are the next phase. This is the substrate they
 * stand on: every result already carries provenance, so a reasoning engine
 * literally cannot produce an unattributable claim from it.
 *
 * Retrieval is lexical here (fact statements + entities) and deliberately
 * cheap; it composes with the existing semantic lanes (fileMemory chunk
 * scores, semanticFactScores) at the call site — hybrid grounded retrieval
 * = semantic candidates ∪ these fact hits, ranked by confidence. No new
 * embedding path, no new dependency.
 */
import { formatCitation, normalizeStatement } from './evidence.js';

/**
 * Rank an owner's grounded facts against a query and attach provenance.
 *
 * @param {object} store  - evidenceStore module (injected for tests)
 * @param {string} ownerId
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=10]
 * @param {number} [opts.minConfidence=0] - drop facts whose best evidence is weaker than this
 * @returns {Array<{ fact, evidence, citations, confidence, score }>}
 */
export function retrieveGroundedFacts(store, ownerId, query, { limit = 10, minConfidence = 0 } = {}) {
  if (!query) return [];
  const terms = tokenize(query);
  if (!terms.length) return [];

  const facts = store.listFacts(ownerId, { limit: 100000 });
  const scored = [];

  for (const fact of facts) {
    const hay = normalizeStatement(`${fact.statement} ${(fact.entities ?? []).join(' ')}`);
    let hits = 0;
    for (const t of terms) if (hay.includes(t)) hits += 1;
    if (!hits) continue;

    const evidence = store.evidenceForFact(ownerId, fact.id);
    const bestConf = evidence.length ? Math.max(...evidence.map(e => e.confidence)) : fact.confidence;
    if (bestConf < minConfidence) continue;

    // Rank: term coverage first, then evidence strength (grounded + confident wins).
    const coverage = hits / terms.length;
    scored.push({
      fact,
      evidence,
      citations: evidence.map(formatCitation),
      confidence: bestConf,
      score: coverage * 0.7 + bestConf * 0.3,
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Provenance for a specific fact — the "explain this answer" primitive a
 * reasoning engine calls after it decides to use a fact.
 */
export function explainFact(store, ownerId, factId) {
  const fact = store.getFact(ownerId, factId);
  if (!fact) return null;
  const evidence = store.evidenceForFact(ownerId, factId);
  return {
    statement: fact.statement,
    confidence: fact.confidence,
    citations: evidence.map(formatCitation),
    evidence: evidence.map(e => ({
      citation: formatCitation(e),
      method: e.extractionMethod,
      confidence: e.confidence,
      location: e.location,
      sourceFileName: e.sourceFileName,
    })),
  };
}

/**
 * All grounded facts for one file, newest-first — powers "what do we know
 * from Financial_Report.pdf, and how do we know it?".
 */
export function factsWithProvenanceForFile(store, ownerId, ukoId, { limit = 100 } = {}) {
  return store.factsForFile(ownerId, ukoId).slice(0, limit).map(fact => ({
    fact,
    citations: store.evidenceForFact(ownerId, fact.id).map(formatCitation),
    confidence: fact.confidence,
  }));
}

function tokenize(q) {
  return [...String(q).toLowerCase().matchAll(/[a-z0-9][\w\-.]{1,}/g)]
    .map(m => m[0])
    .filter(t => t.length > 2);
}
