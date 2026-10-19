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

/** Explicit negation cues (rule 2's list). Contractions in either apostrophe. */
const NEGATION_CUE = /\b(not|never|no longer|neither|nor|none|nobody|nothing)\b|n['’]t\b|\banymore\b|\bstopped\b/i;

/**
 * COMPOUND CHANGES (2026-10-17). "We moved the launch to May 2, and the price is
 * now $39" is two changes in one sentence. Measured on the real product
 * (founder journey runs 3 and 4): the extractor returned only one of them —
 * the price in one run, the date in the other — and the dropped change never
 * reached memory. Model variance, not a parse error, so it is handled like the
 * negation retry: CODE checks that every clause stating a change is covered by
 * some claim, and asks once more, naming the uncovered clause, when one is not.
 */
const CHANGE_CUE = /\b(?:moved|move|pushed|postponed|delayed|rescheduled|slipped|brought\s+forward|changed|switched|raised|lowered|increased|decreased|cut|dropped|now|no\s+longer|anymore|instead|replaced|took\s+over|taken\s+over|handed\s+over|cancel(?:l)?ed|called\s+off|hired|fired|left|joined|renamed|actually|correction)\b/i;
const CLAUSE_SPLIT = /\s*,\s*(?:and|but|while|plus)\s+|\s*;\s*|\s*,\s+(?=(?:we|i|our|the|my|they|he|she|it|also)\b)|\s+and\s+(?=(?:we|i|our|the|my|they|he|she|it|also|then)\b)|\s+and\s+(?=(?:moved|pushed|postponed|delayed|raised|lowered|hired|fired|changed|switched|cancel(?:l)?ed|cut|dropped|renamed|replaced)\b)/i;
const CLAUSE_STOP = new Set(['the', 'and', 'our', 'now', 'was', 'were', 'has', 'have', 'had', 'are', 'for', 'with', 'from', 'that', 'this', 'its', 'also', 'then', 'just', 'per']);
const clauseTokens = s => new Set((String(s ?? '').toLowerCase().match(/[\p{L}\p{N}$€£%]+/gu) ?? [])
  .filter(t => t.length >= 2 && !CLAUSE_STOP.has(t)));
const claimText = c => {
  const o = c?.object ?? {};
  return [c?.statementText, c?.subject, o.entity, o.literal, o.time, o.quantity != null ? String(o.quantity) : null].filter(Boolean).join(' ');
};

/**
 * REVISES, BY RULE 11's OWN CUES (2026-10-18). The prompt defines a change by
 * its language (moved to, now, no longer, switched to, instead of, actually,
 * correction …) and asks the model to set `revises`. Measured: two recordings of
 * "We're now at 57 paying clinics" — one set it, one did not, and without it the
 * old count stayed current (every S8 revision rule requires the flag). Code
 * applies the same definition to the claim's own span as a backstop; each rule
 * that reads the flag keeps its own evidence bar (same-kind value, exactly one
 * rival …). Marked `revisesInferred` so it stays auditable.
 */
const RULE11_CUE = /\b(?:moved\s+to|now|no\s+longer|anymore|switched\s+(?:to|from)|changed\s+(?:from|to)|instead\s+of|actually|correction|raised|lowered|increased|decreased|pushed|postponed|delayed|rescheduled|slipped|took\s+over|taken\s+over)\b/i;
export function inferRevises(claim) {
  if (!claim || claim.revises === true || (claim.modality ?? 'fact') !== 'fact') return claim;
  if (!RULE11_CUE.test(String(claim.statementText ?? ''))) return claim;
  return { ...claim, revises: true, revisesInferred: true };
}

/**
 * WHO DID IT (2026-10-18). "Kofi is helping me build Atlas on weekends" came
 * back as (self, builds, Atlas) only — Kofi, the person doing the work, was
 * dropped (held-out world; reproduced live on the attribution battery). A
 * NAMED person who ACTS in the sentence must appear in some claim. Detected by
 * surface pattern only — a capitalised name directly before an action verb, or
 * after "by" — and never used to invent a claim: it only makes code ask the
 * model once more, naming the person; the model decides what (if anything) the
 * sentence says about them, and every gate still applies.
 */
const ACTION_VERB = '(?:helping|helps|helped|building|builds|built|running|runs|ran|leading|leads|led|managing|manages|managed|handling|handles|handled|owning|owns|owned|designing|designs|designed|writing|writes|wrote|working\\s+on|works\\s+on|worked\\s+on|took\\s+over|taking\\s+over|takes\\s+over|is\\s+responsible\\s+for|is\\s+in\\s+charge\\s+of)';
const NOT_A_NAME = new Set(['I', 'We', 'Our', 'My', 'The', 'This', 'That', 'It', 'He', 'She', 'They', 'You', 'Your', 'Their', 'His', 'Her', 'Who', 'Which', 'Everyone', 'Nobody', 'Someone']);
const ACTOR_RE = new RegExp(`\\b([A-Z][\\p{Ll}'’-]+(?:\\s[A-Z][\\p{Ll}'’-]+)?)\\s+(?:(?:is|was|has\\s+been|will\\s+be|has|had|now|also|still)\\s+)*${ACTION_VERB}\\b`, 'gu');
const BY_ACTOR_RE = /\bby\s+([A-Z][\p{Ll}'’-]+(?:\s(?:and|&)\s[A-Z][\p{Ll}'’-]+)?)/gu;
export function uncoveredActors(text, claims = []) {
  const names = new Set();
  for (const m of String(text ?? '').matchAll(ACTOR_RE)) if (!NOT_A_NAME.has(m[1].split(/\s/)[0])) names.add(m[1]);
  for (const m of String(text ?? '').matchAll(BY_ACTOR_RE)) for (const n of m[1].split(/\s(?:and|&)\s/)) if (!NOT_A_NAME.has(n)) names.add(n);
  const mentions = (c, name) => {
    const o = c?.object ?? {};
    const hay = [c?.subject, o.entity, o.literal].filter(Boolean).join(' ').toLowerCase();
    return name.toLowerCase().split(/\s+/).every(w => hay.includes(w));
  };
  return [...names].filter(n => !(Array.isArray(claims) ? claims : []).some(c => mentions(c, n))).slice(0, 3);
}
/** AQUA_E6_ACTOR_RETRY — default decided by measurement (flag registry note). */
export function actorRetryEnabled() {
  return String(process.env.AQUA_E6_ACTOR_RETRY ?? 'on').toLowerCase() !== 'off';
}
/** Second-reading claims that mention a missing actor and are not already held. */
export function mergeActorRetry(first = [], second = [], actors = []) {
  const key = c => JSON.stringify([String(c?.subject ?? '').toLowerCase(), c?.predicate, c?.object, c?.polarity ?? 'asserted']);
  const held = new Set(first.map(key));
  const mentionsActor = c => {
    const o = c?.object ?? {};
    const hay = [c?.subject, o.entity, o.literal].filter(Boolean).join(' ').toLowerCase();
    return actors.some(a => a.toLowerCase().split(/\s+/).every(w => hay.includes(w)));
  };
  const added = (Array.isArray(second) ? second : []).filter(c => !held.has(key(c)) && mentionsActor(c));
  return [...first, ...added];
}

/**
 * AQUA_E6_COMPOUND_RETRY — OFF unless 'on' (2026-10-18). Measured on 70 live
 * development sentences (two 30-sentence runs plus 8 earlier): it fired once, on
 * a false trigger ("Actually" split off as a clause), and recovered nothing —
 * the real misses were claims extracted and then dropped by validation, after
 * coverage had already looked complete. No measured benefit, so not on by default.
 */
export function compoundRetryEnabled() {
  return String(process.env.AQUA_E6_COMPOUND_RETRY ?? '').toLowerCase() === 'on';
}

/** Clauses of a sentence that state a change and that no extracted claim covers. */
export function uncoveredChangeClauses(text, claims = []) {
  const clauses = String(text ?? '').replace(/[.!]+\s*$/, '').split(CLAUSE_SPLIT).map(s => s.trim()).filter(s => s.length >= 8);
  if (clauses.length < 2) return [];
  const claimSets = (Array.isArray(claims) ? claims : []).map(c => clauseTokens(claimText(c)));
  return clauses.filter(clause => {
    if (!CHANGE_CUE.test(clause)) return false;
    const toks = [...clauseTokens(clause)];
    if (!toks.length) return false;
    // Covered when one claim carries at least half of the clause's words.
    return !claimSets.some(set => toks.filter(t => set.has(t)).length / toks.length >= 0.5);
  }).slice(0, 4);
}

const claimKey = c => {
  const o = c?.object ?? {};
  return [String(c?.subject ?? '').toLowerCase(), c?.predicate, String(o.entity ?? o.literal ?? o.time ?? o.quantity ?? '').toLowerCase(), c?.polarity ?? 'asserted'].join('|');
};

/** Second-reading claims that cover a missing clause and are not already held. */
export function mergeCompoundRetry(first = [], second = [], missing = []) {
  const held = new Set(first.map(claimKey));
  const wanted = missing.map(m => [...clauseTokens(m)]);
  const added = (Array.isArray(second) ? second : []).filter(c => {
    if (held.has(claimKey(c))) return false;
    const set = clauseTokens(claimText(c));
    return wanted.some(toks => toks.length && toks.filter(t => set.has(t)).length / toks.length >= 0.5);
  });
  return [...first, ...added];
}
import { validateAgainstSegment, resolveSegmentPolarityConflicts, OUTCOME } from './claimValidator.js';
import { applyTemporal } from './temporalNormaliser.js';
import { resolveClaimEntities } from './entityResolution.js';

/** S0 size bound. Beyond this a single message is a document, and documents
 *  have their own ingest path with its own budget. */
export const MAX_MESSAGE_CHARS = 20_000;

/**
 * A document's `Key: value` line as a claim (key has_property value), or null.
 * Short keys only (≤ 5 words, starts with a letter); the value is copied
 * verbatim without a trailing full stop. Used only for document sources.
 */
export function keyValueClaim(text) {
  const m = String(text ?? '').trim().match(/^([A-Za-z][\w&'/().\- ]{0,48}?)\s*:\s*(\S.{0,298}?)\s*\.?$/);
  if (!m) return null;
  const key = m[1].trim(), value = m[2].trim();
  if (key.split(/\s+/).length > 5 || /^https?$/i.test(key) || value.length < 2) return null;
  return { subject: key, predicate: 'has_property', object: { literal: value }, polarity: 'asserted', modality: 'fact',
    timePrecision: 'none', statementText: String(text).trim().replace(/\.$/, '') };
}

/**
 * Stages this module runs, in blueprint order. S6 joins only when the caller
 * supplies an entity store — resolution against no store would mark every
 * subject provisional and report a resolution rate of zero as if it were a
 * measurement of the resolver.
 */
export const STAGES = Object.freeze(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
export const STAGES_WITH_S6 = Object.freeze([...STAGES, 'S6']);

/** Declared gaps, so no caller has to infer them from silence. */
export const NOT_IMPLEMENTED = Object.freeze({
  S0_partial: ['owner-budget', 'rate-bounds'],
  // S6 tiers ①②③ are built and run when a store is supplied. ④ embedding and
  // ⑤ LLM disambiguation stay injected and absent — τ is unmeasured and both
  // need a provider.
  S6_partial: ['embedding-similarity', 'llm-disambiguation'],
  S7_S9: 'not run here — they need committed entity ids, and S6 emits provisional ones a caller must insert first.',
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
    segments: 0, gated: 0, called: 0, cached: 0, errors: 0, errorReasons: [],
    parsed: 0, admitted: 0, proposed: 0, discarded: 0,
    byGate: {}, models: [],
  };
  // Diagnostics — OFF unless a caller explicitly asks. `byGate` already
  // aggregates a count per rejection reason; it has never carried WHICH claim
  // tripped which rule, so a run that fails one case in twenty could not say
  // whether the model returned nothing or a gate ate it — see the "PER-CASE
  // RECORD" comment in `scripts/e6-shadow.mjs` for the audit this was missing
  // for. `stats.discards` is that missing detail: one entry per S3-contract or
  // S4-validator rejection, carrying the raw claim fields the model produced.
  //
  // Opt-in and additive only: `opts.diagnostics` defaults to false, in which
  // case `stats.discards` is never added to the returned object at all — the
  // production shape `understandTurn` has always returned is byte-identical
  // for every caller that does not ask for this. Existing aggregate metrics
  // (`byGate`, `discarded`, `proposed`, …) are computed exactly as before;
  // this only adds a parallel, opt-in record alongside them.
  if (opts.diagnostics) stats.discards = [];
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

  // Gate ⑤b's list: the subjects rule 12's CONTEXT gave the extractor, with
  // the values it attached to each ("subject | relation | value"). Only these
  // may be a subject the sentence names by reference. The user ("self") is
  // first person already.
  const contextSubjects = new Map();
  for (const line of [...(opts.context?.conversation ?? []), ...(opts.context?.facts ?? [])]) {
    const [subject, , value] = String(line).split(' | ');
    if (!subject || subject === 'self') continue;
    const k = subject.toLowerCase().trim();
    if (!contextSubjects.has(k)) contextSubjects.set(k, []);
    if (value) contextSubjects.get(k).push(value.replace(/ \(NOT\)$/, ''));
  }

  // ── S1 SEGMENTATION ──────────────────────────────────────────────────────
  const segments = segmentMessage(clean);
  stats.segments = segments.length;

  const claims = [];
  const proposals = [];
  // Segments whose extraction COMPLETED (no transport/parse error), with or
  // without claims. The commit ledgers each one, so a retry after a crash or a
  // failure elsewhere in the turn never re-reads a segment that already
  // succeeded (2026-10-18: a second, different reading committed beside — or
  // instead of — the first). Errored segments are absent and stay retryable.
  const completedSegments = [];

  for (const seg of segments) {
    // ── S2 CANDIDATE GATING ────────────────────────────────────────────────
    // DOCUMENT KEY/VALUE FALLBACK (2026-10-11, Pass 2): "Cap: 12 days per
    // month." in an uploaded contract was gated out or came back [] — the
    // constraint never reached the World Model and the answer ignored it.
    // For DOCUMENT sources only, a `key: value` line that yields nothing
    // becomes key has_property value — verbatim, and still through every
    // validation gate below (subject and literal must be in the line).
    const kv = opts.documentFallback ? keyValueClaim(seg.text) : null;
    const admitted = gateSegment(seg.text).admit;
    if (!admitted && !kv) continue;
    stats.gated++;

    // ── S3 LLM EXTRACTION ──────────────────────────────────────────────────
    let out = admitted ? await extractSegment(seg.text, opts) : { claims: [kv], rejected: [], cached: true, model: 'document-key-value' };
    if (!admitted) stats.documentFallbacks = (stats.documentFallbacks ?? 0) + 1;
    else if (out.cached) stats.cached++; else stats.called++;
    if (admitted && kv && !out.error && !out.claims.length && !(out.rejected ?? []).length) {
      out = { ...out, claims: [kv] };
      stats.documentFallbacks = (stats.documentFallbacks ?? 0) + 1;
    }
    // NEGATION RETRY (2026-10-06). Measured on the production extractor: an
    // explicitly negated sentence sometimes comes back as [] ("Nummo is not
    // one of our customers": extracted in pass 1, [] in pass 2), and one such
    // miss in ~19 negation cases fails the 95% gate. CODE decides to ask once
    // more — only when the reading was empty AND error-free, the sentence has
    // an explicit negation cue and is not a question. The model still decides
    // what (if anything) to extract; every gate below still applies. Bounded:
    // at most one extra call per such segment.
    if (!out.error && !out.claims.length && !(out.rejected ?? []).length
        && NEGATION_CUE.test(seg.text) && !/\?\s*$/.test(seg.text.trim())) {
      const again = await extractSegment(seg.text, { ...opts, negationHint: true });
      stats.negationRetries = (stats.negationRetries ?? 0) + 1;
      if (again.cached) stats.cached++; else stats.called++;
      if (!again.error) out = again;
    }
    // COMPOUND RETRY (2026-10-17) — see CHANGE_CUE. Only when the first reading
    // was error-free and returned claims, the sentence is not a question, and a
    // clause stating a change is uncovered. At most one extra call; only claims
    // that cover a missing clause are taken from it, so the second reading can
    // never overwrite what the first one extracted.
    // ACTOR RETRY (2026-10-18) — see ACTOR_RE. Only when the reading was
    // error-free (with or without claims — an EMPTY reading of "Jun is helping
    // me prepare the investor deck" is the same loss), the sentence is not a
    // question, and a named person who acts in it appears in no claim. At most
    // one extra call; only claims that mention a missing actor are taken from it.
    if (admitted && actorRetryEnabled() && !out.error && !/\?\s*$/.test(seg.text.trim())) {
      const actors = uncoveredActors(seg.text, out.claims);
      if (actors.length) {
        const again = await extractSegment(seg.text, { ...opts, actorHint: actors });
        stats.actorRetries = (stats.actorRetries ?? 0) + 1;
        if (again.cached) stats.cached++; else stats.called++;
        if (!again.error) {
          const merged = mergeActorRetry(out.claims, again.claims, actors);
          stats.actorRecovered = (stats.actorRecovered ?? 0) + (merged.length - out.claims.length);
          out = { ...out, claims: merged };
        }
      }
    }
    if (admitted && compoundRetryEnabled() && !out.error && out.claims.length && !/\?\s*$/.test(seg.text.trim())) {
      const missing = uncoveredChangeClauses(seg.text, out.claims);
      if (missing.length) {
        const again = await extractSegment(seg.text, { ...opts, compoundHint: missing });
        stats.compoundRetries = (stats.compoundRetries ?? 0) + 1;
        if (again.cached) stats.cached++; else stats.called++;
        if (!again.error) {
          const merged = mergeCompoundRetry(out.claims, again.claims, missing);
          stats.compoundRecovered = (stats.compoundRecovered ?? 0) + (merged.length - out.claims.length);
          out = { ...out, claims: merged };
        }
      }
    }
    if (out.error) {
      stats.errors++;
      // Kept (bounded) so a durable caller can tell a transport failure — which
      // must be retried — from a segment that simply holds no claim.
      if (stats.errorReasons.length < 5) stats.errorReasons.push(String(out.error).slice(0, 160));
      continue;
    }
    if (out.model) models.add(out.model);
    stats.parsed += out.claims.length;
    out = { ...out, claims: out.claims.map(inferRevises) };
    stats.revisesInferred = (stats.revisesInferred ?? 0) + out.claims.filter(c => c.revisesInferred).length;

    // An unregistered predicate is refused by the S3 contract, which is right
    // — it is not a storable claim. But refusing is not forgetting: S3's own
    // instruction is "unknown predicate → propose, don't force", and dropping
    // the rejection loses the only evidence that the vocabulary is too small.
    // The contract preserves the reason and the raw claim precisely so this
    // routing is possible.
    for (const r of out.rejected ?? []) {
      // 🔴 AN OBJECT-KIND MISMATCH IS VOCABULARY FEEDBACK, NOT A BAD CLAIM.
      //
      // The rule directly above says "unknown predicate → propose, don't
      // force", because refusing is not forgetting and a dropped rejection
      // loses the only evidence the vocabulary is too small. A mismatch is the
      // same complaint one level down: the predicate exists, and the registry
      // disagrees with the model about the SHAPE of its object.
      //
      // The first named-discard run made the case. Every contract rejection in
      // 525 calls was this one rule — 23 of 23 — and the objects were things
      // like `uses → Postgres`, `owns → billing service`, `depends_on → search`
      // and `blocks → Priya`. A person, typed as a literal. Two of the three
      // negation cases that fail the promotion gate on every run are here.
      //
      // Whether those predicates should take entities is an ONTOLOGY decision
      // and not one this file gets to make silently. What it can stop doing is
      // destroying the evidence: the claim, its predicate and the kind actually
      // observed now survive as a proposal, so the next run reports "uses was
      // handed an entity 14 times" instead of a counter nobody can act on.
      //
      // Metrics are untouched. A proposal is not emitted as a fact, so nothing
      // here moves detection — the gate still fails, for the same reason, and
      // now says so in a form somebody can fix.
      const reason = String(r.reason ?? '');
      if (reason.startsWith('object-kind-mismatch')) {
        stats.proposed++;
        proposals.push({
          kind: 'object-shape',
          predicate: r.raw?.predicate,
          observed: ['entity', 'literal', 'quantity', 'time']
            .find(k => r.raw?.object?.[k] !== undefined) ?? 'unknown',
          quote: r.raw?.statementText,
          segment: seg.text,
        });
        continue;
      }
      if (reason.startsWith('unregistered-predicate')) {
        stats.proposed++;
        proposals.push({ kind: 'predicate', predicate: r.raw?.predicate, quote: r.raw?.statementText, segment: seg.text });
      } else {
        // 🔴 THE REASON WAS RIGHT HERE AND WAS THROWN AWAY.
        //
        // `r.reason` already says exactly what failed — `object-kind-mismatch:
        // owns wants literal, got entity`, `bad-modality:speculative`,
        // `missing-statement-text` — and this line replaced all of it with a
        // question mark. Across a 200-case eval that produced a single number,
        // `?:contract: 22`, sitting on top of eleven different rules with
        // eleven different fixes. The three negation cases that fail the
        // promotion gate every run are two of those twenty-two, and nothing in
        // the output could say which rule they tripped.
        //
        // BOUNDED (G6): keyed on the RULE, not the reason. The full reason
        // interpolates the predicate name and is therefore open-ended; the rule
        // set is the fixed list in `extractionContract.js`. The detail still
        // reaches the caller through `rejected`, which is where an open-ended
        // string belongs.
        stats.discarded++;
        const rule = reason.split(':')[0] || 'unknown';
        const key = `?:contract:${rule}`;
        stats.byGate[key] = (stats.byGate[key] ?? 0) + 1;
        if (stats.discards) {
          stats.discards.push({
            stage: 'S3-contract', gate: null, reason,
            segment: seg.text,
            subject: r.raw?.subject ?? null, predicate: r.raw?.predicate ?? null,
            object: r.raw?.object ?? null, polarity: r.raw?.polarity ?? null,
            modality: r.raw?.modality ?? null, statementText: r.raw?.statementText ?? null,
          });
        }
      }
    }

    const segAdmitted = [];
    let segProposed = 0;
    for (const raw of out.claims) {
      // ── S4 CLAIM VALIDATION ──────────────────────────────────────────────
      const v = validateAgainstSegment(raw, seg.text, {
        sourceTier: opts.sourceTier ?? 'chat',
        modelConfidence: raw.confidenceExtraction ?? raw.confidence_extraction ?? 0.5,
        contextSubjects,
      });
      if (v.outcome === OUTCOME.PROPOSE) {
        stats.proposed++;
        segProposed++;
        proposals.push(v.proposal);
        continue;
      }
      if (v.outcome !== OUTCOME.ADMIT) {
        stats.discarded++;
        // 🔴 KEYED BY REASON, NOT BY GATE NUMBER.
        //
        // `claimValidator.fail(gate, reason)` carries BOTH — a numeric stage id
        // and the human-readable cause — and this line kept only the number.
        // The first E6 shadow run reported `discardedByGate: {"2": 2}`, which
        // says a claim died at stage 2 and nothing about why. Gate 2 alone
        // covers `object-missing` AND `object-not-in-quote`: one is the model
        // omitting a field, the other is it inventing content not in the quote.
        // Opposite defects, same bucket, and the bucket was the only record.
        //
        // Both are kept, gate first so the output still sorts by pipeline
        // stage. `?? 'unknown'` because the contract path below sets a reason
        // with no gate number, and a discard with no label at all is the thing
        // this is fixing.
        const key = `${v.gate ?? '?'}:${v.reason ?? 'unknown'}`;
        stats.byGate[key] = (stats.byGate[key] ?? 0) + 1;
        if (stats.discards) {
          stats.discards.push({
            stage: 'S4-validator', gate: v.gate ?? null, reason: v.reason ?? 'unknown',
            segment: seg.text,
            subject: raw.subject ?? null, predicate: raw.predicate ?? null,
            object: raw.object ?? null, polarity: raw.polarity ?? null,
            modality: raw.modality ?? null, statementText: raw.statementText ?? null,
          });
        }
        continue;
      }
      segAdmitted.push(v.claim);
    }

    // ── S4 gate ⑧: a segment cannot assert and negate the same fact ────────
    const g8 = resolveSegmentPolarityConflicts(segAdmitted);
    for (const d of g8.discarded) {
      stats.discarded++;
      const key = `8:${d.reason}`;
      stats.byGate[key] = (stats.byGate[key] ?? 0) + 1;
      if (stats.discards) {
        const c = d.claim;
        stats.discards.push({
          stage: 'S4-validator', gate: 8, reason: d.reason, segment: seg.text,
          subject: c.subject ?? null, predicate: c.predicate ?? null, object: c.object ?? null,
          polarity: c.polarity ?? null, modality: c.modality ?? null, statementText: c.statementText ?? null,
        });
      }
    }
    // COMPLETED = a reading this segment can be final on (see completedSegments):
    // an empty reading, or one with something that survived validation. A reading
    // whose EVERY claim was discarded (it asserted what the sentence does not say)
    // is a failed reading, not a successful empty one — it stays retryable
    // (2026-10-19: a concurrent retry's invalid reading had ledgered the segment
    // and blocked the valid one).
    if (Number.isInteger(seg.start) && Number.isInteger(seg.end)
        && (out.claims.length === 0 || g8.kept.length > 0 || segProposed > 0)) {
      completedSegments.push({ start: seg.start, end: seg.end });
    }
    const segClaims = [];
    for (const admitted of g8.kept) {
      stats.admitted++;
      // ── S5 TEMPORAL NORMALISATION ────────────────────────────────────────
      const dated = applyTemporal(admitted, opts.assertedAt ?? null);
      segClaims.push({ ...dated, segment: { start: seg.start, end: seg.end, index: seg.index } });
    }
    // ONE CHANGE, ONE START (2026-10-11): "from next month my lead will be
    // Dalia, not Oren" yields Dalia (dated) and NOT Oren (often undated). The
    // old value's retirement belongs to the SAME future moment — undated, it
    // retired Oren today. Within one segment, an undated revision of the same
    // predicate inherits the future start of the dated one.
    const futureRev = segClaims.find(c => c.revises === true && c.temporal?.future && c.validFrom);
    if (futureRev) {
      for (const c of segClaims) {
        if (c !== futureRev && c.revises === true && c.predicate === futureRev.predicate && !c.validFrom && !c.validTo) {
          c.validFrom = futureRev.validFrom;
          c.timePrecision = futureRev.timePrecision;
          c.temporal = Object.freeze({ ...c.temporal, future: true, inheritedFrom: 'segment-revision' });
        }
      }
    }
    claims.push(...segClaims);
  }

  stats.models = [...models];

  // ── S6 ENTITY RESOLUTION ─────────────────────────────────────────────────
  // Only with a store. Without one every subject would come back provisional
  // and the run would report a resolution rate of zero — a number that looks
  // like a measurement of the resolver and is actually a measurement of the
  // caller forgetting an argument.
  if (!opts.entityStore) {
    return {
      claims, proposals,
      entityResolution: 'unresolved',
      stagesRun: STAGES,
      notImplemented: NOT_IMPLEMENTED,
      stats,
    };
  }

  const resolved = [];
  stats.s6 = { ready: 0, ambiguous: 0, provisional: 0, byTier: {} };
  for (const c of claims) {
    const r = await resolveClaimEntities(c, opts.entityStore, {
      selfEntityId: opts.selfEntityId,
      embeddingMatch: opts.embeddingMatch,
      disambiguate: opts.disambiguate,
    });
    for (const side of [r.subject, r.object]) {
      if (side?.tier) stats.s6.byTier[side.tier] = (stats.s6.byTier[side.tier] ?? 0) + 1;
    }
    if (r.ready) stats.s6.ready++;
    if (r.subject.tier === 'ambiguous' || r.object.tier === 'ambiguous') stats.s6.ambiguous++;
    if (r.subject.provisional || r.object.provisional) stats.s6.provisional++;
    resolved.push({ ...c, subjectEntityId: r.subject.entityId, objectEntityId: r.object.entityId,
      resolution: { subject: r.subject, object: r.object, ready: r.ready, blockedBy: r.blockedBy } });
  }

  return {
    claims: resolved,
    proposals,
    completedSegments,
    // Only claims whose BOTH ends carry ids may reach S7. An ambiguous or
    // provisional end is not an id, and E6/PR-8 refuses to build an edge from
    // a surface string for exactly that reason.
    entityResolution: 'resolved',
    readyForS7: resolved.filter(c => c.resolution.ready),
    stagesRun: STAGES_WITH_S6,
    notImplemented: NOT_IMPLEMENTED,
    stats,
  };
}
