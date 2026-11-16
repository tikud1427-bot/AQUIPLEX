# Rollback and Deployment Guide

Nothing was committed, pushed or deployed. No environment variable, database, mirror or production data was changed.

## 1. Runtime rollback switches (no redeploy of code needed — restart with the variable)

| Variable | Default | Set to | Restores |
|---|---|---|---|
| `AQUA_CONVERSATION_CONTEXT` | on | `off` | no reference resolution, raw retrieval query, no reference note (reviewers still get recent turns) |
| `AQUA_E8_PERSONAL_SCOPE` | on | `off` | E8 required `topic` slot for every general question (the incident behaviour) |
| `AQUA_STRICT_CONVERSATION_IDS` | on | `off` | silent creation of a missing conversation id; no disk recovery |
| `AQUA_CONVERSATION_TURN_LOCK` | on | `off` | overlapping turns run concurrently |
| `AQUA_LEDGER_REVISION_BASIS` | confirmed | `legacy` | learned gate counts every applied revision |
| `AQUA_REVIEW_REQUIRE_REASON` | off | `on` | (stricter, not a rollback) discard reason-less reviewer replacements |
| `AQUA_TURN_LOCK_WAIT_MS` / `AQUA_TURN_LOCK_STALE_MS` | 15000 / 600000 | number | lock wait / stale reclaim |

Not flag-gated (code rollback only): reviewer conversation block + withdrawal guard, history window, engine-policy section, health/medical lexicon, persistence-state field, logging, CIE/IIE resolution, graph conversation block.

## 2. Code rollback

**Simplest and safest:** `git apply -R audit/conversation-recovery-2026-11-16/conversation-recovery-delta.patch` (from the repository root). The patch holds exactly this repair's delta — computed against each file's pre-edit content, so the owner's earlier uncommitted edits in the same files are preserved — and was verified with `git apply --check -R` on 2026-11-16. Reverse-applying deletes the 10 new files and restores the 27 modified ones. (Re-check first if those files were edited after this repair.)

Manual alternative:

Pre-edit copies of every touched file are in the session scratchpad `originals/` (path recorded in CONVERSATION_RECOVERY_BASELINE.md). Because eight files carried the owner's uncommitted work, **do not `git checkout` them** — that would also discard the owner's edits. To roll back this repair only:

- Files that were clean at HEAD → `git checkout -- <file>` is equivalent to the original: `brain/contextEngine/{assembler,e8Pipeline,queryPlan}.js`, `core/{promptBuilder,tokenManager}.js`, `intelligence/{debateAgent,evidenceContext,verificationAgent}.js`, `intelligence/learningLedger.test.js`, `memory/sensitivity.js`, `orchestrator/{graphRuntime,multiLabelClassifier}.js`, `cognition/questionModel.js`, `eval/tests/readPathParity.test.js`.
- Files with owner edits (13, verified by comparing each saved original with HEAD) → restore ONLY from the scratchpad copies: `brain/contextEngine/index.js`, `brain/index.js`, `core/atomicStore.js`, `core/flags.js`, `core/tests/flagRegistry.test.js`, `core/tests/flagReadSiteParity.test.js` (untracked — not in HEAD at all), `intelligence/learningLedger.js`, `intelligence/internalIntelligenceEngine.js`, `cognition/index.js`, `memory/conversationStore.js`, `orchestrator/verificationStrategy.js`, `routes/chat.js`, `routes/turnPostProcess.js`.
- New files → delete: `core/conversationContext.js`, `core/conversationTurnLock.js` and the 8 new test files listed in CONVERSATION_RECOVERY_IMPLEMENTATION_REPORT.md.

## 3. Data written by the new code

- On first boot: `.aqua-ledger.json.pre-confirmed-basis-<ts>.json` (backup of the ledger aggregates) and `revisionBasis: "confirmed"` in `.aqua-ledger.json`. Rolling back the code leaves the field harmlessly ignored.
- Assistant messages gain an optional `verification: { status, outcome, revised }` field. Old readers ignore it.
- No schema migration, no deletion.

## 4. Deployment constraints (before any deploy)

1. **Exactly one instance** (no autoscaling) — the store, lock and mirror are single-writer.
2. Confirm the Mongo mirror is verified (`/provider-health` mirror block `durable: true`), otherwise conversations written after deploy are lost at the next deploy (responses will now say `persistence.state: "DEGRADED"`).
3. Decide `DATABASE_URL` (reachable DB or unset) — currently every turn degrades.
4. API contract changes clients must tolerate: chat may now return **404** for a server-issued id it cannot load, **503** (`retryable`, `Retry-After`) when persistence cannot answer, **409** (`retryable`, `Retry-After: 3`) when a previous turn is still running. Additive payload fields: `conversation`, `persistence`, `verification.outcome/applied/revisionReason`.
5. Watch the `[TURN]` log line and `verify=` / `outcome=` counts after deploy; validate the pneumonia scenario on live providers (REMAINING_DEFECTS R-1).
