# AQUA Identity & Self-Knowledge Layer — change summary

Fixes the architectural gap where AQUA sometimes replied "I don't have
information / I'm not familiar" to questions about itself. AQUA now has a
permanent Identity Layer: loaded once, cached, injected into **every** request,
answered directly **without retrieval**, and **guaranteed** never to hedge about
itself.

## New subsystem — `aqua/src/identity/`

| File | Purpose |
|---|---|
| `index.js` | Public API (import from here) |
| `identityLoader.js` | Loads + validates + **caches** the profile; `updateIdentityProfile()`, `reloadIdentity()`, versioned |
| `identityContext.js` | Builds injected prompt text: **compact** (always) + **expanded** per topic + confidence **directive** |
| `identityRouter.js` | **Smart router**: `detectIdentityIntent()` · `answerFromIdentity()` (deterministic) · `isRefusal()` |
| `data/*.json` | **Single source of truth** — company, assistant, founders, products, roadmap, models, faq |
| `tests/identityLayer.test.js` | 31 tests; enforces the spec's FAILURE CONDITIONS |
| `README.md` | How it works + how to edit |

## Integration (surgical edits)

- **`core/promptBuilder.js`** — `buildSystemPrompt()` gained an optional
  `identityIntent` arg and now injects the **compact** identity block on every
  prompt (right after the base system prompt), **expanded** + directive on a
  self-question.
- **`routes/chat.js`** — `prepareTurn()` runs `detectIdentityIntent()` **before
  retrieval**; on a self-question it **skips project/vector retrieval** and
  passes the intent to the prompt builder. Both `/chat` and `/chat/stream` run a
  post-generation **refusal guard**: if the model ever hedges on a
  self-question, the deterministic profile answer replaces it (stream emits
  `replace`). A small `identity` diagnostic is added to the response payload.
- **`prompts/system.txt`** — removed the hardcoded brand line (now owned by the
  Identity Layer → **single source of truth**) and added a self-knowledge
  carve-out to the "never invent facts" rule.
- **`package.json`** (aqua + root) — added `test:identity`; wired into
  root `test:aqua`.

## Behavior

- Every request carries a compact identity block → AQUA always knows Aquiplex
  and AQUA (like ChatGPT always knows OpenAI).
- Self/brand questions skip retrieval and get the full profile + a directive.
- The refusal guard makes the FAILURE CONDITIONS impossible in production, not
  just in tests.

## Tests

```
cd aqua && npm run test:identity      # 31/31 pass
```

All 12 required prompts pass; no self-answer contains "I don't know",
"I'm not familiar", "I don't have information", or "I don't have a source".
No regressions: the pre-existing test suite result is unchanged.

## TODO (placeholders in `aqua/src/identity/data/`)

- `company.json`: set real `website`, `founded`; refine `vision`/`mission` copy.
- `founders.json`: verify names/titles, add bios.
- `roadmap.json`: fill `In progress` and `Planned`.
- `models.json`: keep in sync with `src/providers/modelRegistry.js`.
