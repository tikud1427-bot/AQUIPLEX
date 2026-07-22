# Official External Harnesses

For benchmarks whose community-recognized implementation *is* a harness,
AQEval integrates rather than re-implements. The bridge is the shim:

```bash
# terminal 1 — AQUA engine
node evaluation/runners/aqua-standalone.mjs
# terminal 2 — OpenAI-compatible façade over the AQUA adapter
python3 evaluation/aqeval.py shim --adapter evaluation/configs/adapters/aquiplex.json
```

The shim serves `POST /v1/chat/completions` and `/v1/completions` on
`127.0.0.1:8799`, forwarding verbatim to AQUA and returning OpenAI-shaped
responses. Any harness that supports an OpenAI-compatible endpoint now
evaluates AQUA unmodified.

## lm-evaluation-harness (EleutherAI) — cross-checks & extra tasks
```bash
pip install lm-eval
lm_eval --model local-chat-completions \
  --model_args model=aqua,base_url=http://127.0.0.1:8799/v1/chat/completions,num_concurrent=4,max_retries=3,tokenized_requests=False \
  --tasks gsm8k,mmlu,mmlu_pro,gpqa_diamond_zeroshot \
  --output_path evaluation/reports/harness/lm-eval/
```
Use it to cross-validate AQEval's native numbers on shared tasks; archive its
output directory (it writes its own versioned configs) under
`reports/harness/`.

## LiveCodeBench
Clone the official repo, select a release tag (e.g. `release_v6`), point its
OpenAI-compatible client at the shim, and record the release tag in the
archived output. The rolling design means the tag *is* the dataset version.

## SWE-bench
```bash
pip install swebench
```
Generation: drive predictions through the shim (or an AQUA-side agent),
producing the harness's predictions JSONL. Evaluation: the official
`swebench.harness.run_evaluation` with its per-instance Docker images —
plan for tens of GB of images and hours of container time. Archive the
harness report verbatim. AQEval intentionally does not reimplement any part
of SWE-bench scoring.

## lmms-eval (MMMU / DocVQA / ChartQA)
Ready once the image-input adapter lands (SUPPORT_MATRIX.md): lmms-eval's
OpenAI-compatible mode will target a vision-aware shim the same way.

## BEIR
`pip install beir` once AQUA exposes an embeddings/retrieval route; the
adapter seam is the same pattern as the shim.

Archived harness outputs live under `evaluation/reports/harness/<tool>/…`
and can be merged into comparison dashboards by pointing `aqeval compare` at
metrics files you derive from them — provider-agnostic by design.
