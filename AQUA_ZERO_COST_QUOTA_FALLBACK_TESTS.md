# Zero-Cost Quota & Fallback Tests

**Date:** 2026-11-11

**File:** `aqua/eval/tests/evalProviderManager.test.js`. **33 tests, 33 pass.**

- **All providers are mocked** (`mockTransport`). Clock and sleep are fake.
- **Network tripwire.** `globalThis.fetch` is replaced for the whole file, and an `after` hook asserts it was called **0** times.
- **Leak marker.** Every synthetic credential value contains the marker `SECRET`, so any surface leaking a credential is detectable.

```
cd aqua && node scripts/run-tests.mjs eval/tests/evalProviderManager.test.js
ℹ tests 33 · ℹ pass 33 · ℹ fail 0
```

## Coverage (brief §7 → tests)

| Required | Test(s) | Asserts |
|---|---|---|
| **Key rotation** | invalid credential → another key in the same domain | 2 calls on different variable names; the first key is marked `invalid` |
| **Shared project quota exhaustion** | shared Gemini PROJECT quota exhausted | **1 request** (not 13), the domain `paused`, `QuotaPaused` |
| **Shared organisation quota exhaustion** | shared Groq ORGANISATION quota exhausted (RPD body with an upgrade link) | **1 request** (not 6), `QuotaPaused` |
| **Independent quota-domain fallback** | independent VERIFIED domains | Org 1 tried once (its second key shares the quota), then org 2 serves, **same model** |
| (no false independence) | an unverified domain declaration does not create independence; keys without a verified grouping share ONE domain | One Groq domain; `unverified:gemini` holds 13 and `unverified:groq` 6 |
| **Invalid credentials** | inventory exclusions + invalid credential rotation | Blank, placeholder, whitespace, duplicate and wrong-provider keys excluded |
| **Expired authorization tokens** | expired authorization token | Key marked `expired`; another key serves |
| (key restriction) | key-specific restriction | Key marked `restricted`; another key serves |
| **Retry-After handling** | short Retry-After; long Retry-After | Waits exactly 2,000 ms then succeeds; a 120 s Retry-After with no other domain → `QuotaPaused` with `resumeAt = now + 120,000` |
| **Resume after quota reset** | resume after the quota resets | While paused, **no request is sent**; after the reset the same domain serves |
| **No paid fallback** | billing → STOP; zero free-tier limit → billing; Groq upgrade text → not billing | 402 → `BillingStop` with 1 call, even with a second free domain and another provider available; later requests refused |
| (zero-cost preflight) | 7 preflight tests | Refused without: evaluation-only; production opt-in; known free-tier billing ("a valid key is not proof of free quota"); billing evidence; a non-paid domain; synthetic datasets; non-standard opt-in |
| (synthetic data only) | a non-synthetic dataset is refused | `DataRefused`, **0** transport calls |
| (live path) | the live transport refuses without approval | `LiveTransportRefused` |
| (failure classes) | unknown → review; network bounded; 413 not quota | `ReviewRequired` stops later requests; 2 retries max; a 413 is `RequestRejected` after 1 call |
| **No secret leakage** | credential object never reveals its value; events/state/summary/domains/exclusions/errors | `JSON.stringify` and `util.inspect` of every surface contain no `SECRET`; events have exactly the allow-listed fields; the domain is a 12-hex hash |
| **A/B model consistency** | same model and settings; a pair started with one model is never finished with another | All 6 answer calls: the same model and settings. Resume under a different model → `model-mismatch`, **0** calls. |
| **No duplicate completed requests** | re-run sends nothing; mid-pair pause then resume | A second run makes **0** calls (12 skipped). After a mid-pair pause, arm A is **not** regenerated. |
| (judge queue) | judge provider exhausted | Answering completes (6). Pairs are queued for judging; the exhausted judge project is asked **once**. |

## Bite checks

Each mutation was applied, the suite run, and the files restored. The sha256 was verified afterwards.

| Mutation | Result |
|---|---|
| 1. A quota exhaustion marks the **key** invalid instead of pausing the **domain** (i.e. rotation through a shared quota) | **6 tests fail**, including the shared project, shared organisation and independent-domain tests |
| 2. A billing error rotates to another key instead of stopping | **1 fails** (no paid fallback) |
| 3. A credential value is added to the events | **1 fails** (no secret leakage) |
| 4. The preflight's verified-free-tier check is removed | **2 fail** (unknown billing; free-tier claim without evidence) |

## Other suites (unchanged code, re-run)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests src/providers` | 548 tests: **537 pass, 0 fail**, 11 skipped |

## Not tested (and why)

- **Real provider behaviour.** No live calls were allowed: error bodies, header names and request formats follow public documentation and past observations.
- **The live transports' request and response mapping.** `liveTransport` is only tested for refusing to construct.
