# AQUIPLEX — Evaluation Key Pool Report

**Date:** 2026-11-11 · **Repository:** `main` @ `839ea0d1` (verified)

**Working tree.** It had 134 uncommitted paths at the start, all preserved; 9 new untracked files were added. Nothing was committed, pushed or deployed. No production flag, provider code or configuration changed. No live or paid call was made. The real memory store was not accessed (mtime unchanged).

**Credential handling.** `.env` was read through a script that printed only variable names and shape categories. No credential value, fragment or hash appears in any output, file or document.

## 1. Answers to the brief's questions → [AQUA_EVALUATION_KEY_POOL_AUDIT.md](AQUA_EVALUATION_KEY_POOL_AUDIT.md)

| Question | Answer |
|---|---|
| Gemini authentication | The value is passed as `apiKey` to `@google/genai`. No OAuth or Bearer path. |
| Numbered Gemini entries: keys or tokens? | **Undetermined.** All 12 are `AQ.`-prefixed (not the `AIza` API-key format). The `.env` comment calls such values ~30-minute ephemeral tokens, but past probes saw them work 17 days apart. The comment also describes a layout that no longer matches the active values. |
| Refresh mechanism | **None.** |
| Groq loading | `GROQ_API_KEY_<n>` + `GROQ_API_KEY` via the shared `keyPool.cjs` |
| Existing rotation | Yes (production `keyPool.cjs`): per-key round-robin, with 429 cooling **per key**. **It is not quota-domain aware**, so it would rotate through keys of one exhausted project or organisation. |
| Error classification | `providerErrors.js`: `rate_limit`, `auth`, `billing`. It does not separate per-minute throttling from daily/project exhaustion, and reads Groq's 413 as a rate limit. |
| Projects / organisations | **Gemini unknown.** **Groq:** a 2026-11-01 observation (independent remaining counters for keys 1..5) is consistent with 5 organisations, but was not re-verified (no live calls). |
| Billing / free status | **Unknown for every key.** The `.env` declares itself **production**. |

## 2. Built → [AQUA_EVALUATION_PROVIDER_MANAGER.md](AQUA_EVALUATION_PROVIDER_MANAGER.md)

`aqua/eval/providers/`:
- `credentials.mjs`
- `errorTaxonomy.mjs`
- `evalConfig.mjs`
- `providerManager.mjs`
- `pairRunner.mjs`
- `transports.mjs`
- `evalConfig.example.json` (refused as written)

**Key properties:**
- **Rotation follows the quota scope.** Unverified keys form **one** domain per provider. Quota exhaustion pauses the **domain** (no rotation through 12 Gemini or 5 Groq keys sharing it). Only independent, **verified** domains are alternatives, and only for the **same model**.
- **Separate health and categories** for invalid, expired, restricted, temporary 429 (Retry-After honoured), domain quota exhaustion, billing (stop), oversize request, network (bounded retry) and unknown (stop for review).
- **Zero-cost preflight.** It refuses unless:
  - the configuration is explicitly evaluation-only;
  - production credentials are explicitly allowed;
  - each domain used has `free-tier-verified` billing **with evidence (who, when)**;
  - requests carry an allow-listed **synthetic** dataset.

  A valid key never implies free quota. There is no paid fallback.
- **A/B pairs.** The model is locked per pair; completed answers and judgements are persisted, and never repeated. Answering pauses at quota exhaustion and resumes. Judging is queued when the judge provider is exhausted. Judge identity is recorded.
- **Observability.** Variable names, a hashed domain, tokens, categories, retries and cooldowns. Never values.

## 3. Tests → [AQUA_ZERO_COST_QUOTA_FALLBACK_TESTS.md](AQUA_ZERO_COST_QUOTA_FALLBACK_TESTS.md)

| Command (from `aqua/`) | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/evalProviderManager.test.js` | **33/33 pass.** All providers mocked; global fetch tripwire: **0** network requests. |
| 4 bite checks (shared-quota rotation, paid fallback, secret leak, unknown billing) | Each caught: **6 / 1 / 1 / 2** tests fail; files restored and hash-verified |
| `node scripts/run-tests.mjs eval/tests src/providers` | 537 pass, 0 fail, 11 skipped |

## 4. Verified vs not verified

| Verified | Not verified (needs console access or an approved live check) |
|---|---|
| Variable names and shape categories; no duplicates or blanks | Which Google project each Gemini credential belongs to |
| Authentication method and the absence of a refresh mechanism (source) | What the `AQ.` values are, and whether they still authenticate |
| The production rotation is per-key, not per-domain (source) | Groq organisation membership today |
| Manager behaviour under every required failure (mock tests) | Billing / free-tier status of any project or organisation |
| | Real error bodies and headers; the live transports' request formats |

## 5. Decisions required (founder)

1. **Credentials for evaluation:**
   - **option A:** create **evaluation-only** keys in verified free-tier projects/organisations (`credentialSource: 'evaluation'`) — recommended;
   - **option B:** approve the production keys explicitly (`allowProductionCredentials: true`).
2. **Verify in the provider consoles** and record in the evaluation config:
   - each Gemini key's project;
   - each Groq key's organisation;
   - for each, that no billing account or paid plan is attached (who, when).

   Until then the manager **refuses to run** — by design.
3. **Clarify the `AQ.` Gemini values** (who issued them, and their kind), and reconcile the `.env` comments. Remove the token fragment that appears in a comment.
4. **Approve** wiring the manager into `answer-eval` / `answer-judge`, and a one-case smoke run with `AQUA_EVAL_LIVE_APPROVED=yes` once items 1–2 are done.
5. **Production rotation:** consider making `keyPool.cjs` quota-domain aware. This was **not** changed here (out of scope: "do not modify production provider rotation").

## 6. Files

**New (all untracked):**

| Area | Files |
|---|---|
| Manager | `aqua/eval/providers/credentials.mjs`, `errorTaxonomy.mjs`, `evalConfig.mjs`, `providerManager.mjs`, `pairRunner.mjs`, `transports.mjs`, `evalConfig.example.json` |
| Tests | `aqua/eval/tests/evalProviderManager.test.js` |
| Documents | the four deliverables |

**Modified:** none.
