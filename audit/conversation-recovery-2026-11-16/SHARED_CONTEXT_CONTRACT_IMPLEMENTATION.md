# Shared Context Contract — Implementation

Status legend used in every recovery report: **FIXED+TESTED** (changed and covered by a test that was executed and passed) · **PARTIAL** · **NOT TESTED** · **BLOCKED** · **NEEDS PRODUCTION VALIDATION**.

## 1. The one builder

`aqua/src/core/conversationContext.js` — `buildConversationContext({ message, conversationId, ownerId, history, focusEntityIds })`. Built ONCE per turn at the top of `prepareTurn()` (`aqua/src/routes/chat.js`, step "1⁰"), from the same `getConversation()` array the history window later uses. Pure, deterministic, no I/O, no model call; returns a **deep-frozen** object with **copied** strings.

| Field | Meaning | Category |
|---|---|---|
| `message` | the literal user message | conversation |
| `conversationId`, `ownerId` | identity of this turn | — |
| `historyCount` | prior messages of THIS conversation | conversation |
| `recent[]` | last 6 messages, each clipped to 700 chars with an explicit marker | conversation |
| `reference` | `{ detected, status: none / own_subject / resolved / ambiguous / unresolved, form, subjects[], candidates[], sourceTurnsBack, sourcePersonal }` | conversation (resolution) |
| `personalWorld` | the question is about the user's own world (possessive / first-person state), or follows up a personal statement | personal-world vs general |
| `retrievalQuery` | message + resolved subject(s); raw message when nothing resolved | retrieval only |
| `focusEntityIds` | the existing `conversationFocus` carry-over (World-Model entity ids), read via `Brain.conversationFocusFor` | personal-world (canonical) |

Information categories are kept apart:

1. **Conversation context** — `recent`, `reference` (only this conversation's own messages).
2. **Personal-world context** — memory lanes, Context Engine data half, World Core; gated by `personalWorld` (D-01).
3. **General world knowledge** — never represented as "missing": a general question has no required personal slots, so no UNKNOWN status is rendered (`queryPlan.js` scope `general`).
4. **Retrieved evidence** — Context Engine `dataBlock`, recall, files, search: fenced as untrusted data.
5. **Model inference** — the model's own answer; reviewers may correct it but not withdraw it without cause (D-02 guards).

AQUA's *own policy* about those categories (reference note, evidence status, degraded-memory notice) travels in a separate operator section, `CONTEXT POLICY (from AQUA …)`, outside the untrusted fence (D-17).

## 2. Who consumes it (every answer-shaping stage)

| Stage | Receives | How it cannot contradict the conversation | Status |
|---|---|---|---|
| Drafter (single call, stream and non-stream) | full bounded window (`messages`) + `referenceNote` in the operator policy | the note names the antecedent ("answer about X directly; do not ask what it refers to") or declares genuine ambiguity | FIXED+TESTED (T01–T05, T11) |
| Context Engine V2 / E8 | `retrievalQuery`, `personalWorld`, `focusEntityIds` | general questions: no required personal slots → no UNKNOWN header; personal ones keep the contract, wording scoped to the user's world | FIXED+TESTED (T06, T07, `e8PersonalScope.test.js`) |
| memoryRetrieve, semantic fact scores, canonical semantic scores, file chunks, project retrieval, episodic recall (+ query vector), PIC floor | `retrievalQuery` | the follow-up is searched with its subject | FIXED+TESTED for recall (T09); other lanes SOURCE-CONFIRMED (same variable) |
| Verification agent | `conversationContext` → "Conversation so far" + reference note in the critique input; grounding rule in the prompt | withdrawal guard: an answer cannot be replaced by a clarification (unless `ambiguous`) or by "no information" | FIXED+TESTED (T01, T08, T20, `conversationAwareReview.test.js`) |
| Debate panel + revision | same | same guard on revisions | FIXED+TESTED (unit) |
| Task graph | `context.conversation` (≤1500 chars, newest kept) + `conversationNote` in every node's system prompt | nodes see the chat they continue | FIXED+TESTED (T10) |
| CIE monitor (post-draft escalation) | draft + evidence (no history) | it can only ADD a review; the review it adds is now conversation-aware and guarded | DECLARED — cannot override by itself |
| Classifier, multi-label tags, orchestrator, execution plan | literal message | decide routing, budgets and whether to review — never answer text; a follow-up classified `simple_qa` is answered with full context | DECLARED (no conversation needed) |
| CIE question model / directive | `referenceResolved` | a resolved deictic opener is not "ambiguous" → no "ask ONE clarifying question" directive | FIXED+TESTED (`conversationResolvedDeixis.test.js`, T21) |
| IIE reasoning pass | `resolvedQuestionFor(conversation)` | analyses "Is it curable? (… means: pneumonia)", never a bare pronoun; gating reads the literal message | FIXED+TESTED (unit) |
| memoryObserve (writes) | literal message | memory WRITES must record what the user said, not an augmented query | DECLARED (intentional) |
| Information-needs / hybrid engines (flags off by default) | literal message | not active in production | NOT CHANGED — documented |

## 3. Isolation and immutability

- The builder reads only the history array of the requested conversation; that conversation has already passed the ownership check (`resolveTurnConversation`). Nothing is cached across turns; the focus carry-over stays keyed by owner + conversation in `conversationFocus.js`.
- `Object.isFrozen` on the context, its arrays and the reference (unit test); mutating the source history after building does not change the context (unit test).
- T14 asserts that user B's model request contains nothing of user A's conversation and that B cannot use A's conversation id.

## 4. Rollback

`AQUA_CONVERSATION_CONTEXT=off` → no reference resolution, `retrievalQuery` = message, no reference note. Reviewers still receive recent turns (no product trade-off).
