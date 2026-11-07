# C9 embedding fixture

**Status: not recorded.** The fixture file `c9-semantic-relevance.embeddings.v1.json` doesn't exist yet. The live
run needs separate approval. Until the file exists, the vector tests in `eval/tests/c9SemanticFixture.test.js` are
reported as skipped with the reason "C9 embedding fixture UNAVAILABLE". Nothing generates, simulates or
substitutes vectors.

| | |
|---|---|
| Model | `gemini-embedding-001` (Gemini API `embedContent`), pinned in `scripts/record-c9-embeddings.mjs`. The recorder refuses if production's `EMBED_MODEL` differs or if `AQUA_EMBED_MODEL` overrides it. |
| Dimensions | 768 (`outputDimensionality`), the same as production `EMBED_DIM` |
| Task type | none, the same call production makes (`src/embeddings/dedicatedEmbedder.js`) |
| Credential | `AQUA_EMBEDDING_API_KEY` only: no fallback, refused if equal to any GEMINI/GOOGLE variable, never printed or stored |
| Dataset | `eval/datasets/c9-semantic-relevance.dev.v1.json`, sha256 `e261520aae93a7e7875ac11d4003491a1e534a05e776207abba22b43a7d0bf42` (also in `c9-semantic-relevance.dev.v1.sha256`) |
| Texts | 1,048 entries (758 statements, 290 queries), 928 unique texts, 10 fictional owners |
| Planned requests | 15 (batches of ≤ 64), hard cap 15, stop at the first failure, no retry |
| Recording date | set by the live run (`recordedAt` in the fixture) |

The fixture records the following, written by the recorder:
- model, dimensions and task type;
- `recordedAt`;
- the dataset id, path and sha256;
- the recorder's own sha256;
- the `@google/genai` version;
- each request's count, timing and status;
- `vectorsSha256`, a digest over all vectors;
- the vectors themselves, keyed by the sha256 of each text.

`eval/fixtures/c9EmbeddingFixture.mjs` refuses a fixture whose model, dimension, dataset hash or digest doesn't match.

## Reproduce

```
node scripts/build-c9-semantic-dataset.mjs --check     # the dataset is what the builder writes
node scripts/record-c9-embeddings.mjs                   # dry run: zero network, writes nothing
node scripts/record-c9-embeddings.mjs --live            # ONLY with approval and the dedicated key in the shell
```

A live run writes `c9-semantic-relevance.embeddings.v1.attempt.json`, which holds no vectors and no credential,
before its first request. While that file exists, any later live run refuses. A failed run is never repeated
automatically, and an existing fixture is never overwritten.

The text is synthetic. All people, companies, projects, places and events are invented. Duolingo is named as a
product because C2 is about recognising it. Before using the key, check that its Google project has no billing
account linked. Free-tier content may be used by Google to improve its products, which is acceptable for this
synthetic text only.
