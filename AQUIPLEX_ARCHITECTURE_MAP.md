# AQUIPLEX Architecture Map (as built, 2026-11-10)

**HEAD:** `839ea0d1`. Part of the [Production Intelligence Audit](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md). This is the existing system, not a target design.

Legend used in all diagrams: **solid green** = runs in the documented production configuration (code defaults, no Postgres) · **dashed grey** = exists but inert in production (flag off by default, or needs Postgres) · **orange** = runs, with a finding attached.

## 1. Deployment topology

```mermaid
flowchart LR
  subgraph Clients
    WEB["Browser SPA<br/>aqua-frontend (Vite/React)"]
    AND["Android app<br/>(Capacitor)"]
  end

  subgraph Render["Render service (single instance)"]
    IDX["index.js (CJS Express)<br/>helmet · rate limits · sessions · Passport · CSRF<br/>billing · wallet · usageGuard"]
    RT["aqua/router.js (ESM)<br/>/chat /chat/stream /memory /conversations<br/>/upload /project /artifacts /mind<br/>/understanding /intelligence /brain"]
    DISK[("~/.aquiplex/*.json<br/>25 whole-file stores<br/>ALL users per file")]
    WK["aqua/scripts/worker.mjs<br/>durable jobs"]
  end

  MONGO[("MongoDB Atlas<br/>users · wallet · sessions · billing<br/>aqua_kv mirror of every JSON store")]
  PG[("Postgres + pgvector<br/>entities · claims · jobs · outbox<br/>beliefs · proactive · embeddings")]
  LLM["LLM providers<br/>Groq · Gemini · OpenRouter · NVIDIA<br/>score-ranked, fallback"]
  EMB["Embedding provider"]
  SRCH["Web search providers"]

  WEB -->|"POST /api/aqua/chat/stream (SSE)"| IDX
  AND --> IDX
  IDX -->|"requireLogin → req.aquaUserId"| RT
  RT <--> DISK
  DISK -->|"whole-file mirror, last-writer-wins + gen CAS"| MONGO
  MONGO -->|"boot hydration"| DISK
  IDX <--> MONGO
  RT --> LLM
  RT --> EMB
  RT --> SRCH
  RT -.->|"only with DATABASE_URL"| PG
  WK -.->|"exits without DB"| PG

  classDef prod fill:#e6f4ea,stroke:#2e7d32,color:#1b1b1b;
  classDef inert fill:#f2f2f2,stroke:#9e9e9e,stroke-dasharray: 5 5,color:#555;
  classDef warn fill:#fff3e0,stroke:#ef6c00,color:#1b1b1b;
  class IDX,RT,WEB,AND,LLM,EMB,SRCH prod;
  class PG,WK inert;
  class DISK,MONGO warn;
```

Orange: [F-10](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-10) (all users per file, single instance), [F-20](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md#f-20) (boot-hydration overwrite).

## 2. One chat turn (`POST /chat/stream`, `routes/chat.js`)

```mermaid
flowchart TD
  A["Request · requireLogin · usageGuard<br/>index.js:629-691"] --> B["Conversation access check + getOrCreate<br/>chat.js:1462 · conversationStore.js"]
  B --> C["prepareTurn · chat.js:401"]

  subgraph PREP["prepareTurn"]
    C1["resolveOwner → user:&lt;id&gt;<br/>sensitivity policy + redacted write view"]
    C2["start embeddings: facts · canonical · files"]
    C3["classifyTask (regex)"]
    C4["memoryObserve — WRITES memory now<br/>regex facts · forget · correction · current-state<br/>Mind: beliefs · goals · working · episodes · graph"]
    C5["orchestrate · plan · reasoning strategy"]
    C6["Reasoning pass (LLM)<br/>if complexity high or conf &lt; 0.5"]
    C7["CIE cognitivePrepare (default ON)"]
    C8["resolveReadMode → legacy (no DB)"]
    C9["memoryRetrieve · 800 tok<br/>identity · facts · Mind cognitive block<br/>graph · episodes · file chunks/memory"]
    C10["project · attachments"]
    C11["PIC floor (file evidence)"]
    C11b["Context Engine V2/V3<br/>query plan · sufficiency · Not known"]
    C12["web search (if orchestrator)"]
    C13["Episodic recall — verbatim past messages<br/>all ≤ 8k chars, else keyword-ranked"]
    C14["revision voice · proactive directive"]
    C15["buildSystemPrompt + context window"]
    C1 --> C2 --> C3 --> C4 --> C5 --> C6 --> C7 --> C8 --> C9 --> C10 --> C11 --> C12 --> C13 --> C14 --> C15
    C11 -.->|"AQUA_CONTEXT_V2=on"| C11b
  end

  C --> C1
  C15 --> D["generateTextStream → tokens over SSE<br/>providers/router.js"]
  D --> E["observeDraft (CIE) → verification / debate (LLM)<br/>replace event if revised"]
  E --> F["identity guard · addMessage ×2 · SSE done"]
  F --> G["defer: runPostTurn · turnPostProcess.js"]

  subgraph POST["post-turn (detached)"]
    G1["mindAfterTurn: predictions, Mind reflection"]
    G2["conversation ingest → evidence + graph"]
    G3["Digital Twin"]
    G4["E6 understanding (LLM) → claims / job"]
    G5["Reflection V2 every 8 msgs<br/>computed; applied only if flag on"]
    G6["PIC consolidation"]
    G7["claim shadow projection"]
  end
  G --> G1
  G -.-> G2
  G -.-> G3
  G -.-> G4
  G --> G5
  G -.-> G6
  G -.-> G7

  classDef prod fill:#e6f4ea,stroke:#2e7d32,color:#1b1b1b;
  classDef inert fill:#f2f2f2,stroke:#9e9e9e,stroke-dasharray: 5 5,color:#555;
  classDef warn fill:#fff3e0,stroke:#ef6c00,color:#1b1b1b;
  class A,B,C,C1,C3,C5,C8,C10,C11,C12,C15,D,E,F,G,G1 prod;
  class C11b,C14,G2,G3,G4,G6,G7 inert;
  class C2,C4,C6,C7,C9,C13,G5 warn;
```

Orange nodes and their findings: C2 [F-13](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-13) · C4 [F-04](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-04), [F-12](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-12) · C6 [F-07](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-07) · C7 [F-02](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-02) · C9 [F-06](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-06), [F-09](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-09) · C13 [F-05](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-05) · G5 [F-18](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-18). C14 returns '' without Postgres.

## 3. Where one user statement goes

"I now work at Northbeam" — writers on the left, the prompt sections that read each store on the right.

```mermaid
flowchart LR
  MSG["User message"] --> OBS["memoryObserve<br/>memory/engine.js:138"]

  OBS --> F1[("Legacy facts<br/>mind.facts · history · transitions")]
  OBS --> M1[("Mind beliefs")]
  OBS --> M2[("Mind goals · working memory")]
  OBS --> M3[("Mind graph · episodes · predictions")]
  MSG --> H[("Conversation history")]

  MSG -.->|"BRAIN_INGEST"| EV[("PIC evidence + reasoning graph")]
  MSG -.->|"E6 + DB"| CL[("Canonical claims (Postgres)")]
  FILES["Uploaded files"] --> EV

  F1 -->|"identity card + profile"| P["System prompt"]
  M1 -->|"cognitive block"| P
  M2 -->|"cognitive block (every turn)"| P
  M3 -->|"graph / episode lanes"| P
  H -->|"episodic recall (verbatim)"| P
  EV -->|"PIC floor"| P
  CL -.->|"canonical read / CE V2"| P

  F1 -.->|"AQUA_PROPAGATION (off)"| M1
  F1 -.->|"AQUA_PROPAGATION (off)"| M3
  F1 -.->|"AQUA_PROPAGATION (off)"| EV
  F1 -->|"read-time: retired / laterWords"| M1

  classDef prod fill:#e6f4ea,stroke:#2e7d32,color:#1b1b1b;
  classDef inert fill:#f2f2f2,stroke:#9e9e9e,stroke-dasharray: 5 5,color:#555;
  class MSG,OBS,F1,M1,M2,M3,H,P,FILES,EV prod;
  class CL inert;
```

With propagation off, a change reaches the Mind copies only as read-time filtering ([Knowledge §2 Q3–Q6](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md)); the evidence lane holds chat sentences only when ingest is on.

## 4. Module index

| Area | Path | Entry points |
|---|---|---|
| Chat pipeline | `aqua/src/routes/chat.js` | `prepareTurn`, `router.post('/')`, `router.post('/stream')`, `runVerification`, `memoryWriteTurn` |
| Post-turn | `aqua/src/routes/turnPostProcess.js` | `runPostTurn` |
| Memory facade | `aqua/src/memory/engine.js` | `memoryObserve`, `memoryRetrieve`, `legacySupersessionNotes`, `uncertaintyNotes`, `rememberFile` |
| Fact store | `aqua/src/memory/longTermMemory.js`, `factChange.js`, `memoryRetriever.js`, `memoryExtractor.js`, `candidateExtractor.js` | `storeFact`, `applyCurrentState`, `retrieveRelevantFacts`, `extractFactsWithReport` |
| Recall | `aqua/src/memory/episodicRecall.js`, `semanticRecall.js`, `recallRedactions.js` | `recallForTurn` |
| Propagation | `aqua/src/memory/propagation.js` | `recordTransitions`, `reconcileMind`, `withTransitions`, `startPropagationSweeper` |
| Mind | `aqua/src/mind/` | `mindObserve`, `mindContext` → `retrieveCognitiveContext`, `mindAfterTurn`, `mindStore` |
| PIC | `aqua/src/pic/core.js`, `retrievalIntelligence.js`, `questionShape.js` | `retrieveKnowledge` (lanes 1–7) |
| CIE | `aqua/src/cognition/index.js` | `cognitivePrepare`, `cognitiveKnowledgeRetrieve`, `observeDraft` |
| Brain facade | `aqua/src/brain/index.js` | `resolveReadMode`, `legacyVetoFor`, `assembleContextAsync`, `canonicalSemanticScores`, `understandTurn`, `observeConversationTurn`, `reflectTurn`, `revisionDirectiveForTurn` |
| Context Engine | `aqua/src/brain/contextEngine/` | `assembleTurnContextAsync`, `buildQueryPlan`, `assembleContext`, `scorer` |
| E6 | `aqua/src/brain/understanding/pipeline.js` | segmentation → gate → extraction → validation → temporal → entity resolution |
| Reflection | `aqua/src/mind/reflectionEngine.js`, `brain/reflectionV2/`, `brain/reflectionV3/`, `cognition/reflectionEngine.js` | four modules ([Knowledge §4](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md)) |
| Stores | `aqua/src/core/dataDir.js`, `atomicStore.js`, `mongoMirror.js`, `core/storage/`, `core/db/` | `hydrateFromMongo`, `createDebouncedWriter` |
| Jobs | `aqua/src/core/jobs/`, `aqua/scripts/worker.mjs` | `enqueue`, `runOneJob`, `HANDLERS` |
| Providers | `aqua/src/providers/router.js` | `generateText`, `generateTextStream` |
| Flags | `aqua/src/core/flags.js` | `GATES`, `flagReport`, `flagBootLine` |
| Deletion | `aqua/src/account/accountPurge.js` | `purgeOwnerData` |
