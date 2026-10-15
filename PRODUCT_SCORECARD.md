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
| v4 before/after runs | **UNMEASURED.** Both attempts died when the host laptop slept (logs `lift-v4.*.attempt1-sleep.log`, `*.retry1.log`). |
| VM kit | Validated in a disposable container on 2026-10-15 (smoke test exit 0, 10/10 graded). **Not launched; needs the founder's approval and a host.** |

**What would justify the World Model as a moat:** on the *long* personas, the
World Model (or the hybrid) beats both simple memory and the
production-window history on correctness and stale rate, under the
pre-registered statistic. If it doesn't, the pre-registered decision is SIMPLIFY
or STOP, and the product should ship the simpler path.

## 4. Product funnel (instrumented today; no production data yet)

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

## 5. Reliability, latency, cost

| Metric | Status |
|---|---|
| Automated tests | MEASURED today: aqua 4,366/4,370 pass (4 skipped); platform 233/234 (the 1 failure is a local gitignored file); frontend 117/117; eval gate PASS. |
| Cross-user isolation | MEASURED (unit/integration): conversation 404 guards, workspace owner checks, owner adoption (new today) and bundle ownership (new today). Owner isolation and purge were verified on live infrastructure on 2026-10-05 (HISTORICAL). **No adversarial end-to-end test against the deployed site.** |
| Deletion correctness | Battery passes on this branch. Known gaps are listed in `REPO_AUDIT.md` §7. Production lacks the hotfix (B2). |
| Provider failure rate | UNMEASURED in production. Free-tier quota exhaustion was observed repeatedly in evaluations (HISTORICAL). |
| p50/p95 chat latency | UNMEASURED for the product. Process metrics exist (`/metrics` with token). |
| Cost per completed task | **UNMEASURED.** `aqua/src/core/costAccounting.js` counts tokens per turn and purpose, but ships no prices on purpose (`costUsd = null` until `setPriceTable` is called). Every production model today is a free tier, so the marginal cash cost is about $0, and that is not a sustainable or necessarily compliant basis. **Next step:** pick paid models, load their prices, and report cost per activated user per week. |

## 6. Scorecard summary

| Area | Grade | Why |
|---|---|---|
| Security baseline | **Blocked** | Secrets are in a public repo and production lacks the hotfix. Code-side fixes are done on this branch. |
| Core promise (current state) | **Not demonstrated** | Worse than simple memory and full history on short histories; long histories unmeasured. |
| Onboarding to aha moment | Built, unmeasured | The interview and "what I understand" card exist; activation is now instrumented. |
| Measurement | **Ready** | Funnel events, report, eval gate, pre-registered v4. |
| Business | Hypothesis only | No users, revenue or willingness-to-pay data in the repo. |
