import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { deleteIndustry, IndustryError, loadIndustries, upsertIndustry } from "@/lib/campaign-types/industries-store";

export const dynamic = "force-dynamic";

// GET /api/campaign-types/industries -> { industries }
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    return NextResponse.json({ industries: await loadIndustries() });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/campaign-types/industries  { name, segments, noSegment? } -> { industries, saved }
export async function PUT(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; segments?: unknown; noSegment?: unknown };
    return NextResponse.json(
      await upsertIndustry({
        name: String(body.name ?? ""),
        segments: Array.isArray(body.segments) ? body.segments.map((s) => String(s ?? "")) : [],
        noSegment: typeof body.noSegment === "string" ? body.noSegment : null,
      })
    );
  } catch (err) {
    if (err instanceof IndustryError) return NextResponse.json({ error: err.message }, { status: 400 });
    return errorResponse(err);
  }
}

// DELETE /api/campaign-types/industries?name=… -> { industries }
export async function DELETE(request: Request) {
  try {
    await requireAccountKey(request);
    const name = new URL(request.url).searchParams.get("name") ?? "";
    return NextResponse.json({ industries: await deleteIndustry(name) });
  } catch (err) {
    return errorResponse(err);
  }
}
