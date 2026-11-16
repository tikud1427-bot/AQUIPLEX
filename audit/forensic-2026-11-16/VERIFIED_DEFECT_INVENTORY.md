# Verified Defect Inventory

Severity: **S0** = wrong answers on common traffic · **S1** = wrong answers or data loss under common production conditions · **S2** = correctness, privacy or consistency gap with narrower trigger · **S3** = low impact or hygiene.
Evidence levels as defined in SYSTEM_ARCHITECTURE_MAP.md. Line numbers refer to the working tree at audit time.

| ID | Sev | Title | Evidence |
|---|---|---|---|
| D-01 | S0 | Context Engine declares the topic of general questions "unknown" | REPRODUCED |
| D-02 | S0 | Verification/debate reviewers have no conversation history | SOURCE-CONFIRMED |
| D-03 | S1 | No follow-up/pronoun resolution in any retrieval lane | SOURCE-CONFIRMED |
| D-04 | S1 | Task-graph runtime generates without conversation history | SOURCE-CONFIRMED |
| D-05 | S1 | Global, self-reinforcing learned verification gate | SOURCE-CONFIRMED + REPRODUCED gate flip |
| D-06 | S1 | Reviewer replacements persisted as conversation history | SOURCE-CONFIRMED |
| D-07 | S1 | Conversation Map miss silently recreates an empty conversation | SOURCE-CONFIRMED |
| D-08 | S2 | Context window drops all older turns behind one oversized message | SOURCE-CONFIRMED |
| D-09 | S1 (ops) | PostgreSQL configured at localhost:5432 but unreachable; silent degraded mode | Production log + CONFIG-INDICATED + SOURCE-CONFIRMED |
| D-10 | S2 | Health sensitivity misses common conditions ("I have pneumonia.") | REPRODUCED |
| D-11 | S2 | Medical tag misses disease/treatment questions | REPRODUCED |
| D-12 | S2 | No turn-level regression test for multi-turn context | SOURCE-CONFIRMED (absence) |
| D-13 | S3 | Auto-created conversation lacks userId → 404 for its owner | SOURCE-CONFIRMED |
| D-14 | S2 | Overlapping turns: user message persisted at turn end | SOURCE-CONFIRMED |
| D-15 | S2 | Mongo mirror unverified → acknowledged writes not durable on Render | Production log + SOURCE-CONFIRMED |
| D-16 | S3 | "[PIC] Knowledge injected" logged for evidence-free blocks | SOURCE-CONFIRMED |
| D-17 | S2 | Engine policy text shares the UNTRUSTED fence with user data | SOURCE-CONFIRMED |
| OPS-1 | S3 | Rejected Groq credential in configuration | Production log |

---

### D-01: Context Engine declares the topic of general questions "unknown"  · S0

- **Files / components:** `aqua/src/brain/contextEngine/queryPlan.js` (`TEMPLATES.conversation`, `normalizeTaskType`, `matchCandidateToSlot`, `assessSufficiency`); `aqua/src/brain/contextEngine/e8Pipeline.js` (`runBoundedRetrievalRoundsAsync`); `aqua/src/brain/contextEngine/assembler.js` (`contextEpistemicState`, `headerLines` 539-554, `renderBlock` 556-557); `aqua/src/brain/contextEngine/index.js:114-118`; consumer `aqua/src/routes/chat.js:746-782, 917, 940`.
- **Evidence:** reproduction script in CONVERSATION_FAILURE_INVESTIGATION.md §4. All three incident messages produce `sufficiency {"outcome":"unknown","missing":["topic"]}` and the block "EVIDENCE STATUS: UNKNOWN … Required slots still unknown: topic. Do not infer or fabricate them." Production runs this path (the `world core unavailable` log line is reachable only through `assembleContextAsync`).
- **User-visible consequence:** "I don't have any information about X in the provided context" for common-knowledge questions; clarification requests on follow-ups whose referent is in the conversation.
- **Root cause:** confirmed in code. The personal-world sufficiency contract (required `topic` slot filled only by the user's own knowledge items) is applied to every `simple_qa`/`conversation` question, and the UNKNOWN header renders even with zero selected items. Its role in *this* incident's visible text is strongly supported but needs runtime confirmation (CONVERSATION_FAILURE_INVESTIGATION.md §6 items 2, 8).
- **Dependencies:** D-03 (an unresolved "it" can never fill the slot); D-09 (DB down removes canonical candidates, making empty floors more likely).
- **Recommended repair:** Render the E8 sufficiency header only when the question is about the user's world (personal anchor detected by `analyseQuestion`, first/second-person possessives, or a matched owner entity) or the template is not `conversation`. Make `topic` non-required in the `conversation` template. Never render an unscoped UNKNOWN header with zero items: fall back to the user-scoped footer or nothing. Word any remaining header as "about the user" ("Nothing the user has told Aqua covers this; answer from general knowledge and the conversation").
- **Regression tests:** (1) `buildQueryPlan` + `assembleContext` with an empty floor for "Is pneumonia curable?" → no `EVIDENCE STATUS: UNKNOWN`, no `Required slots still unknown`. (2) Existing E8 decision tests still pass. (3) Turn-level test from D-12.

### D-02: Verification/debate reviewers have no conversation history  · S0

- **Files / components:** `aqua/src/intelligence/verificationAgent.js:138-201` (`runVerification`, `critiqueMessages` 186-189, `buildCritiquePrompt`); `aqua/src/intelligence/debateAgent.js:221, 279`; caller `aqua/src/routes/chat.js:997-1029`.
- **Evidence:** the critique input is built solely from `evidenceBlock`, `userMessage` and the draft. No parameter carries history. `simple_qa` rubric = Logical inconsistencies / Weak assumptions / Hallucination risk (REPRODUCED via `getFocusRisks`). Any usable non-sentinel output replaces the answer (`verificationAgent.js:270-271`).
- **User-visible consequence:** correct follow-up answers replaced with clarification requests or hedges, sometimes after the correct answer already streamed (`replace` event). Production logged repeated `revised_unconfirmed`.
- **Root cause:** confirmed design omission. That it produced turn 3's visible text is HYPOTHESIS (needs the turn's verification record).
- **Dependencies:** D-05 and I-7 (when reviewers run); D-06 (persistence of the rewrite).
- **Recommended repair:** pass `prep.messages` (the same window) to `runVerification`/`debate`, render it as "Conversation so far" in the critique input, and add to the critique prompt: "Referents resolved from the conversation are grounded; a draft is not a hallucination for using them." Also add a guard: a revision that turns an answer into a clarifying question, when the draft answered, is discarded (`suppressedClarification`, not `revised`).
- **Regression tests:** an injected `generate` stub records the critique messages: assert they contain the prior turns. A stub reviewer that returns "Could you specify what 'it' refers to?" for an answered draft → `revised:false`, draft kept.

### D-03: No follow-up/pronoun resolution in any retrieval lane  · S1

- **Files / components:** `aqua/src/routes/chat.js:451-465, 602-615, 744-764, 845-852` (all lanes get `userMessage`); `aqua/src/brain/contextEngine/conversationFocus.js` (entity-UUID carry-over only); `aqua/src/brain/index.js:1162-1166`.
- **Evidence:** traced call sites. No module rewrites or augments the retrieval query from history (searched for rewrite/standalone/condense/resolve-pronoun patterns; the only deictic handling is `conversationFocus`).
- **User-visible consequence:** follow-ups ("is it curable?", "what about the second one?", "when is that due?") retrieve nothing relevant from memory or files, then trigger D-01's UNKNOWN state.
- **Root cause:** confirmed: missing capability.
- **Dependencies:** none. Unblocks the D-01 fix for personal follow-ups ("when is *it* due?" about the user's project).
- **Recommended repair:** a deterministic `retrievalQueryFor(userMessage, window)`: when the message is deictic or elliptical (short, pronoun-led, no content nouns), append the content terms of the previous user turn (and optionally the assistant turn's title or noun phrase) for **retrieval only**, never for display. Keep `conversationFocus` for entity IDs. Optional later: an LLM standalone-question rewrite behind a flag, with cost measured.
- **Regression tests:** unit: `retrievalQueryFor('Is it curable?', [user:'Tell me about pneumonia.', …])` includes "pneumonia". Turn-level: a personal follow-up retrieves the fact named in the previous turn.

### D-04: Task-graph runtime generates without conversation history  · S1

- **Files / components:** `aqua/src/routes/chat.js:1448-1466`; `aqua/src/orchestrator/graphRuntime.js` (`runTaskGraph` 118-…).
- **Evidence:** `runTaskGraph` is called with `context: { memory, evidence, search }`. `graphRuntime.js` has no reference to history or messages.
- **User-visible consequence:** on `POST /chat`, agent-task follow-ups lose the conversation. `/chat/stream` (the app's path) never uses the graph, so the same message behaves differently between endpoints.
- **Root cause:** confirmed omission.
- **Dependencies:** none.
- **Recommended repair:** pass `prep.messages` into `runTaskGraph` and through to each specialist's `generate` call (or to the planner plus synthesizer at minimum). Align stream and non-stream eligibility.
- **Regression tests:** graph runtime with a stub `generate` asserts that the history messages reach the synthesizer call.

### D-05: Global, self-reinforcing learned verification gate  · S1

- **Files / components:** `aqua/src/intelligence/learningLedger.js:79, 89, 171-223` (`recordOutcome`, `getTaskStats`); `aqua/src/orchestrator/verificationStrategy.js` (`shouldVerify`); `aqua/src/routes/chat.js:543`.
- **Evidence:** REPRODUCED: `orchestrate` with `history = { sampleSize: 20, revisionRate: 0.4 }` flips all three incident messages to `verify: true` ("learned: task type historically revision-prone"). The ledger is keyed by task type only, aggregated across all users, and persisted and mirrored.
- **User-visible consequence:** once tripped, every `simple_qa` turn for every user gets a (history-blind, D-02) reviewer. That adds latency and wrong replacements, and the replacements keep the rate above threshold.
- **Root cause:** confirmed design. Production ledger state: HYPOTHESIS (needs `.aqua-ledger.json → byTask.simple_qa`).
- **Dependencies:** D-02 (the source of spurious revisions).
- **Recommended repair:** after fixing D-02, bump `LEDGER_VERSION` to reset poisoned aggregates (the mechanism exists). Count only revisions that were later confirmed (`passed` after revision), or that changed facts, not clarification-shaped rewrites. Add a decay and a cap, so the learned gate can enable at most a sampled fraction of turns.
- **Regression tests:** recording N clarification-shaped revisions does not raise `revisionRate`. Ledger reset on version bump (existing pattern).

### D-06: Reviewer replacements persisted as conversation history  · S1

- **Files / components:** `aqua/src/routes/chat.js:1492-1494, 1529-1530, 1841-1844, 1883-1884`.
- **Evidence:** `finalAnswer = verification.finalAnswer` when revised. `addMessage(conversationId, 'assistant', finalAnswer, …)`.
- **User-visible consequence:** a wrong rewrite (e.g. turn 1's "I don't have any information…") becomes what the model believes it said, and the next turns build on it.
- **Root cause:** confirmed. Persisting the delivered answer is correct in principle. The defect is that unconfirmed revisions are indistinguishable from verified text.
- **Dependencies:** D-02, D-05.
- **Recommended repair:** store the verification status with the assistant message (as with `contextRefs`), and exclude `revised_unconfirmed` clarification-shaped replacements from the history window, or keep the draft in history with a note. Fixing D-02 removes most occurrences.
- **Regression tests:** an assistant message stored with `verification:'revised_unconfirmed'` carries the status. The window policy is applied as designed.

### D-07: Conversation Map miss silently recreates an empty conversation  · S1

- **Files / components:** `aqua/src/memory/conversationStore.js:150-162` (`getOrCreateConversation`), `191-198` (`getConversation`); `aqua/router.js:249-256` (owner load failure); `aqua/src/routes/chat.js:1355-1363, 1607-1616`.
- **Evidence:** a miss → `store.set(finalId, { messages: [] … })`, `isNew: true`, no error. A per-process Map, read from disk/Mongo only at boot.
- **User-visible consequence:** after a restart, deploy, multi-instance routing or (with history partitions on) a DB outage, a follow-up in an existing conversation is answered with no history. The UI still shows the old messages.
- **Root cause:** confirmed design. Occurrence in this incident: HYPOTHESIS (needs `CONVERSATION_CREATED` vs `REUSED` for turn 3).
- **Dependencies:** D-15, D-09.
- **Recommended repair:** on a miss for a client-supplied id, attempt a load (partitions, or a JSON/Mongo re-read for that id). If still missing, return a distinct error (`CONVERSATION_NOT_LOADED`, retryable) or `isNew` plus an explicit client notice. Never silently reuse the id. Enforce single-instance until partitions are authoritative.
- **Regression tests:** a request with an unknown non-null `conversationId` does not produce a silent empty reuse. Partition-on plus DB-down → explicit retryable error.

### D-08: Context window drops all older turns behind one oversized message  · S2

- **Files / components:** `aqua/src/core/tokenManager.js` (`buildContextWindow`); budget `aqua/src/core/contextOptimizer.js computeContextBudget`; `aqua/src/orchestrator/executionProfiles.js:56-62`.
- **Evidence:** the loop `break`s at the first message over budget. REPRODUCED budget 4,000 tokens for `simple_question` turns.
- **User-visible consequence:** after a long pasted text or long answer, the next follow-up has no prior context at all, including the most recent exchange when the newest message alone exceeds the budget.
- **Root cause:** confirmed. Not the cause of this incident (answers capped at 1,024 tokens).
- **Dependencies:** none.
- **Recommended repair:** always include the latest user/assistant pair, truncating an oversized message with a marker rather than dropping everything. Mark omitted older history in the prompt.
- **Regression tests:** history = [short user, 20k-token assistant, …] → window contains a truncated assistant message and the preceding user turn.

### D-09: PostgreSQL configured but unreachable; silent degraded mode  · S1 (operations + design)

- **Files / components:** `.env` `DATABASE_URL` host `localhost:5432` (CONFIG-INDICATED); `aqua/src/core/db/pool.js:172-185`; `aqua/src/brain/index.js:142-149, 1170-1172, 1211-1243, 1258-1267`; `aqua/src/routes/chat.js:597-609`.
- **Evidence:** production log `ECONNREFUSED localhost:5432`, read fallback, World Core unavailable, hydration skipped, canonical write failures. Each matches a fail-open site above.
- **User-visible consequence:** corrections and supersessions are not applied, there is no current-world context, and canonical learning is lost for the outage. Answers do not disclose any of this.
- **Root cause:** operational (no database at the configured address) plus design (degradation not surfaced).
- **Dependencies:** D-01 (degradation makes empty floors likelier); D-07 if history partitions are on.
- **Recommended repair:** operations: provision or point to a reachable Postgres, or unset `DATABASE_URL` deliberately. Design: add a `degraded` field to the payload, plus one prompt line ("the user's long-term memory is temporarily unavailable") distinct from "not known", and replay canonical writes after recovery.
- **Regression tests:** with `isReachable` stubbed false, the prompt contains the degraded notice, not an UNKNOWN header, and the payload has `degraded: true`.

### D-10: Health sensitivity misses common conditions  · S2

- **Files / components:** `aqua/src/memory/sensitivity.js:55` (`HEALTH_TERMS`), `classifyText`, `redactSensitiveSentences`.
- **Evidence:** REPRODUCED: "I have pneumonia." → `null` (stored); "I was diagnosed with pneumonia." → `health`.
- **User-visible consequence:** plain statements of a medical condition are stored and later injected without the opt-in the privacy setting promises.
- **Root cause:** confirmed: a closed lexicon.
- **Dependencies:** none.
- **Recommended repair:** extend the lexicon with common conditions (or a "have/got/caught + condition-noun" pattern with a condition list). Keep the existing `NOT_SENSITIVE` exclusions.
- **Regression tests:** a table of first-person condition statements → `health`; third-person and general questions per the existing policy.

### D-11: Medical tag misses disease/treatment questions  · S2

- **Files / components:** `aqua/src/orchestrator/multiLabelClassifier.js:50-51`; `aqua/src/orchestrator/verificationStrategy.js` (`shouldVerify` medical rule).
- **Evidence:** REPRODUCED: "Is pneumonia curable?" → `tags: []`.
- **User-visible consequence:** medical questions do not get the intended medical-risk handling. Review happens, or does not, for unrelated reasons.
- **Root cause:** confirmed: keyword list without conditions or "curable/cure/treat".
- **Dependencies:** D-02 must be fixed first, or more verification means more history-blind rewrites.
- **Recommended repair:** extend the medical cue list (conditions, cure/curable/treat/prognosis). Decide the policy explicitly: medical → verification with history (after D-02), and possibly web search.
- **Regression tests:** a cue table → `medical`.

### D-12: No turn-level regression test for multi-turn context  · S2

- **Files / components:** `aqua/src/routes/tests/*`, `aqua/src/brain/tests/e8IntegrationGate.test.js`.
- **Evidence:** E8 tests assert UNKNOWN for decision questions only. No test drives `prepareTurn` across turns and inspects `messages` plus `systemPrompt`.
- **User-visible consequence:** the incident class ships undetected.
- **Root cause:** confirmed: absent test.
- **Dependencies:** a provider stub (the `deps` seams exist in `generateText`).
- **Recommended repair / test:** a fixture conversation (pneumonia sequence plus a personal-project sequence) through `prepareTurn` with an empty owner and a scratch data dir. Assert the turn-3 `messages` contain turns 1–2, the `systemPrompt` has no unscoped UNKNOWN header, and the reviewer input (if it runs) contains history.

### D-13: Auto-created conversation lacks userId → 404 for its owner  · S3

- **Files / components:** `aqua/src/memory/conversationStore.js:204-209` (`addMessage`), `180-184` (`canAccessConversation`).
- **Evidence:** auto-create sets `meta: { autoCreated: true, createdAt }` without `userId`.
- **User-visible consequence:** rare: a turn that completes after its conversation was deleted mid-stream leaves a conversation the user cannot open.
- **Root cause:** confirmed.
- **Recommended repair:** do not auto-create on `addMessage` for a deleted id (drop with a log), or carry `userId` through.
- **Regression test:** delete during an in-flight turn → no inaccessible orphan.

### D-14: Overlapping turns: user message persisted at turn end  · S2

- **Files / components:** `aqua/src/routes/chat.js:145-148, 1529-1530, 1883-1884`.
- **Evidence:** persistence happens after generation and verification.
- **User-visible consequence:** a double send or two tabs means the second answer lacks the first exchange, and the stored order follows completion.
- **Root cause:** confirmed. Frequency NOT MEASURED.
- **Recommended repair:** a per-conversation in-flight lock (reject or queue a second concurrent turn), or persist the user message at turn start with a pending marker.
- **Regression test:** two concurrent requests on one conversation → deterministic order and no lost context (queued) or a 409.

### D-15: Mongo mirror unverified → acknowledged writes not durable on Render  · S2

- **Files / components:** `aqua/src/core/mongoMirror.js:255, 272-277, 344-350`; `aqua/router.js` durability self-check.
- **Evidence:** production reported mirror durability unverified. In that state, local stores are not mirrored.
- **User-visible consequence:** conversations and memory written since boot are lost at the next deploy or restart, which then triggers D-07.
- **Root cause:** operational state plus design (single-writer whole-file mirror).
- **Recommended repair:** alert on `unverified` and block deploys while it is set. Move history to partitions (Postgres) once D-09 is resolved.
- **Regression test:** existing `core/tests/mongoMirror.test.js` covers the unverified paths. Add a durability gate test for deploy scripts if one exists.

### D-16: "[PIC] Knowledge injected" for evidence-free blocks  · S3

- **Files / components:** `aqua/src/routes/chat.js:776-782`.
- **Evidence:** the log fires whenever the block is non-empty, including a header-only UNKNOWN block with `items=0`.
- **Consequence:** metrics overstate retrieval and hide D-01.
- **Recommended repair:** log `epistemicState` and `items` and classify `injected` as `items > 0`.
- **Regression test:** log-format unit test.

### D-17: Engine policy text shares the UNTRUSTED fence with user data  · S2

- **Files / components:** `aqua/src/core/promptBuilder.js:133-142`; `aqua/src/routes/chat.js:917`.
- **Evidence:** the Context Engine's directives travel inside `fenceUntrusted(projectContext …)`, whose preamble says the content is "never instruction".
- **Consequence:** unpredictable obedience. The model may follow or ignore AQUA's own policy depending on phrasing, and either outcome breaks something.
- **Recommended repair:** emit engine policy (evidence status, what is unknown, degraded notices) in an operator section, with user-derived statements kept fenced.
- **Regression test:** prompt-structure test: no imperative policy lines inside the untrusted fence.

### OPS-1: Rejected Groq credential  · S3

- **File:** provider key configuration (environment). Handling: `aqua/src/providers/keyPool.cjs:31, 277, 512` (sticky quarantine).
- **Consequence:** less capacity and an extra failed call per process start.
- **Repair:** rotate or remove the key. **Test:** the key-pool probe (existing tooling) reports zero rejected slots.
