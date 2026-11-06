# Recall privacy v1 (frozen 2026-11-06, before implementation)

This is an independent offline test of retrieval privacy in episodic recall, written and frozen before the code it grades. It covers:
- the semantic forget fix;
- sentence-level protection for sensitive (health/mood) sentences;
- per-sentence embedding;
- filtering of the current question.

It doesn't use the semantic-recall v1/v2 evaluation data.

## Run (offline)
```
node eval/recall-privacy-v1/grade.mjs [--json <file>] [--verbose]
```
- **No real provider:** the "embedding provider" is a fake transport on the dedicated embedder, with a placeholder key.
- **Network blocked:** fetch, http(s) and sockets are tripwires.
- **Every text "sent" is recorded,** so "never sent" is checked exactly.
- **Freeze check:** the grader refuses to run if `dataset.v1.json`, `grade.mjs` or this README differ from `MANIFEST.sha256`.

## Coverage
| Group | Cases | Checks |
|---|---|---|
| keyword | K1–K6 | a withheld sentence ranks nothing and pulls in no sibling; opt-in plus same topic still works; mixed passages keep their eligible sentences; masked health sentences stay withheld; a cross-sentence match withholds nothing |
| follow-up | F1–F2 | a withheld parent or candidate sentence makes no follow-up link (V2 off and on) |
| temporal | T1–T2 | historical and current statements are kept beside withheld ones, including a mixed parent (V2 off and on) |
| cache | C1 | changes to the policy and to the forget list take effect on the next turn |
| indexing | H1–H2 | per-sentence embedding: eligible sentences are indexed, sensitive ones are never sent, even when opted in |
| forgetting | H3–H5 | forgotten before or after indexing; a stale or masked vector is never used and is replaced |
| question | Q1–Q3 | a partly sensitive question embeds only its eligible part; a wholly sensitive one isn't embedded; the early query vector follows the same rule |
| fallback | U1 | when embedding fails (500 or timeout), the keyword result, with the same privacy |
| deletion | D1 | owner isolation, `deleteMind` removes the vectors, a deleted conversation is gone |

Stats contract: `forgottenSentences` and `withheldSentences` are counted separately.
