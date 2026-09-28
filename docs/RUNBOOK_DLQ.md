# Runbook — dead-letter queue (E4/PR-7)

A job goes `dead` only after spending its whole retry budget. It is **never deleted** (L5): the row is the record that work was asked for and did not happen.

## Check
```
cd aqua
npm run doctor:dlq            # human-readable
npm run doctor:dlq -- --json
```
Exit code is the alert: `0` ok · `1` warn · `2` alert · `3` could not check (DB unreachable — treat as an incident). Prometheus: `GET /api/aqua/health/metrics` exposes `aqua_dlq_level` (0/1/2), `aqua_jobs{state="dead"}` and `aqua_dlq_oldest_dead_age_seconds`.

Policy lives in `aqua/src/core/jobs/dlqPolicy.js` (`DLQ_THRESHOLDS`): alert at ≥10 dead, ≥5 dead of one kind, or a dead job older than 6h; warn on any dead job or ≥1000 queued.

## Triage
1. **Which kind, what error?** `doctor:dlq` prints `job_id`, kind, attempts and a truncated `last_error`. One kind dominating = systematic bug, not noise.
2. **Is the worker running?** A big `queued` backlog with few dead jobs means the worker is down or too slow (`npm run start:production` starts server + worker together).
3. **Provider/config errors** (`failed(config)`, exhausted providers): fix keys/quotas first — requeueing before that just re-kills the jobs.
4. **Code bug:** ship the fix, *then* requeue.

## Requeue (reversible, non-destructive)
```js
import { requeueDead } from './src/core/jobs/jobQueue.js';
await requeueDead(<job_id>);   // -> { requeued: true } only if the job is currently dead
```
It resets `attempts` and `run_after`, keeps `last_error`, and touches nothing that is `queued`, `running` or `done` — a double call cannot double-run work. Consumers are idempotent (G2), so a re-run is safe. Requeue a few first and watch them finish before requeueing a whole kind.

## Do not
- `DELETE` dead rows to make the alert go away (L5). Account deletion (`purgeOwner`) is the only sanctioned removal.
- Raise thresholds to silence an alert without a written reason.

## Not yet covered
Push delivery (pager/Slack) — the doctor's exit code and the Prometheus gauge are the hooks; wire either to your alerting.
