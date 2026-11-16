# AQUIPLEX — GCS Storage Implementation Report (Phase 4B)

Date 2026-11-15.

**No Google Cloud resource was created or contacted.** Every GCS test ran
against a **local emulator**, `fsouza/fake-gcs-server:1.52.2` (docker
`aqua-test-gcs`, `127.0.0.1:54443`, in-memory), or an **in-process fake**.

The backend is selected by `AQUA_OBJECT_STORE=gcs` (default `pg`), and only when
artifacts are on partitions (`AQUA_STORE_PARTITIONS=artifacts:on`). It is not
active anywhere.

## 1. What was built

**`createGcsObjectStore`** (`aqua/src/core/storage/objectStore.js`) speaks the
GCS JSON API. It has the same contract as the Postgres backend
(`createPgObjectStore`), which the Phase 2c multi-instance tests already
exercise.

| Requirement | Implementation |
|-------------|----------------|
| Shared storage | object name = `artifacts/<id>/<versionDir>/<path>`; every instance reads every object |
| Owner isolation | object metadata `owner`. `get` / `getStream` refuse another owner's object; `deletePrefix(owner, prefix)` deletes **only** that owner's objects under an **exact** prefix (never a pattern) |
| Secure access | private bucket. On Google endpoints the token comes from the **metadata server** (the Cloud Run service account), cached until 60 s before expiry and sent as `Bearer`. No key files. Downloads go through the API's ownership check (streamed); no public URLs. |
| Metadata consistency | metadata `sha256` of the bytes. A `put` of an existing key with the **same** sha256 and owner is an idempotent retry (`created: false`); with different bytes or owner it is **refused** (write-once) |
| Concurrent first writes | upload with `ifGenerationMatch=0`: on real GCS a second writer gets **412**, then the same comparison (retry or refuse) |
| Upload interruption | a GCS upload is atomic: an interrupted upload leaves **no** object; the client retries (network errors, 429, 5xx; bounded backoff) and the retry lands once |
| Missing objects | `get` / `getStream` return `null`. The artifact layer turns a listed-but-missing file into **`ARTIFACT_OBJECT_MISSING`**, logged as data loss, never served as something else |
| Injectable | `transport` (fetch-compatible) and `token` provider: tests need no credentials |
| No silent fallback | `AQUA_OBJECT_STORE=gcs` without `AQUA_GCS_BUCKET` throws at first use; an unknown backend throws |

**Artifact layer** (`aqua/src/artifacts/artifactStore.js`, `routes/artifacts.js`,
`artifacts/editEngine.js`):

- **`ensureArtifactFiles` now covers the classic `v<N>` layout.** Before, it
  returned early for versions without a unique `dir`, which is every artifact
  created before partitions. Those artifacts were unreadable on any other
  instance.
- **`openArtifactFileStream`** (single-file download, `/file`) streams from this
  instance's copy if present, else **directly from the object store**, with no
  local copy. On Cloud Run the local filesystem is memory.
- **`readArtifactFile`** (multi-file archives, previews, the edit engine) reads
  the local copy or the object store.
- **`getArtifact` no longer copies** the current version to local disk on every
  call.
- The edit engine's two synchronous local-disk reads were replaced. An edit on
  an instance that never held the files would previously have failed.

## 2. Tests

**`aqua/src/core/tests/objectStoreGcs.test.js`: 8/8.**

| Test | Backend |
|------|---------|
| The contract: create; idempotent retry; different bytes refused; another owner refused; read back; owner isolation on read; missing = null; stream; `deletePrefix` exact prefix + owner only (a sibling prefix `…x/` and another owner's object survive) | **Postgres** (real), **GCS emulator**, **in-process fake** |
| Two writers racing for one new key, via the 412 path: same bytes = retry; different = refused | fake (the emulator does **not** enforce `ifGenerationMatch`; checked: a second conditional upload returned 200) |
| Upload interrupted mid-transfer: retried, lands once | fake |
| Metadata-server token: fetched once, sent on every call | fake |
| `gcs` without a bucket and an unknown backend refuse | — |
| **Across instances**: process A (empty disk) creates an artifact; process B (another empty disk) **streams it with no local copy**, writes version 2; A reads both versions; one object deleted in the bucket → a third process gets `ARTIFACT_OBJECT_MISSING`; delete on B removes every remaining object | GCS emulator + real Postgres |

**Also tested:**
- **`aqua/src/artifacts/tests/artifactMigration.live.test.js`** (2/2):
  existing classic artifacts migrated to the emulator, then read by an instance
  with an empty disk. See the artifact migration readiness report.
- **Artifact unit and route suites:** 127/127 after the read-path changes.
- **Phase 2c multi-instance store suite:** passing (Postgres object store).

## 3. Deletion and account purge

- `deleteArtifact` → the partition row is tombstoned and
  `deletePrefix(owner, "artifacts/<id>/")` runs. Tested on the emulator: no
  object left.
- Account purge calls `deleteArtifact` for each of the owner's artifacts: the
  same path. The Phase 3 deletion marker blocks any write-back of the account's
  data.
- **Recovery window.** The bucket design keeps **soft delete** (7 days, a bucket
  setting). An accidental delete is recoverable by an operator; the application
  never relies on it.

## 4. Rollback strategy

- **Before the switch** (artifacts still local): the upload is additive. Delete
  the uploaded objects or leave them; nothing reads them.
- **After the switch:** set `AQUA_OBJECT_STORE=pg` or turn `artifacts` off.
  - The original local directory is kept untouched until verification is signed
    off.
  - The partition rows export back to the index shape:
    `artifact-migration.mjs export`.
- Objects are write-once and never overwritten, so no object can be partially
  replaced by a rollback.

## 5. Not tested / not done

- **A real GCS bucket:** IAM, the metadata server, real `412`s, latency,
  regional egress. The emulator and the fake cover the protocol, not Google's
  service.
- Resumable uploads for very large files. The multipart upload is used; files
  are ≤ 25 MB by quota.
- Signed URLs (downloads stream through the API).
- Platform uploads (`public/uploads`: tool logos, APK) still live on local disk.
- Load: concurrent streaming downloads per instance.
