# AQUIPLEX Unified Intelligence — Stage 0 Report and Stage 1 Change

**Date:** 2026-11-12 · **Branch:** `main` @ `839ea0d1` plus the existing uncommitted work · **Nothing committed, pushed or deployed. No model was called.**

This report answers the mission's ten pre-implementation questions (Part 15), then describes the one change made. It builds on the 2026-11-10 audit set rather than repeating it. Each item below was re-checked against current source.

---

## 1. Existing architecture map

The as-built map is still accurate: [AQUIPLEX_ARCHITECTURE_MAP.md](AQUIPLEX_ARCHITECTURE_MAP.md). It covers deployment topology, one chat turn, where one user statement goes, and a module index.

Production runs one Node process (`index.js` plus the ESM engine `aqua/router.js`) on 25 whole-file JSON stores, with a Mongo whole-file mirror. **Production has no Postgres** (founder decision D-1, 2026-11-10). Therefore the following do **not** run in production:
- the canonical World Model, E6, durable jobs and Reflection V3;
- proactive assistance, revision voice and Context Engine V2.

## 2. Actual end-to-end execution flow

`POST /api/aqua/chat/stream` → `routes/chat.js`. Stage-by-stage table with file:line references: [Production Intelligence Audit §3](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md).

Mapped onto the mission's 15-step pipeline:

| Mission step | What runs today (production defaults) | Status |
|---|---|---|
| 1 Observe | message, history, attachments | runs |
| 2 Understand intent | regex `classifyTask` + `declarativeIntent` + orchestrator multi-label tags | runs; regex fallback for about 40% of ordinary questions (§7) |
| 3 Identify entities/projects | Mind graph, project retrieval (workspace only) | partial |
| 4 Extract | regex `memoryExtractor` / `candidateExtractor` + Mind observers, **before** the answer | runs; misses many state-of-world facts (audit F-04) |
| 5 Update world | legacy facts + Mind (beliefs, goals, working memory, graph), separately | runs; two writers, no write-time convergence |
| 6 Resolve change | `factChange.js` (legacy); Mind is filtered at read time only | partial (propagation off) |
| 7 Information needs | `AQUA_INFO_NEEDS` / `AQUA_HYBRID_CONTEXT` | built, **off** |
| 8 Retrieve | memoryRetrieve, Mind cognitive block, PIC floor, episodic recall, files, project | runs, as independent lanes |
| 9 Rank | per lane; no cross-lane ranking | gap |
| 10 Build context | `buildSystemPrompt` concatenates the lanes | runs; duplicates across lanes |
| 11 Strategy | orchestrator + execution plan + CIE + reasoning pass | runs; review depth was mis-triggered (fixed below) |
| 12 Generate | `generateTextStream`, score-ranked free providers | runs |
| 13 Verify | single critic or debate panel; truthful `status` field | runs |
| 14 Deliver | SSE + `replace` event on revision | runs |
| 15 Learn | `runPostTurn` (Mind reflection; ingest/E6/Twin flag-gated or DB-only); failed-turn rollback at the commit boundary (Sprint 1) | partial |

## 3. Data ownership and source-of-truth map

There are 22 places user knowledge lives: [Knowledge Architecture Audit §1](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md). The de facto authority in production is:

| Question | Authority today | Copies that can disagree |
|---|---|---|
| Who the user is / profile facts | legacy fact store (`mind.facts`, `memory/longTermMemory.js`) | Mind beliefs, Mind graph, PIC evidence (when ingest is on) |
| Goals | **two**: legacy `goal` fact and Mind `goalTracker` | each decides completion separately |
| Current state (focus, blockers, deadlines) | Mind working memory | none |
| What was said | conversation history (`.aqua-history.json`) | — |
| Documents | UKO / file index / PIC evidence | — |
| Relationships | Mind graph (the only one on the production read path) | reasoning graph (files), canonical (DB only) |

## 4. Disconnected intelligence capabilities

These exist in code but do not reach a production answer:

| Capability | Why it does not reach the answer |
|---|---|
| Canonical World Model, E6, Reflection V3, proactive, revision voice, CE V2 "Not known" | need Postgres (D-1 = no) |
| Information Needs V2, Hybrid Context | flags off, pending an ACIB v3 claim |
| Propagation (makes Mind a projection of facts) | `AQUA_PROPAGATION` off |
| Reflection V2 | computes every 8 messages and discards the result (F-18) |
| Canonical semantic scores | computed every turn, consumed only by off-flag paths (F-13) |
| Question-aware Mind block | `AQUA_MIND_RELEVANCE` off, so the cognitive block is not about the question (F-06) |
| Decision-form detector | lived only in CE V2; **now also used by the review policy** (§10) |

## 5. Duplicate or competing responsibilities

Details: [Knowledge Audit §4](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md).
- **"What is true about the user":** four writers.
- **Goals:** two stores.
- **Change detection:** five detectors (`factChange`, `stateTransition`, Mind `laterWord`, E6 S8, Reflection V2/V3).
- **Relationship graphs:** three, plus an overlay.
- **"Reflection":** four modules with different meanings.

Against the mission's responsibility table, the main mismatches are:
- Memory and Mind both act as the "World Model" for user state.
- "Timeline" is split across fact `history[]`/`transitions[]` and the DB-only canonical store.
- "Context Engine" in production is prompt concatenation; the real engine (V2) is DB-gated.

## 6. Infrastructure dependencies (Part 10)

| Question | Finding | Evidence |
|---|---|---|
| Which modules depend on Postgres | 30 non-test files call `getPool()` | grep |
| Which check reachability first | **2 of 30** (`brain/index.js` read paths). The other 28 attempt a connection and fail per call | grep |
| Does reading stay correct when the DB is down | Yes. `resolveReadMode` degrades to legacy (the 2026-10-12 P0 fix), so the canonical and legacy reads cannot diverge when the DB is down | `brain/index.js:141` |
| Do shadow-write failures waste latency | Little. A refused connect to `localhost:5432` measured 0–16 ms here. The cost is one error log line per failed write, plus attempts that cannot succeed | measured |
| Why the 12 Nov logs show 5432 failures | The local `.env` sets `DATABASE_URL=…localhost:5432`, `AQUA_STORE_PG=shadow`, `AQUA_E6=on`, `AQUA_CLAIMS_SHADOW=on` and `AQUA_BRAIN_INGEST=on`, while the `aqua-dev-db` container is stopped. It is a local-configuration symptom, not a production one | `.env` (names only) |
| Is the Mongo mirror read-only here | It is not read-only. Sprint 1 added verified initialisation and a lineage marker; an unverified start never mirrors | Sprint 1 report |
| Is local data preserved | JSON stores are authoritative. Shadow failures never propagate (`dualWriteAdapter.js`) | source |

**Recommendation (not implemented, needs your call):** gate the 28 Postgres callers on the cached `isReachable()` verdict (3 s down-TTL). Each would skip its call and log one line per outage instead of one per write. This touches 28 files across storage, claims, jobs and brain, so it is a reviewed change of its own, not a Stage 1 item. The simplest local fix today is to start `aqua-dev-db` or unset `AQUA_STORE_PG` locally.

## 7. Cost and latency inefficiencies

1. **Review depth misfired (fixed in Stage 1).** `classifyTask` returns confidence below 0.5 *only* from its "no pattern matched" fallback; the scored path is `0.5 + gap/top·0.5`, which is never below 0.5. That sentinel was read as "risky". Every short unmatched question therefore paid for:
   - a reasoning pass;
   - a two-pass debate panel;
   - and could have its answer replaced mid-read by an unconfirmed revision.

   On a 24-message probe, 9 messages hit it, including "Who wrote Hamlet?" and "What is 17 times 23?". This is the most likely cause of the 12 Nov "simple question → several Groq calls → unconfirmed debate revision" logs. I did not have those log files, so this is inferred from code plus the probe, not matched line by line.
2. Canonical semantic scores are computed and discarded every turn (F-13). This is an embedding call when a key is present.
3. Fixed prompt overhead of about 1.6k tokens even for impersonal questions (F-17).
4. Episodic recall quotes all history up to 8k chars on every turn (F-05).
5. A complexity bump at confidence < 0.55 promotes `medium` scored tasks to `high`, which seats the debate panel. This is a second "slightly below a threshold" trigger. **Not changed:** it affects scored classifications, so it needs its own measurement.

## 8. Top ten bottlenecks to "one coherent personal intelligence"

1. No production substrate for the canonical model (D-1): everything "world model" is DB-gated.
2. Capture misses state-of-world facts (team size, departures, funding, third-party attributes) (F-04).
3. Two writers for user state (facts and Mind) with propagation off (F-14).
4. Retrieval is independent lanes concatenated, with no cross-lane ranking, de-duplication or provenance carried through.
5. The cognitive block is not question-aware (F-06).
6. Information needs are built but off; "missing vs not retrieved" is not distinguished in production.
7. Recall is "everything" below 8k chars and keyword-only above (F-05).
8. Regex classification falls back on about 40% of ordinary questions, which feeds wrong task types to everything downstream.
9. Two goal stores with separate completion logic.
10. No durable background processing in production (worker exits without a DB) (F-15).

## 9. Proposed integration architecture (within D-1 = no Postgres)

No new modules and no migration. Converge on what exists:

- **One writer per fact.** The legacy fact store is the single writer for user-world attributes. Mind beliefs, graph edges and goal status become **projections** refreshed by the existing `memory/propagation.js` reconciler, which already has an outbox, idempotent IDs, backoff and a dead letter. Measure it on the existing `cross-store-consistency-eval.mjs` / `change-lifecycle-eval.mjs` and ACIB correction cases, then default it on (roadmap R-8).
- **One context assembly step.** Each lane (facts, Mind, PIC, recall, files, project) emits candidates in one evidence shape. One assembler ranks, de-duplicates by claim identity (not by surface similarity), marks current vs historical, and renders with provenance tags. The prompt's existing provenance tags (user-stated / inferred / dated quote) become fields, not prose. Hybrid Context is already the "append, never remove" first step of this.
- **One review-depth policy:** done in Stage 1 (§10).
- **One decision detector:** `isDecisionForm` is now shared by CE V2 and the review policy.
- **Stage contract (Part 11).** The per-turn ledger (`costLedger` → `aiCalls`, tokens), `verification.status` and `contextRefs` already cover most of the Reasoning/Verification contract with IDs and counts only. The missing piece is the Context output (selected evidence IDs, lane, current/historical, missing slots, token budget). That belongs in the assembler above, not in a separate logging module.

## 10. Smallest high-impact implementation plan

| Step | Change | Risk | Status |
|---|---|---|---|
| **S1** | Cost-aware review depth (below) | low; flag rollback | **done, uncommitted** |
| S2 | Reachability gate for the 28 Postgres callers (§6) | medium; touches storage/claims/jobs | proposal |
| S3 | Measure `AQUA_PROPAGATION` on the existing consistency and lifecycle evals, then decide default-on | changes production write behaviour | **needs your approval** |
| S4 | Unified evidence shape plus one assembler behind a flag, shadow-logged against today's prompt on ACIB dev | none while off | proposal |
| S5 | The 15-scenario synthetic end-to-end suite (Part 13) on the deterministic pipeline (no model) | none | proposal; partly covered by ACIB v1/v2 |

---

## Stage 1 change: cost-aware review depth

**What changed in behaviour.** A turn whose classification fell to the "no pattern matched" fallback (confidence < 0.5) now gets verification, the reasoning pass and the debate panel **only if** the message is ≥ 120 characters or carries a security/financial/medical tag. Short **decision-shaped** questions ("Should I…", "What should I focus on…") keep exactly one reasoning pass and no review panel. Nothing else moves:
- high complexity still gets deep review;
- sensitive domains still get verification, and the debate panel when the classification is also shaky;
- confident turns are untouched.

The policy can only remove calls relative to the previous behaviour; a test pins that.

**Rollback:** `AQUA_COST_AWARE_REVIEW=off` (any case) restores the previous policy exactly. It is registered in the flag registry and covered by the read-site parity test.

**Measured on the 24-message probe (classifier + orchestrator, no model):**

| Message | Worst-case model calls before | After |
|---|---|---|
| Who wrote Hamlet? / What time zone is Tokyo in? / What is 17 times 23? | 6 | 1 |
| Where does Ana work? / When is my launch deadline? / What am I working on right now? | 6 | 1 |
| Should I hire another developer? / job offer … or stay? | 6 | 2 |
| Medical, architecture, greetings and the 13 other messages | unchanged | unchanged |
| **Total, 24 turns** | **81** | **43** |

"Worst case" means a debate pass of 2 panel + 2 revision calls; actual calls are often fewer.

**Not claimed:** that answer quality is unchanged or better. No answer-level run was made, because that needs provider quota and your approval. The earlier extra calls were never shown to improve answers either. If you want evidence, the existing answer-eval kit can compare `=off` vs default on ACIB dev with the already-approved GROQ_API_KEY_1 budget.

**Verification labelling** was already truthful: `status` ∈ not_requested / verified / revised_unconfirmed / failed / … and `verified` is true only when a completed pass confirmed the delivered answer. Fewer debate runs means fewer `revised_unconfirmed` replacements of a streamed answer.

**Files changed:**
- `aqua/src/orchestrator/verificationStrategy.js`: `reviewDepth()`, `costAwareReviewEnabled()`, `SHORT_FALLBACK_CHARS`; `shouldVerify` uses the policy.
- `aqua/src/intelligence/internalIntelligenceEngine.js`: the reasoning-pass gate uses the policy; new optional `tags` input.
- `aqua/src/routes/chat.js`: debate seating uses the policy; passes tags to the pipeline; unused import dropped.
- `aqua/src/core/flags.js`: `AQUA_COST_AWARE_REVIEW` registered (default on, rollback `off`).
- Tests:
  - `aqua/src/orchestrator/tests/reviewDepth.test.js` (new);
  - `aqua/src/intelligence/confidenceEngine.test.js` and `aqua/src/intelligence/tests/intelligencePipeline.test.js`: the two old-policy cases moved to long messages, plus new short, sensitive and rollback cases;
  - `aqua/src/core/tests/flagRegistry.test.js` (counts 45→46 gates, 96→97 reads);
  - `aqua/src/core/tests/flagReadSiteParity.test.js` (runtime probe added).

**Tests** (`scripts/run-tests.mjs`, `DATABASE_URL` blank, isolated data dir):

| Suite | Result |
|---|---|
| targeted (reviewDepth, confidenceEngine, intelligencePipeline, flag registry and parity, declarativeIntent) + orchestrator + intelligence | 240 / 240 |
| src/routes | 349 / 349 |
| src/cognition | 55 / 55 |
| src/understanding | 146 / 146 |
| src/memory | 519 / 519 (a first run had 2 transient failures: the suite loaded the file between two edits; the rerun is clean) |
| src/mind | 193 / 193 |
| src/pic | 158 / 158 |
| src/brain (run per subdirectory because of the known Windows EPERM spawn limit) | 1,407 / 1,407 |
| eval/tests | 550 / 550 |
| src/core | 866 / 867. The one failure is the **pre-existing** hygiene check on `aqua/eval/out/contexts.before-profile.*.json` (recorded 2026-11-10), unrelated to this change |

## Decisions needed from you

1. **Approve S1 for commit** (or ask for it to ship with `AQUA_COST_AWARE_REVIEW=off` first and be flipped later).
2. **S2:** do the reachability-gate refactor now, or just stop the local 5432 noise by starting `aqua-dev-db` / unsetting `AQUA_STORE_PG` locally?
3. **S3:** authorise measuring `AQUA_PROPAGATION` as the path to "one writer, Mind as projection". This is the core of the unified world model under D-1.
4. Optional: an answer-level A/B of S1 (`=off` vs default) on ACIB dev within the approved Groq budget.
