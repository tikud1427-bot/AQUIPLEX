# Sprint 5 — Shadow Readiness Review (`AQUA_INFO_NEEDS`)

**Date:** 2026-11-11 · `main` @ `839ea0d1` · Nothing enabled, nothing changed on Render.

This reviews the Sprint 4 shadow implementation and [AQUA_RENDER_SHADOW_READINESS.md](AQUA_RENDER_SHADOW_READINESS.md) from **source and tests**.

## 1. Verified from source

| Requirement | Source evidence | Verdict |
|---|---|---|
| **`off` / `shadow` / `on` correctly separated** | `informationNeeds.infoNeedsMode()` maps the value to exactly `on`, `shadow` or `off`; anything else is `off`. `chat.js:668`: the engine runs only when the mode is not `off` (and an owner exists, it is not a self-identity question and not an interview turn). `chat.js:683`: `needsOwnsContext = needsMode === 'on' && applied === true`. That flag is the **only** thing that changes the memory block (`:684`), skips the broad lanes (`:701`) and replaces recall (`:811`). Under `shadow` it is always false. | ✅ |
| **Shadow cannot change the prompt or answer** | In shadow, the engine's result is used only for the `[NEEDS]` log line and `prep.infoNeeds` (`:907`). `prep.infoNeeds` is **not** part of the HTTP response: `buildResponsePayload` reads `memoryOwner`, `readState`, `mind`, `knowledgeItems`, `systemPrompt` and `recall.excerpts`, all computed exactly as under `off`. | ✅ |
| **No additional model or embedding calls** | The engine imports `questionShape`, `queryPlan`, `stateTransition`, `episodicRecall` (`collectUnits`, `forgetClean`, `withholdClean`, `recallRedaction`, `formatRecall`), `recallRedactions`, `retrievalPrivacy`, `longTermMemory.getFacts` and `memoryExtractor.detectForget`. The only embedding trigger in `episodicRecall` (`indexRecallUnits`, line 689) is inside `recallForTurn`, **which the engine does not call**. No provider, `fetch` or embedding code is reachable from the engine. | ✅ |
| **Raw content cannot enter shadow logs** | **The engine itself contains no `console.*` calls.** The route logs exactly two lines. The success line (`chat.js:676`) interpolates only `needsMode`, booleans, `reason`, intent label, integer counts, sufficiency label, `ms`, `shortHash(owner)` and `requestId`. The failure line (`:679`) interpolates only `err.name`, not `err.message`. | ✅ |
| **Account identifiers not logged** | `owner=#${shortHash(memoryOwner)}`: a per-process HMAC-SHA256, truncated to 8 hex characters (`core/logSafety.js:35`). | ✅ (with the caveat below) |
| **Errors fall back to the existing pipeline** | `try { … } catch { infoNeeds = null; }`, so `needsOwnsContext` is false and the turn takes the `off` path. Failures are counted by `noteFeature('AQUA_INFO_NEEDS','failed', err.name)`. | ✅ |
| **Failed turns leave no memory residue** | The engine is read-only. The Sprint 1 commit boundary (`turnCommit.js`, `persistUserTurn`, `rollbackTurnMemory` in `finally`) is unchanged by shadow. | ✅ |
| **User isolation** | `collectUnits({ userId })` filters conversations by `meta.userId`. `getFacts(ownerId)` and `redactionsFor(ownerId)` are owner-scoped. | ✅ |

**Caveats:**
- **The success line also carries `req=<requestId>`.** That was already logged across the route before Sprint 4, and is a request id, not an account id.
- **The HMAC key is per process.** Hashes are not stable across restarts or across Render instances. Within-deploy correlation only; by design, this is not cross-deploy user tracking.
- **The success line runs after a successful analysis only.** Turns that skip the engine (no owner, self-identity, interview) produce no line, so the shadow sample excludes them.

## 2. Verified by tests (current tree)

| Command (from `aqua/`) | Result |
|---|---|
| `node scripts/run-tests.mjs src/routes` (includes `infoNeedsShadowReadiness.test.js`, 6 tests; `informationNeedsRoute.test.js`, 7; `logPrivacy.test.js`; Sprint 1 failed-turn tests) | **335/335 pass** |
| `node scripts/run-tests.mjs src/brain/tests/informationNeeds.test.js src/brain/tests/informationNeedsV2.test.js eval/tests/answerGrader.test.js` | **48/48 pass** |
| **New this sprint (scratch, not added to the repo):** `node --test …/scratchpad/s5/shadowFail.test.mjs`. Under `shadow`, the provider fails on `/chat` and `/chat/stream`; the user then has no facts, no goals and no persisted user message. | **2/2 pass** |

What the shadow tests prove:

| # | What it proves |
|---|---|
| 1 | Byte-identical prompts between `off` and `shadow` on both endpoints (only the fence's random nonce is normalised), and the same number of provider calls |
| 2 | A strict pattern for the whole `[NEEDS]` line; no history words, names, figures or account id |
| 3 | An engine exception under `shadow` and `on` gives the same prompt as `off`, and the failure log carries no message text |
| 4 | Isolation |
| 5 | Latency budget |
| 6 | Read-only: the data directory hashes are unchanged |

A bite check in Sprint 4 confirmed test 1 fails when shadow alters the prompt.

## 3. Cannot be verified without a real deployment

| Item | Why |
|---|---|
| Render's Node version, environment variables, instance count, disk persistence | Not inspected; no Render access was used. |
| Engine latency on real history sizes | Only synthetic histories were measured (mean 3.4 ms, p95 6.8 ms on ACIB). The engine re-reads the user's whole history (`collectUnits`) on every eligible turn. Whole-history recall already does the same read, so shadow roughly **doubles** that read. |
| Log transport and retention | Whether Render's log pipeline or any drain stores lines longer, or forwards them elsewhere. |
| Whether `/api/aqua/provider-health` is authenticated in production | **From source:** behind `requireLogin`, because `/api/aqua` is mounted with `aquaAccess` (`index.js:665–692`). So a signed-in session is needed to read it. That production runs this source was not verified. It exposes `features` (states and counts, no content). |
| Behaviour with the Mongo mirror active | Tests run with the mirror disabled. The engine is read-only, but the mirror's interaction with the stores the engine reads was not tested live. |
| Real traffic distribution | Intent mix, `no-evidence` rate and sufficiency mix: these are what shadow is for. |

## 4. Deployment checklist

**Pre-deploy (requires founder approval):**
- [ ] Decide the release unit. Shadow needs the engine and the route wiring (Sprint 3 + 4), which ship with Sprint 1 changes in `chat.js`. Capture Integrity can ship before or with it ([capture review](AQUIPLEX_SPRINT5_CAPTURE_RELEASE_REVIEW.md)).
- [ ] Commits reviewed; battery green on exactly the commit set to be deployed (`node scripts/run-tests.mjs`, known `repoHygiene` exception noted); `node eval/gate.mjs` reviewed. It is currently BLOCKED, with explained movements (Sprint 4 report §4).
- [ ] Record the current production commit SHA as the rollback target.
- [ ] Confirm `AQUA_INFO_NEEDS` is **absent or `off`** on Render before deploying.

**Deploy with the flag off:**
- [ ] Deploy. Confirm `GET /api/aqua/provider-health` shows `AQUA_INFO_NEEDS` `value: off`, `state: off`.
- [ ] Watch error rate and latency for at least 1 hour, as for any deploy (capture changes, if included, take effect now).

**Enable shadow:**
- [ ] Set `AQUA_INFO_NEEDS=shadow` in the Render environment and save (the service restarts).
- [ ] Health shows `value: shadow`, then `state: active` after real turns; `observed.failures = 0`.
- [ ] Logs contain `[NEEDS] mode=shadow …` lines. Spot-check 10: only counts and labels, `owner=#<8 hex>`.
- [ ] Observe for 7 days. Record from logs: `applied` rate; `reason` distribution (especially `no-evidence`); intent and sufficiency mix; `ms` p50/p95/max; failure count.

**Abort immediately (set `off`) if:**
- any `[NEEDS]` line contains user text;
- failures exceed 0.1% of analysed turns;
- `ms` p95 is above 50 or max above 500;
- service p95 latency or error rate moves attributably.

## 5. Rollback procedure

| Situation | Action | Data impact |
|---|---|---|
| Shadow misbehaves | Delete `AQUA_INFO_NEEDS` or set it to `off`; save; the service restarts. | None: shadow writes nothing. |
| The deploy itself misbehaves | Redeploy the recorded previous commit from the Render dashboard (Events → previous deploy → Rollback). | Capture changes, if deployed, stop. Facts stored while they were live stay stored (they follow the new rules); nothing is reverted automatically. |
| A log line leaked content (should be impossible) | Set `off`. Request log deletion through Render support for the affected window. Treat it as a privacy incident. | Logs only. |

## 6. Findings from this review

1. **No defects found** in the shadow path. One gap was closed: failed-turn residue under shadow, now covered by the scratch test above. Recommendation: add that test to the repository with the release.
2. **Clarification on doubled reads:** `AQUA_RENDER_SHADOW_READINESS.md` says the history read matches existing recall. It is an **additional** read, not a shared one. Watch `ms` and service latency.
