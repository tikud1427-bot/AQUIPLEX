# AQUIPLEX — Artifact and Conversation Migration Readiness (Phase 4B)

Date 2026-11-15.

**No production export was run, and no production data was read.** Everything
below was validated on synthetic, production-shaped data in disposable
databases and a local GCS emulator.

## 1. Validation status (re-run 2026-11-15)

| Item | Tool | Test | Result |
|------|------|------|--------|
| Conversation inventory: counts by owner and storage type | `history-migration.mjs inventory` | `historyMigration.test.js` | 7/7 (with the next six rows) |
| Missing owners (pre-login `conv:` owners, unknown user ids) | same | same | ✔ |
| **Duplicate message keys preserved** (both messages kept, in order, after the Phase 4A split fix) | same | same: apply + verify 14/14 conversations identical | ✔ |
| Recovery copies (Mongo mirror ahead of the file; local-recovery conflict copy) | `inventory --mirror-export … --union` | same | ✔: mirror-only and recovery-only conversations found; union offered, never applied silently |
| Trash (snapshots; a conversation both live and trashed) | `--trash` | same | ✔ |
| Deleted accounts excluded | `apply --exclude-deleted` | same | ✔ |
| Conversation export + rollback | `export`, `rollback-check` | same | ✔: 14 conversations restorable |
| Artifact inventory, ownership, broken references | `artifact-storage-audit.mjs` / `artifact-migration.mjs plan` | `artifactAudit.test.js` (3/3), `artifactMigration.live.test.js` (2/2) | ✔: missing file, hash mismatch, missing manifest, orphan directory, stray temp file, conversation gone, deleted owner, ownerless |
| Artifact binaries → object store (idempotent) | `artifact-migration.mjs upload` | `artifactMigration.live.test.js` | ✔: 2 uploaded; a re-run uploaded 0 (2 already present); damaged and ownerless skipped |
| Artifact rows (index entry + manifest → `a:<id>`) | `artifact-migration.mjs rows` | same | ✔: dry run by default; `--apply` wrote the two owned artifacts' rows, owned by their user |
| Artifact verification | `artifact-migration.mjs verify` | same | ✔: every planned object present with its sha256; rows reconcile with 0 missing |
| Artifact rollback export | `artifact-migration.mjs export` | same | ✔: the export carries entry + manifest |
| **Classic artifacts readable on another instance after migration** | — | same: an instance with an empty disk streams both versions from GCS, with no local copy | ✔ |
| A damaged artifact after migration | — | same | reported `ARTIFACT_OBJECT_MISSING`, never served |

## 2. Operator-controlled export procedure (production; not executed)

**Who:** an operator authorised in writing for this export. **When:** a
maintenance window with writes frozen, or followed by an incremental re-run.
Every step is read-only on production.

### 2.1 Inputs

| Input | Source | How |
|-------|--------|-----|
| `.aqua-history.json`, `.aqua-history.json.bak`, `.aqua-history-trash.json` | the Render persistent disk (`AQUA_DATA_DIR`) | file copy from the running service's shell, or the platform's disk snapshot |
| `aqua_kv` mirror | production Mongo | `mongoexport --collection aqua_kv --out aqua_kv.jsonl` with a **read-only** database user |
| User ids | production Mongo `users` | `mongoexport --fields _id` (ids only) |
| Artifacts directory | `<AQUA_DATA_DIR>/.aqua-artifacts` (or `AQUA_ARTIFACTS_DIR`) | `tar` of the whole directory |
| Deleted accounts | none yet in production (`aqua_deleted_owners` is Phase 3) | — |

### 2.2 Outputs

- The copied files and the `mongoexport` output, unchanged, plus a
  `SHA256SUMS` file over all of them.
- Tool reports (JSON). They contain **counts, ids and hashes only, never
  content**: the inventory, plan, apply, verify and rollback reports.
- A signed-off decision record: which source is authoritative per conversation
  difference, and what to do with damaged or ownerless artifacts.

### 2.3 Security requirements

1. Exports contain **every user's conversations and files**. They are personal
   data.
2. **Storage:**
   - a dedicated, encrypted location: a private GCS bucket in the target
     project with CMEK or Google-managed encryption, uniform access and no
     public access; or an encrypted volume;
   - **never** a laptop's general storage, chat tools, e-mail or the
     repository.
3. **Access:**
   - named operators only;
   - the read-only Mongo user is created for the export and deleted afterwards;
   - every access is logged (Cloud Audit Logs on the bucket).
4. **Processing:**
   - tools run on a VM or Cloud Shell **in the target project**;
   - `--db` / `--allow-remote` point only at the authorised target (staging
     first);
   - `history-migration.mjs` and `artifact-migration.mjs` refuse remote
     databases without `--allow-remote`.
5. **No content in reports.** Reports name owners and conversations by hash.

### 2.4 Retention

| Artefact | Kept until | Then |
|----------|------------|------|
| Raw exports (history files, `aqua_kv` dump, artifacts tar) | 30 days after the cut-over is verified (the rollback window) | deleted; deletion recorded |
| Tool reports | 1 year (audit) | — |
| `SHA256SUMS` + decision record | 1 year | — |
| The read-only Mongo user | the end of the export | deleted |

An account deleted **during** the retention window must also be removed from the
retained export. Otherwise rollback would resurrect it. The rollback procedure
therefore always re-applies `--exclude-deleted` against `aqua_deleted_owners`.

### 2.5 Order of operations

1. **Conversations.** Copy, then `inventory` across every source (file, mirror,
   conflict copies, trash). Decide the authoritative source. Then `plan`
   (staging), `apply --exclude-deleted --trash`, `verify` (must exit 0),
   `export`, `rollback-check`.
2. **Artifacts.** Run `plan` (audit) and decide on damaged and ownerless
   artifacts. Then `upload` (re-runnable), `rows` (dry run), `rows --apply`,
   `verify`, `export` (rollback).
3. **Attachments.** Use the existing `partition-migrate.mjs --store attachments
   --history …`.
4. **Staging first.** Run steps 1–3 into **staging** Cloud SQL and the staging
   bucket, then run the application journeys there. Production only with
   separate authorisation.

## 3. Remaining risks

- **Production volumes are unknown.** The history split holds a whole store text
  in memory. Measure the file size first; a very large file needs a streaming
  split.
- **The authoritative source is a human decision** when the file, mirror and
  recovery copies differ.
- **Writes between the snapshot and the switch** need either a write freeze or a
  second, incremental run. Every apply step is idempotent.
- **Ownerless artifacts** stay on the local path and are lost with the old disk
  unless someone decides otherwise. Their count is unknown until the audit runs
  on production data.
