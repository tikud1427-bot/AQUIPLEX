# YC UI leak audit — 2026-10-28 (evening)

Worktree `aquiplex-fix`, branch `fix/yc-demo-safety-2026-10-28`. All work below is
**uncommitted**, on top of the branch's 4 local commits and the afternoon's
uncommitted security work (OAuth state/PKCE, Android cookie flush, episodic
recall port), which was left intact. Nothing committed, pushed or deployed.

This is the **second** UI pass today. The first (commit `1c2b4128`, plus this
afternoon's uncommitted §1.4 of `YC_48_HOUR_RELEASE_REPORT.md`) already fixed the
screenshot regressions: goal shown as profession ("billionaire"), "zero and I'm a
student" under a net-worth heading, `event` rows, `alpha`/`frac` domains,
`custom_` headings, the 53 % ring, goal progress bars, forecast %. Those fixes
were re-verified here (tests and screenshots), not redone.

## 1. Findings in this pass and their root causes

| # | Leak | Root cause | Class |
|---|---|---|---|
| 1 | A failed chat turn showed **"All providers exhausted \| task=reasoning \| chain=gemini:failed(config) → groq:failed(config) → openrouter:failed(config) → nvidia:failed(config)"** in the bubble (captured verbatim from the real route). The JSON also carried `providerErrors` (upstream bodies, which can quote part of an API key) and provider names in `fallbackChain`. | `routes/chat.js` returned `err.message` (the router's log line) on both `POST /chat` and the SSE `error` event. The client rendered `body.error` as-is. | Internal leak / privacy |
| 2 | Other 500s returned raw `err.message`: Brain API (`guarded()`, claim correction), and the platform's last-resort Express handler (`⚠️ ${err.message}`). These include driver errors with hosts and collection names. | Same pattern: the message was meant for the log. | Internal leak |
| 3 | "Why Aqua believes this" (belief drawer) printed **"Strongest signals: task:simple_qa; extracted fact: custom_networth. Previously believed: {"name":…}"**, and evidence rows like `task:simple_qa`. | `GET /mind/beliefs/:dim/:key` returned `explainBelief()` (engine wording). It was the one Understanding route that bypassed `mindPresentation.js`. | Internal leak |
| 4 | Belief **confidence percentages** were still on the Identity cards, the Belief drawer, the Communication panel ("confidence 73 %"), the "More confident: x (40 % → 55 %)" feed line, and the "fairly sure" label on the intro card. | Belief confidence is not calibrated: it starts at `0.25 + changeRate × strength`, or 0.9 for any schema match. | Misleading data |
| 5 | Every goal said **"priority 5"**. | `createGoal({ priority = 5 })`. Nothing in the app ever sets another value. | Misleading data |
| 6 | **"What Aqua expects next"** forecasts: "Likely to continue debugging this issue", "Next questions likely about: …". | Fixed-score templates (0.7 / 0.6). The grounded ones (deadline, blocker, goal) repeat the Goals and Attention sections. | Misleading data |
| 7 | **"Established: domain:alpha" / "Established: custom x"** in the learning feed. | The feed sliced raw reflection keys (`knowledge:domain:alpha`) instead of looking up a shown belief. `custom_` became "custom " after `_`→space, so it slipped past the guard. | Internal leak |
| 8 | Hero count, "Remembered" stat and the arcs counted different things (archived/`custom_` beliefs, dropped goals). The ring's shading used average confidence, while its caption said "fainter arcs rest on less evidence". The heatmap tooltip read "2.7 activity". | No shared visibility rule; arbitrary weights. | Misleading data |
| 9 | **Destructive actions with no confirmation and no real result:** the drawer's "Forget this entirely" deleted on one tap and removed the belief even if the server returned `success:false`. "Delete the entire model" swallowed failures (unhandled rejection; the buttons simply reset). Memory-page trash icons deleted on one tap. Failures said "Check your connection" whatever the cause. "Not mine" on Projects failed silently. | Optimistic updates with no result handling. | Data correctness / trust |
| 10 | **"Forget everything" left "What Aqua knows now" on screen.** The server clears the World Model too (`forgetAllFacts`), but the page only emptied the legacy notes list. | Client state not re-read after the operation. | Stale info |
| 11 | Upload failures showed parser exception text, cut mid-word at 40 characters in the chip. | `fileEngine.js` passes `err.message` through. The chip used `.slice(0, 40)`. | Internal leak / layout |
| 12 | **Design-system bug:** `cn('text-micro', 'text-primary')` silently dropped `text-micro`. Badges, the composer character counter, the Patch status pill, the Artifact card path and the attachment status line all rendered at the inherited size. Found in the 1440 px screenshot. | `tailwind-merge` doesn't know the custom type scale (`--text-micro/caption/body/lead`) and treats `text-micro` as a colour. | Visual |
| 13 | "Not mine" / "Not quite" were **invisible on phones**. | `opacity-0 group-hover:opacity-100`. The repo's touch-safe `hover-reveal` utility wasn't used. | Visual / a11y |
| 14 | At 1024 px the "Mind evolution" heatmap hid **"This week"** (the newest data) off the right edge of its own scroller. | `min-w-[420px]` inside a ~400 px column. | Visual |
| 15 | Long URLs, file names and goal titles: goals were clipped to one line; memory rows and claims had no wrap rule (global wrap applies only to Markdown prose). | Missing `overflow-wrap`. | Visual |
| 16 | The reflection toast narrated live work ("Adjusting confidence…", "Refreshing predictions…") after the reflection had already run. | Decorative copy. | Misleading |
| 17 | Belief drawer: a failed evidence load showed "Tracing evidence…" forever; the raw dimension id (`decision`) was the eyebrow. | No error state; no label mapping. | Internal leak / UX |

**Checked and found sound (no change):**
- Cross-account isolation: store-reset registry with a structural test, cache clearing, full-page `replace` on sign-out.
- Server authorization on conversations, memory, artifacts and file previews (`authScoping`, `artifactRoutes`, `uploadAuth` tests).
- The diagnostics panel is behind the opt-in Developer mode and never renders provider names.
- `MemoryControlUnavailable` text is already user-safe.

## 2. Changes

**Server (backward-compatible: same fields and statuses, except the removals listed):**
- `aqua/src/routes/envelope.js`: `publicErrorMessage(err)`. It returns "Aqua is busy right now…" when `retryable`, otherwise "Aqua could not finish that request…".
- `aqua/src/routes/chat.js`: both failure paths use it. `providerErrors` was removed, and `fallbackChain` in error responses carries only `outcome`/`reason`. `retryable`, `errorType`, `retryAfterMs`, `Retry-After` and the 503/500 split are unchanged (AQEval contract). The success payload is unchanged.
- `aqua/src/routes/brain.js`: 500s and the correction 409 return sentences. The detail is logged.
- `index.js`: the last-resort handler no longer echoes `err.message`.
- `aqua/src/mind/mindPresentation.js`: `presentExplanation()`. `mindRoutes.js` uses it for `GET /mind/beliefs/:dim/:key`. The shape is the same.

**Frontend (presentation boundary):**
- `src/lib/userError.ts` (new): `userErrorMessage()`, a second line for older servers. It replaces router chains, provider names, stack frames, driver/SQL errors and key fragments with a sentence; guard sentences pass through. Used in `api/client.ts` `normalizeError`, `stores/chatStore.ts` (stream errors) and `stores/attachmentStore.ts`.
- `src/lib/displayGuard.ts`: `isDisplayableBelief` (one rule for cards, counts and the feed), `beliefBasis` (explicit / correction / file / inferred, with unknown → null), `evidenceCountText`, `dimensionLabel` (unknown → null).
- `src/components/ui/provenance-badge.tsx` (new) replaces `confidence-badge.tsx` (deleted) and `confidenceTone` (removed). Stated facts and inferences look different.
- `src/lib/utils.ts`: `cn` uses `extendTailwindMerge` with the type scale (fixes finding 12 everywhere).
- `features/mind/*`: `IdentitySection`, `BeliefDrawer` (confirm, real result, error state, labels), `ModelSections`, `NowSections` (no default priority, unknown status safe, wrapping titles, forecast component removed), `StorySections`, `UnderstandingRing`, `ReflectionAndPrivacy`.
- `features/understanding/*`: `UnderstandingSections` (hover-reveal, real result), `WorldModelCard` (no confidence label, hover-reveal).
- `pages/MindPage.tsx` (forecast section removed), `pages/MemoryPage.tsx` (confirm every delete, remove only on server success, forget-all re-reads the server, wrap, no duplicated group heading).
- `stores/mindStore.ts` (`learnedCount` and `dimensionEvidence` by the visibility rule; feed lines without percentages or raw keys; errors via `normalizeError`).
- `components/upload/AttachmentChip.tsx`.

**By concern:**
- Data correctness: 4, 5, 6, 8, 9, 10, 16.
- Privacy / secrets: 1, 2 (server-side, so not a CSS hide).
- Internal leakage: 1, 2, 3, 7, 11, 17.
- Visual / layout: 12, 13, 14, 15.

## 3. Tests and commands (all run in this session)

| Command | Result |
|---|---|
| `npx tsc -b` (aqua-frontend) | pass, 0 errors |
| `npx eslint .` | 0 errors, 6 warnings (existing `react-refresh/only-export-components` pattern) |
| `npx vitest run` | **148/148** (11 files) |
| `npm run build` | pass (the existing >500 kB chunk warning is unchanged) |
| `node scripts/run-tests.mjs` routes + mind + understanding + providers (54 files) | **673/673** |
| same, memory + brain (90 files) | **1341/1341** |
| `npm run test:platform` | **287/287** |
| `npx playwright test e2e/ui-audit.spec.ts`, all 9 config projects | 35 pass; **10 fail to launch**: the 390-ios and 768-tablet projects need WebKit, which is not installed here |
| same spec, 390 and 768 in Chromium (temporary config, deleted) | 10/10 |

**New and changed tests:**
- `aqua/src/routes/tests/chatErrorExposure.test.js` (new). It produces a real provider exhaustion by removing all keys, then drives both `POST /chat` and `/chat/stream`. This closes the gap `chatEnvelope.test.js` documented. It fails against the old code with the chain quoted above.
- `uiPayloadContract.test.js` gains a drawer-explanation test. It fails against `explainBelief`.
- `src/test/uiLeakRegression.test.tsx` (new, 13 tests):
  - error sanitising;
  - `cn` keeps the type scale;
  - unknown enum values;
  - no forecasts;
  - feed seeding;
  - no % and no default priority on the whole page;
  - drawer forget (confirm → server 503 shown → success closes);
  - Memory delete (confirm, failure keeps the row, server reason shown);
  - forget-all re-reads;
  - model erase failure.

  Mutation-checked: removing the forget-all reload, or restoring key-slicing in the feed, each fails its test.
- `unsupportedNumbers.test.tsx`: +2 (no default priority; cards and Communication say stated/inferred plus "seen N×", no %).
- `e2e/ui-audit.spec.ts` (new): the real app with **synthetic** API fixtures. Per page and viewport it checks for sideways scroll, elements past the right edge, and leak strings. Optional screenshots go to `AUDIT_SHOTS`.

**Expectations changed, and why:**
- `uiLeaks (i)` asserted the badge reads "confidence 100%". It now asserts no percentage at all, which is the stronger requirement in this brief.
- `uiLeaks (g)` and `unsupportedNumbers` "forecasts print no probability": the forecast component no longer exists. Its coverage moved to a page-level "shows no forecasts" test.

## 4. Pages and viewports actually inspected

Screenshots taken with the synthetic fixtures and **looked at**:
- Understanding at 1440, 1024, 360 and 320.
- Memory at 360.
- Chat conversation (table → cards, KaTeX, code, long URL) at 360.
- Chat failure at 1440.
- Belief drawer at 360.

Automated layout and leak checks (no visual review) ran on these pages at 320, 360, 390, 412, 430, 768, 1024, 1280 and 1440: chat conversation, chat error, Memory, Understanding, belief drawer.

**Not inspected:**
- Projects / workspace dashboard, Settings dialog, Intro (`/understanding/start`) flow, Artifacts panel, Patch card, Privacy policy, login pages (server-rendered EJS).
- Dark theme.
- Real WebKit / iOS Safari.
- The Android WebView.
- Keyboard-only navigation beyond the focus rings added to the drawer controls.

KaTeX fonts 404 on the **dev** server in this worktree, because `node_modules` is a junction outside Vite's allow-list. The production build bundles them, so screenshots use fallback glyphs.

## 5. Remaining risks and manual steps

1. **Real data and a real browser are unverified.** Run the founder journey with real keys, then `node e2e/demo-screens.mjs` (DEMO_RUNBOOK.md) and look at Memory and Understanding.
2. The **success** chat payload still carries `provider`/`providerScore`/`fallbackChain` (visible in DevTools, not rendered). It was left because eval clients read it. Decide before launch whether to gate it behind developer mode server-side.
3. The frontend cannot recognise markup "domains" (`alpha`) on its own. That rule is server-side (`domainTopics.js`, contract-tested). An older server build would show them.
4. Upload parser messages are sanitised only on the client. Server-side `fileEngine.js` still returns `err.message` for the owner's own file.
5. "Not mine" on Projects removes without a confirmation dialog. It is a correction and now reports its result.
6. Run `npm run test:e2e:install` to add WebKit, then run the iOS and iPad projects.
7. The security items in `YC_48_HOUR_RELEASE_REPORT.md` §2 (credential rotation, making the repo private, `PLAY_APP_SIGNING_SHA256`) are untouched and still block a safe public launch.

## 6. Ready for a controlled YC demo?

**Ready for a controlled demo on the Chat, Memory and Understanding pages, conditional on step 1 of §5.** Evidence:
- Every leak class in the brief has a fix at the layer that produced it, plus a test that fails without it.
- Chat errors no longer expose routing.
- No uncalibrated number remains on the Understanding page.
- Deletes confirm and report the real result.
- The audited pages pass the overflow and leak checks at all nine widths in Chromium.

**Not claimed:** that the whole application is clean (see the uninspected routes in §4), or that it behaves the same on real data, WebKit or the Android app.
