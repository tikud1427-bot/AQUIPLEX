# YC application — preparation draft (2026-10-15)

This is a working draft for the founders, not a submission. Everything is
grounded in the repository as of today. Rules for using it:

- `[UNKNOWN — FOUNDER TO PROVIDE]` marks a fact this repo cannot establish.
- Don't fill a placeholder with a guess.
- Don't submit claims marked *hypothesis* as results.

---

## 1. One sentence

**Aquiplex makes an AI assistant that keeps track of where your startup
stands — what's current, what changed, and where it learned each fact — so you
stop re-explaining your company to every new AI conversation.**

## 2. Target customer

Early-stage founders and solo operators (pre-seed to seed, 1–10 people) who use
an AI assistant several times a week to write, plan and think about one
evolving company.

*This is a hypothesis. No interviews have been recorded yet; see
`PILOT_VALIDATION_PLAN.md`.*

## 3. The problem

Every AI conversation starts from zero. Founders paste the same background over
and over. Worse, their facts change constantly: pricing, the launch date, the
stack, the ICP, who owns what. Assistants with "memory" keep the old version,
mix old and new, or hide what they believe. The result is investor updates,
plans and emails written from stale facts, plus a growing tax of re-explaining.

*The severity is a hypothesis to validate with interviews.*

## 4. The solution and the measurable improvement it aims for

Aqua turns what a founder says and uploads into dated, sourced statements about
their company. When something changes, the old statement is retired, not
averaged in. Every answer can show where a fact came from, and the founder can
correct or delete any fact. Corrections and deletions hold across later
conversations.

**Aim:** cut the share of answers that use outdated facts (the *stale-answer
rate*) below what generic assistant memory achieves, while staying close to
"paste everything" quality once a project's history is too long to paste.

**Current measurement (honest):** on a held-out test with short histories, Aqua's
World Model gave stale answers 15.2% of the time. Simple retrieval memory scored
9.1%, and pasting the full history scored 1.0% (`PRODUCT_SCORECARD.md`). The
long-history test, where Aqua is designed to win, is pre-registered but **not
completed**: four attempts died to host sleep or a reboot, and no result exists.

**On the real product (2026-10-17, founder workflow driven end to end):**

- **21 of 23 checks pass.**
- What a founder says reaches memory in 17–94 s.
- A changed fact is used in later conversations.
- Corrections and deletions hold across conversations and stores.
- Another account sees none of it.
- Known weakness: one sentence carrying two changes keeps only one of them.

This is one synthetic workflow on our own machine, not user evidence.

## 5. Why existing alternatives fall short

*This is a hypothesis drawn from product knowledge, not customer research.*

- **ChatGPT, Claude and Gemini memory and projects:** free and convenient. Memory is opaque and hard to correct fact by fact, and nothing guarantees that a changed fact replaces the old one.
- **Notion, docs and wikis:** they hold the truth only if someone keeps them current, and they don't participate in the AI conversation.
- **Pasting context each time:** works until the history gets too long, and costs time every session.

## 6. Advantage Aquiplex can plausibly build

- **Technical, not yet proven.** A tested pipeline (about 4,600 automated tests) that keeps per-fact provenance, supersession, disputes and deletion across conversations and documents. It becomes an advantage **only if** the pre-registered long-history experiment shows it beats simpler memory. Until then, call it a capability, not a moat.
- **Trust.** "See exactly what it believes, with sources, and delete any of it" is built into the product. That could matter for founders handing an AI sensitive company context. *Hypothesis.*
- **Distribution.** `[UNKNOWN — FOUNDER TO PROVIDE: communities, audience or networks the founders actually have]`

## 7. Why now

- Founders now draft much of their writing with AI assistants, so stale context costs them directly. *Hypothesis; needs a cited source or our own interview data.*
- Long-context models make "paste everything" good for small projects. That pushes the remaining value toward keeping state correct over months, which is the problem Aqua targets.

## 8. Business model and expansion

- **Today:** prepaid INR credit packs through Razorpay: ₹49 for 500 credits up to ₹999 for 20,000. Free daily credits. A message costs 5 credits; a file upload costs 8.
- **Proposed test (not built):** a monthly founder plan around the price of a mainstream assistant subscription, offered to pilot users only after they activate. See the pilot plan, week 4.
- **Expansion path:**
  1. small teams sharing one company's state;
  2. consultants and agencies managing several client engagements. This needs per-project scoping, which is not built yet.
- **Unit economics:** UNMEASURED. All production models currently run on free provider tiers. Cost per active user must be measured on paid models before pricing is fixed.
- **Market size.** No figure is claimed. Use this bottom-up formula once its inputs are validated:

  `addressable founders × share reachable via our channels × paid conversion × price × 12`

  Every term is `[UNKNOWN — validate in pilot]`. Do not substitute a top-down "AI assistant market" number.

## 9. What has actually been built

Verified in the repository:

- A live web app, an Android app (Capacitor) and an open-signup platform:
  - email and Google login, including a native Android OAuth handoff;
  - prepaid billing;
  - account deletion.
- The chat engine:
  - multi-provider routing with fallback;
  - file and archive ingestion (PDF, DOCX, PPTX, XLSX, CSV, EPUB, Markdown, HTML, images, audio, video, ZIP/TAR) with zip-bomb limits;
  - codebase indexing with a call graph and patch/checkpoint editing.
- The World Model: a Postgres claim store with durable background jobs (extraction, contradiction, embedding, reflection), supersession, disputes, correction and deletion.
- A two-minute onboarding interview that ends in a correctable "here is what I understood" card.
- A Memory page showing **what Aqua currently answers from**, with the sentence or file each fact came from. One-click correction and deletion apply in every later conversation and every store, isolated per account (built and verified end to end, 2026-10-17).
- An evaluation stack:
  - a regression gate (24 gates, passing);
  - held-out Lift experiments with a blind judge;
  - a pre-registered long-history experiment.
- As of 2026-10-15, content-free product analytics: signup → first chat → 7-day activation → week-1 and week-4 retention.

## 10. Users, revenue, growth, retention

| Metric | Value |
|---|---|
| Registered users | `[UNKNOWN — FOUNDER TO PROVIDE from the production database]` |
| Weekly active users | `[UNKNOWN — run scripts/activation-report.mjs once events accumulate]` |
| Revenue to date | `[UNKNOWN — FOUNDER TO PROVIDE from Razorpay]` |
| Retention | Not measurable before 2026-10-15 (no instrumentation). |
| Paying customers | `[UNKNOWN — FOUNDER TO PROVIDE]` |

Don't describe the prototype as having product-market fit.

## 11. Evidence

- **Evaluations:** see `PRODUCT_SCORECARD.md`. Report the v3 numbers as they are. The fixes improved the World Model by 9.6 points, but it does not yet beat simple memory. v4 is pre-registered with a fixed decision rule.
- **Product workflow (synthetic, ours):** `aqua/scripts/e2e-founder-journey.mjs` on the real app: 21/23 checks; details in `PRODUCT_SCORECARD.md` §3b.
- **Production read-path benchmark:** the canonical retrieval Aqua serves with a database carries far more irrelevant context than the legacy path (153 against 18 noise lines on 200 queries). It is now gated in CI; the fix is the next engineering priority.
- **Customer workflows:** none recorded yet. `[Add pilot results here.]`

## 12. Founders

From the site's `/founders` page. **Founders to verify and expand.**

- **Chhanda Prabal Das**, co-founder and CEO. The page says: student and entrepreneur; has worked on early-stage startups including Uniqence and Acodet. `[FOUNDER TO PROVIDE: concrete outcomes, what was built, technical background]`
- **Ananya Prabal Das**, co-founder and COO. The page says: runs daily operations and works across the full stack on Aqua's engine and platform. `[FOUNDER TO PROVIDE]`
- How long you've worked together, the time commitment, and who wrote the code: `[UNKNOWN — FOUNDER TO PROVIDE]`.
- The insight: why you understand this problem better than others. `[FOUNDER TO PROVIDE, ideally a specific story of stale context costing you]`

## 13. Biggest risks and open questions

1. **Differentiation unproven.** On short histories, simpler methods beat our architecture on our own target metric. If v4 doesn't show a long-history advantage, the product should ship the simpler approach. The company then has to win on workflow, trust and distribution, not on memory technology.
2. **Incumbents.** General assistants keep improving memory and project features for free.
3. **Willingness to pay** in a price-sensitive segment.
4. **Security posture.** Secrets were exposed in a public repository and must be rotated before any growth push. The production deploy lags known security fixes.
5. **Provider dependence.** Free-tier capacity is not a business.

## 14. Next milestones to establish real demand

| By | Milestone |
|---|---|
| Week 0 | Rotate secrets; ship the security hotfix; deploy the analytics. |
| Week 1–2 | 20 problem interviews; recruit 10 design partners. |
| Week 2–3 | Run v4 and apply its pre-registered decision (keep, simplify or stop the World Model). |
| Week 4–6 | 10 partners using Aqua on their real company for 3+ weeks. Measure activation, week-2 retention, stale-answer incidents they report, and usefulness ratings. |
| Week 6 | Offer a paid plan to activated partners. Count conversions, not compliments. |

---

## Live demo script (about 4 minutes, the real product)

Setup: the deployed release (or the local launcher) with a **paid** extraction
provider key; on free tiers a stated change can take a minute or more to reach
memory. Use a fictional startup, "Tidepool", and say on camera that it is
fictional. Every step below passed in the automated founder journey (run 4).

1. **Sign up → onboarding (20 s).** Aqua asks what you are working on and says what it cannot see (email, chat tools, code hosts).
2. **Tell it once (60 s).** *"I'm building Tidepool, a scheduling tool for physiotherapy clinics. My co-founder Maya runs engineering."* Then *"We charge $49 a month per clinic, and our launch is on April 15."* Attach a one-page pricing note. Click **"Show me what you understand"**.
3. **Where it learned it (30 s).** Open **Memory → What Aqua knows now**. Each item shows its source: a conversation or the uploaded file. Expand "Where Aqua learned this" on one.
4. **Change one thing (30 s).** In a **new** conversation: *"Update: we moved the launch to May 2."* Say one change per sentence; compound changes are a known weakness. Refresh Memory until the new date is listed.
5. **The payoff (45 s).** In another **new** conversation: *"Draft a 4-line investor update."* It says May 2, not April 15. Ask *"Where did you learn that?"*: it points to what you told it.
6. **Correct (30 s).** In Memory, press **Correct** on the biggest-risk item and type the new value. Ask about it in a new conversation: the corrected value answers.
7. **Delete (25 s).** Delete the co-founder item. Ask *"Who is my co-founder?"* in a new conversation: Aqua says it does not know.

What makes it different: change handling, visible sources, and corrections and
deletions that hold in every later conversation.

How it is verified: the Memory page on screen, and the automated journey and
eval numbers in `PRODUCT_SCORECARD.md`, shown as they are, including the
weaknesses.

**Rehearse on the deployed build.** If a step fails in rehearsal, say so rather
than cherry-picking a run.
