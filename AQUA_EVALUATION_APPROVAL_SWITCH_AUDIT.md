# AQUA Evaluation — Approval Switch Audit

**Date:** 2026-11-11

## 1. The two switches: every read site in the repository

Found by a full search for both names across `*.js`, `*.mjs` and `*.cjs`, excluding tests and comments.

| Switch | Read at | Semantics |
|---|---|---|
| `AQUA_ANSWER_EVAL_APPROVED` | `aqua/eval/answer/evalRun.mjs`, in `zeroBudgetGate` | If not **exactly** `yes`, adds one refusal reason. When it is `yes`, **nothing is skipped**: every other check in the gate still runs, and refusals accumulate. |
| `AQUA_EVAL_LIVE_APPROVED` | `aqua/eval/providers/transports.mjs`, in `liveTransport` | If not **exactly** `yes`, the live transport refuses to construct. When it is `yes`, it only constructs the transport: it does not configure, select, authorise or bypass anything. |

**Order of checks for `--execute`** (`liveSetup`):

```
productionDataGuard            (scripts, before setup — dry runs too)
→ zeroBudgetGate               (switch 1 + every config/path rule)
→ preflight (free tier)        (before any transport exists)
→ liveTransport                (switch 2)
→ createManager → preflight again
→ every request: manager policy (synthetic data, quota domains, billing stop, …)
```

**Structural argument.**
- The switches are conjunctive requirements (AND), never alternatives (OR) to any rule.
- The modules that enforce the remaining rules never read the switches. A static test asserts that `providerManager`, `evalConfig`, `pairRunner`, `errorTaxonomy` and `credentials` contain no `APPROVED`.
- The switches are read only from the **process environment**. They are not read from the provider config or the credentials file, so a file cannot approve a run.

## 2. Bypass attempts tested, with both switches = `yes`

**File:** `aqua/eval/tests/evalReadiness.test.js`, §1.

| Protection | Attempt | Result |
|---|---|---|
| Evaluation-only credentials | `credentialSource: 'production'`; `allowProductionCredentials: true` | Refused (gate) |
| Evaluation-only credentials | `AQ.` / non-standard opt-in | Refused (gate) |
| Evaluation-only credentials | Credentials or config **inside the repository**: the repository `.env`, `aqua/eval.env`, a config inside `aqua/`, a **junction outside the repository pointing into it**, and a **different letter case** of the repository path (Windows) | All refused (real-path resolution) |
| Free-tier verification | Billing `unknown`; a free-tier claim **without evidence**; billing `paid` | `PreflightRefused` **before a live transport exists** |
| Billing restriction | 402 from the provider | `stopped-billing` after **1** request; no second route |
| Synthetic-data restriction | Dataset not allow-listed (gate); request with a non-synthetic dataset id (manager) | Refused; `DataRefused` before any request |
| Quota exhaustion | Groq 429 RPD (including its "upgrade" text) with both switches in `process.env` | `paused` after **1** request; no other provider |
| No paid fallback | As above | No fallback model, provider or key |
| Switch strictness | `YES`, `true`, `1`, `" yes"`, `"yes "` | Not approved (both switches) |
| Switch source | Switch placed in the **config** (`AQUA_ANSWER_EVAL_APPROVED`, `approved: true`) or in the **credentials file** | Ignored: refused |

**CLI-level refusals** (child processes, exit 2, 0 external requests) are tested in `evalProviderIntegration.test.js`: 10 cases, including "live transport not approved" with switch 1 set.

## 3. Bite checks (mutation → failing tests; files restored, sha256 verified)

| Mutation | Failing readiness tests |
|---|---|
| 1. Switch 1 short-circuits the gate (`if approved return`) | **4** (production credentials, `AQ.` opt-in, non-synthetic data, paths inside the repository) |
| 2. Real-path resolution removed (a link bypass becomes possible) | **1** (junction / case test) |
| 3. The empty-completion rule removed | **1** |
| 4. Switch 2 accepts any truthy value | **1** (strictness) |

## 4. Hardening made during this audit

| Change | Why |
|---|---|
| `insideRepo` resolves symlinks and junctions (`realpath` of the nearest existing ancestor) | A link outside the repository pointing into it previously passed the check |
| The provider config must also be outside the repository | Keep evaluation declarations with their credentials, out of version control |
| `productionDataGuard` in both scripts (dry run and live) | Refuses `DATABASE_URL`, `MONGO_URI` / `MONGODB_URI` / `MONGO_URL`, a mirror not disabled, a missing `AQUA_DATA_DIR`, or one pointing at the real `~/.aquiplex` |
| An empty completion (2xx with no text) stops for review; it is not stored or retried | Reasoning models can spend the whole output budget on hidden reasoning |
| The live transport sends only known generation settings, reports the finish reason, does not retain success bodies, and maps Gemini `thinking_budget` | Request hygiene; truncation diagnosis |
