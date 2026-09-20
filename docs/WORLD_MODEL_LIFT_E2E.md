# End-to-end World-Model Lift

## Purpose

Measure the product-facing question:

> With the same user world and the same model, does AQUIPLEX's world-model/context evidence produce a better grounded answer than the production retrieval floor?

The experiment is paired per query:

1. seed the same 60-fact world;
2. retrieve evidence through the production floor;
3. retrieve evidence through the production Context Engine;
4. send each evidence set to the same provider/router;
5. score both answers against the same reference judgments.

## Run

Install dependencies first, then:

```bash
AQUA_LIFT_LLM=on AQUA_LIFT_PROVIDER=groq npm run eval -- world-model-lift-e2e --json eval/out/world-model-lift-e2e.latest.json
```

`AQUA_LIFT_PROVIDER` may be `groq`, `gemini`, or `openrouter`. If omitted, the production router chooses the provider.

The suite is opt-in because it makes real model calls. Without `AQUA_LIFT_LLM=on`, cases are skipped rather than producing fake results.

## Automated scoring

The first scorer uses reference-token coverage. It answers a narrow question: did the generated answer mention a meaningful token from a judged relevant/acceptable fact?

It does **not** establish:

- semantic correctness;
- factual completeness;
- human preference;
- reduced re-explanation;
- correction persistence;
- planning quality.

Those require semantic evaluation and/or human annotation.

## Investor evidence rule

Do not quote a lift number unless coverage is complete, the dataset fingerprint is recorded, the same provider/model/configuration was used for both lanes, and the report is reproducible from the repository.

For a YC/VC evidence package, pair this automated report with a human-rated sample using a blinded rubric for correctness, personalization, unnecessary clarification, re-explanation, temporal reasoning, relationship reasoning, and honest uncertainty.
