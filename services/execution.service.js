"use strict";
/**
 * execution.service.js
 * FIXED: This file was missing — /bundle/:id/run crashed with MODULE_NOT_FOUND.
 */

const Bundle = require("../models/Bundle");

async function runBundle(bundleId, generateAI) {
  const bundle = await Bundle.findById(bundleId);
  if (!bundle) throw new Error("Bundle not found");

  bundle.status = "running";
  await bundle.save();

  const results = [];
  for (let i = 0; i < bundle.steps.length; i++) {
    const step = bundle.steps[i];
    try {
      const raw = await generateAI([
        { role: "system", content: `You are an expert project executor. Execute this step and produce a detailed deliverable.` },
        { role: "user",   content: `Project: ${bundle.title}\nGoal: ${bundle.goal}\n\nStep ${i + 1}: ${step.title}\n${step.description}` },
      ], { temperature: 0.6, maxTokens: 1200 });

      results.push({ stepIndex: i, title: step.title, content: raw, status: "completed" });

      // Update progress
      if (bundle.progress && bundle.progress[i]) {
        bundle.progress[i].status      = "completed";
        bundle.progress[i].completedAt = new Date();
      }
    } catch (err) {
      results.push({ stepIndex: i, title: step.title, content: "", status: "failed", error: err.message });
      if (bundle.progress && bundle.progress[i]) {
        bundle.progress[i].status = "failed";
      }
    }
  }

  bundle.status = "completed";
  bundle.outputs = results.map((r, i) => ({
    stepIndex:  r.stepIndex,
    title:      r.title,
    content:    r.content,
    executedAt: new Date(),
  }));
  await bundle.save();

  return bundle;
}

module.exports = { runBundle };
