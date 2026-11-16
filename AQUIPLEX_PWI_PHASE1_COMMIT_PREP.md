# AQUIPLEX — PWI Phase 1: Commit Preparation, Render Configuration, Owner-Log Audit

**Date:** 2026-11-15. **Status:** the commit is staged and **not committed**. Nothing is pushed or deployed.

## 1. Working tree

- **Base:** `main` @ `839ea0d1`.
- **Before staging:** the index was empty.
- **Working tree:** 413 changed paths with untracked directories expanded: 77 modified, 336 untracked.

Almost all of it is earlier, never-committed work: Sprints 1–6, scalability Phases 2–4B, the evaluation key pool, ACIB v1–v3, and 86 root-level reports.

**Generated or local outputs (never to be committed with code):**

- `aqua/eval/acib/results/` (62 run outputs).
- `aqua/eval/out/*.before-profile*`: flagged by the `repoHygiene` test.
- `release/` (capture-integrity package).

No `.env`, `.aqua-*` user data, logs or archives are in the changed set.

## 2. Separating Phase 1

Phase 1 was written on top of that uncommitted work. Checked against `HEAD`, each fix's dependencies are as follows:

| Fix | Depends on | Can be committed on `HEAD` alone? |
|---|---|---|
| 2 — veto fallback | `brain/index.js`, `recallRedactions.redactionsFor`, `db/pool._setPoolForTests` (all at HEAD); `core/logSafety.js` (**untracked, Sprint 1**) for one log line | **Yes**, with the Phase 1 part of `logSafety.js` only |
| 3 — owner pseudonyms | `core/logSafety.js` (untracked) | **Yes**, same |
| 1 — Cloud Run pin | `deploy/cloudrun/*.yaml`, `cloudRunTemplates.test.js` — **both untracked Phase 4B files**; the lint test also needs Phase 3/4B flag registrations | **No** — it can only land together with Phase 4B |

**Method.** Every Phase 1 hunk was rebased onto `HEAD` text by a script:

- **Verbatim:** each segment was copied verbatim from the working tree.
- **Anchors:** every anchor had to match exactly once.

The result was tested in a clean `HEAD` worktree. The index was then written from those exact blobs (`git hash-object` + `update-index`). **The working tree was not touched.**

Two files carry CRLF in `HEAD`'s object store despite `.gitattributes eol=lf`, so modified files were hashed without filters. Otherwise every line would show as changed. New files are LF.

**What `HEAD`-based means for the staged versions:**

- **`logSafety.js` (new at HEAD):** only the header, the `crypto` import and `ownerLogId`. Sprint 1's functions (`textMeta` and the rest) stay in the working tree for the Sprint 1 commit.
- **`flagRegistry.test.js`:** the census pins move from `HEAD`'s numbers to +1 setting / +1 read (48→49, 89→90, boot line 48→49).
- **`chat.js`:** the `logSafety` import line is new at HEAD, and imports only `ownerLogId`.
- **`legacyVetoFallback.test.js`:** the partition fail-closed case is omitted, because it needs Phase 2b `core/storage`. It stays in the working tree.

**Correction during preparation.** My first staging attempt hashed working-tree files instead of the rebased ones: `git -C` resolved the relative paths. I caught it from the diff size (`flags.js` +228), unstaged exactly those 12 paths back to `HEAD`, and restaged from absolute paths. The final staged blobs were verified byte-for-byte against the tested worktree (CR-insensitive for new files): **12/12 match**.

## 3. Staging list (staged now)

| File | Kind | Content |
|---|---|---|
| `aqua/src/brain/index.js` | M | +`ownerLogId`/`redactionsFor` imports; `deletionVetoFor`, `fallbackVetoFor`, snapshot map, `canonicalVetoPredicate` (the old closure, unchanged logic); `legacyVetoFor` catch → fallback; `purgeOwner` drops the snapshot |
| `aqua/src/routes/chat.js` | M | `ownerLogId` import; 5 log lines; degraded-read deletion veto |
| `aqua/src/routes/intelligence.js` | M | degraded-read deletion veto |
| `aqua/src/memory/episodicRecall.js` | M | import; 2 `[RECALL]` lines |
| `aqua/src/pic/core.js` | M | import; 3 `[PIC]` lines |
| `aqua/src/core/flags.js` | M | +1 setting `AQUA_LOG_PSEUDONYM_KEY` |
| `aqua/src/core/tests/flagRegistry.test.js` | M | census pins +1 |
| `aqua/src/routes/tests/memoryDeliveryUnreachableDb.e2e.test.js` | M | the pinned fail-closed assertion → the new contract |
| `aqua/src/core/logSafety.js` | A | `ownerLogId` only |
| `aqua/scripts/owner-log-id.mjs` | A | support lookup |
| `aqua/src/brain/tests/legacyVetoFallback.test.js` | A | 13 failure-injection tests |
| `aqua/src/routes/tests/ownerLogPseudonym.test.js` | A | 9 tests (the domain-separation test was rewritten to be self-contained; the working tree has the same file) |

`git diff --cached --stat`: **12 files, +597 / −35.**

**Hunk review.** Every hunk was read. The modified files contain only the edits listed; `brain/index.js` has 7 hunk headers, all in the import block, the veto block and the purge line.

**Secret and personal-data scan.** I scanned the added lines for:

- provider-key shapes;
- non-local DB URLs;
- e-mail addresses;
- private keys and password literals.

**None found.** The only credential-shaped strings are test fixtures:

- `gsk_test_fake_key_for_owner_pseudonym_01`;
- a test pseudonym key;
- `postgresql://aqua:aqua@127.0.0.1:1/aqua_fake`, port 1, which refuses connections.

**Not staged (stay for later commits):** Fix 1 (both templates, `cloudRunTemplates.test.js` additions, `cloudRunMemoryLanes.test.js`) goes with Phase 4B. The working-tree-only test case goes with Phase 2b.

To view the staged change: `git diff --cached`. To unstage it: `git reset -q -- <the 12 paths>`. The index held nothing else.

## 4. Verification of the staged content (clean `HEAD` worktrees, live test DBs)

| Tree | Tests | Pass | Fail |
|---|---|---|---|
| `HEAD` | 5,094 | 5,067 | 2 |
| `HEAD` + staged Phase 1 | 5,116 (+22 new) | 5,089 | 2 |

**Failure comparison.** The same two failures on both: `temporalState.live` "S5 anchors relative dates…" and "the answer context says what is current…", which are date-dependent. **No new failures.** The focused Phase 1 suites pass on `HEAD` + Phase 1, and in the full working tree (118/118, earlier).

## 5. Proposed commit message

```
Memory: legacy veto falls back to deletions; owner ids pseudonymised in logs

A failed canonical veto query no longer withholds every legacy fact for the
turn. legacyVetoFor now serves a fallback: the owner's deletions, read from
the durable recall-redaction list, plus this process's last successful
canonical veto for the same owner when it is at most 10 minutes old (purged
with the account). The degraded read (Postgres configured but unreachable)
applies the same deletion veto; before, it applied none.

[RECALL], [PIC] and [SENSITIVE] lines print ownerLogId(owner) instead of the
raw owner id. With AQUA_LOG_PSEUDONYM_KEY (32 chars or more) the pseudonym is
o_<16 hex>, a keyed HMAC that is stable across processes and not reversible.
Without the key it is p_<16 hex>, a per-process pseudonym (warned once).
scripts/owner-log-id.mjs gives support the pseudonym for an owner.

Tests: brain/tests/legacyVetoFallback.test.js (statement timeout, connection
reset and schema-drift injection; deletions; forget-all; snapshot TTL; owner
isolation; purge; sensitive; end to end), routes/tests/ownerLogPseudonym.test.js
(format, cross-process stability, fallback, support script, source guard, a
real /chat/stream turn). memoryDeliveryUnreachableDb now asserts the new veto
contract. Flag census +1 setting.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Render: required configuration (nothing changed; dashboard not accessible from here)

**Facts found in the repo:**

- There is no `render.yaml`.
- The Render start command is not in the repo.
- Project docs (DEMO_RUNBOOK, the 2026-10-29 validation) record that production runs **without `DATABASE_URL`**, in the legacy read.
- `npm start` = `node index.js`, a single process. `start:production` (`aqua/scripts/start-production.mjs`) spawns the server and the worker with **`env: process.env`**, so they share one environment.

**Required when this commit is deployed:**

| Variable | Value | Why |
|---|---|---|
| `AQUA_LOG_PSEUDONYM_KEY` | a new random secret of 32 characters or more, e.g. `openssl rand -hex 32` | stable `o_…` pseudonyms; without it Render logs show `p_…` (still no raw ids, but per-process) |
| `AQUA_CANONICAL_READ` | `off` (recommended guard) | No effect today (no `DATABASE_URL` → legacy anyway). Prevents the audit C-1 regression if `DATABASE_URL` is ever added to Render |

**API/worker consistency.**

- **Today:** on Render, one service means one environment. Both processes get the same key automatically, whether the start command is `node index.js` (no worker) or `start:production` (worker inherits `process.env`).
- **If a separate Render worker service is created later:** put the key in a Render **Environment Group** linked to both services, which is free. Two different values would make the API's and the worker's pseudonyms for the same owner differ.
- **To verify after deploy:** run `node aqua/scripts/owner-log-id.mjs user:<a test account id>` with the same key. It must print the `o_…` value seen in that account's `[RECALL]` lines.

**Deploy risk to note:**

- If Render auto-deploys on push to `main`, **pushing this commit is a deploy.** Commit locally; push only when the deployment is approved.
- With no `DATABASE_URL` on Render, the veto changes are inert there: neither the authoritative nor the degraded read happens. The only visible change would be the log pseudonyms.

## 7. Remaining raw owner ids in `[MEMORY]` / `[BRAIN]` logs (audit only; not changed)

**23 lines** print a raw owner id under `[MEMORY]`, `[BRAIN]` or `[BRAIN_API]` (working tree):

| File | Lines |
|---|---|
| `memory/propagation.js` | 642, 730, 734, 752, 780, 846, 855, 856 |
| `memory/forget.js` | 33, 206, 210, 221, 222, 243 |
| `memory/engine.js` | 672 (`FILE_REMEMBERED`) |
| `memory/turnCommit.js` | 227 (`TURN_ROLLBACK`) |
| `routes/chat.js` | 600 (read-mode degraded) |
| `routes/brain.js` | 416 (`[BRAIN_API]` correction failed) |
| `brain/index.js` | 1015, 1060 (revision raised) |
| `brain/knowledgeExtraction/conversationIngest.js` | 435 |
| `brain/reflectionV2/index.js` | 161 |
| `brain/digitalTwin/index.js` | 71 |

**Not owner ids:** the structured `[MEMORY]` events (`core/observability.js logMemoryEvent`) carry a conversation id, not an owner id.

**Beyond these two tags:** 51 `owner=${…}` lines in total still print a raw id, including `[MEMEDIT]` ×7, `[ARTIFACT]` ×3, `[MIND]`, `[UUS]`, `[CLAIMS]`, `[WORKER]`, `[ACCOUNT]`, `[E6]` (`logE6Turn`). Converting them is the same mechanical change and the same source guard, extended to all tags. It needs authorization.
