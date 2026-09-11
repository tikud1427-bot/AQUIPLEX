/**
 * AQUA — Extraction client (Blueprint E6/PR-5)
 *
 * "Batching, temperature 0, pinned model, content-hash cache."
 *
 * ⚠️ TWO OF THOSE FOUR CANNOT BE DELIVERED BY THIS PR. Reported rather than
 * quietly worked around, because both are load-bearing for E6/PR-11.
 *
 *   PINNED MODEL — unreachable. `generateGemini(systemPrompt, messages,
 *   signal, maxTokens)` and `generateGroq(...)` take no model argument. Both
 *   iterate `getCandidateModels(provider)` and fall back down the list, and
 *   for OpenRouter that list ROTATES per call (`openrouterCursor`). Two
 *   consecutive extractions can therefore run on two different models.
 *
 *   TEMPERATURE 0 — unreachable. Neither adapter accepts a temperature; the
 *   word does not appear in either file.
 *
 *   AND THE ADAPTER DOES NOT SAY WHICH MODEL ANSWERED. The return is
 *   `{ text, truncated, finishReason }`. The model id exists only in a
 *   console.log, so a run cannot even detect rotation after the fact.
 *
 * Why that matters more than it sounds: PR-11 compares this extractor against
 * the committed E2 baseline. A comparison in which the model silently rotates
 * between calls, at an unknown temperature, is not a comparison — a difference
 * in the numbers could be the new prompt or could be a different model, and
 * nothing in the output distinguishes them.
 *
 * So this client OWNS determinism as far as it can reach, and records what it
 * could not control:
 *
 *   • `modelPin` and `temperature` are recorded on every result, and are
 *     `null` when the transport could not honour them. A null here is a real
 *     measurement — it says "this run is not reproducible" — and PR-11 should
 *     refuse to publish a comparison built from nulls.
 *   • the content-hash cache makes repeat work exactly reproducible even
 *     when the provider is not.
 *
 * The provider-layer change this needs is small and additive — an optional
 * model id and temperature threaded through the two adapters, and the model id
 * echoed in the return — but it touches the production answer path, so it is
 * its own PR with its own measurement rather than a rider on this one.
 *
 * ONE SEGMENT PER CALL. NEVER SEVERAL.
 * ------------------------------------
 * "Batching" here means bounded CONCURRENCY, not several segments in one
 * prompt. The contract's `statement_text` must be verbatim from the segment
 * and `evidence_span` indexes into it (E6/PR-1, PR-4). Put three segments in
 * one prompt and the model has to track which span belongs to which segment —
 * a well-known error source, and one whose failures look like correct output.
 * Cheaper calls are not worth provenance that points at the wrong text.
 *
 * NOT WIRED. No production caller, no flag. E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2`.
 */
import crypto from 'node:crypto';

import { buildExtractionPrompt, PROMPT_VERSION } from './extractionPrompt.js';
import { parseExtractionResponse } from './extractionContract.js';

/** Bounded so a long message cannot open forty sockets at once. */
export const DEFAULT_CONCURRENCY = 4;

/** What the client ASKS for. Whether the transport honours it is recorded, not assumed. */
export const REQUESTED_TEMPERATURE = 0;

/**
 * Cache key = everything that could change the answer.
 *
 * Segment text alone is the tempting key and it is wrong: change the prompt
 * and every cached entry silently becomes a stale answer to a question no
 * longer being asked. The prompt version, the contract version and the model
 * pin are all in the hash, so a prompt edit is a cache MISS rather than a
 * quiet reuse — which is exactly what you want the first time a prompt change
 * is measured.
 */
export function extractionCacheKey({ segment, promptVersion, modelPin }) {
  return crypto.createHash('sha256')
    .update(String(promptVersion ?? PROMPT_VERSION)).update('\u0000')
    .update(String(modelPin ?? 'unpinned')).update('\u0000')
    .update(String(segment ?? ''))
    .digest('hex');
}

/** Process-lifetime cache. Deliberately not persisted — see the header of PR-11. */
const memoryCache = new Map();

export function __clearExtractionCache() { memoryCache.clear(); }
export function __extractionCacheSize() { return memoryCache.size; }

/**
 * Extract claims from ONE segment.
 *
 * @param {string} segment
 * @param {object} [opts]
 * @param {Function} [opts.callModel]  async ({system, user}) => ({ text, model? })
 * @param {string}  [opts.modelPin]    the model this run is supposed to use
 * @param {Map}     [opts.cache]
 * @returns {Promise<{claims:object[], rejected:object[], cached:boolean, model:string|null,
 *                    temperature:number|null, error:string|null, key:string}>}
 *
 * Never throws. Extraction runs over deferred post-turn work; a throw here
 * would take down a turn for a cost optimisation.
 */
export async function extractSegment(segment, opts = {}) {
  const cache = opts.cache ?? memoryCache;
  const modelPin = opts.modelPin ?? null;
  const key = extractionCacheKey({ segment, promptVersion: PROMPT_VERSION, modelPin });

  if (cache.has(key)) return { ...cache.get(key), cached: true };

  const prompt = buildExtractionPrompt(segment);
  const callModel = opts.callModel;

  if (typeof callModel !== 'function') {
    // No transport. Fail OPEN and SILENT-FREE: an empty result with a named
    // reason, never an exception, and never written to the cache — caching a
    // failure would make one bad minute permanent for the process lifetime.
    return { claims: [], rejected: [], cached: false, model: null,
      temperature: null, error: 'no-transport', key };
  }

  let raw, reportedModel = null;
  try {
    const res = await callModel({ system: prompt.system ?? prompt, user: prompt.user ?? segment,
      temperature: REQUESTED_TEMPERATURE, model: modelPin });
    raw = typeof res === 'string' ? res : res?.text;
    // `model` is echoed only if the transport supplies it. The shipped
    // adapters do not, so this is null in production today — a null that
    // MEANS something and must not be filled in with the pin we asked for.
    reportedModel = (typeof res === 'object' && res?.model) ? res.model : null;
  } catch (err) {
    return { claims: [], rejected: [], cached: false, model: null,
      temperature: null, error: `transport:${err?.message ?? 'unknown'}`, key };
  }

  const parsed = parseExtractionResponse(raw);
  const result = {
    claims: parsed.claims ?? [],
    rejected: parsed.rejected ?? [],
    cached: false,
    model: reportedModel,
    // Recorded as null unless the transport confirms it honoured the request.
    // Writing REQUESTED_TEMPERATURE here would turn an unverified ask into a
    // measurement, which is how an irreproducible run comes to look reproducible.
    temperature: (typeof reportedModel === 'string') ? REQUESTED_TEMPERATURE : null,
    error: parsed.ok ? null : (parsed.error ?? 'unparseable'),
    key,
  };

  // Only successful parses are cached. An unparseable response is usually a
  // transient prompt or provider problem, and caching it would mean the same
  // segment can never be extracted again this process.
  if (parsed.ok) cache.set(key, { ...result, cached: false });
  return result;
}

/**
 * Extract from many segments with bounded concurrency.
 *
 * Order is preserved: results[i] corresponds to segments[i], regardless of
 * completion order. A caller matching claims back to spans by array position
 * would otherwise attribute them to the wrong segment — silently, and only
 * under load, which is the worst way to find out.
 */
export async function extractSegments(segments, opts = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const results = new Array(list.length);

  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await extractSegment(list[i], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));

  return {
    results,
    stats: {
      segments: list.length,
      calls: results.filter(r => r && !r.cached).length,
      cacheHits: results.filter(r => r?.cached).length,
      claims: results.reduce((a, r) => a + (r?.claims?.length ?? 0), 0),
      rejected: results.reduce((a, r) => a + (r?.rejected?.length ?? 0), 0),
      errors: results.filter(r => r?.error).length,
      // If ANY result lacks a model id the run is not attributable, and PR-11
      // needs to know that before it publishes a comparison.
      reproducible: results.length > 0 && results.every(r => typeof r?.model === 'string'),
    },
  };
}
