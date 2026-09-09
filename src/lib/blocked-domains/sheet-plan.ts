// Working out what to write to the Email Infrastructure sheet for a blocked
// domain, without doing any writing.
//
// Two paths, by what kind of mailboxes the domain runs on.
//
// Microsoft (and anything that isn't Google):
//   📋 Domains             the domain's row → Status = "Not Active"
//   🚯 Tenants to Cancel   a new row → Tenant, Tenant / Inbox Source
//
// Google Workspace has no tenant to cancel — each inbox is its own seat — so:
//   🛑 Google Inboxes to Cancel  one row per burned inbox → Email Address,
//                                Tenant / Inbox Source
//   📋 Domains             Status = "Not Active" only once EVERY inbox on the
//                          domain is burned; until then the row is left alone
//
// All of it is planned here from the grids, so the exact cells and row
// contents are unit-testable and a missing column is reported rather than
// guessed at.

import { normalizeDomain } from "@/lib/blocked-domains/domain";
import { dominantProvider, type ProviderCounts } from "@/lib/plusvibe-providers";

/** The status a blocked domain's row is set to. */
export const BLOCKED_STATUS = "Not Active";

/** Where the domain was bought — Porkbun, Spaceship, and so on. */
export const COL_DOMAIN_HOST = "Domain Host";

export const CANCEL_TAB = "🚯 Tenants to Cancel";
export const COL_CANCEL_TENANT = "Tenant";
export const COL_CANCEL_SOURCE = "Tenant / Inbox Source";

export const GOOGLE_CANCEL_TAB = "🛑 Google Inboxes to Cancel";
export const COL_GOOGLE_EMAIL = "Email Address";

/**
 * Whether a domain is handled on the Google path.
 *
 * Decided by the provider most of its inboxes are on, so one stray mailbox
 * of the other kind doesn't flip a whole domain onto the wrong list. A record
 * from before providers were captured has no counts and takes the tenant
 * path, as it always did.
 */
export function isGoogleDomain(providers: ProviderCounts | undefined): boolean {
  return !!providers && dominantProvider(providers) === "google";
}

/** Case-insensitive header lookup, tolerant of stray padding. */
export function headerIndex(header: string[], name: string): number {
  const want = name.trim().toLowerCase();
  return header.findIndex((h) => String(h ?? "").trim().toLowerCase() === want);
}

export interface DomainsRowLookup {
  /** 1-based sheet row, ready for A1 notation. */
  rowNumber: number;
  currentStatus: string;
  tenantEmail: string;
  tenantSource: string;
  client: string;
  /** The registrar the domain sits with, when the sheet says. */
  domainHost: string;
}

/**
 * Finds a domain's row in the 📋 Domains grid.
 *
 * Returns every field the rest of the run needs — the status cell to change,
 * the tenant to cancel, and the client, which is the best hint at which
 * Plusvibe workspace the inboxes live in.
 *
 * The first matching row wins. A domain listed twice is a sheet problem, and
 * the count is reported so it can be noticed rather than silently half-handled.
 */
export function findDomainRow(
  grid: string[][],
  domain: string,
  cols: {
    domain: number;
    status: number;
    tenantEmail: number;
    tenantSource: number;
    client: number;
    /** Optional: older callers don't ask for it. */
    domainHost?: number;
  }
): { row: DomainsRowLookup | null; matches: number } {
  const wanted = normalizeDomain(domain);
  if (!wanted) return { row: null, matches: 0 };

  let found: DomainsRowLookup | null = null;
  let matches = 0;
  const cell = (r: string[], i: number) =>
    i >= 0 ? String(r[i] ?? "").trim() : "";

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    if (normalizeDomain(cell(row, cols.domain)) !== wanted) continue;
    matches++;
    if (found) continue;
    found = {
      rowNumber: r + 1,
      currentStatus: cell(row, cols.status),
      tenantEmail: cell(row, cols.tenantEmail),
      tenantSource: cell(row, cols.tenantSource),
      client: cell(row, cols.client),
      domainHost: cell(row, cols.domainHost ?? -1),
    };
  }
  return { row: found, matches };
}

/**
 * Whether the tenant is already queued for cancellation.
 *
 * The tab is append-only, so without this a second blocked domain on the same
 * tenant would queue it twice.
 */
export function tenantAlreadyQueued(
  grid: string[][],
  tenantColumn: number,
  tenantEmail: string
): boolean {
  return alreadyListed(grid, tenantColumn, tenantEmail);
}

/** Whether a value already appears in a column, ignoring case and padding. */
export function alreadyListed(grid: string[][], column: number, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (!wanted || column < 0) return false;
  for (let r = 1; r < grid.length; r++) {
    const v = String(grid[r]?.[column] ?? "").trim().toLowerCase();
    if (v && v === wanted) return true;
  }
  return false;
}

/**
 * Builds the row to append to 🛑 Google Inboxes to Cancel, sized to the tab's
 * own header for the same reason as the tenant row.
 */
export function buildGoogleCancelRow(
  header: string[],
  values: { email: string; source: string }
): string[] {
  const width = Math.max(header.length, 1);
  const row = new Array<string>(width).fill("");
  const iEmail = headerIndex(header, COL_GOOGLE_EMAIL);
  const iSource = headerIndex(header, COL_CANCEL_SOURCE);
  if (iEmail >= 0) row[iEmail] = values.email;
  if (iSource >= 0) row[iSource] = values.source;
  return row;
}

/**
 * Which burned inboxes still need a row: the ones not already on the tab.
 *
 * The tab is append-only and a domain is checked again every week, so this is
 * what keeps a mailbox from being listed once per check.
 */
export function googleInboxesToQueue(
  grid: string[][],
  emailColumn: number,
  burned: string[]
): { toQueue: string[]; alreadyQueued: string[] } {
  const toQueue: string[] = [];
  const alreadyQueued: string[] = [];
  const seen = new Set<string>();
  for (const raw of burned) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    (alreadyListed(grid, emailColumn, email) ? alreadyQueued : toQueue).push(email);
  }
  return { toQueue, alreadyQueued };
}

/**
 * Builds the row to append to 🚯 Tenants to Cancel.
 *
 * Sized to the tab's own header so the two values land under their real
 * columns even if more are added later, and so a column order change doesn't
 * silently write the tenant into the wrong place.
 */
export function buildCancelRow(
  header: string[],
  values: { tenant: string; source: string }
): string[] {
  const width = Math.max(header.length, 1);
  const row = new Array<string>(width).fill("");
  const iTenant = headerIndex(header, COL_CANCEL_TENANT);
  const iSource = headerIndex(header, COL_CANCEL_SOURCE);
  if (iTenant >= 0) row[iTenant] = values.tenant;
  if (iSource >= 0) row[iSource] = values.source;
  return row;
}

/**
 * Matches the sheet's Client value to a Plusvibe workspace name.
 *
 * The sheet doesn't always carry a client, and the names don't always match a
 * workspace exactly, so this is a hint that saves scanning every workspace —
 * never a substitute for confirming the domain's inboxes are actually there.
 */
export function matchWorkspaceByClient(
  client: string,
  workspaces: Array<{ _id: string; name: string }>
): string | null {
  const key = client.trim().toLowerCase();
  if (!key) return null;
  const exact = workspaces.find((w) => w.name.trim().toLowerCase() === key);
  if (exact) return exact._id;
  // A looser pass, for "Acme" vs "Acme Ltd" style drift. Only when exactly one
  // workspace contains the name — two candidates is not a hint worth acting on.
  const loose = workspaces.filter((w) => {
    const n = w.name.trim().toLowerCase();
    return n.includes(key) || key.includes(n);
  });
  return loose.length === 1 ? loose[0]._id : null;
}
