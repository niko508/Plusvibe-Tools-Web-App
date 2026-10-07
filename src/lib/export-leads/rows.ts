// Export Not Contacted Leads: a campaign's leads as CSV rows, and several
// campaigns' rows combined into one file — for re-running them in Clay.
//
// A lead comes back from /lead/workspace-leads with its own fields, the
// workspace's custom variables (as extra keys, or nested in
// custom_variables), and the campaign's bookkeeping. The bookkeeping (ids,
// send counters, status, timestamps) is left out; everything else becomes a
// column. One row per email by default: a lead in two campaigns is one row,
// both campaigns named, its fields taken from the first and gaps filled from
// the rest.
//
// Pure module — no API — so all of it is unit-tested.

/** Per-campaign bookkeeping, never a column. */
const SKIP = new Set([
  "_id",
  "id",
  "organization_id",
  "campaign_id",
  "workspace_id",
  "email_account_id",
  "email_acc_name",
  "camp_name",
  "status",
  "label",
  "is_completed",
  "current_step",
  "sent_step",
  "total_steps",
  "replied_count",
  "opened_count",
  "last_sent_at",
  "created_at",
  "modified_at",
  "bounce_msg",
  "is_mx",
  "mx",
  "seg",
  "__v",
]);

/** The usual lead fields, in this order at the front of the file. */
export const STANDARD_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "company_name",
  "company_website",
  "job_title",
  "department",
  "industry",
  "phone_number",
  "linkedin_person_url",
  "linkedin_company_url",
  "address_line",
  "city",
  "state",
  "country",
  "country_code",
  "notes",
];

export const CAMPAIGN_COLUMN = "campaign";

export type LeadRow = Record<string, string>;

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? "" : String(v));

/** One lead as a flat row: its fields and custom variables, no bookkeeping. */
export function flattenLead(raw: Record<string, unknown>): LeadRow {
  const row: LeadRow = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SKIP.has(key)) continue;
    if (key === "custom_variables") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!(k in row) || row[k] === "") row[k] = text(v);
        }
      }
      continue;
    }
    if (value !== null && typeof value === "object") continue;
    row[key] = text(value);
  }
  if (row.email !== undefined) row.email = row.email.trim();
  return row;
}

export interface CampaignLeads {
  campaignName: string;
  rows: LeadRow[];
}

/**
 * Every campaign's rows in one list, each with its campaign. With `onePerEmail`
 * a lead in several campaigns is one row: fields from the first campaign it is
 * in, empty ones filled from the later, and every campaign named, " | " apart.
 */
export function combineLeads(campaigns: CampaignLeads[], onePerEmail: boolean): { rows: LeadRow[]; merged: number } {
  const out: LeadRow[] = [];
  const byEmail = new Map<string, LeadRow>();
  let merged = 0;
  for (const c of campaigns) {
    for (const r of c.rows) {
      const key = (r.email ?? "").trim().toLowerCase();
      const had = onePerEmail && key ? byEmail.get(key) : undefined;
      if (had) {
        merged += 1;
        for (const [k, v] of Object.entries(r)) if (!had[k] && v) had[k] = v;
        const names = had[CAMPAIGN_COLUMN].split(" | ");
        if (!names.includes(c.campaignName)) had[CAMPAIGN_COLUMN] = [...names, c.campaignName].join(" | ");
        continue;
      }
      const row = { ...r, [CAMPAIGN_COLUMN]: c.campaignName };
      out.push(row);
      if (onePerEmail && key) byEmail.set(key, row);
    }
  }
  return { rows: out, merged };
}

/** The file's columns: the usual fields first, then every other one as first seen, the campaign last. */
export function columnsOf(rows: LeadRow[]): string[] {
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (!STANDARD_COLUMNS.includes(k) && k !== CAMPAIGN_COLUMN) extra.push(k);
    }
  }
  return [...STANDARD_COLUMNS.filter((k) => seen.has(k)), ...extra, ...(seen.has(CAMPAIGN_COLUMN) ? [CAMPAIGN_COLUMN] : [])];
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The rows as CSV, header first, CRLF line ends. */
export function toCsv(rows: LeadRow[], columns: string[] = columnsOf(rows)): string {
  const lines = [columns.map(cell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c] ?? "")).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** "not-contacted-leads-acme-2026-10-07.csv" */
export function fileName(workspaceName: string, day: string): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  return `not-contacted-leads-${slug}-${day}.csv`;
}
