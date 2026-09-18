import { NextResponse } from "next/server";
import { plusvibeGet, resolveApiKey } from "@/lib/plusvibe-server";
import type { EmailAccount } from "@/lib/plusvibe-types";
import { errorResponse } from "@/lib/api-response";

// The raw account shape from Plusvibe varies (`id` vs `_id`), so read loosely.
interface RawAccountsResponse {
  accounts?: Array<Record<string, unknown>>;
}

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const MAX_PAGES = 100; // safety cap: up to 10k accounts

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GET /api/plusvibe/accounts?workspace_id=...&tags=...
//
// Two modes:
//  - Default: returns every account in the workspace, paginating internally so
//    the caller gets the full set in one request.
//  - Paged (`paged=1` with `skip`/`limit`): fetches a SINGLE page and returns
//    `{ accounts, hasMore }`. Lets a client loop and show live progress for
//    large workspaces instead of staring at one long-hanging request.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);
    const workspace_id = searchParams.get("workspace_id") ?? undefined;
    const tags = searchParams.get("tags") ?? undefined;

    if (!workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }

    // --- Paged mode: one page, caller drives the loop --------------------
    if (searchParams.get("paged")) {
      const limit = clampInt(searchParams.get("limit"), PAGE_SIZE, 1, 500);
      const skip = clampInt(searchParams.get("skip"), 0, 0, 1_000_000);
      const data = await plusvibeGet<RawAccountsResponse>({
        apiKey,
        path: "/account/list",
        query: {
          workspace_id,
          tags,
          skip: String(skip),
          limit: String(limit),
        },
      });
      const batch = normalizeAccounts(data);
      return NextResponse.json({
        accounts: batch,
        hasMore: batch.length >= limit,
      });
    }

    // --- Default mode: fetch everything ----------------------------------
    const accounts: EmailAccount[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      // Space out pages so a single large workspace's pagination alone stays
      // under Plusvibe's 5 req/s limit (the bulk-remove scan can page deeply).
      if (page > 0) await sleep(200);
      const data = await plusvibeGet<RawAccountsResponse>({
        apiKey,
        path: "/account/list",
        query: {
          workspace_id,
          tags,
          skip: String(page * PAGE_SIZE),
          limit: String(PAGE_SIZE),
        },
      });
      const batch = normalizeAccounts(data);
      accounts.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    return NextResponse.json({ accounts });
  } catch (err) {
    return errorResponse(err);
  }
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const n = raw == null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// The API is inconsistent about `id` vs `_id` between its schema and examples,
// so normalise both here.
function normalizeAccounts(data: RawAccountsResponse): EmailAccount[] {
  const raw = data?.accounts ?? [];
  return raw.map((a) => {
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    const name = (payload.name ?? {}) as Record<string, unknown>;
    const analytics = (payload.analytics ?? {}) as Record<string, unknown>;
    const health = (analytics.health_scores ?? {}) as Record<string, unknown>;
    const overall = health["7d_overall_warmup_health"];
    const tags = Array.isArray(payload.tags)
      ? (payload.tags as unknown[]).map(String)
      : undefined;
    return {
      id: String(a.id ?? a._id ?? ""),
      email: String(a.email ?? ""),
      status: a.status ? String(a.status) : undefined,
      warmup_status: a.warmup_status ? String(a.warmup_status) : undefined,
      provider: a.provider ? String(a.provider) : undefined,
      first_name: name.first_name ? String(name.first_name) : undefined,
      last_name: name.last_name ? String(name.last_name) : undefined,
      tags,
      warmup_health: typeof overall === "number" ? overall : undefined,
      // Kept as the strings Plusvibe sends; the readers decide how to parse.
      warmup_enabled_at: a.warmup_enb_dt ? String(a.warmup_enb_dt) : undefined,
      created_at: a.timestamp_created ? String(a.timestamp_created) : undefined,
      campaign_ids: Array.isArray(payload.cmps)
        ? (payload.cmps as unknown[]).map(String).filter(Boolean)
        : undefined,
      daily_limit: typeof payload.daily_limit === "number" ? payload.daily_limit : undefined,
    };
  });
}
