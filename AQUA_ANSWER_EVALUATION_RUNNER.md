# Answer-Evaluation Runner (Sprint 6)

**Date:** 2026-11-11.

**Status:** built and tested. **No real API call, no credentials, no paid execution.** Model selection and execution remain pending founder approval.

## 1. Components

| File | Role |
|---|---|
| `aqua/eval/answer/spendLedger.mjs` | **Hard spend cap**, default **$25**. **Before every request** (retries included), it authorises the worst case: estimated input × input price + full output budget × output price. A request that could cross the cap is never sent (`SpendCapReached`). **No prices → no request** (`PricesMissing`): prices are never assumed. An attempt without reported usage is charged its worst case. |
| `aqua/eval/answer/providerClient.mjs` | One request path for the answering model and the judge. Bounded retries (default 2) with exponential backoff and jitter, **only** on 429, 5xx and network errors. Other errors stop the run (`NonRetryableProviderError`). Injectable transport: `httpTransport` (OpenAI-compatible `POST {base}/chat/completions`, only built for `--execute`) and `mockTransport` (never leaves the process). |
| `aqua/eval/answer/judgeRunner.mjs` | The **missing judge runner** (Sprint 5 cost review). `judgePrompt` (rubric plus `confidence`), `parseJudgement` (schema/range validation), `runJudge`, `mergeJudgements`, `aggregateJudge`. See the rows below. |
| `aqua/scripts/answer-eval.mjs` | Rewritten to use the client and ledger. `--arms` (A, B, **H** = hybrid); `--max-usd`; `--retries`; `--price-in`/`--price-out` are **required** with `--execute`. Rows are appended to `<label>.rows.jsonl` (re-running the same label **resumes**). A clean stop at the cap (`status: stopped-cap`, exit 3) keeps every completed row. |
| `aqua/scripts/answer-judge.mjs` | Judges `<label>.judge-requests.jsonl` (blinded) into `<label>.judgements.jsonl` (resumable per `--judge-id`). `--merge` un-blinds with `<label>.judge-key.json` (never given to the judge) and writes `<label>.judge-merged.json`: per-arm aggregates plus the review queue. Gated like `answer-eval` (`JUDGE_BASE_URL`, `JUDGE_MODEL`, `JUDGE_API_KEY`, approval and prices). |
| `aqua/eval/tests/fixtures/fetchGuard.mjs` | Test preload: counts and refuses any non-loopback `fetch` |

**`judgeRunner.mjs` in detail:**

| Function | What it does |
|---|---|
| `judgePrompt` | Builds the rubric prompt with the `confidence` field |
| `parseJudgement` | Validates the JSON against the schema and ranges |
| `runJudge` | Re-asks a malformed reply **once**, then queues it for review (never dropped). Appends every result to disk (**resume**). Stops cleanly at the cap. |
| `mergeJudgements` | Un-blinds, and queues for **review**: malformed output, confidence < 0.6, two judges more than 1 point apart, judge vs deterministic 2+ levels apart |
| `aggregateJudge` | Per-arm means and hallucination rate |

## 2. Tests (no external calls)

| Command (from `aqua/`) | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/answerRunner.test.js eval/tests/answerGrader.test.js` | **25/25 pass** |

What `answerRunner.test.js` proves:
- **Ledger:**
  - the default cap is $25;
  - a worst case over the cap is refused before sending;
  - no price → refused;
  - an attempt without usage is charged its worst case.
- **Client:**
  - 503 then 200 → 2 attempts, both charged;
  - a 429 loop is bounded (3 attempts);
  - a network error is retried;
  - a 400 stops at once;
  - **the cap stops a retry loop before the next attempt is sent** (1 transport call);
  - `httpTransport` refuses without an endpoint and key.
- **Judge:**
  - the prompt carries no arm or context and asks for confidence;
  - validation;
  - malformed → one re-ask → review queue;
  - resume skips judged ids;
  - **the cap stops mid-run, keeping what was judged**; a cap below one request sends nothing;
  - merge queues low confidence, judge disagreement and judge-vs-deterministic gaps.
- **CLIs as child processes, with the fetch guard preloaded:**
  - `answer-eval` (arms A,H, 2 scenarios) → `answer-judge` → `answer-judge --merge` completes with **0 external requests**;
  - the blinded request file has no arm field;
  - `--execute` without approval, credentials or prices exits 2 **before any request**, with 0 external requests.

## 3. The production answering model (from the codebase)

There is **no single answering model**. Each turn is routed by provider ranking (`src/core/strategy.js`, `src/providers/router.js`, `src/providers/modelRegistry.js`):

| Turn type (`taskType`) | Provider order | Model (registry order; first healthy wins) |
|---|---|---|
| conversation, personal_info, memory_recall, simple_qa and other non-listed types (the `DEFAULT` order) | **Groq** → Gemini → OpenRouter → NVIDIA | **Groq `openai/gpt-oss-120b`** (primary), then `openai/gpt-oss-20b`; Gemini `gemini-2.5-flash`, then `gemini-3.6-flash`; OpenRouter `:free` models (rotating); NVIDIA `NVIDIA_DEFAULT_MODEL` or `openai/gpt-oss-20b` |
| reasoning, coding, research, architecture, creative writing, file analysis, agent tasks | **Gemini** first | `gemini-2.5-flash` primary |
| any task with `complexity: 'high'` | Gemini moved first | `gemini-2.5-flash` |

- **Settings sent by the chat route:**
  - no `temperature` (each provider's default);
  - output length from the orchestration budget (`orchestration.budget`, per complexity).
- **Production overrides that could change this:**
  - `AQUA_PROVIDER_PREFER` (reorders providers);
  - `NVIDIA_DEFAULT_MODEL`;
  - which provider keys are configured;
  - provider health at the time of the turn.

  **The production values were not inspected.**
- **All registered models are marked `costTier: 'free'`.** That is the tier the app uses, not an evaluation budget.

**Recommendation for the answering model in the A/B.** Pin **one** model, so arms differ only by context: **Groq `openai/gpt-oss-120b`**, the primary for the conversational and personal turns this context work targets. Use `temperature: 0` and `max_tokens: 700`, as the runner sends (not the production defaults; the comparison needs determinism). Record the exact model id the provider returns (the runner stores `model` per row).

## 4. Judge model: recommendation (not a selection)

- **Rule:** a different model family from the answering model, and not a model the app falls back to. With `gpt-oss-120b` answering and Gemini as the app's second provider, the judge should be **neither an OpenAI open-weight (`gpt-oss`) model nor a Gemini model**.
- **Suggestion:** a strong general model from another family (for example an Anthropic Claude model), via an OpenAI-compatible endpoint. **Whether a given provider's OpenAI-compatible endpoint accepts this request format, including `temperature` and the JSON-only instruction, was not verified.** An adapter may be needed.
- **Second judge (optional):** a different family again. It enables the >1-point disagreement queue.
- **Prices:** none are stated here. The founder supplies `--price-in` / `--price-out` per model from the provider's current price page at approval time.

## 5. How a paid pilot would run (after approval; not done)

```
# 1. answers (both arms), capped
AQUA_ANSWER_EVAL_APPROVED=yes ANSWER_EVAL_BASE_URL=<groq-compatible-url> ANSWER_EVAL_MODEL=openai/gpt-oss-120b ANSWER_EVAL_API_KEY=<key> \
  node scripts/answer-eval.mjs --execute --arms A,H --limit 100 --label pilot1 --price-in <p_in> --price-out <p_out> --max-usd 25
# 2. judge, capped separately
AQUA_ANSWER_EVAL_APPROVED=yes JUDGE_BASE_URL=<url> JUDGE_MODEL=<judge id> JUDGE_API_KEY=<key> \
  node scripts/answer-judge.mjs --execute --label pilot1 --price-in <p_in> --price-out <p_out> --max-usd 25
# 3. un-blind and build review queues (no network)
node scripts/answer-judge.mjs --label pilot1 --merge
```

- If either step stops at the cap, re-running the same command **resumes**. Raise `--max-usd` only with a new approval.
- **Token budgets for sizing** (Sprint 5 cost review): answering about 274k input / ≤140k output per regime; judging ≤230k input / ≤80k output per regime. Judge output is now capped at **400 tokens** (`JUDGE_SETTINGS`).

## 6. Not built

- **A dedicated provider adapter** for non-OpenAI-compatible APIs.
- **A calibration helper** that computes Cohen's κ between the judge and human grades. The human-graded items must first exist. The merged output contains everything κ needs.
