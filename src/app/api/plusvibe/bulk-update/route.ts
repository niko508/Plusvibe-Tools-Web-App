import { NextResponse } from "next/server";
import { plusvibePut, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// Fields we allow through to PUT /account/bulk-update. Whitelisted so callers
// can't set arbitrary account fields.
const ALLOWED_FIELDS = [
  "signature",
  "warmup_max_daily_limit",
  "bulk_warmup_is_slow_rampup",
  "warmup_initial_daily_limit",
  "warmup_pace_increment",
  "warmup_randomize",
  "warmup_randomize_num",
  "warmup_reply_rate",
  "warmup_schedule",
  "warmup_business_type",
] as const;

// POST /api/plusvibe/bulk-update
// Body: { workspace_id, ids: string[], ...allowed fields }
// Proxies Plusvibe's PUT /account/bulk-update, forwarding only whitelisted
// fields (signature + warmup settings).
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Record<string, unknown>;

    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!body.workspace_id || ids.length === 0) {
      return NextResponse.json(
        { error: "workspace_id and at least one id are required" },
        { status: 400 }
      );
    }

    const forwarded: Record<string, unknown> = {
      workspace_id: String(body.workspace_id),
      ids,
    };
    for (const key of ALLOWED_FIELDS) {
      if (body[key] !== undefined) forwarded[key] = body[key];
    }
    // Need at least one field to update beyond workspace_id/ids.
    if (Object.keys(forwarded).length <= 2) {
      return NextResponse.json(
        { error: "No updatable fields provided" },
        { status: 400 }
      );
    }

    const data = await plusvibePut<{ status?: string }>({
      apiKey,
      path: "/account/bulk-update",
      body: forwarded,
    });
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
