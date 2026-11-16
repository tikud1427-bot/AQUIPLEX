# AQUA — Existing Numbered Key Pools for Evaluation

**Founder decision (2026-11-11):** use the existing numbered credentials; do not create new keys.

**Status:** integrated in the evaluation-only provider manager; mocked tests only. **No live request.**

## 1. What the existing pools provide (offline check of the real `.env`; names only)

| Pool | Variables | Usable for evaluation | Why |
|---|---|---|---|
| Gemini | `GEMINI_KEY_1` … `GEMINI_KEY_12` | **None (0 of 12)** | All 12 values are `AQ.`-prefixed, not verified standard API keys, so **excluded** (requirement 5) |
| Groq | `GROQ_API_KEY_1` … `GROQ_API_KEY_5` | **5**, as **one** unverified quota group | All 5 have the standard Groq key format; organisation grouping is not verified, so they are treated as one shared quota (requirements 7–8) |
| Unnumbered | `GEMINI_API_KEY`, `GROQ_API_KEY` | **Never** | Excluded by design (requirement 4) |

**Consequences of the decision**, to be confirmed by the founder:

1. **No Gemini judge is possible** with these pools. The judge must be a **different Groq model**, sharing the same Groq quota group as the answering model. The gate still refuses judge = answering model. A different model *family* on Groq is preferable for judge independence; availability must be confirmed in the Groq console.
2. **Evaluation shares quota with production.** `GROQ_API_KEY_1..5` serve production traffic through `keyPool.cjs`, so every evaluation request consumes the same daily Groq quota. A **mandatory per-run request budget** caps this (§3).
3. **Free tier is still mandatory.** The run is refused until the Groq billing check is recorded (`billing: "free-tier-verified"` with evidence). The offline check confirms that the real configuration is refused today for exactly this reason.

## 2. Investigation of the `AQ.` values (no use attempted)

Structure only: no value, prefix beyond `AQ.`, exact length or hash is reported.

| Property | Finding |
|---|---|
| Prefix | `AQ.` on all 12 |
| Segments (split on `.`) | 2 (the `AQ` marker and one opaque segment) |
| Length | 40–79 characters (bucket) |
| Characters | Base64url-style: letters, digits, `-`, `_` |
| Compared with known shapes | Not a Google API key (`AIza` + 35, 39 in total, one segment); not an OAuth access token (`ya29.`); not a JWT (three segments) |
| History (memory, not re-checked) | Authenticated on 2026-10-15 and 2026-11-01. The `.env` comment (now corrected) had called them ~30-minute tokens, which is inconsistent with working 17 days apart. |
| Conclusion | **Kind undetermined offline.** Excluded. To include them, the founder would need to establish in Google AI Studio / Cloud Console what they are and which project they belong to, and then decide. Even then, the gate refuses any non-standard credential, by design of the zero-budget integration. |

## 3. Changes

**`aqua/eval/providers/evalConfig.mjs`:**
- `numberedOnly` (implied by the mode): unnumbered slots are excluded (`unnumbered-excluded`).
- The preflight accepts `credentialSource: 'production'` **only** with all of:
  - `credentialMode: 'existing-numbered-pools'`;
  - `founderDecision { by, at, statement }`;
  - a positive integer `requestBudget[provider]` for every provider used.

**`aqua/eval/providers/providerManager.mjs`:**
- Per-run request budget: every transport attempt counts, retries included.
- At the cap, `QuotaPaused` with reason `run-request-budget`. The pair runner pauses (resumable), never another route.

**`aqua/eval/answer/evalRun.mjs`:**
- `numberedPoolEnv(text)` keeps **only** `GEMINI_KEY_<n>` and `GROQ_API_KEY_<n>` from the `.env` text. Unnumbered keys, database URLs and other secrets never reach the manager.
- In this mode, `liveSetup` reads the repository `.env` **in memory** (no copy, nothing written) and refuses a separate `--credentials-env`. The path is injectable for tests; tests never read the real file.
- The gate requires the mode's fields; outside the mode, production sources stay refused as before.

**Test update:** `aqua/eval/tests/evalProviderManager.test.js`. The generic config factory now declares evaluation credentials, because production sources are tested explicitly elsewhere. The production-opt-in test sets `credentialSource: 'production'` explicitly.

**Not changed:**
- **`aqua/src/providers/*`** (production rotation and request behaviour): `git diff HEAD` is empty, and 199/199 production provider tests pass.
- **`.env`**: read only in memory, for the offline check.

## 4. Unchanged guarantees (re-verified by tests)

- Quota groups: unverified keys form one group per provider. **Shared exhaustion pauses after one request**, with no rotation through the other keys.
- An individual invalid, expired or restricted key is skipped. **There is never an unnumbered fallback.**
- Billing / paid tier → stop. Unknown billing → refused before any request. There is no paid route.
- The approval switches stay additional requirements only (readiness audit tests still pass).
- A/B: one answering model and settings for both arms; resume never repeats completed work; judge exhaustion queues pairs.
- No credential value appears in logs, records, tests or reports.

## 5. Grouping verification (requirement 6)

| Provider | Offline status | How to verify (console; no API calls) |
|---|---|---|
| Groq | **Unverified.** On 2026-11-01 the five keys showed independent remaining-request counters (consistent with separate organisations), but that is not a verification. They are treated as **one** group, which is conservative: it can only pause earlier, never spend more. | For each key, find the organisation whose **API Keys** page lists it (organisation switcher → Settings → Organization for the ID). Record one domain per verified organisation. |
| Gemini | Not applicable: no usable key | — |
