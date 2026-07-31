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

// GET /api/plusvibe/accounts?workspace_id=...&tags=...
// Returns every email account in the workspace, paginating through the
// underlying /account/list endpoint so the caller gets the full set in one go.
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

    const accounts: EmailAccount[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
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

// The API is inconsistent about `id` vs `_id` between its schema and examples,
// so normalise both here.
function normalizeAccounts(data: RawAccountsResponse): EmailAccount[] {
  const raw = data?.accounts ?? [];
  return raw.map((a) => ({
    id: String(a.id ?? a._id ?? ""),
    email: String(a.email ?? ""),
    status: a.status ? String(a.status) : undefined,
    warmup_status: a.warmup_status ? String(a.warmup_status) : undefined,
    provider: a.provider ? String(a.provider) : undefined,
  }));
}
