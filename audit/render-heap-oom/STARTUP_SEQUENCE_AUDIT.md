# Startup sequence audit

## 1. Actual order (`npm start` = `node index.js`)

```
index.js module evaluation
 ├─ require(...)  platform code, models, passport, routes
 ├─ import("./aqua/router.js")  ← started HERE, not awaited
 │    └─ static imports → … → core/dataDir.js
 │         └─ top-level await hydrateFromMongo(DATA_DIR)
 │              connect (own mongoose connection) → canary (writer) → lease → LIST → restore
 │    └─ every store module: readFileSync + JSON.parse of its file
 │    └─ router.js body: telemetry, metrics publisher, migrateLegacyMemory(), migrateIdentity(),
 │       runStartupValidation(), propagation sweeper (off by default), storage + flag boot lines
 │    └─ .then(): mount at /api/aqua + /v1
 └─ startServer()
      connectDB() → runStartupChecks() (env, Razorpay, payment indexes) → importTools()
      → server.listen()   ← "🚀 Aqua AI running on port"
```

The two branches run concurrently. Measured in the Render-like container (local Mongo):

| Event | Node 22 | Node 20 |
|---|---|---|
| `MongoDB connected` | t ≈ 1.3–2.3 s | t ≈ 0.5 s |
| `🚀 running on port` (Render marks the service live) | t ≈ 1.4–2.4 s | t ≈ 1.1 s |
| mirror hydration done | t ≈ 3.8–5.4 s | t ≈ 3.9 s |
| `✅ AQUA engine mounted` | t ≈ 4.4–6.6 s | t ≈ 4.5 s |

**Old code on a large collection:** `running on port` at 1.7 s, then OOM during hydration, before the engine ever mounts. Over the Atlas network the download is slower, so the gap is longer. This matches the reported "OOM 19–27 s after successful startup".

## 2. Answers to the brief's questions

| # | Question | Finding |
|---|---|---|
| 1 | Is router initialization pending when the server listens? | **Yes**, in every measured run. |
| 2 | Does the router import wait for hydration? | Yes: ESM top-level await in `dataDir.js`; every store importer waits. |
| 3 | Expensive synchronous work at module init? | Store loads (`readFileSync` + `JSON.parse`, up to ~84 MB transient for a 22 MB store on Node 22) and `migrateIdentity` (O(minds), first boot only, flag-guarded). |
| 4 | Does Render report live before the engine is ready? | **Yes.** It considers the port. `/health` is unconditional 200. `/ready` *does* report `engine:false` until mount. |
| 5 | Are init failures hidden? | No: the `.catch` logs `❌ AQUA engine failed to mount` and installs a 503 handler. But **before** mount or failure, an engine request was metered by `usageGuard` and then fell through to the platform's **HTML 404**. |

## 3. Change made

`utils/engineGate.js`, registered **first** inside the engine router (`index.js`: after the login/limiter chain, before the event tap and `usageGuard`):

- **starting:** `503`, `Retry-After: 5`, `{ code: "ENGINE_STARTING" }`; nothing metered.
- **mounted:** pass through, unchanged.
- **failed:** `503 "AQUA engine unavailable"`, the existing response.

Not changed, deliberately:

- `listen()` still happens early. Login, payments and webhooks don't depend on the engine and must stay available even if it fails to mount.
- `/health` is unchanged (liveness). `/ready` already gives an accurate readiness signal.
- The `✅ AQUA engine mounted …` line is unchanged (`e11ApiSurface.test.js` pins it). A separate `[MEM] engine mounted — heap … MB, rss … MB` line follows it.

**Recommendation (infrastructure, not done):** set the Render service's *Health Check Path* to `/ready`, so a deploy only receives traffic once Mongo is connected and the engine is mounted.

## 4. Background operations inventory

| Operation | Where started | Before ready? | Duplicate-start guard | Retains large data? | On every restart |
|---|---|---|---|---|---|
| Mirror heartbeat / lease (30 s) | `connect()` (single-flight) | yes (by design: lease before first write) | `startHeartbeat` checks its timer; `connect` is single-flight. **Live test: 3 hydrations → 1 connection** | no | one `findOne` + one `updateOne` |
| Mirror write queue | `atomicStore` flush → `mirrorWrite` | — | per-file coalescing + `inflight` map | ≤ 2 serialized copies per store (pending + in flight) | — |
| Propagation sweeper | `router.js` | first pass 5 s after boot | `if (sweeper) return` | no | **off by default** (`AQUA_PROPAGATION`) |
| Metrics publisher (15 s) | `router.js` | yes | module evaluated once | no | no-op without `DATABASE_URL` |
| Durable job worker runtime | `scripts/worker.mjs` only | n/a | n/a | — | **not in the Render web process** |
| Reflection / post-turn learning / outbox | per turn, or worker jobs | no | job leases | — | — |
| `migrateLegacyMemory` | `router.js` | yes | returns if legacy file absent | one-off | no-op after first run |
| `migrateIdentity` | `router.js` | yes | per-mind `_identityMigrated` flag | no | scans minds; skips flagged ones |
| Storage / partition config, DB schema check | `router.js` | yes | — | no | boot lines only; schema check not awaited |

No operation was found that starts twice, runs without completing, or holds large results. Steady-state heap stayed flat (±1 MB) for 40–75 s after mount in every run.
