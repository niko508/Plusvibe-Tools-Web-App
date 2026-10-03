import { NextResponse } from "next/server";
import { plusvibePost, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// POST /api/plusvibe/account-delete  body: { workspace_id, email }
// Deletes a single email account.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      email?: string;
    };
    if (!body.workspace_id || !body.email) {
      return NextResponse.json(
        { error: "workspace_id and email are required" },
        { status: 400 }
      );
    }
    const data = await plusvibePost<{ status?: string }>({
      apiKey,
      path: "/account/delete",
      body: { workspace_id: body.workspace_id, email: body.email },
    });
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
