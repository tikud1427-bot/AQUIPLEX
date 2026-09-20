# BATCH 1 — E9 Reflection V3: root→aqua convergence

Runtime = `aqua/` (mounted by `index.js` via `import("./aqua/router.js")`). Root `src/` confirmed still a live-edited second tree, not just stale bloat — see finding below. Blueprint's own rule applies: LIVE CODE > prior audit docs. This supersedes `AQUIPLEX_LATEST_AUDIT_2026-09-13.md` and the "on the horizon" notes from last session.

## Objective
Port E9 Reflection V3 pipeline (built only in root `src/`) into `aqua/` (the runtime tree), so it stops existing only in code the platform never executes.

## Critical finding — tree divergence is WORSE than the Sep-13 audit knew
Both trees have kept moving, in different directions, since Sep 13:

| Subsystem | Only in `aqua/` | Only in `src/` (root) |
|---|---|---|
| E8 Context Engine | `e8Pipeline.js`, `e8IntegrationGate.test.js`, `e8Pipeline.test.js` (PR9-11 gate, `taskType` wiring fix) | — |
| E9 Reflection V3 | `contradictionPolicy.js` (PR-1 only) | `claimBeliefAdapter.js`, `reflectionDelta.js`, `reflectionGate.js`, `reflectionIdempotency.js`, `reflectionLifecycleIntegration.js`, `reflectionOutbox.js`, `reflectionReconciliation.js`, `reflectionRecovery.js`, `reflectionWorker.js` (PR2-10) |
| Durable worker | stub — `HANDLERS = Object.create(null)`, deliberately empty pending "PR-5/6" | `'understanding.turn.v1'` + `'claim.reflection.v1'` handlers wired, outbox dispatch loop wired |
| Eval suites | — | `reflection-lifecycle.suite.mjs`, `reflection-lifecycle-integration.suite.mjs` |
| 51 files total differ or are exclusive between the trees (`diff -rq src aqua/src`) |

Root's E9 PR-1 (`contradictionPolicy.js`, decision policy) and root's PR2-10 (lifecycle/durability plumbing) don't reference each other either — `reflectionLifecycleIntegration.js` doesn't import `contradictionPolicy`. So even a same-tree merge doesn't fully close E9; the policy and the plumbing were built as separate seams.

Do not keep developing both trees. Every batch from here should land in `aqua/` only until root `src/` is retired.

## Files inspected
`src/brain/reflectionV3/*`, `aqua/src/brain/reflectionV3/*`, `scripts/worker.mjs` (both trees), `eval/suites/reflection-lifecycle*.mjs`, dependency surface: `mind/beliefEngine.js`, `mind/mindStore.js`, `core/mind/beliefClaimRepository.js`, `core/db/pool.js`, `core/jobs/jobQueue.js`, `core/claims/claimRepository.js` — confirmed identical exported function signatures in both trees, so the port needed no code changes, only file placement.

## Files changed (this delivery — paths relative to repo root)

**NEW** — copied verbatim from root `src/brain/reflectionV3/`, no edits needed (dependency check passed):
- `aqua/src/brain/reflectionV3/claimBeliefAdapter.js` (+ `.test.js`, `.lifecycle.test.js`)
- `aqua/src/brain/reflectionV3/reflectionDelta.js` (+ `.test.js`)
- `aqua/src/brain/reflectionV3/reflectionGate.js` (+ `.test.js`)
- `aqua/src/brain/reflectionV3/reflectionIdempotency.js` (+ `.test.js`)
- `aqua/src/brain/reflectionV3/reflectionLifecycleIntegration.js` (+ `.test.js`)
- `aqua/src/brain/reflectionV3/reflectionOutbox.js` (+ `.test.js`)
- `aqua/src/brain/reflectionV3/reflectionReconciliation.js` (+ `.test.js`)
- `aqua/src/brain/reflectionV3/reflectionRecovery.js` (+ `.test.js`)
- `aqua/src/brain/reflectionV3/reflectionWorker.js` (+ `.test.js`)
- `aqua/eval/suites/reflection-lifecycle.suite.mjs`
- `aqua/eval/suites/reflection-lifecycle-integration.suite.mjs`

`aqua/src/brain/reflectionV3/contradictionPolicy.js` (+ `.test.js`) — untouched, already there.

**MODIFIED** (full replacement):
- `aqua/scripts/worker.mjs` — was the deliberately-empty PR-2 runner stub. Replaced with root's version: registers `'understanding.turn.v1'` (`Brain.understandTurn` + `logE6Turn`) and `'claim.reflection.v1'` (`runClaimReflectionJob`) handlers, adds the outbox `dispatchReflections()` poll loop. Both handler dependencies (`Brain.understandTurn`, `logE6Turn`) verified present in `aqua/src/brain/index.js` and `aqua/src/core/observability.js` with matching signatures before this swap.

## How to apply
Overlay the `aqua/` folder from this delivery onto your repo's `aqua/` folder (same relative paths). No other files touched.

## Verification performed (real, run in-sandbox with plain `node`, no npm install — these modules are dependency-free by design)
```
node --test aqua/src/brain/reflectionV3/*.test.js
→ tests 26, pass 26, fail 0   (after clearing stale local mind-state, see gap below)

node aqua/eval/suites/reflection-lifecycle-integration.suite.mjs
→ {"events":5,"jobs":5,"effects":5,"pass":true}

reflection-lifecycle.suite.mjs .run()/.score()/.metrics()
→ {"lifecycle_gate":1,"checks_passed":14,"checks_total":14}

node --check aqua/scripts/worker.mjs
→ OK
```
Ran once *before* the port (from root, to establish the baseline) and once *after* (from the aqua copy) — identical results, confirming the port changes nothing behaviorally.

**Not verified**: anything touching a real Postgres connection (`getPool()`/`isConfigured()` paths in `reflectionOutbox.js`/`reflectionRecovery.js`) or the `claim.reflection.v1` job actually running inside `scripts/worker.mjs` end-to-end — this archive ships no `node_modules` and no `DATABASE_URL`. Run `npm ci && npm run test:brain` and `npm run worker` against a real DB before calling this "production-ready" rather than "implemented + unit-tested."

## Gap found during verification (not fixed here — flagging per Law 45)
`reflectionWorker.test.js` / `reflectionOutbox.test.js` call `getMind('user:a')`, which reads/writes the real default Mind snapshot path, not an isolated temp dir (unlike the eval harness, which does this correctly via `AQUA_DATA_DIR`). Re-running the suite twice in the same environment makes the second run's idempotency check correctly return `reflected:false, duplicate:true` — which then fails the test's hardcoded `assert.equal(result.reflected, true)`. This is a real idempotency mechanism working correctly, exposing a test-isolation gap, not a code defect. Recommend both tests inject an isolated `loadMind` the way `runClaimReflectionJob`'s signature already allows (`{ loadMind = getMind }`) instead of hitting the default store.

## Still not done (root cause, not yet closed)
1. `contradictionPolicy.js` (E9 PR-1, decision logic) is still not wired into `reflectionGate.js` / `reflectionWorker.js` (E9 PR2-10, lifecycle/durability). Both now live in the same tree; they still don't call each other.
2. Root `src/` still has 51 files differing from `aqua/src/` — this batch closed the reflectionV3 gap only. E8's `e8Pipeline.js`/gate tests, and everything else in the diff, still needs the same treatment or an explicit decision to abandon root.
3. Root `src/` is not yet retired. Don't delete it until `aqua/` has everything root has (or a documented reason it doesn't need to).

## Separate, unrelated finding surfaced during this audit — flagging, not fixing
`eval/out/world-model-lift.latest.json` (ran 2026-09-16, 200/200 cases, complete): production Context Engine currently scores **worse** than the plain retrieval floor it wraps — `mrr Δ-0.039`, `ndcg@8 Δ-0.062`, `recall@8 Δ-0.094`, `top1_kind Δ-0.125`. This is after E8 PR9-11 (which only unit-tested the two-round retrieval *policy*, not retrieval *quality*). `eval/out/world-model-lift-e2e.latest.json` (2026-09-17) is not usable evidence either way — all 200 cases errored with `All providers exhausted ... failed(config)` for groq/gemini/openrouter; that's a missing-credentials/config problem in whatever environment ran it, not a measured result. Recommend re-running `npm run eval -- world-model-lift` after this batch (should be unaffected — this batch didn't touch Context Engine code) and treating the negative delta as a blocker on any further E8 promotion until root-caused.
