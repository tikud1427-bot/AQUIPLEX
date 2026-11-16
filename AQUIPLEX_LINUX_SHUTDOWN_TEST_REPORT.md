# AQUIPLEX — Linux Graceful Shutdown Test Report (Phase 3)

**Result: 22/22 on Linux, after one real defect was found and fixed by this
test.** Date 2026-11-14.

## Environment

| | |
|---|---|
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 (Docker Desktop's Linux VM), Debian bookworm container |
| Node | v24.22.3 (`node:24-bookworm`) |
| Code | The working tree (uncommitted), copied into the container without `node_modules`, `.git` or `.env`; `npm ci` inside the container |
| Services | Disposable Postgres `aqua-test-db` (pgvector pg16) and Mongo `aqua-test-mongo`, reached via `host.docker.internal` |
| Signals | Real POSIX `SIGTERM` / `SIGKILL` sent by `child.kill()` from a Node parent in the same container |

**What this is not.** It is not Cloud Run and not Render. Docker Desktop's
Linux VM delivers signals the way any Linux kernel does, which is what these
tests need. The platforms' surrounding behaviour was not tested: the grace
period before SIGKILL, and load-balancer draining.

**No claims come from Windows.** On Windows a child "kill" is
TerminateProcess and no handler runs. The harness
(`aqua/scripts/phase3-linux-shutdown.mjs`) refuses to run on any platform other
than Linux.

## How to reproduce

```bash
# scratchpad/linux-run.sh: copies /src → /app (excluding node_modules/.git/.env), npm ci, runs the harness
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v aq-p3-linux-app:/app \
  -v "<repo>:/src:ro" -v "<out>:/out" -v "<linux-run.sh>:/run.sh:ro" \
  node:24-bookworm bash /run.sh
# inside: DATABASE_URL=postgresql://aqua:aqua@host.docker.internal:55432/aqua_test
#         MONGO_URI=mongodb://host.docker.internal:57017/aqua_phase3_linux
#         node aqua/scripts/phase3-linux-shutdown.mjs --out /out/linux-shutdown.json
```

Test settings:

- `AQUA_SCHEDULER_LEASE_MS=1500`, `AQUA_JOB_HEARTBEAT_STALE_MS=2000`,
  `AQUA_WORKER_SHUTDOWN_MS=3000`;
- worker `--reap 1000`, API `AQUA_API_SHUTDOWN_MS=8000`;
- the API gets placeholder `GOOGLE_CLIENT_*`, `RAZORPAY_*` and `SESSION_SECRET`
  values so it can boot without `.env`; no OAuth or payment flow is exercised.

Job rows are `ops.canary.v1`: `pg_sleep` inside the database, writes nothing.

## Results (run 3; run 4 identical in outcome)

| # | Scenario | Checks | Result |
|---|----------|--------|--------|
| T1 | SIGTERM while idle | took lease; exit 0 in 22 ms; lease **released** (row deleted, not left to expire); "shutdown clean" logged | 4/4 |
| T2 | SIGTERM while processing a job (1.5 s job) | the job in hand **finished** (`done`, attempts 1); exit 0 after it, 1509 ms | 3/3 |
| T3 | SIGTERM while renewing the lease (renewal blocked on a row lock held by the test, released 1 s after the signal) | renewal observed blocked in `pg_stat_activity`; exit 0 after the interrupted renewal; lease released | 3/3 |
| T4 | SIGTERM during a database operation past the deadline (20 s `pg_sleep`, deadline 3 s) | exit 0 at 3024 ms (not 20 s); job **released**: `queued`, attempts **0**, last_error "shutdown deadline" | 2/2 |
| T5 | Worker replacement after shutdown | replacement took the released lease in 319 ms; completed the released job | 2/2 |
| T6 | Restart and recovery of unfinished work (SIGKILL mid-job, no handler) | job stranded `running`; a new worker reclaimed it once the heartbeat was stale and completed it (10989 ms, attempts 2) | 3/3 |
| T7 | API shutdown while a request is active (headers sent, body still arriving over ~3 s) | API ready; new connections refused while draining; the request got a **complete HTTP response** (401 — unauthenticated by design); exit after it at 2823 ms (inside the 8 s bound); drain logged | 5/5 |

## The defect this test found

**Run 1: 7/22.** Every graceful worker scenario failed. The worker exited
**143 within 8–17 ms** of SIGTERM:

- the job in hand was left `running`;
- the scheduler lease was left to expire;
- the past-deadline job was not released.

**Cause.** The store layer's SIGTERM handler (`core/atomicStore.js`: flush
writers, drain, `process.exit(143)`) is installed in every process that has a
store writer, including the worker. With nothing to drain it exits at once,
pre-empting the worker's own graceful `shutdown()`.

**Consequence.** The "SIGTERM finishes the job in hand" behaviour that
`scripts/worker.mjs` documented since E4 had **never worked on Linux**. The
Windows test suite could not see this: its kills run no handlers.

**Fix** (`scripts/worker.mjs`). The worker registers its shutdown as a
**shutdown blocker** of the store handler (`registerShutdownBlocker`, added in
this phase for the API). The store handler now waits for the worker's graceful
shutdown, which exits 0 itself, bounded by `AQUA_WORKER_SHUTDOWN_MS` + 8 s. The
API uses the same mechanism to wait for in-flight requests.

**Run 2: 18/22.**

- All worker scenarios passed: T1–T6.
- T7 failed only because the API refused to boot without the Google OAuth
  and Razorpay environment variables (no `.env` in the container).
- **Fix:** placeholder values were added to the harness.

**Run 3: 22/22.**

**Run 4: 22/22.** Repeated after the per-owner claim fix (advisory lock,
see the ownership doc), which changed the worker's claim path. Timings were
within a few ms of run 3.

Raw outputs are kept in the scratchpad:

- run 1: `linux-out-run1/`
- run 2: `linux-out-run2/`
- run 3: `linux-out/linux-shutdown.{log,json}`

## Observations and limits

- **The server-side `pg_sleep` kept running after the worker exited** (T4).
  Postgres ends such a backend when it next notices the closed socket. A long
  database statement can therefore outlive its worker briefly. It holds no lock
  that blocks the requeued job; the canary takes none.
- **API exit code 143.** That is the store handler's conventional code after a
  clean drain. A platform treating non-zero exit as failure should be told that
  143 = SIGTERM handled.
- **T7 exercised HTTP draining, not a chat turn mid-commit.** A real chat needs
  provider keys inside the container. On Windows, the journey's L7 killed an API
  during a real chat: the turn was either fully committed with its jobs or not
  at all. That kill was a hard one, not a graceful drain.
- **Recovery time after SIGKILL** is heartbeat staleness + reap interval:
  - test settings: 2 s + 1 s → ~11 s observed;
  - production defaults: 120 s + 60 s → up to ~3 minutes.

  That window delays one user's learning (per-owner ordering). Other users are
  unaffected.
- **Not tested:**
  - SIGTERM on Cloud Run or Render;
  - SIGTERM while the database itself is down during shutdown (lease release and
    the final flush are best-effort and bounded);
  - more than one in-flight job per worker (the worker runs one at a time).
