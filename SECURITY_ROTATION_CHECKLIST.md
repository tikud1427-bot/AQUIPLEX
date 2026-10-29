# Security rotation checklist — 2026-10-28

For: the founder, who holds every console login. Nothing below has been done.
No credential was rotated, no setting changed, nothing deployed.

## What was verified today

| Check | Result |
|---|---|
| Repository visibility (anonymous GitHub API) | **public**, 0 forks |
| gitleaks v8.18.4, full history of all refs (`--log-opts=--all`, redacted) | 146 commits, 64 findings, 12 commits. Real secrets: `.env` and `aqua/.env` in **`8da8e11b`** (2026-07-04, removed from the tree in `0e00ae77` but still in history), and a Hugging Face token inside `.aqua-index.json` in **`e46bc105`** and **`e877b5ea`** (2026-07-07/08). Every other finding is a synthetic test fixture (`secretGuard.test.js`, `accountSecurity.live.test.js`, `chatWorkspaceAuth.test.js`). |
| gitleaks on the working trees (`--no-git`, node_modules/dist excluded) | Only the git-ignored local `.env`, plus the same synthetic fixtures. No tracked file holds a real secret. |
| Current local `.env` values vs. the four exposure commits (`8da8e11b`, `324a601f`, `0e00ae77`, `6f92e731`) | **19 current values appear verbatim in public history** (list below). Script compared in-process and printed key names only. |
| `.gitignore` | ignores `.env` and `.env.*`, keeps `.env.example`. Correct. |

**UNVERIFIED:** production's values. The comparison used this machine's `.env`. If
production (Render) was set from the same file, the same 19 are live there.

### Still current AND in public history

Secrets: `MONGO_URI`, `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, **`RAZORPAY_WEBHOOK_SECRET`**, `OPENROUTER_API_KEY_1..4`,
`SERPER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`.

Not secret, but exposed: `UNLIMITED_USER_EMAILS`, `GOOGLE_CLIENT_ID`, `APP_URL`,
`BUILDER_ENGINE_URL`, `NODE_ENV`.

> `REPO_AUDIT.md` §5 omits `RAZORPAY_WEBHOOK_SECRET`. It is exposed and current.
> With it, anyone can forge a "payment captured" webhook and mint credits.

### Exposed in history, current value differs (revoke the OLD value at the provider)

`GEMINI_KEY_1..8`, `GROQ_API_KEY_1..4`, `HF_API_KEY`, `TOGETHER_API_KEY`, and the
Hugging Face token in `.aqua-index.json` (`e46bc105`, `e877b5ea`). A changed
value in `.env` does not revoke the old one. Until it is deleted at the
provider, it still works for whoever copied it.

---

## Order

1. **Rotate** (sections A–I below), most damaging first.
2. **Make the repository private** (section J).
3. *Optional, DESTRUCTIVE:* rewrite history (section K). Needs your explicit approval; I will not run it.

Where each value goes: Render → the web service → **Environment** → edit the
variable → **Save, rebuild and deploy** (or save, then **Manual Deploy**). If
the worker runs as a separate Render service, set the same values there.
Keep your local `.env` in step, or local runs will use dead keys.

---

## A. `MONGO_URI` (Atlas user and password) — rotate first

- **Why first:** it reads and writes every account and session. With the session store plus `SESSION_SECRET`, it allows account takeover.
- **Console:** cloud.mongodb.com → your project → **Database Access**.
  1. **Add New Database User** with a new name and a generated password. Give it the same role as the current one.
  2. Build the new URI: the same host, the new user and password.
  3. Set `MONGO_URI` in Render and deploy.
  4. After the deploy is healthy, **delete the old user**.
  5. **Network Access:** replace `0.0.0.0/0` (if present) with Render's outbound IPs (Render dashboard → service → **Outbound IPs**).
  6. Review **Project → Activity Feed** and the database access history for logins you don't recognise.
- **What breaks:** the app cannot reach Mongo between deleting the old user and deploying the new URI. Do it in the order above and nothing breaks. Sessions live in the same cluster, so nobody is logged out by this step.
- **Verify:**
  - the Render boot log shows the Mongo connection succeeding;
  - `cd aqua && MONGO_URI='<new>' node scripts/mirror-doctor.mjs` passes all seven layers;
  - connecting with the **old** URI fails with an authentication error.

## B. `SESSION_SECRET`

- **Generate:** `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- **Console:** Render → Environment → `SESSION_SECRET`.
- **What breaks:** **everyone is signed out**, including the Android app. The app takes one secret, not a list, so there is no grace period. Do it after A, so stolen session IDs are useless twice over.
- **Verify:**
  - an old browser session now gets `401` from `/api/account`;
  - a fresh login works (email, then Google);
  - the boot log has no `[FATAL] SESSION_SECRET` line.

## C. `RAZORPAY_WEBHOOK_SECRET`

- **Console:** dashboard.razorpay.com → (Live mode) → **Account & Settings → Webhooks** → your webhook → **Edit** → set a new secret.
- **What breaks:** webhooks signed with the new secret fail verification until Render has the new value. Payments still capture, but credits are not added until the webhook succeeds. Razorpay retries failed webhooks, so set Render first, then change it in Razorpay, minutes apart.
- **Verify:**
  - Razorpay webhook page → **Send test webhook** → delivered (2xx);
  - a new `WebhookLog` entry shows a verified signature;
  - a forged request signed with the old secret is rejected.

## D. `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`

- **Console:** dashboard.razorpay.com → (Live mode) → **Account & Settings → API Keys** → **Regenerate Key**. The secret is shown once.
- **What breaks:** checkout fails from regeneration until Render has both new values. An order created with the old key cannot be completed after the switch. Do it at a quiet hour.
- **Verify:**
  - one real low-value purchase end to end: the order is created, payment captured, credits added;
  - Razorpay → **Transactions → Payments**: review payments for anything you don't recognise.

## E. `GOOGLE_CLIENT_SECRET`

- **Console:** console.cloud.google.com → the project that owns `GOOGLE_CLIENT_ID` → **APIs & Services → Credentials** → the OAuth 2.0 Client.
  - If the page offers **Add secret**: add a new one, deploy it, then **disable** and **delete** the old one. No downtime.
  - Otherwise use **Reset secret**.
- **What breaks:** with a reset, Google sign-in (web and the Android native handoff) fails until Render has the new value. Email login is unaffected.
- **Verify:**
  - "Continue with Google" on the web completes;
  - Android sign-in completes;
  - the old secret is gone from the client's secret list.

## F. `OPENROUTER_API_KEY_1..4` (and the unnumbered `OPENROUTER_API_KEY`)

- **Console:** openrouter.ai → **Settings → Keys**. **Delete** each exposed key, create new ones, and set a credit limit on each.
- **What breaks:** requests routed to OpenRouter fail over to other providers until Render has the new keys.
- **Verify:**
  - `cd aqua && npm run doctor:providers -- --probe` shows the new OpenRouter slots authenticate;
  - the deleted keys return 401;
  - Activity: check spend you don't recognise.

## G. `SERPER_API_KEY`

- **Console:** serper.dev → dashboard → **API Key** → regenerate.
- **What breaks:** web search in chat fails, and the chat answers without it, until Render has the new key. The numbered `SERPER_API_KEY_1..4` were not exposed.
- **Verify:** one chat turn that triggers web search shows `[SEARCH] ... used=true` in the log.

## H. `UNLIMITED_USER_EMAILS`

- Not a secret, but it tells an attacker which accounts get unlimited credits.
- **Console:** Render → Environment. Change it to the accounts that should have unlimited access today. It is honoured only for a **verified** address (`utils/credits/unlimitedAccess.js`).
- **What breaks:** anyone removed from the list goes back to normal credits.
- **Verify:** log in as a listed account: its balance shows unlimited. An unverified signup using a listed address does not.

## I. The historical set (old values; revoke at each provider)

| Key | Console | Action |
|---|---|---|
| `GROQ_API_KEY`, old `GROQ_API_KEY_1..4` | console.groq.com → **API Keys** | Delete every key created before 2026-07-08 you have not re-issued. Delete `GROQ_API_KEY` from `.env` and Render (the provider already rejects it). |
| `GEMINI_API_KEY`, old `GEMINI_KEY_1..8` | aistudio.google.com/apikey, or console.cloud.google.com → **Credentials** for each project | Delete the old keys. Restrict the current ones to the Generative Language API. |
| `OPENROUTER_API_KEY` (unnumbered) | openrouter.ai → Keys | Delete (the provider rejected it on 2026-10-15), and remove it from `.env` and Render. |
| `HF_API_KEY`, the token in `.aqua-index.json` history | huggingface.co → **Settings → Access Tokens** | Revoke every token created before 2026-07-09. The current `HF_TOKEN` was not found in history. |
| `TOGETHER_API_KEY` | api.together.ai → **Settings → API Keys** | Revoke. |

**Verify:** `cd aqua && npm run doctor:providers -- --probe` lists only keys you
meant to keep, and each one authenticates.

---

## J. Make the repository private

- **Console:** github.com/tikud1427-bot/AQUIPLEX → **Settings → General → Danger Zone → Change repository visibility → Private**.
- **What breaks:**
  - Render deploys through the GitHub app integration, which keeps access. Confirm the next deploy still pulls.
  - Anonymous links to the code stop working.
  - Today there are 0 forks. A fork made before this point would stay public.
- **Verify:** `curl -s https://api.github.com/repos/tikud1427-bot/AQUIPLEX` returns `"message": "Not Found"` when signed out.
- **Not a substitute for rotation:** anyone could have cloned the repository while it was public.

## K. Optional — rewrite history (DESTRUCTIVE, needs your explicit approval)

This removes `.env`, `aqua/.env` and `.aqua-index.json` from every commit. It
rewrites every commit hash from `8da8e11b` onward and needs a force-push of
every branch.

- Every clone, including worktrees and the Render cache, must re-clone or hard-reset.
- Open PRs break.
- Hashes cited in reports (`6dea686e`, `f388893e`, …) stop resolving.
- It does not un-leak anything already copied, so do it only after A–J.

```bash
# ONLY after approval, on a fresh mirror clone, never on the working repo:
git clone --mirror https://github.com/tikud1427-bot/AQUIPLEX.git aquiplex-rewrite.git
cd aquiplex-rewrite.git
pip install git-filter-repo
git filter-repo --invert-paths --path .env --path aqua/.env --path .aqua-index.json
git push --force --mirror origin          # DESTRUCTIVE: rewrites every branch on GitHub
```

Then ask GitHub Support to purge cached views of the old commits, which can
still be reached by SHA.
