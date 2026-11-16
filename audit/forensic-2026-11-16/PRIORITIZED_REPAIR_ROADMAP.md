# Prioritized Repair Roadmap

Principles: fix the verified causes of wrong answers first, with turn-level tests written **before** the fixes. Collect the missing runtime evidence in parallel. No rewrite (see DUPLICATION_AND_TECHNICAL_DEBT.md §5). Every step is reversible behind an existing or new flag. Nothing here has been implemented: this is a plan for approval.

## Step 0: Evidence and safety net (before any behaviour change)

| # | Action | Closes |
|---|---|---|
| 0.1 | Pull, for the incident's three request ids: `CONVERSATION_REUSED/CREATED`, `getConversation miss`, `[PIC] Knowledge …` lines, `[CIE] MONITOR`, the verification event, and the persisted assistant messages. Read production `.aqua-ledger.json → byTask.simple_qa`. Record the production `AQUA_*` flag set and instance count. | Remaining uncertainty in CONVERSATION_FAILURE_INVESTIGATION.md §6 |
| 0.2 | Write D-12: a turn-level test harness (scratch data dir, stub providers, empty owner) driving the pneumonia sequence and one personal-project follow-up through `prepareTurn`, capturing `messages`, `systemPrompt` and the reviewer input. Expected **red** on current code. | Safety net for 1.x |
| 0.3 | Operations: point `DATABASE_URL` at a reachable Postgres or deliberately unset it; restore Mongo mirror `verified`; rotate the dead Groq key. | D-09 (ops), D-15 (ops), OPS-1 |

## Step 1: Stop the wrong answers (S0)

| # | Defect | Change | Size | Flag / rollback |
|---|---|---|---|---|
| 1.1 | D-01 | Gate the E8 sufficiency header on "question is about the user's world". Make `topic` non-required in `conversation`. No unscoped header with zero items. | Small (2 files) | New `AQUA_E8_PERSONAL_SCOPE` (default on), or ship under `AQUA_CONTEXT_V2` |
| 1.2 | D-02 | Pass the window to verification and debate. Add the grounded-referent rule. Discard clarification-shaped replacements of answered drafts. | Small (3 files) | None needed: strictly more input |
| 1.3 | D-06 | Store the verification status on the assistant message. | Small | — |
| 1.4 | D-05 | Bump `LEDGER_VERSION` (reset). Count only confirmed or fact-changing revisions. Cap the learned gate. | Small | Version bump is the rollback |

Exit criterion: the step-0.2 harness is green. Existing E8 decision tests are unchanged. A dev answer evaluation on general-knowledge follow-ups shows no "not in the provided context" or "what does 'it' refer to" responses where history resolves the referent.

## Step 2: Make follow-ups retrievable (S1)

| # | Defect | Change |
|---|---|---|
| 2.1 | D-03 | Deterministic `retrievalQueryFor(message, window)` for all retrieval lanes (retrieval only, never shown). Measure the change on the existing ACIB/PWI sets before enabling by default. |
| 2.2 | D-04 | History into `runTaskGraph`. Align `/chat` and `/chat/stream` graph eligibility. |
| 2.3 | D-08 | Window policy: always keep the latest exchange (truncated if needed), and mark omitted history. |

## Step 3: Stop silent history loss (S1)

| # | Defect | Change |
|---|---|---|
| 3.1 | D-07 | Map miss on a client id → targeted reload, then an explicit retryable error. No silent empty reuse. |
| 3.2 | D-15 / D-07 | Enforce single-instance (documented and checked) until history partitions are authoritative. Then enable `history:on` with a reachable Postgres. |
| 3.3 | D-14 | Per-conversation in-flight guard. |
| 3.4 | D-13 | No auto-create on `addMessage` for a deleted id. |

## Step 4: Honest degradation and privacy (S2)

| # | Defect | Change |
|---|---|---|
| 4.1 | D-09 | `degraded` in the payload, plus a prompt notice distinct from "not known". Replay canonical writes after recovery. |
| 4.2 | D-17 | Engine policy outside the untrusted fence. |
| 4.3 | D-10 | Extend the health lexicon. |
| 4.4 | D-11 | Extend medical cues. Decide the medical verification and web-search policy (product decision). |
| 4.5 | D-16 | Truthful knowledge-injection logging (`epistemicState`, `items`). |

## Step 5: Consolidation (after 1–4 are green; refactor, not rewrite)

- One "unknown-policy" module owning every "say it is not known" sentence, scoped by user-world vs general.
- One question-understanding result object (classifier + shape + plan) passed to all consumers, including the conversation's resolved topic from 2.1.
- A turn-level trace (privacy-safe) recording which lanes contributed, the epistemic state, the window size, and the reviewer verdict class.

## Dependencies

```
0.1 ─┐
0.2 ─┼─► 1.1 ─► 2.1 ─► 5
0.3 ─┘   1.2 ─► 1.3, 1.4 ─► 4.4
         2.2, 2.3 (independent)
0.3 ─► 3.2 ─► 3.1
```

## What not to do

- Do not "fix" the incident by adding web search or a bigger model. The model was told not to use what it knew, and the reviewer was blind.
- Do not raise verification coverage (e.g. D-11) before D-02 is fixed. It would increase wrong replacements.
- Do not declare the conversation engine fixed until 0.1 has ruled D-07 in or out for the incident.
