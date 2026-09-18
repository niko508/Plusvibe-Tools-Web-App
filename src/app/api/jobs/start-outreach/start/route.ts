import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/start-outreach";
import { EMPTY_OUTREACH_SETTINGS, type MovingInbox, type OutreachSettingsInput } from "@/lib/start-outreach/plan";
import type { TagInput } from "@/lib/tags/bulk-tags";
import type { StartOutreachStartPayload } from "@/lib/jobs/start-outreach-types";

export const dynamic = "force-dynamic";

const MAX_INBOXES = 20_000;
const MAX_VALUES = 20;
const MAX_TAGS = 100;

// POST /api/jobs/start-outreach/start
// Body: StartOutreachStartPayload. Starts the run; it goes on in the
// background and is polled via /list.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<StartOutreachStartPayload>;

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const strings = (v: unknown) =>
      (Array.isArray(v) ? v : []).map((x) => str(x)).filter(Boolean).slice(0, MAX_VALUES);
    const tags = (v: unknown): TagInput[] =>
      (Array.isArray(v) ? v : [])
        .map((t) => ({ name: str((t as TagInput)?.name), color: str((t as TagInput)?.color) }))
        .filter((t) => t.name)
        .slice(0, MAX_TAGS);

    const inboxes: MovingInbox[] = [];
    for (const raw of Array.isArray(body.inboxes) ? body.inboxes : []) {
      const i = raw as Partial<MovingInbox>;
      const id = str(i?.id);
      const email = str(i?.email);
      if (!id || !email) continue;
      inboxes.push({
        id,
        email,
        domain: str(i.domain) || email.slice(email.lastIndexOf("@") + 1).toLowerCase(),
        provider: str(i.provider),
        firstName: str(i.firstName) || undefined,
        lastName: str(i.lastName) || undefined,
      });
    }
    if (inboxes.length === 0) {
      return NextResponse.json({ error: "No inboxes to move." }, { status: 400 });
    }
    if (inboxes.length > MAX_INBOXES) {
      return NextResponse.json(
        { error: `Too many inboxes in one run (${inboxes.length}); the limit is ${MAX_INBOXES}.` },
        { status: 400 }
      );
    }

    const settings: OutreachSettingsInput = { ...EMPTY_OUTREACH_SETTINGS };
    const rawSettings = (body.settings ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(EMPTY_OUTREACH_SETTINGS) as (keyof OutreachSettingsInput)[]) {
      const v = rawSettings[key];
      if (typeof v === "string" || typeof v === "number") settings[key] = String(v);
    }

    const signatures = body.signatures
      ? {
          titles: strings(body.signatures.titles),
          companies: strings(body.signatures.companies),
          phones: strings(body.signatures.phones),
          addresses: strings(body.signatures.addresses),
        }
      : null;

    const domainTags = body.domainTags
      ? { tld: tags(body.domainTags.tld), platform: tags(body.domainTags.platform) }
      : null;

    const payload: StartOutreachStartPayload = {
      sourceWorkspaceId: str(body.sourceWorkspaceId),
      sourceWorkspaceName: str(body.sourceWorkspaceName) || str(body.sourceWorkspaceId),
      destWorkspaceId: str(body.destWorkspaceId),
      destWorkspaceName: str(body.destWorkspaceName) || str(body.destWorkspaceId),
      inboxes,
      settings,
      signatures,
      activeTag: str(body.activeTag) || null,
      domainTags,
      sheet: {
        url: str(body.sheet?.url) || undefined,
        tab: str(body.sheet?.tab) || undefined,
        updateClient: body.sheet?.updateClient === true,
      },
    };

    const jobId = await createJob(apiKey, payload);
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) {
      return NextResponse.json({ error: err.message, activeJobId: err.activeJobId }, { status: 409 });
    }
    if (err instanceof Error && !("status" in err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
