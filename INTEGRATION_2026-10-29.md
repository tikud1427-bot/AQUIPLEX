# Integration of `fix/yc-demo-safety-2026-10-28` into this repository — 2026-10-29

**Destination:** this repository, `C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform`, branch `aquiplex/world-model-pass2`. All changes are **uncommitted** in the working tree. Nothing was committed, pushed, merged or deployed.

**Source:** `C:\Users\dell\Downloads\aquiplex-platform\aquiplex-fix`. Same git repository (a second worktree). Left exactly as it was: same branch, same HEAD `aebb81df`, the same 92 changed entries.

## Backup taken first (verified)

`C:\Users\dell\Downloads\aquiplex-platform\backups\main-wip-2026-10-29\`:

- `main-wip-files.tar` holds byte copies of all 21 files this repository had changed or added. Verified by extracting the tar and checking SHA-256 for all 21.
- `main-tracked-changes.patch` (`git diff --binary`) was verified to apply cleanly to `f388893e`.
- `README.txt` explains how to restore.

## How the integration was decided

- **Base.** `f388893e` (this branch's HEAD) is the merge base. The source's two merge commits carry an identical tree.
  - main = base + 21 working-tree changes;
  - source = base + 4 commits + working-tree changes = 126 files.
- **19 files changed on both sides.** A three-way dry run showed 10 byte-identical and 9 different.
  - In all 9, every line found only here was a line the source **deliberately replaced**:
    - raw error text → `userErrorMessage` (no router chain in chat bubbles);
    - recall without a health/mood filter → `recallRedaction(…, sensitive)`;
    - `chat.js` echoing provider errors → `publicErrorMessage`;
    - post-turn writers given the raw turn → the sensitivity-filtered view;
    - the founder-journey checks: kept, gated `if (!YC)`.
  - Nothing of this repository's episodic recall, recall redactions or recall tests was lost. The source's versions contain all of it, plus the sensitivity filter.
  - So the source version was taken for those 9, based on that line-level review.
- **107 source-only files** were brought in, plus 1 deletion: `components/ui/confidence-badge.tsx`. Its copy here was unmodified, and all four of its importers were replaced by versions using `provenance-badge.tsx`.
- **Kept untouched here** (verified by hash): `AQUA_EPISODIC_RECALL_2026-10-20.md` and `aqua-frontend/android/gradle/wrapper/gradle-wrapper.properties`.
- **Not brought in:** `demo/screens/*.png` (4 generated screenshots; regenerate with `aqua-frontend/e2e/demo-screens.mjs`).
- **Never copied:** `.env`, credentials, `node_modules`, build output, caches.
- **Secret scan:** all changed and untracked files, no matches. The `.env.example` values are `<placeholders>`.

**Result.** This repository now equals the source working tree everywhere except the 2 files kept and the 4 screenshots.

## What it contains

All of the source branch, not only the context work. The context-awareness code depends on the earlier passes in the same files: the sensitivity policy used by retrieval, display labels, provenance badges and error sanitising.

- **Security:**
  - Google OAuth `state` + PKCE (login/link CSRF takeover fix);
  - Android WebView cookie flush;
  - `.gitignore` for session dumps.
- **Privacy:**
  - health/mood details not stored or injected by default (`memory/sensitivity.js`);
  - opt-in `privacy.rememberSensitive` (defaults false; no migration);
  - the same filter on episodic recall.
- **UI honesty:**
  - no engine internals, router chains or uncalibrated percentages;
  - delete confirmations that report the server's real result.
- **Context awareness:**
  - goal split / cue / negation fixes, in both the Mind tracker and the fact extractor (`mind/goalText.js`);
  - inferences are never made permanent by repetition;
  - stated vs inferred labels in the prompt;
  - aspirations and rejected values kept out of prompts;
  - impersonal-question gate;
  - home "On your plate" threads;
  - "Context used", checked against the final prompt, with references kept for reopened conversations (`memory/contextProvenance.js`);
  - legacy-data review (`mind/legacyReview.js`, `ReviewPanel`);
  - Understanding section index; Memory group order.
- **Reports:**
  - `YC_48_HOUR_RELEASE_REPORT.md`, `YC_UI_LEAK_AUDIT_REPORT.md`, `CONTEXT_AWARENESS_PASS_2026-10-28.md`, `CONTEXT_VALIDATION_2026-10-29.md`;
  - `SECURITY_ROTATION_CHECKLIST.md`, `DEPLOY_2026-10-28.md`, `DEMO_RUNBOOK.md`, `PATCH_2026-10-28.md`.

## Tests run here, after integration

| Check | Result |
|---|---|
| Aqua backend battery (per directory, Postgres :55432, Redis :56379) | **4,564 tests: 4,560 pass, 0 fail, 4 skipped** |
| `npm run test:platform`, with the live account-security suites on a fresh disposable Mongo | **314/315**. The single failure is `repoHygiene` "build residue does not accumulate at the root". It is caused by three git-ignored `.patch` files at this repository's root (dated Sep 29 – Oct 15). They are not part of the integration and were left alone. |
| `npm run eval:gate` (CI mode) | PASS: 16 suites, all metrics unchanged |
| `context-canonical` and `context-canonical-heldout` (disposable Postgres) | `context-canonical` PASS (improved over a stale baseline). `context-canonical-heldout`: PASS / nDCG 0.7735→0.7701 / PASS over 3 runs. This is the known flake; the committed pre-integration code shows it in 5 of 6 runs. |
| Frontend `tsc -b` · `vitest` · `vite build` | clean · **171/171** · built |
| ESLint, `src` + `e2e` | 0 errors, 6 warnings, identical to the source. Linting the whole folder also reports 2 errors in the git-ignored Android build output (`android/app/build/intermediates/**/native-bridge.js`), which is not source. |
| Playwright UI audit (Chromium, 360 + 1440, light + dark) | **24/24** |
| **Real-provider end-to-end from this repository** (real launcher, `.env` keys, disposable stores, prompt capture) | **legacy (production) mode 33/33. Authoritative mode 31/33.** The two misses are the known ones: the Mind block is not injected in that mode by design, and the control answer used "churn" generically. |

## Not verified / remaining

- WebKit/iOS, the Android app, a real phone.
- The v4 / final held-out evals.
- The security operator steps in `YC_48_HOUR_RELEASE_REPORT.md` §2: credential rotation, making the repository private, `PLAY_APP_SIGNING_SHA256`.
- **Remove or move the three root `.patch` files** if `repoHygiene` should pass. That is your decision.
- **Commit** in reviewable slices when you authorise it: security / privacy / recall / UI honesty / context awareness.
