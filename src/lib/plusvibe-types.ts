// Shared Plusvibe API types used on both the server (proxy routes) and the
// client (tool UIs). Kept intentionally close to the official API schema at
// https://developer.plusvibe.ai/.

export interface Workspace {
  _id: string;
  name: string;
}

export interface WorkspacesResponse {
  status: string;
  workspaces: Workspace[];
}

export type Provider = "GOOGLE_WORKSPACE" | "MICROSOFT365" | "REGULAR_ACCOUNT";

export interface EmailAccount {
  id: string;
  email: string;
  status?: string;
  warmup_status?: string;
  provider?: string;
  first_name?: string;
  last_name?: string;
  tags?: string[];
  warmup_health?: number; // 7-day overall warmup health (0-100)
}

export interface EmailAccountsResponse {
  accounts: EmailAccount[];
}

export interface EmailStatsHeader {
  total_sent_count: number;
  total_reply_count: number;
  total_ooo_reply_count: number;
  total_open_count: number;
  total_bounce_count: number;
  total_contacted_count: number;
  total_completed_count: number;
  total_pos_reply_count: number;
  bounce_rate: number;
  open_rate: number;
  reply_rate: number;
  reply_rate_with_ooo: number;
  pos_reply_rate: number;
  // The API is inconsistent in naming the unique-contacted denominator across
  // the header (total_unique_contacted_count) and one example
  // (total_new_lead_contacted_count) — accept either.
  total_unique_contacted_count?: number;
  total_new_lead_contacted_count?: number;
}

export interface EmailStatsChartPoint {
  label: string;
  date: string;
  total_sent_count: number;
  total_reply_count: number;
  total_ooo_reply_count: number;
  total_open_count: number;
  total_bounce_count: number;
  total_contacted_count: number;
  total_completed_count: number;
  total_pos_reply_count: number;
}

export interface EmailStatsResponse {
  header: EmailStatsHeader;
  chart: EmailStatsChartPoint[];
}

// --- Campaigns / sequences --------------------------------------------------
// Sequences are embedded on the campaign object: they're read via
// GET /campaign/list-all and written via PATCH /campaign/update/campaign, where
// the `sequences` array REPLACES what's stored. Anything not sent back is lost,
// so every read-modify-write must carry the full array.

/** A single variation as returned by GET /campaign/list-all. */
export interface SequenceVariation {
  variation: string; // "A", "B", … "CZ"
  subject?: string;
  preheader?: string;
  body?: string;
  name?: string; // absent on read, required on write
  /**
   * Any field the API returns that isn't in the documented schema. Kept because
   * the docs are incomplete and a marker distinguishing deleted variations may
   * live here — discarding unknown fields would hide it.
   */
  extra?: Record<string, unknown>;
}

/** A step's existing variation, trimmed for display in the picker. */
export interface ExistingVariation {
  variation: string;
  subject: string;
  preview: string; // plain-text snippet of the body
  chars: number;
  /** Undocumented fields returned alongside this variation, for diagnosis. */
  extra?: Record<string, unknown>;
}

export interface SequenceStep {
  step: number;
  wait_time?: number;
  variations: SequenceVariation[];
}

/** Campaign summary for the picker (sequences stripped to keep it light). */
export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  campaignType?: string;
  /** For a sub-sequence, the parent campaign it belongs to. */
  parentCampId?: string;
  sequenceSteps: number;
}

/** Per-step view used by the UI, including any variants hidden from `sequences`. */
export interface CampaignStepInfo {
  step: number;
  waitTime: number;
  /** Live variations — `sequences` minus anything Plusvibe has deleted. */
  variations: ExistingVariation[];
  /**
   * Labels still returned by `sequences` but marked deleted in variation-stats.
   * Duplicating a campaign or removing steps leaves these behind; writing them
   * back would resurrect them as live copy, so they're dropped.
   */
  deletedVariations: string[];
  /**
   * Labels that variation-stats knows about but `sequences` does not — usually
   * disabled variants. They can't be preserved through a write, so we never
   * reuse their letters and the UI warns about them.
   */
  hiddenVariations: string[];
  subject: string;
}

export interface CampaignDetail {
  id: string;
  name: string;
  status: string;
  campaignType?: string;
  steps: CampaignStepInfo[];
  warnings: string[];
}

export interface ApiError {
  error: string;
  message?: string;
  errors?: string[];
}
