# Plusvibe Tools

A clean, minimal web app that bundles bulk utilities for [Plusvibe](https://plusvibe.ai),
built entirely on the [Plusvibe API](https://developer.plusvibe.ai/). Pick a tool,
point it at a workspace, and run work that would otherwise take dozens of clicks.

## Tools

| Tool | Status | What it does |
| --- | --- | --- |
| **Domain Performance Monitoring** | ✅ Live | Breaks a workspace's email stats down by **sending domain** over any date range — sent volume, reply / positive-reply rates, and bounce rate, side by side, with an over-time chart and CSV export. |
| **Create Email Copy Variations** | ✅ Live | Pick a campaign, paste a batch of variants in the `VARIANT n — name` format, and add them all to a sequence step in one pass — keeping the existing subject line and the variants already there. |
| **Azure Start Warmup** | ✅ Live | Upload the Azure mailbox export and the run does the rest: writes each domain's tenant email + a "Warming Up" status into the Domains sheet, then polls Plusvibe **hourly for up to 7 days**, applying the standard warmup config and switching warmup on for each inbox as it appears. Survives closing the tab; inboxes that never show up are listed for troubleshooting. |
| **Move Leads to Another Campaign** | ✅ Live | Moves a set number of **not-contacted** leads between campaigns in a workspace, carrying their fields and custom variables across. Up to three source → destination pairs run at once as **background jobs** with per-pair progress. |
| **Remove Personalized Opening Line** | ✅ Live | Strips the opening-line personalization from a whole campaign: unwraps the `{{fallback\| {{subject_line}} \| …}}` subject on every variation and removes `{{opening_line}}` from every body, leaving the variations and the rest of the copy untouched. Previews every change before applying. |
| **Remove 50 Inboxes from Domain** | ✅ Live | Trims every domain in a workspace down to 50 inboxes, deleting the **worst warmup-health** ones first, then applies the standard warmup config and enables warmup on the ones kept. Runs as a background job. |
| **Add Signatures** | ✅ Live | Generates hundreds of spintax signature combinations from your company / phone / address variations, personalizes each with the inbox's own name, and applies them across a workspace. |
| **Remove Inboxes** | ✅ Live | Paste a list of sending domains, scan every workspace to find their inboxes, preview exactly what will be removed, then delete them in a **server-side background job** you can leave running. |
| Mailbox Health Audit | 🔜 Planned | Scan every mailbox for warmup health, bounce rates and disconnects. |
| Bulk Mailbox Actions | 🔜 Planned | Apply daily-limit, warmup and tagging changes across many mailboxes at once. |

## How Azure Start Warmup works

A run has three phases and can span days, so it lives entirely server-side:

1. **Wait** — an optional delay (0–72h) before anything happens.
2. **Sheet** — matches every domain in the upload against the `Domain` column of
   the Domains tab, then writes the `Tenant Email Address` and sets `Status` to
   `Warming Up`. Columns are located by header name, not position. Domains with
   no row in the tab are reported rather than silently skipped. A sheet failure
   is **not fatal** — the Plusvibe half still runs.
3. **Poll** — every hour, lists the workspace's inboxes and, for every uploaded
   address that has appeared since the last check, applies the warmup config
   (daily limit 18, ramp-up on from 2 with +3/day, 10% randomization, 46% reply
   rate, `America/New_York`) and PATCHes warmup to `ACTIVE`. It stops when every
   uploaded inbox is warming, or after **7 days** — whichever comes first.

Anything that fails on one pass stays pending and is retried on the next, so a
transient API error doesn't lose inboxes. Inboxes that never appeared are listed
in the run and downloadable as CSV for troubleshooting.

Because a run outlives any deploy, the whole state (including the uploaded rows
and which inboxes are already warming) is persisted. A run interrupted by a
redeploy shows a **Resume** button, which restarts it from where it stopped and
skips what's already done. Mailbox passwords in the CSV are never read.

### Google Sheets write access (`GOOGLE_SERVICE_ACCOUNT_JSON`)

Reading sheets elsewhere in the app uses the public CSV export and needs no
credentials, but **writing** does. Set it up once:

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick)
   a project → **APIs & Services** → enable the **Google Sheets API**.
2. **Credentials → Create credentials → Service account**. Give it a name; no
   roles are needed.
3. Open the service account → **Keys → Add key → Create new key → JSON**.
4. Share the Domains spreadsheet with the service account's email
   (`…@….iam.gserviceaccount.com`) as an **Editor**.
5. In Railway, add a variable `GOOGLE_SERVICE_ACCOUNT_JSON` containing the whole
   downloaded JSON file, and redeploy.

The tool reports whether writing is configured before you start a run, and a
`403` from Google is surfaced with the exact service-account address to share
with. Without it, the run still does the Plusvibe warmup half and says the sheet
step was skipped.

## How Create Email Copy Variations works

Sequences aren't a standalone resource in the Plusvibe API — they're an embedded
field on the campaign, read via `GET /campaign/list-all` and written via
`PATCH /campaign/update/campaign`.

**The `sequences` array is replace-the-whole-thing.** Sending only the new
variants would wipe the existing copy. (Plusvibe support, confirming: *"you need
to use the patch campaign endpoint, and pass the existing variations plus the new
variation."*) So every write here is a read-modify-write:

1. Re-read the campaign **server-side at apply time** — not from the browser's
   preview state — so the merge is based on what's actually stored right now.
2. Append the new variants to the target step, carrying **every** existing step
   and variation through untouched.
3. `PATCH` the full array, then **re-read to verify** the variation count landed
   (the PATCH response doesn't echo the sequences back).

**`sequences` also returns variations that were deleted in the Plusvibe UI.**
Duplicating a campaign or removing steps leaves them behind, and the sequences
payload carries no flag to tell them apart — Plusvibe's own UI hides them, so a
step showing 1 variation can come back from the API with 37. Writing those back
would **resurrect them as live copy**. So before any read or write, the tool
cross-references `GET /campaign/get/variation-stats`, which does expose
`is_del`, and drops anything explicitly marked deleted from every step. (Only
explicitly-flagged variations are dropped — a variation merely absent from stats
is kept, since absence isn't proof of deletion.) A write therefore also cleans
the stale entries out of the sequence.

Other safeguards:

- **Subject line is preserved**, not regenerated — new variants inherit the
  step's existing subject and preheader verbatim.
- **Stale-preview guard**: the apply sends the variation count the preview was
  built from; if the step changed in the meantime the write is rejected with a
  409 instead of merging against stale data.
- **Variation letters** follow the API's `^([A-Z]|[ABC][A-Z])$` rule (A–Z, AA–CZ,
  104 max per step). Letters belonging to *disabled* variants — which can be
  absent from `sequences` but still live on the campaign — are read from
  `GET /campaign/get/variation-stats` and never reused. If such variants exist,
  the UI warns that a write may drop them.
- **Campaign status**: the API has no `DRAFT` status (a never-launched campaign
  comes back as `INACTIVE`), and `INACTIVE` isn't accepted by the `status=` query
  filter — so campaigns are fetched unfiltered and bucketed client-side into
  Active / Draft / Paused / Completed, with a "show all" escape hatch.

### Paste format

Variants are split on `VARIANT n — name` headers; the `═══` rule lines are
decoration and ignored. Blank-line-separated paragraphs become `<p>` blocks, and
spintax (`{{Random | … }}`) and Liquid (`{% if … %}`) pass through untouched.
If no headers are present, the paste is split on the rule lines instead.

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

### Job storage (`JOBS_DIR`) — important for redeploys

Both background-job tools (**Remove Inboxes** and **Remove 50 Inboxes from
Domain**) write their records as JSON under a shared base directory, `JOBS_DIR`
(default `./.jobs-data`), each in its own subfolder (`bulk-delete/`,
`remove-50/`).

Jobs run **inside the web process**. That means:

- Closing the browser tab is fine — the job keeps running on the server.
- A **redeploy or container restart is not** — Railway replaces the container
  (SIGTERM → new container with a fresh filesystem), which **stops the running
  job**. Without a persistent volume the records are also wiped, so the job
  disappears entirely.

**To make jobs durable across redeploys, mount a
[Railway volume](https://docs.railway.app/reference/volumes):**

1. Service → **Settings → Volumes → New Volume**, mount path e.g. `/data`.
2. Service → **Variables** → add `JOBS_DIR=/data/jobs`.
3. Redeploy.

With the volume, a job that gets killed by a deploy is preserved and shown as
**Interrupted** (with its last-known progress) instead of vanishing. On SIGTERM
the app also flushes any running job to disk as interrupted before exiting.

**Recovering an interrupted job:** deletions are idempotent — an inbox that was
already removed is treated as "already gone (skipped)". So to finish an
interrupted **Remove Inboxes** job, just re-scan the same domain list and start
again; for **Remove 50**, reload the preview and start again. Only the remaining
inboxes are acted on.

**Best practice:** avoid deploying while a large job is running — the deploy will
stop it. Kick off big trims when you're not about to push changes.

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
