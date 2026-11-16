# AQUIPLEX — API Shutdown Test Report (Phase 4A, Linux)

**Result: 23/23 in runs 2 and 3, and 24/24 in run 4.** Run 4 added a check of
the request write boundary. The first run (20/23) found one real defect and one
real gap, plus one failure whose cause was not determined (see "What the first
run found"). Date 2026-11-15.

## Environment

| | |
|---|---|
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 (Docker Desktop VM), Debian bookworm container |
| Node | v24.22.3 (`node:24-bookworm`) |
| Code | The working tree (uncommitted), copied into the container without `.env`, `.git` or `node_modules`; dependencies installed with `npm ci` in a cached volume |
| Services | Disposable Postgres (`aqua_test`) and Mongo (`aqua_phase4a_linux`) on the host |
| Signals | Real `SIGTERM` sent to the API process (`scripts/start-api.mjs`) |
| Model | A **local fake OpenAI-compatible server** inside the test process. `NVIDIA_BASE_URL` points at it with a fake key, and `AQUA_PROVIDER_PREFER=nvidia`. The test decides when a model call returns, so a request is provably in flight at SIGTERM. No real provider was called. |
| App | The real Express app: real signup and e-mail verification (`MAIL_TRANSPORT=log`), session, usage guard (credits deducted on entry), the full chat pipeline, the durable turn commit. All stores on partitions, `AQUA_POST_TURN_DURABLE=on`. |

Harness: `aqua/scripts/phase4a-linux-api-shutdown.mjs`. It refuses to run on
anything but Linux.

## Results (runs 2 and 3, identical outcomes)

| # | Scenario | Checks | Result |
|---|----------|--------|--------|
| A1 | **Active chat request**: SIGTERM while `/chat` waits on the model (held 2.5 s) | New connections refused after SIGTERM. The in-flight request answered **200**. Its turn is committed **with its learning jobs** (mind, observe). The API exited after it (2.6 s). Charged once (495 → 490; a chat costs 5 credits). | 5/5 |
| A2 | **Streaming response**: SIGTERM mid-stream (tokens every 400 ms) | The stream finished with `done`, not cut. Turn and jobs committed. Exit after it (2.0 s). | 3/3 |
| A3 | **Database transaction in progress, finishing in time**: the turn's commit is blocked on the conversation row (a lock the test holds), SIGTERM, lock released 1.5 s later | The transaction was observed waiting in `pg_stat_activity`. The turn completed and was acknowledged; messages and jobs (mind, observe, reflect) committed together. Exit after it (1.6 s). | 4/4 |
| A4 | **Database transaction that cannot finish before the deadline**: lock held past the API's 7 s drain | The API exited at its deadline, mid-transaction (**9.5 s**, inside a 10 s grace). The client saw a socket error, **never a success**. **Nothing of the turn remains: 0 message rows, 0 jobs** (Postgres rolled back the transaction of the dead connection). | 3/3 + the credit observation below |
| A5 | **Credit operation**: a request whose model calls fail is refunding while the API shuts down | The client received an error response (503, not a reset). **Its credit was back** (475 → 475) **before the API exited.** The REFUND ledger row exists. | 3/3 |
| A6 | **Durable job creation, nothing lost**: afterwards a worker drains the queue | No job queued, running or dead remains. **Every job of every acknowledged turn** (A1, A2, A3) ran to `done`. Run 4 also checks the **request write boundary** in the real app: each turn's pre-commit flush wrote 1–2 of the turn's own partition keys and the post-commit flush 1 (`[[2,1],[1,1],[1,1],[1,1]]`), taking 0–7 ms (60 ms in A3, blocked behind the test's lock). | 2/2 (3/3 in run 4) |
| setup | API ready; real signup; a first turn through the fake model | | 2/2 |

## What the first run found

### 1. Shutdown took 13 s (defect, fixed)

In run 1, A4's API exited at **13.0 s**:
- the in-flight wait (8 s);
- then the store drains, each with its own 5 s timeout, where the history flush
  was stuck behind the same locked row.

That is past a 10 s platform grace period, so the platform would SIGKILL first.

**Fix** (`core/atomicStore.js`): with shutdown blockers registered (the split
runtime), the drains get only **what is left of one budget**,
`AQUA_SHUTDOWN_BUDGET_MS` (default 9500 ms, at least 1 s each). The API's
in-flight wait default dropped from 8 s to **7 s**. Without blockers (today's
single process) nothing changed.

Runs 2 and 3: **9.5 s**. The Phase 3 Linux worker suite was re-run after this
change: 22/22.

### 2. Credit lost when the process dies mid-turn (gap, not fixed: Phase 4B)

In A4 the turn correctly **vanished**, but its credit had been **deducted on
entry** (480 → 475) and the process died before it could refund. The user paid
for a turn that does not exist.

The same applies to any hard exit after the deduction: OOM, SIGKILL, a node
lost. This is not specific to shutdown.

A fix needs the deduction to carry the request id and a "pending" state that a
reconciler refunds when no committed turn has that request id. That is a
design for Phase 4B (see the 4B readiness report). Graceful paths (A1–A3, A5)
are correct.

### 3. A6 failed once (cause not determined)

Run 1's worker left all jobs queued for its 120 s window. The harness did not
capture worker output then. It does now, but the failure did **not reproduce** in
runs 2 and 3, which used the same code except the shutdown budget.

The cause is unknown. One candidate is a worker started while run 1's A4
transaction was still being cleaned up, but that is not proven. It is listed as
an open item rather than dismissed.

## Not tested

- Cloud Run or Render; any load balancer's draining behaviour.
- A real provider. The fake model returns well-formed responses; provider
  failure paths were exercised only as HTTP 500s (A5).
- Concurrent turns in flight at SIGTERM (one at a time here; concurrency was
  covered by the Windows multi-instance journey).
- SIGTERM while the **database is down** (then the drains fail and the budget
  ends the process).
- Uploads and artifact routes in flight at SIGTERM. They use the same response
  gate; not exercised here.

## Raw evidence

Scratchpad:
- `linux4a-out-run1/` (20/23)
- `linux4a-out-run2/` (23/23)
- `linux4a-out-run3b/` (run 3, 23/23)
- `linux4a-out/api-shutdown.{log,json}` (run 4, 24/24)
