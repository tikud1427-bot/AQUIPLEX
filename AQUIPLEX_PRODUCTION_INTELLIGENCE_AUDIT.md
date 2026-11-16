# AQUIPLEX Production Intelligence Audit

**Date:** 2026-11-10 · **Repo:** `aquiplex-platform` · **Branch:** `main` · **HEAD:** `839ea0d1` (clean tree before and after the audit)
**Scope:** what actually runs when a user sends Aqua a message, and what that means for understanding, privacy, cost and scale.
**Companion documents:**
[Feature flags](AQUA_FEATURE_FLAG_AUDIT.md) ·
[Knowledge architecture](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md) ·
[Context engine](AQUA_CONTEXT_ENGINE_AUDIT.md) ·
[Benchmark (ACIB)](AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md) ·
[Roadmap](AQUIPLEX_ENGINEERING_ROADMAP.md) ·
[Architecture map](AQUIPLEX_ARCHITECTURE_MAP.md)

> **Status update 2026-11-10 (Sprint 1 + 2, uncommitted, not deployed):**
> - **Fixed in the working tree:** F-02 (registry), F-09 (logs), F-12 (failed-turn memory), F-20 (startup overwrite) — see [AQUIPLEX_SPRINT1_PRODUCTION_SAFETY_REPORT.md](AQUIPLEX_SPRINT1_PRODUCTION_SAFETY_REPORT.md).
> - **Measured, not fixed:** F-04, F-05, F-06 and F-08 are now quantified by ACIB v1 — see [AQUA_ACIB_V1_BASELINE_RESULTS.md](AQUA_ACIB_V1_BASELINE_RESULTS.md). The hiring question gets 1 of 6 decision-critical facts in the long-history regime.
> - **Unchanged:** everything else below describes HEAD `839ea0d1`.

**Evidence labels used throughout:** **V** = verified (code read and/or executed here) · **I** = strongly inferred · **U** = unknown · **NI** = not implemented.

---

## 0. The short version

1. **Production almost certainly runs the legacy read path with no Postgres** (I — documented in `DEMO_RUNBOOK.md` 2026-10-28; Render's env could not be inspected). Without `DATABASE_URL`, the canonical World Model, E6 LLM understanding, the durable job worker, Reflection V3, proactive interventions, the canonical revision voice and Context Engine V2's canonical lanes do not run. Most of the "brain" in the repository is not in the user's path ([F-01](#f-01)).
2. **What understands the user in production today is mostly the answer model reading raw transcripts.** Episodic recall quotes the user's *entire* cross-conversation history verbatim on every turn while it is under 8,000 characters (V, probe). The structured layers capture a thin and partly wrong slice: in a 7-message synthetic founder history, team size, an engineer's departure, the funding round and a sibling's employer were **never captured as facts** (V, probe) ([F-04](#f-04), [F-05](#f-05)).
3. **Once history exceeds that window, recall becomes keyword-ranked and decision questions lose their context.** "Should I hire another developer?" retrieved only "I might hire a designer next year" — not the team size, the departure, the runway or the deadline (V, probe) ([F-05](#f-05)).
4. **Question-driven context exists, but only on a path production does not run.** `brain/contextEngine/queryPlan.js` builds slot plans (goal/deadline/blockers/constraints) and renders "Not known: … ask once" — only when `AQUA_CONTEXT_V2=on` over canonical claims ([F-08](#f-08)).
5. **Privacy:** user message text is written to stdout logs on every turn, including the *unredacted* message in `memoryRetriever.js:244`, which bypasses the health/mood policy that guards storage ([F-09](#f-09)).
6. **Scale:** every store is a single JSON file holding all users, rewritten whole every 500 ms debounce and mirrored whole to Mongo; the design is single-instance by construction ([F-10](#f-10)).
7. **The flag registry misreports production:** `AQUA_GRAPH` and `AQUA_CIE` are registered as default-off but run on; the boot line says "(all default)" and a reader concludes they are off ([F-02](#f-02)).
8. **Durability:** if Mongo is unreachable while a fresh Render instance boots, the instance serves empty stores and, once Mongo recovers, overwrites the live mirror copy (the good copy is set aside under `conflict/…`, keeping only the newest 3) ([F-20](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md#f-20); code path verified, not executed).

Cross-user isolation in the request path is **sound where verified** (owner derived from the session, conversation and workspace checks, guarded adoption, comprehensive purge) — residual risks are logs, `.bak` copies and the all-users-in-one-document storage design (§5).

---

## 1. Method

| What | How | Result |
|---|---|---|
| Static trace | Read entry points, `routes/chat.js` (1,810 lines) end to end, `turnPostProcess.js`, `memory/engine.js`, `brain/index.js`, `core/flags.js`, Mind, PIC, CE, stores, worker, launcher | §2–§4 |
| Gate read-site check | Isolated probe (`AQUA_DATA_DIR` scratch, mirror off, no DB, no `.env`) comparing `flagReport()` with each gate's own read function | 3 mismatches ([F-02](#f-02)) |
| End-to-end context probe | Drove the real `prepareTurn()` under code defaults with a synthetic founder history (7 statements) and 4 questions, in both recall regimes (whole-history and ranked) | [F-04](#f-04)–[F-07](#f-07) |
| Test battery | `aqua/scripts/run-tests.mjs` per directory (isolated sandbox, `DATABASE_URL` blank) | 3,512 tests, 3 fails — all environmental (§7) |
| Eval gate | `node eval/gate.mjs` with `DATABASE_URL=` (DB-free, code defaults) | 15 PASS, 1 BLOCKED (known gate defect), 2 NOT RUN (need Postgres) (§7) |
| Safety | `~/.aquiplex/.aqua-mind.json` mtime checked before/after every run (unchanged, 11:18:28); `git status` clean after tests | No real data touched |

Not done: no access to Render (env, logs, start command), no Mongo/Postgres production reads, no provider calls, no answer-level generation.

---

## 2. Architecture as it exists

Full diagram: [AQUIPLEX_ARCHITECTURE_MAP.md](AQUIPLEX_ARCHITECTURE_MAP.md).

| Layer | Where | Notes |
|---|---|---|
| Platform server (CJS) | `index.js` (1,975 lines) | Express, helmet, rate limits (Redis optional), Mongo sessions, Passport Google OAuth, CSRF, billing (Razorpay), wallet/credits, marketing views |
| Engine mount | `index.js:623-703` | `aquaAccess` = limiters → `requireLogin` → 50 MB JSON → `req.aquaUserId = session.userId` → privacy settings → `usageGuard` metering → dynamic `import("./aqua/router.js")` at `/api/aqua` and `/v1` (same router) |
| Engine router (ESM) | `aqua/router.js` | `/chat`, `/conversations`, `/memory`, `/upload`, `/project`, `/artifacts`, `/understanding`, `/mind`, `/intelligence`, `/brain`, `/provider-health`; boot validation, flag boot line, propagation sweeper (off) |
| Hot-path stores | `~/.aquiplex/.aqua-*.json` (25 files) via `core/dataDir.js`, `core/atomicStore.js` | In-memory Maps, debounced whole-file writes, Mongo `aqua_kv` mirror (`core/mongoMirror.js`) |
| Canonical store | Postgres, 25 migrations (`aqua/src/core/db/migrations/`) | entities, claims, jobs, outbox, dense retrieval (pgvector), beliefs, proactive, revision voice — **only with `DATABASE_URL`** |
| Worker | `aqua/scripts/worker.mjs` → `core/jobs/workerRuntime.js` | Handlers: `claim.embedding.v1`, `understanding.turn.v1`, `claim.reflection.v1`, `claim.contradiction.v1`; **exits 1 without a database** |
| Launcher | `aqua/scripts/start-production.mjs` | Spawns server + worker; either one exiting stops both |
| Providers | `aqua/src/providers/router.js` + groq/gemini/openrouter/nvidia | Score-ranked, circuit breakers, ≤4 rounds, 90 s retry budget, key pools |
| Frontend | `aqua-frontend` (Vite/React), `src/api/chatStream.ts` | `POST /chat/stream` (SSE) is the primary path; `POST /chat` is the fallback |

**Inferred production topology (I):** if production has no `DATABASE_URL`, the worker would exit and `start-production.mjs` would take the server down with it, so production must be running `node index.js` as a single process. Render's start command is not in the repo (no `render.yaml`). **U** until someone reads the Render service settings.

---

## 3. Production execution path — one message, end to end

Path: `POST /api/aqua/chat/stream` → `routes/chat.js:1462`. `POST /chat` (`:1220`) shares `prepareTurn()` and differs only where noted.
"Prod?" = runs under code defaults **and** without Postgres (the documented production configuration).

| # | Stage | File : function (line) | Caller | Sync/async | Gate / config | Store dependency | Failure handling | Prod? |
|---|---|---|---|---|---|---|---|---|
| 1 | Request entry | `index.js` `aquaAccess` (`:664`) | Express | sync | `engineLimiter`, `engineReadLimiter`; `AQUA_RATE_LIMIT_REDIS_URL` | Redis optional | 429 | V |
| 2 | Auth + user id | `requireLogin`; `req.aquaUserId = String(req.session.userId)` (`:670`) | middleware | sync | session (Mongo store) | Mongo | 401 JSON | V |
| 2b | Metering | `usageGuard('chat_message')` (`index.js:629-660`) | middleware | async | wallet | Mongo | 402; refund on ≥400 | V |
| 3 | Validation | `chat.js:1462+` — message non-empty string; conversation access `canAccessConversation` | route | sync | — | `.aqua-history.json` | 400/404 (no existence oracle) | V |
| 4 | Conversation retrieval | `getOrCreateConversation` (`conversationStore.js:138`); history read at `chat.js:751` | route / `prepareTurn` | sync | — | `.aqua-history.json` | creates if missing | V |
| 5 | Owner + sensitivity | `resolveOwner` (`memory/ownerResolver.js`) → `user:<id>`; `sensitivePolicy`, `redactSensitiveSentences` (`chat.js:406-416`) | `prepareTurn` | sync | `req.aquaSettings.rememberSensitive` | Mind store (adoption) | adoption guarded by `mayAdopt` | V |
| 5b | Embedding prefetch | `semanticFactScores`, `Brain.canonicalSemanticScores`, `semanticFileChunks` (`chat.js:422-428`) | `prepareTurn` | async, started early | `AQUA_EMBEDDINGS` (on) + embedding key | `.aqua-vectors.json` | resolve to null | V — **canonical scores computed every turn, unused under defaults** ([F-13](#f-13)) |
| 6 | Classification | `classifyForMode` → `core/classifier.js classifyTask` (`chat.js:460`) | `prepareTurn` | sync, regex | — | — | — | V — decision questions measured at `simple_qa` 0.45 ([F-07](#f-07)) |
| 7 | **Observe (memory write)** | `memoryObserve` (`memory/engine.js:138`): regex extraction → `storeFacts` → forget → correction → `detectFactChanges` → `laterWordsOnFacts`/`resolveCurrentState` → retire superseded → `mindObserve` (beliefs, goals, working memory, episodes, graph) → `indexOwnerFacts` | `prepareTurn` | **sync, before generation** | `AQUA_PROPAGATION` (off) | Mind store (facts live inside it), evidence store (retire) | try/catch per stage | V ([F-12](#f-12)) |
| 8 | Orchestration + plan | `orchestrate` (`orchestrator/toolOrchestrator.js`), `createExecutionPlan`, `getReasoningStrategy` | `prepareTurn` | sync, pure | learning ledger stats | `.aqua-ledger.json` | — | V |
| 9 | Reasoning pass | `runIntelligencePipeline` (`intelligence/internalIntelligenceEngine.js:59`) | `prepareTurn` | **async LLM call** when `complexity==='high'` or confidence < 0.5 | — | — | fail-open | V |
| 10 | Cognitive plan (CIE) | `cognitivePrepare` (`cognition/index.js:80`) | `prepareTurn` | sync | `AQUA_CIE` — **default ON** (registry says off) | `.aqua-cognition.json` | null plan | V ([F-02](#f-02)) |
| 11 | Read mode | `Brain.resolveReadMode` (`brain/index.js:139`) | `prepareTurn` | async (DB ping) | `DATABASE_URL`, `AQUA_CANONICAL_READ` | Postgres | degrades to legacy | V — `legacy` without DB (probe) |
| 12 | Memory retrieval | `memoryRetrieve` (`memory/engine.js:342`): identity card → ranked legacy facts (`memoryRetriever.js:215`) → preference → Mind cognitive block (`mind/mindRetriever.js:130`) → graph recall → episode recall → file chunks → file memory; one 800-token budget | `prepareTurn` | sync | `AQUA_MIND_RELEVANCE` (off) | Mind store | per-lane try/catch | V ([F-06](#f-06)) |
| 13 | Project retrieval | `retrieveProjectContext` (`project/projectRetriever.js`) | `prepareTurn` | async | `workspaceId` authorised + orchestrator/`REPO_INTENT_RE` | project index | skipped | V (only with a workspace) |
| 14 | Attachments | `getAttachments`/`formatAttachmentsForPrompt` | `prepareTurn` | sync | — | `.aqua-attachments.json` | — | V |
| 15 | Knowledge (PIC floor / CE V2) | `cognitiveKnowledgeRetrieve` → `pic/core.js retrieveKnowledge` (lanes 1–7, `pic/retrievalIntelligence.js:234`); V2: `Brain.assembleContextAsync` | `prepareTurn` | sync / async | `AQUA_PIC` (on), `AQUA_CONTEXT_V2` (off) | `.aqua-evidence.json` | V2 failure → floor | V — floor only; evidence holds **file-derived** facts unless `AQUA_BRAIN_INGEST=on` |
| 16 | Web search | `searchAgent.run` (`chat.js:726`) | `prepareTurn` | async (provider) | orchestrator `web_search` capability | search cache | never throws | V |
| 17 | Episodic recall | `recallForTurn` (`memory/episodicRecall.js`) with `legacySupersessionNotes` | `prepareTurn` | async | `AQUA_EPISODIC_RECALL` (on), `AQUA_SEMANTIC_RECALL` (off), `AQUA_RECALL_ALL_CHARS` (8,000) | conversation store | fail-open | V ([F-05](#f-05)) |
| 18 | Directives | `revisionDirectiveForTurn` (`brain/index.js:956`), `proactiveDirectiveForTurn` | `prepareTurn` | async | `AQUA_REVISION_VOICE` (canonical), `AQUA_PROACTIVE` | **Postgres** | '' | V — **both return '' without DB** |
| 19 | Prompt construction | `buildSystemPrompt` (`core/promptBuilder.js`) + `buildContextWindow` + `optimizeContext` (`chat.js:828-833`) | `prepareTurn` | sync | — | — | — | V — measured section sizes §6 |
| 20 | Model selection + LLM call | `generateTextStream` (`providers/router.js`); `/chat` only: task graph if `AQUA_GRAPH` (default **on**) and agent/multi-part | route | async stream | provider keys, `AQUA_PROVIDER_*` | — | fallback only before first token; abort persists partial | V ([F-16](#f-16)) |
| 21 | Draft monitor | `observeDraft` (CIE) | route | sync | `AQUA_CIE` | — | — | V |
| 22 | Verification | `runVerification` (`chat.js:881`) → `verification` or `debate` agent | route | async LLM, after stream; `replace` event | `shouldVerify` (`orchestrator/verificationStrategy.js:36`): high complexity, architecture, sensitive tags, **confidence < 0.5**, ledger | — | fail-open | V |
| 23 | Identity guard | `isRefusal`/`violatesIdentityContract` | route | sync | — | — | substitutes profile answer | V |
| 24 | Persist turn | `addMessage` ×2 + `contextRefs` | route | sync | — | `.aqua-history.json` | — | V |
| 25 | Respond | SSE `done` | route | — | — | — | — | V |
| 26 | Post-turn (deferred) | `runPostTurn` (`routes/turnPostProcess.js`) via `defer('post-response')` | route | async, detached | — | — | each step fail-open | V |
| 26a | Mind after-turn | `memoryAfterTurn` → `mindAfterTurn` (predictions rebuild, reflection schedule) | `runPostTurn` | sync | — | Mind store | — | V |
| 26b | Conversation ingest (knowledge extraction) | `Brain.observeConversationTurn` → `ingestConversationTurn` | `runPostTurn` | deferred | `AQUA_BRAIN_INGEST` (off), `_FACTS` (off) | evidence store, graph | skipped 'disabled' | **No** (off) |
| 26c | Claim shadow projection | `runClaimShadowProjection` | `runPostTurn` | async | `AQUA_CLAIMS_SHADOW` + DB | Postgres | — | **No** |
| 26d | Digital Twin | `Brain.observeTwin` | `runPostTurn` | deferred | `AQUA_TWIN_V2` (off) | Mind | skipped | **No** |
| 26e | E6 understanding (LLM) | `Brain.understandTurn` or `enqueue('understanding.turn.v1')` | `runPostTurn` | async / durable | `AQUA_E6` (off) + DB + provider | Postgres | in-process fallback | **No** |
| 26f | Reflection V2 | `Brain.reflectTurn` every 8 messages | `runPostTurn` | deferred | `AQUA_REFLECT_V2` (off) gates **apply** only | evidence store | — | Partial: snapshot+diff computed, not applied ([F-18](#f-18)) |
| 26g | PIC consolidation | `consolidate` | `runPostTurn` | deferred | `AQUA_CONSOLIDATE` (off) | PIC store | — | **No** |
| 27 | Background jobs | worker handlers; propagation sweeper | worker / router boot | async | DB; `AQUA_PROPAGATION` | Postgres | reapStale, DLQ | **No** without DB ([F-15](#f-15)) |
| 28 | Reflection V3, contradiction, consolidation workers | `brain/reflectionV3/*` | worker | async | DB | Postgres | outbox, idempotency, recovery | **No** without DB |

**Stream vs JSON differences (V):** the task-graph runtime (`AQUA_GRAPH`) is only on `POST /chat`; the stream path never uses it. On a stream error that is not a client abort, the turn is **not** persisted to history, but stage 7 already wrote to memory ([F-12](#f-12)).

---

## 4. Findings

Severity: **S1** user-visible wrongness or privacy exposure · **S2** structural risk · **S3** cost/quality debt.

<a id="f-01"></a>**F-01 (S1, I) — Production serves the legacy read; the World Model stack is not in the user's path.** `canonicalReadMode()` (`brain/index.js:114`) returns `legacy` without `DATABASE_URL`; the probe confirmed `{"mode":"legacy"}`. Consequence list in §3 (stages 11, 15, 18, 26b–28). Evidence for prod: `DEMO_RUNBOOK.md` ("Production currently serves the legacy read"), plus [F-15](#f-15). → [Knowledge §1](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md), [Roadmap D-1](AQUIPLEX_ENGINEERING_ROADMAP.md#decisions).

<a id="f-02"></a>**F-02 (S2, V) — The flag registry and boot line misreport three gates.** `AQUA_GRAPH` (`chat.js:1323`, `intelligence.js:161` read `?? 'on'`) and `AQUA_CIE` (`cognition/index.js:50`, `?? 'on'`) are registered `dflt: 'off', reads: ON` in `core/flags.js`; `AQUA_PROACTIVE` is registered on but also requires Postgres (`brain/proactive/index.js:35`). `flagRegistry.test.js` checks names, not defaults, so it passes. → [Flag audit](AQUA_FEATURE_FLAG_AUDIT.md).

<a id="f-03"></a>**F-03 (S2, V for local / U for prod) — The developer's local configuration is a different product.** Local `.env` turns on 12 gates (`CONTEXT_V2`, `E6`, `BRAIN_INGEST(_FACTS)`, `REFLECT_V2`, `TWIN_V2`, `SELF_ENTITY`, `CLAIMS_SHADOW`, `CONSOLIDATE`, `UUS`, `RETRIEVAL_V3`, `STORE_PG=shadow`) and has a database. Anything judged by using the app locally says little about production.

<a id="f-04"></a>**F-04 (S1, V) — Structured capture misses most state-of-world facts.** Probe history → stored facts:

| User said | Stored as fact / Mind |
|---|---|
| "I'm the founder of Tidewell… We have 3 engineers: Priya, Marco and Sam." | role=Founder, workplace=Tidewell. **Team, count and names: not stored.** |
| "Our runway is 9 months and we raised $1.2M in March." | `custom runway: 9 months`. **Funding: not stored.** |
| "My goal is to launch the mobile app by January 15." | goal ✓; Mind deadline label = the whole sentence |
| "We're blocked on the payments integration." | Mind blocker ✓ |
| "I might hire a designer next year, not sure yet." | not stored ✓ (hedge respected) |
| "My sister Ana works at Stripe." | `siblings: Ana`. **Ana's employer: not stored** (third-party attribute dropped) |
| "Actually Marco left the company last week, so we are down to 2 engineers." | **Nothing stored or changed** |

Only verbatim recall carried these facts to the model.

<a id="f-05"></a>**F-05 (S1, V) — Recall is "everything" below 8,000 chars and keyword-only above it.** Whole-history regime: all 7 statements were quoted into the water-boiling question's prompt (≈430 tokens). Ranked regime (`AQUA_RECALL_ALL_CHARS=0`, the behaviour every long-term user reaches): "Should I hire another developer?" → 1 excerpt (the designer remark); "How many engineers do we have?" → the two right excerpts; impersonal question → none. → [Context engine §3](AQUA_CONTEXT_ENGINE_AUDIT.md).

<a id="f-06"></a>**F-06 (S1, V) — The cognitive block is not about the question.** With `AQUA_MIND_RELEVANCE` off (default, `mindRetriever.js:202`), every turn gets the top 3 goals, last 2 blockers, last deadline, latest open question and top prediction. In the probe, the earlier question "Should I hire another developer?" appeared as `open question` in three later, unrelated turns, including the water-boiling one; graph recall injected `Ana ←related_to— user —targets→ launch the mobile app` for "Where does Ana work?".

<a id="f-07"></a>**F-07 (S3, V) — Personal questions classify at 0.45 and pay for 2+ extra LLM calls.** "Should I hire another developer?", "Where does Ana work?" and the water-boiling question all classified `simple_qa` at 0.45 (< `LOW_CONFIDENCE_THRESHOLD` 0.5) → reasoning pass (`internalIntelligenceEngine.js:43`) **and** verification (`verificationStrategy.js:48`). The decision-form detector that would label the first one `decision` exists only in CE V2 (`queryPlan.js:101`).

<a id="f-08"></a>**F-08 (S1, V) — Question-driven planning and "Not known" are built but inert in production.** `buildQueryPlan` → `runBoundedRetrievalRoundsAsync` → `assessSufficiency` → `renderBlock` "Not known: … ask about it once" (`assembler.js:531-549`) run only inside `assembleTurnContextAsync` when `AQUA_CONTEXT_V2=on`, and their slots are defined by canonical predicates that need Postgres.

<a id="f-09"></a>**F-09 (S1, V) — User content in logs, outside the sensitivity policy.** `memoryRetriever.js:244` logs `query="<full raw message>"` every turn (raw, not the redacted write view); `memoryExtractor.js:74` logs the first 120 chars; `candidateExtractor.js:275-278` logs sentences and extracted values; `logMemoryEvent` logs `key=value` for EXTRACTED/RETRIEVED (`chat.js:491,583`); `searchManager.js:93` logs search queries; `projectRetriever.js:76` logs queries. Health/mood sentences the product promises not to store are printed to Render logs.

<a id="f-10"></a>**F-10 (S2, V) — Storage is single-instance, all-users-per-file.** `mind/mindStore.js:200-216`: each debounced save (500 ms, `atomicStore.js:231`) reads the disk file, merges, and serialises **every owner**; `mongoMirror.js` then upserts the whole file (chunked at 10 MB) as last-writer-wins, with a heartbeat that only *detects* a second writer. One developer's Mind file was 787,880 bytes on 2026-11-07. Cost per write grows with total users; a corrupted or mis-merged file affects everyone; horizontal scaling is impossible without data loss. `AQUA_STORE_PG` (per-owner blobs in Postgres) exists only as shadow.

<a id="f-11"></a>**F-11 (S2, V) — Account deletion leaves one-generation `.bak` copies.** `atomicStore.js:113-123` copies each store to `<file>.bak` before a process's first flush. `account/accountPurge.js` purges 30+ stores (and has a completeness test) but not `.bak`, `*.migrated-to-datadir` or corrupt-aside files, nor log lines ([F-09](#f-09)).

<a id="f-12"></a>**F-12 (S2, V) — Memory is written before the answer, and kept when the turn fails.** `memoryObserve` runs at `chat.js:486`; on a non-abort stream error (`:1790-1803`) nothing is added to history, but facts, Mind beliefs, goals and episodes from the message remain. The user sees a failed message whose content Aqua nevertheless "learned".

<a id="f-13"></a>**F-13 (S3, V) — Canonical semantic scores are computed and discarded every turn.** `chat.js:425` starts `Brain.canonicalSemanticScores` unconditionally: lists up to 5,000 evidence facts, embeds any new ones, embeds the query (coalesced with the fact-score query) and scans vectors. Under defaults its result is consumed only by CE V2 or `AQUA_MIND_RELEVANCE`, both off.

<a id="f-14"></a>**F-14 (S2, V/I) — One fact lives in up to seven stores and convergence is off.** See [Knowledge §2](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md). `AQUA_PROPAGATION` (the reconciler) is default off.

<a id="f-15"></a>**F-15 (S2, I) — No durable background processing in production.** `worker.mjs` exits 1 without a database and the launcher stops the server with it, so a DB-less production must run the server alone; the job queue, Reflection V3, contradiction and consolidation workers do not run.

<a id="f-16"></a>**F-16 (S3, V) — The answering model varies per turn.** `providers/router.js` ranks four free-tier providers by health score; fallback changes the model mid-session. Answer quality, cost and benchmark results are not reproducible without pinning (`AQUA_LIFT_PROVIDER/MODEL` exists for eval only).

<a id="f-17"></a>**F-17 (S3, V) — Fixed prompt overhead on every turn.** Water-boiling prompt (6,593 chars ≈ 1.66k tokens): core + instruction hierarchy ≈ 490 tok, AQUA self-knowledge ≈ 308 tok, step-by-step reasoning directive + internal brief ≈ 219 tok, identity ≈ 80, cognitive ≈ 124, recall ≈ 428 — for a question that needed none of the personal context.

<a id="f-18"></a>**F-18 (S3, V) — Reflection V2 does work it throws away.** `reflectWorldModel` (`brain/reflectionV2/index.js:78`) snapshots and diffs every 8 messages; `apply` defaults to `reflectV2Enabled()` (off).

<a id="f-19"></a>**F-19 (S3, V) — Documentation drift in code headers.** Example: `brain/understanding/pipeline.js` header says S6 entity resolution "is not built at all", while the file imports `resolveClaimEntities` (`:181`). Headers are long and authoritative in tone; stale ones mislead.

**F-20 (S1, V code path)** — boot-hydration failure can overwrite the Mongo mirror with an empty store. Documented in [Knowledge architecture §3](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md#f-20).

---

## 5. Reliability, security and performance (section G)

| Area | Status | Evidence |
|---|---|---|
| Cross-user isolation (request path) | **Sound where checked (V).** Owner is `user:<session id>`; no route reads an owner id from the client (grep of `req.body/query/params` for owner/userId: none); `canAccessConversation` on chat/upload/memory legacy routes; `authorizedWorkspaceId`; adoption guarded by `mayAdopt` | `ownerResolver.js`, `conversationStore.js:167`, `project/workspaceAccess.js` |
| Isolation by construction | **Weak (V).** All owners share one in-process Map and one file per store; isolation depends on every function keying by `ownerId` correctly. One mis-keyed write is a cross-user leak with no storage boundary to stop it | [F-10](#f-10) |
| Mongo mirror exposure | One `aqua_kv` document set contains every user's memory (I) | `mongoMirror.js` |
| Sessionless access | `canAccessConversation(null, …)` returns true — safe only because `requireLogin` precedes every engine route (V) | `conversationStore.js:168`, `index.js:664` |
| Deletion | Comprehensive purge with completeness test (V); `.bak` and logs remain ([F-11](#f-11), [F-09](#f-09)) | `account/accountPurge.js` |
| Prompt injection | Recall, files, knowledge fenced as UNTRUSTED with nonce markers (V) | probe prompt |
| Idempotency | Durable jobs use idempotency keys (`understanding.turn.v1:<conv>:<turn>`), reflection outbox/idempotency modules (V, code) — **not running in prod** ([F-15](#f-15)) | `turnPostProcess.js`, `brain/reflectionV3/` |
| Concurrency | Two processes reconcile Mind writes by merge-at-flush (`mergeForFlush`); second-writer heartbeat alarm only (V) | `mindStore.js:200` |
| LLM timeouts/retries | Per-task timeouts, ≤4 rounds, 90 s budget, circuit breakers, retryable → 503 + Retry-After (V) | `providers/router.js:62-63`, `chat.js:1438` |
| Calls per turn | 1 generation + up to 1 reasoning pass + 1–2 verification/debate + search + 2–3 embeddings; personal questions at 0.45 trigger the extras ([F-07](#f-07)) | §3 |
| Context size | Memory block budget 800 tok; recall ≤ 2k tok (whole history) or ≤ 900 tok (ranked); PIC ≤ 1,600 chars; history window by complexity | `engine.js:75`, `episodicRecall.js:58` |
| Error monitoring | Scrubbed error webhook optional (`AQUA_ERROR_WEBHOOK_URL`), Prometheus scrape (`AQUA_METRICS_TOKEN`) | `core/flags.js` SETTINGS |
| Sensitive logging | **Fails** ([F-09](#f-09)) | |

---

## 6. Measured prompt composition (probe, code defaults, 7-message history)

| Question | Task / conf | Prompt tokens (est.) | Personal context the model actually got |
|---|---|---|---|
| Should I hire another developer? | simple_qa / 0.45 | 1,784 | identity, profile (founder, Tidewell, sibling Ana, goal, runway), cognitive block, **all 7 statements verbatim** |
| How many engineers do we have? | simple_qa / 0.97 | 1,565 | same; answer only derivable from verbatim quotes |
| Where does Ana work? | simple_qa / 0.45 | 1,808 | same + noisy graph path; employer only in quotes |
| What temperature does water boil at sea level? | simple_qa / 0.45 | 1,660 | identity card, cognitive block, **all 7 statements verbatim** |

Ranked-regime results are in [F-05](#f-05). Raw probe outputs: session scratchpad `probe/turn-probe.json`, `probe/turn-probe-ranked.json` (not committed).

---

## 7. Tests and evals executed (actual results)

All via `aqua/scripts/run-tests.mjs` (sandboxed `AQUA_DATA_DIR`, mirror disabled, `DATABASE_URL` blank, so live-Postgres suites skip).

| Directory | Tests | Pass | Fail | Skip | Todo | Notes |
|---|---|---|---|---|---|---|
| `src/memory` | 492 | 491 | 0 | 0 | 1 | todo = known gap (collection items keep no per-item source sentence) |
| `src/mind` | 199 | 193 | 0 | 0 | 6 | todos = pinned synonym gaps |
| `src/routes` | 308 | 308 | 0 | 0 | 0 | |
| `src/account` | 17 | 17 | 0 | 0 | 0 | purge completeness included |
| `src/understanding` | 137 | 137 | 0 | 0 | 0 | |
| `src/pic` | 158 | 158 | 0 | 0 | 0 | |
| `src/cognition` | 55 | 55 | 0 | 0 | 0 | |
| `src/core` | 791 | 783 | **1** | 7 | 0 | `repoHygiene`: two local ignored files `aqua/eval/out/contexts.before-profile.*.json` |
| `src/brain` | 1,355 | 1,345 | **2** | 8 | 0 | `embeddingFixture.test.js`: Windows `UNKNOWN` (errno −4094) writing the committed fixture `aqua/eval/fixtures/retrieval-core.embeddings.v1.json`; restored by its `after` hook; tree verified clean |
| **Total** | **3,512** | **3,487** | **3** | **15** | **7** | all 3 failures environmental |

`eval:gate` (DB-free): 15 PASS · `capture-core` BLOCKED (all 13 changed metrics improved; the gate treats `n_cases_*` outcome counts as dataset shape — known since 2026-11-02) · `context-canonical`, `context-canonical-heldout` NOT RUN (need Postgres) · 4 suites without baselines.

**Not run:** live Postgres suites, platform tests (`tests/`), frontend tests, any provider-backed eval, any answer-level eval.

---

## 8. What this audit does not establish

- Production's actual env, start command, flag values and data volume (**U** — needs Render access).
- Answer quality. Every measurement here is about context, not answers ([ACIB](AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md) Stage B).
- Whether E6 + canonical World Model, if deployed, fixes [F-04](#f-04) on real traffic. Prior dev evals suggest better capture; no production-shaped measurement exists (Lift v4 never completed).
