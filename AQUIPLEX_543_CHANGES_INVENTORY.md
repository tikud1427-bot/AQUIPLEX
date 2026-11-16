# AQUIPLEX — 543 Local Changes: Preservation and Release Audit

**Date:** 2026-11-16. **Base:** `main` @ `d3e3d6bd`, equal to `origin/main` (verified with `git ls-remote`).

**Audit only.** Nothing was staged, committed, pushed, deployed, reverted, stashed or cleaned. No branch or worktree was created.

**Preservation proof:** all 543 changed files were SHA-256-fingerprinted before the audit and re-hashed afterwards: **identical** (§13). This report is the only file added; it becomes change #544.

**How the evidence was produced** (all read-only; scripts in the session scratchpad):

| Step | Source |
|---|---|
| File list | `git status --porcelain --untracked-files=all` |
| Phase attribution of modified files | labels found in each file's **own added lines** (`git diff -U0`) |
| Dependencies | every changed JS file's relative imports, resolved to files on disk |
| Test status | `run-tests.mjs --list` (runs nothing) plus the last full battery on this tree |
| Gate defaults | `HEAD` vs working-tree `flags.js` registries, compared in a separate process |
| Secret scan | over the content of all 468 untracked files and the added lines of all tracked diffs |

**No test was run** in this audit: running the battery can write files, and the tree must stay untouched.

---

## 1. Totals

| | Count |
|---|---|
| Modified tracked files | **75** |
| Untracked files | **468** |
| **Total (VS Code count)** | **543** |
| Untracked top-level entries (`git status --short`, directories collapsed) | 238 |
| Of the untracked files: generated run outputs | 189 (62 ACIB results, 121 PWI results, 6 answer-eval results) |
| Of the untracked files: reports (`*.md` at repo root) | 90 |
| New database migrations | 6 (0026–0031), all untracked |
| Staged | 0 |

**Secret and personal-data scan:** no provider keys, private keys, Mongo SRV credentials, live payment keys, the owner's e-mail or name in any untracked file or in any added line of the tracked diffs (0 matches).

**Ignored, but present on disk:**

- `aqua/eval/out/` (`.gitignore:55`);
- `release/capture-integrity-v1/capture-integrity-v1.patch` (`*.patch`, `.gitignore:43`).

The **frontend** (`aqua-frontend/`) has **no changes**.

## 2. Workstreams (primary classification; full file lists in Appendix A)

Each file has one *primary* workstream. Files that serve several are in §5.

| Workstream | Modified | Untracked | What it is (evidence) |
|---|---|---|---|
| **WS-SECURITY**: log safety, flags registry, ownership/purge | 7 | 9 | Sprint 1 `core/logSafety.js` (Sprint 1 functions beyond the committed `ownerLogId`), CJS twin `utils/logSafety.js` (imported by `index.js`), flag registry and census tests, `accountPurge.js` |
| **WS-STORAGE**: owner partitions, atomic store, Mongo mirror | 6 | 45 | `core/storage/*` (14 modules), `atomicStore.js`, `mongoMirror.js` (+297/−10, lineage), migrations 0026–0027, `conversationPartitions.js`, partition scripts, 17 tests |
| **WS-MEMORY**: capture integrity, turn commit, forget path | 14 | 9 | `speechAct.js`, `memorySchema.js` (+87/−39), `turnCommit.js`, `forget.js`, `engine.js`, `propagation.js`, `mindStore.js` (+108) |
| **WS-DOCS-RETRIEVAL**: files, upload, embeddings, PIC, project, search | 17 | 0 | all modified; hunks are log-safety and partition bindings (§5) |
| **WS-HYBRID**: information needs + hybrid context | 1 | 16 | `informationNeeds.js`, `hybridContext.js`, 7 tests |
| **WS-JOBS**: durable jobs, workers, turn learning | 3 | 21 | `jobQueue.js` (+242), `workerRuntime.js` (+145), `worker.mjs` (+144), `turnLearning.js`, `schedulerLease.js`, migrations 0029–0030 |
| **WS-CREDITS**: allowance, wallet, pending charges | 3 | 8 | `wallet.service.js` (+98), `checkUsage.js`, `User.js`, `pendingCharges.js`, migration 0031 |
| **WS-ARTIFACTS**: artifact storage, GCS | 3 | 10 | `artifactStore.js` (+247), `objectStore` GCS tests, migration 0028, migration scripts |
| **WS-ORCH**: cost-aware review, cognition, intelligence | 7 | 2 | `verificationStrategy.js` (+54), `reviewDepth.test.js` |
| **WS-BRAIN**: brain stores | 7 | 0 | partition bindings in `idStore`, `reflectionStore`, `annotationStore`; log safety in `brain/index.js` |
| **WS-API**: API integration seams | 4 | 0 | `aqua/router.js`, `routes/chat.js` (+205/−47), `routes/turnPostProcess.js` (+154), `index.js` (+64) |
| **WS-DEPLOY**: Cloud Run / split runtime | 1 | 11 | `deploy/cloudrun/*.yaml`, `scripts/start-api.mjs`, `scripts/start-worker.mjs`, `package.json` (+2 scripts), PWI fix-1 tests |
| **WS-EVAL**: ACIB, answer eval, governance, providers | 2 | 120 | datasets, suites, adapters, answer runner, governance, key-pool provider manager, 17 tests |
| **WS-PWI**: PWI benchmark | 0 | 17 | `aqua/eval/pwi/*.mjs`, dataset + provenance, harness test, PWI reports |
| **Generated outputs** | 0 | 189 | `aqua/eval/acib/results/` (62), `aqua/eval/pwi/results/` (121), `aqua/eval/answer/results/` (6, counted in WS-EVAL in Appendix A) |
| **WS-REPORTS**: other analysis reports | 0 | 17 | audits, sprint reports |

## 3. Dependencies between workstreams

### 3.1 Modified tracked files that import untracked files

These cannot be committed without the untracked file. Resolved imports, complete list:

| Untracked dependency | Imported by (modified files) | Workstream |
|---|---|---|
| `core/storage/ownerBinding.js` | `aqua/router.js`, `idStore.js`, `reflectionStore.js`, `workerRuntime.js`, `core/storage/index.js`, `vectorStore.js`, `recallRedactions.js`, `mindStore.js`, `projectIndex.js`, `projectMemory.js`, `reasoningGraph.js` | STORAGE |
| `core/storage/keyedBinding.js` | `artifactStore.js`, `annotationStore.js`, `vectorStore.js`, `evidenceStore.js`, `fileSearchIndex.js`, `ukoStore.js`, `picStore.js`, `projectIndex.js`, `projectMemory.js`, `attachmentStore.js` | STORAGE |
| `core/storage/instanceAggregate.js` | `cognitiveStore.js`, `learningLedger.js` | STORAGE |
| `core/storage/requestWrites.js`, `responseGate.js` | `aqua/router.js`, `routes/chat.js`, `routes/turnPostProcess.js` | STORAGE |
| `core/storage/deletedOwners.js` | `accountPurge.js`, `workerRuntime.js` | STORAGE |
| `core/storage/objectStore.js` | `artifactStore.js` | STORAGE / ARTIFACTS |
| `memory/conversationPartitions.js` | `conversationStore.js`, `turnPostProcess.js` | STORAGE |
| `memory/turnCommit.js` | `routes/chat.js`, `routes/turnPostProcess.js` | MEMORY (Sprint 1) |
| `understanding/speechAct.js` | `candidateExtractor.js`, `goalTracker.js` | MEMORY (Sprint 4) |
| `brain/contextEngine/informationNeeds.js`, `hybridContext.js` | `routes/chat.js` | HYBRID |
| `learning/turnLearning.js` | `workerRuntime.js`, `turnPostProcess.js` | JOBS |
| `core/jobs/jobLog.js`, `schedulerLease.js` | `workerRuntime.js`, `scripts/worker.mjs` | JOBS |
| `credits/pendingCharges.js`, `reconcileJob.js` | `accountPurge.js`, `turnPostProcess.js`, `workerRuntime.js` | CREDITS |
| `services/credits/pendingChargeWallet.js` | `middleware/usage/checkUsage.js` | CREDITS |
| `utils/logSafety.js` | `index.js` | SECURITY |

### 3.2 Modified files that need the working-tree version of another modified file

**`core/logSafety.js`:**

- **Situation:** it is committed at `HEAD` with `ownerLogId` only.
- **Dependents:** 23 changed files import Sprint 1 functions that exist **only in the working copy** (`textMeta`, `valueMeta`, `safeKey`, `fileMeta`, `stripQuoted`, `safeDetails`, `shortHash`).
- **They include:** `memory/forget.js`, `propagation.js`, `memoryExtractor.js`, `longTermMemory.js`, `engine.js` (`fileMeta`), `memoryEditor.js`, `candidateExtractor.js`, `memoryRetriever.js`, `brain/index.js`, `observability.js`, `artifactStore.js`, `fileMemory.js`, `fileEngine.js`, `documentUnderstanding.js`, `attachmentStore.js`, `documentPipeline.js`, `identityMigration.js`, `projectRetriever.js`, `cognition/index.js` and `routes/chat.js`.
- **Consequence:** committing any of these without the rest of `logSafety.js` breaks the import.

**Other heavily-depended-on modified files** (number of changed files importing them): `atomicStore.js` 24, `mindStore.js` 21, `longTermMemory.js` 20, `flags.js` 19, `conversationStore.js` 15.

### 3.3 Workstream graph (production code only; edge counts and examples in Appendix C)

**Foundations** (depend on no other uncommitted workstream):

- the storage core: `atomicStore`, `mongoMirror`, `core/storage/*`. Its only outgoing edges come from the benchmark script `phase2b-bench.mjs`.
- the log-safety module.

**Cycles exist.** They pass through a few multi-purpose files:

- `accountPurge.js` imports every store;
- `forget.js → brain/index.js → mindStore.js`;
- `brain/index.js ⇄ docs/retrieval stores`.

So directory-sized commits **cannot** be ordered cleanly; commits must follow phases (§10).

**Nothing in production code imports WS-EVAL, WS-PWI, WS-DEPLOY or the reports.** Those depend on the product, never the reverse.

## 4. Existing tests and measured status

**Source:** the last full battery on this tree, with live test databases (Postgres, Mongo, Redis), run 2026-11-15. Since then the tree has only gained the PWI benchmark files, its harness test and reports; the commit `d3e3d6bd` changed no file content.

**Totals:** **5,872 tests, 5,832 pass, 14 fail, 19 skipped, 7 todo.**

The 14 failures are:

| Failing file | Count | Cause | Changed in this tree? |
|---|---|---|---|
| `eval/tests/evalProviderIntegration.test.js` | 8 | the eval CLIs refuse while a database URL is set; **0 failures** in the no-database run the same day | yes (WS-EVAL) |
| `eval/tests/answerRunner.test.js` | 1 | same | yes (WS-EVAL) |
| `src/brain/tests/temporalState.live.test.js` | 2 | date-dependent; **also fails on clean `HEAD`** (measured 2026-11-15) | no |
| `src/core/tests/repoHygiene.test.js` | 1 | ignored `eval/out/*.before-profile*` files on disk | no |
| `src/core/tests/perfShape.test.js` | 1 | timing; passed in isolation (measured) | no |
| `src/core/tests/processMetrics.test.js` | 1 | the shared test DB held another suite's leftover job; passed on rerun | no |

**Changed test files per workstream** (from `run-tests.mjs --list`):

| Workstream | Changed test files | Run by the battery | Failing on 2026-11-15 |
|---|---|---|---|
| SECURITY | 8 | 7 | none. `tests/platform/logSafety.test.js` belongs to the **platform** suite, **not run this session (unverified)** |
| STORAGE | 17 | 17 | none |
| MEMORY | 4 | 4 | none |
| HYBRID | 7 | 7 | none |
| JOBS | 3 | 3 | none |
| CREDITS | 1 | 1 | none. `pendingCharges.live` ran against the Mongo test container |
| ARTIFACTS | 3 | 3 | none. `objectStoreGcs` uses a **local emulator and an in-process fake**; no real GCS (file header) |
| ORCH | 3 | 3 | none |
| BRAIN | 1 | 1 | none |
| DEPLOY | 2 | 2 | none (template lint and lanes) |
| EVAL | 17 | 17 | the 9 database-URL refusals above |
| PWI | 1 | 1 | **not in the 2026-11-15 battery** (added later); run on its own: 10/10 on 2026-11-16 |

**Not measured in this tree:** the platform test suite; any HTTP-level test against a running server (Phase journeys ran 2026-11-13…15 per their reports — **not re-verified here**).

## 5. Files with overlapping changes (several phases in one file)

**26 of the 75 modified files** contain additions labelled with two or more phase families. The complete table is Appendix B. The worst cases:

| File | Diff | Phase families in its added lines |
|---|---|---|
| `aqua/src/core/flags.js` | +217/−12 | Sprint 1, info-needs/hybrid, partitions, durable jobs, Phase 4B, cost-aware review, ACIB (7) |
| `aqua/src/routes/chat.js` | +205/−47 | Sprint 1, info-needs/hybrid, durable jobs, Phase 4A, Phase 4B, cost-aware review, PWI (7) |
| `aqua/src/core/tests/flagRegistry.test.js` | +21/−5 | 7 (the census pins move with every phase) |
| `aqua/src/routes/turnPostProcess.js` | +154/−9 | Sprint 1, partitions, durable jobs, 4A, 4B (5) |
| `aqua/router.js` | +45/−4 | Sprint 1, partitions, durable jobs, 4A (4) |
| `worker.mjs`, `artifactStore.js`, `brain/index.js`, `atomicStore.js`, `workerRuntime.js`, `engine.js`, `wallet.service.js` | | 3 each |

**Consequences:**

- These files must be split **by hunk** to give each phase its own commit, as was done for Phase 1.
- `flags.js` and `flagRegistry.test.js` are special. The census test pins the **total** number of registrations and env reads across `src`, so each phase's commit must carry exactly its own registry entries **and** a matching pin.
- **Caveat:** the phase labels come from words in added lines (comments and flag names). They are strong indicators, not proof of which hunk belongs to which phase. Hunk ownership must be confirmed when splitting.

## 6. Database migrations and deployment risks

**Migrations** (all untracked; per the Phase reports, applied only to the local test database `aqua_test`; production has no `DATABASE_URL`, per DEMO_RUNBOOK):

| Migration | Workstream | Activated by |
|---|---|---|
| `0026_store_partitions.sql` | STORAGE | `AQUA_STORE_PARTITIONS` (default **off**) |
| `0027_owner_versions.sql` | STORAGE | partitions; contains a plpgsql trigger (the pg-mem harness skips it) |
| `0028_objects.sql` | ARTIFACTS | partitioned artifacts / `AQUA_OBJECT_STORE` |
| `0029_scheduler_leases.sql` | JOBS | the worker scheduler |
| `0030_learning_jobs.sql` | JOBS | `AQUA_POST_TURN_DURABLE` (default **off**) |
| `0031_pending_charges.sql` | CREDITS | `AQUA_PENDING_CHARGES` (default **off**) |

**No boot path applies migrations.**

- `aqua/router.js:150` only logs "schema BEHIND"; migration runs through `npm run db:migrate`.
- **Scripts that call `migrate()` all carry a guard:**

| Script | Guard |
|---|---|
| `charges-reconcile.mjs` | refuses non-local DB without `--allow-remote` |
| `history-migration.mjs` | dry run |
| `artifact-migration.mjs` | dry run unless `--apply`; refuses remote |
| `partition-migrate.mjs` | dry run |
| `partition-load.mjs` | explicit `--db`, refuses non-local |
| `phase2b-bench.mjs` | local databases only, line 26 |

**Deployment files (must not be activated accidentally):**

- **`deploy/cloudrun/api.service.yaml` and `worker.workerpool.yaml`:** never deployed; nothing in the repo applies them. The worker-pool launch stage is **unverified** (plan doc). They set `DATABASE_URL`, `AQUA_STORE_PARTITIONS` (every store on), `AQUA_POST_TURN_DURABLE=on`, `AQUA_PENDING_CHARGES=on`, `AQUA_OBJECT_STORE=gcs` and `AQUA_CANONICAL_READ=off`. Applied as-is, they switch on every off-by-default system in this tree at once.
- **`package.json`:** adds the `start:api` and `start:worker` scripts. They are inert unless a host's start command is changed.
- **Push risk:** a push to `main` may auto-deploy to Render, so **any commit of this tree's code is a production change once pushed.**

**Production behaviour changes that are NOT behind a flag** (they would go live on the first deploy of these files; verified in code):

| Change | Evidence |
|---|---|
| **Capture integrity** (speech-act gating of extraction) | `understanding/speechAct.js` has no flag (0 `AQUA_` reads); wired into `candidateExtractor.js` and `memoryExtractor.js:203-205` |
| **Failed-turn memory rollback** | `memory/turnCommit.js` has 0 `AQUA_` reads; used by `routes/chat.js` |
| **Mongo mirror lineage / boot protection** (+297 lines) | `core/mongoMirror.js` has only tuning settings (`AQUA_MIRROR_*_MS`), no on/off switch; it changes boot behaviour on Render |
| **Sprint 1 log redaction** | unconditional by design |
| **`AQUA_COST_AWARE_REVIEW`** | a **new gate, default ON**, which changes which turns get verification and debate |
| `AQUA_CIE`, `AQUA_GRAPH` "off → on" | **registry corrections only**: the read site was already `?? 'on'` at `HEAD` (`cognition/index.js:50`, verified for CIE; GRAPH not re-verified) |
| `ARTIFACTS_ENABLED` (on) | registration of existing behaviour |

Every other new gate defaults **off**: `AQUA_STORE_PARTITIONS`, `AQUA_POST_TURN_DURABLE`, `AQUA_PENDING_CHARGES`, `AQUA_INFO_NEEDS`, `AQUA_HYBRID_CONTEXT`, `AQUA_LOG_CONTENT`. There are 18 new settings, listed in Appendix D.

## 7. Incomplete, experimental, duplicate, obsolete or risky work (each with evidence)

| Item | Status | Evidence |
|---|---|---|
| ACIB v3 | **incomplete**: governance tooling only, no frozen v3 dataset | `eval/governance/` has a manifest **template**; no `acib.v3*` file in `eval/datasets/` |
| Answer-level evaluation | **essentially unrun** | the only live run, `eval/answer/results/live-smoke-1.json`, is `answered: 2, judged: 0, status: complete-judging-queued` |
| PWI benchmark v1 | complete as a baseline; **scorer defects found** | `AQUIPLEX_FOUNDER_REVIEW_NEXT_STEPS.md` §2 (CSV false positive, deletion stores not checked); `AQUIPLEX_PWI_BENCHMARK_BASELINE_REPORT.md` contains statements corrected by that review |
| Hybrid / information needs | experimental, **off** | gates default off; evaluated on ACIB sets the team had read item by item; 50 ms wall-clock budget hits observed (`BudgetExceeded` ×3 in PWI logs) |
| Partitions, durable jobs, pending charges | built, **off**, exercised only on the local test DB | gates default off; migrations 0026–0031 untracked |
| GCS object store | **emulator-tested only** | `objectStoreGcs.test.js` header: fake-gcs-server plus an in-process fake transport |
| Cloud Run templates | **never deployed**; worker-pool launch stage unverified | no deployment tooling in the repo |
| `release/capture-integrity-v1/` | **obsolete once capture integrity is committed** | a frozen export (patch ignored, 2 `.sha256` files untracked) of code that is also in the working tree |
| `utils/logSafety.js` | **not a duplicate**: an intentional CommonJS twin for the platform server | its header; imported by `index.js` |
| Generated outputs (189 files) | **must not be committed** | run outputs with synthetic prompts; they also contain machine paths |
| Reports (90 at root) | mixed: some superseded or partly corrected | e.g. the PWI baseline report, corrected by the founder review |

## 8. Which work must remain local

| Keep local (never commit) | Why |
|---|---|
| `aqua/eval/acib/results/**` (62) | generated run outputs |
| `aqua/eval/pwi/results/**` (121) | generated; contain absolute local paths (`dataDir`) and full prompts |
| `aqua/eval/answer/results/**` (6) | generated, including one live provider run |
| `release/capture-integrity-v1/*.sha256` | belongs to an ignored release patch; obsolete after the capture-integrity commit |

**Founder decision: keep local or move to `docs/`:**

- the root reports (90);
- the deployment templates `deploy/cloudrun/**`, which can be committed but **must stay unapplied until Phase 5 is approved**.

## 9. Changes that are safe to keep separate

These are independent of production code. Nothing in production imports them (§3.3), so they can be committed, or left uncommitted, without affecting runtime:

- WS-EVAL tooling, datasets and suites (not results);
- WS-PWI benchmark code, dataset and provenance;
- WS-REPORTS;
- `deploy/cloudrun/**` and its two tests.

**Off-by-default runtime workstreams** (HYBRID, CREDITS pending charges, JOBS durable learning, ARTIFACTS GCS) can be committed separately from each other **once their foundations are in**. They cannot go before STORAGE and SECURITY, because of the imports in §3.1.

## 10. Recommended commit sequence (proposal; each step needs founder approval; nothing is staged)

**Method, as for Phase 1:**

- **Isolation:** each commit is built from `HEAD` text plus its own hunks, in a clean worktree.
- **Verification:** the full battery runs there before staging. The worktree requires the founder's approval, per this task's rules.
- **Splitting:** multi-phase files (§5) are split by hunk.

| # | Commit | Contains | Why in this position (evidence) |
|---|---|---|---|
| 1 | **Log safety (Sprint 1)** | rest of `core/logSafety.js`, `utils/logSafety.js`, both logSafety tests, `logPrivacy.test.js`, `picQueryRedaction.test.js`, and the log-redaction hunks of the 23 importing files | imported by 23 changed files (§3.2), including every Phase 3A file |
| 2 | **Storage core (Phase 2a/2b), off** | `core/storage/*`, migrations 0026–0027, `conversationPartitions.js`, the binding hunks of the 20+ store files, `AQUA_STORE_PARTITIONS` registry and pins, storage tests, `atomicStore` / `mongoMirror` partition hunks | `ownerBinding`/`keyedBinding` are imported by 20+ modified files (§3.1) |
| 3 | **Mirror lineage + failed-turn rollback (Sprint 1), ungated** | `mongoMirror.js` lineage, `turnCommit.js`, `failedTurnMemory.test.js`, `mongoMirrorStartup.test.js`, matching `chat.js` / `turnPostProcess.js` hunks | ungated production behaviour (§6); needs its own approval and a Render validation plan |
| 4 | **Capture integrity (Sprint 4), ungated** | `speechAct.js`, `memorySchema.js`, extractor / `goalTracker` hunks, tests | ungated, and changes capture for all users (§6); the PWI benchmark gives a before/after measure |
| 5 | **Cost-aware review, default on** | `verificationStrategy.js`, intelligence hunks, `reviewDepth.test.js` | default-on behaviour change; separate so it can be reverted alone |
| 6 | **Information needs + hybrid, off** | contextEngine files, `chat.js` hunks, 7 tests | depends on 1, 4 (`chat.js`), `recallRedactions` (2) |
| 7 | **Durable jobs / turn learning (Phase 3), off** | `jobQueue`, `workerRuntime`, `worker.mjs`, `turnLearning.js`, `jobLog.js`, `schedulerLease.js`, migrations 0029–0030, `turnPostProcess.js` / `router.js` / `index.js` hunks, tests | needs 2 (`deletedOwners`, `ownerBinding`) |
| 8 | **Persistence boundary (Phase 4A)** | the 4A hunks of `chat.js`, `atomicStore`, `engine.js`, `forget.js`, `propagation.js` and wallet | 4A labels in those files (§5) |
| 9 | **Pending charges + GCS + artifacts (Phase 4B), off** | `credits/*`, `pendingChargeWallet.js`, wallet / usage / User hunks, migrations 0028 and 0031, artifact hunks, GCS tests | needs 2 and 7 (`workerRuntime → reconcileJob`) |
| 10 | **Deployment templates + PWI fix 1** | `deploy/cloudrun/**`, `start-api.mjs`, `start-worker.mjs`, `package.json` scripts, the two cloudRun tests | nothing imports them; must not be applied |
| 11 | **Evaluation tooling** (no results) | WS-EVAL except `results/` | independent of production code |
| 12 | **PWI benchmark** (no results) | `aqua/eval/pwi/*.mjs`, dataset, provenance, harness test | independent; its inputs include `acib.v1.json` from 11 |
| 13 | **Reports** (if approved) | root `*.md` | documentation |

**Alternative if hunk-level splitting is judged too costly:** merge commits 1–3 and 7–8 into "foundation" commits that keep all new gates off. That gives less precise history, but the same verification method. **Commits 3, 4 and 5 should stay separate in either case**, because they change production behaviour without a flag.

## 11. Prerequisites for Phase 3A (deletion correctness)

**Measured**, as the transitive closure of uncommitted imports starting from the files Phase 3A would edit.

**Minimal 3A-1 / 3A-3** (chat forget plus full reach; seeds `engine.js`, `forget.js`, `propagation.js`, `memoryExtractor.js`) pulls in **about 40 uncommitted files**:

| Workstream | Files pulled in |
|---|---|
| SECURITY | `logSafety.js`, `flags.js`, `observability.js` |
| STORAGE | `atomicStore.js`, `mongoMirror.js`, 8 `core/storage/*` modules |
| MEMORY | 12, including `speechAct.js` |
| DOCS-RETRIEVAL | 8 |
| BRAIN | 5 |
| JOBS | `jobQueue.js` |
| contextEngine | `index.js` |

**The roots:**

- `logSafety.js` (Sprint 1) and its Sprint 1 function imports in `forget.js`, `propagation.js`, `memoryExtractor.js`, `longTermMemory.js` and `engine.js`;
- `ownerBinding.js` (Phase 2b), via `mindStore.js` and `recallRedactions.js`;
- `speechAct.js` (Sprint 4), via `memoryExtractor.js`.

**Full 3A** (adding document forget and the `chat.js` clarification directive) pulls in about 63 files across 11 workstreams, because `chat.js` imports hybrid, jobs, credits and storage.

**Therefore:**

- **Prerequisites to commit before Phase 3A:** commits **1 (log safety), 2 (storage core) and 4 (capture integrity)** from §10. For 3A-2 (the `chat.js` clarification), also **3, 6, 7, 8 and 9**, or a 3A-2 design that does not touch `chat.js`, for instance carrying the clarification on the memory trace.
- **The alternative** is to build Phase 3A on `HEAD` text, as Phase 1 was, and port it into the working tree. It is possible, but doubles the work and risks conflicts in the 26 overlap files.
- **Recommendation:** commit 1, 2 and 4 first, each verified in a clean worktree, then build 3A-1 and 3A-3.

## 12. Decisions requiring founder approval

1. **Commit method:** hunk-level phase commits (§10 table) or merged foundation commits (§10 alternative).
2. **Clean worktrees for verification:** permission to create them (one per commit), as for Phase 1.
3. **Ungated behaviour changes** (§6): approve committing mirror lineage, failed-turn rollback, capture integrity and the default-on cost-aware review. A push makes them live on Render.
4. **Reports and templates:** commit, move to `docs/`, or keep local (§8).
5. **Phase 3A order:** confirm "commits 1, 2, 4, then 3A-1 / 3A-3" (§11).

## 13. Preservation check

Re-hash of all 543 paths after writing this report's analysis: **identical** to the fingerprint taken before the audit.

- **Index:** empty.
- **Branch:** `main` at `d3e3d6bd`, equal to `origin/main`.
- **Only file added:** this report (`AQUIPLEX_543_CHANGES_INVENTORY.md`).

---
## Appendix A — every changed file, by primary workstream (543)

`M` = modified tracked (with `+added/−removed` lines vs `HEAD`), `??` = untracked.

### WS-SECURITY (16: 7 M, 9 ??)

- M  `aqua/src/account/accountPurge.js` (+12/-0)
- M  `aqua/src/core/flags.js` (+217/-12)
- M  `aqua/src/core/logSafety.js` (+119/-3)
- M  `aqua/src/core/observability.js` (+5/-2)
- M  `aqua/src/core/tests/claimShadowMode.test.js` (+6/-1)
- M  `aqua/src/core/tests/flagRegistry.test.js` (+21/-5)
- M  `aqua/src/routes/health.js` (+5/-0)
- ?? `AQUA_FEATURE_FLAG_AUDIT.md`
- ?? `aqua/src/core/tests/featureStatus.test.js`
- ?? `aqua/src/core/tests/flagReadSiteParity.test.js`
- ?? `aqua/src/core/tests/logSafety.test.js`
- ?? `aqua/src/routes/tests/logPrivacy.test.js`
- ?? `aqua/src/routes/tests/picQueryRedaction.test.js`
- ?? `AQUIPLEX_SPRINT1_PRODUCTION_SAFETY_REPORT.md`
- ?? `tests/platform/logSafety.test.js`
- ?? `utils/logSafety.js`

### WS-STORAGE (51: 6 M, 45 ??)

- M  `aqua/src/core/atomicStore.js` (+33/-4)
- M  `aqua/src/core/mongoMirror.js` (+297/-10)
- M  `aqua/src/core/storage/index.js` (+20/-2)
- M  `aqua/src/core/tests/dbPool.test.js` (+18/-0)
- M  `aqua/src/core/tests/helpers/memoryPg.mjs` (+7/-1)
- M  `aqua/src/core/tests/storageAdapter.test.js` (+4/-1)
- ?? `aqua/scripts/history-migration.mjs`
- ?? `aqua/scripts/partition-load.mjs`
- ?? `aqua/scripts/partition-migrate.mjs`
- ?? `aqua/scripts/phase2b-bench.mjs`
- ?? `aqua/scripts/phase2c-app-journey.mjs`
- ?? `aqua/src/brain/tests/reflectionPartitions.test.js`
- ?? `aqua/src/core/db/migrations/0026_store_partitions.sql`
- ?? `aqua/src/core/db/migrations/0027_owner_versions.sql`
- ?? `aqua/src/core/storage/deletedOwners.js`
- ?? `aqua/src/core/storage/entryMerge.js`
- ?? `aqua/src/core/storage/historyMigration.js`
- ?? `aqua/src/core/storage/instanceAggregate.js`
- ?? `aqua/src/core/storage/keyedBinding.js`
- ?? `aqua/src/core/storage/objectStore.js`
- ?? `aqua/src/core/storage/ownerBinding.js`
- ?? `aqua/src/core/storage/partitionLayout.js`
- ?? `aqua/src/core/storage/partitionMigration.js`
- ?? `aqua/src/core/storage/partitionRepository.js`
- ?? `aqua/src/core/storage/requestWrites.js`
- ?? `aqua/src/core/storage/responseGate.js`
- ?? `aqua/src/core/tests/entryMerge.test.js`
- ?? `aqua/src/core/tests/helpers/multiProcess.mjs`
- ?? `aqua/src/core/tests/helpers/storeProcess.mjs`
- ?? `aqua/src/core/tests/historyMigration.test.js`
- ?? `aqua/src/core/tests/instanceAggregate.test.js`
- ?? `aqua/src/core/tests/mongoMirrorStartup.test.js`
- ?? `aqua/src/core/tests/partitionLayout.test.js`
- ?? `aqua/src/core/tests/partitionMigration.test.js`
- ?? `aqua/src/core/tests/partitionRepository.test.js`
- ?? `aqua/src/core/tests/phase2cLimits.test.js`
- ?? `aqua/src/core/tests/phase2cStores.test.js`
- ?? `aqua/src/core/tests/phase4aPersistence.test.js`
- ?? `aqua/src/core/tests/storeMigrationMatrix.test.js`
- ?? `aqua/src/memory/conversationPartitions.js`
- ?? `aqua/src/memory/tests/conversationPartitions.test.js`
- ?? `aqua/src/mind/tests/mindPartitions.test.js`
- ?? `aqua/src/reasoning/tests/graphIdsPartitions.test.js`
- ?? `AQUIPLEX_APPLICATION_INTEGRATION_TEST_REPORT.md`
- ?? `AQUIPLEX_CONVERSATION_MIGRATION_REPORT.md`
- ?? `AQUIPLEX_PER_OWNER_STORAGE_PLAN.md`
- ?? `AQUIPLEX_PHASE_2B_REPORT.md`
- ?? `AQUIPLEX_PHASE_2C_REPORT.md`
- ?? `AQUIPLEX_PHASE_4A_PERSISTENCE_REPORT.md`
- ?? `AQUIPLEX_SCALABILITY_AUDIT.md`
- ?? `AQUIPLEX_STORE_OWNERSHIP_MATRIX.md`

### WS-MEMORY (23: 14 M, 9 ??)

- M  `aqua/src/memory/candidateExtractor.js` (+37/-4)
- M  `aqua/src/memory/conversationStore.js` (+66/-4)
- M  `aqua/src/memory/engine.js` (+12/-5)
- M  `aqua/src/memory/forget.js` (+4/-2)
- M  `aqua/src/memory/identityMigration.js` (+2/-1)
- M  `aqua/src/memory/longTermMemory.js` (+2/-1)
- M  `aqua/src/memory/memoryEditor.js` (+8/-7)
- M  `aqua/src/memory/memoryExtractor.js` (+9/-4)
- M  `aqua/src/memory/memoryRetriever.js` (+3/-1)
- M  `aqua/src/memory/memorySchema.js` (+87/-39)
- M  `aqua/src/memory/propagation.js` (+5/-3)
- M  `aqua/src/memory/recallRedactions.js` (+72/-9)
- M  `aqua/src/mind/goalTracker.js` (+5/-2)
- M  `aqua/src/mind/mindStore.js` (+108/-3)
- ?? `AQUA_CAPTURE_INTEGRITY_V1.md`
- ?? `aqua/src/memory/tests/captureIntegrity.test.js`
- ?? `aqua/src/memory/tests/turnCommit.test.js`
- ?? `aqua/src/memory/turnCommit.js`
- ?? `aqua/src/routes/tests/failedTurnMemory.test.js`
- ?? `aqua/src/understanding/speechAct.js`
- ?? `aqua/src/understanding/tests/speechAct.test.js`
- ?? `release/capture-integrity-v1/FILES.sha256`
- ?? `release/capture-integrity-v1/PATCH.sha256`

### WS-DOCS-RETRIEVAL (17: 17 M, 0 ??)

- M  `aqua/src/embeddings/embeddingProvider.js` (+3/-0)
- M  `aqua/src/embeddings/fileMemory.js` (+2/-1)
- M  `aqua/src/embeddings/vectorStore.js` (+44/-4)
- M  `aqua/src/files/documentUnderstanding.js` (+2/-1)
- M  `aqua/src/files/evidenceStore.js` (+77/-16)
- M  `aqua/src/files/fileEngine.js` (+3/-2)
- M  `aqua/src/files/fileSearchIndex.js` (+47/-5)
- M  `aqua/src/files/ukoStore.js` (+45/-10)
- M  `aqua/src/pic/core.js` (+1/-1)
- M  `aqua/src/pic/picStore.js` (+65/-11)
- M  `aqua/src/project/projectIndex.js` (+28/-4)
- M  `aqua/src/project/projectMemory.js` (+32/-3)
- M  `aqua/src/project/projectRetriever.js` (+2/-1)
- M  `aqua/src/reasoning/reasoningGraph.js` (+163/-16)
- M  `aqua/src/search/searchManager.js` (+4/-3)
- M  `aqua/src/upload/attachmentStore.js` (+35/-5)
- M  `aqua/src/upload/documentPipeline.js` (+2/-1)

### WS-HYBRID (17: 1 M, 16 ??)

- M  `aqua/src/brain/contextEngine/index.js` (+3/-0)
- ?? `AQUA_HYBRID_CONTEXT_ARCHITECTURE.md`
- ?? `AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md`
- ?? `AQUA_HYBRID_CONTEXT_V1_IMPLEMENTATION.md`
- ?? `AQUA_HYBRID_CONTEXT_V1_RESULTS.md`
- ?? `AQUA_INFORMATION_NEEDS_ENGINE_DESIGN.md`
- ?? `AQUA_INFORMATION_NEEDS_ENGINE_IMPLEMENTATION.md`
- ?? `AQUA_INFORMATION_NEEDS_V2.md`
- ?? `aqua/src/brain/contextEngine/hybridContext.js`
- ?? `aqua/src/brain/contextEngine/informationNeeds.js`
- ?? `aqua/src/brain/tests/hybridContext.test.js`
- ?? `aqua/src/brain/tests/informationNeeds.test.js`
- ?? `aqua/src/brain/tests/informationNeedsV2.test.js`
- ?? `aqua/src/routes/tests/hybridContextRoute.test.js`
- ?? `aqua/src/routes/tests/infoNeedsShadowFailedTurn.test.js`
- ?? `aqua/src/routes/tests/infoNeedsShadowReadiness.test.js`
- ?? `aqua/src/routes/tests/informationNeedsRoute.test.js`

### WS-JOBS (24: 3 M, 21 ??)

- M  `aqua/scripts/worker.mjs` (+144/-11)
- M  `aqua/src/core/jobs/jobQueue.js` (+242/-24)
- M  `aqua/src/core/jobs/workerRuntime.js` (+145/-12)
- ?? `aqua/scripts/phase3-learning-journey.mjs`
- ?? `aqua/scripts/phase3-linux-shutdown.mjs`
- ?? `aqua/scripts/phase4a-linux-api-shutdown.mjs`
- ?? `aqua/src/core/db/migrations/0029_scheduler_leases.sql`
- ?? `aqua/src/core/db/migrations/0030_learning_jobs.sql`
- ?? `aqua/src/core/jobs/jobLog.js`
- ?? `aqua/src/core/jobs/schedulerLease.js`
- ?? `aqua/src/core/tests/phase3Learning.test.js`
- ?? `aqua/src/core/tests/phase3Roles.test.js`
- ?? `aqua/src/core/tests/phase4bWorker.test.js`
- ?? `aqua/src/learning/turnLearning.js`
- ?? `AQUIPLEX_JOB_ARCHITECTURE.md`
- ?? `AQUIPLEX_JOB_OWNERSHIP_AND_RECOVERY.md`
- ?? `AQUIPLEX_LINUX_SHUTDOWN_TEST_REPORT.md`
- ?? `AQUIPLEX_PHASE_3_API_WORKER_DESIGN.md`
- ?? `AQUIPLEX_PHASE_3_IMPLEMENTATION_REPORT.md`
- ?? `AQUIPLEX_PHASE_3_READINESS_REPORT.md`
- ?? `AQUIPLEX_PHASE_3_TEST_REPORT.md`
- ?? `AQUIPLEX_PHASE_4_READINESS_REPORT.md`
- ?? `AQUIPLEX_PHASE_4B_IMPLEMENTATION_REPORT.md`
- ?? `AQUIPLEX_PHASE_4B_READINESS_REPORT.md`

### WS-CREDITS (11: 3 M, 8 ??)

- M  `middleware/usage/checkUsage.js` (+57/-5)
- M  `models/User.js` (+9/-0)
- M  `services/credits/wallet.service.js` (+98/-4)
- ?? `aqua/scripts/charges-reconcile.mjs`
- ?? `aqua/src/core/db/migrations/0031_pending_charges.sql`
- ?? `aqua/src/credits/pendingCharges.js`
- ?? `aqua/src/credits/reconcileJob.js`
- ?? `aqua/src/credits/tests/helpers/chargeChild.mjs`
- ?? `aqua/src/credits/tests/pendingCharges.live.test.js`
- ?? `AQUIPLEX_PENDING_CHARGE_RECOVERY_REPORT.md`
- ?? `services/credits/pendingChargeWallet.js`

### WS-ARTIFACTS (13: 3 M, 10 ??)

- M  `aqua/src/artifacts/artifactStore.js` (+247/-3)
- M  `aqua/src/artifacts/editEngine.js` (+6/-7)
- M  `aqua/src/routes/artifacts.js` (+12/-10)
- ?? `aqua/scripts/artifact-migration.mjs`
- ?? `aqua/scripts/artifact-storage-audit.mjs`
- ?? `aqua/src/artifacts/artifactAudit.js`
- ?? `aqua/src/artifacts/tests/artifactAudit.test.js`
- ?? `aqua/src/artifacts/tests/artifactMigration.live.test.js`
- ?? `aqua/src/core/db/migrations/0028_objects.sql`
- ?? `aqua/src/core/tests/objectStoreGcs.test.js`
- ?? `AQUIPLEX_ARTIFACT_MIGRATION_READINESS.md`
- ?? `AQUIPLEX_ARTIFACT_STORAGE_AUDIT.md`
- ?? `AQUIPLEX_GCS_STORAGE_IMPLEMENTATION_REPORT.md`

### WS-ORCH (9: 7 M, 2 ??)

- M  `aqua/src/cognition/cognitiveStore.js` (+44/-22)
- M  `aqua/src/cognition/index.js` (+5/-1)
- M  `aqua/src/intelligence/confidenceEngine.test.js` (+19/-2)
- M  `aqua/src/intelligence/internalIntelligenceEngine.js` (+8/-9)
- M  `aqua/src/intelligence/learningLedger.js` (+18/-4)
- M  `aqua/src/intelligence/tests/intelligencePipeline.test.js` (+15/-2)
- M  `aqua/src/orchestrator/verificationStrategy.js` (+54/-1)
- ?? `aqua/src/orchestrator/tests/reviewDepth.test.js`
- ?? `AQUIPLEX_UNIFIED_INTELLIGENCE_STAGE0_1.md`

### WS-BRAIN (7: 7 M, 0 ??)

- M  `aqua/src/brain/identity/idStore.js` (+65/-4)
- M  `aqua/src/brain/index.js` (+9/-3)
- M  `aqua/src/brain/proactive/index.js` (+3/-0)
- M  `aqua/src/brain/reflectionV2/index.js` (+5/-1)
- M  `aqua/src/brain/reflectionV2/reflectionStore.js` (+117/-31)
- M  `aqua/src/brain/tests/legacyVetoFallback.test.js` (+15/-0)
- M  `aqua/src/brain/worldModel/annotationStore.js` (+27/-5)

### WS-API (4: 4 M, 0 ??)

- M  `aqua/router.js` (+45/-4)
- M  `aqua/src/routes/chat.js` (+205/-47)
- M  `aqua/src/routes/turnPostProcess.js` (+154/-9)
- M  `index.js` (+64/-4)

### WS-DEPLOY (12: 1 M, 11 ??)

- M  `package.json` (+2/-0)
- ?? `AQUA_RENDER_SHADOW_READINESS.md`
- ?? `aqua/src/core/tests/cloudRunTemplates.test.js`
- ?? `aqua/src/routes/tests/cloudRunMemoryLanes.test.js`
- ?? `AQUIPLEX_API_SHUTDOWN_TEST_REPORT.md`
- ?? `AQUIPLEX_CLOUD_RUN_CONFIGURATION_PLAN.md`
- ?? `AQUIPLEX_INITIAL_INFRASTRUCTURE_COST_ESTIMATE.md`
- ?? `AQUIPLEX_PHASE_5_READINESS_REPORT.md`
- ?? `deploy/cloudrun/api.service.yaml`
- ?? `deploy/cloudrun/worker.workerpool.yaml`
- ?? `scripts/start-api.mjs`
- ?? `scripts/start-worker.mjs`

### WS-EVAL (122: 2 M, 120 ??)

- M  `aqua/eval/core/gate.mjs` (+21/-2)
- M  `aqua/eval/tests/evalGate.test.js` (+13/-2)
- ?? `AQUA_ACIB_V1_BASELINE_RESULTS.md`
- ?? `AQUA_ACIB_V1_COMPARISON_RESULTS.md`
- ?? `AQUA_ACIB_V1_IMPLEMENTATION.md`
- ?? `AQUA_ACIB_V2_BENCHMARK.md`
- ?? `AQUA_ACIB_V3_ANALYSIS_SPEC.md`
- ?? `AQUA_ACIB_V3_AUTHORING_BRIEF.md`
- ?? `AQUA_ACIB_V3_DECLARATIONS.md`
- ?? `AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md`
- ?? `AQUA_ANSWER_EVALUATION_COST_REVIEW.md`
- ?? `AQUA_ANSWER_EVALUATION_RUNNER.md`
- ?? `AQUA_ANSWER_QUALITY_EVALUATION.md`
- ?? `AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md`
- ?? `AQUA_EVALUATION_APPROVAL_SWITCH_AUDIT.md`
- ?? `AQUA_EVALUATION_CREDENTIAL_VERIFICATION.md`
- ?? `AQUA_EVALUATION_KEY_POOL_AUDIT.md`
- ?? `AQUA_EVALUATION_PROVIDER_INTEGRATION_TESTS.md`
- ?? `AQUA_EVALUATION_PROVIDER_MANAGER.md`
- ?? `AQUA_EVALUATION_RUNNER_INTEGRATION.md`
- ?? `AQUA_EVALUATION_SMOKE_TEST_READINESS.md`
- ?? `AQUA_EXISTING_KEY_POOL_INTEGRATION.md`
- ?? `AQUA_EXISTING_KEY_POOL_TESTS.md`
- ?? `AQUA_ZERO_COST_QUOTA_FALLBACK_TESTS.md`
- ?? `aqua/eval/acib/acib-heldout-v1-needs.baseline.json`
- ?? `aqua/eval/acib/acib-heldout-v1-needs.baseline.json.sha256`
- ?? `aqua/eval/acib/acib-heldout-v1.baseline.json`
- ?? `aqua/eval/acib/acib-heldout-v1.baseline.json.sha256`
- ?? `aqua/eval/acib/acib-v1-needs.baseline.json`
- ?? `aqua/eval/acib/acib-v1-needs.baseline.json.sha256`
- ?? `aqua/eval/acib/acib-v1.baseline.json`
- ?? `aqua/eval/acib/acib-v1.baseline.json.sha256`
- ?? `aqua/eval/adapters/acibPipeline.mjs`
- ?? `aqua/eval/answer/answerGrader.mjs`
- ?? `aqua/eval/answer/answerGraderV3.mjs`
- ?? `aqua/eval/answer/evalRun.mjs`
- ?? `aqua/eval/answer/judgeRubric.md`
- ?? `aqua/eval/answer/judgeRunner.mjs`
- ?? `aqua/eval/answer/pairedAnalysis.mjs`
- ?? `aqua/eval/answer/providerClient.mjs`
- ?? `aqua/eval/answer/results/dry-full-2026-11-11.json`
- ?? `aqua/eval/answer/results/dry-full-2026-11-11.judge-key.json`
- ?? `aqua/eval/answer/results/dry-full-2026-11-11.judge-requests.jsonl`
- ?? `aqua/eval/answer/results/live-smoke-1.json`
- ?? `aqua/eval/answer/results/live-smoke-1.merged.json`
- ?? `aqua/eval/answer/results/live-smoke-1.pairs.jsonl`
- ?? `aqua/eval/answer/spendLedger.mjs`
- ?? `aqua/eval/baselines/acib-heldout-v1-needs.v1.json`
- ?? `aqua/eval/baselines/acib-heldout-v1.v1.json`
- ?? `aqua/eval/baselines/acib-v1-needs.v1.json`
- ?? `aqua/eval/baselines/acib-v1.v1.json`
- ?? `aqua/eval/datasets/acib.heldout.v1.FROZEN.sha256`
- ?? `aqua/eval/datasets/acib.heldout.v1.json`
- ?? `aqua/eval/datasets/acib.v1.FROZEN.sha256`
- ?? `aqua/eval/datasets/acib.v1.json`
- ?? `aqua/eval/datasets/acib.v2.dev.FROZEN.sha256`
- ?? `aqua/eval/datasets/acib.v2.dev.json`
- ?? `aqua/eval/datasets/acib.v2.eval.FROZEN.sha256`
- ?? `aqua/eval/datasets/acib.v2.eval.json`
- ?? `aqua/eval/datasets/src/acib.v2.dev.source.mjs`
- ?? `aqua/eval/datasets/src/acib.v2.eval.source.mjs`
- ?? `aqua/eval/datasets/src/acib.v2.eval.source.sha256`
- ?? `aqua/eval/governance/acib-v3-manifest.template.json`
- ?? `aqua/eval/governance/acibV3Governance.mjs`
- ?? `aqua/eval/governance/reviewerMode.mjs`
- ?? `aqua/eval/governance/reviewerPrepare.mjs`
- ?? `aqua/eval/measurements/acib-v2-dev.prompt-sizes.long.json`
- ?? `aqua/eval/measurements/acib-v2-dev.prompt-sizes.very-long.json`
- ?? `aqua/eval/providers/credentials.mjs`
- ?? `aqua/eval/providers/errorTaxonomy.mjs`
- ?? `aqua/eval/providers/evalConfig.example.json`
- ?? `aqua/eval/providers/evalConfig.mjs`
- ?? `aqua/eval/providers/pairRunner.mjs`
- ?? `aqua/eval/providers/providerManager.mjs`
- ?? `aqua/eval/providers/transports.mjs`
- ?? `aqua/eval/suites/acib-heldout-v1-hybrid.suite.mjs`
- ?? `aqua/eval/suites/acib-heldout-v1-needs.suite.mjs`
- ?? `aqua/eval/suites/acib-heldout-v1.suite.mjs`
- ?? `aqua/eval/suites/acib-v1-hybrid.suite.mjs`
- ?? `aqua/eval/suites/acib-v1-needs.suite.mjs`
- ?? `aqua/eval/suites/acib-v1.suite.mjs`
- ?? `aqua/eval/suites/acib-v2-dev-hybrid.suite.mjs`
- ?? `aqua/eval/suites/acib-v2-dev-needs.suite.mjs`
- ?? `aqua/eval/suites/acib-v2-dev.suite.mjs`
- ?? `aqua/eval/suites/acib-v2-eval-hybrid.suite.mjs`
- ?? `aqua/eval/suites/acib-v2-eval-needs.suite.mjs`
- ?? `aqua/eval/suites/acib-v2-eval.suite.mjs`
- ?? `aqua/eval/suites/acibScoring.mjs`
- ?? `aqua/eval/suites/acibSuite.mjs`
- ?? `aqua/eval/tests/acibV3Decisions.test.js`
- ?? `aqua/eval/tests/acibV3FinalPrep.test.js`
- ?? `aqua/eval/tests/acibV3FounderFinal.test.js`
- ?? `aqua/eval/tests/acibV3Governance.test.js`
- ?? `aqua/eval/tests/acibV3Readiness.test.js`
- ?? `aqua/eval/tests/answerGrader.test.js`
- ?? `aqua/eval/tests/answerRunner.test.js`
- ?? `aqua/eval/tests/evalProviderIntegration.test.js`
- ?? `aqua/eval/tests/evalProviderManager.test.js`
- ?? `aqua/eval/tests/evalReadiness.test.js`
- ?? `aqua/eval/tests/existingKeyPool.test.js`
- ?? `aqua/eval/tests/finalPreExecution.test.js`
- ?? `aqua/eval/tests/fixtures/acibV3Filler.mjs`
- ?? `aqua/eval/tests/fixtures/fetchGuard.mjs`
- ?? `aqua/eval/tests/founderVerifiedGemini.test.js`
- ?? `aqua/eval/tests/phase2Evaluation.test.js`
- ?? `aqua/eval/tests/preSmokeReadiness.test.js`
- ?? `aqua/eval/tests/zeroCostReadiness.test.js`
- ?? `aqua/scripts/acib-run.mjs`
- ?? `aqua/scripts/acib-v3-freeze.mjs`
- ?? `aqua/scripts/acib-v3-reviewer-prepare.mjs`
- ?? `aqua/scripts/answer-analyze.mjs`
- ?? `aqua/scripts/answer-eval.mjs`
- ?? `aqua/scripts/answer-judge.mjs`
- ?? `aqua/scripts/build-acib-v2.mjs`
- ?? `aqua/scripts/measure-prompt-sizes.mjs`
- ?? `AQUIPLEX_ACIB_V3_GOVERNANCE_AND_GRADER_READINESS.md`
- ?? `AQUIPLEX_EVALUATION_KEY_POOL_REPORT.md`
- ?? `AQUIPLEX_EVALUATION_READINESS_REPORT.md`
- ?? `AQUIPLEX_EXISTING_CREDENTIAL_EVALUATION_READINESS.md`
- ?? `AQUIPLEX_INTELLIGENCE_BENCHMARK_READINESS.md`
- ?? `AQUIPLEX_INTELLIGENCE_EVALUATION_PHASE2.md`
- ?? `AQUIPLEX_JUDGE_READINESS.md`

### WS-PWI (17: 0 M, 17 ??)

- ?? `aqua/eval/pwi/analyze.mjs`
- ?? `aqua/eval/pwi/dataset/PROVENANCE.md`
- ?? `aqua/eval/pwi/dataset/pwi-v1.json`
- ?? `aqua/eval/pwi/dataset/pwi-v1.json.sha256`
- ?? `aqua/eval/pwi/report-table.mjs`
- ?? `aqua/eval/pwi/rescore.mjs`
- ?? `aqua/eval/pwi/run-pwi.mjs`
- ?? `aqua/eval/pwi/score.mjs`
- ?? `aqua/eval/pwi/stage.mjs`
- ?? `aqua/eval/pwi/truth.mjs`
- ?? `aqua/eval/tests/pwiBenchmark.test.js`
- ?? `AQUIPLEX_FOUNDER_REVIEW_NEXT_STEPS.md`
- ?? `AQUIPLEX_PWI_ARCHITECTURE_AUDIT.md`
- ?? `AQUIPLEX_PWI_BENCHMARK_BASELINE_REPORT.md`
- ?? `AQUIPLEX_PWI_BENCHMARK_SPEC.md`
- ?? `AQUIPLEX_PWI_PHASE1_COMMIT_PREP.md`
- ?? `AQUIPLEX_PWI_PHASE1_IMPLEMENTATION_REPORT.md`

### WS-REPORTS (17: 0 M, 17 ??)

- ?? `AQUA_CONTEXT_ENGINE_AUDIT.md`
- ?? `AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md`
- ?? `AQUA_SHADOW_FAILED_TURN_TEST.md`
- ?? `AQUIPLEX_ARCHITECTURE_MAP.md`
- ?? `AQUIPLEX_ENGINEERING_ROADMAP.md`
- ?? `AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md`
- ?? `AQUIPLEX_SPRINT2_ENGINEERING_NOTES.md`
- ?? `AQUIPLEX_SPRINT3_ENGINEERING_REPORT.md`
- ?? `AQUIPLEX_SPRINT4_REPORT.md`
- ?? `AQUIPLEX_SPRINT5_CAPTURE_RELEASE_REVIEW.md`
- ?? `AQUIPLEX_SPRINT5_REPORT.md`
- ?? `AQUIPLEX_SPRINT5_SHADOW_READINESS_REVIEW.md`
- ?? `AQUIPLEX_SPRINT6_CAPTURE_RELEASE_PACKAGE.md`
- ?? `AQUIPLEX_SPRINT6_REPORT.md`
- ?? `AQUIPLEX_WORKER_FAILURE_INVESTIGATION.md`
- ?? `AQUIPLEX_ZERO_BUDGET_INTEGRATION_REPORT.md`
- ?? `AQUIPLEX_ZERO_COST_EVALUATION_READINESS.md`

### WS-ACIB-results (62: 0 M, 62 ??)

- `aqua/eval/acib/results/` — 62 file(s)

<details><summary>File names</summary>

- ?? `aqua/eval/acib/results/acib-heldout-v1-hybrid.s6.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-hybrid.s6b.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.d3.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.d4.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.d5.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.d6.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.d7.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.d8.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.d9.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.first-run.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.s6.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1-needs.second-run-posthoc.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1.d3.json`
- ?? `aqua/eval/acib/results/acib-heldout-v1.s6.json`
- ?? `aqua/eval/acib/results/acib-v1-hybrid.s6.json`
- ?? `aqua/eval/acib/results/acib-v1-hybrid.s6b.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.d3.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.d4.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.d5.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.d6.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.d7.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.d8.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.d9.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.det-a.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.det-b.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.dev1.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.dev2.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.dev3.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.dev4.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.dev5.json`
- ?? `aqua/eval/acib/results/acib-v1-needs.s6.json`
- ?? `aqua/eval/acib/results/acib-v1.d3.json`
- ?? `aqua/eval/acib/results/acib-v1.determinism-a.json`
- ?? `aqua/eval/acib/results/acib-v1.determinism-b.json`
- ?? `aqua/eval/acib/results/acib-v1.s6.json`
- ?? `aqua/eval/acib/results/acib-v1.sprint3-arm-a.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-hybrid.s6.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-hybrid.s6b.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d0.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d1.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d2.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d3.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d4.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d5.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d6.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d7.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d8.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.d9.json`
- ?? `aqua/eval/acib/results/acib-v2-dev-needs.s6.json`
- ?? `aqua/eval/acib/results/acib-v2-dev.d0.json`
- ?? `aqua/eval/acib/results/acib-v2-dev.d3.json`
- ?? `aqua/eval/acib/results/acib-v2-dev.s6.json`
- ?? `aqua/eval/acib/results/acib-v2-eval-hybrid.s6.json`
- ?? `aqua/eval/acib/results/acib-v2-eval-hybrid.s6b.json`
- ?? `aqua/eval/acib/results/acib-v2-eval-needs.s6.json`
- ?? `aqua/eval/acib/results/acib-v2-eval-needs.sprint4-after-first-run.json`
- ?? `aqua/eval/acib/results/acib-v2-eval-needs.sprint4-after-seam-recheck.json`
- ?? `aqua/eval/acib/results/acib-v2-eval-needs.sprint4-before.json`
- ?? `aqua/eval/acib/results/acib-v2-eval.s6.json`
- ?? `aqua/eval/acib/results/acib-v2-eval.sprint4-after-first-run.json`
- ?? `aqua/eval/acib/results/acib-v2-eval.sprint4-before.json`
- ?? `aqua/eval/acib/results/sprint4-implementation.hashes.txt`

</details>

### WS-PWI-results (121: 0 M, 121 ??)

- `aqua/eval/pwi/results/baseline-2026-11-15/` — 4 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run1/` — 3 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/` — 9 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/` — 9 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/` — 9 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/` — 9 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/` — 9 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/` — 9 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/` — 3 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/` — 9 file(s)
- `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/` — 9 file(s)
- `aqua/eval/pwi/results/review-2026-11-16/` — 1 file(s)
- `aqua/eval/pwi/results/review-2026-11-16/rerun/` — 2 file(s)
- `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/` — 9 file(s)
- `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/` — 9 file(s)
- `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/` — 9 file(s)
- `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/` — 9 file(s)

<details><summary>File names</summary>

- ?? `aqua/eval/pwi/results/baseline-2026-11-15/failures-hybrid-long.md`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/failures-prod-long.md`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/failures-prod-short.md`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-long/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/hybrid-short/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-long/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/prod-short/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-long/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/propagation-short/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/summary.2026-11-15T14-11-04-180Z.superseded.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/summary.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run1/summary.json.sha256`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-long/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/A.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/A.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/A.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/B.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/B.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/B.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/C.run.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/C.score.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/prod-short/C.verify.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/summary.2026-11-15T14-11-09-230Z.superseded.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/summary.json`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/run2-determinism/summary.json.sha256`
- ?? `aqua/eval/pwi/results/baseline-2026-11-15/tables.md`
- ?? `aqua/eval/pwi/results/review-2026-11-16/git-status-after-commit.txt`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/A.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/A.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/A.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/B.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/B.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/B.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/C.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/C.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-long/C.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/A.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/A.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/A.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/B.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/B.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/B.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/C.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/C.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/hybrid-short/C.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/A.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/A.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/A.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/B.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/B.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/B.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/C.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/C.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-long/C.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/A.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/A.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/A.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/B.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/B.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/B.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/C.run.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/C.score.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/prod-short/C.verify.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/summary.json`
- ?? `aqua/eval/pwi/results/review-2026-11-16/rerun/summary.json.sha256`

</details>

Total listed: **543**.

## Appendix B — phase families per modified file (from each file's own added lines)

| File | Diff | Families | Phase families |
|---|---|---|---|
| `aqua/src/core/flags.js` | +217/-12 | 7 | S1 log-safety/mirror/turn-commit; S3/S6 info-needs/hybrid; P2/2b owner partitions; P3 durable jobs/split runtime; P4b charges/GCS/worker; cost-aware review; ACIB |
| `aqua/src/core/tests/flagRegistry.test.js` | +21/-5 | 7 | S3/S6 info-needs/hybrid; P2/2b owner partitions; P3 durable jobs/split runtime; P4a persistence boundary; P4b charges/GCS/worker; cost-aware review; PWI phase 1 |
| `aqua/src/routes/chat.js` | +205/-47 | 7 | S1 log-safety/mirror/turn-commit; S3/S6 info-needs/hybrid; P3 durable jobs/split runtime; P4a persistence boundary; P4b charges/GCS/worker; cost-aware review; PWI phase 1 |
| `aqua/src/routes/turnPostProcess.js` | +154/-9 | 5 | S1 log-safety/mirror/turn-commit; P2/2b owner partitions; P3 durable jobs/split runtime; P4a persistence boundary; P4b charges/GCS/worker |
| `aqua/router.js` | +45/-4 | 4 | S1 log-safety/mirror/turn-commit; P2/2b owner partitions; P3 durable jobs/split runtime; P4a persistence boundary |
| `aqua/scripts/worker.mjs` | +144/-11 | 3 | P2/2b owner partitions; P3 durable jobs/split runtime; P4b charges/GCS/worker |
| `aqua/src/artifacts/artifactStore.js` | +247/-3 | 3 | S1 log-safety/mirror/turn-commit; P2/2b owner partitions; P4b charges/GCS/worker |
| `aqua/src/brain/index.js` | +9/-3 | 3 | S1 log-safety/mirror/turn-commit; P2/2b owner partitions; PWI phase 1 |
| `aqua/src/core/atomicStore.js` | +33/-4 | 3 | S1 log-safety/mirror/turn-commit; P3 durable jobs/split runtime; P4a persistence boundary |
| `aqua/src/core/jobs/workerRuntime.js` | +145/-12 | 3 | P2/2b owner partitions; P3 durable jobs/split runtime; P4b charges/GCS/worker |
| `aqua/src/core/tests/dbPool.test.js` | +18/-0 | 3 | P2/2b owner partitions; P3 durable jobs/split runtime; P4b charges/GCS/worker |
| `aqua/src/memory/engine.js` | +12/-5 | 3 | S1 log-safety/mirror/turn-commit; P3 durable jobs/split runtime; P4a persistence boundary |
| `services/credits/wallet.service.js` | +98/-4 | 3 | P3 durable jobs/split runtime; P4a persistence boundary; P4b charges/GCS/worker |
| `aqua/src/account/accountPurge.js` | +12/-0 | 2 | P3 durable jobs/split runtime; P4b charges/GCS/worker |
| `aqua/src/brain/tests/legacyVetoFallback.test.js` | +15/-0 | 2 | S1 log-safety/mirror/turn-commit; P2/2b owner partitions |
| `aqua/src/core/jobs/jobQueue.js` | +242/-24 | 2 | P3 durable jobs/split runtime; P4b charges/GCS/worker |
| `aqua/src/core/mongoMirror.js` | +297/-10 | 2 | S1 log-safety/mirror/turn-commit; P3 durable jobs/split runtime |
| `aqua/src/memory/candidateExtractor.js` | +37/-4 | 2 | S1 log-safety/mirror/turn-commit; S4 capture integrity |
| `aqua/src/memory/conversationStore.js` | +66/-4 | 2 | P2/2b owner partitions; P3 durable jobs/split runtime |
| `aqua/src/memory/forget.js` | +4/-2 | 2 | S1 log-safety/mirror/turn-commit; P4a persistence boundary |
| `aqua/src/memory/memoryExtractor.js` | +9/-4 | 2 | S1 log-safety/mirror/turn-commit; S4 capture integrity |
| `aqua/src/memory/propagation.js` | +5/-3 | 2 | S1 log-safety/mirror/turn-commit; P4a persistence boundary |
| `aqua/src/mind/mindStore.js` | +108/-3 | 2 | P2/2b owner partitions; P3 durable jobs/split runtime |
| `aqua/src/upload/attachmentStore.js` | +35/-5 | 2 | S1 log-safety/mirror/turn-commit; P2/2b owner partitions |
| `index.js` | +64/-4 | 2 | S1 log-safety/mirror/turn-commit; P3 durable jobs/split runtime |
| `middleware/usage/checkUsage.js` | +57/-5 | 2 | P4a persistence boundary; P4b charges/GCS/worker |
| `aqua/eval/core/gate.mjs` | +21/-2 | 1 | ACIB |
| `aqua/eval/tests/evalGate.test.js` | +13/-2 | 1 | ACIB |
| `aqua/src/artifacts/editEngine.js` | +6/-7 | 1 | P4b charges/GCS/worker |
| `aqua/src/brain/identity/idStore.js` | +65/-4 | 1 | P2/2b owner partitions |
| `aqua/src/brain/reflectionV2/index.js` | +5/-1 | 1 | P2/2b owner partitions |
| `aqua/src/brain/reflectionV2/reflectionStore.js` | +117/-31 | 1 | P2/2b owner partitions |
| `aqua/src/brain/worldModel/annotationStore.js` | +27/-5 | 1 | P2/2b owner partitions |
| `aqua/src/cognition/cognitiveStore.js` | +44/-22 | 1 | P2/2b owner partitions |
| `aqua/src/cognition/index.js` | +5/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/core/logSafety.js` | +119/-3 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/core/observability.js` | +5/-2 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/core/storage/index.js` | +20/-2 | 1 | P2/2b owner partitions |
| `aqua/src/core/tests/claimShadowMode.test.js` | +6/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/core/tests/helpers/memoryPg.mjs` | +7/-1 | 1 | P2/2b owner partitions |
| `aqua/src/core/tests/storageAdapter.test.js` | +4/-1 | 1 | P3 durable jobs/split runtime |
| `aqua/src/embeddings/embeddingProvider.js` | +3/-0 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/embeddings/fileMemory.js` | +2/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/embeddings/vectorStore.js` | +44/-4 | 1 | P2/2b owner partitions |
| `aqua/src/files/documentUnderstanding.js` | +2/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/files/evidenceStore.js` | +77/-16 | 1 | P2/2b owner partitions |
| `aqua/src/files/fileEngine.js` | +3/-2 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/files/fileSearchIndex.js` | +47/-5 | 1 | P2/2b owner partitions |
| `aqua/src/files/ukoStore.js` | +45/-10 | 1 | P2/2b owner partitions |
| `aqua/src/intelligence/confidenceEngine.test.js` | +19/-2 | 1 | cost-aware review |
| `aqua/src/intelligence/internalIntelligenceEngine.js` | +8/-9 | 1 | cost-aware review |
| `aqua/src/intelligence/learningLedger.js` | +18/-4 | 1 | P2/2b owner partitions |
| `aqua/src/memory/identityMigration.js` | +2/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/memory/longTermMemory.js` | +2/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/memory/memoryEditor.js` | +8/-7 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/memory/memoryRetriever.js` | +3/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/memory/memorySchema.js` | +87/-39 | 1 | S4 capture integrity |
| `aqua/src/memory/recallRedactions.js` | +72/-9 | 1 | P2/2b owner partitions |
| `aqua/src/mind/goalTracker.js` | +5/-2 | 1 | S4 capture integrity |
| `aqua/src/orchestrator/verificationStrategy.js` | +54/-1 | 1 | cost-aware review |
| `aqua/src/pic/core.js` | +1/-1 | 1 | PWI phase 1 |
| `aqua/src/pic/picStore.js` | +65/-11 | 1 | P2/2b owner partitions |
| `aqua/src/project/projectIndex.js` | +28/-4 | 1 | P2/2b owner partitions |
| `aqua/src/project/projectMemory.js` | +32/-3 | 1 | P2/2b owner partitions |
| `aqua/src/project/projectRetriever.js` | +2/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/reasoning/reasoningGraph.js` | +163/-16 | 1 | P2/2b owner partitions |
| `aqua/src/routes/artifacts.js` | +12/-10 | 1 | P4b charges/GCS/worker |
| `aqua/src/routes/health.js` | +5/-0 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/search/searchManager.js` | +4/-3 | 1 | S1 log-safety/mirror/turn-commit |
| `aqua/src/upload/documentPipeline.js` | +2/-1 | 1 | S1 log-safety/mirror/turn-commit |
| `models/User.js` | +9/-0 | 1 | P4b charges/GCS/worker |
| `aqua/src/brain/contextEngine/index.js` | +3/-0 | 0 | — |
| `aqua/src/brain/proactive/index.js` | +3/-0 | 0 | — |
| `aqua/src/intelligence/tests/intelligencePipeline.test.js` | +15/-2 | 0 | — |
| `package.json` | +2/-0 | 0 | — |

## Appendix C — workstream dependency edges (production code; count of import edges)

| Edge | Imports | Example |
|---|---|---|
| WS-API → WS-ARTIFACTS | 3 | `aqua/router.js → aqua/src/routes/artifacts.js` |
| WS-API → WS-BRAIN | 4 | `aqua/router.js → aqua/src/brain/index.js` |
| WS-API → WS-CREDITS | 3 | `aqua/src/routes/turnPostProcess.js → aqua/src/credits/pendingCharges.js` |
| WS-API → WS-DOCS-RETRIEVAL | 7 | `aqua/router.js → aqua/src/pic/core.js` |
| WS-API → WS-HYBRID | 2 | `aqua/src/routes/chat.js → aqua/src/brain/contextEngine/informationNeeds.js` |
| WS-API → WS-JOBS | 2 | `aqua/src/routes/turnPostProcess.js → aqua/src/core/jobs/jobQueue.js` |
| WS-API → WS-MEMORY | 10 | `aqua/router.js → aqua/src/memory/propagation.js` |
| WS-API → WS-ORCH | 4 | `aqua/src/routes/chat.js → aqua/src/intelligence/internalIntelligenceEngine.js` |
| WS-API → WS-SECURITY | 10 | `aqua/router.js → aqua/src/routes/health.js` |
| WS-API → WS-STORAGE | 9 | `aqua/router.js → aqua/src/core/mongoMirror.js` |
| WS-ARTIFACTS → WS-SECURITY | 2 | `aqua/src/artifacts/artifactStore.js → aqua/src/core/logSafety.js` |
| WS-ARTIFACTS → WS-STORAGE | 8 | `aqua/src/artifacts/artifactStore.js → aqua/src/core/atomicStore.js` |
| WS-BRAIN → WS-DOCS-RETRIEVAL | 5 | `aqua/src/brain/index.js → aqua/src/reasoning/reasoningGraph.js` |
| WS-BRAIN → WS-HYBRID | 2 | `aqua/src/brain/index.js → aqua/src/brain/contextEngine/index.js` |
| WS-BRAIN → WS-MEMORY | 3 | `aqua/src/brain/index.js → aqua/src/mind/mindStore.js` |
| WS-BRAIN → WS-SECURITY | 5 | `aqua/src/brain/index.js → aqua/src/core/observability.js` |
| WS-BRAIN → WS-STORAGE | 6 | `aqua/src/brain/identity/idStore.js → aqua/src/core/atomicStore.js` |
| WS-DEPLOY → WS-API | 1 | `scripts/start-api.mjs → index.js` |
| WS-DEPLOY → WS-JOBS | 1 | `scripts/start-worker.mjs → aqua/scripts/worker.mjs` |
| WS-DOCS-RETRIEVAL → WS-BRAIN | 1 | `aqua/src/files/documentUnderstanding.js → aqua/src/brain/index.js` |
| WS-DOCS-RETRIEVAL → WS-JOBS | 1 | `aqua/src/files/documentUnderstanding.js → aqua/src/core/jobs/jobQueue.js` |
| WS-DOCS-RETRIEVAL → WS-MEMORY | 1 | `aqua/src/upload/attachmentStore.js → aqua/src/memory/conversationStore.js` |
| WS-DOCS-RETRIEVAL → WS-SECURITY | 9 | `aqua/src/embeddings/embeddingProvider.js → aqua/src/core/flags.js` |
| WS-DOCS-RETRIEVAL → WS-STORAGE | 21 | `aqua/src/embeddings/vectorStore.js → aqua/src/core/atomicStore.js` |
| WS-EVAL → WS-API | 2 | `aqua/eval/adapters/acibPipeline.mjs → aqua/src/routes/chat.js` |
| WS-EVAL → WS-MEMORY | 2 | `aqua/eval/adapters/acibPipeline.mjs → aqua/src/memory/conversationStore.js` |
| WS-EVAL → WS-SECURITY | 2 | `aqua/eval/adapters/acibPipeline.mjs → aqua/src/core/observability.js` |
| WS-HYBRID → WS-MEMORY | 3 | `aqua/src/brain/contextEngine/informationNeeds.js → aqua/src/memory/recallRedactions.js` |
| WS-HYBRID → WS-SECURITY | 1 | `aqua/src/brain/contextEngine/index.js → aqua/src/core/flags.js` |
| WS-JOBS → WS-BRAIN | 3 | `aqua/src/core/jobs/workerRuntime.js → aqua/src/brain/index.js` |
| WS-JOBS → WS-CREDITS | 1 | `aqua/src/core/jobs/workerRuntime.js → aqua/src/credits/reconcileJob.js` |
| WS-JOBS → WS-DOCS-RETRIEVAL | 3 | `aqua/src/core/jobs/workerRuntime.js → aqua/src/embeddings/embeddingProvider.js` |
| WS-JOBS → WS-MEMORY | 4 | `aqua/src/learning/turnLearning.js → aqua/src/memory/conversationStore.js` |
| WS-JOBS → WS-SECURITY | 3 | `aqua/src/core/jobs/workerRuntime.js → aqua/src/core/observability.js` |
| WS-JOBS → WS-STORAGE | 6 | `aqua/scripts/worker.mjs → aqua/src/core/storage/index.js` |
| WS-MEMORY → WS-BRAIN | 2 | `aqua/src/memory/forget.js → aqua/src/brain/index.js` |
| WS-MEMORY → WS-DOCS-RETRIEVAL | 5 | `aqua/src/memory/engine.js → aqua/src/files/evidenceStore.js` |
| WS-MEMORY → WS-JOBS | 1 | `aqua/src/memory/propagation.js → aqua/src/core/jobs/jobQueue.js` |
| WS-MEMORY → WS-SECURITY | 10 | `aqua/src/memory/candidateExtractor.js → aqua/src/core/logSafety.js` |
| WS-MEMORY → WS-STORAGE | 6 | `aqua/src/memory/conversationStore.js → aqua/src/core/atomicStore.js` |
| WS-ORCH → WS-DOCS-RETRIEVAL | 1 | `aqua/src/cognition/index.js → aqua/src/pic/core.js` |
| WS-ORCH → WS-SECURITY | 2 | `aqua/src/cognition/index.js → aqua/src/core/logSafety.js` |
| WS-ORCH → WS-STORAGE | 4 | `aqua/src/cognition/cognitiveStore.js → aqua/src/core/atomicStore.js` |
| WS-SECURITY → WS-ARTIFACTS | 1 | `aqua/src/account/accountPurge.js → aqua/src/artifacts/artifactStore.js` |
| WS-SECURITY → WS-BRAIN | 1 | `aqua/src/account/accountPurge.js → aqua/src/brain/index.js` |
| WS-SECURITY → WS-CREDITS | 1 | `aqua/src/account/accountPurge.js → aqua/src/credits/pendingCharges.js` |
| WS-SECURITY → WS-DOCS-RETRIEVAL | 9 | `aqua/src/account/accountPurge.js → aqua/src/upload/attachmentStore.js` |
| WS-SECURITY → WS-JOBS | 2 | `aqua/src/account/accountPurge.js → aqua/src/core/jobs/jobQueue.js` |
| WS-SECURITY → WS-MEMORY | 6 | `aqua/src/account/accountPurge.js → aqua/src/memory/conversationStore.js` |
| WS-SECURITY → WS-STORAGE | 2 | `aqua/src/account/accountPurge.js → aqua/src/core/storage/deletedOwners.js` |
| WS-STORAGE → WS-BRAIN | 1 | `aqua/scripts/phase2b-bench.mjs → aqua/src/brain/reflectionV2/reflectionStore.js` |
| WS-STORAGE → WS-MEMORY | 2 | `aqua/scripts/phase2b-bench.mjs → aqua/src/memory/conversationStore.js` |


## Appendix D — registry changes (HEAD vs working tree, flags.js)

| Kind | Name | Default / note |
|---|---|---|
| default changed (registry) | `AQUA_CIE` | off → on |
| default changed (registry) | `AQUA_GRAPH` | off → on |
| new gate | `AQUA_COST_AWARE_REVIEW` | on |
| new gate | `AQUA_PENDING_CHARGES` | off |
| new gate | `AQUA_POST_TURN_DURABLE` | off |
| new gate | `AQUA_STORE_PARTITIONS` | off |
| new gate | `AQUA_INFO_NEEDS` | off |
| new gate | `AQUA_HYBRID_CONTEXT` | off |
| new gate | `AQUA_LOG_CONTENT` | off |
| new gate | `ARTIFACTS_ENABLED` | on |
| new setting | `AQUA_PARTITION_CACHE_ENTRIES` | owner-partitioned store  |
| new setting | `AQUA_ROLE` | process role in the split runtime: api  |
| new setting | `AQUA_SCHEDULER_LEASE_MS` | TTL of the periodic-scheduler lease among workers  |
| new setting | `AQUA_JOB_HEARTBEAT_STALE_MS` | a running job whose heartbeat is older than this is reclaimed by recovery  |
| new setting | `AQUA_SHUTDOWN_BUDGET_MS` | SIGTERM → exit budget when shutdown blockers are registered  |
| new setting | `AQUA_JOB_AGING_SECONDS` | durable job claim aging  |
| new setting | `AQUA_CHARGE_ABANDON_MS` | a PENDING charge older than this is abandoned  |
| new setting | `AQUA_CHARGE_RECONCILE_INTERVAL_MS` | how often the scheduler-owning worker enqueues credits |
| new setting | `AQUA_CHARGE_CRASH_AT` | TEST SEAM: kill the process at a named charge transition  |
| new setting | `AQUA_GCS_BUCKET` | the Google Cloud Storage bucket of AQUA_OBJECT_STORE=gcs  |
| new setting | `AQUA_GCS_ENDPOINT` | GCS JSON API endpoint override  |
| new setting | `AQUA_JOB_LOG` | structured [JOB] lifecycle lines  |
| new setting | `AQUA_OBJECT_STORE` | backend for artifact binaries when artifacts are on partitions: pg  |
| new setting | `AQUA_PARTITION_STORE_OWNERS` | stores bound to owner partitions in on/only mode  |
| new setting | `AQUA_PARTITION_CACHE_BYTES` | owner-partitioned store cache bound in bytes per process  |
| new setting | `AQUA_HYBRID_MAX_TOKENS` | AQUA_HYBRID_CONTEXT block budget in estimated tokens  |
| new setting | `AQUA_HYBRID_MAX_MS` | AQUA_HYBRID_CONTEXT time budget: the engine aborts past it and a slower result is discarde |
| new setting | `AQUA_HYBRID_MAX_SENTENCES` | AQUA_HYBRID_CONTEXT work budget: the engine reads at most this many of the most recent use |
