import { NextResponse } from "next/server";
import { fetchSheetMap, SheetError } from "@/lib/sheet";

export const dynamic = "force-dynamic";

// GET /api/sheet?url=<sheet url or id>&tab=<tab name>
// Server-side proxy: fetches the public Google Sheet CSV, parses it by header,
// and returns a normalized domain -> client map. Kept server-side to avoid
// browser CORS and to validate the target (docs.google.com only).
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get("url") ?? "";
    const tab = searchParams.get("tab") ?? "";
    if (!url) {
      return NextResponse.json(
        { error: "A Google Sheets URL is required." },
        { status: 400 }
      );
    }
    const data = await fetchSheetMap(url, tab);
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof SheetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Failed to read sheet";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
