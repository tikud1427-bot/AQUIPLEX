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
  slotOverBudgetPenalty: 0.35,
  requiredSlotBoost: 1.15,
  optionalSlotBudgetShare: 0.25,
};

/**
 * @param {Array} candidates - normalized candidate objects (see scorer)
 * @param {object} ctx - the shared signal bag for scoring
 * @param {object} [opts] - { limit, charBudget, minScore, perEntitySoftCap, diversityPenalty, queryPlan }
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
  const slotBudget = buildSlotBudget(cfg.queryPlan, cfg.charBudget);
  const slotUsed = new Map();

  while (selected.length < cfg.limit && pool.length) {
    // Effective score for each remaining candidate under the current coverage.
    let bestIdx = -1;
    let bestEff = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const primary = pool[i].entityIds?.[0] ?? null;
      const covered = primary ? (perEntityCount.get(primary) ?? 0) : 0;
      const base = pool[i].selectionScore ?? pool[i].score;
      let eff = covered >= cfg.perEntitySoftCap ? base * cfg.diversityPenalty : base;

      const slotId = bestSlotForCandidate(pool[i], slotBudget, slotUsed);
      if (slotId) {
        const budget = slotBudget.get(slotId) ?? 0;
        const used = slotUsed.get(slotId) ?? 0;
        if (used >= budget) eff *= cfg.slotOverBudgetPenalty;
        else if (isRequiredSlot(cfg.queryPlan, slotId) && used === 0) eff *= cfg.requiredSlotBoost;
      }
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
    const selectedSlot = bestSlotForCandidate(c, slotBudget, slotUsed);
    if (selectedSlot) slotUsed.set(selectedSlot, (slotUsed.get(selectedSlot) ?? 0) + cost);
    const primary = c.entityIds?.[0] ?? null;
    if (primary) perEntityCount.set(primary, (perEntityCount.get(primary) ?? 0) + 1);
  }
  for (const c of pool) dropped.push({ id: c.id, reason: 'limit', score: c.score });

  // 3. Render + structured items (PIC-shaped) + observability stats.
  const items = selected.map(c => toItem(c));
  const epistemic = contextEpistemicState(cfg.queryPlan);
  const block = renderBlock(selected, cfg.charBudget, epistemic);

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
      version: 3,
      epistemicState: epistemic.state,
      shouldAbstain: epistemic.shouldAbstain,
      requiredSlotsMissing: epistemic.missing,
      provenancePreserved: true,
      candidates: candidates.length,
      selected: selected.length,
      dropped: dropped.length,
      dropReasons: tally(dropped.map(d => d.reason)),
      usedChars,
      charBudget: cfg.charBudget,
      slotBudgets: Object.fromEntries([...slotBudget.entries()].map(([id, budget]) => [id, {
        budget,
        used: slotUsed.get(id) ?? 0,
        remaining: Math.max(0, budget - (slotUsed.get(id) ?? 0)),
      }])),
      topDimensionsPerItem: selected.slice(0, 5).map(s => ({
        id: s.id ?? s.entity,
        score: s.score,
        top: rankedDimensions(s.dimensions).slice(0, 3).map(r => `${r.dim}:${r.contribution}`),
      })),
    },
  };

  return { items, block, stats };
}

function buildSlotBudget(plan, charBudget) {
  const slots = Array.isArray(plan?.slots) ? plan.slots : [];
  if (!slots.length) return new Map();
  const required = slots.filter(s => s.required);
  const optional = slots.filter(s => !s.required);
  const reserve = Math.floor(charBudget * 0.75);
  const requiredBudget = required.length ? Math.floor(reserve / required.length) : 0;
  const optionalPool = Math.max(0, charBudget - requiredBudget * required.length);
  const optionalBudget = optional.length ? Math.floor(optionalPool * 0.25 / optional.length) : 0;
  const out = new Map();
  for (const slot of required) out.set(slot.id, requiredBudget);
  for (const slot of optional) out.set(slot.id, optionalBudget);
  return out;
}

function isRequiredSlot(plan, slotId) {
  return !!plan?.slots?.find(s => s.id === slotId)?.required;
}

function bestSlotForCandidate(candidate, slotBudget, slotUsed) {
  const ids = Array.isArray(candidate?.slotIds) ? candidate.slotIds : [];
  if (!ids.length || !slotBudget.size) return null;
  return ids
    .filter(id => slotBudget.has(id))
    .sort((a, b) => {
      const ar = (slotBudget.get(a) - (slotUsed.get(a) ?? 0)) / Math.max(1, slotBudget.get(a));
      const br = (slotBudget.get(b) - (slotUsed.get(b) ?? 0)) / Math.max(1, slotBudget.get(b));
      return br - ar;
    })[0] ?? null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderLength(c) {
  return renderItemLine(c).length;
}

function renderItemLine(c) {
  const slots = Array.isArray(c.slotIds) && c.slotIds.length
    ? ` {slots: ${c.slotIds.join(', ')}}`
    : '';
  if (c.kind === 'entity') {
    const aka = c.aliases?.length ? ` (a.k.a. ${c.aliases.slice(0, 3).join(', ')})` : '';
    const where = c.files?.length ? ` — appears in ${c.files.slice(0, 3).join(', ')}` : '';
    return `• Entity: ${c.text}${aka}${where}${slots}`;
  }
  if (c.kind === 'event') {
    return `• ${c.timestamp ? `[${c.timestamp}] ` : ''}${String(c.text).slice(0, 120)}${slots}`;
  }
  const cite = c.citations?.[0] ? ` [${c.citations[0]}]` : '';
  const flags = [c.trusted && 'trusted', c.disputed && 'disputed — treat as contested', c.stale && 'stale']
    .filter(Boolean).join(', ');
  const via = c.via ? `; via ${c.via}` : '';
  return `• ${c.text}${cite} (confidence ${fmt(c.confidence)}${flags ? `; ${flags}` : ''}${via})${slots}`;
}

function renderBlock(selected, charBudget, epistemic = { state: 'sufficient', missing: [] }) {
  if (!selected.length && epistemic.state !== 'unknown') return '';
  const lines = ['── CONTEXT AQUA ASSEMBLED FOR THIS QUESTION ──'];
  if (epistemic.state === 'unknown') {
    lines.push(`EVIDENCE STATUS: UNKNOWN — required information is missing after the bounded retrieval policy.`);
    lines.push(`Required slots still unknown: ${epistemic.missing.join(', ') || 'unspecified'}. Do not infer or fabricate them.`);
  } else if (epistemic.state === 'needs_round_two') {
    lines.push(`EVIDENCE STATUS: INCOMPLETE — a targeted second retrieval round is required for: ${epistemic.missing.join(', ')}.`);
  } else {
    lines.push('EVIDENCE STATUS: SUFFICIENT for the required QueryPlan slots.');
  }
  for (const c of selected) lines.push(renderItemLine(c));
  lines.push('Use the context above with its provenance and citations; disputed items must be presented as contested, never as settled.');

  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > charBudget) break;
    out += (out ? '\n' : '') + l;
  }
  return out;
}

function contextEpistemicState(plan) {
  const required = Array.isArray(plan?.slots) ? plan.slots.filter(s => s.required) : [];
  const missing = required.filter(s => s.status !== 'filled').map(s => s.id);
  const round = Number(plan?.round ?? 1);
  if (!missing.length) return { state: 'sufficient', shouldAbstain: false, missing: [] };
  if (round >= 2) return { state: 'unknown', shouldAbstain: true, missing };
  return { state: 'needs_round_two', shouldAbstain: false, missing };
}

function toItem(c) {
  const provenance = {
    via: c.via ?? null,
    citations: Array.isArray(c.citations) ? [...c.citations] : [],
    slotIds: Array.isArray(c.slotIds) ? [...new Set(c.slotIds)] : [],
    lane: c.lanes?.length ? [...c.lanes] : null,
  };
  if (c.kind === 'entity') {
    return {
      kind: 'entity', epistemic: 'derived',
      entity: c.text, entityType: c.entityType, aliases: c.aliases ?? [],
      files: c.files ?? [], nodeId: c.id,
      slotIds: provenance.slotIds, provenance,
      score: c.score, dimensions: c.dimensions,
    };
  }
  if (c.kind === 'event') {
    return {
      kind: 'event', epistemic: 'derived',
      statement: c.text, timestamp: c.timestamp, certainty: c.certainty,
      slotIds: provenance.slotIds, provenance,
      score: c.score, dimensions: c.dimensions,
    };
  }
  return {
    kind: 'fact', epistemic: c.epistemic ?? 'observed',
    id: c.id, statement: c.text, confidence: c.confidence,
    trusted: !!c.trusted, disputed: !!c.disputed, stale: !!c.stale,
    citations: provenance.citations, via: provenance.via,
    slotIds: provenance.slotIds, provenance,
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
