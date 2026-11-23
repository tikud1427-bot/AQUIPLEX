# Changes

All changes are **local and uncommitted**. Nothing was deployed or pushed, and no environment variable, database or Render setting was touched. None of the files below had uncommitted edits before this work, so no existing work was overwritten.

## Modified

| File | Change |
|---|---|
| `aqua/src/core/mongoMirror.js` (+168 / −39) | **Bounded hydration.** `listMirrorMeta` (one listing: no chunk parts, no bodies) + `streamChunksTo` (one part in memory, appended to the temp file, surrogate-safe) + a per-file loop that fetches one body at a time and follows a generation superseded mid-hydration (≤ 3 attempts). All decisions (`knownGen`, lineage marker, newer-wins, unknown-lineage preservation, incomplete-chunk blocking, temp + rename, per-file `recordLineage`, unverified on failure) are unchanged, in the same order. Stale `.<file>.hydrate.<pid>` temp files from killed hydrations are removed. The hydration log line now carries docs listed / parts streamed / MB written / ms / heap before→after. **Metadata-only reads:** `reconcileAfterOutage`, `prunePreserved` and the chunked-write GC check no longer load conflict bodies or chunk parts. **`chunkSlices()`:** chunk writers (`writeOne`, `preserveLocal`) never end a part between the halves of a surrogate pair (a pre-existing emoji corruption, reproduced on real MongoDB). |
| `index.js` (+10) | Registers `utils/engineGate.js` first in the engine router; flips it to *mounted* / *failed* in the existing `import("./aqua/router.js")` handlers. Adds one `[MEM] engine mounted — heap … rss …` log line. |

## Added

| File | Purpose |
|---|---|
| `utils/engineGate.js` | 503 + `Retry-After` while the engine is starting (instead of metering a request that then hit the HTML 404); 503 "unavailable" if it failed. |
| `aqua/src/core/tests/mongoMirrorBoundedHydration.test.js` | 17 regression tests on a filter-, projection- and body-recording fake (TEST_RESULTS.md). |
| `aqua/src/core/tests/mongoMirrorHydration.mongo.live.test.js` | 3 tests against a real disposable local MongoDB; skipped unless `MIRROR_DISPOSABLE_MONGO_URI` (local host, `aqua_disposable_*`, empty DB). |
| `tests/platform/engineGate.test.js` | 4 tests: gate behaviour over real HTTP, plus wiring order in `index.js`. |
| `aqua/scripts/mirror-census.mjs` | **Read-only** census of `aqua_kv` (one metadata aggregation; bodies never requested; no writes, no canary). Prints sizes, orphaned and conflict bytes, and boot heap estimates. |
| `audit/render-heap-oom/*.md` | These six reports. |

## Why the repair works

The failure was a **peak**, not a leak: one call held the entire collection as on-heap strings at up to 2 bytes/char, plus a joined copy of each chunked store. The repair changes only *how much is held at once*. The listing carries metadata, and the only bodies ever in memory are one store document or one chunk part (≤ 10 MB of UTF-8). Peak hydration heap became independent of collection size: 26 MB for 70, 279 and 516 MB collections, versus 235 MB / OOM before. The on-disk result is byte-identical (verified against real MongoDB, including multi-byte text and an emoji on a part boundary).

## Data-integrity guarantees, re-verified

| Guarantee | How |
|---|---|
| Never overwrite a valid remote generation with an incomplete/unverified local copy | Tests 6, 8, 11, 12 + existing `mongoMirrorStartup` suite (13/13). |
| Generation CAS | Test 2 (first write after hydration lands without a false conflict); existing concurrency suite. |
| Conflict preservation | Test 5 + live test 2: conflict copies and superseded parts are neither restored nor deleted. Hydration issues no deletes. |
| Chunk integrity | Tests 3, 3b, 3c, 4, 7, 8, 14 + live test 1 (byte-exact via real BSON). |
| Atomic replacement | Temp + `rename` only; tests 6, 8 and 12 assert no torn file and no leftover temp. |
| Local-newer vs remote-newer | Tests 9, 10, 13. |
| Writer lease, roles | Unchanged code; existing suites pass. |
| Auth, sessions, payments, webhooks, per-user isolation, forget/delete | Not touched; the gate sits *after* `requireLogin`. Platform suite 327/328 (the one failure is pre-existing, see TEST_RESULTS.md). |

**Compatibility.** The mirror document format is unchanged. Code before this change can hydrate what the new writer writes (part counts and lengths were never assumed), and the new code hydrates everything the old one wrote. Rolling back is a plain revert, with no data migration.

## Remaining risks

1. **Store loading is the next ceiling.** Full-app peak ≈ 70 + 2.3 × (live store MB). That reaches 259 MB near **80 MB of live store JSON**, whatever the mirror does. Dev-shaped data (47 MB) peaks at 177 MB on Node 22. **Production's figure is unknown until the census runs.** If it is near or above ~70 MB, this repair alone will not keep the instance up. The structural fix is the already-built per-owner partitioning (`AQUA_STORE_PARTITIONS`, currently off), which avoids loading every user's data at boot.
2. **Orphaned chunk parts keep accumulating in MongoDB** (MONGO_HYDRATION_AUDIT.md §3). They no longer affect memory, but they consume the Atlas free-tier storage quota (512 MB), shared with users, sessions and payments. If the quota is hit, writes fail cluster-wide. Proposed fix, **not implemented** (it deletes mirror data; needs your approval): in `writeOne`, replace the all-or-nothing guard with "delete parts of this file with `gen < current` whose `gen` is not referenced by any preserved conflict manifest". Run the census first to see the size.
3. **Write-path transients.** Each flush of a large store builds its full JSON string (2 B/char on Node 20/22), and the mirror queue holds it until upserted. A 22 MB store costs ~44 MB transiently per flush. With the measured 130 MB steady state there is headroom, but not unlimited.
4. **Unpinned Node version.** Behaviour differs sharply between Node 22 and 24 (string externalization). Pinning (`"engines": { "node": "22.x" }`) would make production reproducible locally. This changes the deploy, so it is left as a recommendation.
5. **Hydration latency.** One round trip per chunk part (17–23 parts in the fixtures; 2.3–3.8 s locally). Over Atlas, expect a few seconds more than before. The engine gate covers that window.
6. Characters already corrupted by the old chunk writer (an emoji that sat on a part boundary) stay corrupted. The fix prevents new ones.

## Deployment recommendation

1. Run the census against production (read-only): `MONGO_URI=<prod> node aqua/scripts/mirror-census.mjs`. You run it, or authorise me to.
2. If **store loading peak** is comfortably under 259 MB (say < 220 MB): commit and deploy this change as is. After deploy, check the boot log for the new `[MIRROR] hydration: … [N doc(s) listed, P part(s) streamed, … heap a→b MB]` line, `[MEM] engine mounted — heap …`, and no OOM over the next minutes.
3. If it is not: deploy this change anyway (hydration was the crash trigger and it is necessary in every case), and plan partitioned stores before traffic grows.
4. Decide separately on the orphaned-part GC (risk 2) once the census shows how much storage it holds.
5. Optional: set the Render health check path to `/ready`.
