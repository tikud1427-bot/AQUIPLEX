# AQUIPLEX — Zero-Budget Evaluation Integration Report

**Date:** 2026-11-11

**Repository:** `main` @ `839ea0d1` (verified). Working tree: 144 uncommitted paths (the existing 140 preserved, plus the new integration test and the 3 documents).

**Not done:** no commit, push or deployment; no live or paid call; no production credential used for evaluation; no production provider file or configuration changed; no frozen dataset or baseline touched; the real memory store not accessed (mtime unchanged). No credential value was printed or written.

## Results

| Task | Status |
|---|---|
| 1. Manager wired into the answering and judge scripts | **Done.** `answer-eval.mjs` and `answer-judge.mjs` rewritten on `eval/answer/evalRun.mjs` |
| 2. All requests through the manager | **Done.** It is the only request path; a bypass mutation fails 6 tests. |
| 3. Free-tier verification mandatory | **Done.** The preflight runs before a live transport can exist, and again when the manager is created. |
| 4. Identical A/B model configuration | **Done.** Model and settings locked per pair; a mixed model is refused. |
| 5. Exhaustion pauses, no paid services | **Done.** Domain pause, `BillingStop`, no fallback; the old priced flags are refused. |
| 6. Resumable answers and judgements | **Done.** Pair store; no-duplicates key without the date-dependent prompt hash; lazy prompts |
| 7. Judge exhaustion queues completed pairs | **Done.** A judge-only run drains the queue without re-answering. |
| 8. Integration tests with mocked providers | **29/29.** All evaluation suites together: **87/87** |
| 9. All refusal conditions tested | **Done.** 10 CLI refusals (exit 2, 0 external requests) plus 9 gate tests and the preflight refusal |
| 10. No production provider or configuration change | **Verified:** `git diff HEAD -- aqua/src/providers services/ai.client.js render.yaml package.json aqua/package.json` is empty. Files changed in this task: `.env` (comments only) and 7 files under `aqua/eval/` and `aqua/scripts/`. |
| Credential hygiene | **Done.** `.env` lines 49–51 (misleading comments, an old token fragment on line 50) replaced with an accurate note. **All 77 entries are verified identical; 0 `AQ.` fragments remain in comments.** The `AQ.` values are refused for evaluation (gate plus inventory exclusion). |

## Additional hardening found during integration

1. **Resume across days would have regenerated answers.** The Sprint 6 no-duplicates key included the prompt hash, and ACIB prompts contain the run date. Fixed: the key is case | arm | model | settings, with the prompt hash kept as metadata.
2. **Preflight order.** The live transport was constructed before the free-tier preflight in the first draft. Fixed: preflight first, so unverified configurations never reach a live transport.

## Still unverified (requires approval)

- The live request formats (Groq OpenAI-compatible; Gemini `generateContent`) and real error bodies.
- Free-tier status of any evaluation key: none exist yet.

## Awaiting approval (stopped here)

1. **Credential verification.** Create **evaluation-only** keys in a file outside the repository. Verify in the consoles each key's project or organisation and that no billing is attached (who and when), then fill the evaluation config.
2. **First live synthetic test:** a one-case smoke run (`--limit 1`), with `AQUA_ANSWER_EVAL_APPROVED=yes` and `AQUA_EVAL_LIVE_APPROVED=yes`, per `AQUA_EVALUATION_RUNNER_INTEGRATION.md` §5.

**Documents:**
- [AQUA_EVALUATION_RUNNER_INTEGRATION.md](AQUA_EVALUATION_RUNNER_INTEGRATION.md)
- [AQUA_EVALUATION_PROVIDER_INTEGRATION_TESTS.md](AQUA_EVALUATION_PROVIDER_INTEGRATION_TESTS.md)
