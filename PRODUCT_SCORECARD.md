# Product scorecard — primary workflow

**Product promise under test:** *Aqua knows where your project stands: what's
current, what changed, and where it learned it.* (See `YC_PRODUCT_THESIS.md`.)

Labels:

- **MEASURED**: a number from a named file or command.
- **UNMEASURED**: no data yet. This is not the same as a failure.
- **TARGET**: a goal set in advance, not a result.

---

## 1. Primary quality metric: stale-answer rate

The product's whole claim is current state. The primary metric is therefore
the share of answers that use a value the user has since changed or corrected.
Lower is better. Second are correctness on change and correction questions, and
fabrication.

## 2. Baseline (MEASURED, held-out Lift v3)

Source files are `aqua/eval/out/lift-heldout-v3.before.json` and
`.after.json`. They were recomputed today from the stored per-question results.

Setup:

- 7 personas, multi-session, one uploaded document each.
- 109 questions × 2 repeats; 214 graded after judge errors.
- Answerer and extractor: NVIDIA `openai/gpt-oss-20b`.
- Blind judge: `nvidia/nemotron-3-ultra-550b-a55b`, with κ 0.96 against Gemini judgements (HISTORICAL).
- Histories are **short**: about 2,300 characters of full history per persona.

"After" means after the 2026-10-11 fixes.

| Condition | Correct | **Stale rate** | Fabrication | Corrections (n=9) | State changes (n=27) | File questions (n=15) |
|---|---|---|---|---|---|---|
| No memory (stateless) | 14.0% | 0.0% | 4.7% | 0% | 0% | 3.3% |
| Simple memory (BM25, k=8) | 78.5% | **9.1%** | 10.8% | 82.3% | 77.8% | 83.3% |
| Full history in prompt | **95.3%** | **1.0%** | 3.3% | 94.1% | 98.2% | 100% |
| **Aqua World Model** | 73.4% | **15.2%** | 18.2% | 70.6% | 74.1% | 73.3% |
| World Model *before* the fixes | 63.9% | 18.0% | 16.7% | 77.8% | 79.6% | 3.3% |

How to read this:

- On short histories, Aqua's World Model is **the worst option** at the job the product promises.
- Its paired difference against simple memory is −4.2 points, CI [−13.9, +6.0], not significant (HISTORICAL, `COMPLETION_PASS_2026-10-11.md`).
- Full history wins clearly: −21.8 for the World Model, CI [−30.1, −13.9].
- v3 was written by the same engineer who tuned the system, so author independence is not met. v3 is now also contaminated for any fix made after reading its failures.

## 3. The decisive pending measurement: long histories (v4)

v4 has 8 personas: 4 short and 4 long. The long ones run about 25k tokens each,
more than the production context window. It has 136 questions and a frozen
hash. The pre-registration is
`aqua/eval/lift/PREREG-v4-2026-10-12.md` plus addendum 1. It fixes the primary
endpoint and a decision rule (KEEP / STOP / SIMPLIFY / INCONCLUSIVE) before any
v4 answer exists.

| | Status |
|---|---|
| v4 runs | **UNMEASURED: four attempts, none completed.** Attempts 1–2 (2026-10-11/12) died when the laptop slept. Attempt 3 (2026-10-15 23:00, run `mv9tghjfwtqe`, launched exactly as pre-registered from tree `aadda450` on a fresh `aqua_v4_prereg`) died about 40 minutes into ingest when the session ended and the machine rebooted. At the 2026-10-17 resume the laptop was on battery, so no relaunch: the protocol voids any run that crashes. No v4 answer or grade has been looked at. |
| How to run it | One command on a host that stays up for 6–10 hours on AC: `scratchpad/v4run/launch-v4.ps1` (it refuses to start on battery, holds the machine awake, and logs to `aqua/eval/out/lift-v4.prereg.log`), or the validated VM kit (2026-10-15). |

**Memory verdict: none yet.** The decision rule cannot be applied until v4 completes.

**What would justify the World Model as a moat:** on the *long* personas, the
World Model (or the hybrid) beats both simple memory and the
production-window history on correctness and stale rate, under the
pre-registered statistic. If it doesn't, the pre-registered decision is SIMPLIFY
or STOP, and the product should ship the simpler path.

## 3a. The production read path, measured (2026-10-16, new gate)

Until now, no gate measured the read that production serves when Postgres is
configured: canonical claims only. With a database exported, the old context
suites scored 0 because they seed legacy stores. The new `context-canonical`
suite works like this:

- The same 60 facts go through the **production understanding path**, replaying `groq/openai/gpt-oss-120b` output recorded once.
- The same 200 labelled queries are asked exactly as `routes/chat.js` asks them.
- Runs are deterministic: two processes produce identical rankings. The tie-breaks added for this live in production code.

| Metric (200 queries) | Legacy read (`context-core`) | **Canonical read (`context-canonical`)** |
|---|---|---|
| recall@8 | 0.756 | **0.696** |
| MRR | 0.688 | 0.582 |
| top-1 correct | 0.643 | 0.536 |
| noise lines (irrelevant context) | 18 | **153** |
| unknown honesty (returns nothing when nothing applies) | 0.719 | **0.344** |
| facts that reached canonical claims | — | 93% (56/60) |

Reading: the canonical read retrieves somewhat less, but its large gaps are
noise and silence. It hands the model irrelevant context for about two-thirds of
the questions that should get none. That is consistent with the World Model's
higher fabrication in Lift v3. Example: "Where do I work?" did not retrieve "I
run product at Nummo" but filled eight slots with weaker matches. **This is the
most actionable quality gap in the product**, and it is now gated, so a fix will
show up as a number.

Related finding: legacy facts moved by the E10 migration land as
`extracted / unresolved` claims that **no canonical read returns**. Migrated
users get nothing from the canonical path until those claims are re-extracted.

### 3a′. Update 2026-10-18: canonical relevance gate, state fixes, held-out set

Full record: `WORLD_MODEL_INITIATIVE_2026-10-17.md`. On a new held-out set
(`retrieval-heldout.v1`, 82 questions, frozen before the change, V3 ranker), MEASURED:

- unknown honesty 0.19 → **0.65**;
- noise lines 120 → **24**;
- MRR 0.71 → **0.76**;
- recall@8 0.82 → **0.84**;
- stale leaks 11 → **6** of 16.

On the development set above: noise 153 → 22, honesty 0.34 → 0.75, recall@8 0.696 → 0.702.
Two caveats:

- Retrieval only. Answer-level stale rate and fabrication are UNMEASURED for this change.
- The canonical gate previously never ran the worker, so no change had ever been applied in
  the world it measured.

## 3b. The founder workflow, end to end on the real app (2026-10-16/17)

Driver: `aqua/scripts/e2e-founder-journey.mjs`. It runs the real launcher
(server and worker), disposable Postgres and Mongo, and real providers (chat
through the router; extraction on Groq `gpt-oss-120b`). It walks signup →
onboarding interview → "what I understood" card → document upload → Memory with
sources → a change in a new conversation → investor update in another new
conversation → correct one fact → delete one fact → a second account.

| Run | Checks passed | What failed, and what was done |
|---|---|---|
| 1 | 17/23 | (a) the change never reached memory: extraction rate-limited, job dead-lettered after about 30 s; (b) "our price" answered from Aquiplex's profile; (c) a deleted fact came back through a sibling claim. **All three fixed.** |
| 2 | 12/22 | Not comparable: the driver stopped waiting for retries (now about 1 to 8 minutes under the new capacity backoff). Driver fixed to wait for all pending extraction. |
| 3 | 19/23 | Deleted co-founder still answered: claims phrased differently share only the source segment, and a garbage legacy slot ("cofounder: And"). **Fixed** (segment siblings, role-slot deletion and veto). |
| **4** | **21/23** | Remaining: the compound sentence "we moved the launch to May 2, **and** the price is now $39" kept only **one of its two changes** (run 3 dropped the price, run 4 the date). An extraction-quality weakness, measured, not tuned. |

Run 4, measured:

- chat latency p50 **4.5 s**, p90 6.8 s;
- what was said reached memory in **17–94 s**;
- **0** dead extraction jobs.

Every isolation and deletion check passed: another account cannot read, see or
delete the founder's facts, and deleted facts do not come back, including
through re-derived legacy copies.

Pass/fail criteria for the workflow (proposed, to hold the pilot to):

- every isolation, deletion and correction check passes on every run;
- a stated change is used in a new conversation in ≥ 95% of single-change sentences;
- no dead extraction jobs under the pilot's load;
- chat p90 under 10 s.

Status: isolation, deletion, correction and latency **pass**. Change-capture is
**not yet measured at volume**, and compound changes fail about half the time.

## 3c. Cost and capacity (measured where stated)

| Item | Value | Basis |
|---|---|---|
| Tokens per chat turn | **~2,690 in + ~1,010 out, 3.2 provider calls** (verification is 41% of tokens) | MEASURED: server counters over 20 real turns (`aqua_cost_*`) |
| Extraction per turn | ~3–4k tokens per call (Groq reports "Requested ~3,955") | MEASURED (provider 429 messages); output not separately counted |
| Free-tier throughput | Groq free tier: 8,000 tokens/min per organisation × 5 keys ≈ **10 extractions per minute for the whole product** | MEASURED limits (429 bodies); one founder's onboarding burst hits it |
| Model cost per turn on paid gpt-oss-120b | ≈ **$0.0025** (chat + verification + extraction) | ESTIMATE from the token counts at assumed list prices of $0.15 per 1M input and $0.75 per 1M output tokens. **Verify current prices before relying on this.** |
| A heavily active founder (30 turns/day, 22 days) | ≈ **$1.60/month** in model cost | ESTIMATE, same assumptions |

So for a pilot the constraint is **throughput, not cost**. One paid tier for the
extraction provider removes the bottleneck at a cost that is small next to any
plausible price.

## 4. Product funnel (instrumented; no production data yet)

Events (`services/analytics/productEvents.js`) are content-free: user id, event
name and time only. The report command is
`node scripts/activation-report.mjs --mongo <uri>` and is read-only.

| Metric | Definition | Baseline | TARGET for the pilot (hypothesis) |
|---|---|---|---|
| Signup → first chat | first `chat_turn` after `signup_completed` | UNMEASURED (no data before today) | ≥ 70% |
| Time to first chat | median minutes from signup to first chat turn | UNMEASURED | ≤ 3 min |
| Gave context | an upload or project created within 7 days | UNMEASURED | ≥ 40% |
| **Activation (7-day)** | chat turns on **≥ 2 distinct days** within 7 days of signup. The promise can only be felt in a second session. | UNMEASURED | ≥ 35% |
| Week-1 retention | ≥ 1 chat turn in days 7–13 | UNMEASURED | ≥ 25% |
| Week-4 retention | ≥ 1 chat turn in days 28–34 | UNMEASURED | ≥ 15% |
| Correction rate | memory corrections per 100 chat turns. High means Aqua is getting facts wrong, *or* that users trust the controls. Read it next to interviews. | UNMEASURED | track |

The report logic is verified end to end: synthetic events seeded into a
disposable Mongo produced exactly the expected cohort numbers (80% first chat,
40% activated, 20% week-1).

Not instrumented, on purpose: prompt or answer content, file names, and
per-message quality ratings. If usefulness ratings are added later, store the
rating only.

## 5. Reliability, isolation, tests (updated 2026-10-17)

| Metric | Status |
|---|---|
| Automated tests (this branch) | MEASURED 2026-10-17. Aqua battery with live Postgres and Redis: **4,392 tests, 4,388 pass, 0 fail, 4 skipped** (run per directory; a single spawn of all files hits EPERM on this machine). Platform 245/246 (the 1 failure is three gitignored local `*.patch` files). Frontend tsc clean, 117/117. Eval gate PASS with the test database (including `context-canonical`) and without one (canonical suite reported NOT RUN). |
| Release candidate | Linux `node:20`: 3,634 tests, 3,617 pass, **0 new failures** against production `54c8de96` (all 14 failures pre-exist there). Details: `RELEASE_MANIFEST_RC_2026-10-17.md`. |
| Cross-user isolation | MEASURED end to end on the real app (founder journey): a second account cannot list, read or delete the founder's claims, and its answers contain none of the founder's facts. Unit and integration guards: conversation 404s, workspace owners, owner adoption, bundle ownership, intro marker. **No adversarial test against the deployed site.** |
| Deletion and correction | MEASURED end to end: deleted facts do not come back in new conversations, including through sibling claims, legacy slots or re-derived legacy copies; corrected values answer. Live tests pin each case. |
| Browser e2e (Chromium, 7 viewports, real app, signed in) | Shell suite: **all pass except one chat answer that hit the 120 s limit during provider backoff** (capacity). The suite found and fixed 3 defects: read requests exhausting the message rate limit; a duplicate search box on phones; focus not returning after the artifacts panel or drawer closed. The markdown-tables spec (development builds only) ran for the first time on the Vite dev server: 28/42, with narrow-viewport table rendering defects open. WebKit projects (iPhone, iPad) not run. |
| Android | Static release check PASS. Gradle/APK build **not run** (no JDK or SDK here). Native OAuth handoff not device-tested. |
| Chat latency (real app, 8 turns) | MEASURED: p50 4.5 s, p90 6.8 s. |
| Time for a stated fact to reach memory | MEASURED: 17–94 s under free-tier rate limits; 0 dead jobs since the capacity backoff fix. |
| Cost per turn | See §3c: ≈ $0.0025 on paid gpt-oss-120b (estimate from measured tokens). |

## 6. Scorecard summary (2026-10-17)

| Area | Grade | Why |
|---|---|---|
| Security baseline | **Blocked on founder action** | Secrets are in a public repo and must be rotated. Production lacks the fixes; a tested release candidate is ready (`RELEASE_MANIFEST_RC_2026-10-17.md`). |
| Core promise (current state) | **Partly demonstrated in the workflow; not as a technical advantage** | End to end: changes, corrections and deletions work for single-change statements (21/23). Compound changes lose one part. Retrieval benchmarks: the canonical read is noisier and less silent than the legacy one; long histories (v4) unmeasured. |
| Trust controls (see, correct, delete) | **Demonstrated** | The Memory page shows what answers, with sources; correction and deletion hold across conversations and stores; isolated per account. |
| Onboarding to aha moment | Works end to end | The interview and card are verified on the real app; activation is instrumented. |
| Pilot operations | **Needs one paid provider tier** | Free-tier extraction throughput is about 10 per minute for the whole product. |
| Measurement | **Ready** | Funnel events, eval gate including the production read path, founder-journey driver, pre-registered v4. |
| Business | Hypothesis only | No users, revenue or willingness-to-pay data in the repo. |
