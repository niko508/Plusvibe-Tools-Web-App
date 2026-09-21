// Planning "Remove Inboxes & Domains": what to write to the Email
// Infrastructure sheet, and which Plusvibe inboxes to delete.
//
// Two paths, by provider, because the two are recorded in different places.
//
// Microsoft — a burned row is a DOMAIN, and a domain is a tenant we pay for:
//   📋 Domains             the domain's row → Status = "Not Active"
//   🚯 Tenants to Cancel   its Tenant Email Address, with the
//                          Tenant / Inbox Source read from the same row
//   Plusvibe               every Microsoft inbox on that domain, deleted
//
// Google — a burned row is a single INBOX, and each Google mailbox is its own
// seat, so there is no tenant to cancel:
//   🛑 Google Inboxes to Cancel   the address, source left blank for now
//   Plusvibe                      that one inbox, deleted
//   📋 Domains                    left alone: the domain's other mailboxes
//                                 may well still be fine
//
// The sheet is written FIRST and the deletion follows, so nothing is removed
// from Plusvibe before the record of what to cancel exists. A row whose sheet
// step failed is deliberately left alone in Plusvibe: deleting inboxes whose
// tenant was never queued loses both the mailboxes and the trail to the
// subscription still being paid for.
//
// Pure module — no API calls, no sheet writes — so all of it is unit-tested.

import { domainOfEmail, inboxIsOnDomain } from "@/lib/blocked-domains/domain";
import {
  headerIndex,
  type GoogleTabWrite,
} from "@/lib/blocked-domains/sheet-plan";
import { bucketOf } from "@/lib/plusvibe-providers";
import type { Esp } from "./settings";
import type { ScanRow } from "./scan";

/** The status a removed domain's row is set to. */
export const REMOVED_STATUS = "Not Active";

/** One burned row, reduced to what the removal needs. */
export interface RemovalTarget {
  workspaceId: string;
  workspaceName: string;
  /** The domain for Microsoft, the inbox address for Google. */
  name: string;
  /** The sending domain either way. */
  domain: string;
}

/**
 * The burned rows to act on, in the order the run will take them.
 *
 * Only "burned" — a row the Reply % rescue saved, one with too few sends and
 * one with no figures at all are all rows this tool declined to judge against
 * the bar, and none of them is a thing to delete.
 *
 * Grouped by workspace so the run lists each workspace's inboxes once, and
 * deduplicated because the same domain can be judged in two workspaces and
 * must not be queued for cancellation twice.
 */
export function targetsFrom(rows: ScanRow[]): RemovalTarget[] {
  const out: RemovalTarget[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.verdict !== "burned") continue;
    const name = r.name.trim().toLowerCase();
    if (!name) continue;
    const key = `${r.workspaceId}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName,
      name,
      domain: (r.domain || "").trim().toLowerCase(),
    });
  }
  out.sort(
    (a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.name.localeCompare(b.name)
  );
  return out;
}

/** Every distinct domain among the targets, for the Microsoft sheet step. */
export function domainsOf(targets: RemovalTarget[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    const d = t.domain || domainOfEmail(t.name) || "";
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

// --- 📋 Domains -------------------------------------------------------------

/** What the Domains tab said about one domain, and what was done to it. */
export interface DomainLookup {
  domain: string;
  /** 1-based sheet row, when the domain was found. */
  rowNumber?: number;
  /** How many rows carry this domain — more than one is a sheet problem. */
  matches: number;
  status: string;
  tenantEmail: string;
  tenantSource: string;
  /** Already "Not Active" before this run, so its cell is left as it is. */
  statusAlready?: boolean;
  problem?: string;
}

export interface DomainsPlan {
  lookups: DomainLookup[];
  /** Status cells to set. 1-based row, 0-based column. */
  updates: GoogleTabWrite[];
  /** A problem with the tab itself rather than with one domain. */
  problem?: string;
}

/**
 * Finds each domain in 📋 Domains and plans its Status cell.
 *
 * The whole tab is read once and every domain is looked up in the same pass:
 * a scan can turn up a hundred burned domains, and a read per domain would
 * spend the Sheets quota to learn the same grid a hundred times.
 *
 * A domain that isn't in the tab is not an error to stop on — it is reported
 * against that row, and that row's inboxes are then left alone in Plusvibe.
 */
export function planDomainsTab(
  grid: string[][],
  domains: string[],
  cols: { domain: string; status: string; tenantEmail: string; tenantSource: string },
  tabName: string
): DomainsPlan {
  const header = grid[0] ?? [];
  const iDomain = headerIndex(header, cols.domain);
  const iStatus = headerIndex(header, cols.status);
  const iTenant = headerIndex(header, cols.tenantEmail);
  const iSource = headerIndex(header, cols.tenantSource);

  const plan: DomainsPlan = { lookups: [], updates: [] };
  if (iDomain < 0) {
    plan.problem = `The "${tabName}" tab has no ${cols.domain} column, so no domains could be found in it.`;
    return plan;
  }

  // One pass over the grid, into a map, rather than a scan per domain.
  const rowsByDomain = new Map<string, number[]>();
  for (let r = 1; r < grid.length; r++) {
    const d = String(grid[r]?.[iDomain] ?? "").trim().toLowerCase();
    if (!d) continue;
    const list = rowsByDomain.get(d);
    if (list) list.push(r + 1);
    else rowsByDomain.set(d, [r + 1]);
  }

  const cell = (rowNumber: number, i: number) =>
    i >= 0 ? String(grid[rowNumber - 1]?.[i] ?? "").trim() : "";

  for (const domain of domains) {
    const hits = rowsByDomain.get(domain) ?? [];
    if (hits.length === 0) {
      plan.lookups.push({
        domain,
        matches: 0,
        status: "",
        tenantEmail: "",
        tenantSource: "",
        problem: `${domain} isn't in the "${tabName}" tab, so nothing was updated there and its inboxes were left alone.`,
      });
      continue;
    }
    const rowNumber = hits[0];
    const status = cell(rowNumber, iStatus);
    const lookup: DomainLookup = {
      domain,
      rowNumber,
      matches: hits.length,
      status,
      tenantEmail: cell(rowNumber, iTenant),
      tenantSource: cell(rowNumber, iSource),
    };
    if (iStatus < 0) {
      lookup.problem = `The "${tabName}" tab has no ${cols.status} column, so the status was left as it was.`;
    } else if (status.toLowerCase() === REMOVED_STATUS.toLowerCase()) {
      lookup.statusAlready = true;
    } else {
      plan.updates.push({ row: rowNumber, column: iStatus, value: REMOVED_STATUS });
    }
    plan.lookups.push(lookup);
  }
  return plan;
}

/**
 * The tenants to queue, in sheet order and without repeats.
 *
 * Several burned domains often sit on one tenant, and cancelling it once is
 * the whole point — so the first domain that names a tenant carries it, and
 * the rest record that it was already accounted for. That first domain is
 * also the one written into the tab's Domain column.
 */
export function tenantsToQueue(
  lookups: DomainLookup[]
): { entries: { key: string; source: string; domain: string }[]; missing: string[] } {
  const entries: { key: string; source: string; domain: string }[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const l of lookups) {
    if (!l.rowNumber) continue;
    const tenant = l.tenantEmail.trim();
    if (!tenant) {
      missing.push(l.domain);
      continue;
    }
    const key = tenant.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // The domain is the one whose row named this tenant — the whole point of
    // the column is to say what sent it to the cancellation list.
    entries.push({ key: tenant, source: l.tenantSource, domain: l.domain });
  }
  return { entries, missing };
}

// --- Plusvibe ---------------------------------------------------------------

export interface InboxLike {
  id: string;
  email: string;
  provider?: string;
}

/**
 * Which of a workspace's inboxes a target means.
 *
 * Microsoft takes every mailbox on the domain; Google takes the one address.
 * Both are filtered to the provider that was scanned, so a burned Microsoft
 * domain that happens to share a name with a Google mailbox can never take
 * the Google one with it — the scan never judged it, and deleting it would be
 * acting on evidence that was never gathered.
 */
export function inboxesFor<T extends InboxLike>(
  target: RemovalTarget,
  inboxes: T[],
  esp: Esp
): T[] {
  const onEsp = inboxes.filter((i) => bucketOf(i.provider) === esp);
  if (esp === "google") {
    return onEsp.filter((i) => i.email.trim().toLowerCase() === target.name);
  }
  return onEsp.filter((i) => inboxIsOnDomain(i.email, target.domain || target.name));
}

/** "3 inboxes", "1 inbox" — plain enough for a progress line. */
export function inboxCount(n: number): string {
  return `${n.toLocaleString()} inbox${n === 1 ? "" : "es"}`;
}

// --- What the run reports ----------------------------------------------------

export type TargetState =
  /** Not reached yet. */
  | "pending"
  /** The sheet is written and Plusvibe is next. */
  | "queued"
  /** Its inboxes are being deleted. */
  | "deleting"
  /** Sheet written, inboxes gone. */
  | "done"
  /** Left alone on purpose — the sheet step could not record it. */
  | "skipped"
  /** Something failed. */
  | "error";

export interface TargetResult {
  workspaceId: string;
  workspaceName: string;
  name: string;
  domain: string;
  state: TargetState;
  /** Microsoft only: the tenant this domain's row named. */
  tenant?: string;
  /** The tenant was already on 🚯 Tenants to Cancel before this run. */
  tenantAlready?: true;
  /** The address was already on 🛑 Google Inboxes to Cancel. */
  listedAlready?: true;
  /** Its row in 📋 Domains was already "Not Active". */
  statusAlready?: true;
  /** Inboxes found in Plusvibe, and how many were deleted. */
  inboxesFound: number;
  inboxesDeleted: number;
  note?: string;
}

/** A one-line summary of what a finished run did. */
export function describeRun(rows: TargetResult[], esp: Esp): string {
  const done = rows.filter((r) => r.state === "done").length;
  const skipped = rows.filter((r) => r.state === "skipped").length;
  const failed = rows.filter((r) => r.state === "error").length;
  const deleted = rows.reduce((n, r) => n + r.inboxesDeleted, 0);
  const noun = esp === "google" ? "inbox" : "domain";
  const parts = [
    `${done.toLocaleString()} ${noun}${done === 1 ? "" : "s"} handled`,
    `${inboxCount(deleted)} deleted`,
  ];
  if (skipped > 0) parts.push(`${skipped.toLocaleString()} left alone`);
  if (failed > 0) parts.push(`${failed.toLocaleString()} failed`);
  return parts.join(" · ");
}
