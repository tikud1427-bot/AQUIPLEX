# Temporal profile consistency — report (2026-11-02)

Main development tree, uncommitted. Lift v4b (pid 10568) untouched. No provider calls, no model
download, no Postgres-backed tests. Every evaluation and test uses a private temporary data
directory. No baseline was changed.

**Result (context level, development data).** "Memory block" means the sections the prompt frames
as authoritative or current: IDENTITY, USER PROFILE, COGNITIVE MODEL.

| | Before | After |
|---|---|---|
| Outdated value presented as current in the memory block, all 182 dev questions | **11.3%** (9/80 change questions) | **0.0%** |
| Same, profile-consistency set | 70.0% (7/10) | 0.0% |
| False updates on no-change controls (negated, speculative, hypothetical) | 0/3 | 0/3 |
| Whole prompt: stale statement without its update | 3.8% | 1.3% |
| Historical questions (old value still available) | 100% | 100% |
| Tokens per question | 747 | 769 (+3%) |

Identical under the dev `.env` flags and under code defaults (no `AQUA_*` set). Answer quality is
**not measured** (no model calls, as required).

## 1. Existing profile architecture (verified in code)

- **Store.** The legacy fact store (`memory/longTermMemory.js`), held per owner in the same Mind
  store as the cognitive model, keyed (`workplace`, `city`, `custom_biggest_client`…), with version
  history and an `archived` status.
- **Extraction.** `memoryObserve` (`memory/engine.js`) on every turn:
  - schema plus free-text extraction (`candidateExtractor` / `memoryExtractor`), through one
    conflict resolver (`storeResolved`: duplicate / merge / overwrite / correction);
  - explicit corrections ("actually my X is now Y", step 4);
  - since 2026-10-29, `factChange.js`: re-keying "my new X / my X is now Y", and date/amount
    changes ("the thesis deadline moved to June 13") on the one named fact (step 4a).
- **Into the prompt.** `memoryRetrieve`:
  - IDENTITY card (`identity.js`, from the identity keys; "authoritative… never claim you do not know");
  - USER PROFILE (`memoryRetriever.formatFactsForPrompt`, undated, "If asked about these topics, rely on this profile");
  - COGNITIVE MODEL (`mind/mindRetriever.js`).

  This block comes first in the system prompt. The ordered evidence and recall quotes come later,
  fenced as untrusted material.
- **Lifecycles differ.** The profile changed only when a later turn produced the *same key with a
  new readable value*. The cognitive model (after this morning's pass) follows later words in its
  own working memory and goals. Its *beliefs* (Identity, Preferences) follow neither.

## 2. Root causes

1. **The profile only changes through a few exact phrasings.** An ending ("I resigned from Hartwell",
   "I sold the Civic"), a replacement ("Now Mellow is my biggest client"), a departure ("Derek Shaw
   moved to another branch"), a relocation ("We relocated to Bristol"), a partial change ("…720
   euros for new clients", deliberately not applied) and a completed goal ("I passed the CFA…") all
   left the old line as current, under "rely on this profile".
2. **"passed the exam" was not a resolution**, so the cognitive model also kept the goal: profile
   and cognitive model agreed on something false.
3. **Cognitive-model beliefs never consult the facts.** After the profile was fixed, the prompt said
   `Company: Hartwell Bank (since changed — "I resigned…")` *and* `Identity: organization: Hartwell
   Bank (user said)`.
4. **The change reader had no negation or speculation guard.** "I haven't **left** Hartwell"
   counted as a change word. Found by a control before any profile code used it.
5. Found while auditing every new annotation by hand, not by the labels:
   - third parties' changes looked like the user's ("Mei Tan left Coinwise", "Imran will be the lead
     for Splitpay from now on");
   - an open state looked like a new value ("the opening is blocked by a zoning permit").

## 3. Changes implemented (one reader, no new store or system)

| File | Change |
|---|---|
| `understanding/stateTransition.js` | `changeKind`: resolved, ended or changed, **only when stated as fact** (`speculative` guard; negation guard extended to change words). Plus `namesOf`, "passed the/my", "relocated" |
| `memory/factChange.js` | `laterWordsOnFacts`: per clause, about ONE stored fact (two shared subject words / a name from the value / past-tense relocation for the city). The change must be the user's or the fact's own thing's; open states are skipped; ambiguous → nothing. The note carries the user's whole sentence |
| `memory/longTermMemory.js` | `noteLaterWord`: the fact keeps its value; `laterWord` = {text, kind, at}; earlier ones kept in `laterWords`. A new value replaces the fact (and so clears it); restating the same value clears it |
| `memory/engine.js` | Step 4c in `memoryObserve` (redacted text only; facts that existed before the turn and were not re-valued by it). Later words feed recall's "since changed" notes and the cognitive model |
| `memory/memoryRetriever.js`, `memory/identity.js`, `memory/displayLabels.js` | Profile and identity lines render `(since changed — they said: "…")`, plus one rule line (§4) |
| `mind/mindRetriever.js`, `mind/index.js` | Identity / Preferences beliefs with the same value carry the same note |
| `mind/goalTracker.js`, `mind/workingMemory.js` | Same speculation guard on the Mind's update paths |

Rules the requirements asked for, and how they hold:
- **History preserved:** no value is deleted or rewritten by this path; old values stay visible as "what was true before".
- **Provenance:** every note is the user's verbatim sentence with when and which kind of change.
- **Confidence:** fact confidence is unchanged.
- **Negated / speculative / hypothetical / ambiguous:** no change, with tests for each.
- **Deadlines:** keep the history and the new full date (Mind working memory, this morning).
- **Preferences:** the old value plus the user's words when the profile or Mind holds the
  preference. See §6: preference changes are often not captured at all.
- **Account isolation and deletion:** unchanged. Later words live on the owner's own fact and are
  purged with it.

## 4. Evidence hierarchy

Every source now marks a change the same way, decided by the same reader (`changeKind`):

| Source (prompt order) | Marker |
|---|---|
| IDENTITY, USER PROFILE | `(since changed — they said: "…")` + rule line |
| COGNITIVE MODEL | goals (since changed), beliefs (same note), working memory retired to history |
| Evidence block | oldest → newest, "the later one is the current state unless marked disputed" |
| Recall quotes | dated, oldest first; `↳ since changed — now: "…"` (now also from profile later words) |
| Current conversation | the window, in order |

The rule, stated once in each authoritative block: *a line marked "since changed" is what was true
before; the user's words beside it are the latest they told you. Answer from those, and when they
do not give the new value, say so rather than guess.*

The newest sentence does **not** win by being newest. Only an explicit resolution, ending,
change or correction does, and only if it is not negated, speculative or hypothetical, is about one
fact, and is the user's or the thing's own change. Speculation stays as the user's verbatim words
in recall and evidence, marking nothing.

**Can an outdated statement still override a newer one?**
- In the memory block on these sets, no: 0 remaining.
- In the evidence block the order note still governs.
- Whether the *model* follows the rule is an answer-level question, not measured here.

## 4b. Evaluation

- `aqua/eval/datasets/profile-consistency.dev.v1.json` + labels (sha256 `cb7eebd3…` / `4fd1251c…`),
  written before the change: 12 users, 14 questions, covering:
  - ending, replacement, departure, relocation, partial change, goal completion, preference
    change, resolved blocker, moved deadline, a historical question;
  - controls: negated, speculative, hypothetical future.
- New label `stillCurrent`: a false update is counted when such a value is missing, or only shown with a note.
- Run with v3 and the three dev sets from today (182 questions), with
  `scripts/temporal-resolution-eval.mjs` (`--profile dev-env|code-defaults`, regimes short/padded).
- **Metric bug found and fixed before reporting.** The stale-as-current filter ran on
  whitespace-normalised text, so any annotated line hid the whole memory block. Fixed: raw lines.
  All before/after arms were recomputed from the recorded prompts by one script
  (`scripts/authority-recompute.mjs`). This morning's 10.0% → 2.9% is confirmed under the fixed metric.

## 5. Regression tests

- `src/memory/tests/profileLaterWords.test.js`: 15 tests through `memoryObserve` → `memoryRetrieve`,
  each with a control. Turning off each mechanism makes tests fail:

  | Mechanism disabled | Tests failing |
  |---|---|
  | engine step 4c | 7 |
  | speculation guard | 1 |
  | whose-change guard | 1 |
  | open-state guard | 1 |
  | restatement clearing | 1 |
  | rendering note | 5 |
  | cognitive-belief note | 1 |

  (Before a dedicated control was added, the speculation guard showed 0 failures; it now has one.)
- `src/understanding/tests/stateTransition.test.js`: `changeKind` / `speculative` cases.
- DB-free battery, clean run (mind, understanding, memory, pic, brain, cognition, routes, files,
  eval/tests): **2,716 tests, 0 failures**, 8 skipped (Windows-only and live-DB suites). One intermittent failure in an earlier run
  (`files/tests/evidenceStore.test.js` persistence) happened while two batteries overlapped. It
  passed 4/4 alone, and `src/files` is unchanged.
- DB-free gate: 16/17 PASS. `capture-core` BLOCKED by `n_cases_*` outcome counts read as dataset
  structure (reported before; baseline untouched).

## 6. Remaining inconsistencies across production context sources

1. **Preference changes are often not captured** in the profile or the Mind at all (p11, a04).
   They reach the answer only through recall and evidence.
2. **New values are noted, not applied.** "Now Mellow is my biggest client" leaves `Oakline (since
   changed — …)` and relies on the model reading the note (answer-level unmeasured).
3. **The evidence block** marks change only by order and "later is current"; its facts all carry
   confidence 0.60, with no confidence signal.
4. **Subject detection is lexical**: first-person words, or a name in the first three words. "After
   lunch, Derek Shaw moved…" would be missed (conservative: no note), and so would semantic
   relocations without "moved/relocated to".
5. **Duplicate lines**: the identity card and profile repeat the same fact (`Company:` + `workplace:`).
6. **Extraction quality outside temporal scope**: `cofounder: And`, `Company: Hartwell Bank as a risk analyst`.
7. The canonical World Model's typed supersession still never reaches production answers (legacy read).

## 7. Recommended next product improvement

**Apply the new value when it is unambiguous, keeping the note for the rest.** When a later word
states the slot and a new value in a recognisable form, store the new value as a correction, with
the old one in version history. Forms: "X is now my Y", "my new Y is X", "our new Y is X", "moved
to <Place>" for the city, "I now work at <Org>". Keep the "since changed" note for endings and
partial changes. That removes the model's need to infer the current value from a note.

**Then run the answer-level pair** (`TEMPORAL_ANSWER_EVAL_PLAN_2026-11-02.md`; recorded contexts
`eval/out/contexts.{before,after}-profile.*.json`) once Lift has finished. Only that shows whether
these context changes improve real answers.
