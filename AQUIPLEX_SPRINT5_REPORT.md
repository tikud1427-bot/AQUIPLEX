# AQUIPLEX Sprint 5 — Safe Release, Shadow Observation & Hybrid Context Design

**Date:** 2026-11-11

## Repository

| Item | Value |
|---|---|
| Root | `C:/Users/dell/Downloads/aquiplex-platform/aquiplex-platform` |
| Branch | `main` |
| HEAD | `839ea0d167025e1ad7085668727ff65452d51335` (verified at start and end) |
| Working tree at start | 105 paths (36 modified, 69 untracked) — all Sprint 1–4 work, preserved |
| Working tree at end | 110 paths: the 105 plus 5 new documents and this report (this report makes 111) |
| Commits, pushes, deploys, Render or environment changes, migrations | **none** |
| Paid model, embedding or external AI API calls | **none** |
| Real user store (`~/.aquiplex/.aqua-mind.json`) | not accessed; mtime 2026-11-10 11:18:28, unchanged |
| Frozen datasets, scorers, baselines | unchanged; `acib.v2.eval.json` sha `002208e4…` intact |

## 1. Verified facts

1. **Capture Integrity V1 is separable from the rest of the work.**
   - `speechAct.js`, `memorySchema.js` and `goalTracker.js` contain only capture changes.
   - `candidateExtractor.js` and `memoryExtractor.js` mix capture hunks with Sprint 1 log-safety hunks. Both depend on `core/logSafety.js` (untracked, Sprint 1; imports only `node:crypto`).
   - Capture and the Information Needs engine do not import each other.
2. **Capture behaves as intended.** 45 sentences across all eight requested categories were run against the working tree and against a read-only `git archive HEAD` export. Every difference is an intended fix; there are **no regressions** in the set.
   - Removed: `siblings=Work`, `spouse=Called`, `siblings=Works`, `spouse=Isn'T`.
   - Removed: the truncated workplace "…and earn 58".
   - Removed: goals created from requests.
   - Newly captured: "joined X as…" and "started a new job at X".
3. **Pre-existing capture gaps** (unchanged; the words stay quotable in recall):
   - "I moved to Lisbon" and "I quit my job at Fenwick" store no fact;
   - "I earn $58,000 a year" has no income pattern.
4. **Existing stored data is not modified.**
   - Statically: the capture diff adds no store access, migration or backfill.
   - Dynamically: legacy bad values in an isolated store were byte-identical after unrelated turns.
5. **The shadow path is sound, from source:**
   - The gate is three-way.
   - Only `on && applied` changes the prompt.
   - `prep.infoNeeds` never reaches the HTTP response.
   - The engine has no `console` output, and no provider, fetch or embedding path is reachable from it. The only embedding trigger in `episodicRecall` lives in `recallForTurn`, which the engine does not call.
   - Logs carry counts, labels, `err.name`, an HMAC owner and the request id.
   - `/api/aqua/provider-health` is behind `requireLogin` (`index.js:665–692`).
6. **Shadow re-reads history.** It **adds** a second whole-history read per eligible turn; it is not shared with recall. This corrects a statement in the Sprint 4 readiness document.
7. **The answer-evaluation package has two gaps:**
   - **no judge executor** — nothing sends the judge requests to a model;
   - **no retry or resume.**

   The repository deliberately ships **no price table**. The Sprint 4 figures of $0.59 / $0.79 per MTok were illustrative arguments, not prices.
8. **`chat.js` hash note.** Its current hash (`925d1b82…`) differs from the hash recorded in Sprint 4 (`146a07c1…`). The cause is the Sprint 4 `reason=` log-field addition, made after that record. It is log-only, and the ACIB adapter does not read logs, so it has no effect on any ACIB result.

## 2. Test results (this sprint; commands run from `aqua/`)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs src/memory src/mind src/understanding` | 865 tests — **858 pass, 0 fail**, 7 todo (the known todos) |
| `node scripts/run-tests.mjs src/routes` | **335/335 pass** |
| `node scripts/run-tests.mjs src/brain/tests/informationNeeds.test.js src/brain/tests/informationNeedsV2.test.js eval/tests/answerGrader.test.js` | **48/48 pass** |
| `node --test <scratchpad>/s5/shadowFail.test.mjs` — new and **not added to the repository**: under `shadow`, a failed provider on `/chat` and `/chat/stream` leaves no fact, goal or persisted user message | **2/2 pass** |
| Scratch verification scripts `s5/verify.mjs` (working tree vs HEAD export) and `s5/stored.mjs` (legacy data untouched) | outputs as reported in the capture review |

**Not re-run this sprint:**
- the full battery (Sprint 4: 5,035 pass, 3 fail — `repoHygiene` pre-existing and 2 load-timing failures that pass alone);
- `eval:gate` (Sprint 4: BLOCKED, with explained movements);
- the platform tests.

No source file changed in Sprint 5.

## 3. Architecture proposals (not implemented)

- **Hybrid context** ([AQUA_HYBRID_CONTEXT_ARCHITECTURE.md](AQUA_HYBRID_CONTEXT_ARCHITECTURE.md)). The existing context stays intact. V2 *adds* only:
  - strong, de-duplicated evidence;
  - conflict, change and ambiguity notes;
  - unknowns **verified against the existing context**, so a lexical miss never becomes a false "Not known".

  Behaviour is specified for each case in the brief, under a token budget, a work budget and a post-hoc time discard. Flags: `AQUA_HYBRID_CONTEXT` (`off` / `shadow` / `on`), `AQUA_HYBRID_MAX_TOKENS`, `AQUA_HYBRID_MAX_MS`, and a separate later `AQUA_HYBRID_PRUNE`. The document includes pseudocode, risks, 18 test cases and bite checks.
- **ACIB v3 benchmark plan** ([AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md](AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md)):
  - independent authors;
  - eval set (150) frozen and reviewed before implementation; dev set (54);
  - a semantic-mismatch category;
  - answerability labels and false-unknown accounting;
  - scorer v3 frozen with the set;
  - one run per implementation;
  - proposed success criteria.

## 4. Unverified assumptions

- **Production.** Production runs the source reviewed here. Render's Node version, environment, instance count, log retention and mirror state were not inspected.
- **Latency.** Engine latency on real (large) histories is unmeasured; it is measured only on synthetic histories.
- **Hybrid thresholds.** Strength thresholds and budgets (400 tokens, 50 ms) are hypotheses, to be fitted on the dev set.
- **Benchmark power.** The power estimate for 150 paired scenarios is approximate.
- **Providers.** Whether candidate providers accept `seed`, and their real prices.
- **Judge blinding.** It may be weakened by stylistic tells in arm B's answers. A probe is proposed.

## 5. Decisions requiring founder approval

1. **Release unit for Capture Integrity.** The recommendation is capture together with Sprint 1 log safety for the two mixed files. Whether to build that commit series is your decision.
2. **Deploy, then `AQUA_INFO_NEEDS=shadow`,** following the checklist and rollback procedure in [AQUIPLEX_SPRINT5_SHADOW_READINESS_REVIEW.md](AQUIPLEX_SPRINT5_SHADOW_READINESS_REVIEW.md).
3. **Whether to add the scratch failed-turn shadow test to the repository.**
4. **Hybrid context:** approve implementation behind `AQUA_HYBRID_CONTEXT=off`.
5. **ACIB v3:**
   - who the independent authors are;
   - the success criteria;
   - who reviews and signs off the freeze.
6. **Answer evaluation:**
   - answering model and judge model (exact versions, prices);
   - the spend ceiling;
   - approval to build the judge executor, retry/resume and spend ceiling (code, no paid calls);
   - whether to run on `acib.v2.eval` (valid for answer-level comparison) or wait for v3.
7. **Gate baselines** (carried over from Sprint 4): accept the improved `acib-v1` and `capture-core` movements?

## 6. Files

**Created (6, all at the repository root):**
- `AQUIPLEX_SPRINT5_CAPTURE_RELEASE_REVIEW.md`
- `AQUIPLEX_SPRINT5_SHADOW_READINESS_REVIEW.md`
- `AQUA_HYBRID_CONTEXT_ARCHITECTURE.md`
- `AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md`
- `AQUA_ANSWER_EVALUATION_COST_REVIEW.md`
- `AQUIPLEX_SPRINT5_REPORT.md`

**Modified:** none. No source, test, dataset, scorer or baseline file was changed in Sprint 5.

**Outside the repository:** scratch scripts in the session scratchpad (`s5/verify.mjs`, `s5/verify-head.mjs`, `s5/stored.mjs`, `s5/shadowFail.test.mjs`, and a read-only HEAD export under `s5/head/`).
