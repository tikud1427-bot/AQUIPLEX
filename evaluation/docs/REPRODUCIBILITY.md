# Reproducing a Result

Every run directory is self-describing. `manifest.json` records:

- **Git commits** — AQEval and the platform tree (plus dirty flags).
- **Configuration** — full run config and the adapter config (secrets redacted).
- **Environment** — Python version, OS/platform, CPU count, RAM; AQUA
  behaviour flags (`AQUA_CIE` / `AQUA_PIC` / `AQUA_GRAPH`, …) and *presence
  booleans* for provider/search keys (never values).
- **Model versions** — adapter name/type; for AQUA, the engine's own
  provider + fallbackChain per item are captured in `records.jsonl`.
- **Prompt template version** — id, version, SHA-256 of the exact template.
- **Dataset identity** — path + SHA-256 per file (`checksums.json` pins).
- **Seed** — drives GPQA choice shuffling and bootstrap CIs.
- **Timestamp & command line.**

## Steps

1. `git checkout <platform commit>` and `<aqeval commit>` from the manifest.
2. Restore datasets: `aqeval download …` / `convert_hf.py …`; the pinned
   SHA-256s must match or the run refuses to start.
3. Recreate the environment per the manifest (Python x.y, Node for the
   harness) and set the same AQUA flags / key presence.
4. Start the harness: `node evaluation/runners/aqua-standalone.mjs`.
5. Re-run with the manifest's seed:
   `python3 evaluation/aqeval.py run --benchmark <b> --adapter <cfg> --seed <s>`

## What still varies

AQUA routes across third-party providers whose hosted models change over
time; the engine also owns its decoding parameters. Bit-identical outputs
across weeks are therefore not guaranteed — statistically consistent scores
(within the reported CI) are the reproducibility target, which is the norm
for API-served systems. `records.jsonl` preserves which provider actually
answered every item, so drift is diagnosable.

`aqeval report <run_dir>` rebuilds all four report formats from the stored
records at any time.
