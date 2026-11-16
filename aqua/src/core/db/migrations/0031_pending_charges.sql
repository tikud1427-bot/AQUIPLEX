-- 0031 — pending-charge recovery (scalability Phase 4B).
--
-- Credits are deducted when a request arrives (the wallet lives in Mongo). A
-- turn that died with its process kept the credit: the request was never
-- answered and nothing refunded it (measured, AQUIPLEX_API_SHUTDOWN_TEST_REPORT.md
-- A4). Every charge is now a row with an explicit state, moved only by
-- conditional updates, every move recorded:
--
--   PENDING ──(turn committed: same transaction as the messages and jobs)──► COMMITTED
--      │
--      └──(request failed, or abandoned: no commit within the abandon window)──► REFUND_PENDING
--                                                                                   │
--                                         (wallet refund applied, idempotent) ──► REFUNDED
--   any open state ──(the account no longer exists)──► VOID
--
-- The wallet side is idempotent per charge id (users.wallet.appliedCharges /
-- refundedCharges, conditional Mongo updates): a debit or a refund is applied
-- at most once, whatever crashes and retries happen around it.
--
-- `deducted` records that the debit is KNOWN to have been applied; a charge
-- whose process died between creating the row and debiting is resolved by the
-- refund step, which refunds only a debit that was applied (never mints).
--
-- No user content: ids, amounts, states, reasons. Additive only.

CREATE TABLE IF NOT EXISTS aqua_charges (
  charge_id      text        PRIMARY KEY,
  user_id        text        NOT NULL,
  owner_id       text        NOT NULL,
  request_id     text,
  action_type    text        NOT NULL,
  amount         integer     NOT NULL CHECK (amount > 0),
  from_free      integer     NOT NULL DEFAULT 0,
  from_paid      integer     NOT NULL DEFAULT 0,
  free_reset_at  timestamptz,
  deducted       boolean     NOT NULL DEFAULT false,
  state          text        NOT NULL DEFAULT 'PENDING'
                 CHECK (state IN ('PENDING', 'COMMITTED', 'REFUND_PENDING', 'REFUNDED', 'VOID')),
  reason         text,
  refund_attempts integer    NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz
);

-- The reconciler scans open charges by age.
CREATE INDEX IF NOT EXISTS aqua_charges_open_ix
  ON aqua_charges (state, updated_at)
  WHERE state IN ('PENDING', 'REFUND_PENDING');
CREATE INDEX IF NOT EXISTS aqua_charges_owner_ix ON aqua_charges (owner_id);

-- Append-only audit trail: one row per transition (and per deduction/refund fact).
CREATE TABLE IF NOT EXISTS aqua_charge_events (
  event_id    bigserial   PRIMARY KEY,
  charge_id   text        NOT NULL,
  from_state  text,
  to_state    text,
  event       text        NOT NULL,
  actor       text        NOT NULL,
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aqua_charge_events_charge_ix ON aqua_charge_events (charge_id, event_id);
