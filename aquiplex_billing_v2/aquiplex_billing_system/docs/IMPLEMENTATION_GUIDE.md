# AQUIPLEX Billing v2 — Implementation Guide
## Prepaid AI Credits Economy

---

## 1. ANALYSIS FINDINGS

### What exists in the codebase

| File | Status |
|------|--------|
| `services/billing/billing.service.js` | Cashfree — DELETE |
| `services/billing/billing.service.js.bak` | DELETE |
| `services/billing/webhook.handler.js` | Cashfree — REPLACE |
| `routes/billing/billing.routes.js` | REPLACE |
| `services/credits/credits.service.js` | REPLACE with wallet.service.js |
| `middleware/usage/usageGuard.js` | REPLACE |
| `models/User.js` | REPLACE (schema migration) |
| `models/BillingLog.js` | KEEP (audit) — don't write to it anymore |
| `utils/subscription/plans.js` | REPLACE with utils/credits/packs.js |
| `fix-billing-index.js` | DELETE |
| `views/billing.ejs` | REPLACE with wallet.ejs |
| `views/pricing.ejs` | REPLACE |

---

## 2. FILES TO DELETE

```
services/billing/billing.service.js
services/billing/billing.service.js.bak
utils/subscription/plans.js
fix-billing-index.js
```

Keep but stop writing to:
```
models/BillingLog.js   ← historical audit
```

---

## 3. FILES TO CREATE

```
models/User.js                              ← wallet schema
models/Transaction.js                       ← credit ledger
models/Payment.js                           ← Razorpay orders
models/WebhookLog.js                        ← dedup webhooks
utils/credits/packs.js                      ← pack config
services/billing/razorpay.service.js        ← Razorpay integration
services/billing/webhook.handler.js         ← Razorpay events
services/credits/wallet.service.js          ← atomic wallet ops
routes/billing/billing.routes.js            ← API routes
middleware/usage/usageGuard.js              ← credit guard
views/wallet.ejs                            ← wallet UI
views/pricing.ejs                           ← pricing page
docs/migrate_v1_to_v2.js                   ← DB migration
```

---

## 4. API ROUTES

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/billing/create-order` | required | Create Razorpay order |
| POST | `/api/billing/verify-payment` | required | Verify after checkout |
| GET | `/api/billing/wallet` | required | Wallet summary |
| GET | `/api/billing/history` | required | Transaction history |
| GET | `/api/billing/payments` | required | Payment history |
| GET | `/api/billing/packs` | public | Credit pack list |
| POST | `/api/billing/webhook` | Razorpay sig | Webhook endpoint |

---

## 5. PAYMENT FLOW

```
User → /pricing or /wallet
  → clicks "Buy Now"
  → POST /api/billing/create-order { packId }
  → backend: Razorpay.orders.create() → saves Payment doc
  → returns { orderId, amount, keyId }
  → frontend: new Razorpay({ order_id, key, handler })
  → rzp.open() → user pays via UPI/card/netbanking
  → handler fires: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
  → POST /api/billing/verify-payment
  → backend: HMAC-SHA256(orderId|paymentId, KEY_SECRET) === signature
  → wallet.addPaidCredits(userId, credits, paymentId)
  → atomic $inc on user.wallet.paidCredits
  → Transaction ledger entry
  → response: { success, credits, balanceAfter }
  → toast: "X credits added!"
```

Webhook (backup path):
```
Razorpay → POST /api/billing/webhook
  → verify signature HMAC-SHA256(rawBody, WEBHOOK_SECRET)
  → WebhookLog.create (idempotency check — duplicate = skip)
  → event: payment.captured → addPaidCredits (checks creditedAt)
  → event: payment.failed   → Payment.status = failed
```

---

## 6. CREDIT CONSUMPTION

### In any AI route:

```js
const { usageGuard } = require("../../middleware/usage/usageGuard");

// Pre-deduct (default) — refund on failure
router.post("/generate", usageGuard("full_app_gen"), async (req, res) => {
  try {
    const result = await runAI(req.body);
    res.json({ result });
  } catch (err) {
    await req.creditContext.refund(); // returns credits on failure
    res.status(500).json({ error: err.message });
  }
});

// Check-only — commit on success
router.post("/chat", usageGuard("chat_message", { deductOnEntry: false }), async (req, res) => {
  const reply = await runChat(req.body);
  await req.creditContext.commit(); // deduct after success
  res.json({ reply });
});
```

### Consumption order (automatic):
1. `freeCredits` (daily, resets midnight)
2. `paidCredits` (purchased, never expires)

---

## 7. RAZORPAY DASHBOARD SETUP

1. Login → Settings → Webhooks → Add Webhook
2. URL: `https://aquiplex.com/api/billing/webhook`
3. Secret: value of `RAZORPAY_WEBHOOK_SECRET`
4. Events to enable:
   - `payment.captured` ✅
   - `payment.failed`   ✅
   - `order.paid`       ✅ (backup)

---

## 8. ENV VARIABLES REQUIRED

```env
# Razorpay
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=AquiplexWebhookSecret_2026_secure

# Free daily credits
FREE_DAILY_CREDITS=100

# Credit packs
STARTER_PACK_PRICE=49
STARTER_PACK_CREDITS=500
GROWTH_PACK_PRICE=199
GROWTH_PACK_CREDITS=3000
PRO_PACK_PRICE=499
PRO_PACK_CREDITS=8500
MAX_PACK_PRICE=999
MAX_PACK_CREDITS=20000

# App
APP_URL=https://aquiplex.com
NODE_ENV=production
```

---

## 9. MIGRATION STEPS

1. **Backup MongoDB** — `mongodump --uri=$MONGO_URI`
2. Deploy new code to staging
3. Run: `node docs/migrate_v1_to_v2.js`
4. Verify: `GET /api/billing/wallet` returns wallet object
5. Test purchase flow with Razorpay test key
6. Switch to live keys
7. Update webhook URL in Razorpay dashboard
8. Deploy to production

---

## 10. DELETION CHECKLIST

Remove all references to:
- `cashfree` — search codebase
- `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_WEBHOOK_SECRET`
- `subscriptionStatus`, `currentPeriodEnd`, `subscriptionCancelledAt`
- `resetToFreePlan`, `applyPlan`, `runMonthlyResetCron`
- `checkAndDowngradeIfExpired` (old version)
- `getPlanById`, `inferActionCost` (old plans.js)
- `cashfree-pg` npm package → `npm uninstall cashfree-pg`

---

## 11. SECURITY CHECKLIST

- [x] Webhook signature verified server-side (HMAC-SHA256)
- [x] Razorpay payment signature verified before crediting
- [x] Atomic `$inc` prevents race conditions on credit ops
- [x] `creditedAt` flag prevents double-credit on retry
- [x] WebhookLog deduplication prevents replay attacks
- [x] TTL index auto-expires webhook logs after 30 days
- [x] Payment record tied to specific userId (can't steal others' credits)
- [x] No credit amount trusted from frontend — always from Payment record

---

## 12. TESTING CHECKLIST

- [ ] Buy Starter pack → 500 credits added
- [ ] Buy Growth pack  → 3000 credits added
- [ ] Free credits reset at midnight (check freeResetAt)
- [ ] Free credits consumed before paid credits
- [ ] Chat deducts 5 credits
- [ ] Full app gen deducts 150 credits
- [ ] Insufficient credits → 402 response with cta
- [ ] Webhook duplicate delivery → skipped (check WebhookLog)
- [ ] Invalid webhook signature → 400 rejected
- [ ] Payment signature mismatch → 400 rejected
- [ ] `/wallet` page loads wallet summary
- [ ] Transaction history shows PURCHASE + DEBIT entries
- [ ] Razorpay checkout opens → payment completes → toast shows

---

## 13. RENDER/VPS DEPLOYMENT

### Environment
- Set all env vars in Render dashboard or VPS `.env`
- `NODE_ENV=production`

### npm
```bash
npm uninstall cashfree-pg           # remove Cashfree SDK
npm install razorpay@2.9.6          # already in package.json
```

### Process
```bash
node docs/migrate_v1_to_v2.js      # run once
npm start                           # index.js
```

### Health check
```bash
curl https://aquiplex.com/api/billing/packs
# Should return { success: true, packs: [...] }
```
