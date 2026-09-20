# World-Model Lift experiment

## Purpose

This experiment measures one narrow, investor-relevant part of the AQUIPLEX thesis:
whether the world-model/context stage changes the evidence selected for a user's
question compared with the production retrieval floor.

It uses the **same 60-fact world, 200 queries, K and scorer** as `retrieval-core`.
The control is the production floor retrieval; the treatment is the production
Context Engine/world-model path.

## What a result means

A positive delta in recall/nDCG/MRR is evidence that the context/world-model stage
improved retrieval selection on this benchmark.

It is **not** an end-to-end claim that the generated answer is better. It does
not yet measure re-explanation rate, correction persistence, planning quality,
or human preference. Those require a turn-level experiment with paired outputs.

## Run

```bash
npm run eval:world-model-lift
```

The machine-readable report is written to:

`eval/out/world-model-lift.latest.json`

## Investor evidence rule

Do not quote a lift number unless:

1. coverage is complete;
2. the dataset fingerprint is recorded;
3. the control and treatment used the same world and queries;
4. the model/provider/configuration is recorded;
5. the result is reproducible from the repository.

This suite is an experiment, not a promotion gate.
