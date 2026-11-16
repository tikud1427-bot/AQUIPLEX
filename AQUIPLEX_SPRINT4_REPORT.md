# AQUIPLEX Sprint 4 — Understanding Reliability, Answer Quality & Shadow Validation

**Date:** 2026-11-10/11 · **Branch** `main` · **HEAD** `839ea0d1` (unchanged) · **State:** uncommitted, not pushed, not deployed.

**Confirmed not done:**
- no Render, environment, database or migration change;
- no paid model call;
- no frozen dataset or scorer edited, no baseline regenerated.

**Documents:**
- [Capture Integrity V1](AQUA_CAPTURE_INTEGRITY_V1.md)
- [Information Needs V2](AQUA_INFORMATION_NEEDS_V2.md)
- [ACIB v2 benchmark](AQUA_ACIB_V2_BENCHMARK.md)
- [Answer-quality evaluation](AQUA_ANSWER_QUALITY_EVALUATION.md)
- [Render shadow readiness](AQUA_RENDER_SHADOW_READINESS.md)

## 1. The headline finding

**The Sprint 3 engine did not generalise.** A new, independent, 100-scenario evaluation set was frozen before any Sprint 4 code was written. On it, the Sprint 3 engine reached recall 0.63 and 58/100 correct. The existing pipeline reached 95 correct on short histories and 74 on long ones. Sprint 3's perfect dev and held-out scores came from small sets written by the same engineer.

**V2 recovers most of that, but not all of it.** On a single untouched run of the frozen eval set:

| | Existing pipeline (A) | Sprint 3 engine | **V2** |
|---|---|---|---|
| Correct, short history | **95** | 58 | 88 |
| Correct, long history | 74 | 58 | **82** |
| Recall, short / long | 0.98 / 0.79 | 0.63 / 0.63 | 0.94 / 0.86 |
| Precision, short / long | 0.55 / 0.16 | 0.60 / 0.60 | **0.80 / 0.68** |
| Contradiction | 0.50 | 0.44 | **0.94** |
| Unknowns, short / long | 0 / 0 | 0.23 | **0.85 / 0.69** |
| Personal items on impersonal questions, short / long | 15 / 77 | 4 / 4 | **0 / 13** |

**V2 is better than the existing pipeline** on long histories, on precision, on contradictions and unknowns, and on not sending personal details to impersonal questions. **It is still worse on short histories** (−7 cases), and long-history recall (0.86) is below the 0.95 target. **Turning it `on` is not justified.** Running it in `shadow` is.

## 2. What was done, by section

| § | Done | Not done / limits |
|---|---|---|
| **A. Protection** | Verified root, branch `main` and HEAD `839ea0d1`. All prior work preserved; 104 paths changed or untracked, none discarded. Real store `~/.aquiplex/.aqua-mind.json` untouched (mtime 2026-11-10 11:18:28 before and after). All runs used isolated data dirs. Sprint 3 reports reviewed. | — |
| **B. Capture Integrity V1** | All three defects fixed at source: questions as facts, numbers truncated, questions as goals. A speech-act classifier now covers assertions, questions, requests, hypotheticals, intentions, goals, preferences, predictions, corrections, negations and "remember that". Provenance (`metadata.speechAct`) and hedging are preserved; uncertain statements never replace confirmed values. Also fixed: city run-on, verbs captured as relation names, "started a new job at / joined X as" not captured. 25 new tests. | **Not behind a flag:** it changes capture for all users on deploy. Stored bad facts are not cleaned (that would be a migration). Classification is lexical. |
| **C. Information Needs V2** | General mechanisms, with no held-out templates: anchoring, advice forms, a decision model (option / situation / resources / effects / criteria), life domains, figures as evidence, change following, remaining-"left", date and day conflicts, fact staleness by label, third-party facts as quotes, **one clarifying question only when insufficient**, a no-evidence fallback. The held-out 0.50 was investigated (§4 of the V2 doc): the engine had no concept of a decision's effect on others. 17 new tests. | Lexical misses (22 of 200 eval cases) fall back to the existing pipeline. Situations outside the domain vocabularies are missed. Precision on the Sprint 3 sets dropped slightly (§4). |
| **D. ACIB v2** | 100-scenario **eval** set across the 10 required categories, hash-frozen (`002208e4…`) before code changes. Separate 40-scenario **dev** set. Builder that validates every expectation against its source text. Creation process documented. Eval items were not read until after the single run. | Written by the same agent that built the engine. After this report the eval set has been read item by item, so the next claim needs a new frozen set. |
| **E. Answer evaluation** | Controlled A/B package: same model, settings, instructions and scenarios; prompts built by the real pipeline. Deterministic grader (7 tests). Blinded judge rubric and protocol. Gated runner: a paid run needs `--execute` plus `AQUA_ANSWER_EVAL_APPROVED=yes`. Full 200-answer **dry run** with a mock model: a paid run of this design is about 274k input tokens and ≤140k output tokens. | **Not run with a real model** (needs approval). **No answer-quality claim is made.** |
| **F. Shadow readiness** | 6 route-level tests, each mapped to a checklist item. A bite check was confirmed. Two route changes: the `[NEEDS]` line now hashes the owner (it printed the account id) and carries `reason=`. Exact Render procedure with gates, abort criteria and rollback. | Production configuration, Node version and history sizes on Render were not inspected. |
| **G. Deliverables** | All six documents, plus a memory note. | — |

## 3. Integrity of the evaluation

1. The eval set was frozen first. Baselines for both arms were recorded before any change.
2. Development used dev sets only. Of the eval set, only aggregates were seen until the implementation was frozen.
3. The changed files were hashed. The eval set was run **once** per arm.
4. One behaviour-neutral change was made after that run (a test seam). The re-run gives 0 of 133 metrics different and identical items for all 200 cases.
5. **Nothing was fixed against the eval set** after reading its failures. They are reported as classes in the V2 document, §5.
6. Dataset hashes are intact: v1 `d041746a…`, held-out v1 `8da1bffb…`, v2 eval `002208e4…`. The scorer is unchanged. Every ACIB run recorded 0 network attempts.

## 4. Tests and gate (actual results)

| Scope | Result |
|---|---|
| New: `speechAct` (9), `captureIntegrity` (16), `informationNeedsV2` (17), `infoNeedsShadowReadiness` (6), `answerGrader` (7) | 55/55 |
| Sprint 3 engine and route tests | 31/31. Six assertions updated where V2 changes behaviour on purpose; each keeps the old expectation in a comment. |
| memory + mind + understanding | 858 pass, 0 fail, 7 todo (the same todos as before) |
| **Full engine battery** (`src` + `eval`, 5,071 tests) | 5,035 pass, 26 skipped, 7 todo, **3 fail**. `repoHygiene` is pre-existing (`aqua/eval/out/*before-profile*`). `atomicStore` and `perfShape` failed while a 200-scenario dry run loaded the machine; **re-run alone: 7/7 pass**. |
| Platform tests (root) | **not re-run.** Sprint 4 did not touch `index.js` or platform code. |
| **`eval:gate` (DB-free)** | **BLOCKED**, honestly reported in the table below. 18 suites PASS; 2 NOT RUN (need Postgres); the 4 new ACIB v2 suites have no baseline (skipped, deliberately not created). |

**Gate blocks:**

| Suite | What moved | Reading |
|---|---|---|
| `acib-v1` (production default) | Long-history **efficiency** −0.007 (3 metrics). Every other moved metric improved: stale-as-current 2→1, irrelevant items 218→209, short precision 0.544→0.564. | Effect of the capture fixes. Net positive, but a strict gate blocks any wrong-way move. |
| `capture-core` | Every metric improved: capture rate 0.83→0.87, supersession 0.5→1, retrievability 0.89→0.95. Blocked by the "dataset shape" rule: one more case is now fully captured. | Known gate behaviour since 2026-11-02. |
| `acib-v1-needs` | Precision 0.854→0.844; 2 distractor items (was 0). | **A real V2 trade-off.** The situation need sometimes brings in an unrelated stated fact. |
| `acib-heldout-v1-needs` | Precision 0.85→0.81 (short) and 0.79 (long); 3 distractors (e.g. the pottery course on the job-offer decision). The memory sub-lane's temporal metric 1→0. | Same cause. Recall, unknowns (0.50→1.00, post-hoc) and correctness rose on this set. |

Baselines were **not** regenerated. Updating them is a deliberate act for the PR that introduces this work, and needs your decision.

## 5. Decisions needed

1. **Capture Integrity V1 ships with any deploy of this code** and changes memory capture for all users. Review it, and ideally commit it separately from the engine.
2. **Shadow rollout.** Authorise the code deploy (Gate 0), then `AQUA_INFO_NEEDS=shadow` (Gate 1), following the shadow-readiness document.
3. **Answer-level run.** Choose the answering model and a judge model of a different family, and approve the spend.
4. **Gate baselines.** Accept the moved `acib-v1` and `capture-core` baselines as improvements? And how should the V2 precision trade-off on the Sprint 3 sets be weighed against its generalisation gains?
5. **Next engine step.**
   - Meaning-level question↔statement matching for the lexical-miss class (C9 embeddings; needs approval for live embedding calls).
   - And/or a hybrid that keeps the existing lanes when V2's evidence is thin.
   - Either way, measure on a **new** frozen set.

## 6. Files

**New:**

| Area | Files |
|---|---|
| Source | `aqua/src/understanding/speechAct.js` |
| Tests | `aqua/src/understanding/tests/speechAct.test.js`, `aqua/src/memory/tests/captureIntegrity.test.js`, `aqua/src/brain/tests/informationNeedsV2.test.js`, `aqua/src/routes/tests/infoNeedsShadowReadiness.test.js`, `aqua/eval/tests/answerGrader.test.js` |
| Datasets | `aqua/eval/datasets/acib.v2.{eval,dev}.json` and their `.FROZEN.sha256`; `aqua/eval/datasets/src/acib.v2.{eval,dev}.source.mjs` and the eval source hash |
| Scripts | `aqua/scripts/build-acib-v2.mjs`, `aqua/scripts/answer-eval.mjs` |
| Suites | `aqua/eval/suites/acib-v2-{eval,dev}[-needs].suite.mjs` |
| Answer evaluation | `aqua/eval/answer/answerGrader.mjs`, `aqua/eval/answer/judgeRubric.md`, `aqua/eval/answer/results/dry-full-2026-11-11.*` |
| Records | `aqua/eval/acib/results/acib-v2-*`, `sprint4-implementation.hashes.txt` |
| Documents | the six documents above |

**Modified:**
- `aqua/src/memory/candidateExtractor.js`
- `aqua/src/memory/memorySchema.js`
- `aqua/src/memory/memoryExtractor.js`
- `aqua/src/mind/goalTracker.js`
- `aqua/src/brain/contextEngine/informationNeeds.js`
- `aqua/src/routes/chat.js` (the `[NEEDS]` log line only)
- `aqua/eval/adapters/acibPipeline.mjs` (opt-in `capturePrompt`)
- `aqua/src/brain/tests/informationNeeds.test.js`
- `aqua/src/routes/tests/informationNeedsRoute.test.js`

**Not modified:** ACIB v1 and held-out v1 datasets and their freezes; the scorer; all gate baselines; billing, auth and credits; production environment and data.
