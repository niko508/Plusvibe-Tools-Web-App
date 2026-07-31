# Plusvibe Tools

A clean, minimal web app that bundles bulk utilities for [Plusvibe](https://plusvibe.ai),
built entirely on the [Plusvibe API](https://developer.plusvibe.ai/). Pick a tool,
point it at a workspace, and run work that would otherwise take dozens of clicks.

## Tools

| Tool | Status | What it does |
| --- | --- | --- |
| **Domain Performance Monitoring** | ✅ Live | Breaks a workspace's email stats down by **sending domain** over any date range — sent volume, reply / positive-reply rates, and bounce rate, side by side, with an over-time chart and CSV export. |
| Mailbox Health Audit | 🔜 Planned | Scan every mailbox for warmup health, bounce rates and disconnects. |
| Bulk Mailbox Actions | 🔜 Planned | Apply daily-limit, warmup and tagging changes across many mailboxes at once. |

## How Domain Performance Monitoring works

Plusvibe's [Get email account stats for a date range](https://developer.plusvibe.ai/get-email-account-stats-for-a-date-range-38494510e0)
endpoint accepts a `domain` filter. The tool:

1. Lists every email account in the selected workspace (`/account/list`) and
   derives the unique **sending domains** from the addresses.
2. Fetches workspace-level totals once for the summary cards and the default chart.
3. Fans out one `email-stats?domain=…` call **per domain**, throttled client-side
   to stay under the Plusvibe rate limit (5 req/s), filling the table in as each
   result arrives.

You can optionally filter by recipient inbox provider (Google / Microsoft / Other),
sort every column, click a domain to focus the chart on it, and export the table
to CSV.

## Tech stack

- **Next.js 14** (App Router) + **TypeScript**
- **Tailwind CSS** for styling (light + dark themes)
- **Recharts** for charts
- Server-side **route handlers** proxy every Plusvibe call so the API key never
  ships in the browser bundle

## API key handling

The Plusvibe API key grants access to **all workspaces** on the account, so it is
treated as a secret:

- Enter it once in the app (**Connect** button, top-right). It is stored only in
  your browser's `localStorage` and forwarded to this app's own server routes via
  a header, which then call Plusvibe with `x-api-key`.
- Alternatively, set `PLUSVIBE_API_KEY` as a server environment variable to
  pre-configure a default key (used when a request doesn't supply one). Handy for
  a single-user Railway deployment.

Get a key under **Settings → API access** in Plusvibe (Business plan required).

## Local development

```bash
npm install
cp .env.example .env   # optional: set PLUSVIBE_API_KEY
npm run dev            # http://localhost:3000
```

Production build:

```bash
npm run build
npm run start
```

## Deploying to Railway

This repo is ready for [Railway](https://railway.app):

1. Create a new project → **Deploy from GitHub repo** and pick this repository.
2. Railway auto-detects Next.js (Nixpacks). `railway.json` pins the build/start
   commands (`npm run build` / `npm run start`).
3. Railway injects `PORT`; `next start` binds to it automatically.
4. (Optional) Add a `PLUSVIBE_API_KEY` variable under the service's **Variables**
   tab to pre-configure a default key. Otherwise users enter their own in the UI.

That's it — no other configuration required.

## Adding a new tool

1. Add an entry to `TOOLS` in `src/lib/tools.tsx` (set `status: "active"`).
2. Create `src/app/tools/<slug>/page.tsx` and build the tool UI.
3. Reuse the Plusvibe proxy routes under `src/app/api/plusvibe/` (or add new ones)
   and the client helpers in `src/lib/api-client.ts`.

## Project structure

```
src/
├── app/
│   ├── page.tsx                       # tool-picker landing
│   ├── layout.tsx, globals.css        # shell + design tokens
│   ├── api/plusvibe/                  # server-side proxy routes
│   │   ├── workspaces/route.ts        #   GET /authenticate
│   │   ├── accounts/route.ts          #   GET /account/list (paginated)
│   │   └── email-stats/route.ts       #   GET /account/email-stats
│   └── tools/domain-performance/      # the first tool
├── components/                        # header, dialog, cards, icons, theme…
└── lib/                               # API client, formatting, throttling, types
```
