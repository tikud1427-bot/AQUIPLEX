# Semantic recall: independent live validation v2 (frozen 2026-11-05, not run)

This tests the **current** semantic recall ranking on new data, untuned. That means `rankHybrid` and `SEMANTIC_DEFAULTS` exactly as fixed after the v1 live run, together with the unchanged selection, follow-ups and keyword path. The data is a new synthetic set with real `gemini-embedding-001` vectors.
- **Isolation:** the dedicated key only.
- **Production:** it does **not** enable `AQUA_SEMANTIC_RECALL`.

## Independence and freeze
- **Independent data:** three new fictional users (`mara`, `dev`, `ines`) across 7 conversations, with 35 passages and 19 questions. No v1 sentence, question or name is reused, and the runner refuses if one is.
- **Written in advance:** expected relevant passages, exclusions, the current statement and the "favoured" retrieval were all set before any embedding of these sentences existed.
- **`MANIFEST.sha256`** freezes the dataset, grading and criteria (`grade-v2.mjs`), runner, oracle and this README.
- **`CODE.sha256`** freezes the production ranking and embedding code being tested. The runner refuses a live run if either changed, so nothing can be tuned on this set before or after the run without it showing.

## Coverage (19 questions)

| Kind | Questions |
|---|---|
| paraphrase / different terminology | A1 (burn rate ↔ "money each month"), B4 ("promoted" ↔ "head of department"), B8 (greyhound ↔ dog), C2 (food bank ↔ "help out at weekends") |
| goals changing / achieved | A2 (hire head of sales → Theo accepted), B2 (training for 10K → finished → date corrected), C1 (learn to sail → certificate) |
| historical vs current | B1 (chemistry → also physics), A1 ($80k → $95k) |
| abandoned projects | A3 (Inkwell app shelved), B3 (textbook on hold) |
| contradictory / corrected | A4 (might move to Rotterdam → staying in Utrecht), B2 (May → April) |
| uncertain statements | A4 (a8 "might… nothing is decided"), B5 ("Maybe… not sure yet") |
| multiple memories across conversations | A6 (a1 in January + a9 in March), A2, A3, A4, B1, B2, B3, C1 |
| keyword traps (exclusions) | A1 (spending *notebook*), A2 (sales *tax*), A8 (sales *team*), B2 (sister *runs* a bakery), B6 (the race passages), B1/B4 (parent-teacher evening), B3 (old maps) |
| unrelated | A7, B7, C3 (nothing may be quoted) |
| expected winner | keyword: A5 (invoice QB-2291), B6 ("Who runs the bakery?"); semantic: A1, A4, A6, B1–B4, B8, C2; both: A2, A3, A8, B5, C1 |
| small pool (< 8 vectors, absolute-scale fallback) | user `ines`: C1, C2, C3 |

## Frozen success criteria (`grade-v2.mjs` → `CRITERIA`)

| # | Criterion | Threshold |
|---|---|---|
| C1 | relevant passages quoted / all relevant | ≥ 0.90 |
| C2 | excluded passages quoted | 0 |
| C3 | share of quoted passages that are neither relevant nor excluded | ≤ 0.20 |
| C4 | unrelated questions (A7, B7, C3) quote nothing | all |
| C5 | right memory ranked first, answerable questions | ≥ 0.80 |
| C6 | questions with an old and a current statement: all relevant quoted | ≥ 0.80 |
| C7 | semantic-favoured questions: all relevant quoted | ≥ 0.80 |
| C8 | keyword-favoured questions: all relevant quoted | 1.0 |
| C9 | questions where keyword-only quotes a relevant passage that hybrid misses | 0 |
| C10 | small-pool user: pool "small", C1 and C2 fully quoted, C3 nothing | all |
| C11 | simulated 500 / 429 / 401 / timeout → keyword result | 4 / 4 |

**Informational, not gated:**
- **Single-call latency.** It is now hidden behind the early query vector, and the measurement is from the owner's machine, not Render.
- **MRR** for keyword, semantic and hybrid.
- **Current statement ranked first.** Quotes are shown in date order anyway.

**Grading:** questions are graded on what `selectRecall` would actually quote in ranked mode, for each user's own passages.

## Risks stated before the run (from the offline self-checks)
1. **Unrelated questions depend only on the absolute floor (0.58).** The per-question band always admits a question's own best passages. With v1's real vectors, the unrelated question topped out at 0.547.
2. **Follow-ups are keyword-based and unchanged.** A trap that shares a query word *and* contains a change word ("The sales tax rules … **changed**") can be admitted as a follow-up even when the ranking demotes it (A2/a13). This affects C2.

## Plan: 7 requests (hard cap 9)

| # | Request |
|---|---|
| 1 | all 35 passages, production path (`dedicatedEmbedder`, model and dimension as in production) |
| 2 | all 19 questions |
| 3–7 | five single questions, cache cleared (latency, informational) |

About 54 short texts plus 5 repeats, roughly 700 input tokens in total. The run stops at the first provider error. Fallback is tested with simulated failures and no requests.

## Live-mode guards
A live run refuses, before any request, if:
- `--unfrozen-ok` is present (it's accepted for the offline modes only);
- the package or the production code changed since the freeze;
- `AQUA_EMBEDDING_API_KEY` is missing, blank, looks like a placeholder (fewer than 30 characters, any character outside `A–Z a–z 0–9 . _ -`, or fewer than 12 distinct characters), or equals any `GEMINI…` / `Gemini…` variable in the session. The check does not assume a Google key format: both `AIza…` and `AQ.…` keys are accepted, and shape is never treated as proof of validity or isolation;
- `--confirm "isolated-embedding-key:<label>"` is missing;
- `--out` is missing or already exists.

The placeholder and `--unfrozen-ok` guards were added after a safeguard probe on 2026-11-05. That probe used a placeholder value that passed every other guard, so one request (35 synthetic passages) was sent and rejected by Google with `API_KEY_INVALID`. Its record is kept outside this package.

The first version of the placeholder guard (2026-11-05) accepted only `AIza` plus 35 characters, which wrongly refused the dedicated project's genuine Google AI Studio key (`AQ.…`, 53 characters). It was replaced the same day, before any live v2 run, with the format-independent check above. Only this runner and this README changed; the dataset, grading, criteria, oracle and `CODE.sha256` did not.

## Offline modes (no key, nothing sent)
- **`node run-live-v2.mjs --dry-run`**: plumbing only.
- **`node run-live-v2.mjs --oracle`**: harness self-check with crude concept vectors. It passes C1 and C3–C11. C2 fails on A1/a14, an oracle artefact, and on A2/a13, which is risk 2.

## Live run (after approval, in the owner's own PowerShell)
```powershell
cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua\eval\semantic-recall-live-v2
$env:AQUA_EMBEDDING_API_KEY = "<key from the dedicated evaluation project>"
node run-live-v2.mjs --confirm "isolated-embedding-key:<dedicated project label>" --out runs/live-v2-2026-11-05
Remove-Item Env:AQUA_EMBEDDING_API_KEY
```
