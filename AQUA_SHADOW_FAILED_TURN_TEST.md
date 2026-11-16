# Shadow Mode — Failed-Turn Regression Test

**Sprint 6, 2026-11-11.**

**File:** `aqua/src/routes/tests/infoNeedsShadowFailedTurn.test.js`, added to the repository and promoted from the Sprint 5 scratch test. Shadow mode was **not** enabled anywhere outside the test process.

## What it proves

Order inside `prepareTurn`:
1. `memoryObserve` writes, held in the turn's transaction;
2. the information-needs analysis (**shadow:** read-only, logs `[NEEDS]`);
3. generation.

When generation fails, the Sprint 1 commit boundary (`routes/chat.js` `finally` → `rollbackTurnMemory`) must undo the turn's writes. The tests prove the shadow analysis running in between changes nothing about that.

| # | Test | Asserts |
|---|---|---|
| 1 | `/chat`: a new user's failed shadow turn | The status is ≥500, and **the analysis ran on this turn** (a `[NEEDS] mode=shadow` line is logged and `featureStatus` runs ≥ 1). After the turn: no facts, no Mind goals, no persisted user message. |
| 2 | `/chat`: an existing user | Three turns build memory. A failing turn then carries new facts ("moved to Cardiff", "joined Calder Legal") and a question. Afterwards, facts (key, value, ended), Mind goals, beliefs, working memory and persisted user messages are **byte-identical** to before, and the analysis ran. |
| 3–4 | The same two cases on `/chat/stream` | The stream reports `event: error`; same assertions |
| 5 | Control | The same message under shadow **without** a failure does store facts. Without this, tests 1–4 could pass vacuously. |

## Results

| Command (from `aqua/`) | Result |
|---|---|
| `node scripts/run-tests.mjs src/routes/tests/infoNeedsShadowFailedTurn.test.js` | **5/5 pass** |
| **Bite check:** both `rollbackTurnMemory(ctx.memoryTxn, { reason: 'not-persisted' })` calls in `chat.js` replaced with `void 0`, the suite run, then the file restored | **4 of 5 fail** (only the control passes). `chat.js` was restored byte-identically (sha256 verified). |
| `node scripts/run-tests.mjs src/routes` (all route tests, including this file) | see the Sprint 6 report |

## Scope and limits

- **Fake provider; isolated data dir; Mongo mirror disabled.** Behaviour with the production mirror active is not covered. That is a deployment-time check, as noted in the Sprint 5 shadow review.
- **Also covered for the hybrid** (`hybridContextRoute.test.js`): a failed provider turn under `AQUA_HYBRID_CONTEXT=on` leaves no facts.
