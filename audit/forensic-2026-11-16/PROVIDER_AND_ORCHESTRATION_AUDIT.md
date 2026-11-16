# Provider and Orchestration Audit

Evidence levels as defined in SYSTEM_ARCHITECTURE_MAP.md.

## 1. Model routing (SOURCE-CONFIRMED)

`providers/router.js`:

- `rankProviders(taskType, complexity)` scores `gemini`, `groq`, `openrouter`, `nvidia` using static task affinity, health (circuit breaker, per-model cooldowns) and a bounded learned prior (`getProviderPrior`, ±6, sample-gated).
- `generateText`: up to `AQUA_PROVIDER_MAX_ROUNDS=4` rounds within `AQUA_PROVIDER_RETRY_BUDGET_MS=90 000`, with jittered exponential backoff. Rounds after the first are skipped when every circuit is open (`router.js:268-271`). Per-call timeouts come from `getTimeout(taskType, provider, promptLength, complexity)`.
- A truncated completion (`finishReason=length`) counts as a **success** and is returned (`router.js:296-305`). Non-truncated output passes `validateResponse` (task-aware minimum length) or falls through to the next provider.
- Exhaustion: retryable → HTTP 503 + `Retry-After` (`chat.js:1575-1580`); terminal → 500.
- Streaming (`generateTextStream`) has the same ranking; on a client abort it throws `CLIENT_ABORTED`, and the partial text is persisted (`chat.js:1937-1947`).

### Credentials (`providers/keyPool.cjs`)

- 401/403, or a 400 whose wording says the key is invalid → `auth` → the key is **quarantined permanently ("sticky")** (`keyPool.cjs:31, 277, 512-516`). The pool moves on to the next key. When all keys are rejected, the result is `ALL_KEYS_REJECTED` (401, non-retryable).
- Billing → quarantine with TTL. Rate limit → per-key cooldown.
- **Production's "at least one rejected Groq credential"**: handled as designed (that key is skipped). The operational defect is the dead key in configuration. Rotate or remove it (OPS-1). Rejected keys need a deliberate revival (the operator opt-in `ttlMs`).

## 2. Orchestration decisions (REPRODUCED for the incident)

```
Is pneumonia curable?    simple_qa conf .97 low    → simple_question (minimal) verify:false ctx 4000 web:false
Tell me about pneumonia. simple_qa conf .45 medium → simple_question            verify:false ctx 4000 web:false
Is it curable?           simple_qa conf .97 low    → simple_question            verify:false ctx 4000 web:false
```

- **Web search was not used** for a general medical-knowledge question (`web:false`). The answer depends entirely on model knowledge, which the Context Engine's UNKNOWN block then tells the model not to use (D-01).
- Verification was not statically warranted. The production `revised_unconfirmed` therefore came from the learned ledger gate (D-05) or CIE escalation (I-7). See INTELLIGENCE_PIPELINE_AUDIT.md.
- "Tell me about pneumonia." classifies at confidence 0.45 (zero-score fallback), complexity medium, and gets the Phase-4 directive "Work through this step-by-step…". Under cost-aware review, low confidence on a short, non-sensitive message does not add review. That is correct.

## 3. Prompt assembly (SOURCE-CONFIRMED)

See SYSTEM_ARCHITECTURE_MAP.md §4. Findings:

### P-1 (S1, part of D-01). Engine-generated directives fenced as "untrusted" but phrased as authority

The Context Engine block joins `combinedContext`, which `buildSystemPrompt` fences as UNTRUSTED CONTENT from "your files, repositories and stored knowledge". It contains imperative instructions ("Do not infer or fabricate them"). Either the fence works and AQUA's own sufficiency contract is noise, or the model follows it and the fence's promise ("never instruction") is false. Both are design defects: **AQUA's own policy text and user-derived data share one channel and one trust label.** The production answers indicate the model followed it.

### P-2 (S2). Directive channel concatenates five producers without arbitration

`reasoningDirective = [reasoning, CIE, interview, revision voice, proactive].join('\n')` (`chat.js:939`). None of them is aware of the others, the Context Engine's header, or the conversation.

### P-3 (S3). The `userMessage` passed to `generateText` is not the message list

`generateText(userMessage, systemPrompt, messages, …)` uses `userMessage` only for classification fallback and validation (`router.js:233-240, 308`). The user turn reaches the provider via `messages`. Correct, but easy to misread. The verification agent passes `userMessage` where the history should go.

## 4. Streaming vs non-streaming consistency (SOURCE-CONFIRMED)

| Aspect | `POST /chat` | `POST /chat/stream` |
|---|---|---|
| prepareTurn | same | same |
| Graph runtime for agent tasks | **yes** (no history, D-04) | **no** |
| Verification | when enabled or escalated | same, unless the client aborted |
| Revision delivery | final JSON | `replace` SSE event **after** the draft streamed: the user reads the correct answer, then sees it replaced |
| Persist | before response | before `done` |
| Post-turn learning | synchronous call after persist | deferred job after `done` |
| Learning ledger update | before response | deferred |
| Refund on error | fire-and-forget (`chat.js:1567`), plus the usageGuard net | awaited, bounded 5 s (`chat.js:1953`) |
| Client abort | n/a | partial text persisted; refunded if empty |

The stream's draft-then-replace UX makes D-02 visible: users may see a correct follow-up answer stream in and then be replaced by "Could you specify what 'it' refers to?". This is HYPOTHESIS for this incident (needs the SSE event log or the `done` payload's `verification.revised`).

## 5. Provider timeouts and failures

- Per-call timeout via `AbortController`, plus the overall 90 s retry budget. Verification uses the same router, so a slow reviewer extends turn latency. Verification errors fail open (draft kept).
- NVIDIA was noted as down in earlier operations memory. Not re-verified.
- Provider ranking adapts to the global learned prior (sample-gated, bounded). It shares the same cross-user coupling as D-05 but is bounded (±6) and lower risk.

## 6. Recommendations (orchestration-specific)

1. Give reviewers the same conversation window the drafter had (D-02), and add the rule: "a referent resolved from the conversation is grounded".
2. Scope the learned verification gate by more than task type, and exclude history-blind or clarification revisions from `revised` counts until D-02 is fixed. Reset the ledger after the fix (it has a versioned reset path; see `learningLedger.js` v1 quarantine).
3. Route general-knowledge questions with no personal anchor away from E8 personal sufficiency (D-01). Consider web search for factual medical questions (policy decision).
4. Separate "operator policy derived by AQUA" from "untrusted user/data content" in the prompt: different sections, different labels.
5. Unify `/chat` and `/chat/stream` (graph runtime eligibility, refund awaiting).
