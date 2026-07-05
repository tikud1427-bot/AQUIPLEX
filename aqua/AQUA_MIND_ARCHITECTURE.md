# AQUA Mind — Persistent Cognitive Model

**Status: shipped, additive, backward compatible.** 34/34 mind tests passing; all pre-existing suites (memory ×5, upload, classifier, orchestrator, health, editEngine) unaffected.

AQUA no longer only stores and retrieves facts. It maintains a per-user **cognitive model** — an evolving, confidence-weighted understanding of who the user is, how they work, what they're working toward, and what they'll likely need next — that becomes more accurate with every interaction.

```
before:  Conversation → Extract facts → Store → Retrieve → Respond
now:     Conversation → Observe → Infer → Update cognitive model
         → Predict → Retrieve UNDERSTANDING → Respond → Reflect → Improve
```

---

## Where it lives

```
aqua/src/mind/
├── mindSchema.js        types, dimensions, dynamics, caps, constructors
├── confidence.js        Layer 11 — pure math: reinforce/contradict/decay/promotion
├── mindStore.js         user-scoped persistence (.aqua-mind.json), owner resolution
├── beliefEngine.js      Layers 1–4, 17, 18 — the only writer of beliefs
├── observers.js         Observe→Infer: zero-LLM per-turn signal extraction + fact bridge
├── goalTracker.js       Layer 5 — goals as living objects (detect/match/progress/complete)
├── workingMemory.js     Layer 9 — volatile focus/blockers/deadlines/questions, fast decay
├── episodeTracker.js    Layer 8 — experiences: themed arcs with outcomes
├── relationshipGraph.js Layers 7+16 — typed weighted graph; org memory = org neighborhoods
├── timeline.js          Layer 10 — capped event ring; history never disappears
├── predictionEngine.js  Layer 12 — ephemeral forecasts; never become beliefs
├── reflectionEngine.js  Layers 13+14 — async consolidation, decay, promote, archive
├── mindRetriever.js     Layer 15 — smallest highest-relevance cognitive block, budgeted
├── index.js             facade: mindObserve / mindContext / mindAfterTurn
├── mindRoutes.js        Layers 17/18/19 API — inspect/explain/correct/lock/delete/export
├── mindView.html        env-gated developer panel (AQUA_MIND_VIEW=1)
└── tests/mind.test.js   34 tests, node:test
```

**Not a monolith.** Each subsystem owns exactly one section of the Mind object, is imported independently, and is independently tested. `index.js` is a thin fail-safe facade — the *only* module the chat pipeline touches.

## The Mind object (per owner)

```js
{
  ownerId, turnCount,
  beliefs:   { "dimension:key" → Belief },   // identity / personality / communication /
                                             // preferences / knowledge / behavior / decision
  goals:     { id → Goal },                  // priority, progress, blockers, status, history
  episodes:  { id → Episode },               // arcs with objectives + outcomes
  graph:     { nodes, edges },               // person/org/project/goal/technology, typed edges
  timeline:  [events],                       // belief flips, goal changes, reflections
  working:   { focus, blockers, deadlines, discoveries, openQuestions },
  predictions: [ { label, probability, basis } ],   // ephemeral
  reflections: [reports], lastReflectionAt,
}
```

Every belief: `value, confidence, evidence[] (windowed), evidenceCount, contradictions, history[], established, privacy { visibility, retentionDays, temporary, locked, source }`.

## Confidence semantics (Layer 11)

- **Support:** `c' = c + rate·strength·(1−c)` — asymptotic, never reaches 1. Nothing is binary.
- **Contradiction:** multiplicative drop, floored at 0.05, counter incremented, **old value versioned into history — never overwritten.** A challenger value flips the belief only when its implied confidence overtakes the weakened incumbent.
- **Decay (reflection-time):** per-dimension weekly rates; identity never decays; `established` beliefs keep a 0.4 floor. Decayed-below-0.15 → **ARCHIVED, never deleted.** Hard deletion happens only via user action or privacy `retentionDays` TTL.
- **Promotion:** confidence ≥ 0.8 **and** ≥ 3 observations → `established` (one-way flag, reported once by reflection as "learned").

## Turn lifecycle integration (chat.js — surgical, ~30 lines)

`prepareTurn()` gained `userId` and three hooks:

1. **`mindObserve(owner, turn)`** — after fact extraction. Zero-LLM heuristics (<1ms): task-type → identity traits, text → communication/decision/preference signals, tech mentions → knowledge, plus the **fact bridge** that lifts the existing regex extractor's output into belief evidence (no duplicate extraction — the proven pipeline is reused, not replaced). Feeds goals, working memory, episodes, graph.
2. **`mindContext(owner, query)`** — the cognitive block **rides the existing `memoryBlock` slot**; `promptBuilder` signature untouched. Budgeted (~450 tokens), priority-ordered (identity → communication → preferences → knowledge → goals → working state → top prediction → graph), tail-trimmed under budget. Includes the guardrail: *confidence <70% = treat as a hunch, never assert it back to the user.*
3. **`mindAfterTurn(owner)`** — after persist, both endpoints: turn count, prediction rebuild, and **async reflection** via `setImmediate` every 8 turns. Reflection adds zero latency and never surfaces in user messages.

Every facade call is fail-safe: a Mind error logs a warning and returns neutral — **the chat pipeline can never break because of the Mind.** Response payloads gained a `mind: { observedSignals, goalsTouched, contextInjected, contextUsed }` diagnostics block (additive; existing consumers unaffected).

### Owner resolution

`user:<aquaUserId>` when the platform session exists — **cross-conversation understanding, the actual goal.** Falls back to `conv:<conversationId>` when the engine runs standalone (dev/demo). Null → Mind silently disabled. Existing conversation-scoped fact memory (`.aqua-memory.json`) is untouched and continues to work exactly as before.

## API (mounted at `/api/aqua/mind`)

| Route | Purpose |
|---|---|
| `GET /` | Full model summary (Mind View data source) |
| `GET /export` | Complete raw export — the user owns the model (L19) |
| `GET /beliefs?dimension=&min=` | Filtered beliefs |
| `GET /beliefs/:dim/:key` | One belief **+ plain-language explanation** (L17) |
| `PATCH /beliefs/:dim/:key` | Correct `{ value }` — explicit, audited, dominates inference (L18) |
| `POST /beliefs/:dim/:key/lock` | Pin — immune to inference and decay |
| `POST /beliefs/:dim/:key/temporary` | Never promoted to permanent |
| `DELETE /beliefs/:dim/:key`, `PATCH/DELETE /goals/:id`, `DELETE /` | Edit/erase — user-controlled |
| `GET /graph?around=nodeKey` | Graph / neighborhood traversal; org memory via org nodes |
| `GET /reflections` | Reflection history |
| `GET /view` | **Mind View** dev panel — 404 unless `AQUA_MIND_VIEW=1` |

## Explainability example (live output)

> **Why do you think I prefer minimal UI?**
> "Believed because of 27 observations across 24 conversations. Strongest signals: rejected flashy/busy option. Previously believed: …"

Generated from the evidence window — never hallucinated.

## Running

```bash
npm run test:mind        # 34 tests
AQUA_MIND_VIEW=1 npm start   # then open /api/aqua/mind/view
```

## Migration path & future work

- **Storage:** Map + debounced JSON file, matching every other AQUA store. All access flows through `mindStore.js`; swapping to SQLite/Postgres later touches one file.
- **LLM-assisted observation:** `observers.js` is one producer of signals. A second, LLM-backed observer (better episode titles, richer trait inference) can be added behind the orchestrator's cost gates without touching any consumer.
- **Multimodal memory:** belief `value` is schemaless; evidence entries can reference attachment ids from the Day-5 upload store.
- **Frontend Mind tab:** shipped — see `aqua-frontend/src/pages/MindPage.tsx` + `src/features/mind/` (route `/aqua/mind`, code-split, event-driven refresh from `chatStore.finishTurn`, no polling). `mindView.html` remains as the raw env-gated dev inspector.
- **Streaming updates:** `touchMind` is the single write funnel — an event emitter there gives live Mind View updates for demos.

## Success criteria check

After sustained use, responses are shaped by: who the user is (identity), how to speak to them (communication beliefs), what they know (knowledge model → "skip basics"), what they're driving at (goals + working memory), and what's coming (predictions) — all confidence-weighted, all explainable, all user-editable, all decaying honestly when evidence goes stale. Not better memory. **Understanding.**
