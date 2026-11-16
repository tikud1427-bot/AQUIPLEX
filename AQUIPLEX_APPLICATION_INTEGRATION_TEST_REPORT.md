# AQUIPLEX — Application Integration Test Report (Phase 2c, step 4)

**Date:** 2026-11-14 · **Harness:** `aqua/scripts/phase2c-app-journey.mjs` · **Production:** untouched.

The storage suites prove each store's semantics in isolation. This report covers the **real application**, run as the split runtime with **every store on owner partitions**.

## 1. Setup

| | |
|---|---|
| Processes | **2 API instances** (`scripts/start-api.mjs`, ports 5071/5072) + **2 workers** (`scripts/start-worker.mjs`). Each has its **own empty data directory**, so separate hosts in effect. A third worker and a replacement API are started mid-run. |
| Shared state | only the disposable Postgres 16 (`aqua_test`, :55432) and disposable Mongo (`aqua_phase2c`, :57017) |
| Flags | `AQUA_STORE_PARTITIONS` = all 18 stores `on`; `AQUA_STORE_PG=off`; Mongo mirror disabled; `AQUA_SCHEDULER_LEASE_MS=5000` |
| Safety | `--db`/`--mongo` must be local; `NODE_ENV=development` + `MAIL_TRANSPORT=log` (the verification link is read from the API log; **no email sent**); the `.env` database and Mongo URLs are overridden explicitly |
| Providers | **real** (keys from the platform `.env`): chat answers and the workers' extraction are real model calls (free tier) |
| Client | one cookie jar used against **both** instances (a session created on A is used on B) |
| Verification | every check reads **persisted rows** (`aqua_store_partitions`, `aqua_jobs`, `aqua_claims`, Mongo `users`) or what the *other* instance serves |

## 2. Results

**Final run: 29/29 checks passed.** An earlier run (before two harness fixes, below) also passed every check it reached.

| Requested workflow | Scenario | Checks (all PASS) |
|---|---|---|
| User signup and login | S1 | signup accepted, link logged not sent; account created by verification; **the session made on A is valid on B** |
| Conversation creation | S2 | conversation header + **one row per message**, owned by `user:<id>` |
| Concurrent message insertion | S3 | the same conversation written on A and B at once: **6/6 messages, none duplicated, none rewritten (all version 1)**; A and B show the same 6 |
| Memory extraction and recall | S4 | extraction by the workers (9 canonical claims, Mind row); **asked on B, answered from what was said on A**: "You live in **Lisbon**, and you work at **Acme Robotics**."; 0 dead jobs |
| Mind updates | S5 | a fact forgotten through A is gone from the **persisted** Mind, and B no longer lists it |
| Reflection generation · reasoning graph · identity | S6/S7 | after upload + turns: one live row each for reflection, reasoning graph, identity map, evidence, uko, pic, attachments (informational: rows exist; content asserted by the store suites) |
| File upload | S7 | upload accepted; the attachment row belongs to the **user**, not the conversation id |
| Worker restart | S9 | both workers killed; a fresh worker drains everything they left; 0 dead jobs |
| Interrupted jobs | S11 | workers killed while a job was **genuinely running** (`running at kill = 1`); the job was **reclaimed and completed** |
| Server restart | S10 | API A replaced by a new process with an **empty disk**: it serves the full conversation (14 messages) and answers "who is my manager" from memory |
| Message deletion (conversation) | S8 | deleted on B: header **and every message row** tombstoned; the recovery snapshot kept as the user's trash row; A returns **404** |
| Account deletion | S13 | `POST /api/account/delete` (re-authenticated): **no live partition row of the user remains in any store** |
| Concurrent server and worker writes | throughout | the workers wrote the Mind (claim reflection, 13 jobs) and the canonical model while both APIs served turns that wrote the same owner's stores. Every later read (S4, S5, S10) saw both. The deterministic two-process versions are in the store suites ([Phase 2c report](AQUIPLEX_PHASE_2C_REPORT.md) §4). |

Work the workers did in the final run: `understanding.turn.v1` ×6, `understanding.document.v1` ×1, `claim.embedding.v1` ×13, `claim.reflection.v1` ×13, all completed. `proactive.evaluate.v1` (scheduler-owned scans over every owner in the shared test database) also completed.

## 3. Defects found by this testing, and fixed

| Found | Fix |
|---|---|
| **Scheduler ownership flapped between workers.** The lease was renewed only between jobs, so an extraction job longer than the TTL let it lapse (log: `w1 no longer owns` right after a 7 s `understanding.turn.v1`) | renewal moved to an independent timer; each scheduler also re-checks ownership when it runs (`aqua/scripts/worker.mjs`). Re-verified by the final run (§4) |
| Harness: a process ended by a signal has `exitCode` null, so cleanup waited forever | the harness checks `signalCode` too |
| Harness: the first runs never caught a job mid-run, so S11 was not exercised | the harness waits for a `running` job before killing; S11 now asserts the interruption happened |

## 4. Final run after the lease fix

**29/29 checks passed** (logs kept locally in the run's temporary log directory).
- **Scheduler ownership:** `w1` owned the schedulers from boot and **never lost them** through long extraction jobs. `w3` took over only after `w1` and `w2` were killed (S9), as designed.
- **S11:** a job genuinely running at the kill was reclaimed and completed.
- **Recall on B:** "You live in **Lisbon**, and you work at **Acme Robotics** (as a product designer)."
- **Worker jobs:** `understanding.turn.v1` ×5, `understanding.document.v1` ×1, `claim.embedding.v1` ×10, `claim.reflection.v1` ×10, `proactive.evaluate.v1` ×2, all completed. None dead.

## 5. Not covered here, and why

| Item | Status |
|---|---|
| Editing one message over HTTP | **no route exists** in the product. `editMessage`/`deleteMessage` are tested at the store level with real processes (explicit conflicts, tombstones) |
| Graceful SIGTERM of the split roles | **unverified**: Windows kills are TerminateProcess (readiness report §4) |
| Artifacts end-to-end over HTTP | store-level, two processes (cross-instance file serving, distinct concurrent versions, deletion of objects); not driven through the chat artifact flow here |
| Load (many users) | **not run.** This journey is one user, functional. No capacity is claimed |
| Linux, Cloud SQL, network latency | **unverified** |
