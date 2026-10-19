# World Model — validation and second iteration (2026-10-18)

Follows `WORLD_MODEL_INITIATIVE_2026-10-17.md`. Branch `aquiplex/world-model-pass2`, base `e64f26cb`,
everything **uncommitted**.

Labels:
- **MEASURED (today)** — a number from a run on this date.
- **HISTORICAL** — from an earlier report.
- **ESTIMATE** — derived, not measured.
- **NOT RUN** — the stage has not been executed.

## 0. Short version

- **v4 and the answer-level evaluation have not run.** Both are packaged, verified, and waiting on
  the VM you chose.
  - The final answer-level evaluation is frozen and pre-registered: a new set authored by an
    isolated agent, sha256 `b20c331d…`, and `PREREG-final-2026-10-18.md`.
  - **Every claim below is about state and retrieval. None is about answer quality.**
- Of the 6 stale-value failures carried over, **4 are fixed in state** and one more was found and
  fixed (a cancelled plan). The 2 that remain are a scoring artefact and an extractor
  misattribution (§2).
- The compound-change retry showed **no measurable benefit** on 70 live sentences and is now **off
  by default** (§3).
- Credentials are **still not rotated**: 17 current `.env` values appear verbatim in public git
  history. Production `main` now contains `e64f26cb` **without** the 2026-10-15 security fixes,
  which are still uncommitted (§8).

## 1. v4 (the pre-registered long-history experiment)

**Status: no result (MEASURED). Validity: no valid run exists.** Attempts 1–4 crashed; under the
prereg a crash voids the run. No answer or grade has been produced or seen.

- **Attempt 4** started 2026-10-17 12:54 IST exactly as registered:
  - snapshot byte-identical to tree `aadda450` (934 files);
  - dataset sha `86c4f7ba…`;
  - fresh 24/24-migration `aqua_v4_prereg`;
  - AC power.
- It died at 16:38:57 when Sleep was chosen from the Start menu (System log: User32 1074 from
  `StartMenuExperienceHost` → Kernel-Power 187/42). It had been ingesting the last persona, with 0
  dead jobs. Log: `lift-v4.prereg.attempt4-usersleep.log`.
- **Execution path chosen: a VM.** The validated kit was re-verified today:
  - `MANIFEST.sha256` OK;
  - archive content byte-identical to `aadda450`;
  - dataset sha `86c4f7ba…`;
  - command identical to the prereg's;
  - no restart policy (a crash stays a void run, as registered).
- Durable copy: `C:\Users\dell\aquiplex-vm-kits\v4-vm-kit\`.

```
# on an Ubuntu VM with Docker, outbound HTTPS to NVIDIA and Google only, no route to production
./make-secrets-env.sh /path/to/aquiplex-platform/.env > secrets.env && chmod 600 secrets.env   # on your machine
./run-v4.sh check && ./run-v4.sh smoke && ./run-v4.sh v4      # then ./run-v4.sh status until exit=0
```

The decision rule is applied to `out/lift-v4.prereg.json` only after it exists. Nothing in this
pass was informed by v4.

## 2. The remaining stale-value failures: root causes (MEASURED on retrieval-heldout.v1, now DEVELOPMENT data)

Each case was traced through raw extractor output → contract → S8 → worker → claims → rendered
context. The causes differ.

| Case | Root cause | Fix | Now |
|---|---|---|---|
| h003, h051 launch date | Plan `(You, plans_to, "launch publicly on April 14", intent)` vs change `(public launch, deadline_for, "May 2", revises)`: two shapes of one date; no rule compared them | S8 **plan rescheduled**: a `revises` deadline replaces exactly one current dated plan whose words contain every word of the new subject (prefix-aware), with a different date | fixed |
| h009 design lead | `(Ines, role_is, "leads design")` vs `(Ines, task_owner, design, NEGATED)`: the end of a responsibility, under another predicate | S8 **responsibility ended** (same subject, explicit end language, every distinctive word of the ended object present, exactly one candidate) | role superseded. The metric still counts a leak because the sentence also carries a still-current `works_at` claim; the rendered context shows "Ines works at Brightloop" and "Rui is responsible for design; NOT: Ines…", with the old sentence not quoted (**scoring artefact**) |
| h024 Kofi | Extractor variance. One recording gave `(Kofi, builds, Atlas)` (the new rule retires it); the other gave `(You, builds, Atlas)`, so Kofi's involvement was never stored | none in S8: retiring "You builds Atlas" would delete a true fact | **open**: extraction attribution |
| h011 blocker | `PENDING_RE` lacked the noun `blocker`, so "the sync is fixed now" retired one claim of the sentence and left `(sync, has_property, "biggest blocker")` current | add `blockers?` | fixed |
| h014 customer count | (1) The contract refused `{quantity: 57, unit: "paying clinics"}` for `has_property` (literal-typed), so the new count never committed. (2) In the re-recording the model omitted `revises` despite "now", and every revision rule requires the flag | (1) content-preserving **quantity → literal** coercion (gate ② still requires the text in the quote); (2) **`revises` from rule 11's own cues**, applied by code to the claim's span (marked `revisesInferred`) | fixed |
| found today: cancelled plan | `(You, rejected, "Porto offsite")` vs `(You, plans_to, "a team offsite in Porto in June")`; the profile kept saying it was planned | S8 **plan cancelled** (cancel language, same subject, one plan holding every distinctive word) | fixed |

Every new rule needs explicit evidence and **exactly one** candidate; with two it records an
ambiguous revision and retires nothing. Old values are **superseded, not deleted**, so history
questions still find them. S8's history is loaded per predicate, so the new rules request only the
extra predicates they need (`revisionHistoryPredicates`).

Supersessions in the world after all fixes (MEASURED): **10, all correct**, covering 9 of the
world's 10 real changes. Before this pass: 0 (worker never ran in the eval). In the first drained
run: 5, one of them wrong.

## 3. Compound-change retry (MEASURED, live Groq `gpt-oss-120b`, 30 development sentences per run, paced)

| | retry off | retry on |
|---|---|---|
| valid sentences (no transport error) | 29 | 30 |
| change clauses captured | 35 / 39 (90%) | 37 / 40 (92.5%) |
| retries fired / clauses recovered | 0 / 0 | **1 / 0** (a false trigger: "Actually" split off as a clause) |
| provider calls per turn | 1.00 | 1.03 |
| p50 / p90 turn latency | 3.2 / 8.0 s | 3.1 / 7.2 s |
| duplicate claims within a turn | 0 | 0 |

- The real misses in the on-run were claims **extracted and then dropped by validation**, after the
  coverage check had already passed. The retry, as designed, cannot see them.
- With the 8 sentences of 2026-10-17, that makes 70 live sentences with no clause recovered.
- **Decision: `AQUA_E6_COMPOUND_RETRY` default OFF** (opt-in `=on`). Code and tests are kept.
- **Idempotency finding (MEASURED):** re-running `understandTurn` on the same turn with a cleared
  extraction cache, as a retried job after a partial commit would, **added 7 claims over 3 of 29
  sentences** in one run (0 in the other). A different second reading commits beside the first.
- Turn jobs themselves are idempotent: enqueue is keyed `conversation:turn`, so a re-enqueue never
  re-processes a finished turn. The exposure is limited to a job retried *after* a partial commit.

## 4. Files and functions changed in this iteration

- `aqua/src/brain/understanding/claimDedup.js`:
  - new rules: plan rescheduled, responsibility ended, plan cancelled;
  - `blockers?` in `PENDING_RE`;
  - new export `revisionHistoryPredicates()`;
  - helpers `distinctiveObjectWords`, `RESPONSIBILITY_PREDICATES`, `ENDED_RE`, `CANCEL_RE`.
- `aqua/src/brain/understanding/extractionContract.js`: quantity → literal coercion.
- `aqua/src/brain/understanding/pipeline.js`: `inferRevises()`; `compoundRetryEnabled()` now opt-in.
- `aqua/src/brain/index.js`: S8 history requests `revisionHistoryPredicates(segment.claims)`.
- `aqua/src/core/flags.js`: `AQUA_E6_COMPOUND_RETRY` default off.
- Eval:
  - new: `eval/lift/world-model-final.v1.json` (frozen), `eval/lift/PREREG-final-2026-10-18.md`,
    `eval/lift/finalAnalysis.mjs`;
  - updated: `FROZEN.sha256`, re-recorded `eval/fixtures/retrieval-heldout.e6-replay.v1.json`,
    re-baselined `eval/baselines/context-canonical-heldout.v1.json`.
- No migrations. No production configuration changed.

## 5. Regression tests added (all passing)

- `claimDedup.test.js`:
  - responsibility ended: design role kept separate from employment; Kofi; plain negation, other
    subject, generic words and two candidates all retire nothing;
  - plan rescheduled, with negatives for no `revises`, an undated plan, and a different plan;
  - history-predicate requests;
  - blocker named as such;
  - plan cancelled, with negatives.
  - File total: 71/71.
- `extractionPrompt.test.js`: quantity coercion (49/49).
- `compoundRetry.test.js`: `inferRevises` cases; retry opt-in default; existing mechanism tests (14
  with the flag-registry file).
- Battery (MEASURED, per directory, live Postgres and Redis): **4,427 tests, 4,422 pass, 4 skipped,
  1 fail**. The failure is `perfShape.test.js` (a timing test of a perf helper, untouched), which
  passed 3/3 when re-run alone.
- Platform suite: 245/246. The failure is the pre-existing repo-hygiene check: three `.patch` files
  at the repo root dated 2026-09-29 to 10-15, not from this pass.
- Eval gate with a database: 17 suites PASS. `context-canonical-heldout` was re-baselined with a
  justification (below).

## 6. Retrieval and state metrics (MEASURED; deterministic offline replay; V3 ranker unless noted)

**retrieval-heldout.v1 (82 questions; DEVELOPMENT data since 2026-10-17):**

| | start of 10-17 | end of 10-17 | today |
|---|---|---|---|
| recall@8 | 0.821 | 0.839 | **0.893** |
| MRR | 0.712 | 0.757 | **0.792** |
| top-1 | 0.625 | 0.696 | **0.714** |
| unknown honesty | 0.192 | 0.654 | 0.615 |
| noise lines | 120 | 24 | 25 |
| stale leaks (/16) | 11 | 6 | **2** |
| facts reaching canonical claims | 95.7% | 95.7% | **100%** |

The honesty and noise cost is a single question: "Who won the last World Cup?" now receives "Our
churn last month was 3%" on the word *last*. It is known and not fixed: the improved tree is frozen
for the registered final run.

**retrieval-core.v1 (200 questions, dev), V2:** unchanged from the 10-17 baseline (recall@8 0.702,
MRR 0.620, honesty 0.750, noise 22), so the state fixes cost nothing there.

## 7. Answer-level metrics and baselines: NOT RUN

- **No answer-level number exists for the new code.**
- The registered evaluation (`PREREG-final-2026-10-18.md`) compares 7 conditions on 128 frozen
  questions × 2 repeats:
  - `fullHistory`, the 12k `history` window, BM25 `memory`, `memoryMatched`;
  - `wm-current` (tree `aadda450`), `wm-improved`, `hybrid-improved`.
- Same answerer and judge for all; long personas exceed the production window. It has three
  endpoints:
  - **E1:** did this pass improve the World Model?
  - **E2:** does structured state beat simpler memory on long histories?
  - **E3:** the same comparison on short histories.
- Judge reliability is built in: a seeded 15% sample is re-judged by a second judge family (Groq
  `gpt-oss-120b`), with κ reported, and a 60-item **blinded** sheet is produced for you to grade
  (`finalAnalysis.mjs human-sheet`).
- Results stay labelled "LLM-judged only" until that sheet is graded.
- The analysis paths were tested on synthetic grades only (random grades → no change detected, as
  they should).

Kit: `C:\Users\dell\aquiplex-vm-kits\final-vm-kit\`, both trees verified file by file. It was
validated in a simulated VM (Docker-in-Docker):

- `check` passed for both trees (npm ci, 24/24 schema);
- 6 guard tests rejected bad `secrets.env` files and a tampered kit;
- it refuses to start while v4 runs (shared NVIDIA keys).

**Run it after v4:**

```
cp ../v4-vm-kit/secrets.env . && chmod 600 secrets.env
./run-final.sh check && ./run-final.sh final        # ./run-final.sh status; after a VM restart: ./run-final.sh resume
```

Then, here, with `out/` copied back:

```
node eval/lift/finalAnalysis.mjs endpoints out/improved/final.improved.json out/current/final.current.json --out final-report.json
node eval/lift/finalAnalysis.mjs second-judge  <same two files> --out judge2.json        # ~270 Groq calls, may need 2 days of free quota
node eval/lift/finalAnalysis.mjs human-sheet   <same two files> --out review.csv --key review-key.json
```

ESTIMATE of the run: about 1,200 extraction and 4,000 answer/judge NVIDIA calls; 8–10 h.

## 8. Latency, cost, reliability

All MEASURED except where marked.

- **Retrieval latency** (canonical read, local DB, held-out world): p50 37 ms / p90 74 ms today,
  versus 30 / 59 at the end of 10-17 and 25 / 32 before the 10-17 changes. The cost comes from the
  state-slot reads and the extra S8-independent lane work; it is local and small but measured.
- **S8 duplicate detection grows linearly with history** (history load + dedup per segment per
  turn): 100 claims → 9 ms; 1,000 → 45 ms; 5,000 → 220 ms; 20,000 → 0.72 s.
  `findClaimsForDedup` has no LIMIT. It runs in the worker, not the chat request: not a pilot
  blocker, but unbounded.
- **Extraction:** the state fixes add no model calls. Compound retry: off.
- **Free-tier capacity** (MEASURED again today): back-to-back runs on Groq ran out of the
  per-minute token limit within minutes (24–25 of 30 turns errored before pacing).

## 9. Production and security gates

| Gate | Status |
|---|---|
| Credential rotation | **NOT DONE**. 17 values in the current `.env` appear verbatim in public git history (names only checked: Google OAuth client secret, Mongo URI, session secret, Razorpay key secret, Groq/Gemini/OpenRouter/Serper keys, and some non-secret values). Rotation must happen in each provider's console. |
| What production runs | Remote `main` = merge of PR #1 → `e64f26cb` (2026-10-15). It **lacks** the uncommitted 2026-10-15 security fixes (owner-adoption guard, session fixation, bundle IDOR, anonymous LLM spend, pre-auth body limit, Razorpay timing-safe compare). The RC branch from 10-16 is not pushed. |
| Feature flags | New defaults: `AQUA_CANONICAL_RELEVANCE_GATE` on (rollback `=off`, verified to reproduce old rankings), `AQUA_E6_COMPOUND_RETRY` off. Production overrides on Render: **unverified** (no access from here). |
| Isolation and deletion | Live suites pass (deleted facts do not return through sibling claims, legacy slots or re-derived copies; another owner sees none). The new S8 rules supersede, never archive or delete. Every new query is owner-scoped. |
| Corrections vs deleted facts | Archived (user-deleted) claims are excluded from every new read path (`CURRENT_STATES`/`RETROSPECTIVE_STATES` both exclude `archived`). |
| Worker durability | Turn jobs idempotent by key. Gap: a job retried after a partial commit can add a second reading (§3). |
| Migrations | none in either pass; rollback = the two flags. |
| Uncommitted changes | 49 tracked files modified + 23 untracked (this and earlier sessions). Backup: session scratchpad `wip-2026-10-18.patch` + `wip-untracked-2026-10-18.tgz`. Nothing committed, pushed or deployed. |

## 10. Strongest defensible technical evidence (today)

- **State correctness, measured and reproducible:**
  - on a frozen founder world, 9 of 10 real changes are applied as supersessions, with 0 wrong;
  - before this work: 0 applied in the eval, and 1 wrong once the worker ran;
  - the old values remain answerable as history.
- **Honest abstention:** on the held-out world the canonical read went from 19% to 62% "return
  nothing when nothing applies" (65% on 10-17), from 120–132 to 25 irrelevant lines. On the
  development set it went from 34% to 75%.
- **Discipline:** pre-registered criteria, a frozen held-out set (promoted once, then declared
  spent), and an independently authored final set frozen before scoring, with blinded human
  checking built in.
- **Not yet evidence:** that any of this gives better *answers* than full history or BM25. That is
  E1/E2 of the registered run. Until it exists, the claim stays "state tracking and abstention",
  never "beats ChatGPT/Claude/Gemini" or "beats memory".
- **Customer metrics still needed:** activation (2 distinct days in week 1), week-1/week-4
  retention, correction rate, willingness to pay. All are instrumented; none has data.

## 11. Next three priorities

1. **Run the two VM kits** (v4, then the final evaluation), record v4's registered decision and
   E1–E3, and grade the 60-item blinded sheet. This alone turns "retrieval and state improved" into
   an answer-level verdict.
2. **Rotate the exposed credentials and ship the security fixes to `main`** (with your approval).
   Production currently runs without them.
3. **Extraction attribution and idempotency:**
   - fix the remaining extractor misattribution class (helper vs owner of a project);
   - make a retried understanding job replace its own partial commit instead of adding beside it;
   - bound `findClaimsForDedup`;
   - judge all three against a *new* untouched set, since retrieval-heldout.v1 and, after its run,
     world-model-final.v1 are development data.
