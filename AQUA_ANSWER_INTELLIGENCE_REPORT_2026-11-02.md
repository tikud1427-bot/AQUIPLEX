# Aqua answer intelligence — report (2026-11-02)

Main development tree, uncommitted. Lift v4b (pid 10568) untouched; no provider calls; no
Postgres-backed tests; no baseline changed.

**Bottom line.** No model call was safe to make (§2), so no answer was generated or graded:
**answer-level metrics are unmeasured.** What *was* measured is the exact user context the
answer model receives on the production legacy read, read section by section. That showed a
failure the retrieval metrics never could. The block the prompt presents as the user's
**current state** — the cognitive model, injected on every turn — kept resolved blockers,
moved deadlines, completed and changed goals, and invented "deadlines" from sentence
fragments. It now follows the user's own later words. Measured on development data:

| Memory block (what the prompt frames as authoritative / current) | Before | After |
|---|---|---|
| Outdated value presented as current, answer-intelligence set (6 change questions) | **50.0%** | **0.0%** |
| Same, all dev sets (only the new set labels outdated values; undercounts) | 10.0% | 2.9% |
| "Deadlines" in *Current state* that name no date | **79 / 79** | **0 / 62** |
| Evidence, recall and combined-context metrics (all sets, both flag profiles) | — | unchanged |
| Context tokens per question | 839 | 847 (+1%) |

The change is active in production **whatever the `AQUA_*` flags are**: the Mind runs on the
legacy read by default (measured identically under `--profile code-defaults`).

## 1. Verified production answer path (code, not docs)

`routes/chat.js prepareTurn` → `buildSystemPrompt` (`core/promptBuilder.js:89`). No
`DATABASE_URL` → `Brain.canonicalReadMode()` = legacy: no canonical World Model, its
supersession, provenance or modality reaches an answer. Prompt order:

1. System prompt and instruction hierarchy, then Aqua's identity.
2. **Memory block** (`memory/engine.js memoryRetrieve`, legacy mode). In order:
   - user IDENTITY ("authoritative");
   - USER PROFILE (legacy fact store, undated, "If asked about these topics, rely on this profile");
   - COGNITIVE MODEL (`mind/mindRetriever.js`): Identity, Preferences, **Active goals**,
     **Current state** (focus, blocked on, deadline, open question), **Anticipated need**;
   - RELATED KNOWLEDGE (Mind relationship graph), PAST EPISODES, KNOWN FILES.
3. Reasoning and cognition directives.
4. Fenced as **untrusted material**: the evidence block (PIC floor, or the Context Engine
   if `AQUA_CONTEXT_V2=on`), then the episodic-recall quotes.
5. Task modules.

Post-turn (`routes/turnPostProcess.js`): Mind reflection every N turns (its only cleanup was
a 7-day / 14-day timeout), conversational fact ingest (only with
`AQUA_BRAIN_INGEST(_FACTS)=on`), E6 queue (only with Postgres).

**Can the answer model tell current from past?**

| Distinction | Evidence block | Recall quotes | Memory block (before this pass) |
|---|---|---|---|
| Current vs used to be | ordered oldest→newest + "later is current" note | dated, ordered, "newer replaces older" | **no** — profile undated; cognitive model never updated |
| What changed / corrected | order only; no "corrected" mark | order; "since changed" notes from fact-store history | **no** |
| Still unresolved | — | — | blockers kept, but expired after 7 days even when open |
| Uncertain | hedge words verbatim only | verbatim | none |
| Confidence | every conversational fact 0.60 (no signal) | — | "inferred, NN%" on beliefs only |

The structural problem: the block that arrives **first and is framed as current/authoritative**
was the least temporally aware; the carefully ordered evidence arrives **last, framed as
untrusted**. Architecture gap: the World Model's typed supersession and modality never reach
production answers (legacy read).

## 2. Evaluation methodology

- **No model calls.** No local generative model is installed (no Ollama, llama.cpp, LM Studio
  or cached GGUF/ONNX LLM; Transformers.js is set up for a reranker only). Obtaining one means
  downloading weights and running CPU inference on a host with 3.5 GB free RAM that is running
  the live multi-week Lift (attempt 1 was lost to a host reset). Hosted providers share Lift's
  quota. A small local model's answers would also say little about Aqua's answers.
- **Deterministic, section-aware context evaluation** (`aqua/scripts/temporal-resolution-eval.mjs`):
  - Replays each history through the production legacy writers (`eval/lift/liftLegacy.mjs`)
    plus recall, so the context is what the production turn receives.
  - Regimes: short, ranked, and padded with neutral filler (long history, ranked recall).
  - Two flag profiles: the dev `.env` switches, and `code-defaults` (every `AQUA_*` unset).
  - New metrics: stale value presented as current (memory block); undated "deadlines"; irrelevant
    same-subject facts shown. Plus the existing ones: resolution coverage, stale-without-update,
    current/historical coverage, false matches, unknown-question lines, tokens.
- **New case set** `aqua/eval/datasets/answer-intelligence.dev.v1.json` (+ labels; sha256
  `b2a8e271…` / `f030c040…`). Ten scenarios:
  1. plan → blocker → resolution
  2. correction
  3. goal change
  4. preference change
  5. two true statements from different times
  6. current truth
  7. previous truth
  8. unanswerable
  9. outdated fact beside its resolution
  10. several related facts, few relevant

  Also uncertainty vs contradiction, and a completed commitment. Each question has explicit
  `required`/`forbidden` items for a model judge, and deterministic labels (`current`, `stale`,
  `staleValue`, `historical`, `irrelevant`, `mustNot`).
  - **Caveat:** development data, written after the cognitive-model failure was observed.
  - Run together with v3 (development since its run was read) and the two dev sets from
    earlier today: 168 questions.
- **Answer-level pair, ready, not run.** Recorded contexts:
  - before the fix: `eval/out/contexts.before-mind.{dev-env,code-defaults}.json`
  - after: `contexts.after-mind.*`

  Same harness, data and padding; the code differs only by this pass. 121 of 168 questions'
  prompts differ (the cognitive block is per user). Run, when allowed:
  `scripts/lift-legacy-answers.mjs --contexts-from … --regime short --questions <the 121>`,
  then `--compare`, under `TEMPORAL_ANSWER_EVAL_PLAN_2026-11-02.md` decision rules.

## 3. Before / after

Answer level: **not measured** (§2).

Context level, padded regime (ranked recall), all 168 questions. Identical under both flag
profiles except the evidence lane, which is empty under code defaults:

| Metric | Before | After |
|---|---|---|
| Outdated value presented as current (memory block) | 10.0% | **2.9%** (h1-q11, v10: legacy profile lines) |
| Undated "deadlines" in Current state | 79/79 | **0/62** |
| Memory block: current-state statement present | 1.0% | 9.6% |
| Combined: resolution coverage / stale without update | 96.9% / 2.9% | 96.9% / 2.9% |
| Combined: current / historical coverage | 96.2% / 100% | 96.2% / 100% |
| False matches on 7 look-alike controls | 2 | 2 (pre-existing) |
| Lines on unanswerable questions | 13.71 | 13.71 |

Cognitive-model lines, short regime, as the answer model now reads them (before → after):

| User | Before | After |
|---|---|---|
| h1 | `deadline: launch on November` | `deadline: the launch is December 16, not December 9` |
| h3 | `deadline: before 6` | `deadline: My proposal deadline was extended to March 7` |
| h5 | `deadline: before dec` | `deadline: The thesis deadline moved to June 13` |
| h7 | `deadline: by March` | `deadline: The new finish date for the kitchen is April 5` |
| h4 | `blocked on: a zoning permit` | (gone; the permit came through) |
| t1 | `blocked on: FCC certification`; goal `"ship the first batch on March 3"` | blocker gone; goal `(since changed — they said: "Shipping slips to April 20, …")` |
| a01 | `blocked on: Apple's review` | gone; goal "launch on May 6" kept (still true) |
| a03 | goal `"run a marathon"` | `"run a marathon" (since changed — they said: "… a half marathon instead …")` |
| a10, t2, v05 | completed goals or deadlines active | completed; not shown as current |
| h6, t4 | `open question: hat..` / `ull overhaul` | the user's whole clause |
| t4, n01 | still-open blockers | **kept** (still open) |

## 4. Individual failure analysis

| Failure | Cause | Fixed? |
|---|---|---|
| Resolved blocker shown as "Current state" (h4, t1, a01) | Temporal interpretation — working memory only added; removal was a timer | Yes |
| Open blocker would expire after 7 days while the user reports it open (t4) | Temporal interpretation | Yes ("still no word" keeps it) |
| Moved / corrected deadline kept (h1, h7, h3, h5, v05) | Capture (label cut at the date's first token, no subject) + temporal interpretation | Yes |
| Fake deadlines "before 6", "before 1", "before deciding" | Capture — clock times and "dec"/"deciding" matched (no word boundary) | Yes |
| Completed goal active (a10, t2) | Temporal interpretation — completion knew "finished/shipped/launched…" only | Yes |
| Changed goal active (a03, t1, v02) | Temporal interpretation | Yes — annotated with the user's words, title kept |
| Completed goal still walked as `←targets— user` in the graph block (a10) | Context construction | Yes — not walked; edge kept |
| Multi-change message read as one ("Boxwell is out" abandoning the shipping goal) | Temporal interpretation — found by this eval mid-fix | Yes — read per clause |
| Fragmented open questions | Capture | Yes |
| Outdated profile values (h1-q11 "mentoring Ana", v10 "Honda Civic") | Legacy fact store: only "my X is now Y" / "X moved to Y" supersede | No — next (§8) |
| coffee ↔ caffeine, "live" ↔ "relocated" (t2-q04, v09) | Retrieval — no shared word; needs semantics | No |
| Same-subject but irrelevant facts shown (a08: 3/3) | Retrieval; low harm (same subject, small) | Not changed on one case |
| Historical question missing in recall under code defaults (1 of 6) | Retrieval | No |

## 5. Changes and why

All deterministic, user-words-only, history-preserving, in existing files:

- `understanding/stateTransition.js` — new helpers:
  - `closes`/`closeKind`: resolution vs ending, ignored when negated or hedged ("hasn't
    arrived yet", "once Apple approves it");
  - `datesIn`; `subjectShared` (ignores date words); `clausesOf` / `partAbout` (several changes
    in one message read per clause); `clauseWith`.
- `mind/workingMemory.js` — `applyLaterWords`:
  - a closing message retires a blocker to `resolvedBlockers` (when + the message);
  - "still no word" keeps a blocker open;
  - a dated change, correction or closing retires a deadline to `pastDeadlines` and records
    the new one in the user's clause;
  - open questions are recorded as whole clauses.
- `mind/observers.js` — deadline label = the user's clause through the full date; clock times,
  bare numbers and month look-alikes rejected; "due on" recognised.
- `mind/goalTracker.js` — `laterWordOnGoals`. Applies only when the message is about one goal
  (two shared words; or one distinctive word; or one word plus a reschedule):
  - resolution → COMPLETED; ending → ABANDONED;
  - change → `changedBy`: the title is never rewritten; restating the goal clears it;
  - history entries for every change.
- `mind/mindRetriever.js` — changed goals render with the user's words.
  `mind/predictionEngine.js` — no forecast from a changed plan.
- `mind/graphRecall.js` — closed or changed goals are not walked.
- `memory/displayLabels.js`, `brain/timelineV2/chainBuilder.js` — labels for `goal_abandoned`.
- Instrument: section-aware metrics, `--profile`, `--emit-contexts`. The deadline metric's
  date pattern is in the script.

Isolation: per-owner Mind; nothing crosses owners. Deletion: the Mind's existing deletion path
is unchanged; history lists live inside the same per-owner Mind and are purged with it.
Tokens +1%. No new store, agent, model call or flag.

## 6. Tests

- New `src/mind/tests/laterWords.test.js`: 14 tests, each with a control. Disabling each
  mechanism fails them: working memory 3, goals 5, deadline filter 1.
- Earlier today's suites: 72 new tests.
- DB-free battery (mind, understanding, memory, pic, brain, cognition, routes, files,
  eval/tests): **2,698 tests, 0 failures**, 8 skipped (Windows-only and live-DB suites).
- DB-free gate: 16/17 PASS; `capture-core` BLOCKED (§7).
- **Disclosure:** one ad-hoc probe in this pass imported Mind modules without the isolated data
  dir and **read** the real `~/.aquiplex` stores into memory. Nothing was written: no Mind was
  modified or saved. All later probes and tests use private data dirs.

**capture-core.** Every metric improves (top-1 0.8947→0.9000, retrievability →0.9500). It
blocks because `eval/core/gate.mjs` treats any `n_cases_*` metric as dataset structure
(`STRUCTURAL_PREFIXES`), a rule written for extraction-core's per-category case counts.
capture-core uses `n_cases_fully_captured` / `n_cases_not_captured` as **outcomes**. The
dataset fingerprint is unchanged. Recommended:
- each suite declares its structural metrics explicitly, instead of the gate inferring them
  from a name prefix;
- capture-core's two outcome counts become graded metrics;
- add an absolute top-1 count, since the rate's denominator (captured cases) grows with capture.

Baseline untouched pending owner approval.

## 7. Remaining weaknesses

- **Answers are unmeasured.** Every number here is about the context, not the answer.
- Legacy **profile** facts still state replaced values (2.9%) under "rely on this profile".
- The memory block still comes first and authoritative, the evidence last and "untrusted". No
  instruction tells the model how to reconcile them.
- Conversational facts all carry confidence 0.60: no confidence signal reaches the model.
- Uncertainty is only verbatim hedging; the World Model's modality never reaches production.
- Semantic equivalence (coffee↔caffeine, live↔relocated) is out of deterministic reach.
- Evidence-lane improvements need `AQUA_BRAIN_INGEST(_FACTS)=on` in production (unverified).
- Development data only, partly written after seeing the failures; synthetic padding.

## 8. Three highest-impact next improvements

1. **Run the answer-level pair** (121 questions × 2 arms × 2 repeats; NVIDIA free tier) once
   Lift has finished. This is the only way to know whether answers improved.
2. **Make the profile follow later words**, as the Mind now does. Free-text profile facts whose
   later statement changes, ends or corrects them get a "since changed" note or retire to
   history. This is the last source of stale-as-current in these sets.
3. **One reconciliation rule in the prompt.** State once, above all user context, that dated
   later statements in the evidence and quotes override undated profile and cognitive-model
   lines. Then measure it with the answer pair before keeping it. It changes model behaviour on
   every turn, so only answer-level evidence should decide it.
