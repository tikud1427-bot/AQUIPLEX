# AQUA Evaluation Runner — Zero-Budget Provider Integration

**Date:** 2026-11-11 · `main` @ `839ea0d1` · Uncommitted.

No live API call. No production credential used. No production provider file or configuration changed.

## 1. Request path (the only one)

```
scripts/answer-eval.mjs ─┐                         ┌─ dry run: dryRunSetup()  — synthetic config + synthetic credentials + mockTransport
scripts/answer-judge.mjs ─┴─► eval/answer/evalRun.mjs ┤
                                                   └─ --execute: liveSetup() — zeroBudgetGate → evaluation credentials file → preflight → liveTransport
                              runEvaluation()
                                └─► createManager()       (eval/providers/providerManager.mjs — preflight again; free tier mandatory)
                                └─► runPairs()            (eval/providers/pairRunner.mjs — model lock, store, resume, judge queue)
                                      └─► manager.request(role, …)  → transport
```

- **The scripts contain no other request code.** The Sprint 6 priced path (`--price-in` / `--price-out` / `--max-usd`, `spendLedger`, `providerClient`) is **no longer reachable** from them, and passing any of those flags is refused.
- The older modules remain only as unit-tested library code.

## 2. What the integration guarantees

| Requirement | How |
|---|---|
| All requests pass through the manager | `runEvaluation` builds the manager and hands it to `runPairs`; the scripts have no other transport. Tests count every transport call against the manager's accounting. A bite check that bypasses the manager fails 6 tests. |
| Free-tier verification mandatory | Checked **twice**, both before any request: (1) `liveSetup` runs the manager's `preflight` *before* a live transport can be constructed; (2) `createManager` runs it again. A domain is used only with `billing: 'free-tier-verified'` **and** `billingEvidence: { method, by, at }`. |
| No production credentials | `zeroBudgetGate` refuses: `credentialSource` other than `'evaluation'`; `allowProductionCredentials: true`; a credentials file that is the repository `.env` or **any file inside the repository**. Credentials are read only from the `--credentials-env` file, never from `process.env`. |
| `AQ.` values never used | The gate refuses any non-empty `allowNonStandard`. The inventory excludes non-standard values by default, so an `AQ.` value present in an evaluation file is excluded. |
| Identical A/B model configuration | `runPairs` sends both arms with `config.models.answer` (model and settings) and locks the model per pair. Resuming a pair under another model is refused (`model-mismatch`). The judge must differ from the answering model (gate). |
| Quota exhaustion pauses, never a paid route | Manager: domain pause on exhaustion; `BillingStop` on any billing signal; no fallback model or provider. Run status `paused` (exit 3) with the resume time. |
| Resumable answers and judgements | `<label>.pairs.jsonl` is appended per completed answer and judgement. The no-duplicates key is `case|arm|model|settings`. **The prompt hash is no longer part of the key**, because ACIB prompts contain the run date and a resume on another day must not regenerate answers. The prompt hash is stored with the answer. Prompts are built **lazily**, only for arms not yet answered. |
| Judge exhaustion queues completed pairs | `runPairs` queues the case and keeps answering (`complete-judging-queued`, exit 3). `answer-judge --label` later runs **judging only** (`phases: ['judge']`), and never re-answers. |
| Synthetic data only | Every request carries the dataset's frozen sha256, which must be in `syntheticDatasets` (manager) and in the config (gate). Prompts come from the ACIB pipeline on synthetic scenarios. |

## 3. Changes

| File | Change |
|---|---|
| `aqua/eval/answer/evalRun.mjs` | **New.** Contains `zeroBudgetGate`, `parseEnvFile`, `dryRunSetup`, `liveSetup`, `acibCases` (lazy prompts via the real pipeline), `runEvaluation`, `mergeStore` (un-blind from the store, deterministic grades, judge aggregates, review queue: malformed / confidence < 0.6). |
| `aqua/scripts/answer-eval.mjs` | **Rewritten** on `evalRun`. `--arms` must name exactly two (default `A,H`); `--execute --provider-config <f> --credentials-env <f>`; legacy priced flags refused. Outputs: `<label>.pairs.jsonl` and `<label>.json`. Exit codes: 0 complete / 2 refused / 3 paused, queued or stopped. |
| `aqua/scripts/answer-judge.mjs` | **Rewritten.** Judging only (drains the queue) or `--merge` (writes `<label>.merged.json`, no requests). |
| `aqua/eval/providers/pairRunner.mjs` | `arms` and `phases` options; lazy arm prompts; key without the prompt hash; `incomplete` list. The manager's 33 tests still pass. |
| `aqua/eval/tests/evalProviderIntegration.test.js` | **New:** 29 tests |
| `aqua/eval/tests/answerRunner.test.js` | One CLI test updated to the new output files (`merged.json`, pair store) |
| `.env` | **Comments only** (lines 49–51), see §4 |

**Not changed:**
- `aqua/src/providers/*` and `services/ai.client.js`: `git diff HEAD` is empty and `git status` clean;
- frozen datasets: hashes intact;
- `aqua/eval/baselines/`: no file newer than Sprint 5.

## 4. Credential hygiene (`.env`)

| | |
|---|---|
| Located | Lines 49–51 of `.env`, the Gemini block. Line 49 claimed `KEY_1` holds the standard API key (false). Line 50 contained a **10-character fragment of an old `AQ.` token**. Line 51 claimed the `AQ.` values are commented out (false: lines 53–64 are active). The only `AQ.` fragment in any `.env` comment was on line 50 (whole-file scan). |
| Changed | Those three lines were replaced with an accurate note. The values are not in the standard Google API-key format, their kind and lifetime are unverified, and they are not used for evaluation (with a pointer to the audit). |
| Preserved | The script verified the expected text of each of the three lines before changing anything. It compared all **77** `NAME=value` entries (order and content) before and after: **identical**, re-checked from disk after writing. No backup copy of the file was made, and no value was printed. **0** comment lines now contain `AQ.`. |
| Not changed | Every credential value; every other line. `.env` is git-ignored, so there is no repository diff. |

## 5. How a first live synthetic test would run (NOT done — awaiting approval)

1. **Founder:** create **evaluation-only** keys (not the production ones) and put them in a file **outside** the repository, for example `C:\aquiplex-eval\eval.env`.
2. **In the provider consoles,** record for each key the Google project or Groq organisation, and that no billing or paid plan is attached (who, when). Fill these into a copy of `aqua/eval/providers/evalConfig.example.json` (outside the repository) with `credentialSource: "evaluation"`.
3. **One-case smoke run:**
   ```
   AQUA_ANSWER_EVAL_APPROVED=yes AQUA_EVAL_LIVE_APPROVED=yes \
     node scripts/answer-eval.mjs --execute --limit 1 --arms A,H --label live-smoke \
       --provider-config C:\aquiplex-eval\config.json --credentials-env C:\aquiplex-eval\eval.env
   ```
4. **Check** `eval/answer/results/live-smoke.json` (status, usage, quota state) before anything larger. **The live request formats are unverified until this step.**
