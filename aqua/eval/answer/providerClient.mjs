/**
 * Provider client for evaluation runs (Sprint 6, 2026-11-11).
 *
 * One request path for the answering model and the judge:
 *   · the spend ledger authorises EVERY attempt (retries included) before it is sent
 *   · bounded retries (default 2) with exponential backoff + jitter, only for
 *     429 / 5xx / network errors; any other error stops the run
 *   · the transport is injectable; `mockTransport()` never touches the network
 *
 * OpenAI-compatible `POST {baseUrl}/chat/completions` only. Credentials come from
 * the caller and are never logged.
 */
import { SpendCapReached, PricesMissing } from './spendLedger.mjs';

export class NonRetryableProviderError extends Error {
  constructor(status, message) { super(message); this.name = 'NonRetryableProviderError'; this.status = status; }
}

const RETRYABLE = s => s === 429 || (s >= 500 && s <= 599);
/** Rough token estimate (the pipeline's heuristic family: ~4 chars per token), padded 30% for safety. */
export const estimateTokens = text => Math.ceil((String(text ?? '').length / 4) * 1.3);

/** The real transport. Only constructed for --execute runs. */
export function httpTransport({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !apiKey) throw new Error('httpTransport needs baseUrl and apiKey');
  return async (body) => {
    const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: r.status, json };
  };
}

/** A transport that never leaves the process: deterministic content-free replies. */
export function mockTransport({ reply = 'MOCK ANSWER (dry run).', judgeReply = null } = {}) {
  return async (body) => {
    const isJudge = /You are grading an assistant/.test(body.messages?.[0]?.content ?? '') || body.response_format;
    const content = isJudge ? (judgeReply ?? JSON.stringify(MOCK_JUDGEMENT)) : reply;
    return { status: 200, json: { model: `mock:${body.model}`, choices: [{ message: { content } }], usage: { prompt_tokens: 0, completion_tokens: 0 } } };
  };
}
export const MOCK_JUDGEMENT = Object.freeze({ factual_correctness: 1, grounding: 1, personalization: 1, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 1, hallucination: false, hallucinated_claims: [], confidence: 0.5, notes: 'mock' });

export function createClient({ transport, ledger, model, maxRetries = 2, baseDelayMs = 500, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random, onAttempt = () => {} }) {
  if (!transport) throw new Error('createClient needs a transport');
  return {
    model,
    /** Send one chat request. Returns { text, usage, model, attempts, usd }. */
    async chat({ messages, settings = {} }) {
      const body = { model, messages, ...settings };
      const estInputTokens = estimateTokens(messages.map(m => m.content).join('\n'));
      const maxOutputTokens = settings.max_tokens ?? 1024;
      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await sleep(Math.round(baseDelayMs * 2 ** (attempt - 1) * (0.5 + random())));
        const worstUsd = ledger ? ledger.authorise({ model, estInputTokens, maxOutputTokens }) : 0;   // throws before sending
        let res;
        try { res = await transport(body); } catch (err) {
          if (ledger) ledger.record({ model, usage: null, worstUsd });
          onAttempt({ attempt, status: 'network-error' });
          lastErr = err; continue;
        }
        const usage = res.json?.usage ?? null;
        const usd = ledger ? ledger.record({ model, usage: res.status === 200 ? usage : null, worstUsd }) : 0;
        onAttempt({ attempt, status: res.status });
        if (res.status === 200) {
          return { text: res.json?.choices?.[0]?.message?.content ?? '', usage, model: res.json?.model ?? model, attempts: attempt + 1, usd };
        }
        if (!RETRYABLE(res.status)) throw new NonRetryableProviderError(res.status, `provider HTTP ${res.status} (not retried)`);
        lastErr = new Error(`provider HTTP ${res.status}`);
      }
      throw Object.assign(new Error(`provider failed after ${maxRetries + 1} attempts: ${lastErr?.message ?? 'unknown'}`), { name: 'RetriesExhausted' });
    },
  };
}

export { SpendCapReached, PricesMissing };
