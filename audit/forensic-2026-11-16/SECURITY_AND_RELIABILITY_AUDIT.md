# Security and Reliability Audit

Evidence levels as defined in SYSTEM_ARCHITECTURE_MAP.md. Scope: the chat path and the stores it touches. This is not a full application security review. Earlier, separate security work (auth defects S1/S2, exposed credentials, OAuth state) is tracked in the repository's own documents and was **not re-verified** here.

## 1. Authentication and ownership (SOURCE-CONFIRMED)

- `/api/aqua/*` and `/v1/*` require a session (`requireLogin`, `index.js:665-676`). `req.aquaUserId` comes from the session, never from the request body.
- Conversation access: when the requested conversation exists and `meta.userId !== aquaUserId`, the route returns 404, with no existence oracle (`chat.js:1607-1611`, `conversationStore.js:180-184`).
- **R-1 (S2). Ownership is checked against the in-process Map only.** When the conversation is not in this process's Map (another instance, or not hydrated), the check is skipped and the conversation is *created* at the requested id with the caller's `userId` (`getOrCreateConversation`). On a multi-instance deployment, a caller who knows another user's conversation id could create a same-id conversation on an instance that has not loaded it. Through whole-file mirroring, that local Map can then race the real one. Exploitability requires id knowledge (ids are UUIDv4) plus a multi-instance deployment. **HYPOTHESIS for exploitability**; SOURCE-CONFIRMED for the unchecked path.
- R-2 (S3): `canAccessConversation(null, id)` returns true. This is unreachable from the platform (`requireLogin` always sets the user), but it remains a footgun for any future sessionless mount.
- Workspace ids are re-authorized per turn (`authorizedWorkspaceId`, `chat.js:159-165`). An inaccessible id is dropped, not trusted.

## 2. Fail-open behaviour: where it is unsafe

The codebase's general rule is "fail open: never fail a turn". This audit found several places where failing open **changes the answer's truth basis silently**:

| Fail-open site | What the user gets instead | Unsafe because |
|---|---|---|
| DB unreachable → legacy read (`resolveReadMode`) | Answers from a different, stale store; corrections may be ignored | Not disclosed to the user or the model |
| World Core / claim hydration errors swallowed | Less context, same confidence | Same |
| Context Engine empty floor → UNKNOWN block (D-01) | "I don't have information" for common knowledge | Missing ≠ failed ≠ not-about-the-user, all rendered the same |
| Conversation Map miss → new empty conversation (D-07) | Answers without history | No error, no UI signal |
| Reviewer replacement accepted on any non-empty text (D-02) | A worse answer replaces a better one | "Fail-open" guards only check form, not regression |
| Mongo mirror unverified → local-only writes | Data loss on the next Render deploy | Logged once; the user is unaware |

## 3. Concurrency and race conditions

- **R-3 (D-14, S2, SOURCE-CONFIRMED).** The user message is persisted at the *end* of a turn, after generation and verification (`chat.js:1529, 1883`). Two overlapping turns in one conversation (double send, retry after timeout, two tabs) each build their window without the other. History order is completion order, so the stored transcript can read A-user, B-user's answer before B-user's question, and so on. The memory transaction per turn (`turnCommit.js`) protects memory, not message ordering.
- **R-4 (S2).** Whole-file JSON stores with one writer per process are safe within one process (synchronous Map mutation, debounced snapshot). Across processes: last-writer-wins at the mirror (STORAGE_AND_DURABILITY_AUDIT.md).
- The plan cache (`reasoningPlanner.js`) and `conversationFocus` are per-process. Different instances can give the same conversation different focus or plan reuse. This is a correctness inconsistency, not a security issue.

## 4. Retry behaviour

- Provider retries are bounded (4 rounds, 90 s), backoff is jittered, and open circuits are not re-hit after round 1. Sound.
- Verification adds up to `maxPasses` (1–2) more provider calls, each with its own fallback chain. Worst-case latency per turn is roughly drafter plus up to 2 × reviewer chains. NOT MEASURED in this pass.
- Mongo mirror retries are re-queued with backoff (fixed after the July audit per the module header). Not re-tested.

## 5. Credit debiting (SOURCE-CONFIRMED)

- `usageGuard('chat_message')` deducts on entry. `refundOnFailure` refunds once on status ≥ 400 (idempotent `refund()`, `middleware/usage/usageGuard.js:28-39`).
- The streaming endpoint answers 200 before it can fail, so its handler refunds explicitly (awaited, bounded). Non-stream refunds fire-and-forget and rely on the net. Both are idempotent, so there is no double refund.
- **R-5 (S3, product).** A turn whose correct answer was replaced by a history-blind reviewer (D-02), or that answered "I don't have information" because of D-01, is charged as a successful turn. Not a billing bug. It is a value-delivered issue to weigh when deciding remediation priority.

## 6. Logging and observability

- `ownerLogId` and `shortHash` pseudonymise owners. Message text is logged as `textMeta` (length/hash) in most places. Good practice, SOURCE-CONFIRMED where read.
- **R-6 (S2).** The logs cannot answer the incident's key question without the raw prompt: they record `[PIC] Knowledge injected … items=0` (looks like success) and verification status, but not *what* the reviewer changed or which text the context block carried. A privacy-preserving trace is needed: block header class (`UNKNOWN/PARTIAL/SUFFICIENT`), window message count and token total, reviewer verdict class (pass / replacement / clarification-shaped), and whether the final answer ends in a question.
- **R-7 (S3).** `noteFeature` and the per-turn logs exist, but there is no per-turn "degraded" flag in the response payload that the UI could show ("memory temporarily unavailable").

## 7. Privacy

- **R-8 (D-10, S2, REPRODUCED).** `classifyText("I have pneumonia.") === null`. Common conditions are missing from the health lexicon, so the "health is not stored unless you opt in" promise does not hold for plain statements of many conditions.
- The sensitive scrub is applied to the knowledge, recall and memory lanes. Verified in `chat.js:714-717, 768-774, 880-882`.

## 8. Not audited

OAuth flows, session fixation and cookies, the upload parser's 50 MB body limit and file-type handling, artifact sandboxing, account purge completeness across Postgres/partitions, rate-limit tuning, admin/debug endpoints (`getAllConversations` export: callers not traced), and the 18 previously reported exposed credentials (status unknown).
