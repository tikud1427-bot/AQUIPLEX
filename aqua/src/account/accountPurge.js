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

  // ── 4. Persistent Intelligence Core ───────────────────────────────────────
  report.picSubjects = step(report, 'pic', () => purgePic(ownerId)) ?? 0;

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
