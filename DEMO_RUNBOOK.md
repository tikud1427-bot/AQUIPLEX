# Demo runbook — Tidepool (YC application video)

For: the founder, recording the ≤4-minute live demo. Script source:
`YC_APPLICATION_DRAFT.md` → "Live demo script".

> **HARD RULE: never demo on a personal account.** Your real account holds real
> conversations, files and (before this patch) health and mood details. Always use
> a brand-new account made for the take. If the wrong account is signed in, stop
> the recording.

## Read this first — three things that change the plan

1. **Steps 3 and 6 need the World Model (Postgres) read path.**
   - "What Aqua knows now", the per-item source labels, and the **Correct** button exist only when the server has a database (`/brain/current` returns `configured: true`).
   - Production currently serves the **legacy** read. On it, that section is absent and fact rows have only Pin and Forget.
   - Choose one:
     - (a) record on the local launcher with a database: the setup `aqua/scripts/e2e-founder-journey.mjs` uses;
     - (b) deploy with `DATABASE_URL` and migrations: your separate decision;
     - (c) use the legacy fallback lines marked **[legacy]** below.
2. **Step 6 corrects "the biggest-risk item", but the YC script never states a risk.** Say the third line in step 2 below, or step 6 has nothing to correct.
3. **Memory latency is the risk on camera.** You measured 17–94 s on free tiers. It was **not re-measured today**: the session could not load provider keys (see `PATCH_2026-10-28.md` §5). Use a paid extraction key, and rehearse once to get your own number.

## Pre-flight (10 minutes before)

- [ ] **Fresh account** created for this take (new email). Not your personal account. Not a reused demo account.
- [ ] **Paid extraction key** loaded on the server you record against. Check: `cd aqua && npm run doctor:providers -- --probe` shows it authenticates.
- [ ] Server has a database (for steps 3 and 6). Check: signed in, open `/api/aqua/brain/current` → `"configured": true`. If false, use the **[legacy]** lines.
- [ ] Deployed build includes `fix/yc-demo-safety-2026-10-28` (Memory has no `custom_` headings or "event" rows).
- [ ] **Clean browser profile:** a new Chrome profile, no extensions, no saved logins, bookmarks bar hidden, zoom 100%, window 1920×1080.
- [ ] **Your personal account is logged out** everywhere in that profile: AQUA, Google, Gmail.
- [ ] **Notifications off:** Windows Focus Assist / Do Not Disturb on; Slack, WhatsApp and mail closed; phone face down.
- [ ] Settings → Memory → "Let AQUA remember health and mood details" is **off** (the default).
- [ ] Pricing note ready on the desktop as `tidepool_pricing.txt`:
  ```
  Tidepool pricing (internal)
  Standard plan: $49 per clinic per month.
  Annual plan: 2 months free.
  Target customer: independent physiotherapy clinics with 2-10 therapists.
  ```
- [ ] Say on camera that Tidepool is fictional.

## The take — 7 steps, 4:00 budget

| # | Budget | Type exactly / do | Expected screen | If it lags, say |
|---|---|---|---|---|
| 1 | 0:20 | Sign up with the fresh email, open the verification link, set the password. | Onboarding: Aqua asks what you're working on and says what it can't see (email, chat tools, code hosts). | "Signup verifies the email first — that's deliberate." |
| 2 | 1:00 | In the onboarding chat, one message at a time: **"I'm building Tidepool, a scheduling tool for physiotherapy clinics. My co-founder Maya runs engineering."** → **"We charge $49 a month per clinic, and our launch is on April 15."** → **"Our biggest risk right now is that clinics churn after the first month."** Attach `tidepool_pricing.txt`. Click **Show me what you understand**. | A card naming Tidepool, Maya, the price and the launch date. | "It's reading the note now — this is the one part that runs in the background." |
| 3 | 0:30 | Sidebar → **Memory** → **What Aqua knows now**. Expand **Where Aqua learned this** on the price. | Items with "From a conversation" / "From tidepool_pricing.txt". The quote is the sentence you typed. **[legacy]** No "What Aqua knows now": show the Project / Work rows and expand **Why AQUA thinks this**. | "Everything here shows where it came from." |
| 4 | 0:30 | **New chat**: **"Update: we moved the launch to May 2."** One change per message (compound changes are a known weakness). Go back to Memory and refresh until **May 2** is listed. | The launch item now says May 2. | "On a paid key this lands in seconds; on free tiers I've seen up to a minute and a half." Keep talking; refresh once. **Do not cut** if it hasn't landed. |
| 5 | 0:45 | **New chat**: **"Draft a 4-line investor update."** Then in the same chat: **"Where did you learn that?"** | The update says **May 2**, not April 15. The answer points to what you told it. | "It's drafting from the current state, not the first thing I said." |
| 6 | 0:30 | Memory → the risk item → **Correct** → type **"clinics not finishing onboarding"** → Save. **New chat**: **"What's our biggest risk right now?"** | Toast "Corrected". The answer says onboarding, not churn. **[legacy]** No Correct button: in a chat, type **"Actually, my biggest risk is now clinics not finishing onboarding."** It must be "my … is now …": that is the legacy correction pattern (`memoryExtractor.js` UPDATE_PATTERNS); "our" does not match. The answer end to end is UNVERIFIED, so rehearse it. | "Corrections apply everywhere, not just this chat." |
| 7 | 0:25 | Memory → the co-founder item → **Delete**. **New chat**: **"Who is my co-founder?"** | Aqua says it doesn't know. | "Deleted means deleted — every store that can answer." |

Total budget: 4:00 (20 + 60 + 30 + 30 + 45 + 30 + 25 s).

## If something breaks

- **A reply errors** ("All providers exhausted"): the provider key is not loaded or is out of quota. Stop the take; fix the key; restart with a **new** account.
- **Step 4 never lands within ~2 minutes:** say so on camera ("extraction is queued behind a rate limit"). Don't fake it. Re-take later with a paid key.
- **Step 5 still says April 15:** step 4 hadn't landed. Go back and wait for May 2 in Memory before asking.
- **A raw key, `simple_qa`, "event" or "Domain:" appears on Memory/Understanding:** the deploy doesn't include this branch. Stop and redeploy.

## Verified on 2026-10-28 (and what was not)

| Check | Result |
|---|---|
| Fresh account through the real server (fix branch), Memory + Understanding pages | **No leaks** (Playwright text scan). Screenshots: `demo/screens/memory-1920x1080.png`, `demo/screens/understanding-1920x1080.png`. |
| Fresh account: "I'm very bored", "unable to enjoy anything", "my right eye is moving automatically" | **Not stored** (setting off); `[SENSITIVE] not stored` logged for each. |
| "I am a billionaire", "I hate loveit" | No profession and no language stored. Three "billionaire" goals collapse to one. |
| The 7-step journey with real providers, per-step timings, memory latency | **NOT RUN / UNVERIFIED.** This session could not load provider keys (its request to read your `.env` was refused). Run it yourself — command in `PATCH_2026-10-28.md` §5. |
