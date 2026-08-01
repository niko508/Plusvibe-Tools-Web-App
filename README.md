# Plusvibe Tools

A clean, minimal web app that bundles bulk utilities for [Plusvibe](https://plusvibe.ai),
built entirely on the [Plusvibe API](https://developer.plusvibe.ai/). Pick a tool,
point it at a workspace, and run work that would otherwise take dozens of clicks.

## Tools

| Tool | Status | What it does |
| --- | --- | --- |
| **Domain Performance Monitoring** | ✅ Live | Breaks a workspace's email stats down by **sending domain** over any date range — sent volume, reply / positive-reply rates, and bounce rate, side by side, with an over-time chart and CSV export. |
| **Remove Inboxes** | ✅ Live | Paste a list of sending domains, scan every workspace to find their inboxes, preview exactly what will be removed, then delete them in a **server-side background job** you can leave running. |
| Mailbox Health Audit | 🔜 Planned | Scan every mailbox for warmup health, bounce rates and disconnects. |
| Bulk Mailbox Actions | 🔜 Planned | Apply daily-limit, warmup and tagging changes across many mailboxes at once. |

## How Remove Inboxes works

Plusvibe has no "find inboxes by domain" endpoint, so the tool:

1. **Scans in the browser** — lists every inbox across the selected workspaces
   (`/account/list`, paginated + throttled) and builds a `domain → inboxes`
   index. This is one pass over your inventory (seconds to ~2 min), independent
   of how many domains you paste.
2. **Previews** — shows, per pasted domain, how many inboxes match and in which
   workspace(s), the grand total to delete, and which domains weren't found.
   Nothing is deleted yet; you arm the delete by typing the exact inbox count.
3. **Deletes as a background job** — on confirm, the inbox list is handed to a
   **server-side job** (`POST /account/delete` per inbox) that keeps running
   after you close the app. Deletions across all jobs share one **global rate
   limiter** (~4.5/s) to stay under Plusvibe's 5 req/s cap.
4. **Reports** — jobs are persisted and shown in a Jobs panel with live progress
   (by domains processed) and a summary: domains removed, inboxes deleted,
   domains not found, and per-inbox errors (with copy/export).

Jobs are tagged with a fingerprint of your API key (the key itself is held in
memory only, **never written to disk**), so only a client using the same key
sees them. A run is naturally resumable — re-scanning only finds inboxes that
still exist, so an interrupted run continues safely.

Two workspaces are **unchecked by default** in the scope selector ("Ikoni
Digital Lead Nurturing + Duplicate Workspace" and "Inbox Warmup") — re-check
them anytime.

### Faster scans with the Email Infra sheet (optional)

Scanning every workspace is the slow part. If you keep an "Email Infra" Google
Sheet mapping each **domain → client**, sync it via the **Sync sheet** button
(top-right) — paste the sheet URL and tab name (default `📋 Domains`). Because
the sheet's Client value equals the Plusvibe **workspace name**, a scan then
resolves each pasted domain → client → workspace and lists **only those
workspaces** instead of all of them — turning a minute-plus scan into seconds
when your domains sit in one or a few workspaces.

- Columns are matched **by header name** (`Domain`, `Client`), so column order
  can change.
- The sheet must be shared as **"anyone with the link can view"** (read
  server-side via its public CSV export — no Google login).
- **Full-scan sheet misses** (on by default) falls back to scanning the
  remaining workspaces for any pasted domain the sheet can't place, so nothing
  is silently missed. Turn it off to trust the sheet fully for maximum speed.
- The deletion phase is unchanged — the sheet only speeds up finding the
  inboxes, not the rate-limited deletes.

### Job storage (`JOBS_DIR`)

Job records are written as JSON under `JOBS_DIR` (default `./.jobs`). Out of the
box, history survives closing the browser. To also survive a **Railway
redeploy**, mount a [Railway volume](https://docs.railway.app/reference/volumes)
and set `JOBS_DIR` to a path on it (e.g. `/data/jobs`); otherwise records last
only for the container's lifetime.

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
