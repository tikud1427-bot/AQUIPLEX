# AQUIPLEX E8 / PR-9 — Production seam integration gate

## Scope

This PR closes a production wiring defect found while tracing the E8 path end-to-end.

The synchronous `/chat` path already classifies each turn and computes `taskType`, but its
`Brain.assembleContext(...)` call did not forward `taskType`. The asynchronous cross-encoder
path did forward it. As a result, the sync path silently built the generic `conversation`
QueryPlan for decision/planning/coding/etc. turns.

## Change

`src/routes/chat.js` now passes `taskType` into the synchronous `Brain.assembleContext(...)`
call, matching the async path.

## Regression coverage

`src/brain/tests/contextEngine.test.js` adds a focused contract test proving that a production-
style synchronous Context Engine invocation with `taskType: decision` produces a decision
QueryPlan, including the required `deadline` slot.

## Validation

- `node --check src/routes/chat.js` — PASS
- `node --check src/brain/contextEngine/index.js` — PASS
- `node --check src/brain/contextEngine/assembler.js` — PASS
- `node --check src/brain/tests/contextEngine.test.js` — PASS
- `node src/brain/tests/queryPlan.test.js` — 4/4 PASS

The full Brain/route integration suite remains blocked in this archive because `node_modules`
is not present and the runtime dependencies have not been installed. No full-suite pass is
claimed.
