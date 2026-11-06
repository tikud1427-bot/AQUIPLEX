# Answer comparison 2: HEAD vs DEV with A–D (prepared 2026-11-05, not run)

The second answer-level comparison. It is the same as run 1 (`../2026-11-05/answers/primary-cf-mistral-2026-11-05`) in everything except the DEV code, which now includes:
- **A:** goal targets reached;
- **B:** uncertainty preserved;
- **C:** question-aware cognitive context;
- **D:** scaffold guard.

Graded with the frozen rubric v2 (`../rubric-v2`, `FROZEN.sha256`), and also with v1 for continuity. **Nothing here has been sent to a model.**

## What is the same as run 1
- **Questions:** the 12 frozen development questions (`aqua/eval/datasets/answer-lifecycle.dev.v1.json`, sha256 `155c0390…`).
- **HEAD:** `contexts.HEAD.code-defaults.json` is a byte copy of the frozen run-1 file. The 12 HEAD requests are byte-identical to run 1's (checked against its raw log's request SHA-256).
- **Model, settings and order:** the runner is the frozen `../2026-11-05/run-answers.v2.mjs`, used in place. It uses `@cf/mistralai/mistral-small-3.1-24b-instruct` with temperature 0, top_p 1, max_tokens 600 and seed 7, in the same seeded order (`q09:HEAD q09:DEV q04:HEAD …`). It stops on any provider error, sends at most 24 calls and never overwrites a run directory.
- **Accounts:** a fresh account per question with its life replayed; no prompt contains another question or another life.

## What differs
- **DEV:** `contexts.DEV.code-defaults.json` is built from the working tree, fingerprinted in `dev-code.sha256`: 407 source files, the same file rule as run 1. Compared with run 1's DEV fingerprint, exactly the 16 files of A–D differ.
- **Rebuilt twice:** both builds are identical (nonce normalised).

## Also measured by this run
**Run-to-run noise.** The HEAD half repeats run 1 exactly. `compare-head.mjs` reports how many HEAD answers and v2 grades changed between the two runs. A HEAD/DEV difference no larger than that is not evidence.

## Files

| File | Purpose |
|---|---|
| `contexts.{HEAD,DEV}.code-defaults.json` | the system prompt per question |
| `prompts.code-defaults.jsonl` | 24 records: HEAD (identical to run 1), then DEV |
| `dev-code.sha256` | DEV source fingerprint (check from the repo root) |
| `verify-package.mjs` | model-free gate before the run: hashes, shape, order, HEAD identity, isolation, limits, Neuron estimate |
| `check-run.mjs` | after the run: complete, untruncated (ADDENDUM rule 3), the frozen requests |
| `compare-head.mjs` | HEAD run 1 vs run 2: noise floor |
| `MANIFEST.sha256` | hashes of the files above |

## Order of operations
1. `node verify-package.mjs`. Every check must pass.
2. The run, by the owner, in their own session (the token is not visible to tools).
3. `node check-run.mjs answers/<run-id>`. If it fails, report the run as incomplete and do not grade it as complete.
4. Grade (no calls): rubric v2 → `graded.v2.json`; v1 → `graded.v1.json`; then `compare-head.mjs`.
5. Report every question, per category, paired better/worse/same, regressions and the noise floor.

**Development set:** the questions were written by the implementer, and rubric v2 was written after reading run 1. This comparison is diagnostic, not confirmatory.
