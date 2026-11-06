# Pre-registration — the shipped context pipeline on long histories (Lift v4, production conditions)

Registered 2026-10-29, **before any answer exists for this code on this set**. No condition has ever
been answered or graded on v4 (`PREREG-v4-2026-10-12.md`: four attempts, none completed). The
engineer registering this has not read v4's personas, questions or labels; only structural counts
were printed (8 personas; 4 long ≈ 90k chars / ~340 turns each; 4 short 2.5–6k chars).

This is a **separate experiment** from `PREREG-v4-2026-10-12.md`. That registration tests frozen
tree `aadda450` and remains runnable from its VM kit; nothing here changes its protocol or code.

## Why

Since v4 was registered, production chat gained episodic recall (`memory/episodicRecall.js`,
2026-10-20): the user's own past messages and files, quoted beside the World Model block. Its
measured gain (v3: World Model 73.4% → World Model + recall 90.2%) is on a development set with
short histories, where recall injects the **whole** history (under `AQUA_RECALL_ALL_CHARS` = 8000
chars). On long histories recall falls back to ranked excerpts. That regime is unmeasured, and it is
where a persistent model of the user is supposed to matter.

## Question

When a user's history is far longer than the production window, does what a chat turn now carries —
the canonical World Model block plus episodic recall — answer questions about the user better than
(a) the production history window and (b) plain BM25 retrieval at the same context size? And does
the World Model add anything beyond recall?

## Fixed inputs

| Item | Value |
|---|---|
| Dataset | `eval/lift/world-model-lift-heldout.v4.json`, sha256 `86c4f7ba5e04152d92987b38aa53f89c149cc79e7f6e79e07b11e071ed8d18e9` (`FROZEN.sha256`, 2026-10-11) |
| Code under test | `main` at `b5e9694f` plus this session's working-tree changes, snapshotted (see manifest below) before launch; the run executes from the snapshot, never from the live tree |
| Database | a fresh, freshly migrated `aqua_v4_prod1029` on the disposable test Postgres (`localhost:55432`) |
| Extractor (E6) | NVIDIA `openai/gpt-oss-20b` |
| Answerer (all conditions) | NVIDIA `openai/gpt-oss-20b`, temperature 0, `liftCore.buildAnswerPrompt` |
| Judge | NVIDIA `nvidia/nemotron-3-ultra-550b-a55b` |
| Repeats | 2 per question |
| Statistics | question-clustered paired difference in mean correctness; seeded bootstrap 95% CI (4000 resamples, seed 20261006); sign test (`liftCore.clusteredComparison`) |
| Recall settings | production defaults: `AQUA_RECALL_ALL_CHARS` unset (8000), files on, "since changed" notes from the run database |

## Conditions

| Condition | Context given to the answerer |
|---|---|
| `history` | production conversation window: newest turns up to 12,000 tokens |
| `fullHistory` | the whole history (upper reference; exceeds the production window on long personas) |
| `memoryMatched` | BM25 turns up to the World Model block's size |
| `worldModel` | the canonical World Model block (`Brain.assembleContextAsync`, canonical lanes) |
| `recall` | the production episodic-recall block alone (`recallForTurn`) |
| `wmRecall` | `worldModel` block + `recall` block, joined as `routes/chat.js` joins them — **the shipped pipeline's user context** |
| `memoryProdMatched` | BM25 turns up to `wmRecall`'s size — the size-fair simple baseline for `wmRecall` |
| `legacyProd` | **what production serves today** (no Postgres): `memoryRetrieve`'s legacy block (fact store + Mind) + the PIC knowledge block + episodic recall, built by the `prepareTurn` calls after replaying every turn and document through the legacy writers with `DATABASE_URL` blank, under a separate owner |

## Primary endpoints (long personas only)

Δ(A,B) = clustered mean correctness of A minus B, 95% CI [lo, hi]. F(X) = fabrication rate,
S(X) = stale-answer rate, both on long personas.

**P1 — is the shipped pipeline better than the simple alternatives?**
`wmRecall` is SUPERIOR if Δ(wmRecall, history) lo > 0 **and** Δ(wmRecall, memoryProdMatched) lo > 0
**and** F(wmRecall) ≤ F(memoryProdMatched). It is INFERIOR to a baseline B if Δ(wmRecall, B) hi < 0.
Otherwise: NOT DISTINGUISHABLE from that baseline.

**P2 — does the World Model add value beyond recall?**
Δ(wmRecall, recall): ADDS VALUE if lo > 0; HARMS if hi < 0; otherwise NO DETECTABLE CONTRIBUTION.

**P3 — what users receive today, and what Postgres would change.**
`legacyProd` vs `history` and vs `memoryProdMatched` (same SUPERIOR / INFERIOR / NOT DISTINGUISHABLE
rule as P1); and Δ(wmRecall, legacyProd): Postgres read BETTER if lo > 0, WORSE if hi < 0, else
NOT DISTINGUISHABLE.

Decision implications, fixed now:

- P1 SUPERIOR → the shipped pipeline is the measured best production-feasible option on long histories.
- P1 INFERIOR to `memoryProdMatched` or `history` → the simpler context becomes the default candidate;
  the World Model + recall assembly must be fixed or simplified before any context-awareness claim.
- P2 HARMS → recall alone is the next default candidate; P2 NO DETECTABLE CONTRIBUTION → the World
  Model's answer-context role is unproven on long histories (its state-tracking roles are not tested here).
- P3 Postgres read BETTER → enabling the canonical read in production is supported by answer-level
  evidence; WORSE → it must not be enabled for answers as it stands.

## Secondary (reported, not decisions)

Short personas (all comparisons above); `fullHistory` as the ceiling; stale-answer rate; fabrication;
unknown honesty; per-category correctness; context tokens per question; answer latency.

## Validity gates (checked before any endpoint is read)

- Judge errors ≤ 3% of graded units, else re-judge only, same judge.
- E6 extraction errors ≤ 10% of ingested turns, else the run is invalid (infrastructure) and is rerun
  from scratch on a fresh database with the identical command; both runs are reported.
- A crash may be resumed with `--resume <partial.json>` from the **identical** snapshot and flags.
  A code or flag change voids the run.

## Run discipline

- No code, prompt, flag or threshold change in the snapshot during the run.
- Progress is monitored by unit counts only. No per-question answer, grade or progress line is read
  until the final JSON exists and the endpoints are recorded in an addendum to this file.
- After the endpoints are recorded, v4 is development data for this code line. Any fix motivated by
  its per-question failures needs a new, untouched set before a held-out claim is made.

## Known limitations, stated in advance

- v4 was written by an isolated AI agent of the same model family as the system's builders:
  synthetic, not human-independent. Only 4 long personas; the CI resamples questions, not personas.
  Effects under about 10 points are likely to come out NOT DISTINGUISHABLE.
- Free-tier 20B answerer and the harness prompt, not the production system prompt; the legacy
  gap-fill facts (`memoryRetrieve`) and the Mind block are not part of `wmRecall`.
- `wmRecall` is larger than `worldModel`; `memoryProdMatched` controls for that size, `history` does not.
  The BM25 baselines admit only turns with a positive BM25 score, so the size is a CAP, not a target:
  on the dev smoke (one short persona) `memoryProdMatched` averaged 78 context tokens against
  `wmRecall`'s 1,618. Mean context tokens per condition are reported beside every comparison.
- `legacyProd` is replayed on a synthetic clock (each turn at the time recall dates it, sessions a week
  apart, questions the day after the last session), while the World Model conditions were ingested on
  the real clock. It uses the keyword path: fact embeddings are indexed asynchronously and cannot be
  awaited in a replay, so it is a conservative reading of production.
- **Synthetic benchmark results are not evidence of real-user value.**

## Command (run from the snapshot's `aqua/`)

```
AQUA_TEST_DATABASE_URL=postgresql://aqua:aqua@localhost:55432/aqua_v4_prod1029 \
node scripts/world-model-lift-live.mjs \
  --datasets eval/lift/world-model-lift-heldout.v4.json \
  --conditions history,fullHistory,memoryMatched,worldModel,recall,wmRecall,memoryProdMatched,legacyProd \
  --history-tokens 12000 --repeat 2 --answer-provider nvidia --e6-provider nvidia --e6-model openai/gpt-oss-20b \
  --concurrency 4 --ingest-concurrency 8 --keep \
  --prereg eval/lift/PREREG-v4-production-2026-10-29.md --json eval/out/lift-v4.production-1029.json
```
