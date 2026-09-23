import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob, QueueRejectedError } from "@/lib/jobs/campaign-types";
import type { CampaignTypesStartPayload, RoleNames, SourceInput } from "@/lib/jobs/campaign-types-types";
import { CREATED_ROLES } from "@/lib/jobs/campaign-types-types";
import { normalizeName } from "@/lib/campaign-types/match";
import { normalizeKinds, rolesFor } from "@/lib/campaign-types/kinds";
import { normalizeRules, validateRules } from "@/lib/campaign-types/segments";
import { classifyDestinations } from "@/lib/campaign-types/allocate";

export const dynamic = "force-dynamic";

// POST /api/jobs/campaign-types/start
// Body: { mode?, workspaceId, workspaceName,
//         sources: [{ campaignId, campaignName,
//                     names: { blue, optOut, blueOptOut, signature, blueSignature } }],
//         kinds: ["default" | "optOut" | "signature"],
//         rules: [{ segment: string | null, campaignId, campaignName }],
//         activate? }
//
// mode "move" sorts and splits into the copies that already carry these
// names, creating and launching nothing.

const MAX_SOURCES = 25;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<CampaignTypesStartPayload>;

    const workspaceId = String(body.workspaceId ?? "").trim();
    if (!workspaceId) return bad("workspaceId is required");

    // A fix run builds nothing, so it has no types to pick.
    const isFix = body.mode === "fix";
    const kinds = normalizeKinds(body.kinds);
    if (!isFix && kinds.length === 0) return bad("Pick at least one campaign type.");
    const roles = rolesFor(kinds);

    // --- the originals --------------------------------------------------------
    const rawSources = Array.isArray(body.sources) ? body.sources : [];
    if (rawSources.length === 0) return bad("Pick at least one original campaign.");
    if (rawSources.length > MAX_SOURCES) return bad(`At most ${MAX_SOURCES} original campaigns in one run.`);

    const sources: SourceInput[] = [];
    const seenIds = new Set<string>();
    for (const s of rawSources) {
      const campaignId = String(s?.campaignId ?? "").trim();
      const campaignName = String(s?.campaignName ?? "").trim();
      if (!campaignId || !campaignName) return bad("Every original campaign needs an id and a name.");
      if (seenIds.has(campaignId)) return bad(`"${campaignName}" is picked twice.`);
      seenIds.add(campaignId);
      const names = {} as RoleNames;
      for (const role of CREATED_ROLES) {
        names[role] = String(s?.names?.[role] ?? "").trim();
        if (roles.includes(role) && !names[role]) return bad(`No name for the "${role}" campaign of "${campaignName}".`);
      }
      sources.push({ campaignId, campaignName, names });
    }

    // --- a fix run --------------------------------------------------------------
    // It reads the campaigns it is given and moves one segment's leads into
    // campaigns picked by hand. Nothing is derived from a name, nothing is
    // built, nothing is launched — so none of the checks below apply, and a
    // copy is a perfectly good source.
    const mode = body.mode === "move" ? "move" : isFix ? "fix" : "create";
    if (mode === "fix") {
      const segment = String(body.segment ?? "").trim();
      if (!segment) return bad("Type the segment whose leads should move.");
      const picked: { campaignId: string; campaignName: string }[] = [];
      for (const raw of Array.isArray(body.destinations) ? body.destinations : []) {
        const campaignId = String((raw as { campaignId?: unknown })?.campaignId ?? "").trim();
        if (!campaignId) continue;
        if (picked.some((p) => p.campaignId === campaignId)) continue;
        picked.push({
          campaignId,
          campaignName: String((raw as { campaignName?: unknown })?.campaignName ?? "").trim() || campaignId,
        });
      }
      if (picked.length === 0) return bad("Pick at least one campaign for the leads to go to.");
      if (picked.length > MAX_SOURCES) return bad(`At most ${MAX_SOURCES} destination campaigns in one run.`);
      // A campaign that is both read and written would have its own leads
      // taken out and put back, which is at best pointless.
      const overlap = picked.find((p) => sources.some((s) => s.campaignId === p.campaignId));
      if (overlap) return bad(`"${overlap.campaignName}" is both a source and a destination. Un-tick it from one of them.`);
      const { problems: roleProblems } = classifyDestinations(picked);
      if (roleProblems.length > 0) return bad(roleProblems.join(" "));

      const jobId = await createJob(apiKey, {
        mode: "fix",
        workspaceId,
        workspaceName: String(body.workspaceName ?? ""),
        sources,
        segment,
        destinations: picked,
        kinds: [],
        rules: [],
        activate: false,
      });
      return NextResponse.json({ jobId });
    }

    // Two copies under the same name would be indistinguishable afterwards,
    // and the run's own reuse check would then adopt one for both roles —
    // across originals too, since they share the workspace.
    const taken = new Map<string, string>();
    for (const s of sources) taken.set(normalizeName(s.campaignName), `the original "${s.campaignName}"`);
    for (const s of sources) {
      for (const role of roles) {
        const key = normalizeName(s.names[role]);
        const holder = taken.get(key);
        if (holder) return bad(`"${s.names[role]}" would have the same name as ${holder}.`);
        taken.set(key, `a copy of "${s.campaignName}"`);
      }
    }

    // --- the segment rules --------------------------------------------------------
    const rules = normalizeRules(body.rules);
    const problems = validateRules(rules, sources.map((s) => s.campaignId));
    if (problems.length > 0) return bad(problems.join(" "));
    // The stored name is the picked campaign's, whatever the form sent.
    for (const r of rules) r.campaignName = sources.find((s) => s.campaignId === r.campaignId)?.campaignName ?? r.campaignName;

    const jobId = await createJob(apiKey, {
      mode,
      workspaceId,
      workspaceName: String(body.workspaceName ?? ""),
      sources,
      kinds,
      rules,
      activate: body.activate !== false,
    });

    return NextResponse.json({ jobId });
  } catch (err) {
    // Starting while a job runs is normal now — it queues. A 409 here means the
    // job could not even be queued (a duplicate, or a full queue).
    if (err instanceof QueueRejectedError) {
      return NextResponse.json({ error: err.message, existingJobId: err.existingJobId }, { status: 409 });
    }
    return errorResponse(err);
  }
}
