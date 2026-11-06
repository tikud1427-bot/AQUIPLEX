# Context-awareness audit — 2026-10-29

Repository `aquiplex-platform`, branch `main` at `b5e9694f` (clean, equal to `origin/main`). All work
below is uncommitted. Labels: **MEASURED** (number from a command run today or a named file),
**HISTORICAL** (from an earlier report), **UNVERIFIED** (stated in docs, not checkable from here).

## 1. What production actually executes

The answer path is `aqua/src/routes/chat.js` `prepareTurn` → `buildSystemPrompt`. Per turn it
assembles four user-context lanes:

| Lane | Code | Read mode |
|---|---|---|
| Fact store + Mind (identity, preferences, goals; labelled "user said" / "inferred") | `memory/engine.js` `memoryRetrieve` | legacy: full; authoritative: legacy facts only as gap-fill, vetoed by the World Model; no Mind |
| Knowledge block | `Brain.assembleContextAsync` (Context Engine V2 + Retrieval V3) over the PIC floor | legacy: PIC evidence lane; authoritative: canonical World Model claims only |
| Episodic recall (user's own past words + other conversations' files) | `memory/episodicRecall.js` | both; "since changed" notes only with a World Model |
| Conversation window | `tokenManager.buildContextWindow` | both |

**Which mode production serves: legacy** (UNVERIFIED from here; stated in `DEMO_RUNBOOK.md` and
`YC_48_HOUR_RELEASE_REPORT.md`). The canonical World Model needs `DATABASE_URL`; without it
`Brain.canonicalReadMode()` returns `legacy`. So the canonical World Model, its relevance gate, its
supersession and its E6 extraction do not reach any production answer today. Code defaults for
`AQUA_E6`, `AQUA_CONTEXT_V2`, `AQUA_RETRIEVAL_V3` and `AQUA_SELF_ENTITY` are **off**; only the
environment turns them on (the local `.env` does; production's env is UNVERIFIED).

Post-turn learning: `routes/turnPostProcess.js` `runPostTurn` (Mind reflection, PIC evidence ingest,
Digital Twin, E6 → durable job queue → canonical commit, contradiction and consolidation workers).

## 2. Implemented but not on the production answer path

- The whole canonical World Model (E6 claims, supersession, provenance, relevance gate, graph lane):
  only with Postgres.
- Cross-encoder reranking (`AQUA_CROSS_ENCODER` off), CIE planning (`AQUA_CIE` off), compound-change
  retry (`AQUA_E6_COMPOUND_RETRY` off).
- In authoritative mode the Mind block (stated vs inferred labels) is not injected.

## 3. Unreliable, incomplete or unmeasured

- **The decisive answer-level question is unmeasured**: on histories longer than the window, does
  any of this beat the history window or plain retrieval? Lift v4 (registered 2026-10-12) and the
  final set (2026-10-18) have never completed.
- **Episodic recall's measured gain is from a regime where it injects the whole history.** On short
  histories it quotes everything under 8,000 chars (`allUnderChars`), so v3's 90.2% (HISTORICAL,
  development set) is close to "full history". Its ranked mode (k=8 excerpts) is unmeasured.
- The `legacy` read, which is what users receive, has never had an answer-level measurement.
- **Eval reliability (fixed today):** `context-canonical-heldout` flipped nDCG 0.7735 ↔ 0.7701
  between runs with identical rankings. Two causes, both in how the eval adapter labels a claim with
  a corpus fact: (1) it took whichever evidence row Postgres returned last; (2) whether a later
  restatement is attached to an existing claim as corroboration varies between seedings, so even
  "latest supporting turn" flipped. Claims are now labelled by their origin turn (stable across 6+6
  runs). The held-out nDCG baseline moved 0.7744 → 0.7812 from this **definition change alone**.
  Open, production side: corroboration attachment depends on processing order (not investigated
  further; same claim text and score are served either way).
- Retrieval silence: the canonical read handed claims to 38% of held-out questions that have no
  answer in memory (unknown-honesty 0.615, MEASURED baseline).

## 4. Most consequential observed failures (dev data, mechanisms traced in code)

| Failure | Mechanism | Where |
|---|---|---|
| Unanswerable personal question gets unrelated claims ("What is my partner's birthday?" → 6 claims) | Both `partner` and `birthday` recorded as typing cues → no topic left → "kind alone may answer" → every person-shaped claim passes | `pic/questionShape.js` `analyseQuestion` |
| "Where did I holiday last summer?" → "…last year", "…last month" | A temporal modifier alone earned lexical credit and topic support | `pic/questionShape.js` `factAffinity` |
| Requests addressed to the assistant ("Can you run your tests?") pull user claims sharing one verb | Lexical fraction weighs a single shared verb like a noun | not fixed (recall risk in a heavily tuned scorer) |
| History extraction loses facts (compound changes, rate limits, 7% of facts never become claims) | E6 lossy; addressed by recall quoting the user's words | HISTORICAL, scorecard §3 |

## 5. Worth preserving

Owner isolation and the forget/correct/deletion paths (live-tested, `memory/forget.js`, recall
redactions); the eval harness's three-outcome contract and frozen held-out sets; the pre-registration
discipline; deterministic, LLM-free retrieval and gating; fail-open lanes.

## 6. Highest-impact changes, ordered by expected measured benefit

1. **Measure the shipped and the Postgres pipelines on long histories** against the window and
   size-matched retrieval: Lift v4 with production conditions (`legacyProd`, `recall`, `wmRecall`,
   `memoryProdMatched`). Pre-registered: `aqua/eval/lift/PREREG-v4-production-2026-10-29.md`. This
   decides whether to invest in the World Model, recall, or the simpler path.
2. Make the gates trustworthy (nondeterminism) — done.
3. Reduce context noise on unanswerable questions (fabrication driver) — two rule fixes, done, gated.
4. Then, guided by (1): recall ranking on long histories, or the World Model's answer context.

## 6a. Done today (uncommitted)

| Change | Evidence | Label |
|---|---|---|
| Gate determinism: canonical eval labels a claim by its origin turn (`eval/adapters/canonicalContextRetrieval.mjs`) | 6/6 identical held-out runs (was 1–2 flips in 4–5) | MEASURED |
| Possessor is a topic, not a typing cue; a when-word alone earns no lexical or topic credit (`pic/questionShape.js`) | Unknown-honesty: canonical dev 0.750→0.844, legacy dev 0.719→0.781, **held-out 0.615→0.654**; noise lines 22→13 / 18→9 / 25→23; recall@8 and MRR unchanged on every suite | MEASURED (retrieval level) |
| Legacy retrieval hints match whole words (`memory/memoryRetriever.js`) | 38 of 265 dev queries earned a spurious +600 hint ("son" in "person", "age" in "language", "os" in "most"); no gate covers this retriever, so unit tests only | MEASURED mechanism; outcome UNMEASURED |
| "I'm X" is a name only if written as one (`memory/memorySchema.js`) | "I'm colorblind, so…" had overwritten the name "Oskar" in a legacy replay; now Oskar | Observed in replay + tests |
| Mind block focus uses the UI's labels (`mind/mindRetriever.js`) | "focus: personal_info, simple_qa" no longer reaches the prompt | tests |
| Lift harness: `recall`, `wmRecall`, `memoryProdMatched`, `legacyProd` conditions | Dev smoke and legacy validation ran end to end | harness only |

Answer-level effect of all of the above: UNMEASURED until the v4 production run completes
(pre-registered; snapshot frozen; waits for AC power — see §7).

Still open: legacy free-text facts are never superseded ("thesis due May 30" stays in the profile
after "the deadline moved to June 13"); requests addressed to the assistant ("Can you run your
tests?") still pull user claims on a shared verb; corroboration attachment in the World Model
varies with processing order.

## 7. Baseline commands

```
# deterministic gate (dev + held-out retrieval, with disposable Postgres)
cd aqua && DATABASE_URL= AQUA_TEST_DATABASE_URL=postgresql://aqua:aqua@localhost:55432/<fresh db> node eval/gate.mjs
# answer-level, long histories (≈10–15 h on the NVIDIA free tier)
powershell -File C:\Users\dell\aquiplex-runs\v4-prod-1029\launch.ps1
# tests
cd aqua && AQUA_TEST_DATABASE_URL=… node scripts/run-tests.mjs src/memory src/brain src/pic src/routes
```

## 8. Evening session (2026-10-29): legacy supersession, answer-level

**Lift v4: NOT RUN.** Attempt 1 (16:44) and attempt 2 (17:16) died about 3 min into ingest, with no exit
line and no Windows crash event; no answer graded, no partial file. DB reset; snapshot verified
(CODE.sha256). Must be started from the user's own terminal:
`powershell -ExecutionPolicy Bypass -File C:\Users\dell\aquiplex-runs\v4-prod-1029\launch.ps1`
(AC power, machine awake, 10–20 h).

**Confirmed production (legacy read) failures, reproduced before fixing** (dev v3 replay; new tests fail on HEAD):

| Failure | Mechanism | Fix |
|---|---|---|
| Evidence lane lists "plays hockey Saturdays" and "switched to swimming, Sundays" undated in relevance order, under a footer saying "disputed items must be presented as contested"; the answer calls an update a dispute or unknown (3 of 12 wrong v3 baseline answers) | Floor facts carry `createdAt`; the item mapping dropped it; the renderer ordered only canonical claims | `pic/retrievalIntelligence.js` and `brain/contextEngine/assembler.js`: legacy facts listed oldest → newest under the order note. Not dated: printed dates were quoted back as event dates in 4/109 answers |
| Profile states replaced values as current ("thesis due May 30" after "moved to June 13"); "Dr" for "Dr. Raj Patel"; `custom_new_accountant` beside `custom_accountant` | A change replaced a free-text fact only under the same key; the value regex stopped at punctuation | `memory/factChange.js` (`onto`, `detectFactChanges`: one named fact only, a date or amount span, unqualified changes only), `candidateExtractor.js` `clauseValue`, `engine.js` step 4a. Old value kept in the version history |
| Legacy recall has no "since changed" notes | Notes came only from the World Model | `engine.legacySupersessionNotes` (from fact history), passed by `routes/chat.js` on legacy reads |
| "Can you run your tests?" retrieves "I run product at Nummo" | The assistant's verb counted as a topic term | `pic/questionShape.js` ADDRESSED_VERB. Gate: dev honesty 0.781 → 0.813 (legacy), 0.844 → 0.875 (canonical); held-out unchanged |

**Answer-level** (DEVELOPMENT; legacyProd context; gpt-oss-120b answers, Nemotron-3-Ultra judge, 1 repeat):

| Set | Before | After | Δ correct [95% CI], question W/L/T | Stale | Fabrication | Status |
|---|---|---|---|---|---|---|
| v3, short histories | 91.7% | n/a | n/a | 0.0% | 4.6% | After-arm INTERRUPTED (Groq quota); rerun pending |
| v3 + filler (ranked recall, about 11k chars) | 87.0% | 88.0% | +0.9 [−4.6, +6.5], 5/4/99, p=1 | 2.0% → 2.0% | 4.6% → 7.4% (+2.8 [−1.8, +7.4], p=0.45) | Complete: 108 pairs, 1 judge error |

The padded result is inconclusive. Neither correctness nor the stale rate measurably improved, and the
fabrication point estimate rose, though not significantly. The targeted failures did flip: flour supplier,
Tuesday opening, San Antonio blockers. A side effect was found: floor-fact timestamps also feed the Context
Engine's recency dimension, which changed the selection for h4-q13. Earlier "after" runs on intermediate code
(dates shown; amount rule without the qualifier guard) are superseded and not reported as results.

**Next bottleneck (observed):** in ranked recall, a stale statement is retrieved without its later
resolution in different words ("blocked by a zoning permit" vs "the zoning permit came through").

## 9. Next candidate: a stale statement retrieved without its later resolution (PLAN ONLY)

**Status:** documented, not implemented. Nothing here changes until Lift v4 has completed and its
endpoints are recorded. v4 must measure the code it was registered against.

**Failure.** On a long history, recall works in ranked mode (about 8 excerpts). The evidence lane picks
by relevance. A question matches the older statement's words ("Is anything blocking the San Antonio
opening?" matches "the opening is blocked by a zoning permit"). The later statement that resolved it
shares few of those words ("the zoning permit came through"), so it isn't retrieved, and the answer
reports the old state as current.

Observed on dev data, v3 with filler, both arms: h4-q10 and h4-q13 contexts held the blocking statement
and not its resolution. This is not a fact-store problem. The legacy fact-change rules (§8) cover only
"my X is now Y" and "X moved to Y". Free-form state changes ("came through", "broke up", "signed the
form", "we stopped …") have no stored key to supersede.

**Why this is the next step and not something broader.** The context is not missing the topic; it is
missing the later turn on the same topic. The candidate fix is retrieval-time and narrow: when an
excerpt about a topic is selected, also bring in later statements by the user that name the same
specific entity or noun phrase ("zoning permit", "SBA loan", "Northern Static"). Not implemented.

**Evaluation plan (to be pre-registered before any implementation):**

1. *Instrument first, LLM-free.* Add per-question supporting-turn labels to the development sets only:
   the turn that states the current answer and, if any, the turn it supersedes. Define
   **resolution coverage** as the share of questions whose context contains the current-answer turn,
   given that it contains the superseded one. Measure it for `legacyProd` on v3 (short), v3 with filler
   (ranked), and v4 once v4 is development data. Deterministic, so it can gate retrieval changes.
2. *Baseline before changing anything:* resolution coverage, plus answer-level stale rate and
   correctness on the state_change and correction questions. Use 2 repeats, the Nemotron judge,
   question-clustered bootstrap, and the same answerer as v4.
3. *Comparisons, size-fair:* the candidate against (a) current `legacyProd`; (b) the same context with
   the extra budget given to plain BM25 turns (`memoryProdMatched`-style), so a gain is not just more
   context; (c) full history as a ceiling.
4. *Decision rules, fixed in advance:*
   - Adopt only if stale rate on state_change and correction questions falls, with a 95% CI excluding 0.
   - Overall correctness must be non-inferior (lower CI bound above −3 points).
   - Unknown-honesty and fabrication must not rise beyond their CI.
   - Context tokens must grow by less than 25%.
   - The deterministic gate must stay green, held-out included.
5. *Held-out:* v4 stops being held-out once its endpoints are read, and `final.v1` stays reserved. A
   claim beyond development data needs a new, untouched set written before the change.
6. *Known risks:* pulling in later turns can surface unrelated later facts (noise) or, on negated
   questions, the wrong turn. Polarity and the "which came later" ordering must be preserved; §8's
   ordering fix already applies to the evidence lane.
