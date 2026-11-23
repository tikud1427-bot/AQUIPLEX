# MongoDB mirror hydration audit

Code: `aqua/src/core/dataDir.js:78` (`await hydrateFromMongo(DATA_DIR)` as a top-level await, so every store module waits for it) → `aqua/src/core/mongoMirror.js` `hydrateFromMongo`.

## 1. What the deployed code did

```js
const docs = await col.find({}).toArray();   // the whole collection, bodies included
const parts = new Map();                     // every chunk part of every generation, kept until the loop ends
const mains = [];
...
json = set.map(p => p.json).join('');        // + one more full copy per chunked store
```

The `aqua_kv` collection holds:

| Document kind | `_id` | Body | Needed at boot? |
|---|---|---|---|
| live single-doc store | `.aqua-x.json` | `json` ≤ 10 MB | yes |
| live chunked manifest | `.aqua-x.json` | `json: null` | yes (metadata) |
| chunk part, live generation | `.aqua-x.json::part<gen>:<i>` | ≤ 2.5 M chars | yes |
| chunk part, **superseded** generation | same pattern, older gen | ≤ 2.5 M chars | **no** |
| preserved conflict copy | `conflict/.aqua-x.json/<gen>` | `json` ≤ 10 MB, or chunked | **no** |
| its parts | `.aqua-x.json::part<gen>:<i>` | ≤ 2.5 M chars | **no** |
| local-recovery copy | `conflict/<file>/local-<instance>` (+ parts) | ≤ 10 MB / chunked | **no** |
| canary, writer lease | `.aqua-mirror-canary`, `.aqua-mirror-writer` | tiny | no |

Only the first three rows matter for a boot. All rows were materialized.

## 2. Answers to the brief's questions

| # | Question | Answer |
|---|---|---|
| 1–6 | Production document counts, live/chunk/conflict/obsolete split, total BSON size, largest file | **Not measured**: production was not accessed. `node aqua/scripts/mirror-census.mjs` reports exactly these, read-only (aggregation of metadata + server-side `$bsonSize`; store bodies never leave the server). Local dev data has 2 chunked stores (`.aqua-index.json` 23.4 MB, `.aqua-vectors.json` 15.3 MB); production is at least as exposed. |
| 7 | Memory retained by `docs` | Every body for the whole loop: ≈ 1–2 bytes/char of the collection's data on Node 20/22 (2 bytes once a string holds any char > U+00FF, which real stores do). |
| 8 | By the `parts` Map | The same part objects as `docs` (references), so no extra copy. But they stay reachable until the function returns, including parts of generations nobody uses. |
| 9 | Chunk reconstruction | `join` builds one flat copy of each chunked store (2 B/char): +2 × store size at the moment of the join. |
| 10 | Temporaries after hydration | All released when the function returns (old: heap returned to ~14 MB after GC in the probe). The problem is the **peak**, not a leak. |
| 11 | Whole collection loaded before filtering? | **Yes.** Conflict copies and superseded parts were downloaded and decoded, then ignored. |
| 12 | Can it explain ~256 MB exhaustion? | **Yes, reproduced**: old hydration alone OOMs at ≥ 140 MB of collection data on Node 22, with the production trace (`Mark-Compact (reduce) 251.9 → 251.6 MB … Reached heap limit`). A clean 70 MB live set alone peaks at 235 MB. |

## 3. Why the collection grows (the time bomb)

`writeOne` (chunked path) garbage-collects superseded parts:

```js
let preservedChunked = (await col.find({ conflict: true, of: filename }).toArray()).some(d => d.chunked);
if (!preservedChunked) await col.deleteMany({ part: true, of: filename, gen: { $lt: gen } });
```

The guard protects the parts of a preserved conflict generation. It does that by skipping **all** GC for the file. Preserved copies are pruned to the newest 3 (`PRESERVE_PER_FILE`), never to zero, so once one chunked conflict copy exists, **every later write of that store leaves a full set of parts behind, forever**. Conflict copies arise from normal deploy overlap: the old instance's last flush lands after the new instance hydrated, and the new instance's first write hits the generation CAS.

Hydration downloaded all of it. The old loop also read the bodies of every conflict copy (`prunePreserved` and the GC check above also loaded full conflict bodies on every conflict and every chunked write).

## 4. The bounded design (implemented)

1. **One metadata listing:** `find({ part: { $exists: false } }, { projection: { json: 0 } })`. This returns no chunk parts and no bodies. Its size is proportional to the number of store files plus conflict copies, a few hundred small docs.
2. **One file at a time** over the live docs (same filters as before: no canary, lease, `conflict` or `conflict/…`, or suspicious `_id`).
   - Single-doc store: `findOne({ _id })`. The body is held only for this file.
   - Chunked store: a metadata query for that generation's parts (`{ part, of, gen }`, `json: 0`) enforces the **same completeness rule** (exactly `parts` parts, indices 0..n−1). Then each part is fetched **by `_id`, one at a time**, checked (`gen`, `i`, string body) and appended to the temp file. Order is by index, so out-of-order storage doesn't matter. A trailing high surrogate is carried into the next part, so the output is byte-identical to encoding the joined string.
3. **Generation followed under a race.** If a part vanishes because a writer superseded the generation mid-hydration (deploy overlap), the manifest is re-read. If its `gen` changed, that generation is streamed instead (≤ 3 attempts). Otherwise the file is blocked exactly as before.
4. **Unchanged decisions, in the same order:**
   - `knownGen` is set from the generation actually loaded.
   - An incomplete or corrupt set means `blocked: remote-chunk-set-incomplete`, the local copy is kept and never mirrored over the backup.
   - A non-string single-doc body is skipped.
   - The lineage marker is respected, and an unknown-lineage local copy is preserved first.
   - Local newer means kept (the staged copy is discarded).
   - Otherwise temp + `rename`, then `recordLineage` per file.
   - A failure anywhere means `enterUnverified` (nothing mirrored).
5. **Interrupted hydration.** A killed process leaves `.<file>.hydrate.<pid>`, which was never renamed into place and so is never data. These are removed at the start of the next hydration.
6. **Observability.** The hydration log line now ends with `[N doc(s) listed, P part(s) streamed, X MB written, T ms, heap a→b MB]` (numbers only).

Peak heap is bounded by the largest single document. Measured flat at 26 MB for collections of 70 → 516 MB (MEMORY_PROFILE.md §2).

## 5. Other full-body reads fixed

| Site | Before | After |
|---|---|---|
| `reconcileAfterOutage` | `find({}, {json:0})`, listing every chunk part | `listMirrorMeta`: no parts |
| `prunePreserved` | `find({conflict, of})`: every conflict body (up to 10 MB each) on every conflict | `json: 0` projection |
| `writeOne` GC check | same, on **every chunked write** | `json: 0` projection |

## 6. Chunk integrity defect found and fixed (pre-existing)

Parts were cut every `CHUNK_CHARS` UTF-16 units. A part could end between the two halves of a surrogate pair (an emoji). BSON stores UTF-8 and encodes a lone half as U+FFFD, so **the emoji came back as two replacement characters on every later hydration**. This was reproduced against real MongoDB with the deployed code. The writers (`writeOne`, `preserveLocal`) now use `chunkSlices()`: a part never ends on a high surrogate (it is one char shorter instead). Readers are unaffected, since part count and lengths were never assumed. Characters already corrupted in stored data cannot be recovered; this only affects text that happened to sit on a boundary.

## 7. Not changed (decision needed)

**Orphaned-part GC.** The correct rule is to delete parts with `gen < current` whose generation is not referenced by any preserved conflict manifest. It was **not implemented**, because it deletes data from the production mirror when deployed, and the brief forbids deleting mirrored data. With the bounded hydration, orphaned parts no longer affect memory. They still consume Atlas storage (the free tier caps data at 512 MB, and the same cluster holds users, sessions and payments). Run the census, then decide. See CHANGES.md.
