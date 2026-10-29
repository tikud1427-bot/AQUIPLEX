# Context-awareness pass — 2026-10-28 (night)

Worktree `aquiplex-fix`, branch `fix/yc-demo-safety-2026-10-28`. All changes are **uncommitted**. They sit on top of today's earlier uncommitted work (`YC_48_HOUR_RELEASE_REPORT.md`, `YC_UI_LEAK_AUDIT_REPORT.md`), which was built on rather than redone. Nothing was committed, pushed or deployed.

## What changed in behaviour (not just UI)

| # | Defect found in code | Fix | Proof |
|---|---|---|---|
| 1 | **Goals merged into one string.** `detectGoalTitles` used `text.match`, which takes only the first match per pattern. It also captured through "and". So "I want to launch the beta and hire a designer" became one goal, and a second "I want to…" sentence was dropped. | Global matching. Coordinated goals are split only when the next part starts with a new goal verb ("build and ship the app" stays one). Comma lists are handled. The fact-bridge path is split the same way. `mind/goalTracker.js` | `mind/tests/goalNormalization.test.js`: 10 tests, **9 fail on the old code**. |
| 2 | **Goals completed by unrelated messages.** An unmatched "finished/shipped" fell back to *the most recently mentioned goal*. "I finished lunch" completed "become a billionaire". "I haven't shipped it yet" completed a goal. | A status cue applies only to the goal the message names. Negated, hedged and conditional cues ("haven't", "almost", "once we…") are ignored. Light stemming means "launched the beta" matches "launch the beta". | Same file. |
| 3 | **Inferences became permanent by repetition.** `isEstablished` promoted any belief at 0.8 confidence after 3 observations. "Established" gives a permanent decay floor. | Only beliefs the user stated, corrected, or that came from their files can become established. Inferences stay usable and labelled, and keep decaying unless seen again. `mind/confidence.js` | `mind.test.js` reflection test: it asserted the old behaviour and now checks both sides. |
| 4 | **The model was still told "Profession: billionaire".** This morning's fix hid such values from the Memory page, but `retrieveRelevantFacts` kept injecting them into prompts. | Stored facts that fail today's validators are not injected. They stay stored and forgettable. `memory/memoryRetriever.js` | `memory/tests/answerInputTrust.test.js`: **3/3 fail on the old code**. |
| 5 | **Stated and inferred beliefs looked identical to the model.** Both were formatted as `trait (62%)`. Aspirational roles were also injected as identity. | Prompt lines now say `(user said)` or `(inferred, 62%)`, and aspirational role values are dropped. Selection logic is unchanged. `mind/mindRetriever.js` | Same file. |
| 6 | **Finished goals offered as ongoing.** The welcome selector matched closure by exact words, so "database migration is done" did not close "migrate the database". | Stemmed closure match. `brain/welcome/selector.js` | `welcome.test.js` K-block. |

## New product surfaces

**Home screen threads ("On your plate").**
- The welcome selector already ranked several grounded candidates (deadline, blocker, decision, goal, task, project) and threw away all but one. It now returns up to 3 more as `threads` (an additive field).
- They pass the same grounding check, sensitivity filter, evidence ids and lifecycle rules as the welcome line.
- Tapping one pre-fills the message box with the user's own words. Nothing is sent automatically.
- Each thread can be dismissed. Dismissals are remembered per device.
- New and sparse users get no threads, rather than filler.

**Context used under an answer.**
- The chat response now carries `contextUsed`. It lists the stored facts and World-Model claims that were actually injected for that answer, built from data the server already had, with the same label rules as the Memory page.
- It is collapsed by default, and absent when nothing about the user was used.
- Every item can be forgotten (confirmed first; the row changes only on server success).
- World-Model items can be corrected in place.
- After a change, the last answer offers "Regenerate with the change".

**Understanding page.** A section index (Identity · Goals · Right now · Projects & sources · Map · Timeline · Privacy) with deep links (`/mind#goals` etc.). No route moved.

**Memory page.**
- Groups are ordered by meaning: identity → work → goals → … → "Other things you've said" last. Previously the largest group came first.
- Each fact shows "You last said this …" when that differs from when it was learned. This uses the new additive `lastConfirmedAt` field (the existing `lastMentionedAt`).

**Mobile bug fixed.** Only the sidebar loaded the conversation list, and on phones the sidebar isn't mounted until opened. Returning phone users therefore saw no "Pick up where you left off", were greeted as new, and got an "Add a project" button. The home screen now loads the list itself.

## Tests run (this session, all observed)

| Command | Result |
|---|---|
| Aqua backend battery, per directory, Postgres :55432 + Redis :56379 | **4,548 tests: 4,543 pass, 1 fail, 4 skipped.** The failure was the timing-based `core/tests/perfShape.test.js`, which ran during a Playwright run. Rerun alone: **3/3 passes**. |
| `npm run test:platform` | 287/287 |
| `npm run eval:gate` (`DATABASE_URL=` as CI) | PASS: 16 suites, **all metrics unchanged**. `context-canonical(-heldout)` not run (needs Postgres), same as before. |
| `npx tsc -b`, `npx eslint .`, `npm run build` | Clean. 0 lint errors (6 existing warnings). Build passes. |
| `npx vitest run` | 163/163 (was 148). |
| Playwright `e2e/ui-audit.spec.ts`, 7 Chromium viewports 320–1440 | 49/49. Includes the new home and context-used scenarios. Screenshots were looked at (home 1440/412/360). |

## Not done or not verified

- **Real providers and real data were not run.** The founder journey, the held-out evals and any answer-quality measurement need `.env` keys, and loading those is refused in this environment. So there is **no measured evidence yet that answers improved**. What is proven is that the model is no longer fed a goal as a profession, is told which beliefs are guesses, and that goal records are correct.
- **Context used has no end-to-end test over HTTP**, because there is no provider seam for a successful `/chat` turn. The wiring is checked against the source code, the builder is tested against real retrieval output, and the UI is tested with mocks and Playwright.
- **Already-stored merged goals are not split.** The fix applies to new messages, and stored data was left untouched on purpose. Users can delete merged goals on the Understanding page.
- Context used is shown only for answers produced in the current session. It is not stored with conversation history.
- Dismissed home threads are remembered per device, not per account.
- Not inspected: dark theme, WebKit/iOS, the Android WebView.

## How to see it in the running app

1. Tell Aqua: "I want to launch the beta and hire a designer." Open Understanding → Goals. You should see two goals, not one.
2. Then say "I finished lunch". Both goals stay active. Say "We launched the beta!" Only that goal completes.
3. Ask something personal ("plan my week around my goals"). Under the answer, open **Context used**. It lists what Aqua knew. Forget or correct an item, then press **Regenerate with the change**.
4. Open a new chat. With World-Model data (Postgres read mode), **On your plate** lists up to three grounded items. Tap one and the composer is pre-filled. Press × and it stays gone.
5. On a phone, open the app. "Pick up where you left off" now lists your recent conversations.
