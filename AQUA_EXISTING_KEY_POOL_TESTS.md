# AQUA — Existing Key Pool Tests

**Date:** 2026-11-11

**File:** `aqua/eval/tests/existingKeyPool.test.js`. **19 tests, 19 pass.**

- **Synthetic environment that mirrors the real `.env` layout:** 12 `AQ.`-prefixed `GEMINI_KEY_<n>`, a bare `GEMINI_API_KEY`, five standard `GROQ_API_KEY_<n>`, a bare `GROQ_API_KEY`, blank and malformed entries, and unrelated secrets (database URL, session secret, Mongo URI, OpenRouter keys).
- **Every value carries the marker `SECRET`.**
- **All providers mocked.** A global fetch tripwire asserts 0 requests. **The real `.env` is never read by tests.**

```
cd aqua && node scripts/run-tests.mjs eval/tests/existingKeyPool.test.js     → 19/19
```

## Coverage (brief → tests)

| Required | Test | Asserts |
|---|---|---|
| All numbered names recognised | the reading tests | Only `GEMINI_KEY_<n>` (1–13) and `GROQ_API_KEY_<n>` (1–7) leave the `.env` text. Unnumbered keys, `DATABASE_URL`, `SESSION_SECRET`, `MONGO_URI` and OpenRouter keys are dropped. Numeric order holds (10–12 after 9). |
| Missing / malformed filtered | missing and malformed keys | `GEMINI_KEY_13` blank, `GROQ_API_KEY_6` placeholder, `GROQ_API_KEY_7` internal whitespace: excluded with reasons, no values |
| `AQ.` credentials excluded | every `AQ.`-prefixed Gemini value is excluded | 12 excluded; **no Gemini domain**. Opting them in is refused by the gate. **A Gemini judge is refused** (no eligible credential). |
| Shared quota exhaustion pauses | shared quota exhaustion pauses after ONE request | The 5 Groq keys form one group; an RPD 429 (with Groq's upgrade text) → `QuotaPaused` after **1** request |
| Invalid individual credential skipped | an invalid individual credential is skipped safely | A 401 on `GROQ_API_KEY_1` → another numbered key serves (2 requests); the key is marked invalid |
| No unnumbered fallback | unnumbered keys excluded; no unnumbered fallback | The bare keys are excluded (`unnumbered-excluded`). With **all** numbered keys invalid, each is tried at most once and the bare key **never** → pause. |
| No paid route | billing stop; unknown billing; mode requirements; request budget | 402 → `BillingStop` after 1 request. Unknown billing → refused. Production pools require the founder decision, the mode and a `requestBudget`. **The budget pauses the run** (`run-request-budget`), counting retries. |
| Gate (mode) | integration gate | A separate credentials file is refused in this mode; incomplete founder decision, non-synthetic data and an in-repo config are refused; a complete config passes the gate |
| Live switch still required | liveSetup in this mode | Reads only the numbered variables (synthetic file) and still refuses without `AQUA_EVAL_LIVE_APPROVED=yes` |
| A/B consistency, resume, no leakage | both arms same model; resume; records | 4 answers on one model with identical settings; only `GROQ_API_KEY_1..5` used; a re-run sends **0** requests; no `SECRET` in the store or run record |
| Production behaviour unchanged | production key pool still discovers numbered and unnumbered slots | `keyPool.cjs` still sees the bare `GROQ_API_KEY` and all 12 numbered Gemini slots: evaluation filtering does not affect it |

## Bite checks (mutation → failing tests; files restored, sha256 verified)

| Mutation | Failing |
|---|---|
| 1. Unnumbered filter removed | **2** (exclusion, no-fallback) |
| 2. Request budget removed | **1** |
| 3. `.env` reader passes every variable | **2** |
| 4. Founder-decision requirement removed | **1** |

## Regression

| Command (from `aqua/`) | Result |
|---|---|
| All evaluation suites: `existingKeyPool`, `evalReadiness`, `evalProviderIntegration`, `evalProviderManager`, `answerRunner`, `answerGrader` | **123/123** |
| `node scripts/run-tests.mjs src/providers` (production providers) | **199/199** |
| `git diff HEAD -- aqua/src/providers services/ai.client.js` | empty |
