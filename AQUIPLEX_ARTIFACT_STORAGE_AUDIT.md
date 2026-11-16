# AQUIPLEX — Artifact Storage Audit and GCS Migration Design (Phase 4A)

Date 2026-11-15.

**Nothing in this document is activated.**

- No Google Cloud Storage bucket was created and no object was uploaded
  anywhere outside the disposable test database.
- Production artifacts were not read.

The audit is **of the code**. The tool that audits a real artifacts directory is
built and tested on synthetic artifacts created by the real store. It has not
been run on production data: that requires an operator copy of the production
directory.

## 1. Where artifacts live today

| Item | Location (production, single Render instance) | With partitions on (`artifacts:on`, not active anywhere) |
|------|------------------------------------------------|--------------------------------------------------------|
| Root | `AQUA_ARTIFACTS_DIR`, else `<AQUA_DATA_DIR>/.aqua-artifacts` (a legacy `./.aqua-artifacts` in the working directory is copied there once at boot — `migrateLegacyDir`) | same root, used as a **local cache** |
| Lite index | `<root>/.index.json` (debounced JSON writer; mirrored to Mongo `aqua_kv` like every store file) | partition rows `a:<id>` (index entry + manifest), owner = `ownerId` |
| Manifest | `<root>/<id>/manifest.json` (full: embedded spec, versions, file metadata, model ≤ 400 k chars) | in the `a:<id>` row |
| Binaries | `<root>/<id>/v<N>/<path>` (classic layout, immutable per version) | object store `aqua_objects` (Postgres, migration 0028) under `artifacts/<id>/<versionDir>/<path>`, unique `versionDir` per version (`v<base36 time>-<random>`), plus the local copy |
| Mongo mirror | **index only.** Binaries are **not** mirrored: a lost Render disk loses every artifact's files (audit S3) | not needed |

## 2. Ownership and access

- **Owner.** Every artifact carries `ownerId`. This is the turn's memory owner
  `user:<id>`: `/api/aqua` requires a signed-in session (`requireLogin` comes
  before the engine), so anonymous owners cannot be created through HTTP. It
  also records `conversationId`, `workspaceId` and `requestId`.
- **Access check.** `routes/artifacts.js` `assertOwner` checks the lite entry's
  `ownerId` against the session user and returns a uniform 404 otherwise.
  - Defensive note: the check is skipped when the request has **no** user
    (`scopeUser` null).
  - That branch is unreachable today, because `requireLogin` always sets
    `aquaUserId`.
  - It should fail closed if the engine is ever mounted elsewhere. Not changed
    in this phase.

| Access pattern | Route | Storage behaviour |
|----------------|-------|-------------------|
| list | `GET /artifacts` | index only (by owner, conversation, workspace) |
| manifest | `GET /artifacts/:id` | manifest |
| download | `GET /artifacts/:id/download[?version]` | one file: **streamed** from disk. Several: **assembled in memory** (zip/tar, ≤ 100 MB) |
| one file | `GET /artifacts/:id/file?path` | streamed |
| preview | `GET /artifacts/:id/preview?path` | ≤ 50 000 chars of a text file |
| edit / regenerate | `POST /artifacts/:id/edit`, `/regenerate`, chat edit turns | reads the current version, writes a new immutable version |
| rename | `PATCH /artifacts/:id` | manifest + index |
| delete | `DELETE /artifacts/:id` | directory removed, index entry removed (partitioned: tombstone + `deletePrefix`) |

With partitions on, every read of a version first calls `ensureArtifactFiles`,
which copies missing files from the object store into the local cache.

## 3. Metadata

**Manifest fields:**
- `id`, `ownerId`, `conversationId`, `workspaceId`, `requestId`;
- `format`, `title`, `spec` (embedded), `packaging` (raw / zip / tar / tar.gz);
- `version`, `versions[]` (`v`, `createdAt`, `reason`, `files`, `dir` when
  partitioned), `files[]` (`path`, `size`, `mime`, `sha256`);
- `totalBytes`, `diskBytes`, `hash` (over `path:sha256` lines), `model`.

**Quotas** (`artifacts/security.js`):
- 25 MB per file;
- 100 MB per artifact;
- 200 files per artifact;
- **500 MB per owner**, enforced by evicting the oldest artifacts (logged);
- at most **20 versions** per artifact (v1 and the newest are kept; pruned
  versions' directories are removed).

## 4. Deletion behaviour

| Event | What happens |
|-------|--------------|
| User deletes an artifact | Directory and index entry removed; partitioned: row tombstoned and its objects deleted |
| Owner over 500 MB | Oldest artifacts deleted, logged |
| More than 20 versions | Middle versions pruned (files removed) |
| **Conversation deleted** | Artifacts are **not** deleted. They keep a `conversationId` that no longer exists and stay in the user's artifact list. Behaviour unchanged; the audit reports them as `conversationGone`. |
| Account deleted | `accountPurge` deletes every artifact of the owner, and the Phase 3 deletion marker blocks write-back |

## 5. Missing or broken references: what the audit finds

Tool: `aqua/scripts/artifact-storage-audit.mjs --root <copy> [--history <copy>] [--deleted <ids>] [--plan-out plan.json]`.
Module: `aqua/src/artifacts/artifactAudit.js`. It is read-only, and reports
name artifacts by id and owners by hash, never content.

**Integrity**, which makes the audit unclean (exit code 1):
- index entry without a directory or manifest;
- unreadable manifest;
- a listed file missing;
- **size or sha256 mismatch** (bytes re-hashed);
- a version directory missing.

**Hygiene:**
- orphan directories that the index does not know;
- stray `*.tmp.*` files from interrupted writes.

**References:**
- conversation gone;
- owner deleted;
- no owner.

**Inventory:**
- artifacts, versions and files;
- bytes, including the largest artifact;
- owners, formats, packaging;
- classic versus unique version directories.

**Tested** (`src/artifacts/tests/artifactAudit.test.js`, 3/3). Artifacts were
created by the real store, then damaged:
- a file deleted;
- same-length bytes changed (caught only by the hash);
- a manifest removed;
- an orphan directory and a stray temp file;
- a conversation gone and a deleted owner.

Every case was reported, and no content appeared in the report.

**Production numbers are not known.** The tool must be run by an operator on a
copy of the production artifacts directory.

## 6. Shared-storage requirements (from the code)

1. **Every instance must read every artifact.**
   - Today the binaries exist only on one disk and are not mirrored.
   - Requirement: binaries in a shared object store, with the local disk as a
     cache only.
2. **Write-once objects with unique version directories.**
   - Two instances editing one artifact must never write the same key.
   - The partitioned layout already gives each version a unique directory, and
     the object store refuses to overwrite a key with different bytes.
3. **Owner metadata on every object**, so account purge can remove a user's
   objects.
4. **Bounded instance memory.**
   - Multi-file downloads are assembled in memory (≤ 100 MB), and
     `ensureArtifactFiles` materialises files on local disk.
   - On Cloud Run the local filesystem is in-memory and counts against the
     instance's RAM.
   - A GCS backend should stream objects straight to the response instead of
     caching them on local disk. This is a 4B design change.
5. **The classic layout must stay readable after migration.**
   - `ensureArtifactFiles` returns early for versions without a `dir`, which
     includes every existing production artifact.
   - So on another instance an existing artifact's files would not be fetched
     from the object store.
   - Required change (4B): fetch classic `v<N>` versions from
     `artifacts/<id>/v<N>/<path>` too. The migration plan already uses that
     key.
6. **Platform uploads are outside the engine.** `public/uploads` holds tool
   logos (multer) and `Aquiplex.apk`, on local disk. They need shared storage
   too: a public, static bucket or the release pipeline. Not audited by the
   tool.

## 7. Migration design to Google Cloud Storage (not activated)

**Bucket:**
- one per environment, private, with uniform bucket-level access, in the same
  region as the services;
- object versioning **off**, because objects are write-once by contract;
- **soft-delete retention** (7 days) as the recovery window for accidental
  deletes;
- no lifecycle rule that deletes data.

**Identity:**
- the API and worker service accounts hold object create, get and delete on
  that bucket only;
- no public access;
- downloads go through the API's ownership check, either streamed or as a
  short-lived signed URL issued after `assertOwner`.

**Key scheme:**
- the same as `objectStore.js`: `artifacts/<id>/<versionDir>/<path>`;
- object metadata: `sha256` and the owner hash.

**Write-once:**
- `put` with the precondition `ifGenerationMatch=0`, the GCS equivalent of the
  Postgres `ON CONFLICT DO NOTHING`;
- on conflict, compare `sha256` (same bytes: idempotent success; different:
  refuse). This is the contract the Postgres backend already implements and is
  tested against.

**Backend.** `AQUA_OBJECT_STORE=gcs` today **refuses** (not implemented). Phase
4B implements `put`, `get` (and a streaming variant) and `deletePrefix` against
that contract.

**Migration steps** (each idempotent, run on a copy, then for real only with
authorisation):
1. Audit the copy and resolve or acknowledge every integrity finding.
2. Upload the plan (`--plan-out`, one object per artifact, version and file)
   with `ifGenerationMatch=0`. A re-run uploads only what is missing.
3. Verify (`verifyObjectPlan`): every planned object present, with the planned
   size and sha256.
4. Export the existing index and manifests into `a:<id>` partition rows. That
   tool is not built; it is 4B.
5. Ship the code changes in §6 (5) and (4).
6. Switch `artifacts:on` with `AQUA_OBJECT_STORE=gcs`.

**Rollback:** keep the original directory untouched until the switch has been
verified. The partition rows can be exported back to `.index.json` and
manifests with the existing export tooling.

**Tested now:**
- the plan and its verification, against the **Postgres** object store, which
  has the same write-once contract: upload, idempotent re-upload, and detection
  of a deleted object (`artifactAudit.test.js`);
- the GCS calls themselves are **untested**.

## 8. Status

| | |
|---|---|
| Implemented | audit module + CLI, upload plan, plan verification |
| Tested | synthetic artifacts from the real store; Postgres object store as the target |
| Not tested | a real production artifacts directory; GCS |
| Not implemented | GCS backend; streaming reads; classic-layout fetch in `ensureArtifactFiles`; export of existing manifests to partition rows; platform `public/uploads` |
| Not activated | everything |
