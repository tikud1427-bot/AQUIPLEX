/**
 * AQUA Autonomous Edit — verify→diagnose→repair→converge (Phase 4a)
 * ─────────────────────────────────────────────────────────────────────────────
 * proposeEdit() makes ONE model call, applies the patch in memory, runs static
 * verification (bracket balance, JSON validity, local-import resolution,
 * removed-export reference breakage), and returns the proposal — even when
 * verification FAILS. That leaves the user holding a broken patch.
 *
 * This module closes that loop. It drives proposeEdit in a bounded cycle: when
 * a proposal fails verification (or has operations that could not be applied),
 * it feeds the SPECIFIC failures back to the model as a corrective instruction
 * and asks for a fixed edit, re-verifying each attempt, until one passes or the
 * attempt budget is exhausted. This is the "edit → diagnose → repair → converge"
 * autonomy — done safely on STATIC verification, with no execution of untrusted
 * uploaded code (executable test-running belongs in a sandbox; see 4b).
 *
 * Safety / cost:
 *   - Non-mutating: like proposeEdit, it only produces proposals — nothing is
 *     applied to the workspace. The user still explicitly applies the result.
 *   - Bounded: at most `maxAttempts` model calls (default 3). Converges early
 *     the moment a proposal passes.
 *   - Fail-open: unrepairable structural errors (no workspace / not indexed / no
 *     targets located) are surfaced immediately — retrying cannot help. Every
 *     other outcome returns the BEST proposal produced (a passing one if any,
 *     else the last), so the caller always gets a usable result plus the full
 *     attempt history.
 *
 * Testable: proposeEdit is injected (`_propose`) so the loop's orchestration is
 * unit-tested offline without the model — the underlying proposeEdit LLM path
 * is already the router's concern and is covered by the edit suite.
 */
import { proposeEdit } from './editEngine.js';

const DEFAULT_MAX_ATTEMPTS = 3;

// Errors where a retry with feedback CAN help (the model produced something,
// it was just wrong/unusable). Structural errors (missing workspace, not
// indexed, no targets) are not in this set — they are rethrown immediately.
const REPAIRABLE_CODES = new Set(['BAD_EDIT_PLAN', 'ALL_OPS_FAILED']);

/** A proposal is "good" when static verification passed AND every op applied. */
function isClean(proposal) {
  return !!proposal?.verification?.passed && (proposal.failedOperations?.length ?? 0) === 0;
}

/**
 * Turn a failed attempt into concrete repair FEEDBACK for the model.
 *
 * These diagnostics quote repository-derived text — file
 * paths, export and module names, the model's own path strings, and parse
 * errors that can echo file or model content. They used to be appended to the
 * user's instruction, i.e. sent UNFENCED with the authority of the user. They
 * are now returned as a separate list; proposeEdit renders them inside the
 * untrusted fence, after the user's unchanged instruction, under AQUA's own
 * repair framing (editEngine.js REPAIR_FRAMING).
 *
 * @returns {string[]} one diagnostic per entry (empty when there is nothing to repair)
 */
export function buildRepairFeedback({ proposal, error } = {}) {
  const lines = [];
  if (error) lines.push(`The edit could not be applied: ${error}`);
  for (const w of proposal?.verification?.warnings ?? []) lines.push(String(w));
  for (const fo of proposal?.failedOperations ?? []) {
    lines.push(`${fo.file}: ${fo.error}${fo.suggestion ? ` (${fo.suggestion})` : ''}`);
  }
  return lines;
}

/**
 * Propose an edit, repairing static-verification failures autonomously.
 *
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.instruction
 * @param {string} [input.requestId]
 * @param {string} [input.conversationId]
 * @param {(id: string, label: string) => void} [input.onStage]
 * @param {number} [input.maxAttempts=3]
 * @param {Function} [input._propose]  injected proposeEdit (tests)
 * @returns {Promise<{
 *   ok: boolean, proposal: object|null, converged: boolean, repaired: boolean,
 *   attemptCount: number, attempts: Array<{ attempt, passed, warnings, failedOps, error }>
 * }>}
 * @throws structural errors (NO_WORKSPACE / NOT_INDEXED / NO_TARGETS) — unrepairable.
 */
export async function proposeEditWithRepair({
  workspaceId, instruction, requestId, conversationId, onStage = () => {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS, _propose = proposeEdit,
}) {
  const attempts = [];
  let bestProposal = null;
  // The user's instruction is sent unchanged on every attempt; repair
  // diagnostics travel separately as `feedback` (fenced by proposeEdit).
  let currentFeedback = [];
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) onStage('edit_repair', `Repairing patch (attempt ${attempt}/${maxAttempts})…`);

    let proposal = null;
    let errMsg = null;
    try {
      proposal = await _propose({ workspaceId, instruction, feedback: currentFeedback, requestId, conversationId, onStage });
    } catch (err) {
      // Structural errors cannot be repaired by retrying — surface immediately.
      if (!REPAIRABLE_CODES.has(err.code)) {
        if (attempt === 1) throw err;
        // Mid-loop structural error: stop and return the best we have.
        attempts.push({ attempt, passed: false, warnings: [], failedOps: [], error: err.message });
        break;
      }
      errMsg = err.message;
      lastError = err.message;
    }

    if (proposal) {
      bestProposal = proposal;   // most-recent usable proposal
      attempts.push({
        attempt,
        passed: isClean(proposal),
        warnings: proposal.verification?.warnings ?? [],
        failedOps: (proposal.failedOperations ?? []).map(f => `${f.file}: ${f.error}`),
        error: null,
      });

      if (isClean(proposal)) {
        return { ok: true, proposal, converged: true, repaired: attempt > 1, attemptCount: attempt, attempts };
      }
      lastError = null;
    } else {
      attempts.push({ attempt, passed: false, warnings: [], failedOps: [], error: errMsg });
    }

    // Not clean — prepare a corrective instruction for the next attempt.
    currentFeedback = buildRepairFeedback({ proposal: bestProposal, error: lastError });
    // A retry is always framed as a repair, even when no specific diagnostic exists.
    if (!currentFeedback.length) currentFeedback = ['The previous attempt did not pass static verification.'];
  }

  // Exhausted without a clean proposal. Return the best we produced (if any).
  return {
    ok: !!bestProposal,
    proposal: bestProposal,
    converged: false,
    repaired: attempts.length > 1 && !!bestProposal,
    attemptCount: attempts.length,
    attempts,
  };
}
