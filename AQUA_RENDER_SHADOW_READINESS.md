# AQUA Render Shadow Readiness — `AQUA_INFO_NEEDS=shadow`

**Sprint 4, 2026-11-11.** Nothing was changed on Render: no deploy, no environment change. This document is the checklist and the exact procedure for a **separately authorised** shadow rollout.

## 1. What shadow does

On each eligible chat turn (an owner exists, not a self-identity question, not an interview turn), the route computes the information-needs analysis and logs **one** `[NEEDS]` line of counts. The prompt, the model calls and the answer are those of `off`. Turns are handled by both `/chat` and `/chat/stream` (`routes/chat.js`, step 5c¹).

## 2. Readiness checklist (verified locally, real chat route, fake provider)

Tests: `aqua/src/routes/tests/infoNeedsShadowReadiness.test.js`, 6 tests, **6/6 pass**. A bite check made shadow alter the prompt; the suite then failed, and the file was restored byte-identically.

| # | Requirement | Evidence | Status |
|---|---|---|---|
| 1 | Does not alter the answer | The test compares every system prompt sent to the provider under `off` and under `shadow`, on both endpoints, for identical histories. They are **byte-identical**. The only normalisation is the fence's per-request random nonce, a security feature that differs on every turn. | ✅ |
| 2 | No extra model calls | Same number of provider calls under `off` and `shadow`, on both endpoints. The engine is deterministic: no model, embeddings or network. | ✅ |
| 3 | No raw content in logs | The whole `[NEEDS]` line is checked against a strict pattern: counts, intent, sufficiency, `ms`, `owner=#<8 hex>`, `req`. It is also checked against the history's names, figures and words, and the account id. | ✅ |
| 3a | Owner is not identifiable | **Changed in Sprint 4:** the line printed `owner=user:<account id>`. It now prints a per-process HMAC (`core/logSafety.shortHash`). That is stable within one deploy for correlating lines, and not reversible. | ✅ |
| 4 | Safe fallback on failure | The engine is made to throw (test seam `__failNextForTests`). In `shadow` and `on`, the turn is served with the **same prompt as `off`**. One `[NEEDS] failed … <ErrorName>` line is logged, without the message text. `/health` shows `features.AQUA_INFO_NEEDS.state = failing` with `lastErrorCode` (the error name). | ✅ |
| 5 | User isolation | The engine reads only the asking user's conversations (`episodicRecall.collectUnits`, `meta.userId`-scoped) and facts (`ownerId`). A test seeds two users with conflicting data, and neither sees the other. A user with no history gets nothing. The Sprint 3 `on` isolation test also passes. | ✅ |
| 6 | Acceptable latency | **Engine time:** mean 3.4 ms, p95 6.8 ms over 200 ACIB v2 eval cases. The median is under 100 ms on a test history of 60+ messages (test budget). Every `[NEEDS]` line carries `ms`. **Note:** V2 reads the user's history on every eligible turn, impersonal ones included (needed for anchoring). Existing whole-history recall does the same read. | ✅ (measured locally; production users with very long histories not measured) |
| 7 | Production pipeline unchanged | With `shadow`, nothing the model receives changes (item 1). The engine is **read-only**: a test hashes every file in the data directory before and after four analyses, and nothing changes. Memory writes, commit safety (Sprint 1 rollback) and billing are untouched. | ✅ |
| 8 | Metrics only, no PII | Item 3. `/health` adds only state, counts, timestamps and the error name. | ✅ |

## 3. Not covered by "shadow"

- **The capture fixes are NOT behind the gate.** Deploying this code changes memory capture for every user, whatever `AQUA_INFO_NEEDS` is set to. See [AQUA_CAPTURE_INTEGRITY_V1.md](AQUA_CAPTURE_INTEGRITY_V1.md). Review them, and ideally commit them, separately.
- **Production configuration is not verified.** These checks ran locally. Render's actual environment, Node version and data volume were not inspected, and nothing here claims them.
- **Memory store size in production is unknown.** Latency on the largest real histories is the main open risk. The `ms` field in `[NEEDS]` measures it.

## 4. Exact procedure (requires explicit authorisation at each numbered gate)

**Gate 0 — code review and deploy (not done; needs approval).**
1. Review and commit the Sprint 1–4 work in reviewable units: capture integrity separately from the engine.
2. Push, and let Render deploy it.
3. Record the deployed commit SHA from the Render dashboard (Events → the deploy).
4. Before changing any variable, confirm the deploy is healthy:
   - `GET https://<service>/api/aqua/provider-health` → `features` lists `AQUA_INFO_NEEDS` with `value: "off"`, `state: "off"`.

**Gate 1 — enable shadow.**
1. Render dashboard → the AQUIPLEX web service → **Environment** → **Add Environment Variable**: key `AQUA_INFO_NEEDS`, value `shadow`.
2. Save. Render restarts the service with the new value.
3. Verify within 10 minutes:
   - The startup log line `[FLAGS] effective …` is present, and the service is serving.
   - `GET /api/aqua/provider-health` shows `AQUA_INFO_NEEDS` `value: "shadow"`, `state: "enabled"`. After the first real chat turn it shows `state: "active"` with `observed.runs > 0`.
   - Logs (Render → Logs, search `[NEEDS]`) show lines of the form `[NEEDS] mode=shadow applied=… reason=… intent=… … ms=… owner=#xxxxxxxx req=…`.
   - Spot-check five lines: they hold no words, names or figures, and `owner` is `#` plus 8 hex characters.

**Gate 2 — observe for 7 days.** Collect from the `[NEEDS]` lines:

| Measure | From | Why |
|---|---|---|
| Turns analysed; `applied=true` rate | `applied` | How often V2 would own the context |
| `applied=false` reasons | `reason` (see §5) | The `no-evidence` rate is the lexical-miss class |
| Intent distribution | `intent` | Real question mix vs ACIB |
| Sufficiency distribution | `sufficiency` | How often it would ask a clarifying question (`insufficient`) |
| Engine `ms` p50 / p95 / max | `ms` | Latency on real history sizes |
| Failures | `[NEEDS] failed`, `/health` `observed.failures` | Robustness |

**Abort criteria.** Set `AQUA_INFO_NEEDS=off` immediately if any of these occurs:
- any `[NEEDS] failed` rate above 0.1% of turns;
- p95 `ms` above 50, or any value above 500;
- any `[NEEDS]` line containing user text;
- any change in answer latency or error rate on the service's normal dashboards attributable to the deploy.

**Rollback.** Delete the variable, or set it to `off`, and save; Render restarts. Shadow writes nothing, so there is nothing to undo. Capture-integrity changes are rolled back only by redeploying the previous commit.

**Gate 3 — `on` for a cohort (not recommended yet).** The ACIB v2 eval set shows V2 below the existing pipeline on short histories (88 vs 95 correct). `on` is justified only after:
- the shadow data;
- an improved engine measured on a new frozen set;
- the answer-level evaluation ([AQUA_ANSWER_QUALITY_EVALUATION.md](AQUA_ANSWER_QUALITY_EVALUATION.md)).

The code has no cohort selector today (the gate is global). A cohort rollout needs a small, reviewed change to the gate.

## 5. Log field added for shadow

The `[NEEDS]` line carries `reason=` (`-` when applied; `no-evidence` / `no-requirements` when not). It is content-free (asserted by test 3) and makes the lexical-miss fallback rate measurable in shadow.
