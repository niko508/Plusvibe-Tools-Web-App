import "server-only";

import { normalizeDomainToken } from "@/lib/format";
import { parseCsv } from "@/lib/csv";

export { parseCsv };

// Reads a Google Sheet tab (public, "anyone with the link can view") as CSV via
// the gviz endpoint and builds a domain -> client map, locating the columns by
// HEADER NAME so column reordering doesn't break it.

export interface SheetMap {
  map: Record<string, string>; // normalized domain -> client
  domains: number;
  clients: number;
}

export class SheetError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SheetError";
    this.status = status;
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { ts: number; data: SheetMap }>();

// Accepts a full Google Sheets URL or a bare spreadsheet id.
export function extractSheetId(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

function gvizUrl(id: string, tab: string): string {
  // Host is always docs.google.com and the id is validated — no SSRF surface.
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    tab
  )}`;
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped "" quotes,
// and commas/newlines inside quotes.

function findColumn(header: string[], name: string): number {
  const target = name.trim().toLowerCase();
  // exact header match first, then a contains fallback
  let idx = header.findIndex((h) => h.trim().toLowerCase() === target);
  if (idx === -1) {
    idx = header.findIndex((h) => h.trim().toLowerCase().includes(target));
  }
  return idx;
}

export async function fetchSheetMap(
  input: string,
  tab: string
): Promise<SheetMap> {
  const id = extractSheetId(input);
  if (!id) {
    throw new SheetError(
      "Couldn't read a Google Sheets link. Paste the full share URL.",
      400
    );
  }
  const cleanTab = (tab || "").trim() || "Sheet1";
  const key = `${id}::${cleanTab}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  let res: Response;
  try {
    res = await fetch(gvizUrl(id, cleanTab), { cache: "no-store" });
  } catch (err) {
    throw new SheetError(
      `Couldn't reach Google Sheets: ${(err as Error).message}`,
      502
    );
  }

  if (!res.ok) {
    throw new SheetError(
      `Google Sheets returned ${res.status}. Make sure the sheet is shared as "anyone with the link can view".`,
      res.status === 404 ? 404 : 502
    );
  }

  const text = await res.text();
  // A private sheet redirects to an HTML sign-in page instead of CSV.
  if (/^\s*</.test(text) || text.toLowerCase().includes("<html")) {
    throw new SheetError(
      'This sheet isn\'t publicly readable. Share it as "anyone with the link can view".',
      403
    );
  }

  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new SheetError("The sheet tab appears to be empty.", 422);
  }

  const header = rows[0];
  const domainIdx = findColumn(header, "domain");
  const clientIdx = findColumn(header, "client");
  if (domainIdx === -1 || clientIdx === -1) {
    throw new SheetError(
      `Couldn't find "Domain" and "Client" columns in tab "${cleanTab}".`,
      422
    );
  }

  const map: Record<string, string> = {};
  const clientSet = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const rawDomain = cells[domainIdx] ?? "";
    const client = (cells[clientIdx] ?? "").trim();
    if (!client || client === "–" || client === "-") continue;
    const domain = normalizeDomainToken(rawDomain);
    if (!domain) continue;
    map[domain] = client;
    clientSet.add(client);
  }

  const data: SheetMap = {
    map,
    domains: Object.keys(map).length,
    clients: clientSet.size,
  };
  cache.set(key, { ts: Date.now(), data });
  return data;
}
