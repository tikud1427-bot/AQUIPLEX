# Temporal continuity — answer-level paired evaluation (plan, 2026-11-02)

**Status: designed, dry-run verified, NOT run.** Written before any answer exists. It is not run
while Lift v4b retry2 is live (pid 10568 on 2026-11-02): it must not share Groq/Gemini quota, the
Postgres container or the v4b run directory.

## Question

Does the evidence produced by the temporal-continuity work (episodic-recall follow-ups, entity
continuity, PIC Lane 7, Context Engine seating, ranking by later word, vocabulary forms) make the
**answer** more often current and less often stale, without more fabrication or less abstention?
The retrieval-level gains (`scripts/temporal-resolution-eval.mjs`) do not answer this.

## Arms (paired, same questions, same contexts as the retrieval metric)

| Arm | Code | How contexts are produced |
|---|---|---|
| before | the tree as it stood before 2026-11-02 — a **scratch copy** of the v4b-retry2 snapshot, taken after that run has ended; verified file-by-file against the current tree for every file this work did not touch | the current `temporal-resolution-eval.mjs` and datasets copied into the scratch tree, `--emit-contexts contexts.before.json` |
| after | current development tree | `--emit-contexts contexts.after.json` (dry run done: 155 questions × 3 regimes) |

Both arms with `--profile dev-env` **and** `--profile code-defaults` (production's flag values are
unknown; under code defaults the evidence lane holds no conversational facts and only recall changes).

## Data and regime

Development sets only: `world-model-lift-heldout.v3` (development since its run was read),
`temporal-resolution.dev.v1`, `vocabulary-continuity.dev.v1`. Never `heldout.v4` or `final.v1`
(the scripts refuse them). Primary regime: `padded` (long history, ranked recall) — where the
changes act. `short` is reported as a control (recall quotes everything; contexts should barely differ).

**Primary subset:** questions whose `padded` context differs between arms, plus every
`expectUnknown` question (abstention/fabrication guard). Questions with identical contexts are not
answered (same input → no causal contrast); their count is reported.

## Answerer, judge, cost

- Answerer and judge on the NVIDIA free tier (not used by Lift): `openai/gpt-oss-20b` answers,
  `nvidia/nemotron-3-ultra-550b-a55b` judges (98% agreement / κ 0.96 with the Gemini judge,
  measured 2026-10-06). Temperature 0, 2 repeats. No paid API.
- Expected size: ≤ 155 questions × 2 arms × 2 repeats ≈ 620 answers + 620 judgments at most;
  the primary subset is smaller. At 20–70 s per NVIDIA call, budget 6–10 h; it can be split by
  `--questions` and merged with `--merge`.

```
node scripts/lift-legacy-answers.mjs --datasets <sets> --contexts-from eval/out/contexts.before.json --regime padded \
  --answer-provider nvidia --judge-provider nvidia --repeat 2 --questions <primary subset> --json eval/out/answers.temporal.before.json
# same with contexts.after.json → answers.temporal.after.json
node scripts/lift-legacy-answers.mjs --compare eval/out/answers.temporal.before.json,eval/out/answers.temporal.after.json
```

## Metrics (liftCore: question-clustered bootstrap, sign test)

| Metric | Definition |
|---|---|
| current-state correctness | `correct` on questions with a `forbidden` item (state_change, correction, negation, preference) |
| stale-answer rate | `stale` (a forbidden item asserted) on those questions — **primary endpoint** |
| historical correctness | `correct` on `temporal` questions labelled `historical` |
| fabrication | `fabricated` on all questions |
| abstention | `unknown_honesty` on `expectUnknown` questions |
| provenance accuracy | **not graded by the current judge.** Proposed judge item (new judge version, frozen before use): "when the answer attributes a statement to the user or to a time, is the attribution correct per the history?" |

## Decision rules (fixed now)

1. Adopt as an answer-level improvement only if the stale-answer rate falls with a 95% CI excluding 0.
2. Overall correctness non-inferior: lower CI bound above −3 points.
3. Fabrication must not rise and abstention must not fall beyond their CIs.
4. Context tokens +25% at most (retrieval-level: +3%).
5. Report dev-env and code-defaults separately; a gain under dev-env only is a gain conditional on
   `AQUA_BRAIN_INGEST(_FACTS)=on` in production.

## What it cannot show

Development data authored partly by the session that built the change, and synthetic padding. A
claim beyond development data needs a new, untouched set written before the run.
