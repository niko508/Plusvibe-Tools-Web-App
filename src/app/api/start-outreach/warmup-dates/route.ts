import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { fetchSheetGrid, SheetError } from "@/lib/sheet";
import { envSpreadsheetId, readTab } from "@/lib/google-sheets";
import { DEFAULT_SHEET_TAB } from "@/lib/jobs/azure-warmup-types";
import {
  normalizeDomain,
  warmupFromGrid,
  type SheetWarmup,
} from "@/lib/start-outreach/readiness";

export const dynamic = "force-dynamic";

const MAX_DOMAINS = 5000;

// POST /api/start-outreach/warmup-dates
// Body: { domains: string[], url?: string, tab?: string }
//
// Reads the Domains tab and returns each requested domain's "Warmup Started"
// and "Warmup Days" cells. The synced sheet (url + tab from the browser) is
// used when given; otherwise the service-account sheet the automations write
// to. A sheet that cannot be read is reported as a problem with an empty map,
// not as a failure — the tool then falls back to Plusvibe's own dates and
// says why.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as {
      domains?: unknown;
      url?: unknown;
      tab?: unknown;
    };
    const wanted = new Set(
      (Array.isArray(body.domains) ? body.domains : [])
        .map((d) => normalizeDomain(String(d ?? "")))
        .filter(Boolean)
        .slice(0, MAX_DOMAINS)
    );
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const tab =
      typeof body.tab === "string" && body.tab.trim() ? body.tab.trim() : DEFAULT_SHEET_TAB;

    let grid: string[][] | null = null;
    let source = "";
    let problem: string | null = null;
    try {
      if (url) {
        grid = await fetchSheetGrid(url, tab);
        source = `the synced sheet, "${tab}" tab`;
      } else {
        const id = envSpreadsheetId();
        if (!id) {
          problem = "No sheet is synced and SPREADSHEET_ID is not set.";
        } else {
          grid = await readTab(id, tab);
          source = `the Email Infra sheet, "${tab}" tab`;
        }
      }
    } catch (err) {
      problem =
        err instanceof SheetError || err instanceof Error
          ? `The sheet could not be read: ${err.message}`
          : "The sheet could not be read.";
    }

    const byDomain: Record<string, SheetWarmup> = {};
    let rows = 0;
    if (grid) {
      const parsed = warmupFromGrid(grid);
      if (parsed.problem) problem = `${source}: ${parsed.problem}`;
      for (const [domain, cells] of parsed.byDomain) {
        if (wanted.size > 0 && !wanted.has(domain)) continue;
        byDomain[domain] = cells;
        rows += 1;
      }
    }

    return NextResponse.json({ byDomain, rows, source: source || null, problem });
  } catch (err) {
    return errorResponse(err);
  }
}
