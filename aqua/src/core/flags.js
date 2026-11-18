/**
 * AQUA — Flag & setting registry
 * Blueprint L13 (no dark flags) · G5 (observable) · E4
 *
 * WHAT THIS IS FOR
 * ----------------
 * A flag that changes behaviour and is not reported anywhere is a branch in
 * production nobody can see. Boot reported 11; the code reads 42. The other 31
 * were decided at import time by an environment variable, and the only way to
 * learn which way they went was to read the source and guess at the deploy.
 *
 * 🔴 A CORRECTION TO THE AUDIT, WHICH THIS FILE EXISTS TO MAKE PERMANENT.
 *
 * The audit reported "56 AQUA_* flags, 11 reported" and the Phase 0 inspection
 * repeated it at 57. Both were produced by grepping for `AQUA_[A-Z_]+` across
 * `src/`, and that pattern does not match flags. It matches:
 *
 *   · LOG EVENT LABELS — `AQUA_REQUEST`, `AQUA_MEMORY`, `AQUA_PLAN`,
 *     `AQUA_SEARCH`, `AQUA_COGNITION`, `AQUA_INTELLIGENCE`, `AQUA_ORCHESTRATOR`,
 *     `AQUA_VERIFICATION` are `type:` fields in observability.js. Eight of them.
 *   · MARKDOWN FILENAMES — `AQUA_INDEXED_NOT_SCAN.md`, `AQUA_PARSE_ISOLATION.md`,
 *     `AQUA_DEPENDENCY_SAFETY.md`, `AQUA_PHASE6_NOTES.md` cited in comments.
 *   · A FLAG THAT DOES NOT EXIST — `AQUA_EXTRACT_V2` is named in two headers as
 *     the flag a capability WILL ship behind. Nothing reads it.
 *
 * So the real figure is 42 read, 11 reported, 31 dark — a third smaller than the
 * headline, and still an L13 violation. The reason to write this down rather
 * than quietly use the better number: a count that overstates the problem gets
 * corrected the moment someone tries to fix it, and then the whole audit reads
 * as unreliable. It was one bad regex, and the finding underneath it is real.
 *
 * THE REGISTRY IS NOT THE COMPLETENESS TEST.
 * A hand-maintained list of flags rots exactly like a hand-maintained list of
 * test files. `flagRegistry.test.js` derives the truth from the source — every
 * name read from `process.env` must appear here, and every name here must be
 * read somewhere. Both directions, because a registry with stale entries lies
 * as confidently as one with missing entries.
 *
 * GATES vs SETTINGS. A gate changes which code path runs and belongs in the
 * boot report. A setting tunes a path that runs either way — a timeout, a model
 * name, a directory. Reporting all 42 on every boot would bury the 26 that
 * matter under 16 that do not.
 */

/** How a gate reads its variable. Recorded because they are NOT uniform. */
const ON = "=== 'on'";
const ONE = "=== '1'";
/** Exactly lowercase 'on' — the read site does not lowercase, so ON/On mean off (2026-11-10). */
const ON_CASE = "=== 'on' (case-sensitive)";
/** A comma list: any non-empty value turns the behaviour on. */
const LIST = "non-empty list";
/** Three-way off | shadow | on (AQUA_INFO_NEEDS). */
const TRI = "off|shadow|on";
/** Three-way: 'on' | 'off' | anything else (unset) = 'auto'. */
const AUTO = "on|off|auto";
/** `=== 'local'` and never on Render / NODE_ENV=production (core/logSafety.js). */
const LOCAL_ONLY = "=== 'local' (never in production)";

/**
 * Behaviour gates — these decide which code path runs.
 *
 * `dflt` is what the branch does with the variable UNSET, verified against the
 * read site rather than assumed. Three of these are on-by-default and two are
 * inverted (the variable turns something OFF), which is precisely the kind of
 * thing a reader guesses wrong.
 */
export const GATES = Object.freeze([
  { name: 'AQUA_ANSWER_SCAFFOLD_GUARD', subsystem: 'intelligence', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'reasoning directives say the stages are for thinking, not the reply layout (reasoningStrategy/synthesizer). ON by default; =off restores the previous text' },
  { name: 'AQUA_BRAIN', subsystem: 'brain', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'master kill switch — ON by default, set to off to disable' },
  { name: 'AQUA_BRAIN_INGEST', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_BRAIN_INGEST_FACTS', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_CANONICAL_IDS', subsystem: 'identity', dflt: 'off', reads: ON_CASE },
  { name: 'AQUA_CANONICAL_READ', subsystem: 'world-model', dflt: 'auto', reads: AUTO,
    note: 'E10 read mode (brain/index.js canonicalReadMode): unset/auto = canonical-authoritative (canonical World Model answers; legacy identity/regex facts only fill gaps it does not contradict); on = canonical only; off = legacy rollback' },
  { name: 'AQUA_CANONICAL_RELEVANCE_GATE', subsystem: 'brain', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'canonical retrieval lanes admit only claims about the question (pic/questionShape.js claimAffinity) and answer "is X still true?" from the same state slot (2026-10-17). ON by default; =off = rollback to admit-everything-reached' },
  { name: 'AQUA_CIE', subsystem: 'cognition', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'Cognitive Intelligence Engine (cognition/index.js cieEnabled): plan, directive, draft monitor, verification escalation. ON by default — the read site is `?? \'on\'`; the registry said off until 2026-11-10 (audit F-02). =off is the rollback' },
  { name: 'AQUA_CLAIM_STRICT_PREDICATES', subsystem: 'claims', dflt: 'off', reads: ONE },
  { name: 'AQUA_CLAIMS_SHADOW', subsystem: 'claims', dflt: 'off', reads: ON,
    note: 'E5/PR-5 — degrades to off with a stated reason when DATABASE_URL is absent' },
  { name: 'AQUA_CONSOLIDATE', subsystem: 'pic', dflt: 'off', reads: ON },
  { name: 'AQUA_CONTEXT_V2', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_CROSS_ENCODER', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_RETRIEVAL_V3', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_CORRECTION_PHRASES', subsystem: 'memory', dflt: 'off', reads: LIST,
    note: 'a comma list of extra correction phrases (memory/memoryConflictResolver.js), read at import; any non-empty value adds phrases. Registered as on/off until 2026-11-10' },
  { name: 'AQUA_DISABLE_MONGO_MIRROR', subsystem: 'store', dflt: 'off', reads: ONE, inverted: true,
    note: 'set to 1 to DISABLE the mirror — the variable turns something off' },
  { name: 'AQUA_E6_ACTOR_RETRY', subsystem: 'brain', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'E6 asks once more when a named person who acts in the sentence appears in no claim ("Kofi is helping me build Atlas" → self builds Atlas only), naming them (understanding/pipeline.js, 2026-10-18). Live: fired 3× in 36 trigger-class sentences, recovered 3, 0 wrong additions. ON by default; =off = rollback' },
  { name: 'AQUA_PROPAGATION', subsystem: 'memory', dflt: 'off', reads: ON,
    note: 'one change, every store (memory/propagation.js): records a fact change and reconciles the Mind, profile and evidence lane, with a startup sweeper (router.js). OFF by default (2026-11-06): only exactly "on" enables recording, reconciliation and the sweeper' },
  { name: 'AQUA_EPISODIC_RECALL', subsystem: 'memory', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'chat answers also see the user\'s own matching past messages from other conversations, dated, redaction-checked, with World Model "since changed" notes (memory/episodicRecall.js, 2026-10-20). ON by default; =off = rollback' },
  { name: 'AQUA_E6_COMPOUND_RETRY', subsystem: 'brain', dflt: 'off', reads: ON,
    note: 'E6 asks once more when a clause stating a change produced no claim, naming the clause (understanding/pipeline.js, 2026-10-17). OFF: no measured benefit on 70 live dev sentences (2026-10-18)' },
  { name: 'AQUA_E6', subsystem: 'brain', dflt: 'off', reads: ON,
    note: 'understanding pipeline. extract-v3: negation 0.95-1.00 on 5 fresh runs; full 200-case precision/recall pending provider quota (scripts/e6-shadow.mjs)' },
  { name: 'AQUA_EMBEDDINGS', subsystem: 'embeddings', dflt: 'on', reads: "=== 'off'", inverted: true,
    note: 'ON by default — set to off to disable' },
  { name: 'AQUA_GRAPH', subsystem: 'orchestrator', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'task-graph runtime: POST /chat (not /chat/stream) for agent / multi-part high-complexity turns, AND POST /intelligence/orchestrate. ON by default — the read sites are `?? \'on\'`; the registry said off until 2026-11-10 (audit F-02). =off is the rollback' },
  { name: 'AQUA_GRAPH_STRICT_TYPES', subsystem: 'reasoning', dflt: 'off', reads: ONE },
  { name: 'AQUA_COST_AWARE_REVIEW', subsystem: 'orchestrator', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'review depth (verificationStrategy.reviewDepth, 2026-11-12): classifier confidence < 0.5 (= no pattern matched) earns verification, the reasoning pass and the debate panel only when the message is >= 120 chars or carries a security/financial/medical tag. ON by default; =off restores the previous policy (every sub-0.5 turn reviewed)' },
  // 2026-11-16 — conversation recovery (audit/forensic-2026-11-16). All ON by default; each =off is its rollback.
  { name: 'AQUA_CONVERSATION_CONTEXT', subsystem: 'routes', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'shared resolved conversation context (core/conversationContext.js): follow-up reference resolution, retrieval query = message + resolved subject, operator reference note. =off: raw message, no resolution (reviewers still see recent turns)' },
  { name: 'AQUA_E8_PERSONAL_SCOPE', subsystem: 'brain', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'E8 query plan: conversation/research/analysis/planning templates require personal slots only for questions about the user\'s own world (D-01). =off restores the always-required topic slot' },
  { name: 'AQUA_STRICT_CONVERSATION_IDS', subsystem: 'routes', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'a server-issued conversation id that cannot be loaded → 404/503, never a silent empty re-creation; the id is re-read from disk first (D-07). =off restores silent re-creation' },
  { name: 'AQUA_CONVERSATION_TURN_LOCK', subsystem: 'routes', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'one turn at a time per conversation, in-process (core/conversationTurnLock.js, D-14): bounded wait, then 409. =off removes the lease' },
  { name: 'AQUA_REVIEW_REQUIRE_REASON', subsystem: 'intelligence', dflt: 'off', reads: ON,
    note: 'strict reviewer reason protocol: a verification replacement without a REVISION_REASON line is discarded (draft kept). OFF by default — the reason is always requested, parsed and recorded' },
  { name: 'AQUA_MIND_RELEVANCE', subsystem: 'mind', dflt: 'off', reads: ON,
    note: 'question-aware goals/deadlines/predictions in the cognitive block (mindRetriever questionScope). OFF by default (2026-11-06) until related-phrase matching exists; =on enables it' },
  { name: 'AQUA_MIND_VIEW', subsystem: 'mind', dflt: 'off', reads: ONE },
  { name: 'AQUA_PARSE_WORKER', subsystem: 'upload', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'ON by default' },
  { name: 'AQUA_PIC', subsystem: 'pic', dflt: 'on', reads: "!== 'off'", inverted: true, note: 'ON by default' },
  { name: 'AQUA_PROACTIVE', subsystem: 'proactive', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'Phase 4 proactive interventions + Phase 5 action proposals. Flag ON by default since eval/suites/proactive-core passed; INERT without Postgres (proactiveEnabled also requires isConfigured()). =off is the rollback' },
  { name: 'AQUA_PROVIDER_LOG', subsystem: 'providers', dflt: 'off', reads: "=== 'debug'" },
  { name: 'AQUA_RECALL_FOLLOWUP_V2', subsystem: 'memory', dflt: 'off', reads: ON,
    note: 'episodic recall follow-ups need a shared subject (name / identifier / words) AND a state relation, stricter from meaning-only seeds (memory/followUpRelevance.js). OFF = legacy follow-up step' },
  { name: 'AQUA_REFLECT_V2', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_REL_EVOLVE', subsystem: 'reasoning', dflt: 'off', reads: ON_CASE },
  { name: 'AQUA_REVISION_VOICE', subsystem: 'brain', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'canonical revision voice ON by default (eval: revision-voice); =on also enables the unevaluated legacy-ledger voice; =off = rollback' },
  { name: 'AQUA_SEMANTIC_RECALL', subsystem: 'memory', dflt: 'off', reads: ON,
    note: 'episodic recall adds embedding similarity + recency to keyword ranking (memory/semanticRecall.js). OFF by default: sends past user messages to the embedding provider; needs a usable embedder' },
  { name: 'AQUA_SELF_ENTITY', subsystem: 'identity', dflt: 'off', reads: ON_CASE,
    note: 'decides whether E6/S6 can resolve first person at all' },
  { name: 'AQUA_STORE_PG', subsystem: 'store', dflt: 'off', reads: "=== 'shadow'" },
  { name: 'AQUA_STORE_PG_READ', subsystem: 'store', dflt: 'off', reads: LIST,
    note: 'comma list of stores read from Postgres (core/storage/index.js readStoresFromEnv); any non-empty value. Registered as on/off until 2026-11-10' },
  { name: 'AQUA_PENDING_CHARGES', subsystem: 'credits', dflt: 'off', reads: ON,
    note: 'scalability Phase 4B (credits/pendingCharges.js): every credit charge is a Postgres row PENDING → COMMITTED (in the transaction of the turn) | REFUND_PENDING → REFUNDED, wallet debit/refund idempotent per charge id, a reconciler job resolves charges whose process died. Needs DATABASE_URL. OFF = deduct-on-entry and refund exactly as before' },
  { name: 'AQUA_POST_TURN_DURABLE', subsystem: 'store', dflt: 'off', reads: ON,
    note: 'scalability Phase 3 (learning/turnLearning.js): a turn\'s messages and its learning jobs commit in ONE transaction and workers run the post-turn learning (Mind, ingest, Twin, E6, reflection, consolidation); the API runs none of it. Needs DATABASE_URL and history partitions on (.aqua-history.json:on), refused with a stated reason otherwise. OFF by default = runPostTurn in-process, unchanged' },
  { name: 'AQUA_STORE_PARTITIONS', subsystem: 'store', dflt: 'off', reads: LIST,
    note: 'per-owner partition persistence, per store: "reflection:on,mind:shadow" (core/storage/ownerBinding.js). Modes off|shadow|on|only; on/only need DATABASE_URL and a migrated store (refused otherwise, reason in the boot line). Unset = every store exactly as before' },
  { name: 'AQUA_TWIN_V2', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_UUS', subsystem: 'uus', dflt: 'off', reads: ON },
  { name: 'AQUA_WORLD_CORE', subsystem: 'brain', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'current-world section of the answer context (brain/contextEngine/worldCore.js): every current canonical claim the relevance section did not show, as the user\'s own statements, budgeted. ON by default; =off = rollback' },
  { name: 'AQUA_INFO_NEEDS', subsystem: 'brain', dflt: 'off', reads: "off|shadow|on",
    note: 'information-needs engine (brain/contextEngine/informationNeeds.js, Sprint 3): on = question-driven context replaces the broad personal lanes on turns it understands; shadow = computed and logged (counts only), prompt unchanged; anything else = off. OFF by default — evaluation mode (ACIB acib-*-needs suites) until approved' },
  { name: 'AQUA_HYBRID_CONTEXT', subsystem: 'brain', dflt: 'off', reads: TRI,
    note: 'hybrid context (brain/contextEngine/hybridContext.js, Sprint 6): on = the information-needs engine ADDS a bounded needs-check block after the existing context (conflicts, changes, verified unknowns, strong evidence not already shown) and never removes anything; shadow = computed and logged (counts only), prompt unchanged; anything else = off. Takes precedence over AQUA_INFO_NEEDS=on. OFF by default' },
  { name: 'AQUA_LOG_CONTENT', subsystem: 'observability', dflt: 'off', reads: LOCAL_ONLY,
    note: 'core/logSafety.js (Sprint 1, 2026-11-10): =local prints raw user content in log lines for local debugging. Refused when RENDER=true or NODE_ENV=production, whatever the value' },
  // Not AQUA_-prefixed, read at import time (routes/chat.js). Registered 2026-11-10 —
  // the scan only looked for AQUA_ names, so this behaviour gate was dark.
  { name: 'ARTIFACTS_ENABLED', subsystem: 'artifacts', dflt: 'on', reads: "!== 'false'", inverted: true,
    note: 'Universal Artifact Engine branch of chat (routes/chat.js). ON unless exactly "false"' },
]);

/**
 * What each gate needs besides its own value before it can actually run
 * (Sprint 1, 2026-11-10). A flag that is on but whose dependency is missing is
 * INERT — reported as such, never as operational (AQUA_PROACTIVE was reported
 * "on" in a deployment with no Postgres, where it cannot do anything).
 *
 *   db              Postgres configured (DATABASE_URL)
 *   llm             at least one chat-model provider key
 *   embedding-key   a key in the shared Gemini embedding pool
 *   dedicated-embedding-key   AQUA_EMBEDDING_API_KEY (semantic recall only)
 *   gate:<NAME>     another gate must be on
 *
 * Verified against the read sites (`brainEnabled() && …`, `isConfigured()`,
 * `dbConfigured() && e6CommitEnabled()`), not inferred from names.
 */
export const DEPENDENCIES = Object.freeze({
  AQUA_GRAPH:                    ['llm'],
  AQUA_PROACTIVE:                ['db'],
  AQUA_CANONICAL_READ:           ['db', 'gate:AQUA_BRAIN'],
  AQUA_CONTEXT_V2:               ['gate:AQUA_BRAIN'],
  AQUA_RETRIEVAL_V3:             ['gate:AQUA_BRAIN', 'gate:AQUA_CONTEXT_V2'],
  AQUA_CROSS_ENCODER:            ['gate:AQUA_RETRIEVAL_V3'],
  AQUA_CANONICAL_RELEVANCE_GATE: ['gate:AQUA_CONTEXT_V2', 'db'],
  AQUA_WORLD_CORE:               ['gate:AQUA_CONTEXT_V2', 'db'],
  AQUA_BRAIN_INGEST:             ['gate:AQUA_BRAIN'],
  AQUA_BRAIN_INGEST_FACTS:       ['gate:AQUA_BRAIN_INGEST'],
  AQUA_E6:                       ['llm'],
  AQUA_E6_ACTOR_RETRY:           ['gate:AQUA_E6'],
  AQUA_E6_COMPOUND_RETRY:        ['gate:AQUA_E6'],
  AQUA_CLAIMS_SHADOW:            ['db'],
  AQUA_REFLECT_V2:               ['gate:AQUA_BRAIN'],
  AQUA_TWIN_V2:                  ['gate:AQUA_BRAIN'],
  AQUA_REVISION_VOICE:           ['gate:AQUA_BRAIN', 'db'],   // the default (canonical) voice; =on adds a legacy voice that needs neither
  AQUA_CONSOLIDATE:              ['gate:AQUA_PIC'],
  AQUA_EMBEDDINGS:               ['embedding-key'],
  AQUA_SEMANTIC_RECALL:          ['gate:AQUA_EPISODIC_RECALL', 'gate:AQUA_EMBEDDINGS', 'dedicated-embedding-key'],
  AQUA_STORE_PG:                 ['db'],
  AQUA_STORE_PG_READ:            ['db'],
  AQUA_STORE_PARTITIONS:         ['db'],
  AQUA_POST_TURN_DURABLE:        ['db', 'gate:AQUA_STORE_PARTITIONS'],
  AQUA_PENDING_CHARGES:          ['db'],
});

/** Settings — values that tune a path which runs either way. */
export const SETTINGS = Object.freeze([
  { name: 'AQUA_ARTIFACTS_DIR', subsystem: 'artifacts' },
  { name: 'AQUA_CONSOLIDATE_EVERY', subsystem: 'pic' },
  { name: 'AQUA_DATA_DIR', subsystem: 'store', note: 'eval isolation depends on this' },
  { name: 'AQUA_PARTITION_CACHE_ENTRIES', subsystem: 'store', note: 'owner-partitioned store (storage/partitionRepository.js) cache bound in entries per process (default 5000). Not used by any production path until a store is cut over (Phase 2b)' },
  { name: 'AQUA_ROLE', subsystem: 'store', note: 'process role in the split runtime: api (HTTP only, no periodic schedulers, SIGTERM drain) | worker (job queue only). Unset = the current single process, unchanged. Set by scripts/start-api.mjs / start-worker.mjs' },
  { name: 'AQUA_SCHEDULER_LEASE_MS', subsystem: 'store', note: 'TTL of the periodic-scheduler lease among workers (aqua_scheduler_leases, default 60000, min 1000): a dead owner is replaced within it' },
  { name: 'AQUA_JOB_HEARTBEAT_STALE_MS', subsystem: 'store', note: 'a running job whose heartbeat is older than this is reclaimed by recovery (jobQueue.reapStale; default 120000, min 1000). Workers renew every quarter of it' },
  { name: 'AQUA_SHUTDOWN_BUDGET_MS', subsystem: 'store', note: 'SIGTERM → exit budget when shutdown blockers are registered (split runtime): the store/mirror/job drains get what is left of it after in-flight requests or the job in hand (core/atomicStore.js; default 9500, min 2000). Without blockers the drains keep 5 s each, as before' },
  { name: 'AQUA_JOB_AGING_SECONDS', subsystem: 'store', note: 'durable job claim aging (core/jobs/jobQueue.js): a runnable job gains 1 priority point per this many seconds waited, at most 100, so a stream of higher-priority retries cannot starve lower-priority work (default 5; 0 = strict priority, the pre-Phase-4B behaviour)' },
  { name: 'AQUA_CHARGE_ABANDON_MS', subsystem: 'credits', note: 'a PENDING charge older than this is abandoned (its request died) and refunded by the reconciler (default 900000 = 15 min; must exceed any request lifetime)' },
  { name: 'AQUA_CHARGE_RECONCILE_INTERVAL_MS', subsystem: 'credits', note: 'how often the scheduler-owning worker enqueues credits.reconcile.v1 (default 60000)' },
  { name: 'AQUA_CHARGE_CRASH_AT', subsystem: 'credits', note: 'TEST SEAM: kill the process at a named charge transition (credits/pendingCharges.js crashAt). Never set in production' },
  { name: 'AQUA_GCS_BUCKET', subsystem: 'artifacts', note: 'the Google Cloud Storage bucket of AQUA_OBJECT_STORE=gcs (core/storage/objectStore.js). Required with gcs: refused without it, never a silent fallback' },
  { name: 'AQUA_GCS_ENDPOINT', subsystem: 'artifacts', note: 'GCS JSON API endpoint override (an emulator in tests). Unset = https://storage.googleapis.com with the Cloud Run service account token from the metadata server' },
  { name: 'AQUA_JOB_LOG', subsystem: 'observability', note: 'structured [JOB] lifecycle lines (core/jobs/jobLog.js): on by default; =off silences them. Never logs payloads or message text' },
  { name: 'AQUA_CONNECTOR_KEY', subsystem: 'connect', note: 'SECRET — 32 random bytes, base64 or 64 hex (node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"). AES-256-GCM key sealing connector credentials at rest (connect/credentialVault.js). No fallback: unset/invalid = connecting is refused. Value never logged or reported. Losing it makes stored connector credentials unreadable (users reconnect); knowledge already imported is unaffected. Phase 1b: not read by any production path yet' },
  { name: 'AQUA_LOG_PSEUDONYM_KEY', subsystem: 'observability', note: 'SECRET (≥ 32 chars). Key for the stable owner pseudonym in log lines (core/logSafety.js ownerLogId → o_<16 hex>): the same owner gets the same pseudonym on every instance and restart, and it cannot be reversed without this key. Unset/short = a per-process key (p_<16 hex>, correlates within one process only, warned once). scripts/owner-log-id.mjs computes a pseudonym for support' },
  { name: 'AQUA_OBJECT_STORE', subsystem: 'artifacts', note: 'backend for artifact binaries when artifacts are on partitions: pg (default, aqua_objects) | gcs (Phase 4, not implemented: refuses)' },
  { name: 'AQUA_PARTITION_STORE_OWNERS', subsystem: 'store', note: 'stores bound to owner partitions in on/only mode (ownerBinding.js) keep at most this many owners in memory per process (default 2000); least-recently-used CLEAN owners are evicted and reloaded on their next request' },
  { name: 'AQUA_PARTITION_CACHE_BYTES', subsystem: 'store', note: 'owner-partitioned store cache bound in bytes per process (default 64 MB). Eviction is always safe: the cache holds nothing unwritten' },
  { name: 'AQUA_EMBEDDING_API_KEY', subsystem: 'memory', note: 'SECRET — the only credential semantic episodic recall uses (embeddings/dedicatedEmbedder.js); unset = recall stays keyword-only. Never the shared Gemini pool. Value never logged' },
  { name: 'AQUA_PROPAGATION_CRASH_AT', subsystem: 'memory', note: 'TEST SEAM ONLY (memory/propagation.js crashAt): the process exits (code 70) at the named step, to test crash recovery. Never set in production; unset = no effect' },
  { name: 'AQUA_HYBRID_MAX_TOKENS', subsystem: 'brain', note: 'AQUA_HYBRID_CONTEXT block budget in estimated tokens (default 400; 50–4000, otherwise the default)' },
  { name: 'AQUA_HYBRID_MAX_MS', subsystem: 'brain', note: 'AQUA_HYBRID_CONTEXT time budget: the engine aborts past it and a slower result is discarded (default 50; 5–5000)' },
  { name: 'AQUA_HYBRID_MAX_SENTENCES', subsystem: 'brain', note: 'AQUA_HYBRID_CONTEXT work budget: the engine reads at most this many of the most recent user sentences, plus files (default 4000; 100–100000)' },
  { name: 'AQUA_RECALL_ALL_CHARS', subsystem: 'memory', note: 'episodic recall quotes the WHOLE past history while it fits this many characters (default 8000 ≈ 2k tokens), ranked excerpts beyond; 0 = always ranked' },
  { name: 'AQUA_S8_HISTORY', subsystem: 'brain', note: 'S8 history read (worldModelRepository.findClaimsForDedup): bounded (default; targeted indexed candidates, migration 0025) | full (rollback: every claim of the predicates) | compare (eval only: decide with both, count differences)' },
  { name: 'AQUA_E6_MODEL', subsystem: 'brain' },
  { name: 'AQUA_E6_PROVIDER', subsystem: 'brain' },
  { name: 'AQUA_E6_COMMIT', subsystem: 'brain' },
  { name: 'AQUA_E6_SINGLE_VALUED', subsystem: 'brain', note: 'registry-declared single-valued predicates: S8 emits changed values, E9 retires the older snapshot. Default ON (eval: claim-lifecycle); off = rollback' },
  { name: 'AQUA_E6_MINT', subsystem: 'brain', note: 'S6 provisional-entity minting; follows AQUA_E6_COMMIT, =off is the rollback' },
  { name: 'AQUA_E6_EXTRACTOR_VERSION', subsystem: 'brain' },
  { name: 'AQUA_EMBED_DIM', subsystem: 'embeddings' },
  { name: 'AQUA_EMBED_MODEL', subsystem: 'embeddings' },
  { name: 'AQUA_MIRROR_CHUNK_BYTES', subsystem: 'store' },
  { name: 'AQUA_ERROR_WEBHOOK_URL', subsystem: 'observability', note: 'POST scrubbed error records here (core/telemetryExport.js); unset = local ring' },
  { name: 'AQUA_ERROR_WEBHOOK_TOKEN', subsystem: 'observability', note: 'optional Bearer token for AQUA_ERROR_WEBHOOK_URL' },
  { name: 'AQUA_METRICS_TOKEN', subsystem: 'observability', note: 'Bearer token for the Prometheus machine scrape GET /metrics (routes/metricsScrape.js); unset or < 32 chars = 404' },
  { name: 'AQUA_RATE_LIMIT_REDIS_URL', subsystem: 'platform', note: 'shared rate-limit window across processes (utils/rateLimitStore.js); unset = per-process memory' },
  { name: 'AQUA_CONSOLIDATION_INTERVAL_MS', subsystem: 'jobs', note: 'E9 J3 consolidation scheduling interval in the worker (default 600000; 0 = never schedule)' },
  { name: 'AQUA_TEST_DATABASE_URL', subsystem: 'tests', note: 'the ONLY database a test run may touch (scripts/run-tests.mjs); never .env DATABASE_URL' },
  { name: 'AQUA_MIRROR_RETRY_BASE_MS', subsystem: 'store' },
  { name: 'AQUA_MIRROR_RETRY_CAP_MS', subsystem: 'store' },
  { name: 'AQUA_MIRROR_STALE_FAILS', subsystem: 'store' },
  { name: 'AQUA_MIRROR_STALE_MS', subsystem: 'store' },
  { name: 'AQUA_MIRROR_ROLE', subsystem: 'store', note: 'writer|reader; unset = writer on Render (RENDER=true), reader elsewhere — only the deployment writes the shared Mongo mirror (P0 2026-10-12)' },
  { name: 'AQUA_MIRROR_LEASE_MS', subsystem: 'store', note: 'writer-lease TTL for the Mongo mirror (default 3 heartbeats = 90000)' },
  { name: 'AQUA_PROVIDER_BACKOFF_CAP_MS', subsystem: 'providers' },
  { name: 'AQUA_PROVIDER_BACKOFF_MS', subsystem: 'providers' },
  { name: 'AQUA_PROVIDER_MAX_ROUNDS', subsystem: 'providers' },
  // 2026-11-16 — conversation recovery settings.
  { name: 'AQUA_LEDGER_REVISION_BASIS', subsystem: 'intelligence' },   // confirmed (default) | legacy — which revisions feed the learned verification gate (D-05)
  { name: 'AQUA_TURN_LOCK_WAIT_MS', subsystem: 'routes' },             // how long a second turn waits for the first (default 15000)
  { name: 'AQUA_TURN_LOCK_STALE_MS', subsystem: 'routes' },            // when an unreleased turn lease is reclaimed (default 600000)
  { name: 'AQUA_PROVIDER_PREFER', subsystem: 'providers', note: 'comma list moved to the front of the ranked healthy providers (controlled rollout, e.g. nvidia); unset = pure score ranking' },
  { name: 'AQUA_LIFT_LLM', subsystem: 'eval', note: 'eval-only (eval/adapters/pairedAnswerLift.mjs): =on runs the provider-backed paired-answer World-Model Lift' },
  { name: 'AQUA_LIFT_PROVIDER', subsystem: 'eval', note: 'eval-only: pins BOTH lift lanes to one provider (groq|gemini|openrouter|nvidia); unset = production router' },
  { name: 'AQUA_LIFT_MODEL', subsystem: 'eval', note: 'eval-only: model pin for AQUA_LIFT_PROVIDER; unset = that provider\'s first registered model' },
  { name: 'AQUA_PROVIDER_RETRY_BUDGET_MS', subsystem: 'providers' },
  { name: 'AQUA_PROVIDER_MAX_KEYS_PER_MODEL', subsystem: 'providers', note: 'non-rejected key attempts per model per request (default 3; NVIDIA tries every key once)' },
  { name: 'AQUA_PROVIDER_MAX_KEY_ATTEMPTS', subsystem: 'providers', note: 'non-rejected key attempts per provider call across all models (default 8)' },
  { name: 'AQUA_PROVIDER_KEY_REJECT_TTL_MS', subsystem: 'providers', note: 'read in keyPool.cjs; unset/0 = a 401/403-rejected key stays quarantined until restart or explicit reset (default)' },
  { name: 'AQUA_CROSS_ENCODER_BLEND', subsystem: 'brain' },
  { name: 'AQUA_CROSS_ENCODER_CACHE_SIZE', subsystem: 'brain' },
  { name: 'AQUA_CROSS_ENCODER_CACHE_TTL_MS', subsystem: 'brain' },
  { name: 'AQUA_CROSS_ENCODER_DTYPE', subsystem: 'brain' },
  { name: 'AQUA_CROSS_ENCODER_MODEL', subsystem: 'brain' },
  { name: 'AQUA_CROSS_ENCODER_POOL', subsystem: 'brain' },
  { name: 'AQUA_CROSS_ENCODER_TIMEOUT_MS', subsystem: 'brain' },
  { name: 'AQUA_OUTBOX_CLAIM_TTL_MS', subsystem: 'jobs' },
  { name: 'AQUA_PROACTIVE_INTERVAL_MS', subsystem: 'proactive', note: 'worker periodic proactive scan interval (default 3600000; 0 = never); change-triggered evaluation runs regardless' },
]);

/** Every registered name, gates and settings alike. */
export const REGISTERED = Object.freeze(
  [...GATES, ...SETTINGS].map(f => f.name).sort(),
);

/**
 * Current state of every gate.
 *
 * Takes an env object rather than always reading `process.env`, because the
 * first version of the default-check test deleted all 27 variables globally to
 * see what unset resolved to. Node's test runner executes files concurrently
 * and `testCoverage.test.js` spawns the runner as a subprocess — which inherited
 * the mutated environment mid-deletion and discovered 26 fewer test files. The
 * full battery failed somewhere unrelated to either test. A pure parameter
 * removes the shared mutable state instead of sequencing around it.
 *
 * Reports the RAW value alongside the resolved one. "off" because the variable
 * is unset and "off" because someone typed `AQUA_E6=false` are the same boot
 * line and very different mistakes, and the second is invisible without the raw
 * value — every gate here matches an exact string, so `false`, `true`, `yes`
 * and `1` all silently mean off for most of them.
 */
export function flagReport(env = process.env) {
  return GATES.map(g => {
    const raw = env[g.name];
    const set = raw !== undefined && raw !== '';
    return {
      name: g.name,
      subsystem: g.subsystem,
      value: resolveGate(g, raw, env),
      default: g.dflt,
      raw: set ? raw : null,
      overridden: set,
    };
  });
}

/** Resolve one gate the way its own read site does. */
function resolveGate(g, raw, env = {}) {
  const v = String(raw ?? '').toLowerCase();
  switch (g.reads) {
    case LOCAL_ONLY: return v === 'local' && String(env.RENDER ?? '').toLowerCase() !== 'true' && String(env.NODE_ENV ?? '').toLowerCase() !== 'production' ? 'on' : 'off';
    case "!== 'false'": return raw === 'false' ? 'off' : 'on';   // case-sensitive at the read site
    case ON: return v === 'on' ? 'on' : 'off';
    case ON_CASE: return raw === 'on' ? 'on' : 'off';
    case TRI: return v === 'on' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
    case LIST: return String(raw ?? '').split(',').some(x => x.trim()) ? 'on' : 'off';
    case ONE: return v === '1' ? 'on' : 'off';
    case "=== 'debug'": return v === 'debug' ? 'on' : 'off';
    case "=== 'shadow'": return v === 'shadow' ? 'shadow' : 'off';
    case "=== 'off'": return v === 'off' ? 'off' : 'on';   // inverted, on by default
    case "!== 'off'": return v === 'off' ? 'off' : 'on';   // inverted, on by default
    case AUTO: return v === 'on' ? 'on' : v === 'off' ? 'off' : 'auto';
    default: return 'off';
  }
}

/**
 * One boot line. Gates only, and the non-default ones named explicitly.
 *
 * Listing 26 gates on every boot is the same failure as listing none: nobody
 * reads it. What matters is which ones differ from the default, because that is
 * the deploy's actual configuration and the thing an incident starts from.
 */
export function flagBootLine(env = process.env) {
  const report = flagReport(env);
  const changed = report.filter(f => f.overridden);
  const suffix = changed.length
    ? changed.map(f => `${f.name}=${f.value}`).join(' ')
    : '(all default)';
  return `[FLAGS] ${GATES.length} gates · ${SETTINGS.length} settings · ${changed.length} overridden — ${suffix}`;
}

// ── Effective status: flag → dependencies → observed execution (Sprint 1) ────
//
// Four different things that a single "on" used to stand for:
//   off       the flag is off
//   inert     the flag is on but a dependency is missing — it cannot run
//   enabled   flag on, dependencies present, not yet seen running in this process
//   active    seen running (noteFeature 'ran') and the last outcome was not a failure
//   failing   the last recorded outcome was a failure
// A feature is reported operational only from OBSERVED execution, never from
// its flag. Execution counters are process-local (they reset on restart) and
// are recorded at the production call sites (routes/chat.js,
// routes/turnPostProcess.js, cognition, embeddings, context engine).

const PROVIDER_KEY = /^(GROQ_API_KEY|OPENROUTER_API_KEY|NVIDIA_API_KEY|GEMINI_API_KEY|Gemini_API_Key)(_\d+)?$|^GEMINI_KEY_\d+$/;
const EMBEDDING_KEY = /^(GEMINI_API_KEY|Gemini_API_Key)$|^GEMINI_KEY_\d+$/;
const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

/** Infrastructure a gate may depend on, read from the environment only (no I/O). */
export function infrastructure(env = process.env) {
  const keys = Object.keys(env);
  return {
    db: nonEmpty(env.DATABASE_URL),
    llm: keys.some(k => PROVIDER_KEY.test(k) && nonEmpty(env[k])),
    'embedding-key': keys.some(k => EMBEDDING_KEY.test(k) && nonEmpty(env[k])),
    'dedicated-embedding-key': nonEmpty(env.AQUA_EMBEDDING_API_KEY),
  };
}

/** The resolved value of one registered gate under `env` ('on'|'off'|'auto'|'shadow'). */
export function gateValue(name, env = process.env) {
  const g = GATES.find(x => x.name === name);
  if (!g) throw new Error(`unregistered gate: ${name}`);
  return resolveGate(g, env[name], env);
}

const isOnValue = v => v === 'on' || v === 'auto' || v === 'shadow';

/** Missing dependencies of a gate (recursively through `gate:` dependencies). */
export function missingDependencies(name, env = process.env, infra = infrastructure(env), seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const out = [];
  for (const dep of DEPENDENCIES[name] ?? []) {
    if (dep.startsWith('gate:')) {
      const parent = dep.slice(5);
      if (!isOnValue(gateValue(parent, env))) out.push(`${parent}=off`);
      else out.push(...missingDependencies(parent, env, infra, seen));
    } else if (!infra[dep]) {
      out.push(dep === 'db' ? 'no-db' : `no-${dep}`);
    }
  }
  return [...new Set(out)];
}

const executions = new Map();   // gate → { runs, failures, lastAt, lastOutcome, lastFailureAt, lastErrorCode }

/**
 * Record that a gated feature actually executed. `outcome`: 'ran' | 'failed'.
 * `code` is a short machine reason (never user content). Never throws.
 */
export function noteFeature(name, outcome = 'ran', code = null) {
  try {
    const e = executions.get(name) ?? { runs: 0, failures: 0, lastAt: null, lastOutcome: null, lastFailureAt: null, lastErrorCode: null };
    const now = Date.now();
    if (outcome === 'failed') { e.failures += 1; e.lastFailureAt = now; e.lastErrorCode = code ? String(code).slice(0, 60) : 'error'; }
    else e.runs += 1;
    e.lastAt = now;
    e.lastOutcome = outcome === 'failed' ? 'failed' : 'ran';
    executions.set(name, e);
  } catch { /* telemetry never affects a turn */ }
}

/** Test seam: forget recorded executions. */
export function _resetFeatureExecutionsForTests() { executions.clear(); }

/**
 * One row per gate: configured value, dependencies, observed execution, and
 * the derived state. `env` and `infra` are injectable for tests.
 */
export function featureStatus(env = process.env, { infra = infrastructure(env) } = {}) {
  return GATES.map(g => {
    const value = resolveGate(g, env[g.name], env);
    const missing = isOnValue(value) ? missingDependencies(g.name, env, infra) : [];
    const ex = executions.get(g.name) ?? null;
    let state;
    if (!isOnValue(value)) state = 'off';
    else if (missing.length) state = 'inert';
    else if (ex?.lastOutcome === 'failed') state = 'failing';
    else if (ex?.runs) state = 'active';
    else state = 'enabled';
    return {
      name: g.name, subsystem: g.subsystem, value, state,
      requires: DEPENDENCIES[g.name] ?? [], missing,
      observed: ex ? { runs: ex.runs, failures: ex.failures, lastAt: ex.lastAt, lastOutcome: ex.lastOutcome, lastFailureAt: ex.lastFailureAt, lastErrorCode: ex.lastErrorCode } : null,
    };
  });
}

/**
 * Second boot line: every gate that is ON but cannot run, and why. Printed
 * because the first line only lists overrides — a default-on gate whose
 * dependency is missing (AQUA_PROACTIVE without Postgres) appeared nowhere.
 */
export function flagEffectiveLine(env = process.env, opts = {}) {
  const inert = featureStatus(env, opts).filter(f => f.state === 'inert');
  const defaultsOn = GATES.filter(g => g.dflt === 'on' && !nonEmpty(env[g.name] ?? '')).map(g => g.name);
  return `[FLAGS] effective — inert (on, dependency missing): ${inert.length ? inert.map(f => `${f.name}(${f.missing.join(',')})`).join(' ') : 'none'}`
    + ` · on by default: ${defaultsOn.join(' ')}`;
}
