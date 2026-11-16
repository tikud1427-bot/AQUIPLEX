# AQUA Evaluation Key Pool — Audit

**Date:** 2026-11-11 · `main` @ `839ea0d1`

**Method.** Source inspection, plus a read of `.env` through a script that printed only variable **names** and a non-revealing **shape category** per value. That script reused the repository's own `aqua/scripts/provider-keys-doctor.mjs` `offlineReport`.

- **No credential value, prefix, suffix, length or hash** appears in this document, any other file, or any log.
- **No live API call was made.** Statements about live behaviour are labelled as historical, with their dates.

## 1. What is configured (names and shapes only)

| Variable | Shape category |
|---|---|
| `GEMINI_API_KEY` | standard Google AI Studio API-key format |
| `GEMINI_KEY_1` … `GEMINI_KEY_12` (12) | **`AQ.`-prefixed — not the documented API-key format** |
| `GROQ_API_KEY` | standard Groq API-key format |
| `GROQ_API_KEY_1` … `GROQ_API_KEY_5` (5) | standard Groq API-key format |

- Gemini: 13 distinct values; Groq: 6 distinct values. No duplicates, no blanks.
- **The file is labelled "AQUIPLEX — production env"** (its first comment), so **these are production credentials.**
- `.env` is git-ignored and untracked.

## 2. Findings

| # | Question | Finding | Basis |
|---|---|---|---|
| 1 | How are Gemini credentials authenticated? | The adapter passes each value as `apiKey` to the `@google/genai` SDK: `new GoogleGenAI({ apiKey })` in `src/providers/gemini.js`. There is no OAuth flow or `Authorization: Bearer` path. | Source |
| 2 | Are the numbered Gemini entries API keys or short-lived tokens? | **Undetermined.** They are not in the documented `AIza…` API-key format. The `.env` comments call such `AQ.` values "ephemeral tokens (~30 min life), not API keys", and say `KEY_1` holds the standard key and the `AQ.` values are *commented out*. **The active values contradict that comment:** all 12 active `GEMINI_KEY_n` are `AQ.`-prefixed. Historical probes (2026-10-15, 2026-11-01) recorded all 12 authenticating on both dates, 17 days apart, which is **inconsistent with a 30-minute lifetime**. Their nature cannot be settled offline; the manager treats them as non-standard and unusable unless explicitly opted in. | `.env` names/comments; memory of past probes |
| 3 | Does any refresh mechanism exist? | **No.** No code obtains, refreshes or exchanges tokens for Gemini; values are used as given. If they are short-lived tokens, they silently stop working when they expire. The production pool marks such a key `rejected` (sticky) on 401/403. | Source (`gemini.js`, `keyPool.cjs`) |
| 4 | How are Groq credentials loaded? | `GROQ_API_KEY_<n>` (numbered, sorted numerically) plus `GROQ_API_KEY` (bare), via `keyPool.cjs` `discoverKeySlots`. Each is passed as `apiKey` to the `groq-sdk` client with `maxRetries: 0`. | Source |
| 5 | Does key rotation already exist? | **Yes, in production.** `src/providers/keyPool.cjs` + `keyRotation.js`: round-robin over the slots. A 429 cools **that key** (or key×model) and moves to the next key. 401/403 → the key is rejected (sticky). 402/billing → rejected with a TTL. **It has no notion of a project or organisation:** on a project-level 429 it would try every key of the same project in turn. | Source |
| 6 | How are provider and quota errors classified? | `src/providers/providerErrors.js` `classifyProviderError`: `rate_limit` (429, "quota", "resource_exhausted"), `auth` (401/403, Google 400 `API_KEY_INVALID`), `billing` (402, or out-of-credits wording). `keyPool.cjs` `classifyKeyFailure` adds per-key `auth`/`billing`/`rate_limit`. **Per-minute throttling is not distinguished from daily or project exhaustion.** A Groq 413 "request too large" carries the code `rate_limit_exceeded` and would be read as a rate limit (observed 2026-11-01). | Source; memory |
| 7 | Do the keys belong to different projects or organisations? | **Gemini: unknown.** An API key does not encode its project, and determining it needs the Google console or a live call, neither of which was used. **Groq: historically suggested, not verified now.** On 2026-11-01, one small request per key returned independent remaining-request counters for `GROQ_API_KEY_1..5`, which is consistent with 5 separate organisations. That is 10 days old and was not re-checked; the bare `GROQ_API_KEY` returned 401 on 2026-10-15. | Memory of past probes; no live call today |
| 8 | Billing status / free-tier eligibility | **Unknown for every key.** Nothing in the repository records whether a billing account is attached to any Google project or Groq organisation. Every model in `modelRegistry.js` is marked `costTier: 'free'`, but that is a routing label, not evidence. | Source |

## 3. Official quota scope (as provided in the brief)

- **Gemini:** rate limits are per Google Cloud project, so all keys of one project share one quota.
- **Groq:** rate limits are per organisation, so all keys of one organisation share one quota.

**Consequence.** More keys in one project or organisation add **no** quota. Rotating through them after a quota error only multiplies failing requests. The production rotation (finding 5) does exactly that, so it is not suitable for evaluation.

## 4. Other observations (low risk, reported)

- **A `.env` comment contains a short fragment of a former Gemini token**, and an existing test (`aqua/src/core/tests/envDoctor.test.js`) contains a similar fragment as a fixture. These are short and partial, but recommend removing them from the comment (and confirming the test fixture is synthetic). The fragment is not reproduced here.
- **The `.env` header and comments are out of date** relative to its active values (finding 2). Recommend the owner reconcile them.
- **The production `[RECALL]` log line prints the raw owner id** (Sprint 6 finding, unrelated to keys; still open).

## 5. What would make the unknowns known (each needs the owner's approval or console access)

| Unknown | How to establish it, without exposing values |
|---|---|
| Gemini project per key | The Google AI Studio "API keys" page lists each key under its project. Record env var name → project id in the evaluation config (`domains[].verification`). |
| What the `AQ.` values are | The issuing console; or ask the person who created them |
| Groq organisation per key | The Groq console (Settings → Organisation) for each key's account; or an **approved** one-request probe comparing rate-limit headers |
| Billing / free tier | Google Cloud console → Billing for each project; Groq console → Billing / plan for each organisation. **Record who checked and when** (`domains[].billingEvidence`). |
