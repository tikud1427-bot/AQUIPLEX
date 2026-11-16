# AQUIPLEX — Conversation History Migration Report (Phase 4A)

Date 2026-11-15.

**Production was not read and nothing was migrated.**

- The tooling below is built and tested end to end on a production-*shaped*
  synthetic history, in a fresh disposable database created and dropped by the
  test.
- The real production counts are therefore **not known**. Producing them is the
  first operator step in §5.

## 1. Every place production conversation history lives

| # | Source | Shape | Notes |
|---|--------|-------|-------|
| 1 | `AQUA_DATA_DIR/.aqua-history.json` on the Render disk | store envelope `{__aqua, data: {<conversationId>: {messages[], meta}}}` | Also `.aqua-history.json.bak`, the boot backup from the previous process generation |
| 2 | Mongo `aqua_kv` `_id: ".aqua-history.json"` | `{json}` or chunked: a manifest `{chunked, parts, gen}` + `"<id>::part<gen>:<i>"` docs | The durable copy. It can be **ahead** of the file (written after the file's last save) or behind it |
| 3 | Mongo `aqua_kv` `conflict/.aqua-history.json/…` | Same as 2 | Preserved generations and **local-recovery** copies: writes made while the mirror was unreachable, possibly **found nowhere else** |
| 4 | `.aqua-history-trash.json` (file + mirror) | A bare array of `{id, deletedAt, ...conversation}`, newest 40 | Recovery snapshots of deleted conversations |
| 5 | pg-blob (`AQUA_STORE_PG`) | Store text in Postgres | Only if the blob shadow was ever enabled in production |
| — | `.aqua-attachments.json` | Keyed by conversation | Not history, but placed under each conversation's user; migrated with `--history` (existing CLI) |

**Record variants present in the code's history:**
- conversation objects `{messages, meta}`;
- **legacy array-form** conversations (a bare message array, no meta, so no
  owner);
- messages with a stable key (`mid`, written since partitions existed in shadow)
  and messages without one (positional);
- pre-login conversations without `meta.userId`, owned by `conv:<id>`.

## 2. Tooling

**Module:** `aqua/src/core/storage/historyMigration.js`. Pure functions over the
text the operator supplies:
- `readMirrorExport`: reassembles `aqua_kv` docs into store texts, including
  chunk sets and conflict copies. A torn chunk set is reported, never guessed.
- `inventoryHistory`: counts and findings.
- `compareHistorySources`: file ⇄ mirror ⇄ conflict copies.
- `verifyHistoryPreserved`: per-conversation equality after an apply.

**CLI:** `aqua/scripts/history-migration.mjs`.
- stdout is the JSON report only; module logs go to stderr.
- The database comes only from `--db`, and a non-local host is refused without
  `--allow-remote`.
- Reports name owners and conversations by **hash**, never by id or content.

| Command | Does |
|---------|------|
| `inventory --history <file\|mirror> [--mirror-export f] [--trash f] [--users f] [--union --out f]` | Counts by owner and storage type; missing owners; duplicates; malformed records; file/mirror/conflict differences. Optionally writes the **union** for an operator to review. Never used automatically. |
| `plan --db … --history …` | Inventory + **dry run** against the target. Writes nothing to the partitions; records the run in `aqua_store_partition_runs`. |
| `apply --db … --history … [--trash f] [--exclude-deleted]` | Inserts the partitions (`migrateStoreText`). Never overwrites a row; differing rows are reported. A re-run after an interruption inserts only what is missing. `--exclude-deleted` leaves out accounts in `aqua_deleted_owners`. |
| `verify --db … --history … [--exclude-deleted]` | Rebuilds the store from the partitions. **Every** source conversation must be identical (header fields + ordered message list), plus the store-level reconcile (checksums, missing, extra, tombstoned). Exit code 1 if not. |
| `export --db … --out f` | The rollback file: the store JSON rebuilt from the partitions |
| `rollback-check --db … --history …` | Export, then compare with the source: every conversation restorable |

## 3. What the inventory reports

**Counts:**
- conversations, messages, bytes;
- **by owner**, hashed: conversations, messages, bytes.

**Storage type:**
- conversation objects vs legacy arrays;
- stable-key vs positional messages.

**Missing owners:**
- conversations without a user (`conv:` owners);
- user ids **not among the known accounts**, from `--users` (an export of Mongo
  user ids).

**Deleted accounts:** conversations of owners in `aqua_deleted_owners`. These
must not come back.

**Duplicates:**
- the same message key twice in one conversation;
- repeated identical consecutive messages (a client retry);
- a conversation both live and in the trash.

**Malformed records:** a conversation without a message list; a message without
`role`/`content`.

**Sources:** conversations only in one source, and conversations whose versions
differ. Each difference is listed with message counts and hashes, and the
proposed choice (most messages, then newest `updatedAt`).

## 4. Results (test suite `src/core/tests/historyMigration.test.js`: 7/7, a fresh database per run)

The fixture has:
- 3 users;
- an anonymous (pre-login) conversation and a legacy array conversation;
- positional and stable keys, and a **duplicate message key**;
- a repeated message and a malformed message;
- an unknown user and a deleted account;
- a chunked mirror **ahead** of the file by one conversation;
- a **local-recovery** copy with a conversation found nowhere else;
- a trash file with a conversation that is also live.

| Step | Result |
|------|--------|
| inventory | every category above counted correctly; owners hashed; no content in the report |
| sources | the mirror-only and recovery-only conversations found; union offered, not applied |
| plan | dry run: `wouldInsert > 0`, **0 rows written** |
| apply (deleted account excluded) | all rows inserted, 0 conflicts; **a second run inserted 0** (idempotent) |
| verify | **14/14 conversations identical**; the deleted account's conversation excluded; message totals equal; store reconcile **clean** |
| export + rollback-check | 14 conversations restorable, 0 missing, 0 changed |
| damage detection | one message row tombstoned: verify fails, with `changed=1, messageCountDiffers=1` |
| non-local database | refused |

**Defect found and fixed by this test.** A conversation containing the **same
message key twice** mapped both messages to one partition row. The apply batch
then aborted with a version conflict, and every other conversation in the batch
was not migrated. The split (`partitionLayout.js`) now gives a repeated key the
message's position key, so both messages are kept in order. Storage layout and
migration suites: 119/119 after the change.

**Related runtime note.** A JSON history loaded in shadow mode also keys
messages by `mid`. A duplicate there collapses in the binding's in-memory index
(not in the conversation itself). The partition load, used in `on` mode, is not
affected.

## 5. Production procedure (for an authorised operator; not executed)

1. **Freeze writes or snapshot.** Copy `.aqua-history.json`, its `.bak` and
   `.aqua-history-trash.json`. Run `mongoexport` on `aqua_kv` (read-only). Export
   the Mongo user ids.
2. **Inventory** every source together:
   `inventory --history <file> --mirror-export <aqua_kv> --trash <trash> --users <ids>`.

   Review the following, and decide in writing which sources are authoritative:
   - missing owners;
   - unknown users;
   - duplicates;
   - malformed records;
   - and above all **conversations only in the mirror or in a local-recovery
     copy**.

   If the union is chosen: `--union --out union.json`, review it, use it as
   `--history`.
3. **Plan** against the target (Cloud SQL; `--allow-remote` is an explicit,
   authorised step), then **apply** with `--exclude-deleted` and `--trash`.
4. **Verify** (must exit 0), then **rollback-check**. Keep the export file.
5. Switch `history:on`, required before `AQUA_POST_TURN_DURABLE`. Then migrate
   attachments with `--history`.

**Rollback:** turn the flag off. The JSON file is untouched; with `on`, the
binding keeps it current as a rollback copy. The export file rebuilds it from
the partitions if needed.

## 6. Status

| | |
|---|---|
| Implemented | inventory, mirror reassembly, source comparison/union, plan, apply with deleted-account exclusion, per-conversation verify, export, rollback-check; duplicate-key fix in the split |
| Tested (real Postgres, fresh disposable database) | the whole sequence, with a production-shaped fixture |
| Not tested | real production data (never read); Cloud SQL; histories of production size (the split holds a whole store text in memory: a very large file needs a streaming split, so measure the file size first); a live `aqua_kv` read (the tool reads exports) |
| Not activated | everything |
| Remaining risks | (1) the authoritative source among file, mirror and recovery copies is an operator decision. (2) Writes made after the snapshot and before the switch need a second, incremental apply, which is idempotent, or a write freeze. (3) In-memory split of a large store. |
