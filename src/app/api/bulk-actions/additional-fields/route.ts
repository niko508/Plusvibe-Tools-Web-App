import { NextResponse } from "next/server";
import { plusvibeGet, plusvibePost, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import {
  classifyApiError,
  classifyWorkspace,
  normalizeFieldName,
  validateFieldName,
  type FieldOutcome,
  type WorkspaceField,
} from "@/lib/additional-fields/field";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;

// POST /api/bulk-actions/additional-fields
// Body: { workspaces: [{ id, name }], name, defaultValue?, dryRun? }
//
// Creates the same additional field in each selected workspace. Every
// workspace is attempted even if an earlier one fails, and each reports its own
// outcome — a bulk action that stops halfway leaves you guessing which half.
//
// A field's name is immutable once created (only its default can change), so a
// typo pushed to fifty workspaces has to be deleted from fifty workspaces by
// hand. That is why the name is validated here as well as in the form, and why
// the preview exists.

interface IncomingWorkspace {
  id?: string;
  name?: string;
}

interface CreateResult {
  workspaceId: string;
  workspaceName: string;
  outcome: FieldOutcome;
  /** The field already present, as Plusvibe stores it. */
  existingName?: string;
  existingDefault?: string;
  reason?: string;
}

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: IncomingWorkspace[];
      name?: string;
      defaultValue?: string;
      dryRun?: boolean;
    };

    const workspaces = (body.workspaces ?? [])
      .map((w) => ({ id: String(w?.id ?? ""), name: String(w?.name ?? "") }))
      .filter((w) => w.id);
    if (workspaces.length === 0) {
      return NextResponse.json(
        { error: "Pick at least one workspace." },
        { status: 400 }
      );
    }
    if (workspaces.length > MAX_WORKSPACES) {
      return NextResponse.json(
        {
          error: `Too many workspaces (${workspaces.length}); the limit is ${MAX_WORKSPACES}.`,
        },
        { status: 400 }
      );
    }

    const name = String(body.name ?? "").trim();
    const problems = validateFieldName(name);
    if (problems.length > 0) {
      return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
    }
    const defaultValue = String(body.defaultValue ?? "").trim();
    const dryRun = body.dryRun === true;

    const results: CreateResult[] = [];

    for (const ws of workspaces) {
      // Read first: the list is what tells "already has it" apart from "safe
      // to create", and creating blind would fail on every workspace that was
      // set up by hand.
      let existing: WorkspaceField[];
      try {
        await acquireSlot();
        const data = await plusvibeGet<unknown>({
          apiKey,
          path: "/workspaces/additional-fields",
          query: { workspace_id: ws.id },
        });
        existing = asFieldArray(data);
      } catch (err) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "error",
          reason: `Could not read the existing fields: ${message(err)}. Skipped rather than risk a duplicate.`,
        });
        continue;
      }

      const decision = classifyWorkspace(name, existing);
      if (decision.action === "already") {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "already",
          existingName: decision.existing?.name,
          existingDefault: decision.existing?.default_value,
        });
        continue;
      }

      if (dryRun) {
        results.push({ workspaceId: ws.id, workspaceName: ws.name, outcome: "created" });
        continue;
      }

      try {
        await acquireSlot();
        await plusvibePost<Record<string, unknown>>({
          apiKey,
          path: "/workspaces/additional-fields",
          body: {
            workspace_id: ws.id,
            name,
            ...(defaultValue ? { default_value: defaultValue } : {}),
          },
        });
        results.push({ workspaceId: ws.id, workspaceName: ws.name, outcome: "created" });
      } catch (err) {
        const reason = message(err);
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: classifyApiError(reason),
          reason,
        });
      }
    }

    return NextResponse.json({
      dryRun,
      name,
      // What Plusvibe will store — shown so nobody is surprised by the
      // underscores when they go to use it in copy.
      normalizedName: normalizeFieldName(name),
      defaultValue: defaultValue || undefined,
      results,
      totals: {
        created: results.filter((r) => r.outcome === "created").length,
        already: results.filter((r) => r.outcome === "already").length,
        conflict: results.filter((r) => r.outcome === "conflict").length,
        errors: results.filter((r) => r.outcome === "error").length,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

/**
 * The docs show a bare array; the same wrappers other list endpoints use are
 * accepted too, so a change of envelope doesn't read as "no fields".
 */
function asFieldArray(data: unknown): WorkspaceField[] {
  let raw: unknown[] = [];
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === "object") {
    for (const k of ["fields", "additional_fields", "data", "result"]) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        raw = v;
        break;
      }
    }
  }
  return raw
    .map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      const dv = o.default_value;
      return {
        name,
        default_value: typeof dv === "string" ? dv : undefined,
      };
    })
    .filter((f) => f.name);
}
