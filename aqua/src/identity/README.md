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
3. **Refusal guard** — after generation, both `/chat` and `/chat/stream` run:
   `if (intent.isSelf && isRefusal(answer)) answer = answerFromIdentity(msg)`.
   This is the hard guarantee: a hedged self-answer is replaced by the
   deterministic profile answer before it reaches the user (stream emits
   `replace`). The always-on block makes this path rare.

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

Enforces the spec's FAILURE CONDITIONS: every required identity prompt is
detected and answered, and no self-answer may contain "I don't know",
"I'm not familiar", "I don't have information", or "I don't have a source".

## TODO for the team (placeholders in the data files)

- `company.json`: set real `website` and `founded`; refine `vision` / `mission` wording.
- `founders.json`: verify names/titles, add bios.
- `roadmap.json`: fill `In progress` and `Planned`.
