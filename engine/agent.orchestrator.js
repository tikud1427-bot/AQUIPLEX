"use strict";

/**
 * engine/agent.orchestrator.js — AQUIPLEX MULTI-AGENT ORCHESTRATION SYSTEM
 *
 * Coordinates specialized agents to build production-grade apps:
 *
 *   planner-agent    → creates structured architecture plan (JSON)
 *   frontend-agent   → generates HTML/CSS/JS from plan
 *   backend-agent    → generates server.js, routes, package.json
 *   repair-agent     → validates + fixes generated files
 *   deploy-agent     → generates deployment configs
 *
 * Each agent:
 *   - receives structured plan (not raw user prompt)
 *   - generates one file at a time (traceable)
 *   - updates project graph after each file
 *   - emits status events for real-time UI
 *
 * Replaces monolithic single-prompt generation.
 */

const ai          = require("./ai.core");
const planner     = require("./planner.agent");
const graph       = require("./graph.engine");
const repairEng   = require("./repair.engine");
const deployGen   = require("./deploy.generator");
const { createLogger } = require("../utils/logger");

const log = createLogger("AGENT_ORCH");

// ─────────────────────────────────────────────────────────────────────────────
// AGENT STATUS EMITTER
// helper to push status events to calling layer (routes → socket.io → UI)
// ─────────────────────────────────────────────────────────────────────────────

function makeEmitter(onStatus) {
  return function emit(agent, status, detail = "") {
    const event = { agent, status, detail, ts: Date.now() };
    log.info(`[${agent}] ${status}${detail ? ": " + detail : ""}`);
    if (typeof onStatus === "function") {
      try { onStatus(event); } catch {}
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE GENERATION PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildFilePrompt(plan, fileName, role, existingFiles = {}) {
  const { meta, stack, designSystem, components, features, pages } = plan;

  const contextParts = [
    `PROJECT: ${meta.title}`,
    `DESCRIPTION: ${meta.description}`,
    `TYPE: ${meta.type} | COMPLEXITY: ${meta.complexity}`,
    `STACK: framework=${stack.framework}, runtime=${stack.runtime}, db=${stack.database}, auth=${stack.auth}`,
  ];

  if (designSystem) {
    contextParts.push(
      `DESIGN: theme=${designSystem.theme}, primary=${designSystem.primaryColor}, accent=${designSystem.accentColor}, font=${designSystem.fontPrimary}`
    );
  }

  if (components?.length) {
    contextParts.push(`COMPONENTS: ${components.join(", ")}`);
  }

  if (features?.length) {
    contextParts.push(`FEATURES: ${features.join(", ")}`);
  }

  // Inject existing file names so agent knows what's already generated
  const existingNames = Object.keys(existingFiles);
  if (existingNames.length) {
    contextParts.push(`ALREADY GENERATED: ${existingNames.join(", ")}`);
  }

  // Inject small files (CSS, package.json) as reference for cross-file consistency
  if (existingFiles["style.css"] && fileName !== "style.css") {
    const cssSnippet = (existingFiles["style.css"] || "").slice(0, 800);
    contextParts.push(`STYLE REFERENCE (style.css excerpt):\n${cssSnippet}`);
  }

  if (existingFiles["server.js"] && fileName.includes("route")) {
    const srvSnippet = (existingFiles["server.js"] || "").slice(0, 600);
    contextParts.push(`SERVER REFERENCE (server.js excerpt):\n${srvSnippet}`);
  }

  const context = contextParts.join("\n");

  const fileRoleInstructions = {
    main_entry:      "Generate complete, production-ready index.html. Link to style.css and script.js. Include all HTML sections described in features and components. No placeholder text.",
    styles:          "Generate complete, production-quality style.css. Use the design system colors and fonts. Include all CSS needed for every component. Include CSS custom properties (--variables). Include responsive breakpoints. No placeholders.",
    main_script:     "Generate complete, working script.js. All interactive features must be fully implemented. No TODOs. No placeholder functions.",
    server_entry:    "Generate complete server.js. Working Express server with all routes, middleware, error handling. Include a /api/health endpoint.",
    package_config:  "Generate complete package.json with all required dependencies and scripts (start, dev).",
    frontend_entry:  "Generate complete index.html for the public folder. Served by Express. Links to /public/style.css and /public/script.js.",
    frontend_styles: "Generate complete style.css for the public folder. Production-quality CSS.",
    frontend_script: "Generate complete script.js for the public folder. All interactions working.",
    api_routes:      "Generate complete routes/index.js. All API endpoints fully implemented.",
    env_template:    "Generate .env.example with all required environment variables and descriptions as comments.",
    docs:            "Generate README.md with setup instructions, environment variables, and how to run.",
  };

  const instruction = fileRoleInstructions[role] || `Generate the complete ${fileName} file. Production-ready, no placeholders.`;

  return { context, instruction };
}

// ─────────────────────────────────────────────────────────────────────────────
// FRONTEND AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function runFrontendAgent(plan, emit, existingFiles = {}) {
  const frontendFiles = plan.files.filter(f =>
    f.role === "main_entry" || f.role === "styles" || f.role === "main_script" ||
    f.role === "frontend_entry" || f.role === "frontend_styles" || f.role === "frontend_script"
  );

  const generatedFiles = { ...existingFiles };

  for (const fileDef of frontendFiles) {
    const { path: fileName, role } = fileDef;
    emit("frontend-agent", "generating", fileName);

    const { context, instruction } = buildFilePrompt(plan, fileName, role, generatedFiles);

    const SYSTEM = `You are an expert frontend engineer. Generate ONLY the file content — no explanation, no markdown fences, no \`\`\` tags. 
    
PROJECT CONTEXT:
${context}

RULES:
- Complete file only. No placeholders, no TODOs, no "add your content here".
- Production-quality code. Fully functional.
- Use the design system specified exactly.
- Every component mentioned must be implemented.
- Responsive design required.
- For HTML: include proper meta tags, viewport, charset.
- For CSS: use CSS custom properties for theming.
- For JS: real functionality, not stubs.`;

    try {
      const content = await ai.generateAI(
        [
          { role: "system", content: SYSTEM },
          { role: "user",   content: instruction },
        ],
        { temperature: 0.25, maxTokens: 8000 }
      );

      generatedFiles[fileName] = content;
      emit("frontend-agent", "done", fileName);
    } catch (err) {
      emit("frontend-agent", "error", `${fileName}: ${err.message}`);
      log.warn(`Frontend agent error for ${fileName}: ${err.message}`);
    }
  }

  return generatedFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKEND AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function runBackendAgent(plan, emit, existingFiles = {}) {
  if (plan.stack.runtime !== "node") {
    return existingFiles; // No backend for browser-only projects
  }

  const backendFiles = plan.files.filter(f =>
    f.role === "server_entry" || f.role === "package_config" ||
    f.role === "api_routes"   || f.role === "env_template"   || f.role === "docs"
  );

  const generatedFiles = { ...existingFiles };

  for (const fileDef of backendFiles) {
    const { path: fileName, role } = fileDef;
    emit("backend-agent", "generating", fileName);

    const { context, instruction } = buildFilePrompt(plan, fileName, role, generatedFiles);

    const SYSTEM = `You are an expert backend engineer. Generate ONLY the file content — no explanation, no markdown fences, no \`\`\` tags.

PROJECT CONTEXT:
${context}

RULES:
- Complete file only. Production-ready, no placeholders.
- server.js: Include express, cors, body-parser, /api/health route, proper error handlers, port from process.env.PORT.
- package.json: Valid JSON only. Include start and dev scripts.
- Routes: Complete implementation, not stubs.
- .env.example: All keys with descriptive comments. No actual secret values.
- README.md: Markdown format. Include prerequisites, installation, environment setup, running instructions.`;

    try {
      const content = await ai.generateAI(
        [
          { role: "system", content: SYSTEM },
          { role: "user",   content: instruction },
        ],
        { temperature: 0.2, maxTokens: 6000 }
      );

      generatedFiles[fileName] = content;
      emit("backend-agent", "done", fileName);
    } catch (err) {
      emit("backend-agent", "error", `${fileName}: ${err.message}`);
      log.warn(`Backend agent error for ${fileName}: ${err.message}`);
    }
  }

  return generatedFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPAIR AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function runRepairAgent(plan, generatedFiles, emit) {
  emit("repair-agent", "started", "Validating generated files");

  const repairedFiles = { ...generatedFiles };
  let repairCount     = 0;

  for (const [fileName, content] of Object.entries(generatedFiles)) {
    const ext = fileName.split(".").pop();

    // Run repair engine validation
    let issues = [];
    if (ext === "html") {
      issues = repairEng.detectHTMLIssues
        ? repairEng.detectHTMLIssues(content)
        : [];
    } else if (ext === "css") {
      issues = repairEng.detectCSSIssues
        ? repairEng.detectCSSIssues(content)
        : [];
    }

    const criticals = issues.filter(i => i.severity === "critical");

    if (criticals.length === 0) continue;

    emit("repair-agent", "repairing", `${fileName} (${criticals.length} issues)`);

    const issueDesc = criticals.map(i => `- ${i.code}: ${i.description}`).join("\n");

    try {
      const repaired = await ai.generateAI(
        [
          {
            role: "system",
            content: `You are a code repair agent. Fix the following issues in this ${ext} file and return ONLY the complete fixed file content. No markdown, no explanation.

ISSUES TO FIX:
${issueDesc}

PROJECT: ${plan.meta.title}
DESIGN SYSTEM: ${JSON.stringify(plan.designSystem || {})}`,
          },
          {
            role: "user",
            content: `FILE: ${fileName}\n\nCONTENT:\n${content.slice(0, 6000)}`,
          },
        ],
        { temperature: 0.15, maxTokens: 8000 }
      );

      if (repaired && repaired.length > 100) {
        repairedFiles[fileName] = repaired;
        repairCount++;
        emit("repair-agent", "fixed", fileName);
      }
    } catch (err) {
      emit("repair-agent", "error", `Could not repair ${fileName}: ${err.message}`);
    }
  }

  emit("repair-agent", "done", `${repairCount} file(s) repaired`);
  return repairedFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPLOY AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function runDeployAgent(plan, emit) {
  emit("deploy-agent", "started", `Target: ${plan.deployment?.target || "netlify"}`);

  const deployFiles = {};

  try {
    // Use existing deploy.generator deterministically
    const brain = {
      name:        plan.meta.title,
      projectType: plan.meta.type,
      isFullstack: plan.stack.runtime === "node",
      stack: {
        framework:  plan.stack.framework,
        language:   plan.stack.runtime === "node" ? "javascript" : "html",
        database:   plan.stack.database || "none",
        auth:       plan.stack.auth || "none",
      },
      envVars:   (plan.envVars || []).map(e => `${e.key}=`),
      startCmd:  plan.deployment?.startCmd || "",
      buildCmd:  plan.deployment?.buildCmd || "",
      port:      plan.deployment?.port || 3000,
    };

    const generated  = deployGen.generateDeployConfigs(brain, ["auto"]);

    if (Array.isArray(generated)) {
      generated.forEach(f => {
        const name = f.fileName || f.name;
        deployFiles[name] = f.content;
        emit("deploy-agent", "generated", name);
      });
    }

    // Always generate .env.example if not already there
    if (!deployFiles[".env.example"] && plan.envVars?.length) {
      const envContent = (plan.envVars || [])
        .map(e => `# ${e.description}\n${e.key}=${e.required ? "REQUIRED" : ""}`)
        .join("\n\n");
      deployFiles[".env.example"] = envContent;
      emit("deploy-agent", "generated", ".env.example");
    }

    emit("deploy-agent", "done", `${Object.keys(deployFiles).length} config files`);
  } catch (err) {
    emit("deploy-agent", "error", err.message);
    log.warn(`Deploy agent error: ${err.message}`);
  }

  return deployFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runAgentPipeline
 *
 * Full agent pipeline: planner → frontend → backend → repair → deploy → graph
 *
 * @param {string} prompt       — raw user prompt
 * @param {string} projectId    — workspace project ID
 * @param {object} options
 * @param {function} options.onStatus  — callback(event) for real-time status
 * @param {function} options.saveFiles — async fn(files) to persist to disk
 * @returns {Promise<{ plan, files, deployFiles, graphSummary }>}
 */
async function runAgentPipeline(prompt, projectId, options = {}) {
  const { onStatus, saveFiles } = options;
  const emit = makeEmitter(onStatus);

  const startMs = Date.now();
  log.info(`Agent pipeline starting for project ${projectId}`);

  // ── PHASE 1: PLANNER AGENT ────────────────────────────────────────────────
  emit("planner-agent", "started", "Creating architecture plan");

  let plan;
  try {
    plan = await planner.createProjectPlan(prompt);
    emit("planner-agent", "done", `${plan.meta.type}/${plan.meta.complexity} — ${plan.files.length} files planned`);
  } catch (err) {
    emit("planner-agent", "error", err.message);
    throw new Error(`Planner failed: ${err.message}`);
  }

  // ── PHASE 2: GRAPH INIT ───────────────────────────────────────────────────
  await graph.initArchitecture(projectId, plan).catch(() => {});
  if (plan.pages?.length) await graph.updateFrontendPages(projectId, plan.pages).catch(() => {});

  // ── PHASE 3: FRONTEND AGENT ───────────────────────────────────────────────
  emit("frontend-agent", "started", `Generating ${plan.stack.runtime === "browser" ? 3 : 3} frontend files`);
  let allFiles = await runFrontendAgent(plan, emit, {});

  // ── PHASE 4: BACKEND AGENT ────────────────────────────────────────────────
  if (plan.stack.runtime === "node") {
    emit("backend-agent", "started", "Generating backend files");
    allFiles = await runBackendAgent(plan, emit, allFiles);
  }

  // ── PHASE 5: REPAIR AGENT ─────────────────────────────────────────────────
  emit("repair-agent", "started", "Running quality checks");
  allFiles = await runRepairAgent(plan, allFiles, emit);

  // ── PHASE 6: DEPLOY AGENT ─────────────────────────────────────────────────
  emit("deploy-agent", "started", "Generating deployment configs");
  const deployFiles = await runDeployAgent(plan, emit);

  // Merge deploy files into all files (optional — some want them separate)
  const mergedFiles = { ...allFiles, ...deployFiles };

  // ── PHASE 7: SAVE + GRAPH UPDATE ─────────────────────────────────────────
  if (typeof saveFiles === "function") {
    emit("system", "saving", `Writing ${Object.keys(mergedFiles).length} files`);
    await saveFiles(mergedFiles);
  }

  // Update graphs for all written files
  const fileEntries = Object.entries(mergedFiles).map(([fileName, content]) => ({ fileName, content }));
  await graph.updateGraphsForFiles(projectId, fileEntries).catch(() => {});

  // Get graph summary
  const graphSummary = await graph.getGraphSummary(projectId).catch(() => "");

  const durationMs = Date.now() - startMs;
  emit("system", "complete", `Pipeline done in ${(durationMs / 1000).toFixed(1)}s`);
  log.info(`Agent pipeline complete for ${projectId} in ${durationMs}ms`);

  return {
    plan,
    files:        allFiles,
    deployFiles,
    mergedFiles,
    graphSummary,
    durationMs,
    fileCount:    Object.keys(mergedFiles).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE FILE AGENT (for edits)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runFileAgent — regenerate a single file with full project context
 * Used by the repair/edit flow.
 */
async function runFileAgent(fileName, instruction, projectContext, options = {}) {
  const { onStatus } = options;
  const emit         = makeEmitter(onStatus);

  emit("file-agent", "started", fileName);

  const { existingFiles = {}, brain = {}, graphSummary = "" } = projectContext;

  const SYSTEM = `You are an expert software engineer working on an existing project.
Generate ONLY the complete updated file content. No markdown, no explanation, no \`\`\` tags.

PROJECT CONTEXT:
${graphSummary || JSON.stringify(brain).slice(0, 800)}

EXISTING FILES: ${Object.keys(existingFiles).join(", ")}

RULES:
- Return ONLY the complete file content
- Preserve existing functionality unless explicitly told to change it
- Cross-reference other files for consistency (class names, routes, variable names)
- Production quality — no placeholders, no TODOs`;

  try {
    const content = await ai.generateAI(
      [
        { role: "system", content: SYSTEM },
        { role: "user",   content: `FILE: ${fileName}\n\nINSTRUCTION: ${instruction}` },
      ],
      { temperature: 0.2, maxTokens: 8000 }
    );

    emit("file-agent", "done", fileName);
    return { fileName, content, success: true };
  } catch (err) {
    emit("file-agent", "error", `${fileName}: ${err.message}`);
    return { fileName, content: "", success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  runAgentPipeline,
  runFrontendAgent,
  runBackendAgent,
  runRepairAgent,
  runDeployAgent,
  runFileAgent,
};
