# Root `eval/` — thin shim, not a second eval tree

`gate.mjs`, `run.mjs`, and `cross-encoder-local-smoke.mjs` are one-line
re-exports of `aqua/eval/`'s real implementation — same pattern as
`scripts/worker.mjs`. `.github/workflows/eval-gate.yml` only ever runs
`aqua/eval/` directly (`working-directory: aqua`); these shims exist so
`npm run eval:gate` etc. still work from the repo root without a second,
divergent copy of every suite/adapter/baseline to keep in sync.

`out/` holds real historical run output (`world-model-lift.latest.json`,
2026-09-16; `world-model-lift-e2e.latest.json`, 2026-09-17) — evidence, not
code, kept as the last-known record. `aqua/eval/`'s current
`world-model-lift.suite.mjs` is a newer 4-condition design
(stateless/memory/worldModel/worldModelDense) superseding the simpler
2-condition (floor/worldModel) suite that produced the 2026-09-16 file, so a
fresh run won't match its shape — that's expected, not a regression.

If you're looking for suites, adapters, baselines, or datasets: they're all
under `aqua/eval/` now. There used to be a second copy here that had quietly
diverged from it; this file is what's left of that.
