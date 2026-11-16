# Intelligence Pipeline Audit

Evidence levels as defined in SYSTEM_ARCHITECTURE_MAP.md. This report covers the stages between classification and the final answer that **decide, instruct or rewrite**. For each one, the questions are: what does it see, and what can it change?

## 1. Stage-by-stage visibility and authority

| Stage | Module | Sees history? | Can change the answer by | Status |
|---|---|---|---|---|
| Classifier | `core/classifier.js` | no | task type → profile, budget, prompt module | SOURCE-CONFIRMED |
| Multi-label tags | `orchestrator/multiLabelClassifier.js` | no | verification (security/financial/medical) | SOURCE-CONFIRMED |
| Orchestrator | `orchestrator/toolOrchestrator.js` | no; reads the **global** learning ledger | verification on/off, budgets, web search, project retrieval | SOURCE-CONFIRMED |
| Execution plan / reasoning strategy | `core/executionPlanner.js`, `core/reasoningStrategy.js` | no | directive text | REPRODUCED for incident |
| IIE (planner, critic, optional reasoning pass) | `intelligence/internalIntelligenceEngine.js` | **no** (params: taskType, complexity, confidence, userMessage, …) | `synthesis.text` injected into the system prompt | SOURCE-CONFIRMED |
| CIE question model, style, plan, directive | `cognition/questionModel.js`, `reasoningPlanner.js` | **no** | directive lines incl. "Ground every claim in the provided context; if the context lacks it, say so" and "ask ONE clarifying question" | REPRODUCED: no directive for incident messages |
| Context Engine V2 / E8 | `brain/contextEngine/*` | **no** | `EVIDENCE STATUS` header and instructions | REPRODUCED: UNKNOWN for incident messages |
| Drafter | `providers/router.js` | **yes** (window) | — | SOURCE-CONFIRMED |
| Task-graph runtime (agent tasks) | `orchestrator/graphRuntime.js` | **no**: `context` holds only memory/evidence/search | replaces the drafter entirely | SOURCE-CONFIRMED |
| CIE draft monitor | `cognition/reasoningMonitor.js` | no | escalates to verification | SOURCE-CONFIRMED |
| Verification | `intelligence/verificationAgent.js` | **no** | **replaces the answer** | SOURCE-CONFIRMED |
| Debate | `intelligence/debateAgent.js` | **no** | **replaces the answer** | SOURCE-CONFIRMED |
| Identity guard | `identity/` | no | replaces on self-questions | SOURCE-CONFIRMED |

**Authority inversion:** the only component that sees the conversation (the drafter) is subordinate to components that do not see it. Pre-generation, they write its instructions. Post-generation, they can overwrite its output.

## 2. Findings

### I-1 (D-02, S0). Reviewers judge follow-ups without the conversation

`verificationAgent.js:186-189`:

```js
const critiqueMessages = [{ role: 'user',
  content: `${evidenceBlock}Original user question:\n${userMessage}\n\nDraft answer to review:\n${current}` }];
```

`debateAgent.js:221` and `:279` use the same shape. `runVerification` in `chat.js:997-1029` passes no history, and neither agent accepts one. Rubric for `simple_qa` / `conversation`: *Logical inconsistencies, Weak assumptions, Hallucination risk* (REPRODUCED). A correct follow-up answer naming the antecedent ("pneumonia") is, from the reviewer's view, an assumption the question never stated. The prompt instructs the reviewer to return "the complete corrected replacement answer" for such a risk. The guards (`isUsableRevision`, truncation, grounded capability refusal) do not catch a clarifying question. The result is persisted as the assistant turn (D-06).

**User-visible consequence:** correct, context-aware answers replaced by requests for clarification or by generic hedges, specifically on follow-up turns, the turns where context-awareness matters most. Production's repeated `revised_unconfirmed` is the observable trace of replacements, though not proof that each was this mechanism.

### I-2 (D-05, S1). The verification gate learns globally and reinforces itself

`getTaskStats(taskType)` (`learningLedger.js:214-223`) aggregates **all users'** turns per task type. `shouldVerify` (`verificationStrategy.js`) enables verification when `turns ≥ 10` and `revised/ran ≥ 0.30`. Because the denominator is `ran` and I-1 produces revisions on many follow-ups, the gate keeps itself on: more verification → more history-blind revisions → a higher revision rate. One user's traffic changes every other user's pipeline, and the ledger file is in the mirrored data directory, so it survives deploys.

REPRODUCED: with `{ sampleSize: 20, revisionRate: 0.4 }`, all three incident messages switch to `verify: true`. Whether production's ledger is in that state is HYPOTHESIS (runtime evidence: `.aqua-ledger.json → byTask.simple_qa`).

### I-3 (D-11, S2). The medical rule does not recognise medical questions

`multiLabelClassifier.js:50-51` matches `diagnos|symptom|medication|dosage|patient|clinical|treatment plan|medical record`. REPRODUCED: "Is pneumonia curable?" → `tags: []`. The static "medical reasoning → verify" rule, the only *intended* trigger for medical content, misses disease and treatment questions. So review on medical questions is decided by unrelated signals (the ledger, the CIE monitor), not by risk.

### I-4 (D-04, S1). Task-graph runtime has no conversation history

`chat.js:1448-1466`: when `taskType === 'agent_task'` (or high complexity with a numbered list), `runTaskGraph({ userMessage, taskType, plan, context: { memory, evidence, search }, budget, ctx })` serves the turn. `graphRuntime.js` contains no reference to history or messages (SOURCE-CONFIRMED by search). An agent-style follow-up ("now do the same for the second one") is generated with no conversation at all. The streaming endpoint never takes this path (`chat.js:1446`), so `/chat` and `/chat/stream` differ in history handling for the same message.

### I-5 (S2). The IIE reasoning pass analyses the message without its antecedent

When a reasoning pass runs (high complexity, or low confidence plus a long or sensitive message), its analysis of the bare message is injected into the system prompt as `intelligence.synthesis.text`. For a follow-up, that analysis is about an underspecified question and can steer the drafter away from the antecedent. Severity depends on how often reasoning passes run on follow-ups. NOT MEASURED.

### I-6 (S2). CIE question model can recommend clarification for deictic openers without checking history

`questionModel.js:25, 85, 122`: messages that *start* with it/this/that, are under 12 words and have classifier confidence < 0.7 get `deictic_opener`. With score ≥ 0.6 (needs a second strong signal), it recommends `LINE_CLARIFY`. Not triggered in this incident (REPRODUCED). "Is it curable?" does not start with a deictic word, but "It's curable, right?" or "That one — is it curable?" may be. The decision ignores whether history supplies the referent.

### I-7 (S3). Monitor escalation on refusal-shaped drafts adds a history-blind review

`reasoningMonitor.js:97-101`: a draft matching `REFUSAL_RE` while evidence is present triggers a critical `dead_end`, then verification. The UNKNOWN block counts as "evidence present". So a drafter that obeys the UNKNOWN block ("I can't determine…") is escalated to a reviewer that also lacks history. That reviewer cannot restore the answer and may reinforce the refusal.

## 3. Duplicated or competing intelligence (summary; see DUPLICATION_AND_TECHNICAL_DEBT.md)

Five classifiers of the same message (`classifyTask`, multi-label, CIE question model, PIC `questionShape`, E8 `queryPlan`) and three post-generation authorities (monitor, verification, debate) make decisions independently. None of them has a shared notion of "what this conversation is about".

## 4. Not audited in this pass

Mind belief and goal dynamics, Reflection V2 and revision voice, the proactive engine, the Digital Twin, E6 extraction accuracy, the PIC knowledge graph and timeline internals, and the UUS interview flow. Their **inputs** on the turn path were checked (none receives history). Their internal correctness was not.
