# Render heap OOM — root cause

**Date:** 2026-11-24 · **Deployed commit investigated:** `48025adb` (= `412543d2` + a founders-page edit; `mongoMirror.js`, `dataDir.js` and `index.js` are byte-identical to local `HEAD`) · **Status:** repaired locally, not committed, not deployed.

## Summary

At every boot, the AQUA engine restores its JSON stores from the MongoDB mirror (`aqua_kv`). The hydration called `col.find({}).toArray()`, which loads **the whole collection, store bodies included**, into the V8 heap at once:

- every live store,
- every chunk part of **every generation**, including superseded ones,
- every preserved conflict copy.

It then joined each chunked store into one more string. On the Node versions Render runs (20/22), these decoded strings live **on the V8 heap**. Any character above U+00FF (em dash, emoji, Devanagari) makes the whole string **2 bytes per character**. Peak heap was about **3.4× the collection's data size**. A 512 MB Render instance has a **259 MB** V8 heap.

The collection grows without bound because of a second defect. Once any chunked store has a preserved conflict copy, `writeOne` stops deleting that store's superseded chunk parts **forever**: the guard at `mongoMirror.js` "never GC while a chunked conflict copy exists" applies to the whole file, and conflict copies are pruned to the newest 3, never to zero. Every later flush of a >10 MB store (`.aqua-index.json`, `.aqua-vectors.json`, …) then leaves a full extra set of parts behind, and each boot loads all of them.

The HTTP server starts listening **before** this hydration finishes (`import("./aqua/router.js")` runs in parallel with `connectDB()` → `listen()`). So the log shows a healthy start (`🚀 Aqua AI running on port`), and the process dies seconds later, mid-download. This is the reported pattern: "crashes ~19–27 s after the application reports successful startup", repeating on every restart because the collection doesn't change.

## Evidence

| Claim | Evidence |
|---|---|
| Production heap limit is 259 MB | `node:20-slim` and `node:22-slim` in a `--memory=512m` container report `heap_size_limit = 259 MB`, matching the logged "~251–257 MB before final GC" (MEMORY_PROFILE.md §1). |
| Decoded strings are on-heap at 2 B/char on Render's Node | Node 20/22: a 5 M-char UTF-8 decode containing `—` costs **10 MB of heap**; the `join` adds 20 MB more. Node 24 (the dev laptop) makes the same strings *external*, which is why no local run ever hit this (MEMORY_PROFILE.md §1). |
| Old hydration alone exhausts the heap | Real `hydrateFromMongo` from `48025adb`, Node 22, 512 MB, synthetic collection: 70 MB → **235 MB peak**; 140 / 188 / 279 MB → **`FATAL ERROR: Reached heap limit`**, with the same `Mark-Compact (reduce) 251.9 → 251.6 MB` trace as production (MONGO_HYDRATION_AUDIT.md §3). |
| Full app crashes *after* "running on port" | Full `node index.js`, Node 20 and 22, 512 MB container, fixture Mongo: `🚀 running on port` at t≈1.7 s, **OOM ~3 s later** (local Mongo; over the Atlas network the download, and so the delay, is longer) (STARTUP_SEQUENCE_AUDIT.md §2). |
| The repair removes it | Same fixtures up to 516 MB: hydration peak heap **26 MB flat**; full app peaks at 177 MB (Node 22) / 127 MB (Node 20) and settles at 130 / 125 MB, across repeated fresh-disk boots (MEMORY_PROFILE.md §3). |
| Orphaned-part growth exists | Code path read and reproduced in the fixture. `aqua/scripts/mirror-census.mjs` counts orphaned parts per store. |

## What was **not** proven

- **Production's actual `aqua_kv` size.** By the operating rules, production MongoDB was not touched. The mechanism, the reproduction of the exact failure signature, and the one-way growth defect make this cause highly likely. The remaining confirmation is one run of the **read-only** census against production:
  `MONGO_URI=… node aqua/scripts/mirror-census.mjs`.
  It prints collection size, orphaned/conflict bytes and the estimated boot heap.
- **Why it started on 2026-11-23** in particular. Consistent with the collection crossing the threshold as orphaned generations and conflict copies accumulated. Not independently verified.
- **The 19–27 s delay.** It is consistent with downloading a few hundred MB from Atlas, but the network time was not measured.

## Ruled out (with evidence)

- **Render/MongoDB connectivity:** connect, canary and lease succeed before the crash in both production and the reproduction.
- **Chat traffic:** the reproduction crashes with zero requests.
- **Background schedulers:** heartbeat, propagation sweeper, metrics publisher and worker runtime each start at most once. The sweeper is off by default, the metrics publisher is a no-op without Postgres, and the worker runtime doesn't run in the web process (STARTUP_SEQUENCE_AUDIT.md §4).
- **Startup migrations:** `migrateIdentity` and `migrateLegacyMemory` are idempotent and flag-guarded.

## Second contributor (remains after the repair)

**Store loading.** After hydration, each store module reads its whole file and runs `JSON.parse` on it. Measured: full app peak ≈ `70 MB + 2.3 × (total live store MB)`, steady ≈ `70 + 1.3 ×`. With the dev-shaped 47 MB store set, that is 177 MB peak / 130 MB steady, inside the limit. It would reach 259 MB at roughly **80 MB of live store JSON**, independently of the mirror. The census prints this estimate. See CHANGES.md "Remaining risks".
