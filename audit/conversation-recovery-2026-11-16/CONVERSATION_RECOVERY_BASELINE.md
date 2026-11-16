# Conversation Recovery — Baseline (Phase 0)

Date 2026-11-16. Recorded before any source change in this repair.

## Repository state

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD | `d3e3d6bd9047481650ba6d10f21eb5817a656760` ("Memory: legacy veto falls back to deletions; owner ids pseudonymised in logs") |
| Working tree | 315 entries in `git status --porcelain` before this work: modified tracked files and untracked reports/scripts that pre-date this repair (the owner's uncommitted work — see `AQUIPLEX_543_CHANGES_INVENTORY.md`). |
| Preservation | No reset, stash, checkout or revert was run. Every file this repair touched was copied BEFORE its first edit to the session scratchpad (`originals/`); 13 of the 27 modified files already carried the owner's uncommitted edits (verified by comparing each saved original with `HEAD`; full list in ROLLBACK_AND_DEPLOYMENT_GUIDE.md §2). Only this repair's own delta is described in the reports. |
| Forensic reports | `audit/forensic-2026-11-16/*.md` (10 files) read; not modified. No newer reports (root-cause verification, regression testing, focus integration, shared contract, verification safety, recovery, rollback) existed in the repository; none were invented. |

## Test framework and commands

- `node:test`, run ONLY through `aqua/scripts/run-tests.mjs` — it sets a temporary `AQUA_DATA_DIR`, blanks `DATABASE_URL` (unless `AQUA_TEST_DATABASE_URL` is given) and disables the Mongo mirror. Running `node --test` directly loads the developer's real `~/.aquiplex` stores (a past incident), so it was never used.
- Per-directory runs (a single full-battery spawn fails with EPERM on this machine): `node scripts/run-tests.mjs src/<dir>` with `MONGO_URI=` and `DATABASE_URL=` blank.
- Node v24.19.0, Windows 11. Production is Linux (Render) — two SIGTERM tests skip on Windows by design.
- Real store check: `~/.aquiplex` listing (mtimes) captured before and after every battery; unchanged after the baseline battery.

## Baseline results (unmodified tree)

| Directory | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| src/routes | 363 | 363 | 0 | 0 |
| src/intelligence | 129 | 129 | 0 | 0 |
| src/brain | 1434 | 1426 | 0 | 8 |
| src/memory | 520 | 519 | 0 | 0 (1 todo) |
| src/core | 951 | 941 | **1** | 9 |
| src/orchestrator | 42 | 42 | 0 | 0 |
| src/cognition | 55 | 55 | 0 | 0 |
| src/providers | 199 | 199 | 0 | 0 |
| src/pic | 158 | 158 | 0 | 0 |
| src/mind | 200 | 194 | 0 | 0 (6 todo) |
| src/understanding | 146 | 146 | 0 | 0 |
| src/identity / search / upload / files / embeddings / project / artifacts / account / reasoning | 45 / 63 / 101 / 111 / 32 / 185 / 89 / 17 / 88 | all pass (artifacts 1 skip) | 0 | — |
| eval | 600 | 589 | 0 | 11 |

The one pre-existing failure (`src/core`, repository-hygiene test "no snapshot copies in the working tree (E1/PR-7)") is caused by two untracked files of the owner's, `aqua/eval/out/contexts.before-profile.code-defaults.json` and `…dev-env.json`. Not touched.

## Production entry points mapped

| Entry | Location |
|---|---|
| `POST /api/aqua/chat`, `/chat/stream` (and `/v1/…`) | `index.js` → `requireLogin` → `usageGuard` → `aqua/router.js` → `aqua/src/routes/chat.js` |
| `prepareTurn()` | `aqua/src/routes/chat.js` |
| Main drafter | `providers/router.js generateText / generateTextStream` |
| Task graph | `orchestrator/graphRuntime.js runTaskGraph` (`/chat` only) |
| Context Engine | `brain/index.js assembleContextAsync` → `brain/contextEngine/index.js` → `e8Pipeline.js` / `queryPlan.js` / `assembler.js` |
| Retrieval | `memory/engine.js memoryRetrieve`, PIC floor via `cognition`, `memory/episodicRecall.js`, semantic lanes |
| Verification / debate | `intelligence/verificationAgent.js`, `intelligence/debateAgent.js` |
| Persistence | `memory/conversationStore.js` (+ `conversationPartitions.js`, `routes/turnPostProcess.js commitTurnWithLearning`) |
| Ownership | `conversationStore.canAccessConversation`, route guards in `chat.js` |

## Feature flags affecting these paths

Pre-existing: `AQUA_CONTEXT_V2` (code default off; `.env` on; production on — proven by the World Core log line), `AQUA_RETRIEVAL_V3`, `AQUA_E6`, `AQUA_CIE`, `AQUA_WORLD_CORE`, `AQUA_CANONICAL_READ`, `AQUA_COST_AWARE_REVIEW`, `AQUA_STORE_PARTITIONS`, `AQUA_GRAPH`, `AQUA_EPISODIC_RECALL`, `AQUA_INFO_NEEDS`, `AQUA_HYBRID_CONTEXT`, `AQUA_DISABLE_MONGO_MIRROR`.
New in this repair (all default to the repaired behaviour; each is a rollback switch): see ROLLBACK_AND_DEPLOYMENT_GUIDE.md.

## Persistence configuration (no secrets printed)

- Repository `.env`: `DATABASE_URL` host `localhost:5432` (production logs show it unreachable); `MONGO_URI` set (mirror); `AQUA_STORE_PARTITIONS` unset → history partitions OFF.
- **Authoritative store for conversation history in the running process: the in-process Map**, snapshotted to `.aqua-history.json` (debounced 500 ms) and mirrored whole-file to Mongo `aqua_kv` (boot hydration only). Postgres partitions are a built-but-inactive path.
- **Instance count: not determinable from the repository.** No `render.yaml` / instance configuration is present; `deploy/cloudrun` templates exist but are not active. The mirror module itself documents the design as single-writer and alarms on a second writer. This repair therefore treats production as **single-instance** and documents that requirement.
