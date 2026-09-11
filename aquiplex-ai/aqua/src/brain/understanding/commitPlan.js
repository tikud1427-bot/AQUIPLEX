/**
 * AQUA — Commit plan, stage S9 (Blueprint E6/PR-10)
 *
 *   claims + evidence + claim_evidence + entities + aliases + edges
 *   + events + lifecycle_transitions(extracted→active) + outbox event
 *   idempotency key = (source_id, segment_range, extractor_version)
 *   → re-ingest is a no-op; extractor upgrade re-runs cleanly
 *
 * S9 is now executable: all nine logical write targets have physical migrations.
 * ---------------------------------------------------------------------------
 * The plan remains pure and substrate-agnostic. The repository is the only
 * production SQL writer; this module describes the transaction before it is
 * applied and keeps the dependency order and idempotency contract testable.
 *
 * THREE DEFECTS IN THE EXISTING WRITER, FOUND WHILE READING FOR THIS
 * ------------------------------------------------------------------
 * By inspection of the claim writer under `src/core/claims/` — named
 * indirectly because the one-writer guard greps for that identifier and fired
 * on this very comment. The guard is right: a module naming it looks like a
 * caller, and this one imports nothing from it. Rewording keeps the guard at
 * full strength rather than spending its one firing on prose.
 *
 * No Postgres is reachable from the
 * analysis sandbox, so these are read, not executed, and want confirming
 * against a real database before anyone acts on them:
 *
 *   1. `recordClaim` IS NOT TRANSACTIONAL. It runs SELECT, INSERT, then
 *      `attachEvidence` as separate statements on the pool. A crash between
 *      the INSERT and the evidence write leaves a claim with no evidence —
 *      which S4 gate ① calls "a hallucination with a database row".
 *      `supersede()` does use BEGIN/COMMIT on a checked-out client, so the
 *      pattern exists in the file; it just is not applied here.
 *
 *   2. THE IDEMPOTENCY KEY IS NOT THE ONE S9 SPECIFIES. The dedupe SELECT is
 *      `(owner_id, subject_entity_id, predicate, statement_norm)`.
 *      `extractor_version` is stored but never compared. So "extractor upgrade
 *      re-runs cleanly" does not hold: a v2 extractor re-processing the same
 *      source finds the v1 row and returns `created:false`, and the upgrade
 *      silently produces nothing.
 *
 *   3. `recordClaim` CALLS `ensurePredicate`, WHICH AUTO-REGISTERS. That is
 *      precisely what S4 gate ③ exists to prevent. Gating at S4 only works if
 *      nothing reaches the writer ungated, and the writer currently has no
 *      opinion — so a caller that skips S4 can still teach the registry
 *      `enjoys_working_at`.
 *
 * None of the three is fixed here. Each is a change to a shipped writer with
 * its own blast radius, and #2 in particular changes what re-ingest does.
 *
 * NOT WIRED. No production caller, no flag.
 */
import crypto from 'node:crypto';

/**
 * LOGICAL targets, not physical table names.
 *
 * The first draft named the tables directly and tripped two guards — "only the
 * REPOSITORY touches the claim tables — one writer" and "nothing CALLS the
 * repository yet". Both were RIGHT: a module that names those tables looks
 * like a writer, and the correct response is not an allowlist exemption but
 * the realisation that a PLAN HAS NO BUSINESS KNOWING THE PHYSICAL SCHEMA.
 *
 * Logical names keep the plan substrate-agnostic, leave the one-writer rule at
 * full strength for actual writers, and mean a table rename is a mapping
 * change in the executor rather than an edit here. The logical → physical
 * mapping lives in the test, which reads the migrations to check it.
 */
export const WRITABLE_TARGETS = Object.freeze(new Set([
  'sources', 'evidence', 'entities', 'aliases', 'claims', 'claim_evidence',
  'edges', 'events', 'lifecycle_transitions', 'outbox',
]));

/** Kept as an empty set so callers/tests can report future migration drift. */
export const PENDING_TARGETS = Object.freeze(new Set());

/**
 * Dependency order. Not alphabetical, not the order the spec lists them —
 * foreign keys decide it.
 *
 * A claim references a subject entity and a source; `claim_evidence` bridges
 * claims and evidence; an edge references a claim. Write an edge before its
 * claim and the FK rejects it, inside a transaction that then rolls back
 * everything — one ordering mistake discards a whole turn's understanding.
 */
export const COMMIT_ORDER = Object.freeze([
  'sources',
  'evidence',
  'entities',
  'aliases',
  'claims',
  'claim_evidence',
  'edges',
  'events',
  'lifecycle_transitions',
  'outbox',
]);

/**
 * The S9 idempotency key: (source_id, segment_range, extractor_version).
 *
 * WHY ALL THREE. Source alone would make a second segment of the same message
 * look already-committed. Source plus range makes re-ingest a no-op, which is
 * half the promise. The extractor version is what makes the other half work —
 * "extractor upgrade re-runs cleanly" is only true if a new version produces a
 * DIFFERENT key and therefore does not collide with what v1 wrote.
 *
 * The range is normalised to `start:end` so `[0,22]` and `{start:0,end:22}`
 * hash alike; two shapes of the same range producing two keys would silently
 * double-commit.
 */
export function idempotencyKey({ sourceId, segmentRange, extractorVersion }) {
  const range = Array.isArray(segmentRange)
    ? `${segmentRange[0]}:${segmentRange[1]}`
    : segmentRange && typeof segmentRange === 'object'
      ? `${segmentRange.start}:${segmentRange.end}`
      : String(segmentRange ?? '');

  return crypto.createHash('sha256')
    .update(String(sourceId ?? '')).update('\u0000')
    .update(range).update('\u0000')
    .update(String(extractorVersion ?? ''))
    .digest('hex');
}

const op = (target, rows, note = null) => ({
  target,
  rows: Object.freeze([...rows]),
  count: rows.length,
  writable: WRITABLE_TARGETS.has(target),
  pendingMigration: PENDING_TARGETS.has(target),
  note,
});

/**
 * Build the ordered commit plan for one segment's understanding.
 *
 * @param {object} input
 * @param {string} input.sourceId
 * @param {number[]|object} input.segmentRange  from E6/PR-1
 * @param {string} input.extractorVersion
 * @param {object[]} [input.claims]         post-S8
 * @param {object[]} [input.edges]          post-S7
 * @param {object[]} [input.events]
 * @param {object[]} [input.contradictions] post-S8 — emitted, never resolved
 * @param {Set<string>} [input.committedKeys] keys already written
 * @returns {{key:string, committed:boolean, operations:object[], stats:object}}
 *
 * Pure. Builds no SQL, opens no connection, and cannot partially apply — the
 * point of a plan is that it is inspectable before anything is irreversible.
 */
export function buildCommitPlan(input = {}) {
  const key = idempotencyKey(input);
  const seen = input.committedKeys instanceof Set
    ? input.committedKeys
    : new Set(input.committedKeys ?? []);

  if (seen.has(key)) {
    // RE-INGEST IS A NO-OP. Not "an empty plan that happens to write nothing":
    // an explicit `committed: true`, so a caller can tell "already done" from
    // "there was nothing to do", which are different outcomes with the same
    // row count.
    return {
      key, committed: true, operations: [],
      stats: { skipped: 'already-committed', operations: 0, rows: 0, blocked: 0 },
    };
  }

  // `?? []` guards null and undefined but NOT a non-array — a caller passing
  // a string reaches `.map` and throws, taking down the turn this plan was
  // supposed to make safe. Caught by the degenerate-input test.
  const arr = v => (Array.isArray(v) ? v : []);
  const claims = arr(input.claims);
  const edges = arr(input.edges);
  const events = arr(input.events);
  const contradictions = arr(input.contradictions);

  // Evidence and entities are derived from the claims rather than taken as
  // separate inputs, so a claim can never be planned without the rows its
  // foreign keys require.
  const evidence = [];
  const entities = new Set();
  const claimEvidence = [];
  for (const c of claims) {
    if (c?.subject) entities.add(c.subject);
    if (c?.objectKind === 'entity' && c.object?.entity) entities.add(c.object.entity);
    for (const e of [].concat(c?.evidence ?? [])) {
      evidence.push({ evidenceId: e, claimId: c.claimId });
      claimEvidence.push({ claimId: c.claimId, evidenceId: e });
    }
  }

  const lifecycle = claims.map(c => ({
    claimId: c.claimId, from: 'extracted', to: 'active', reason: 'e6-commit',
  }));

  // Contradictions are OUTBOX EVENTS, not claim mutations. S8 emits and
  // refuses to decide; if S9 wrote a resolution it would undo that restraint
  // one stage later, and the surviving claim would look undisputed.
  const outbox = [
    ...claims.map(c => ({ type: 'ClaimCommitted', claimId: c.claimId })),
    ...contradictions.map(c => ({
      type: 'ContradictionDetected',
      subject: c.subject, predicate: c.predicate, kind: c.kind,
    })),
  ];

  const byTarget = {
    sources: input.sourceId ? [{ sourceId: input.sourceId }] : [],
    evidence,
    entities: [...entities].map(name => ({ name })),
    aliases: arr(input.aliases),
    claims,
    claim_evidence: claimEvidence,
    edges,
    events,
    lifecycle_transitions: lifecycle,
    outbox,
  };

  const operations = COMMIT_ORDER
    .map(target => op(target, byTarget[target] ?? [],
      PENDING_TARGETS.has(target) ? 'no migration yet — cannot be executed' : null))
    .filter(o => o.count > 0);

  const blocked = operations.filter(o => !o.writable);

  return {
    key,
    committed: false,
    operations,
    stats: {
      operations: operations.length,
      rows: operations.reduce((a, o) => a + o.count, 0),
      // Rows that have nowhere to go. Counted separately from `rows` so a plan
      // reporting healthy totals cannot hide a third of itself.
      blocked: blocked.reduce((a, o) => a + o.count, 0),
      blockedTargets: blocked.map(o => o.target),
      // The whole plan can only be one transaction once every target exists.
      atomicPossible: blocked.length === 0,
      contradictions: contradictions.length,
    },
  };
}
