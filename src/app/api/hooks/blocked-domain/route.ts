import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { intake } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/hooks/blocked-domain
//
// Called by Clay when a bounce reason shows one of our sending domains has been
// blocked. Body: { domain, bounceReason?, source? }
//
// Authenticated with a shared secret rather than the Plusvibe key: Clay should
// be able to trigger this one action without holding a credential that can do
// anything else to the account.

const HEADER = "x-webhook-secret";

/** Constant-time compare, so a wrong secret can't be found a byte at a time. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
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
  // A duplicate is a success as far as Clay is concerned — one blocked domain
  // produces many bounce rows, and retrying is not an error to surface there.
  if (result.outcome === "duplicate") {
    return NextResponse.json({
      status: "duplicate",
      domain: result.job.domain,
      jobId: result.job.id,
      message: "Already handled or in progress.",
    });
  }
  // 202: the work runs in the background, so Clay isn't held open through a
  // scan of every workspace.
  return NextResponse.json(
    { status: "accepted", domain: result.job.domain, jobId: result.job.id },
    { status: 202 }
  );
}
