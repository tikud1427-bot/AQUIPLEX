# AQUIPLEX — PWI Phase 1 Implementation Report

**Date:** 2026-11-15 · **Scope:** the three authorized fixes only, from [AQUIPLEX_PWI_ARCHITECTURE_AUDIT.md](AQUIPLEX_PWI_ARCHITECTURE_AUDIT.md) (C-1, C-2, C-5).

**Not done, as authorized:**

- nothing committed, pushed or deployed;
- no world-model migration;
- E6 writes untouched;
- no connectors;
- Reflection V2/V3 untouched;
- no legacy store deleted.

## 1. Cloud Run read mode (audit C-1)

**Change:** `AQUA_CANONICAL_READ=off` added to both templates:

- [deploy/cloudrun/api.service.yaml:82](deploy/cloudrun/api.service.yaml#L82);
- [deploy/cloudrun/worker.workerpool.yaml:54](deploy/cloudrun/worker.workerpool.yaml#L54).

**Are the templates used by deployment?** **No automated process uses them today.**

- No CI workflow, script, `cloudbuild` file or `render.yaml` references `deploy/cloudrun/`.
- `deploy/` is untracked.
- Production is still on Render, with dashboard-managed environment.
- The only consumers are:
  - the operator steps in [AQUIPLEX_CLOUD_RUN_CONFIGURATION_PLAN.md](AQUIPLEX_CLOUD_RUN_CONFIGURATION_PLAN.md) (manual `gcloud` apply in Phase 5);
  - the lint test `cloudRunTemplates.test.js`.

So the pin protects the Phase 5 rollout, and **whoever sets up the Phase 5 deploy must apply these files, or carry the variable over.** The tests guard the files, not a pipeline.

**Regression tests:**

- [aqua/src/routes/tests/cloudRunMemoryLanes.test.js](aqua/src/routes/tests/cloudRunMemoryLanes.test.js), new:
  - **Setup:** it drives the real `prepareTurn` with `DATABASE_URL` configured and a *reachable* database (a fake pool with an empty canonical store, so the read is not degraded). It reads `AQUA_CANONICAL_READ` from each template file.
  - **Assertions:** `systemPrompt` contains **goals, blockers, deadlines, relationships and conversation episodes**, one assertion each, for both templates.
  - **Sentinel:** a sentinel test shows that the same turn *without* the pin loses all five, so the reason for the pin stays visible.
- [cloudRunTemplates.test.js](aqua/src/core/tests/cloudRunTemplates.test.js), extended: each template must pin `off` and must reference the pseudonym key secret (fix 3).

## 2. PostgreSQL veto fallback (audit C-2)

**Before:** if the canonical veto query failed, for example on a timeout, a connection reset or schema drift, `legacyVetoFor` returned `() => true`. Every legacy fact and the identity card were withheld for that turn.

**After:** the query-failure fallback is `fallbackVetoFor` ([brain/index.js:227](aqua/src/brain/index.js#L227)). It vetoes:

- **the owner's deletions** (`deletionVetoFor`, :208), always. Every user forget/correct path (`memory/forget.js`) records the forgotten values and sentences in the owner's recall-redaction list before removing the legacy copy. That list is durable, needs no database, and is owner-scoped: its hashes are keyed by owner id. A legacy value containing a forgotten phrase is withheld, and so is anything stated before a "forget everything".
- **the last successful canonical veto for the same owner**, when it is at most 10 minutes old. It is kept per process, in a map of at most 1,000 owners, and dropped on account purge (`Brain.purgeOwner`).

**Degraded read (Postgres unreachable).** This path previously applied no veto at all. It now applies the same deletion veto: [chat.js:609](aqua/src/routes/chat.js#L609), [intelligence.js:186](aqua/src/routes/intelligence.js#L186).

**Safety properties, each tested:**

- **Deletions:** deleted values are never exposed, on the fallback or on the degraded read.
- **Ownership:** no cross-owner effect, from either the snapshot or the deletion list, and every query carries its own owner.
- **Partitions:** an owner whose deletion list is not loaded fails CLOSED, in a child process with partitions on.
- **Sensitive data:** sensitive-category withholding is unchanged, because the veto only removes.
- **Logging:** the fallback is logged with the error code and a pseudonymous owner.
- **Success path:** the success path decides exactly as before. Its logic was factored into `canonicalVetoPredicate`, unchanged.

**Tests:**

- [aqua/src/brain/tests/legacyVetoFallback.test.js](aqua/src/brain/tests/legacyVetoFallback.test.js) (new, 14 tests). Failures are injected through a scripted pool: `57014` statement timeout, `ECONNRESET`, `42P01` undefined table. It includes an end-to-end check through `memoryRetrieve`.
- `memoryDeliveryUnreachableDb.e2e.test.js`: the assertion that pinned the old fail-closed behaviour now asserts the new contract.

## 3. Owner ids in logs (audit C-5)

**Change:** `ownerLogId()` in [core/logSafety.js:72](aqua/src/core/logSafety.js#L72) returns:

- `o_<16 hex>` = HMAC-SHA256 under `AQUA_LOG_PSEUDONYM_KEY` (a secret of at least 32 characters). It is stable across restarts, instances and the API/worker split, and cannot be reversed without the key. It is domain-separated from the other log hashes.
- `p_<16 hex>` when the key is missing or short: a per-process key, warned once. The raw id is still never printed, and the prefix tells the reader that correlation holds only within one process.

**Lines changed (10):**

- `[SENSITIVE]` ×2, `[PIC]` ×2 and `[RECALL]` ×1 in `chat.js`;
- `[RECALL]` ×2 in `episodicRecall.js`;
- `[PIC]` ×3 in `pic/core.js`.

**Correlation:** `AQUA_LOG_PSEUDONYM_KEY=… node aqua/scripts/owner-log-id.mjs user:<id>` prints the pseudonym to search for. The key is registered in `flags.js`, and added to both templates as a Secret Manager reference, `aquiplex-log-pseudonym-key`, shared by API and worker.

**Tests:** [aqua/src/routes/tests/ownerLogPseudonym.test.js](aqua/src/routes/tests/ownerLogPseudonym.test.js) (new, 9 tests):

- the pseudonym's format;
- determinism;
- owner and key separation;
- **cross-process stability** (child processes);
- the fallback and its warning;
- the support script;
- a source guard over all of `src`;
- a real `/chat/stream` turn whose captured `[RECALL]`/`[PIC]`/`[SENSITIVE]` lines carry `o_…` and never the account id.

## Files changed

Four files listed below were **already modified or untracked before this work**, so `git diff` shows other changes too:

- `chat.js`, `brain/index.js` and the other `M` files;
- `logSafety.js` and `cloudRunTemplates.test.js` (Sprint 1 / Phase 4B, untracked).

My edits are only those listed here.

| File | Change |
|---|---|
| `deploy/cloudrun/api.service.yaml`, `worker.workerpool.yaml` | `AQUA_CANONICAL_READ=off`; `AQUA_LOG_PSEUDONYM_KEY` secret ref |
| `aqua/src/brain/index.js` | `deletionVetoFor`, `fallbackVetoFor`, snapshot map, `canonicalVetoPredicate` (extracted, same logic), catch → fallback, purge drops snapshot; imports |
| `aqua/src/routes/chat.js` | degraded-read deletion veto (:609); 5 log lines → `ownerLogId` |
| `aqua/src/routes/intelligence.js` | same degraded-read deletion veto (:186) |
| `aqua/src/memory/episodicRecall.js`, `aqua/src/pic/core.js` | 5 log lines → `ownerLogId` |
| `aqua/src/core/logSafety.js` | `ownerLogId`, `_resetOwnerLogIdForTests` |
| `aqua/src/core/flags.js` | register `AQUA_LOG_PSEUDONYM_KEY` |
| `aqua/scripts/owner-log-id.mjs` | new — support lookup |
| tests | 3 new files (above); `flagRegistry.test.js` census pins +1 setting/+1 read; `cloudRunTemplates.test.js` +4 tests; `memoryDeliveryUnreachableDb.e2e.test.js` 1 assertion updated |

## Test results

| Run | Result |
|---|---|
| Focused (9 files: the 3 new + every touched test) | **118 / 118 pass** |
| Full battery, no live DBs | 5,518 tests · 5,481 pass · **1 fail** (`repoHygiene`: two pre-existing `eval/out/*.before-profile*` files) · 29 skipped (live suites) · 7 todo |
| Full battery, live test DBs (Postgres :55432, Mongo :57017, Redis) | 5,872 tests · 5,832 pass · **14 fail**. 12 are the known pre-existing set: 9 eval CLIs that refuse while a DB URL is set (they pass in the no-DB run), 2 date-dependent `temporalState.live`, 1 `repoHygiene`. 2 are timing/shared-DB flakes: `perfShape` passes in isolation; `processMetrics` failed once because its worker picked up another suite's leftover job (`refw-a-…`), then passed on a rerun. None touch the changed code. |
| Eval gate (`node eval/gate.mjs`) | **BLOCKED** by the same four suites as the Sprint 4/6 reports: `capture-core` (dataset-shape rule), `acib-v1` (the identical 3 long-history efficiency metrics, ≈ −0.007), `acib-v1-needs`, `acib-heldout-v1-needs` (V2 trade-off). With no DB configured, `prepareTurn` now passes the same `null` veto as before, and only log text differs. 15 suites PASS; others have no baseline. |

`~/.aquiplex` was unchanged (mtime snapshot before and after). Docker test containers were started for the live run. `aqua-test-db` needed a restart because its port was not published after Docker Desktop's cold start.

## Unresolved risks

1. **Staleness on the fallback.** With no fresh snapshot (a new process, or a failure longer than 10 minutes), a legacy value that the canonical model *superseded*, but the user never deleted, can answer during the failure. This is the same exposure the degraded (unreachable) read already had. The previous fail-closed rule traded it for withholding everything.
2. **Forget-list limits.**
   - **Fragments:** the list stores hashed phrases. A legacy value that is only a *fragment* of a longer forgotten sentence is not detected. Every forget path also records the values themselves, so this affects only values no forget named (pinned in a test).
   - **Cap:** the list is capped per owner (`MAX_PHRASES_PER_OWNER`); the oldest phrases are evicted beyond it.
3. **The snapshot is per process.** A deletion made on another instance after this process's snapshot is still covered by the shared forget list (on partitions). A canonical supersession made elsewhere is not.
4. **The pseudonym key is a new secret.**
   - **Before Phase 5:** it must be created in Secret Manager and set to the same value for the API and the worker.
   - **Production:** Render has no key today, so its logs will show `p_…` (non-raw, but per-process).
   - **Rotation:** rotating the key breaks correlation with older logs, by design.
5. **Other log tags still print raw owner ids**, for example some `[MEMORY]` and `[BRAIN]` lines. They were out of the authorized scope.
6. **Template pin vs production.** The pin protects only a deploy made from these files. Nothing deploys them yet (§1).
