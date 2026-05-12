# AQUIPLEX WORKSPACE — V5 UPGRADE DOCUMENTATION

## Summary

Upgraded the Workspace Builder from a single-generation-prompt system into a
**multi-agent, graph-aware, plan-driven project generation engine**.

All upgrades are **additive and backward-compatible**. No existing functionality
was broken or removed.

---

## New Modules

### `engine/planner.agent.js`
Project Architecture Planner — runs before any code generation.

- Detects project type (saas, dashboard, portfolio, game, api, chat, fullstack, etc.)
- Estimates complexity (simple / medium / complex)
- Builds deterministic file plan per stack
- Selects design system (colors, fonts, theme)
- AI-enriches with components, features, pages, env vars
- Returns structured JSON plan that drives all downstream agents

**Used by:** `core/aqua.orchestrator.js` (every `generate_project` intent), `routes/export.routes.js`

---

### `engine/graph.engine.js`
Project Graph Engine — maintains persistent structural knowledge.

Generates and updates 4 graph files per project:

| File | Purpose |
|------|---------|
| `_architecture.json` | Stack, type, complexity, files, design system |
| `_dependency-graph.json` | File import/link relationships |
| `_route-map.json` | Backend API routes + frontend pages |
| `_component-tree.json` | UI components extracted from HTML |

Graphs auto-update after every file write. Agents read `getGraphSummary()` for
compressed project context instead of re-reading all files.

**Used by:** `core/aqua.orchestrator.js`, `routes/export.routes.js`, `engine/agent.orchestrator.js`

---

### `engine/agent.orchestrator.js`
Multi-Agent Orchestration System.

Specialized agents, each with a single responsibility:

| Agent | Responsibility |
|-------|---------------|
| `planner-agent` | Architecture plan (JSON) |
| `frontend-agent` | HTML, CSS, JS — file by file |
| `backend-agent` | server.js, routes, package.json |
| `repair-agent` | Validate + fix generated files |
| `deploy-agent` | Deployment configs (Vercel, Railway, Docker, Netlify) |

Key features:
- File-by-file generation (traceable, not monolithic)
- Cross-file context injection (CSS variables shared with JS, server routes shared with route files)
- Real-time status events via `onStatus` callback
- Streaming SSE support via `/workspace/project/:id/agent-gen/stream`

**Entry point:** `runAgentPipeline(prompt, projectId, { onStatus, saveFiles })`

---

### `routes/export.routes.js`
New REST endpoints mounted at `/workspace`:

```
GET  /workspace/templates                    — list all templates
POST /workspace/templates/:name/seed         — get plan from template
POST /workspace/project/:id/plan             — create architecture plan
GET  /workspace/project/:id/graph            — get all 4 project graphs
GET  /workspace/project/:id/graph/summary    — compressed graph for AI
POST /workspace/project/:id/agent-gen        — run full pipeline (blocking)
POST /workspace/project/:id/agent-gen/stream — run pipeline (SSE streaming)
GET  /workspace/project/:id/export/zip       — download project as ZIP
GET  /workspace/project/:id/export/deploy    — get all deployment configs
```

---

## Templates (8 production templates)

| Key | Name | Type |
|-----|------|------|
| `saas-landing` | SaaS Landing Page | saas |
| `dashboard` | Analytics Dashboard | dashboard |
| `portfolio` | Developer Portfolio | portfolio |
| `ecommerce` | E-Commerce Store | ecommerce |
| `ai-chat` | AI Chat Interface | chat |
| `blog-cms` | Blog CMS | blog |
| `admin-panel` | Admin Panel | dashboard |
| `api-backend` | Express REST API | api |

---

## Workspace UI Changes

- **Agent Status Panel** — fixed bottom-left panel showing real-time agent events
  during pipeline runs (planner / frontend / backend / repair / deploy)
- **Export ZIP** — updated to use new `/export/zip` endpoint
- `runAgentGen(projectId, prompt)` — JS function to trigger streaming pipeline
- `viewProjectPlan()` — JS function to view architecture graph
- `logAgentEvent(event)` — renders agent events in panel

---

## Integration with Existing Architecture

### What changed in existing files:

**`core/aqua.orchestrator.js`** (additive patch):
- `GENERATE_PROJECT` case now runs `planner.agent.createProjectPlan()` before generation
- After generation, calls `graph.engine.updateGraphsForFiles()` to build graphs
- Both steps are non-fatal — failures don't break generation
- Response now includes `plan` field with the architecture plan

**`index.js`** (one line added):
- Mounts `exportRoutes` at `/workspace`

### What was NOT changed:
- `workspace/workspace.service.js` — untouched
- `engine/ai.core.js` — untouched
- `engine/repair.engine.js` — untouched
- `engine/deploy.generator.js` — untouched
- `engine/project.brain.js` — untouched
- `engine/prompt.expander.js` — untouched
- `core/aqua.orchestrator.js` — only additive patch
- All auth, session, chat, memory, history routes — untouched
- All existing workspace routes — untouched
- MongoDB models — untouched

---

## Migration Notes

### `archiver` dependency
ZIP export requires `archiver` npm package. Install if needed:
```bash
npm install archiver
```
Without it, the ZIP endpoint gracefully falls back to returning files as JSON.

### No database migrations needed
All new data is stored as flat JSON files inside `data/projects/<id>/` directories.
Existing projects are unaffected.

### Backward compatibility
- All existing `/workspace/project/:id/export` endpoints still work
- Existing chat-based generation flow unchanged
- New plan/graph data is additive — stored alongside `_brain.json`

---

## Future Scaling Recommendations

1. **Vector indexing** — Replace `_architecture.json` text summaries with embedding
   vectors (OpenAI/Together embeddings) for semantic file retrieval in large projects.

2. **Sandboxed runtime** — Add Docker-based sandbox for running generated Node.js
   projects. Connect terminal stream to workspace via WebSocket.

3. **GitHub export** — Use GitHub API to push project files to a new repo directly
   from the workspace.

4. **Incremental generation** — For large projects, allow agents to generate
   additional files (new pages, components) without regenerating the whole project.

5. **Agent parallelism** — Frontend and backend agents can run concurrently
   when projects have clear separation. Currently sequential for simplicity.

6. **Plan versioning** — Store multiple plans per project (history) to allow
   reverting to a previous architecture.
