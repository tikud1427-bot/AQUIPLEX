# AQUIPLEX Platform v2

AQUIPLEX = the platform. **AQUA = the only AI.**

## What we're building

**Aqua knows where your project stands.** It is an AI assistant for early-stage
founders that keeps the current state of their company: what's decided, what
changed, and where each fact came from. Facts can be corrected or deleted, and
that holds across conversations.

Current status, stated honestly:

- **Built:** onboarding interview, sourced and correctable memory, file ingestion.
- **Not yet shown:** that this memory beats simpler approaches. See [PRODUCT_SCORECARD.md](PRODUCT_SCORECARD.md).

| Document | What it covers |
|---|---|
| [REPO_AUDIT.md](REPO_AUDIT.md) | Current state, **release blockers**, security findings, capability matrix |
| [YC_PRODUCT_THESIS.md](YC_PRODUCT_THESIS.md) | Directions considered, the chosen segment and promise, assumptions |
| [PRODUCT_SCORECARD.md](PRODUCT_SCORECARD.md) | Measured baseline (stale-answer rate), funnel definitions, pending v4 experiment |
| [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md) | Changes, root causes, test commands and results |
| [PILOT_VALIDATION_PLAN.md](PILOT_VALIDATION_PLAN.md) | Interviews → design partners → paid test, with decision rules |
| [YC_APPLICATION_DRAFT.md](YC_APPLICATION_DRAFT.md) | Fact-checked application prep and live demo script |

The roughly 70 dated `*.md` reports at the repo root are history. Where they
disagree with the documents above, the documents above win.

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
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY_1..N`
(NVIDIA is an additional provider/fallback; model via `NVIDIA_DEFAULT_MODEL`,
default `openai/gpt-oss-20b`).

Web search keys (multi-key, any subset): `SERPER_API_KEY_1..N`,
`TAVILY_API_KEY_1..N` (bare `SERPER_API_KEY`/`TAVILY_API_KEY` also honored).
Zero keys = search dormant, chat unchanged. Optional tuning:
`SEARCH_TIMEOUT`, `SEARCH_MAX_RESULTS`, `SEARCH_PROVIDER_PRIORITY`,
`SEARCH_CACHE_TTL`, `SEARCH_ENABLE_CACHE`, `SEARCH_RETRY_LIMIT` — see
`aqua/AQUA_SEARCH_ARCHITECTURE.md`.

## Tests

```bash
npm test                 # = test:aqua (engine battery) && test:platform (root tests/)
npm run test:aqua        # cd aqua && npm test — every aqua suite, discovered
npm run test:platform    # auth, sessions, CSRF, billing, account deletion, launch safety
cd aqua && DATABASE_URL= npm run eval:gate   # evaluation regression gate (as CI runs it)
```

CI runs two workflows. `eval-gate.yml` runs the aqua battery plus the gate on
`aqua/**` changes. `platform-tests.yml` runs the root tests on every PR. Live
Postgres and Redis suites need disposable containers; never point tests at
`.env` databases.

## Product analytics

Server-side and content-free: user id, event name and time only. The events are
signup, login, chat turn, upload, project created, memory corrected and memory
forgotten. They are deleted with the account and expire after 400 days. Turn
them off with `AQUA_PRODUCT_EVENTS=off`.

Read-only report:

```bash
node scripts/activation-report.mjs --mongo <uri> [--days 120] [--json out.json]
```

The report covers activation (chat on 2 or more days in the first 7) and
week-1 and week-4 retention, by signup cohort.

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
