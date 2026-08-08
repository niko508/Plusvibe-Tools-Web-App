import { NextResponse } from "next/server";
import { plusvibePut, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// POST /api/plusvibe/bulk-update
// Body: { workspace_id, ids: string[], signature: string }
// Proxies Plusvibe's PUT /account/bulk-update to set the signature on a set of
// email accounts. Only the signature field is forwarded here.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      ids?: unknown;
      signature?: string;
    };

    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!body.workspace_id || ids.length === 0) {
      return NextResponse.json(
        { error: "workspace_id and at least one id are required" },
        { status: 400 }
      );
    }
    if (typeof body.signature !== "string") {
      return NextResponse.json(
        { error: "signature is required" },
        { status: 400 }
      );
    }

    const data = await plusvibePut<{ status?: string }>({
      apiKey,
      path: "/account/bulk-update",
      body: {
        workspace_id: body.workspace_id,
        ids,
        signature: body.signature,
      },
    });
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
