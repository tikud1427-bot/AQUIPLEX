# Aqua Context Engine Audit

**Date:** 2026-11-10 · **HEAD:** `839ea0d1` · Part of the [Production Intelligence Audit](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md). Labels: **V** verified · **I** inferred · **U** unknown · **NI** not implemented.

## 1. There are two context engines

| | **Production pipeline** (runs today) | **Context Engine V2/V3** (`brain/contextEngine/`) |
|---|---|---|
| Entry | `prepareTurn` (`routes/chat.js:401`) composing independent lanes | `Brain.assembleContextAsync` → `assembleTurnContextAsync` (`contextEngine/index.js:60`) |
| Gate | always | `AQUA_CONTEXT_V2=on` (off); canonical lanes need Postgres |
| Sources | identity card, legacy facts, Mind cognitive block, Mind graph + episodes, file chunks/memory, PIC floor (file evidence), attachments, project, web search, **episodic recall** | PIC floor + canonical claims (dense + graph + slot lanes), world core, conversation focus |
| Selection | each lane ranks itself; lanes are concatenated | query plan → bounded 2-round retrieval → 10-dimension scorer → (RRF + cross-encoder with V3) → diversity-aware budgeted assembler |
| Missing information | not represented | "Not known: … ask about it once" when required slots are unfilled after round two (`assembler.js:531-549`) |
| Budget | memory block 800 tok (`engine.js:75`); recall 8k chars whole / 3.6k ranked; PIC 1,600 chars; history window by complexity | `charBudget` 1,600 + world core budget |

Everything below about "production" refers to the left column ([F-01](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-01), [F-08](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-08)).

## 2. Capability-by-capability

| Capability | Production implementation | V2/V3 implementation | Assessment |
|---|---|---|---|
| **Query analysis** | Seven independent analysers, each re-reading the message: `classifyTask` (`core/classifier.js:393`), `detectIdentityIntent`, `isIdentityQuery`, `isMemoryQuery`/`detectCategoryIntent`/`detectSemanticConcepts`/`detectKeyIntent` (`memoryRetriever.js`), `assessQuestion` (CIE, `cognition/questionModel.js:77`), `analyseQuestion` (PIC, `pic/questionShape.js:250`), `isPastRecallQuery`, `detectContinuation` | adds `buildQueryPlan` + `isDecisionForm` | No shared question representation; analysers can disagree within one turn (V) |
| **Intent classification** | regex classifier; "Should I hire another developer?" → `simple_qa` @ 0.45 (probe) | `isDecisionForm` upgrades generic labels to `decision` | Decision questions are misclassified in prod ([F-07](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-07)) |
| **Context planning** | none — every lane runs for every turn (identity/recall skipped for self-questions) | slot templates per task (`queryPlan.js` TEMPLATES): decision = goal, deadline, blockers, constraints, risk, prior plans | Planning exists only in V2 and only over canonical predicates |
| **Semantic retrieval** | fact cosine blend `(cos−0.55)×700` (`memoryRetriever.js:125-203`); file chunks; recall semantic **off** | canonical dense lane (pgvector or local), lexical fallback | Prod is keyword-first; embeddings only nudge facts |
| **Memory retrieval** | `retrieveRelevantFacts`: importance×15 + confidence×20 + intent/category/key/value hints + recency + semantic; threshold 50 for generic queries; impersonal gate (`:266`) | n/a (legacy gap-fill) | Good guardrails on the *fact* lane; other lanes lack them |
| **Entity retrieval** | Mind graph: first node whose label is a substring of the query (`mindRetriever.js:269-283`); PIC lane 2 (canonical, alias-aware entities from files) | canonical entity lanes, role anchors (`roleAnchorsForQuery`) | Substring match; no alias resolution for chat entities in prod |
| **Relationship traversal** | `recallGraphPaths` multi-hop over the Mind graph; PIC lane 3 one hop over `about` edges | `gatherCanonicalGraphCandidates` | Prod multi-hop produces noise: `Ana ←related_to— user —targets→ launch the mobile app` (probe) |
| **Project relevance** | workspace retrieval when orchestrator or `REPO_INTENT_RE` fires | `active_project` dimension | OK for code workspaces; "project" as a life project is not modelled in prod |
| **Goal relevance** | cognitive block shows top-3 goals **regardless of question** (`AQUA_MIND_RELEVANCE` off) | `active_goal` dimension; Mind relevance (C9) when on | Not question-gated in prod ([F-06](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-06)) |
| **Temporal relevance** | PIC lane 4 (timeline, temporal questions only); recall dates every quote; profile "(previously …)" | lifecycle states, `asserted_at`, supersession notes | Present but text-level |
| **Recency** | facts +40/+20/+10 for <1 min/<10 min/<1 h (`memoryRetriever.js:194`); recall oldest→newest | exponential decay dimension | Fact recency bonus is about seconds-to-hours, not life recency |
| **Confidence** | facts ≥0.5 retrieved, ≥0.55 rendered; Mind "confidence <70% = hunch" instruction | dimension + lifecycle (trusted/disputed/stale) | OK |
| **Source reliability** | blocks labelled ("user-stated, authoritative", "inferred", UNTRUSTED fences) | `source_reliability` dimension (document > conversational > inferred) | Labelled, not weighted, in prod |
| **Contradiction detection** | read-time: `laterWords`/`retired` hide stale Mind beliefs; recall "since changed" notes; PIC disputed flag | canonical contradiction policy (DB workers) | Only for captured facts |
| **Context diversity** | none across lanes — the same fact can appear in profile, cognitive block, graph and recall | diversity-aware assembler | Duplication in prompt (probe: "Tidewell" appears 3× in one prompt — identity card, profile, recall; "January 15" 3×) |
| **Token budgeting** | per-lane budgets; lane dropped whole if it does not fit (`engine.js:460`) | one char budget for the block | No global budget across memory + PIC + recall + project |
| **Compression** | none (verbatim quotes, sentence-level facts) | none (selection only) | — |
| **Prompt assembly** | `buildSystemPrompt(taskType, memoryBlock, directives, combinedContext, synthesis, identity, search)` — fixed ≈ 1k tokens of non-personal scaffolding per turn ([F-17](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-17)) | same seam | — |
| **Clarifying questions** | CIE recommends one when the *wording* is ambiguous (`ambiguity ≥ 0.6 && confidence < 0.7 && words < 15`, `questionModel.js:122`) | V2 "if it changes the answer, ask about it once" for unfilled slots | Prod never asks because *personal information* is missing |

## 3. Does Aqua retrieve what a question needs, or what is similar?

**In production: neither, mostly.** Below 8,000 characters of history, recall quotes **everything** the user ever said, and the Mind block injects goals/blockers/deadline/open question/prediction on **every** turn; above that window, the decisive lane (recall) is **keyword similarity** over the user's own messages. The fact lane is the only one with question-aware gating (directed-intent and impersonal gates), and it holds the least information ([F-04](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-04)). **V.**

### Walkthrough — "Should I hire another developer?" (probe, code defaults, no DB)

What a good answer requires: team size and composition (changed), workload and roadmap (launch deadline, payments blocker), money (runway 9 months, $1.2M raised), hiring history/plans (hedged designer plan), goals.

| Need | Captured as structure? | Reached the prompt — short history | Reached the prompt — long history (ranked recall) |
|---|---|---|---|
| Team: 3 engineers → Marco left → 2 | **No** | only as verbatim quotes | "How many engineers" yes; **"Should I hire" no** |
| Runway 9 months | yes (`custom runway`) | yes (profile) | yes (profile) |
| $1.2M raised | **No** | quotes only | **No** |
| Launch Jan 15 | yes (goal) | yes | yes (goal + cognitive) |
| Payments blocker | yes (Mind blocker) | yes | yes (cognitive block — by accident: it is injected for every question) |
| Hiring plans | correctly not stored (hedged) | quote | quote (the *only* recall hit) |
| What is missing / should be asked | **NI** | — | — |

The long-history column is where every retained user ends up. It shows the production pipeline answering a decision question with the runway and the deadline but **without the team size or its recent change** — exactly the "Aqua already understands the relevant context" promise failing on the flagship question shape.

## 4. Opportunities for question-driven context construction (ranked)

1. **An information-needs model on the production path (highest impact).** Generalise `queryPlan.js` slot templates from canonical predicates to *store-agnostic needs* (e.g. `team`, `finances`, `commitments`, `blockers`, `goals`, `prior decisions`, `constraints`), each with resolvers over the stores that exist in production: fact keys/categories, Mind goals/blockers/deadlines, recall queries (need-specific query expansion — "team" → engineers, hired, left, joined, headcount), and canonical predicates when Postgres exists. Output: selected items per need **and** an explicit `unknown` list rendered as "Not known: … ask once if it changes the answer" (the V2 renderer already has this text). Reuses `isDecisionForm`, `fillQueryPlan`, `assessSufficiency` unchanged.
2. **Need-gated lanes.** The cognitive block, graph recall and whole-history recall run only when a need asks for them (or the question is personal); impersonal questions get none (today they get the cognitive block and up to 2k tokens of quotes).
3. **Replace "quote everything ≤8k chars" with need-driven recall + recency.** Keep the verbatim quote format (it is the strongest evidence lane), but select by need. This also caps the per-turn token cost that today grows to ≈2k tokens per turn for every user under the window.
4. **One question representation per turn.** Build it once (shape, decision form, personal/impersonal, temporal, entities, needs) and pass it to every lane, replacing seven re-analyses. Fixes the 0.45-confidence escalation for decision questions as a side effect ([F-07](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-07)).
5. **Cross-lane de-duplication and one global context budget**, using the V2 assembler's diversity logic over lane outputs.
6. **Capture the facts decisions depend on** (team/headcount changes, money, third-party attributes). This is an extraction problem, not a retrieval one — see [Roadmap R-4](AQUIPLEX_ENGINEERING_ROADMAP.md).

Each of these is measured by the context-level stage of the [benchmark](AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md) (context precision/recall per need, unknown-detection) before any answer-level run.
