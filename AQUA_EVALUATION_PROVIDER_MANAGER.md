# AQUA Evaluation Provider Manager

**Date:** 2026-11-11 · **Location:** `aqua/eval/providers/` · **Evaluation only.**

- Production rotation (`src/providers/keyPool.cjs`, `keyRotation.js`) is **not used and not changed**. No file under `src/providers/` was modified.
- Nothing is wired into the running app.
- No live call was made.

## 1. Modules

| File | Responsibility |
|---|---|
| `credentials.mjs` | Loads `GEMINI_KEY_<n>` + `GEMINI_API_KEY` and `GROQ_API_KEY_<n>` + `GROQ_API_KEY`. **Excludes:** blank, whitespace, quoted, placeholder or too-short values; duplicates; values in another provider's format. **Classifies** compatibility as `standard` / `non-standard` / `incompatible`. The value lives in a private `WeakMap`: `JSON.stringify`, `String()` and `util.inspect` of a credential show only its variable name. `revealForRequest` is used only by a live transport to build the auth header. |
| `errorTaxonomy.mjs` | One category and one scope per failed attempt (§3). Parses Retry-After (header seconds or date, or body `retry in` / `retryDelay`). |
| `evalConfig.mjs` | Explicit evaluation configuration and **preflight** (§4); quota-domain construction |
| `providerManager.mjs` | Domain-aware selection, per-key and per-domain health, the error policy, observability (§5) |
| `pairRunner.mjs` | A/B pairs: model lock, persistence, resume, judge queue (§6) |
| `transports.mjs` | `mockTransport` (tests). `liveTransport` **refuses to construct** without `AQUA_EVAL_LIVE_APPROVED=yes`; its request formats follow public REST documentation and are **unverified live**. |
| `evalConfig.example.json` | A template that the preflight **refuses as written** (billing `unknown`) |

## 2. Quota domains

- **A quota domain** is the unit that shares a limit: a Gemini project or a Groq organisation.
- **Verified domains.** The config declares them per provider with `envNames`, plus `verification: { method, by, at }`, meaning a person established that these keys belong to one project or organisation.
- **Unverified keys.** Every credential not in a verified domain joins **one** implicit domain per provider, `unverified:<provider>`. **Two keys are never assumed to be separate quota domains.** A declared domain without verification is merged into it.
- **Rotation happens:**
  - **between keys inside a domain** only for key-scoped failures (invalid, expired, restricted);
  - **between domains** only when both are verified and independent, and only to the **same model**.
- **The domain id is logged only as a 12-hex hash.**

## 3. Error policy

| Category | Detected by | Action |
|---|---|---|
| `invalid_credential` | 401; 400/403 with an invalid-key wording | Key marked `invalid`; try another key in the same domain |
| `expired_credential` | `expired` / `ACCESS_TOKEN_EXPIRED` / `invalid_grant` | Key marked `expired`; try another key |
| `key_restricted` | 403 `PERMISSION_DENIED`, `API_KEY_*_BLOCKED`, referrer/IP/service restrictions | Key marked `restricted`; try another key |
| `rate_limited_temporary` | 429 with per-minute (RPM/TPM) wording or a Retry-After | **Domain** cools until Retry-After (default 60 s). If short (≤30 s) and no other open independent domain, wait inline and retry; otherwise try another independent domain; else `QuotaPaused`. |
| `quota_exhausted` | 429 with per-day / RPD / TPD / free-tier quota wording; any unexplained 429 (conservative) | **Domain paused** until Retry-After, or the configured daily reset, or 24 h if unknown. No other key of that domain is tried. |
| `billing_required` | 402; billing / paid-tier wording on non-429 errors; **a 429 with a quota of 0** (the model has no free allocation) | **STOP the whole run.** Every later request throws `BillingStop`; no other key, domain, provider or model is tried. |
| `request_too_large` | 413 (Groq labels it `rate_limit_exceeded`) | `RequestRejected`; no retry; **not** a quota event |
| `network` / `server_error` | Transport throw (`ECONNRESET`, timeout…) / 5xx | Bounded retry on the same key: 2 retries, exponential backoff, max 8 s |
| `unknown` | Anything else | **STOP for review** (`ReviewRequired`) |

- **A Groq 429 that advertises an upgrade is not a billing event.** Groq's ordinary 429 text includes "Upgrade to Dev Tier … /settings/billing", so on a 429 the status decides. This is tested.

## 4. Zero-cost protection (preflight refuses unless all hold)

| Rule | Mechanism |
|---|---|
| Explicit evaluation-only configuration | `evaluationOnly: true` required |
| No production credentials unless explicitly enabled | `credentialSource` must be declared. `'production'` (the repo `.env` labels itself so) requires `allowProductionCredentials: true`. |
| Billing / free eligibility known | A domain serves requests **only if** `billing: 'free-tier-verified'` **with** `billingEvidence: { method, by, at }`. `unknown` or `paid` → no request. The model's provider must have at least one such domain. |
| A valid key is not proof of free quota | No code path sets billing status from a successful call. Billing comes only from the declaration. |
| No paid fallback | `BillingStop` ends the run; there is no fallback model or provider; the role's model is fixed |
| Stop before any request that could incur a charge | Only verified-free domains are eligible; the first billing signal stops everything |
| Never automatically enable billing | No code touches billing settings (no such API is called) |
| Never send user histories | Every request carries a `datasetId` that must be in `syntheticDatasets` (sha256 allow-list), else `DataRefused` **before** any request |
| Non-standard credentials | Unusable unless listed in `allowNonStandard` |

## 5. Observability (allow-listed fields only)

- **Each event records:**
  - `provider`, `model`, `role`, `caseId`;
  - `envName` (the variable **name**);
  - `domain` (12-hex hash);
  - `outcome`, `category`, `retry`;
  - `promptTokens`, `completionTokens`, `cooldown` (until), `at`.
- **`summary()`** aggregates per provider, model, variable name and domain: requests, successes, tokens, errors by category, retries.
- **`state()`** shows each key's status (`unknown-until-used`, `invalid`, `expired`, `restricted`) and each domain's status (`ok`, `cooling`, `paused`) with resume time, plus the stop reason.
- **Completed evaluation cases** are counted by the pair runner.
- **Never recorded:** keys, authorization headers, request bodies or error bodies.

## 6. A/B pairs (`runPairs`)

- **Same answering model and settings for A and B.** The model is locked per pair on its first answer. Resuming a pair under a different configured model is **refused** (`model-mismatch`), never mixed.
- **Persistence.** Every answer and judgement is appended to a JSONL store as it completes.
- **No duplicate work.** The idempotency key is case | arm | model | settings hash | prompt hash.
- **Answer quota exhausted** → status `paused`, with the resume time. The completed arm is kept; re-running after the reset completes only what is missing.
- **Judge quota exhausted** → completed pairs are **queued** for judging (`complete-judging-queued`) and answering continues. The judge's provider and model and the answer model are recorded per judgement.
- **Billing or unknown error** → the run stops (`stopped-billing` / `stopped-review`).

## 7. How an evaluation would be configured (not done; needs approvals)

1. Copy `evalConfig.example.json` outside the repository.
2. For each Gemini project and Groq organisation that a person has verified in the provider console:
   - add a domain with `envNames`, `verification` and `billingEvidence`;
   - set `billing: 'free-tier-verified'` only if the console shows no billing attached.
3. Set `allowProductionCredentials: true` only with explicit approval, or create evaluation-only keys and set `credentialSource: 'evaluation'`.
4. Only then: `AQUA_EVAL_LIVE_APPROVED=yes` for the run that uses `liveTransport`. Its request formats are unverified, so start with a one-case smoke run.

**Not built:** wiring into `scripts/answer-eval.mjs` / `answer-judge.mjs`. Those use the Sprint 6 provider client and spend ledger. Swapping their transport for the manager is a small, reviewed change, left for approval.
