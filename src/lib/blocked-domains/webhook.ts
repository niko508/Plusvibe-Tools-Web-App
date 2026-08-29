import "server-only";

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { intake } from "@/lib/jobs/blocked-domains";

// The Clay webhook, as a handler both route paths share.
//
// Called when a bounce reason shows one of our sending domains has been
// blocked. Body: { domain, bounceReason?, source? }
//
// Authenticated with a shared secret rather than the Plusvibe key: Clay should
// be able to trigger this one action without holding a credential that can do
// anything else to the account.
//
// Mounted at BOTH /api/hooks/blocked-domain and /api/hooks/blocked-domains.
// The rest of the app spells it plural, so the singular-only path was a
// trap — a URL a character off returns Next's 404 page, which says nothing
// about what went wrong.

const HEADER = "x-webhook-secret";

/**
 * Plain-English summary of what already happened to a repeated domain.
 *
 * Driven by what the run actually DID, not by its overall status. A run that
 * deleted every inbox but failed to write the sheet ends as "error", and
 * telling Clay to re-run that domain would be wrong — the inboxes are gone; it
 * is the sheet that needs a look.
 */
function describeExisting(job: {
  domain: string;
  status: string;
  inboxesDeleted: number;
  inboxesFound: number;
}): string {
  const when = `Already run for ${job.domain}`;
  if (job.status === "working" || job.status === "deleting") {
    return `${when} — still in progress. Nothing to do.`;
  }
  if (job.status === "awaiting_confirmation") {
    return `${when} — its ${job.inboxesFound} inbox(es) are stopped and waiting for confirmation in the app. Nothing to do.`;
  }
  if (job.inboxesDeleted > 0) {
    const caveat =
      job.status === "error"
        ? " The run reported a problem afterwards, so check the sheet."
        : "";
    return `${when} — ${job.inboxesDeleted} inbox(es) already deleted. Nothing to do.${caveat}`;
  }
  if (job.status === "dismissed") {
    return `${when} — someone chose to keep the inboxes. Nothing to do.`;
  }
  // Nothing was deleted, so re-running is the sensible suggestion.
  return `${when} — the earlier run ended as "${job.status}" without deleting anything. Remove it in the app to run again.`;
}

/** Constant-time compare, so a wrong secret can't be found a byte at a time. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleBlockedDomainWebhook(request: Request) {
  const expected = process.env.BLOCKED_DOMAIN_WEBHOOK_SECRET?.trim();
  if (!expected) {
    // Refusing is the safe default: without a secret this endpoint would let
    // anyone who finds the URL delete inboxes.
    return NextResponse.json(
      { error: "BLOCKED_DOMAIN_WEBHOOK_SECRET is not set on the server." },
      { status: 503 }
    );
  }

  const provided =
    request.headers.get(HEADER)?.trim() ??
    // Clay can send the secret as a bearer token instead, if that's easier to
    // configure than a custom header.
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ??
    "";
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const result = await intake({
    domain: body.domain ?? body.Domain ?? body.blocked_domain,
    bounceReason:
      typeof body.bounceReason === "string"
        ? body.bounceReason
        : typeof body.bounce_reason === "string"
          ? body.bounce_reason
          : undefined,
    source: typeof body.source === "string" ? body.source : "clay",
  });

  if (result.outcome === "invalid") {
    return NextResponse.json({ status: "invalid", error: result.reason }, { status: 400 });
  }
  // A duplicate is a success as far as Clay is concerned — a domain with 50
  // inboxes bounces for weeks, and every one of those rows firing is expected,
  // not an error to surface there. The message says what already happened, so
  // the response column in Clay explains itself without opening the app.
  if (result.outcome === "duplicate") {
    const j = result.job;
    return NextResponse.json({
      status: "already_handled",
      domain: j.domain,
      jobId: j.id,
      firstSeen: new Date(j.createdAt).toISOString(),
      previousStatus: j.status,
      inboxesDeleted: j.inboxesDeleted,
      repeatHits: j.duplicateHits,
      message: describeExisting(j),
    });
  }
  // 202: the work runs in the background, so Clay isn't held open through a
  // scan of every workspace.
  return NextResponse.json(
    { status: "accepted", domain: result.job.domain, jobId: result.job.id },
    { status: 202 }
  );
}

/**
 * Answers a browser (or a misconfigured GET) with something useful.
 *
 * Without this, visiting the URL to check it returns a bare 405 — which looks
 * like the same failure as a wrong path. This says the path is right and what
 * the endpoint actually wants.
 */
export function describeBlockedDomainWebhook() {
  const configured =
    (process.env.BLOCKED_DOMAIN_WEBHOOK_SECRET?.trim() ?? "") !== "";
  return NextResponse.json(
    {
      endpoint: "blocked-domain",
      ok: true,
      message:
        "This is the Blocked Domains webhook. Send a POST, not a GET, with the x-webhook-secret header and a JSON body of { \"domain\": \"example.com\" }.",
      secretConfigured: configured,
      ...(configured
        ? {}
        : {
            warning:
              "BLOCKED_DOMAIN_WEBHOOK_SECRET is not set, so every POST will be rejected with 401.",
          }),
    },
    { status: 200 }
  );
}
