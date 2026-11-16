/**
 * Spend ledger for paid evaluation runs (Sprint 6, 2026-11-11).
 *
 * A HARD cap, checked BEFORE every provider request against that request's
 * worst case (estimated input tokens × input price + the full output budget ×
 * output price). A request that could cross the cap is never sent.
 *
 * Prices are never assumed: a paid run must be given them (USD per million
 * tokens, per model). Without prices the cap cannot be enforced, so the ledger
 * refuses to authorise any request. Default pilot cap: $25.
 *
 * Accounting is conservative: an attempt that reports no usage (an error, a
 * timeout) is charged its worst case.
 */
export const DEFAULT_CAP_USD = 25;

export class SpendCapReached extends Error {
  constructor(message, detail) { super(message); this.name = 'SpendCapReached'; this.detail = detail; }
}
export class PricesMissing extends Error {
  constructor(message) { super(message); this.name = 'PricesMissing'; }
}

const finitePositive = x => Number.isFinite(x) && x >= 0;

export function createLedger({ capUsd = DEFAULT_CAP_USD, prices = {}, spentUsd = 0 } = {}) {
  if (!finitePositive(capUsd) || capUsd <= 0) throw new Error(`invalid spend cap: ${capUsd}`);
  const state = { capUsd, spentUsd: Number(spentUsd) || 0, requests: 0, refused: 0, byModel: {} };

  function priceOf(model) {
    const p = prices[model];
    if (!p || !finitePositive(p.inputPerMTok) || !finitePositive(p.outputPerMTok)) {
      throw new PricesMissing(`no price for model "${model}" — pass --price-in/--price-out (USD per 1M tokens); prices are never assumed`);
    }
    return p;
  }
  const cost = (model, inTok, outTok) => { const p = priceOf(model); return ((inTok * p.inputPerMTok) + (outTok * p.outputPerMTok)) / 1e6; };

  return {
    /** Throws SpendCapReached / PricesMissing unless this request's worst case fits under the cap. */
    authorise({ model, estInputTokens, maxOutputTokens }) {
      const worst = cost(model, Math.max(0, estInputTokens | 0), Math.max(0, maxOutputTokens | 0));
      if (state.spentUsd + worst > state.capUsd) {
        state.refused++;
        throw new SpendCapReached(`spend cap reached: spent $${state.spentUsd.toFixed(4)} + worst case $${worst.toFixed(4)} > cap $${state.capUsd}`, { spentUsd: state.spentUsd, worstUsd: worst, capUsd: state.capUsd });
      }
      return worst;
    },
    /** Record one attempt. Missing usage → charged at its worst case (conservative). */
    record({ model, usage, worstUsd }) {
      const inTok = usage?.prompt_tokens, outTok = usage?.completion_tokens;
      const usd = Number.isFinite(inTok) && Number.isFinite(outTok) ? cost(model, inTok, outTok) : worstUsd;
      state.spentUsd += usd; state.requests++;
      const m = (state.byModel[model] ??= { requests: 0, usd: 0, inputTokens: 0, outputTokens: 0 });
      m.requests++; m.usd += usd; m.inputTokens += inTok ?? 0; m.outputTokens += outTok ?? 0;
      return usd;
    },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
  };
}
