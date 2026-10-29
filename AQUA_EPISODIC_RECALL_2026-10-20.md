# Episodic recall: Aqua answers from what you said, not only from what it extracted (2026-10-20)

**Status:** built, tested, measured at answer level on development data. **Uncommitted** on
`aquiplex/world-model-pass2`. Nothing was pushed, deployed, or rotated.

## 1. The problem this fixes

Before this change, the answer model saw only two things about a user's past:

- the current conversation's window;
- whatever background extraction had turned into World Model claims.

Anything said in **another** conversation reached the answer only if extraction caught it.
Extraction is lossy by construction. It was measured losing:

- one of the two changes in "we moved the launch to May 2, **and** the price is now $39"
  (founder journey, runs 3 and 4);
- exact figures from uploaded files ("15,000 words", "max 12 days a month");
- facts entirely, about 7% of the time.

It also lands 17–94 seconds after the user speaks.

The measurement that pointed here was held-out Lift v3, recorded in `PRODUCT_SCORECARD.md` §2.
On short histories, the World Model alone was the **worst** memory condition (73.4% correct,
15.2% stale). Every past turn verbatim was the best (95.3%, 1.0% stale).

The structured model does things raw text cannot:

- supersession;
- provenance;
- per-claim correct and delete;
- abstention.

As the *only* window onto the past, though, it threw away what the user actually said.

## 2. What was built

### Episodic recall (`aqua/src/memory/episodicRecall.js`)

Every chat turn now also gets the user's own past messages, verbatim and dated, oldest first,
in addition to the World Model block.

**Adaptive scope.**

- While everything the user ever said fits about 2k tokens (`AQUA_RECALL_ALL_CHARS`, default
  8000 characters), recall quotes **all** of it.
- Beyond that, it quotes ranked excerpts: BM25 with light stemming, a relative relevance
  floor, at most 8 passages and 3,600 characters.
- Ranked mode adds **follow-ups**. A later message continuing a selected one ("…so the launch
  moved") is admitted even when it shares no word with the question.

**World Model annotation.** A quoted sentence whose claim the World Model later superseded
carries the current statement beside it:

> ↳ since changed — now: "We pushed it to May 2"

This comes from `canonicalReadModel.supersessionNotes`. It catches changes no lexical match
can find. A chain that ends in a user deletion gives no note.

**Uploaded files from other conversations.** These are a separate pool with their own budget:
whole files up to 4,000 characters, otherwise the 4 best passages. They are labelled as files,
never as the user's words. Files in the current conversation are not repeated; they are
already attached whole.

**Guarantees, each covered by a test:**

- **Owner isolation.** A user reads only conversations whose `meta.userId` is theirs.
- **The user's words only.** Assistant text is never quoted as the user's. A short reply
  carries a labelled snippet of the question it answered.
- **No duplication.** Messages already in the conversation window are skipped.
- **Fenced as untrusted content,** like other ingested text.
- **Fail-open.** An error yields an empty block, never a failed turn.

### Forget holds (`aqua/src/memory/recallRedactions.js`)

Messages stay in the conversation store after a forget, so recall could otherwise quote a
forgotten fact back. Every forget and correction path in `memory/forget.js` now records what
recall must never quote again:

- per-claim delete;
- per-claim correct;
- per-fact forget;
- forget-all, as a timestamp watermark;
- Memory-page correction;
- chat "forget my X".

How it works:

- The store keeps **salted hashes** of normalised phrases, never the phrases themselves.
- Writes are synchronous and mirrored.
- Account deletion purges the store.
- Matching checks whole words at both sentence and passage level. The passage check was added
  after a test caught "Dr. Okafor" being split across a sentence boundary, which defeated a
  forget.

### Product surface

- `/chat` payload: `recall.excerpts`, listing the conversation id, title, date, and whether it
  changed. It never includes the quoted text.
- Frontend: `RecallSources` shows "From your earlier conversations:" with a link to each one.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `AQUA_EPISODIC_RECALL` | on | `=off` is a complete rollback |
| `AQUA_RECALL_ALL_CHARS` | 8000 | whole-history budget; `0` = always ranked |

## 3. Measured results

### 3a. Answer level: held-out Lift v3, re-scored

Script: `aqua/scripts/lift-recall-offline.mjs`. Outputs:

- `aqua/eval/out/lift-recall-v3.json`
- `aqua/eval/out/lift-recall-v3-adaptive.json`
- `aqua/eval/out/lift-recall-v3-files.json`

Setup:

- The same 7 personas, 109 questions × 2 repeats, stored World Model blocks and stored grades
  as the 2026-10-11 run.
- The World Model block is **held fixed**, so differences are the recall lane's own effect.
- Same answerer (`openai/gpt-oss-20b`, temperature 0), judge (`nemotron-3-ultra`), rubric,
  and answer template.

| Condition | Correct | Stale | Fabrication | Unknown honesty | Context tokens |
|---|---|---|---|---|---|
| World Model alone (what production served) | 73.4% | 15.2% | 18.2% | 92.9% | 601 |
| BM25 memory, k=8 (includes file lines) | 78.5% | 9.1% | 10.8% | 100% | 75 |
| Ranked recall alone (no files) | 69.0% | 5.1% | 9.9% | 96.4% | 197 |
| World Model + ranked recall | 88.3% | 3.0% | 8.9% | 92.9% | 798 |
| **World Model + adaptive recall** | **90.2%** | **0.0%** | **8.4%** | 92.9% | 1,442 |
| World Model + adaptive recall + files (production default) | FILES_CORRECT | FILES_STALE | FILES_FAB | FILES_UNK | FILES_TOK |
| Full history (ceiling for short histories) | 95.3% | 1.0% | 3.3% | 92.9% | 575 |

Question-clustered paired statistics (seeded bootstrap 95% CI; sign test over questions that
differ):

| Comparison | Δ correct | 95% CI | W/L/T | p |
|---|---|---|---|---|
| WM + adaptive recall vs WM alone | **+16.7** | [+9.7, +23.6] | 26/2/80 | <0.001 |
| stale rate, same comparison | **−15.0** | [−25, −6] | 0/8/42 | 0.008 |
| fabrication, same comparison | **−9.7** | [−16.2, −3.7] | 3/19/86 | <0.001 |
| WM + ranked recall vs WM alone | +14.4 | [+7.9, +21.8] | 24/3/81 | <0.001 |
| WM + ranked recall vs ranked recall alone | **+19.4** | [+10.7, +28.7] | 30/7/71 | 0.0002 |
| WM + adaptive recall vs full history | −5.1 | [−10.7, 0] | 7/12/89 | 0.36 |
| WM + adaptive recall + files vs full history | FILES_VS_FULL | | | |

**Reading:**

- Adding recall to the World Model is the largest answer-level gain this project has measured.
  Stale answers, the product's primary metric, went from 15.2% to 0.0%.
- The World Model is **not** redundant. Removing it from the combined context costs 19 points.
  It carries files, structure, and abstention that raw recall alone lacks.
- What remained against full history was mostly **uploaded files**: 9 of 18 losses, file
  questions 73% vs 100%. That is why files joined recall. The rest were embellished specifics
  in long synthesis answers ("draft an update…") and one wrong addressee.

**Caveats, stated rather than hidden:**

- v3 is a **development** set by now (its failures were read on 2026-10-11). This is not a
  held-out claim.
- Histories are short, about 2.3k characters. Long histories (v4) remain unmeasured; that VM
  kit has still not run.
- Stored conditions were answered on 2026-10-11 and recall conditions today, with the same
  model ids at temperature 0. Provider-side drift is possible.
- The offline run has no database, so "since changed" notes are absent. The production path is
  at least as informed.

### 3b. The real product, end to end

Driver: `aqua/scripts/e2e-founder-journey.mjs`. It runs the real launcher (server and worker),
a fresh Postgres `aqua_e2e_recall`, the test Mongo, and real providers.

| Run | Result | Notes |
|---|---|---|
| 4 (2026-10-17, before recall) | 21/23 | compound change kept one of two values |
| **5 (2026-10-20, with recall)** | **23/24** | see below |

Run 5 in detail:

- Both changes from the compound sentence reached the investor update (May 2 **and** $39).
- Provenance quoted the founder's own update message, which fixes the old "internal note"
  wording.
- After the Memory-page correction and deletion, the old churn wording and "Maya" did not come
  back; recall logged `redacted=2`.
- The World Model note fired live (`annotated=1`).
- The second account got 0 excerpts.
- The one FAIL is the driver's regex not recognising "I'm not aware of…" as abstaining. The
  answer was right. The regex now accepts "aware".
- Chat latency was p50 5.5 s.

### 3c. Cost and safety

**Latency:** 11–17 ms per warm turn, measured on one owner with 10,000 messages among 20,000
other users' conversations. A cold first turn takes about 120 ms. Heap was 60 MB.

**Tests (all MEASURED 2026-10-20):**

- aqua battery: **4,487 passed, 0 failed**, 6 skipped (environment), run per directory with the
  test DB;
- after the files change, memory, routes, upload, and account suites: 612/612;
- frontend: 119/119 (2 new);
- eval gate: PASS on all 18 suites, both canonical suites included, metrics unchanged.

New tests:

- `src/memory/tests/episodicRecall.test.js` (20): ranking, adaptive mode, follow-ups, owner
  isolation, assistant text, window exclusion, bounds, redaction including hashing and purge,
  files, and three end-to-end runs through `prepareTurn`;
- `src/memory/tests/episodicRecallNotes.live.test.js` (5, live Postgres): World Model notes
  through the real understanding pipeline, whole-history mode, deletion, isolation;
- `aqua-frontend/src/test/recallSources.test.tsx` (2).

## 4. What is not done

- **Long-history evidence.** The v4 and final VM kits are still unrun. Ranked recall, the mode
  long histories use, measured 88.3% on short ones. Its long-history behaviour is unknown.
- **Semantic recall.** Ranking is lexical: "splitting bills across countries" does not find
  "cross-border splits" (h1-q09). The existing Gemini embedding pipeline could add a dense lane,
  but it would need per-message vectors and is unmeasurable here without long data.
- **Chat-path forget with no legacy fact.** "Forget X" in chat only redacts when the legacy
  store holds X. This gap predates recall: such a forget never reached the World Model either.
- **Synthesis embellishment.** Long drafts still invent specifics (dates, numbers) the user
  never gave. That is a prompt and answer-policy problem, not a memory one.
- **Payload privacy review.** `recall.excerpts` exposes conversation titles. They belong to the
  same user, but a security pass should confirm.

## 5. Next steps, in order

1. Commit this work with your approval. Run the founder journey on staging after deploy.
2. Run the v4 and final VM kits. They are the only route to a long-history claim. Note that the
   final kit measures the 10-18 snapshot, not this code.
3. Re-run this offline Lift on a fresh held-out set written by someone else, to turn the
   development-set result into a claim.
4. Dense recall lane (per-message embeddings) once a long-history set exists to measure it on.
