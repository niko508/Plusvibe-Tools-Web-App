import "server-only";

import { plusvibeGet } from "@/lib/plusvibe-server";

// Helpers for moving leads between campaigns.
//
// There is no move endpoint: a move is `POST /lead/add` into the destination
// followed by `POST /lead/delete` from the source (keyed by EMAIL, not id).
// Delete has no per-email result and is assumed irreversible, so the add must
// be verified before anything is deleted.
//
// Leads are taken in `_id` order regardless of status.

const PAGE_LIMIT = 100; // page size is undocumented; 100 matches other endpoints
const MAX_PAGES = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RawLead {
  [key: string]: unknown;
}

// Fields POST /lead/add accepts at the top level. Anything else that carries
// real data has to travel inside custom_variables instead.
const WRITABLE_TOP_LEVEL = new Set([
  "email",
  "first_name",
  "last_name",
  "notes",
  "address_line",
  "city",
  "country",
  "country_code",
  "phone_number",
  "company_name",
  "company_website",
  "linkedin_person_url",
  "linkedin_company_url",
]);

// Per-campaign progress/bookkeeping that must NOT follow a lead to another
// campaign (ids, send counters, status, timestamps).
const METADATA_SKIP = new Set([
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

export interface LeadPayload {
  email: string;
  custom_variables?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Maps a lead read from one campaign into the shape POST /lead/add expects.
 *
 * Two things make this less trivial than a copy: /lead/add accepts a narrower
 * field set than /lead/workspace-leads returns (job_title, department,
 * industry and state are readable but not writable), and workspace custom
 * variables — including opening_line — come back as undocumented extra keys.
 * Both are routed into custom_variables so nothing is silently dropped.
 */
export function leadToPayload(lead: RawLead): LeadPayload {
  const out: LeadPayload = { email: String(lead.email ?? "") };
  const custom: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(lead)) {
    if (value === null || value === undefined || value === "") continue;
    if (METADATA_SKIP.has(key)) continue;
    if (key === "custom_variables") {
      // Already-nested custom variables, if the API ever returns them that way.
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(custom, value as Record<string, unknown>);
      }
      continue;
    }
    if (WRITABLE_TOP_LEVEL.has(key)) {
      if (key !== "email") out[key] = value;
      continue;
    }
    // Readable-but-not-writable standard fields and workspace additional
    // fields both land here.
    if (typeof value === "object") continue; // don't smuggle nested junk
    custom[key] = value;
  }

  if (Object.keys(custom).length > 0) out.custom_variables = custom;
  return out;
}

// The 200 body is documented as an object but described as a list — accept
// either, plus the usual envelope keys.
function asLeadArray(data: unknown): RawLead[] {
  if (Array.isArray(data)) return data as RawLead[];
  if (data && typeof data === "object") {
    for (const key of ["leads", "data", "result", "results", "items"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as RawLead[];
    }
  }
  return [];
}

/** Pages through a campaign's leads, stopping once `max` are collected. */
export async function fetchCampaignLeads(
  apiKey: string,
  workspace_id: string,
  campaign_id: string,
  max: number
): Promise<{ leads: RawLead[]; scanned: number }> {
  const leads: RawLead[] = [];
  let scanned = 0;

  for (let page = 1; page <= MAX_PAGES && leads.length < max; page++) {
    if (page > 1) await sleep(220); // stay under the 5 req/s budget
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/lead/workspace-leads",
      query: {
        workspace_id,
        campaign_id,
        page: String(page),
        limit: String(PAGE_LIMIT),
        sort: "_id",
        direction: "asc",
      },
    });
    const batch = asLeadArray(data);
    scanned += batch.length;
    for (const lead of batch) {
      if (leads.length >= max) break;
      if (!lead.email) continue;
      leads.push(lead);
    }
    if (batch.length < PAGE_LIMIT) break;
  }

  return { leads, scanned };
}

export interface StatusCount {
  status: string;
  count: number;
}

/** Lead counts per status for a campaign, for the pre-flight preview. */
export async function fetchStatusCounts(
  apiKey: string,
  workspace_id: string,
  campaign_id: string
): Promise<StatusCount[]> {
  try {
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/lead/count/lead-status",
      query: { workspace_id, campaign_id },
    });
    const arr = Array.isArray(data)
      ? data
      : asLeadArray(data);
    return arr
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          status: String(row.status ?? "").toUpperCase(),
          count: Number(row.count ?? 0) || 0,
        };
      })
      .filter((r) => r.status);
  } catch {
    return [];
  }
}

/** Total leads on the campaign, summed across every status. */
export function totalCount(counts: StatusCount[]): number {
  return counts.reduce((sum, c) => sum + c.count, 0);
}
