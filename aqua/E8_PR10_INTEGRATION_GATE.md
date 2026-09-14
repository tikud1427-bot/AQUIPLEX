# AQUIPLEX E8 / PR-10 — Integration Policy Gate

## Scope
Extract the bounded two-round retrieval policy from the Context Engine into a pure,
directly testable module.

## Guarantees
- first retrieval is always performed;
- second retrieval occurs only when required QueryPlan slots remain missing;
- second-round queries are explicitly slot-targeted;
- at most two queries are issued per missing slot;
- there is never a third retrieval round;
- after round two, unresolved required slots become `unknown`;
- slot membership is explicit provenance, not text inference;
- the merged result preserves the original floor and targeted evidence.

## Additional wiring correction
The synchronous `/chat` Context Engine call now forwards `taskType`, matching the
already-wired async path. This prevents the production sync path from silently
falling back to the generic `conversation` QueryPlan.

## Validation
- `node --check` on all changed JS: PASS
- `src/brain/tests/queryPlan.test.js`: 4/4 PASS
- `src/brain/tests/e8Pipeline.test.js`: 4/4 PASS
- Full Brain/route suite remains environment-blocked when dependencies are absent
  (`uuid` is missing from the supplied archive).
