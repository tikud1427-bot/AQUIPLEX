# Duplication and Technical Debt

Evidence levels as defined in SYSTEM_ARCHITECTURE_MAP.md. Measured at audit time: 389 non-test JS modules (~91,300 lines) under `aqua/src`, 23 subsystem directories, 190 Markdown reports in the repository root plus 30 in `aqua/`, and 22 loose JSON/patch/script artefacts in the root.

## 1. Competing sources of truth

| Concern | Implementations | Arbitration | Evidence |
|---|---|---|---|
| The user's world | Legacy facts (`.aqua-memory.json`), Mind (`.aqua-mind.json`), PIC (`.aqua-pic.json`), evidence store (`.aqua-evidence.json`), canonical World Model (Postgres) | Per-turn DB reachability (`resolveReadMode`); veto/gap-fill rules | SOURCE-CONFIRMED |
| Conversation history | Map + JSON + Mongo mirror; Postgres partitions (off) | Partition mode flag | SOURCE-CONFIRMED |
| "What is this question about?" | `classifyTask`, `classifyMultiLabel`, CIE `assessQuestion`, PIC `analyseQuestion`, E8 `buildQueryPlan`, `detectIdentityIntent`, artifact/edit intent regexes | None. Each feeds its own consumer. | SOURCE-CONFIRMED |
| "What may AQUA say it doesn't know?" | E8 UNKNOWN/PARTIAL header, `BLOCK_FOOTER`, `WORLD_CORE_NOTHING_SELECTED`, information-needs "Not known", hybrid "Not known", CIE `LINE_EVIDENCE_REQUIRE` | None | SOURCE-CONFIRMED |
| Answer quality authority | Drafter, CIE monitor, verification agent, debate agent, identity guard | Order of execution | SOURCE-CONFIRMED |
| Learned global behaviour | Learning ledger (verification gate, provider prior), cognitive store (strategy stats), PIC reasoning feedback | Independent | SOURCE-CONFIRMED |

The incident is a direct product of row 4 colliding with row 3. A personal-world sufficiency rule (E8) issued an "unknown" verdict on a question that the classifier and question-shape analyser already characterised as a generic fact question. No component reconciled the two.

## 2. Duplicated mechanisms

1. **Retrieval lanes over the same owner data, each with its own ranking and token budget:** memoryRetrieve, PIC floor, Context V2 (+ V3 RRF, optional cross-encoder), World Core, episodic recall, semantic recall, information-needs, hybrid. Seven-plus blocks can reach one prompt. Their budgets are independent; nothing measures the total.
2. **Two history-window concepts:** `tokenManager.buildContextWindow` (drafter) and the `excludeFromIndex` bookkeeping in recall and information-needs. Correct today, but coupled through an index offset, not a shared object.
3. **Three generation paths with different context:** single-call (history), task graph (no history), artifact/edit branches (own prompts; artifact agent receives `prep` but no explicit window. NOT AUDITED in depth).
4. **Two reviewer agents** (verification and debate) with copy-shaped prompts (`Original user question:` …), so a fix to one must be repeated in the other.
5. **Synchronous and asynchronous Context Engine entry points** (`assembleTurnContext` / `assembleTurnContextAsync`, `assembleContext` / `assembleContextAsync` in `brain/index.js:1086-1195`) with near-identical bodies.
6. **Twenty JSON stores each re-implementing load/save/purge** on top of the shared atomic writer, plus a partition binding layer per store.

## 3. Debt that hides defects

- **Fail-open everywhere, with no degraded-state propagation.** Each guard is locally reasonable. Collectively, the answer is produced from whatever survived, with no record in the prompt or payload of what did not.
- **Flags without a production manifest.** Behaviour depends on more than 20 `AQUA_*` flags (SYSTEM_ARCHITECTURE_MAP.md §5). The repository's `.env` differs from code defaults (`AQUA_CONTEXT_V2`, `AQUA_RETRIEVAL_V3`, `AQUA_E6` on). Production's set could only be inferred from a log line. There is no `/provider-health` field listing effective flags. (If one exists, it was not found in this pass.)
- **Tests assert components, not turns.** E8 tests assert the UNKNOWN header for *decision* questions (`brain/tests/e8IntegrationGate.test.js:45-57, 100-118`). No test drives a multi-turn conversation through `prepareTurn` and inspects the provider request. The pneumonia failure passes every existing unit test by construction.
- **Documentation volume.** 220 reports, many describing intended behaviour. This audit relied on code only. Several reports describe subsystems as working that this audit could only classify as present-but-degraded (World Core, canonical read) or mis-scoped (E8 for general questions).

## 4. What is not debt

- Provider routing, key pool and retry logic are coherent and well-bounded.
- The per-turn memory transaction (`turnCommit.js`) is a clean commit/rollback boundary.
- Log-safety pseudonymisation is applied consistently where read.
- The conversation store's v3 fixes (no orphan ids, CREATED/REUSED truthfulness, no 200-message deletion) are sound within a single process.

## 5. Rewrite assessment

**No rewrite is justified by the evidence.** The incident's causes are local and fixable:

- D-01 is a scoping rule in `queryPlan.js` / `assembler.js`.
- D-02 is a missing parameter in two agents.
- D-03 needs one new, small, deterministic module.
- D-05 is a gate-definition change.

Storage (D-07) needs the already-built partition path, or a single-instance guarantee, not a new design. Consolidation of the "unknown" policy (§1 row 4) and the classifiers (row 3) is worthwhile, but it is a refactor, not a rewrite, and should follow the targeted fixes and turn-level tests.
