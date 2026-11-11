import { NextResponse } from "next/server";
import { burnedAccess } from "@/lib/burned/access";
import { errorResponse } from "@/lib/api-response";
import { listJobs } from "@/lib/jobs/burned-removal";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { who } = await burnedAccess(request);
    return NextResponse.json({ jobs: await listJobs(who) });
  } catch (err) {
    return errorResponse(err);
  }
}
