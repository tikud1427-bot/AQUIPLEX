/**
 * AQUA Connect — authenticated principal (G0, IS-1)
 *
 * The connect service never trusts a user id supplied by a client. A route
 * obtains a principal ONLY from the authenticated server-side request:
 *
 *   principalFromRequest(req)   req.aquaUserId is set by the platform's
 *                               /api/aqua access chain from req.session.userId
 *                               (index.js aquaAccess, after requireLogin); both
 *                               must be present and agree.
 *
 * A principal is an opaque frozen object registered in a module-private
 * WeakSet: a look-alike object built from request data ({ userId: '…' }) is
 * not a principal and is refused by the service. Body, query, params and
 * headers are never read here.
 *
 *   principalForServerJob(userId)  for trusted server-internal callers only
 *                                  (e.g. a scheduled sync that iterates
 *                                  connections already owned by userId). Never
 *                                  call it with request data.
 */

const issued = new WeakSet();

export class PrincipalError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function mint(userId) {
  const id = typeof userId === 'string' || typeof userId === 'number' ? String(userId).trim() : '';
  if (!id) throw new PrincipalError('UNAUTHENTICATED', 'an authenticated user is required');
  const p = Object.freeze({ userId: id });
  issued.add(p);
  return p;
}

/** The ONLY way a route may identify the caller. */
export function principalFromRequest(req) {
  const sessionUser = req?.session?.userId;
  const bound = req?.aquaUserId;
  if (sessionUser == null || bound == null || String(sessionUser) !== String(bound)) {
    throw new PrincipalError('UNAUTHENTICATED', 'an authenticated user is required');
  }
  return mint(bound);
}

/** Trusted server-internal callers only (never with request data). */
export function principalForServerJob(userId) {
  return mint(userId);
}

export function isPrincipal(p) {
  return p != null && typeof p === 'object' && issued.has(p);
}
