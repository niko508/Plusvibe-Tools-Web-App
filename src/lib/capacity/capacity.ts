// Sending Capacity: how much this account could send in a day, per workspace
// and all told.
//
// An inbox's capacity depends on what it runs on, and that is decided the same
// way Start Outreach decides it — by the DOMAIN the inbox sits on, and for
// Microsoft by how many mailboxes share that domain. One definition of "Azure
// 25" across the app: if the two ever disagreed, the number planned for and
// the number sent would quietly differ.
//
// Pure module — no API calls — so all of it is unit-tested.

import { domainOf } from "@/lib/campaign-types/esp";
import { CATEGORIES, categoryOf, type Category } from "@/lib/start-outreach/categories";
import { generalSettings, isExcludedWorkspace } from "@/lib/general-settings/settings";

/**
 * Emails per inbox per day.
 *
 * A Google seat carries far more than an Azure one, and a 50-seat Azure domain
 * is run slower per mailbox than a 25 — the whole point of telling them apart.
 */
export const DAILY_PER_INBOX: Record<Category, number> = {
  // Read from General Settings (Sending capacity) each time.
  get google() {
    return generalSettings().capacity.google;
  },
  get azure50() {
    return generalSettings().capacity.azure50;
  },
  get azure25() {
    return generalSettings().capacity.azure25;
  },
};

/**
 * Workspaces that are never counted.
 *
 * Neither sends to prospects: one is a nursery for warming inboxes and the
 * other a duplicate kept for reference, so counting either would inflate the
 * number this tool exists to give.
 */
export const excludedWorkspaces = (): string[] => generalSettings().workspaces.excluded;

/** The list lives in General Settings (Workspaces); case and padding don't matter. */
export const isExcluded = isExcludedWorkspace;

/** The order the columns read in, Google first. */
export const CAPACITY_ORDER: Category[] = ["google", "azure50", "azure25"];

export const COLUMN_LABELS: Record<Category, string> = {
  google: "Google Inboxes",
  azure50: "Azure 50 Inboxes",
  azure25: "Azure 25 Inboxes",
};

// --- Counting a workspace ----------------------------------------------------

export interface InboxLike {
  email: string;
  /** Plusvibe's provider key, e.g. GOOGLE_WORKSPACE. */
  provider?: string;
}

export type CategoryCounts = Record<Category, number>;

export function emptyCounts(): CategoryCounts {
  return { google: 0, azure50: 0, azure25: 0 };
}

export interface WorkspaceCapacity {
  workspaceId: string;
  workspaceName: string;
  /** Inboxes in each category. */
  counts: CategoryCounts;
  /** Inboxes on a domain that is on neither provider — no capacity given. */
  uncategorized: number;
  /** Every inbox the workspace holds, counted or not. */
  inboxes: number;
  /** Emails a day, by provider and in total. */
  google: number;
  microsoft: number;
  total: number;
}

/**
 * One workspace's inboxes, counted by what they run on.
 *
 * Every inbox is counted, not only the ones sending today: this is a capacity
 * figure — what the infrastructure could carry — and a mailbox paused for a
 * week is still a mailbox that was paid for. Inboxes whose domain is on
 * neither provider are counted apart rather than given a rate they have no
 * basis for.
 */
export function capacityOf(
  ws: { workspaceId: string; workspaceName: string },
  inboxes: InboxLike[]
): WorkspaceCapacity {
  // Grouped by domain first, because the Azure split is a property of the
  // domain — how many mailboxes share it — not of any one inbox.
  const byDomain = new Map<string, InboxLike[]>();
  let noDomain = 0;
  for (const i of inboxes) {
    const domain = domainOf(i.email);
    if (!domain) {
      noDomain += 1;
      continue;
    }
    const list = byDomain.get(domain);
    if (list) list.push(i);
    else byDomain.set(domain, [i]);
  }

  const counts = emptyCounts();
  let uncategorized = noDomain;
  for (const list of byDomain.values()) {
    const providers = new Map<string, number>();
    for (const i of list) {
      const key = String(i.provider ?? "");
      providers.set(key, (providers.get(key) ?? 0) + 1);
    }
    const category = categoryOf([...providers.entries()], list.length);
    if (category) counts[category] += list.length;
    else uncategorized += list.length;
  }

  return { ...ws, counts, uncategorized, inboxes: inboxes.length, ...capacityFrom(counts) };
}

/** Emails a day from a set of counts, split the way the table reads. */
export function capacityFrom(counts: CategoryCounts): {
  google: number;
  microsoft: number;
  total: number;
} {
  const google = counts.google * DAILY_PER_INBOX.google;
  const microsoft = counts.azure50 * DAILY_PER_INBOX.azure50 + counts.azure25 * DAILY_PER_INBOX.azure25;
  return { google, microsoft, total: google + microsoft };
}

// --- Adding them up ----------------------------------------------------------

/**
 * The overview, in the same shape as a row.
 *
 * `counts` stays nested rather than spread alongside the capacities: a flat
 * shape would have `google` meaning both "Google inboxes" and "Google emails
 * a day", and the two are three orders of magnitude apart.
 */
export interface CapacityTotals {
  workspaces: number;
  inboxes: number;
  counts: CategoryCounts;
  uncategorized: number;
  /** Emails a day. */
  google: number;
  microsoft: number;
  total: number;
}

export function totalsOf(rows: WorkspaceCapacity[]): CapacityTotals {
  const counts = emptyCounts();
  let inboxes = 0;
  let uncategorized = 0;
  for (const r of rows) {
    for (const c of CATEGORIES) counts[c] += r.counts[c];
    inboxes += r.inboxes;
    uncategorized += r.uncategorized;
  }
  return {
    counts,
    workspaces: rows.length,
    inboxes,
    uncategorized,
    ...capacityFrom(counts),
  };
}

/** Biggest sender first — the table is read to find where the capacity is. */
export function sortRows(rows: WorkspaceCapacity[]): WorkspaceCapacity[] {
  return [...rows].sort((a, b) => b.total - a.total || a.workspaceName.localeCompare(b.workspaceName));
}

// --- What comes out ----------------------------------------------------------

/** "Google 13 · Azure 50 3 · Azure 25 5 emails per inbox per day" */
export function describeRates(): string {
  return `${CAPACITY_ORDER.map((c) => `${COLUMN_LABELS[c]} ${DAILY_PER_INBOX[c]}`).join(" · ")} emails per inbox per day`;
}

export const CSV_HEADERS = [
  "workspace",
  "google_inboxes",
  "azure_50_inboxes",
  "azure_25_inboxes",
  "google_capacity",
  "microsoft_capacity",
  "total_capacity",
];

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "sending-capacity-2026-09-21.csv" */
export function csvNameFor(at: Date): string {
  return `sending-capacity-${at.toISOString().slice(0, 10)}.csv`;
}

export function toCsv(rows: WorkspaceCapacity[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.workspaceName, r.counts.google, r.counts.azure50, r.counts.azure25, r.google, r.microsoft, r.total]
        .map(cell)
        .join(",")
    );
  }
  // A totals row, so the file answers the same question the overview does.
  const t = totalsOf(rows);
  lines.push(
    ["All workspaces", t.counts.google, t.counts.azure50, t.counts.azure25, t.google, t.microsoft, t.total]
      .map(cell)
      .join(",")
  );
  return lines.join("\n");
}
