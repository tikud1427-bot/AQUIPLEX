# Sprint 5 — Capture Integrity V1: Capture-Only Release Review

**Date:** 2026-11-11 · **Repository root:** `C:/Users/dell/Downloads/aquiplex-platform/aquiplex-platform` · **Branch:** `main` · **HEAD:** `839ea0d167025e1ad7085668727ff65452d51335` (verified) · **Working tree:** 105 paths (36 modified, 69 untracked), all preserved.

No commits, no migration, no production change. The verification runs below used isolated data directories. The real store `~/.aquiplex/.aqua-mind.json` was not opened (mtime 2026-11-10 11:18:28, unchanged).

## 1. File-level inventory

The working tree mixes Sprint 1, 2, 3 and 4 work. I attributed each change by reading its `git diff` against HEAD hunk by hunk.

### 1a. Capture Integrity V1 — the deployable unit

| File | Status | Capture-only? | What the capture change is |
|---|---|---|---|
| `aqua/src/understanding/speechAct.js` | new (untracked) | **yes, entire file** | Speech-act classifier, `assertedPart`, `assertedText`. No imports. |
| `aqua/src/memory/memorySchema.js` | modified | **yes, every hunk** (no log or other changes in this file) | 37 digit-aware terminators; `orgName`, `placeName`, `relationName`; 2 job-change patterns. |
| `aqua/src/mind/goalTracker.js` | modified | **yes, every hunk** | `trackGoals` reads goals only from `assertedText(...)`; adds 2 imports. |
| `aqua/src/memory/candidateExtractor.js` | modified | **mixed** | **Capture:** `truncatedNumber`; the speech-act gate in `extractAllCandidates`; the `speechAct`/`hedged` fields; the `NO_MATCH … act=` log line. **Sprint 1 (log safety):** the `logSafety.js` import and the `MATCH`/`NO_MATCH` lines rewritten to metadata. |
| `aqua/src/memory/memoryExtractor.js` | modified | **mixed** | **Capture:** 3 lines adding `metadata.speechAct`. **Sprint 1:** the `logSafety.js` import and 4 log lines rewritten to metadata. |
| `aqua/src/understanding/tests/speechAct.test.js` | new | yes | 9 tests |
| `aqua/src/memory/tests/captureIntegrity.test.js` | new | yes | 16 tests |

### 1b. Not part of Capture Integrity (excluded from a capture-only release)

| Workstream | Files |
|---|---|
| **Information Needs V2** (gated, off) | `aqua/src/brain/contextEngine/informationNeeds.js` (Sprint 3 file plus V2); `aqua/src/brain/tests/informationNeedsV2.test.js`; `aqua/src/brain/tests/informationNeeds.test.js` (updated assertions) |
| **Shadow instrumentation** | `aqua/src/routes/chat.js` (the `[NEEDS]` line: hashed owner and `reason=`; the Sprint 3 wiring at step 5c¹, alongside Sprint 1 changes in the same file); `aqua/src/routes/tests/infoNeedsShadowReadiness.test.js`; `aqua/src/routes/tests/informationNeedsRoute.test.js` |
| **Benchmark** | `aqua/eval/datasets/acib.v2.*`, `aqua/eval/datasets/src/*`, `aqua/scripts/build-acib-v2.mjs`, `aqua/eval/suites/acib-v2-*.suite.mjs`, `aqua/eval/acib/results/*`, `aqua/eval/adapters/acibPipeline.mjs` (opt-in `capturePrompt`) |
| **Answer evaluation** | `aqua/eval/answer/*`, `aqua/scripts/answer-eval.mjs`, `aqua/eval/tests/answerGrader.test.js` |
| **Earlier sprints, still uncommitted** | **Sprint 1:** `core/logSafety.js`, `utils/logSafety.js`, `core/flags.js`, `core/mongoMirror.js`, `memory/turnCommit.js`, `memory/engine.js`, many log-only edits. **Sprint 2:** ACIB v1. **Sprint 3:** the engine and its suites. |
| **Documents** | All `AQUA_*` and `AQUIPLEX_*` markdown files at the root. |

## 2. Dependencies of a capture-only release

| Dependency | Why | Options |
|---|---|---|
| **`aqua/src/core/logSafety.js`** (Sprint 1, untracked; imports only `node:crypto`) | The capture hunks in `candidateExtractor.js` use `textMeta` in the new `NO_MATCH … act=` log line. Both mixed files already import `logSafety.js` through their Sprint 1 hunks. | **A (recommended):** release capture **together with the Sprint 1 log-safety hunks of these two files plus `core/logSafety.js`**. That is itself a privacy fix: those lines printed user text at HEAD. **B:** split hunks so only capture lines go out, rewriting the new `NO_MATCH` line without `textMeta`. More surgery, and it keeps raw-text logging in those files. |
| `aqua/src/memory/sentenceParser.js` | `goalTracker.js` imports `splitSentences`, `candidateExtractor.js` imports `splitClauses`. | Unchanged at HEAD; both already exist. No action. |
| Mind, longTermMemory, resolver | `hedged` and `metadata.speechAct` flow through the **existing** hedging path (`memoryResolver` "hedged keeps confirmed"; `longTermMemory` metadata passthrough). | Present at HEAD; no change needed. |
| Information Needs engine | **None.** The engine has its own question and request filters and its own `truncatedNumber`, and does not import `speechAct.js`. Capture does not import the engine. | Independent in both directions. |

**Minimal capture release set (option A):**
- `speechAct.js`, `memorySchema.js`, `goalTracker.js`, `candidateExtractor.js`, `memoryExtractor.js`, `core/logSafety.js`;
- the 2 test files.

Plus, if the battery is run in CI, the `core/tests` and `tests/platform` tests that cover `logSafety`.

**Open item (not done).** Because the mixed files also carry Sprint 1 hunks, a clean capture-only commit should be built and tested in isolation **before** release. Commit A1 would be `logSafety.js` plus the log hunks; commit A2 would be the capture hunks. Creating commits was out of scope here.

## 3. Behaviour verification (this sprint)

Method: a scratch script ran the real `extractFactsWithReport`, `trackGoals` and `memoryObserve` in an isolated data dir. It ran **once against the working tree** and **once against a read-only `git archive HEAD` export in the scratchpad** (not a worktree, not a project directory). The outputs were diffed. All 45 sentences behave as intended. Every difference from HEAD is an intended fix, and there are **no regressions in the set**.

| Category | Working-tree behaviour | Differs from HEAD? |
|---|---|---|
| **Questions vs assertions** | "Where does my sister work?" / "Is my wife called Mia?" / "Do I live in Leeds?" → nothing. "My wife is Mia." → `spouse=Mia`; "I live in Leeds." → `city=Leeds`. | **Yes, fixed.** HEAD stored `siblings=Work`, `spouse=Called`, and `siblings=Works` (from "My sister works at Stripe"). |
| **Hypotheticals vs events** | "If I moved to Lisbon…", "Suppose I worked at Google", "What if I quit my job at Fenwick?" → nothing. | Same as HEAD for these sentences. **Gap (pre-existing):** the events "I moved to Lisbon." and "I quit my job at Fenwick." are not captured as facts either. |
| **Intentions vs completed actions** | "I'm going to move to Porto next year" and "I will start at Northbeam in May" → no current fact. "I'm planning to join Brightmoor" → `goal=join Brightmoor` (an intention, not a workplace). "I joined Brightmoor as a QA lead" → `workplace=Brightmoor`. "I just started a new job at Northbeam" → `workplace=Northbeam`. | **Yes, improved:** the last two were not captured at HEAD. |
| **Preferences vs facts** | "I love Lisbon" → `likes=lisbon`, **not** `city`. "I live in Lisbon" → `city=Lisbon`. | Same as HEAD (already correct). |
| **Predictions vs confirmed** | "I'll probably be working at Google next year" → nothing. "I think I work at Halcyon Labs" → `workplace` **hedged**. End to end: "I work at Fenwick", then "I'll probably be working at Google…" → workplace stays **Fenwick**. | The hedging path existed at HEAD. Speech acts add hedging for predictions. |
| **Corrections** | "Actually, my sister is Josie not Jodie" → `siblings=Josie`, tagged `correction`. | Same value as HEAD; provenance tag added. |
| **Negations** | "I don't live in Leeds anymore", "I'm not a nurse", "I no longer work at Fenwick" → no new fact (endings go through the existing change path in a full turn). "My wife isn't called Mia" → `relationship_status=married` only. | **Yes, fixed:** HEAD stored `spouse=Isn'T`. |
| **Numbers, currencies, commas, decimals, units** | `58,000` · `€1,250.50 a month` · `£3.5k` · `12.5%` · `1.5 million` · `217` · age `41` all stored whole. "…St Aldric Hospital and earn 58,000 a year" → `workplace=St Aldric Hospital`. | **Yes, fixed:** HEAD stored `workplace=St Aldric Hospital and earn 58`. **Gap (pre-existing):** "I earn $58,000 a year" has no income pattern, so it stays quotable in recall only. |
| **Questions becoming goals** | "Can you help me plan my training this week?", "Should I learn Spanish?", "Help me write an email.", "What if I wanted to run a marathon?" → no goal. "My goal is to run a marathon." → goal. "Help me become a better writer." → goal (an aspiration). | **Yes, fixed:** HEAD stored `goal=plan my training this week` and `goal=write an email`. End to end, a questions-only person now has **0 facts and 0 goals**; HEAD gave 2 facts and 1 goal. |

### Existing users' stored data is not modified

1. **Static check.** The capture diff adds no store access: no `migrat*`, `writeFile`, `storeFact`, `deleteFact`, `touchMind`, `persist` or `getFacts` in added lines; `speechAct.js` imports nothing. There is no migration, no startup rewrite and no backfill.
2. **Dynamic check (isolated store).**
   - Wrote legacy-style bad facts (`siblings: ["Ana","Work"]` sourced from a question; `workplace: "St Aldric Hospital and earn 58"`).
   - Ran three unrelated turns through `memoryObserve`.
   - Both values were **byte-identical afterwards**; only the new `likes=jazz` was added.
3. **Consequence (unchanged from Sprint 4).** Users who already hold bad values keep them until they correct or forget them. Cleaning them would be a migration, which needs separate approval and was not created.

### Tests (current tree)

| Command (from `aqua/`) | Result |
|---|---|
| `node scripts/run-tests.mjs src/memory src/mind src/understanding` | 865 tests: **858 pass, 0 fail**, 7 todo (the same known todos) |
| Included above: `speechAct.test.js` (9) and `captureIntegrity.test.js` (16) | pass |

## 4. Release recommendation

- **Deployable independently of the engine, shadow, benchmarks and answer evaluation:** yes, with the dependency above.
- **Behaviour change for all users on deploy.** Questions, requests and hypotheticals stop producing facts and goals. Some job changes and numbers are captured correctly.
- **Risk.** A *statement* misclassified as a question loses that fact's structured capture; its words stay in recall. In this verification set no statement was misclassified. Sprint 4's sentence-initial-noun guards ("Book club is…", "Plan B is…") are covered by tests.

**Before release:**
1. Build the two-step commit series from §2 and run the battery on it alone.
2. Optional, recommended: run capture-only in a staging environment and diff extraction logs (metadata only) for a sample of turns.
