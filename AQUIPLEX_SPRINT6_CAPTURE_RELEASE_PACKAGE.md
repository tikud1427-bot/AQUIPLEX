# Sprint 6 — Capture Integrity V1: Release Package

**Date:** 2026-11-11 · `main` @ `839ea0d1` · **Prepared, not committed, not deployed.**

**Package:** `release/capture-integrity-v1/`

| File | Contents |
|---|---|
| `capture-integrity-v1.patch` | A git-format patch **against HEAD `839ea0d1`**, 9 files, 1,035 lines. sha256 `678b0c6069676cd2…` (`PATCH.sha256`) |
| `FILES.sha256` | sha256 of each of the 9 files as they stand in the working tree |

The patch is a **copy** of these changes. The working tree is unchanged: no file was moved, staged or reverted.

## 1. Exact file list

| # | File | At HEAD | Content in the package |
|---|---|---|---|
| 1 | `aqua/src/understanding/speechAct.js` | absent | Speech-act classifier (Sprint 4). No imports. |
| 2 | `aqua/src/memory/memorySchema.js` | tracked | Capture only: 37 digit-aware terminators; `orgName`, `placeName`, `relationName`; 2 job-change patterns |
| 3 | `aqua/src/mind/goalTracker.js` | tracked | Capture only: goals read from `assertedText(...)` |
| 4 | `aqua/src/memory/candidateExtractor.js` | tracked | **Capture:** the speech-act gate, `truncatedNumber`, `speechAct`/`hedged` fields, `NO_MATCH … act=`. **Sprint 1 dependency:** `logSafety` import, `MATCH`/`NO_MATCH` lines as metadata. |
| 5 | `aqua/src/memory/memoryExtractor.js` | tracked | **Capture:** `metadata.speechAct`. **Sprint 1 dependency:** `logSafety` import, 4 log lines as metadata. |
| 6 | `aqua/src/core/logSafety.js` | absent | Sprint 1 log-privacy helpers (imports only `node:crypto`) |
| 7 | `aqua/src/understanding/tests/speechAct.test.js` | absent | 9 tests |
| 8 | `aqua/src/memory/tests/captureIntegrity.test.js` | absent | 16 tests |
| 9 | `aqua/src/core/tests/logSafety.test.js` | absent | **New in Sprint 6:** 7 tests of `logSafety.js` itself. Before this, it was covered only through Sprint 1 call sites outside the package. |

Diff size, from `git diff --stat`:
- tracked files: 4 files, +138 / −49;
- new files: 5 files, 559 lines.

## 2. Dependency chain (reviewed)

```
memoryExtractor.js ──► candidateExtractor.js ──► speechAct.js        (no imports)
        │                    │            └────► memorySchema.js     (unchanged imports)
        │                    └─────────────────► logSafety.js ──► node:crypto
        └──────────────────────────────────────► logSafety.js
goalTracker.js ──► speechAct.js
               └─► memory/sentenceParser.js (splitSentences — exists at HEAD, unchanged)
```

- **Required dependency: `core/logSafety.js`.** The Sprint 1 log-privacy hunks in files 4 and 5 import it, and so does the new capture log line. Shipping the log hunks is itself a privacy fix: at HEAD those two files log user sentences and values verbatim.
- **Not required:**
  - the other 19 Sprint 1 call sites of `logSafety.js` (they stay out of this package);
  - `utils/logSafety.js` (CJS, platform);
  - flags, mirror and turn-commit changes;
  - anything in `brain/`.
- **Confirmed absent from the patch:**
  - the Information Needs engine and the hybrid: the strings `contextEngine`, `informationNeeds` and `AQUA_INFO_NEEDS` occur 0 times;
  - `routes/chat.js`, flags, benchmarks, evaluation code, documents.
- **Runtime paths reused unchanged from HEAD:**
  - `hedged` uses the existing resolver rule "hedged never replaces confirmed";
  - `metadata.speechAct` uses the existing `longTermMemory` metadata passthrough.
- **Data:** no migration, no backfill, no store rewrite (verified in Sprint 5 statically and dynamically).

## 3. Isolation proof: the package applied to a clean HEAD

**Method:**
1. `git archive HEAD aqua` was exported **twice** into the session scratchpad: `head/` (pure HEAD) and `pkg/` (HEAD + patch).
2. `git apply` applied all 9 files cleanly to `pkg/`.
3. The 6 source files in `pkg/` equal the working-tree files byte for byte (CRLF-normalised sha256).
4. `node_modules` was linked (a junction), not copied.
5. The full `src` battery ran in each export.

| Export | Tests | Pass | Fail | Skipped | Todo |
|---|---|---|---|---|---|
| `head/` (HEAD only) | 4,572 | 4,537 | **13** | 15 | 7 |
| `pkg/` (HEAD + capture package) | 4,604 | 4,570 | **12** | 15 | 7 |

- **The failing tests are the same set in both**, except `LINEAR work passes`, which failed on HEAD only (a timing test, sensitive to load). The package therefore introduces **no new failure**, and its 32 added tests all pass.
- **The 12 shared failures come from the export method, not the package.** The export contains only `aqua/`. Tests that read the repository root (dev compose file, the platform's `/metrics` mount, flag scans of the root `index.js`) fail, as do environment-dependent tests:
  - NVIDIA key aliasing;
  - Redis rate-limit live test;
  - `atomicStore`;
  - `e11ApiSurface`;
  - registry census.

  They fail identically on pure HEAD.

## 4. Diff review (summary)

| Change | Risk | Review note |
|---|---|---|
| Speech-act gate before extraction | A statement misread as a question loses its structured capture (its words stay in recall) | 45-sentence comparison against HEAD in Sprint 5: only intended differences. Guards for sentence-initial nouns are tested. |
| Digit-aware terminators (37) | A value may now run past `,`/`.` followed by a digit | Covered: thousands separators, decimals, `€1,250.50`, `£3.5k`, `12.5%`, `1.5 million`, sentence-final numbers. |
| `orgName`, `placeName`, `relationName` | Capture ends earlier at a lowercase predicate | Case-sensitive: "Marks and Spencer", "Stoke on Trent" and lowercase-only writers are tested. |
| 2 job-change patterns | A new workplace from "started a new job at X" / "joined X as" | The name must be capitalised; "my brother … joined" is not the user's. "I now work at X" is deliberately left to the existing change path. |
| Goals only from asserted text | Fewer inferred goals | Aspirations as requests ("help me become…") are still goals; task requests are not. |
| Log lines → metadata | Less debugging detail in production logs | `AQUA_LOG_CONTENT=local` restores content locally; it is refused on Render and in production. |

## 5. Tests (working tree; commands from `aqua/`)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs src/memory src/mind src/understanding` | 858 pass, 0 fail, 7 todo (Sprint 5; these files are unchanged since) |
| `node scripts/run-tests.mjs src/core/tests/logSafety.test.js` | 7/7 |
| Full `src` battery in the `pkg/` export | see §3 |

## 6. How to apply (when approved; not done)

```
git switch -c release/capture-integrity-v1 839ea0d1      # from a clean checkout of HEAD
git apply --check release/capture-integrity-v1/capture-integrity-v1.patch
git apply release/capture-integrity-v1/capture-integrity-v1.patch
sha256sum -c release/capture-integrity-v1/FILES.sha256   # every file matches
cd aqua && node scripts/run-tests.mjs                    # full battery
```

Suggested commit split:
1. `logSafety.js`, its test, and the 5 log hunks in the two extractors (privacy);
2. the capture changes and their 2 test files.

## 7. Rollback

| Situation | Action | Data |
|---|---|---|
| Before merge | Delete the branch | none |
| After deploy, behaviour problem | Revert the capture commit(s) and redeploy, or redeploy the previous commit from Render (Events → Rollback) | Facts stored while the package was live follow its rules and stay stored. There is no automatic reversal and no migration was introduced. |
| Logs too sparse to debug | `AQUA_LOG_CONTENT=local` on a **local** machine only (refused on Render and in production) | none |
