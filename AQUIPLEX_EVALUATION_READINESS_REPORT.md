# AQUIPLEX — Evaluation Readiness Report

**Date:** 2026-11-11

## Repository and safety

| Item | Value |
|---|---|
| Repository | `main` @ `839ea0d1` (verified) |
| Working tree | 144 uncommitted paths at the start: the brief's 140 plus the 4 added by the integration task. All preserved. 5 new paths in this task: one test file and four documents. |
| Production provider code | Untouched: `git status` and `git diff` for `aqua/src/providers` and `services/` are empty |
| Commits, pushes, deploys | None |
| API requests | **No live API request** of any kind. No ownership discovery requests. |
| Production memory | Not accessed: `~/.aquiplex/.aqua-mind.json` mtime unchanged since 2026-11-10 11:18:28 |
| Credentials | No credential requested, read for display, or printed. The examples contain none. |

## 1. Credential verification → [AQUA_EVALUATION_CREDENTIAL_VERIFICATION.md](AQUA_EVALUATION_CREDENTIAL_VERIFICATION.md)

- **Console steps** for: Gemini project ownership and project ID, free tier, billing; Groq organisation ownership and organisation ID, free tier, billing.
- **The evidence to record** per check, and how it maps to the config fields.
- **Recommendation:** create **new evaluation-only keys** in a billing-free Google project and a payment-method-free Groq organisation. Ownership is then established by construction. Production keys and the `AQ.` values are refused by design.

## 2. Approval-switch safety → [AQUA_EVALUATION_APPROVAL_SWITCH_AUDIT.md](AQUA_EVALUATION_APPROVAL_SWITCH_AUDIT.md)

- **Each switch is read in exactly one place**, as an additional (AND) requirement. Neither can skip, weaken or replace any other check, and the enforcing modules never read them (static test).
- **Bypass tests with both switches = `yes`:**
  - evaluation-only credentials (including a **junction into the repository** and **letter-case** variants);
  - free-tier verification (unknown, unevidenced, paid);
  - billing stop;
  - synthetic data;
  - quota pause;
  - no paid fallback;
  - switch strictness (`YES` / `true` / `1` / spaces);
  - switches placed in the config or the credentials file.

  **All hold.**
- **Bite checks:** 4 mutations, each caught (4 / 1 / 1 / 1 tests fail).

## 3. External configuration

| Path | Contents |
|---|---|
| `C:\Users\dell\aquiplex-eval-example\` (outside the repository) | `config.example.json`, `eval.env.example` (empty values), `README.txt` (setup and `icacls` permission command) |

- **No credentials** anywhere.
- **The example config is refused as written**, even with both switches set: billing is `unknown`. This was verified.
- **The real files go in `C:\Users\dell\aquiplex-eval\`** (not created).
- **Credential and config paths inside the repository are refused**, including via links.

## 4. Smoke-test readiness → [AQUA_EVALUATION_SMOKE_TEST_READINESS.md](AQUA_EVALUATION_SMOKE_TEST_READINESS.md)

- **The test:** one synthetic dev case (`acib.v2.dev`, first scenario, short history), arms A/H, Groq `openai/gpt-oss-120b` answering, Gemini `gemini-2.5-flash` judging. **4 requests.**
- **Verified without network:**
  - same answering model for both arms, and a different judge;
  - request formats and response parsing for both providers (stubbed `fetch`);
  - persistence, and resume with 0 re-requests;
  - quota pause; billing stop; empty-completion stop;
  - no production data.
- **The exact smoke command** was dry-run through the CLI (mock transport): `complete`, then a resume with 4 skipped, with **0** external requests.

## 5. Tests (commands from `aqua/`)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/evalReadiness.test.js` (**new**, 17 tests) | 17/17 |
| `node scripts/run-tests.mjs eval/tests/evalReadiness.test.js eval/tests/evalProviderIntegration.test.js eval/tests/evalProviderManager.test.js eval/tests/answerRunner.test.js eval/tests/answerGrader.test.js` | **104/104** |

Every file carries a global fetch tripwire (0 real requests), or a child-process fetch guard for the CLI tests.

## 6. Changes in this task

**Hardening, all in `aqua/eval/` and `aqua/scripts/`:**

| File | Change |
|---|---|
| `aqua/eval/answer/evalRun.mjs` | `realLocation` / `insideRepo` (links resolved); the provider config must be outside the repository; `productionDataGuard` |
| `aqua/eval/providers/providerManager.mjs` | Empty completion → stop for review |
| `aqua/eval/providers/transports.mjs` | Only known settings sent; finish reason reported; success bodies not retained; Gemini `thinking_budget` |
| `aqua/scripts/answer-eval.mjs`, `aqua/scripts/answer-judge.mjs` | `productionDataGuard` at start |

**New:**
- `aqua/eval/tests/evalReadiness.test.js`;
- the four documents;
- the external example folder.

**Not changed:** production provider code, configuration, `.env`, frozen datasets, baselines.

## 7. Open points — unverifiable until the live smoke test

- The live request formats, error bodies, and whether `thinking_budget: 0` is accepted.
- The token budgets needed by the two reasoning models (`max_tokens` 1,500 answering / 1,024 judging, in the example).

## 8. Stopped — awaiting founder approval

1. **Create the evaluation-only keys**, and perform and record the console checks (§1).
2. **Approve the first live request:** the one-case smoke test, 4 requests, with both switches set by the founder.
