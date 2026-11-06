# Aqua: unified change lifecycle and reliable reconciliation — report (2026-11-04)

Main development tree, uncommitted.

**Constraints observed:**
- Lift v4b (pid 10568) untouched.
- No model calls, no downloads, no Postgres.
- Every run used a private temporary data directory, and no real user store was accessed.
- No baseline or frozen file changed.

**The result in short.** Every user-facing way of changing a fact now goes through the one transition lifecycle built in `AQUA_CROSS_STORE_CONSISTENCY_REPORT.md`. Paths covered:
- chat;
- the Memory page: correct, replace, archive, restore, merge, split, delete;
- the Understanding page: belief edit, goal status, goal delete.

A Memory-page correction and a chat correction now leave every store saying the same thing. Before, a Memory-page correction changed only the legacy fact: 1 of 4 stores. Now 4 of 4.

**Repair no longer waits for the user's next message.** The transition record doubles as a durable outbox. Writes are ordered write-ahead, failures back off and are dead-lettered after 8 attempts, a sweeper runs every minute and once shortly after boot, and an owner-scoped diagnostics endpoint shows what is pending or dead. A real process killed mid-propagation lost no change; the next process finished it without duplicating anything.

**The two goal stores now agree** when the user closes a goal on the Understanding page. Before, the profile kept it open. Related-fact changes still never close a goal.

**Dependency matching now also uses:**
- acronyms of names with three or more words;
- aliases the entity resolver already merged;
- a pronoun with exactly one referent.

Ambiguous pronouns, role references ("my manager"), past-tense statements and third parties stay untouched: 0 false flags on the controls.

**Test instability: cause not established.** Two mechanisms are ruled out, and one real hazard was found (§6).

As before, every gain is measured at store and context level. **No answers were generated.**

---

## 1. Every identified change path

Inventory: `routes/memory.js`, `mind/mindRoutes.js`, `routes/brain.js`, `memory/engine.js`, `memory/memoryEditor.js`, `memory/forget.js`, `mind/goalTracker.js`.

| Path | Operation | Before | Now |
|---|---|---|---|
| Chat (`memoryObserve`) | create / change / correct / end / complete | transitions + reconciliation (previous mission) | unchanged; plus pronoun referents and goal sync |
| Chat: "forget my X" | forget | fact deleted, World Model + recall redacted, Mind copies removed | unchanged |
| `POST /memory/fact` mode `correct` | correct | **legacy fact only**: belief, graph, evidence lane and dependents kept the old value | `withTransitions`, kind `corrected`, source `memory_page` |
| `POST /memory/fact` mode `replace` | change | legacy fact only | same, kind `changed` |
| `POST /memory/fact/:key/split-item` | correct a collection | legacy only | via `correctFact`, covered |
| `POST /memory/fact/:key/archive` | archive / restore | legacy only (`status: archived`); Mind copies and the sentence kept answering | kind `archived`: belief archived, edge ended, sentence retired; **no dependents flagged** (an archive is not a change in the world); restore releases all of it |
| `POST /memory/merge`, `/fact/:key/split` | merge / split | legacy only | kinds `merged` / `split` (archive kinds); split parts that overwrite an existing key are `changed` |
| `DELETE /memory/fact/:key`, `DELETE /memory` | forget / forget all | forget everywhere + release (previous mission) | unchanged |
| `POST /memory/fact/:key/pin`, `/keep`, `/confirm` | metadata | n/a | not changes of value; not routed (correct) |
| `PATCH /mind/beliefs/:dim/:key` | correct a belief | belief only: **a second current value** beside the fact | a belief bridged from a fact (`FACT_TO_BELIEF`) is corrected **as that fact** (source `understanding_card`); other beliefs are unchanged |
| `DELETE /mind/beliefs/:dim/:key` | delete an inference | belief only | unchanged, by decision: deleting an inference is not forgetting the fact (the Memory page delete is) |
| `PATCH /mind/goals/:id` (status) | complete / abandon / reopen | Mind goal only; the profile's goal list kept it open | goal sync in reconciliation |
| `DELETE /mind/goals/:id` | delete goal | Mind goal only; the legacy item and the sentence kept answering | `forgetGoal`: World Model first (fails closed), recall redaction, legacy item removed from value, history, retired items and transitions; graph node and edges removed |
| `POST /mind/goals/:id/split` | split goal | Mind only | **not routed** (remaining, §8) |
| `/brain/claims/:id/correct`, `/forget`, `/correct-value` | World Model | Postgres; legacy copies deleted (`forgetClaim`, `correctClaimValue`) + release | unchanged; not exercised (no Postgres) |
| Reflection (`reflection: unmentioned` → stale) | decay | Mind only | **deliberately not propagated**: not the user's word |

**Implementation.**
- `withTransitions(ownerId, keys, mutate, { source, kind })` in `memory/propagation.js`. It snapshots the facts the edit touches, runs the edit, records the difference as transitions (the same `recordTransitions` as chat), reconciles the Mind and schedules the evidence step. It never fails the edit.
- `memoryEditor.correctFact` / `replaceFact` / `archiveFact` / `restoreFact` / `mergeFacts` / `splitFact` call it.

**One definition of current reality.** A transition carries `source` (`conversation | memory_page | understanding_card`) and the provenance `user_statement | user_edit:<source>`.

The prompt never presents an edit as speech. A Memory-page change renders as:
`(uncertain whether still current — they changed it on the Memory page: workplace "Fintrail" → "Northbeam")`
not as "they said: edited:user_correction" (`displayLabels.reviewNote` / `reviewPhrase`, used by the profile, the cognitive model, the PIC floor and the Context Engine).

A Memory-page *correction* shows no "(previously: …)", exactly like a chat correction: the profile reads the transition's kind. A Memory-page *replace* shows it.

**Corrected in passing.** The kind detection read the store's `isCorrection` flag as a correction. Step 4a sets that flag on every moved date only to skip confidence damping, so "the deadline got pushed back to April 23" would have lost its "(previously: April 2)". A correction is now decided by the user's words alone (`stateTransition.corrects`). An existing test (`factChange.test.js`) caught it.

**Extraction defects found** (not lifecycle; not fixed):
- "Actually, my company is Northbeam, not Fintrail" is stored as **`project: Northbeam`**.
- "Actually, my workplace is Northbeam" becomes `custom_workplace`.
- Only "I work at …" phrasings reach `workplace`.

The chat and Memory-page paths therefore agree whenever chat understood the correction. Chat does not always understand it.

## 2. Shared transition architecture

There is one transition record per change, on the fact itself (`fact.transitions`):

```
{ id = sha1(owner, key, from, to, text), key, from, to, kind, text, at, item?,
  fromSource, effective, source, provenance, confidence,
  // evidence-lane outbox state:
  pic?, picAttempts?, picNextAt?, picError?, picDead?, picReleased? }
```

The kinds, and what each does:

| Kind | Meaning | Effect |
|---|---|---|
| `changed` | the value changed | belief updated, edge ended, dependents flagged |
| `corrected` | the old value was wrong | same; no "previously" |
| `ended`, `resolved` | the fact or item ended or was resolved | belief archived, edge ended, dependents flagged |
| `archived`, `merged`, `split` | removed from the active memory on the Memory page | belief archived, edge ended, sentence retired, **no dependents**; live only while the fact stays archived |

A transition is **live** while what it retired is not current again (archive kinds: while archived). A non-live transition releases what it set. Reconciliation (`reconcileMind`) is a pure function of the facts' transitions plus the existing Mind state, so re-running it changes nothing.

## 3. Reconciliation and recovery design

**Where things live.** The Mind document (legacy facts plus every Mind store) is one file with one atomic flush, so a turn's Mind-side effects and the transition record are written together. The evidence lane is a second file. The durable job queue (`core/jobs/jobQueue.js`) is Postgres-only, so it is unavailable on the legacy path. The transition record is therefore the outbox, and the queue's own `backoffMs` is reused so that only one retry policy exists.

**Order for each evidence step** (`propagateToEvidence`):
1. `flushMind`: the transition is on disk before anything acts on it (write-ahead; new `mindStore.flushMind`).
2. The evidence work. It is idempotent: archived filter, same-transition check. Everything archived carries `archivedReason: propagation:<id>`.
3. `flushEvidence`: the evidence file is on disk (new `evidenceStore.flushEvidence`).
4. Stamp `pic`. The Mind's next flush persists the stamp.

**Crash outcomes:**
- Before step 1: the turn's whole change is lost in both files together. That is consistent, but it is lost.
- Between 1 and 3: the stamp is missing and the work is redone.
- Between 3 and the next Mind flush: the work is redone idempotently.

The evidence lane can lag the record of a change on disk; it cannot lead it. **This is not atomic across files** and is not claimed to be.

**Release.** When a transition stops being live (a revert, a restore), reviews are cleared and **exactly** the sentences it archived are un-archived. Anything a forget archived stays archived.

**Failure handling:**
- Attempt N waits `backoffMs(N)`: 2, 4, 8, … seconds.
- After 8 attempts: `picDead = { at, error, attempts }`. The record is kept and logged (`PROPAGATION_DEAD`), never retried, and reported.
- An owner whose evidence step is already running in this process is skipped (`inFlight`).
- Across processes, every step is idempotent. There is no cross-process lock: two processes may do the same work, and the result is the same (measured below).

**Without a user message.** `sweepOnce()` reconciles every owner that has transitions and runs their due evidence steps. `startPropagationSweeper()` is started in `aqua/router.js` at boot: a first pass after 5 s, then every 60 s, unref'd. Owners are independent.

**Diagnostics.** `GET /mind/propagation` (owner-scoped) returns pending and dead transitions with key, kind, source, attempts, next attempt and error, the oldest pending age, and the last sweep's statistics. It quotes no user text.

**Account isolation.** Transition IDs include the owner, every step takes one `ownerId`, and the sweep iterates owners separately. Measured: another account had 0 transitions, 0 reviews and 0 ended edges on every path.

## 4. Goal lifecycle findings

**Two stores.** A goal is an item of the legacy `goal` fact (closed by `factChange.laterWordsOnFacts` → `retiredItems`, or `ended` for a single goal) and a Mind goal (closed by `goalTracker` or on the Understanding page).

Findings:
- **Chat closures already agreed.** With closure words ("I finished / completed the half marathon", "The half marathon is done", "I gave up on…", "no longer training for…") both resolvers close the goal independently, with the same kind.
- **The Understanding page did not.** Marking a goal done there left the profile's goal list open (agree = false).
- **Deleting a goal** on the Understanding page left the legacy item and its sentence answering.
- **Achievement phrasing closes nothing.** "I finally ran the half marathon last weekend!" closes the goal in **neither** store: an understanding gap, not a sync gap. Not fixed: deciding that "ran it" means "done" belongs to the shared transition reader, and should be measured on the dev sets first.
- **Goal-store creation was already consistent** in every evaluated case. Both stores are fed by the same extraction.

**Implemented (`reconcileGoals`, the first stage of every reconciliation):**
- **Mind → profile.** A Mind goal completed or abandoned *by the user* (history reason `completion cue | user edit | … by the user`) retires the matching legacy item (`goalSimilarity` ≥ 0.8) through `applyCurrentState`, recorded as a transition.
- **Profile → Mind.** A legacy item or single goal the user's words closed completes the Mind goal (resolved), abandons it (ended) or marks `changedBy` (changed), with the same words. A goal restated after it closed is not touched.
- **Never from reflection** (stale) and **never from a related fact**: dependents are only flagged.
- **Goal deletion** goes through `forgetGoal` (§1).

**Not done:** goal split on the Understanding page, and goal dependency changes (a goal's blockers resolving) beyond the existing working-memory handling.

## 5. Dependency identification improvements

Every name for the retired value comes from what Aqua already holds, never from a guess (`anchorsFor`):

| Source | Example | Rule |
|---|---|---|
| The value and its leading name | "Derek Shaw at Lone Star Bank" → "Derek Shaw" | previous mission |
| Acronym | "Lone Star Capital" → "LSC" | only names of **three or more** capitalised words, matched case-sensitively; "DS" for Derek Shaw is not used |
| Entity-resolver aliases | "Fintrail" ↔ "Fintrail Payments" | the reasoning graph's existing entity `data.aliases` (merged mentions of one thing) |
| Pronoun with one referent | "My bank contact … is Derek Shaw …" then "I need to send **her** the bank statements" | `notePronounReferents`: the item was created this turn, has a personal pronoun and no full name, and the user's **previous message in the same conversation** stated facts naming **exactly one** person → `refersTo` |
| The same referent, evidence lane | the sentence the deadline came from | the evidence step uses the Mind item's `refersTo` when the sentence contains its label: the same resolution, not a new one |

**Left untouched by design:**
- Two candidate referents ("…Priya Rao and … Lena Ortiz", then "send them…").
- A role reference ("send my manager the slide deck": whoever holds the role now).
- Past tense, and someone else's relation (previous mission).
- Organisation-like names as pronoun referents.

**Investigated, not built:** second-order dependencies through related projects, e.g. "Atlas" was at Fintrail, so a sentence naming only Atlas depends on the job. The only grounding available is co-occurrence in an earlier sentence, which this mission's rule ("ambiguous → untouched") does not allow.

## 6. Test instability (13 brain embedding-fixture failures)

**Cause: not established.** What is known:
- All 13 failures were in `src/brain/tests/embeddingFixture.test.js` itself, and finished in milliseconds. Every failing test reads source or dataset files when its `describe` is defined (`retrievalIntelligence.js`, `retrieval-small.v1.json`, `retrieval-core.v1.json`, `embeddingFixture.mjs`), and the file itself failed too. That pattern fits one failed read or resource error in that test process, not 13 separate assertion failures. The battery's filtered log did not keep the error text.
- **Ruled out: fixture corruption.** The committed fixture is byte-identical to git afterwards.
- **Ruled out: a concurrent reader breaking the test.** With a second process re-reading the fixture in a tight loop during the run: 0 failures in 3 runs.
- **Ruled out: another test reading the fixture.** No other `src/brain` test reads it.
- **Found, a real hazard: the test breaks other readers.** That same concurrent reader saw **2–8 failed reads per run**. The test rewrites the 2.5 MB committed fixture `eval/fixtures/retrieval-core.embeddings.v1.json` in every `afterEach`. Any other process reading it meanwhile (the gate's dense suites, anything else using the dense-retrieval fixture) can read a scratch or missing file.
- **Found: two concurrent runs of this file fail,** on different tests (2 failures per pair: stale/hash tests). Two overlapping test runs therefore produce failures from this file.
- **Not ruled out:** memory pressure. The file documents an earlier OOM kill at 3 GB, and 4.3 GB of 15.4 GB was free with nothing running. The failure did not reproduce in 2 full `src/brain` runs plus the file alone.

Tests were not modified. **Recommended:**
- the test should write its scratch fixtures to a temporary path (the loader takes a path or name) instead of mutating a committed artifact;
- the battery should keep full output for failing files, so the next occurrence records its error.

## 7. Before and after measurements

`node scripts/change-lifecycle-eval.mjs --propagation off|on`. Off = no propagation at all, which is the code before both missions for these paths. Isolated.

**Path parity: what each store says the employer is after the change** (legacy fact, Mind belief, Mind graph, evidence lane), plus the 4 dependents:

| Path | Off: stores current | Off: dependents flagged | On: stores current | On: dependents flagged |
|---|---|---|---|---|
| chat | 3/4 (graph had both Fintrail and Northbeam) | 0/4 | **4/4** | **4/4** |
| Memory page, correct | **1/4** | 0/4 | **4/4** | **4/4** |
| Memory page, replace | **1/4** | 0/4 | **4/4** | **4/4** |
| Understanding page, belief edit | 2/4 (fact and belief only) | 0/4 | **4/4** | **4/4** |

**Goal lifecycle: Mind goal vs the profile's goal list:**

| Path | Off | On |
|---|---|---|
| chat "I finished the half marathon." | agree (both closed) | agree |
| chat "I gave up on the half marathon." | agree (both closed) | agree |
| chat "I finally ran the half marathon last weekend!" | agree (**both still open**: understanding gap) | agree (same) |
| Understanding page: mark done | **disagree** (Mind completed, profile open) | **agree** (both closed) |
| a related fact changed | agree (both open) | agree (both open, not closed) |

**Dependencies** (labelled; records across Mind goals, deadlines and evidence sentences):

| Case | Expected | Off | On |
|---|---|---|---|
| acronym (LSC) | flag | 0/2 | **2/2** |
| full name | flag | 0/3 | **3/3** |
| pronoun, one referent | flag | 0/3 | **3/3** |
| past tense | no flag | 0/1 | 0/1 |
| someone else | no flag | 0/1 | 0/1 |
| pronoun, two referents | no flag | 0/3 | 0/3 |
| role reference | no flag | 0/3 | 0/3 |
| unrelated | no flag | 0/3 | 0/3 |

On: positives fully flagged 3/3, with **0/5** controls falsely flagged. The pronoun case's evidence sentence was missed in the first run (2/3) and fixed with the shared-referent rule.

**Recovery by the sweep, no user message** (sweeper every 60 s, simulated clock):

| Failures injected | Attempts | Repaired | Simulated time to repair | Dead-lettered (reported) |
|---|---|---|---|---|
| 1 | 1 | yes | 120 s | 0 |
| 3 | 3 | yes | 240 s | 0 |
| 7 | 7 | yes | 552 s | 0 |
| 8 | 8 | **no** | — | 1 (1) |
| 12 | 8 (bounded) | no | — | 1 (1) |

**Crash** (a real child process exits with code 70 at the named point; a fresh process recovers from the same data directory):

| Crash point | Change survived | Pending after restart | Pending after one sweep | Old sentence retired | Duplicate flags | Duplicate history |
|---|---|---|---|---|---|---|
| after the Mind flush | yes | 2 | 0 | yes | 0 | 0 (1 → 1) |
| after the evidence flush | yes | 2 | 0 | yes | 0 | 0 (1 → 1) |

Both processes took about 0.7 s together.

**Concurrent reconciliation** (tests):
- two sweeps plus a chat-path step at once: each sentence flagged once, history entry once;
- **two processes sweeping the same store at once** converge: 0 pending, no duplicate flags.

**No regression on the previous mission's evaluation** (`cross-store-consistency-eval.mjs`, both lives × both profiles, on):
- 0 outdated-as-current records and 3/3 changes consistent;
- history 11/11, 7/7, 5/5, 2/2;
- dependents 8/8, 5/5, 8/8, 5/5, with 0 false flags;
- every failure case heals.

These are identical to that report.

**Tests:**
- `src/memory/tests/unifiedChangeLifecycle.test.js`: 18 tests, including a real child-process crash at two points and two concurrent processes.
- With `oneChangeEveryStore.test.js`: 30 of 30 pass. `src/memory` + `src/mind`: 387 of 387.

**Bite checks.** Each of 14 new mechanisms was disabled in turn, and each made at least one test fail:
- Memory-page routing;
- archive kinds;
- edit wording;
- the bridged belief;
- goal sync, and its scalar-goal case;
- backoff and the dead letter;
- write-ahead;
- acronym, resolver alias and pronoun;
- pronoun ambiguity;
- `forgetGoal`.

Two of the tests did not catch their mechanism at first:
- **The alias test** used an alias containing the name itself.
- **The ambiguity control** used a message that extracts no usable name. Its first message, "My manager is Priya Rao and my accountant is Lena Ortiz", stores `custom_manager` as the whole run-on value, an extraction defect.

Strengthening them exposed a real gap. The pronoun rule matched only single-sentence messages, because facts from a two-sentence message each carry their own sentence. That is fixed (match by containment at that turn), and both mechanisms now bite. All files were restored and verified by hash after every bite.

**Development sets.** 199 questions, `AQUA_RECALL_ALL_CHARS=0`, short regime, against the previous mission's recorded contexts:

| Profile | Outdated as current | Correct current | False updates | History | Tokens per question |
|---|---|---|---|---|---|
| dev-env | 1/90 | 9/9 | 0/12 | 9/9 | 752 |
| code-defaults | 1/90 | 9/9 | 0/12 | 8/9 | 526 |

All are identical to before.

**Full DB-free test run.**
- 2,762 tests: 2,754 pass, **0 fail**, 8 skipped (Postgres-only).
- The full output of every directory was kept, and the embedding-fixture failure did not recur.

**Evaluation gate.**
- 16 of 17 suites pass, as before.
- capture-core is still BLOCKED only because the gate reads its case counts as dataset shape (fully captured 19 → 20). Its baseline is untouched.

## 8. Remaining risks

1. **Not atomic across the two files.** It is write-ahead and recoverable, but a crash before the Mind flush loses the turn's change in both files together (consistent, not durable). The flush is debounced at 500 ms.
2. **No cross-process lock.** Duplicate work is safe because every step is idempotent, as measured with two processes. A future non-idempotent step would need a lease.
3. **The sweep cost is linear.** It visits every owner with transitions and scans each one's evidence sentences per pending transition.
4. **Dead letters are reported, not repaired.** After 8 failures (about 4 minutes of backoff), a human has to look at `GET /mind/propagation`. Nothing re-arms them automatically.
5. **Some goal changes are not unified:** Understanding-page goal split, goal dependency changes, and "ran it"-style achievements, which close neither store.
6. **Extraction gaps decide whether chat and the Memory page agree:** "my company is X" is stored as a project, and "my workplace is X" as a separate key (§1).
7. **The Memory page doesn't ask whether an edit was a correction or a change.** "Correct" is recorded as a correction (no "previously"), "replace" as a change.
8. **Name-based residue:** pronouns resolve only one message back in the same conversation; aliases only when the entity resolver merged them; related projects are not followed.
9. **The sweeper runs in every process that loads the router.** That is safe (idempotent) but doubles work in the two-process deployment.
10. **The test instability cause is not established** (§6), and the test's mutation of a committed fixture is a hazard to concurrent readers.
11. **No answer-level measurement.**

## 9. Recommended next milestone

**Answer-level validation of the lifecycle, then the goal-understanding gap.**

1. **Run the answer pair.** As soon as a non-shared model is available, run it on the recorded contexts (propagation off vs on, chat vs Memory-page edits). Measure:
   - does the answer use the current value?
   - does it ask about a flagged goal rather than assume either way?
   - does it ever present a Memory-page edit as something the user said?
2. **Achievement phrasing** ("ran it", "got the job", "we launched") as goal closure, in the shared transition reader (`stateTransition`). Measure on the dev sets and the goal lifecycle evaluation before shipping.
3. **Fix the fixture test hazard** (§6): scratch fixtures to a temporary path. Keep full output for failing battery files.
4. **Then** a single-process sweeper with a lease in the two-process deployment. Do this only if the doubled work shows up in the process metrics.
