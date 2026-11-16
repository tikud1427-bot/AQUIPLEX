# Conversation Recovery — Implementation Report

Written for: the AQUIPLEX engineer/founder reviewing this repair before deciding whether to commit. Nothing was committed, pushed or deployed.

Input: the ten forensic reports in `audit/forensic-2026-11-16/` (re-confirmed against current source before each repair). No newer reports existed. Baseline: CONVERSATION_RECOVERY_BASELINE.md.

## Answer to the incident

"Is it curable?" failed because (1) E8 told the model the topic of any general question was unknown, and (2) history-blind reviewers rewrote follow-up answers into clarifications, with nothing resolving the reference for retrieval. All three are repaired and the pneumonia sequence passes end-to-end on the production route path (T01). It has **not** been validated with real models (see REMAINING_DEFECTS R-1).

## Defect status

| Defect | Status | Where | Evidence |
|---|---|---|---|
| D-01 E8 "topic unknown" for general questions | FIXED+TESTED | `brain/contextEngine/queryPlan.js buildQueryPlan`, `e8Pipeline.js`, `contextEngine/index.js`, `assembler.js headerLines`, `brain/index.js assembleContextAsync` | e8PersonalScope (8), T01, T06, T07 |
| D-02 reviewers without history | FIXED+TESTED | `intelligence/verificationAgent.js runVerification`, `debateAgent.js runDebate`, `evidenceContext.js` (rule, guard, outcomes, reason parsing), `routes/chat.js runVerification` | conversationAwareReview (9), T01, T08, T20 |
| D-03 no follow-up resolution in retrieval | FIXED+TESTED | `core/conversationContext.js` (new), all retrieval call sites in `chat.js prepareTurn` | conversationContext (16), T02–T05, T09 |
| D-04 task graph without history | FIXED+TESTED | `orchestrator/graphRuntime.js nodeSystemPrompt`, `chat.js` graph context | T10 |
| D-05 global self-reinforcing gate | PARTIAL | `intelligence/learningLedger.js recordOutcome/getTaskStats/revisionBasis` | ledger tests; cross-user aggregation remains (R-5) |
| D-06 rewrites persisted as history | FIXED+TESTED | `memory/conversationStore.js addMessage` (verdict field), `chat.js` assistantExtra | T08 |
| D-07 silent empty re-creation | FIXED+TESTED (503 branch not tested) | `conversationStore.conversationLoadState/recoverConversation`, `chat.js resolveTurnConversation` | T12, T13 |
| D-08 window wiped by one long message | FIXED+TESTED | `core/tokenManager.js buildContextWindowWithStats` | contextWindow (6), T16 |
| D-09 silent degraded memory | PARTIAL (reported, not cured) | operator notice in `chat.js`, `persistenceState` | T19; DB itself is operational (R-3) |
| D-10 health disclosures missed | FIXED+TESTED | `memory/sensitivity.js CONDITION_*`, `classifyText`, `classifyHealthContext` | healthSensitivity (4), T17 |
| D-11 medical tag misses diseases | FIXED+TESTED | `orchestrator/multiLabelClassifier.js` | healthSensitivity |
| D-12 no turn-level test | FIXED | `routes/tests/conversationRecovery.e2e.test.js` (22) | — |
| D-13 owner-less auto-create | FIXED (not separately tested) | `conversationStore.addMessage`, `turnPostProcess.commitTurnWithLearning` | full batteries |
| D-14 overlapping turns | FIXED+TESTED (single instance) | `core/conversationTurnLock.js` (new), both chat handlers | lock tests (4), T15, T15b |
| D-15 mirror unverified → not durable | PARTIAL (truthful reporting only) | `persistenceState`, `atomicStore.createDebouncedWriter onFlushed` | T19; operational (R-4) |
| D-16 misleading logs | FIXED+TESTED | `chat.js` `[PIC]` lines, `logTurnDiagnostics` | e2e logs inspected |
| D-17 policy inside untrusted fence | FIXED+TESTED | `assembler.renderBlockParts`, `brain/index.withWorldCore`, `core/promptBuilder.buildSystemPrompt(enginePolicy)` | T18, e8PersonalScope |
| CIE clarification on resolved deixis | FIXED+TESTED | `cognition/questionModel.assessQuestion`, `cognition/index.cognitivePrepare` | resolvedDeixis, T21 |
| IIE reasoning on bare pronoun | FIXED+TESTED | `intelligence/internalIntelligenceEngine.runIntelligencePipeline(reasoningMessage)` | resolvedDeixis |

No paid service, dependency, model call, database, migration or infrastructure was added. The only additional provider usage: verification now runs on medical-tagged questions (the policy's intent, R-13).

## Diff summary (this repair only — computed against pre-edit copies, excluding the owner's prior uncommitted edits)

Modified (27 files, +918 / −114 lines):

```
aqua/src/routes/chat.js                              +211 −45
aqua/src/memory/conversationStore.js                 +125  −4
aqua/src/intelligence/evidenceContext.js             +106  −0
aqua/src/core/tokenManager.js                         +95 −15
aqua/src/memory/sensitivity.js                        +57  −0
aqua/src/intelligence/verificationAgent.js            +46  −6
aqua/src/intelligence/learningLedger.js               +35  −3
aqua/src/intelligence/debateAgent.js                  +34  −5
aqua/src/brain/contextEngine/queryPlan.js             +33  −3
aqua/src/brain/contextEngine/assembler.js             +31 −10
aqua/src/brain/index.js                               +28  −0
aqua/src/intelligence/learningLedger.test.js          +19  −3
aqua/src/core/flags.js                                +15  −0
aqua/src/core/promptBuilder.js                        +12  −1
aqua/src/routes/turnPostProcess.js                     +9  −2
aqua/src/core/tests/flagReadSiteParity.test.js         +9  −0
aqua/src/orchestrator/graphRuntime.js                  +7  −1
aqua/src/orchestrator/multiLabelClassifier.js          +6  −0
aqua/src/cognition/questionModel.js                    +6  −2
aqua/src/intelligence/internalIntelligenceEngine.js    +5  −2
aqua/src/core/tests/flagRegistry.test.js               +5  −5
aqua/src/core/atomicStore.js                           +5  −1
aqua/eval/tests/readPathParity.test.js                 +5  −1
aqua/src/orchestrator/verificationStrategy.js          +4  −1
aqua/src/cognition/index.js                            +4  −2
aqua/src/brain/contextEngine/e8Pipeline.js             +4  −2
aqua/src/brain/contextEngine/index.js                  +2  −0
```

New (10 files):

```
aqua/src/core/conversationContext.js                          327
aqua/src/core/conversationTurnLock.js                          87
aqua/src/routes/tests/conversationRecovery.e2e.test.js         428
aqua/src/core/tests/conversationContext.test.js               135
aqua/src/intelligence/tests/conversationAwareReview.test.js   123
aqua/src/brain/tests/e8PersonalScope.test.js                   88
aqua/src/core/tests/contextWindow.test.js                      74
aqua/src/core/tests/conversationTurnLock.test.js               51
aqua/src/cognition/tests/conversationResolvedDeixis.test.js    48
aqua/src/memory/tests/healthSensitivity.test.js                44
```

Plus 10 reports in `audit/conversation-recovery-2026-11-16/`. `git diff` on the repository shows these changes mixed with the owner's pre-existing uncommitted work; the per-file pre-edit copies (session scratchpad `originals/`) separate them.

## Related reports

SHARED_CONTEXT_CONTRACT_IMPLEMENTATION.md · VERIFICATION_AND_RETRIEVAL_REPAIR_REPORT.md · STORAGE_CONCURRENCY_AND_DURABILITY_REPORT.md · HEALTH_PRIVACY_AND_SECURITY_REPAIR_REPORT.md · CONVERSATION_REGRESSION_TEST_RESULTS.md · REMAINING_DEFECTS_AND_OPERATIONAL_LIMITATIONS.md · ROLLBACK_AND_DEPLOYMENT_GUIDE.md
