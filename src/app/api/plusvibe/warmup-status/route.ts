import { NextResponse } from "next/server";
import { plusvibePatch, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// POST /api/plusvibe/warmup-status  body: { workspace_id, ids, warmup_status }
// Enables/disables warmup for a set of accounts (PATCH /account/bulk-update-warmup).
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      ids?: unknown;
      warmup_status?: string;
    };
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const status = body.warmup_status;
    if (!body.workspace_id || ids.length === 0) {
      return NextResponse.json(
        { error: "workspace_id and at least one id are required" },
        { status: 400 }
      );
    }
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      return NextResponse.json(
        { error: "warmup_status must be ACTIVE or INACTIVE" },
        { status: 400 }
      );
    }
    const data = await plusvibePatch<{ status?: string }>({
      apiKey,
      path: "/account/bulk-update-warmup",
      body: { workspace_id: body.workspace_id, ids, warmup_status: status },
    });
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
