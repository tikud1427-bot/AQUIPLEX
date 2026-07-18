# DATABASE_MIGRATION_PLAN.md — Memory 5.0 storage path

## Now (correct for current scale)
In-proc Map + debounced atomic JSON (`~/.aquiplex/*.json`) + Mongo `aqua_kv` mirror (hydrate/mirror/drain, canary, chunking, dual-writer alarm). Single-instance writer. Good to ~10⁴ owners per instance. **No migration executed in this sprint** — Memory 5.0 phases are storage-neutral by design; every store already has a one-file swap seam.

## Swap seams (already isolated — port ONE file each)
| Store | File | Target |
|---|---|---|
| mindStore | `mind/mindStore.js` | Postgres `minds(owner_id pk, doc jsonb)` — or per-section tables at step 3 |
| conversationStore | `memory/conversationStore.js` | `conversations(id pk, owner_id, meta jsonb)` + `messages(conv_id, seq, role, content)` |
| vectorStore | `embeddings/vectorStore.js` | pgvector `vectors(ns, id, embedding vector, hash, meta jsonb, pk(ns,id))` + ivfflat |
| projectMemory | `project/projectMemory.js` | `workspaces(id pk, doc jsonb)` (rebuildable — lowest priority) |

## Staged path (when triggered by load, not by ambition)
1. **Trigger**: >5k owners OR store file >50 MB OR multi-instance need.
2. **Step 1 — SQLite** (zero infra): same schemas, WAL mode; removes whole-file rewrite cost; still single-writer. 1 day/store.
3. **Step 2 — Postgres + pgvector**: enables multi-instance (row-level writes kill the last-writer-wins constraint); mirror retired or kept as export.
4. **Step 3 — hot/cold split**: archived facts + closed episodes → cold tables; active set stays small → retrieval O(active).
5. **Dual-write window** per store: new tier primary, JSON shadow 1 week, diff job verifies, shadow off.

## 100M-user honesty
Spec asks "design for 100M users." Design = the seams above + owner-sharded row model (`owner_id` in every key) — that sharding property is already true in the JSON layout, so the port is mechanical. Building Postgres now would violate RULE #1 (don't replace working systems) and add ops burden with zero current users demanding it.

## GDPR
`deleteMind(owner)` + `clearFacts` + vector ns purge already cascade in-process; after port, same facade calls become `DELETE ... WHERE owner_id=?`. Mirror docs keyed by file — purge job listed.
