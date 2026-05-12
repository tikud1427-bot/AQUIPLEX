/**
 * models/Workspace.js — AQUIPLEX Production
 * Canonical single model. Workspace__1_.cjs (legacy stub) is superseded by this file.
 */

"use strict";

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────────────────────────

const ExecutionSessionSchema = new mongoose.Schema(
  {
    bundleId:     { type: mongoose.Schema.Types.ObjectId, ref: "Bundle", required: true },
    startedAt:    { type: Date, default: Date.now },
    lastActiveAt: { type: Date, default: Date.now },
    status: {
      type:    String,
      enum:    ["running", "paused", "completed", "failed"],
      default: "running",
    },
    currentStep: { type: Number, default: 0 },
    totalSteps:  { type: Number, default: 0 },
  },
  { _id: true }
);

const RecentOutputSchema = new mongoose.Schema(
  {
    bundleId:    { type: mongoose.Schema.Types.ObjectId, ref: "Bundle" },
    bundleTitle: { type: String, default: "" },
    stepIndex:   { type: Number, default: 0 },
    stepTitle:   { type: String, default: "" },
    preview:     { type: String, default: "" },
    createdAt:   { type: Date,   default: Date.now },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Embedded Tool Sub-schema
// Keeps a lightweight snapshot of tool metadata directly on Workspace so
// the sidebar can render without a separate Tool population query.
// ─────────────────────────────────────────────────────────────────────────────
const WorkspaceToolSchema = new mongoose.Schema(
  {
    toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", required: true },
    name:   { type: String, default: "" },
    url:    { type: String, default: "" },
    logo:   { type: String, default: "" },
  },
  { _id: true } // _id lets us delete by subdoc id from the frontend
);

// ─────────────────────────────────────────────────────────────────────────────
// Core Workspace Schema
// ─────────────────────────────────────────────────────────────────────────────

const WorkspaceSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      unique:   true,
      index:    true,
    },

    // Embedded tool snapshots — preferred over raw ObjectId refs for the sidebar
    tools:         { type: [WorkspaceToolSchema], default: [] },

    activeBundles: [{ type: mongoose.Schema.Types.ObjectId, ref: "Bundle" }],
    pinnedBundles: [{ type: mongoose.Schema.Types.ObjectId, ref: "Bundle" }],

    executionSessions: { type: [ExecutionSessionSchema], default: [] },
    recentOutputs:     { type: [RecentOutputSchema],    default: [] },

    workspaceMemory: {
      type:    Map,
      of:      String,
      default: {},
    },

    lastOpenBundleId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Bundle",
      default: null,
    },

    activeTab: {
      type:    String,
      enum:    ["bundles", "tools", "outputs", "memory"],
      default: "bundles",
    },
  },
  {
    timestamps: true,
    minimize:   false,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Instance Methods
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open or reactivate an execution session for a bundle.
 * Caps the session list at 10 (oldest removed).
 */
WorkspaceSchema.methods.openSession = function (bundleId, totalSteps) {
  const id       = bundleId.toString();
  const existing = this.executionSessions.find(
    (s) => s.bundleId && s.bundleId.toString() === id
  );

  if (existing) {
    existing.lastActiveAt = new Date();
    existing.status       = "running";
    if (totalSteps != null) existing.totalSteps = totalSteps;
  } else {
    this.executionSessions.push({ bundleId, status: "running", totalSteps: totalSteps || 0 });
    if (this.executionSessions.length > 10) {
      this.executionSessions = this.executionSessions.slice(-10);
    }
  }

  const alreadyActive = this.activeBundles.some(
    (aid) => aid && aid.toString() === id
  );
  if (!alreadyActive) this.activeBundles.push(bundleId);
};

/**
 * Update session fields. Noop if session not found.
 */
WorkspaceSchema.methods.updateSession = function (bundleId, patch = {}) {
  const id      = bundleId.toString();
  const session = this.executionSessions.find(
    (s) => s.bundleId && s.bundleId.toString() === id
  );
  if (!session) return;
  if (patch.status      != null) session.status      = patch.status;
  if (patch.currentStep != null) session.currentStep = patch.currentStep;
  session.lastActiveAt = new Date();
};

/**
 * Close session and optionally remove from activeBundles.
 */
WorkspaceSchema.methods.closeSession = function (bundleId, status = "completed") {
  const id = bundleId.toString();
  this.updateSession(bundleId, { status });
  if (status === "completed" || status === "failed") {
    this.activeBundles = this.activeBundles.filter(
      (aid) => aid && aid.toString() !== id
    );
  }
};

/**
 * Prepend a recent output, keeping the list capped at 20.
 */
WorkspaceSchema.methods.pushRecentOutput = function (entry) {
  this.recentOutputs.unshift({
    bundleId:    entry.bundleId,
    bundleTitle: entry.bundleTitle  || "",
    stepIndex:   typeof entry.stepIndex === "number" ? entry.stepIndex : 0,
    stepTitle:   entry.stepTitle   || "",
    preview:     (entry.content    || "").substring(0, 300),
    createdAt:   new Date(),
  });
  if (this.recentOutputs.length > 20) {
    this.recentOutputs = this.recentOutputs.slice(0, 20);
  }
};

/**
 * Merge key/value pairs into workspaceMemory.
 * Skips falsy keys and null/undefined values.
 */
WorkspaceSchema.methods.mergeWorkspaceMemory = function (newEntries = {}) {
  if (!newEntries || typeof newEntries !== "object") return;
  for (const [k, v] of Object.entries(newEntries)) {
    if (k && v != null) {
      this.workspaceMemory.set(k.trim(), String(v).trim());
    }
  }
};

/**
 * Add a tool snapshot. Prevents duplicate toolId entries.
 */
WorkspaceSchema.methods.addTool = function ({ toolId, name, url, logo }) {
  const alreadyAdded = this.tools.some(
    (t) => t.toolId && t.toolId.toString() === String(toolId)
  );
  if (!alreadyAdded) {
    this.tools.push({ toolId, name: name || "", url: url || "", logo: logo || "" });
  }
};

/**
 * Remove a tool by its subdoc _id (the id the frontend sends).
 * Falls back to matching by toolId if no subdoc _id matches.
 */
WorkspaceSchema.methods.removeTool = function (id) {
  const strId = String(id);
  const before = this.tools.length;

  // Try subdoc _id first
  this.tools = this.tools.filter(
    (t) => t._id && t._id.toString() !== strId
  );

  // If nothing removed, try toolId
  if (this.tools.length === before) {
    this.tools = this.tools.filter(
      (t) => t.toolId && t.toolId.toString() !== strId
    );
  }
};

module.exports = mongoose.model("Workspace", WorkspaceSchema);