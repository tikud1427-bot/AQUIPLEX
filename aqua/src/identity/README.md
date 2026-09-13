# AQUA Identity & Self-Knowledge Layer

The single source of truth for everything AQUA knows about **Aquiplex** and
**AQUA**. Loaded once, cached in memory, injected into **every** request — so
AQUA always knows itself, without retrieval (the way ChatGPT always knows
OpenAI). AQUA can never fail to answer a question about itself.

## Layout

```
src/identity/
├── index.js              Public API (import from here)
├── identityLoader.js     Loads + validates + caches the profile; updates + reload
├── identityContext.js    Builds the injected prompt text (compact + expanded + directive)
├── identityRouter.js     Smart router: detect intent · deterministic answer · refusal guard
├── data/                 THE SOURCE OF TRUTH — edit these, nothing else
│   ├── company.json        name, vision, mission, values, website, stage
│   ├── assistant.json      AQUA's role, capabilities, differentiators, limitations, file types
│   ├── founders.json       founders
│   ├── products.json       product lineup
│   ├── roadmap.json        shipped / in-progress / planned
│   ├── models.json         providers + models (mirror src/providers/modelRegistry.js)
│   ├── faq.json            curated answers for non-field questions
│   └── overrides.json      (optional, auto-written) runtime overrides
└── tests/identityLayer.test.js
```

## How it plugs in

1. **Always-on injection** — `promptBuilder.buildSystemPrompt(...)` calls
   `buildIdentityInjection(intent)` and injects the **compact** identity block
   into every system prompt, right after the base system prompt.
2. **Smart router** — `chat.js prepareTurn()` calls
   `detectIdentityIntent(userMessage)` **before** retrieval. On a self/brand
   question it (a) **skips project/vector retrieval**, (b) injects the **full**
   profile section(s) for the matched topic(s) plus a **confidence directive**.
3. **Identity contract guard** — after generation, both `/chat` and
   `/chat/stream` replace a self-answer when it either refuses or makes a
   detectable unsupported self/competitor claim (for example, inventing an
   underlying model or saying the profile is 'not documented'). The deterministic
   profile answer is emitted/replaced before persistence.

## Editing

- Change the vision / roadmap / anything: **edit `data/*.json`**. It propagates
  to every prompt and every direct answer. Nothing is hardcoded in a prompt.
- Programmatic / admin: `updateIdentityProfile({ company: { vision: '…' } })`
  (in-memory by default; `{ persist: true }` writes `data/overrides.json`).
  Bumps the profile revision.
- Hot reload after editing files: `reloadIdentity()`.

## Tests

```
npm run test:identity        # from aqua/
```

Enforces the self-knowledge contract: required identity prompts are detected
and grounded, generic comparisons do not trigger it, and unsupported/refusal
patterns are caught before they can be persisted as the assistant answer.

## TODO for the team (placeholders in the data files)

- `company.json`: set real `website` and `founded`; refine `vision` / `mission` wording.
- `founders.json`: verify names/titles, add bios.
- `roadmap.json`: fill `In progress` and `Planned`.
