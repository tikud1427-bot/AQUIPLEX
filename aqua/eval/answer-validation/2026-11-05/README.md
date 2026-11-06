# Answer validation package: HEAD vs DEV (frozen 2026-11-05)

This folder holds everything needed to answer, grade and independently check the comparison. **No answers have been generated yet:** no isolated, authorised, free answerer was available (see `AQUA_ANSWER_INTELLIGENCE_VALIDATION_REPORT.md` §1).

## Conditions

| | Code | How it was built |
|---|---|---|
| **HEAD** | commit `df674e610455cdbd740266de50cd38649ee817ad` | `git archive HEAD aqua`, extracted to a temporary folder; `node_modules` linked; no git state touched |
| **DEV** | the working tree on 2026-11-05 | fingerprint `dev-code.sha256` (407 source files, test files excluded) |

Both conditions get exactly the same inputs:
- **lives and questions:** `aqua/eval/datasets/answer-lifecycle.dev.v1.json`, sha256 `155c0390…`;
- **harness:** `aqua/scripts/answer-eval-harness.mjs contexts`, one fresh account per question with the life replayed into it, simulated clock, private data directory, no provider;
- **prompt path:** the real production `routes/chat.js prepareTurn` (legacy read);
- **flag profiles:** production code defaults (`code-defaults`, the primary condition) and the developer flags (`dev-env`, secondary).

**Reproducibility.** Each build was rebuilt twice and is identical for 12 of 12 questions. The only difference is the random per-request untrusted-content fence nonce, a security token (`check-repro.mjs`).

**Equivalence.** Per prompt, only memory-derived sections differ. Fixed instruction text is identical in dev-env. In code-defaults the only difference is that DEV omits the cognitive-model block for some questions, which is content-driven (`instruction-diff.mjs`).

## Files

| File | What it is |
|---|---|
| `contexts.{HEAD,DEV}.{code-defaults,dev-env}.json` | the exact system prompt each question gets |
| `prompts.{code-defaults,dev-env}.jsonl` | 24 records each (12 questions × HEAD/DEV): `{id, condition, category, system, user}` |
| `run-answers.mjs` | **generation only.** Refuses without `--endpoint --model --api-key-env --confirm "isolated-free-authorized:<provider>"`; never reads `.env`; fixed settings (temperature 0, top_p 1, max_tokens 600, seed 7); seeded interleaved order; never overwrites; stops on any quota or rate signal. `--dry-run` sends nothing |
| `check-repro.mjs`, `check-equivalence.mjs`, `instruction-diff.mjs`, `focus-lines.mjs` | model-free checks used in the report |
| `focus.*.txt` | per question, the prompt lines about what is asked, in both conditions |
| `HELDOUT_SPEC.md`, `validate-heldout.mjs` | the independent held-out evaluation: what to write, who writes it, how it is run, the decision rule |
| `MANIFEST.sha256` | SHA-256 of every file here, the harness and the dataset |

## Running it, once an answerer is authorised

```bash
cd aqua/eval/answer-validation/2026-11-05
sha256sum -c MANIFEST.sha256                 # nothing in this folder changed since the freeze
(cd ../../../.. && sha256sum -c aqua/eval/answer-validation/2026-11-05/dev-code.sha256)   # DEV code unchanged (from the repo root)
node run-answers.mjs --prompts prompts.code-defaults.jsonl --out answers/<run-id> \
  --endpoint <base url> --model <model> --api-key-env <VAR> --confirm "isolated-free-authorized:<provider>"
node ../../../scripts/answer-eval-harness.mjs grade --answers answers/<run-id>/answers.jsonl \
  --contexts contexts.HEAD.code-defaults.json,contexts.DEV.code-defaults.json --json answers/<run-id>/graded.json
```

Repeat the run with `prompts.dev-env.jsonl` as the secondary condition. Keep `answers.raw.jsonl` untouched. That is the record anyone can re-grade.
