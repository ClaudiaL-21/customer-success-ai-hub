# Build-Prompt — Account Health Copilot (Dashboard)

Ziel-Werkzeug: Claude Code (oder gleichwertiger Coding-Agent, der Mehrdatei-Projekte bauen kann).
Voraussetzung: `data/accounts.json` existiert bereits (siehe [02_dataset_schema.md](02_dataset_schema.md)) und wird von diesem Prompt referenziert, nicht neu erfunden.

---

```markdown
# Role
You are a senior full-stack developer and AI-integration engineer building a
portfolio-grade internal dashboard for a Head of Customer Success. You value
explainability (calculated vs. AI-generated must always be visually distinct)
and information density that stays scannable — this is a working tool for
someone managing an international team, not a marketing dashboard.

# Context
This project is a portfolio case study for a repositioning toward "CX Systems
& AI Enablement Specialist". The domain logic is inspired by real experience
leading an international Customer Success Management team (EMEA/APAC) at a US enterprise
software company, managing accounts licensed on a SaaS customer data platform (CDP) and using Gainsight as the CS operations platform. You may
reference the CDP product and Gainsight by name in documentation/README as the real
professional context that informs this project's design — but ALL account
data, contract values, module names, and personal names in this project are
entirely fictional (see data/accounts.json), and this must stay explicit
everywhere.

A mocked dataset already exists at `data/accounts.json`: 25 fictional B2B
accounts across EMEA/APAC, managed by 4 fictional CSMs, each with contract,
usage, support, and relationship data plus free-text ticket/email snippets.
Load and use this file as-is — do not regenerate or alter its structure.

# Task
Build a multi-file project ("Account Health Copilot") with two layers:

## Layer 1 — Deterministic scoring engine (client-side, no AI, always available)
1. Load `data/accounts.json`.
2. Compute for each account:
   a. **Health Score** (0-100) and **Churn Risk category** (low/medium/high)
      using the weighted criteria below.
   b. **Expansion Potential Score** — a separate, positively-framed score
      based on high adoption, positive/growth-oriented feature requests,
      strong CSAT/NPS, and unused licensed module headroom (whitespace).
3. Dashboard views:
   - **Portfolio view** (default): all accounts, sortable/filterable table —
     columns: account, region, CSM, ARR, next renewal date, health score,
     churn risk badge, expansion score, days since last interaction, next
     QBR date. Filter by CSM, region, risk category.
   - **Team view**: aggregated by CSM — count of accounts per risk category,
     total ARR at risk, upcoming renewals (next 90 days), overdue QBRs.
     This is the Head-of-CS lens: "how is my team doing", not just
     account-by-account.
   - **Account detail view**: expandable/drill-down per account showing the
     full score breakdown (which criteria drove the score, with weights and
     contribution), contract details, usage trend, and the free-text
     artifacts.

## Layer 2 — AI enrichment (serverless proxy to Anthropic API, additive only)
4. A serverless endpoint (`api/analyze.js`, Vercel-deployable) that, given an
   account's structured data + free-text artifacts, returns:
   a. A short sentiment read derived from the free-text artifacts (with a
      1-sentence rationale quoting the relevant snippet).
   b. A 2-3 sentence plain-English risk (or opportunity, if expansion score
      is high) narrative combining quantitative top-drivers and qualitative
      text signals.
   c. 1-3 concrete, specific recommended next actions tailored to that
      account's actual top drivers.
   d. For the Team view: an AI-generated weekly priority list — which 3-5
      accounts across the whole team most warrant CSM attention this week,
      with a one-line reason each (capacity-aware framing, not just a sorted
      list).
5. A free-text "Ask about this account" input per account that sends that
   account's full context to the same endpoint and displays the answer.
6. API key read from an environment variable server-side only, never exposed
   to the client. If no key is configured or the call fails, the app must
   keep working fully on the deterministic layer alone, with a visible
   "AI insights unavailable" note instead of breaking.

# Criteria — Health/Churn Score (weights sum to 100%)
- Usage/adoption decline (sessions trend + adoption rate) — 20%
- Recurring unresolved support ticket topic — 15%
- Weekly CSAT trend (level + direction over the 8-week history) — 15%
- NPS (level + trend over the 3-quarter history) — 15%
- Champion risk (recently_departed = high risk, unknown = medium, active = low) — 15%
- No meaningful interaction in 30+ days — 10%
- Exec sponsor not engaged — 5%
- QBR overdue (no QBR held within a reasonable cadence relative to today, and/or no next QBR scheduled) — 5%

Compute each sub-score 0-100 (risk-normalized) before applying weights, and
expose the per-criterion contribution in the account detail breakdown —
exactly like the original single-file scorer this project evolved from, just
with two more criteria (NPS, Champion risk) added based on real CS practice.

# Format & Stack
- Vanilla JS frontend (no heavy framework), Vercel serverless function for
  the AI proxy (Node.js), `data/accounts.json` as static data (already
  provided, do not move it out of `data/`).
- `package.json` with minimal dependencies (Anthropic SDK or plain fetch).
- `.env.example` documenting `ANTHROPIC_API_KEY`.
- Clean, scannable layout: table/list-first, not a chart-heavy dashboard.
  Use color coding (green/orange/red) consistent with churn risk category.
- README covering: what this demonstrates, the real-world context that
  inspired it (CDP / Gainsight experience, described generically), local
  setup, and Vercel deploy steps.

# Constraints
- Never regenerate or hand-edit `data/accounts.json` structure without
  flagging it — it's the agreed source of truth.
- Keep the existing disclaimers: "Demo data only — no real customer
  information is used or stored." and, near AI-generated content: "AI-
  generated insight — may be inaccurate, always verify before acting."
- No database, no accounts/login, no persistence beyond session state
  (filter/sort selections can live in memory, not localStorage).
- Never log or persist the API key anywhere in the frontend bundle.

Build the full project now: scoring engine, portfolio/team/detail views,
serverless AI-proxy endpoint, and README — ready to deploy to Vercel with
just an API key added.
```
