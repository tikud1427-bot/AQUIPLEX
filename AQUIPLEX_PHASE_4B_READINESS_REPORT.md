# AQUIPLEX — Phase 4B Readiness Report (after Phase 4A)

Date 2026-11-15.

**Phase 4B has not been started.**

- Nothing was deployed, provisioned (Cloud SQL, GCS) or enabled.
- No production data was read.

This report states what Phase 4A established, what Phase 4B must still do, and
what needs an explicit authorisation.

## 1. What Phase 4A established

| Claim | Evidence | Limits |
|-------|----------|--------|
| With every store on partitions, **no required user state depends on a post-response timer**: a request's own writes are durable before its response, or the request gets a retryable 503 | audit (persistence report §2); `phase4aPersistence` 9/9 with bite 9/9; the real-app boundary wrote 1–2 keys per turn before and 1 after the commit (Linux run 4) | single-process JSON mode unchanged (≤ 500 ms hard-crash window) |
| A chat turn is acknowledged only when its preparation state, messages, learning jobs and commit effects are durable | chat boundary; Linux A1–A3; multi-instance journey 34/34 | post-commit window of one round trip for effect writes (persistence report §6) |
| A turn interrupted mid-transaction leaves **nothing** | Linux A4: 0 messages, 0 jobs | — |
| No accepted learning job is lost across an API shutdown | Linux A6: every job of every acknowledged turn ran to done | — |
| A failed request's credit is refunded **before** the error reaches the client | Linux A5; refund/wallet tests 41/41 | **not** when the process dies (§3, item 1) |
| SIGTERM → exit within ~9.5 s, also when a drain is stuck | Linux A4: 9.5 s (was 13 s) | platform grace not tested on the platform itself |
| Conversation history can be inventoried, migrated, verified and rolled back without loss | migration report; 7/7 on a fresh database, including a mirror-only conversation, a local-recovery copy, deleted-account exclusion and an idempotent re-run | production never read; sizes unknown |
| Artifacts can be audited and planned for an object store | artifact audit; 3/3 | GCS not implemented |

## 2. Cloud Run CPU allocation (updated from the Phase 4 readiness report)

The Phase 4 readiness report's first blocker is **resolved**: the turn path, and
every mutating AQUA request, now awaits its own writes.

What still runs after a response in the API:
- per-instance statistics sync (`instanceAggregate`: routing and cost
  heuristics);
- PIC background consolidation (3 s debounce, idempotent maintenance);
- telemetry and metrics publishers;
- effects that exceed their 3 s wait (counted).

**None of these is required user state.**

**Assessment.** Request-based CPU allocation for the API is now *plausible*:
throttling would delay only statistics and maintenance. It must still be
**validated on Cloud Run under load (Phase 6)** before it is relied on. Workers
always need CPU allocated.

## 3. What Phase 4B must do

| # | Item | Why | Size |
|---|------|-----|------|
| 1 | **Pending-charge reconciliation.** The deduction records the request id as *pending*; the turn commit marks it *settled*; a scheduled job refunds pending charges older than N minutes that have no committed turn. | A hard exit after the deduction loses the user's credit (Linux A4: 480 → 475 for a turn that does not exist) | medium; credits code + one job kind + tests |
| 2 | **GCS object-store backend** (`put` with `ifGenerationMatch=0` + sha256 compare, `get`, a **streaming** get, `deletePrefix`) against the contract the Postgres backend passes | artifacts on multiple instances | medium |
| 3 | `ensureArtifactFiles` must fetch **classic** `v<N>` versions from the object store, and stream instead of materialising on local disk | existing artifacts would be unreadable on other instances; Cloud Run's local disk is RAM | small |
| 4 | Export existing artifact index and manifests into `a:<id>` partition rows | existing artifacts must exist in the partitioned store | small–medium |
| 5 | Platform uploads (`public/uploads`: tool logos, `Aquiplex.apk`) to shared storage | local disk | small |
| 6 | **Production inventory, operator run.** Produce the counts this phase could not: history inventory across file, mirror and conflict copies; artifact audit on a copy. Decide which source is authoritative. | the migration plan depends on them | operator time; **needs authorisation** to export production data |
| 7 | Streaming split for very large history files (the split holds the whole store text in memory) | only if the inventory shows a large file | small |
| 8 | Cloud SQL provisioning, connection-pool sizing, migrations 0026–0030 on it | target database | **needs authorisation** |
| 9 | Load test (Phase 6) of the gate and commit under concurrency on Cloud SQL | latency and pool numbers are local-only today | — |
| 10 | Open items: Linux run-1 A6 failure (not reproduced, cause unknown); artifact `assertOwner` should fail closed without a user | — | small |

## 4. Test status at the end of Phase 4A

**AQUA battery** (`npm test` in `aqua/`, with the test database mapped):
- 5803 tests: **5767 pass, 12 fail**, 17 skipped, 7 todo. None of the failures
  comes from Phase 4A.
- 9 failures are `eval/tests/answerRunner` and `evalProviderIntegration`. Their
  CLIs refuse whenever `DATABASE_URL` is set, which the battery's test-database
  mapping does.
  - On 2026-11-14 the same 9 passed 47/47 when run without the database.
  - They were not rerun this phase.
- 2 failures are `temporalState.live`, which is date-dependent and known.
- 1 failure is `repoHygiene` (eval/out before-profile files), known.

**Platform battery** (`tests/**/*.test.js`, test Mongo): 387 tests, **384 pass,
3 fail**. None comes from Phase 4A:
- 2 in `accountSecurity.live` (signup page). `views/signup.ejs` uses
  `FREE_DAILY_CREDITS`, introduced by the last commit `839ea0d1 allowance
  update`. `index.js` sets it on `app.locals`; the test's own minimal app does
  not. So they fail at HEAD.
- 1 in `repoHygiene` (root `.patch` files), known.

**Phase 4A suites:**
- persistence 9/9, bite 9/9;
- history migration 7/7;
- artifact audit 3/3;
- Linux API shutdown 24/24;
- Linux worker shutdown 22/22;
- multi-instance journey 34/34;
- wallet/refund 41/41.

## 5. Requires authorisation before Phase 4B can proceed past code

- Reading or exporting production data: history file, `aqua_kv` mirror,
  artifacts directory, user ids.
- Creating Cloud SQL or a GCS bucket.
- Any deployment, flag or environment change on Render or Cloud Run.

Nothing in this report was started.
