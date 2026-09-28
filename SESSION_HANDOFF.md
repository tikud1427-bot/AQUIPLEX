# SESSION HANDOFF

- Architecture: runtime = `aqua/` (ESM, mounted by root `index.js` via `aqua/router.js`). Root `src/` no longer exists in this archive. Blueprint V2 status labels are STALE: tree has migrations 0001-0015, transactional outbox, worldModelRepository, retrieval bridge, owner-partition HNSW, belief_claims, e8Pipeline, reflectionV3 (contradictionPolicy wired via contradictionWorker + scripts/worker.mjs), durable `understanding.turn.v1` job. LIVE CODE > blueprint text.
- Baseline (before this session's edits, Node 22, `npm ci` in aqua/, `AQUA_DATA_DIR=/tmp/aqua-data`): 3330 tests / 3328 pass / 1 fail / 1 skip. The 1 fail = `repoHygiene.test.js` (E1/PR-7): two snapshot files.
- Completed: baseline; re-baseline vs blueprint; E1/PR-7; E4/PR-7 (dlqPolicy, requeueDead, doctor:dlq, runbook); E12 slice (cost, span allowlist, /metrics); durable understanding path + commit default; **E8 root cause #1 (tokenizer)**.
- E8 lift, measured (eval world-model-lift, this sandbox): worldModel-vs-floor mrr -0.0169 -> -0.0020, top1_correct -0.0179 -> 0.0000, ndcg@8 -0.0169 -> -0.0062, recall@8 0.0000 -> 0.0000; top1_kind -0.0417 (unchanged). Dense-vs-worldModel mrr +0.06. Cause: `tokensOf` (contextEngine/scorer.js) fused sentence-final `.` to the last word, so stored facts never matched the query's answer word; user_focus+semantic (0.36 weight) read 0 and confidence/source priors ranked. Fix + tokenizer.test.js.
- Tried and REJECTED: seeding corpus `supersededBy` in eval seed -> mrr delta -0.0045 (no real change). Benchmark world left untouched. Residual: `superseded` cat still loses (sum rr -1.4/10 q), top1_kind -0.04. Next: trace q117/q118/q120 (CE pulls extra neighbours, returns 4.1 items vs 3.1) — it's widening + budget, not lexical.
- NOT yet: flip AQUA_CONTEXT_V2 or E8 flags (default off in core/flags.js). Lift is ~0, not positive.
- Pending: see Roadmap.
- Current Step: implement unblocked slice (E1/PR-7, E4/PR-7, E12 slice).
- Constraints: land in `aqua/` only. No new env vars without registering in `core/flags.js` (L13). No new dependencies. No flag flips for E6/E8 (gates unmet). No agents (Part 3, Part 15 §9). No new stores (L2). Never copy `_env` into repo.
- Files: see Roadmap.
- Decisions: E10 (store unification), E11 (/v1 consolidation), agents NOT started — blueprint orders them after World-Model Lift is positive; measured lift is now ~0 (was negative; see E8 line above), not positive.
- Errors: E6 negation gate unmet (0.70-0.90 vs 0.95 needed) — needs `--repeat 5` measurement with live Groq key, not code. E8 context worse than floor — root-cause first. Live-DB paths unverified (no Postgres in sandbox).
- Next Exact Action: `node /tmp/trace.mjs`-style trace of q117/q118/q120 (floor vs CE ranking + stats); find why CE widens to 4.1 items on `superseded` queries. Then E6 negation measurement (needs live key).

## Roadmap + file order (this session)

1. E1/PR-7 — delete `aqua/src/brain/understanding/pipeline.before-pr17.js`, `e6Extractor-before-pr16.mjs` (only referenced by the hygiene test that forbids them).
2. E4/PR-7 — `aqua/src/core/jobs/dlqPolicy.js` (pure alert evaluation), `requeueDead()` in `jobQueue.js`, `docs/RUNBOOK_DLQ.md`, tests.
3. E12 slice — `aqua/src/core/costAccounting.js`, `aqua/src/core/spanAttributes.js` (PII allowlist), `aqua/src/core/metricsExposition.js` (Prometheus text), `GET /metrics` in `routes/health.js`, tests.

## Still open after this session

- E6 promotion gate (measurement). E7 canonical rollout + ablation. E8 root-cause negative lift.
- E5/PR-9 parity job, PR-10 remove `"You"` special cases (needs AQUA_SELF_ENTITY flip, live data).
- E9 PR-7/8 delta v2 + revision feed on live data. E10/E11 (blocked by lift). Real OTel traces + Redis rate limits (need new deps — decision for you).
