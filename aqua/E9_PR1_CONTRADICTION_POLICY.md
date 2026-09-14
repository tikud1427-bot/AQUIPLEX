# E9 / PR-1 — Contradiction Resolution Policy

This is the first Reflection V3 seam. It is intentionally a pure policy module.

## Contract

`resolveContradiction(a, b, opts)` never writes data and never calls a model.

Decision order:

1. explicit user correction
2. explicit supersession
3. non-overlapping validity windows
4. independent corroboration (only when explicitly enabled)
5. recency (only when explicitly enabled and same subject + predicate)

Otherwise the result is `disputed`.

Heuristic rules 4 and 5 are opt-in because the blueprint requires disagreement to be surfaced rather than silently resolved. This PR therefore establishes the deterministic policy surface without changing production claim state.

## Safety

- user correction has an explicit confidence ceiling of 1.0
- heuristic corroboration resolution is capped at 0.85
- heuristic recency resolution is capped at 0.80
- no LLM policy
- no mutation
- no cross-owner state
- no new knowledge store

The next E9 PR can wire this policy to the canonical claim lifecycle once the required claim-state substrate is available.
