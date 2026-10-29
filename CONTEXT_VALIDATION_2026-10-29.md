# Context-awareness validation — 2026-10-29

**Where the work is.** Repository copy `C:\Users\dell\Downloads\aquiplex-platform\aquiplex-fix`, branch `fix/yc-demo-safety-2026-10-28`.

- Base: `origin/main` `8f1c92cd`, plus 4 local commits (`4fa5da35`, `1c2b4128`, `890c0a78`, `aebb81df`).
- Everything from 2026-10-28 afternoon onward is **uncommitted**. That covers today's earlier passes and this one.
- Nothing was committed, pushed, merged or deployed.

**How the two folders relate.** `aquiplex-platform` (branch `aquiplex/world-model-pass2`) and `aquiplex-fix` are worktrees of the **same** git repository.

- `origin/main` already contains `aquiplex-platform`'s HEAD (`f388893e`).
- The 21 uncommitted files in `aquiplex-platform` are the 2026-10-20 episodic-recall work. That work was ported into `aquiplex-fix` with an added health/mood filter.
- So `aquiplex-fix` is a superset. Nothing in `aquiplex-platform` needs to be carried over.

## 1. Real-chat validation (real providers, real server)

### Setup

- **Server:** the real launcher (`scripts/start-production.mjs`, server + worker) from this working tree.
- **Provider keys:** your `.env` was loaded in place for provider keys only. No key was printed, copied or written anywhere.
- **Datastores:** every store was overridden to a disposable one.
  - Postgres: `aqua_ctx_1029` on the test container (:55432).
  - Mongo: `aqua_ctx_*` on the test container (:57017). Verified by listing the local database's collections.
  - Data directory: an empty scratch folder.
  - Mail: `MAIL_TRANSPORT=log`.
- **Prompt capture:** a Node loader hook outside the repo recorded each turn's final system prompt, so that "Context used" could be checked against what the model was really given. The product never loads it.
- **Driver:** `validate.mjs` in the session scratchpad. It drives HTTP like a browser with two fresh accounts per run:
  - **A**, a founder: university student; goals "become a billionaire", "build a company people love", "learn Spanish this year"; building Tidepool, a scheduling tool for physio clinics, at $49/clinic/month, with month-one churn as the main risk.
  - **B**, a blank control account.
- **Model:** every turn was answered by the same provider (Groq), so the with/without comparison is like for like.

### Read modes tested

Each final run used new accounts and new stores. Both runs used the final code, except one later refactor: the reopened-conversation route now reads claims through the Brain facade (§5). Its behaviour is identical, and `contextProvenance.test.js` covers it over HTTP.

| Read mode | What it means | Result |
|---|---|---|
| **legacy** (`AQUA_CANONICAL_READ=off`) | What production serves today (fact store + Mind) | **33/33** |
| **authoritative** (Postgres World Model) | The default whenever a database is configured | **31/33**. Both failures are explained in the table below. |

### Results by requirement

| # | Requirement | Result (both modes unless noted) |
|---|---|---|
| 1 | Separately extracted goals | **Pass.** One sentence with three goals gave four separate goals, including the beta stated later: `become a billionaire`, `build a company people love`, `learn Spanish this year`, `launch the Tidepool beta`. The fact store's goal list is also split (see §3, fix B). |
| 2 | Unrelated statement does not complete a goal | **Pass.** After "I finished lunch", every goal stayed active. Positive control: "we launched the Tidepool beta today" completed only that goal. |
| 3 | Negated statement does not complete a goal | **Pass.** After "We haven't launched the Tidepool beta yet", the goal stayed active. |
| 4 | Stated vs inferred is distinguishable in the model context | **Pass (legacy).** Every injected identity/preference line in the captured prompts says `(user said)` or `(inferred, N%)`, with 0 unlabelled lines. In authoritative mode the Mind block is not injected at all (by design: it is a legacy-mode lane), so there was nothing to label; that is the authoritative failure. |
| 5 | An aspiration is not presented as a current profession | **Pass.** Identity says profession = "university student" (stated). No captured prompt says billionaire is a profession or role. Answer: "You're a university student… you're actively building Tidepool". |
| 6 | Personal context improves a project question | **Pass on substance.** Same question, same provider: "What should I focus on this week to give my product launch the best chance?"<br>• **With context:** a plan built on the user's actual situation, e.g. "shaped around … still fixing bugs, $49 / clinic pricing, churn risk after the first month"; onboarding work aimed at the month-one churn risk; positioning copy for physio clinics at $49/month.<br>• **Without context:** a sound but generic launch checklist that invents no user facts.<br>The authoritative failure is my keyword check: the control answer used "churn" generically ("…destroys credibility and churns early users"). It names no Tidepool, clinic or price. |
| 7 | Unrelated memories excluded from a general factual question | **Pass after a fix in this pass.** The first run sent the user's profession, project and goals with "At sea level, what temperature does water boil at?". The answer was correct and clean, but the data should not have been sent. Fixed (§3, fix C). Final runs: 0 personal items injected, answer "100 °C". |
| 8 | A correction changes later retrieval and answers | **Pass.** Before the correction: "We charge $49 per clinic each month". The correction used the endpoint behind "Context used" and the Memory page. After it: "$59" in a new conversation, and also when re-asked in the original conversation (the regenerate path). "Context used" then showed the $59 claim and not the $49 one. |

**Latency.** Over 13 turns per mode, the median was 4.2 s (authoritative) and 4.7 s (legacy); p90 was 7.7 s and 8.4 s. Context added about 3–6k characters to the prompt. The project-question turns took 15–25 s with context and 13–14 s without. Both used web search, so the difference cannot be attributed to context alone.

**Not measured.** This is one scripted founder scenario per mode, not a statistical evaluation. Answer-quality claims beyond the checks above would need the held-out evals (v4 / final kits), which are still unrun.

## 2. "Context used"

### Faithfulness

**Every displayed item corresponds to context actually supplied.** All `S3` checks pass in both modes.

- On every turn with context (profession question, project question, after correction, and the factual question with 0 items), each displayed item's text was found in the **captured prompt that turn sent**.

**Fix found by this check:** retrieval returns facts from 0.5 confidence, but the prompt formatter only injects from 0.55. So a fact between 0.50 and 0.55 could have been listed without the model ever seeing it.

- `contextUsedItems` now uses the formatter's own line (`factPromptLine`) and requires it to be in the final system prompt.
- A claim is listed only if the knowledge block that renders it is in the prompt.
- With no prompt, nothing is listed. The list can now under-state, but never over-state.

### User actions, checked live

- **Inspect:** works.
- **Correct:** works.
- **Forget:** works. The forgotten item ("learn Spanish this year") was gone from both the list and the prompt on the next turn.
- **Regenerate after correcting:** works. A re-ask in the original conversation answered $59.

**Fix: the correction garbled sentences.** The extractor had stored the value as "charge $49 a month per clinic", so typing "$59 a month per clinic" produced **"We $59 a month per clinic"**.

- Claims now carry the exact value a correction replaces (`value`, an additive field on `/brain/current` and `contextUsed`).
- Both correction boxes (Context used and the Memory page) start pre-filled with it.
- Live check: editing the pre-filled value gave "We charge $69 a month per clinic".

### Reopened conversations

Provenance used to be lost on reopen: a stored message is only `{role, content, ts}`. It now fits the architecture as follows.

- **What is stored.** An assistant message stores `contextRefs`: a fact key or claim id, plus a 12-character fingerprint of the exact text used. **No personal text is stored**, so forget/correct have no new copy to chase.
- **How it is resolved.** `GET /conversations/:id` resolves the references against the stores as they are now:
  - **unchanged:** shown;
  - **changed** (corrected / superseded): shown and marked "since changed", with no edit actions;
  - **forgotten / deleted / archived:** never shown, only counted ("1 more was used, and has since been removed");
  - **World Model unreachable:** counted as "couldn't be checked", never guessed.
  - Raw references are never returned.
- **Live check (both modes):**
  - the first answer's $49 came back marked changed;
  - the forgotten Spanish goal appeared on no reopened answer;
  - no raw references reached the client.

**Limitations of reopened answers:**

- Answers saved **before** this change have no references, so they show nothing.
- A changed item shows its current text, marked as changed. The exact old wording is not recoverable by design, because it isn't stored.

## 3. Legacy data and fixes made in this pass

| | Problem | What changed | Evidence |
|---|---|---|---|
| A | Stored merged goals (Mind) | **Review, not rewrite.** `GET /mind/review` (read-only) lists candidates using the same split rule as new input. The user chooses:<br>• **Split:** new goals inherit the original's dates and mentions. The original is kept, marked abandoned, with `splitInto` and a history entry, so its evidence survives in the export.<br>• **It's one goal:** recorded; stops asking. | `legacyReview.test.js` (8) |
| B | **Live source of merged goals in the fact store.** The fact extractor still saved "become a billionaire and build a company people love" as one goal item. Found in the live run, and the item went into prompts. | The extractor now splits goals with the same rule. The pure rules moved to `mind/goalText.js` so both writers share them, and the extractor doesn't import the Mind store. Already-stored merged items are offered for review and split through `correctFact`, so revision history keeps the old value. | Live: fact-store goals were separate in the final runs. Tests: extractor + split-item. |
| C | Factual questions carried the whole profile. Importance alone cleared the generic-query threshold. | When a question has no personal reference (I/me/my/we/our), names no category and isn't a recall question, only facts it explicitly names are kept. "Help me plan my week" keeps the profile. | Live V7: 3 items → 0. `answerInputTrust.test.js`. Eval gate unchanged. |
| D | "Profession: billionaire" and other values today's validators reject were hidden from the page and from prompts, so the user could no longer see or delete them. | Shown in the review as "Saved as your profession: 'Billionaire'. That reads like something you're aiming for, not what you do now", with the original quote. Choices:<br>• **Remove:** confirmed, uses the existing forget.<br>• **It's right:** recorded; it is shown and used again. | Same tests. Live: nothing written by this build was flagged. |
| E | Aspirational role beliefs: same blind spot as D. | Same review. "It's right" sets `reviewedAt`. | Same tests. |
| F | Inferences made "permanent" under the old rule | Reflection re-derives the flag. An inference loses only its permanent decay floor; its value, evidence and status are untouched, and the change is reported (`unsettled`). | `mind.test.js` |

Nothing is merged, rewritten or deleted without the user's action, apart from re-deriving the flag in F.

**UI.** The Memory page now has a "Worth a second look" panel. It also appears in the empty state, because a user whose only fact is the hidden one would otherwise see "AQUA doesn't know anything about you", with no way to remove it.

**Remaining legacy risk:**

- The review covers only the patterns above.
- Other wrong inferences need the existing per-item correct/forget.
- Users must open the Memory page to see the review. Nothing prompts them.

## 4. UI verification

- **Playwright audit** (real app, synthetic API, Chromium): **24/24 at 360 px and 1440 px.** That is 12 scenarios: home with threads; chat; chat error; context used (live and reopened); Memory; Memory review; Understanding; belief drawer; and dark mode for home, Memory and Understanding.
- **Earlier today:** 49/49 at 7 widths for the scenarios that existed then.
- **Screenshots looked at:** Memory review (1440), dark home (360), reopened answer with context (360).
- **Dark mode:** verified by emulating the system dark scheme in Chromium. Text is readable and nothing is clipped on the inspected pages.
- **Not verified:**
  - real WebKit / iOS Safari (not installed);
  - the Android app;
  - a real phone;
  - dark mode at the other 5 widths.
- **New vs returning users:** covered by the vitest suites (`homeThreads`, `welcomeLine`) and the Playwright home scenario. The mobile conversation-list fix has a unit test.

## 5. Regression (all run in this pass)

| Suite | Result |
|---|---|
| Aqua backend battery (per directory, Postgres :55432, Redis :56379) | **4,564 tests: 4,559 pass, 1 fail, 4 skipped.**<br>• **The failure was mine:** `dbPool.test.js` "only declared consumers import the pool". The reopened-answer route imported the DB pool directly. **Fixed** by going through the Brain facade (`claimsForProvenance`). That test now passes.<br>• **Reruns after the fix:** `src/core` 3×, plus `src/brain` 1456/1456, `src/routes` 308/308, `src/memory` 221/221.<br>• **Remaining intermittent failure:** only `perfShape.test.js`, a wall-clock timing test, in 1 of 3 core runs. It is not touched by these changes and passed 3/3 alone earlier today. |
| `npm run test:platform` | 287/287 |
| `npm run eval:gate` with the disposable Postgres (`AQUA_TEST_DATABASE_URL`) | **PASS: all 18 gated suites.** Includes `context-canonical` and `context-canonical-heldout`, run for the first time in these passes. `extraction-core` shows metrics with no baseline (new when a test DB is configured). |
| Frontend: `tsc -b`, `eslint`, `vitest`, `vite build` | clean · 0 errors (6 existing warnings) · **171/171** · built |

**Eval reliability finding, not caused by these changes.** `context-canonical-heldout` intermittently reports nDCG@8 0.7735 → 0.7701.

- **Committed HEAD:** 5 of 6 runs (an extracted HEAD snapshot).
- **Working tree:** 2 of 5 runs.
- Turning off the new retrieval gate or episodic recall did not change it. It is nondeterminism in the suite: one query flips between two rankings.
- The `context-canonical` baseline is stale: HEAD already beats it.
- Both should be fixed before that gate is relied on (stable ordering, refreshed baseline).

## 6. Known limitations

- **Keyword collision.** "Explain how photosynthesis works" still pulls the user's profession, because the existing keyword index reads "works" as the WORK category. This is pinned in a test as a known limitation and not changed in this pass.
- **Authoritative mode** (the World Model) still injects a project claim ("Tidepool") into some impersonal questions. Its relevance gate is a different system from the fact gate fixed here. In the final runs the factual question got 0 items, but this was not proven in general.
- **Mind block.** The stated/inferred labelling and the Mind block apply only in legacy read mode (current production). With a database, the Mind block is not injected.
- **Reopened answers** saved before this change show no context.
- **Home dismissals** are per device. Home threads come only from the World Model or from established Mind goals.
- **Not done:** v4 / final held-out evals, and the founder journey script with its own checks. This pass used its own driver, which reuses the journey's helpers.

## 7. Moving this into the main development branch (safest path; nothing done)

1. Review the uncommitted diff in `aquiplex-fix`. Today's reports explain each part: `YC_48_HOUR_RELEASE_REPORT.md`, `YC_UI_LEAK_AUDIT_REPORT.md`, `CONTEXT_AWARENESS_PASS_2026-10-28.md`, and this file.
2. Commit on `fix/yc-demo-safety-2026-10-28` in reviewable pieces:
   - **(a)** security: OAuth state/PKCE, Android cookie flush;
   - **(b)** episodic recall port;
   - **(c)** UI leak fixes;
   - **(d)** understanding fixes and context used;
   - **(e)** legacy review and this pass.
3. Push the branch and open a PR against `main`. CI runs `eval:gate` without Postgres. Also run the Postgres suites as here.
4. Merge only after the security operator steps in `YC_48_HOUR_RELEASE_REPORT.md` §2 (credential rotation, making the repo private, `PLAY_APP_SIGNING_SHA256`). Those still block a safe public launch.
5. Do not merge `aquiplex/world-model-pass2` separately. Its uncommitted recall work is already in this branch, minus the sensitivity gap.

## Key files (this pass)

- **Backend, new:**
  - `aqua/src/mind/goalText.js`
  - `aqua/src/mind/legacyReview.js`
  - `aqua/src/memory/contextProvenance.js`
- **Backend, changed:**
  - `routes/chat.js`: faithful `contextUsedItems`, `contextRefs` on save, claim `value`
  - `routes/conversations.js`: resolved context, read through `brain/index.js` `claimsForProvenance`
  - `routes/memory.js`: `confirm`, `split-item`
  - `routes/brain.js`: claim `value`
  - `mind/mindRoutes.js`: review, split, belief review
  - `memory/memoryRetriever.js`: `factPromptLine`, impersonal gate
  - `memory/candidateExtractor.js`: goal split
  - `memory/conversationStore.js`: message extras
  - `memory/factVisibility.js`, `mind/mindPresentation.js`, `mind/mindRetriever.js`: user confirmation respected
  - `mind/confidence.js`, `mind/reflectionEngine.js`: flag re-derivation
  - `mind/goalTracker.js`: uses `goalText`
- **Frontend:**
  - `components/memory/ReviewPanel.tsx` (new)
  - `components/chat/ContextUsed.tsx`
  - `pages/MemoryPage.tsx`
  - `api/mind.ts`, `api/memory.ts`
  - `types/api.ts`, `types/chat.ts`
  - `stores/chatStore.ts`
  - `components/chat/MessageBubble.tsx`
- **Tests, new:**
  - `mind/tests/legacyReview.test.js`
  - `memory/tests/contextProvenance.test.js`
  - `test/reviewPanel.test.tsx`
  - additions to `answerInputTrust`, `contextUsed` (backend and frontend), `mind.test.js`, `e2e/ui-audit.spec.ts`
