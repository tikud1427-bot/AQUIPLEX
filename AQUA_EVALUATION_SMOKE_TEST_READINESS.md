# AQUA Evaluation — One-Case Smoke Test Readiness

**Date:** 2026-11-11 · **Status: READY TO RUN, NOT RUN.** It needs founder approval, the console verification and evaluation-only keys. No live API call has been made.

## 1. The smoke test

| Item | Value |
|---|---|
| Dataset | `acib.v2.dev` (synthetic development set; frozen hash `abca8916…`), **not** the evaluation set |
| Case | The first scenario (`d-pc-job`, personal context), **short** history |
| Arms | A (production defaults) and H (`AQUA_HYBRID_CONTEXT=on`) |
| Answering model | Groq `openai/gpt-oss-120b`, one model and identical settings for both arms |
| Judge model | Gemini `gemini-2.5-flash` (a different provider and model family) |
| Requests | **4** in total: 2 answers + 2 judgements |
| Approximate tokens | Answers: about 1.3–1.5k input each, ≤1,500 output. Judgements: about 0.8k input each, ≤1,024 output. |

**Command (to be run by the founder, after approval):**

```
cd aqua
set AQUA_ANSWER_EVAL_APPROVED=yes
set AQUA_EVAL_LIVE_APPROVED=yes
node scripts/answer-eval.mjs --execute --set acib.v2.dev --limit 1 --regime short --arms A,H --label live-smoke-1 ^
  --provider-config C:\Users\dell\aquiplex-eval\config.json --credentials-env C:\Users\dell\aquiplex-eval\eval.env
```

**Expected:** `complete · answered 2 · judged 2` and exit 0. Output: `eval/answer/results/live-smoke-1.json` (content-free status, usage and quota) and `live-smoke-1.pairs.jsonl` (answers and judgements).

**If interrupted or paused:** re-run the same command. Completed work is skipped.

## 2. Readiness checks (all without network)

| Check | Evidence | Result |
|---|---|---|
| **Same answering model for A and B (H)** | Smoke rehearsal (live code path, stubbed network): both Groq request bodies have the same `model`, `temperature` and `max_tokens`. CLI dry run of the exact command: both answers are recorded with one model. | ✅ |
| **Different judge model** | Rehearsal: the judge requests go to `generativelanguage.googleapis.com/…/gemini-2.5-flash`, not the answering model. The gate refuses judge = answering model. | ✅ |
| **Request formats** | Live-transport tests with a stubbed `fetch`. **Groq:** `POST https://api.groq.com/openai/v1/chat/completions`, `Authorization: Bearer`, body limited to `model`, `messages`, `temperature`, `max_tokens` (unknown keys dropped), system message included. **Gemini:** `POST …/v1beta/models/<model>:generateContent`, `x-goog-api-key` header (no `Authorization`), `systemInstruction`, roles `user`/`model`, `generationConfig` {`temperature`, `maxOutputTokens`, optional `thinkingConfig.thinkingBudget`}. | ✅ against the documented formats. **Not yet confirmed by a live call.** |
| **Response parsing** | Groq: `choices[0].message.content`, `usage`, `finish_reason`. Gemini: `candidates[0].content.parts[].text` joined, `usageMetadata`, `finishReason`. Errors: status, `retry-after` header, body (≤2,000 chars) reach the classifier. | ✅ (stubbed) |
| **Persistence and resume** | Rehearsal: 4 records (answer A, answer H, judgement A, judgement H). A re-run sends **0** requests (4 skipped). CLI dry run of the exact command: the same. | ✅ |
| **Quota handling** | A 429 RPD (with Groq's "upgrade" text) → `paused` after 1 request; no other provider. Temporary 429 with Retry-After → waited. Empty completion → stop for review, not stored. | ✅ |
| **No paid fallback** | 402 → `stopped-billing` after 1 request; a quota limit of 0 → billing stop; no fallback model, provider or key exists in the path | ✅ |
| **No production data access** | `productionDataGuard` refuses `DATABASE_URL`, Mongo URIs, a mirror not disabled, or `AQUA_DATA_DIR` at the real `~/.aquiplex`. The scripts run in a temporary isolated data dir. The real store's mtime is unchanged (2026-11-10 11:18:28). | ✅ |
| **No production credentials** | The gate refuses production sources, `AQ.` values, and credentials or config inside the repository | ✅ |

## 3. Risks the live smoke test is meant to reveal

| Risk | Mitigation already in place | What to look at |
|---|---|---|
| **Reasoning models spend output on hidden reasoning** (gpt-oss on Groq; Gemini 2.5 Flash thinks by default) and return empty or truncated text | Empty completion → `stopped-review`, nothing stored. The example config uses `max_tokens: 1500` for answers, and `thinking_budget: 0` with `max_tokens: 1024` for the judge. | `finishReason` in the review detail; if `length` / `MAX_TOKENS`, raise the budget or adjust the reasoning settings. **Change it for both arms equally** (it is one setting). |
| Whether `thinking_budget: 0` is accepted for `gemini-2.5-flash` on the key's tier | A 400 is classified `unknown` → stop for review (no retry) | The run record's quota and usage; error category |
| Real error bodies differ from the documented ones | Unclassified errors stop for review; 429s without a recognised daily marker pause the domain conservatively | Error category in events |
| Free-tier daily quota resets at unknown times | Paused domains resume after Retry-After, the configured daily reset hour, or 24 h | The `resumeAt` printed |

## 4. Abort criteria for the live smoke test

Stop and report, before any larger run, if any of these occur:
- any `stopped-billing`;
- any request to a host other than `api.groq.com` / `generativelanguage.googleapis.com`;
- an empty completion;
- an unclassified error;
- any credential value appearing in an output file (the run record is content-free by design; spot-check it).
