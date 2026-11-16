# AQUA Answer-Quality Evaluation — prepared, not run

**Sprint 4, 2026-11-11.**

**Status:** the package is built and validated with a mock model. **No paid model was called.** A real run needs explicit approval (Sprint 4 stop condition: "no paid model execution without explicit approval").

**Separation.** This is kept separate from the retrieval and context evaluation in [AQUA_ACIB_V2_BENCHMARK.md](AQUA_ACIB_V2_BENCHMARK.md). ACIB grades what the model *receives*; this grades what it *answers*.

## 1. Design

| Element | Choice |
|---|---|
| **Arms** | **A** = existing production context (default flags). **B** = information-needs context (`AQUA_INFO_NEEDS=on`). |
| **Prompt construction** | Both arms are built by the **real chat pipeline** (`prepareTurn`) through the ACIB adapter, with `capturePrompt`. The exact system prompt and messages the route would send are captured. |
| **Held constant** | Same model ID and version, same settings (`temperature 0`, `top_p 1`, `max_tokens 700`, fixed `seed`), same system instructions (the pipeline's), same scenarios, same regime. The only difference is the context the pipeline selected. |
| **Scenarios** | The frozen ACIB v2 evaluation set (100 scenarios), long regime by default; short is available. |
| **Grading 1 — deterministic** | `aqua/eval/answer/answerGrader.mjs`. It uses the frozen ACIB annotations: factual correctness, temporal accuracy (current value present, stale value not asserted), contradiction handling, uncertainty handling (declines to assert unknowns, or asks), clarification quality (≤1 question when information is missing, 0 otherwise), ungrounded figures (a hallucination proxy), personal leaks on impersonal questions, distractor mentions and personalisation. Tests: `eval/tests/answerGrader.test.js`, 7/7. |
| **Grading 2 — independent judge** | `aqua/eval/answer/judgeRubric.md`. A different model family from the answering model. Blinded: no arm, context or system prompt. Order shuffled with a recorded seed. A JSON rubric on 0–2 scales, plus a hallucination flag with the hallucinated claims. |
| **Operational** | Latency (model call), context-build ms, prompt and completion tokens, cost (input/output price per 1M tokens, passed explicitly). |
| **Outputs** | `eval/answer/results/<label>.json` (config, dataset hash, engine hash, per-answer grades, per-arm aggregates, cost estimate). `<label>.judge-requests.jsonl` is blinded: id, history, question, answer only. `<label>.judge-key.json` maps ids back to scenario and arm, and is withheld from the judge. |

## 2. Gates in the runner (`aqua/scripts/answer-eval.mjs`)

- **Dry run by default.** A mock model returns a fixed, content-free string. There is no network and no cost. Grades from a dry run are labelled "plumbing checks, NOT results".
- **A paid run** requires **all** of:
  - `--execute`;
  - `AQUA_ANSWER_EVAL_APPROVED=yes`;
  - `ANSWER_EVAL_BASE_URL` (an OpenAI-compatible endpoint);
  - `ANSWER_EVAL_MODEL`;
  - `ANSWER_EVAL_API_KEY`.

  Values are never printed, and the run is refused otherwise (verified).
- **The dataset must match its freeze hash**, or the run is refused.
- **Context is built behind the ACIB network guard.** Only the model call, after the context is built, reaches the network.

## 3. Dry-run validation (done)

```
node scripts/answer-eval.mjs --set acib.v2.eval --regime long --limit 100 --label dry-full-2026-11-11 --price-in 0.59 --price-out 0.79
```

- 200 answers (100 scenarios × 2 arms), built by the real pipeline, with **0 network attempts** while building context.
- **A and B prompts differ in 94 of 100 scenarios.** In the other 6, B fell back to the existing pipeline (`no-evidence`), so the prompts are identical by design.
- **Size of a real run of this design:** 200 requests, about 274k input tokens and at most 140k output tokens. At the illustrative prices above, that is **at most about $0.27**. The real price depends on the model chosen. Mean prompt tokens: A 1,417, B 1,321.
- Judge requests are checked to hold no arm information.

## 4. Proposed protocol for the approved run

1. **Choose and record** the answering model (exact ID and version) and the judge model (a different family). Pass prices explicitly. Approve the spend.
2. **Run both regimes:**
   ```
   AQUA_ANSWER_EVAL_APPROVED=yes ANSWER_EVAL_BASE_URL=… ANSWER_EVAL_MODEL=… ANSWER_EVAL_API_KEY=… node scripts/answer-eval.mjs --execute --label run1-long
   … --regime short --label run1-short
   ```
3. **Calibrate the judge** on 20 answers a human has graded, and report κ per dimension. Then judge all answers from `*.judge-requests.jsonl` and un-blind with `*.judge-key.json`.
4. **Report** per arm and per category:
   - the deterministic grades;
   - the judge grades;
   - the hallucination rate;
   - clarifying-question rate (overall, and on sufficient vs insufficient cases);
   - latency, tokens and cost.

   Use **paired** comparisons per scenario, with bootstrap 95% CIs.
5. **Claim rule.** No claim that B answers better unless the difference holds on this frozen set with a CI excluding 0 **and** the deterministic and judge grades agree in direction. Report regressions as prominently as gains.
6. **Ideally**, also run a set written by someone other than the engine's author (see ACIB v2 §2, limits of independence).

## 5. What to expect, and not to assume

The context-level results predict that B should:
- be better at contradictions, unknowns and irrelevant personal details;
- be better on long histories;
- be **worse on short-history lookups**, where the engine's lexical matching misses what the broad context contains.

Whether the model *uses* these differences is exactly what this evaluation measures. **No answer-level claim is made in Sprint 4.**
