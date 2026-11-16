# Storage, Concurrency and Durability — Repair Report

Status legend: **FIXED+TESTED** · **PARTIAL** · **NOT TESTED** · **BLOCKED** · **NEEDS PRODUCTION VALIDATION**.

## Source of truth (re-confirmed against current code)

| Substrate | Role for conversation history |
|---|---|
| In-process `Map` (`memory/conversationStore.js`) | **Authoritative** for reads while the process runs |
| `.aqua-history.json` in `AQUA_DATA_DIR` | Snapshot (debounced 500 ms whole-file write); read at boot and — new — on a per-id recovery |
| Mongo `aqua_kv` mirror | Whole-file copy; hydrates `DATA_DIR` at boot; single-writer by design |
| Postgres partitions (`AQUA_STORE_PARTITIONS=history:on`) | Built, **inactive** (not configured); the only path that can be authoritative across instances |
| Platform MongoDB | Users / sessions / credits (not conversation history) |

No infrastructure, database, migration or production variable was changed.

## D-07 — silent re-creation of a missing conversation · FIXED+TESTED

- `conversationStore.conversationLoadState(id, userId)` → `present | recovered | unavailable | absent`.
  - `recovered`: `recoverConversation(id)` re-reads that one conversation from the history file (JSON-backed modes) — the case of a fresh process or another process on the same disk.
  - `unavailable`: partitions authoritative and the owner's partition is not loaded, **or** the mirror reports an `UNVERIFIED` / `RECOVERY REQUIRED` start (the backup may hold it).
- `chat.js resolveTurnConversation()` (both endpoints):
  - `unavailable` → **503** `unavailable`, `retryable: true`, `Retry-After: 5`.
  - `absent` + server-issued id (UUID v1–8; the server mints only `uuidv4`) → **404** "Conversation not found"; **nothing is created under the id**.
  - `absent` + client-chosen id (e.g. `conv-…`, used by eval tooling and tests) → created with the caller as owner (documented contract kept).
  - Ownership is checked for every existing or recovered conversation → 404 on mismatch (no existence oracle).
- Logs: `CONVERSATION_RECOVERED`, `conversation not found — not re-created empty`, `conversation unavailable` (pseudonymous id hash).
- Tests: T12 (entry removed from the Map → recovered from disk, history intact, follow-up answered), T13 (unknown UUID → 404 on `/chat` and `/chat/stream`, no entry created; custom id still created), T14 (other user → 404).
- **API contract change (documented):** a `conversationId` the server issued but can no longer load now yields 404 (or 503) instead of a silent fresh conversation. The frontend's handling of that status was not changed in this repair — see REMAINING_DEFECTS_AND_OPERATIONAL_LIMITATIONS.md.
- **Not tested:** the `unavailable` branch end-to-end (needs an authoritative partition store or a live unverified mirror). The branch is a pure status read; covered only by code review.

## D-13 — owner-less auto-created conversations · FIXED+TESTED (unit-level through the durable path guard)

- `addMessage` no longer resurrects an id **deleted by this process** (`clearConversation` / `purgeConversation` record it in a bounded set): the message is not stored and a warning is logged. The durable commit path (`turnPostProcess.commitTurnWithLearning`) turns that into an explicit `CONVERSATION_DELETED` not-durable error instead of a `TypeError`.
- Any other auto-create carries `extra.ownerUserId` (the chat routes pass the authenticated session user) so it stays reachable by its owner; a client-supplied owner is never trusted (the value comes from `req.aquaUserId`, set by `requireLogin`).
- Tested indirectly: the full routes/core/memory batteries (conversation, purge and account-deletion suites) pass. A dedicated "delete during a streaming turn" test was **not** written (NOT TESTED).

## D-14 — overlapping turns · FIXED+TESTED (single instance)

- `aqua/src/core/conversationTurnLock.js`: per-conversation lease (native `Map` + promises). A second turn waits up to `AQUA_TURN_LOCK_WAIT_MS` (default 15 s) then proceeds — reading the history that now contains the first turn — or receives **409** `conflict`, `retryable: true`, `Retry-After: 3`. Different conversations never block each other. Release is in `finally` on both endpoints (success, error, early return, client abort); a lease older than 10 min is reclaimed (no permanent lock, no deadlock: one lease per turn, never nested).
- Acquired **before** the SSE handshake, so a busy stream gets a plain JSON 409.
- Tests: `conversationTurnLock.test.js` (ordering, timeout, idempotent release, stale reclaim, flag off) and T15 / T15b end-to-end (request order preserved `user1,asst1,user2,asst2`; the second turn's model request contains the first turn; a still-running turn → 409, no interleaving).
- **Limitation:** in-process only. It does not coordinate several instances — consistent with the store itself, which is single-writer (see below).

## D-08 — history window · FIXED+TESTED

`core/tokenManager.js buildContextWindowWithStats`: contiguous suffix (callers' index arithmetic preserved), newest exchange always present, oversized messages included as **truncated copies** with an explicit marker (head + tail), questions reserved for truncated answers, no orphaned assistant at the start, store objects never mutated, budget respected; stats (`included / excluded / truncated / tokens`) logged and returned in the payload `conversation.window` — counts only. Tests: `contextWindow.test.js` (6) and T16. No summarizer added.

## D-09 / D-15 — truthful persistence state · FIXED+TESTED (reporting) · NEEDS PRODUCTION VALIDATION (actual durability)

- `conversationStore.persistenceState({ durableCommit })` → `DURABLE` (durable partition commit for this turn) · `MIRRORED` (mirror enabled and `durable`) · `LOCAL_ONLY` (no mirror) · `DEGRADED` (mirror configured but not durable: not connected / unverified / failing / standby / multiple writers) · `FAILED` (last history-file write failed after the last success).
- Write outcomes are now observed, not assumed: `createDebouncedWriter` gained an optional `onFlushed` hook (additive; the 21 other stores are unaffected) and the history writer records success/failure times.
- Every chat response carries `persistence: { state }` (additive field); the per-turn `[TURN]` log line carries it too. A response never says DURABLE/MIRRORED on the strength of an in-memory write.
- Degraded canonical memory (Postgres unreachable) is now **said** to the model as an operator notice distinct from "not known" ("could not be checked right now").
- Tests: T19 (no mirror → `LOCAL_ONLY`; configured-but-unconnected mirror → `DEGRADED`; durable commit → `DURABLE`).
- **What this does NOT do:** make storage durable. Whether production's mirror is actually verified, and whether `DATABASE_URL` should point at a reachable database or be unset, are operational decisions (no infrastructure was changed).

## Multi-instance

**Not supported, and not claimed.** The Map, the turn lock, the reference focus cache and the whole-file mirror are per-process. Requirement: run exactly ONE instance (Render: one instance, no autoscaling) until history partitions are authoritative on a reachable Postgres. The mirror's existing writer-lease/heartbeat alarm remains the safeguard that reports a second writer. No Redis or other service was introduced.
