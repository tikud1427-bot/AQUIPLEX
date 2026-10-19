# Pre-registration — final answer-level evaluation (world-model-final v1)

Registered 2026-10-18, **before any condition has been run on this set**. Nobody has run, read or
graded an answer on it. The dataset content has not been read by the engineer who changed the system
(only structural counts were printed when it was frozen).

## Fixed inputs

| Item | Value |
|---|---|
| Dataset | `eval/lift/world-model-final.v1.json`, sha256 `b20c331da465907cc451b7bfe40ca02ddfc633062a770ed4d7f88917d3ed67e2` (`FROZEN.sha256`, 2026-10-18 19:16 IST) |
| Authoring | an isolated agent given only a written spec (schema, coverage, rubric rules); no access to code, earlier datasets or failures. Same model family as the system's builders: **not human-independent**. |
| Composition | 6 personas: 4 short (2.5–4.2k chars of history; fits every window), 2 long (≈61k chars ≈ 15k tokens; exceeds the 12k production window). 128 questions (72 short, 56 long), 20 `expectUnknown`. |
| Code: current World Model | git tree `aadda450` (the v4-registered code), verified byte-identical, 934 files |
| Code: improved World Model | snapshot of the working tree on 2026-10-18 after Phase 2, manifest sha256 `bc89f7108d0d4419…` (962 files); `AQUA_CANONICAL_RELEVANCE_GATE` on, `AQUA_E6_COMPOUND_RETRY` off (defaults) |
| Extractor (E6) | NVIDIA `openai/gpt-oss-20b` (as v4) |
| Answerer (all conditions) | NVIDIA `openai/gpt-oss-20b`, harness template `liftCore.buildAnswerPrompt` |
| Judge | NVIDIA `nvidia/nemotron-3-ultra-550b-a55b` |
| Repeats | 2 |
| Statistics | question-clustered paired difference in mean correctness, seeded bootstrap 95% CI (4000 resamples, seed 20261006), sign test (`liftCore.clusteredComparison`) |

## Conditions

| Id | Code | Context |
|---|---|---|
| `fullHistory` | improved harness | the whole history, unbounded (fits the answer model's window for all personas; for long personas it exceeds the 12k production window — reported as the upper reference, not the production baseline) |
| `history` | improved harness | production window: newest turns up to 12,000 tokens |
| `memory` | improved harness | BM25 top-8 past turns |
| `memoryMatched` | improved harness | BM25 turns up to the World Model block's size |
| `wm-current` | tree aadda450 | `worldModel` condition of that tree |
| `wm-improved` | improved snapshot | `worldModel` condition |
| `hybrid-improved` | improved snapshot | improved World Model block + `memoryMatched` turns |

Command per tree (from its `aqua/`), on a fresh migrated test database each:

```
AQUA_TEST_DATABASE_URL=<fresh db> node scripts/world-model-lift-live.mjs \
  --datasets eval/lift/world-model-final.v1.json \
  --conditions <improved: fullHistory,history,memory,memoryMatched,worldModel,hybrid | aadda450: worldModel,hybrid> \
  --history-tokens 12000 --repeat 2 --answer-provider nvidia --e6-provider nvidia --e6-model openai/gpt-oss-20b \
  --concurrency 4 --ingest-concurrency 4 --keep --json eval/out/final.<tree>.json
```

(The aadda450 tree's `hybrid` is reported for completeness; it is not an endpoint.)

## Primary endpoints and decision rule

Δ(A,B) = clustered mean correctness of A minus B with 95% CI [lo, hi]. F(X) = fabrication rate, S(X) = stale-answer rate.

**E1 — did this pass improve the World Model?** All personas. `wm-improved` vs `wm-current`:
IMPROVED if lo > 0; WORSE if hi < 0; otherwise NO DETECTABLE CHANGE.

**E2 — does structured state beat simpler memory where history does not fit?** Long personas only.
For C ∈ {wm-improved, hybrid-improved}: SUPERIOR if Δ(C, history) lo > 0 **and** Δ(C, memoryMatched) lo > 0 **and** F(C) ≤ F(memoryMatched).
If neither C qualifies: report which simpler condition is best. No superiority claim is made in that case.

**E3 — short histories.** Same comparison against `fullHistory` and `memoryMatched` on short personas; reported, no claim unless lo > 0 for both.

The first applicable result of each endpoint is the decision; nothing is re-run to change it.

## Secondary measures (reported, not decisions)

Stale-answer rate, fabrication rate, unknown honesty, per-category correctness (state_change, correction, compound, history, temporal, conflict_document, disambiguation, multi_hop, consequence, attribution, negation, synthesis), required-fact recall, answer latency, context tokens per question, provider calls.

## Validity gates (checked before reading any endpoint)

- Judge errors ≤ 3% of graded units (else re-judge only, same judge).
- E6 extraction errors ≤ 10% of ingested turns per tree (else rerun that tree from scratch on a fresh DB).
- A crash before completion: resume with `--resume <partial.json>` on the **identical** code and flags is allowed (this is not the v4 protocol); a code or flag change voids the run.
- **Judge reliability:** a seeded random 15% of graded units is re-judged by a second judge from a different family (Groq `openai/gpt-oss-120b`); Cohen's κ on `correct` is reported. If κ < 0.6 the endpoints are reported as unreliable.
- **Human check:** a seeded random sample of 60 answers (balanced across conditions, condition labels hidden, order shuffled) is graded by a human against the same rubric; agreement with the judge is reported. Until it is done, results are labelled "LLM-judged only".

## Run discipline

- No code, prompt, flag or threshold change in either tree between this registration and the end of both runs.
- No per-question output is read before both JSON files exist and the endpoints above are recorded in an addendum.
- After the endpoints are recorded the set becomes development data. Any fix motivated by its failures needs a new untouched set.

## Known limitations, stated in advance

- Same-model-family authorship; synthetic; 6 personas (2 long), so persona-level variance is not captured by a question-level CI. Effects under about 10 points are likely to be indistinguishable.
- A free-tier 20B answerer and the harness prompt, not the production system prompt.
- Deletion and account isolation are not graded here (they are covered by the live regression suite).
- Synthetic benchmark results are not evidence of real-user value.
