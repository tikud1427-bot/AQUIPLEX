"use strict";

/**
 * aquiplex/services/command.service.js
 *
 * Stub — created to fix MODULE_NOT_FOUND crash on startup.
 * Replace stub bodies with real logic as needed.
 */

const { createLogger } = require("../utils/logger");
const log = createLogger("COMMAND_SVC");

/**
 * executeCommand(command, context) → { success, result, error }
 */
async function executeCommand(command, context = {}) {
  log.info(`executeCommand: ${command}`);
  return { success: true, result: null, error: null };
}

/**
 * parseCommand(input) → { command, args }
 */
function parseCommand(input = "") {
  const [command, ...args] = input.trim().split(/\s+/);
  return { command: command || "", args };
}

/**
 * registerCommand(name, handler) — no-op stub
 */
function registerCommand(name, handler) {
  log.info(`registerCommand: ${name} (stub — not persisted)`);
}

module.exports = { executeCommand, parseCommand, registerCommand };
