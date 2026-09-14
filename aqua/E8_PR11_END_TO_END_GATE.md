# AQUIPLEX E8 / PR-11 — Context Engine V3 End-to-End Policy Gate

This change closes the E8 safety/evidence seam on the pure production components
that can be exercised without external stores/providers.

## Proven contracts

- sufficient QueryPlan -> exactly one retrieval round
- missing required slots -> one targeted second round only
- no third retrieval round
- exhausted required slots -> explicit UNKNOWN / abstention state
- slot provenance is explicit
- citations and retrieval lane provenance survive assembly
- canonical evidence text is not paraphrased by the compression/rendering layer
- global character budget and item limit remain hard bounds
- existing QueryPlan and E8 pipeline tests remain green

## Validation

`node --test src/brain/tests/e8Pipeline.test.js src/brain/tests/queryPlan.test.js src/brain/tests/e8IntegrationGate.test.js`

Result: **12 tests passed, 0 failed, 0 skipped**.

The full repository gate still requires the project's external dependencies and
runtime stores/providers. This PR does not claim that broader gate.
