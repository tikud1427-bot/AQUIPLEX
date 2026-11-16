# AQUIPLEX Sprint 1 — Production Safety Report

**Date:** 2026-11-10 · **Branch:** `main` · **Base:** HEAD `839ea0d1` · **State:** all changes uncommitted, nothing pushed or deployed, no production data or environment touched.
**Inputs:** [Production Intelligence Audit](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md) findings F-02, F-09, F-12, F-20; decisions D-1…D-5.

| Task | Audit finding | Status |
|---|---|---|
| A — sensitive logging | F-09 | **Fixed and verified** (38 leaking lines → 0 on the same probe) |
| B — flag registry | F-02 | **Fixed and verified** (every gate checked against its read site) |
| C — startup backup protection | F-20 | **Fixed and verified** (incident reproduced, now prevented) |
| D — failed-turn memory integrity | F-12 | **Fixed and verified** (real routes; retries idempotent) |

Every new test was "bite-checked": the fix was reverted, the test was confirmed to fail, and the file was restored and verified by hash.

---

## Task A — user content no longer reaches the logs

**What leaked (measured before the fix).** A sentinel probe drove five real turns through `POST /chat`, `/chat/stream` and `/upload` (success and failure) and captured stdout/stderr: **38 lines carried user content**. They came from:
- extractor input, sentences and values;
- `[MEMORY]` events with `key=value`;
- `MEM_RETRIEVER MEMORY_RANKED` printing the **raw** message, including a "therapist… anxiety" sentence the sensitivity policy refuses to store;
- uploaded file names.

**Also found while auditing every log site:**
- The final error handler (`index.js`) logged the error *object*. A malformed JSON body yields a body-parser error whose `body` property is the raw request.
- The native-OAuth legs logged `req.sessionID` in full, which is a bearer credential.

**Fix.** A shared rule, implemented in [aqua/src/core/logSafety.js](aqua/src/core/logSafety.js) (engine) and [utils/logSafety.js](utils/logSafety.js) (platform; separate package, same rules):

| Helper | Logs instead of content |
|---|---|
| `textMeta` | `len=N h=<8-hex HMAC with a random per-process key>` — correlates within a process, cannot be dictionary-reversed |
| `valueMeta` | type and size (`string(len=10)`, `list(3)`) |
| `safeKey` | the field name; the free-text tail of `custom_*` keys (built from the user's words) is hashed |
| `fileMeta` | extension, length, hash |
| `safeDetails` | `key=value` → `key` (applied at the `logMemoryEvent` sink, so every caller is covered) |
| `errorMeta` / `errorSummary` + `stackFrames` | class, code, status, body-parser type, quote-stripped message, stack frames; never the message of a parse error |
| `sessionTag` | `sess#<hmac>` |

Local debugging: `AQUA_LOG_CONTENT=local` restores raw content, but is refused when `RENDER=true` or `NODE_ENV=production` (registered gate).

**Sites changed (log statements only, no behaviour):**
- Engine extraction and memory: `memoryExtractor.js`, `candidateExtractor.js`, `memoryRetriever.js`, `longTermMemory.js`, `memoryEditor.js`, `forget.js`, `propagation.js`, `identityMigration.js`.
- Observability, search, project and cognition: `observability.js` (memory and search event sinks), `searchManager.js`, `projectRetriever.js`, `cognition/index.js`.
- Brain, artifacts and chat: `brain/index.js` (revision summary), `artifactStore.js` (the edit reason is the user's instruction), `routes/chat.js` (artifact title).
- Files and uploads: `engine.js`, `attachmentStore.js`, `documentPipeline.js`, `fileEngine.js`, `documentUnderstanding.js`, `fileMemory.js`.
- Error handlers: `aqua/router.js`; `index.js` (error handler and three OAuth lines — **log statements only; no authentication logic changed**).

**Kept deliberately:** ids, owner/conversation/request ids, counts, durations, stages, providers, field names, enumerated reasons. Code-workspace file paths (the project editor) are kept as operational metadata for the edit engine, since they are repository paths rather than personal documents. Mongo mirror logs name stores (`.aqua-mind.json`), never contents.

**Verified (re-run after the fix):** the same probe gives **0 leaking lines out of 508** — the line count is unchanged, so no observability was lost.

**Tests:**
- [aqua/src/routes/tests/logPrivacy.test.js](aqua/src/routes/tests/logPrivacy.test.js) — 7 tests:
  - real routes with sentinel messages, including failed turns and an upload;
  - the memory-event and search-event sinks;
  - the helpers;
  - a body-parser parse error;
  - the production refusal of `AQUA_LOG_CONTENT`;
  - a static guard against reintroducing raw-message interpolation.

  Bite-checked: reverting `MEMORY_RANKED` fails 2 tests; reverting the sink fails 2.
- [tests/platform/logSafety.test.js](tests/platform/logSafety.test.js) — 3 tests: a real `express.json()` parse failure (with a positive control showing the old statement printed the body), session tagging, and `index.js` using the safe statements.

## Task B — the flag registry now matches the code

**Corrected registry entries** ([aqua/src/core/flags.js](aqua/src/core/flags.js)):

| Gate | Was | Now (= read site) |
|---|---|---|
| `AQUA_GRAPH` | default off | **on** (`?? 'on'` in `chat.js`, `intelligence.js`) |
| `AQUA_CIE` | default off | **on** (`?? 'on'` in `cognition/index.js`) |
| `AQUA_PROACTIVE` | on | on, **plus a declared dependency on Postgres** (inert without it) |
| `AQUA_SELF_ENTITY`, `AQUA_CANONICAL_IDS`, `AQUA_REL_EVOLVE` | case-insensitive `on` | **case-sensitive** `=== 'on'` (`ON` means off) |
| `AQUA_CORRECTION_PHRASES`, `AQUA_STORE_PG_READ` | on/off | **comma lists** (any non-empty value) |
| `ARTIFACTS_ENABLED` | unregistered (scan only saw `AQUA_` names) | registered, `!== 'false'` |
| `AQUA_LOG_CONTENT` | new (Task A) | `local`, never in production |

**Status model.** Enabled, dependencies available, executing and failing are now four separate facts:
- `DEPENDENCIES`: what each gate needs besides its own value — `db`, `llm`, `embedding-key`, `dedicated-embedding-key`, or a parent gate. Verified against read sites.
- `featureStatus()`: per gate, the configured value, the missing dependencies, the **observed** execution counts, and a derived state:
  - `off`;
  - `inert` — on, but a dependency is missing;
  - `enabled` — on with dependencies present, not yet seen running;
  - `active` — observed running;
  - `failing` — last observed outcome failed.

  A feature is reported operational only from observed execution, never from its flag.
- `noteFeature()` records executions at the production call sites:
  - CIE, task graph, PIC floor, episodic and semantic recall, Mind relevance (`chat.js`);
  - Context Engine V2 success vs. floor fallback (`contextEngine/index.js`);
  - proactive policy store, canonical revision voice;
  - conversation ingest, Digital Twin, E6 (in-process and enqueue), Reflection V2 apply, consolidation (`turnPostProcess.js`);
  - embeddings.

  It records outcome codes only, never content.
- **Reporting:**
  - a second boot line, `[FLAGS] effective — inert (on, dependency missing): … · on by default: …`;
  - `GET /api/aqua/provider-health` now includes `features`.

**Verified locally, not in production:** with no `DATABASE_URL`, the effective line names `AQUA_PROACTIVE(no-db)` and `AQUA_CANONICAL_READ(no-db)` as inert. Production configuration remains **unverified** until Render's boot lines are read (D-5).

**Tests:**
- [flagReadSiteParity.test.js](aqua/src/core/tests/flagReadSiteParity.test.js) — 46 tests. Every gate's real enable function (or verbatim source expression, for import-time reads) is evaluated over 14 raw values and compared with the registry. A coverage test fails if any gate lacks a probe.

  Bite-checked: restoring the old `AQUA_CIE` entry fails 2 tests; restoring the case-insensitive `AQUA_SELF_ENTITY` entry fails 1.
- [featureStatus.test.js](aqua/src/core/tests/featureStatus.test.js) — 14 tests: defaults without a DB, explicit overrides (`AQUA_E6=on` with and without keys, `AQUA_E6=true` = off), parent and transitive dependencies, observed `active` / `failing` / recovery, a real `cognitivePrepare` recorded as active, and an inert proactive call recording no run.
- **Existing tests updated (reviewed, not weakened):**
  - [flagRegistry.test.js](aqua/src/core/tests/flagRegistry.test.js): census 41→43 gates, 89→91 names read, the on-by-default list, and a scan for non-`AQUA_` gates.
  - [claimShadowMode.test.js:110](aqua/src/core/tests/claimShadowMode.test.js) asserted `AQUA_GRAPH` `dflt === 'off'`, which pinned the misreport itself. Changed to `'on'` with a comment citing the read site.

## Task C — a failed startup can no longer overwrite the backup

**The incident, reproduced as a test before fixing:**
1. Mongo is unreachable while a fresh Render instance boots, so hydration fails and the stores load empty.
2. Mongo returns.
3. The first flush's CAS conflict preserved the live backup under `conflict/…` (pruned to the newest 3) and landed the **empty** store as live.

**Fix (inside the existing mirror, [aqua/src/core/mongoMirror.js](aqua/src/core/mongoMirror.js), no new database):**
- **Verified initialization.**
  - `sync.status` is `pending | verified | unverified | not-configured`.
  - A configured mirror whose hydration fails — at connect, or after connecting — is **unverified**. Nothing is mirrored and the backup is untouched.
  - "Missing vs. valid empty": a store absent from a backup that hydrated *successfully* is a valid new store. Any store seen by a failed hydration is unverified, empty or not.
- **Lineage marker** `<DATA_DIR>/.mirror-sync.json`:
  - written with plain fs, so it is never mirrored;
  - records, per file, the remote generation the local copy equals or descends from, plus `unverifiedSince`;
  - updated per file during hydration and after every successful mirror write, so an **interrupted initialization** resumes from what is on disk.
- **Recovery when Mongo returns mid-process** (metadata only, single-flight, rate-limited):
  - a file whose remote generation matches the marker resumes normally;
  - a file with unknown lineage is **blocked**: the live backup is left alone and the local copy (outage-period writes) is preserved as `conflict/<file>/local-<instance>`, refreshed on later flushes;
  - status reports `RECOVERY REQUIRED — … Restart to load the backups`.
- **Next boot:** for unknown lineage the **backup wins**, and the local copy is preserved first, regardless of mtime.
- **Other files that are never mirrored over a backup:** a torn remote chunk set, a restore that failed, and a local copy that could not be preserved.
- **No pruning of recovery copies:** local-recovery copies are excluded from conflict pruning.
- **Status and logs:** `getMirrorStatus().sync` has `status`, `unverifiedSince`, `recoveryRequired`, `blocked[]` and `preservedLocal[]`. Logs name stores only.

**Compatibility:** a data dir with **no marker at all** (pre-existing) keeps the previous newer-wins rule; the existing "local file newer is kept" test passes unchanged.

**Tests:**
- [mongoMirrorStartup.test.js](aqua/src/core/tests/mongoMirrorStartup.test.js) — 11 tests:
  - a **real** connection failure (closed localhost port);
  - a cluster timing out after connect;
  - the incident (backup untouched, local copy preserved, a genuinely new store still mirrors);
  - a control showing the old path overwrote;
  - known-lineage recovery (no false alarm);
  - next-boot restore despite a newer mtime;
  - valid-empty first deploy;
  - interrupted initialization (a restore fails mid-way, then completes on the next boot);
  - a torn chunk set;
  - prune exemption;
  - logs without store contents.

  Bite-checked: disabling the write gate fails 3 tests.
- Existing mirror suites: 22 tests, all pass (2 skip on Windows by design, SIGTERM).

**Operational note:** a "recovery required" instance keeps serving the stores it has (possibly empty) until restarted. It does not restart itself — an automatic restart mid-conversation was judged riskier. The outage-period writes survive in `conflict/<file>/local-<instance>` for manual reconciliation; no automatic merge exists yet.

## Task D — a failed turn leaves no knowledge behind

**Lifecycle (verified).** `memoryObserve` runs in `prepareTurn` **before** generation. It writes facts and Mind beliefs, goals, working memory, episodes and graph. On a provider failure (HTTP 503 / SSE `error`), no message reached the history, but all of that stayed. A retry then re-observed the same message, so belief evidence was counted twice — demonstrated by the idempotency test failing when the fix is disabled.

**Commit boundary:** the moment the user message is persisted to the conversation (`persistUserTurn` in [routes/chat.js](aqua/src/routes/chat.js)). Every post-preparation persistence path goes through it:
- the JSON path;
- the stream path;
- both artifact paths;
- a user-stopped stream (the turn happened, so it commits).

Both handlers roll back in `finally` whatever did not commit. Patch-edit branches run before observation and are untouched.

**Mechanism (smallest reliable change), [aqua/src/memory/turnCommit.js](aqua/src/memory/turnCommit.js):**
- **Snapshot:** the owner's Mind (where legacy facts live) is serialized per item before observation. At the end of preparation, only the units the turn **changed** are kept.
- **Rollback is a 3-way revert per unit:**
  - restore the previous value only if the unit still equals what the turn left;
  - keep anything another request changed since (a concurrent turn's knowledge survives — tested through the real route);
  - tombstone removed keys so the two-process merge cannot resurrect them.
- **Forget is honoured even on failure:** deletion is not knowledge, and the World Model / recall-redaction side already ran.
- **Deferred effects:** background effects on other stores (evidence-lane retirement, fact re-indexing) are deferred to commit and dropped on rollback, via a new optional `defer` parameter on `memoryObserve`. Callers that don't pass it behave as before.
- **Successful turns are unchanged.**

**Cost (measured, synchronous):**

| Mind size | Per successful turn | Per failed turn |
|---|---|---|
| 50 KB | 4 ms | 15 ms |
| 250 KB | 17 ms | 25 ms |
| 800 KB | 52 ms | 94 ms |
| 2 MB | 143 ms | 221 ms |

A first design with whole-Mind clones cost about 2× this and was replaced. For comparison, the existing mind store already re-serializes **every owner** on each 500 ms flush.

**Tests:**
- [turnCommit.test.js](aqua/src/memory/tests/turnCommit.test.js) — 15 tests: units, the revert rules, real observation rollback, an unsealed rollback, commit idempotency, deferred effects, forget honoured, a concurrent turn preserved.
- [failedTurnMemory.test.js](aqua/src/routes/tests/failedTurnMemory.test.js) — 7 tests through the real routes:
  - JSON failure → no facts, goals or message; a retry learns once;
  - **fail, fail, succeed ≡ succeed once** (facts and belief evidence);
  - stream failure;
  - forget honoured on failure;
  - a concurrent successful turn preserved;
  - a user-stopped stream commits;
  - the rollback is logged with counts only.

  Bite-checked: disabling rollback fails 6 of 7.

## Pre-existing defects found during Sprint 1 (not fixed — for review)

1. **Multi-sentence forget hits the wrong fact.** "Forget my workplace. Also my name is X" resolves the hint to `name` and deletes the name the same message stated; the workplace is not forgotten (`detectForget` takes everything after "forget my").
2. **"I just started a new job at Y" is not captured** (only "work at" forms are).
3. **Forgetting something that only exists in history doesn't redact recall.** "Forget my address" with no stored address fact leaves "My home address is 14 Larch Road" in recall quotes (ACIB `forgotten@short`).
4. **The current question is stored as a goal and open question.** It is observed before retrieval, so it then supersedes earlier goals in recall notes (ACIB `goal-change`: the marathon quote annotated "now: Help me plan my training this week").
5. **The Northbeam job change is not captured:** the identity card says "Company: none current".

## Tests executed (actual results)

| Scope | Result |
|---|---|
| Full engine battery after Sprint 1 (17 directories, isolated runner) | memory 503/504 (+1 todo); mind 193/199 (6 todo); routes 322/322; core 855/864 → after the `claimShadowMode` correction only the 2 pre-existing `repoHygiene` failures remain (untracked local `aqua/eval/out/*before-profile*` files; 7 skipped); brain 1347/1355 (8 skipped, live Postgres); account, understanding, pic, cognition, embeddings, upload, files, search, project, providers, intelligence, orchestrator: all pass |
| Platform tests (`npm run test:platform`) | 323/324 — the 1 failure is pre-existing `repoHygiene` (three root `.patch` files) |
| Final consolidated run, after both sprints (all new and changed test files, the three mirror suites, `claimShadowMode`, `eval/tests`) | **423 tests: 410 pass, 0 fail, 13 skipped** (2 Windows SIGTERM skips by design; the rest are eval framework skips) |
| `tests/platform/logSafety.test.js` | 3/3 |
| Full `eval:gate` (DB-free) | every suite passes except pre-existing `capture-core` BLOCKED (all metrics improved; known gate defect); `context-canonical*` not run (need Postgres); `acib-v1` passes (213 metrics) |
| Real store `~/.aquiplex/.aqua-mind.json` | mtime unchanged throughout (11:18:28, before the session) |

Live Postgres suites, frontend tests and any provider-backed test were **not** run.

## Files

- **New:** `aqua/src/core/logSafety.js`, `utils/logSafety.js`, `aqua/src/memory/turnCommit.js`, and 7 test files (named above).
- **Modified (engine):** `aqua/router.js`, `aqua/src/core/flags.js`, `aqua/src/core/mongoMirror.js`, `aqua/src/core/observability.js`, `aqua/src/routes/chat.js`, `aqua/src/routes/health.js`, `aqua/src/routes/turnPostProcess.js`, `aqua/src/memory/engine.js`, `aqua/src/cognition/index.js`, `aqua/src/brain/index.js`, `aqua/src/brain/proactive/index.js`, `aqua/src/brain/contextEngine/index.js`, `aqua/src/embeddings/embeddingProvider.js`, plus the log-only edits listed in Task A.
- **Modified (platform):** `index.js` (log statements only).
- **Modified (tests):** `aqua/src/core/tests/flagRegistry.test.js`, `aqua/src/core/tests/claimShadowMode.test.js`.
