# AQUA Deferred Jobs — E4

**Blueprint:** Epic E4 (event bus + job runner) · L13 (no dark stages)
**Status:** PR-1 — the registry and the drain

---

## The measured problem

Post-turn understanding work — Mind post-turn, world-model ingest, the Digital
Twin, cadence-gated reflection — runs behind a bare `setImmediate`. That is
correct in itself: a chat turn must never wait on it.

But it is untracked, so:

```
outstanding jobs at SIGTERM : 3
survived                    : 0
anything that knew they existed : nothing
```

The E3 drain already awaits the debounced writers, the Mongo mirror and the
storage adapter. Deferred work was invisible to it.

**Every deploy discarded the understanding side-effects of whatever turns were
in flight.** The user got their answer, so from their side it worked. AQUA
just quietly learned nothing from that conversation.

After this PR, the same scenario drains 3 of 3.

## What this PR does — and what it deliberately does not

It makes outstanding work **visible and drainable**. That is all.

| not in this PR | why |
|---|---|
| a **queue** | implies ordering guarantees and a backpressure policy, and neither is needed to stop losing work on shutdown |
| **persistence** | an outbox that survives a *crash* is E4/PR-3. This survives a *deploy* — the common case and the cheap one |
| **retry** | a retry policy needs a failure taxonomy to be anything more than "try twice and hope" |

Adding any of them here would be two risky things at once — the ordering rule
E3 followed throughout.

A test asserts the module has not grown them.

## Fail-open is preserved exactly

`runPostTurn` already promises that every subsystem failing at once never
reaches the caller, and there is a test for it. A registry that let a rejection
escape would break that promise **while claiming to improve reliability**.

Failures are swallowed exactly as the bare `setImmediate` did — and **counted**.
That count is the improvement: a failure that is invisible cannot be
investigated, and this path has been silently swallowing them since it was
written.

## The drain has a hard ceiling, on purpose

A deploy window is finite — the platform sends SIGKILL on its own schedule
regardless — so a drain that waited indefinitely would be killed mid-write and
lose **more** than it saved.

On timeout it reports what was still running:

```
[JOBS] drained 3 job(s) in 121ms
[JOBS] ⚠ drain gave up after 5000ms — ingest×3 still running and will be LOST
```

*Drained* and *gave up* are different facts. A deploy log that conflates them
teaches people to ignore it.

It runs **alongside** the mirror and storage drains, not after — a deploy will
not wait three times.

## One line, because the seam already existed

`turnPostProcess.js` already took `defer` as an injectable dependency:

```js
-  defer: setImmediate,
+  defer: fn => defer('post-turn', fn),
```

That is the whole wiring change. The refactor that created that seam was shipped
as a deliberate no-op precisely so a change like this could be one line.

## Bite, measured

Every mutation verified as applied first.

| mutation | failures |
|---|---|
| stop tracking work (invisible again) | 8 |
| let a job rejection escape | 1 |
| drain with no ceiling (hangs the deploy) | 2 |
| revert post-turn to a bare `setImmediate` | 1 |
| drop `drainJobs` from the SIGTERM drain | 1 |
| *(reverted)* | **0 — 15/15** |

## Results

```
npm test    2330 / 223 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 · flagproof 30/30 · router boots
```

## Next

**PR-2** — a retry policy, once there is a failure taxonomy worth acting on:
the `failed` counter this PR adds is what makes that taxonomy observable rather
than guessed. **PR-3** — an outbox, so work survives a crash and not only a
deploy.
