import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/winning-variants";
import { MAX_SEGMENTS, type SegmentInput } from "@/lib/jobs/winning-variants-types";
import { MAX_WINNER_CAMPAIGNS } from "@/lib/winning-variants/run";
import { planProblems } from "@/lib/winning-variants/plan";

export const dynamic = "force-dynamic";

// POST /api/jobs/winning-variants/start
// { workspaceId, workspaceName, segments: [{ segment, baseId, baseName, ids, name }],
//   tagIds, newTags, optOut: true | false | null }
// One 🟡 clone per segment, made on the server one segment after another:
// step 1 keeps only the variants that got a positive reply across the
// segment's campaigns; a segment without one is skipped.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = String(body.workspaceId ?? "").trim();
    if (!workspaceId) return NextResponse.json({ error: "Pick a workspace." }, { status: 400 });
    const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max) : []);
    const raw = Array.isArray(body.segments) ? (body.segments as Record<string, unknown>[]) : [];
    if (raw.length === 0) return NextResponse.json({ error: "Tick at least one segment." }, { status: 400 });
    if (raw.length > MAX_SEGMENTS) return NextResponse.json({ error: `At most ${MAX_SEGMENTS} segments in one run.` }, { status: 400 });
    const segments: SegmentInput[] = [];
    const names = new Set<string>();
    for (const s of raw) {
      const seg: SegmentInput = {
        segment: String(s.segment ?? "").trim(),
        baseId: String(s.baseId ?? "").trim(),
        baseName: String(s.baseName ?? "").trim(),
        ids: strings(s.ids, MAX_WINNER_CAMPAIGNS),
        name: String(s.name ?? "").trim(),
      };
      if (!seg.ids.includes(seg.baseId)) seg.ids = [seg.baseId, ...seg.ids].slice(0, MAX_WINNER_CAMPAIGNS);
      const problems = planProblems({ workspaceId, campaignId: seg.baseId, name: seg.name });
      if (!seg.segment || problems.length > 0) return NextResponse.json({ error: `${seg.segment || "A segment"}: ${problems[0] ?? "no name"}` }, { status: 400 });
      if (names.has(seg.name.toLowerCase())) return NextResponse.json({ error: `Two clones would both be named "${seg.name}".` }, { status: 400 });
      names.add(seg.name.toLowerCase());
      segments.push(seg);
    }
    const jobId = await createJob(apiKey, {
      workspaceId,
      workspaceName: String(body.workspaceName ?? ""),
      segments,
      tagIds: strings(body.tagIds, 50),
      newTags: strings(body.newTags, 20),
      optOut: body.optOut === true ? "add" : body.optOut === false ? "remove" : "keep",
    });
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) return NextResponse.json({ error: err.message, existingJobId: err.activeJobId }, { status: 409 });
    return errorResponse(err);
  }
}
