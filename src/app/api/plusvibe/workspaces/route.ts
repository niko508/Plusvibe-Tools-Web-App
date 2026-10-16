import { NextResponse } from "next/server";
import { plusvibeGet, resolveApiKey } from "@/lib/plusvibe-server";
import type { WorkspacesResponse } from "@/lib/plusvibe-types";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/workspaces
// Validates the API key and returns the workspaces it can access.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const data = await plusvibeGet<WorkspacesResponse>({
      apiKey,
      path: "/authenticate",
    });
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
