/**
 * AQUA Account Purge — engine-side erasure for account deletion
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *   Google Play's User Data policy requires that an in-app account deletion
 *   removes the account AND the data associated with it. The platform owns the
 *   Mongo side (user, wallet, billing, sessions — see
 *   services/account/accountDeletion.service.js); THIS module owns everything
 *   the AQUA engine accumulated for that user across its own stores.
 *
 * DESIGN
 *   Composition, not redesign. Every store already knows how to drop an owner
 *   (or gained a small `purgeOwner` in this change, matching its existing
 *   `clear*`/`remove*` shape). This module only sequences those calls for one
 *   identity and reports what it removed.
 *
 *   Identity: the platform userId maps to ownerId `user:<id>` via the single
 *   owner model in memory/ownerResolver.js. Pre-login conversations resolve to
 *   `conv:<conversationId>` owners, so every conversation the user owns is
 *   ALSO purged under its conv-scoped owner — otherwise an un-adopted mind
 *   (created before the session existed) would outlive the deletion.
 *
 * FAIL-SOFT, NEVER FAIL-SILENT
 *   Each step is isolated: one failing store can never abort the rest of the
 *   erasure (partial deletion beats no deletion). Failures are collected in
 *   `errors[]` and returned, so the caller can log them, surface a warning,
 *   and retry. A non-empty `errors[]` means "not fully erased" — callers MUST
 *   treat it as a failure of the deletion contract, not a warning to ignore.
 */
import { ownerForUser, ownerForConversation } from '../memory/ownerResolver.js';
import {
  listConversationIdsForUser,
  purgeConversation,
  purgeTrashForUser,
} from '../memory/conversationStore.js';
import { purgeTracesForOwner } from '../memory/engine.js';
import { clearAttachments } from '../upload/attachmentStore.js';
import { deleteMind } from '../mind/mindStore.js';
import { clearOwnerFileChunks } from '../embeddings/fileMemory.js';
import { purgeOwner as purgeUKOs } from '../files/ukoStore.js';
import { purgeOwner as purgeEvidence } from '../files/evidenceStore.js';
import { purgeOwner as purgeFileIndex } from '../files/fileSearchIndex.js';
import { purgeOwner as purgeReasoningGraph } from '../reasoning/reasoningGraph.js';
import { purgeOwner as purgePic } from '../pic/picStore.js';
import { purgeOwner as purgeBrain } from '../brain/index.js';
// E5/PR-6 — the claim shadow path writes owner-scoped rows to Postgres. It
// no-ops when DATABASE_URL is absent rather than reporting an erasure failure
// for a database the deployment never had.
import { purgeOwner as purgeClaims } from '../core/claims/claimRepository.js';
// P0.1 — the canonical world model (entities/edges/events/lifecycle/revisions/
// corrections/belief_claims/evidence/sources/commit_ledger/outbox/embeddings)
// had NO purge path at all until this change; see the comments at each
// function's definition for why this is two calls, one before and one after
// claimRepository, rather than one. FK order, not style: aqua_edges/
// aqua_events/aqua_belief_claims REFERENCE aqua_claims (must go first),
// aqua_claims REFERENCES aqua_entities (must go last).
import {
  purgeOwner as purgeWorldModelPreClaims,
  purgeOwnerEntities,
} from '../core/worldModel/worldModelRepository.js';
import { purgeOwner as purgeEmbeddings } from '../core/worldModel/embeddingRepository.js';
// This one's purgeOwner already existed and was already correct — it just had
// no caller. purgeCompleteness.test.js was red on the *original* repository
// (checked against the pristine tree before any change in this pass) because
// of exactly this: aqua_jobs has had a working purge function with nothing
// wiring it in.
import { purgeOwner as purgeJobs } from '../core/jobs/jobQueue.js';
import { listArtifacts, deleteArtifact } from '../artifacts/artifactStore.js';
import { listWorkspaces, deleteWorkspace } from '../project/workspaceManager.js';
import { clearIndex } from '../project/projectIndex.js';
import { clearCallGraph } from '../project/callGraph.js';
import { clearSymbolGraph } from '../project/symbolGraph.js';
import { clearGraph as clearDependencyGraph } from '../project/dependencyGraph.js';
import { clearCheckpoints } from '../project/checkpointEngine.js';

/** Run one erasure step in isolation — a thrown error never aborts the rest. */
function step(report, name, fn) {
  try {
    return fn();
  } catch (err) {
    report.errors.push(`${name}: ${err.message}`);
    return null;
  }
}

/** Same, for steps that await (artifact removal touches the filesystem). */
async function stepAsync(report, name, fn) {
  try {
    return await fn();
  } catch (err) {
    report.errors.push(`${name}: ${err.message}`);
    return null;
  }
}

/**
 * Erase every trace of one platform user from the AQUA engine.
 *
 * @param {object}  args
 * @param {string}  args.userId  platform user id (Mongo ObjectId as a string)
 * @returns {Promise<{
 *   ownerId: string, conversations: number, attachments: number,
 *   artifacts: number, workspaces: number, ukos: number,
 *   evidence: { facts: number, evidence: number },
 *   indexedFiles: number, graph: { nodes: number, edges: number },
 *   picSubjects: number, mind: boolean, traces: number, trashed: number,
 *   claims: number, worldModel: object|null, entities: object|null,
 *   embeddings: number, jobs: number,
 *   errors: string[]
 * }>}
 */
export async function purgeOwnerData({ userId } = {}) {
  if (!userId) throw new Error('purgeOwnerData requires a userId');

  const ownerId = ownerForUser(String(userId));
  const report = {
    ownerId,
    conversations: 0,
    attachments: 0,
    artifacts: 0,
    workspaces: 0,
    ukos: 0,
    evidence: { facts: 0, evidence: 0 },
    indexedFiles: 0,
    graph: { nodes: 0, edges: 0 },
    picSubjects: 0,
    mind: false,
    traces: 0,
    trashed: 0,
    claims: 0,
    worldModel: null,
    entities: null,
    embeddings: 0,
    jobs: 0,
    errors: [],
  };

  // ── 1. Conversations + their attachments + any un-adopted conv-scoped mind ──
  const conversationIds = step(report, 'conversations:list', () =>
    listConversationIdsForUser(userId)) ?? [];

  for (const id of conversationIds) {
    step(report, `attachments:${id}`, () => {
      if (clearAttachments(id)) report.attachments++;
    });
    // A conversation started before login owns its own mind + vector
    // namespaces under `conv:<id>`; deleteMind cascades both.
    step(report, `mind:conv:${id}`, () => deleteMind(ownerForConversation(id)));
    step(report, `conversation:${id}`, () => {
      if (purgeConversation(id)) report.conversations++;
    });
  }

  // Conversations this user deleted EARLIER still sit in the rolling trash
  // snapshot — an account deletion has to take those too.
  report.trashed = step(report, 'conversations:trash', () => purgeTrashForUser(userId)) ?? 0;

  // ── 2. Mind: facts, beliefs, goals, episodes, relationships, timeline ──────
  // deleteMind also cascades the owner's vector namespaces (`<owner>` and
  // `files:<owner>`) — the GDPR cascade that already existed.
  report.mind = step(report, 'mind', () => deleteMind(ownerId)) ?? false;
  step(report, 'fileChunks', () => clearOwnerFileChunks(ownerId));

  // ── 3. File intelligence: UKOs, evidence, search index, reasoning graph ────
  report.ukos = step(report, 'ukos', () => purgeUKOs(ownerId)) ?? 0;
  report.evidence = step(report, 'evidence', () => purgeEvidence(ownerId))
    ?? { facts: 0, evidence: 0 };
  report.indexedFiles = step(report, 'fileIndex', () => purgeFileIndex(ownerId)) ?? 0;
  report.graph = step(report, 'reasoningGraph', () => purgeReasoningGraph(ownerId))
    ?? { nodes: 0, edges: 0 };

  // ── 4. Persistent Intelligence Core + Brain world-model annotations ────────
  report.picSubjects = step(report, 'pic', () => purgePic(ownerId)) ?? 0;
  // Brain sidecar holds only annotations (no knowledge), but once a user has
  // written entity descriptions they are personal data and must be erased too.
  report.brainAnnotations = step(report, 'brain', () => purgeBrain(ownerId))?.annotations ?? 0;
  // E5/PR-6 — claim shadow rows. Async because Postgres is.
  // P0.1 — world-model rows that REFERENCE claims (edges, events,
  // belief_claims) must be gone before claims are deleted, or the DELETE on
  // aqua_claims hits a FK RESTRICT and the whole engine purge reports a
  // failure instead of quietly leaving orphans. This step, then claims, then
  // entities (below) — that order is load-bearing, see worldModelRepository.js.
  report.worldModel = (await stepAsync(report, 'worldModelPreClaims',
    () => purgeWorldModelPreClaims(ownerId))) ?? null;
  report.claims = (await stepAsync(report, 'claims', () => purgeClaims(ownerId)))?.claims ?? 0;
  // Entities can only be deleted once claims (which reference them) are gone.
  report.entities = (await stepAsync(report, 'worldModelEntities',
    () => purgeOwnerEntities(ownerId))) ?? null;
  report.embeddings = (await stepAsync(report, 'embeddings',
    () => purgeEmbeddings(ownerId)))?.embeddings ?? 0;
  report.jobs = (await stepAsync(report, 'jobs', () => purgeJobs(ownerId)))?.jobs ?? 0;

  // ── 5. Generated artifacts (manifest index + files on disk) ───────────────
  const artifacts = step(report, 'artifacts:list', () => listArtifacts({ ownerId })) ?? [];
  for (const a of artifacts) {
    const ok = await stepAsync(report, `artifact:${a.id}`, () => deleteArtifact(a.id));
    if (ok) report.artifacts++;
  }

  // ── 6. Uploaded projects / workspaces and every derived index ─────────────
  const workspaces = step(report, 'workspaces:list', () =>
    listWorkspaces().filter(ws => ws?.ownerId === ownerId)) ?? [];

  for (const ws of workspaces) {
    step(report, `workspace:${ws.id}`, () => {
      clearIndex(ws.id);
      clearCallGraph(ws.id);
      clearSymbolGraph(ws.id);
      clearDependencyGraph(ws.id);
      clearCheckpoints(ws.id);
      if (deleteWorkspace(ws.id)) report.workspaces++;
    });
  }

  // ── 7. In-process Inspector traces (never persisted, but hold fact values) ─
  report.traces = step(report, 'traces', () => purgeTracesForOwner(ownerId)) ?? 0;

  console.log(
    `[ACCOUNT] Purged engine data owner=${ownerId} conversations=${report.conversations} ` +
    `artifacts=${report.artifacts} workspaces=${report.workspaces} ukos=${report.ukos} ` +
    `errors=${report.errors.length}`,
  );

  return report;
}