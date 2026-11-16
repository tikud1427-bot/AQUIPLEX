# AQUIPLEX — Founder Review: Phase 1 Commit, Benchmark Review, Phase 3A Plan

**Date:** 2026-11-16.

**Done in this pass:**

- the approved Phase 1 commit (local only);
- a critical review of the PWI benchmark;
- the deletion-correctness plan.

**Not done:**

- no push, no deploy, no environment change;
- Phase 3A is not started;
- the benchmark dataset and baseline are untouched.

Review artefacts are in `aqua/eval/pwi/results/review-2026-11-16/`.

## 1. Commit verification and result

**Checks before committing (all passed):**

| Check | Result |
|---|---|
| Commit-prep report re-read | done |
| Staged file list = the reviewed 12 files | **yes**: 4 added, 8 modified, nothing else staged |
| Staged diff = reviewed change | **yes**: `12 files changed, 597 insertions(+), 35 deletions(-)`; blob ids identical to the reviewed staged diff (e.g. `chat.js d4eb2b44`, `flags.js a471453d`) |
| `git diff --cached` inspected | 855 lines. Modified-file hunks are byte-identical to the ones reviewed hunk by hunk; the new source files `logSafety.js` and `owner-log-id.mjs` were re-read in full |
| No unrelated or unreviewed change in the index | **yes**: the index held only the 12 paths |
| No secrets, user data, generated or local files | **yes**: scan of added lines for provider-key shapes, private keys, e-mail, Mongo URIs, local paths, `.aquiplex` data. Only test fixtures: `gsk_test_fake_key_for_owner_pseudonym_01`, a test pseudonym key, `postgresql://aqua:aqua@127.0.0.1:1/aqua_fake` (a port that refuses), `http://127.0.0.1:${port}` |
| Staged = tested versions | **yes**: 8 modified files byte-exact, and 4 new files identical after LF normalisation, to the rebased files that passed the clean-`HEAD` battery (5,116 tests, the same 2 date-dependent failures as `HEAD`) |

**Commit:**

- **Hash:** `d3e3d6bd9047481650ba6d10f21eb5817a656760`
- **Parent:** `839ea0d1`
- **Message:** the proposed message in `AQUIPLEX_PWI_PHASE1_COMMIT_PREP.md` §5, verbatim. Its title is "Memory: legacy veto falls back to deletions; owner ids pseudonymised in logs", and it ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Hooks:** ran normally (none skipped).

```
$ git show --stat --oneline HEAD
d3e3d6bd Memory: legacy veto falls back to deletions; owner ids pseudonymised in logs
 aqua/scripts/owner-log-id.mjs                      |  23 +++
 aqua/src/brain/index.js                            |  99 +++++++--
 aqua/src/brain/tests/legacyVetoFallback.test.js    | 229 +++++++++++++++++++++
 aqua/src/core/flags.js                             |   1 +
 aqua/src/core/logSafety.js                         |  49 +++++
 aqua/src/core/tests/flagRegistry.test.js           |   6 +-
 aqua/src/memory/episodicRecall.js                  |   5 +-
 aqua/src/pic/core.js                               |   7 +-
 aqua/src/routes/chat.js                            |  15 +-
 aqua/src/routes/intelligence.js                    |   6 +-
 .../tests/memoryDeliveryUnreachableDb.e2e.test.js  |  13 +-
 aqua/src/routes/tests/ownerLogPseudonym.test.js    | 179 ++++++++++++++++
 12 files changed, 597 insertions(+), 35 deletions(-)
```

**No other changes were committed.**

- **Branch:** `main...origin/main [ahead 1]`.
- **Not pushed.**
- **Index:** empty after the commit.

**`git status --short` after the commit:** 312 entries (75 modified, 237 untracked), all of them earlier uncommitted work. The full listing is in `results/review-2026-11-16/git-status-after-commit.txt`.

Two committed paths still show as modified (`M`), as expected:

- `aqua/src/core/logSafety.js`: the working copy also has Sprint 1's other functions.
- `aqua/src/brain/tests/legacyVetoFallback.test.js`: the working copy also has the partition fail-closed case, which needs Phase 2b.

Both belong to later commits.

**Cosmetic note (not a check failure):** the committed `logSafety.js` comment mentions `shortHash`/`textMeta`, which only exist at HEAD once Sprint 1 lands.

**Not done, as instructed:**

- Fix 1 (the Cloud Run templates) stays uncommitted with Phase 4B.
- No push.
- No deploy.

## 2. Benchmark review findings

I re-read the spec, the baseline report and the commit-prep report, and checked each claim against the raw outputs. **Several baseline statements are wrong or overstated; they are corrected here.** Following the instruction, the original baseline is not edited.

| # | Question | Finding | Evidence |
|---|---|---|---|
| 1 | Real production code paths? | **Mostly yes**, with stated deviations. Turns go through `prepareTurn` → message persist → `commitTurnMemory` → `runPostTurn`; uploads through the real `/upload` route; page actions through the same functions `routes/memory.js` calls. **Deviations:** (a) **embeddings off.** Production computes semantic scores whenever a Gemini key exists (`embeddings/embeddingProvider.js:40-45`), so retrieval in production may differ. (b) The answer is a stub ("Noted."), so post-turn ingest of the assistant reply is not realistic. (c) Memory-page actions call the functions, not the HTTP route, so the route-level checks are skipped. (d) The HTTP/auth layer is bypassed (`userId` is passed directly) | `eval/pwi/stage.mjs` |
| 2 | Stories and expected answers consistent? | Replay is consistent (validator plus 10 harness tests). **But 3 labels are debatable:** (a) **"My partner Jonas Eckermann is helping me with the 3D mockups"** is genuinely ambiguous. "Partner" commonly means a romantic partner, so Aqua's `spouse = Jonas` is a reasonable reading. The baseline called it a capture error, and that claim is **withdrawn**. Ending the *collaborator* role does not end a romantic relationship, so `spouse = Jonas` remaining current is not stale. (b) **p2's Memory-page delete of "Fenwright Partners"** was scripted although the page cannot show that value. The truth marks it deleted, so recall quotes of it count as violations. It is a real product gap (no way to delete), but it is a *non-executable request*, not a *leaking deletion*, and the two should be scored separately. (c) p3's "forget the print run number from the Vellum brief" assumes forget should reach document content. That is a reasonable product expectation, but a policy choice (§8 D-4) | dataset `pwi-v1.json`; `failures-prod-long.md` |
| 3 | Missing / outdated / incorrect / unknown distinguished? | **Partly.** Missing is distinguished, split into capture vs retrieval. Outdated (past) vs incorrect (corrected) are separate kinds. **Gaps:** (a) **no precision for stored claims**: spurious or misattributed facts (`hobbies = ["doing","crossword",…]`, "a new job this week…" as a project) are only visible as spurious graph nodes; (b) **stale checks are value-based, not slot-based**, so a past value legitimately held in another slot counts as stale (the Jonas case); (c) fabricated values for unknowns are not detectable; (d) **"claim accuracy" equals "claim recall" in every cell** (redundant as defined, because stale values only coexisted with uncaptured new values); (e) the **CSV false positive**: the whole 0.077 stale-unmarked rate at stage C is two hits on the dated table row `February,120,310`. The real stale-unmarked rate in structured lanes is **0 of 24** | `C.score.json` stale decomposition |
| 4 | Deletion checks every representation and path? | **No.** The store check covers facts (value, history, `sourceText`), a *subset* of the Mind (beliefs, goals, working memory, graph, episodes) and the active evidence lane, plus every probe context. **Missed:** `mind.files[*].summary` (file memory), the UKO store, attachments, the file search index, vectors, the reasoning graph, PIC, and fact fields `sourceMessage`, `metadata.sourceSentence`, `normalizedValue`. A search of the raw data directory found p3's deleted "25,000" in `.aqua-mind.json` (`files.vellum-brief.md.summary`), `.aqua-uko.json` and `.aqua-attachments.json`, which the baseline counted as "fully gone" from stores. The real store-compliance figure is lower than the reported 0.833. Conversation history (verbatim) is excluded by design | data-dir search, `review-2026-11-16` |
| 5 | Restart and isolation meaningful? | **Restart:** meaningful for *flush-on-shutdown* (separate processes, production SIGTERM handler, measurement equality). **Not** a test of a crash/SIGKILL, and **not** of Render's restart path. The Mongo mirror and hydration are disabled, while production restarts on Render depend on them. **Isolation:** 4 users share every store file and a first name, and the canary scan of contexts and stores is meaningful for the store and retrieval layer. **Not** tested: HTTP ownership checks, the conversation-owner fallback / adoption at login, concurrency | `stage.mjs`, `run-pwi.mjs` |
| 6 | Reproducible from the locked dataset? | **Yes on this tree.** A rerun after the commit (`review-2026-11-16/rerun`) is **identical** to the baseline for `prod` and `hybrid`, all stages and both regimes, and the earlier `run2` matched too. **But** the benchmark code, `pwi-v1.json`, the ACIB filler it reuses (`acib.v1.json`) and the measured memory modules are **uncommitted**, and the summary records no code fingerprint. So it is not reproducible from any commit | `git ls-files` checks |
| 7 | Hybrid comparison fair? | Same data, same scorer, a flag-only difference: fair in design. **Caveats:** (a) the hybrid engine has a 50 ms wall-clock budget, and 3 turns hit it (`BudgetExceeded`), so results can depend on machine speed (the rerun was identical on this machine); (b) the hybrid engine was tuned on ACIB, the same team and harness, and is not independent of the system under test; (c) its gain is in context completeness only (+0.10 at C), with no answer-level evidence | `hybrid-*/*.run.json.log` |
| 8 | Misleading results? | **Yes, five, corrected below.** (a) "Changes recorded as changes 3 of 18" undercounts. Counting later-word annotations and goal `changedBy`, it is **5 of 18**: the March 14 deadline *was* annotated "(since changed — they said: … April 30)", contrary to the baseline's F-3 wording. (b) The stale-unmarked rate is 0, not 0.077 (CSV artefact). (c) Deletion store compliance is overstated (point 4). (d) Context-violation "occurrences" multiply one leak by the number of probes (23 = 3 values × probes); distinct value-lane leaks are the meaningful count. (e) Consistency metrics are **vacuous when nothing was captured**: correction consistency 1.0 includes the never-captured child count, and "contradiction handled in context 0.923" mostly reflects old values that were never stored. The headline, that Aqua stores more but understands less, **still holds**: claim recall .607 → .447 and entity recall .529 → .393 are measured on captured content and unaffected by these corrections | this section |

## 3. Confirmed benchmark limitations (beyond the spec's list)

1. **Labels not independent.** The PWI-v1 labels, including the debatable ones above, need an independent reviewer. Lower-ambiguity rewording belongs in pwi-v2 (never edit v1).
2. **Production fidelity.** Embeddings were off; there is no HTTP/auth layer and no Mongo hydration. Results describe the no-embedding legacy read on local disk.
3. **Deletion coverage.** The store check misses file memory, UKO, attachments, index, vectors, the reasoning graph and some fact fields (point 4).
4. **Scoring rules:**
   - stale detection is value-based, not slot-based;
   - claim precision is absent;
   - "claim accuracy" is redundant;
   - consistency metrics are vacuous on uncaptured data;
   - deletion counts are per occurrence;
   - non-executable deletion requests are mixed with leaking ones.
5. **Reproducibility.** The benchmark and its inputs are uncommitted, and no code fingerprint is recorded.
6. **Answer level.** No answer-level evidence, by scope.

**Fixing these is benchmark work for pwi-v1.1 (scorer) or v2 (data).** Each needs your approval, because it changes measured numbers: rescoring is non-destructive (`rescore.mjs` keeps superseded summaries), but it must not overwrite the original baseline.

## 4. Deletion failure: root-cause analysis

Every claim below was reproduced with the real functions in an isolated data directory.

### R-1 Wrong target: chat forget maps the request to the user's own schema slot

- **Path:** `memory/engine.js:202-214` (`memoryObserve` step 3):
  1. `detectForget(userMessage)` (`memoryExtractor.js:169`) captures the text after "forget (that) (my)";
  2. `resolveCanonicalKey(hint)` (`memoryExtractor.js:21`) scores **schema** key words with **head-noun dominance** (the last word weighs most);
  3. `deleteFact(ownerId, hintKey)` runs **without checking that the fact relates to the request**.
- **Reproduced:**

| Request | Resolved key | Effect |
|---|---|---|
| "Please forget my manager's name." | `name` | **deletes the user's own name** |
| "Forget my brother's name" | `name` | **deletes the user's own name** |
| "Forget my wife's employer." | `workplace` | **deletes the user's own workplace** |
| "Please forget the print run number from the Vellum brief." | `country` | wrong key; a no-op only because p3 had none |
| "Forget that my doctor is Dr. Lee" | `doctor_is_dr._lee` | silent no-op |
| "Please forget what I told you about my sister." | `siblings` | correct |

- **Why:**
  - the resolver knows schema vocabulary, not this user's facts or values;
  - a possessive ("X's") marks a third party, and the resolver discards it;
  - nothing compares the deleted fact's value or key with the request;
  - there is no confirmation step.
- **Existing tests do not cover it:** `forgetEverywhere.test.js` and `forgetMindCleanup.test.js` cover only "forget my *city* / *workplace*".

### R-2 Incomplete reach: forget cleans only some representations

| Representation | Chat forget (`engine.js` + `forgetInBackground`) | Memory page (`forget.js forgetFact`) | Evidence |
|---|---|---|---|
| Fact (value) | deleted (if the key is right) | deleted | — |
| The **same value in other facts' `sourceText` / `sourceMessage` / `metadata.sourceSentence`** | **kept** | **kept** | Fenwright in p2's `spouse` and `relationship_status` facts |
| Mind bridged belief + graph **edges** | removed (`forgetValueInMind`, `propagation.js:866`) | removed | — |
| Mind graph **node** | **kept** | **kept** | `person:rosalind` survives (edge-only removal) |
| Mind goals / working memory / episodes / predictions / timeline holding the value | **kept** | **kept** | not handled by `forgetValueInMind` |
| `mind.files[*]` file-memory summary | **kept** | **kept** | "25,000" in `files.vellum-brief.md.summary` |
| Uploaded document: UKO, attachments, evidence facts, search index, file chunks / vectors, reasoning graph | **kept** — and **no production code removes a document's derived knowledge at all** | **kept** | `ukoStore.removeUKO`, `fileSearchIndex.removeUKOFromIndex`, `evidenceStore.removeFile`, `graphBuilder.removeFileFromGraph` exist with **no callers**. `DELETE /upload/attachments/:c/:id` calls only `removeAttachment` |
| Recall quotes | redacted (`redactPhrases` of the value) | redacted | works when the key is right |
| Conversation-lane evidence sentences | archived (`archiveConversationFacts`) | archived | — |
| Canonical World Model | archived (DB only) | archived; refuses when unreachable | — |
| Verbatim conversation history | kept (by design; recall redacts quotes) | kept | policy question D-4 |

### R-3 Uncaptured values cannot be deleted from the Memory page

The page lists stored facts. A value said but never captured ("Fenwright Partners") has no row to delete, yet recall quotes it and the hybrid and information-needs engines can cite it.

### R-4 Logs

Deletion logging is not yet pseudonymous:

- `FORGET_CHAT owner=user:…` and the other `[MEMORY]` lines print raw owner ids (23 lines, commit-prep §7);
- there is no per-deletion verification record.

### Not found (checked)

- **Cross-user effects:** every forget path takes the owner from `resolveOwner` and every store is owner-keyed. No path was found by which one user's request changes another's data; the benchmark's 4-user shared store showed 0 leaks.
- **Re-appearance after restart:** none observed for executed deletions (restart verify identical). Recall redactions flush immediately (`recallRedactions.js persist → writer.flush()`).
- **Not verified:**
  - re-appearance through Mongo-mirror hydration;
  - re-appearance through the pre-login conversation-owner adoption (`mindStore.adoptMind`).

## 5. Phase 3A implementation plan: deletion correctness only (not started)

**Principles:**

- no new store, service or model call;
- deterministic;
- reuse the existing per-store removal functions;
- forget must never delete something the request did not name;
- when unsure, ask instead of guessing.

### 3A-1 Target resolution (fixes R-1)

- **Current behaviour:** schema-word fuzzy match → `deleteFact`.
- **Proposed correction:** a new pure resolver, `memory/forgetTarget.js` `resolveForgetTarget(ownerId, message)`, that returns `{ targets: [{ store, key, value }], ambiguity, reason }`. It uses the user's **actual stored facts and values**, not schema vocabulary alone:
  1. **Exact-value match:** a fact whose value is named in the request ("forget Teodor Ilić").
  2. **Possessive or third-party phrase** ("my manager's name", "my wife's employer"): match facts whose key or source sentence names that relation (`custom_manager_*`, `spouse`), and **never** a self slot.
  3. **Bare self slot** ("forget my city"): keep the current behaviour.
  4. **Nothing matches, or several plausible targets:** **no deletion**. The turn records a clarification need ("Which of these should I forget: …?") and redacts nothing.
- **Wiring:** `engine.js:202-214` calls the resolver, then the existing `forgetFact`-equivalent path per target. `resolveCanonicalKey` itself is unchanged, because `memoryEditor` relies on it with exact keys.
- **Tests (new `memory/tests/forgetTarget.test.js`):**
  - every row of the R-1 table;
  - "forget my name" still deletes the name;
  - a possessive never deletes a self slot;
  - ambiguity produces no deletion and a clarification;
  - a value match deletes exactly that fact and keeps unrelated facts and relationships.
  - The existing `forgetEverywhere` and `forgetMindCleanup` stay green.
- **Risks:**
  - Some requests that worked by luck may now ask instead of acting. That is acceptable, because a clarification costs one turn, while a wrong deletion is data loss.
  - Phrase coverage is heuristic; measure it on the PWI deletion probes plus new cases.

### 3A-2 Clarification behaviour

- **Current behaviour:** none; a forget either acts or silently does nothing.
- **Proposed correction:** when the resolver returns ambiguity or no target, add a directive to the turn on the existing directive channel (`reasoningDirective`, `chat.js`): "The user asked to forget something; it is not clear which item. Ask which of these (list) — do not claim it was forgotten."
- **Wording:** the list renders labels, never other users' data.
- **Tests:** a prompt-level test (as in `cloudRunMemoryLanes`) asserts that the directive is present and that no store changed.
- **Risk:** answer wording is model-dependent, which is not testable without model calls (D-6).

### 3A-3 Complete reach for a fact-level forget (fixes R-2)

- **Proposed correction:** extend the existing `forget.js` / `forgetValueInMind` so that one forget clears every representation of the named value for that owner:
  - facts: the value and the provenance fields (`sourceText`, `sourceMessage`, `metadata.sourceSentence`) of **other** facts, by redacting the value inside them;
  - Mind graph **nodes** whose label is the forgotten value, when no remaining fact references them, plus their edges;
  - goals, working memory, episodes, predictions and timeline entries naming it;
  - `mind.files` summaries;
  - evidence statements (existing archive).
- **Tests:**
  - an extension of `forgetEverywhere.test.js` that seeds every representation and asserts, by a search of every store file in the data directory, that the value is gone and unrelated values remain;
  - a restart (child process) re-check;
  - a two-user test where the same value held by another user is untouched.
- **Risk:** over-deletion when a value is a common word, so require the resolver's matched value. Store migration is not needed (in-place edits).

### 3A-4 Document forget (fixes R-2 for uploads; new capability from existing parts)

- **Proposed correction:** `files/forgetDocument.js` `forgetDocument(ownerId, ukoId)` composes the existing removers:
  - `ukoStore.removeUKO`;
  - `fileSearchIndex.removeUKOFromIndex`;
  - `evidenceStore.removeFile`;
  - `graphBuilder.removeFileFromGraph`;
  - `fileMemory.removeFileChunks`;
  - `attachmentStore.removeAttachment` for every conversation;
  - `mind.files` entry;
  - recall redaction of the file's quoted excerpts.
- **Wiring:** `DELETE /upload/attachments/:c/:id` (owner-checked) plus a chat forget naming the document.
- **Detail-level forget** ("forget the print run number") **is a policy decision (D-4)**: either redact the detail inside the stored document text, or require forgetting the whole document.
- **Tests:**
  - an upload → `forgetDocument` → every-store search;
  - the document is no longer in any context;
  - restart;
  - the other documents of the same user are untouched.
- **Risks:**
  - the UKO cache and content-hash dedup: the same file uploaded by another user must stay;
  - **check the `ukoStore` cache semantics before implementing (U).**

### 3A-5 Delete what the Memory page cannot show (fixes R-3)

- **Proposed correction:** a "Forget a phrase" Memory-page action calls the existing `redactPhrases` plus the 3A-3 reach for that text. It needs no new store: `POST /memory/forget-phrase`, owner from session.
- **Tests:** a route test (as in `forgetEverywhere`'s route tests) for uncaptured values (Fenwright), recall, hybrid and info-needs quotes.

### 3A-6 Auditable verification without raw data (fixes R-4)

- **Proposed correction:** each forget returns and logs one receipt line: `[FORGET] owner=<ownerLogId> request=<id> targets=<n> stores={facts:1,mind:2,evidence:1,files:0,…} verified=<bool>`. Values are represented only as `textMeta` hashes, never printed.
- **Verification:** a post-forget sweep over the owner's stores, using the same search as the tests, sets `verified`.
- **Also:** convert the 23 raw-owner `[MEMORY]`/`[BRAIN]` lines to `ownerLogId`, with the same source guard.
- **Tests:** a log-capture test (as in `ownerLogPseudonym.test.js`): no raw owner, no value text.

### 3A-7 Benchmark extensions for measuring 3A (benchmark changes; need approval, §8)

- **Scorer fixes:**
  - deletion search over every store file in the data directory;
  - a wrong-target metric (a fact deleted that the request did not name);
  - executable and non-executable deletion counted separately;
  - distinct leak counts;
  - the CSV/dated-row rule;
  - claim accuracy defined against stored claims.
- **Delivery:** as pwi-v1.1 scoring, rescored without overwriting v1.
- **New probes:** the R-1 phrasings, as **pwi-v2** (a new frozen file; v1 untouched).

## 6. Exact files and tests that would change (Phase 3A; nothing changed yet)

| File | Change |
|---|---|
| `aqua/src/memory/forgetTarget.js` | **new**: target resolver (3A-1) |
| `aqua/src/memory/engine.js` | step 3 (lines ~202-214) uses the resolver; clarification flag on the turn trace |
| `aqua/src/memory/forget.js` | full-reach forget (3A-3); `logControl` → receipts with `ownerLogId` (3A-6) |
| `aqua/src/memory/propagation.js` | `forgetValueInMind`: nodes, goals, working memory, episodes, predictions, timeline, `mind.files` (3A-3) |
| `aqua/src/files/forgetDocument.js` | **new**: composes the existing per-file removers (3A-4) |
| `aqua/src/routes/upload.js` | attachment `DELETE` → `forgetDocument` (3A-4) |
| `aqua/src/routes/memory.js` | `POST /memory/forget-phrase` (3A-5) |
| `aqua/src/routes/chat.js` | clarification directive (3A-2) |
| `aqua/src/memory/*`, `aqua/src/brain/*` | the 23 raw-owner log lines → `ownerLogId` (3A-6) |
| **Tests (new)** | `memory/tests/forgetTarget.test.js`, `memory/tests/forgetReach.test.js` (every-store search + restart + two users), `files/tests/forgetDocument.test.js`, `routes/tests/forgetPhrase.test.js`, `memory/tests/forgetReceipt.test.js` |
| **Tests (extended)** | `forgetEverywhere.test.js`, `forgetMindCleanup.test.js`, `ownerLogPseudonym.test.js` (source guard over all tags) |
| **Benchmark (if approved)** | `eval/pwi/score.mjs` (v1.1 rules), new `eval/pwi/dataset/pwi-v2.json` |

## 7. Risks and unresolved questions

1. **Commit order and dependencies.** The forget files (`forget.js`, `engine.js`, `propagation.js`) carry uncommitted Sprint and Phase work in the working tree. Phase 3A will hit the same separation problem as Phase 1. **Recommendation:** commit the earlier reviewed work first, or accept that Phase 3A is built on the working tree and committed after it.
2. **Behaviour change.** Some forgets that "worked by luck" will now ask a question. This is intended; measure it.
3. **Over-deletion vs under-deletion.** A common-word value could match unrelated text. Mitigated by requiring the resolver's matched value and keeping exact-match semantics.
4. **Shared document cache:** UKO and content-hash reuse across users is **unverified (U)**, and must be checked before `forgetDocument`.
5. **Not tested here:** Mongo-mirror hydration and pre-login adoption as resurrection paths **(U)**. Add tests in 3A, using the Mongo test container and no production data.
6. **Answer wording** of clarifications and "I've forgotten that" confirmations needs answer-level evaluation (model calls, D-6).
7. **Canonical World Model** forget paths exist but are DB-only. They are out of scope while production has no database.

## 8. Decisions requiring founder approval

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Approve Phase 3A implementation (3A-1 … 3A-6) as planned | yes; 3A-1 + 3A-3 first (wrong-target and reach), then 3A-4, 3A-5, 3A-6 |
| D-2 | Commit strategy for Phase 3A, given uncommitted dependencies (§7.1) | commit earlier reviewed work (Sprint 1 … Phase 4A) before Phase 3A |
| D-3 | Ambiguous forget: ask (no deletion) vs best guess | **ask** |
| D-4 | Scope of "forget": (a) should verbatim conversation history be deleted, or only redacted from every answer path as today? (b) a detail inside a document: redact inside the stored text, or forget only whole documents? | (a) keep redaction plus offer "delete this conversation"; (b) redact inside stored text |
| D-5 | Benchmark corrections: pwi-v1.1 scorer (rescored beside v1, not over it) and pwi-v2 dataset with independent review | yes; v1 stays as the frozen baseline |
| D-6 | Answer-level evaluation on the free key pool for clarification and deletion wording | optional; deterministic tests first |
| D-7 | Convert the remaining 23 raw-owner `[MEMORY]`/`[BRAIN]` log lines in 3A | yes (mechanical, guarded) |
| D-8 | Push of `d3e3d6bd` | **not requested**: a push to `main` may deploy to Render |

**Stopped here.**

- Nothing pushed or deployed.
- No environment, flag or cloud change.
- Phase 3A not started.
- Dataset and baseline untouched; review outputs are in a separate directory.
