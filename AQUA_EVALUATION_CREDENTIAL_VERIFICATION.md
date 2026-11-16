# AQUA Evaluation — Credential Verification (console steps)

**Date:** 2026-11-11

**Scope:** everything a person must check, **in the provider consoles**, before the evaluation config may declare a quota domain as free-tier.

**What I did not do:** no API request was made to discover project or organisation ownership, no credential was requested, read or printed, and no console was accessed.

> **UI caveat.** These steps follow the providers' documented consoles. Menu labels change, so if a label differs, the **evidence to record** column is what matters.

## 0. Recommended approach: create new evaluation keys (mapping by construction)

The `.env` keys are **production** keys and are refused by the evaluation gate. The numbered `GEMINI_KEY_n` values are not standard API keys. So:

1. **Groq.** Use an organisation that has **no payment method** (a new one is cleanest). Create one API key in it, named e.g. `aquiplex-eval-<date>`.
2. **Gemini.** Use a Google Cloud project with **no billing account linked** (a new one is cleanest), created from Google AI Studio. Create one API key in it, named e.g. `aquiplex-eval-<date>`.
3. **Store the keys** only in `C:\Users\dell\aquiplex-eval\eval.env`, outside the repository (template: `C:\Users\dell\aquiplex-eval-example\`).

Because each key is created inside a known project or organisation, ownership is established **by construction**. One key per domain is enough: more keys in the same project or organisation add no quota.

## 1. Gemini

| Check | Console steps | Evidence to record (config field) |
|---|---|---|
| **Project ownership and project ID** | (a) **Google AI Studio** → **Get API key** / **API keys**: each key is listed with its Google Cloud **project**. Open the project's details for its project ID. (b) Alternatively, **Google Cloud Console** → choose the project in the project picker → **APIs & Services → Credentials**. The key appears under *API keys* with its creation date and restrictions. A key belongs to the project whose Credentials page lists it. | `domains[].id` = `gemini-project-<project id>`; `verification: { method: "AI Studio API keys page lists <key name> under <project id>", by, at }` |
| **Key restriction (recommended)** | Cloud Console → Credentials → the key → **API restrictions** → restrict to *Generative Language API* | (note in `verification.method`) |
| **Free-tier eligibility** | AI Studio → API keys / **Usage & limits** (or **Rate limits**): the project shows **Free tier**, or offers *Set up billing*, rather than a paid tier. The free tier is per project. | `billingEvidence.method` must mention the free-tier label |
| **Billing status** | Cloud Console → **Billing** → **Account management** / **My projects**, or the project's **Billing** page: it must state that **no billing account is linked** to this project. If one is linked, the project is on the paid tier, so do **not** declare it free. | `billing: "free-tier-verified"` only if no billing account is linked; `billingEvidence: { method, by, at }` |
| Model availability | AI Studio model list for the project: `gemini-2.5-flash` is available on the free tier. A free-tier quota of **0** for a model means paid-only; the manager stops on it as billing. | — |

## 2. Groq

| Check | Console steps | Evidence to record (config field) |
|---|---|---|
| **Organisation ownership and organisation ID** | **console.groq.com** → organisation switcher (top bar) → select the organisation → **Settings → Organization**: shows the organisation name and **ID**. The **API Keys** page lists the keys **of the selected organisation** (name, created, last used). A key belongs to the organisation whose API Keys page lists it. | `domains[].id` = `groq-org-<organisation id>`; `verification: { method: "API Keys page of org <id> lists <key name>", by, at }` |
| **Free-tier eligibility** | **Settings → Billing** (or **Plan**): the organisation is on the **Free** plan. **Settings → Limits** shows the free-plan rate limits for `openai/gpt-oss-120b` (requests and tokens per minute and day). | `billingEvidence.method` must mention the Free plan |
| **Billing status** | **Settings → Billing**: **no payment method** on file, and no paid tier (e.g. *Developer* / *Dev Tier*). If a card is on file, usage can be billed: do **not** declare it free. | `billing: "free-tier-verified"` only on the Free plan with no payment method |

## 3. Record and freeze the evidence

1. Copy `C:\Users\dell\aquiplex-eval-example\config.example.json` to `C:\Users\dell\aquiplex-eval\config.json`.
2. Per domain, fill in: `id`, the `envNames` (the variable **names** in `eval.env`), `verification` and `billingEvidence` (method, **who**, **date**). Change `billing` from `unknown` to `free-tier-verified` **only** after §1/§2 confirmed it.
3. **Re-verify before each live run** if more than a few days have passed. Billing can be attached at any time, and the manager cannot detect it before a request.

## 4. What the software checks, and what it cannot

| Checked by code | Cannot be checked by code (a person's declaration) |
|---|---|
| The credentials file and config are outside the repository (links resolved) | Which project or organisation a key belongs to |
| `credentialSource: "evaluation"`; no production opt-in; no `AQ.` / non-standard keys | Whether billing is attached |
| Every domain used declares `free-tier-verified` **with** evidence (method, who, date) | Whether the evidence is true |
| A billing / paid-tier response stops the run; a quota of 0 is treated as billing | Provider-side changes between verification and the run |
