# Aqua: understanding user intent, outcomes and relationships — report (2026-11-04)

Main development tree, uncommitted.

**Constraints observed:**
- Lift v4b (pid 10568) untouched.
- No model calls, no downloads, no Postgres.
- Every run used a private temporary data directory, and no real user store was accessed.
- No baseline or frozen file changed.

**What changed.** Aqua now reads a goal as an intended outcome, not a stored sentence:
- **Achievements close the right goal, in both goal stores.** "I finally ran the half marathon", "I got the promotion", "We closed our seed round" now complete the goal they achieve, in both goal stores, with the user's words and when they said it happened. Plans, negations, hypotheticals, partial progress, sarcasm, questions and other people's achievements do not.
- **"My company is X" is the workplace.** It was being filed as a project.
- **One sentence can now state several facts**, without run-ons and without splitting names.
- **The answer harness is ready.** A model-independent harness can produce and grade answers for the previous and current production contexts. **No answers were generated.**

**Results** (development set; a check set written afterwards in brackets):

| Measure | `HEAD` (production) | Working tree before this mission | Now |
|---|---|---|---|
| Achievements recognised in both goal stores | 0/10 [0/7] | 4/10 | **10/10 [7/7]** |
| Goals kept open that must stay open | 13/15 [4/8] | 13/15 | **15/15 [8/8]** |
| False goal completions | 2 [4] | 2 | **0 [0]** |
| Entity classification | 6/13 [1/6] | 6/13 | **13/13 [6/6]** |
| Multi-fact cases | 2/10 [2/6] | 2/10 | **9/10 [6/6]** |
| Relationships extracted cleanly | 4/15 [3/8] | 4/15 | **13/15 [8/8]** |
| Run-on facts | 4 | 4 | **0** |
| Duplicate values | 0 | 0 | 0 |

The remaining multi-fact case is the health-sensitivity policy working as designed (§6).

**Answer readiness.** The production prompt now holds what a correct answer needs for **11 of 12** questions, up from **5 of 12** on `HEAD` (model-free check, §7). The 12th is a flaw in my own criterion, explained in §7.

---

## 1. Root causes

**Goals (the two goal stores, `mind/goalTracker.js` and `memory/factChange.js`):**
- **A closure needed a closure word.** `laterWordOnGoals` and the legacy resolver close a goal only on a word from the shared list (`stateTransition.RESOLVES`: finished, completed, done…). An achievement reported with the goal's own verb ("ran", "got", "bought") or a synonym ("closed our seed round") was never read as one.
- **Matching shared words, not the outcome.** "promotion" and "promoted" share no stem, so "I got the promotion" matched nothing.
- **Keyword completion.** `trackGoals` completed the most word-similar open goal on any of `finished | completed | shipped | launched | released`. Nothing checked who did it, whether it was all of it, or whether it was meant. "Our competitor launched their product" and "I finished the first draft of my book" completed goals. The legacy resolver closed "I finished the first draft…" too.
- **The stores disagreed at creation.**
  - The profile store cut "save 10,000 dollars for a car" to "save 10", ending the value at the comma inside the number.
  - The Mind rejected "My goal is to read twenty books" because "read" is on a head-word filter meant for remarks ("I want to read about…").
  - "Our goal is…" was not a goal in the profile store at all.

**Entity classification ("Actually, my company is Northbeam" → project):**
- **The pattern sat under project.** "my (startup|project|**company**|product|app) is X" lived in the *project* schema (`memorySchema.js`, `my_project`). The workplace schema listed "company" as an alias, but no workplace pattern accepted "my company is X".
- **The correction never reached the workplace.** Workplace stayed Fintrail, Northbeam became a project, and the transition lifecycle never saw a workplace change.

**Several facts in one sentence ("My manager is A and my accountant is B" → one run-on manager):**
- **One statement per sentence.** Extraction read each sentence as a single statement: the first matching pattern won, and its value ran to the clause end. The result was "Priya Rao and my accountant is Lena Ortiz", and the second relationship was never read.
- **The generic "my X is Y" fallback** accepted only "my", not "our". It had no inverse form ("Jordan is my co-founder"), no hyphenated roles ("skip-level"), and no mapping of role words to known keys.

**Found while measuring:**
- **Sensitivity was decided for the whole sentence.** "My mentor is Grace Liu and my therapist is private" lost the mentor: chat's write-side redaction removed the whole sentence, and the fact-level check read it too.
- **The new inverse pattern turned a question into a fact.** "How is my half marathon goal going?" was stored as `custom_half_marathon_goal_going = "How"`. Introduced and fixed in this mission.
- **The profile mis-rendered closed goals.**
  - An achieved goal was shown only as "No longer current", not as achieved.
  - Closing one goal of several showed the old list as "(previously: …)".
  - Recall marked the first goal "since changed — now: [the second goal]" after a merge. That came from `legacySupersessionNotes`, earlier work in this session.

## 2. Production data flow

```
chat message ─ routes/chat.js prepareTurn
  ├─ sensitivity.redactSensitiveSentences   (now per clause)
  ├─ memory/engine.js memoryObserve
  │    ├─ memoryExtractor → candidateExtractor.extractAllCandidates
  │    │     sentences → sentenceParser.splitClauses (NEW) → per clause:
  │    │       schema patterns (memorySchema)  →  else generic role fallback (our / inverse / role → schema key)
  │    │     provenance = the whole sentence; `clause` and `pattern` carried with the fact
  │    ├─ conflict resolution, corrections, factChange (legacy goal closures via closeKind)
  │    ├─ propagation.recordTransitions     (every fact change → one transition)
  │    ├─ mind/index.js mindObserve → goalTracker.trackGoals
  │    │     laterWordOnGoals → achievedGoal (NEW: stateTransition.achieves per clause)
  │    └─ propagation.reconcileMind → reconcileGoals (Mind ⇄ profile goal sync) …
  └─ memoryRetrieve → profile / cognitive model / recall → system prompt
```

Every new or corrected fact still enters through the same store path, so the transition lifecycle (propagation, history, provenance, confidence, dependents, retry, isolation) applies unchanged. A goal achieved in the Mind reaches the profile store through `reconcileGoals`, and is recorded there as a `resolved` transition.

## 3. Changes implemented

**The achievement reader (`understanding/stateTransition.js`, shared by both goal stores).** A goal title is read as an outcome: a verb plus an object, with the time phrase removed. `achieves(clause, goalTitle)` holds only when all of these hold:
- **subject:** the user is the subject ("I", "we", "my team"), or the clause opens on the verb ("Got my driver's license today!");
- **done:** a past form of the goal's own verb (an irregular map plus regular "-ed", stemmed alike), or a completion or release verb. Verbs spelled the same in past and present ("read", "hit") count only with a past-time marker;
- **object:** the head of the noun phrase the verb acts on (up to a preposition or time word, skipping a gerund such as "finished *writing* my book") is the goal's object. Enough of the object is present: half its words, or its distinctive head ("promotion" ~ "promoted");
- **asserted:** not negated, planned, hoped, conditional, "almost", asked, or in a sarcastic frame;
- **whole:** not partial ("first draft", "halfway", "so far") and not an activity around the goal ("route", "training", "application");
- **same quantity:** a stated amount must be the goal's amount (2,000 saved is not the 10,000 goal).

When several goals qualify, the best coverage wins, and a tie closes nothing. `reportsDone(clause)` applies the same checks when the goal is already known.

**Where it is used:**
- **`goalTracker.laterWordOnGoals`** completes the goal, records `achievedBy = { text, clause, at, when }` (when as said: "last week", "on Sunday") and adds a history entry. The title is never rewritten.
- **The old completion cue** now needs the shared reader to agree: the goal named in the same message must pass `reportsDone`, and any other goal must pass `achieves`. Its history reason stays "completion cue".
- **`closeKind`** (used by both stores' older closers) now refuses partial completion and sarcastic frames.
- **Goal sync** accepts "achieved by the user" closures, so the profile store closes the same goal through the transition lifecycle.
- **Goal creation:** the profile store accepts "Our goal is…" and keeps "10,000"; the Mind keeps an explicitly *stated* goal whatever its verb.

**Entities:**
- **"my / our company | employer | workplace | firm is X"** → workplace, also in the appositive "My company, X, is based in Denver" (Denver is not the user's city). A name must be written as one, so "my company is growing fast" stores nothing.
- **"my / our startup | project | product | app is (called) X"** → project. "I'm building an app called X" → project X.
- **The generic fallback** reads "my / our X is Y" and the inverse "Y is my X", with hyphenated roles. A role word that the schema already knows as a key or alias becomes that key, with its validator and policy ("co-founder" → `cofounder`, "employer" → `workplace`); other roles keep their own `custom_` key with the user's casing. This adds no new taxonomy.
- **A slot holds a name:** a role mapped to a known key must have a capitalised value.

**Several facts per sentence (`memory/sentenceParser.js splitClauses`):**
- **Where clauses split:** at a coordinator or comma followed by a **new subject** (my, our, I, we, he, she, they…). A name is not a subject, so "Johnson and Johnson LLP", "Ernst and Young" and "a founder and a software engineer" stay whole.
- **What blocks a split:** a leading subordinate clause ("When I write emails, I prefer…") is not split, and each part needs three or more words.
- **How each clause is read:** extracted on its own. Provenance (`sourceText`) stays the whole sentence, which the evidence lane and transitions quote. The clause and the matched pattern travel with the fact.

**Sensitivity per clause (`memory/sensitivity.js`):**
- **Write-side redaction** removes only the sensitive clause of a sentence, keeping the rest as its own sentence.
- **The fact-level check** reads the fact's clause when known.
- **Questions:** the generic fallback refuses interrogatives.

**Rendering:**
- **An achieved goal** shows as `- Goals: pass the CFA Level 1 exam (achieved) — they said: "I passed my CFA exam!"`.
- **Closing one goal of several** no longer shows the old list as "previously".
- **Recall** no longer turns a collection merge into "since changed".

**New tools and data:**
- `eval/datasets/intent-outcome.dev.v1.json` (sha256 `db20d0ab…`, written before any change) and `intent-outcome.check.v1.json` (`021c3e8f…`, written after the first implementation and run once before further changes);
- `scripts/intent-outcome-eval.mjs`;
- `eval/datasets/answer-lifecycle.dev.v1.json` (`155c0390…`) and `scripts/answer-eval-harness.mjs` (§7);
- `src/memory/tests/intentOutcome.test.js`.

## 4. Before and after results

`node scripts/intent-outcome-eval.mjs --set dev|check --profile dev-env|code-defaults`, real `memoryObserve` path, one account per case.

**"Achieved"** means completed in **both** goal stores: the Mind goal completed, and the profile item retired or the fact ended as `resolved`.

| Development set | `HEAD` | Before (working tree) | After |
|---|---|---|---|
| achievements recognised | 0/10 | 4/10 | **10/10** |
| negatives kept open | 13/15 | 13/15 | **15/15** |
| false goal completions | 2 / 17 | 2 / 17 | **0 / 17** |
| goal not created in both stores | 2 | 2 | 0 |
| entity classification | 6/13 | 6/13 | **13/13** |
| multi-fact cases | 2/10 | 2/10 | 9/10 |
| relationships extracted cleanly | 4/15 | 4/15 | 13/15 |
| run-on facts | 4 | 4 | 0 |
| "Actually, my company is Northbeam." | workplace still Fintrail; no transition | same | workplace and belief Northbeam; transition `Fintrail → Northbeam corrected`; Fintrail in history |

| Check set (written after the first implementation) | `HEAD` | First run | After the fixes it prompted |
|---|---|---|---|
| achievements recognised | 0/7 | 3/7 | **7/7** |
| negatives kept open | 4/8 | 5/8 | **8/8** |
| false goal completions | 4 / 9 | 3 / 9 | **0 / 9** |
| goal not created in both stores | 6 | 4 | 0 |
| entity classification | 1/6 | 4/6 | **6/6** |
| multi-fact cases | 2/6 | 5/6 | **6/6** |

The check set's first run exposed real defects:
- the dropped subject ("Got my driver's license today!");
- a stemming mismatch ("become" vs "became");
- digits cutting a goal's object;
- a modifier read as the object ("my third swimming lesson");
- the keyword cue;
- the 10,000 comma cut;
- the "read" head-word filter;
- "my company is growing fast";
- "an app called X";
- sentence-level sensitivity.

All were fixed generally, not per phrase. After that the check set is no longer independent, and the "after" column is not a held-out result. Results are identical in both flag profiles.

**Lifecycle integration** (per achieved goal):
- `achievedBy` is recorded, with when-as-said in 5 of 10 dev cases where the user gave one ("last week", "on Sunday", "yesterday");
- one history entry;
- a `resolved` transition on the profile's goal fact.

The previous missions' evaluations are unchanged (§5).

## 5. Regression tests

**New: `src/memory/tests/intentOutcome.test.js`, 32 tests:**
- achievements through both stores;
- 12 kinds of non-achievement;
- several goals, and related-fact changes;
- the shared reader;
- rendering, and goal creation;
- entities, multi-fact extraction, per-clause sensitivity, and questions.

**Bite checks.** 22 mechanisms were disabled one at a time.

Twenty bite (each disabling made at least one test fail):
- the achievement reader, the object head, partial completion in `closeKind`, sarcasm in `closeKind`;
- the cue's `reportsDone` gate, and named-goal-only cues;
- the user subject, not-asserted, quantity, verb stemming, goal-sync of achievements;
- the name-only slot, clause splitting, the inverse role, the question guard, per-clause redaction;
- stated goals, the "(achieved)" label;
- "my company is X" (schema pattern and alias mapping together).

Two do not bite, both because another check catches the same cases:
- **"my company is X" via the schema pattern alone:** the fallback's alias mapping also reaches workplace.
- **The achievement reader's own sarcasm check:** the subject and object-head checks already reject every sarcastic phrasing tested.

All files were restored and verified by hash after each bite.

Three bites were invalid as first written: two edits that were no-ops, and one with backslashes lost in the shell. They were rewritten and re-run, and the numbers above are from the corrected runs. The first round also showed that three guards were masked in the tests by a second guard. Cases isolating each one were added; one of them exposed a real gap (sarcasm in the profile store's older closer), which is now fixed.

**Existing suites:**
- `src/memory`, `src/mind`, `src/understanding`: all pass.

Three existing tests failed during development. Each was fixed in the code; no expectation was changed:
- **The ETH-application deadline label:** my fallback lowercased keys and lost "ETH". It now keeps the user's casing, as before.
- **"Finally shipped the billing migration!"** stopped completing the goal. Release verbs are now completion, and a subjectless opening counts.
- **An expected history reason of "completion cue":** that path is kept, now gated by the shared reader.

**Two existing tests were updated, with the reason recorded in each:**
- **`profileLaterWords.test.js`:** an achieved goal's history line now carries "(achieved)". The assertion now *requires* the label rather than merely allowing it.
- **`memoryDeliveryUnreachableDb.e2e.test.js`:** the fixture's "Razorpay is our main competitor" is now extracted as a fact (it never was before). It isn't relevant to the test's question ("where do I work and who is my co-founder?"), and it *is* ranked and delivered when asked about (verified). The assertion "every stored fact reaches the prompt" was a proxy that held only while that sentence extracted nothing. It now checks its stated intent: every *ranked* fact reaches the prompt, and the facts the question asks about are ranked and present.

**A regression caught by the gate, and fixed.** The capture-core gate changed from blocked-on-improvement (20 fully captured) to passing at the baseline (19). That signalled a lost case, not a fix. The cause was the new inverse pattern: "Growth is my top priority this quarter." became the fact `custom_top_priority_this_quarter = "Growth"`, because every sentence opens on a capital. The next sentence then ended that fact, and the lifecycle archived the first sentence. The inverse form now applies only to relationship roles (client, co-founder, accountant, competitor…). The case is captured again, and the gate is back at 20 (blocked only by its known `n_cases_` shape rule, baseline untouched).

**Final verification:**
- **Full DB-free test run:** **2,794 tests, 2,786 pass, 0 fail**, 8 skipped (Postgres-only).
- **Gate:** 16 of 17 suites pass; capture-core blocked only on the shape rule.
- **Previous missions' evaluations unchanged:**
  - cross-store: 0 outdated-as-current, 3/3 consistent, dependents 8/8, 0 false flags;
  - lifecycle: 4/4 stores on every path, recovery and crash rows as before;
  - goal lifecycle: now also agrees for "achievement, no closure verb", where both stores are completed;
  - 199 dev questions: outdated-as-current 1/90, correct current 9/9, false updates 0/12, history 9/9 (dev-env) and 8/9 (code-defaults), as before. Tokens per question 752 → 775 (dev-env) and 526 → 551 (code-defaults), about +3–5%, from clause-level extraction storing more facts.

## 6. False-positive analysis

**False goal completions:** 0 of 26 goals that had to stay open, across both sets. Before, 6 of 26, all from the keyword cue or the older closers:
- a competitor's launch;
- a first draft;
- a third swimming lesson (check set);
- related cases.

What still guards against false completions, and where it could fail:
- **The noun-phrase heuristic:** the object is read up to the first preposition or time word. "I finished the report for the half marathon club" would read "report", correctly not the marathon. But "I won the regional chess tournament of my club" stops at "of" and reads "tournament", which is fine. A goal phrased around a preposition ("move to Lisbon") has its object after the preposition, which these rules skip. **Untested.**
- **Synonyms beyond the list:** only the goal's own verb, completion verbs and release verbs are recognised. "I'm officially a nurse now" or "Lisbon, here I am" close nothing (a missed achievement, not a false one).
- **Same-spelling verbs** ("read", "hit") need a past-time marker. "I read the last chapter of my twentieth book" with no time marker closes nothing.
- **Sarcasm** is limited to a fixed list of frames ("yeah right", "as if", "in my dreams"); irony without such a marker is not detected.
- **"We" counts as the user.** "We" for a family or team goal is accepted; "we" meaning a group the user isn't really part of is not distinguished.

**Entity and relationship false positives:**
- **"Northbeam is my client" vs "my company is Northbeam":** distinct keys, tested.
- **"My company, Northbeam, is based in Denver":** no city stored, tested.
- **Clause splitting inside names:** none in the test cases ("Johnson and Johnson LLP", "Ernst and Young").
- **A split at a comma before "my" in a list of roles is intended.** A list like "Me, my wife and my son" yields no facts, because there's no "is".
- **Sensitivity granularity: privacy now depends on the clause.** "My doctor is Dr. Maya Chen and my dentist is Dr. Omar Haddad" stores the dentist and withholds the doctor, because "dentist" was never a health word in `sensitivity.js` (alone, it was always stored). Clause-level redaction makes this existing gap visible. The taxonomy is unchanged; it's a candidate for review. The doctor and dentist case is the one multi-fact "failure": by design without opt-in. With opt-in, both facts are extracted separately with their titles.

## 7. Answer-evaluation readiness

**Inputs.** The previous plan (`TEMPORAL_ANSWER_EVAL_PLAN_2026-11-02.md`) and `scripts/lift-legacy-answers.mjs` answer and judge with hosted models. Nothing here calls one.

**`scripts/answer-eval-harness.mjs`** (model-independent):
- **`contexts`:** replays each life through the real production prompt path (`routes/chat.js prepareTurn`, legacy read, production code-default flags or `--profile dev-env`) and records the system prompt each question gets, for any code tree. **Previous production** is the committed `HEAD`, extracted with `git archive` into a temporary folder (no git state touched; `node_modules` linked). **Current** is this tree.
- **`prepare`:** one JSONL record per question and condition, `{id, condition, category, system, user}`, for any answerer. Produced: 24 prompts (12 questions × before/after).
- **`grade`:** scores answers `{id, condition, answer}` against deterministic criteria: current value given, retired value only as past, goal status, hedging on uncertain dependencies, personal context used, unsupported names, abstention. It reports per category, per condition, and paired better/worse/same.
- **`selftest`:** grades each question's good and bad example answer. **12 of 12** separate. Its first run caught two rubric defects (a sentence-opening word merged into a name), fixed before any real answer.
- **`sufficiency`:** model-free; does the prompt contain what a correct answer needs?

**Context sufficiency, both profiles identical:**

| Question | `HEAD` (production) | Now |
|---|---|---|
| q01 / q07 current employer (retired value marked as past) | gap | ok |
| q02 historical | ok | ok |
| q03 / q11 / q12 goal status (achieved goal marked done) | gap | ok |
| q04 uncertain dependency (Atlas flagged) | gap | ok |
| q05 personal context, q06 / q10 abstention, q09 client | ok | ok |
| q08 accountant | gap | gap: **criterion flaw**. "Priya Rao" is `notCurrent` for grading the answer ("your accountant is Priya Rao" is wrong), but she *is* current as manager, so the model-free check misfires. Label unchanged; it applies to answers, not to contexts |
| **total** | **5/12** | **11/12** |

**What is needed to run it.** An answerer that is isolated, free and authorised, and not shared with Lift. Then:
- answer the 24 prompts;
- run `grade`;
- optionally add an LLM judge as a second, frozen grader;
- report paired results with the rubric's limits.

The rubric is a deterministic proxy: string and sentence rules, not meaning.

## 8. Remaining limitations

1. **Still rule-based understanding.** It is structural (subject, verb, object, assertion, quantity, part versus whole), not keyword-based. But it is English-only, with no parser or model: complex syntax, idioms ("I'm officially a nurse now"), irony without markers, and objects after prepositions ("move to Lisbon") are not read.
2. **The goal's object comes from its title.** A goal stated vaguely ("my goal is to get fit") has no checkable outcome, and nothing closes it except an explicit closure word, which is the correct conservative behaviour.
3. **Pronoun objects aren't resolved.** "I finally did it!" achieves nothing, even right after naming the goal, unless the goal is named in the same message.
4. **Clause splitting needs an explicit new subject.** "My manager is Priya Rao, my accountant Lena Ortiz" (elided verb) yields only the manager.
5. **Role words create `custom_` keys** when the schema doesn't know them ("skip-level", "biggest client"). They are queryable and propagate, but they aren't typed as person or organisation: no entity typing was added.
6. **Sensitivity per clause** exposes that "dentist" (and possibly other health roles) isn't in the health vocabulary (§6).
7. **Development-scale measurement.** 25 + 15 achievement cases, 19 entity cases and 16 multi-fact cases, by the same author. The check set lost its independence after its first run.
8. **No answer-level measurement.** That needs an authorised isolated model.

## 9. Recommended next milestone

**Run the answer pair, then widen understanding with a measured, model-assisted reader.**

1. **With an isolated, authorised, free answerer:**
   - run the 24 prepared prompts;
   - grade with `answer-eval-harness.mjs grade`;
   - add a frozen LLM judge only as a second grader;
   - report paired before/after per criterion.
2. **Write a held-out set before touching the code again,** by someone other than the author if possible: achievements, relationships and multi-fact messages. Measure the current reader on it as-is.
3. **Then decide where a small local model would add value.** For the cases rules cannot read (idioms, pronoun objects, elided verbs), a model proposes and the shared reader's checks verify (subject, assertion, object match). The output must be checkable against the goal's structure, never trusted directly.
4. **Review the health vocabulary**, now that redaction is per clause.
