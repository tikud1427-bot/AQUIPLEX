# Aqua: answer-level results, HEAD vs DEV (2026-11-05)

## Status: BLOCKED. No answers generated, no model called.

The frozen 24-prompt comparison is verified and ready to run. It is waiting for **one explicit authorisation from the owner** naming a dedicated evaluation key (§4). This mission's message gives none, and none may be inferred from keys present in `.env`. So there are **no answer-level results yet**: nothing about whether DEV answers better than HEAD is established.

Constraints observed:
- Lift v4b untouched (no access to its databases or run directories).
- No production or Lift credentials used.
- No secret values read: only variable names.
- No real user stores, no downloads, no Postgres.
- Nothing committed.
- The frozen package is unchanged: `MANIFEST.sha256` verifies 20/20. Additions are listed in §2.
- No code changes.

## 1. Verification of the frozen package (all passed)

| Check | Result |
|---|---|
| HEAD commit | `df674e610455cdbd740266de50cd38649ee817ad` ✓ |
| Frozen package files (`MANIFEST.sha256`) | 20/20 OK, folder otherwise untouched ✓ |
| DEV code (`dev-code.sha256`) | 407/407 source files identical to the freeze ✓ |
| HEAD code | a fresh `git archive df674e61` is identical to the copy the freeze was built from (source tree digest `b5b7ddc4…`, `diff -r` empty) ✓ |
| Contexts rebuild reproducibly | HEAD and DEV, code-defaults and dev-env: 12/12 identical each (only the random untrusted-content fence nonce differs, a security token) ✓ |
| All 24 prompts rebuild identically | code-defaults 24/24, dev-env 24/24 (nonce normalised) ✓ |
| Fresh account per question | harness creates `harness-<life>-<question>` and replays the life for each question; no prompt contains another question's text (0 leaks in 48 records) ✓ |
| Instruction wording equivalent | dev-env: 48/48 fixed instruction lines shared. code-defaults: 45 shared; HEAD's 3 extra lines are the cognitive-model block header and footer, which DEV omits when that block is empty (content, not wording) ✓ |
| Only memory content differs | per-section comparison: preamble identical in all prompts; differences confined to identity, profile, cognitive model, related knowledge and recall ✓ |
| Grader self-test | 12/12 good and bad example pairs separated ✓ |
| Raw output storage | `answers/` absent (nothing to overwrite); the runner creates `answers/<run-id>/answers.raw.jsonl` append-only and refuses an existing directory ✓ |
| Runner refuses without authorisation | exits before any network call without `--confirm "isolated-free-authorized:<provider>"` ✓ |

## 2. Added to the package (originals unchanged)

**`run-answers.v2.mjs`.** The frozen runner stopped only on quota or rate signals; this mission requires stopping on any quota, billing or provider error. v2 adds:
- stopping on any error or empty reply;
- a `--max-calls 24` guard;
- the stated provider recorded in the run metadata.

**Requests, settings and order are byte-identical:** both versions' dry runs produce the same order and request SHA-256s (digest `e79b62f2…`).

**`ADDENDUM-v2.md`.** Execution rules fixed before any answer exists:
- primary run, then secondary;
- a stopped run is never graded as complete, and is re-run in full;
- a truncation rule (more than 2 of 24 `finish_reason: length` → no conclusion; re-run all 24 with one higher cap for both conditions);
- one provider, model and settings set per run;
- grading separate;
- every result reported, regressions included.

Both new files are hashed in `MANIFEST-ADDENDUM.sha256`.

## 3. Calls, tokens and cost

| | Primary (`code-defaults`) | Secondary (`dev-env`) |
|---|---|---|
| answer calls | **24** (12 questions × HEAD / DEV) | 24 |
| input tokens (estimate, characters ÷ 4) | ≈ 35,000 total; mean 1,460, max 1,735 per call | ≈ 36,900; mean 1,540, max 1,860 |
| output tokens (cap) | ≤ 600 per call, ≤ 14,400 total | ≤ 14,400 |
| worst case per run | ≈ 49,000 tokens | ≈ 51,000 tokens |

Grading makes **no** calls: the rubric is deterministic. An optional LLM judge would be a separate, separately authorised run of the same size.

**Fixed settings:**
- temperature 0, top_p 1, max_tokens 600, seed 7;
- system = the recorded production prompt, user = the question;
- one request per prompt, in the frozen interleaved order (`q09:HEAD q09:DEV q04:HEAD …`).

**Cost:** depends on the provider named at authorisation. Each request is under 2,500 tokens, and a run is about 50,000 tokens. This fits comfortably within typical free developer tiers, but whether a tier is genuinely free, and its current limits, must be confirmed on the provider's own pricing and limits page **at authorisation time**. It has not been verified here.

Where the provider supports it, set a spending cap on the dedicated key (for example, a credit limit on an OpenRouter key), or use an account with **no billing method attached**.

**A model with hidden reasoning** (e.g. the gpt-oss family) may spend part of the 600 tokens before answering. The truncation rule (§2) covers that. A non-reasoning instruct model avoids it.

## 4. What remains: one authorisation

**The runner's requirements** (`run-answers.v2.mjs`):
- an **OpenAI-compatible `/chat/completions`** endpoint;
- `Authorization: Bearer <key>`;
- accepts `temperature`, `top_p` and `max_tokens` (`seed` may be ignored).

This covers, among others:
- Groq (`https://api.groq.com/openai/v1`);
- OpenRouter (`https://openrouter.ai/api/v1`);
- Google AI Studio's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`);
- NVIDIA (`https://integrate.api.nvidia.com/v1`).

The key is read **only** from the one environment variable named on the command line, for that process. It is never written to `.env` or anywhere in the repo.

**Not usable**, whatever the provider:
- the existing keys in `.env`: Groq 1–5 and Gemini 1–8 (Lift v4b), Gemini 9–12 (same pool), NVIDIA and OpenRouter (the product's provider keys);
- any other key whose isolation cannot be confirmed.

**The authorisation needed** (one message from the owner):

> I authorise the answer-level evaluation on provider **<name>**, model **<model id>**, with the key in environment variable **<VAR>**. The key was created for this evaluation and is used by nothing else (not Lift v4b, not production). Cost basis: **<free allowance / spending cap of $X on the key>**.

**Then exactly this runs:**

```bash
cd aqua/eval/answer-validation/2026-11-05
sha256sum -c MANIFEST.sha256 && sha256sum -c MANIFEST-ADDENDUM.sha256
(cd ../../../.. && sha256sum -c aqua/eval/answer-validation/2026-11-05/dev-code.sha256)
node run-answers.v2.mjs --prompts prompts.code-defaults.jsonl --out answers/primary-<date> \
  --endpoint <base url> --model <model id> --api-key-env <VAR> \
  --confirm "isolated-free-authorized:<provider>" --max-calls 24
node ../../../scripts/answer-eval-harness.mjs grade --answers answers/primary-<date>/answers.jsonl \
  --contexts contexts.HEAD.code-defaults.json,contexts.DEV.code-defaults.json --json answers/primary-<date>/graded.json
# then the same with prompts.dev-env.jsonl → answers/secondary-<date>
```

Results would then go into this file:
- each question's HEAD and DEV answer, with its checks;
- category pass rates;
- the paired better/worse/same count;
- every truncation and stop;
- the failure origin for every failing answer.

## 5. What is known before any answer (model-free; not answer results)

From `AQUA_ANSWER_INTELLIGENCE_VALIDATION_REPORT.md`, re-verified on the same frozen prompts:
- **The prompt holds what a correct answer needs** for 11/12 questions on DEV and 5/12 on HEAD.
- **HEAD's gaps are contradictions, not absences.** The recall block quotes the user's later words, so a capable model may answer several HEAD questions correctly anyway.
- **Expected differences:** largest on q04 (Atlas dependency: HEAD gives no signal at all) and on q07 and q08 (misfiled company, run-on accountant fact). Uncertain on q01, q03, q11 and q12. None expected on q02, q05, q06, q09 and q10.

None of this is evidence that answers improve. It is what the run will test.

## 6. Existing issues, kept as they are for the comparison (not fixed)

1. **Irrelevant Atlas deadline.** The uncertain Atlas migration deadline rides in "Current state" on every question in that life, including unrelated ones ("What's my manager's name?"). The cognitive block is not question-gated.
2. **Stale promotion goal.** "Get promoted to senior analyst" stays active, and is the top prediction, after the user became a senior analyst at a new employer.
3. **The question as its own open question.** In q05, "open question: What should I focus on at work this month?" is the current question, recorded into working memory before the prompt is built (HEAD truncates it to "at work this month").
4. **Inferred predictions beside confirmed facts.** "Anticipated need: Likely working toward … (p=0.6)" appears in both conditions next to stated facts.

These affect answers in both conditions and stay as they are, so the comparison measures the code as frozen.

## 7. Honesty notes

- Nothing above is an answer-level result.
- If the run, once authorised, shows no improvement, or regressions, that will be reported as such.
- The development questions and rubric were written by the implementer. Only the independent held-out set (`HELDOUT_SPEC.md`) can show generality.
