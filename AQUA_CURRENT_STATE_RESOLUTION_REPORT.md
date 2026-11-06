# Current-state resolution — report (2026-11-02)

Main development tree, uncommitted. Lift v4b (pid 10568) untouched. No hosted model calls, no model
download, no Postgres-backed tests. Every evaluation and test uses a private temporary data
directory. No baseline changed.

**What changed in one line.** The profile, identity card and cognitive model now hold the **current
value**: `workplace: Northbeam (previously: Fintrail)`, `Company: none current (previously: Hartwell
Bank — they said: "…")`. Before, they held the old value with a note beside it. A note remains only
where the user did not state the new value, or the change may not be theirs.

**Measured at context level, development data only.** Answers were not generated, so **no
answer-quality claim is made.**

| `current-state.dev.v1` (17 users, 23 questions) | Before | After |
|---|---|---|
| Correct current value shown as current | **1/9 (11%)** | **9/9 (100%)** |
| Outdated value shown as current | 2/10 (20%) | **0/10** |
| False updates on no-change controls (negated, hypothetical, third-party, ambiguous, one-time, scoped) | **4/9 (44%)** | **0/9** |
| Values the user never held shown as current | 0/2 | 0/2 |
| History preserved (past value still in the prompt) | 2/2 | 2/2 |
| Preference questions answered from the right current preference (c11, c12 ×2, c13) | 0/4 | 4/4 |

Identical under the dev `.env` flags and under code defaults (no `AQUA_*` set). Across all 199 dev
questions see §4.

## 1. Existing architecture and production data flow (verified)

`routes/chat.js prepareTurn` → `memory/engine.js`:
- **Write**: `memoryObserve`, every turn. In order:
  1. extraction: schema + free-text fallback, `candidateExtractor` / `memorySchema`;
  2. one conflict resolver (`storeResolved`): duplicate / merge / overwrite / correction, with
     version `history`;
  3. explicit corrections ("my X is now Y");
  4. `factChange.js` date/amount changes;
  5. since this morning, later-word notes;
  6. then the Mind (`mindObserve`: beliefs, goals, working memory).
- **Read**: `memoryRetrieve` → IDENTITY card (`identity.js`, from identity keys), USER PROFILE
  (`memoryRetriever.formatFactsForPrompt`, facts chosen by relevance to the question), COGNITIVE
  MODEL (`mind/mindRetriever.js`). This memory block comes first in the system prompt. The evidence
  block and recall quotes come later, fenced as untrusted.
- Facts and the Mind live in the same per-owner store and share its deletion path.

## 2. Root causes (each observed in the baseline)

| Symptom | Cause |
|---|---|
| "I now work at Northbeam" left Fintrail everywhere (c01) | Capture: no pattern for "now work at"; nothing linked a new employer to the old one |
| "our new loan officer is Kim Alvarez", "relocated to Bristol", "sold my Civic and bought a Tesla" stayed as notes on the old value (c02, c04, c06) | **Resolution**: the new value was in the sentence but never applied; the note left the model to infer it |
| "Mellow is now my biggest client" changed nothing (c03) | Linking: the clause also matched `newest client: Mellow` by name, so it was treated as ambiguous |
| "I no longer work at Hartwell", "I sold my Civic", "I passed the CFA exam" left the value listed as current (c05, c07, c08) | Representation: an ended state had no form except a note on a current line |
| "720 euros for new clients" marked 650 as changed (c09) | Scope: a narrower value was treated as a change to the broader one |
| "I prefer long, detailed answers" stored as "long" (c11, c12) | The pattern stopped at the first comma, missed "I **now** prefer", and lost "For emails, …" |
| Old and new preferences both current | `preference` is a merged collection; nothing ever retired an item |
| "I prefer detailed explanations" never reached "Explain how a mortgage works" (c13) | Retrieval: facts are chosen by word overlap with the question |
| "I'm in a rush" stored as `custom_in_a_rush` | The transient-state guard checked only the first word |
| An ended identity field left the authoritative block silent (v11) | Identity keys are rendered only by the card; dropping the field dropped its history |

## 3. Changes implemented (existing components; no new store or subsystem)

**`memory/factChange.js`: `resolveCurrentState`.** Each later word that `laterWordsOnFacts` links
to one fact resolves to one of:

| Action | Meaning | Example |
|---|---|---|
| replace | a new value for the same slot, read from the user's sentence | "our/my new X is V", "V is now my X", "my X is now V", "relocated to V" (city), "I now work at V / I'm a R at V / joined V" (workplace, plus role), "sold … and bought V" |
| scoped | narrower than the stored value | "for new clients", "only for …" → its own fact `<key>__<scope>`; the broader one untouched |
| end | the state ended, nothing replaces it | |
| uncertain | the ending may not be the user's, or refers back | "We sold the Civic" on *my* car; "bought it back" → kept current, flagged |
| note | changed, new value not stated | this morning's annotation |

Values are never inferred. A pronoun or empty phrase is not a value. Linking also gained an
employment slot rule (like the past-tense relocation rule) and a tie-break: the slot named in full
wins over a fact matched by its value.

**`memory/longTermMemory.js`: `applyCurrentState`.**
- **Replace**: the previous value becomes a revision via `buildVersionHistory`, the sanctioned
  "never silently overwrite" path. A `transitions` entry `{from, to, kind, text, at}` is added;
  `sourceText` is the user's sentence; confidence is 0.9.
- **End**: `ended = {text, kind, at}`. A collection retires only the linked item, to `retiredItems`.
- **Scoped**: a separate fact with `scope` / `scopeOf`.

**`memory/engine.js`**:
- Step 4c applies the resolution, including the role update that comes with an employer.
- New step 2b: a newly stated preference about the same thing, in the same context, retires the
  older one (`preferenceSupersedes`: same head noun, same scope).
- The stated `preference` fact rides every turn.
- Ended and replaced values are passed to the cognitive model as retired, and ended facts get
  recall "since changed" notes.

**Rendering**:
- Profile (`memoryRetriever.js`): current value plus `(previously: …)`, from a transition or from
  any resolver revision except a collection merge. Scoped facts get their own label; ended facts
  and retired items go under `### No longer current`. Collection items containing commas are
  joined with "; ".
- Identity card (`identity.js`): an ended field reads `none current (previously: … — they said: "…")`.
- Cognitive model (`mindRetriever.js`): beliefs holding a retired value are not shown.
- One rule line (`displayLabels.js`) explains the markers: current / previously / no longer
  current / since changed / uncertain.

**Preferences** (`memorySchema.js`, `candidateExtractor.js`, `mind/observers.js`):
- Capture runs to the end of the clause, accepts "now / actually / generally prefer", and keeps
  the context: "(for emails)", "(for code)".
- "this time", "right now", "today" make a wish for one answer, not a preference.
- One-time brevity or depth requests carry a weak Mind signal (0.15 instead of 0.75), so one
  request cannot become a belief.
- Moments ("in a rush") are not stored as facts.

How preference kinds are represented:

| Kind | Representation |
|---|---|
| Stable | profile item |
| Context-specific | item with "(scope)" |
| Explicit change | replace + previously / retired item |
| Temporary or one-time | not a profile preference; weak Mind signal |
| Inferred | Mind belief labelled "inferred, NN%" (unchanged) |

**Consistency rule across the prompt.** One reader (`changeKind` + `resolveCurrentState`) decides
for every source. **History versus correction**: a *change* keeps the old value as
`(previously: …)`; a *correction* does not, because the old value was a mistake, not a past truth.
- A later statement changes the current state only if it is:
  - an explicit resolution, ending, change or correction;
  - not negated, speculative or hypothetical;
  - about one fact;
  - the user's own change or the thing's own.
- Profile, identity card and cognitive model show the resolved current value. The evidence block
  orders statements oldest → newest; recall quotes carry "since changed — now" notes.
- Uncertainty is shown as "uncertain", never as a change.

## 4. Before / after evaluation

Method: `scripts/temporal-resolution-eval.mjs` replays every history through the production legacy
writers and recall, records each question's exact context (`--emit-contexts`), and
`scripts/authority-recompute.mjs` scores the recorded prompts of both arms with one definition.
- **Data**: `current-state.dev.v1.json` + labels (sha256 `85290e58…` / `ab11b491…`), written before
  the change, plus the five earlier dev sets: 199 questions.
- **Regimes**: short and padded (long history, ranked recall).
- **Flag profiles**: dev-env and code-defaults.

All 199 questions:

| | dev-env before | dev-env after | code-defaults before | code-defaults after |
|---|---|---|---|---|
| Outdated value shown as current (90 change Qs) | 2.2% | 1.1% | 2.2% | 1.1% |
| Correct current value (9) | 11.1% | 100% | 11.1% | 100% |
| False updates (12 controls) | 33.3% | 0% | 33.3% | 0% |
| History preserved (9 historical) | 100% | 100% | 88.9% | 88.9% |
| Combined context: stale without update / current coverage (padded) | 2.2% / 96.4% | 2.2% / 96.4% | 3.3% / 94.2% | 3.3% / 94.2% |
| Tokens per question (short) | 734 | 751 (+2.3%) | 507 | 527 (+3.9%) |

Notes:
- The one remaining "outdated-as-current" case, **p06**, is a **label disagreement**, not a stale
  value. That earlier set's label calls any unannotated "650 euros" stale. Under scoped resolution
  650 is correct and current for existing clients, with `day rate (new clients): 720 euros` beside
  it, which is what this set's c09 labels expect. Labels written earlier were not edited after
  seeing results.
- The memory lane's *sentence-based* metrics moved (stale-without-update 0 → 5.6%, current
  coverage 23.9 → 13.8%). This is an artifact of the new representation: those labels look for the
  user's sentence, which the old note quoted; the block now states the value and puts the old one
  in "(previously: …)". I verified all 5 cases by hand. The combined context is unchanged.
- Code-defaults history 8/9 is pre-existing (one recall miss), unchanged.
- A hand audit of **every** "(previously: …)", "No longer current" and "uncertain" line across
  all users found all of them correct (29 users).

**Context relevance**: same-subject irrelevant facts (a08) 3/3 → 3/3, unchanged. Unknown-question
lines +0.4, from the rule and history lines.

## 5. Regression tests

`src/memory/tests/profileLaterWords.test.js` was rewritten to the current-state semantics: 29 tests
through `memoryObserve` → `memoryRetrieve`, each with a control.

**The seven superseded assertions.** They had pinned this morning's annotation behaviour, which this
pass replaces by design. The negative controls were kept.

Turning off each mechanism fails tests:

| Mechanism disabled | Tests failing |
|---|---|
| replace | 5 |
| scope detection | 1 |
| named-slot tie-break | 1 |
| possessor uncertainty | 2 |
| employment link | 1 |
| identity ended rendering | 1 |
| cognitive retired filter | 1 |
| preference supersession | 1 |
| preference always-include | 3 |
| one-time preference guard | 1 (after adding the "I prefer X this time" control; it was 0 before) |
| transient-phrase guard | 1 |
| previously rendering | 6 |

The `src/mind` and `src/understanding` temporal suites are unchanged and pass.

DB-free battery, clean run (mind, understanding, memory, pic, brain, cognition, routes, files,
eval/tests): **2,730 tests, 0 failures**, 8 skipped (Windows-only and live-DB suites).
DB-free gate: **16/17 PASS**. `capture-core` is still BLOCKED only by its `n_cases_*` outcome counts
being read as dataset structure; all its metrics are improved and its baseline is untouched.

**Found by tests, then fixed**:
- "sold my Civic and bought **it back**" produced the value "it back". A pronoun-led replacement is
  now *uncertain* (neither replaced nor ended).
- **Titles broke sentences.** "My supervisor is now Dr. Varga" was split after "Dr.", giving the
  value "Dr", and "Dr" matched "Dr. Osei", replacing the *lab* supervisor when two supervisors were
  stored. Caught by an existing ambiguity test (`factChange.test.js`). Fixed: a title-aware sentence
  splitter (`SENTENCE_END`), and titles are never a shared subject.
- **A correction is not a change.** An existing safety test (`forgetEverywhere.test.js`) caught the
  difference. After "Actually, my city is now Porto", showing `(previously: Lisbon)` asserted that
  Lisbon was once true, but a correction says it was a *mistake*. Now `(previously: …)` appears only
  when the sentence that set the current value is a change. After a correction (actually /
  correction / I misspoke / I meant / "X, not Y") the old value does not reach the prompt as
  history, as that test requires.

**Two pre-existing assertions changed, with reason** (`factChange.test.js`, 2026-10-29). They
asserted the old value must not appear *anywhere* in the profile after a genuine change ("pushed
back to April 23", "Pedro retired; my new accountant is Mira Chen"). This mission requires the
previous value to remain visible as history. Their stated intent ("not stated **as current**") is
kept: they now check the profile *outside* `(previously: …)`. One of them also asserts that the old
date *is* kept as history.

New: a test pinning correction vs change, with a move as the control. Disabling the correction
guard fails it.

## 6. Remaining limitations

- **Answer quality is unmeasured.** Every number here is about the context the model receives.
- **Value extraction is pattern-based** (new / now / relocated / joined / bought). New values stated
  any other way ("Kim handles our loan now") fall back to a note. That's honest, but not resolved.
- **Scope detection covers common qualifiers** (for new/existing/…, only for …), not every
  contextual condition. Different deadlines per project work because they are separate facts.
  Multiple values of one relationship type are separate keys only when the user names them
  differently.
- **Temporary preferences are recognised by a few time words** ("this time", "today", "right
  now"). Expiry of a stated temporary preference ("for this week") is not modelled.
- **Third-party detection** is first-person / named-subject only (conservative: misses rather than
  misfires).
- **The evidence block** still conveys change only through ordering; its conversational facts all
  carry confidence 0.60.
- **The canonical World Model's typed supersession** still never reaches production answers
  (legacy read).
- **Development data only**, written by the session that built the change. The padding is synthetic.

## 7. Recommended next product milestone

**Answer-level validation of current-state understanding.** Run the paired answer evaluation
(`TEMPORAL_ANSWER_EVAL_PLAN_2026-11-02.md`) on the recorded contexts
(`eval/out/contexts.{before,after}-cs.*.json`) once Lift has finished and a non-shared model is
available. Add one judge item: *"Does the answer state the current value, and the previous one only
as history?"*

Every change since this morning has improved what the model is *given*. Only that run shows whether
Aqua *answers* better. If it does, the next engineering step is to widen value extraction beyond
the current patterns, so fewer changes fall back to "since changed".
