# AQUA Evaluation Provider Integration — Tests

**Date:** 2026-11-11

**File:** `aqua/eval/tests/evalProviderIntegration.test.js`, **29 tests, 29 pass.**
- **All providers mocked.** A global `fetch` tripwire asserts **0** network requests in-process.
- **CLI tests** run the real scripts as child processes with a preloaded fetch guard that counts any non-loopback request: **0** in every case.
- **Synthetic credentials only**, each containing a `SECRET` marker. No stdout or stderr contains it.

```
cd aqua
node scripts/run-tests.mjs eval/tests/evalProviderIntegration.test.js            → 29/29
node scripts/run-tests.mjs eval/tests/answerRunner.test.js eval/tests/evalProviderIntegration.test.js \
     eval/tests/evalProviderManager.test.js eval/tests/answerGrader.test.js     → 87/87
```

## Coverage (brief tasks → tests)

| Task | Test | Asserts |
|---|---|---|
| 2. All requests through the manager | answers and judgements via the injected transport | 12 transport calls = 12 manager-accounted requests; every call from a configured credential name; the run record has no credential value |
| 4. Identical A/B model configuration | both arms identical; real pipeline prompts | All answer calls use the same model and settings in pair order. With the **real ACIB pipeline** (lazy prompts), A and H share model and settings, the real system prompt is sent, and arms differ only in context. |
| 4. (no mixing) | a changed answering model cannot finish a pair | `model-mismatch` |
| 5. Exhaustion pauses, no paid route | answer quota exhausted; billing | `paused` at `s2`; only the configured model was used; the shared org was hit **once** (not rotated through its other key). A 402 → `stopped-billing` after 1 call. |
| 6. Resumable | resume after reset | A new process (new manager) completes **only the 4 missing answers**; exactly one answer per case × arm in the store |
| 7. Judge exhaustion queues pairs | judge quota exhausted | Answering completes (6). `judgeQueued = [s1, s2, s3]`. A later **judge-only** run judges 6 and sends **0** answer requests. Judge and answer identities are recorded. |
| (merge, blinding) | merge un-blinds from the store | Per-arm answer, judgement and grade counts; the judge request content carries no arm |
| 3 / 9. Free-tier mandatory | unknown billing → refused before any request | `PreflightRefused`, **0** transport calls |
| 9. Refusals (gate, in-process) | 9 tests | No approval; no config / credentials file; credentials from the repository `.env` or any file inside the repository; production `credentialSource`; `allowProductionCredentials`; `AQ.` / non-standard opt-in; dataset not allow-listed; judge = answering model. `AQ.` values in an evaluation file are excluded. The dry run uses only synthetic credentials. |
| 9. Refusals (CLI, child processes) | 10 tests | `answer-eval` exits **2**, with 0 external requests and no secret in its output, for each of: no approval; no config or credentials; the repository `.env`; production credentials; `AQ.` opt-in; **unknown billing** (refused by the preflight *before* any live transport exists); live transport not approved; a legacy priced flag; an invalid arm pair. `answer-judge` exits 2 for a priced flag, an unknown label, and a missing label. |

## Bite checks (mutation → result; files restored, sha256 verified)

| Mutation | Failing tests |
|---|---|
| 1. `runEvaluation` bypasses the manager (calls the transport directly) | **6** (including all-requests-through-manager, quota pause, billing stop) |
| 2. The gate's production-credential check removed | **2** (gate test + CLI test) |
| 3. The pair runner ignores the store (regenerates completed answers) | **2** (resume, judge-only drain) |
| 4. Judge exhaustion aborts instead of queueing | **1** (judge queue) |

## Other suites (re-run after the integration)

| Suite | Result |
|---|---|
| `eval/tests/evalProviderManager.test.js` (manager, after the `pairRunner` change) | 33/33 |
| `eval/tests/answerRunner.test.js` (ledger, client and judge units; CLI dry run updated to the new outputs) | 18/18 |
| `eval/tests/answerGrader.test.js` | 7/7 |

## Not tested

- **Live provider behaviour, and the live transports' request formats.** No live calls were allowed.
- **A live run with `AQUA_EVAL_LIVE_APPROVED=yes`.** It is deliberately not exercised. The "live transport not approved" refusal is tested.
