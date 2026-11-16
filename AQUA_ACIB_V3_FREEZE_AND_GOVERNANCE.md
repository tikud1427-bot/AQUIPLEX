# ACIB v3 — Freeze and Governance

**Sprint 6, 2026-11-11.**

**Status: not frozen.** The governance preconditions are **not met**: no independent authors and no reviewer sign-off exist yet. No v3 dataset was written. No v3 benchmark execution was implemented, as the brief requires ("Implement benchmark execution only after the new benchmark is frozen").

## 1. Preconditions: status

| Precondition (brief §4) | Status | Who can satisfy it |
|---|---|---|
| Independent authorship of the 150 evaluation scenarios | **Not met.** No independent authors have been named or engaged. I (the implementation author) must not write them. | Founder: engage at least two authors who do not build the engine or hybrid |
| Reviewer sign-off | **Not met** | Founder or a delegate who is not an implementation author |
| 150 evaluation scenarios frozen and versioned | **Not done.** The tooling is ready. | Run `scripts/acib-v3-freeze.mjs` after the two rows above |
| 54 development scenarios kept separate | **Not done.** Tooling validates them separately; they may be written by anyone. | Authors |
| Implementation authors cannot inspect held-out scenarios | **Enforced by process plus tooling** (§3). It cannot be guaranteed by code on a machine the implementer controls. | Founder and reviewer hold the eval file |
| Sprint 4 frozen dataset and historical baselines untouched | **Met.** `acib.v2.eval.json` sha `002208e4…` is intact; no file in `eval/baselines/` was modified. | — |

## 2. Tooling built in Sprint 6

**`aqua/eval/governance/acibV3Governance.mjs`:**
- `PLAN`: the Sprint 5 plan as data (150/54, 11 categories with eval/dev counts, the answerability labels).
- `validateManifest`:
  - at least two eval authors;
  - **no eval author is an implementation author**;
  - reviewer `name`, `signedAt` and `statement` are present, and the reviewer is not an implementation author;
  - the founder's confirmation of the success criteria is recorded;
  - eval and dev paths are given.
- `validateDataset`:
  - counts and category balance match the plan;
  - unique ids;
  - an answerability label per scenario;
  - authors recorded per scenario;
  - every `match` and `evidence` pattern is reachable in the scenario's own text;
  - **`paraphrase: true` needs share no content token with the question** (checked with the recall tokenizer, so "semantic mismatch" scenarios really are mismatches).
- `assertOutsideRepo`: the evaluation file must **not** be inside the repository.
- `freezeRecord`: hashes (eval, dev, scorer), declared authors, reviewer and rules. The eval path is withheld.

**`aqua/scripts/acib-v3-freeze.mjs --manifest <file> [--scorer <file>]`**
- Refuses (exit 2) unless every check passes.
- **Never overwrites** an existing freeze.
- Writes `aqua/eval/datasets/acib.v3.FREEZE.json`.

**Tests:** `aqua/eval/tests/acibV3Governance.test.js`, **7/7 pass**. They cover:
- a valid manifest;
- author/implementer overlap;
- a single author;
- a missing sign-off;
- a self-reviewing implementer;
- unconfirmed criteria;
- an eval file inside the repository;
- each dataset check;
- the plan totals;
- the CLI refusing and writing nothing.

## 3. Process

1. **Founder:**
   - appoint ≥2 eval authors and a reviewer (none of them implementation authors);
   - confirm the success criteria (Sprint 5 benchmark plan §7, or amended).
2. **Authors:**
   - write the eval set (150) and the dev set (54) per the plan's schema;
   - the eval file is kept **outside the repository**, by the reviewer.
3. **Reviewer:**
   - spot-check at least 20 eval items;
   - run the freeze tool with the manifest (sign-off statement and date);
   - the freeze record is committed (hashes only).
4. **Implementation:**
   - the implementation author receives the dev set and the freeze record, **not** the eval file;
   - the hybrid is tuned on dev only.
5. **Then (future sprint):**
   - build `acibScoring.v3.mjs`, frozen with the set: new metrics for false unknowns, answerability accuracy, fallback rate and added tokens;
   - build a **sealed runner**: the reviewer runs it; it prints aggregates only and writes per-item results outside the repository;
   - one run per implementation; items opened only after that run, and labelled post-hoc.

**Limit.** The separation in step 4 is a process guarantee. On a single shared machine or account, code cannot stop an implementer from reading a file they can reach. The tooling makes the rules explicit, checkable and recorded.

## 4. What the Sprint 6 hybrid results are, therefore

All Sprint 6 hybrid measurements ([AQUA_HYBRID_CONTEXT_V1_RESULTS.md](AQUA_HYBRID_CONTEXT_V1_RESULTS.md)) come from sets the implementer has seen:
- dev sets: v1, held-out v1 (post-hoc), v2-dev;
- the contaminated v2 eval set, used only as a regression check.

**They are development evidence, not an independent evaluation.**
