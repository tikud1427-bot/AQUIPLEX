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
  const items = selected.map(toItem);
  const sufficiency = assessPlanSufficiency(cfg.queryPlan);
  const rendered = renderBlock(selected, cfg.charBudget, sufficiency);
  const block = rendered.block;

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
      compression: rendered.stats,
      sufficiency,
      abstention: rendered.stats.abstention,
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

function renderBlock(selected, charBudget, sufficiency = { outcome: 'sufficient', missing: [] }) {
  if (!selected.length) return { block: '', stats: { ...emptyCompressionStats(), abstention: buildAbstention(sufficiency) } };

  // Hierarchical compression is STRUCTURAL, not semantic: exact canonical
  // statements remain intact, while repeated entity/slot framing is emitted
  // once at the group level. Provenance, confidence, lifecycle flags and
  // citations stay attached to every evidence line.
  const groups = hierarchicalGroups(selected);
  const rawLength = selected.reduce((n, c) => n + renderItemLine(c).length + 1, 0);
  const lines = ['── CONTEXT AQUA ASSEMBLED FOR THIS QUESTION ──', `Retrieval status: ${sufficiency.outcome.toUpperCase()}`];
  if (sufficiency.outcome === 'unknown') {
    lines.push(`Do not infer missing required slots: ${sufficiency.missing.join(', ')}. State what is unknown.`);
  }

  for (const group of groups) {
    lines.push(group.header);
    for (const c of group.items) lines.push(renderCompactEvidence(c));
  }
  lines.push('Use the context above with its citations; disputed items must be presented as contested, never as settled.');

  let out = '';
  let emittedItems = 0;
  for (const l of lines) {
    const next = out ? `${out}\n${l}` : l;
    if (next.length > charBudget) break;
    out = next;
    if (l.startsWith('  •')) emittedItems += 1;
  }

  // Selection is already budget-aware, but the hierarchy adds group headers.
  // Never exceed the hard rendering budget. If the safety footer cannot fit,
  // evidence is still returned rather than truncating an evidence line.
  if (!out) out = lines[0].slice(0, charBudget);

  return {
    block: out,
    stats: {
      level: 2,
      groups: groups.length,
      selectedItems: selected.length,
      renderedItems: emittedItems,
      rawChars: rawLength,
      compressedChars: out.length,
      savedChars: Math.max(0, rawLength - out.length),
      ratio: rawLength ? Number((out.length / rawLength).toFixed(3)) : 1,
      truncatedByBudget: emittedItems < selected.length,
      groupTypes: tally(groups.map(g => g.type)),
      abstention: buildAbstention(sufficiency),
    },
  };
}

function emptyCompressionStats() {
  return { level: 2, groups: 0, selectedItems: 0, renderedItems: 0, rawChars: 0, compressedChars: 0, savedChars: 0, ratio: 1, truncatedByBudget: false, groupTypes: {}, abstention: buildAbstention({ outcome: 'sufficient', missing: [] }) };
}

function assessPlanSufficiency(plan) {
  if (!plan?.slots?.length) return { outcome: 'sufficient', missing: [] };
  const required = plan.slots.filter(s => s.required);
  const missing = required.filter(s => s.status !== 'filled').map(s => s.id);
  const round = Number(plan.round ?? 1);
  if (!missing.length) return { outcome: 'sufficient', missing: [] };
  return { outcome: round >= 2 ? 'unknown' : 'needs_round_two', missing };
}

function buildAbstention(sufficiency) {
  const outcome = sufficiency?.outcome ?? 'sufficient';
  return {
    requiredSlotsMissing: Array.isArray(sufficiency?.missing) ? [...sufficiency.missing] : [],
    shouldAbstain: outcome === 'unknown',
    mode: outcome === 'unknown' ? 'explicit_unknown' : 'answer_with_context',
  };
}

function hierarchicalGroups(selected) {
  const groups = new Map();
  for (const c of selected) {
    const entity = c.entityIds?.[0];
    const slot = c.slotIds?.[0];
    const key = entity ? `entity:${entity}` : slot ? `slot:${slot}` : `evidence:${c.kind ?? 'unknown'}`;
    if (!groups.has(key)) {
      const type = entity ? 'entity' : slot ? 'slot' : 'evidence';
      const label = entity ? `Entity ${entity}` : slot ? `Slot ${slot}` : `${capitalize(c.kind ?? 'evidence')} evidence`;
      groups.set(key, { key, type, header: `▸ ${label}`, items: [] });
    }
    groups.get(key).items.push(c);
  }
  return [...groups.values()];
}

function renderCompactEvidence(c) {
  const text = c.kind === 'entity' ? c.text : c.kind === 'event' ? c.text : c.text;
  const cite = c.citations?.length ? ` [${c.citations.slice(0, 2).join(', ')}]` : '';
  const flags = [c.trusted && 'trusted', c.disputed && 'disputed', c.stale && 'stale']
    .filter(Boolean).join(', ');
  const certainty = c.kind === 'event'
    ? (c.certainty != null ? ` certainty ${fmt(c.certainty)}` : '')
    : c.kind === 'entity'
      ? ''
      : ` confidence ${fmt(c.confidence)}`;
  const meta = [certainty.trim(), flags, c.via ? `via ${c.via}` : ''].filter(Boolean).join('; ');
  return `  • ${text}${cite}${meta ? ` (${meta})` : ''}`;
}

function capitalize(value) {
  const s = String(value);
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function toItem(c) {
  if (c.kind === 'entity') {
    return {
      kind: 'entity', epistemic: 'derived',
      entity: c.text, entityType: c.entityType, aliases: c.aliases ?? [],
      files: c.files ?? [], nodeId: c.id,
      score: c.score, dimensions: c.dimensions,
      provenance: { via: c.via ?? 'entity', slotIds: c.slotIds ?? [], entityIds: c.entityIds ?? [] },
    };
  }
  if (c.kind === 'event') {
    return {
      kind: 'event', epistemic: 'derived',
      statement: c.text, timestamp: c.timestamp, certainty: c.certainty,
      score: c.score, dimensions: c.dimensions,
      provenance: { via: c.via ?? 'event', slotIds: c.slotIds ?? [], entityIds: c.entityIds ?? [] },
    };
  }
  return {
    kind: 'fact', epistemic: c.epistemic ?? 'observed',
    id: c.id, statement: c.text, confidence: c.confidence,
    trusted: !!c.trusted, disputed: !!c.disputed, stale: !!c.stale,
    citations: c.citations ?? [], via: c.via ?? 'lexical',
    score: c.score, dimensions: c.dimensions,
    provenance: { via: c.via ?? 'lexical', citations: c.citations ?? [], slotIds: c.slotIds ?? [], entityIds: c.entityIds ?? [] },
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
