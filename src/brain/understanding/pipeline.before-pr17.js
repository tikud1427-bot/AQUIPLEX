/**
 * AQUA — The E6 understanding pipeline (Blueprint S0 → S5)
 *
 * Composes the stages built in E6/PR-1 … PR-7 into the sequence the blueprint
 * specifies, in `src/` where production can reach it.
 *
 * WHY THIS EXISTS, AND WHY IT IS OVERDUE
 * --------------------------------------
 * Nine modules shipped and nothing composed them. The ONLY thing that ran the
 * stages in order was `eval/adapters/e6Extractor.mjs`, which means the shadow
 * run (E6/PR-11) was measuring a pipeline production does not have — the exact
 * shape L12 exists to forbid, in the one place it would be least visible: the
 * numbers would look real, and would describe an arrangement of stages that
 * was never shipped. The eval adapter now delegates here, so what is measured
 * and what would ship are the same code.
 *
 * ⚠️ S0 IS PARTIAL AND S6 IS ABSENT. NEITHER IS SKIPPED SILENTLY.
 * ---------------------------------------------------------------
 * S0 ADMISSION specifies: content-hash dedup · owner budget check · trust tier
 * · PII/secret pre-scan · size and rate bounds. Implemented here: the secret
 * pre-scan and size bound. NOT implemented: owner budget and rate limiting,
 * which need per-owner accounting this module has no access to. Reported on
 * every run in `stats.s0`.
 *
 * S6 ENTITY RESOLUTION is not built at all — five tiers, two of which need a
 * provider. Its absence is why THIS PIPELINE STOPS AT S5. Running S7 without
 * it would mint edges whose endpoints are raw surface strings, and E6/PR-8's
 * own header says an edge to something never resolved to an entity "is a node
 * nothing else can ever reach". Producing those and calling the pipeline
 * complete would be worse than not producing them: the graph would fill with
 * unreachable nodes that look like data.
 *
 * So `entityResolution: 'unresolved'` rides on every result, and S7–S9 are not
 * invoked. A caller that wants edges has to notice.
 *
 * 🔴 THE SECRET PRE-SCAN WAS MISSING FROM THE PATH ENTIRELY
 * ---------------------------------------------------------
 * Segments go to a THIRD-PARTY PROVIDER. Before this, nothing between the
 * user's message and that request looked for credentials — `secretGuard`
 * exists and shipped, and no stage called it. A pasted `.env`, an API key in a
 * stack trace, a connection string in a debugging question: all would have
 * been transmitted verbatim.
 *
 * S0 puts `redactSecrets` in front of the transport, and `stats.s0.redactions`
 * counts what it caught. Redaction happens BEFORE segmentation so a secret
 * spanning a sentence boundary cannot slip through in halves.
 *
 * NOT WIRED. No production caller and no flag: E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2`, and that PR is deliberately blocked until the shadow run
 * produces numbers. There is nothing to gate until something reads this.
 */
import { redactSecrets } from '../../project/secretGuard.js';
import { segmentMessage } from './segmentation.js';
import { gateSegment } from './candidateGate.js';
import { extractSegment } from './extractionClient.js';
import { validateAgainstSegment, OUTCOME } from './claimValidator.js';
import { applyTemporal } from './temporalNormaliser.js';

/** S0 size bound. Beyond this a single message is a document, and documents
 *  have their own ingest path with its own budget. */
export const MAX_MESSAGE_CHARS = 20_000;

/** Stages this module actually runs, in blueprint order. */
export const STAGES = Object.freeze(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);

/** Declared gaps, so no caller has to infer them from silence. */
export const NOT_IMPLEMENTED = Object.freeze({
  S0_partial: ['owner-budget', 'rate-bounds'],
  S6: 'entity resolution — five tiers, two provider-backed. S7–S9 are not run without it.',
});

/**
 * Run S0 → S5 over one user message.
 *
 * @param {string} text
 * @param {object} opts
 * @param {Function} opts.callModel   transport; without it S3 yields nothing
 * @param {string}  [opts.modelPin]
 * @param {string}  [opts.sourceTier] explicit | file | chat | inferred
 * @param {string|number|Date} [opts.assertedAt] when it was SAID — S5 needs it
 *   for any relative expression, and will NOT fall back to the clock
 * @returns {Promise<object>}
 */
export async function runUnderstandingPipeline(text, opts = {}) {
  const stats = {
    s0: { admitted: false, reason: null, redactions: 0, tags: [], chars: 0 },
    segments: 0, gated: 0, called: 0, cached: 0, errors: 0,
    parsed: 0, admitted: 0, proposed: 0, discarded: 0,
    byGate: {}, models: [],
  };
  const empty = extra => ({
    claims: [], proposals: [], entityResolution: 'unresolved',
    stagesRun: [], notImplemented: NOT_IMPLEMENTED, stats, ...extra,
  });

  // ── S0 ADMISSION ─────────────────────────────────────────────────────────
  if (typeof text !== 'string' || !text.trim()) {
    stats.s0.reason = 'empty';
    return empty();
  }
  stats.s0.chars = text.length;
  if (text.length > MAX_MESSAGE_CHARS) {
    stats.s0.reason = 'too-large';
    return empty();
  }

  // Redact BEFORE segmenting. A credential that straddles a sentence boundary
  // would otherwise be split and each half sent separately — still exposed,
  // and harder to spot.
  const scan = redactSecrets(text);
  stats.s0.redactions = scan.redactions ?? 0;
  stats.s0.tags = scan.tags ?? [];
  const clean = scan.content ?? text;
  stats.s0.admitted = true;

  const models = new Set();

  // ── S1 SEGMENTATION ──────────────────────────────────────────────────────
  const segments = segmentMessage(clean);
  stats.segments = segments.length;

  const claims = [];
  const proposals = [];

  for (const seg of segments) {
    // ── S2 CANDIDATE GATING ────────────────────────────────────────────────
    if (!gateSegment(seg.text).admit) continue;
    stats.gated++;

    // ── S3 LLM EXTRACTION ──────────────────────────────────────────────────
    const out = await extractSegment(seg.text, opts);
    if (out.cached) stats.cached++; else stats.called++;
    if (out.error) { stats.errors++; continue; }
    if (out.model) models.add(out.model);
    stats.parsed += out.claims.length;

    // An unregistered predicate is refused by the S3 contract, which is right
    // — it is not a storable claim. But refusing is not forgetting: S3's own
    // instruction is "unknown predicate → propose, don't force", and dropping
    // the rejection loses the only evidence that the vocabulary is too small.
    // The contract preserves the reason and the raw claim precisely so this
    // routing is possible.
    for (const r of out.rejected ?? []) {
      if (String(r.reason ?? '').startsWith('unregistered-predicate')) {
        stats.proposed++;
        proposals.push({ predicate: r.raw?.predicate, quote: r.raw?.statementText, segment: seg.text });
      } else {
        stats.discarded++;
        stats.byGate.contract = (stats.byGate.contract ?? 0) + 1;
      }
    }

    for (const raw of out.claims) {
      // ── S4 CLAIM VALIDATION ──────────────────────────────────────────────
      const v = validateAgainstSegment(raw, seg.text, {
        sourceTier: opts.sourceTier ?? 'chat',
        modelConfidence: raw.confidenceExtraction ?? raw.confidence_extraction ?? 0.5,
      });
      if (v.outcome === OUTCOME.PROPOSE) {
        stats.proposed++;
        proposals.push(v.proposal);
        continue;
      }
      if (v.outcome !== OUTCOME.ADMIT) {
        stats.discarded++;
        stats.byGate[v.gate] = (stats.byGate[v.gate] ?? 0) + 1;
        continue;
      }
      stats.admitted++;

      // ── S5 TEMPORAL NORMALISATION ────────────────────────────────────────
      const dated = applyTemporal(v.claim, opts.assertedAt ?? null);
      claims.push({ ...dated, segment: { start: seg.start, end: seg.end, index: seg.index } });
    }
  }

  stats.models = [...models];
  return {
    claims,
    proposals,
    // Surface strings, NOT entity ids. S7 must not run on these.
    entityResolution: 'unresolved',
    stagesRun: STAGES,
    notImplemented: NOT_IMPLEMENTED,
    stats,
  };
}
