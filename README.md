# AQUIPLEX Platform v2

AQUIPLEX = the platform. **AQUA = the only AI.**

## Architecture

```
aquiplex-platform/
├── index.js                Platform server (CommonJS, Express 5, EJS)
│                           auth · tools directory · bundles · blogs · billing
├── aqua/                   AQUA engine (ESM subpackage) — mounted at /api/aqua
│   ├── router.js           Single mount point (chat, stream, memory,
│   │                       conversations, project intelligence, upload)
│   └── src/                core · intelligence · memory · orchestrator ·
│                           project · providers · prompts · routes · upload
├── aqua-frontend/          AQUA app (React 19 + TS + Vite) — served at /aqua
├── models/                 User, Tool, Bundle, Payment, Transaction,
│                           BillingLog, WebhookLog
├── routes/billing/         Razorpay REST routes (webhook handled pre-json)
├── services/               ai.client (internal LLM util), execution,
│                           billing, credits
├── middleware/usage/       Credit metering (usageGuard / checkUsage)
├── utils/                  startup checks, logger, credits, validators
├── views/ + public/        Platform pages (EJS)
```

## Request flow

- `GET /aqua` → requireLogin → React SPA (`aqua-frontend/dist`, base `/aqua/`)
- `POST /api/aqua/chat`, `/chat/stream` → requireLogin → usageGuard
  (`chat_message`) → AQUA engine (classify → orchestrate → plan →
  intelligence → memory → project retrieve → **web search** (multi-provider,
  cached, orchestrator-gated) → prompt → provider router w/ fallback →
  verify → persist)
- `POST /api/aqua/upload` → usageGuard (`chat_with_file`) → universal upload
  (ZIP / TAR / TAR.GZ / documents / media) → workspace intelligence dashboard
- Conversations + memory scoped per platform user via `req.aquaUserId`
  (session identity injected at the mount).
- Legacy AI URLs 301 → `/aqua`: `/chatbot`, `/aqua-ai`,
  `/aqua-project-engine`, `/workspace`, `/workspace/*`.

## Setup

```bash
npm install                 # also installs aqua/ (postinstall)
npm run build:aqua          # builds the AQUA SPA into aqua-frontend/dist
npm start
```

Env (.env): `MONGO_URI`, `SESSION_SECRET`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, plus AQUA provider keys: `GROQ_API_KEY`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`.

Web search keys (multi-key, any subset): `SERPER_API_KEY_1..N`,
`TAVILY_API_KEY_1..N` (bare `SERPER_API_KEY`/`TAVILY_API_KEY` also honored).
Zero keys = search dormant, chat unchanged. Optional tuning:
`SEARCH_TIMEOUT`, `SEARCH_MAX_RESULTS`, `SEARCH_PROVIDER_PRIORITY`,
`SEARCH_CACHE_TTL`, `SEARCH_ENABLE_CACHE`, `SEARCH_RETRY_LIMIT` — see
`aqua/AQUA_SEARCH_ARCHITECTURE.md`.

## Tests

```bash
npm run test:aqua                          # edit + upload + identity + search
cd aqua && node --test src/**/tests/*.test.js
```

## Removed in the v2 restructure

Legacy chatbot (chatbot.ejs, /chat, aqua.orchestrator, ai chat modes, History
model, suggest-prompts, multi-generate), legacy memory system
(memory.service, Memory model, /memory pages), Workspace Builder (workspace
views/routes/service, generation engine: 50+ engine/* files, brain, assembly,
composer, compiler, ingestion, manifest, editing, learning, hybrid-engine,
templates, ui-packs), builder-engine/, unused Replit client/ + server/ (React
scaffold), file.session/file.parser legacy uploads, socket.io, dead deps
(react/vite/radix/drizzle/pg/cashfree/socket.io/ws/pdf-parse/mammoth at
platform level), stub command.service, unrouted views (lab, every, tool,
components), orphan CSS/JS.

Kept as internal utility (not user-facing AI): `services/ai.client.js` —
powers tool insights, bundle generation/execution.
