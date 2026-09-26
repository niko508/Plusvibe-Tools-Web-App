import { NextResponse } from "next/server";
import { PlusvibeError } from "@/lib/plusvibe-server";

// Normalises any thrown error into a JSON response the UI can render.
export function errorResponse(err: unknown) {
  if (err instanceof PlusvibeError) {
    return NextResponse.json(
      { error: err.message, details: err.details ?? null },
      { status: err.status }
    );
  }
  const message = err instanceof Error ? err.message : "Unexpected server error";
  return NextResponse.json({ error: message }, { status: 500 });
}
