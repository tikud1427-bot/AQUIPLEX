/**
 * AQUA — workspace access rule (one rule, every entry point)
 *
 * /project/workspace/:id enforced ownership through router.param, but POST
 * /chat and /chat/stream took `workspaceId` straight from the request body and
 * handed it to project retrieval, semantic file scoring, the patch-first edit
 * branch and artifact turns — so any signed-in user holding another user's
 * workspace id could pull that workspace's source into their own answer or
 * propose edits against it (audit 2026-10-12). The two entry points had two
 * copies of "who may use this workspace"; one of them was empty.
 *
 * Same contract as conversations: a platform session may touch only workspaces
 * its owner created; no session (dev/standalone) enforces nothing; a legacy
 * workspace with a null ownerId is invisible to signed-in callers.
 */
import { getWorkspace } from './workspaceManager.js';
import { ownerForUser } from '../memory/ownerResolver.js';

/** True when `userId`'s session may read or act on workspace `workspaceId`. */
export function canAccessWorkspace(userId, workspaceId) {
  if (!workspaceId) return false;
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return false;
  if (!userId) return true;   // dev/standalone: no platform session, nothing to scope by
  return workspace.ownerId === ownerForUser(userId);
}

/**
 * The workspace id a chat turn may use: the requested one when accessible,
 * otherwise null — the turn proceeds exactly as a turn without a workspace.
 * Null rather than an error: the client remembers conversation→workspace links
 * locally, so a stale or deleted link must not break the conversation, and a
 * foreign id and a nonexistent id must be indistinguishable (no oracle).
 */
export function authorizedWorkspaceId(userId, workspaceId) {
  return canAccessWorkspace(userId, workspaceId) ? workspaceId : null;
}
