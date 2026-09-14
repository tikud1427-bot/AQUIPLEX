/**
 * AQUA — E8 retrieval-round policy.
 *
 * Pure orchestration over an injected floor retrieval function. No storage,
 * model calls, or candidate interpretation live here. This makes the
 * two-round sufficiency contract directly testable without the full Brain
 * dependency graph.
 */
import { buildQueryPlan, fillQueryPlan, assessSufficiency, withRound } from './queryPlan.js';

export function runBoundedRetrievalRounds({
  query,
  taskType = 'conversation',
  limit = 8,
  retrieve,
  queryPlan = null,
}) {
  if (typeof retrieve !== 'function') throw new TypeError('retrieve must be a function');

  const plan = queryPlan ?? buildQueryPlan(query, { taskType });
  const roundCalls = [];
  const first = retrieve(query, {
    limit,
    round: 1,
    queryPlan: withRound(plan, 1),
    slotId: null,
  });
  roundCalls.push({ round: 1, query, slotId: null, limit });

  const firstPlan = withRound(fillQueryPlan(plan, floorItemsToCandidates(first?.items ?? [])), 1);
  const firstSufficiency = assessSufficiency(firstPlan);

  if (firstSufficiency.outcome !== 'needs_round_two') {
    return {
      result: first,
      plan: firstPlan,
      sufficiency: firstSufficiency,
      rounds: 1,
      roundCalls,
    };
  }

  const roundTwoItems = [];
  for (const slotId of firstSufficiency.missing) {
    const slot = plan.slots.find(s => s.id === slotId);
    for (const slotQuery of (slot?.queries ?? []).slice(0, 2)) {
      const targetedQuery = `${query} ${slotQuery}`;
      const targeted = retrieve(targetedQuery, {
        limit: Math.max(limit, 8),
        round: 2,
        queryPlan: withRound(plan, 2),
        slotId,
      });
      roundCalls.push({
        round: 2,
        query: targetedQuery,
        slotId,
        limit: Math.max(limit, 8),
      });
      for (const item of targeted?.items ?? []) {
        roundTwoItems.push({ ...item, slotIds: [slotId] });
      }
    }
  }

  const merged = mergeResults(first, {
    items: dedupeItems(roundTwoItems),
  });
  const finalPlan = withRound(
    fillQueryPlan(plan, floorItemsToCandidates(merged.items ?? [])),
    2,
  );

  return {
    result: merged,
    plan: finalPlan,
    sufficiency: assessSufficiency(finalPlan),
    rounds: 2,
    roundCalls,
  };
}

function floorItemsToCandidates(items) {
  return items.map(it => ({
    kind: it.kind,
    id: it.id ?? it.nodeId ?? it.statement,
    text: it.statement ?? it.entity ?? it.text ?? '',
    slotIds: it.slotIds ?? [],
  }));
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = `${it.kind}:${it.id ?? it.nodeId ?? it.statement ?? it.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeResults(base, extra) {
  const items = dedupeItems([...(base?.items ?? []), ...(extra?.items ?? [])]);
  return {
    ...(base ?? { items: [], block: '', stats: {} }),
    items,
    block: [base?.block, extra?.block].filter(Boolean).join('\n\n'),
    stats: {
      ...(base?.stats ?? {}),
      ...(extra?.stats ?? {}),
      facts: items.filter(x => x.kind === 'fact').length,
      entities: items.filter(x => x.kind === 'entity').length,
      timelineEvents: items.filter(x => x.kind === 'event').length,
    },
  };
}
