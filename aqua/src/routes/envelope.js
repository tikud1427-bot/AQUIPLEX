/**
 * AQUIPLEX — E11 API Consolidation, foundation piece.
 *
 * ONE response envelope, ONE error taxonomy, for the AQUA engine's own
 * `/api/aqua/*` surface (`src/routes/*`). Scoped deliberately: the wider
 * app (billing, account) is a different product surface and out of scope
 * for this blueprint.
 *
 * WHY THIS SHAPE, NOT A NEW ONE
 * ------------------------------
 * The routes already agree, informally, on `{ success: true, ...data }` for
 * success and `{ success: false, error: '<message>' }` for failure — most
 * of chat.js, conversations.js and health.js already do this. Compose over
 * replacement: this codifies that shape and adds the one thing genuinely
 * missing — a closed error-code taxonomy — as an ADDITIVE field. No
 * existing consumer parsing `success`/`error` breaks; `code` is new.
 *
 * MIGRATION, NOT A REWRITE
 * ------------------------
 * This file only adds `ok()`/`fail()`. It does not touch any route yet.
 * Each route file adopts it as its own PR — start with read-only, low-
 * traffic surfaces (health.js), leave high-traffic ones (chat.js,
 * project.js) for last, with frontend coordination, per the blueprint's
 * own "migrate consumers before removal" rule.
 */

export const ErrorCodes = Object.freeze({
  BAD_REQUEST:  'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN:    'forbidden',
  NOT_FOUND:    'not_found',
  CONFLICT:     'conflict',
  INTERNAL:     'internal',
});

const STATUS_FOR_CODE = Object.freeze({
  [ErrorCodes.BAD_REQUEST]:  400,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.FORBIDDEN]:    403,
  [ErrorCodes.NOT_FOUND]:    404,
  [ErrorCodes.CONFLICT]:     409,
  [ErrorCodes.INTERNAL]:     500,
});

/** Success envelope. `data` is spread onto the envelope, matching the
 *  existing `{ success: true, ...payload }` convention exactly. */
export function ok(res, data = {}) {
  return res.json({ success: true, ...data });
}

/** Error envelope. `code` must be one of ErrorCodes; unknown codes fall
 *  back to 500/internal rather than throwing, so a typo degrades safely
 *  instead of crashing the request it was reporting an error on. */
export function fail(res, code, message, extra = {}) {
  const status = STATUS_FOR_CODE[code] ?? STATUS_FOR_CODE[ErrorCodes.INTERNAL];
  const safeCode = STATUS_FOR_CODE[code] ? code : ErrorCodes.INTERNAL;
  return res.status(status).json({ success: false, code: safeCode, error: message, ...extra });
}
