import { NextResponse } from "next/server";
import { espConfigured, espUrlInvalid } from "@/lib/esp-app";

export const dynamic = "force-dynamic";

// GET /api/esp/status -> { connected, invalid }
// Whether this app knows where the ESP app is, so the forms can say so
// before a run that ends with its Manual Run is started. The address itself
// stays on the server.
export async function GET() {
  return NextResponse.json({ connected: espConfigured(), invalid: espUrlInvalid() });
}
