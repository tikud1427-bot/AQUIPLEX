/**
 * AQUA — E12: per-turn cost accounting.
 *
 * Blueprint E12 wants "per-turn cost accounting" so extraction spend (E6's
 * budget risk) is a number, not a surprise. This module counts tokens and, when
 * it has been GIVEN prices, dollars.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - It ships NO default prices. Provider prices change and a stale table is a
 *    confident wrong number (L16: measure, then claim). Until `setPriceTable`
 *    is called, `costUsd` is `null` — "unknown", never `0`. Tokens are always
 *    counted.
 *  - It never sees message content, owner ids or conversation ids. A ledger is
 *    counters keyed by an opaque turn key the caller chooses (D3, E12 PII risk).
 *  - It reads no env vars (L13).
 */

export const COST_PURPOSES = Object.freeze(['chat', 'extraction', 'embedding', 'verification', 'reflection', 'other']);

/** { "<provider>/<model>": { inputPerMTok: number, outputPerMTok: number } } — USD per million tokens. */
let priceTable = Object.freeze({});

export function setPriceTable(table = {}) {
  const clean = {};
  for (const [key, v] of Object.entries(table ?? {})) {
    if (v && Number.isFinite(v.inputPerMTok) && Number.isFinite(v.outputPerMTok)
        && v.inputPerMTok >= 0 && v.outputPerMTok >= 0) {
      clean[key] = Object.freeze({ inputPerMTok: v.inputPerMTok, outputPerMTok: v.outputPerMTok });
    }
  }
  priceTable = Object.freeze(clean);
  return Object.keys(priceTable).length;
}

function nonNegInt(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** USD for one call, or null when this provider/model has no known price. */
export function priceCall({ provider, model, inputTokens = 0, outputTokens = 0 } = {}) {
  const p = priceTable[`${provider}/${model}`];
  if (!p) return null;
  return (nonNegInt(inputTokens) * p.inputPerMTok + nonNegInt(outputTokens) * p.outputPerMTok) / 1e6;
}

/**
 * One turn's ledger. Create per turn, `record()` each provider call, then hand
 * `summary()` to `recordTurnCost`.
 */
export function createTurnLedger() {
  const byPurpose = {};
  let calls = 0, inputTokens = 0, outputTokens = 0, costUsd = 0, unpricedCalls = 0;
  return {
    record({ provider, model, inputTokens: i = 0, outputTokens: o = 0, purpose = 'other' } = {}) {
      const p = COST_PURPOSES.includes(purpose) ? purpose : 'other';
      const inT = nonNegInt(i), outT = nonNegInt(o);
      const usd = priceCall({ provider, model, inputTokens: inT, outputTokens: outT });
      calls++; inputTokens += inT; outputTokens += outT;
      if (usd == null) unpricedCalls++; else costUsd += usd;
      const b = (byPurpose[p] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      b.calls++; b.inputTokens += inT; b.outputTokens += outT;
    },
    summary() {
      return {
        calls, inputTokens, outputTokens, unpricedCalls,
        // null = at least one call had no price, so a total would understate spend.
        costUsd: unpricedCalls === 0 && calls > 0 ? costUsd : (calls === 0 ? 0 : null),
        pricedCostUsd: costUsd,
        byPurpose: JSON.parse(JSON.stringify(byPurpose)),
      };
    },
  };
}

const agg = { turns: 0, calls: 0, inputTokens: 0, outputTokens: 0, unpricedCalls: 0, pricedCostUsd: 0, byPurpose: {} };

/**
 * Fold a finished turn's summary into process-wide counters.
 *
 * `providerCallsAlreadyCounted`: every provider adapter already folds each
 * successful call into these counters via recordProviderCall(). A caller whose
 * ledger only re-records those same calls (the chat route) passes true, so the
 * turn is counted without counting its calls and tokens a second time —
 * before 2026-10-15 every chat call appeared twice in /metrics.
 */
export function recordTurnCost(summary, { providerCallsAlreadyCounted = false } = {}) {
  if (!summary || !Number.isFinite(summary.calls)) return;
  agg.turns++;
  if (providerCallsAlreadyCounted) return;
  agg.calls += summary.calls;
  agg.inputTokens += summary.inputTokens ?? 0;
  agg.outputTokens += summary.outputTokens ?? 0;
  agg.unpricedCalls += summary.unpricedCalls ?? 0;
  agg.pricedCostUsd += summary.pricedCostUsd ?? 0;
  for (const [p, b] of Object.entries(summary.byPurpose ?? {})) {
    const t = (agg.byPurpose[p] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    t.calls += b.calls; t.inputTokens += b.inputTokens; t.outputTokens += b.outputTokens;
  }
}

/**
 * Fold ONE provider call into the process-wide counters. Called by every
 * provider transport on success (groq / gemini / openrouter / nvidia), so the counters
 * reflect real traffic — before 2026-10-04 nothing in production called
 * recordTurnCost and /metrics reported 0 calls and $0 forever. Tokens are
 * always counted; dollars only for priced models (unpriced → unpricedCalls,
 * and the USD total is withheld). Never sees content or owners (D3).
 */
export function recordProviderCall({ provider, model, usage, purpose = 'other' } = {}) {
  const inputTokens = nonNegInt(usage?.inputTokens);
  const outputTokens = nonNegInt(usage?.outputTokens);
  const p = COST_PURPOSES.includes(purpose) ? purpose : 'other';
  agg.calls++;
  agg.inputTokens += inputTokens;
  agg.outputTokens += outputTokens;
  if (!usage) agg.unreportedUsageCalls = (agg.unreportedUsageCalls ?? 0) + 1;
  const usd = usage ? priceCall({ provider, model, inputTokens, outputTokens }) : null;
  if (usd == null) agg.unpricedCalls++; else agg.pricedCostUsd += usd;
  const t = (agg.byPurpose[p] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
  t.calls++; t.inputTokens += inputTokens; t.outputTokens += outputTokens;
}

export function getCostMetrics() {
  return {
    ...agg,
    byPurpose: JSON.parse(JSON.stringify(agg.byPurpose)),
    avgTokensPerTurn: agg.turns ? +((agg.inputTokens + agg.outputTokens) / agg.turns).toFixed(1) : 0,
    // `pricedCostUsd` understates spend whenever unpricedCalls > 0 — say so.
    complete: agg.unpricedCalls === 0,
  };
}

export function _resetCostMetrics() {
  agg.turns = agg.calls = agg.inputTokens = agg.outputTokens = agg.unpricedCalls = agg.pricedCostUsd = 0;
  agg.unreportedUsageCalls = 0;
  agg.byPurpose = {};
  priceTable = Object.freeze({});
}
