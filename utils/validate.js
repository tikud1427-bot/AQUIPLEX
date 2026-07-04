"use strict";

/**
 * utils/validate.js — Input validation helpers for AQUIPLEX routes
 */

/**
 * validateAquaExecute — validates POST /aqua/execute body
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAquaExecute({ message, projectId, fileName } = {}) {
  if (!message || typeof message !== "string" || !message.trim()) {
    return { valid: false, error: "message is required and must be a non-empty string" };
  }
  if (message.trim().length > 4000) {
    return { valid: false, error: "message must be under 4000 characters" };
  }
  if (projectId !== undefined && projectId !== null) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      return { valid: false, error: "projectId must be a non-empty string" };
    }
  }
  if (fileName !== undefined && fileName !== null) {
    if (typeof fileName !== "string" || !fileName.trim()) {
      return { valid: false, error: "fileName must be a non-empty string" };
    }
    // Block path traversal
    if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      return { valid: false, error: "fileName contains invalid characters" };
    }
  }
  return { valid: true };
}

/**
 * validateSaveFile — validates POST /workspace/save-file body
 */
function validateSaveFile({ projectId, fileName, content } = {}) {
  if (!projectId || typeof projectId !== "string" || !projectId.trim()) {
    return { valid: false, error: "projectId is required" };
  }
  if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
    return { valid: false, error: "fileName is required" };
  }
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return { valid: false, error: "fileName contains invalid characters" };
  }
  if (content === undefined || content === null) {
    return { valid: false, error: "content is required" };
  }
  return { valid: true };
}

/**
 * validateEditFile — validates POST /workspace/edit-file body
 */
function validateEditFile({ projectId, fileName, instruction } = {}) {
  if (!projectId || typeof projectId !== "string" || !projectId.trim()) {
    return { valid: false, error: "projectId is required" };
  }
  if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
    return { valid: false, error: "fileName is required" };
  }
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return { valid: false, error: "fileName contains invalid characters" };
  }
  if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
    return { valid: false, error: "instruction is required" };
  }
  return { valid: true };
}

module.exports = { validateAquaExecute, validateSaveFile, validateEditFile };
