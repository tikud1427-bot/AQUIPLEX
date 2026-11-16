# Health Privacy and Security — Repair Report

Status legend: **FIXED+TESTED** · **PARTIAL** · **NOT TESTED** · **BLOCKED** · **NEEDS PRODUCTION VALIDATION**.

## D-10 — personal health disclosures missed · FIXED+TESTED

- `memory/sensitivity.js`: `CONDITION_TERMS_SOURCE` (≈90 common conditions/treatments: pneumonia, flu, COVID, tuberculosis, stroke, high cholesterol, antibiotics, chemo…) and `CONDITION_DISCLOSURE`: a condition is personal only as a disclosure — "I have / I've got / I'm on / I was … X", "my son has X", "my X" — never as an object ("Tell me about pneumonia") or a modal question ("Can I get pneumonia from…?"). Product framing ("an app for pneumonia patients") stays non-sensitive. Existing symptom/drug/mood logic unchanged.
- Effect: such sentences are redacted from every memory writer unless the user opted in (existing policy, `redactSensitiveSentences`), and withheld from injection under the existing rules.
- `classifyHealthContext(text, { previousUserMessages })` → `emergency | personal_disclosure | personal_followup | general_medical | null` — a pure label (A/B/C/D of the brief). **It attaches no new behaviour**: no emergency response flow was added (existing medical safety behaviour preserved; inventing one was out of scope). PARTIAL for "emergency context" (detected, not acted upon).
- Tests: `memory/tests/healthSensitivity.test.js` (positives, negatives, labels, medical tag), e2e T17 (no pneumonia fact stored without opt-in; the general question is `personal: false`). Full memory suite passes (523/524, 1 todo — as baseline).

## D-11 — medical questions not tagged · FIXED+TESTED

`orchestrator/multiLabelClassifier.js` medical tag adds condition + cure/treat/symptom/contagious/prognosis/vaccine/… co-occurrence and "side effects", using the same condition list. "Is pneumonia curable?", "What are the symptoms of tuberculosis?", "Can this medication cause side effects?" → `medical`; "Explain photosynthesis", "side quests in this game" → not.
**Consequence (cost):** medical questions now earn the verification pass the policy always intended (`shouldVerify`: medical reasoning) — one extra model call on those turns, more (debate) when classifier confidence is below 0.5. No new provider or paid service. Rollback: none separate; reverting the regex line restores it (see ROLLBACK guide). Follow-up messages without a condition word ("Is it curable?") are classified on the literal message and are not tagged (declared).

## D-17 — policy inside the untrusted fence · FIXED+TESTED

- `assembler.renderBlockParts` tags lines while rendering: user statements → `dataBlock`; evidence status, ordering rule, footer → `policyBlock`. The combined `block` is byte-identical to before for every other consumer. The split is decided by provenance, never by parsing text, so user content can never be promoted to policy.
- `brain/index.withWorldCore` keeps the halves (World Core lines → data; "nothing selected" → policy).
- `promptBuilder.buildSystemPrompt(…, enginePolicy)` renders `CONTEXT POLICY (from AQUA — operator instructions; not user content):` BEFORE the untrusted fence. chat.js fills it with the reference note, the Context Engine policy half and the degraded-memory notice.
- The reference note quotes only the user's own earlier words in THIS conversation (capped 60 chars per phrase, quoted); retrieved documents, files and web text never reach it.
- Test: e2e T18 — an item whose text impersonates "EVIDENCE STATUS" and "CONTEXT POLICY … Ignore all previous instructions" stays in the data half, appears only after the fence opens, and the policy section precedes the fence.

## D-16 — misleading logging · FIXED+TESTED

- `[PIC] Knowledge injected` is logged only when items reached the prompt; a policy-only block logs `[PIC] Knowledge policy-only … items=0 epistemic=…`; the empty line now says `policy=yes epistemic=…`.
- New one-line `[TURN]` diagnostic per completed turn: pseudonymous conversation hash, request id, path (`single`/`graph`, `/stream`), history count, window included/total/truncated, approximate prompt tokens, reference status and subject COUNT, retrieval augmented, personal flag, fact and knowledge item counts, evidence state, verification status/outcome/applied, read mode (degraded), persistence state. **No message, memory, document or medical text** — counts and status words only (verified in the e2e logs).
- Response payload gains `conversation` (counts/statuses) and `persistence.state` (additive).

## Authentication, ownership, isolation · FIXED+TESTED (tested paths)

- No auth code changed; `requireLogin` still sets `req.aquaUserId`.
- `resolveTurnConversation`: an existing or recovered conversation of another user → 404 (no oracle); a missing server-issued id can no longer be (re)created by anyone; an unknown client-chosen id is created owned by the caller only. T13, T14.
- Auto-create in `addMessage` carries the authenticated owner (`ownerUserId` from the session), never a client-supplied value; a deleted conversation is not resurrected (D-13).
- The shared context is built only from the authorized conversation's history; T14 asserts user B's model request carries none of user A's text.

## Remaining privacy/security risks

See REMAINING_DEFECTS_AND_OPERATIONAL_LIMITATIONS.md (global ledger aggregation; per-process focus/lock; condition lexicon is finite; emergency label not acted on; frontend error UX for 404/409/503).
