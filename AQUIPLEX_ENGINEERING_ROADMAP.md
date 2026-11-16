# AQUIPLEX Engineering Roadmap — from the 2026-11-10 audit

**Basis:** [Production Intelligence Audit](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md) findings F-01…F-20. Nothing here is implemented. Each item is one reviewable unit with its own tests and, where it changes understanding, an [ACIB](AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md) Stage A measurement before/after.

**Ordering principle.** The brief's priority list (context intelligence → unified world model → user understanding → reflection → cross-domain → personalised assistance) is kept as the spine, with two changes the evidence forces: (1) privacy and data-loss defects go first because they are cheap and their failure is unrecoverable; (2) a measurement harness precedes the first intelligence change, because the repo's history shows changes judged by reading examples.

<a id="decisions"></a>
## 1. Decisions only the owner can make

| ID | Decision | Why it blocks | Options (recommendation first) |
|---|---|---|---|
| **D-1** | **Production substrate for the World Model** | The canonical model, E6, durable jobs, Reflection V3, proactive, revision voice and CE V2 exist only with Postgres; production has none ([F-01](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-01)). Every "unified world model" item depends on this. | (a) **Keep production on the legacy substrate for now; build R-5/R-6 store-agnostic; run ACIB arm C2 to decide with data.** (b) Provision Postgres on Render + migrations + worker, then flip read mode. (c) Retire the canonical stack. |
| **D-2** | What may appear in logs | Fixing [F-09](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-09) removes debug signal engineers use | **Ids, counts, lengths, hashes only; content behind a local-only debug flag** · or redact-by-policy |
| **D-3** | Key/model for answer-level evaluation | ACIB Stage B and every "is the answer better" claim need an authorised, dedicated key or a local model | dedicated paid key with a cap · approved local model · single named free key |
| **D-4** | Semantic recall | Turning on `AQUA_SEMANTIC_RECALL` sends past user messages to an embedding provider | keep off until R-5 shows a need-driven keyword path is insufficient · enable with a dedicated key and privacy notice |
| **D-5** | Production start command and env record | The audit could not verify production; the boot line misreports two gates ([F-02](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-02)) | owner pastes Render start command, `[FLAGS]` line and `/provider-health` read-mode into `ops/PRODUCTION_CONFIG.md` after R-2 |

> **Status 2026-11-10 (uncommitted, not deployed):**
> - **Done:** R-1 (logs), R-2 (registry + effective status), R-3 (startup protection), R-4 (ACIB v1 Stage A, baseline frozen).
> - **Done from R-11:** the failed-turn half.
> - **Still open:** the `.bak` purge half of R-11; R-5 onward.
> - **Decisions taken:** D-1 (no Postgres in production yet), D-2 (no user content in logs), D-3 (deterministic benchmark first), D-4 (semantic recall stays off).
> - **Next:** R-5, measured on ACIB — see [Sprint 2 notes](AQUIPLEX_SPRINT2_ENGINEERING_NOTES.md).

## 2. Prioritised work

Complexity: **S** ≤ 1 day · **M** 2–5 days · **L** > 1 week.

### P0 — safety (do first, small)

**R-1 · Stop writing user content to logs** — *S, P0*
- Existing: `console.log` of raw messages/values in `memoryRetriever.js:244`, `memoryExtractor.js:74`, `candidateExtractor.js:275-278`, `logMemoryEvent` details (`chat.js:491,583`), `searchManager.js:93`, `projectRetriever.js:76`.
- Deficiency: health/mood sentences the product refuses to store are printed to Render logs; every message is retained wherever logs go.
- Proposal: log `requestId`, owner hash, counts, lengths, fact *keys* (not values); a `LOG_CONTENT=local` debug switch that refuses to activate when `RENDER=true`.
- Expected outcome: no user text in production logs.
- Dependencies: D-2. Risks: lost debugging detail (mitigated by the local switch). Tests: a test that drives `prepareTurn` with a sentinel string and asserts it never reaches captured stdout/stderr. Priority: **P0**.

**R-2 · Make the flag registry tell the truth** — *S, P0*
- Existing: `core/flags.js` registers `AQUA_GRAPH`, `AQUA_CIE` as default off; read sites default on; `AQUA_PROACTIVE` needs DB; `ARTIFACTS_ENABLED` unregistered ([Flag audit §1](AQUA_FEATURE_FLAG_AUDIT.md)).
- Proposal: correct the three entries; register `ARTIFACTS_ENABLED`; add a test that, for each gate, compares `resolveGate(g, undefined)` with the real enable function (the isolated probe used in this audit is the template); boot line prints effective values for gates with infrastructure dependencies ("PROACTIVE=on(no-db→inert)").
- Outcome: production configuration readable from one log line (enables D-5). Risks: none functional. Tests: the new default-parity test must fail on today's registry. Priority: **P0**.

**R-3 · Never let a failed boot hydration overwrite the mirror** — *S–M, P0*
- Existing: `hydrateFromMongo` continues on failure; first write's CAS conflict preserves the good copy and overwrites live; preserved generations pruned to 3 ([F-20](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md#f-20)).
- Proposal: a writer may not mirror a file until that file's hydration succeeded (or Mongo confirmed it absent); until then writes stay local and `/provider-health` reports `durable: false, reason: hydration-pending`; retry hydration in the background and merge before the first mirror write; never prune a preserved generation newer than the last successful hydration.
- Outcome: a Mongo outage during deploy degrades to "not durable yet", never to data loss. Risks: delayed durability during outages (already the case). Tests: mirror unit test with a fake collection — hydration throws, store writes, Mongo recovers → live doc unchanged until merge. Priority: **P0**.

### P1 — measure, then make context question-driven (brief Priority 1)

**R-4 · ACIB Stage A harness (model-free) — the first intelligence task** — *M, P1*
- Existing: answer harness, temporal/regime evals, recorded-context tooling ([ACIB §1](AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md)); nothing measures context recall/precision *per need* on `prepareTurn` across short/long regimes.
- Proposal: `aqua/scripts/acib-context.mjs` + `aqua/eval/datasets/acib.dev.v1.json` (the 76 dev scenarios, starting with the 6 decision scenarios and 6 missing-information scenarios); arms B, C (and C2 when a test DB is up); metrics per [ACIB §6](AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md); runs in CI without providers.
- Expected outcome: a baseline in which the audit's probe result ("Should I hire…" misses team and its change in the long regime) is a failing number, not an anecdote.
- Dependencies: none (D-3 only for Stage B). Risks: synthetic histories over-fit; mitigated by held-out authored separately. Tests: harness self-test with a hand-built prompt whose recall/precision is known. Priority: **P1 (first)**.

**R-5 · Information-needs model on the production path** — *L, P1*
- Existing: `queryPlan.js` slot templates, `isDecisionForm`, `assessSufficiency`, and the "Not known … ask once" renderer — all only inside CE V2 over canonical predicates ([Context §4](AQUA_CONTEXT_ENGINE_AUDIT.md)).
- Deficiency: production selects by "everything ≤8k chars" or by keyword; decision questions lose decisive context; missing information is never named ([F-05](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-05), [F-08](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-08)).
- Proposal: build one question representation per turn (shape, decision form, personal vs impersonal, entities, needs); map needs to resolvers over the stores production has (fact keys/categories, Mind goals/blockers/deadlines, need-expanded recall queries) and canonical predicates when present; render selected items plus an explicit unknown list. Reuse `queryPlan` (extend `P`/`TEMPLATES` with store-agnostic need ids) rather than adding a parallel planner. Behind a new gate, default off until ACIB says otherwise.
- Expected outcome (to be measured, not promised): context recall on decision/missing-info scenarios up in the long regime; unknown detection > 0 from 0; prompt tokens down on impersonal questions.
- Dependencies: R-4. Risks: need vocabularies are hand-built and can miss phrasings (the C9 synonym gaps are a precedent); mitigated by held-out and by keeping recall as a fallback lane. Tests: unit tests per need resolver; ACIB Stage A before/after; existing temporal/current-state dev sets must not regress. Priority: **P1**.

**R-6 · Gate always-on lanes by need** — *M, P1/P2 (can ship inside R-5)*
- Existing: cognitive block (goals, blockers, deadline, open question, prediction) every turn; whole-history recall every turn under 8k chars; graph multi-hop noise ([F-06](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-06)).
- Proposal: impersonal questions get no personal lanes; the cognitive block includes only items a need selected; the previous turn's question is never re-injected as an "open question" in another conversation; predictions are labelled inference and only shown when a need asks for them. `AQUA_MIND_RELEVANCE` (C9) is the existing partial implementation — evaluate it under ACIB and fold it in.
- Outcome: less noise and fewer tokens on most turns. Risks: dropping context a good answer would have used — exactly what ACIB precision/recall exposes. Priority: **P1/P2**.

### P2 — understanding that is captured, converged and scalable (brief Priorities 2–3)

**R-7 · Capture the state decisions depend on** — *M (legacy) / L (canonical), P2*
- Existing: rule extractors miss team composition, headcount changes, money raised, third-party attributes ([F-04](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-04)); E6 (LLM, typed claims with polarity/modality) exists but is off and needs Postgres to commit.
- Proposal: depends on D-1. Legacy: add schema keys + extractors for `team_members`/`team_size`, `funding`, departures/joins as transitions on those keys, and third-party attributes stored against the person (not the user). Canonical: run E6 on the ACIB dev histories (arm C2) to measure its capture before deciding to deploy.
- Risks: regex over-capture (documented precedent: "my manager is A and my accountant is B"); attribution errors ("I help X with her Y"). Tests: `capture-core`, `extraction-core`, `attribution-dev`, plus new ACIB capture metrics. Priority: **P2**.

**R-8 · Converge the stores (one writer per attribute)** — *L, P2*
- Existing: one fact in up to seven stores; `memory/propagation.js` (transition outbox, reconcile, sweeper) built and tested, default off ([Knowledge §4–5](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md)).
- Proposal: per D-1, declare the authoritative writer (fact store or claims); make Mind beliefs/graph edges/goals projections; measure propagation on ACIB correction and changed-goal scenarios and the existing `cross-store-consistency-eval.mjs` / `change-lifecycle-eval.mjs`, then default it on; unify the two goal stores' completion logic.
- Risks: reconciliation bugs mutate many stores at once — the 2026-11-04 crash-recovery tests are the guard. Priority: **P2**.

**R-9 · Per-owner persistence** — *L, P2*
- Existing: 25 whole-file JSON stores holding all users, rewritten every 500 ms and mirrored whole; single instance only; `AQUA_STORE_PG` per-owner blob shadow exists ([F-10](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-10)).
- Proposal: per-owner documents (Mongo collection keyed by owner+store, or Postgres `store_blobs` if D-1 = Postgres) with per-owner write paths; keep the in-memory cache; migrate with the existing loss-proof copy-verify-rename pattern.
- Outcome: write cost proportional to the active user; a corrupted write affects one user; storage-level isolation; horizontal scaling becomes possible. Risks: migration of production data — needs a rehearsal on a Mongo snapshot and explicit approval. Priority: **P2** (becomes P0 before any growth push).

**R-10 · Cost and latency trims** — *S–M, P2*
- Skip `canonicalSemanticScores` when no consumer is active ([F-13](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-13)).
- Stop personal questions at 0.45 from triggering reasoning pass + verification ([F-07](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-07)) — via R-5's question representation, not a threshold tweak.
- Self-knowledge block only for self/brand questions or a compact one-liner otherwise; reasoning directive not on simple factual questions ([F-17](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-17)).
- Don't compute Reflection V2 snapshots when apply is off ([F-18](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-18)).
- Measure with ACIB tokens/calls per turn. Priority: **P2**.

### P3 — reliability details, reflection, cross-domain (brief Priorities 4–6)

**R-11 · Turn-level memory consistency** — *M, P3*: defer durable memory writes from a failed (non-abort) turn, or persist the user message with an error marker so history and memory agree ([F-12](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-12)); purge `.bak`/aside files in account deletion and extend `purgeCompleteness.test.js` ([F-11](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-11)).

**R-12 · One meaning of "reflection"** — *L, P3*: four reflection modules (Mind, V2, V3, CIE) with different semantics. After D-1, keep one change detector vocabulary (`understanding/stateTransition.js`) and one reflection pipeline; retire the rest one at a time, each guarded by its existing eval suite. Not before R-8.

**R-13 · Cross-domain reasoning and personalised assistance** — *ongoing*: measured by ACIB categories "multi-conversation synthesis", "multiple files/projects" and D9; proactive interventions require D-1(b). No new subsystem until ACIB shows the gap is in reasoning rather than in context.

## 3. Suggested sequence

```
Week 1   R-1, R-2, R-3 (P0, small, independent)          → owner approves each
         R-4 ACIB Stage A + dev scenarios (decision, missing-info first)
Week 2-3 R-5 information needs (+ R-6 gating) behind a gate; ACIB A before/after
         D-1 informed by ACIB arm C2 on a disposable test DB
Week 4+  R-7 capture, R-10 trims; Stage B once D-3 is settled
Later    R-8 convergence, R-9 per-owner storage, R-11, R-12
```

Code changes require the owner's review of this audit first; commits and pushes only with explicit permission.
