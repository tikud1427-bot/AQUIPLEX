/**
 * models/Workspace.js — AQUIPLEX Production
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
      type: String,
      enum: ["running", "paused", "completed", "failed"],
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
    createdAt:   { type: Date, default: Date.now },
  },
  { _id: false }
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

    tools:          [{ type: mongoose.Schema.Types.ObjectId, ref: "Tool" }],
    activeBundles:  [{ type: mongoose.Schema.Types.ObjectId, ref: "Bundle" }],
    pinnedBundles:  [{ type: mongoose.Schema.Types.ObjectId, ref: "Bundle" }],

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

WorkspaceSchema.methods.openSession = function (bundleId, totalSteps) {
  const id  = bundleId.toString();
  const existing = this.executionSessions.find(
    (s) => s.bundleId && s.bundleId.toString() === id
  );

  if (existing) {
    existing.lastActiveAt = new Date();
    existing.status       = "running";
    existing.totalSteps   = totalSteps || existing.totalSteps;
  } else {
    this.executionSessions.push({
      bundleId:   bundleId,
      status:     "running",
      totalSteps: totalSteps || 0,
    });
    if (this.executionSessions.length > 10) {
      this.executionSessions = this.executionSessions.slice(-10);
    }
  }

  const alreadyActive = this.activeBundles.some((aid) => aid && aid.toString() === id);
  if (!alreadyActive) this.activeBundles.push(bundleId);
};

WorkspaceSchema.methods.updateSession = function (bundleId, patch = {}) {
  const id      = bundleId.toString();
  const session = this.executionSessions.find(
    (s) => s.bundleId && s.bundleId.toString() === id
  );
  if (!session) return;
  if (patch.status      !== undefined) session.status      = patch.status;
  if (patch.currentStep !== undefined) session.currentStep = patch.currentStep;
  session.lastActiveAt = new Date();
};

WorkspaceSchema.methods.closeSession = function (bundleId, status = "completed") {
  const id = bundleId.toString();
  this.updateSession(bundleId, { status });
  if (status === "completed") {
    this.activeBundles = this.activeBundles.filter(
      (aid) => aid && aid.toString() !== id
    );
  }
};

WorkspaceSchema.methods.pushRecentOutput = function (entry) {
  this.recentOutputs.unshift({
    bundleId:    entry.bundleId,
    bundleTitle: entry.bundleTitle || "",
    stepIndex:   typeof entry.stepIndex === "number" ? entry.stepIndex : 0,
    stepTitle:   entry.stepTitle  || "",
    preview:     (entry.content   || "").substring(0, 300),
    createdAt:   new Date(),
  });
  if (this.recentOutputs.length > 20) {
    this.recentOutputs = this.recentOutputs.slice(0, 20);
  }
};

WorkspaceSchema.methods.mergeWorkspaceMemory = function (newEntries = {}) {
  if (!newEntries || typeof newEntries !== "object") return;
  for (const [k, v] of Object.entries(newEntries)) {
    if (k && v !== undefined && v !== null) {
      this.workspaceMemory.set(k.trim(), String(v).trim());
    }
  }
};

module.exports = mongoose.model("Workspace", WorkspaceSchema);
