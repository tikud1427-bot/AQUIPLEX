"use strict";

/**
 * utils/logger.js — Structured logger for AQUIPLEX
 * Replaces all console.log calls with leveled, prefixed output.
 */

const LEVELS = { info: "INFO", warn: "WARN", error: "ERROR" };

function format(level, namespace, ...args) {
  const ts  = new Date().toISOString();
  const msg = args
    .map(a => (typeof a === "object" ? JSON.stringify(a) : String(a)))
    .join(" ");
  return `[${ts}] [${level}] [${namespace}] ${msg}`;
}

function createLogger(namespace = "APP") {
  return {
    info:  (...a) => console.log(format(LEVELS.info,  namespace, ...a)),
    warn:  (...a) => console.warn(format(LEVELS.warn,  namespace, ...a)),
    error: (...a) => console.error(format(LEVELS.error, namespace, ...a)),
  };
}

module.exports = { createLogger };
