# AQUA Persistent Intelligence Core — Architecture (Phase 4)

> Memory, Reasoning, Evidence, Knowledge, and Search no longer function as
> separate systems. They function as one Persistent Intelligence Core.

Phase 0 gave AQUA stable orchestration. Phase 1 gave it Universal File
Intelligence (every artifact → one UKO). Phase 2 gave it the Evidence Engine
(no fact without provenance). Phase 3 gave it Cross-File Reasoning (one
graph across everything). Phase 4 connects them: the **Persistent
Intelligence Core (PIC)** is the coordination layer through which every
subsystem synchronizes — and the first *consumer* of the Phase-3 graph and
query layer, which previously had none.

AQUA no longer thinks "I have files." It retrieves connected knowledge.

---

## 1. Architecture

### 1.1 Position

```
                        ┌────────────────────────────────────────────┐
   POST /upload ──────► │  fileEngine (Phase 1)                      │
                        │  parse → validate → enrich → evidence      │
                        │  → graph rebuild (Phase 3)                 │
                        │  → PIC.onKnowledgeIngested()   ← Phase 4   │
                        └────────────────────────────────────────────┘
                                          │
                        ┌─────────────────▼──────────────────────────┐
                        │        PERSISTENT INTELLIGENCE CORE        │
                        │              src/pic/core.js               │
                        │                                            │
                        │  knowledgeLifecycle   11-state machine     │
                        │  versionStore         revision history     │
                        │  reasoningFeedback    verdicts → boosts    │
                        │  consolidationEngine  continuous improve   │
                        │  retrievalIntelligence knowledge-first     │
                        │  knowledgeHealth      monitor + maintain   │
                        │  projectIntelligence  the space, understood│
                        └─────────────────┬──────────────────────────┘
                                          │ coordinates — never owns
        ┌──────────┬──────────┬───────────┼───────────┬──────────┬──────────┐
        ▼          ▼          ▼           ▼           ▼          ▼          ▼
   evidenceStore ukoStore reasoningGraph queryEngine memory/  embeddings  search/
   (facts+ev =   (objects) (derived      (traversal) (Memory   (vectors)  (web)
   SOURCE OF               connections)              5.0)
   TRUTH)
                                          ▲
                        ┌─────────────────┴──────────────────────────┐
   POST /chat ────────► │  prepareTurn (routes/chat.js)              │
                        │  … memory retrieve → project → attachments │
                        │  → PIC.retrieveKnowledge()     ← Phase 4   │
                        │  → evidence context → prompt → generate    │
                        │  → verification → PIC feedback ← Phase 4   │
                        └────────────────────────────────────────────┘
```

### 1.2 The one rule that makes it safe

**The PIC persists only meta-state. It never holds knowledge.**

`.aqua-pic.json` contains lifecycle records, revision deltas, feedback
signals, and an operations ledger — every entry *references* knowledge by
id (`fact:<id>`, `uko:<id>`, `entity:<id>`). Facts stay in the evidence
store, objects in the UKO store, connections in the graph, memories in the
memory engine. Delete `.aqua-pic.json` and AQUA degrades gracefully to
exact Phase-3 behavior; no knowledge is lost, because none lives there.

This is how the critical requirements are met *structurally*, not by
discipline: no duplicated data, no parallel memory system, no competing
knowledge store. The single source of truth is unchanged.

### 1.3 Contracts

| Contract | Mechanism |
|---|---|
| Fail-open | Every facade method catches; ingest and chat can never be sunk by intelligence bookkeeping. Empty retrieval ⇒ prompt byte-identical to pre-PIC turns. |
| Kill switch | `AQUA_PIC=off` disables every PIC operation instantly. |
| Composition over replacement | All deps injected (`DEFAULT_DEPS` in core.js), default-wired to the real modules; every module tested against real stores AND injectable fakes. |
| Backward compatibility | All edits additive. Route contracts byte-stable. New evidence-context section absent ⇒ identical output. New fact flags (`archived`, `disputed`, `trusted`, `stale`, `supersededBy`, `corroboratedFiles`) are additive keys no legacy reader branches on. |
| Grounding | Every retrieved item carries citations + epistemic tier (`observed`/`derived`); the knowledge block rides `composeEvidenceContext`, so reviewers see exactly what the drafter saw (Phase-0 contract preserved). |

### 1.4 Module map

```
src/pic/
  core.js                  facade — the ONLY entry point consumers use
  picStore.js              persisted meta-state (.aqua-pic.json, schema 1)
  knowledgeLifecycle.js    state machine + transition rules
  versionStore.js          revision history (compact deltas)
  reasoningFeedback.js     session capture + per-fact retrieval bias
  consolidationEngine.js   merge / evolve / flag / promote
  retrievalIntelligence.js knowledge-first retrieval composition
  knowledgeHealth.js       monitoring + runMaintenance
  projectIntelligence.js   the owner's knowledge space, one view
  tests/pic.test.js        38-test regression suite
src/routes/intelligence.js maintenance + observability API (/intelligence)
```

Integration edits (all additive):

| File | Edit |
|---|---|
| `src/files/fileEngine.js` | After graph build: `pic.onKnowledgeIngested(...)` (dynamic import, fail-open) |
| `src/files/evidenceStore.js` | New `updateFact(ownerId, factId, patch)` — the one write seam consolidation uses; statements are never rewritten |
| `src/routes/chat.js` | prepareTurn §5c²: `picRetrieveKnowledge()` → `knowledgeContext`; `runVerification` records the verdict as reasoning feedback |
| `src/intelligence/evidenceContext.js` | New `knowledgeContext` section in the grounding block |
| `router.js` | Mounts `/intelligence` |

---

## 2. Knowledge Lifecycle

Every subject (`uko:*`, `fact:*`, `entity:*`) follows the Phase-4 sequence:

```
created → parsed → enriched → verified → linked → reasoned
       → retrieved → updated → versioned → archived → retired
```

Rules (`canTransition`, pure and exported):

- **Forward always legal, skips included.** A content-hash cache hit jumps
  `created → enriched` in one hop — that is what actually happened.
- **The living loop.** `retrieved / reasoned / versioned / verified /
  linked → updated → versioned → …` — knowledge improves in cycles;
  nothing remains static forever.
- **Re-verification.** Living states may return to `verified` — that is
  what consolidation's *promotion* is.
- **Archival is universal and reversible** (`archived → updated` revives).
- **Retirement is terminal and two-step** (`archived → retired` only).
  Knowledge leaves the system through two deliberate transitions, never
  one accident.
- **Touch semantics.** A self-transition records no history entry but
  bumps `meta.retrievals / reasonings / updates` and `lastAt` — bounded
  logs, live counters. Retrieval frequency is exactly what consolidation's
  stale/promote logic reads.

Ingest derives each UKO's real path from its recorded processing stages
(`ingestStatesFor`), so lifecycle never claims a step that didn't run.

---

## 3. Synchronization Architecture

Three synchronization points; everything flows through them.

**Ingest → PIC** (`onKnowledgeIngested`, called by fileEngine per batch):
lifecycle birth for every new object and fact; `entity_merge` revisions for
every resolution the graph builder performed (canonical + aliases +
confidence, straight from the resolver's own output — never re-derived);
contradiction events ledgered; background consolidation scheduled
(debounced 3s per owner, `unref`'d timer — the process is never held open).

**Chat → PIC** (prepareTurn §5c²): one `retrieveKnowledge()` call composes
the knowledge block; it joins the evidence context (reviewers see it) and
the drafter prompt (same slot as attachments/project). Identity
self-questions skip it — the same rule project retrieval and search follow.

**Verification → PIC** (runVerification): the reviewer's verdict on a turn
that used PIC knowledge becomes a reasoning session — clean pass ⇒
`verified`, revision ⇒ `corrected`, failed unrevised ⇒ `unsupported` —
which updates the per-fact signals the *next* retrieval ranks with. The
loop closes: reasoning improves reasoning.

Everything else (memory, embeddings, search, mind) keeps its existing lane
untouched; the PIC composes their outputs, it does not re-route them.
Memory was not redesigned — it is one subsystem the core coordinates, as
the brief requires.

---

## 4. Consolidation Engine

`consolidateOwner(deps, ownerId)` — deterministic, **idempotent** (a second
pass over unchanged knowledge is a no-op; proven by test), annotate-and-
archive only:

1. **Merge duplicates.** Facts grouped by `normalizeStatement`; survivor =
   highest confidence, then newest. Evidence unions onto the survivor
   (evidence sharing means this costs id references, not copies).
   Duplicates get `{ archived, supersededBy }` — archived, never deleted.
   `fact_supersession` revisions recorded on both sides.
2. **Handle conflicting evidence.** Facts on a `contradicts` edge are
   flagged `disputed` and confidence-capped at 0.60 — a contested claim
   must never outrank an uncontested one. Surfaced, not resolved (the
   Phase-3 rule stands).
3. **Evolve confidence.** Corroboration across `N` independent source
   files pushes confidence asymptotically toward 0.98 — and only when the
   independent-file count *increases* (`corroboratedFiles` tracked on the
   fact), which is what makes the pass idempotent instead of creeping.
   Every move ≥ 0.01 records a `confidence` revision.
4. **Detect stale.** No lifecycle touch for 30 days ⇒ `stale` flag —
   downweighted at retrieval, never removed (old ≠ wrong). A new touch
   restores freshness on the next pass.
5. **Promote trusted.** ≥2 evidence objects + ≥2 retrievals + undisputed ⇒
   `trusted` flag + lifecycle `verified` (re-verification). Retrieval
   boosts it.

Runs two ways: **background** (debounced after every ingest) and
**on demand** (`POST /intelligence/maintain`). Every pass is ledgered.

---

## 5. Versioning

`versionStore` keeps bounded, compact revision history per subject —
`{ rev, at, kind, before, after, reason, actor }` with only the fields
that changed. Kinds: `fact_supersession`, `entity_merge`, `confidence`,
`relationship`, `memory`, `state`.

- `getHistory(owner, subject)` — the full trail.
- `confidenceTrajectory(owner, subject)` — how belief in one fact evolved.
- Bounds: 20 revisions/subject (oldest roll off; `rev` numbers keep
  climbing so gaps are visible), 20k subjects/owner.

Historical knowledge is never destroyed: supersession archives, revisions
persist, and the current truth in the evidence store is annotated — not
replaced.

---

## 6. Retrieval Intelligence

"Retrieve knowledge instead of files." One call —
`retrieveKnowledge(owner, query)` — composes:

| Lane | Source | What it adds |
|---|---|---|
| Grounded facts | `evidenceRetrieval` | lexical hits with citations |
| Entities | reasoning graph | token-matched canonical entities, alias-aware, with their files |
| Connected facts | graph `about` edges | facts the lexical lane *missed* but the graph links to matched entities |
| Timeline | `queryEngine.timelineAcross` | cross-file ordered events, only on temporal cues |
| Reasoning history | `reasoningFeedback` | per-fact boost in [−0.10, +0.15] |
| Lifecycle | fact flags | archived/superseded **excluded**; `disputed` −0.20, `stale` −0.10, `trusted` +0.10 |

Output: ranked `items[]` (each with citations, epistemic tier, flags) and
one budgeted prompt `block` (default 1600 chars, hard cap). Served facts
receive a `retrieved` lifecycle touch — the signal consolidation feeds on.
Disputed items are labeled in the block itself ("treat as contested") so
the drafter can never present a contested claim as settled.

---

## 7. Knowledge Health

`GET /intelligence/health` computes every check in the brief from the live
stores (counts + bounded samples, never dumps):

duplicate-entity candidates (the resolver's ambiguous pairs) · broken
evidence references · orphaned knowledge (facts without evidence, evidence
without facts) · missing relationships (multi-file entities with no edges)
· stale knowledge · conflicting facts (open `contradicts` edges) · disputed
· low confidence (< 0.4) · trusted · unused embeddings · invalid graph
references — rolled into `status: healthy | attention | degraded`.

`POST /intelligence/maintain` = measure → consolidate → re-measure,
returning `{ before, consolidation, after, ledger }`. Maintenance writes
only through the consolidation path: annotate and archive, never rewrite,
never delete.

---

## 8. Observability

Every intelligence operation feeds `getPICMetrics()`: ingests, retrievals
(total/non-empty), knowledge items served, feedback reuse, consolidations,
facts merged, entities merged, confidence adjustments, reasoning sessions,
maintenance runs, failures, and EWMA latencies (ingest/retrieve/
consolidate) — plus store stats. Exposed at `GET /intelligence/metrics`;
every operation also logs under the `[PIC]` prefix and lands in the
per-owner ledger (`GET /intelligence/ledger`).

### API surface (`/api/aqua/intelligence`, owner-scoped like `/memory`)

```
GET  /knowledge?q=…             knowledge-first retrieval (items + block)
GET  /project                   the knowledge space, organized + understood
GET  /health                    full health report
POST /maintain                  consolidate + re-measure (before/after)
GET  /lifecycle/:kind/:id       state + transitions + revisions + trajectory
GET  /ledger                    recent intelligence operations
GET  /metrics                   PIC counters + latencies (no owner needed)
```

---

## 9. Developer Guide

**Consume knowledge** (the only call most code needs):

```js
import { retrieveKnowledge } from '../pic/core.js';
const { items, block, stats } = retrieveKnowledge(ownerId, query, { limit: 8 });
// items: [{ kind:'fact'|'entity'|'event', citations, epistemic, … }]
// block: ready-to-inject prompt section ('' when nothing relevant)
```

**Report a reasoning outcome** (any future agent/autonomous phase):

```js
import { recordReasoningOutcome } from '../pic/core.js';
recordReasoningOutcome(ownerId, {
  outcome: 'verified',           // successful|failed|corrected|verified|unsupported
  usedFacts: [...factIds], usedEntities: [...], query, requestId,
});
```

**Inspect a subject:** `getLifecycle`, `getHistory`,
`confidenceTrajectory`, `reasoningBoost` — all exported from `core.js`.

**Test against fakes:** every engine takes `deps`
(`{ evidenceStore, ukoStore, graph, queryEngine, evidenceRetrieval,
formatCitation }`); pass fakes exactly as `graphBuilder` tests do. The PIC
suite (`npm run test:pic`) is the template — tmpdir + `AQUA_DATA_DIR` +
dynamic imports + `_resetPICForTests()`.

**Extend:** new consolidation ops go in `consolidationEngine` (keep them
idempotent — the test enforces it); new retrieval lanes in
`retrievalIntelligence` (must carry citations); new revision kinds in
`versionStore.REVISION_KINDS`; new lifecycle rules in `canTransition`
(pure — test first). Future autonomous reasoning calls
`retrieveKnowledge` + `recordReasoningOutcome`; enterprise collaboration
narrows `ownerId → projectId` at the `projectIntelligence` seam. No
rewrite required — that is the point.

---

## 10. Migration Guide

**There is no migration.** Deploy and restart.

- New store `.aqua-pic.json` is created empty in the standard data dir on
  first write; existing stores are untouched and their schemas unchanged.
- Existing knowledge joins the PIC organically: the next ingest registers
  its lifecycle; the first consolidation pass annotates the historical
  fact set; the first retrieval starts the touch counters. No backfill
  job, nothing to run.
- Rollback = revert the code. Additive fact flags are ignored by every
  legacy reader; `.aqua-pic.json` can be deleted freely (meta-state only).
- Emergency disable without deploy: `AQUA_PIC=off`.

Verified: full pre-existing suite passes unchanged (920/921; the single
failure — `project/tests/indexPersistence.test.js` — fails identically on
the pristine pre-Phase-4 tree and is unrelated to this work).

---

## 11. Performance Guide

- **Incremental everywhere.** Ingest sync is O(new objects + their facts);
  the graph is not rebuilt by the PIC (fileEngine already owns the one
  rebuild per batch); consolidation re-reads the compact fact set, not
  text; corroboration boosts fire only on *new* independent files.
- **Background, debounced, unref'd.** Consolidation runs 3s after the last
  ingest per owner, off the request path, and never holds the process
  open.
- **Bounded by construction.** 20k lifecycle subjects, 30 transitions and
  20 revisions per subject, 10k feedback signals, 500 sessions, 300
  ledger entries per owner — same oldest-first eviction policy as every
  AQUA store.
- **Lazy + streaming-friendly.** Retrieval hydrates only the facts it
  serves; the block is budgeted (default 1600 chars) so prompt cost is
  fixed; items stream into existing SSE stages untouched.
- **Measured.** Scale test: 500 facts / 10 files — consolidation < 5s
  bound (measured ~50ms), retrieval < 2s bound (measured ~10ms); latency
  EWMAs exposed at `/intelligence/metrics` for production drift.
- **Scaling path.** Per-owner maps mirror every existing store; the Mongo
  road (already free via `atomicStore`'s mirror) carries the PIC store
  with zero interface change when millions of objects arrive.

---

## 12. Success criteria — status

| Brief requirement | Where |
|---|---|
| One coordinating core, nothing isolated | `core.js` + the three sync points (§3) |
| Knowledge lifecycle, nothing static | §2 — enforced state machine + touches |
| Consolidation: merge/confidence/stale/conflicts/promote/archive | §4 |
| Versioning, history never destroyed | §5 |
| Reasoning feedback loop | §3 + §6 (verdicts re-rank retrieval) |
| Project intelligence | `projectIntelligence` + `GET /project` |
| Knowledge health + maintenance APIs | §7 |
| Retrieval: knowledge, not files | §6 — first consumer of Phase 3 |
| Memory evolved, not redesigned | untouched lane, coordinated (§3) |
| Performance: incremental, background, bounded | §11 |
| Observability | §8 |
| Production-grade tests, no regressions | 38 PIC tests + 920/921 sweep at baseline parity |
| Never duplicate / no parallel stores / compose / backward compatible | §1.2, §1.3 — structural |
