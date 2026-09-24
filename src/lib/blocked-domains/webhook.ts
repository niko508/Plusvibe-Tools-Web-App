import "server-only";

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { intakeInbox } from "@/lib/jobs/blocked-inboxes";
import type { BlockedInboxJob } from "@/lib/jobs/blocked-inboxes-types";

// The Clay webhook, as a handler both route paths share.
//
// Called when a bounce shows one of our sender inboxes may be blocked.
// Body: { email, bounceReason?, source? } — the SENDER inbox, which is judged
// on its own last 14 days. (It used to take a domain; a body with only a
// domain is refused with a message saying what to send instead.)
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

/** Plain-English summary of what already happened to a repeated inbox. */
function describeExisting(job: BlockedInboxJob): string {
  const when = `Already handled ${job.email}`;
  switch (job.status) {
    case "working":
    case "deleting":
      return `${when} — still in progress. Nothing to do.`;
    case "awaiting_confirmation":
      return `${when} — blocked and stopped, waiting for the deletion to be confirmed in the app. Nothing to do.`;
    case "deleted":
      return `${when} — blocked and deleted. Nothing to do.`;
    case "dismissed":
      return `${when} — blocked, and someone chose to keep it stopped. Nothing to do.`;
    case "passed":
      return `${when} — its last 14 days passed. It is judged again on the first bounce 24 hours after that.`;
    case "untouched":
      return `${when} — neither Microsoft nor Google, so it is left alone.`;
    case "not_found":
      return `${when} — not in any workspace. Checked again 24 hours after that.`;
    default:
      return `${when} — the last run ended as "${job.status}". Checked again 24 hours after it; remove it in the app to run it now.`;
  }
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

  const email =
    body.email ?? body.Email ?? body.inbox ?? body.sender ?? body.sender_email ?? body.senderEmail ?? body.from_email;
  if (email === undefined && (body.domain ?? body.Domain ?? body.blocked_domain) !== undefined) {
    // The old body. Refused rather than guessed at: a domain says nothing
    // about which of its inboxes bounced.
    return NextResponse.json(
      {
        status: "invalid",
        error: 'This webhook now takes the sender inbox, not the domain. Send { "email": "sender@domain.com" }.',
      },
      { status: 400 }
    );
  }

  const result = await intakeInbox({
    email,
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
  // A repeat is a success as far as Clay is concerned: one inbox bounces many
  // times, and every one of those rows firing is expected. The message says
  // what already happened, so the response column in Clay explains itself.
  if (result.outcome === "duplicate") {
    const j = result.job;
    return NextResponse.json({
      status: "already_handled",
      email: j.email,
      jobId: j.id,
      firstSeen: new Date(j.createdAt).toISOString(),
      previousStatus: j.status,
      repeatHits: j.duplicateHits,
      message: describeExisting(j),
    });
  }
  // 202: the work runs in the background, so Clay isn't held open through a
  // scan of every workspace.
  return NextResponse.json({ status: "accepted", email: result.job.email, jobId: result.job.id }, { status: 202 });
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
        "This is the Blocked Domains webhook. Send a POST, not a GET, with the x-webhook-secret header and a JSON body of { \"email\": \"sender@example.com\" } — the sender inbox that bounced.",
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
