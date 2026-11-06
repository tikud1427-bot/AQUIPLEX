# Aqua: from memory management to a living personal world model — architecture report (2026-11-02)

Main development tree, uncommitted. Lift v4b (pid 10568) untouched. No model calls, no downloads, no
Postgres. Every probe ran in a private temporary data directory. No baseline changed.

**Evidence base.** This report rests on three kinds of evidence:
- **Code reading**: every claim below names a file and function.
- **One end-to-end probe**: one evolving life, replayed through every production legacy writer
  (`memoryObserve`, `memoryAfterTurn`, `Brain.observeConversationTurn`, `Brain.observeTwin`),
  inspecting every store afterwards.
- **Today's six development evaluation sets**: 199 questions.

The probe's life:

1. "I'm a data analyst at Fintrail."
2. "My goal is to get promoted to senior analyst at Fintrail."
3. "I'm leading the Atlas migration at Fintrail; it's due on March 3."
4. "My manager is Priya Rao."
5. *A week later:* "I now work at Northbeam as a senior analyst."
6. "My manager is now Tom Ellis."

## 1. Actual production architecture

Production serves the **legacy read**. With no `DATABASE_URL`, `Brain.canonicalReadMode()`
(`brain/index.js`) returns `legacy`. Per turn (`routes/chat.js prepareTurn`):

| Stage | Code | Active in production |
|---|---|---|
| Write, before the answer | `memory/engine.js memoryObserve`: extraction (`candidateExtractor`, `memorySchema`) → one conflict resolver (`longTermMemory.storeResolved`) → corrections (step 4) → date/amount changes (`factChange.detectFactChanges`, 4a) → current-state resolution (`resolveCurrentState` + `applyCurrentState`, 4c) → Mind (`mind/index.js mindObserve`: beliefs, goals, working memory, episodes, graph) | always |
| Read: memory block | `memoryRetrieve`: IDENTITY card (`identity.js`) + USER PROFILE (`memoryRetriever.formatFactsForPrompt`) + COGNITIVE MODEL (`mind/mindRetriever.js`) + Mind graph recall + episodes + files | always (legacy mode) |
| Read: evidence block | PIC floor (`pic/retrievalIntelligence.retrieveKnowledge`), or the Context Engine (`brain/contextEngine`) if `AQUA_CONTEXT_V2=on` | facts exist only if `AQUA_BRAIN_INGEST(_FACTS)=on` (code default **off**; production value unverifiable) |
| Read: recall | `memory/episodicRecall.recallForTurn` over `conversationStore` | always |
| Prompt | `core/promptBuilder.buildSystemPrompt`: memory block first; evidence and recall last, fenced as untrusted | always |
| Post-turn | `routes/turnPostProcess.js`: `memoryAfterTurn` (Mind reflection, predictions), deferred `observeConversationTurn` (PIC facts, reasoning graph), `observeTwin`, PIC `consolidate`; E6 understanding → durable job queue → canonical claims | E6/canonical needs Postgres: **off in production** |
| Feedback | `pic/core.recordReasoningOutcome` (verification verdict → retrieval weight); Memory page `forget.forgetFact` / `correctFactEverywhere` (World Model + legacy + conversation lane + recall redactions); the user's later words | always |

**The canonical World Model is dark in production.** It is the one layer with typed, bitemporal,
supersedable claims (`core/db/migrations/0006_claims.sql`, `0008_world_model.sql`,
`core/claims/*`, `core/worldModel/*`). It needs Postgres, and its E6 extraction needs a provider.

## 2. Existing capabilities (verified)

| Capability | Where it really exists |
|---|---|
| Current value + history of a fact | legacy facts: `history` (`buildVersionHistory`), `transitions`, `ended`, scoped facts (today); canonical claims: `state`, `superseded_by` |
| Correction vs change distinguished | legacy rendering since today (`stateTransition.corrects`); canonical: `aqua_corrections` |
| Provenance | legacy: `sourceText`/`sourceMessage`/`sourceConversation`; PIC: evidence with turn citation; canonical: `aqua_evidence`, `aqua_claim_evidence`, `statement_text` |
| Confidence | legacy: one number; Mind beliefs: confidence + `basis` (user said / inferred); PIC: constant 0.60; canonical: vector (extraction / source / corroboration) |
| Observation vs inference | Mind labels beliefs "user said" vs "inferred, NN%"; PIC `epistemic: observed`; canonical `modality` + `actor` |
| Recorded time | everywhere (`createdAt`, `ts`, `asserted_at`) |
| **Valid time** (when it was true in the world) | **canonical only** (`valid_from` / `valid_to` / `time_precision`) |
| Entity↔entity relations | Mind graph (`relationshipGraph.js`: `part_of`, `works_on`, `targets`, `uses`, `related_to`); reasoning graph (`reasoning/reasoningGraph.js`: `about`, `mentions`); canonical `aqua_edges` (typed, valid-time, projected from claims; predicates incl. `depends_on`, `blocks`, `blocked_by`: `core/claims/predicateRegistry.js`) |
| Claim↔claim dependency ("this deadline depends on that blocker") | **nowhere** |
| Events / timeline | Mind `timeline` (goal_created / completed / abandoned, episodes); canonical `aqua_events` |
| Temporal state transitions | `understanding/stateTransition.js` (today): resolved / ended / changed / corrected, negation-, speculation- and intent-guarded, per clause; used by recall, PIC Lane 7, Context Engine seating, Mind working memory and goals, profile |

## 3. Data model analysis

**Where each kind of thing lives in production**: "—" means it is not represented.

| Kind | Legacy facts | Mind | PIC evidence + reasoning graph | Canonical (dark) |
|---|---|---|---|---|
| People | keyed slots (`custom_manager`, `spouse`, `children`) | graph `person` nodes | entity nodes (by name) | entities |
| Organizations | `workplace` (identity) | belief `organization`, graph node + `part_of` edge | entity node | entities |
| Projects | `project` collection | graph `project` nodes | entity node | entities |
| Goals | `goal`/`goals` collection | **goals** (lifecycle: active/blocked/completed/abandoned/changedBy) | sentence | `plans_to` claims |
| Preferences | `preference` collection (scoped, superseding — today) | beliefs PREFERENCES / COMMUNICATION | sentence | belief claims |
| Relationships | `relationship_status`, `spouse` | graph edges | entity co-mention | `aqua_edges` |
| Decisions | free-text `custom_*` at best | — | sentence (`polarity` read by `claimFidelity`) | `decided` / `rejected` predicates |
| Events | — | timeline (Mind's own lifecycle events only) | **dates become entity nodes** ("March 3" in the probe) | `aqua_events` |
| Commitments | — | (goals, if phrased as intention) | sentence | `plans_to` / intent modality |
| Resources / files | — | `files` | file UKOs (documents) | sources |
| Locations | `city`, `country` | — | entity | entities |
| Important dates | value text ("due on June 13") | working-memory deadlines (labels) | entity / sentence | `object_time_from` / `object_time_to` |

**Per-fact properties in production**:

| Property | Legacy facts | Mind | PIC |
|---|---|---|---|
| current | yes | yes | yes |
| historical | yes | partial (goal history, resolved blockers, past deadlines — today) | archived flag |
| provenance | sentence | evidence counts, not sentences | turn citation |
| confidence | one number | per belief | constant |
| valid time | **no** | deadlines as text | **no** |
| relations to other facts | **no** | via graph, entity-level only | entity-level |
| supersession | yes (history / transitions / ended) | goals, blockers, deadlines | duplicate consolidation + reflection |
| uncertainty / contradiction | `uncertain` note (today); `contradictions` counter | belief confidence | `disputed` flag |

## 4. Information lifecycle and data flows — what the probe showed

**One fact, six places.** After turn 1, "works at Fintrail" is held independently by:
- the legacy `workplace` fact, which is also the identity card;
- a Mind belief `identity:organization`;
- a Mind graph node `organization:Fintrail` and edge `self —part_of→ Fintrail`;
- a PIC evidence fact (the sentence);
- a reasoning-graph entity.

The goal is held in four places: the legacy `goal` fact, the Mind goal, a Mind graph node and edge, and
a PIC sentence.

**After "I now work at Northbeam as a senior analyst"**, state per store:

| Store | After the move | Status |
|---|---|---|
| legacy `workplace` / `profession` | Northbeam / senior analyst, with transitions | correct (after today's fixes, below) |
| identity card | Company: Northbeam | correct |
| PIC sentence "I'm a data analyst at Fintrail" | archived (step 4b retires sentences stating a replaced value) | correct |
| Mind belief `organization: Fintrail` | **still `active`, confidence 0.90**; only *hidden* at render time (`mindRetriever`, `retired`) | stale in the store |
| Mind graph edge `self —part_of→ Fintrail` | **still present**; graph recall would walk it for a question naming Fintrail | stale |
| Goal "get promoted to senior analyst **at Fintrail**" | **active** in the legacy fact, the Mind goal and the graph (`Active goals:` in every prompt) | stale dependent |
| "Atlas migration at Fintrail, due March 3" | **active** as `Current state: deadline: it's due on March 3` and a PIC sentence (the deadline label lost its subject: "it") | stale dependent |
| Digital Twin | holds behavioural patterns, not facts (0 mentions) | n/a |

**Two defects found by the probe and fixed today** (§10). Before the fixes, the same probe showed:
- the identity card saying `Company: Fintrail (since changed — they said: "My goal is to get
  promoted…")`: a **goal read as a change**;
- the move not applied at all: the goal shared "senior analyst" with it, so the match counted as
  **ambiguous**.

Neither was covered by the 199 labelled questions.

**Lifecycle failure points**:

| Kind of failure | Where |
|---|---|
| Information lost | Sentences with no entity never reach PIC unless they continue an earlier fact (`conversationFacts`). Deadline labels can lose their subject (`clauseWith` on "…; it's due on March 3"). Dates become entities, not times. E6's structured understanding never runs in production. |
| Duplicates | Six stores per identity fact; two goal stores (legacy `goal` collection + Mind goals) with separate completion logic (`laterWordsOnFacts` vs `goalTracker.laterWordOnGoals`). |
| Conflicting representations | Mind beliefs vs legacy facts: render-time reconciliation only. Mind graph never consults the facts. |
| Stale survival | Dependents of a changed fact (goals, deadlines, projects naming the old employer). PIC sentences of *ended* facts are not archived: step 4b fires only on value change. |
| Irrelevant context | The cognitive block (Current state, Active goals, Anticipated need) rides **every** turn regardless of the question (all 155 dev questions carried a Current state line). |
| Updates fail to propagate | Legacy fact → Mind belief, Mind graph, dependents; Mind goal ↔ legacy goal fact. |
| Observation vs inference | Well separated in Mind beliefs and canonical modality. Blurred in legacy free-text facts: "I'm X" becomes a `custom_*` fact; the transient guard covers only known states. Mind predictions ("Likely preparing for …", p=0.7) are inferences presented beside facts. |

## 5. Cross-domain relationships

**What exists:**
- Entity-level links: Mind graph `targets` / `works_on` / `part_of` / `related_to`; reasoning-graph
  `about`; canonical typed edges with `depends_on` / `blocks`.
- Retrieval can follow them:
  - PIC Lane 3 hops `about` edges from named entities;
  - PIC Lane 7 and the Context Engine seat a later statement beside the one it continues;
  - Mind graph recall walks two hops.

**What does not exist:**
- Any mechanism that, when one fact changes, finds and re-evaluates the facts that **depend** on it.
  The probe's job change left the employer-anchored goal and deadline active.
- Claim-to-claim dependencies: "the launch date depends on the FDA letter" is two sentences
  connected only by shared words.
- Consequence reasoning: a new client → revenue expectations; a financial decision → plans. Nothing
  represents expectations or plans as quantities with drivers, and inventing such links without the
  user's words would be guessing.

**Biggest limitation:** *change does not travel along existing links.* The links are there (shared
named entities: "Fintrail" in the job, the goal and the project), but no lifecycle uses them when a
fact transitions.

## 6. Architectural gaps (concrete)

1. **No single owner of current state.** Five writers keep their own copy of the same fact and
   reconcile only at render time (`mindRetriever` `retired`, today), or not at all.
2. **No change propagation along entity links** (§5).
3. **No valid time in production.** "Due on June 13" is text. No store can answer "what was true in
   March". Dates are entities in PIC.
4. **The best data model is dark.** Canonical claims (bitemporal, typed, supersedable, vector
   confidence) need Postgres and a provider. Production reasons over key/value facts and sentences.
5. **Context is not question-gated in the cognitive block.** Stale or irrelevant state and inferred
   predictions reach every answer.
6. **No answer-level measurement.** Every gain since this morning is a context gain.

## 7. Five highest-impact opportunities, ranked

1–5 scale, where 5 = most favourable (high impact, high feasibility, low risk, low cost, high gain).

| # | Opportunity | User impact | Feasibility | Reliability risk | Cost | Gain in contextual intelligence | Why |
|---|---|---|---|---|---|---|---|
| 1 | **One change, every store**: a single transition event from the legacy engine applied to Mind beliefs, Mind graph, both goal stores and PIC sentences | 5 | 5 | 4 | 4 | 4 | The probe's stale Mind belief, graph edge, ended-fact sentences and duplicate goal logic all come from one missing step. Existing functions, no new store |
| 2 | **Dependents flagged, not guessed**: when an entity value is retired (left an employer, sold a car, a blocker resolved), current goals, deadlines and projects that *name* it are marked "may be affected by: <the user's sentence>" | 5 | 4 | 3 | 4 | 5 | The first real "what depends on it". Deterministic (shared named entity), never auto-closes anything, the user's words as provenance |
| 3 | **Valid time on legacy facts**: `validFrom` / `validTo` read from the user's dates and transitions; deadlines keep their subject | 4 | 4 | 4 | 3 | 4 | Enables "what was true then" and date-aware staleness; reuses `datesIn`, transitions, `clauseWith` |
| 4 | **Question-gated cognitive block**: Current state / Anticipated need shown when relevant, inferences labelled as such | 3 | 4 | 4 | 4 | 3 | Less noise and less stale exposure on every turn; measurable with existing relevance metrics |
| 5 | **Converge on the claim shape, not on a new store**: give legacy facts the canonical claim's fields (predicate-like slot, polarity, modality, valid time, confidence parts) so the dark World Model and the live store describe facts the same way | 4 | 2 | 3 | 2 | 4 | The long-term coherent model. Only after 1–3, and after Lift decides the World Model's role |

## 8. Recommended implementation sequence

1. **Milestone 1: one change, every store** (§10). Measurable with the probe.
2. **Answer-level validation**, as soon as a non-shared model is available. Recorded before/after
   contexts exist (`eval/out/contexts.*`). Prompt-affecting milestones (2, 4) should not ship on
   context metrics alone.
3. **Dependent flags** (opportunity 2), on top of milestone 1's transition event.
4. **Valid time + deadline subjects** (opportunity 3).
5. **Question-gated cognitive block** (opportunity 4).
6. **Claim-shape convergence** (opportunity 5), when Lift v4 has decided the World Model's place.

## 9. What should NOT be built

- **A new memory store, graph database or vector store.** There are already six places for one
  fact; a seventh makes it worse.
- **An LLM "world-model agent"** to resolve supersession or infer consequences. Today's results came
  from deterministic, testable rules over the user's own words.
- **Automatic consequence inference** ("new job → goal achieved", "new client → revenue up"). Flag
  dependents; never decide for the user.
- **More annotation types in the prompt.** Today moved from notes to current values; the next step
  is fewer markers, not more.
- **Synonym tables or embedding thresholds tuned to the dev sets.**
- **Expanding the Digital Twin or predictions** before facts agree across stores.
- **Moving production to the canonical World Model** before Lift v4 answers whether it helps.

## 10. Concrete first implementation milestone: "One change, every store"

**Goal.** When the legacy engine records a transition (replace / end / correction / completed goal),
every other production store that holds the old value agrees within the same turn. History is kept;
nothing is deleted.

**Scope (existing functions only):**
- **Emit.** `memory/engine.js` step 4c (`applyCurrentState`), step 4 (corrections) and step 4a
  (`detectFactChanges`) produce one list of transitions `{key, from, to, kind, text, at}`. The data is
  already in `fact.transitions` / `history` / `ended`.
- **Mind beliefs.** `mind/beliefEngine.js`: a belief whose value equals a transition's `from` gets
  `status: superseded` with the transition as evidence. This replaces today's render-time filter
  with stored state.
- **Mind graph.** `mind/relationshipGraph.js`: edges to the old node (e.g. `part_of → Fintrail`)
  get `validTo` + `endedBy`. `graphRecall` skips them unless the question is about the past.
- **Goals.** One completion path for both goal stores. When `goalTracker.laterWordOnGoals`
  completes or abandons a goal, the legacy `goal` collection item retires (`applyCurrentState` end),
  and vice versa.
- **PIC.** Extend step 4b (`retireSupersededInBackground`) from "value changed" to "value changed
  or ended".

**Acceptance (deterministic, isolated):** extend the probe into a test
(`src/memory/tests/oneChangeEveryStore.test.js`).
- After the move: **0** stores assert Fintrail as current. Today: Mind belief (active), Mind graph
  edge.
- The old value stays retrievable as history in each store.
- The six dev sets show no regression (`authority-recompute.mjs`).
- Every mechanism has a test that fails when it is disabled.

**Not in scope:** dependents (milestone 3), prompt wording, the World Model.

### Implemented in this mission (small, evidenced, independently safe)

Two defects found by the probe, both in today's earlier work:

1. **An intention is not a change.** `stateTransition.changeKind` now ignores goal, aim, plan and
   "trying to" statements (`intends`). Before, "My goal is to get promoted … at Fintrail" put
   `Company: Fintrail (since changed — …)` on the identity card.
2. **A slot rule beats shared words.** In `factChange.laterWordsOnFacts`, an employment or
   relocation statement links to `workplace` / `city` even when another fact shares words with it.
   Before, "I now work at Northbeam as a senior analyst" changed nothing, because the goal shared
   "senior analyst".

Tests: two new tests in `src/memory/tests/profileLaterWords.test.js` (31 tests). Each fix, when
disabled, fails its test. The six dev sets are unchanged:
- outdated-as-current 1/90;
- correct current 9/9;
- false updates 0/12;
- history 9/9;
- combined stale-without-update 2.2%.

**Full DB-free test run.**
- 2,732 tests: 2,724 pass, 0 fail, 8 skipped (the Postgres-only tests).

**Evaluation gate.**
- 16 of 17 DB-free suites pass.
- capture-core is still BLOCKED. Its counts improved: fully captured cases went from 19 to 20, and
  not-captured cases from 2 to 1. The gate blocks it because it treats any change in these
  `n_cases_*` counts as a change in the dataset itself. The baseline was not changed.
