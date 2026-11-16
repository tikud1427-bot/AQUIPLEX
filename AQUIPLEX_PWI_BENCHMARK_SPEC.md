# Personal World Intelligence Benchmark (PWI-v1) — Specification

**Date:** 2026-11-15.

**Question it answers.** Does Aqua's understanding of a user become more accurate as the user's world grows and changes, or does it only store more?

**Code:**

- `aqua/eval/pwi/`: `truth.mjs`, `stage.mjs`, `score.mjs`, `run-pwi.mjs`;
- dataset at `aqua/eval/pwi/dataset/`;
- harness tests in `aqua/eval/tests/pwiBenchmark.test.js`.

## 1. What is measured, and where

Aqua is driven through its **production write and read paths**, with no model call:

- **Turns:**
  - `routes/chat.js prepareTurn`;
  - persist the message;
  - `memory/turnCommit.js` commit;
  - `routes/turnPostProcess.js runPostTurn`.
- **Uploads:** the real `POST /upload` route.
- **Memory-page actions:** exactly what `routes/memory.js` calls (`correctFact` + `correctFactEverywhere`; `forgetFact`).

Two things are measured:

1. **The stores** after each stage: the legacy fact store, the Mind (beliefs, goals, working memory, graph, episodes) and the evidence lane, per user.
2. **The answer context.** For each probe, the `systemPrompt` that `prepareTurn` builds, asked in a new conversation and rolled back. This is the exact string the model would receive.

**Configuration.** The production configuration as it runs today:

- no `DATABASE_URL` (legacy read);
- no Mongo mirror;
- embeddings off;
- no provider credentials;
- a loopback-only network guard.

Every non-loopback call is refused and counted. The canonical (Postgres) World Model is **not** measured: it has no writer in production (audit C-1), and E6 writes are out of scope.

**Not measured in v1:** answer factuality and personalised answer quality. Both need model calls (an answer and a judge), which were not approved for this phase. They are reported as `null` with that reason, never estimated. §8 says how to add them.

## 2. Dataset (`pwi-v1.json`, frozen by SHA-256 before the first run)

**Users.** Four synthetic users with invented names and organisations:

| | Profile | Exercises |
|---|---|---|
| p1 | Founder, one product | team change, move, blocker resolved, chat forget, Memory-page correction, hedge, document |
| p2 | Teacher doing a PhD | job change, corrected count, moved deadline, Memory-page deletion, document, hedge |
| p3 | Freelance designer, two clients | finished project, sensitive health statement (no opt-in), moved deadline, move, collaborator leaves, chat forget of a document detail, document |
| p4 | Engineer, side project | metric change, collaborator leaves, promotion, chat forget; **shares the first name "Teodor" with p1 for isolation** |

**Events.** 57 events: 51 statements, 4 documents, 2 Memory-page actions. They are dated from January to April 2026 across 3 stages, in several conversations per stage.

**Probes.** 32 probes, asked at 1–3 stages each: 75 probe instances.

**Labels by construction.** Each event lists its effects on the user's world. The effect operations are:

| Operation | Meaning |
|---|---|
| `set` | the world changed; the old value becomes *past* |
| `add` / `remove` | collections |
| `end` | no longer true, nothing replaces it |
| `correct` | the old value was *wrong* |
| `delete` | the user asked to forget it |
| `hedge` | said only tentatively |
| `sensitive` | health or mood without opt-in |

`truth.mjs` replays the effects to get the truth at each stage. A probe names *slots*: `city`, `deadline`, `workplace@past`. The strings it requires or forbids are derived from the replayed truth, never from Aqua's output.

**Provenance and limits** are in `dataset/PROVENANCE.md`: the labels are *not* from an independent person, and why this is mitigated.

## 3. Stages, regimes, arms, restarts

**Stages:**

| Stage | Content |
|---|---|
| **A** | initial understanding |
| **B** | after additional information, including documents |
| **C** | after changes, corrections, contradictions and deletions |

**Each stage is a separate process** over the same data directory. After each stage, a **fresh process** asks the same probes again: *persistence across restarts*. Stage processes exit through the production SIGTERM handler (flush every store, drain jobs), as a deploy restart does.

**Regimes:**

- **short:** only the dataset's statements. Each user's history stays under 8,000 characters, so the recall lane quotes the *whole* history verbatim (`AQUA_RECALL_ALL_CHARS`, audit F-05).
- **long:** after each stage, unrelated conversations are added until the user's own words pass 9,000 × stage-number characters. The text is ACIB v1's frozen, label-free filler, hash-checked, with zero collisions with any of the 111 labelled terms. Recall must then rank. This is where every retained user ends up.

**Arms** (code defaults except as stated):

| Arm | Change from production defaults |
|---|---|
| `prod` | none (production today) |
| `propagation` | `AQUA_PROPAGATION=on` (one change reaches every store) |
| `hybrid` | `AQUA_HYBRID_CONTEXT=on` (information-needs check block) |

## 4. Metrics (per stage; definitions in `score.mjs`)

**Text rules:**

- **Matching:** whole-token, case- and accent-insensitive, against the dataset's surface forms.
- **Presented as current:** a value is "presented as current" when it occurs on a context line with no history, change or uncertainty marker. The marker rule is `truth.mjs MARKED_LINE`.
- **Recall quotes:** dated recall quotes (`[2026-01-08 · …]`) are history by construction. Stale values inside them are reported separately (`staleQuoted`, `…WithChangeNote`).
- **Arrows:** graph arrows are not markers.

| # | Category | Metric | Definition |
|---|---|---|---|
| 1 | Factual | **Claim recall** | current slot values found in the current facts or Mind (per source: chat / document) |
| | | **Claim accuracy** | captured, **and** no past or wrong value of that slot still held as current |
| 2 | Relationship | **Entity P / R** | Mind graph nodes (excluding self, goal and technology nodes) vs labelled live entities. Recall is graph-only over non-place entities (the graph has no place type), and structured (graph or fact) over all. Type agreement is reported separately |
| | | **Relationship P / R** | graph edges between entity/self nodes vs labelled live relations, either direction. Edges for ended or deleted relations are counted as stale |
| 3 | Temporal | **Temporal probe accuracy** | temporal probes with every required value present and no stale value unmarked |
| | | **Stale-unmarked rate** | stale checks (past/wrong values of probed slots) found unmarked in structured lanes |
| 4 | Cross-source | **Cross-source completeness** | completeness on document + chat probes; document items separately |
| 5 | Personalised reasoning | **Context completeness / precision on decision probes** | the context a good decision needs, at context level only (§1) |
| 6 | Correction propagation | **Store views consistent** | for each correction (and, separately, each world change): the old value is *not current* in facts, Mind and the evidence lane (3 views each) |
| | | **Context consistent** | the old value is not presented as current on probes about that slot |
| 7 | Contradiction | **Detected in store** | the store keeps the old value as history (fact history, transitions, later-word, retired items, ended) |
| | | **Handled in context** | as context-consistent, over all changes |
| 8 | Uncertainty | **Hedged as fact** | hedged values held as a current fact or Mind item |
| | | **Hedged unmarked** | hedged values unmarked in the context |
| | | **Unknown acknowledged** | probes about something never said whose context says it is unknown |
| 9 | Deletion and privacy | **Store compliance** | deleted and sensitive values absent from facts (incl. history and source text), the whole Mind and the active evidence lane. Reported per store, with *held* vs *source text only* |
| | | **Context violations** | deleted or sensitive values in any probe context |
| — | Isolation | **Cross-user leaks** | another user's canary tokens in this user's stores or contexts |
| 10 | Persistence | **Identical after restart** | per-probe measurement vectors and per-user store measurements, run vs fresh process |
| — | Retrieval | **Relevance (precision)** | required present ÷ (required present + this user's other current facts present). The name is excluded (the identity card is shown on every turn by design) |
| — | Retrieval | **Context completeness** | required items present. Each miss is classified **capture** (in no store) or **retrieval** (stored, not in the context) |
| — | Quantity | facts / nodes / edges / evidence | reported beside accuracy so that "more stored" is never read as "understands better" |

**Benchmark vs infrastructure failures.**

- **Infrastructure failures** (recorded in `infra`, never scored):
  - an event, probe, upload or snapshot that **throws**;
  - a stage process that exits other than through the shutdown path;
  - any blocked network call.
- **Benchmark failures:** measured misses only.

## 5. Reproducing

```
cd aqua
node eval/pwi/run-pwi.mjs --arms prod,propagation,hybrid --regimes short,long --out <dir>
node scripts/run-tests.mjs eval/tests/pwiBenchmark.test.js     # the harness itself
```

- **Inputs:** no network, database or credentials. The runner strips them from the child environment.
- **Duration:** about 2 s per stage process.
- **Outputs:**
  - raw stage outputs (`<cell>/<stage>.run.json`, `.verify.json`, with the exact contexts and store snapshots);
  - scores (`<cell>/<stage>.score.json`);
  - `summary.json` + its SHA-256.
- **Freeze check:** the runner refuses a dataset whose hash differs from `pwi-v1.json.sha256`.

## 6. Known limitations

1. **Labels.** The labels are authored by the same agent that built the system and the benchmark (see PROVENANCE). They are mechanical, frozen before any run, and still need independent review before gating.
2. **Size.** Four users and 75 probe instances is a small set. Per-category numbers rest on 2–20 checks each, and the report states the denominators.
3. **Context level, not answers.** A required value in the context does not mean the model uses it. A stale value marked "previously" may still be misread.
4. **Text rules.** "Presented as current" is a line-level rule. A value on a line with an unrelated marker word is counted as marked, which favours the system. The dated-quote rule also favours the system, which is why quoted stale values are reported separately.
5. **No place nodes.** The graph has no place type, so place entities can only be captured as facts. Graph recall excludes them, and that is stated.
6. **Clock.** The scenario clock replaces `Date`. `performance.now` and timers run in real time, and no store logic found depends on them for ordering.
7. **Canonical World Model and E6 not measured** (by scope). The benchmark design applies unchanged once they are enabled: same stores interface, plus a claims view.

## 7. Thresholds

Recommended release thresholds are in the baseline report. They are proposals for the founder's decision, not gates yet. No gate baseline was created, so `eval/gate.mjs` is unchanged.

## 8. Extending to answer level (needs approval)

- **Mechanism:** `scripts/answer-eval.mjs` plus `eval/answer/` already provide an answer runner and a judge rubric, with an approval switch (`AQUA_ANSWER_EVAL_APPROVED=yes`) and a cost cap.
- **Change needed:** PWI probes would add an `expect` field (the facts an answer must use and must not assert), plus a rubric for personalised quality.
- **Cost estimate:** one answer and one judge call per probe instance and arm. That is 75 × 2 × arms calls, on the existing free-tier key pool.
