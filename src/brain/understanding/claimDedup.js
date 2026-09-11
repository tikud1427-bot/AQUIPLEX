/**
 * AQUA — Dedup, corroboration & contradiction, stage S8 (Blueprint E6/PR-9)
 *
 *   exact: (subject, predicate, object, polarity) match → attach evidence
 *   semantic: cosine ≥ τ AND same subject+predicate → LLM equivalence check
 *     → merge, survivor = higher source tier (document absorbs chat)
 *   CONTRADICTION: same subject+predicate, incompatible object OR opposite
 *     polarity, overlapping validity → emit ContradictionDetected;
 *     DO NOT resolve here (that is Reflection)
 *
 * IT DETECTS AND REFUSES TO DECIDE
 * --------------------------------
 * The last line of the spec is the load-bearing one. S8 emits a contradiction
 * and stops. Picking a winner needs the whole world model, the user's
 * correction history and a sense of which source is trustworthy for this
 * subject — none of which is available while looking at two rows. A stage that
 * quietly resolved would manufacture certainty, and the resulting single
 * surviving claim would look like a fact nobody ever disputed.
 *
 * THIS IS NOT THE TEXT CONTRADICTION DETECTOR
 * -------------------------------------------
 * `relationshipEngine.conflictKind(a, b)` compares two free-text statements
 * heuristically and is gated at 93.3% recall. This compares STRUCTURED claims:
 * same subject, same predicate, and either opposite polarity or an
 * incompatible object, with overlapping validity. Different input, different
 * mechanism, and neither replaces the other — the text detector still runs on
 * everything that never became a claim. Structure is what makes this one
 * deterministic where that one has to guess.
 *
 * 🔴 WHY "INCOMPATIBLE OBJECT" IS OFF BY DEFAULT
 * ----------------------------------------------
 * Two claims differing only in object are a contradiction ONLY if the
 * predicate is single-valued:
 *
 *   uses → Postgres  +  uses → Redis        both true. Not a contradiction.
 *   knows → Dev      +  knows → Priya       both true. Not a contradiction.
 *   works_at → Nummo +  works_at → Zeta     probably a contradiction.
 *
 * The registry does not know which is which. Its predicate spec carries
 * `name class objectKind inverse symmetric source` — audited, and there is no
 * cardinality flag anywhere. So firing on "different object" would over-fire
 * on every multi-valued predicate, which is precisely the failure FINDING-1
 * measured: a contradiction rule that fires on ordinary variation and accuses
 * the user of disagreeing with themselves.
 *
 * `functionalPredicates` therefore defaults to EMPTY. The branch is built and
 * tested; it fires only on predicates a caller explicitly declares
 * single-valued. Populating that set is its own PR with its own measurement —
 * which predicates are actually single-valued IN THE CORPUS — rather than a
 * list assembled from intuition.
 *
 * POLARITY CONTRADICTION NEEDS NO SUCH KNOWLEDGE and is always on: "uses
 * Postgres" and "does NOT use Postgres" over the same window disagree whatever
 * the predicate's cardinality.
 *
 * NOT WIRED. No production caller, no flag. E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2`.
 */

/** Source tiers, strongest first — "document absorbs chat, existing and correct". */
const TIER_RANK = Object.freeze({ explicit: 4, file: 3, chat: 2, inferred: 1 });
const rankOf = tier => TIER_RANK[tier] ?? 0;

const norm = v => String(v ?? '').trim().toLowerCase();

/** The object as a comparable scalar, kind included so 5 ≠ "5". */
function objectSig(claim) {
  const o = claim?.object ?? {};
  const kind = claim?.objectKind
    ?? ['entity', 'literal', 'quantity', 'time'].find(k => o[k] !== undefined && o[k] !== null)
    ?? null;
  if (!kind) return { kind: null, value: null };
  return { kind, value: norm(o[kind] ?? o.value) };
}

/**
 * Exact identity: subject + predicate + object + polarity.
 *
 * Modality is DELIBERATELY absent. "I plan to join Zeta" and "I joined Zeta"
 * share a subject, predicate and object but are claims about different worlds,
 * so they must not collapse — which is why modality is compared separately in
 * `sameClaim` rather than folded into the key. Keeping it out of the key means
 * they land in the same bucket and are then distinguished, instead of never
 * being compared at all.
 */
export function exactKey(claim) {
  const { kind, value } = objectSig(claim);
  return [norm(claim?.subject), norm(claim?.predicate), kind, value,
    claim?.polarity ?? 'asserted'].join('\u0000');
}

/** Bucket key for contradiction search: subject + predicate only. */
export const subjectPredicateKey = c => `${norm(c?.subject)}\u0000${norm(c?.predicate)}`;

/**
 * Do two validity windows overlap? Null means unbounded on that side.
 *
 * Getting the nulls wrong is the whole game. Treating an unbounded end as
 * "now" makes two historical claims look disjoint; treating it as zero makes
 * everything overlap. Both produce a contradiction count that is wrong in a
 * direction nobody can see from the output.
 */
export function validityOverlaps(a, b) {
  const aFrom = a?.validFrom ? Date.parse(a.validFrom) : -Infinity;
  const aTo   = a?.validTo   ? Date.parse(a.validTo)   : Infinity;
  const bFrom = b?.validFrom ? Date.parse(b.validFrom) : -Infinity;
  const bTo   = b?.validTo   ? Date.parse(b.validTo)   : Infinity;
  // An unparseable date is treated as unbounded rather than NaN — NaN
  // comparisons are all false, which would silently report NO overlap and
  // hide every contradiction involving a malformed date.
  const f = n => (Number.isNaN(n) ? null : n);
  const A0 = f(aFrom) ?? -Infinity, A1 = f(aTo) ?? Infinity;
  const B0 = f(bFrom) ?? -Infinity, B1 = f(bTo) ?? Infinity;
  return A0 <= B1 && B0 <= A1;
}

/** Same claim in every respect that matters for corroboration. */
export function sameClaim(a, b) {
  return exactKey(a) === exactKey(b) && (a?.modality ?? 'fact') === (b?.modality ?? 'fact');
}

/**
 * Why, if at all, do these two structured claims contradict?
 *
 * @returns {{contradicts:boolean, kind:string|null, reason:string|null}}
 */
export function contradictionBetween(a, b, opts = {}) {
  const no = (reason) => ({ contradicts: false, kind: null, reason });

  if (!a || !b) return no('missing-claim');
  if (subjectPredicateKey(a) !== subjectPredicateKey(b)) return no('different-subject-predicate');

  // Only factual assertions can contradict. An intent and a fact about the
  // same subject describe different worlds — "I plan to leave Nummo" does not
  // disagree with "I work at Nummo", it explains it.
  const ma = a.modality ?? 'fact', mb = b.modality ?? 'fact';
  if (ma !== 'fact' || mb !== 'fact') return no('non-factual-modality');

  // Overlapping validity is required by the spec. "I worked at Intercom until
  // 2024" and "I work at Nummo since 2024" are a career, not a conflict.
  if (!validityOverlaps(a, b)) return no('disjoint-validity');

  const pa = a.polarity ?? 'asserted', pb = b.polarity ?? 'asserted';
  const oa = objectSig(a), ob = objectSig(b);

  // OPPOSITE POLARITY on the same object. Always detectable, no cardinality
  // knowledge needed.
  if (pa !== pb && oa.kind === ob.kind && oa.value === ob.value) {
    return { contradicts: true, kind: 'polarity', reason: `${pa} vs ${pb} on the same object` };
  }

  // INCOMPATIBLE OBJECT — only for predicates the caller declares
  // single-valued. See the header: the registry has no cardinality flag, and
  // firing without one accuses a user of contradicting themselves for saying
  // they use two databases.
  const functional = opts.functionalPredicates instanceof Set
    ? opts.functionalPredicates
    : new Set(opts.functionalPredicates ?? []);
  if (pa === pb && functional.has(a.predicate) && oa.value !== ob.value) {
    return { contradicts: true, kind: 'object',
      reason: `${a.predicate} is single-valued but holds ${oa.value} and ${ob.value}` };
  }

  return no('compatible');
}

/**
 * Fold a batch of claims against an existing set.
 *
 * @param {object[]} incoming
 * @param {object[]} [existing]
 * @param {object} [opts]
 * @param {Set<string>} [opts.functionalPredicates] see above — empty by default
 * @param {Function} [opts.semanticMerge] async (a, b) => boolean. Absent → the
 *   semantic tier does not run at all. It needs embeddings AND an LLM
 *   equivalence check, neither of which is available where this is tested, and
 *   τ has not been measured. An unmeasured threshold applied by default is the
 *   thing this project keeps refusing to ship.
 */
export function dedupAndDetect(incoming, existing = [], opts = {}) {
  const kept = new Map();
  const corroborations = [];
  const contradictions = [];

  // Seed with what is already stored so incoming claims corroborate and
  // contradict against history, not only against each other in this batch.
  for (const c of Array.isArray(existing) ? existing : []) {
    if (c) kept.set(exactKey(c), { claim: c, evidence: [...(c.evidence ?? [])], corroborationCount: 1 });
  }

  for (const claim of Array.isArray(incoming) ? incoming : []) {
    if (!claim) continue;
    const key = exactKey(claim);
    const hit = kept.get(key);

    if (hit && sameClaim(hit.claim, claim)) {
      // EXACT MATCH → attach evidence. Not a second row: the same fact said
      // twice is one claim with two sources, and storing it twice would make
      // repetition look like independent corroboration while also inflating
      // every count that reads the store.
      hit.corroborationCount++;
      if (claim.evidence) hit.evidence.push(...[].concat(claim.evidence));
      else if (claim.claimId) hit.evidence.push(claim.claimId);

      // The SURVIVOR is the higher source tier — "document absorbs chat,
      // existing and correct". Ties keep the incumbent, so re-ingesting the
      // same export cannot churn the store.
      if (rankOf(claim.sourceTier) > rankOf(hit.claim.sourceTier)) {
        hit.claim = { ...claim, evidence: hit.evidence };
      }
      corroborations.push({ key, count: hit.corroborationCount });
      continue;
    }

    // Contradiction search runs over the subject+predicate bucket, not the
    // whole store.
    for (const other of kept.values()) {
      const v = contradictionBetween(claim, other.claim, opts);
      if (v.contradicts) {
        // EMITTED, NOT RESOLVED. Both claims stay. Reflection decides.
        contradictions.push({
          kind: v.kind, reason: v.reason,
          incoming: claim, existing: other.claim,
          subject: claim.subject, predicate: claim.predicate,
        });
      }
    }

    kept.set(key, { claim, evidence: [...(claim.evidence ?? [])], corroborationCount: 1 });
  }

  return {
    claims: [...kept.values()].map(k => ({ ...k.claim, corroborationCount: k.corroborationCount })),
    corroborations,
    contradictions,
    stats: {
      incoming: Array.isArray(incoming) ? incoming.length : 0,
      existing: Array.isArray(existing) ? existing.length : 0,
      kept: kept.size,
      corroborated: corroborations.length,
      contradictions: contradictions.length,
      byKind: contradictions.reduce((a, c) => ({ ...a, [c.kind]: (a[c.kind] ?? 0) + 1 }), {}),
      // Whether the semantic tier ran at all. A merge rate of zero means
      // something different when the tier was never invoked, and PR-11 must be
      // able to tell those apart.
      semanticTierRan: typeof opts.semanticMerge === 'function',
    },
  };
}
