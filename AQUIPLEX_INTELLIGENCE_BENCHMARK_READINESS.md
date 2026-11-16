# AQUIPLEX — Intelligence Benchmark Readiness (A vs H, answer level)

**Date:** 2026-11-12 · **Status: prepared, NOT executed.** No live request was made. All measurements below are offline: the real context pipeline, with a network guard (0 external requests). No dataset, baseline, production code or routing was changed.

## 0. The decision that comes first

**The frozen 100-scenario evaluation set cannot show that H is better than A.** This is according to this repository's own governance.

- `acib.v2.eval` (sha256 `002208e4…`, freeze verified today) was authored by the engine's own author before Sprint 4. After its single run, it was **read item by item**.
- Hybrid context (H) was then built by the same author. [AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md](AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md) classes the set as **"Contaminated … may be run as a regression check, but never cited as independent."** [AQUA_HYBRID_CONTEXT_V1_RESULTS.md](AQUA_HYBRID_CONTEXT_V1_RESULTS.md) already reports H on it as development evidence only.
- The independent set, **ACIB v3**, does not exist. It needs at least two scenario authors who did not build the engine, plus a reviewer sign-off ([AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md](AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md)). None has been appointed.
- **Statistically, too,** v2 eval is too small for this question (§5): even a perfect translation of the known context-level gains would not reach significance.

**Recommendation.**

- **Option A (recommended): run the answer-level A/B on `acib.v2.eval` now, labelled "development / regression evidence".** It tests the full pipeline at scale, measures answer quality and model noise, and checks that H does not *hurt* answers. It must not be cited as proof of improvement.
- **For the improvement claim:** commission ACIB v3 (independent authors + reviewer, ~150 eval scenarios), then run the same plan once on it.
- **Option B:** wait for v3 and run nothing now.

## 1. Benchmark inspection (`acib.v2.eval`)

| Property | Finding |
|---|---|
| Scenarios | **100**, each run in 2 regimes → **200 paired cases** (400 answers) |
| Regimes | **short:** history only. **long:** history plus filler conversations until the user's past messages exceed 9,000 characters. |
| Categories | personal 10 · long-history 10 · cross-project 10 · history-change 12 · contradiction 8 · missing 12 · financial 12 · employment 8 · third-party 10 · negative 8 |
| Changing facts / contradictions | 11 scenarios with temporal annotations (history-change); 8 with contradiction annotations |
| Missing / unknown information | 13 with `unknowns` annotations (missing category: e.g. "Can we afford the flat?" without the figures) |
| Personalisation | personal, third-party (family members' facts), financial and employment advice that should use the user's facts |
| Negative controls | 8 impersonal questions (e.g. "capital of Canada"); 8 scenarios have no required need. Personal context should **not** be used. |
| Distractors / cross-entity | 14 with distractors (e.g. a hobby that must not leak into a job answer); 9 cross-entity; 10 with inline filler |
| History length | 0–3 messages per scenario, plus up to 9,000 chars of filler (long regime); 1 scenario has an upload |
| **Language-mismatch tests** | **None.** Only 1 scenario contains any non-ASCII character, and none is in another language. Not covered. |
| **Indirect-reference tests** | **Weak.** About 5 questions use pronoun or relational references; there is no dedicated category. Third-party questions ("my sister", "my mum") are the closest. |
| Expected answers | Per scenario `needs[]`: required facts with `match` strings, `evidence` and slots. Plus `distractors`, `temporal` (current vs stale value), `contradiction` and `unknowns`. |
| Scoring | **Deterministic** (`eval/answer/answerGrader`, from the annotations): factual correctness, temporal accuracy, contradiction handling, uncertainty handling, clarification quality, personalisation; counts of stale assertions, ungrounded figures, personal leaks, distractor mentions and questions asked. **Judge** (rubric 0–2): factual correctness, grounding, personalisation, temporal, contradiction, uncertainty, clarification; hallucination flag; confidence. |

**Independence of dev and eval:** 0 shared scenario ids, 0 shared history lines, 1 identical question text (an impersonal one). The dev set (`acib.v2.dev`, 40) is the development set; the eval set is never used for development.

## 2. What actually differs between A and H (measured)

The evaluation must compare only the context treatment. I built every eval prompt offline for both arms (normalising a random per-build security delimiter) and compared them:

| Set / regime | Control: A built twice | **A vs H: prompts differ** | Where H changes the prompt |
|---|---|---|---|
| v2 eval short | 100 / 100 identical | **37 / 100** | missing 11, history-change 7, contradiction 7, financial 6, employment 3, personal/cross-project/third-party 1 each |
| v2 eval long | 100 / 100 identical | **40 / 100** | missing 11, financial 9, history-change 7, contradiction 7, employment 4, cross-project/third-party 1 each |
| v2 dev short / long | 40 / 40 identical | 18 / 40 · 25 / 40 | similar categories |

**Consequences**

1. **In 63 short / 60 long cases, A and H send exactly the same prompt.** Any answer difference there is **model noise**. Groq at temperature 0 is not guaranteed deterministic. These cases are a built-in **noise control**: they estimate how often the same prompt yields a different verdict.
2. **H can only matter in 37 / 40 cases per regime,** concentrated in missing information, changing facts, contradictions and advice. The analysis reports this subset separately.
3. **The only manipulated variable is `AQUA_HYBRID_CONTEXT=on`.** The answering model, settings and scenarios are identical (the pair runner's model lock refuses a pair answered with a different model or settings).

## 3. Evaluation design

| Requirement | How it is met | Status |
|---|---|---|
| Same answering model, both arms | Groq `openai/gpt-oss-120b` | Enforced (model lock per pair) |
| Identical generation settings | `temperature 0`, `max_tokens 1500`, from the config; settings hash in every record | Enforced |
| Only context differs | Arm env: A `{}`, H `{ AQUA_HYBRID_CONTEXT: 'on' }`; separate isolated user ids per arm | Enforced (verified §2) |
| Same scenarios both arms | Pairs are case-keyed; a pair is judged only when both arms are answered | Enforced |
| Blind judging | The judge receives one answer at a time, with **no arm label** (`judgePrompt({history, question, answer})`) | Enforced |
| Randomised order | Arms are answered and judged **always A then H** within a case. Not randomised. | **Gap.** Proposed eval-only change: a seeded per-case shuffle of arm order (D6) |
| Independent judge | Groq `qwen/qwen3.8-27b`: a different model family from the answerer. It worked in the smoke test (2/2 valid verdicts). | Ready; limits to verify (D3) |
| Automatic metrics retained | Deterministic grader runs on every answer at merge | Ready |
| Human-review cases retained | The merge queues malformed and low-confidence (< 0.6) judgements | **Partial.** Proposed (D6): also queue every discordant pair, every judge-vs-deterministic disagreement, and a 10% random audit for founder grading |
| Failed / missing reported | `incomplete`, `refused`, `stopped-*` statuses in every run record | Ready. The analysis must list them (§5). |

## 4. Cost and quota plan ($0)

### Requests

| Stage | Requests |
|---|---|
| Answers: 100 scenarios × 2 regimes × 2 arms | **400** |
| Judgements: one per answer | **400** |
| **Total** | **800** (optional second-judge sample: +40 to +80) |

### Tokens

Measured prompt sizes are 2,277,895 characters across the 400 answer prompts (median 5,446–5,957 per prompt; maximum 9,078). The conversion ratio is 4.48 chars/token, as observed in the live smoke test.

| Stage | Input (expected) | Output (expected) | **Expected total** | **Ceiling** (every output at its maximum) |
|---|---|---|---|---|
| Answers | 510k–570k | 80k–180k (most answers are short; the advice categories are longer) | **0.59M–0.75M** | 0.57M + 400 × 1,500 = **1.17M** |
| Judging | 250k–350k (172k rubric framing + answer text) | ~45k (113/judgement in the smoke test) | **0.30M–0.40M** | 0.17M + 0.60M + 400 × 1,024 = **1.18M** |
| **All** | | | **≈ 0.9M–1.15M** | **≈ 2.35M** |

### Free quota (Groq free plan)

These figures were measured on 2026-11-01 and **must be re-checked in the console**. Limits apply per organisation, per model:

- `gpt-oss-120b`: **1,000 requests/day, 8,000 tokens/minute, ~200,000 tokens/day.** Request count is not the constraint; **tokens per day are**.
- `qwen/qwen3.8-27b`: **limits unknown**; verify before planning.
- These quotas are **shared with production traffic** on the same keys.

| Scenario | Answering days (gpt-oss-120b) |
|---|---|
| 1 organisation, evaluation takes ≤ 50% of the daily tokens (100k/day) | **6–8 days** |
| 1 organisation, evaluation takes all of it (production starved) | 3–4 days (**not recommended**) |
| 5 organisations, if verified as separate and free (the 2026-11-01 header probe suggested separate orgs; ownership and billing are unverified for keys 2–5) | ~1.5–2 days at 50% each |

The judge stage is additional, on Qwen's own limits. **The smoke-test configuration (cap 2, `GROQ_API_KEY_1` only) is not sufficient**; a new configuration is required (§6).

**Gemini as a judge is not viable at this scale:** about 20 requests per day per project were measured, and it is unknown how many projects the 12 keys span.

**Wall clock:** the 61-second pacing allows about 60 requests per hour per organisation. Daily tokens, not time, are the limit.

### Per-run cap

Each daily run stops at its cap, and the next day's run resumes without repeats (tested). With the conservative per-request ceiling (~3,500 tokens):

- a cap of **28 answer requests/run** can never exceed 100k tokens;
- a cap of **50** typically uses ~85k, with a worst case of ~175k.

**Proposed (D6):** a per-run *token* budget in the evaluation manager. Today it caps requests, not tokens. Even without it, a daily-limit 429 pauses the run immediately, but by then production has lost the rest of that day's quota.

## 5. Scientific safeguards and statistics

**Frozen inputs**

- Dataset hashes verified: eval `002208e4…`, dev `abca8916…`.
- The config allow-list (`syntheticDatasets`) admits only these hashes.
- The scorer, grader, judge rubric and this plan are hashed into the run record **before** the first request (pre-registration).
- No existing baseline is modified; answer-level baselines are created only from this run.

**Pre-registered primary endpoint, per regime:**

- **Correct** = judge `factual_correctness = 2` **and** `hallucination = false`.
- Paired A vs H on all 100 scenarios.

**Primary test:** exact McNemar on discordant pairs. Paired risk difference with a 95% CI (bootstrap over scenarios, 10,000 resamples, fixed seed). Holm correction across the two regimes.

**Secondary (descriptive):**

- Mean judge score (sum of the 4 always-applicable dimensions, 0–8): paired difference with a bootstrap CI.
- Deterministic grader metrics.
- The changed-prompt subset (37/40) versus the identical-prompt subset (the noise control).
- Hallucination rate.
- **Category breakdown with counts and CIs, no claims:** 8–12 scenarios per category is too few.

**Missing data:**

- Complete pairs form the primary analysis.
- A sensitivity analysis counts a missing or failed answer as incorrect for that arm.
- Every failed, refused, paused or review-queued item is listed by count.

**Power (why no improvement claim is possible from v2 eval):**

- Context level, long regime: H gained 5 cases and lost 0 (short: 0 / 0).
- If all 5 became answer-level gains with zero noise, exact McNemar 5–0 gives **p = 0.0625**, which is not significant. Any noise-induced discordance weakens it further.
- The plan therefore reports estimates and CIs, and **claims improvement only if the pre-registered test passes**. From v2 eval, the expected honest conclusion is "no detectable regression / inconclusive".
- ACIB v3 (≈150 targeted scenarios) is the setting where a claim could be supported. The success criteria are in the plan's §7 and are to be confirmed before its freeze.

## 6. Proposed execution plan (NOT run; each step needs founder authorisation)

1. **Decisions D1–D6** (§8).
2. **Eval-only code (if approved), with tests:**
   - seeded arm-order randomisation;
   - per-run token budget;
   - extended review queue;
   - the offline paired-analysis script (McNemar, bootstrap CIs, subsets, categories);
   - plan and scorer hashing into the run record.

   No production code.
3. **New config** `C:\Users\dell\aquiplex-eval\config-benchmark.json`:
   - `syntheticDatasets: ["002208e4737bd917143d90097db5e018d84b49e936ee8ea7b7704c21f1242e21"]`;
   - verified organisation(s) with billing evidence;
   - `requestBudget.groq` = the daily cap;
   - same models and settings as the smoke test;
   - `keyRotation: false`, `waitOnRateLimit: false`.
4. **Pre-registration:** hash this plan, the scorer, grader and rubric, and record them in the results directory.
5. **Daily answering runs** (PowerShell, new window without provider keys). Repeat each until it reports `COMPLETED`; each run resumes without repeating:
   ```powershell
   cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua
   $env:AQUA_ANSWER_EVAL_APPROVED="yes"; $env:AQUA_EVAL_LIVE_APPROVED="yes"
   node scripts/answer-eval.mjs --execute --answers-only --set acib.v2.eval --limit 100 --regime short --arms A,H --label acib-v2-eval-ab-short --provider-config C:\Users\dell\aquiplex-eval\config-benchmark.json
   node scripts/answer-eval.mjs --execute --answers-only --set acib.v2.eval --limit 100 --regime long  --arms A,H --label acib-v2-eval-ab-long  --provider-config C:\Users\dell\aquiplex-eval\config-benchmark.json
   Remove-Item Env:AQUA_ANSWER_EVAL_APPROVED, Env:AQUA_EVAL_LIVE_APPROVED
   ```
   `--limit 100` is required: the script defaults to 10 scenarios.
6. **Judging runs** (same pattern):
   ```powershell
   node scripts/answer-judge.mjs --execute --label acib-v2-eval-ab-short --set acib.v2.eval --regime short --arms A,H --provider-config C:\Users\dell\aquiplex-eval\config-benchmark.json
   node scripts/answer-judge.mjs --execute --label acib-v2-eval-ab-long  --set acib.v2.eval --regime long  --arms A,H --provider-config C:\Users\dell\aquiplex-eval\config-benchmark.json
   ```
7. **Offline:** `--merge` for both labels, then the pre-registered analysis; founder review of the review queue.
8. **Report:** aggregates, CIs, subsets, noise control, missing items. Labelled **development / regression evidence** for v2 eval.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Contaminated set read as proof | §0 labelling; the report template says "not independent" |
| Production starved of Groq quota for several days | ≤ 50% share, low-traffic hours, per-run cap; verify remaining quota daily |
| Model noise at temperature 0 | Identical-prompt cases measure it; report the noise discordance rate |
| A pause between a case's A and H answers → different dates in the prompts | Arms are answered consecutively; even per-run caps; record and report split pairs (each answer is timestamped) |
| A judge position or time drift effect | Absolute (not pairwise) grading, blind; arm-order randomisation (D6) |
| Qwen limits or availability on the Free plan | Verify in the console (D3); unknown errors stop after 1 request |
| Judge bias or miscalibration | Deterministic grader in parallel; human audit sample; optional second judge |
| Long answers exceed the judge budget | `max_tokens` 1,024 on the judge; an empty completion stops for review |
| Weak coverage: no language mismatch, few indirect references | Stated as a limitation; include in ACIB v3's authoring guide |
| The dataset's hash allow-list currently admits only the dev set | The new config adds only the eval hash |

## 8. Outstanding founder decisions

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Dataset: v2 eval now as development evidence (Option A), wait for ACIB v3 (Option B), or both | **Both:** A now; commission v3 for the claim |
| **D2** | Quota: one organisation (6–8 days) or verify ownership and billing of keys 2–5 (~2 days); the evaluation's share of daily tokens; the daily cap | Verify the orgs; 50% share; cap 28–50 answers/run |
| **D3** | Judge: confirm `qwen/qwen3.8-27b` limits on the Free plan; optional second-judge sample (Gemini, ≤ 20/day) | Qwen; a second judge only on a 40-item sample |
| **D4** | Send H for identical-prompt cases (≈ 120 extra requests, measures noise) or skip them | **Send** (the noise control is needed to interpret any difference) |
| **D5** | Primary endpoint and thresholds (§5) | Adopt as written; freeze before the first request |
| **D6** | Approve eval-only changes: arm-order randomisation, per-run token budget, extended review queue, paired-analysis script, pre-registration hashing | Approve; about 0.5–1 day with tests, mocked only |
| **D7** | ACIB v3: appoint ≥ 2 independent authors and a reviewer | Required for any improvement claim |

**Stopped — awaiting founder review. No live requests; nothing committed, pushed or deployed.**
