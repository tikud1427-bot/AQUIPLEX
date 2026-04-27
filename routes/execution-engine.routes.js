/**
 * execution-engine.routes.js
 *
 * Mounts on the existing Express app.
 * Adds:
 *   POST /execute-step
 *   GET  /resume/:bundleId
 *   GET  /bundle-progress/:id
 *
 * Drop this file into your project root and wire it in index.js:
 *   const executionRoutes = require("./execution-engine.routes");
 *   executionRoutes(app, requireLogin, generateAI);   ← call once after middleware
 */

"use strict";

const mongoose = require("mongoose");
const Bundle   = require("../models/Bundle");

// ─────────────────────────────────────────────────────────────────────────────
// Context Engine — builds the deep prompt injected before every step
// ─────────────────────────────────────────────────────────────────────────────

function buildExecutionContext(bundle, stepIndex) {
  const step      = bundle.steps[stepIndex];
  const prevOutputs = bundle.outputs
    .filter((o) => o.stepIndex < stepIndex)
    .sort((a, b) => a.stepIndex - b.stepIndex);

  const decisions = bundle.decisions
    .filter((d) => d.stepIndex < stepIndex)
    .sort((a, b) => a.stepIndex - b.stepIndex);

  // Serialize persistent memory
  const memoryLines = [];
  if (bundle.memory && bundle.memory.size > 0) {
    for (const [k, v] of bundle.memory.entries()) {
      memoryLines.push(`  • ${k}: ${v}`);
    }
  }

  // Serialize outputs compactly — include full content only for the last 2 steps
  const outputLines = prevOutputs.map((o, i) => {
    const isFull = i >= prevOutputs.length - 2;
    const body   = isFull
      ? o.content
      : o.content.slice(0, 300) + (o.content.length > 300 ? "\n  [... truncated]" : "");
    return [
      `─── Step ${o.stepIndex + 1}: ${o.title} ───`,
      body,
      o.keyInsights.length ? `Key insights: ${o.keyInsights.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const decisionLines = decisions.map(
    (d) => `  Step ${d.stepIndex + 1} — ${d.question}: ${d.chosen} (rationale: ${d.rationale})`
  );

  // Dynamic hints from the immediately preceding step
  const hints = prevOutputs.length
    ? (prevOutputs[prevOutputs.length - 1].nextStepHints || [])
    : [];

  const hintBlock = hints.length
    ? `\n📌 REFINEMENT HINTS FOR THIS STEP (from prior AI analysis):\n${hints.map((h) => `  • ${h}`).join("\n")}`
    : "";

  return `
═══════════════════════════════════════════════════════════════
AQUA EXECUTION ENGINE — STEP ${stepIndex + 1} of ${bundle.steps.length}
═══════════════════════════════════════════════════════════════

🎯 USER GOAL:
${bundle.goal || bundle.title}

${bundle.answers && bundle.answers.length
  ? `📋 USER CONTEXT (onboarding answers):\n${bundle.answers.map((a, i) => `  Q${i + 1}: ${a}`).join("\n")}`
  : ""}

${memoryLines.length
  ? `🧠 PERSISTENT PROJECT MEMORY:\n${memoryLines.join("\n")}`
  : ""}

${bundle.contextSummary
  ? `📖 RUNNING CONTEXT SUMMARY:\n${bundle.contextSummary}`
  : ""}

${outputLines.length
  ? `📦 PREVIOUS STEP OUTPUTS:\n${"─".repeat(50)}\n${outputLines.join("\n\n")}\n${"─".repeat(50)}`
  : ""}

${decisionLines.length
  ? `⚖️ KEY DECISIONS MADE:\n${decisionLines.join("\n")}`
  : ""}
${hintBlock}

═══════════════════════════════════════════════════════════════
NOW EXECUTE — STEP ${stepIndex + 1}: ${step.title}
${step.description ? `Context: ${step.description}` : ""}
═══════════════════════════════════════════════════════════════
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Insight extractor — called after each step to grow memory
// ─────────────────────────────────────────────────────────────────────────────

async function extractInsights(generateAI, bundle, stepIndex, stepOutput) {
  const prompt = `
You are an AI analyst. A user is executing a multi-step project plan.

PROJECT GOAL: ${bundle.goal || bundle.title}
STEP ${stepIndex + 1} TITLE: ${bundle.steps[stepIndex].title}
STEP OUTPUT:
${stepOutput.slice(0, 2000)}

Your job:
1. Extract 3-5 KEY INSIGHTS from this output (facts, decisions, constraints, technical choices).
2. Extract 2-3 NEXT STEP HINTS that will make the following step more targeted.
3. Extract up to 5 MEMORY ENTRIES: short key=value pairs representing durable project facts.
4. Write a 2-sentence CONTEXT UPDATE that summarizes what has been accomplished so far.

Return ONLY valid JSON:
{
  "keyInsights": ["insight 1", "insight 2"],
  "nextStepHints": ["hint 1", "hint 2"],
  "memory": { "key": "value" },
  "contextUpdate": "2-sentence summary."
}
`.trim();

  try {
    const raw = await generateAI(
      [{ role: "user", content: prompt }],
      { temperature: 0.3, maxTokens: 800 }
    );
    const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON");
    return JSON.parse(match[0]);
  } catch {
    return {
      keyInsights:   [],
      nextStepHints: [],
      memory:        {},
      contextUpdate: "",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context summary updater — keeps the rolling summary under ~500 tokens
// ─────────────────────────────────────────────────────────────────────────────

async function updateContextSummary(generateAI, bundle, newUpdate) {
  if (!newUpdate) return bundle.contextSummary || "";

  const existing = bundle.contextSummary || "";
  if (!existing) return newUpdate;

  const prompt = `
Merge these two project context summaries into one coherent 3-sentence summary.
Keep it under 120 words. Preserve all important technical decisions and facts.

EXISTING: ${existing}
NEW UPDATE: ${newUpdate}

Return only the merged summary text. No preamble.
`.trim();

  try {
    const merged = await generateAI(
      [{ role: "user", content: prompt }],
      { temperature: 0.2, maxTokens: 200 }
    );
    return merged.trim();
  } catch {
    return newUpdate || existing;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main router factory
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function registerExecutionRoutes(app, requireLogin, generateAI) {

  // ── POST /execute-step ───────────────────────────────────────────────────
  // Executes one step of a saved bundle using full AI context.
  app.post("/execute-step", requireLogin, async (req, res) => {
    const { bundleId, stepIndex } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!bundleId || !mongoose.Types.ObjectId.isValid(bundleId)) {
      return res.status(400).json({ error: "Invalid bundleId" });
    }
    if (typeof stepIndex !== "number" || stepIndex < 0) {
      return res.status(400).json({ error: "stepIndex must be a non-negative integer" });
    }

    const startMs = Date.now();

    try {
      const bundle = await Bundle.findOne({
        _id:    bundleId,
        userId: req.session.userId,
      });

      if (!bundle)            return res.status(404).json({ error: "Bundle not found" });
      if (!bundle.steps[stepIndex]) {
        return res.status(400).json({ error: `Step ${stepIndex} does not exist` });
      }

      // ── Mark in-progress ────────────────────────────────────────────────
      bundle.markStepStarted(stepIndex);
      await bundle.save();

      // ── Build deep context prompt ────────────────────────────────────────
      const contextBlock = buildExecutionContext(bundle, stepIndex);
      const step         = bundle.steps[stepIndex];

      const executionPrompt = `
${contextBlock}

EXECUTION INSTRUCTIONS:
You are an AI operator executing Step ${stepIndex + 1} of a real project plan.
The user is counting on you for a concrete, professional deliverable — not advice.

Deliver:
- Actionable, ready-to-use output (code, copy, plan, framework, script, etc.)
- Specific to this user's goal and all prior context
- Structured clearly (use headers, lists, or code blocks as appropriate)
- Long enough to be genuinely useful (aim for 300-600 words)
- Zero filler, zero generic tips

Step title:       ${step.title}
Step description: ${step.description || "Infer from the goal and prior context."}

Begin your output now:
`.trim();

      // ── Execute step via AI ──────────────────────────────────────────────
      const output = await generateAI(
        [{ role: "user", content: executionPrompt }],
        { temperature: 0.65, maxTokens: 1500 }
      );

      const durationMs = Date.now() - startMs;

      // ── Extract insights & grow memory ──────────────────────────────────
      const insights = await extractInsights(generateAI, bundle, stepIndex, output);

      const newContextSummary = await updateContextSummary(
        generateAI,
        bundle,
        insights.contextUpdate
      );

      // ── Persist decision if insight extraction identified one ────────────
      if (insights.keyInsights.length) {
        // Record as a soft decision entry for context threading
        bundle.decisions.push({
          stepIndex,
          question:  `Key takeaway from step ${stepIndex + 1}`,
          chosen:    insights.keyInsights[0] || "",
          rationale: insights.keyInsights.slice(1).join(" | "),
        });
      }

      // ── Merge new memory ────────────────────────────────────────────────
      if (insights.memory && Object.keys(insights.memory).length) {
        bundle.mergeMemory(insights.memory);
      }

      // ── Update context summary ───────────────────────────────────────────
      bundle.contextSummary = newContextSummary;

      // ── Persist step output ──────────────────────────────────────────────
      bundle.markStepCompleted(stepIndex, {
        title:         step.title,
        content:       output,
        keyInsights:   insights.keyInsights   || [],
        nextStepHints: insights.nextStepHints || [],
        durationMs,
        tokensUsed:    0,   // extend here if your AI layer returns token counts
      });

      await bundle.save();

      // ── Stream-friendly response ─────────────────────────────────────────
      return res.json({
        success:          true,
        stepIndex,
        stepTitle:        step.title,
        output,
        keyInsights:      insights.keyInsights   || [],
        nextStepHints:    insights.nextStepHints || [],
        completionPercent: bundle.completionPercent,
        currentStep:      bundle.currentStep,
        status:           bundle.status,
        durationMs,
        memory:           Object.fromEntries(bundle.memory || new Map()),
        contextSummary:   bundle.contextSummary,
      });

    } catch (err) {
      console.error("❌ /execute-step error:", err);

      // Attempt to mark step as failed
      try {
        const bundle = await Bundle.findOne({ _id: bundleId, userId: req.session.userId });
        if (bundle) {
          const p = bundle.progress.find((p) => p.step === stepIndex);
          if (p) p.status = "failed";
          await bundle.save();
        }
      } catch (_) {}

      return res.status(500).json({ error: "Execution failed", message: err.message });
    }
  });

  // ── GET /resume/:bundleId ────────────────────────────────────────────────
  // Returns full bundle state so the client can resume without re-generating.
  app.get("/resume/:bundleId", requireLogin, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.bundleId)) {
        return res.status(400).json({ error: "Invalid bundleId" });
      }

      const bundle = await Bundle.findOne({
        _id:    req.params.bundleId,
        userId: req.session.userId,
      }).lean({ virtuals: true });

      if (!bundle) return res.status(404).json({ error: "Bundle not found" });

      // Reconstruct memory from POJO (lean loses the Map)
      const memoryObj = bundle.memory
        ? (bundle.memory instanceof Map
            ? Object.fromEntries(bundle.memory)
            : bundle.memory)
        : {};

      return res.json({
        success: true,
        bundle: {
          _id:              bundle._id,
          title:            bundle.title,
          goal:             bundle.goal,
          steps:            bundle.steps,
          progress:         bundle.progress,
          outputs:          bundle.outputs,
          decisions:        bundle.decisions,
          contextSummary:   bundle.contextSummary,
          memory:           memoryObj,
          currentStep:      bundle.currentStep,
          status:           bundle.status,
          completionPercent: bundle.completionPercent,
          createdAt:        bundle.createdAt,
          updatedAt:        bundle.updatedAt,
        },
      });
    } catch (err) {
      console.error("❌ /resume error:", err);
      return res.status(500).json({ error: "Failed to load bundle" });
    }
  });

  // ── GET /bundle-progress/:id ─────────────────────────────────────────────
  // Lightweight polling endpoint for live progress bars.
  app.get("/bundle-progress/:id", requireLogin, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid id" });
      }

      const bundle = await Bundle.findOne(
        { _id: req.params.id, userId: req.session.userId },
        "title steps progress outputs currentStep status contextSummary"
      ).lean({ virtuals: true });

      if (!bundle) return res.status(404).json({ error: "Bundle not found" });

      const done    = bundle.progress.filter((p) => p.status === "completed").length;
      const total   = bundle.steps.length;
      const percent = total ? Math.round((done / total) * 100) : 0;

      return res.json({
        success:    true,
        bundleId:   bundle._id,
        title:      bundle.title,
        status:     bundle.status,
        currentStep: bundle.currentStep,
        completionPercent: percent,
        stepsTotal: total,
        stepsDone:  done,
        progress:   bundle.progress,
        // Include only the titles + status of outputs for the sidebar
        outputSummaries: (bundle.outputs || []).map((o) => ({
          stepIndex: o.stepIndex,
          title:     o.title,
          executedAt: o.executedAt,
          durationMs: o.durationMs,
        })),
        contextSummary: bundle.contextSummary,
      });
    } catch (err) {
      console.error("❌ /bundle-progress error:", err);
      return res.status(500).json({ error: "Failed to fetch progress" });
    }
  });

  console.log("✅ Execution Engine routes registered: POST /execute-step | GET /resume/:id | GET /bundle-progress/:id");
};
