# Aqua Knowledge Architecture Audit

**Date:** 2026-11-10 · **HEAD:** `839ea0d1` · Part of the [Production Intelligence Audit](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md). Labels: **V** verified · **I** inferred · **U** unknown · **NI** not implemented.

## 1. Every place user knowledge lives

"Prod" = written/read in the documented production configuration (legacy read, no Postgres, code-default flags).

| # | Store | Physical location | Owner module (write API) | What it holds | Read by the answer path? | Prod |
|---|---|---|---|---|---|---|
| 1 | **Legacy facts** (profile) | `.aqua-mind.json` → `mind.facts` | `memory/longTermMemory.js` `storeFact`/`applyCurrentState`/`noteLaterWord`/`deleteFact` | key→value facts with `confidence`, `importance`, `sourceText`, `sourceConversation`, `history[]`, `transitions[]`, `ended`, `laterWord`, `retiredItems`, `sensitivity` | Yes — identity card + "USER PROFILE & MEMORY" (`memory/engine.js:388-420`) | **V** write+read |
| 2 | **Identity card** | derived from #1 (`memory/identity.js`) | — (view) | name, role, company, location | Yes, every turn | **V** |
| 3 | **Mind beliefs** | `.aqua-mind.json` | `mind/beliefEngine.js` via `mindObserve` | dimensioned beliefs (identity, communication, preferences, knowledge, decision) with confidence + basis | Yes — cognitive block | **V** |
| 4 | **Mind goals** | `.aqua-mind.json` | `mind/goalTracker.js` | goals with status, progress, `changedBy`, `review`, `achievedBy` | Yes — "Active goals" | **V** |
| 5 | **Mind working memory** | `.aqua-mind.json` | `mind/workingMemory.js` | focus, blockers, deadlines, open questions | Yes — "Current state" | **V** |
| 6 | **Mind episodes** | `.aqua-mind.json` | `mind/episodeTracker.js` | conversation arcs | Yes — episode recall lane | **V** |
| 7 | **Mind relationship graph** | `.aqua-mind.json` | `mind/relationshipGraph.js` | nodes/edges (self, people, orgs, goals) | Yes — "Related", graph recall lane | **V** |
| 8 | **Mind predictions** | `.aqua-mind.json` | `mind/predictionEngine.js` | inferred next needs with probability | Yes — "Anticipated need" | **V** |
| 9 | **Conversation history** | `.aqua-history.json` | `memory/conversationStore.js` | every message, per conversation, `meta.userId` | Yes — window + **episodic recall** (verbatim) | **V** |
| 10 | **Recall forget list** | `.aqua-recall-redactions.json` | `memory/recallRedactions.js` | phrases the user asked to forget, applied to quotes | Yes (filter) | **V** |
| 11 | **PIC evidence store** | `.aqua-evidence.json` | `files/evidenceStore.js` `saveFact`/`saveEvidence` | sentence facts + evidence objects; from **files** always, from **chat** only with `AQUA_BRAIN_INGEST(_FACTS)` | Yes — PIC floor | **V** files only |
| 12 | UKO / file index / attachments | `.aqua-uko.json`, `.aqua-fileindex.json`, `.aqua-attachments.json` | `files/`, `upload/` | parsed documents, chunks | Yes — attachments, file recall | **V** |
| 13 | Vectors | `.aqua-vectors.json` | `embeddings/vectorStore.js` | fact/file/canonical/recall embeddings per owner namespace | Yes (scores) | **V** if embedding key |
| 14 | Reasoning graph | `.aqua-reasoning-graph.json` | `reasoning/reasoningGraph.js` | entities/relations from files (and chat with ingest) | PIC lanes | **V** files |
| 15 | PIC lifecycle / feedback | `.aqua-pic.json` | `pic/picStore.js` | trusted/disputed/stale flags, reasoning feedback | PIC ranking | **V** |
| 16 | Brain annotations | `.aqua-brain.json` | `brain/worldModel/annotationStore.js` | curated entity notes; "cannot hold knowledge" by design | `/brain` routes | V |
| 17 | Reflection V2 snapshots/ledger | `.aqua-reflection.json` | `brain/reflectionV2/reflectionStore.js` | world snapshots, change ledger | legacy revision voice (`=on` only) | Computed, not applied |
| 18 | Cognition store | `.aqua-cognition.json` | `cognition/cognitiveStore.js` | reasoning plans/strategy outcomes | CIE | **V** |
| 19 | Project memory / index | `.aqua-projects.json`, `.aqua-index.json` | `project/` | workspace knowledge | project retrieval | V (workspaces) |
| 20 | **Canonical World Model** | Postgres `aqua_entities`, `aqua_claims` (+ lifecycle, evidence, beliefs, dense embeddings, outbox, jobs) | `core/worldModel/*`, `core/claims/*`, E6 commit | typed claims with polarity, modality, state (active/trusted/disputed/superseded/archived), `asserted_at`, provenance | Yes on canonical/authoritative read | **No (no DB)** |
| 21 | Digital Twin | inside Mind | `brain/digitalTwin/` | style/pattern inferences | `/brain` view | Off |
| 22 | Mongo mirror | Mongo `aqua_kv` | `core/mongoMirror.js` | whole-file copies of #1–#19 (+ `conflict/` generations) | boot hydration | **V** |

**Duplication (V for the legacy stores; from the 2026-11-02 probe, `AQUA_LIVING_WORLD_MODEL_ARCHITECTURE_REPORT.md` §4, with ingest on):** "works at Fintrail" is held independently by the legacy `workplace` fact (= identity card), a Mind belief `identity:organization`, a Mind graph node + edge, a PIC evidence sentence and a reasoning-graph entity — plus a canonical claim when Postgres is present. A goal is held in four places (legacy `goal` fact, Mind goal, graph node/edge, PIC sentence). In production the evidence/reasoning-graph copies come only from files, so a chat fact lives in 3–4 places, plus verbatim in conversation history.

## 2. The ten questions

**1. Which system is the authoritative source of truth?**
*By design:* with Postgres, the canonical World Model (`AQUA_CANONICAL_READ` auto = "authoritative": canonical answers, legacy facts only fill gaps it does not contradict — `legacyVetoFor`, `brain/index.js:162`). *In production:* there is no canonical model ([F-01](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-01)), so authority is **split**: the legacy fact store answers the profile and identity card, the Mind answers the cognitive block, and conversation history answers via recall. No single module decides what is true about the user; the answer model reconciles them, guided by prompt text ("a newer statement about the same thing replaces an older one"). **V.**

**2. Are multiple systems storing the same information?** Yes — §1. Each copy is written by its own extractor from the same message (`memoryObserve` runs `extractFactsWithReport` and then `mindObserve` with those facts plus its own observers), so they agree at write time only when both extractors agree.

**3. How are conflicts resolved?**
- Legacy facts: `memoryConflictResolver.js` (newer / higher confidence; correction phrases "actually", "now", and `AQUA_CORRECTION_PHRASES`) and `factChange.js` (`resolveCurrentState` → replace / scoped / end / uncertain / note). **V.**
- Mind: beliefs merge with confidence; `retired` and `laterWords` passed from the fact store at **read** time hide or annotate stale beliefs (`engine.js:431-451`) — the stored belief is not changed unless `AQUA_PROPAGATION=on`. **V.**
- Canonical (DB only): S8 dedup, single-valued predicate supersession (`AQUA_E6_SINGLE_VALUED`), contradiction policy (`brain/reflectionV3/contradictionPolicy.js`) and lifecycle states. **V code / not in prod.**
- Across stores: **nothing at write time** with propagation off. Read-time veto exists only between canonical and legacy.

**4. How are outdated facts superseded?** Legacy: `applyCurrentState` writes `history`, `transitions`, `ended`, `retiredItems`; the profile renders "(previously: …)" and "No longer current"; replaced sentences are retired from the evidence lane in the background (`retireSupersededInBackground`, `engine.js:276-291`). Mind: read-time filtering only (above). Recall quotes: "since changed" notes from `legacySupersessionNotes`. **Limit (V, probe):** supersession only fires for facts the extractor captured. "Marco left the company… down to 2 engineers" superseded nothing because the team was never a fact ([F-04](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-04)).

**5. How are historical facts preserved?** Legacy `history[]` and `transitions[]` per fact (version history, `buildVersionHistory`); conversation history verbatim; canonical claims keep superseded rows with `asserted_at`. No point-in-time query ("what did I believe in March?") exists on the production path (**NI**).

**6. How are corrections propagated?** Memory-page and Understanding-page edits go through `propagation.withTransitions` (`memory/memoryEditor.js:77-302`), which is a pass-through when `AQUA_PROPAGATION` is off (`propagation.js:831`). So in production a correction updates the fact store only; the Mind belief, graph edge, goal and evidence sentence keep the old value and are hidden/annotated only where read-time filters catch them. **Exception:** forget always cleans the Mind's copies (`forgetValueInMind`, `engine.js:208`), and forget reaches the World Model when it exists. **V.**

**7. How are relationships updated?** Mind graph `upsertEdge` from extracted facts and observer hints; no edge retirement on change without propagation. Third-party attributes are mostly not captured ("My sister Ana works at Stripe" → `siblings: Ana` only; probe). With Postgres + E6, claims carry subject entities, so third-party facts become claims about Ana — with the E6 attribution failure class "I help X with her Y" credited to self, measured on dev sets (2026-10-19 note). **V / I.**

**8. How is provenance maintained?** Legacy facts: `sourceText`, `sourceConversation`, `ts`, `extractor`, `isCorrection`. Evidence store: evidence objects per fact with `sourceFileId`. Canonical: claim evidence + `asserted_at`. The answer gets provenance only as rendering ("user-stated", "(user said)", dated recall quotes). "Context used" disclosure (`contextRefs`, `chat.js:1726`) records which facts reached the prompt. **V.** Mind beliefs record `basis` but not the source sentence for every update.

**9. What happens when one database is unavailable?**

| Unavailable | Behaviour | Label |
|---|---|---|
| Postgres (configured) | `resolveReadMode` degrades to legacy, logged; legacy veto would fail closed but is bypassed by the degrade (fix for the 2026-10-12 P0) | V |
| Mongo at runtime | hot path unaffected (local files); mirror re-queues with backoff; health verdict shows not durable | V |
| **Mongo at boot on a fresh Render disk** | "hydration failed — continuing with local files only" → users appear to have **no memory**; when Mongo recovers, the first write's generation-CAS conflict preserves the good copy under `conflict/<file>/<gen>` and **overwrites the live document** with the near-empty store; preserved copies are pruned to the newest 3; recovery is manual ([F-20](#f-20)) | V (code path), not executed |
| Embedding provider | semantic scores null → keyword everywhere | V |
| LLM providers | 503 + Retry-After; memory already written ([F-12](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-12)) | V |

**10. Can the system recover from partial updates?**
- Within one store: atomic temp+rename writes, `.bak` once per process, corrupt files set aside (`core/atomicStore.js`). **V.**
- Across stores in one turn: each stage is try/catch fail-open, so a turn can update facts and fail on the Mind (or vice versa) with no compensation. With propagation on, `reconcileMind` runs every turn and the transition record acts as an outbox with backoff and a dead letter after 8 attempts; off in production. **V.**
- Canonical: transactional outbox, reflection idempotency/recovery modules, reapStale — DB only. **V code / not in prod.**

<a id="f-20"></a>
## 3. Additional finding

> **Status 2026-11-10 (Sprint 1, uncommitted): fixed.**
> - **Verified initialization and a lineage marker:** an unverified start never mirrors; a store of unknown lineage is blocked and its local copy preserved; the next boot restores the backup.
> - **Tests:** 11 in `mongoMirrorStartup.test.js`, including a real connection failure.
> - **Related fix:** failed-turn memory (Q10) is now rolled back at the turn's commit boundary (`memory/turnCommit.js`).
> - **Details:** [Sprint 1 report](AQUIPLEX_SPRINT1_PRODUCTION_SAFETY_REPORT.md).

**F-20 (S1, V code path) — A Mongo outage during a Render boot can replace every user's memory with an empty store.** `core/mongoMirror.js` `hydrateFromMongo` (`:424-497`) logs and continues on failure; `casFilter` (`:502`) then matches `gen: {$exists:false}`; the duplicate-key path `preserveForeignGeneration` (`:513`) copies the live doc to `conflict/…` and the retry lands the new (empty-based) file as live. `prunePreserved` keeps 3 preserved generations per file; the code notes that server + worker sharing stores produced 40 conflicts in one short session. A boot should refuse to become the mirror writer until hydration has succeeded at least once (see [Roadmap R-3](AQUIPLEX_ENGINEERING_ROADMAP.md)).

## 4. Inconsistencies and duplicate responsibilities

| Responsibility | Implementations | Problem |
|---|---|---|
| "What is true about the user" | legacy facts; Mind beliefs; canonical claims; recall quotes | Four writers, no write-time convergence in prod; prompt carries all of them and asks the model to reconcile |
| Goals / completion | legacy `goal` fact (collection) and Mind `goals` (`goalTracker`) | Two goal stores decide completion separately (documented gap 2026-11-02, still open) |
| Change detection | `factChange.js` (legacy), `stateTransition.js` (understanding), Mind `laterWordOnGoals`, E6 S8/single-valued (canonical), Reflection V2/V3 diffs | Five change detectors with different vocabularies |
| Relationship graph | Mind graph; reasoning graph; canonical entities/claims; Brain annotations | Three graphs + overlay; the Mind graph is the only one on the prod read path |
| Extraction | regex `memoryExtractor`/`candidateExtractor`; Mind observers; conversation ingest (off); E6 LLM (off) | Prod uses only the two rule-based ones ([F-04](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-04)) |
| Reflection | Mind `reflectionEngine` (every 8 turns, applied), Reflection V2 (computed, not applied), Reflection V3 (DB workers), CIE `reflectionEngine` | Four "reflection" modules with different meanings |

## 5. Assessment: converge, don't rewrite

The duplication is real but most of it is already *structured for* convergence: every legacy fact has a history and transitions; the transition record (`memory/propagation.js`) is an outbox with idempotent IDs, backoff, a sweeper and dead letter; forget already fans out; the canonical model already has the lifecycle the legacy store imitates. What is missing is (a) a decision about which store is authoritative **in production** and (b) running the existing reconciler there. A rewrite would discard the most-tested code in the repository (memory 492 tests, brain 1,355) to rebuild the same lifecycle.

Recommended convergence path (details and gates in [Roadmap §2](AQUIPLEX_ENGINEERING_ROADMAP.md)):
1. **Decide the production substrate** (D-1): deploy Postgres or commit to the legacy store for the next 6 months. Everything else depends on this.
2. **One write-time truth per attribute:** the fact store (legacy) or claims (canonical) is the only *writer* of user-world state; Mind beliefs, graph edges and goals become projections refreshed from it (the propagation reconciler already does this — measure it, then default it on).
3. **Retire duplicate detectors** behind the single `stateTransition` vocabulary, one at a time, each with its existing eval as the guard.
