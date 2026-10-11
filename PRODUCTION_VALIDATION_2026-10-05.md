# Production validation — 2026-10-05

**Current verdict: PRODUCTION BLOCKED** (credentials, Part 2 §6); the D6
iteration (Part 3) is **VALIDATION INCOMPLETE**. Part 3 is the newest; Part 2 the
fix iteration before it; Part 1 the first validation pass, kept unchanged except
where later parts correct it.

# Part 3 — D6 iteration (reference resolution, ambiguity, measurement)

Same rules as Part 2: disposable infrastructure only, `.env` untouched, dev DB
and real MongoDB untouched, nothing committed. D5 is unchanged and its
regression is in the battery.

## 3.1 What changed (all tied to a measured D6 failure)

| Change | Why (evidence) | Where |
|---|---|---|
| **Rule 12 — reference context.** The extractor now receives a second fenced block: claims said earlier in *this* conversation (turn-ordered, via `aqua_sources.external_ref = <conv>:turn:<n>`) and the owner's current facts (`subject \| relation \| value`). It may resolve "it", "the backend", "the launch date", "No, it's Rust", "Not Go — Rust" to a subject **only when exactly one subject in the context fits**; otherwise it must leave the words as written or return nothing. The context is never a source of claims. Part of the extraction cache key. Prompt `extract-v5`. | Maya's live run: "the launch" refused as an unresolved description (×2), "It's written in Rust" refused as a pronoun (×1) | `extractionPrompt.js`, `extractionClient.js`, `canonicalReadModel.extractionContext`, `brain/index.js` |
| **Gate ⑤b.** S4 gate ⑤ ("the subject must appear in the sentence") rejected every resolved reference (`5:subject-not-in-segment`). A subject absent from the sentence is now admitted **only if** it is literally one of the subjects the extractor was given **and** the sentence refers to it — a third-person pronoun, a word of its name, or a value the context attaches to it. Otherwise the original refusal stands. The resolution is stored in the evidence locator (`contextResolved: {subject, via}`). | the deterministic live test: rule-12 output discarded at gate ⑤ | `claimValidator.js`, `pipeline.js`, `worldModelRepository.js` |
| **Sole-value revision (S8).** A claim marked `revises` on a **many-valued** relation that does not name the old value ("the backend is Rust now") retires the old value **only if the subject holds exactly one other current value** for that relation; with two or more it retires nothing and records an `ambiguousRevisions` entry. Single-valued relations are untouched (the snapshot rule already handles them). | "We switched the backend to Rust" / "The backend is Rust now" left Go current (Part 2) | `claimDedup.js` |
| `works_at` gloss names "my company / my employer". | "My company changed from Initech to Hooli" → `has_property` | `predicateRegistry.js` |
| D6 check: multi-turn cases with conversations, an **abstain** expectation, suites `agreed` / `agreed+` / `matrix`. | your §9 matrix | `scripts/d6-extraction-check.mjs` |

No sentence-specific rule exists anywhere: resolution is decided by the owner's
World Model (which subjects exist, which values they hold) and the model's
reading under rule 12; ambiguity is decided by counting current values.

## 3.2 D6 final status

Real production extractor (Groq `openai/gpt-oss-120b`), live Postgres, worker drain:
`eval/out/d6-extraction-check.v5.json` (+ `…v5-rerun.json`).

| Suite | Measured | Pass | Fail | **Unmeasured (Groq never answered after 6 retries)** |
|---|---|---|---|---|
| agreed (Part 2's 15) | 11 | **9** | 2 | 4 |
| agreed+ (former "limitation" cases) | 1 | 1 | 0 | 2 |
| matrix (§9, incl. 2 abstain cases) | 6 | **6** | 0 | 5 |
| **total** | 18 | **16** | 2 | 11 |

Passing on the real extractor, newly in this iteration: "Not Go — Rust." · "Not Go, it's Rust." · "The launch date changed to May 2." · "Actually, the backend is Rust." · "We switched the backend to Rust." · "My employer changed from Initech to Hooli." — and **both abstain cases retired nothing**: "Tidepool uses Rust now" after "Go and Postgres", and "It's written in Rust now" after two backends were named.

**Failures (2), and what they are:**
1. `city-negation-only` — "I don't live in Lisbon anymore." This run the extractor emitted the negation **without** `revises` (it did mark it in Part 2's run), so the unmarked polarity flip went to DISPUTED, as the policy requires. *Extraction variance, safe direction* (disputed, not wrongly current).
2. `job-changed-from-to` — "My company changed from Initech to Hooli." Still `Initech | has_property | Hooli` even with the clarified gloss and `self | works_at | Initech` in context. *Implementation defect in extraction (predicate choice)*; nothing wrong was retired, but the change is not recorded.

**Unmeasured (11)** — all three pronoun cases ("It's written in Rust", "It's now May 2", "I'm at Hooli now"), the conversational correction ("No, it's Rust"), "The company is now Acme", three launch cases, "We switched the backend from Go to Rust", "The backend is Rust now", the multi-fact case. Groq's daily capacity ran out mid-run (every key in an 18–25 min cooldown and re-limited at once). They are **not** counted as passes or failures. Deterministic evidence for the same mechanisms (scripted extraction, real pipeline, live Postgres): `d6Revision.live.test.js` 3/3, gate ⑤b unit tests 6/6.

**Stop condition: NOT MET.** On the agreed suite the measured result is 9/11 with 4 unmeasured; even if all 4 pass it is 13/15 < 14/15. Verdict for D6: **VALIDATION INCOMPLETE — provider capacity**, plus one real extraction defect (#2).

Next Groq window: `AQUA_TEST_DATABASE_URL=… node aqua/scripts/d6-extraction-check.mjs --only <the 11 ids> --json aqua/eval/out/d6-extraction-check.v5-rerun.json`.

## 3.3 E6

| | v3 (Part 1) | v4 (rule 11 + date gloss) | v5 (rule 12 + gloss) |
|---|---|---|---|
| precision | 97.5% | 97.5% | _running_ |
| recall | 84.2% | 84.0% | _running_ |
| negation (gate ≥ 95%) | 90.0% FAIL | **94.7% FAIL** | _running_ |
| modality detection | 66.7% | 58.3% | _running_ |
| transport errors | 5 | 9 | _running_ |

All on NVIDIA `openai/gpt-oss-20b`, 200 cases × 3 passes, so the rows are comparable to each other; none is the production extractor (Groq 120b, still unmeasured). v4: precision unchanged, recall −0.2 (inside run-to-run noise), negation +4.7, modality detection −8.4 (≈ 2 cases). Per case v3→v4: 7 correct→wrong, 9 wrong→correct (net +2), no modality case among the flips — consistent with noise, not proven to be. The E6 harness passes no context, so v5's measurement covers rule 12's *text* only; its effect with context is what the D6 check measures. **Gate status: not promotable on any version (negation < 95%).**

## 3.4 Longitudinal test (§12)

Real-provider run (real launcher + Groq chat and extraction): **BLOCKED — provider capacity** (same Groq exhaustion). Deterministic counterpart, in the battery (`canonicalReadFlip.live.test.js`, real `prepareTurn`, live Postgres, scripted extraction): initial city / employer / project state / technology / launch date → changed in later conversations → new conversation asks each — old value kept as history (superseded, evidence intact), new value current, production context carries the new value and never the old statement: **13/13**. The last real-provider longitudinal is Part 2's (Porto 3/3; launch date and Rust failed — the two refusals this iteration targets).

## 3.5 Re-explanation (§13)

Measurement check: the 21% (3/14) is a hand count over 14 answers by one rater (me), not an instrument; the denominator ("answers that depended on an earlier-conversation fact") is a judgement. Valid as a direction, too small for a rate. The built-in `/brain/reexplanation` counts only *volunteered* restatements and cannot see these.

| Case (Part 2, Maya) | Classification | Root cause (verified in logs) | Addressed? |
|---|---|---|---|
| "When is my app launching?" → March 15 | **extraction / ambiguous reference** | S6 refused "the launch" (`s6.refused={"description":2}`) — did not match the existing `launch date` entity | rule 12 + ⑤b; real-extractor "The launch date changed to May 2" now passes; the exact Maya sentence unmeasured |
| "What language is the backend?" → Go vs not Go | **extraction** + **context rendering** | "It's written in Rust" refused (`s6.refused={"pronoun":1}`); and the surviving `uses → Postgres` claim is rendered with its source sentence "…Go on Postgres" | pronoun: rule 12 + ⑤b (unmeasured live); rendering: **not addressed** |
| contractor plan asked for the timeline | **extraction-derived** + **intentional clarification** | no current launch date (row 1); the model asked rather than assume | follows row 1 |

No retrieval failure and no reasoning failure was found in the three: the remaining friction is extraction (reference resolution) plus one rendering issue.

## 3.6 Confidence / hedging (§14)

Source, measured: **all 737 current extracted claims carry the same stored confidence** (extraction 0.50, source 0.50), rendered to the model as `(confidence 0.66)`. The number is a constant, not a measurement — and the answer model reads it as "moderate confidence".

Classification of the 14 hedging answers (Part 2 live run):
- **3 appropriate** — a real dispute existed (backend Go/not-Go; budget $20k vs $35k ×2).
- **9 unnecessary exposure** — correct answer plus a meaningless "≈ 66%".
- **2 harmful** — the constant made the model doubt a clear answer ("current best-guess" table; "the current car can't be stated with certainty").

**Product decision needed** (not changed here): stop rendering a constant confidence and keep only meaningful status (disputed / no longer current), or make confidence informative (e.g. corroboration count, recency, user-explicit vs inferred) before showing it. The evidence says the current number adds caution without information in 11 of 14 cases.

## 3.7 Shadow writes (§15)

Verified by test (`dualWrite.test.js`): only the server installs the Postgres shadow; `worker.mjs`, `workerRuntime.js` and the launcher never import it. The 3 rejections after the abrupt kill are **expected crash-recovery behaviour**: those stores' last shadow writes never reached Postgres, so the row differs from the JSON the next instance loaded, and the guard refuses rather than overwrite something it never read. It is a durability gap only in the mirror (JSON is authoritative and intact); recovery is the existing `refresh()` / drift reconcile. No change made to zero the counter. Linux SIGTERM drain (which flushes the shadow) not verifiable on this Windows host.

## 3.8 Regressions retained

Full battery on the final tree (Windows, Node 24, live PG + Redis): **4,019 tests —
4,013 pass, 2 fail, 4 skipped**; `eval:gate` passed; production-loop doctor 27/27;
env-doctor clean. The 2 failures are environmental, not this change:
`editRoutes.test.js` ("8 passed, 0 failed", then the known libuv teardown abort)
and `perfShape.test.js` (a wall-clock linear-vs-quadratic test, file untouched;
2 of 3 isolated reruns pass while the E6 run loads the machine).

Retained and passing in that run: **D5** `canonicalReadFlip.live.test.js` 13/13
(Lisbon legacy / Porto canonical → production context Porto; flag-off control
still shows the stale legacy value) · **graph** `graphLaneCitations.live.test.js`
· **metrics** `metricsScrape.test.js` (200 token / 401 wrong / 404 unset) ·
**labels** `promptLabelLeak.test.js` · new: `d6Revision.live.test.js` 3/3,
gate ⑤b 6/6, sole-value revision 6/6, rule 12 prompt/client tests, shadow writer
pinned to the server.

## 3.9 Verdict

Overall: **PRODUCTION BLOCKED** (unrotated credentials, Part 2 §6). This iteration: **VALIDATION INCOMPLETE.** D6 improved where it could be measured (16/18 measured; both abstain cases correct; six previously failing phrasings now pass), but 11 cases are unmeasured because the production extractor's provider ran out of capacity, the agreed-suite stop condition (≥ 14/15) is not met even optimistically, one extraction defect remains ("my company changed"), the real-provider longitudinal run is blocked, and the E6 gate (negation ≥ 95%) is not met on any prompt version. Production remains blocked on the credentials (Part 2 §6) regardless.

---

# Part 2 — fix iteration (D5, D6, shadow store, graph, metrics, label leakage)

All work on disposable infrastructure: test Postgres 16 (:55432), local MongoDB
and Redis containers, sandboxed data dirs. `.env` was not modified (one read-only
fingerprint scan for §6). The real dev database and the real MongoDB were not
touched. Nothing is committed.

## 1. Changes made

| Area | Change | Files |
|---|---|---|
| **D5** read flip | `AQUA_CANONICAL_READ=on` now governs the **answer context**: the Context Engine gets an empty legacy floor, no evidence store, no Mind and an empty legacy graph (only canonical Postgres lanes contribute); `memoryRetrieve` skips the legacy user-world lanes (identity card, regex facts, Mind state, Mind graph, episodes) and keeps uploaded-document lanes. Same rule on `POST /intelligence/orchestrate`. Legacy **writes** unchanged → `=off` is a complete rollback. Per-call override `canonicalOnly` for tests. | `brain/index.js`, `memory/engine.js`, `routes/chat.js`, `routes/intelligence.js` |
| **D6** change language | Extraction prompt **rule 11** (`extract-v4`): a change/correction yields the new value asserted and, when named, the old value negated, both `revises: true`; three new few-shot examples (`fx-change-move`, `fx-change-correction`, `fx-change-date`; contamination-checked). Contract carries `revises` only when `true`. Commit records it in the evidence locator (`revision: true`) — provenance, no migration. Contradiction policy **rule 2** (explicit supersession) now also treats a newer claim the user marked as a revision as the successor of the older conflicting claim; unmarked polarity flips stay DISPUTED. | `extractionPrompt.js`, `fixtures/extraction-prompt.v1.json`, `extractionContract.js`, `worldModelRepository.js`, `contradictionWorker.js`, `contradictionPolicy.js` |
| D6 ontology | `has_status` gloss no longer invites dates ("never a date"); `deadline_for` names launches/ships/due. Root cause of "launch is on April 15" → `has_status` vs "moved to May 2" → `deadline_for` (never conflicting). | `predicateRegistry.js` |
| D6 wiring | Prompt rule 9 ("prefer these known names") was never fed on the E6 path. `Brain.understandTurn` now passes the owner's top 40 canonical entity labels (never "You"); they are part of the extraction cache key. | `brain/index.js`, `extractionClient.js` |
| **Shadow store** | Restart lifecycle fixed: the shadow's baseline is seeded at install from the JSON on disk (`seedShadowBaseline`), and an existing row equal to that baseline is continued, not refused; a row that differs is still a conflict. The first-write `.bak` copy of a store the shadow never held is skipped instead of logged as a failed write. | `pgBlobAdapter.js`, `dualWriteAdapter.js`, `storage/index.js` |
| **Metrics** | `GET /metrics` on the platform server: bearer token (`AQUA_METRICS_TOKEN`, ≥ 32 chars), constant-time compare, **404 when unset**, mounted before the session-gated `/api/aqua`; serves the same exposition (`sendPrometheus`, factored out of `health.js`). New registered setting (census 30 · 38 · 68). | `routes/metricsScrape.js`, `routes/health.js`, root `index.js`, `flags.js` |
| **D7** label leakage | Context lines no longer render retrieval mechanics (`via dense: 0.58`, `{slots: …}`) — kept on items for diagnostics. The instruction that defines the injection fence now forbids quoting/citing its markers, codes and annotations. | `contextEngine/assembler.js`, `core/untrustedContent.js` |
| Tooling | `scripts/d6-extraction-check.mjs` (real-extractor D6 check, retries transport errors, reports UNMEASURED); doctor check 27 (D5 seam). | `aqua/scripts/` |

Correction to Part 1, D8: the worker does **not** write the Postgres shadow
(`configureStorageFromEnv` runs only in the server). The 609 rejections were the
server's own restart lifecycle (now fixed) plus `.bak`-copy noise — not a
server/worker conflict.

## 2. D5 — how persistent context reaches the answer now

```text
                         AQUA_CANONICAL_READ=on                       =off (rollback, previous behaviour)
memoryRetrieve      identity / regex facts / Mind / Mind graph /      all lanes
                    episodes: SKIPPED · uploaded-file lanes: kept
Context Engine      canonical lanes only (structured, dense, graph    PIC floor + legacy graph + evidence
                    over aqua_claims; superseded → past questions     store + Mind + canonical lanes
                    only); PIC floor / legacy graph / ES / Mind: none
conversation        current conversation's messages (unchanged)       same
writes              legacy observe + canonical E6 (unchanged)          same
```

**Configuration you need to set** (I did not touch `.env`):
`AQUA_CANONICAL_READ=on`. The registry default stays `off` on purpose: users whose
memories exist only in the legacy stores (everything learned before E6 was
enabled) would lose them from answers until `npm run e10:migrate` backfills them
into the canonical World Model. Order: run E10 on the target database → review
the parity report → set `AQUA_CANONICAL_READ=on`.

Live (real launcher, real Groq, flag on via process env; same scenarios as Part 1, fresh users):
- "I moved to Porto" → three later questions in new conversations: **Porto 3/3** (Part 1: Lisbon 3/3).
- 5-user change sample, direct question afterwards: **5/5 current** (Part 1: 3/5; Berlin→Munich and Initech→Hooli were stale).
- Employer after "I no longer work at Acme, I work at Globex now": 2/2.

## 3. D6 — changed facts and corrections

**State transition (scripted extraction, real pipeline, live Postgres)** — all
five fact kinds: old claim `superseded` with `superseded_by`, an audited
lifecycle transition, evidence kept; the new claim current.

**Natural language, real production extractor** (Groq `openai/gpt-oss-120b`,
`scripts/d6-extraction-check.mjs`, graded on the value whatever the predicate,
0 unmeasured): **10/15 pass**, plus 3 declared-limitation cases that never count.

| Pass | Fail — and why |
|---|---|
| I moved from Lisbon to Porto · I live in Porto now · Actually, I moved to Porto · I don't live in Lisbon anymore; I'm in Porto · I moved to Porto · I don't live in Lisbon anymore (old retired, no new city) · I no longer work at Initech. I work at Hooli now · My employer is now Hooli · Actually, the launch is May 2 · The launch moved to May 2 | **My company changed from Initech to Hooli** — extracted as `Initech has_property Hooli`, not `works_at`. **The launch date changed from April 15 to May 2** — new subject "launch date" ≠ "Tidepool launch". **Not Go — Rust.** / **Not Go, it's Rust.** — no subject in the sentence; the extractor sees one sentence without the previous turn → nothing, or subject "You". **We switched the backend from Go to Rust** — subject "You" (the speaker), not the backend; passed on one run, failed on two (model variance). |

Declared limitation (reported, not counted): **"We switched the backend to Rust" / "The backend is Rust now"** — `uses` is many-valued and the old value is not named, so no rule can tell Go from Postgres; Go stays current next to Rust.

Live longitudinal (Maya, Part 1's sentences): still **two failures**. "Update on
Tidepool: the launch has moved from March 15 to May 2" — claims extracted, but
S6½ could not resolve "the launch" to the existing "launch date" entity → refused,
answer still "March 15". "Correction: … not Go. It's written in Rust" — Go
correctly superseded, but "It's written in Rust" (pronoun) yielded nothing, and the
surviving `uses → Postgres` claim is rendered with its source sentence "…written in
Go on Postgres", so the model still reads Go.

Forced re-explanation (Part 1 definition, same 14 answers): **3/14 (21%)**, was
7/14 (50%). Stable facts 0/6 (was 1/6); changed facts 3/8 (was 6/8).

**New regression seen live:** answers now hedge on confidence much more —
14/49 answers cite "confidence ≈ 66%", "can't guarantee", etc. (Part 1: 8/52),
about things the user said directly. The canonical lines carry
`(confidence 0.66)`; the legacy identity card that used to say "authoritative —
answer confidently" is gone under the flip. Not fixed — how much calibration to
show the answer model is a product decision.

## 4. Regression tests — commands and results

| Test | Proves | Before fix | After |
|---|---|---|---|
| `src/brain/tests/canonicalReadFlip.live.test.js` (live PG, drives real `prepareTurn`) | 5 fact kinds: WM supersession + provenance; with flag on the production context carries the new value and no old statement / legacy lane; control: flag off injects stale `City: Lisbon`; isolation | removing the chat seam: 4 fail; old policy: technology fails ("old technology is disputed") | 13/13 |
| `contradictionPolicy.test.js` (+4), `contradictionWorker.test.js` (+2) | newer revision supersedes older (incl. polarity flip on `uses`); older revision cannot; unmarked flip stays disputed; marker read from the evidence locator | revision tests fail (DISPUTED) | 11/11, 5/5 |
| `extractionPrompt.test.js` (+3), `extractionClient.test.js` (+3) | rule 11 + examples; marker survives only when `true`; known entities reach the prompt and the cache key | — (new behaviour) | 48/48 (with contamination guard), 24/24 |
| `storeConcurrency.test.js` (+6), `dualWrite.test.js` (+2, 1 updated) | restart continues from the row it loaded; differing row still refused; first read only; **real boot order** seeding from disk; `.bak` of an unheld store skipped | first restart test conflicts | 70/70 storage suites |
| `routes/tests/metricsScrape.test.js` | 200 with token, 401 otherwise, 404 when unset, short token refused, mounted before `requireLogin`, same exposition | — (new route) | 6/6 |
| `brain/tests/promptLabelLeak.test.js` | no lane/slot internals in the block (diagnostics kept on items); fence instruction present in every prompt | block contains `via` | 3/3 |
| `graphLaneCitations.live.test.js` (Part 1, D4) | canonical graph lane with the production citation formatter | reproduces `nestedPath` | 1/1 |

```bash
cd aqua
AQUA_TEST_DATABASE_URL=postgresql://aqua:aqua@localhost:55432/aqua_test AQUA_TEST_REDIS_URL=redis://:aquatest@127.0.0.1:56379/2 node scripts/run-tests.mjs
cd .. && npm run eval:gate && node aqua/scripts/production-loop-doctor.mjs && node aqua/scripts/env-doctor.mjs
AQUA_TEST_DATABASE_URL=… node aqua/scripts/d6-extraction-check.mjs --json aqua/eval/out/d6-extraction-check.json
```
Results (final tree, Windows, Node 24, live PG + Redis): **3,998 tests — 3,994 pass, 0 fail, 4 skipped** (the four declared skips); `eval:gate` **passed** (the context suites included — removing `via`/`slots` from the rendered lines changed no gated metric); production-loop doctor **27/27**; env-doctor clean.

Live checks: label leakage **0/49** answers (Part 1: 3/52); shadow restart on the
same data dir **481 → 3** rejections (the 3: two stores whose last write never
reached Postgres before an abrupt Windows kill — still refused by design, see §5);
`GET /metrics` 200 with token / 401 wrong / 404 unset, carrying
`aqua_requests_total` and `aqua_provider_requests_total{provider="groq"}`.

**E6 re-measurement of the v4 prompt** (rule 11 + glosses): **NOT YET MEASURED.**
Running detached (`--provider nvidia --model openai/gpt-oss-20b --repeat 3`, same
model as Part 1's v3 baseline: precision 97.5 / recall 84.2 / negation 90.0); at
pass 2/3 when this was written. Result →
`aqua/eval/out/e6-full-repeat3.nvidia-gpt-oss-20b.extract-v4.json`. Until it shows
no drop beyond the v3 run-to-run noise, the v4 prompt is **unvalidated on the E6
eval** — the live D6 check is evidence it extracts changes, not that it kept
precision and negation.

## 5. Remaining blockers (real ones)
1. **Credentials** (§6) — exposed in a public repository and still in use. Must be rotated by you.
2. **D6 is not complete** — 10/15 natural-language changes; subject resolution of definite descriptions ("the launch date", "the backend") and subject-less corrections ("Not Go — Rust") still fail, and so do two of Maya's original turns. The core loop is right when extraction names the same subject; it is not yet reliable when it does not.
3. **E10 backfill before the read flip** on any database with legacy-only users (§2).
4. **Shadow store after a crash** — a store whose last write was lost stays refused until reconciled (`refresh` exists; no automatic path). Needs an ops decision: reseed the mirror from JSON on boot in single-server topology, or keep the manual reconcile.
5. **Provider capacity** — E6 on the production model; Lift judge quota.
6. **Lift not rerun** — your condition (D5 and D6 complete) is not met, and the dataset still has 49 answerable questions.

Not blockers but open: confidence over-hedging (§3); "uses → Postgres" carrying
the stale sentence "Go on Postgres"; revision-voice phrasing (Part 1).

## 6. Security — credentials requiring rotation (no values shown)
Exposed in public git history (commits `8da8e11b`, `324a601f`, `0e00ae77`, `6f92e731`) **and byte-identical to the current `.env`**: `GOOGLE_CLIENT_SECRET`, `MONGO_URI` (MongoDB user/password), `SESSION_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_1..4`, `SERPER_API_KEY` (14).
Exposed but no longer in `.env`: additional Groq, Gemini and OpenRouter keys, `HF_API_KEY`, `TOGETHER_API_KEY` — revoke them too.
Provider-side actions: MongoDB Atlas (new DB user, delete old, review access log) · Razorpay (regenerate live key pair, review payments) · Google Cloud Console (reset OAuth client secret) · new `SESSION_SECRET` (invalidates sessions) · Groq, Google AI Studio, OpenRouter, Serper, Hugging Face, Together (revoke + reissue, check usage). Full ordered checklist: Part 1 §Security.
Working tree: no current production secret in any tracked or committable file (1,460 files scanned against 41 current values; the only match is the local dev-container `DATABASE_URL`, `localhost:5432`, defined in `docker-compose.dev.yml`). New values belong in your environment only; nothing here commits them.

## 7. Database
| | State | Done here |
|---|---|---|
| **Disposable test DB** (:55432) | 22/22 migrations incl. **0022**; schema == code == ledger | all validation; shadow rows cleared once for the restart proof |
| **Your dev DB** (`.env`, :5432) | 15/21 applied; 0016–0022 pending (7 incl. 0022) | **nothing — needs your approval.** All seven read: additive tables/indexes, two unique indexes replaced by strictly narrower ones (cannot fail on existing data), 0019 marks record-only outbox rows published. Command once approved: `npm run db:migrate` |
| **Production DB** | not reachable from this environment | nothing. Sequence: `db:status` → `db:migrate` (0016–0022) → `e10:migrate` dry run → review parity → apply → `AQUA_CANONICAL_READ=on` |

## 8. Next validation (in this order)
1. Rotate credentials; set them in the environment.
2. Approve and run `npm run db:migrate` on the dev DB; on production follow §7.
3. Decide D6 scope: subject resolution for definite descriptions against existing entities, and passing the previous user turn to extraction for elliptical corrections — then rerun `scripts/d6-extraction-check.mjs` (target 15/15 non-limitation) **and** the full E6 eval on the production model (Groq quota: run one pass per day).
4. Rerun the live longitudinal + change scenarios with `AQUA_CANONICAL_READ=on` (driver in this report's method; ~60 turns).
5. Only then the Lift: author ≥ 51 more answerable questions **before** any run, by someone other than whoever tunes the system; ≥ 5 personas × 3 repeats; same answer model for all conditions; the same blind judge (Gemini 2.5-flash is ~150 judgements/day here → spread over days with `--resume`, or pay for quota); add a **production-path condition** (canonical-only context exactly as chat builds it) next to the isolated world-model condition.

---

# Part 1 — first validation pass

First validation pass after the engineering freeze (PATCH_2026-10-12). The real
launcher (`scripts/start-production.mjs`: HTTP server + cognition worker) was
run with **real providers** (Groq `openai/gpt-oss-120b` for chat and E6
extraction, Gemini embeddings) against disposable infrastructure: test Postgres
16 + pgvector (:55432, migrated 0001–0022), a local MongoDB container for
users/sessions, a test Redis for rate limits, and a sandboxed data dir. Real
users were created through `/signup` and spoke to Aqua through `/api/aqua/chat`.
Nothing touched the `.env` dev database or the `.env` MongoDB cluster except
where stated in §G.

**Verdict: PRODUCTION BLOCKED** — see §J.

| | |
|---|---|
| **GREEN — verified on real infrastructure** | launcher starts server + worker; durable understanding → claims → outbox → embedding / reflection / contradiction / J3 jobs (queued→running→done); retry → DLQ → re-queue; stable-fact cross-conversation recall; single-valued supersession in the World Model; contradiction kept disputed; J3 archive-not-delete with provenance; replay idempotency (18 tables unchanged); owner isolation; purge (18 tables → 0); request/provider/queue/DLQ/J3/voice metrics; worker+server snapshots; Redis-backed limiter; battery + eval gate |
| **YELLOW — implemented, evidence incomplete** | revision-voice phrasing (n = 7, 2 voiced well / 4 silent / 1 blended); E6 quality on the production model; preference application ("short answers" stored, not applied); PG shadow store under two processes (D8); OTel / error-webhook export (not configured here) |
| **RED — defects / product failures** | **D5** stale changed facts in production answers (legacy memory wins); **D6** E6 misses change/correction statements; Lift: no lift vs memory, fabrication guardrail fails; **D7** fence labels leak into answers; Prometheus cannot authenticate to scrape (D9). Fixed this pass: D1, D2, D3, D4 |
| **BLOCKED — external** | credential rotation (public repo); E6 on Groq 120b (quota); Lift judge quota + dataset size; production DB access and migration approval; vendor OTel / tracker |

---

## A. Engineering status

| Check | Result |
|---|---|
| `production-loop-doctor` | **26/26** (25 before + 1 added: launcher gives the worker the `.env`) |
| `env-doctor` | **clean** after removing `AQUA_CROSS_ENCODER=off` (read is `=== 'on'`, default off — redundant) |
| `dependency-doctor` | 19/19 installed |
| Full battery (Windows, Node 24, live PG + Redis) | **3,956 tests: 3,951 pass, 1 fail, 4 skipped.** The fail is `editRoutes.test.js` at file level: "8 passed, 0 failed", then the known libuv `UV_HANDLE_CLOSING` abort at teardown; passes in isolation. An earlier run had a cross-file race on `eval/fixtures/retrieval-core.embeddings.v1.json` (one test rewrites it while another reads; Windows refuses the write) — 28/28 in isolation, did not recur. |
| Live-PG + Redis suites | **79/79** existing, 0 skipped; plus the 2 new live files (3 tests) pass |
| `eval:gate` | **passed** |
| `db:status` — test DB | 22/22 applied (0022 added this pass) |
| `db:status` — `.env` dev DB (:5432) | **15/21 applied, 0016–0021 pending — not applied** (it holds the user's own data; see §5 below) |
| `db:drift` — dev DB | 18/18 legacy JSON stores never reached Postgres (E10 not run there) |
| Worker | alive; handlers for understanding, embedding, reflection, contradiction, J3; `queued → running → done` observed for every kind |
| API | alive; 86 authenticated real chat turns served over HTTP |

### Database (§5)
- Test DB: schema == code == ledger (22/22, no checksum drift).
- Dev DB (`.env`): 6 migrations behind. All six were read: 0016/0018/0020/0021 only add; 0017 swaps a unique index for a strictly narrower one (cannot fail on data that satisfied the old one); 0019 only marks record-only outbox rows published. **Safe to apply**, not applied because it is the user's persistent DB. 0022 (this pass) is likewise a narrower index.
- Production DB: **not reachable from here** — no production `DATABASE_URL` exists in this environment. Parity on production is BLOCKED (§I).

---

## B. Cognitive-loop evidence (real launcher, real providers)

| Link | Result | Evidence |
|---|---|---|
| **New fact** | ✅ | "I live in Lisbon" → durable `understanding.turn.v1` (queued→done) → `located_in` claim + entity + evidence → outbox → embedding (pgvector) + reflection jobs done |
| **Retrieval / cross-conversation** | ✅ for stable facts | New conversation, no re-explanation: city, fitness goal, cofounder's role, investor name answered correctly (Maya scenario, §E) |
| **Changed fact — World Model** | ✅ for registry single-valued predicates | Lisbon→Porto, Acme→Globex, Berlin→Munich, Initech→Hooli, junior→senior analyst: old claim `superseded`, lifecycle + revision rows, recency policy |
| **Changed fact — the answer** | ❌ | The canonical Context Engine returns "I moved to Porto"; production chat ALSO injects the legacy regex memory (`city=Lisbon`) and the model answers **Lisbon**. Every stale city/employer answer (7/7) equals the legacy store's value; where its regex happened to catch the change ("I work at Globex now") the answer was right. See D5 |
| **Changed fact — extraction** | ❌ | "the launch has moved from March 15 to May 2" → E6 `parsed=0`: no claim, nothing superseded |
| **Correction** | ❌ / partial | "Correction: backend is not Go, it's Rust" → only `is_a | backend is not go`; `uses→Go` never superseded; Aqua then reports the stack as "conflicting". "Correction: I don't work at Acme anymore, I work at Globex" → ✅ superseded |
| **Contradiction** | ✅ policy-consistent | "$35,000 budget" vs "$20,000": both `disputed`, no silent winner; Aqua asked once to confirm, later presented both as contested |
| **Consolidation (J3)** | ✅ | Paraphrased restatements are absorbed at write time (evidence=3 on one claim). A planted structural duplicate was found by the running worker's scheduler in 57 s, job queued→done, duplicate **archived not deleted**, survivor kept its evidence, `merge` revision + lifecycle (`e9:j3-consolidation`) written; `aqua_worker_j3_merged_total 1` on /metrics |
| **Isolation** | ✅ | A second user asking about the first user's app/cofounder/city: "I don't have that information"; 0 matching claims under that owner |
| **Purge** | ✅ | `POST /api/account/delete` → 18 owner-scoped tables and the job queue at 0 rows; session gone (401) |
| **Replay / idempotency** | ✅ | Both understanding jobs of an owner re-queued and re-run (queued→done): identical row counts in all 18 tables before/after |
| **Retry / DLQ** | ✅ | Observed live: embedding jobs 5 attempts → dead (D1), understanding job 5 attempts → dead (D2); re-queue after the fix → done |

---

## C. E6 evaluation

**On the production extractor (Groq `openai/gpt-oss-120b`): BLOCKED — PROVIDER CAPACITY.**
NVIDIA does not serve 120b (checked against its public model list), and Groq's free
daily quota (~800k tokens across the keys) is below one 3-pass run (~1.56M) and was
needed for today's live product validation. Not attempted.

**On a substitute (NVIDIA `openai/gpt-oss-20b`, max_tokens 4096): completed, gate FAILED.**
`node scripts/e6-shadow.mjs --provider nvidia --model openai/gpt-oss-20b --repeat 3 --json eval/out/e6-full-repeat3.nvidia-gpt-oss-20b.json`

| | |
|---|---|
| Cases × repeats | 200 × 3, all 3 passes valid; 525 calls, 0 cache hits |
| Provider failures | 5 transport errors; 2 cases never answered (modality-014, temporal-018), excluded |
| Wall-clock | 89.5 min (≈ 10 s/call, serial) — the harness records no per-call latency |
| **Precision** (silence on negatives) | **97.5%** — gate ≥ 85% **PASS** |
| **Recall** (detection) | **84.2%** — gate ≥ 70% **PASS** |
| **Negation** | **90.0%** — gate ≥ 95% **FAIL** |
| Verdict | **DO NOT PROMOTE** |
| Other | subject recall 73.9%, predicate accuracy 53.3%, fidelity 68.5%, overall strict accuracy 54.0%, temporal 83.3%, modality 66.7% (**below the 72.0% baseline**) |
| Extraction failures | 25 cases emitted nothing (13 = model returned `[]`: modality ×8, task ×5; the rest dropped by gates); gate discards: quote-not-verbatim 11, object-not-in-quote 6 |
| Noise (3 passes) | ≤ 1 case on every count; detection_people 80–95% |

This measures a smaller model than production, so it neither validates nor
invalidates production extraction; it does show the negation gate is not met on a
model with capacity. It agrees with the live finding D6: change and correction
statements are where extraction is weakest.

---

## D. World-Model Lift

**BLOCKED — PROVIDER CAPACITY (judge), after a partial run. Not a pass.**

Run `muv65ndqdb64` (`aqua/scripts/world-model-lift-live.mjs --repeat 3`, dataset
`world-model-lift-live.v1`, unmodified). E6 ingestion through the production
handlers on the production extractor (Groq `openai/gpt-oss-120b`); every condition
answered by the same model (NVIDIA `openai/gpt-oss-20b`, temp 0 — a substitute for the
production answerer, which has no quota for ~720 calls); blinded judge Gemini
`gemini-2.5-flash`. The judge quota ran out on all 8 keys after 148 judgements
(verified: HTTP 429 on every key); the run was stopped and is resumable with
`--resume eval/out/world-model-lift-live.muv65ndqdb64.partial.json`.

| | stateless | memory | full history | **world model** |
|---|---|---|---|---|
| answerable correctness | 0.000 | 0.387 | 0.968 | **0.387** |
| fabrication rate | 0.000 | 0.189 | 0.000 | **0.351** |
| stale rate (changed facts) | 0.000 | 0.231 | 0.000 | 0.231 |
| asked-for-known-info | 0.730 | 0.378 | 0.000 | **0.108** |
| required-fact recall | 0.000 | 0.516 | 0.984 | 0.677 |
| personalization | 0.000 | 0.516 | 1.000 | 0.677 |
| unknown honesty | 1.000 | 1.000 | 1.000 | 1.000 |

- Sample: **37 graded rows = 13 questions × ≤3 repeats, 2 personas (p1 complete, p2 q01–q03); 31 answerable.** Pre-registration requires ≥ 100 answerable questions over ≥ 5 personas × 3 repeats — and the dataset itself has only **49 answerable** questions, so even a complete run cannot meet it.
- **Primary (paired answerable correctness, WM vs memory):** 9 wins / 9 losses / 13 ties; one-sided sign test p = **0.59** (two-sided 1.0). **No measurable lift.** Repeats of one question are not independent, so even this p is optimistic.
- **Guardrail: FAILS** — world-model fabrication 0.351 > memory 0.189. The fabrications inspected are stale facts the World Model never retired ("based in Pune" after the move to Bangalore, the superseded Dec 10 date, the payments owner who left) — the same E6 change-extraction gap as D6.
- **Secondary:** the World Model asks for known information far less (0.11 vs 0.38) and recalls more required facts (0.68 vs 0.52), but asserts stale ones; WM beats stateless 12–0 (p = 0.0005). Full history (whole 14-turn chat in context) beats every other condition — at this history length, retrieval of any kind loses to simply including the conversation.
- **Caveat — this is not the production chat path.** The harness gives the world-model condition an empty legacy floor and no `formatCitation`, so it measured the canonical model in isolation; production chat additionally injects the legacy memory (D5) and, before this pass, lost the graph lane (D4).
- Previous run for comparison (2026-10-04, 20 q × 1): 4/4/12, p = 1.0, fabrication 0.20 vs 0.05. Same direction.

---

## E. Longitudinal product evaluation (8 conversations + change/voice samples)

Rated by Claude from the transcripts with the rubric below — **not a human
rating**; it should be re-rated blind by a person before it is used as evidence.
0 = fails, 1 = partial, 2 = good, — = not exercised.

| Scenario (user, after all fixes) | Correct | Relevant | Personal | Temporal | Relationship | Correction | No needless clarif. | No re-explain needed | Uncertainty | Useful |
|---|---|---|---|---|---|---|---|---|---|---|
| Identity recall, new conv ("which city, fitness goal?") | 2 | 2 | 2 | — | — | — | 2 | 2 | 2 | 2 |
| Relationship ("who handles design?") | 2 | 2 | 2 | — | 2 | — | 2 | 2 | 2 | 2 |
| Investor and what she wants | 1 | 2 | 1 | — | 1 | — | 2 | 1 | 2 | 1 |
| Launch date after it moved | 0 | 2 | 1 | 0 | — | — | 2 | 0 | 1 | 0 |
| Backend after explicit correction | 0 | 2 | 1 | — | — | 0 | 2 | 0 | 1 | 0 |
| Planning (hire a contractor?) | 0 | 2 | 1 | 0 | — | 0 | 1 | 1 | 1 | 1 |
| Conflicting budget | 2 | 2 | 2 | — | — | — | 1 | 2 | 2 | 1 |
| City after a move (×5 asks) | 0 | 2 | 1 | 0 | — | — | 2 | 0 | 1 | 0 |
| Employer / title / manager / car after change | 2 | 2 | 2 | 2 | — | 2 | 2 | 2 | 2 | 2 |
| Another user's data | 2 | 2 | — | — | — | — | 2 | — | 2 | 2 |

Concrete examples:
- **Good:** new conversation, "Which city do I live in, and what's my fitness goal?" → "Lisbon — and your fitness goal is to run a half-marathon in October."
- **Good:** "Who is my manager?" after a change → "Tom Berg. (Note: an earlier source mentioned Sara Lind…)"
- **Bad:** after "launch moved to May 2" (acknowledged in that conversation), a new conversation: "When is my app launching?" → "March 15 … you may want to double-check that it's still current." The plan in conversation 7 is built on March 15 and a Go stack that had been corrected to Rust.
- **Bad:** after "I moved to Porto", "Remind me: what city do I live in?" → "Lisbon." The World Model held Porto as current.
- **Preference not applied:** "I prefer short, direct answers" was stored (`prefers`) but answers stayed long tables.

## F. Re-explanation

- **Existing instrument** (`GET /api/aqua/brain/reexplanation`): exact S8 restatements / all conversation evidence, per owner per week, lower bound. Verified live: the user who restated their employer three times scores 2/6; scripted users who never restate score 0. It measures what the user *volunteers again*; it cannot see what Aqua *lost* and would force the user to repeat. No new instrumentation was added — counting forced re-explanation needs a judgement per turn, not a counter.
- **Measured baseline (forced re-explanation, transcripts after all fixes):** of **14** fact-dependent answers in new conversations, **7 (50%)** were missing or wrong in a way the user would have to correct or restate. Split: stable facts **1/6** need re-explanation (the investor's request); changed or corrected facts **6/8** (stale rate 75%). A separate 5-user change sample (§14 below) adds 2/5 stale, both on fields the legacy store tracks.
- Definition used: forced re-explanation = answers that omit, contradict or mark as unknown a fact the user stated in an earlier conversation ÷ answers that depended on such a fact.

### Revision voice (provider-backed sample, §14)
7 users with single-valued changes (2 change-scenario users with city + employer changes, and 5 users in a dedicated sample: city, employer, title, manager, car), each followed by unrelated turns and a direct question; real Groq answers.
- **Selection** ✅: 7 canonical supersessions → **7 raises, each exactly once**, never repeated; `skipped{no-candidates|unsuitable-turn}` counted on /metrics. Concurrency is covered by `revisionVoice.live.test.js` (5 concurrent callers → raised once).
- **Phrasing** — mixed: **2/7** surfaced as one brief question ("I also recall you mentioned moving to Porto — is that still the case?"); **4/7** were never voiced (the turn carrying the directive was unrelated — book suggestions, focus tips — and the model ignored it); **1/7 blended old and new as if both were true** ("a senior analyst who still wears a junior‑analyst hat"). None asserted an uncertain fact as confirmed.
- Manager and car changes were not treated as single-valued, so no transition — answers were still correct (the Context Engine carried the newer statement).
- Policy unchanged; n = 7 raises is too small to estimate a per-user frequency.

## G. Production infrastructure

| Component | Implemented | Configured here | Verified live |
|---|---|---|---|
| Request/provider metrics | yes | yes | **after fix D3** (`aqua_requests_total 7`, `aqua_provider_*{provider="groq"}`) |
| Cost metrics | yes | yes | tokens by purpose ✅; USD withheld (all calls unpriced — by design) |
| Queue depth / retries / DLQ | yes | yes | ✅ (`aqua_jobs`, `aqua_jobs_window`, `aqua_dlq_level`) |
| Worker + server snapshots | yes | yes | ✅ `aqua_workers_alive 1`, `aqua_servers_alive 1` |
| J3 / revision voice / E6 counters | yes | yes | ✅ |
| **Prometheus scraping** | yes | **no** | ❌ documented path `/api/aqua/health/metrics` was 404 (real: `/api/aqua/provider-health/metrics`, docs corrected) and it is behind `requireLogin` — a scraper cannot authenticate (decision pending) |
| OTel export | yes (env) | no (`spans=local`) | not verified — no collector |
| Error webhook | yes (env) | no (`errors=local`) | not verified — no tracker |
| Shared Redis rate limit | yes | test Redis | ✅ engine limiter key in Redis; auth limiter enforced (429) |
| MongoDB | — | local container | sessions/users ✅. Note: `npm run db:drift` with the `.env` connects to the **real** Mongo cluster and performs a round-trip probe write there. |

## H. Defects found

| # | Severity | Defect | Root cause | Evidence | Fix | Regression test |
|---|---|---|---|---|---|---|
| D1 | **High** | `.env`-configured deployments' worker has no provider keys: every `claim.embedding.v1` dead-letters, server looks healthy | `index.js` loads `.env`; launcher and worker don't, worker runs from `aqua/` | 774/774 embedding jobs DEAD; after fix 774/774 done | launcher loads platform `.env` (no override) before spawning | production-loop-doctor check 26 |
| D2 | **High — data loss** | Any sentence with two facts sharing subject+predicate ("backend is Go on Postgres") loses the **whole turn** | 0017's current-claim key (owner, subject, predicate, statement_norm) has no object, and every claim of a segment shares the sentence | job 2690 DEAD ×5: `duplicate key … aqua_claims_dedup_current_idx` (Postgres log: `uses` ×2); launch date + budget lost with it | migration **0022**: key = S8's identity (+ object, polarity, modality); an identical current claim is still refused | `claimDedupObject.live.test.js` (fails before, passes after); job 2690 re-run → done |
| D3 | Medium | `aqua_request_*` / `aqua_provider_*` never recorded; 2 alert rules could never fire | `logCompletion()` had no caller in any commit | `aqua_requests_total 0` after 30 live chats | called on success + failure of `/chat` and `/chat/stream` | `alertRules.test.js` guard; live scrape |
| D4 | **High** | Canonical graph lane threw on **40 of 53** live turns | it ran canonical evidence through the FILE citation formatter (`.location.nestedPath`) | `[BRAIN] canonical graph lane failed … 'nestedPath'` | pass canonical evidence rows raw, as the dense lane does | `graphLaneCitations.live.test.js` (calls it as chat.js does; reproduces before, passes after); 0 failures live |
| D5 | **Critical (product)** | Changed facts answered stale although the World Model is right | production chat injects the legacy regex memory (`city=Lisbon`) next to the Context Engine; it is not revised and the model follows it | 7/7 stale city/employer answers equal the legacy store's (unrevised) value; the Context Engine alone returns "I moved to Porto" for the same owner and question | **not fixed** — which source wins is the E10 read-flip (product decision) | — |
| D6 | High (quality) | E6 recall misses change/correction statements and some multi-fact sentences | extraction quality | "launch moved to May 2" parsed=0; "my dog is Biscuit and my employer is Northwind" → refused as descriptions; "not Go, Rust" → no `uses→Rust` | not a code defect; measured by E6 eval (§C) | — |
| D7 | Medium | Internal fence labels/nonces leak into answers (`【UNTRUSTED‑CONTENT OPOUBtohz0gd …】`) | answer model cites the injection fence | several transcripts | not fixed — prompt rule vs output scrub is a product choice | — |
| D8 | Medium | PG shadow store cannot stay in sync with server + worker | both processes write the same legacy stores from separate in-memory copies; the version guard correctly refuses | 609 rejected shadow writes (240 on `.aqua-mind.json`) | not fixed — blocks the E10 read flip; Mind lost-update is a risk, not proven | — |
| D9 | Low (ops) | Prometheus scrape path wrong in docs; endpoint needs a session | — | 404 / 401 | docs corrected; auth decision pending | — |
| D10 | Low | Launcher orphans children when killed on Windows | Windows signal semantics | observed twice | none (production is Linux) | — |

## Security / credentials (§4)
A history scan over all 135 commits (values never printed; SHA-256 fingerprints compared)
found real credentials in `.env`, `aqua/.env` and `.aqua-index.json` blobs in commits
`8da8e11b`, `324a601f`, `0e00ae77`, `6f92e731` — **all on `origin/main`, and the GitHub
repository is public**. None of those files is tracked today. Test-file hits are fixtures.

**14 values in the current `.env` are byte-identical to exposed ones** and must be treated
as compromised: `GOOGLE_CLIENT_SECRET`, `MONGO_URI`, `SESSION_SECRET`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`OPENROUTER_API_KEY_1..4`, `SERPER_API_KEY`. Also exposed (not in use now): additional
Groq/Gemini/OpenRouter keys, HF, Together.

Rotation checklist (in this order):
1. **MongoDB**: create a new DB user/password in Atlas, update `MONGO_URI` everywhere, delete the old user; review Atlas access logs and the IP allow-list.
2. **Razorpay**: regenerate key id/secret in the dashboard (live mode), update env, review recent payments/refunds.
3. **Google OAuth**: reset the client secret in Google Cloud Console → Credentials; update `GOOGLE_CLIENT_SECRET`.
4. **SESSION_SECRET**: generate a new random value (≥ 32 bytes); all sessions are invalidated.
5. **Groq, Gemini (`GEMINI_API_KEY`), OpenRouter (all 5), Serper**: revoke in each console, issue new keys, update env; check usage pages for unknown spend.
6. Revoke the exposed but unused keys too (old Groq/Gemini/OpenRouter, HF, Together).
7. Only then decide on history rewriting (`git filter-repo` + force-push + GitHub support cache purge). Rotation makes it unnecessary for safety; it is not done here.

## I. Remaining blockers
1. **Credential rotation** (above) — external, required before any deployment.
2. **D5 (legacy memory overrides the World Model)** — needs the E10 read-flip decision; until then the product does not deliver changed facts to the user.
3. **D6 E6 recall on change/correction statements** — the loop cannot revise what it never extracts.
4. **Provider capacity** — E6 full on the production model (Groq 120b) and the pre-registered Lift (judge quota); see §C, §D.
5. **Production DB / deployment** — no access here; migrations 0016–0022 on production need the repository's procedure.
6. **Lift dataset** has 49 answerable questions; the pre-registration requires ≥ 100.

## J. Final verdict
**PRODUCTION BLOCKED**

Two things prevent a safe deployment today, independently of what remains unmeasured:
credentials in active use are exposed in a public repository (§Security), and in the
production chat path a changed fact reaches the user stale even when the World Model has
it right (D5). Beyond those, the evidence is incomplete: E6 on the production model and
the pre-registered Lift are blocked by provider capacity, and the Lift dataset is too
small for its own pre-registration.

## Is Aqua becoming more useful because it models the user's world?

**Not yet, on today's evidence.**

- **What works:** the durable loop is real. Turns become claims in Postgres through the
  worker; embeddings, reflection, contradiction, J3, replay-idempotency, isolation and
  purge all work on real infrastructure with a real extractor. Stable facts carry across
  conversations without re-explanation (5/6), and versus no memory at all the World Model
  wins 12–0.
- **What doesn't:** the thesis is about an *evolving* model, and evolution is where it
  fails. Changed and corrected facts were stale in 6 of 8 longitudinal answers. Two causes,
  both measured: extraction misses many change/correction statements (D6), and when the
  World Model does update, production chat still lets the unrevised legacy memory win (D5).
- **Against the honest baseline:** the World Model ties BM25 memory on correctness (9–9),
  fabricates more (0.35 vs 0.19) because of unretired stale facts, and loses badly to
  simply keeping the whole short history in context (0.39 vs 0.97). It does ask for
  already-known information much less often (0.11 vs 0.38) — the one secondary signal in
  its favour.
- **Four of the defects fixed this pass** (D1–D4) could each silently stop learning or
  lose turns in production, and none was visible to the existing test suites, because
  those suites stand in for the models and call the Context Engine differently from chat.
  Validation on the real loop is where the truth is.

The next evidence that would change this answer: decide D5 (one source of truth at
answer time), measure E6 recall specifically on change/correction statements, rotate the
credentials, then rerun the Lift on the production path with ≥ 100 answerable questions.
