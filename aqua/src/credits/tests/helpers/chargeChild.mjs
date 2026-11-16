/**
 * One process that charges, commits, refunds or reconciles — and can die at a
 * named point (AQUA_CHARGE_CRASH_AT). Driven by pendingCharges.live.test.js.
 *
 *   node chargeChild.mjs <op> <json args>
 *     begin      { userId }                  real checkUsage (usage guard) → prints { chargeId }
 *     commit     { chargeId }                PENDING → COMMITTED
 *     refund     { chargeId }                REFUND_PENDING → wallet refund → REFUNDED
 *     reconcile  { abandonMs }               one reconcile pass
 * Output: one JSON line on stdout (the last line).
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const [op, json] = process.argv.slice(2);
const args = JSON.parse(json ?? '{}');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const requireRoot = createRequire(path.join(ROOT, 'package.json'));
const mongoose = requireRoot('mongoose');
await mongoose.connect(process.env.CHARGE_TEST_MONGO, { serverSelectionTimeoutMS: 5_000 });
const PC = await import('../../pendingCharges.js');
const { createWalletAdapter } = requireRoot('./services/credits/pendingChargeWallet.js');
const wallet = createWalletAdapter();
let out;
try {
  if (op === 'begin') {
    const { checkUsage } = requireRoot('./middleware/usage/checkUsage.js');
    const r = await checkUsage({ userId: args.userId, actionType: 'chat_message' });
    out = { allowed: r.allowed, status: r.status ?? 200, chargeId: r.creditContext?.chargeId ?? null, cost: r.cost };
  } else if (op === 'commit') {
    out = { committed: await PC.commitCharge(args.chargeId) };
  } else if (op === 'refund') {
    await PC.requestRefund(args.chargeId, { reason: 'chat_message_failed' });
    out = await PC.processRefund(args.chargeId, { wallet });
  } else if (op === 'reconcile') {
    out = await PC.reconcileCharges({ wallet, abandonMs: args.abandonMs ?? 1_000, actor: 'reconciler-test' });
  } else throw new Error(`unknown op ${op}`);
} catch (err) {
  out = { error: String(err?.message ?? err) };
}
await mongoose.disconnect();
const { closePool } = await import('../../../core/db/pool.js');
await closePool();
console.log(JSON.stringify(out));
process.exit(0);
