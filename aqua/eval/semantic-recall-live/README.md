# Semantic recall: controlled live validation (prepared 2026-11-05, not run)

This tests real `gemini-embedding-001` vectors on **synthetic, fictional sentences** (`dataset.v1.json`: 24 passages, 10 queries).
- **Purpose:** check embedding quality and calibrate the threshold before any decision on production activation.
- **Production:** it does **not** enable `AQUA_SEMANTIC_RECALL`. It never touches production data or Render.

## Credential (required; otherwise nothing is sent)
- **Key:** a Gemini API key created in a **new Google project used for nothing else**.
- **Why a new project:** Gemini rate limits are **per project, not per key**. A key in the project that holds the shared `GEMINI_KEY_*` keys would share quota with chat and Lift v4b.
- **Where it lives:** only in the owner's own shell, as `AQUA_EMBEDDING_API_KEY`. Never in `.env` or the repo.
- **Free tier:** content sent on the free tier is used by Google to improve its products. That's acceptable here (synthetic text), but it is a decision point for real user messages.

## Plan: 9 requests (hard cap 20)

| # | Request | Inputs |
|---|---|---|
| 1 | passages, production config (model, 768 dims, no task type), through `dedicatedEmbedder` | 24 |
| 2 | queries, production config | 10 |
| 3 | passages, `taskType: RETRIEVAL_DOCUMENT` (comparison only) | 24 |
| 4 | queries, `taskType: RETRIEVAL_QUERY` (comparison only) | 10 |
| 5–9 | one query each, cache cleared (single-call latency) | 1 each |

About 73 short texts in total, roughly 1,000 input tokens. The run stops at the first provider error. Fallback (500, 429, 401, timeout) is tested with simulated failures and **no requests**.

## Recorded
For each request:
- latency;
- the response's usage metadata, if the API returns any (the docs don't say it does).

For each query:
- cosine against every passage;
- keyword, semantic and hybrid rankings, with hit@1 and MRR;
- the selection the prompt would actually get.

Across the set:
- relevant vs unrelated cosine distributions, and a threshold sweep (0.40–0.90);
- whether the current statement ranks above its historical one, and whether both are quoted;
- keyword traps.

## Success criteria (fixed before any data)
1. **Paraphrase:** Q1 and Q2 have a relevant passage in hybrid top 3, where keyword-only has none.
2. **No false memory:** Q8 (unrelated) has no passage at or above the threshold.
3. **Threshold:** the best-F1 threshold is within ±0.05 of the current 0.62. Otherwise recalibrate, which is a code change, before activation.
4. **History:** in Q3–Q7 and Q10, both statements are quoted, chronologically. The current one ranks first in at least 4 of 6.
5. **Keyword trap:** in Q7 and Q10, hybrid doesn't rank the trap above the relevant passages.
6. **No loss:** hybrid MRR is at least keyword MRR, and no query loses a relevant top-3 passage that keyword had.
7. **Latency:** single-call p50 under 500 ms and max under 1,500 ms (the read-path timeout).
8. **Fallback:** all 4 simulated failures give the keyword result.

The task-type comparison (#3–4) is informative only: the production code doesn't send a task type. Ten queries is diagnostic, not proof of answer quality.

## Run (after approval, in the owner's shell)
```powershell
cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua\eval\semantic-recall-live
$env:AQUA_EMBEDDING_API_KEY = "<key from the new project>"
node run-live.mjs --confirm "isolated-embedding-key:<new project label>" --out runs/live-2026-11-05
Remove-Item Env:AQUA_EMBEDDING_API_KEY
```

The runner refuses if:
- the key is missing, or equals any `GEMINI*` variable in the session;
- `--confirm` is missing;
- the output folder exists.

It never prints the key. Two offline modes need no key and send nothing:
- **`node run-live.mjs --dry-run`** uses hashed-word vectors with no meaning, and checks the plumbing only.
- **`node run-live.mjs --oracle`** uses crude concept vectors (`oracle-concepts.mjs`). It is a harness self-check that shows the harness can detect a successful semantic retrieval. Its cosines and threshold say nothing about Gemini.

**Diagnostics** (added 2026-11-05, harness only):
- Each top hybrid result is broken down into weighted keyword, semantic and recency parts, using the production weights from `SEMANTIC_DEFAULTS`.
- A best threshold on either edge of the sweep is flagged as "not a calibration".

The dataset, the criteria above and the 9-request plan are unchanged.
