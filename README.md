# CS AI Signal Hub

*Which customer needs my attention now, why does it matter, and what should I do next?*

## Look at it in 5 minutes

1. **Hub prototype (interactive):** https://claude.ai/artifact/UHd4SESuoxqyHK8YM7ZDtb
2. **Case study:** https://claude.ai/artifact/JwwsD8FEvDf5WxVBdpXJmg
3. **QBR prototype (interactive):** https://claude.ai/artifact/FkAoRy42trDBE2P6rb7ViY
4. **n8n workflows:** [n8n/](n8n/)

**Prototype, not production.** All data is fictional. Email processing and customer communications are demonstrated through test mailboxes. No customer receives an automated message.

## What it is

An AI-powered Customer Success prototype that turns fragmented customer signals (usage, support, relationship, contract) into transparent priorities, an explainable Health Score, and human-approved next actions. It is a portfolio project and the final project of a KI-Manager certificate course.

The domain logic (modular licensing, sessions/user usage, weekly CSAT, quarterly NPS, renewal/QBR cadence, champion risk) is inspired by real experience as Head of Customer Success Management (EMEA/APAC) at a US enterprise software company, with a SaaS customer data platform (CDP) as the licensed product and Gainsight as the CS platform. **All customers, people, contracts, and figures in this project are entirely fictional**: no real customer data, module names, or prices.

## Project brief

See [docs/05_project_brief.md](docs/05_project_brief.md) for the problem statement, target user, success criteria, demo scenario, and open gaps for the next build phase.

## How it developed

- **Start:** a simple single-file scorer with six weighted churn criteria ([docs/00_prompt_original_scorer_FR-EN.md](docs/00_prompt_original_scorer_FR-EN.md), [German](docs/01_prompt_original_scorer_DE.md)).
- **AI layer:** an Anthropic-powered serverless function reads ticket and chat text and explains risk. The calculated score stays deterministic. The AI insights are kept separate because they can be wrong.
- **Scale and views:** 35 fictional accounts, six CSMs, a health-vs-value matrix, a renewal radar, a map view and a feature-request view for the product team.
- **Human approval:** the project was reframed as a decision-support system, not a churn-alarm dashboard, and extended with an n8n approval workflow.

## Folder structure

```
customer-success-ai-hub/
├── README.md
├── docs/                 ← concept notes, dataset schema, KPI catalog, n8n integration
├── src/                  ← frontend (scoring engine, views, styles)
├── api/                  ← serverless AI layer
├── n8n/                  ← exported n8n workflows (JSON)
├── supabase/             ← migrations, edge functions, seed data
├── tests/                ← automated tests
└── data/
    └── accounts.json     ← 35 fictional accounts, 6 fictional CSMs
```

## Dataset at a glance

- 35 fictional B2B accounts across EMEA, APAC, and the Americas, 6 fictional CSMs with regional coverage
- Per account: contract and ARR, licensed modules, usage and adoption, support tickets, feature requests, weekly CSAT (8 weeks), NPS (3 quarters), champion status, QBR dates, HQ location, free-text snippets for the AI layer
- Details: [docs/02_dataset_schema.md](docs/02_dataset_schema.md)

## Running locally

```bash
npm run dev:local
```

Starts a dependency-free local server (frontend and serverless functions) on http://localhost:5173 (override with the `PORT` environment variable). Set `MOCK_AI=true` in a local `.env` to exercise the AI layer without a real model key or any cost.

Run the tests with `npm test`: 261 tests, all passing.

## Current state

The human-approval workflow and a live email intake are built and tested end to end. A customer email becomes an unconfirmed signal. An AI prepares a classification, a next action and a draft reply. A person confirms the account (Gate 1) and approves the action (Gate 2). Only then does n8n act.

- **n8n workflows** (exported JSON, documented with sticky notes): [n8n/](n8n/), with email intake, AI analysis and the approval workflow described in [docs/06_n8n_integration.md](docs/06_n8n_integration.md) and [docs/15C_email_ingestion_payload_schema.md](docs/15C_email_ingestion_payload_schema.md)

Still planned: a Slack alert when a signal pushes an account over a threshold, a weekly voice-of-customer digest for product, and an error workflow that alerts the owner.
