# World Model initiative — audit, fixes and measurements (2026-10-17/18)

Branch `aquiplex/world-model-pass2`, base `e64f26cb`, everything **uncommitted** (the tree
already carried uncommitted work from 2026-10-15/16; the files of this pass are listed in §8).
Labels as in `PRODUCT_SCORECARD.md`: MEASURED (a number from a named file or command),
UNMEASURED, TARGET.

## 1. Verdict

The canonical World Model, which is what production reads when Postgres is configured, had
three concrete defects. None of them was architectural.

1. **No relevance test on the canonical read.** The canonical lanes merged their claims into
   the Context Engine's "floor", and the floor is never re-judged. A first-person question
   anchored on the user's self entity and got *every* claim about the user. "What is my dog's
   name?" received eight facts about the user's job, under the header "CONTEXT AQUA ASSEMBLED
   FOR THIS QUESTION … EVIDENCE STATUS: SUFFICIENT". The legacy path had a relevance gate
   (`factAffinity`) and the explicit rule "the self anchor is not topical"; the canonical path
   had neither. This is consistent with the World Model's higher fabrication on Lift v3.
2. **Changes were stored but not applied, and one rule applied them wrongly.**
   - The canonical eval never ran the worker, so it measured a world in which no change or
     correction had ever been applied.
   - With the worker running, S8's sole-value revision **retired an unrelated fact**: "We
     raised our price to $39" superseded "We have 42 paying clinics" (`has_property` is an
     unkeyed catch-all).
   - Many changes are extracted into a *different slot* than the value they replace (price
     under `Our price` vs `You`; launch as `plans_to` vs `deadline_for`), so no rule compares
     them.
3. **Non-determinism that made measurements unrepeatable.**
   - The extractor's reference context picked an arbitrary evidence turn per claim
     (`DISTINCT ON` without `ORDER BY`).
   - V3 fusion broke ties by random canonical UUIDs (122 of 200 dev queries reordered between
     two seedings of identical data).

The World Model has **not** been shown to beat simpler memory. The long-history experiment
that would show it (v4) has still not completed (§6).

## 2. Root causes (code references)

| # | Root cause | Where |
|---|---|---|
| A | Canonical claims bypass the relevance gate; `relevanceBacked()` counts any structured/graph item as relevant; self anchor = whole world | `aqua/src/brain/contextEngine/index.js` `canonicalCandidatesForQuery`, `gatherCanonicalGraphCandidates`; `contextEngine/assembler.js` `relevanceBacked` |
| B | State not applied / applied wrongly: eval never drains the worker; sole-value revision on `has_property` retires unrelated values; attribute held under two subjects | `eval/adapters/canonicalContextRetrieval.mjs`; `brain/understanding/claimDedup.js` (sole-value revision) |
| C | Non-determinism: extraction context evidence-turn choice; fusion tie-break by UUID (and lane rows read `r.text`, which they don't carry) | `core/worldModel/canonicalReadModel.js` `extractionContext`; `brain/contextEngine/retrievalV3.js` |

## 3. What changed

**Retrieval (Priority A, F)**
- `pic/questionShape.js` `claimAffinity()`. This is `factAffinity` applied to a canonical claim,
  using the claim's own structure:
  - polarity and lifecycle are read as data;
  - the predicate types the answer, but only when the question's topic is accounted for;
  - anchor credit only for an entity the question *names*, or a role it resolves (never the
    self entity);
  - the dense cosine counts below kind credit;
  - temporal modifiers ("next", "latest") are not topics;
  - overview requests ("What do you know about me?") make the self anchor topical.
- `contextEngine/index.js`:
  - every canonical lane (lexical, structured, dense, graph, graph neighbours, and the
    dense-seeded graph lane) passes through the gate;
  - the slot lane (decision scaffolds) is exempt by design;
  - anchors are resolved once;
  - rollback: `AQUA_CANONICAL_RELEVANCE_GATE=off` (verified to reproduce the old rankings exactly).
- **"Is X still true?" and "what was it before?" (Priority B).** When a question names a value
  that is no longer current, the slot's current values and the explicit `superseded_by`
  successor are added. "Do I work at Intercom?" now reaches "I run product at Nummo". On a
  past-tense question naming a value ("Where did I work before Nummo?"), the slot's history is
  added. A negated value of the asked relation ("NOT: User works at Acme") stays visible as
  the correction. All of this is bounded (at most 4 slots and 4 successors, owner-scoped,
  archived never).
- `brain/index.js` `withWorldCore`: when nothing was selected for the question, the profile
  block now says so and repeats "anything not stated is unknown". Before, the anti-fabrication
  footer lived only in the (empty) relevance block.

**State (Priority B, D)**
- `claimDedup.js`:
  - sole-value revision of `has_property` only replaces a value of the same kind (money,
    percent, duration, date, count, or text sharing a word);
  - new **attribute-subject revision**: `(Our price, $29…)` is retired by `(You, $39…)` when
    the change's own sentence names "price". Same evidence bar as the existing renamed-subject
    rule; exactly one candidate, otherwise it is recorded as ambiguous.
- `understanding/pipeline.js`:
  - **compound-change retry**: when a clause stating a change ("…, and the price is now $39")
    has no covering claim, code asks once more and names the clause;
  - only claims covering the missing clause are taken from the retry;
  - rollback `AQUA_E6_COMPOUND_RETRY=off`. The no-hint prompt is byte-identical, so cache keys
    and fixtures are unchanged.

**Determinism**
- `canonicalReadModel.extractionContext`: a claim ranks by its most recent mention.
- `retrievalV3.js`: ties broken by content before id, in lane grouping and in fusion.

**Evaluation (§6 of the brief)**
- `eval/datasets/retrieval-heldout.v1.json`:
  - 46 founder statements, 82 questions;
  - written before the gate change and frozen (`.FROZEN.sha256`, `a192effc…`);
  - replayed through the production understanding path from a Groq `gpt-oss-120b` recording
    (`eval/fixtures/retrieval-heldout.e6-replay.v1.json`, 46/46 calls, stable across 3 replays).
- New suite `context-canonical-heldout`; new metric `stale_leaks` (lower is better).
- Canonical suites now run the durable worker after ingest (`AQUA_EVAL_CANONICAL_DRAIN=off`
  for the old behaviour).
- Pre-registered promotion criteria and their result: `eval/datasets/retrieval-heldout.v1.PROMOTION.md`.

## 4. Resulting read path

```
user turn ─▶ S0–S6 extraction (E6; + compound retry) ─▶ S8 dedup/contradiction (outbox)
                                                         └─▶ worker: contradiction policy → supersede / dispute
question ─▶ analyseQuestion + named anchors (findEntities, role holders; self only for overview)
         ─▶ canonical lanes (lexical · structured · dense · graph) ─▶ claimAffinity gate
         ─▶ state-slot resolution (successor / current values / history)
         ─▶ scorer + fusion (deterministic) ─▶ assembler (budget, diversity, dedupe, epistemic status)
         ─▶ relevance block  +  World Core profile (with "nothing selected → unknown")
```

History (production window) and BM25 memory remain separate prompt inputs in chat; the hybrid
exists only in the Lift harness. Nothing about which mix is best has been measured on long
histories (§6).

## 5. Measurements

All retrieval numbers are deterministic, offline (no dense lane), local Postgres, replayed
`groq/openai/gpt-oss-120b` extraction. "Before" = session-start code.

**Held-out (retrieval-heldout.v1, n = 82: 56 answerable, 26 silence, 16 stale-labelled), V3 ranker (production `.env`)**

| | before | + worker & S8 fixes | + relevance gate & slot rules |
|---|---|---|---|
| recall@8 | 0.821 | 0.821 | **0.839** |
| MRR | 0.712 | 0.739 | **0.757** |
| top-1 | 0.625 | 0.679 | **0.696** |
| unknown honesty | 0.192 | 0.192 | **0.654** |
| noise lines (silence queries) | 120 | 117 | **24** |
| stale leaks (/16) | 11 | 7 | **6** |
| retrieval latency p50 / p90 | 25 / 32 ms | — | 30 / 59 ms |

- Promotion decision: the gate was PROMOTED on the first held-out after-run, against criteria
  written before that run (all 5 met for both rankers). Later refinements (overview requests,
  temporal modifiers, correction visibility, slot history) were motivated by dev failures, and
  the held-out set had already been opened for state diagnosis. **The last column is therefore
  a secondary measurement, not a fresh held-out result.**
- Small n: one query is about 1.8 points of recall, 3.8 points of honesty, and 6 points of the
  stale-leak rate.

**Development (retrieval-core.v1, n = 200), V2 ranker (the gate's configuration)**: recall@8
0.696 → 0.702, MRR 0.584 → 0.620, top-1 0.536 → 0.571, unknown honesty 0.344 → 0.750,
noise 153 → 22, items per query 5.5 → 2.3 (silence queries 4.8 → 0.7). Accepted regression:
`recall_category` 0.406 → 0.375 (one semantic paraphrase that only the dense lane serves).
With V3: recall@8 0.702 → 0.690, MRR 0.617 → 0.635.

**Compound changes**
- 8-sentence development battery, live Groq, committed claims counted: 15/16 change clauses
  with the retry off; 16/16 with it on.
- The retry **never fired** in the on-run, so this difference is model variance, not the
  retry. Its mechanism is pinned by scripted tests only; its live benefit is UNMEASURED.

**State corrections found while measuring**
- The supersessions that landed in the held-out world went from 0 (worker never run) to 5,
  one of them wrong (price retired the clinic count).
- After the S8 fix, the wrong one is gone and the attribute-subject rule applies.
- Remaining stale leaks (6): launch (`plans_to` vs `deadline_for`, two questions), design lead
  (`role_is` vs `task_owner`), Kofi (`builds` vs negated `task_owner`), a blocker sentence with
  one sibling claim left current, and "57 paying clinics" not linked to "42".

**Cost.** The relevance gate and slot rules add no model calls. The compound retry adds at most
one extraction call, only when a change clause is uncovered (0 retries in 8 live sentences).
Answer-context size from the relevance section is −59% items per query.

**Not measured in this pass:** answer-level correctness, stale-answer rate and fabrication with
an LLM answerer and judge (the Lift harness); human evaluation; the dense lane's effect on the
canonical gate (needs embeddings online); the founder journey on the real app (held back so as
not to compete with v4 for NVIDIA quota).

## 6. Long-history experiment (v4)

- **Status: no result. Five attempts, none completed.**
- Attempt 4 was launched 2026-10-17 12:54 IST exactly as registered:
  - snapshot verified byte-identical to tree `aadda450`;
  - dataset sha `86c4f7ba…`;
  - fresh migrated `aqua_v4_prereg`;
  - AC power, keep-awake hold.
- It died at 16:38:57 when Sleep was chosen from the Start menu (System log: User32 1074 from
  `StartMenuExperienceHost`, then Kernel-Power 187/42). It was still ingesting the last
  persona, with 0 dead jobs.
- Under the prereg a crash voids the run. No answer or grade was produced or looked at. Logs:
  `lift-v4.prereg.attempt3-reboot.log`, `lift-v4.prereg.attempt4-usersleep.log` in the
  snapshot's `aqua/eval/out/`.
- **Blocker:** a host that stays on AC and is not put to sleep for 6–10 hours (or the validated
  VM kit).
- Command:

```
powershell -File <scratchpad>\v4run\launch-v4.ps1     # refuses to start on battery
```

- After it exits, read `aqua/eval/out/lift-v4.prereg.json` in the snapshot and apply the
  prereg's decision rule. The v4 snapshot does **not** contain this pass's fixes. That is
  intended: it measures the registered code, and this pass's changes need their own
  pre-registered run afterwards.

## 7. Regression, security, isolation

- Aqua battery (per directory, live Postgres and Redis, 2026-10-18): **4,416 tests, 4,411
  pass, 4 skipped, 1 fail**. The failure was the baseline-note format test (notes must name the
  per-suite regenerate command). It was fixed and re-run (`eval/tests/evalGate.test.js` 25/25)
  after the battery started. Frontend and platform suites: not re-run (no files touched there).
- Eval gate: PASS without a database (the canonical suites report NOT RUN). With a database
  everything passes after the three re-baselines, each justified in its baseline's `note`:
  - `context-canonical`;
  - `context-canonical-heldout` (new);
  - `context-dense-v3` (−0.0003 MRR from the tie-break change).
- Every new query is owner-scoped and bounded. Archived (user-deleted) claims are excluded from
  every new path (current-state reads use `CURRENT_STATES`; history reads use
  `RETROSPECTIVE_STATES`, which excludes archived).
- Isolation and deletion live tests pass. No adversarial test against a deployed site.
- Side finding, not fixed: `findClaimsForDedup` loads every claim of the incoming predicates
  with no LIMIT, so S8's cost grows with the user's history on every turn.
- Unchanged and still blocking: the secrets in the public repository history must be rotated
  by the owner (`PRODUCT_SCORECARD.md` §6).

## 8. Files

- Source:
  - `aqua/src/brain/contextEngine/index.js`, `contextEngine/retrievalV3.js`, `brain/index.js`
  - `aqua/src/pic/questionShape.js`
  - `aqua/src/brain/understanding/{claimDedup,pipeline,extractionClient,extractionPrompt}.js`
  - `aqua/src/core/worldModel/canonicalReadModel.js`, `aqua/src/core/flags.js`
- Tests:
  - new: `src/pic/tests/claimAffinity.test.js`, `src/brain/tests/compoundRetry.test.js`
  - extended: `claimDedup.test.js`, `retrievalV3.test.js`, `worldCoreLoop.live.test.js`,
    `extractionContextDeterminism.live.test.js`, `flagRegistry.test.js`
- Eval:
  - `eval/adapters/canonicalContextRetrieval.mjs`, `eval/fixtures/recordCanonicalWorld.mjs`
  - `eval/suites/{context-canonical-heldout.suite.mjs,retrievalScoring.mjs}`, `eval/core/gate.mjs`
  - `eval/datasets/retrieval-heldout.v1.*`, `eval/fixtures/retrieval-heldout.e6-replay.v1.json`
  - `eval/baselines/{context-canonical,context-canonical-heldout,context-dense-v3}.v1.json`

New flags (both on by default; `=off` is the rollback): `AQUA_CANONICAL_RELEVANCE_GATE`,
`AQUA_E6_COMPOUND_RETRY`. Eval-only: `AQUA_EVAL_CANONICAL_DRAIN`. No migrations.

## 9. Next three priorities

1. **Complete v4** on a host that cannot sleep, and record its decision. Then pre-register a v5
   run of *this* code against the same conditions.
2. **Slot consistency at extraction.** One canonical subject and predicate per attribute
   (launch date, price, role holder), and the change rules that rely on it. This is the
   largest remaining source of stale answers. It needs a prompt change, re-recorded fixtures
   and a *new* held-out set.
3. **Answer-level measurement of this pass:**
   - a Lift run (short personas) of the new read path vs BM25 and history, with judge
     calibration and a blinded human sample;
   - then the founder journey on the real app, compound changes included.
