import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listJobs } from "@/lib/jobs/azure-warmup";
import { isSheetWritingConfigured, serviceAccountEmail } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

// GET /api/jobs/azure-warmup/list
// Also reports whether sheet writing is configured, so the UI can warn up front
// rather than after a run has already started.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    return NextResponse.json({
      jobs: await listJobs(apiKey),
      sheetWriting: {
        configured: isSheetWritingConfigured(),
        serviceAccount: serviceAccountEmail(),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
