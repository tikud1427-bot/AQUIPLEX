/**
 * AQUA Retrieval Intelligence — Persistent Intelligence Core (Phase 4)
 *
 * "The system should retrieve KNOWLEDGE instead of files." Before this
 * module, chat retrieval was three disconnected lanes (memory facts, file
 * chunks, attachment text) and the Phase-3 graph/query layer had ZERO
 * consumers. This is the unification: one call composes
 *
 *   grounded facts        evidenceRetrieval (lexical, provenance-bearing)
 *   connected entities    reasoning graph (canonical, alias-aware)
 *   connected facts       one-hop `about` edges from matched entities —
 *                         facts the lexical lane MISSED but the graph links
 *   timeline context      cross-file ordered events, only on temporal cues
 *   reasoning history     per-fact feedback boost (reasoningFeedback)
 *   lifecycle awareness   archived/superseded facts excluded; stale and
 *                         disputed downweighted; trusted boosted
 *
 * into ONE ranked item list + ONE budgeted prompt block. Every item keeps
 * its provenance (citations, source files, kind observed|derived) — the
 * grounding contract survives composition.
 *
 * Side effect (the lifecycle earning its keep): facts that make the final
 * cut get a `retrieved` lifecycle touch — retrieval frequency is what
 * consolidation's stale/promote logic reads.
 *
 * Pure over injected deps; no model, no I/O of its own; fail-open at the
 * PIC facade.
 */
import { transition } from './knowledgeLifecycle.js';
import { reasoningBoost } from './reasoningFeedback.js';

const TEMPORAL_CUE = /\b(when|before|after|timeline|first|then|earlier|later|history|sequence|order of|chronolog)\b/i;

const W_TRUSTED  = 0.10;
const W_DISPUTED = -0.20;
const W_STALE    = -0.10;
const W_GRAPH    = 0.05;    // facts reached through the graph, not lexically

/**
 * @param {object} deps - { evidenceStore, evidenceRetrieval, graph, queryEngine }
 * @param {string} ownerId
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=8]        max knowledge items
 * @param {number} [opts.charBudget=1600] hard cap on the rendered block
 * @returns {{ items: Array, block: string, stats: object }}
 */
export function retrieveKnowledge(deps, ownerId, query, { limit = 8, charBudget = 1600 } = {}) {
  const { evidenceStore: ES, evidenceRetrieval: ER, graph: G, queryEngine: QE } = deps;
  const started = Date.now();
  const empty = { items: [], block: '', stats: { facts: 0, entities: 0, connectedFacts: 0, timelineEvents: 0, reusedSignals: 0, durationMs: 0 } };
  if (!ownerId || !query) return empty;

  // ── Lane 1: grounded facts (lexical + provenance) ──────────────────────────
  const factHits = ER.retrieveGroundedFacts(ES, ownerId, query, { limit: limit * 2 });

  // ── Lane 2: entities matching the query (canonical, alias-aware) ───────────
  // Token-based: a whole user message never substring-matches an entity
  // label, so we match entity labels/aliases against the query's tokens.
  const qTokens = tokenize(query);
  const entityMatches = [];
  if (qTokens.length) {
    for (const n of G.nodesByType(ownerId, 'entity')) {
      const names = [n.label, ...(n.data?.aliases ?? [])].map(v => String(v).toLowerCase());
      const hit = names.some(name => qTokens.some(t => name.includes(t)));
      if (!hit) continue;
      const files = G.neighbors(ownerId, n.id, { type: 'file', edgeType: 'mentions' })
        .map(({ node }) => ({ file: node.label }));
      entityMatches.push({
        entity: n.label, entityType: n.data?.entityType,
        aliases: n.data?.aliases ?? [],
        resolutionConfidence: n.data?.resolutionConfidence,
        files, _nodeId: n.id, _fileCount: files.length,
      });
    }
    entityMatches.sort((a, b) => b._fileCount - a._fileCount);
    entityMatches.splice(3);
  }

  // ── Lane 3: connected facts — one hop over `about` edges from matched
  //    entities; the graph surfacing what lexical matching missed ────────────
  const seenFactIds = new Set(factHits.map(h => h.fact.id));
  const connected = [];
  for (const em of entityMatches) {
    for (const { node } of G.neighbors(ownerId, em._nodeId, { type: 'fact', edgeType: 'about' })) {
      const factId = node.id.replace(/^fact:/, '');
      if (seenFactIds.has(factId)) continue;
      const fact = ES.getFact(ownerId, factId);
      if (!fact) continue;
      seenFactIds.add(factId);
      const evidence = ES.evidenceForFact(ownerId, factId);
      connected.push({
        fact, evidence,
        citations: evidence.map(deps.formatCitation),
        confidence: fact.confidence,
        score: (fact.confidence ?? 0.5) * 0.5 + W_GRAPH,
        via: `graph: about ${em.entity}`,
      });
    }
  }

  // ── Rank: base score ± lifecycle flags ± reasoning feedback ────────────────
  const scored = [...factHits, ...connected]
    .filter(h => !h.fact.archived && !h.fact.supersededBy)
    .map(h => {
      let s = h.score;
      if (h.fact.trusted)  s += W_TRUSTED;
      if (h.fact.disputed) s += W_DISPUTED;
      if (h.fact.stale)    s += W_STALE;
      const boost = reasoningBoost(ownerId, h.fact.id);
      s += boost;
      return { ...h, score: s, feedbackBoost: boost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // ── Lane 4: timeline, only when the question is temporal ───────────────────
  let timelineEvents = [];
  if (TEMPORAL_CUE.test(query)) {
    const tl = QE.timelineAcross(ES, ownerId);
    timelineEvents = tl.ordered.slice(0, 5);
  }

  // ── Lifecycle touch: these facts were retrieved ────────────────────────────
  for (const h of scored) transition(ownerId, `fact:${h.fact.id}`, 'retrieved', { reason: 'pic-retrieval' });

  // ── Items (structured, for callers) + block (for the prompt) ───────────────
  const items = [
    ...scored.map(h => ({
      kind: 'fact', epistemic: 'observed',
      id: h.fact.id, statement: h.fact.statement,
      confidence: h.fact.confidence,
      trusted: !!h.fact.trusted, disputed: !!h.fact.disputed, stale: !!h.fact.stale,
      citations: h.citations, via: h.via ?? 'lexical', score: round3(h.score),
    })),
    ...entityMatches.map(em => ({
      kind: 'entity', epistemic: 'derived',
      entity: em.entity, entityType: em.entityType,
      aliases: em.aliases, files: em.files.map(f => f.file),
      resolutionConfidence: em.resolutionConfidence, nodeId: em._nodeId,
    })),
    ...timelineEvents.map(e => ({
      kind: 'event', epistemic: 'derived',
      statement: e.statement, timestamp: e.timestamp, certainty: e.certainty, order: e.order,
    })),
  ];

  const block = renderBlock({ scored, entityMatches, timelineEvents, charBudget });

  const stats = {
    facts: scored.length,
    entities: entityMatches.length,
    connectedFacts: scored.filter(h => String(h.via ?? '').startsWith('graph:')).length,
    timelineEvents: timelineEvents.length,
    reusedSignals: scored.filter(h => h.feedbackBoost !== 0).length,
    durationMs: Date.now() - started,
  };
  return { items, block, stats };
}

// ── Prompt block (budgeted; provenance visible; epistemic tiers labeled) ─────

function renderBlock({ scored, entityMatches, timelineEvents, charBudget }) {
  if (!scored.length && !entityMatches.length && !timelineEvents.length) return '';
  const lines = ['── CONNECTED KNOWLEDGE (verified across your files) ──'];

  for (const h of scored) {
    const cite = h.citations?.[0] ? ` [${h.citations[0]}]` : '';
    const flags = [h.fact.trusted && 'trusted', h.fact.disputed && 'disputed — treat as contested', h.fact.stale && 'stale']
      .filter(Boolean).join(', ');
    lines.push(`• ${h.fact.statement}${cite} (confidence ${fmt(h.fact.confidence)}${flags ? `; ${flags}` : ''})`);
  }
  for (const em of entityMatches) {
    const aka = em.aliases?.length ? ` (a.k.a. ${em.aliases.slice(0, 3).join(', ')})` : '';
    const files = em.files.slice(0, 4).map(f => f.file).join(', ');
    lines.push(`• Entity: ${em.entity}${aka} — appears in ${files}`);
  }
  if (timelineEvents.length) {
    lines.push('• Timeline (cross-file, derived):');
    for (const e of timelineEvents) {
      lines.push(`   ${e.order + 1}. ${e.timestamp ? `[${e.timestamp}] ` : ''}${e.statement.slice(0, 110)} (${e.certainty})`);
    }
  }
  lines.push('Use the knowledge above with its citations; disputed items must be presented as contested, never as settled.');

  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > charBudget) break;
    out += (out ? '\n' : '') + l;
  }
  return out;
}

const fmt = (n) => (n == null ? '?' : Number(n).toFixed(2));

function tokenize(q) {
  return [...String(q).toLowerCase().matchAll(/[a-z0-9][\w\-.]{1,}/g)]
    .map(m => m[0])
    .filter(t => t.length > 2);
}
const round3 = (n) => Math.round(n * 1000) / 1000;
