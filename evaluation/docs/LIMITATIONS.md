# Limitations

Stated up front because credible evaluation names its own boundaries.

1. **No logprob scoring.** AQUA (like all API chat systems) exposes no token
   log-likelihoods, so MMLU-style benchmarks use the generative-letter
   protocol rather than the original loglikelihood ranking. This is the
   field-standard adaptation for API systems and is applied identically to
   every system in a comparison — but it is not bit-identical to open-weight
   leaderboard harness settings. Manifests name the protocol.
2. **Engine-owned decoding.** The frozen chat contract accepts only
   `message` — temperature, max output tokens, and stop sequences cannot be
   set per request. `max_tokens`/`stop` from benchmark configs are recorded
   but not enforced engine-side. Answers cut short surface as extraction
   misses (visible in `records.jsonl`).
3. **Provider drift.** AQUA routes to hosted third-party models that evolve;
   see REPRODUCIBILITY.md — CIs, not bit-identity, are the target.
4. **System-level measurement.** Scores measure the AQUA *system* (routing,
   verification, memory machinery, prompt scaffolding) end to end — that is
   the point — so they are not directly comparable to raw-model numbers for
   the underlying providers.
5. **AIME sample size.** n = 30 per edition; single runs move in 3.3-point
   increments. Run multiple seeds before citing.
6. **pass@k at n=1.** Default HumanEval/MBPP config samples once per task, so
   only pass@1 is meaningful; raise `n_samples` (and budget) for pass@10.
7. **Sequential-item cost.** A full MMLU run is 14,042 chat requests through
   the full cognitive pipeline. Budget provider quota and wall-clock
   accordingly; `--limit` smoke runs exist for plumbing checks, and are
   marked non-reportable for exactly that reason.
8. **Multimodal & retrieval gaps.** DocVQA/ChartQA/MMMU await the
   image-input adapter; BEIR awaits an exposed embeddings route
   (SUPPORT_MATRIX.md). They stay marked unsupported rather than
   approximated.
