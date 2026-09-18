import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  deletePreset,
  loadPreset,
  savePreset,
} from "@/lib/signatures/store";

export const dynamic = "force-dynamic";

// GET /api/signatures/presets?workspace_id=... -> { preset }
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const workspaceId =
      new URL(request.url).searchParams.get("workspace_id") ?? "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    return NextResponse.json({ preset: await loadPreset(apiKey, workspaceId) });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/signatures/presets
// Body: { workspaceId, titles, companies, phones, addresses }
export async function PUT(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaceId?: string;
      titles?: string[];
      companies?: string[];
      phones?: string[];
      addresses?: string[];
    };
    const workspaceId = String(body.workspaceId ?? "");
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }
    const preset = await savePreset(apiKey, workspaceId, {
      titles: body.titles ?? [],
      companies: body.companies ?? [],
      phones: body.phones ?? [],
      addresses: body.addresses ?? [],
    });
    return NextResponse.json({ preset });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE /api/signatures/presets?workspace_id=...
export async function DELETE(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const workspaceId =
      new URL(request.url).searchParams.get("workspace_id") ?? "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: await deletePreset(apiKey, workspaceId) });
  } catch (err) {
    return errorResponse(err);
  }
}
