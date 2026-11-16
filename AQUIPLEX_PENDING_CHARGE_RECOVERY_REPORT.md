# AQUIPLEX — Pending-Charge Recovery Report (Phase 4B)

Date 2026-11-15. Uncommitted, behind `AQUA_PENDING_CHARGES` (default **off**,
needs `DATABASE_URL`). Nothing is activated in production.

## 1. The problem

Credits are deducted when a request arrives, and the wallet lives in Mongo. If
the API process died after the deduction and before the turn completed, the
turn vanished correctly, but the credit never came back.

This was measured in Phase 4A (Linux A4): the wallet went 480 → 475 for a turn
that does not exist. The same applies to any hard exit: OOM, SIGKILL, a lost
node.

## 2. Design

Every charge is a **Postgres row** (migration `0031_pending_charges.sql`) moving
through explicit states. Each move is **one conditional `UPDATE … WHERE state =
<expected>`**, and it writes an **event row in the same transaction**: the audit
trail.

```
PENDING ──(turn committed: SAME transaction as its messages and jobs)──► COMMITTED
   │
   ├──(request failed: awaited before the error response)──► REFUND_PENDING ──(wallet refund)──► REFUNDED
   └──(abandoned: still PENDING after AQUA_CHARGE_ABANDON_MS, 15 min)──┘
open (PENDING | REFUND_PENDING) ──(account no longer exists)──► VOID
```

**The wallet side (Mongo) is idempotent per charge id.** `users.wallet` gains
two bounded lists, `appliedCharges` and `refundedCharges` (newest 500 each).

- **Debit:** `deductCredits(…, { chargeId })` applies only while the id is
  **not** in `appliedCharges`, and pushes the id in the same atomic
  `findOneAndUpdate`. A retried debit returns the original breakdown and does
  not charge again.
- **Refund:** `refundCharge` applies only while the id **is** in
  `appliedCharges` and **not** in `refundedCharges`, pushing the id atomically.
  So:
  - **a refund can never be applied twice**, even by concurrent racers;
  - **a refund of a debit that never happened mints nothing** (`never-deducted`).
- **Split rules are unchanged:** paid credits always return; free credits return
  only within the same daily allowance and never above it.

**Order of a request** (`middleware/usage/checkUsage.js` 7a):
1. PENDING row + event `created`;
2. wallet debit (idempotent);
3. `deducted` recorded.

Any of these may be the last step before a crash; every resulting state is
recoverable (§3).

**Completion:**

| Request | How the charge settles |
|---------|------------------------|
| Chat turn, durable mode | `commitChargeIn(client, chargeId)` **inside** `commitTurnWithLearning`'s transaction. The charge is COMMITTED exactly when its turn exists. |
| Any other successful AQUA request | The response gate settles it (`settle()`) before the response. If that write fails, the answer still goes out and the charge stays PENDING. The reconciler then refunds it after the abandon window, so a failure here favours the user. |
| Failure | `refund()`: REFUND_PENDING, then the wallet refund, then REFUNDED. Awaited before the error response (Phase 4A gate and stream path). A committed charge is **never** refunded: the request-refund move is conditional on PENDING. |

**Recovery.**
- The scheduler-owning worker enqueues `credits.reconcile.v1` every
  `AQUA_CHARGE_RECONCILE_INTERVAL_MS` (60 s), one job per interval bucket.
- Each pass:
  - moves abandoned PENDING charges to REFUND_PENDING;
  - processes every REFUND_PENDING (refunded / already-refunded / never-deducted
    / account gone → VOID).
- The worker connects to Mongo lazily for this job only.
- Operators run the same pass with `aqua/scripts/charges-reconcile.mjs`.

**Account deletion.** `accountPurge` voids open charges (recorded), then deletes
the charge rows and events with the account, as the platform deletes the Mongo
credit ledger. A refund still in flight finds the account gone and closes VOID.

**Ledger reconciliation.** `reconcileLedger` compares every recent charge with
the Mongo `Transaction` rows that carry `metadata.chargeId`, and checks the
ledger against what the refund event recorded. It flags:
- debited twice;
- refunded twice;
- committed but refunded;
- committed without a debit;
- refunded state without a refund row;
- a refund row although nothing was returned;
- a refund row missing after "already refunded";
- never-deducted but present in the ledger.

`charges-reconcile.mjs --ledger [--user id]` exits 1 on any anomaly.

## 3. Termination at every transition boundary (real Postgres + real Mongo)

`aqua/src/credits/tests/pendingCharges.live.test.js`: **16/16**.

Each scenario kills a child process at the named point (`AQUA_CHARGE_CRASH_AT`,
`process.exit`). The child runs the **real `checkUsage`**. A reconcile pass then
runs in another child process.

| Process dies at | Expected and verified |
|-----------------|-----------------------|
| `after-charge-created` (row exists, nothing debited) | REFUNDED as never-deducted; wallet unchanged; **no** REFUND row (nothing minted) |
| `after-wallet-debit` (debited, not recorded) | REFUNDED once; wallet restored; 1 REFUND row |
| `after-deducted-recorded` | same |
| `after-commit` | stays COMMITTED; charged once |
| `after-refund-requested` | refund completed once |
| `after-wallet-refund` (wallet refunded, state not recorded) | next pass finds `already-refunded`, records REFUNDED; wallet credited **once** |
| `after-refunded-recorded` | final; once |
| the **reconciler (worker)** dies after the wallet refund | the next pass finishes it; once |

**Other cases tested:**
- **duplicate refunds**, by two methods:
  - 6 concurrent refund processes for one charge;
  - **10 refunds at the same instant in one process**, straight at the wallet
    (all read before any write).

  Both result in exactly one refund and one ledger row.
- **refund after commit**: refused.
- **free-credit split**: returned to the free balance.
- **wallet unreachable during a refund**: error recorded on the charge
  (`last_error`), stays REFUND_PENDING; the next pass completes it.
- **account deleted** with a refund pending: VOID.
- **account purge**: the rows are gone.
- **ledger reconciliation**: consistent after all of the above. A duplicated
  refund row is detected as `refunded-twice`.

**Bite check** (`scratchpad/bite4b_charges.cjs`). Mutations caught:
- wallet refund without its "not yet refunded" condition (first **missed**; the
  same-instant race test was added for it, and the mutation is now caught);
- refund of a never-applied debit (minting);
- refund allowed after commit;
- abandoned charges never recovered;
- refund recorded without touching the wallet;
- account deletion not voided.

## 4. End to end in the real application

**Linux** (`aqua/scripts/phase4a-linux-api-shutdown.mjs`, pending charges on):
**28/28**.

- The API that died mid-transaction (A4) left its charge **PENDING**.
- One reconcile pass refunded it: wallet 480 → **480**, ledger anomalies **0**.
- At the end of the session every charge was resolved: 4 COMMITTED (answered
  turns, each committed inside its turn's transaction) and 2 REFUNDED (the dead
  turn and the failed request).

**Windows multi-instance journey** (2 APIs + workers, real providers, database
restart, API crash): see the implementation report §4 (scenario L12).

## 5. Limits and risks

- **The abandon window decides how soon a dead request is refunded** (15 min
  default). It must exceed any request's lifetime: a still-running request whose
  charge was refunded as abandoned would then fail to commit it. The commit is
  conditional on PENDING, so the turn's transaction is not affected, and the
  user is not charged. Set it well above `timeoutSeconds`.
- **Wallet id lists are bounded to 500.** A charge older than its user's 500
  newest charges cannot be retried idempotently. The reconciler resolves charges
  within minutes, so this window is wide.
- **A successful non-chat request whose settle write fails** is refunded after
  the abandon window. This is a known, user-favourable outcome; it is counted in
  the logs.
- **Not tested:** Mongo replica-set failover during a refund (the test Mongo is
  standalone); production-scale charge volume.
