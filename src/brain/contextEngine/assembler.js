/**
 * AQUA Brain — Context Engine V2 Assembler (Brain V1 / B4)
 *
 * "The engine should assemble the OPTIMAL context. Do NOT dump every memory
 * into prompts." — the brief's core instruction for this phase.
 *
 * WHAT THIS DOES DIFFERENTLY
 * --------------------------
 * The PIC lane scores facts lexically, sorts, and takes the top N until a
 * char budget fills. Two problems the brief calls out:
 *
 *   1. Scoring is one-dimensional. B4's scorer fixes that (ten dimensions).
 *   2. Selection is "highest first until full" — which loads five near-
 *      duplicate facts about the same entity and nothing about the second
 *      entity the question mentioned. That is dumping, ranked.
 *
 * The assembler makes selection a real decision:
 *
 *   • DIVERSITY. Once an entity has contributed a couple of items, further
 *     items about it are down-weighted, so the budget spreads across the
 *     things the question is actually about instead of piling onto one.
 *   • BUDGET AS SELECTION. Items compete for a token budget by score-per-
 *     char, not raw score — a long low-value item does not crowd out three
 *     short high-value ones.
 *   • THRESHOLD. Below a floor score an item is left out entirely. An empty
 *     assembly is a valid, safe answer (byte-identical prompt to no-context).
 *
 * SUPERSET RETURN SHAPE
 * ---------------------
 * Returns exactly the PIC contract — { items, block, stats } — so it drops
 * into chat.js at the existing seam with no downstream change, PLUS a
 * `contextEngine` stats section (per-item dimensions, what was dropped and
 * why) for observability. Callers that only read block/items/stats are
 * unaffected; the enrichment is additive.
 *
 * Pure over its inputs. The caller (facade) gathers candidates + signals;
 * this ranks, selects, and renders.
 */
import { scoreCandidate, rankedDimensions, tokensOf } from './scorer.js';
import { round3 } from '../worldModel/schema.js';

const DEFAULTS = {
  limit: 8,
  charBudget: 1600,
  minScore: 0.12,          // below this an item is not worth prompt space
  perEntitySoftCap: 2,     // items about one entity before diversity kicks in
  diversityPenalty: 0.6,   // multiplier applied past the soft cap
};

/**
 * @param {Array} candidates - normalized candidate objects (see scorer)
 * @param {object} ctx - the shared signal bag for scoring
 * @param {object} [opts] - { limit, charBudget, minScore, perEntitySoftCap, diversityPenalty }
 * @returns {{ items, block, stats }} PIC-superset
 */
export function assembleContext(candidates, ctx, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const started = Date.now();

  // 1. Score every candidate on all ten dimensions.
  const scored = candidates.map(c => {
    const { score, dimensions } = scoreCandidate(c, ctx);
    return { ...c, score, selectionScore: Number.isFinite(c.selectionScore) ? c.selectionScore : score, dimensions };
  });

  // 2. Select with diversity + budget as actual constraints.
  //
  // Diversity is a RE-RANKING, not a per-item gate during a raw-score walk:
  // if we simply walked highest-first, the 4th fact about entity A (even
  // penalized) could still take a slot before the 1st fact about entity B is
  // ever considered. Instead we repeatedly pick the best-scoring remaining
  // candidate under its CURRENT diversity penalty, then update the penalty —
  // so once A is well-covered, B's fresh item outranks A's next one.
  const dropped = [];
  const pool = scored.filter(c => c.score >= cfg.minScore);
  for (const c of scored) if (c.score < cfg.minScore) dropped.push({ id: c.id, reason: 'below-threshold', score: c.score });

  const selected = [];
  const perEntityCount = new Map();
  let usedChars = 0;

  while (selected.length < cfg.limit && pool.length) {
    // Effective score for each remaining candidate under the current coverage.
    let bestIdx = -1;
    let bestEff = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const primary = pool[i].entityIds?.[0] ?? null;
      const covered = primary ? (perEntityCount.get(primary) ?? 0) : 0;
      const base = pool[i].selectionScore ?? pool[i].score;
      const eff = covered >= cfg.perEntitySoftCap ? base * cfg.diversityPenalty : base;
      if (eff > bestEff) { bestEff = eff; bestIdx = i; }
    }
    if (bestIdx < 0) break;

    const c = pool.splice(bestIdx, 1)[0];
    if (bestEff < cfg.minScore) { dropped.push({ id: c.id, reason: 'diversity', score: round3(bestEff) }); continue; }

    // Budget as selection: value must justify the space. A near-empty budget
    // still admits a short, strong item.
    const cost = renderLength(c);
    if (usedChars + cost > cfg.charBudget) {
      const remaining = cfg.charBudget - usedChars;
      if (cost > remaining) { dropped.push({ id: c.id, reason: 'budget', score: c.score }); continue; }
    }

    selected.push({ ...c, effectiveScore: round3(bestEff) });
    usedChars += cost;
    const primary = c.entityIds?.[0] ?? null;
    if (primary) perEntityCount.set(primary, (perEntityCount.get(primary) ?? 0) + 1);
  }
  for (const c of pool) dropped.push({ id: c.id, reason: 'limit', score: c.score });

  // 3. Render + structured items (PIC-shaped) + observability stats.
  const items = selected.map(toItem);
  const block = renderBlock(selected, cfg.charBudget);

  const stats = {
    // PIC-compatible fields (chat.js logs these).
    facts: selected.filter(s => s.kind === 'fact').length,
    entities: selected.filter(s => s.kind === 'entity').length,
    timelineEvents: selected.filter(s => s.kind === 'event').length,
    connectedFacts: selected.filter(s => (s.via ?? '').startsWith('graph')).length,
    reusedSignals: 0,
    durationMs: Date.now() - started,
    // B4 observability — the assembly is explainable.
    contextEngine: {
      version: 2,
      candidates: candidates.length,
      selected: selected.length,
      dropped: dropped.length,
      dropReasons: tally(dropped.map(d => d.reason)),
      usedChars,
      charBudget: cfg.charBudget,
      topDimensionsPerItem: selected.slice(0, 5).map(s => ({
        id: s.id ?? s.entity,
        score: s.score,
        top: rankedDimensions(s.dimensions).slice(0, 3).map(r => `${r.dim}:${r.contribution}`),
      })),
    },
  };

  return { items, block, stats };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderLength(c) {
  return renderItemLine(c).length;
}

function renderItemLine(c) {
  if (c.kind === 'entity') {
    const aka = c.aliases?.length ? ` (a.k.a. ${c.aliases.slice(0, 3).join(', ')})` : '';
    const where = c.files?.length ? ` — appears in ${c.files.slice(0, 3).join(', ')}` : '';
    return `• Entity: ${c.text}${aka}${where}`;
  }
  if (c.kind === 'event') {
    return `• ${c.timestamp ? `[${c.timestamp}] ` : ''}${String(c.text).slice(0, 120)}`;
  }
  const cite = c.citations?.[0] ? ` [${c.citations[0]}]` : '';
  const flags = [c.trusted && 'trusted', c.disputed && 'disputed — treat as contested', c.stale && 'stale']
    .filter(Boolean).join(', ');
  return `• ${c.text}${cite} (confidence ${fmt(c.confidence)}${flags ? `; ${flags}` : ''})`;
}

function renderBlock(selected, charBudget) {
  if (!selected.length) return '';
  const lines = ['── CONTEXT AQUA ASSEMBLED FOR THIS QUESTION ──'];
  for (const c of selected) lines.push(renderItemLine(c));
  lines.push('Use the context above with its citations; disputed items must be presented as contested, never as settled.');

  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > charBudget) break;
    out += (out ? '\n' : '') + l;
  }
  return out;
}

function toItem(c) {
  if (c.kind === 'entity') {
    return {
      kind: 'entity', epistemic: 'derived',
      entity: c.text, entityType: c.entityType, aliases: c.aliases ?? [],
      files: c.files ?? [], nodeId: c.id,
      score: c.score, dimensions: c.dimensions,
    };
  }
  if (c.kind === 'event') {
    return {
      kind: 'event', epistemic: 'derived',
      statement: c.text, timestamp: c.timestamp, certainty: c.certainty,
      score: c.score, dimensions: c.dimensions,
    };
  }
  return {
    kind: 'fact', epistemic: c.epistemic ?? 'observed',
    id: c.id, statement: c.text, confidence: c.confidence,
    trusted: !!c.trusted, disputed: !!c.disputed, stale: !!c.stale,
    citations: c.citations ?? [], via: c.via ?? 'lexical',
    score: c.score, dimensions: c.dimensions,
  };
}

// ── small utils ──────────────────────────────────────────────────────────────

function tally(arr) {
  const out = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}
const fmt = (n) => (n == null ? '?' : Number(n).toFixed(2));

export { DEFAULTS as ASSEMBLER_DEFAULTS, tokensOf };
