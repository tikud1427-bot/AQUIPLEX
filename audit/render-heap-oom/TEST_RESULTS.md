# Test results (2026-11-24, local, Windows host + Linux containers)

## New tests

### `aqua/src/core/tests/mongoMirrorBoundedHydration.test.js`: 17/17 pass

Mutation check: the same file run against the **deployed** `mongoMirror.js` fails 9/17, so the tests detect the old behaviour. The tests that pass on both versions are the ones encoding preserved guarantees.

| # | Brief requirement | Test | On old code |
|---|---|---|---|
| 1 | Empty mirror | 1 | fail (old read the canary body) |
| 2 | Normal unchunked files | 2 (+ CAS base, no false conflict) | fail (bodies in the listing) |
| 3 | Large chunked files | 3, 3b (emoji on boundary, writer), 3c (legacy split parts, reader) | 3, 3b fail |
| 4 | Multiple chunked files | 4 | fail |
| 5 | Preserved conflict generations | 5 (not restored, not read, not deleted) | fail |
| 6 | Missing chunks | 6 | pass (guarantee kept) |
| 7 | Out-of-order chunks | 7 | pass |
| 8 | Corrupted manifests (too many parts, non-string part, gen with no parts, index gap, non-string body) | 8 | pass |
| 9 | Local newer than remote | 9 | pass |
| 10 | Remote newer than local | 10 | pass |
| 11 | MongoDB connection failure | 11 (+ existing real-socket test in `mongoMirrorStartup`) | pass |
| 12 | Interrupted hydration | 12 (connection lost mid-stream → unverified, no torn file; next boot cleans stale temps and completes) | fail |
| 13 | Repeated process startup | 13 (3 boots, same disk) + live test 3 | pass |
| 14 | Duplicate background-worker prevention | live test 3 (concurrent + repeated hydration → **one** connection, so one heartbeat) | — |
| 15 | Startup readiness sequencing | `tests/platform/engineGate.test.js` | — |
| — | Generation superseded during hydration | 14 | fail |
| — | Post-boot housekeeping reads no conflict bodies | 15 | fail |

### `aqua/src/core/tests/mongoMirrorHydration.mongo.live.test.js`: 3/3 pass (real MongoDB 7, `aqua_disposable_mirror`, dropped afterwards)

Write path → fresh boot: byte-exact restore of multi-byte stores with an emoji across a part boundary. Conflicts and orphaned parts are excluded by the real driver's filter and projection, not restored, not deleted. Concurrent/repeated hydration shares one connection. Without the env var, the file runs 0 tests.

### `tests/platform/engineGate.test.js`: 4/4 pass

Starting → 503 + `Retry-After`, nothing metered. Mounted → reaches the engine. Failed → 503 unavailable, never the HTML 404. Wiring order in `index.js`.

## Existing suites

| Suite | Result |
|---|---|
| `src/core/tests/mongoMirror*.test.js` (3 files) | 31 pass, 0 fail, 2 skipped (SIGTERM tests skip on Windows by design) |
| `node scripts/run-tests.mjs src/core` | 1151 tests: 1139 pass, **1 fail**, 11 skipped |
| `node scripts/run-tests.mjs src/memory src/routes` | 909 tests: 908 pass, 0 fail (includes `e11ApiSurface`, which pins the mount log line) |
| `node --test "tests/**/*.test.js"` (platform) | 328 tests: 327 pass, **1 fail** |

**Both failures are pre-existing and unrelated** (repo-hygiene checks on files this work did not create or touch):

- core `repoHygiene`: `aqua/eval/out/contexts.before-profile.{code-defaults,dev-env}.json`, dated 2026-11-02.
- platform `repoHygiene`: root `aqua-latex-fix.patch`, `aquiplex-stream-finalization-fix-20260929-portable.patch`, `gemini-3.6-flash-migration.patch`, dated 2026-09-29 to 2026-10-15.

## Constrained-memory runs (Render-like: 512 MB container, Node 20 and 22)

Full tables in MEMORY_PROFILE.md. Headline:

| | Old (deployed) | New |
|---|---|---|
| Hydration alone, 279 MB collection | **OOM** | 26.7 MB peak heap, 100 MB RSS |
| Hydration alone, 516 MB collection | — | 26.1 MB peak heap |
| Full app, dev-shaped 187 MB collection, Node 22 | **OOM** ~3 s after "running on port" | 177 MB peak, 130 MB steady |
| Full app, dev-shaped 342 MB collection, Node 20 | **OOM** | 127 MB peak, 125 MB steady |
| Repeated fresh-disk boots | — | identical (2 boots × 2 Node versions) |
| Memory after startup | — | flat ±1 MB for 40–75 s |
| Hydration duration (local Mongo) | 1.1–2.6 s | 2.3–3.8 s |
| Docs processed (342 MB collection) | 210 docs, all bodies | 74 listed (metadata), 17 parts + 16 bodies fetched |

## Not run

- No test against production MongoDB (by rule). The census was validated on the fixture only.
- No 24 h soak. Post-startup stability was observed for ≤ 75 s per run, without user traffic.
- SIGTERM drain tests (Windows host, skipped by design); the drain code is unchanged.
