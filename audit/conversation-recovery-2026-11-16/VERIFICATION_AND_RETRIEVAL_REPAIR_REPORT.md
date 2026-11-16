# Verification and Retrieval — Repair Report

Status legend: **FIXED+TESTED** · **PARTIAL** · **NOT TESTED** · **BLOCKED** · **NEEDS PRODUCTION VALIDATION**.

## 1. D-01 — Context Engine declared general topics "unknown" · FIXED+TESTED

Reproduced before the fix (forensic report §4): for "Is pneumonia curable?" with an empty personal store, E8 ended `unknown`, ran two text searches for "<question> topic/subject", and rendered "EVIDENCE STATUS: UNKNOWN … Required slots still unknown: topic. Do not infer or fabricate them."

Repair:
- `brain/contextEngine/queryPlan.js buildQueryPlan(query, { taskType, personalWorld })`: for the `conversation`, `research`, `analysis` and `planning` templates, slots are **not required** unless the question is about the user's own world (`personalWorld` from the shared conversation context, else read from the query by the single rule `core/conversationContext.isPersonalWorldQuestion`). `decision`, `project_query`, `file_analysis` and `coding` are unchanged. The plan carries `scope: 'general' | 'personal'`.
- `e8Pipeline.js` (sync + async) and `contextEngine/index.js` forward `personalWorld`; `brain/index.js assembleContextAsync` passes it through.
- `assembler.js`: the UNKNOWN line is now explicitly scoped ("These are facts about the user's own world; this does not limit general knowledge or the conversation itself").
- Rollback: `AQUA_E8_PERSONAL_SCOPE=off`.

Tests: `brain/tests/e8PersonalScope.test.js` (8: general × 4 task types × 6 questions → no UNKNOWN, one round only; explicit flag wins; personal-missing keeps UNKNOWN with scoped wording; decisions unchanged; personal fact → sufficient; contradictory personal evidence rendered as data with the contested rule in the policy half; split integrity; rollback), e2e T06, T07, T01. Existing E8 gate tests unchanged and passing.

## 2. D-02 — reviewers without history · FIXED+TESTED

- `verificationAgent.runVerification({ …, conversationContext })` and `debateAgent.runDebate({ …, conversationContext })`: the review input starts with "Conversation so far in this chat" (bounded, newest kept) plus the reference note; the question is labelled "Latest user message". Both system prompts gain `CONVERSATION_GROUNDING_RULE` (`intelligence/evidenceContext.js`).
- **Withdrawal guard** (`evidenceContext.withdrawalReason`): a revision that turns an answered draft into a clarification is discarded unless the reference is genuinely `ambiguous`; a revision that withdraws to "I don't have information / not in the provided context" is always discarded. Suppression keeps the draft, records `suppressedWithdrawals`, status `incomplete` (never `verified`).
- **Outcome vocabulary**: `outcome ∈ ACCEPT | REVISE | CLARIFY | REFUSE | INSUFFICIENT_EVIDENCE` (null when no pass completed) + `applied` + `revisionReason`.
- **Reason protocol**: the verifier is asked to start a replacement with `REVISION_REASON: …`; the line is parsed, recorded, and stripped (tolerates markdown). Enforcement (discard reason-less replacements) is behind `AQUA_REVIEW_REQUIRE_REASON=on`, **default off** → PARTIAL (see remaining defects): free-tier models do not reliably follow formats, and dropping legitimate corrections would be a regression.
- Failure semantics unchanged and re-tested: throw/timeout, blank, truncated → draft kept (T20, unit tests).
- `chat.js runVerification` passes `prep.conversation` on both endpoints.

Tests: `intelligence/tests/conversationAwareReview.test.js` (9), e2e T01 (reviewer ran with history → `verified`), T08 (reviewer forced to clarify → answer kept, persisted message carries `outcome: CLARIFY, revised: false`), T20.

## 3. D-05 — global self-reinforcing learned gate · PARTIAL (FIXED+TESTED for self-reinforcement; cross-user aggregation remains)

- `learningLedger.recordOutcome` counts `confirmed` revisions (revised AND a later pass confirmed); `getTaskStats` computes the learned revision rate from confirmed revisions (`revisionBasis: 'confirmed'`). Unconfirmed rewrites, suppressed withdrawals, timeouts and malformed reviews no longer feed the gate.
- Existing aggregates are **not reset or deleted**: on first load they are copied once to `.aqua-ledger.json.pre-confirmed-basis-<ts>.json` and marked `revisionBasis: 'confirmed'`. Rollback: `AQUA_LEDGER_REVISION_BASIS=legacy`.
- Tests: two existing ledger tests updated to the new contract (they pinned the old rule); new tests "UNCONFIRMED revisions never switch the learned gate on" and the legacy rollback.
- **Remaining:** the ledger is still aggregated per task type across all users (routing statistics by design). One user can still statistically contribute to a task type's confirmed-revision rate. Per-owner isolation would need a ledger schema change — not done (documented in REMAINING_DEFECTS).

## 4. D-06 — reviewer contamination of history · FIXED+TESTED

The text persisted as the assistant turn is exactly the final user-visible answer (`finalAnswer`; on the stream, the `replace` event's text). Suppressed revisions are never persisted. The assistant message now carries `verification: { status, outcome, revised }` (status words only). T08 asserts persisted content === response answer and the stored verdict.

## 5. D-03 / D-04 / focus / CIE / IIE — follow-up resolution everywhere · FIXED+TESTED

- **Retrieval** (`chat.js`): semantic fact scores, canonical semantic scores, semantic file chunks, recall query vector, `memoryRetrieve`, project retrieval, Context Engine / PIC floor, episodic recall — all query `conversation.retrievalQuery`. T09 proves it end-to-end in the ranked recall regime (literal follow-up: 0 excerpts; resolved follow-up: the earlier passage recalled).
- **Task graph**: every node's system prompt carries "CONVERSATION SO FAR" (≤1500 chars, newest kept) and the reference note (`graphRuntime.nodeSystemPrompt`). T10.
- **Conversation focus**: the existing `conversationFocus.js` (`rememberFocus` after assembly, `recallFocus` for deictic messages) was already on the production path inside `assembleContextAsync`; it is now also read once into the shared context (`Brain.conversationFocusFor`) and passed back as `priorEntityIds`. No second focus system. Focus remains per-process, keyed owner+conversation, and limited to World-Model entity ids (general topics are carried by reference resolution instead).
- **CIE**: `assessQuestion(…, { referenceResolved })` drops the `deictic_opener` ambiguity signal when the conversation resolved the referent → no "ask ONE clarifying question" directive (`cognition/tests/conversationResolvedDeixis.test.js`, e2e T21).
- **IIE reasoning pass**: receives `resolvedQuestionFor(conversation)` ("Is it curable? (in this conversation, the reference means: pneumonia)"); gating still reads the literal message (unit test).
- **Streaming vs non-streaming**: identical `prepareTurn`, identical reviewer inputs; T11 asserts the same answer from both. The graph runtime remains `/chat`-only (unchanged strategy) — both paths now carry the conversation.

## 6. Reference resolution — known limits (deterministic, by design)

- Antecedents come from the user's own earlier messages (most recent turn that names a subject, up to 6 back). A referent introduced only by the ASSISTANT ("I recommend Redis" → "Is it free?") is not resolved → `unresolved`, the drafter still has the history. PARTIAL.
- A message that names its own subject is left alone (`own_subject`), e.g. "Is it raining in Paris?".
- Subject extraction is lexical (content words, coordination splits entities). Unusual phrasing can extract an imperfect phrase; it only augments retrieval and the note says "most recent subject", never invents.
