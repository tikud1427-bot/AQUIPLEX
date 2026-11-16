# AQUIPLEX — Judge Readiness (live-smoke-1)

**Date:** 2026-11-12 · **Status: prepared, NOT executed.** No live request was made. The stored answers were not modified (sha256 unchanged).

## Command (PowerShell, new window with no provider keys in its environment — NOT authorised yet)

```powershell
cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua
$env:AQUA_ANSWER_EVAL_APPROVED="yes"
$env:AQUA_EVAL_LIVE_APPROVED="yes"
node scripts/answer-judge.mjs --execute --label live-smoke-1 --set acib.v2.dev --regime short --arms A,H --provider-config C:\Users\dell\aquiplex-eval\config.json
Remove-Item Env:AQUA_ANSWER_EVAL_APPROVED, Env:AQUA_EVAL_LIVE_APPROVED
```

**Expected:** `RESULT: COMPLETED · requests sent 2 · provider-reported tokens: …`, exit code 0, after at least 61 s (pacing).

**Afterwards, no requests:** `node scripts/answer-judge.mjs --label live-smoke-1 --set acib.v2.dev --regime short --arms A,H --merge` writes `live-smoke-1.merged.json`.

## Checks

| # | Item | Result |
|---|---|---|
| 1 | Saved answers | `eval/answer/results/live-smoke-1.pairs.jsonl` holds 2 answers for case `d-pc-job@short` (arms A, H), `groq/openai/gpt-oss-120b`, `GROQ_API_KEY_1`. `live-smoke-1.json`: `complete-judging-queued`, answered 2, judged 0. |
| 2 | Loadable by `answer-judge.mjs` | Yes. Offline simulation with the real config, a **copy** of the real store, the script's own case selection and a mock transport: the case is found, and both stored answers are matched (same model and settings) and skipped as done. |
| 3 | Exactly 2 judge requests, 0 answering | Simulation: 2 requests, both `groq/qwen/qwen3.8-27b` on `GROQ_API_KEY_1`, `max_tokens` 1024; 0 answering requests (the script runs the judge phase only). 0 external requests. |
| 4 | No repeat or overwrite | Judgements are **appended** to the store, and the existing answer lines stay byte-identical (checked). Re-running on the judged copy sent **0** requests (4 skipped). |
| 5 | Judge model | Provider **Groq**, model **`qwen/qwen3.8-27b`** (different family from the answering model), `temperature 0`, `max_tokens 1024`. Source: `C:\Users\dell\aquiplex-eval\config.json` → `models.judge`. |
| 6 | Expected tokens | Each judge prompt is 1,989 characters. At the ratio observed in the smoke test (≈4.5 chars/token), that is about 450 prompt tokens per request; output is ≤ 1,024 (JSON verdict ≈150–250 tokens, plus any Qwen reasoning). **Expected total ≈ 1,300–2,950 tokens for 2 requests.** The conservative pacing estimate is 1,711 per request (3,422 total), under the 4,000 per-request ceiling and Groq's 8,000 TPM. |
| 7 | Protections active (same config) | Request cap `groq: 2`. Pacing: 4,000-TPM share, ≥ 61 s between requests. Only `GROQ_API_KEY_1`; no key rotation; no Gemini (no Gemini key loaded). Any 429 → paused immediately. Billing signal → stopped. Auth failure → stopped for review. Unknown error, including **model not found / decommissioned** (checked offline) → stopped for review after 1 request; no other model is tried. Empty completion → stopped for review. Run lock; both approval switches required. |
| 8 | Production routing | `git diff HEAD -- aqua/src/providers aqua/src/core/strategy.js services/ai.client.js`: empty. Nothing was changed for this preparation. |
| 9–11 | Answers and work preserved | Answer files' sha256 unchanged. No live request. Uncommitted paths: 158, plus this report. |

## Risks for founder review

1. **Judge availability is unverified.** `qwen/qwen3.8-27b` was last seen in Groq's model list on 2026-11-01. Confirm in console.groq.com → Models / Playground that it is listed for the **Personal** organisation on the Free plan. If it isn't, the run stops after 1 request (`stopped-review`).
2. **Qwen reasoning output.** If Qwen spends the 1,024-token budget on reasoning, the empty completion stops the run for review after 1 request. If reasoning text containing braces precedes the JSON, that judgement is stored but marked unparseable at merge; it is not retried. Neither case costs more than the 2-request cap.
3. **Shared quota:** about 3k tokens of the organisation's daily allowance, which production also uses.
4. **What 2 judgements show.** Both arms gave the same answer, so 2 judgements test the judging path, not the A/H difference.

**Stopped — awaiting founder review and authorisation.**
