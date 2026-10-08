import "server-only";

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { intakeGoogleStop, intakeTenantBlock } from "@/lib/jobs/blocked-inboxes";
import { NO_GOOGLE_TAG } from "@/lib/jobs/blocked-inboxes-types";

// The Clay webhook, as a handler both route paths share.
//
// Called by Clay for a bounce row whose Domain Blocked, Tenant Block or Stop
// Sending to Google column says YES.
// Body: { email, domain?, domain_blocked?, tenant_block?, stop_sending_to_google?, bounce_reason?, source? }
//   Domain Blocked / Tenant Block  the sender's whole domain is blocked: every
//                                  inbox on it stopped and deleted, the sheet updated
//   Stop Sending to Google         every inbox on the domain tagged No Sending to Google
// A body without domain_blocked and stop_sending_to_google is Clay's older
// one, sent only on Domain Blocked YES, and counts as that.
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
 * Whether Clay's Tenant Block column said yes. Clay sends the cell as text,
 * so "YES", "yes", "true" and a real true all count; an empty cell, "NO" and
 * a missing field don't.
 */
export function saysYes(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === "string" && ["yes", "y", "true", "1"].includes(v.trim().toLowerCase());
}

const STOP_GOOGLE_KEYS = ["stop_sending_to_google", "stopSendingToGoogle", "Stop Sending to Google"];
const DOMAIN_BLOCKED_KEYS = ["domain_blocked", "domainBlocked", "Domain Blocked"];

const TENANT_BLOCK_KEYS = ["tenant_block", "tenantBlock", "Tenant Block", "tenant_blocked", "tenantBlocked"];

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
  const domain = body.domain ?? body.Domain ?? body.blocked_domain;

  const flagged = (keys: string[]) => keys.some((k) => saysYes(body[k]));
  const has = (keys: string[]) => keys.some((k) => k in body);
  const source = typeof body.source === "string" ? body.source : "clay";

  // Domain Blocked or Tenant Block: the whole domain goes — every inbox on it
  // stopped and deleted, the sheet updated. A body without a Domain Blocked
  // or Stop Sending to Google field is Clay's older one, sent only when Domain
  // Blocked said YES, so it counts as Domain Blocked.
  const tenant = flagged(TENANT_BLOCK_KEYS);
  const domainBlocked = flagged(DOMAIN_BLOCKED_KEYS) || (!has(DOMAIN_BLOCKED_KEYS) && !has(STOP_GOOGLE_KEYS) && !tenant);
  if (tenant || domainBlocked) {
    const column = tenant ? "tenant-block" : "domain-blocked";
    const r = await intakeTenantBlock({ email, domain, source, column });
    if (r.outcome === "invalid") return NextResponse.json({ status: "invalid", error: r.reason }, { status: 400 });
    if (r.outcome === "duplicate") {
      const d = r.state;
      return NextResponse.json({
        status: "already_handled",
        action: column,
        domain: r.domain,
        repeatHits: d.tenantBlockHits ?? 0,
        message:
          d.cancelledAt !== undefined
            ? `${r.domain} is already blocked${d.tenantQueued || d.tenantAlreadyQueued ? " and its tenant queued" : ""}. Nothing to do.`
            : `${r.domain} is already being blocked. Nothing to do.`,
      });
    }
    return NextResponse.json({ status: "accepted", action: column, domain: r.domain }, { status: 202 });
  }

  // Stop Sending to Google: every inbox on the domain tagged No Sending to Google. Nothing else.
  if (flagged(STOP_GOOGLE_KEYS)) {
    const r = await intakeGoogleStop({ email, domain, source });
    if (r.outcome === "invalid") return NextResponse.json({ status: "invalid", error: r.reason }, { status: 400 });
    if (r.outcome === "duplicate") {
      const g = r.state;
      return NextResponse.json({
        status: "already_handled",
        action: "stop_sending_to_google",
        domain: r.domain,
        repeatHits: g.hits,
        message: g.doneAt === undefined || g.running ? `${r.domain} is being tagged. Nothing to do.` : `${r.domain}'s inboxes were tagged ${NO_GOOGLE_TAG} in the last 24 hours. Nothing to do.`,
      });
    }
    return NextResponse.json({ status: "accepted", action: "stop_sending_to_google", domain: r.domain }, { status: 202 });
  }

  // Every column there, none of them YES.
  return NextResponse.json({ status: "ignored", message: "Neither Domain Blocked, Tenant Block nor Stop Sending to Google says YES. Nothing was done." });
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
        "This is the Blocked Domains webhook. Send a POST, not a GET, with the x-webhook-secret header and a JSON body of { \"email\": \"sender@example.com\", \"domain_blocked\": \"YES\", \"tenant_block\": \"\", \"stop_sending_to_google\": \"\" }. Domain Blocked or Tenant Block blocks the sender's whole domain; Stop Sending to Google tags its inboxes No Sending to Google.",
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
