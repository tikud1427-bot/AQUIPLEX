const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────────────────────────

const DecisionSchema = new mongoose.Schema({
  stepIndex:   { type: Number, required: true },
  question:    { type: String, default: "" },
  chosen:      { type: String, default: "" },
  rationale:   { type: String, default: "" },
  timestamp:   { type: Date,   default: Date.now },
}, { _id: false });

const OutputSchema = new mongoose.Schema({
  stepIndex:   { type: Number, required: true },
  title:       { type: String, default: "" },
  content:     { type: String, default: "" },           // Full AI-generated deliverable
  keyInsights: { type: [String], default: [] },         // Extracted insights fed to next step
  nextStepHints: { type: [String], default: [] },       // Dynamic refinements for following steps
  tokensUsed:  { type: Number, default: 0 },
  executedAt:  { type: Date,   default: Date.now },
  durationMs:  { type: Number, default: 0 },
}, { _id: false });

const ProgressSchema = new mongoose.Schema({
  step:   { type: Number, required: true },
  status: {
    type:    String,
    enum:    ["pending", "in-progress", "completed", "failed"],
    default: "pending",
  },
  startedAt:   { type: Date },
  completedAt: { type: Date },
}, { _id: false });

// ─────────────────────────────────────────────────────────────────────────────
// Core Bundle Schema
// ─────────────────────────────────────────────────────────────────────────────

const BundleSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "User",
      required: true,
      index: true,
    },

    // ── Identity ──────────────────────────────────────────────────────────────
    title:       { type: String, required: true, trim: true },
    goal:        { type: String, default: "" },      // Raw user goal fed into context engine
    answers:     { type: [String], default: [] },    // Onboarding answers from step 1

    // ── Steps (static plan) ───────────────────────────────────────────────────
    steps: { type: Array, default: [] },

    // ── Execution memory ──────────────────────────────────────────────────────
    decisions:      { type: [DecisionSchema], default: [] },
    outputs:        { type: [OutputSchema],   default: [] },
    progress:       { type: [ProgressSchema], default: [] },

    // ── Context engine ────────────────────────────────────────────────────────
    // Rolling summary kept under ~500 tokens — injected at the top of every step prompt
    contextSummary: { type: String, default: "" },

    // Persistent key-value memory that grows across executions
    // e.g. { "target_audience": "indie hackers", "tech_stack": "Node + React" }
    memory: {
      type: Map,
      of:   String,
      default: {},
    },

    // ── State ─────────────────────────────────────────────────────────────────
    currentStep: { type: Number, default: 0 },
    status: {
      type:    String,
      enum:    ["draft", "active", "completed", "paused"],
      default: "draft",
    },
    completedAt: { type: Date },
  },
  {
    timestamps: true,        // createdAt, updatedAt
    minimize:   false,       // preserve empty Maps
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Virtuals
// ─────────────────────────────────────────────────────────────────────────────

BundleSchema.virtual("completionPercent").get(function () {
  if (!this.steps || this.steps.length === 0) return 0;
  const done = this.progress.filter((p) => p.status === "completed").length;
  return Math.round((done / this.steps.length) * 100);
});

BundleSchema.virtual("lastOutput").get(function () {
  if (!this.outputs || this.outputs.length === 0) return null;
  return this.outputs[this.outputs.length - 1];
});

BundleSchema.set("toJSON",   { virtuals: true });
BundleSchema.set("toObject", { virtuals: true });

// ─────────────────────────────────────────────────────────────────────────────
// Instance helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark a step as started.
 */
BundleSchema.methods.markStepStarted = function (stepIndex) {
  const p = this.progress.find((p) => p.step === stepIndex);
  if (p) {
    p.status    = "in-progress";
    p.startedAt = new Date();
  }
  this.currentStep = stepIndex;
  this.status      = "active";
};

/**
 * Mark a step as completed and persist its output.
 */
BundleSchema.methods.markStepCompleted = function (stepIndex, outputData) {
  const p = this.progress.find((p) => p.step === stepIndex);
  if (p) {
    p.status      = "completed";
    p.completedAt = new Date();
  }

  // Remove old output for this step (re-execution support)
  this.outputs = this.outputs.filter((o) => o.stepIndex !== stepIndex);
  this.outputs.push({ stepIndex, ...outputData });

  // Advance pointer
  const nextStep = stepIndex + 1;
  if (nextStep < this.steps.length) {
    this.currentStep = nextStep;
  } else {
    this.status      = "completed";
    this.completedAt = new Date();
  }
};

/**
 * Append a key insight into the persistent memory map.
 */
BundleSchema.methods.mergeMemory = function (newEntries = {}) {
  for (const [k, v] of Object.entries(newEntries)) {
    if (k && v) this.memory.set(k.trim(), String(v).trim());
  }
};

module.exports = mongoose.model("Bundle", BundleSchema);
