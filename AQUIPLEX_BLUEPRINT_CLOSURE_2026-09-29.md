# AQUIPLEX Blueprint V2 — Implementation Closure

Date: 2026-09-29

This file records changes made against the supplied AQUIPLEX Technical Blueprint V2 and the verified code-level state after the implementation pass.

## Implemented in this pass

### E7 — canonical world-model retrieval wiring

- Wired the canonical Postgres graph lane into the asynchronous Context Engine path.
- Canonical graph traversal is bounded, owner-scoped, lifecycle-aware, retrospective-aware, provenance-preserving and fail-open.
- Graph claims are loaded from the canonical claim repository rather than the legacy fact store.
- The existing lexical/dense/legacy PIC floor remains intact as the fail-safe floor.
- Retrieval continues to fuse lanes through the existing RRF/reranking/assembly path.

### E9 / E4 — durable reflection + outbox hardening

- Transactional outbox dispatch now claims rows atomically with `FOR UPDATE SKIP LOCKED`.
- Processing rows carry `claimed_by` / `claimed_at` and increment attempts.
- Stale `processing` rows are reaped back to `pending` after the configured claim TTL.
- Queue-enqueue failures return rows to `pending` with a bounded retry path; after 8 attempts they become `dead` instead of retrying forever.
- The worker now accepts the richer batch-dispatch result and reports recovered stale outbox rows.
- The existing job idempotency keys remain the downstream duplicate barrier.

### L6 / L20 — user correction loop

- Added canonical `correctClaim()` in the world-model repository.
- A user correction creates a new evidence-backed successor claim with explicit user-tier provenance.
- The old claim is superseded rather than overwritten.
- Correction, lifecycle transition and revision history are recorded atomically.
- The successor claim emits durable `claim.created` and `claim.embedding.requested` events so correction immediately feeds reflection and dense retrieval.
- Added authenticated Brain API surfaces:
  - `GET /brain/claims/:id`
  - `GET /brain/claims/:id/history`
  - `POST /brain/claims/:id/correct`
- User-visible canonical claims now expose a writable provenance `ref`.

### E1 hygiene

- Removed stale pre-PR snapshot artifacts discovered by the repo hygiene guard.
- The repository hygiene test is now green.

### Developer ergonomics / verification

Added package scripts:

- `doctor:production-loop`
- `start:production`
- `test:world-model-loop`

The production-loop doctor was expanded from 8 to 12 static closure checks to cover the new canonical graph, correction, and atomic-outbox seams.

## Verification performed

Passing:

- Production loop doctor: **12/12**
- E1 repo hygiene: **4/4**
- E7 graph-lane contract: **14/14** (+ real-Postgres traversal remains skipped because `AQUA_TEST_PG_URL` is not configured)
- E7 embedding substrate: **3/3**
- E9 reflection/outbox focused tests: **all assertions passed**

The full repository test battery was attempted. The working tree did not contain a complete `node_modules` installation; dependency installation via `npm ci --prefer-offline` timed out, and the full runner consequently reported dependency-resolution failures (for packages such as `uuid`, `express`, `@google/genai`, `openai`, `pg-mem`, `adm-zip`, etc.). Those failures are environment/dependency-installation failures, not evidence that the edited modules fail their focused checks.

## Deliberately not falsified

The blueprint still requires external/runtime evidence before claiming the full product is proven:

1. E6 negation promotion gate must be established with the blueprint's repeated `--repeat 5` measurement before calling the extractor promoted.
2. Canonical claim authority still needs the specified parity/drift window against the legacy substrate.
3. Dense retrieval needs a real provider-backed corpus and its ablation measurement.
4. World-Model Lift must be run on real longitudinal user data.
5. Re-explanation-rate decline and live correction accumulation must be observed on real users.
6. Agent autonomy remains intentionally out of scope for this closure pass, matching the supplied blueprint's sequencing rule.

No production secret material is included in this source archive.
