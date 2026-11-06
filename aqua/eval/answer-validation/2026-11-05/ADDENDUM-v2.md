# Addendum v2: execution rules (2026-11-05, written before any answer exists)

The frozen materials (`MANIFEST.sha256`) are unchanged. This addendum adds one file, `run-answers.v2.mjs`, and fixes the execution rules in advance. Hashes: `MANIFEST-ADDENDUM.sha256`.

## Why v2

The frozen `run-answers.mjs` stops only on quota or rate signals. The execution mission requires stopping on **any** quota, billing or provider error, because a failed call graded as an empty answer would bias the comparison. v2 differs only in this:
- stops on any provider error: non-2xx, network error, error body, or empty reply. No retries, no fallback provider or model;
- `--max-calls` (default 24) refuses a larger run;
- records the provider named in `--confirm`.

**Requests, settings and order are byte-identical.** Both versions' dry runs print the same order and request SHA-256s (verified: identical digest `e79b62f2…` of the two dry-run outputs). Use v2.

## Fixed rules

1. **Order of runs.** Primary run: `prompts.code-defaults.jsonl` (production flag defaults), 24 calls. Secondary run: `prompts.dev-env.jsonl`, 24 calls, only after the primary completes. Each run gets a new `--out answers/<run-id>`; nothing is overwritten.
2. **A stopped run is incomplete.** It is reported as stopped and never graded as a complete comparison. After the cause is fixed, *all 24* prompts run again under a new run id. Never selective re-runs.
3. **Truncation.** `finish_reason` is recorded for every answer.
   - Truncated answers (`length`) are graded as they are and listed.
   - If more than 2 of the 24 are truncated, the run is reported, but no conclusion is drawn from it. A new run of **all 24** with one higher cap, applied to both conditions, is then made and reported beside it. The cap may never differ between conditions.
4. **One provider, one model, one settings set per run.** No switching mid-run. A second model is a separate, separately reported run.
5. **Grading is separate.** `answer-eval-harness.mjs grade` runs on `answers.jsonl` only after generation ends. `answers.raw.jsonl` is never edited. If an LLM judge is added later, it is a second grader with a frozen prompt, reported separately.
6. **Results are reported whatever they show:** per question, per category, paired better/worse/same, including regressions.

## What an authorisation must state

The run starts only on an explicit message from the owner naming:
- the **provider** and **model**;
- the **environment variable** holding a key created for this evaluation;
- that the key is used by **nothing else** (not Lift v4b, not production);
- the **cost basis**: a free allowance, or a spending cap set on the key.

Presence of a key in any `.env` is never permission.
