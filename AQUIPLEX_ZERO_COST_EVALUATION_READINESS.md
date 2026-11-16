# AQUIPLEX — Zero-Cost Evaluation Readiness

**Date:** 2026-11-11 · **Repository:** `main` @ `839ea0d1`
**Revision 3:** final pre-smoke-test corrections. Revision 2 added the founder-verified Gemini credentials.

> **No live requests were made.** No provider API was called in this review or in any test. Every test mocks its providers (or injects a stub fetch) and carries a network tripwire (0 external requests). Nothing was committed, pushed or deployed. No credential was created. No secret value was printed, copied, logged or written. **The smoke test is not authorised and was not executed.**

## 1. The exact command (answers-only smoke test — NOT run)

Windows PowerShell, in a **new** PowerShell window with no provider credentials in its environment:

```powershell
cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua
$env:AQUA_ANSWER_EVAL_APPROVED="yes"
$env:AQUA_EVAL_LIVE_APPROVED="yes"
node scripts/answer-eval.mjs --execute --answers-only --set acib.v2.dev --limit 1 --regime short --arms A,H --label live-smoke-1 --provider-config C:\Users\dell\aquiplex-eval\config.json
```

After the run, clear the switches (or close the window):

```powershell
Remove-Item Env:AQUA_ANSWER_EVAL_APPROVED, Env:AQUA_EVAL_LIVE_APPROVED
```

- `$env:` variables apply only to that PowerShell window. The earlier CMD-style `set` lines were wrong for PowerShell and have been replaced.
- **Expected outcome:** `complete-judging-queued · answered 2 · judged 0`, with **exit code 3**. Exit code 3 is the designed status for "answers done, judging queued", not an error.
- **Judging is a separate, later decision** (also not authorised). It sends 2 judge requests and no answering requests:
  ```powershell
  node scripts/answer-judge.mjs --execute --set acib.v2.dev --regime short --arms A,H --label live-smoke-1 --provider-config C:\Users\dell\aquiplex-eval\config.json
  ```

### The scripts refuse to start (exit 2, no request sent) if

- any provider credential variable is present in the window's environment;
- `DATABASE_URL` or a Mongo URI is set;
- either switch is not exactly `yes`;
- another evaluation holds the machine-wide lock;
- the config fails the gate or preflight (§3).

## 2. Expected request counts

| Run | Groq answer (`openai/gpt-oss-120b`) | Judge | Total | Duration |
|---|---|---|---|---|
| **Answers-only smoke (§1)** | **2** (arm A, arm H; case `d-pc-job@short`) | **0** | **2** | ≥ 61 s (paced) |
| Later judge run (not authorised) | 0 | 2 | 2 | ≥ 61 s |
| Full pair without `--answers-only` (not proposed) | 2 | 2 | 4 | ≥ 3 min |

**Answers-only cannot continue into judging.** This is verified by tests:

- `--answers-only` maps to the answer phase only. A dry-run child process prints `complete-judging-queued · answered 2 · judged 0` with 0 external requests.
- In-process: exactly 2 Groq `gpt-oss-120b` requests and 0 judge-model requests.
- Re-running the same answers-only command sends **0** requests (answers are stored; nothing is judged).
- Judging happens only in a separate `answer-judge` run. It sends exactly the 2 judge requests and never re-answers.

**Note:** for this first case, arms A and H currently build **identical** prompts (5,923 characters each). This smoke test exercises the request path; it cannot show an A/H difference.

## 3. Quota safeguards

### Token estimates (measured offline with the real pipeline; no tokenizer installed, so the bounds are conservative)

| Request | Prompt (measured) | Typical estimate (~4 chars/token) | Conservative estimate used by the manager (chars/3 + framing + full output bound) |
|---|---|---|---|
| Answer, each arm | 5,923 chars, 906 words, 2 messages | ~1,500 prompt + ≤ 1,500 output | **3,507** |
| Judge, worst case (6,000-char answer) | 7,933 chars | ~2,000 + ≤ 1,024 | **3,693** |

The real token usage is recorded per request in `eval/answer/results/live-smoke-1.pairs.jsonl` (`usage`) for comparison after the run.

### Against Groq's 8,000 tokens-per-minute limit

The limit was observed on 2026-11-01 for the free plan and is shared with production; re-check it in the console.

- **Evaluation share:** `rateLimits.groq = { tokensPerMinute: 4000, maxRequestTokens: 4000, minIntervalMs: 61000 }`. The evaluation uses at most half the limit in any minute, leaving at least 4,000 TPM to production.
- **Pacing:** before **every** attempt, retries included, the manager waits until 61 s have passed since the previous attempt to that provider. It also waits until the estimated tokens sent in the last minute plus this request fit within 4,000.
  - The two answers are therefore at least 61 s apart; there is never more than one evaluation request in a minute.
  - Tested with a fake clock: answers, a full pair and a retry.
- **Size ceiling:** a request estimated above 4,000 tokens is **rejected before it is sent** (status `stopped-rejected`, 0 requests; Groq would answer 413 anyway). The smoke requests (3,507) fit.
- **Bounded output:** `max_tokens` is required for every role (answer 1,500; judge 1,024). It must also leave room for the prompt under the ceiling.
- **Request cap:** `requestBudget { groq: 4, gemini: 4 }` per run. Every attempt counts, and the run pauses at the cap.
- **Stops:**
  - A daily-quota 429 pauses the shared group after 1 request.
  - A billing signal (402, billing wording, quota limit 0) → `stopped-billing`. There is no paid route, no other provider and no other model.
  - An empty completion (output budget spent on reasoning) → `stopped-review`.
  - An unclassified error → `stopped-review`.

All of these are **required** in production-pool mode: a config without `rateLimits` for each role provider, or without a bounded `max_tokens`, is refused.

## 4. Verification requirements (enforced in code)

| Requirement | Enforcement |
|---|---|
| Explicit founder decision to use the existing pools | `founderDecision { by, at, statement }` (gate and preflight) |
| Explicit founder verification of the 12 Gemini credentials | `credentialVerification { by, at, statement, envNames }`; each `AQ.` key must be named and opted in (`allowNonStandard`); numbered `GEMINI_KEY_<n>` only |
| **Every** account/quota group explicitly verified free, for **both** providers | **New:** in production-pool mode, *every* declared domain must have `billing: "free-tier-verified"` **and** its own `billingEvidence { method, by, at }`. This applies even to a group no role uses, so nothing unverified is loaded. |
| Gemini billing evidence independent of the credential verification | **New:** the credential verification never sets billing. A `billingEvidence` that merely repeats the credential-verification statement is refused. Tested: a record present with billing missing → refused. |
| Conservative grouping until ownership is documented | Without `verification { method, by, at }` per domain, all 12 Gemini keys are **one** group and all 5 Groq keys **one** group (tested) |

## 5. Gemini authentication (only through the supported mechanism)

- **Production adapter:** `aqua/src/providers/gemini.js:71` uses `new GoogleGenAI({ apiKey })`. The `@google/genai` 2.10.0 SDK sends an `apiKey` in the `x-goog-api-key` header.
- **Differential test (new).** The real SDK and the evaluation transport were each given the same synthetic `AQ.` key, with a stub fetch in place of the network. They produced the **same** request:
  - the same endpoint (`…/v1beta/models/gemini-2.5-flash:generateContent`);
  - the key in `x-goog-api-key`;
  - no `Authorization` header;
  - no key in the URL.
- **Static test (new):** credential values are revealed only in the evaluation transport, and for Gemini only into `x-goog-api-key`.
- **Why the evaluation does not call the SDK through the production adapter:** that would route through production provider code, which this evaluation must not touch. The differential test proves the mechanism is identical.
- **Unproven until a live call:** whether Google accepts the `AQ.` values for `generateContent` on the chosen model. The answers-only smoke test sends **no** Gemini request; Groq answers.

## 6. Outstanding manual checks (founder; record who and when)

**Groq** (console.groq.com):

1. Which organisation owns `GROQ_API_KEY_1..5` (API Keys page; Settings → Organization for the ID).
2. Plan = **Free**, **no payment method**, no invoices or credits.
3. Limits for `openai/gpt-oss-120b`: confirm 8,000 TPM (or adjust `rateLimits.groq` to at most half the real value). Check today's usage.
4. A low-traffic time. Remaining daily quota comfortably above 2 requests / ~7k tokens.

**Gemini** (needed in the config even for the answers-only run, because every declared group must be verified; or remove the Gemini domain and set `allowNonStandard: []` for a Groq-only config):

5. Which Google Cloud project(s) own `GEMINI_KEY_1..12`. Until this is documented, keep one domain.
6. Each project: **no billing account linked** (Cloud console → Billing). This is separate evidence, not the credential verification.

**Later (judge run only):**

7. `qwen/qwen3.8-27b` availability on the Groq Free plan, or `gemini-2.5-flash` for these keys.

**Then fill in `C:\Users\dell\aquiplex-eval\config.json`** from `C:\Users\dell\aquiplex-eval-example\config.existing-pools.example.json` (outside the repository):

- `founderDecision`;
- `credentialVerification`;
- organisation and project ids;
- `billing: "free-tier-verified"` plus `billingEvidence` for each group;
- keep `requestBudget` and `rateLimits` as given.

The example is refused as written and accepted once filled in (checked with synthetic values).

**Also outstanding:** repository `.env` lines 49–51 still say the Gemini keys are not used for evaluation (outdated; not edited — see revision 2).

## 7. Test results (from `aqua/`)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/preSmokeReadiness.test.js` (**new**) | **16/16** |
| All evaluation suites (`preSmokeReadiness`, `founderVerifiedGemini`, `zeroCostReadiness`, `existingKeyPool`, `evalReadiness`, `evalProviderIntegration`, `evalProviderManager`, `answerRunner`, `answerGrader`) | **170/170** |
| `node scripts/run-tests.mjs src/providers` | **199/199** |
| `git diff HEAD -- aqua/src/providers aqua/src/core/strategy.js services/ai.client.js` | **empty** (production routing, fallback and key rotation unchanged) |
| Bite checks (mutation → failures; files restored, sha256 verified) | Pacing removed → 4; size ceiling removed → 1; per-group billing rule removed → 2; copied-evidence check removed → 1; CLI ignores `--answers-only` → 1; `rateLimits` requirement removed → 1 |
| Leak scan (real `.env` values, counts only) | 19 values × 13 files → **0 hits** |

## 8. Changes in revision 3

| File | Change |
|---|---|
| `aqua/eval/providers/providerManager.mjs` | `estimateRequestTokens`; pacing before every attempt (minimum interval + per-minute token window); oversize requests rejected unsent |
| `aqua/eval/providers/evalConfig.mjs` | Production pools require: billing evidence on **every** domain; billing evidence distinct from the credential verification; `rateLimits` per role provider; bounded `max_tokens` |
| `aqua/eval/providers/pairRunner.mjs` | `RequestRejected` → clean `stopped-rejected` status (previously an uncaught error) |
| `aqua/eval/answer/evalRun.mjs` | `runEvaluation` accepts `managerOptions` (tests inject a clock); returns `rejected` |
| `aqua/eval/tests/preSmokeReadiness.test.js` | **New** (16 tests) |
| `aqua/eval/tests/existingKeyPool.test.js`, `zeroCostReadiness.test.js`, `founderVerifiedGemini.test.js` | Configs gain a non-blocking `rateLimits` (now required); assertions unchanged |
| `C:\Users\dell\aquiplex-eval-example\config.existing-pools.example.json` (outside the repository) | `rateLimits` (4,000 TPM share, 61 s interval); note that billing evidence is per group and separate |
| This report | Revision 3: PowerShell commands, answers-only command, request counts, token pacing |

## 9. Final pre-execution check (revision 3.1)

The review found that two items did **not** hold in revision 3. Both were fixed in the evaluation manager only.

- A per-minute 429 with a short `Retry-After` was waited out and retried, and a quota 429 could move to another verified group.
- Keys rotated round-robin (the two answers would have used `GROQ_API_KEY_1` and `_2`), and a 401/403 moved on to the next key.

**New defaults in existing-pool mode.** A config can opt out explicitly with `keyRotation: true` or `waitOnRateLimit: true`; the smoke config does not.

- Every request uses the first configured key (`GROQ_API_KEY_1`).
- A failed key → `stopped-review`.
- **Any** 429 (per-minute, daily or unexplained) → `paused` at once: no wait, no retry, no other key or group.

The run summary previously also counted pacing waits as requests; it now counts only sent attempts. The CLIs print one `RESULT:` line, for example:

- `RESULT: COMPLETED (answers only; judging NOT run — use answer-judge.mjs) · requests sent 2 · provider-reported tokens: prompt …, completion …`
- `RESULT: PAUSED (<reason>) — nothing further was sent; resume after …`

| # | Check | Status | Evidence (`eval/tests/finalPreExecution.test.js`, 14 tests) |
|---|---|---|---|
| 1 | Any Groq rate-limit response pauses immediately | ✅ | Per-minute, daily and unexplained 429: 1 request, 0 waits, `paused`; no move to a second verified organisation |
| 2 | No switch to another Groq key or to Gemini | ✅ | Both answers use `GROQ_API_KEY_1`; a 401 → `stopped-review` after 1 request; a 5xx retries on the same key; the answer provider is fixed to Groq |
| 3 | No retry exceeds the cap | ✅ | Endless network failures: ≤ 2 attempts with cap 2, ≤ 4 with cap 4 |
| 4 | Answers-only = 2 requests, 0 judge requests | ✅ | In-process and CLI dry run (`requests sent 2`, 0 external) |
| 5 | Re-run repeats nothing | ✅ | Same command again: 0 requests; after a pause only the missing arm is sent |
| 6 | Provider-reported tokens recorded | ✅ | Groq `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`) stored per answer in `live-smoke-1.pairs.jsonl`, summed in `live-smoke-1.json` and in the `RESULT` line |
| 7 | Output says completed or paused | ✅ | `RESULT:` line + `status` / `pauseReason` / `resumeAt` in the JSON |
| 8 | Production routing and fallback unchanged | ✅ | `git diff HEAD -- aqua/src/providers aqua/src/core/strategy.js services/ai.client.js` empty; `src/providers` 199/199 |
| 9 | Uncommitted paths preserved | ✅ | 155 original + 3 new test files = 158 |

**Results:**

- Evaluation suites: **184/184**.
- Bite checks: rotation default flipped → 3 failures; rate-limit waiting re-enabled → 5; summary counting non-requests → 1; failed-key rotation → 1. The file was restored (sha256 verified).
- Leak scan: 19 values × 16 files → **0 hits**.
- Five older tests that exercise rotation now opt in explicitly (`keyRotation: true`); their assertions are unchanged.

**Git:** `main` @ `839ea0d1`. Nothing committed, pushed or stashed. Revision 3 left 157 uncommitted paths; with `finalPreExecution.test.js` there are now 158.

**Git (as of revision 3):** 157 uncommitted paths: the 155 preserved, plus `founderVerifiedGemini.test.js` and `preSmokeReadiness.test.js`. **Not changed:** production providers, routing, fallback, key rotation, `.env`, frozen datasets, baselines.

**Stopped — awaiting founder authorisation. No live requests.**
