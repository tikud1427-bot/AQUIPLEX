# Memory profile

All measurements use the real code in Linux containers capped like Render Free (`docker run --memory=512m --memory-swap=512m`, official `node:20-slim` / `node:22-slim`), against a **disposable local MongoDB** (`aqua-test-mongo`, port 57017). Content is synthetic, or a local copy of a dev data directory (never production). Production MongoDB was not accessed.

Scripts (kept in the session scratchpad, not the repo): `seed-mirror.mjs` (writes `aqua_kv` in exactly the format `mongoMirror.js` produces; refuses any URI but the local instance), `probe-hydrate.mjs` (runs `hydrateFromMongo` alone), `memtrace.cjs` (a `--require` preload that snapshots `process.memoryUsage()` at boot milestones and every second; logs numbers only), `dapp.sh` (full `node index.js` with the real `.env` masked by an empty file and only synthetic config).

## 1. Runtime facts that decide everything

| Node | `heap_size_limit` in 512 MB container | 5 M-char decode, ASCII | with `—` | with `é` | `[s, s].join('')` |
|---|---|---|---|---|---|
| 20.20.2 | **259 MB** | 5 MB heap | **10 MB heap** | 5 MB heap | +20 MB heap |
| 22.23.5 | **259 MB** | 5 MB heap | **10 MB heap** | 5 MB heap | +20 MB heap |
| 24.19.0 (dev laptop) | 4288 MB | external | external | external | +20 MB heap |

The repo pins no Node version (no `engines`, `.nvmrc` or `render.yaml`), so Render runs its default, an older major than the laptop's. The production logs' "~251–257 MB before final GC" matches the 259 MB limit.

## 2. Hydration stage alone (`probe-hydrate.mjs`, Node 22, 512 MB)

Fixture "rep" = the 17 largest store sizes of a real dev data dir (index 23.4 MB, vectors 15.3 MB, reasoning graph 14.5 MB, …), synthetic content with realistic Unicode.

| Collection | Shape | **Old** peak heap | **New** peak heap | Old / new peak RSS |
|---|---|---|---|---|
| 10.7 MB | small stores | 34.6 MB | — | 115 MB / — |
| 69.8 MB | live only | **235.1 MB** | **26.6 MB** | 341 / 101 MB |
| 139.6 MB | + 1 conflict copy per store | **OOM** | — | — |
| 188.0 MB | + 2 orphaned generations | **OOM** | — | — |
| 279.2 MB | + 3 conflict copies per store | **OOM** | **26.7 MB** | — / 100 MB |
| 515.6 MB | + 3 conflicts + 4 orphaned gens | — | **26.1 MB** | — / 101 MB |

Old peak ≈ 3.4 × collection MB. New peak is independent of collection size: it is bounded by one document (≤ `CHUNK_BYTES` = 10 MB of UTF-8).

## 3. Full application (`node index.js`), lifecycle checkpoints

Heap used (MB) at each milestone; limit 259.

| Scenario | Node | Impl | listen | after hydration | engine mounted | peak | steady (after GC, t=40–75 s) |
|---|---|---|---|---|---|---|---|
| empty mirror | 22 | old | 70.4 | 68.7 | 69.8 | 70.9 | 67.7 |
| synthetic 70 MB | 22 | old | 68.9 | **241.4** | 178.2 | 241+ | 75.3 |
| synthetic 70 MB | 22 | new | 69.5 | 69.2 | 178.5 | 178.7 | 75.5 |
| synthetic 279 MB | 22 | old | 68.7 | — | — | **OOM** (t≈4.6 s) | — |
| synthetic 279 MB | 22 | new | 68.0 | 71.4 | 178.4 | 178.6 | 75.5 |
| dev-shaped 47 MB | 22 | old | 71.6 | 177.3 | 177.0 | 177.2 | 130.0 |
| dev-shaped 47 MB | 22 | new | 71.1 | 77.1 | 176.8 | 177.0 | 130.1 |
| dev-shaped 187 MB (+3 conflicts) | 22 | old | 68.6 | — | — | **OOM** | — |
| dev-shaped 187 MB (+3 conflicts) | 22 | new | 70.4 | 87.1 | 176.9 | 177.2 | 130.1 |
| dev-shaped 342 MB (+3 conflicts, +4 orphaned gens) | 22 | new (all changes), boot 1 & 2 | 69.1 / 70.2 | 79.2 / 76.8 | 177 | 177.4 | 130.0 |
| same | 20 | new (all changes), boot 1 & 2 | 54.3 / 48.0 | 75.5 / 70.7 | 126 | 126.8 | 125.2 |
| same | 20 | old | 49.4 | — | — | **OOM** | — |

"Boot 1 & 2" are two separate containers (fresh disk each time, as on Render). Memory stabilises within ~10 s of mount and stays flat for the rest of each run (5 s samples in the run logs).

## 4. Per-store load cost (Node 22, dev-shaped stores)

`readFileSync(…,'utf8')` + `JSON.parse`. Every store contains characters above U+00FF, so its raw string costs 2 × file size.

| Store | File | Raw string | Parse transient | Parsed (approx.) |
|---|---|---|---|---|
| `.aqua-index.json` | 22.3 MB | 42.9 MB | 84 MB | ~41 MB |
| `.aqua-vectors.json` | 14.6 MB | 29.2 MB | 29 MB | — |
| `.aqua-uko.json` | 2.0 MB | 3.9 MB | 7.5 MB | ~3.5 MB |
| `.aqua-reflection.json` | 1.8 MB | 3.7 MB | 7.5 MB | ~3.5 MB |
| others | < 2 MB each | | | |

Fitted over the runs: **full-app peak ≈ 70 + 2.3 × S**, **steady ≈ 70 + 1.3 × S**, where S = total live store MB. The 259 MB limit is reached near **S ≈ 80 MB**.

## 5. Contribution by stage (dev-shaped 187 MB collection, Node 22)

| Stage | Old | New |
|---|---|---|
| Platform + engine code loaded (baseline) | ~70 MB | ~70 MB |
| Mirror hydration | > 189 MB (OOM) | +6 to +17 MB, transient |
| Store loading (parse) | not reached | +107 MB transient, +60 MB retained |
| Background operations | not reached | ≈ 0 (no growth over 75 s) |
