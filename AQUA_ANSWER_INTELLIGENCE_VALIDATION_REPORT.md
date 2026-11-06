# Aqua: answer-level intelligence validation (2026-11-05)

**Outcome: the answer-level comparison was NOT run, so no answer-level claim can be made.**

No answer model met the mission's conditions: already authorised, verifiably isolated from Lift v4b and from shared quota, free, and requiring no download or install (§1). Per the mission, **no model call was made**. Instead:
- **The comparison is frozen and fully reproducible:** HEAD and DEV get identical inputs, shown to differ only in memory content.
- **The answering and grading package is ready to run** the moment an answerer is authorised.
- **Every model-free analysis that is honest to do has been done.**

What the evidence does and does not show:
- **It shows:** the system prompt DEV gives the answer model now holds a consistent, correctly marked account of the user's world for 11 of 12 questions, against 5 of 12 on HEAD.
- **It does not show** that answers improve. In every case where HEAD's prompt falls short, the correct information is *still present* in it: the recall block quotes the user's later words verbatim. So HEAD's prompts are **contradictory, not empty**, and a capable model may resolve many of them correctly. Only generated answers can settle this.

Constraints observed:
- Main tree, nothing committed.
- Lift v4b untouched (no access to its databases or run directories).
- No Postgres, no real user stores, no downloads, no baselines changed.
- **The implementation was not modified:** DEV's 407 source files are byte-identical to the freeze fingerprint.

---

## 1. Model and evaluation environment

**Inventory:**
- `.env` variable **names** only (no values read);
- process environment;
- local runtimes: `ollama`, `llama.cpp`, LM Studio, koboldcpp, ports 11434 and 1234.

| Option | Status | Usable? |
|---|---|---|
| Groq `GROQ_API_KEY_1..5` | Lift v4b's extraction provider (measured caps ≈200k tokens/key/day) | **No:** shared with Lift |
| Gemini `GEMINI_KEY_1..8` | Lift v4b's answer and judge pool | **No:** shared with Lift |
| Gemini `GEMINI_KEY_9..12` | in the same `gemini-pool` configuration (set aside for one model only); project membership unknown | **No:** not verifiably isolated |
| NVIDIA `NVIDIA_API_KEY_1..5` | not in the v4b design (v4b exists because NVIDIA was down). They are the **product's** provider keys (`src/providers/nvidia.js`, `keyPool.cjs`) in an `.env` that runs `NODE_ENV=production`, and were Lift's judge in earlier designs | **No:** isolation from production and from Lift fallbacks can't be verified without reading Lift's run kit (forbidden). Not authorised for this run |
| OpenRouter `OPENROUTER_API_KEY(_1..4)` | the product's provider keys (`src/providers/openrouter.js`) | **No:** shared with production; not authorised |
| HF token | not authorised; account quota shared | **No** |
| Local model | no runtime installed or running; installing or downloading is forbidden | **No** |

**Decision:** no model calls. The blocker is authorisation plus verifiable isolation, not technical feasibility.

**What would unblock it** (any one):
1. **A dedicated key:** the owner creates a provider key, or a free account, used by nothing else (not Lift, not production), and authorises it by name for this evaluation.
2. **A local model:** the owner approves installing a small local model (for example via Ollama) on this machine.
3. **The owner confirms in writing** that a specific existing key (e.g. one NVIDIA slot) is unused by Lift v4b and by production, and authorises it.

`run-answers.mjs` enforces this: it refuses to run without `--confirm "isolated-free-authorized:<provider>"`.

**Environment of the frozen comparison:**
- Windows 11, Node 24.19.0;
- each build in a private temporary data directory, the Mongo mirror disabled, no `DATABASE_URL` (the legacy read production serves);
- simulated clock.

## 2. Comparison methodology

**Conditions:**
- **A = HEAD:** commit `df674e61`, extracted with `git archive` into a temporary folder; no git state touched.
- **B = DEV:** today's working tree, fingerprinted in `dev-code.sha256` (407 source files, verified unchanged after the build).

**Identical for both:**
- **Inputs:** three lives and 12 questions (`answer-lifecycle.dev.v1.json`, sha256 `155c0390…`). Each question gets **a fresh account with its life replayed**, so earlier questions can't leak into later prompts (§2.1).
- **Prompt path:** the real production `routes/chat.js prepareTurn`.
- **Flag profiles:** production code defaults (primary) and developer flags (secondary).
- **Answer settings** (`run-answers.mjs`): temperature 0, top_p 1, max_tokens 600, seed 7, the recorded system prompt plus the question. Both conditions are sent in one seeded, interleaved order, so time or rate drift can't favour one. The run stops at the first quota or rate signal.
- **Grading:** a separate step (`answer-eval-harness.mjs grade`) with a fixed deterministic rubric. Its self-test separates each question's good and bad example answer (12/12). Raw outputs are kept append-only (`answers.raw.jsonl`), with the SHA-256 of every exact request body.

**Mission grading dimensions → fixed checks:**

| Dimension | Check (deterministic) |
|---|---|
| current-state accuracy | `include` (current value given) and `notCurrent` (a retired value only in a sentence that marks it past) |
| historical accuracy | `include` of the earlier value (q02) |
| goal-status accuracy | `notOpen` (an achieved goal not presented as open) and `include` |
| temporal interpretation | covered by the current, historical and goal-status checks above (what is now vs what was) |
| uncertainty handling | `hedge` on the dependent record (q04) |
| unsupported claims / hallucinations | every answer: capitalised names or long numbers absent from the context and question |
| abstention | `abstain` phrases on never-stated facts (q06, q10) |
| personal context | `include` of a relevant personal fact (q05) |

The rubric is a **proxy**: string and sentence rules. A frozen LLM judge can be added later as a *second, separately reported* grader.

### 2.1 Validity of the freeze (checked, model-free)

- **Reproducible.** Each condition was rebuilt three times. The 12 prompts are identical apart from a random per-request untrusted-content fence nonce, a security token (`check-repro.mjs`).
- **Equivalent.** Per prompt, only memory-derived sections differ (identity, profile, cognitive model, related knowledge, recall). The fixed instruction text is identical in dev-env. In code-defaults the one difference is that DEV omits the cognitive-model block for some questions, which is content, not wording (`instruction-diff.mjs`).
- **One harness defect found and fixed before the freeze.** Questions for one life were asked in sequence in one account, so each earlier question leaked into later prompts ("open question: What should I focus on at work this month?" appeared in q06). It was equal across conditions but contaminating. Now one account per question.

## 3. All 24 prompts (12 questions × HEAD / DEV)

Prompt files: `aqua/eval/answer-validation/2026-11-05/prompts.{code-defaults,dev-env}.jsonl`.

**The lives:**
- **job:** Fintrail data analyst; goals: promotion, half marathon; Atlas migration at Fintrail due March 3. A week later: "I now work at Northbeam as a senior analyst."; "I finally ran the half marathon."
- **people:** "I work at Northbeam."; "My manager is Priya Rao and my accountant is Lena Ortiz." A week later: "Actually, my company is Halcyon Labs."; "Our biggest client is Meridian Health."
- **goals:** CFA Level 1 and Spanish goals. A week later: "I passed my CFA exam!"; "I didn't get to practice Spanish this week."

| # | Question | Category | A correct answer must |
|---|---|---|---|
| q01 | Where do I work now? | current | say Northbeam; Fintrail only as past |
| q02 | Where did I work before my current job? | historical | say Fintrail |
| q03 | How is my half marathon goal going? | goal_status | say it's done |
| q04 | Is the Atlas migration still on my plate? | uncertain_dependency | name Atlas and hedge or ask (the job changed) |
| q05 | What should I focus on at work this month? | personal_context | use Northbeam / senior analyst |
| q06 | What's my manager's name? | abstention | say it wasn't stated (job life) |
| q07 | What company do I work for? | current | say Halcyon Labs; Northbeam only as past |
| q08 | Who is my accountant? | current | say Lena Ortiz |
| q09 | Who is our biggest client? | current | say Meridian Health |
| q10 | What's my accountant's phone number? | abstention | say it wasn't shared; invent nothing |
| q11 | Which of my goals are still open? | goal_status | Spanish open; CFA not open |
| q12 | Did I pass the CFA? | goal_status | yes |

## 4. Answers from both implementations

**None were generated** (§1): 0 of 24 answers per profile. There is nothing to show and nothing was invented.

What each condition's prompt tells the model about the question asked, from `focus.code-defaults.txt` (the dev-env profile is the same in substance):

| # | HEAD prompt says | DEV prompt says |
|---|---|---|
| q01 | Identity "Company: Fintrail", profile "workplace: Fintrail"; recall quotes "I now work at Northbeam…" last | "Company: Northbeam", "workplace: Northbeam (previously: Fintrail)"; recall marks the Fintrail sentence "since changed — now: …Northbeam" |
| q02 | Fintrail (as current); Northbeam only in recall | Northbeam current, Fintrail "previously" |
| q03 | "Active goals: run a half marathon"; "Anticipated need: working toward it"; recall "I finally ran the half marathon." | under "No longer current": "run a half marathon in October (achieved) — they said: 'I finally ran the half marathon.'" |
| q04 | only the recall quote "I'm leading the Atlas migration at Fintrail; due March 3" | "deadline: I'm leading the Atlas migration at Fintrail… (uncertain whether still current — they said: 'I now work at Northbeam…')" |
| q05 | "Role: Data Analyst, Company: Fintrail"; recall has the move | "Role: Senior Analyst, Company: Northbeam (previously: Fintrail)" |
| q06 | no manager anywhere | no manager anywhere |
| q07 | "Company: Northbeam" and **"project: Halcyon Labs"**; recall "Actually, my company is Halcyon Labs." | "Company: Halcyon Labs"; recall marks "I work at Northbeam" as changed |
| q08 | "custom manager: **Priya Rao and my accountant is Lena Ortiz**" (one run-on fact); recall has the sentence | "custom manager: Priya Rao", "custom accountant: Lena Ortiz" |
| q09 | only the recall quote | "custom biggest client: Meridian Health" plus recall |
| q10 | the run-on manager fact; no phone | "custom accountant: Lena Ortiz"; no phone |
| q11 | "Goals: pass the CFA…, learn Spanish"; "Active goals: both"; recall "I passed my CFA exam!" | "Goals: learn Spanish"; "No longer current: pass the CFA… (achieved)"; "Active goals: Spanish" |
| q12 | CFA listed as an active goal; recall "I passed my CFA exam!" | "pass the CFA… (achieved) — they said: 'I passed my CFA exam!'" |

## 5. Grading results

**Answer grading: not available** (no answers).

**Context sufficiency** (model-free, `answer-eval-harness.mjs sufficiency`): does the prompt contain what a correct answer needs, marked correctly?

| # | HEAD | DEV |
|---|---|---|
| q01 current | gap: retired value presented as current | ok |
| q02 historical | ok | ok |
| q03 goal status | gap: achieved goal presented as open | ok |
| q04 uncertain dependency | gap: no uncertainty signal | ok |
| q05 personal context | ok | ok |
| q06 abstention | ok (nothing to invent from) | ok |
| q07 current | gap: retired value presented as current | ok |
| q08 current | "gap" (criterion flaw, below) | "gap" (criterion flaw) |
| q09 current | ok | ok |
| q10 abstention | ok | ok |
| q11 goal status | gap | ok |
| q12 goal status | gap | ok |
| **total** | **5/12** | **11/12** |

Identical in both flag profiles.

**q08 is a flaw in my own criterion, not in the prompt.** "Priya Rao" is labelled `notCurrent` to catch the wrong *answer* "your accountant is Priya Rao". But she is current, as manager, so the model-free check misfires on both conditions. Label unchanged; on context content alone, DEV holds two clean facts and HEAD a run-on one.

## 6. Before and after metrics

| Measure | HEAD | DEV | Level |
|---|---|---|---|
| prompts sufficient for a correct answer | 5/12 | 11/12 | **context** |
| prompts where authoritative blocks contradict the user's later words | 5 (q01, q03, q07, q11, q12) | 0 | context |
| prompts with no signal that a dependent record may be stale | 1 (q04) | 0 | context |
| prompts carrying a run-on or misfiled fact | 2 (q07 project, q08 run-on) | 0 | context |
| answers correct | — | — | **not measured** |

The prompt is about 3% longer in DEV (mean 5,861 vs 5,686 characters, code-defaults).

## 7. Individual failure analysis (prompt level)

**HEAD, by origin:**

| # | What's wrong in the prompt | Originating stage | Answer risk |
|---|---|---|---|
| q01, q02, q05 | the workplace and role stay Fintrail and data analyst after "I now work at Northbeam as a senior analyst" | **state transition**: no current-state resolution in HEAD | medium. The identity block is labelled "authoritative… answer confidently", while recall quotes the move; a model may follow either |
| q03, q11, q12 | an achieved goal is listed as active and predicted ("working toward") | **state transition** (no achievement reading) + **cross-store** (two goal stores, no sync) + **context construction** (prediction from it) | medium. Recall quotes "I passed my CFA exam!", "I finally ran…" |
| q04 | the Atlas migration has no uncertainty signal | **cross-store reconciliation**: no dependent propagation | high. The only evidence is "I'm leading the Atlas migration… due March 3" |
| q07 | Halcyon Labs filed as a **project**; workplace still Northbeam | **extraction**: entity classification | medium. Recall quotes the correction |
| q08, q10 | one run-on fact "Priya Rao and my accountant is Lena Ortiz" | **extraction**: multi-fact | low to medium. Readable, but mislabelled as the manager |
| (all) | internal routing IDs ("focus: simple_qa, personal_info") in "Current state" | **context construction** | low; noise |

**DEV, remaining problems (systematic, not fixed in this mission):**
1. **A dependent record rides along on every turn.** The uncertain Atlas deadline appears in "Current state" for *unrelated* questions (q02, q03, q06 "What's my manager's name?"). The cognitive block isn't question-gated (the architecture report's opportunity 4). Origin: **context construction**. It's correctly marked uncertain, so the risk is distraction, not misinformation.
2. **An achievement through a change of state is not read.** "Get promoted to senior analyst" stays an active goal *and* the top prediction after "I now work at Northbeam as a senior analyst". The user now holds the target role, but by a new job, not a promotion. Whether that counts as achieved is genuinely ambiguous. Today neither store asks, and the prompt asserts the goal as current. Origin: **state transition and understanding** (no link between a goal's target and a fact's new value).
3. **The question echoes itself into its own prompt.** "open question: What should I focus on at work this month?" appears in q05 (HEAD has it truncated: "at work this month"). Working memory records the current message as an open question before the prompt is built. Origin: **context construction**, in both conditions.
4. **Inferred predictions** ("Anticipated need: Likely working toward …, p=0.6") still appear beside facts in both conditions. Origin: **prompt construction**. They are labelled as inferred but persuasive.

**Not attributable without answers:** whether the answer model resolves HEAD's contradictions correctly (answer generation), and whether DEV's extra markers ("uncertain whether…", "(achieved)") are used as intended (prompt instructions).

## 8. Held-out evaluation plan

Full specification: `aqua/eval/answer-validation/2026-11-05/HELDOUT_SPEC.md`. Validator: `validate-heldout.mjs`.

**I did not write held-out questions.** The specification asks an **independent evaluator** (not the implementer, who must not see the development cases or results) for:
- at least 6 lives and 30 questions, at least 4 per category;
- in each life, at least one real change and one statement that only *sounds* like a change;
- natural phrasing (several facts per sentence, pronouns, achievements without "done");
- a good and a bad example answer per question.

**The validator:**
- pins the submitted file's SHA-256;
- checks schema and coverage;
- rejects sentences and names reused from the development sets;
- checks the rubric separates the writer's examples.

Tested on the development set itself, it correctly rejects it: coverage, a reused sentence, reused names.

**Procedure and decision rule:**
- The procedure is fixed in advance: submit and hash before any run; same answerer and settings as the development comparison; held-out results reported separately; nothing in the implementation changes between submission and grading (any change spends the set).
- **Decision rule:** paired sign test on DEV − HEAD per question, p < 0.05, and no category worse by more than one question. With 30 questions only large effects are detectable; anything smaller is reported as "not shown".

## 9. Limitations and confidence

1. **No answer-level evidence.** Improvement at the answer level is **not established**. The context-level evidence is strong for *consistency* (DEV's prompt no longer contradicts itself, and marks achieved and uncertain items). It is weak for *answer quality*: HEAD's prompts usually still contain the right fact in the verbatim recall block.
2. **The expected effect is uneven.**
   - **Largest:** q04 (the dependency), where HEAD gives no signal at all. Also q07 and q08, where the misfiled or run-on fact sits in the "authoritative" profile.
   - **Uncertain:** q01, q03, q11 and q12, where a strong model may read recall's later statements correctly on HEAD.
   - **None expected:** q02, q05, q06, q09, q10.
3. **Twelve questions, one author,** written in the mission that built the mechanisms. The development cases can't establish generality; the held-out plan exists for that.
4. **The rubric is a deterministic proxy.** It checks strings within sentences, not meaning. It separates the authored examples (12/12), but real answers paraphrase. A second, frozen LLM judge is recommended, reported separately.
5. **One answer model and temperature 0** would measure one model's behaviour. Repeat with a second model if possible.

**Confidence:**
- **High** that the comparison is fair and reproducible.
- **High** that DEV's prompts are more consistent.
- **None yet** on whether answers are better.

## 10. Recommended next engineering priority

1. **Unblock the evaluation, not the code.** Authorise one isolated answerer (§1), run the 24 prompts in both profiles, grade, publish the raw outputs. Then commission the held-out set from an independent writer. **No intelligence work should be prioritised on the strength of context metrics alone** until this runs.
2. **Then, if answers confirm the context gains:** question-gate the cognitive block (DEV problem 1, the most systematic remaining issue). Stale or uncertain items, inferred predictions and the question's own echo reach every turn. This is a context-construction change, measurable with the same frozen package as a third condition.
3. **Then the goal–state link** (DEV problem 2): when a fact's new value matches a goal's target ("senior analyst"), flag the goal for review, as dependents are flagged today. Never close it automatically.
