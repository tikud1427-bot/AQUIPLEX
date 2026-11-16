# Conversation Regression Test Results

All runs: `aqua/scripts/run-tests.mjs` (temporary `AQUA_DATA_DIR`, `DATABASE_URL` and `MONGO_URI` blank, mirror disabled), Node v24.19.0, Windows 11, 2026-11-16. No network, no provider credits: providers are a deterministic fake Groq client injected through the existing `__setClientFactoryForTests` seam. `~/.aquiplex` (the developer's real store) was listed before the baseline and after the last run: contents unchanged.

## 1. End-to-end suite — `aqua/src/routes/tests/conversationRecovery.e2e.test.js`

Real `/chat` and `/chat/stream` routes, real `prepareTurn`, Context Engine V2 + E8 + Retrieval V3 enabled (as in production), real orchestrator, verification/debate agents, task graph, conversation store and turn lock. The fake model is obedient and weak in exactly the ways the incident showed (it obeys an unscoped UNKNOWN block; it can only resolve a pronoun via the operator reference note; the fake verifier rewrites to a clarification when it sees no conversation). Every provider request is recorded and asserted on.

| ID | Setup | Expected | Actual (repaired tree) | Rollback flags off* |
|---|---|---|---|---|
| T01 | pneumonia 3 turns, verification forced on (learned gate, confirmed basis) | turn 1 answers; turn 3 resolves "it", no clarification; reviewer saw history; `verified` | PASS | FAIL |
| T02 | photosynthesis → "Why is it important?" | resolves | PASS | FAIL |
| T03 | MongoDB vs PostgreSQL → "Which one is easier to scale?" | both candidates kept | PASS | FAIL |
| T04 | pneumonia → cloud storage → "What are its advantages?" | cloud storage, never pneumonia | PASS | FAIL |
| T05 | two entities → "Is it better?" | clarify (genuinely ambiguous) | PASS | FAIL |
| T06 | "What is my dog's name?", empty memory | UNKNOWN contract kept, scoped, in operator section | PASS | PASS |
| T07 | 3 general questions, empty personal store | no UNKNOWN block; answered | PASS | FAIL |
| T08 | reviewer forced to clarify a resolved follow-up | answer kept; history = visible answer; verdict stored | PASS | FAIL |
| T09 | ranked recall regime (20 filler messages); earlier conv names the Zephyr owner; "Who runs it?" | literal control: 0 excerpts; resolved follow-up: passage recalled | PASS | FAIL |
| T10 | numbered planning request continuing a chat (graph path) | every node sees the conversation | PASS | PASS (not flag-gated) |
| T11 | same follow-up on `/chat/stream` and `/chat` | same resolution, same answer | PASS | FAIL |
| T12 | entry removed from the in-process Map after the disk flush | recovered from disk; follow-up answered | PASS | FAIL |
| T13 | unknown server-issued UUID; custom id | 404 on both endpoints, nothing created; custom id created | PASS | FAIL |
| T14 | user B uses user A's conversation id; B's own follow-up | 404; nothing appended; B's request carries no A text | PASS | FAIL** |
| T15 | two overlapping turns | order user1,asst1,user2,asst2; second saw first | PASS | FAIL |
| T15b | second turn while first still running past the wait | 409 retryable; first completes | PASS | FAIL |
| T16 | ~36k-char message then follow-up | recent exchange kept, explicit truncation, within budget | PASS | PASS (not flag-gated) |
| T17 | "I have pneumonia." then "Is pneumonia curable?" | not stored; second is general | PASS | PASS (not flag-gated) |
| T18 | item impersonating policy + injection text | stays in the fenced data, after the policy section | PASS | PASS (not flag-gated) |
| T19 | persistence state | LOCAL_ONLY without mirror; DEGRADED with unconnected mirror; DURABLE only for durable commits | PASS | PASS (not flag-gated) |
| T20 | reviewer throws | draft kept, status failed | PASS | FAIL*** |
| T21 | "That one — is it curable?" after pneumonia | no CIE clarification directive; answered | PASS | FAIL |

**Repaired tree: 22/22 pass. Rollback mode: 6 pass, 16 fail** — the suite detects the defects, and the rollback switches really restore the old behaviour.
\* `AQUA_CONVERSATION_CONTEXT=off AQUA_E8_PERSONAL_SCOPE=off AQUA_STRICT_CONVERSATION_IDS=off AQUA_CONVERSATION_TURN_LOCK=off AQUA_LEDGER_REVISION_BASIS=legacy`. This approximates, but is not identical to, the pre-repair code: reviewer history, the withdrawal guard, the window, health and the trust boundary are not flag-gated.
\** T14 fails in rollback mode on its `refStatus` assertion (no resolver), not on isolation.
\*** T20 fails in rollback mode because without the resolver the weak fake drafter itself asks what "it" means; the reviewer-failure path itself is covered by unit tests either way.

The 20 scenarios required by the brief are all exercised (T15b and T21 are additional). Scenario 12 tests recovery from the JSON file; recovery from the Mongo mirror or Postgres partitions is **not** tested (needs those services).

## 2. New unit/integration suites

| File | Tests | Result |
|---|---|---|
| `core/tests/conversationContext.test.js` | 16 | 16 pass |
| `core/tests/contextWindow.test.js` | 6 | 6 pass |
| `core/tests/conversationTurnLock.test.js` | 4 | 4 pass |
| `memory/tests/healthSensitivity.test.js` | 4 | 4 pass |
| `brain/tests/e8PersonalScope.test.js` | 8 | 8 pass |
| `intelligence/tests/conversationAwareReview.test.js` | 9 | 9 pass |
| `cognition/tests/conversationResolvedDeixis.test.js` | 4 | 4 pass |

Defects found BY these tests during the work and fixed before completion: "Can I use it?" read as a personal statement; "When is it due?" read as naming its own subject; one clause yielding two "entities"; window builder dropping a truncated answer when no budget remained for its question; "Tell me about pneumonia" classified as a health disclosure ("me"); "curable" alone treated as a medical subject. Two test-stub bugs were also fixed (stub matched the revision prompt as a panel; a fence anchor matched the instruction hierarchy).

## 3. Existing suites — before / after

| Directory | Baseline (unmodified) | After repair | Notes |
|---|---|---|---|
| src/routes | 363 / 363 | 385 / 385 | +22 e2e |
| src/intelligence | 129 / 129 | 140 / 140 | +9 new; 2 ledger tests updated to the new contract (+2 new) |
| src/brain | 1426 pass, 8 skip / 1434 | 1434 pass, 8 skip / 1442 | +8 new |
| src/memory | 519 pass / 520 (1 todo) | 523 pass / 524 (1 todo) | +4 new |
| src/core | 941 pass, **1 fail**, 9 skip / 951 | 972 pass, **1 fail**, 9 skip / 982 | same pre-existing hygiene failure (owner's untracked `eval/out/*.before-profile.*.json`); 3 flag tests updated for the 8 new flags (+4 probes) |
| src/cognition | 55 / 55 | 59 / 59 | +4 new |
| src/orchestrator | 42 / 42 | 42 / 42 | |
| eval | 589 pass, 11 skip / 600 | 589 pass, 11 skip / 600 | parity test updated: chat queries `retrievalQuery` (= the question for single-turn evals) |
| providers, pic, mind, understanding, identity, search, upload, files, embeddings, project, artifacts, account, reasoning | all pass (baseline) | all pass (post-change full battery) | unchanged counts |

Existing tests changed (each because it pinned behaviour this repair deliberately changes — never to hide a regression): `intelligence/learningLedger.test.js` (gate now needs confirmed revisions), `core/tests/flagRegistry.test.js` (census +5 gates +3 settings, default-on list, boot line), `core/tests/flagReadSiteParity.test.js` (+5 read-site probes), `eval/tests/readPathParity.test.js` (query variable).

Skipped tests are the pre-existing skips (live-DB suites without `AQUA_TEST_DATABASE_URL`, Windows-only skips); none were added.

## 4. Not tested

- Real model behaviour (no provider calls by design). Whether real Groq/Gemini models follow the reference note and the reviewer rule as the fake does → **production validation needed**.
- `unavailable` (503) conversation branch end-to-end; multi-instance behaviour; Mongo-mirror or Postgres-partition recovery; a deletion racing an in-flight turn; the frontend's handling of the new 404/409/503.
