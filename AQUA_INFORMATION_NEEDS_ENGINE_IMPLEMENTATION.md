# Aqua Information Needs Engine — Implementation

**Date:** 2026-11-10 · **Final engine:** `aqua/src/brain/contextEngine/informationNeeds.js`, sha256 `1f4e64c9f823d10e…` · **State:** uncommitted on `main` (HEAD `839ea0d1`) · Design: [AQUA_INFORMATION_NEEDS_ENGINE_DESIGN.md](AQUA_INFORMATION_NEEDS_ENGINE_DESIGN.md)

## 1. Execution path (actual)

`POST /api/aqua/chat` and `POST /api/aqua/chat/stream` → `prepareTurn` (`aqua/src/routes/chat.js`):

1. Owner, sensitivity policy, classification, `memoryObserve` inside the Sprint 1 turn transaction.
2. Orchestration, plan, CIE.
3. `memoryRetrieve` — legacy lanes, computed as before (its retrieval bookkeeping is unchanged).
4. Project context and attachments.
5. **Step 5c¹ (new).** Compute the history window, then `infoNeedsMode()`. If not `off`, call `analyseInformationNeeds({ ownerId, userId, conversationId, question, taskType, excludeFromIndex, sensitive })`. It is wrapped in `try`, records `noteFeature('AQUA_INFO_NEEDS', 'ran'|'failed')`, and logs a counts-only `[NEEDS]` line.
6. If `on` and `applied`:
   - `memoryBlock` ← the engine's needs block, after `scrubSensitiveLines`;
   - the PIC lane is skipped;
   - `recall` ← the engine's need-selected quotes, which still pass the recall scrub below.
7. Recall (the existing path when the engine does not own the context), evidence context, `buildSystemPrompt`, context window — unchanged.
8. `prep.infoNeeds = { mode, applied, summary }` (counts only).

Generation, verification, persistence (`persistUserTurn` commit boundary), post-turn work and rollback are untouched.

## 2. Code

| File | Change |
|---|---|
| `aqua/src/brain/contextEngine/informationNeeds.js` | **New.** Stages A–E, rendering, `infoNeedsMode()` |
| `aqua/src/routes/chat.js` | Step 5c¹; `memoryBlock` reassignable; history window moved up (same values); PIC lane gated by `!needsOwnsContext`; recall branch; `prep.infoNeeds`; import |
| `aqua/src/core/flags.js` | Gate `AQUA_INFO_NEEDS` (`off\|shadow\|on`, default off), new read kind `TRI` |

**Reused, unmodified:**
- `queryPlan.isDecisionForm`;
- `pic/questionShape.analyseQuestion`;
- `understanding/stateTransition` — `tokens`, `changeKind`, `corrects`;
- `memory/episodicRecall` — `collectUnits`, `forgetClean`, `withholdClean`, `recallRedaction`, `formatRecall`;
- `memory/recallRedactions.redactionsFor`;
- `memory/retrievalPrivacy` — `withheldBy`, `policyKey`;
- `memory/longTermMemory.getFacts`;
- `memory/memoryExtractor.detectForget`.

## 3. Evaluation infrastructure (Sprint 3)

| File | Change |
|---|---|
| `aqua/eval/suites/acibSuite.mjs` | **New** suite factory: one run/score definition shared by every arm (dataset, freeze and configuration checks; an arm's `env` applied per scenario and restored) |
| `aqua/eval/suites/acib-v1.suite.mjs` | Rewritten on the factory — same id, cases and scoring; **0 metric changes** against the frozen Sprint 2 baseline (verified) |
| `aqua/eval/suites/acib-v1-needs.suite.mjs` | **New** — arm B on the dev set (`AQUA_INFO_NEEDS=on`) |
| `aqua/eval/suites/acib-heldout-v1.suite.mjs`, `acib-heldout-v1-needs.suite.mjs` | **New** — arms A and B on the held-out set |
| `aqua/eval/datasets/acib.heldout.v1.json` + `.FROZEN.sha256` | **New** held-out set (10 scenarios), authored and frozen **before** the engine existed |
| `aqua/eval/adapters/acibPipeline.mjs` | Scoped `env` per run; question `prepareTurn` latency; engine summary in records |
| `aqua/scripts/acib-run.mjs` | `--suite`; records include latency and engine summary |
| `aqua/eval/baselines/acib-v1-needs.v1.json`, `acib-heldout-v1.v1.json`, `acib-heldout-v1-needs.v1.json` | **New** gate baselines |
| `aqua/eval/acib/*.baseline.json` (+ `.sha256`) | Frozen records: `acib-v1-needs`, `acib-heldout-v1`, `acib-heldout-v1-needs` |
| `aqua/eval/acib/results/` | Development runs (dev1–dev5), determinism pair, **held-out first run**, held-out post-hoc second run, arm A re-run |

**Not modified:** `acib.v1.json` and its freeze (`d041746a…`), `acibScoring.mjs` (the scorer), `acib-v1.v1.json`, and `acib-v1.baseline.json` (the Sprint 2 record).

## 4. Performance (measured, ACIB synthetic users)

| | Arm A | Arm B |
|---|---|---|
| Engine time per question | — | **0.6–1.6 ms** (mean by set and regime) |
| Question `prepareTurn` | 3.9 / 4.5 ms (dev short / long) | 3.1 / 4.8 ms |
| Prompt tokens, dev long | 1,639 | **1,304 (−20%)** |
| Prompt tokens, dev short | 1,504 | 1,304 (−13%) |
| Hiring question tokens | 1,672 (long) | 1,542 |
| Additional LLM calls | — | **0** |
| Additional retrieval operations | — | per turn: one fact-store read, one history-unit collection (recall's per-conversation token cache), one scoring pass per requirement (≤ 8 requirements × candidates) |
| Unit-test latency check | — | 400-message history, 8 requirements: ~24 ms |

The legacy `memoryRetrieve` still runs before the engine (for its retrieval bookkeeping), so the engine adds its own cost rather than replacing that one. Skipping it when the engine owns the context is a later optimisation. The PIC lane and recall *are* skipped.

**Cache opportunities:**
- history units are already cached per conversation by recall;
- vocabulary stems are computed once at import;
- facts are read once per turn.

**Failure behaviour:** any exception → the existing pipeline serves the turn, `[NEEDS] failed` (error name only) is logged, and `features` reports `failing`.

## 5. Tests

| File | Tests | What |
|---|---|---|
| `aqua/src/brain/tests/informationNeeds.test.js` | 24 | Stage A intents; impersonal/simple questions not over-read; Stage B conditional requirements; evidence for every hiring need; irrelevant, speculative and question text excluded; missing info declared without invented figures; contradiction flagged; temporal (correction annotation; stale stored fact shown as no longer current); forget without a stored fact; question-derived facts (two independent rules); truncated stored numbers; ambiguous names; sensitivity; **cross-user isolation**; impersonal = empty; no owner = not applied; long-history budget and latency; gate parsing |
| `aqua/src/routes/tests/informationNeedsRoute.test.js` | 7 | The **actual system prompt sent to the provider** through the real route: `off` = existing pipeline; `shadow` = logged counts only, prompt unchanged; `on` = needs block, broad lanes replaced, user words still fenced, execution reported active; stream path; impersonal; **failed turn still rolls back**; **isolation** |
| `aqua/src/core/tests/flagReadSiteParity.test.js`, `flagRegistry.test.js` | +1 probe; census 43→44 gates, 91→92 names | registry ↔ read site |
| ACIB gate | `acib-v1` (arm A) unchanged; `acib-v1-needs`, `acib-heldout-v1`, `acib-heldout-v1-needs` baselined | regression |

**Bite checks** (break, confirm failure, restore by hash):
- Forcing `needsOwnsContext = false` fails 3 route tests.
- Removing the question-source fact rule first did **not** fail any test — the collection-item rule masked it. A dedicated test was added, and it now fails as it should.

## 6. Development history (for honest reading of the numbers)

1. **Dev runs 1–5** on `acib.v1` led to fixes, each driven by inspecting items rather than metrics:
   - the engine's prose named the recall header, breaking extraction;
   - an over-loose "since changed" rule;
   - flat planning vocabulary;
   - facts without provenance;
   - question-derived facts;
   - stem collisions (`training` → *train*, `employees` → *employer*);
   - duplicate quotes;
   - affordability labels;
   - stale stored facts.
2. **Held-out first run** (engine `fc8fd62d…`, never run on that set before): 9/10 correct, unknown 0.50, contradiction 0.50. **This is the generalisation measurement.**
3. **Three generic bugs** found by that run were fixed:
   - "want to" read as a hedge;
   - a truncated stored number shown as a fact;
   - the contradiction subject test.

   The held-out second run (final): 10/10, contradiction 1.00. Unknown handling stays 0.50: a pricing decision needs a "churn" unknown that no template knows, and this was **deliberately not patched** to avoid tuning on held-out data.
