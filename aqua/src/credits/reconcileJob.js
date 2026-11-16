/**
 * Phase 4B — the pending-charge reconciler as a durable job (credits.reconcile.v1)
 * and as a callable for scripts/charges-reconcile.mjs.
 *
 * The wallet lives in Mongo; workers do not otherwise connect to it, so the
 * connection is opened lazily here (MONGO_URI) and kept for later runs.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reconcileCharges, pendingChargesEnabled } from './pendingCharges.js';

export const RECONCILE_KIND = 'credits.reconcile.v1';
export const RECONCILE_INTERVAL_MS = (() => {
  const v = Number(process.env.AQUA_CHARGE_RECONCILE_INTERVAL_MS);
  return Number.isFinite(v) && v >= 1_000 ? v : 60_000;
})();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const requireRoot = createRequire(path.join(ROOT, 'package.json'));

export async function walletAdapter({ mongoUri = process.env.MONGO_URI } = {}) {
  const mongoose = requireRoot('mongoose');
  if (mongoose.connection.readyState !== 1) {
    if (!mongoUri) throw new Error('charge reconcile: MONGO_URI is not set (the wallet lives in Mongo)');
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5_000 });
  }
  const { createWalletAdapter } = requireRoot('./services/credits/pendingChargeWallet.js');
  return createWalletAdapter();
}

export async function runReconcile(opts = {}) {
  if (!pendingChargesEnabled() && !opts.force) return { skipped: 'AQUA_PENDING_CHARGES is off' };
  const wallet = opts.wallet ?? await walletAdapter(opts);
  const r = await reconcileCharges({ wallet, ...opts });
  if (r.abandoned || r.refunded || r.voided || r.errors) {
    console.log(`[CHARGE] ${JSON.stringify({ evt: 'charge', phase: 'reconciled', ...r })}`);
  }
  return r;
}

/** Scheduler-owner tick: one job per interval bucket, deduplicated across workers. */
export async function scheduleChargeReconcile({ enqueue, now = Date.now(), intervalMs = RECONCILE_INTERVAL_MS } = {}) {
  if (!pendingChargesEnabled()) return { skipped: true };
  const bucket = Math.floor(now / intervalMs);
  return enqueue({ ownerId: 'system:credits', kind: RECONCILE_KIND, payload: { bucket },
    idempotencyKey: `${RECONCILE_KIND}:${bucket}`, priority: 20, maxAttempts: 3 });
}
