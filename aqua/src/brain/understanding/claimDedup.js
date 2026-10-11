/**
 * AQUA — Dedup, corroboration & contradiction, stage S8 (Blueprint E6/PR-9)
 *
 *   exact: (subject, predicate, object, polarity) match → attach evidence
 *   semantic: cosine ≥ τ AND same subject+predicate → LLM equivalence check
 *     → merge, survivor = higher source tier (document absorbs chat)
 *   CONTRADICTION: same subject+predicate, incompatible object OR opposite
 *     polarity, overlapping validity → emit claim.contradiction.detected;
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

  // HISTORY IS NOT CONTRADICTED (2026-10-04). A superseded or archived claim
  // describes the past; a new value disagrees with the CURRENT one, not with
  // every value the subject ever had. Without this, A→B→C flagged C against A
  // as well as B, and the worker's attempt to supersede an already-superseded
  // claim threw "lifecycle transition changes nothing" until it dead-lettered.
  const historical = st => st === 'superseded' || st === 'archived';
  if (historical(a.state) || historical(b.state)) return no('historical');

  // ONE-PER-OBJECT (2026-10-04): "Kavya owns the payment integration" and
  // "Rohan owns the payment integration" share no subject, yet compete — the
  // registry declares `owns` one-per-object (its inverse `owned_by` holds one
  // value). Same predicate, same entity object, different subjects, both
  // asserted facts with overlapping validity → an object contradiction.
  const singleObject = opts.singleObjectPredicates instanceof Set
    ? opts.singleObjectPredicates : new Set(opts.singleObjectPredicates ?? []);
  if (singleObject.has(a.predicate) && a.predicate === b.predicate
      && norm(a.subject) !== norm(b.subject)) {
    const oa = objectSig(a), ob = objectSig(b);
    const facts = (a.modality ?? 'fact') === 'fact' && (b.modality ?? 'fact') === 'fact';
    const asserted = (a.polarity ?? 'asserted') === 'asserted' && (b.polarity ?? 'asserted') === 'asserted';
    if (facts && asserted && oa.kind === 'entity' && oa.kind === ob.kind && oa.value === ob.value
        && validityOverlaps(a, b)) {
      return { contradicts: true, kind: 'object',
        reason: `${a.predicate} is one-per-object but ${oa.value} has ${a.subject} and ${b.subject}` };
    }
    return no('different-subject-predicate');
  }
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
/**
 * An incoming claim expressed in the vocabulary the store uses: stored claims
 * carry an entity's CANONICAL label ("You"), incoming ones carry the surface
 * text ("I"), and S8 compares by key, so the two never met. One definition,
 * used by the facade and by anything that rehearses the facade.
 */
export function inStoredVocabulary(c) {
  return {
    ...c,
    subject: c._canonicalSubject?.canonical ?? c._canonicalSubject?.name ?? c.subject,
    object: c.objectKind === 'entity'
      ? { ...c.object, entity: c._canonicalObject?.canonical ?? c._canonicalObject?.name ?? c.object?.entity }
      : c.object,
  };
}

// ── Blocker resolution vocabulary (Pass 2) ──────────────────────────────────
const PENDING_PREDICATES = new Set(['has_status', 'has_property']);
const RESOLVED_RE = /\b(?:fixed|resolved|solved|done|complete(?:d)?|finished|signed|approved|granted|arrived|delivered|received|returned|came\s+through|cleared|sorted(?:\s+out)?|unblocked|repaired|working\s+again|back\s+online|passed|accepted|issued|no\s+longer\s+(?:an?\s+)?(?:issue|problem|blocking|blocker))\b/i;
const UNRESOLVED_RE = /\b(?:not|n['’]t|never|still|yet|pending|waiting|awaiting|delayed|late|stuck)\b/i;
const PENDING_RE = /\b(?:hasn['’]t|has\s+not|haven['’]t|have\s+not|isn['’]t|not\s+yet|still|pending|waiting|awaiting|late|delayed|stuck|missing|broken|down|blocked|blocking|overdue|timing\s+out|failing|fails|keeps)\b/i;

/** "the embassy" / "The Embassy" / "my visa application" → one comparable key. */
function labelKey(s) {
  return String(s ?? '').toLowerCase().normalize('NFKC').replace(/^(?:the|a|an|my|our|your)\s+/, '').replace(/\s+/g, ' ').trim();
}
/** An asserted factual STATUS that reports something as resolved — and not "still not signed". */
export function isResolutionStatus(c) {
  if (!c || !PENDING_PREDICATES.has(c.predicate)) return false;
  if ((c.polarity ?? 'asserted') !== 'asserted' || (c.modality ?? 'fact') !== 'fact') return false;
  const v = String(c.object?.literal ?? c.object?.value ?? '');
  return RESOLVED_RE.test(v) && !UNRESOLVED_RE.test(v);
}
function isPendingStatus(c) {
  return PENDING_RE.test(String(c.object?.literal ?? c.object?.value ?? ''));
}
// Words that name a KIND of thing, not WHICH thing: never enough to link two
// mentions on their own ("the launch moved" could be any launch).
const GENERIC_WORDS = new Set(['launch', 'project', 'deadline', 'date', 'event', 'meeting', 'thing', 'plan', 'release',
  'line', 'deal', 'trip', 'work', 'task', 'job', 'new', 'next', 'big', 'final', 'first', 'call', 'review', 'report',
  'application', 'app', 'product', 'feature', 'version', 'phase', 'stage', 'one', 'user', 'you', 'self']);
const WORD_STOP = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'of', 'for', 'to', 'on', 'in', 'at', 'and', 'is', 'are',
  "we're", 'we', 'i', "i'm", 'by', 'with', 'from', 'actually', 'now', 'moved', 'move']);
const stemWord = w => w.replace(/(?:ing|ed|es|s)$/, '');
function subjectWords(s) {
  return [...new Set(String(s ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}']+/u)
    .filter(w => w.length > 2 && !WORD_STOP.has(w)).map(stemWord).filter(w => w.length > 2))];
}

/** Predicates S8 needs in history when a batch carries a resolution status. */
export const RESOLUTION_HISTORY_PREDICATES = Object.freeze(['blocks', 'blocked_by', 'has_status', 'has_property']);

export function dedupAndDetect(incoming, existing = [], opts = {}) {
  const kept = new Map();
  const corroborations = [];
  const contradictions = [];
  const evidenceAttachments = [];
  const ambiguousRevisions = [];

  // Seed with what is already stored so incoming claims corroborate and
  // contradict against history, not only against each other in this batch.
  for (const c of Array.isArray(existing) ? existing : []) {
    if (c) kept.set(exactKey(c), { claim: c, evidence: [...(c.evidence ?? [])], corroborationCount: 1 });
  }

  for (const claim of Array.isArray(incoming) ? incoming : []) {
    if (!claim) continue;
    const key = exactKey(claim);
    const hit = kept.get(key);

    // A match on a SUPERSEDED/ARCHIVED claim is a RETURN to an old value
    // ("Berlin → Paris → back in Berlin"), not corroboration of history:
    // attaching evidence there left the intermediate value current. It goes
    // on as a new claim, and contradicts whatever is current now.
    const hitIsHistory = hit && (hit.claim.state === 'superseded' || hit.claim.state === 'archived');
    if (hit && !hitIsHistory && sameClaim(hit.claim, claim)) {
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
      evidenceAttachments.push({ targetClaimId: hit.claim.claimId, claim: { ...claim } });
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

    // SOLE-VALUE REVISION (D6, 2026-10-05). The user presented this claim as a
    // CHANGE (`revises`, prompt rule 11) of a MANY-valued relation without
    // naming the old value — "the backend is Rust now". Cardinality cannot say
    // what it replaces (a project uses Go AND Postgres), so it is decided by the
    // owner's own history: if the subject holds exactly ONE other current value
    // for this relation, that is what changed — emitted as a contradiction for
    // the policy (rule 2) to retire. Two or more → ambiguous: nothing is
    // retired, the ambiguity is recorded. Single-valued relations never need
    // this (the snapshot rule already covers them).
    const functional = opts.functionalPredicates instanceof Set
      ? opts.functionalPredicates : new Set(opts.functionalPredicates ?? []);
    if (claim.revises === true && (claim.polarity ?? 'asserted') === 'asserted'
        && (claim.modality ?? 'fact') === 'fact' && !functional.has(claim.predicate)) {
      const sig = objectSig(claim);
      const rivals = [...kept.values()].map(k => k.claim).filter(o => o !== claim && o._persisted
        && subjectPredicateKey(o) === subjectPredicateKey(claim)
        && o.state !== 'superseded' && o.state !== 'archived'
        && (o.polarity ?? 'asserted') === 'asserted' && (o.modality ?? 'fact') === 'fact'
        && objectSig(o).value !== sig.value);
      if (rivals.length === 1 && !contradictions.some(c => c.incoming === claim && c.existing === rivals[0])) {
        contradictions.push({
          kind: 'revision', reason: `${claim.predicate} revised; ${rivals[0].subject} held one other current value`,
          incoming: claim, existing: rivals[0], subject: claim.subject, predicate: claim.predicate,
        });
      } else if (rivals.length > 1) {
        ambiguousRevisions.push({ claim, candidates: rivals.length });
      }
    }

    // ROLE HANDOVER (2026-10-11). "My biggest client is NOW Sora Studio" is a
    // related_to claim (prompt rule 13) about a DIFFERENT subject than the one
    // it replaces, so the subject-keyed rules above never compare the two and
    // "Kumo Games — biggest client" stayed current forever. The user framed it
    // as a change (`revises`), so the role moved: decided by the owner's own
    // history, exactly like a sole-value revision — if exactly ONE other
    // subject currently holds the same role, that holder is what changed
    // (emitted for the policy, rule 2, to retire). Two or more → ambiguous,
    // nothing retired: "my client is now X" does not end every other client.
    if (claim.revises === true && claim.predicate === 'related_to' && (claim.polarity ?? 'asserted') === 'asserted'
        && (claim.modality ?? 'fact') === 'fact') {
      const role = objectSig(claim).value;
      const holders = [...kept.values()].map(k => k.claim).filter(o => o !== claim && o._persisted
        && o.predicate === 'related_to' && objectSig(o).value === role
        && String(o.subject ?? '').toLowerCase() !== String(claim.subject ?? '').toLowerCase()
        && o.state !== 'superseded' && o.state !== 'archived'
        && (o.polarity ?? 'asserted') === 'asserted' && (o.modality ?? 'fact') === 'fact');
      if (holders.length === 1 && !contradictions.some(c => c.incoming === claim && c.existing === holders[0])) {
        contradictions.push({
          kind: 'revision', reason: `role "${role}" handed over from ${holders[0].subject} to ${claim.subject}`,
          incoming: claim, existing: holders[0], subject: claim.subject, predicate: claim.predicate,
        });
      } else if (holders.length > 1) {
        ambiguousRevisions.push({ claim, candidates: holders.length });
      }
    }

    // RENAMED SUBJECT (2026-10-11, Pass 2, real-extraction finding). "We're
    // launching the ceramic planter line on May 4" … "Actually the planter
    // launch moved to May 18": the second mention minted a NEW subject, so two
    // current launch dates competed forever. Linked only on supported evidence:
    // the user framed it as a CHANGE (`revises`) of a SINGLE-valued relation,
    // the new subject holds no current value of its own, and EVERY word of the
    // new subject (stemmed) appears in exactly one existing current claim of
    // that relation — its subject or its own source sentence — with at least
    // one DISTINCTIVE word ("planter", not "launch"). Two candidates → nothing
    // retired, recorded as ambiguous. Never a merge by similarity alone.
    if (claim.revises === true && functional.has(claim.predicate)
        && (claim.polarity ?? 'asserted') === 'asserted' && (claim.modality ?? 'fact') === 'fact'
        && !contradictions.some(c => c.incoming === claim)) {
      const words = subjectWords(claim.subject);
      const hasOwn = [...kept.values()].some(k => k.claim !== claim && k.claim._persisted
        && subjectPredicateKey(k.claim) === subjectPredicateKey(claim) && k.claim.state !== 'superseded' && k.claim.state !== 'archived');
      if (!hasOwn && words.some(w => !GENERIC_WORDS.has(w))) {
        const cands = [...kept.values()].map(k => k.claim).filter(o => o !== claim && o._persisted
          && o.predicate === claim.predicate && labelKey(o.subject) !== labelKey(claim.subject)
          && o.state !== 'superseded' && o.state !== 'archived'
          && (o.polarity ?? 'asserted') === 'asserted' && (o.modality ?? 'fact') === 'fact'
          && (() => { const have = new Set([...subjectWords(o.subject), ...subjectWords(o.statementText ?? o.statement ?? '')]); return words.every(w => have.has(w)); })());
        if (cands.length === 1) {
          contradictions.push({
            kind: 'revision', reason: `"${claim.subject}" refers to the subject of "${cands[0].statementText ?? cands[0].subject}" (renamed mention of the same ${claim.predicate})`,
            incoming: claim, existing: cands[0], subject: claim.subject, predicate: claim.predicate,
          });
        } else if (cands.length > 1) {
          ambiguousRevisions.push({ claim, candidates: cands.length, reason: 'renamed-subject' });
        }
      }
    }

    // BLOCKER RESOLUTION (2026-10-11, Pass 2). "The embassy returned my
    // passport" / "the firmware bug is fixed now" arrive as a STATUS of the
    // thing that was blocking, and nothing compared them with the blocker
    // relation — so the old blocker stayed current and was answered as the
    // present (Lift v3 failure class). Only an explicit RESOLUTION status
    // counts (not any positive update), and only claims LINKED to the
    // resolved thing are retired: X blocks …, … blocked_by X, X's own pending
    // state, and — when the resolved thing is the blocked TASK itself — its
    // blockers. Emitted as revisions (rule 2 retires the older claim, kept
    // as history); nothing else is touched.
    if (isResolutionStatus(claim)) {
      const who = labelKey(claim.subject);
      const linked = [...kept.values()].map(k => k.claim).filter(o => o !== claim && o._persisted
        && o.state !== 'superseded' && o.state !== 'archived'
        && (o.polarity ?? 'asserted') === 'asserted' && (o.modality ?? 'fact') === 'fact'
        && ((o.predicate === 'blocks' && labelKey(o.subject) === who)
          || (o.predicate === 'blocked_by' && labelKey(o.object?.entity) === who)
          || (o.predicate === 'blocked_by' && labelKey(o.subject) === who)
          || (o.predicate === 'blocks' && labelKey(o.object?.entity) === who)
          || (PENDING_PREDICATES.has(o.predicate) && labelKey(o.subject) === who && isPendingStatus(o))));
      for (const o of linked) {
        if (contradictions.some(c => c.incoming === claim && c.existing === o)) continue;
        contradictions.push({
          kind: 'revision', reason: `${claim.subject} resolved ("${objectSig(claim).value}") — ${o.predicate} no longer current`,
          incoming: claim, existing: o, subject: claim.subject, predicate: claim.predicate,
        });
      }
      if (linked.length) claim.revises = true;
    }

    kept.set(key, { claim, evidence: [...(claim.evidence ?? [])], corroborationCount: 1 });
  }

  return {
    claims: [...kept.values()].map(k => ({ ...k.claim, corroborationCount: k.corroborationCount })),
    corroborations,
    evidenceAttachments,
    contradictions,
    // Revisions S8 refused to resolve because more than one current value could
    // be the one replaced. Nothing was retired for them.
    ambiguousRevisions,
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
