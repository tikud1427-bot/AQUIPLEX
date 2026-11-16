# Memory and Context Audit

Evidence levels as defined in SYSTEM_ARCHITECTURE_MAP.md.

## 1. Two kinds of "context", conflated

AQUA has two context mechanisms that answer different questions:

| | Short-term (conversation) | Long-term (the user's world) |
|---|---|---|
| Question | "What were we just talking about?" | "What do I know about this person?" |
| Source | `conversationStore` → `buildContextWindow` | memoryRetrieve, Mind, PIC, Context Engine V2/E8, World Core, episodic recall, information-needs, hybrid |
| Reaches the model as | `messages` (chat turns) | System-prompt blocks |
| Query used | n/a (recency) | **The raw current message** |

The defect class behind the incident: **the long-term lanes judge sufficiency and write instructions without consulting the short-term context**, and their instructions outrank it in the prompt.

## 2. Short-term context

SOURCE-CONFIRMED (details in CONVERSATION_FAILURE_INVESTIGATION.md §1):

- Budget = `computeContextBudget(complexity, profile.maxContextTokens)`, minimum 4,000. REPRODUCED: 4,000 for `simple_question` turns.
- Selection: newest → oldest, `chars/4` estimate, **stops at the first message that does not fit** (`core/tokenManager.js`). One long recent message (a pasted document, a generated artifact summary, a long code answer under a larger profile) removes **all** older turns, including the antecedent of the next "it" (D-08).
- No summarization of dropped turns; nothing tells the model that history was cut.
- Episodic recall and information-needs exclude messages inside the window (`excludeFromIndex: history.length - window.length`), so nothing outside the window comes back for *this* conversation either. A dropped antecedent is unrecoverable.

## 3. Long-term lanes executed on every turn

| Lane | Module | Gate | Query |
|---|---|---|---|
| Legacy facts + Mind (memoryBlock) | `memory/engine.js memoryRetrieve` | always (owner) | raw message + semantic scores of raw message |
| PIC floor (via CIE seam) | `cognition` → `pic/` | always unless needs-owned | raw message |
| Context Engine V2 + E8 rounds + RRF (V3) | `brain/contextEngine/*` | `AQUA_CONTEXT_V2=on` (prod) | raw message; round two = `"<message> topic"`, `"<message> subject"` |
| World Core | `brain/index.js withWorldCore` | on + DB configured | owner's current world (Postgres) |
| Conversation focus (deictic) | `brain/contextEngine/conversationFocus.js` | `isDeictic(query)` | previous turn's **World-Model entity UUIDs** only |
| Episodic recall (+ semantic) | `memory/episodicRecall.js` | `recallEnabled()` | raw message |
| Information needs / hybrid | `brain/contextEngine/informationNeeds.js`, `hybridContext.js` | off by default | raw message |

### Follow-up resolution (D-03, SOURCE-CONFIRMED)

There is **no** history-aware query rewriting or antecedent carry-over for retrieval. The single follow-up mechanism, `conversationFocus`, stores the entity IDs that the previous turn's *Context Engine selection* contained. It cannot carry:

- a general-knowledge topic (pneumonia has no World-Model entity);
- anything when the canonical store is unreachable (no canonical items are selected);
- anything from the *assistant's* previous answer.

`memory/followUpRelevance.js` and `memory/continuation.js` are about other things: recall follow-up chains, and bare "let's continue" detection.

## 4. Context Engine V2 epistemic contract

### C-1 (D-01, S0). "Required slot `topic` unknown" for any question not about the user

REPRODUCED (see CONVERSATION_FAILURE_INVESTIGATION.md §4).

- `queryPlan.js normalizeTaskType`: `simple_qa`/`conversation`/generic → the `conversation` template, `SLOT('topic', 'thing', required=true, ['topic','subject'])`.
- `matchCandidateToSlot`: `thing` is filled by any `fact`/`entity`/`event` **from the personal floor**.
- `e8Pipeline.runBoundedRetrievalRoundsAsync`: fills the plan from **floor items only** (canonical-graph candidates gathered later never update `planState`). Round two appends the literal words "topic" and "subject" to the query.
- `assembler.js contextEpistemicState` → `unknown` at round 2; `renderBlock` renders the header **even with zero selected items** (`assembler.js:557`); `headerLines` writes `Required slots still unknown: topic. Do not infer or fabricate them.`
- `brain/contextEngine/index.js:114-118` falls back to the floor only when the floor had items. With an empty floor, the UNKNOWN block is returned.
- `chat.js:768-769` injects any non-empty block; `chat.js:782` logs it as `[PIC] Knowledge injected … items=0`.

**Consequence:** for general questions (medicine, history, science, how-to) and for every pronoun follow-up, the model is told by AQUA's own trusted-looking context that the question's topic is unknown and must not be inferred. This is the opposite of the product goal: being "context-aware" here means *suppressing* the model's world knowledge *and* the conversation.

The E8 design is sound for its intended case: personal decision questions ("Should I launch?" → goal/deadline/blockers). The defect is applying a personal-world sufficiency contract to questions that are not about the user's world. `pic/questionShape.js analyseQuestion` already exists and could make that distinction. **It is computed in `buildQueryPlan` but not used to gate the template.**

### C-2 (S2). Several generators of "say it is unknown" instructions

Five independent texts instruct the model to declare things unknown, with different scopes:

| Text | Location | Scope stated |
|---|---|---|
| `EVIDENCE STATUS: UNKNOWN … Required slots still unknown` | `assembler.js:545-547` | **unscoped**: reads as the question's subject |
| `Not known: … If it changes the answer, ask about it once.` | `assembler.js:544` | unscoped |
| `BLOCK_FOOTER` "Anything about the user not stated … is unknown" | `assembler.js:530-531` | about the user (correct) |
| `WORLD_CORE_NOTHING_SELECTED` | `brain/index.js:1197` | about the user (correct) |
| information-needs / hybrid "Not known: … Do not guess it." | `informationNeeds.js:815`, `hybridContext.js:161` | per need |

Only the user-scoped ones are safe for general questions. No single policy owns "what may AQUA claim not to know".

### C-3 (S3). Observability: "injected" for an evidence-free block

`[PIC] Knowledge injected … items=0` is logged when the only content is the UNKNOWN header (`chat.js:776-782`). Dashboards counting "knowledge injected" overstate retrieval success. The "Inconsistent memory retrieval counts" observation from production is at least partly explained by different counters measuring different lanes: `relevantFacts` (memoryRetrieve), `knowledgeItems` (Context Engine), `CTXv2 selected/candidates`, recall `excerpts`, `contextRefs` (only items whose exact line appears in the final prompt). They are not expected to agree. A full reconciliation is NOT AUDITED.

## 5. Memory extraction and admission

- `memoryObserve` runs on every user message before orchestration (`chat.js:519-523`), with a turn transaction (`memory/turnCommit.js`) committed only when the user message is persisted, and rolled back otherwise. SOURCE-CONFIRMED.
- **Sensitive-category gap (D-10, S2, REPRODUCED):** `classifyText("I have pneumonia.")` → `null`, while "I was diagnosed with pneumonia." → `health`. The health lexicon (`memory/sensitivity.js:55`) is a closed term list without common conditions (pneumonia, flu, COVID, bronchitis, …). Plain first-person statements of a condition are stored without the opt-in that the policy promises. Questions *about* a disease are correctly not personal-health statements.
- Extraction quality, conflict resolution, the Mind's belief/goal model, E6 semantic extraction and Reflection V2 cadence: **NOT AUDITED** in this pass. Prior internal audits (`AQUIPLEX_PWI_ARCHITECTURE_AUDIT.md`, `AQUIPLEX_PWI_BENCHMARK_BASELINE_REPORT.md`) report "stores more, understands less" and a forget-deletes-wrong-fact defect. Those were not re-verified here.

## 6. Degraded-mode memory behaviour (database unreachable)

SOURCE-CONFIRMED (STORAGE_AND_DURABILITY_AUDIT.md S-2): legacy read, deletion-only veto, no World Core, no canonical claims, no retired-statement filter. The model is **not told** that memory is degraded. A personal question answered in degraded mode receives the same "UNKNOWN" header as a question about something the user never said. **Failed retrieval and missing information are indistinguishable** to the model and to the user.

## 7. Required regression tests

1. `prepareTurn`-level test: a three-turn conversation (general topic → explanation → pronoun follow-up) with an empty personal store. Assert the provider request for turn 3 contains turns 1–2 **and** no `EVIDENCE STATUS: UNKNOWN` / `Required slots still unknown: topic` text.
2. `buildQueryPlan` / `assembleContext`: a general-knowledge question with an empty floor → empty block (or a user-scoped footer only), never an unscoped UNKNOWN header.
3. A personal decision question with an empty floor → still `UNKNOWN`/`PARTIAL` (preserve the existing E8 gate tests).
4. `buildContextWindow`: one oversized newest message must not evict the previous turns' antecedent (define the intended policy first, e.g. truncate the oversized message instead of dropping all).
5. `classifyText('I have pneumonia.') === 'health'` (and a list of common conditions).
6. Degraded DB: the prompt states that personal memory is temporarily unavailable, distinct from "not known".
