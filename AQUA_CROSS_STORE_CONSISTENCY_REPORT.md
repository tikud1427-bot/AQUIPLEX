# Aqua: one change, every store — cross-store consistency report (2026-11-02)

Main development tree, uncommitted.

**Constraints observed:**
- Lift v4b (pid 10568) untouched.
- No model calls, no downloads, no Postgres.
- Every run used a private temporary data directory. One exception: an import check read the real `~/.aquiplex` stores without writing anything (see "Incident" at the end).
- No baseline or frozen file changed.

**The fix in short.** When the user says "I now work at Northbeam", the change is now recorded once, as a transition on the fact. Every store that held "Fintrail" as current then agrees within the same turn, and keeps Fintrail as history. Things that name Fintrail (a goal, a deadline, a sentence) are flagged as uncertain. Nothing is closed or deleted.

**Measured on two simulated lives** (A: development, B: written afterwards), each through all production legacy writers:

| | Propagation off | Propagation on |
|---|---|---|
| Outdated-as-current records | 4–7 | **0** |
| Changes consistent in every store | 1/3 | **3/3** |
| Dependent records flagged | 0 | **all** (5–8 per run) |
| False flags on controls | 0 | **0** (after one guard fix found by life B) |

The mechanism also recovers from:
- a stage failing part-way;
- an evidence-lane failure;
- an older copy brought back by the two-process merge;
- a forget;
- a return to the old value.

The 199 development questions are unchanged: outdated-as-current 1/90, correct current 9/9, false updates 0/12. Prompt size changes by +3 tokens per question (dev-env) and 0 (code-defaults).

**Measurement limits:**
- Everything here is measured at store level and on the memory block.
- **No answers were generated.**
- Consistency is not atomic across the two files involved (section 5).

---

## 1. Production writers and readers

**Writers** (legacy production path: no `DATABASE_URL`).

| Writer | When | Writes |
|---|---|---|
| `memory/engine.js memoryObserve` | synchronously on the request path, no `await` | **One per-owner Mind document**, in `.aqua-mind.json` via `mind/mindStore.js`. It holds: legacy facts (`storeFacts`, 2b preference supersession, 3 forget, 4 correction, 4a `detectFactChanges`, 4c `applyCurrentState` / `noteLaterWord`); then `mindObserve`: beliefs (`observers.js FACT_TO_BELIEF` → `beliefEngine.observeSignal`), goals (`goalTracker.trackGoals`), working memory (deadlines, blockers), episodes, graph (`relationshipGraph.updateGraph`). |
| `memoryAfterTurn` | after the reply | predictions (`predictionEngine`), reflection scheduling |
| `Brain.observeConversationTurn` | deferred after the turn (`routes/turnPostProcess.js`), only with `AQUA_BRAIN_INGEST(_FACTS)` on | evidence sentences (`files/evidenceStore.js`, its own file); reasoning-graph entities (`reasoning/reasoningGraph.js`, its own file) |
| `Brain.observeTwin` | after the turn | behavioural patterns, no facts |
| `memory/forget.js` | Memory page | `forgetFact`, `forgetClaim`, `correctClaimValue`, `forgetAllFacts`: World Model (if configured), recall redactions, legacy facts |
| `memory/memoryEditor.js` | Memory page | `correctFact`, `replaceFact`, merge, split, archive: legacy facts only |
| E6, canonical World Model | durable job queue | Postgres only: **off in production** |

**Persistence and failure units:**
- **The Mind document.** Facts and every Mind store live in one object per owner. It is written by one debounced, atomic temp-file-plus-rename flush. Everything a turn changes in it lands in the same flush.
- **The two-process merge.** Server and worker share the file. `mergeConcurrent` merges facts per key (newer wins) and beliefs and goals by item time. For graph nodes and edges it keeps "ours if present", so a graph edit by the other process can be lost.
- **The evidence store and reasoning graph** are separate files with separate flushes. No transaction spans them and the Mind document.

**Identifiers that connect the copies.** There is no shared ID across stores. The links are:

| Store | Key |
|---|---|
| Legacy fact | `owner:key` |
| Mind belief | `dimension:key`, via the fixed `FACT_TO_BELIEF` map (`workplace` → `identity:organization`) |
| Graph node | `type:label` |
| Graph edge | `from\|type\|to`, via the fixed fact-key → relation map in `updateGraph` (`workplace` → `part_of` an organization) |
| Goal | random ID; title only |
| Deadline | label text |
| Evidence sentence | random ID; statement text, conversation evidence |

The only reliable joins are therefore **fact key → belief key and graph relation** (a code mapping) plus **value equality**. Anything else can only be found by the name it mentions.

**Readers that present something as current:**
- **Identity card** (`identity.js`): from facts.
- **USER PROFILE** (`memoryRetriever.factPromptLine`).
- **COGNITIVE MODEL** (`mindRetriever.retrieveCognitiveContext`): beliefs, active goals, current state (deadlines, blockers), anticipated need (predictions), and "Related:" (graph `neighborhood`).
- **Graph recall** (`graphRecall.recallGraphPaths`).
- **Evidence block**: `pic/retrievalIntelligence` (PIC floor) or `brain/contextEngine/assembler`.
- **Episodic recall**: verbatim quotes.
- **Memory page and Mind routes**: not changed or measured here.

## 2. Existing store relationships (before this work)

The architecture probe (`AQUA_LIVING_WORLD_MODEL_ARCHITECTURE_REPORT.md` §4) found one fact held in six places, with change applied to one. Re-measured with the new evaluation and propagation off, life A, dev-env, the employer change left:
- the Mind belief `organization: Fintrail` **active**, hidden only by a render-time filter;
- the graph edge `self —part_of→ Fintrail` **open**, so graph recall walks it;
- the goal "get promoted … at Fintrail", the Atlas deadline, the loan-paperwork deadline and their sentences all **current with no mark**. The cognitive model rendered "Current state: deadline: I need to send Derek Shaw the bank statements" and "Anticipated need: Likely preparing for: …Derek Shaw…" after Derek Shaw had been replaced.

Pre-existing defects found while tracing (all fixed, §4):
- **(a) Current sentences retired.** Step 4b retired the evidence sentence of a **still-current** collection item whenever the collection merged. With propagation off, life B, the sentence "My goal is to open a bakery in Austin" was archived when an unrelated goal was added.
- **(b) Forget left copies.** Forgetting a fact left the Mind belief and graph edge holding the forgotten value.
- **(c) Change history erased.** An overwrite through `storeFact` / `storeResolved` dropped the fact's `transitions`.
- **(d) Deadline subject lost.** A deadline label lost its subject ("it's due on March 3").
- **(e) Punctuation in values.** A relocation stored "Austin." with the full stop, so the value never compared equal again.
- **(f) A current value hidden.** The render-time `retired` list hid a value that had become current again.

## 3. State-transition design

One transition per change, stored **on the fact itself** (`fact.transitions`; `memory/propagation.js recordTransitions`). It is built from the fact store's own before/after comparison within one turn:

```
{ id,          // stable: sha1(owner, key, from, to, the user's sentence) — same change, same id
  key, from, to,          // to = null when the fact or a collection item ended
  kind,                   // the resolver's kind: changed | ended | corrected | resolved | …
  text,                   // the user's sentence (provenance)
  at,                     // recorded time
  effective,              // a date the user named in the sentence, else null — nothing inferred
  item?,                  // a collection item retired, not the whole fact
  fromSource,             // the sentence that stated the old value (to retire it in the evidence lane)
  provenance: { conversationId, requestId, source: 'user_statement' },
  confidence }            // the fact's confidence
```

**Rules:**
- A transition exists only where the fact store's value changed:
  - an extractor overwrite;
  - a correction;
  - a `detectFactChanges` date change;
  - a 4c later-word replace, end or collection-item end;
  - a 2b preference supersession.
- A fact that disappeared was forgotten, which is not a change.
- A fact that is new was set, not changed.
- A transition **is live** while what it retired is not current again. "Back at Fintrail" makes the Fintrail → Northbeam transition non-live and releases everything it set.
- Transitions now survive later overwrites (`longTermMemory.storeFact` / `storeResolved` carry them forward), capped at 10 per fact.

The resolver's `kind` is kept, so a correction remains a correction. The profile shows no "previously" after a correction, as before.

## 4. Propagation implementation

Propagation is **reconciliation**: `reconcileMind(owner)` derives what each Mind store should say from the live transitions and fixes only what disagrees. It runs in `memoryObserve` step 5b, after the Mind has observed the turn, on **every** turn. Re-running it changes nothing.

| Store | On a live transition | Matching |
|---|---|---|
| Mind belief | holding the old value → new value (old one to `history` with `transitionId`); fact ended → `archived` | fact key → belief key (`FACT_TO_BELIEF`) + value equality |
| Mind graph | `self → old` edge gets `endedAt` / `endedBy`; `self → new` edge created as `updateGraph` would | fact key → relation + node `type:label` |
| Goals (Mind) | `review = { transitionId, text, at, value }`; status unchanged | proper name, whole word (below) |
| Deadlines, blockers | `review` | same |
| Other legacy facts (goal / project collections, free text) | `reviews[]`, per collection item | same |
| Evidence sentences | sentence that stated the old value archived (`retireSupersededStatement`, existing); dependent sentences get `review` | background, `propagateToEvidence` |
| Reasoning graph | no change: entity nodes are names, not state; archived sentences are already excluded at retrieval | n/a |
| Identity card, profile | already read from facts | n/a |

**Dependents, conservatively.** A record depends on a transition only when all of these hold:
- it **names the old value as a proper name**, whole word (`namedValue`, `anchorsOf`). "Derek Shaw at Lone Star Bank" is looked for as "Derek Shaw"; the bank did not change.
- it was said **before** the change;
- it does **not** name the new value;
- it is **not** past tense ("I learned SQL at Fintrail", "I grew up in Austin");
- it is **not** about someone else's relation ("My friend Sam works at Fintrail").

Descriptions ("data analyst", preferences) never flag dependents. Dependents are **never** completed, closed, archived or deleted.

**Reading the flags.** Flags render with the existing uncertainty marker, so no new prompt vocabulary was added: `"get promoted to senior analyst at Fintrail" (uncertain whether still current — they said: "I now work at Northbeam as a senior analyst.")`. The evidence block (PIC floor and Context Engine) shows `uncertain whether still current — they later said: "…"`. Other readers changed as follows:
- predictions no longer forecast from a flagged goal or deadline;
- graph recall and `neighborhood` skip ended edges;
- the render-time `retired` list no longer hides a value that is current again.

**Release.** A transition that stops being live releases what it set:
- reviews are removed;
- an ended edge reopens, but only when its value is current again, not when the fact was forgotten.

**Forget.** `forget.forgetFact`, `forgetClaim`, `correctClaimValue`, `forgetAllFacts` and the chat "forget my X" step now also:
- remove the Mind belief and graph edge holding the forgotten value (`forgetValueInMind`);
- release every review quoting the forgotten fact's change, in the Mind and in the evidence lane (`releaseAfterForget`).

**Smaller fixes made for this:**
- `observers.js`: a deadline clause that opens on a pronoun keeps the clause it refers to.
- `factChange.clean`: strips the sentence's full stop from a value.

**Kill switch.** `AQUA_PROPAGATION=off` disables recording and reconciliation, and restores the old step 4b.

**Files.**
- New: `src/memory/propagation.js`, `src/memory/tests/oneChangeEveryStore.test.js`, `scripts/cross-store-consistency-eval.mjs`.
- Changed:
  - `memory/engine.js`, `longTermMemory.js`, `forget.js`, `memoryRetriever.js`, `factChange.js`;
  - `mind/observers.js` (export plus deadline label), `mindRetriever.js`, `graphRecall.js`, `relationshipGraph.js`, `predictionEngine.js`;
  - `pic/retrievalIntelligence.js`, `brain/contextEngine/index.js`, `assembler.js`.

## 5. Failure and retry behaviour (what is and is not guaranteed)

| Situation | Behaviour | Evidence |
|---|---|---|
| One Mind stage throws (beliefs, graph or dependents) | earlier stages stay done; the turn continues; the next turn's reconciliation completes the rest | eval F1, test "fails part-way" |
| Evidence-lane step throws | `picAttempts` +1, no `pic` stamp; retried on later turns, at most 5 attempts | eval F2, test "retried" |
| Same message twice (client retry, duplicate event) | same transition ID; nothing recorded twice; history, belief history, reviews and edges identical | eval replay, test "changes nothing" |
| Older copy restored (two-process merge, `mergeConcurrent` graph rule) | repaired on the owner's next turn | eval F3, test "older copy" |
| Concurrent turns, same owner, same process | `memoryObserve` has no `await`, so writes are serialised. Overlapping background evidence steps are idempotent (archived filter; same review overwritten). | code |
| Other account | untouched; IDs are owner-scoped | eval isolation, test |
| User forgets the fact | reviews quoting it removed everywhere; belief and edge removed | eval F4, test |
| User returns to the old value | everything released; belief and edge back | eval F5, test |

**Not guaranteed:**
- **No atomicity across the two files.** The Mind document and the evidence file flush independently (debounced). In memory, the evidence step reads the transitions, so it can lag the Mind but not lead it. On disk, after a crash inside the flush window, either file can be ahead. When the Mind file is behind, the turn's whole fact change is lost with it, and an evidence sentence may already be archived.
- **Repair needs a later turn.** It happens when the owner speaks again; there is no background sweeper.
- **Bounded retries.** After 5 failed evidence attempts a transition is no longer retried.
- **Graph edits can be lost to the other process.** The two-process merge's graph rule can still drop an edit; reconciliation repairs it, but only on that owner's next turn.

## 6. End-to-end evaluation

`node scripts/cross-store-consistency-eval.mjs --life a|b --profile dev-env|code-defaults --propagation on|off [--json out]`

The simulation:
- runs the real `memoryObserve`, `memoryAfterTurn`, `Brain.observeConversationTurn` and `Brain.observeTwin`;
- uses a simulated clock and a private data directory;
- runs every store's inspection after each change.

**Life A** (development: the life the mechanism was built and debugged against):
- **Setup:** works at Fintrail; promotion goal at Fintrail; Atlas migration deadline at Fintrail; loan contact Derek Shaw; a deadline to send him statements; a long-answers preference.
- **Controls:** manager Priya Rao; "I learned SQL at Fintrail"; "My friend Sam works at Fintrail"; a half-marathon goal.
- **Changes:** moves to Northbeam as senior analyst; Derek Shaw replaced by Kim Alvarez; "Actually, I now prefer short bullet-point answers".

**Life B** (written after the code, other names and attributes, run once before any change for it):
- **Setup:** lives in Austin; bakery-in-Austin goal; Austin lease renewal deadline; manager Priya Rao with a report deadline; email preference.
- **Controls:** "My sister lives in Austin"; "I grew up in Austin"; a reading goal; accountant Lena Ortiz.
- **Changes:** "We moved to Denver last month"; "My manager is now Tom Ellis"; "Actually, I now prefer phone calls".

Life B's first run found two things:
- a false flag ("I grew up in Austin", whose past-tense form was missing from the guard);
- the revert defect (§2e: "Austin." kept the move's reviews live after "We moved back to Austin").

Both were fixed, and life B is therefore no longer independent. Reported below as measured after the fixes, with the first run noted.

**Measured per store:**
- **Outdated-as-current:** the legacy fact, any active belief, any open self edge, the unarchived sentence that stated the old value, and memory-block lines naming the old value with no history or uncertainty marker.
- **History:** whether each store that held the old value as current before the change still holds it as history.
- **Dependents:** labelled records in each store, and whether each is flagged.
- **Controls, replay, isolation, failures F1–F5.**

## 7. Before and after measurements

Store level, all three changes, final state:

| Life / profile | Propagation | Outdated as current | Consistent changes | History kept | Dependents flagged | Dependents closed | Control false flags |
|---|---|---|---|---|---|---|---|
| A / dev-env | off | 7 | 1/3 | 9/11 | 0/7 | 0 | 0/7 |
| A / dev-env | **on** | **0** | **3/3** | **11/11** | **8/8** | 0 | 0/7 |
| A / code-defaults | off | 7 | 1/3 | 5/7 | 0/5 | 0 | 0/3 |
| A / code-defaults | **on** | **0** | **3/3** | **7/7** | **5/5** | 0 | 0/3 |
| B / dev-env | off | 4 | 1/3 | 5/5 | 0/7 | 0 | 0/6 |
| B / dev-env | **on** | **0** | **3/3** | 5/5 | **8/8** | 0 | 0/6 (first run: 1/6) |
| B / code-defaults | off | 4 | 1/3 | 2/2 | 0/5 | 0 | 0/2 |
| B / code-defaults | **on** | **0** | **3/3** | 2/2 | **5/5** | 0 | 0/2 |

"Off" still includes the deadline-label and value-punctuation fixes, which are not behind the switch.

**Reliability (propagation on, all four runs):**
- Replay of the same message changed nothing.
- 0 duplicate transition IDs.
- The other account had 0 transitions, 0 reviews and 0 ended edges.
- **F1, a Mind stage fails:** 1–2 outdated records after the failing turn → 0 after the next turn.
- **F2, the evidence step fails:** 1 attempt recorded → done on the next turn.
- **F3, an older copy is restored:** 1–4 outdated → 0, dependents re-flagged.
- **F4, forget:** 3–6 reviews quoting the forgotten sentence → 0; belief and edge holding the forgotten value → 0.
- **F5, return to the old value:** 0 reviews left; edge reopened; belief restored.

**Development sets.** 199 questions, `temporal-resolution-eval` + `authority-recompute`, short regime, `AQUA_RECALL_ALL_CHARS=0` as in every earlier run:

| | Earlier recorded | Propagation off | Propagation on |
|---|---|---|---|
| dev-env: outdated-as-current | 1/90 (p06-q1) | 1/90 | 1/90 |
| dev-env: correct current / false updates / history | 9/9, 0/12, 9/9 | same | same |
| dev-env: tokens per question | 749 | 749 | 752 |
| code-defaults: outdated / correct / false / history | 1/90, 9/9, 0/12, 8/9 | same | same |
| code-defaults: tokens per question | 526 | 526 | 526 |

Those sets rarely contain a fact that something else names, which is why they do not move. They confirm there is no regression; they do not measure propagation.

A first run forgot `AQUA_RECALL_ALL_CHARS=0` and showed about +50% tokens. That growth was the whole-history recall mode, identical with propagation off. Measurement setup, not the change.

**Tests.** `src/memory/tests/oneChangeEveryStore.test.js` has 12 tests, all passing. Each of 12 mechanisms was disabled in turn, and each disabling failed at least one test:
- belief, graph and dependent stages;
- the past-tense and someone-else guards;
- ID de-duplication;
- reconciliation on every turn rather than once;
- evidence retry;
- forget of Mind copies;
- forget release;
- revert release;
- the kill switch.

**Full DB-free test run.**
- 2,745 tests: 2,724 pass, 8 skipped (the Postgres-only tests), 13 failed.
- All 13 failures were in `src/brain` embedding-fixture tests, which had passed in the previous run.
- Re-run on their own and as the whole `src/brain` directory twice: 1,342 tests, 0 failures. I did not find the cause; the failures look transient and did not reproduce.

**Evaluation gate.**
- 16 of 17 DB-free suites pass, as before.
- capture-core is still BLOCKED, but its numbers improved: fully captured cases went from 19 to 20. The gate counts any change in its `n_cases_*` counts as a change to the dataset itself, so it blocks. Baseline untouched.

## 8. Remaining inconsistencies

1. **Memory-page edits do not propagate.** `memoryEditor.correctFact` / `replaceFact` change the legacy fact without a transition, so beliefs, graph and dependents do not follow. The chat path and the forget paths are covered; the editor is not.
2. **Two goal stores still decide completion separately**: the legacy `goal` collection (`factChange`) and Mind goals (`goalTracker.laterWordOnGoals`).
3. **Episodic recall** quotes old sentences verbatim. Its "since changed" notes come from the World Model (Postgres) and the resolution tier, not from these transitions. Recall was not part of this evaluation.
4. **Dependents are found by name only.** Missed: aliases ("FT"), pronouns ("they want the report"), paraphrase. Possible false flags: homonyms ("Austin" the colleague vs the city). Only proper-name values have dependents at all.
5. **Extraction gaps stop propagation before it starts.** "Our loan officer is Derek Shaw." creates no fact, so a later change has nothing to update. The evaluation uses a phrasing the extractor knows.
6. **Not atomic across files;** repair needs the owner's next turn; at most 5 evidence retries (§5).
7. **The evidence step scans all of an owner's evidence sentences** for each pending transition, which is linear in the owner's history.
8. **Effective time** is only a date phrase the user said. There is no valid-time model in the legacy stores.
9. **Unverified readers:** the Memory page, the Understanding card (`mindRoutes`) and the Digital Twin were not checked for how they show `review` or ended edges.
10. **No answer-level measurement.** Whether the model asks rather than assumes on a flagged goal is untested.

## 9. Recommended next milestone

**Route every change through one transition, and measure answers.**

1. **Close the remaining change sources:**
   - `memoryEditor` correct/replace records a transition (the same `recordTransitions` diff around the edit);
   - goal completion in either store becomes a transition the other store reconciles from.

   Acceptance: the existing evaluation extended with a Memory-page edit and a goal completion, 0 outdated records, a bite test per path.
2. **Answer-level check on the recorded contexts.** As soon as a non-shared local or free model is available, run the context pairs this evaluation can emit, propagation off vs on, and judge: does the answer treat Northbeam as the employer, and does it ask about the Fintrail goal rather than assume either way? Prompt-affecting work should not expand further on context metrics alone.
3. **Only then:** valid time on legacy facts (`validFrom` / `validTo` from transitions and dates), and alias-aware dependents.

---

**Incident.** During development, a syntax check (`node -e "import('./memory/engine.js')"`) ran without the isolation import. It loaded the real `~/.aquiplex` stores into memory: 102 minds, 311 conversations, a vector index. No observe or write call ran, and no file was modified: the newest timestamps there are Oct 29, checked afterwards. All later runs imported `eval/core/isolateDataDir.mjs` first.
