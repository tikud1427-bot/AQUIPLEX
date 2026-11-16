# AQUIPLEX — Existing-Credential Evaluation Readiness

**Date:** 2026-11-11

**Repository:** `main` @ `839ea0d1`. Working tree: 149 uncommitted paths at the start, all preserved. This task added one test file and three documents.

**Not done:**
- no commit, push or deployment;
- **no live API request**;
- no change to production provider rotation or request behaviour;
- no credential value printed, copied or written. The real `.env` was read **in memory only**, for an offline check printing names and reasons.

## Verdict: integrated, but not runnable yet

| Item | State |
|---|---|
| Numbered pools supported in the evaluation manager | ✅ |
| Unnumbered keys | Excluded; never a fallback ✅ |
| Gemini `GEMINI_KEY_1..12` | **All excluded** (`AQ.`-prefixed, kind undetermined) → **0 usable Gemini credentials** |
| Groq `GROQ_API_KEY_1..5` | 5 usable, as **one** unverified quota group |
| Free-tier verification | **Missing.** The run is refused until the Groq billing check is recorded (offline check of the real configuration: refused for exactly this reason). |
| Tests | 19/19 new; 123/123 evaluation; 199/199 production providers |

## Decisions needed from the founder before any live request

1. **The judge model.** With these pools, the judge cannot be Gemini. Choose a **different Groq model** (preferably a different model family from `openai/gpt-oss-120b`; confirm availability in the Groq console). Note that it shares the same Groq quota group.
2. **Groq billing and grouping (console):**
   - confirm the organisation(s) that own `GROQ_API_KEY_1..5`;
   - confirm the **Free plan with no payment method**;
   - record `by` and `at` in the config.

   Without separate verified organisations, the five keys stay **one** quota group.
3. **Production quota protection:** set `requestBudget.groq`. The example uses **20 requests per run**. The one-case smoke test needs 4 (2 answers + 2 judgements). Production traffic uses the same keys and daily quota.
4. **Record the founder decision** in the config (`founderDecision { by, at, statement }`).
5. **The `AQ.` values:** leave excluded, or establish their kind in Google's console first. They are refused by the gate either way, unless that rule is deliberately changed.

## How the first live smoke test would run (after approval; not run)

1. Copy `C:\Users\dell\aquiplex-eval-example\config.existing-pools.example.json` to `C:\Users\dell\aquiplex-eval\config.json` and fill it in (judge model, organisation, billing evidence, founder decision).
2. Run:
   ```
   cd aqua
   set AQUA_ANSWER_EVAL_APPROVED=yes
   set AQUA_EVAL_LIVE_APPROVED=yes
   node scripts/answer-eval.mjs --execute --set acib.v2.dev --limit 1 --regime short --arms A,H --label live-smoke-1 --provider-config C:\Users\dell\aquiplex-eval\config.json
   ```
   No `--credentials-env`: credentials come only from the numbered variables of the repository `.env`.
3. **Stop on:**
   - `stopped-billing`;
   - an empty completion;
   - an unclassified error;
   - the request budget being reached;
   - any host other than `api.groq.com`.

**Documents:**
- [AQUA_EXISTING_KEY_POOL_INTEGRATION.md](AQUA_EXISTING_KEY_POOL_INTEGRATION.md)
- [AQUA_EXISTING_KEY_POOL_TESTS.md](AQUA_EXISTING_KEY_POOL_TESTS.md)

**Stopped for founder review.**
