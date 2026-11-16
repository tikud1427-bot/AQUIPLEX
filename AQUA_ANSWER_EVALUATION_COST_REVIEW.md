# AQUA Answer Evaluation — Cost Review

**Sprint 5, 2026-11-11.** Nothing was executed. No model is selected; execution waits for explicit approval.

Sources: `aqua/scripts/answer-eval.mjs`, `aqua/eval/answer/answerGrader.mjs`, `aqua/eval/answer/judgeRubric.md`, `aqua/eval/answer/results/dry-full-2026-11-11.json`, `aqua/src/core/costAccounting.js`, `aqua/src/providers/*`.

## 1. What the package requires

| Item | Current state |
|---|---|
| **Answering model and exact version** | **Not chosen.** Supplied at run time via `ANSWER_EVAL_MODEL`. The runner records the model id the provider returns (`j.model`). Pinning a dated or versioned id is required by the protocol, not enforced by code. |
| **Judge model and exact version** | **Not chosen.** The rubric requires a different model family from the answering model. |
| **Answering provider support** | Any **OpenAI-compatible** `POST {base}/chat/completions` with Bearer auth (`ANSWER_EVAL_BASE_URL`). The app's existing providers are Groq, OpenRouter, NVIDIA (OpenAI-compatible, per `nvidia.js`) and Gemini (`src/providers/`), but the runner does **not** reuse them; it calls the endpoint directly. Providers with other APIs need an adapter (not verified, not built). The `seed` parameter is sent; whether a given provider accepts, ignores or rejects it is **unverified**. |
| **Judge execution** | **No judge executor exists.** The package writes blinded `*.judge-requests.jsonl` and the rubric, but nothing sends them to a model, parses the JSON or merges the results. It must be built before a judged run (small: the same transport as the runner, with JSON validation). |
| **Retries** | **None.** A non-2xx response throws and aborts the run. There is no resume, and partial results are not written. |

## 2. Token estimates (measured inputs; no prices)

The basis is the pipeline's own token estimator (`core/tokenManager.estimateTokens`, a heuristic, not a provider tokenizer). Provider-billed tokens may differ; apply a **±30% margin**.

### Answering

| Run | Requests | Input tokens | Output tokens (cap `max_tokens` 700) |
|---|---|---|---|
| Long regime, 100 scenarios × A/B (measured in the dry run) | 200 | **273,764** (A 141,701 · B 132,063; max per request 1,894) | ≤ 140,000 |
| Short regime, 100 × A/B (from the ACIB v2 eval records: A mean 1,392, B mean 1,307) | 200 | ≈ 269,900 | ≤ 140,000 |
| **Both regimes** | 400 | **≈ 543,700** | **≤ 280,000** |

### Judge (per answer)

| Component | Tokens |
|---|---|
| Rubric prompt | ≈ 396 (1,584 characters) |
| History and question | mean ≈ 26, max ≈ 56 (the judge sees the scenario's own history, not the filler) |
| The answer | ≤ 700 |
| **Judge input** | **≤ ~1,150** (typical ≈ 700–800) |
| Judge output | a JSON rubric, typically 100–250. **Proposed cap: 400** (not yet implemented) |

| Judge run | Requests | Input | Output (cap 400) |
|---|---|---|---|
| One regime | 200 | ≤ 230,000 | ≤ 80,000 |
| Both regimes | 400 | ≤ 460,000 | ≤ 160,000 |
| Calibration (20 items with human grades) | 20 | ≤ 23,000 | ≤ 8,000 |
| Second judge (optional, protocol step 4) | same again | ×2 | ×2 |

## 3. Cost formula (prices deliberately not assumed)

```
cost = Σ_models ( input_tokens / 1e6 × P_in(model) + output_tokens / 1e6 × P_out(model) )
```

- **No prices are documented in the repository.** `core/costAccounting.js` deliberately ships no default price table ("provider prices change and a stale table is a liability"). The runner takes `--price-in` / `--price-out` explicitly.
- **Correction to Sprint 4.** The figures `$0.59` / `$0.79` per million tokens used in the Sprint 4 dry run were **illustrative arguments typed by the engineer, not researched or documented prices.** The resulting "≤ $0.27" in `AQUA_ANSWER_QUALITY_EVALUATION.md` must not be read as an estimate for any real model.
- **Free tiers and subscriptions.** Several configured models are marked `costTier: 'free'` in `modelRegistry.js`. That is a rate-limited tier, not an evaluation budget. **No claim is made** that any subscription includes API credits.

**Worked template (fill in at approval):**

| Line | Tokens in / out | Price in / out ($/MTok) | Cost |
|---|---|---|---|
| Answering, both regimes | 543,700 / ≤ 280,000 (+30% margin: 706,800 / 364,000) | `P_in(ans)` / `P_out(ans)` | — |
| Judge, both regimes | ≤ 460,000 / ≤ 160,000 (+30%: 598,000 / 208,000) | `P_in(judge)` / `P_out(judge)` | — |
| Calibration | ≤ 23,000 / ≤ 8,000 | judge prices | — |

## 4. Maximum possible cost with retries

At present, a failure aborts the run, so the worst case is **every request of a full run, plus one complete re-run**: ≤ **2× the template total**.

**Proposed before execution** (not implemented):
- per-request retry cap **R = 2** with backoff, only on 429/5xx;
- resume from the last written row;
- a hard **spend ceiling** (`--max-usd`) that stops the run when cumulative priced usage reaches it.

With these, the bound is `(1 + R) × template` = **≤ 3×** in theory. In practice it is close to 1× plus failed requests, and never above the ceiling.

## 5. Blinding

**What the code already does:**
- The judge request file carries only `id`, `history`, `question` and `answer`.
- It holds no arm, context, system prompt or model name.
- The order is shuffled with a recorded seed.
- The `*.judge-key.json` mapping is a separate file, withheld from the judge.

**Residual risk.** The **answer text itself** may reveal the arm. Arm B's context instructs, for example, "If you ask, ask only this", so B's answers may carry a stylistic tell. Mitigations: an identical answer-format instruction in both arms (already the case; only context differs), and a check that judge accuracy at *guessing* the arm is near chance on a 20-item probe.

## 6. Reviewing disagreements and low-confidence scores

**Present in the protocol (`judgeRubric.md`):**
- judge calibration on 20 human-graded answers, with Cohen's κ per dimension reported **before** any arm comparison;
- two judges where budget allows;
- disagreements above 1 point go to a human;
- deterministic grades reported beside judge grades;
- the claim rule (CI excludes 0, and deterministic and judge grades agree in direction).

**Missing:**
- **The rubric has no confidence field.** Proposal: add `"confidence": 0–1` per item; send items below 0.6 to human review.
- **Malformed JSON** is not handled, because there is no executor yet. Proposal: one re-ask, then send to human review, never silently dropped.
- **Disagreement between the deterministic and judge grades** on the same dimension is not flagged. Proposal: list items where they disagree by 2 or more levels for human review.

## 7. Decisions pending approval

1. **Answering model:** exact id and version, provider endpoint, and prices.
2. **Judge model:** a different family, exact id and version, and prices; one or two judges.
3. **Spend ceiling.**
4. **Approval to build** the judge executor, retry/resume, the spend ceiling and the rubric confidence field. These are code changes; none makes a paid call.
5. **Whether to run on `acib.v2.eval`.** Contaminated for the engine's development, but still valid for **answer-level** A/B, because the answering model never saw it. Alternatively, wait for the ACIB v3 eval set.
