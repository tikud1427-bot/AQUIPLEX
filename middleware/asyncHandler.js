"use strict";

/**
 * middleware/asyncHandler.js — Error-safe async route wrapper + response helpers
 */

/**
 * asyncHandler — wraps async route handlers to catch all unhandled rejections.
 * Forwards errors to Express error middleware instead of crashing.
 *
 * @param {Function} fn  async (req, res, next) handler
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Standardized success response
 * @param {Response} res
 * @param {any}      data
 * @param {string}   [message]
 * @param {number}   [status=200]
 */
function sendSuccess(res, data, message, status = 200) {
  const body = { success: true };
  if (message !== undefined) body.message = message;
  if (data    !== undefined) body.data    = data;
  return res.status(status).json(body);
}

/**
 * Standardized error response
 * @param {Response} res
 * @param {string}   error
 * @param {number}   [status=500]
 */
function sendError(res, error, status = 500) {
  return res.status(status).json({ success: false, error });
}

/**
 * Global Express error handler — mount LAST in app.
 */
function globalErrorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const { createLogger } = require("../utils/logger");
  const log = createLogger("ERROR_HANDLER");
  log.error(err.message, err.stack);

  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  const message =
    err.code === "LIMIT_FILE_SIZE"        ? "File too large. Maximum 10 MB." :
    err.message?.includes("not found")    ? err.message :
    err.message?.includes("Unauthorized") ? err.message :
    "Internal server error";

  return res.status(status).json({ success: false, error: message });
}

module.exports = { asyncHandler, sendSuccess, sendError, globalErrorHandler };