# AQUA Capture Integrity V1

**Sprint 4, 2026-11-10/11** · `main` @ `839ea0d1` · **uncommitted** · not deployed

**Scope.** Memory capture, the code that turns a user message into stored facts and Mind goals.

**Not gated.** Unlike the Information Needs Engine, these are fixes to default behaviour. They take effect for every user the next time this code is deployed.

## 1. The three source defects

Sprint 3 found these defects and worked around them inside the engine. They are now fixed where they originate.

| # | Defect | Reproduced before the fix | Root cause |
|---|---|---|---|
| 1 | Questions extracted as user facts | `Where does my sister work?` → `siblings: Work`<br>`What's my dog called?` → `pets: {name: "called"}`<br>`Is my sister called Ana?` → `siblings: Called`<br>`Plan a dinner for my partner and me` → `spouse: And` | Every schema pattern ran on every sentence. The only question guard was in the custom-fact fallback. |
| 2 | Numbers truncated during extraction | `I work as a nurse manager at St Aldric Hospital and earn 58,000 a year.` → `workplace: St Aldric Hospital and earn 58` | 37 value patterns ended at `\s*[,.!?]`, so a thousands separator or decimal point ended the value. The workplace capture also ran on through "and earn…". |
| 3 | Questions recorded as user goals | `Can you help me plan my training this week?` → `goal: plan my training this week` (fact store and Mind) | The `help_me_goal` pattern read any "help me <verb>" request as an aim. The Mind's goal tracker then trusts extracted goal facts. |

Found and fixed while doing this. All of these were **pre-existing**, not introduced by Sprint 4:

| Defect | Before | After |
|---|---|---|
| City capture ran on through a lower-case phrase | `I live in Aarhus with my two cats.` → `city: Aarhus With My Two Cats` | `city: Aarhus` |
| A verb captured as a relation's name | `My partner wants to adopt a greyhound.` → `spouse: Wants`<br>`My brother quit and joined…` → `siblings: Quit` | no fact |
| A job change said as an event was not captured (Sprint 3 finding 4) | `I just started a new job at Northbeam.` and `I quit Hendry & Ross and joined Calder Legal as a solicitor.` → nothing | `workplace: Northbeam`; `workplace: Calder Legal` |

## 2. What was built

### Speech-act classification — `aqua/src/understanding/speechAct.js` (new)

This module decides what a sentence *does* before capture reads what it *says*. It is deterministic and lexical, with no model call.

| Act | Example | Capture |
|---|---|---|
| assertion | "I teach chemistry in Leicester." | read |
| negation | "I don't have a car." | read (patterns already respect negation) |
| correction | "Sorry, my sister is Josie not Jodie." | read (the resolver's correction path) |
| preference | "I hate coriander." | read |
| goal | "My goal is to learn Italian." | read |
| intention | "I'm going to repaint the kitchen." | read |
| intention, hedged | "I'm thinking about going freelance." | read as **hedged** only |
| prediction | "I'll probably get the promotion." | read as **hedged** only |
| remember | "Remember that my locker is 217." | only the embedded statement |
| question | "Where does my sister work?" · "I wonder if I should move." | **not read** |
| request | "Help me plan my wedding." · "Remember to call mum." | **not read** |
| hypothetical | "If I moved to Lisbon, would I be happier?" | **not read** |

- **`assertedPart(sentence)`** keeps a leading statement when a question or request follows it. For example, `I live in Leeds, can you recommend a gym?` → `I live in Leeds`.
- **An aspiration said as a request is still the user's aim.** "Help me become a billionaire within a year" stays a goal, which an existing test requires. A *task* said as a request ("help me plan my training", "help me write an email") does not.

**False positives guarded against:**
- sentence-initial nouns: "Book club is on Tuesdays", "Name's Rosalind", "Plan B is…", "Design is my passion";
- statement wh-clauses: "What I really want is…", "When I write emails, I prefer…";
- "Will Smith is my favourite actor".

### Where it is applied

- **`memory/candidateExtractor.js` `extractAllCandidates`.**
  - Each sentence is reduced to its asserted part before any pattern runs. Non-assertions are logged as `NO_MATCH … act=<act>`, with metadata only.
  - Predictions and hedged intentions mark candidates `hedged`. The existing resolver then never lets them replace a confirmed value, and they display as uncertain.
  - Every candidate carries `speechAct`. `toLegacyFact` stores it as `metadata.speechAct`, beside the existing `sourceSentence` and `confidence` provenance.
- **`mind/goalTracker.js` `trackGoals`.** Goals are detected only from the asserted text of the message.

### Number integrity

- **`memory/memorySchema.js`:**
  - 37 value terminators made digit-aware: `[,.!?]` became `[,.!?](?!\d)`.
  - The workplace captures accept `,` inside a number.
  - The new `orgName` cuts at a lower-case predicate ("…Hospital and earn…"). It is case-sensitive, so "Marks and Spencer" stays whole.
- **`candidateExtractor.truncatedNumber`** is defence in depth. A candidate whose trailing number the sentence continues past a separator is dropped. The sentence stays quotable.

### Other capture fixes

- **`placeName`** for `live_in`.
- **`relationName`** for spouse and sibling names: the same casing evidence as the existing `introName`, plus a stop-list of common verbs.
- **Two event patterns** for a job change: `started a new job at X`, and `joined X as a/an…` (also after "I quit … and joined").
  - The name must be capitalised.
  - "My brother … joined X" is not the user.
  - "I now work at X" is deliberately left to the existing change path, which also moves the role. An earlier attempt that captured it here broke `oneChangeEveryStore.test.js`, so it was removed.

## 3. Verification

### Tests

| Test file | Result |
|---|---|
| `understanding/tests/speechAct.test.js` (new) | 9/9 |
| `memory/tests/captureIntegrity.test.js` (new): end to end through `memoryObserve` plus the Mind; the three defects, provenance, hedging, legitimate capture preserved | 16/16 |
| memory + mind + understanding directories | 858 pass, 0 fail, 7 todo — the same 7 known todos as before |

**Two intermediate regressions were found and fixed before the final run:**
- **10 failures.** "Help me become a billionaire" had stopped being a goal, and "I now work at Northbeam as a senior analyst" was pre-empting the change path.
- **1 failure.** The Aarhus case.

### Effect on the production default context (ACIB arm A, context level)

| Set | Before | After |
|---|---|---|
| ACIB v1, short history | stale-as-current 2, irrelevant 82 | stale-as-current 1, irrelevant 76 |
| ACIB v1, long history | stale-as-current 2, irrelevant 218 | stale-as-current 1, irrelevant 209 |
| Held-out v1, short / long, irrelevant items | 65 / 85 | 62 / 82 |
| ACIB v2 eval (A) | 452 irrelevant | 451 irrelevant |

Correct-case counts are unchanged in every one of these sets.

**Effect on the engine.** The cleaner capture surfaced a cross-entity issue in the engine. A trusted `siblings: Tomas` fact now carried its sentence ("…lives in Ghent…") inside a structured line. It is handled in Information Needs V2: facts about other people travel as the user's own sentence.

## 4. Limits and what this does not do

- **Lexical classification.** Unusual phrasings can be misread.
  - Known example: "How I met my wife was funny" is correctly a statement, but other statement-shaped wh-clauses may not be.
  - A misread *question* now stores nothing, which is the safe direction. A misread *statement* as a question loses a fact; its words remain quotable in recall.
- **Facts already stored are not cleaned.** Users who already have `siblings: Work`-style values keep them until they are corrected or forgotten. A cleanup is a data migration and needs separate approval.
  - The engine (V2) still ignores question-sourced facts.
  - Legacy recall still shows them.
- **Not fixed:**
  - `I started work at nine today` → `project: work` (pre-existing, `founded` pattern);
  - the multi-sentence forget-hint bug (Sprint 1);
  - "Forget my address" not redacting history-only data. The engine works around this; legacy recall does not.
- **This changes memory semantics by default.** The Sprint 4 brief asked for it, but it ships with the next deploy of this code, not behind a flag. Review accordingly.
