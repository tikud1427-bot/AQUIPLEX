# eval/ (platform root)

Shims only. The evaluation harness — suites, datasets, baselines, adapters and
its own tests — lives in `aqua/eval/` and runs from there (`cd aqua && npm run
eval:gate`). The entrypoints here forward to it so `npm run eval:gate` at the
platform root runs the same single implementation. Do not copy suites here:
a second copy drifts (it had, before 2026-10-04) and nothing runs it.

`eval/out/` holds local run records and is not a baseline.
