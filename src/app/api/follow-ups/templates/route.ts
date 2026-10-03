import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  loadTemplates,
  saveTemplates,
  TemplateValidationError,
} from "@/lib/follow-ups/store";
import type { FollowUpTemplate } from "@/lib/follow-ups/templates";

export const dynamic = "force-dynamic";

// GET /api/follow-ups/templates -> { templates, seeded }
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    return NextResponse.json(await loadTemplates(apiKey));
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/follow-ups/templates  body: { templates: [{ id, body }] }
// Replaces the whole library — the editor always sends its full list.
export async function PUT(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { templates?: FollowUpTemplate[] };
    if (!Array.isArray(body.templates)) {
      return NextResponse.json(
        { error: "templates must be an array" },
        { status: 400 }
      );
    }
    const templates = await saveTemplates(apiKey, body.templates);
    return NextResponse.json({ templates });
  } catch (err) {
    if (err instanceof TemplateValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
