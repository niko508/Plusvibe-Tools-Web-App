// Campaign settings that can be changed in bulk.
//
// Each setting is a field on PATCH /campaign/update/campaign. The API writes
// toggles as "yes"/"no" but reads them back from /campaign/list-all as 0/1
// (sometimes "yes"/"no" or true/false), so reading goes through readValue()
// and every comparison is made on the normalised form. Pure module: the
// catalogue, validation, the per-campaign diff and the read-back check, with
// no API calls, so all of it is unit-tested.

export type SettingKind = "toggle" | "choice" | "number";

export interface SettingSpec {
  key: string;
  label: string;
  /** What "On" means, in the words of the Plusvibe campaign screen. */
  hint: string;
  kind: SettingKind;
  /** For "choice": the allowed values with their labels. */
  choices?: { value: string; label: string }[];
  /** For "number": the smallest allowed value. */
  min?: number;
  /** For "number": a hint on units. */
  unit?: string;
}

export const SETTINGS: SettingSpec[] = [
  { key: "is_esp_match", label: "ESP matching", hint: "Match the sender's provider with the recipient's (Google to Google, Microsoft to Microsoft).", kind: "toggle" },
  { key: "stop_on_lead_replied", label: "Stop on reply", hint: "Stop sending to a lead once they reply.", kind: "toggle" },
  { key: "exclude_ooo", label: "Continue after out-of-office replies", hint: "An auto-reply doesn't count as a reply; sending continues.", kind: "toggle" },
  { key: "is_acc_based_sending", label: "Stop the whole domain on reply", hint: "One reply stops sending to everyone at that company.", kind: "toggle" },
  { key: "is_emailopened_tracking", label: "Open tracking", hint: "Track opens with a tracking pixel.", kind: "toggle" },
  { key: "is_unsubscribed_link", label: "Unsubscribe link", hint: "Add an unsubscribe link to emails.", kind: "toggle" },
  { key: "unsub_blocklist", label: "Add unsubscribes to the blocklist", hint: "Unsubscribed leads go on the workspace blocklist.", kind: "toggle" },
  { key: "send_as_txt", label: "Send as plain text", hint: "Send text-only emails, no HTML.", kind: "toggle" },
  { key: "send_risky_email", label: "Send to risky emails", hint: "Send to leads whose email is marked risky.", kind: "toggle" },
  { key: "send_seg_email", label: "Send to SEG emails", hint: "Send to leads behind a secure email gateway.", kind: "toggle" },
  { key: "is_pause_on_bouncerate", label: "Pause on high bounce rate", hint: "Pause the campaign when bounces pass the limit.", kind: "toggle" },
  { key: "bounce_rate_limit", label: "Bounce rate limit", hint: "The bounce percentage that pauses the campaign.", kind: "number", min: 0, unit: "%" },
  { key: "other_email_acc", label: "Fallback sending", hint: "Send from other accounts when an account is removed.", kind: "toggle" },
  { key: "is_max_lead_domain_per_day", label: "Cap leads per domain per day", hint: "Limit how many leads at one company are contacted per day.", kind: "toggle" },
  { key: "max_lead_domain_per_day", label: "Max leads per domain per day", hint: "The cap, when the cap is on.", kind: "number", min: 1 },
  {
    key: "var_sel_type",
    label: "Follow-up variation selection",
    hint: "How variations are picked for steps after step 1.",
    kind: "choice",
    choices: [
      { value: "R_ROBIN", label: "Round robin" },
      { value: "INIT_STEP_VAR", label: "Match initial variation" },
    ],
  },
  { key: "opportunity_val", label: "Opportunity value", hint: "Dollar value per positive reply.", kind: "number", min: 0, unit: "$" },
];

export function specFor(key: string): SettingSpec | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/** One requested change: a setting and the value it should have. */
export interface SettingChange {
  key: string;
  /** "yes"/"no" for toggles, a choice value, or a number. */
  value: string | number;
}

/**
 * Normalises whatever the API reports for a setting to the write form —
 * "yes"/"no" for toggles, the raw string for choices, a number for numbers.
 * Null when the campaign doesn't report it (or reports garbage).
 */
export function readValue(spec: SettingSpec, raw: unknown): string | number | null {
  if (raw === undefined || raw === null) return null;
  if (spec.kind === "toggle") {
    if (raw === true || raw === 1 || raw === "1") return "yes";
    if (raw === false || raw === 0 || raw === "0") return "no";
    const s = String(raw).trim().toLowerCase();
    if (s === "yes" || s === "true") return "yes";
    if (s === "no" || s === "false") return "no";
    return null;
  }
  if (spec.kind === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? n : null;
  }
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/** Problems with one requested change. Empty when fine. */
export function validateChange(c: SettingChange): string[] {
  const spec = specFor(c.key);
  if (!spec) return [`"${c.key}" is not a setting this tool can change.`];
  if (spec.kind === "toggle") {
    return c.value === "yes" || c.value === "no" ? [] : [`${spec.label}: choose On or Off.`];
  }
  if (spec.kind === "choice") {
    return spec.choices?.some((o) => o.value === c.value) ? [] : [`${spec.label}: pick one of the options.`];
  }
  // Number("") is 0, so a blank field has to be caught before converting.
  const n = typeof c.value === "number" ? c.value : String(c.value).trim() === "" ? NaN : Number(c.value);
  if (!Number.isFinite(n)) return [`${spec.label}: enter a number.`];
  if (spec.min !== undefined && n < spec.min) return [`${spec.label}: must be at least ${spec.min}.`];
  return [];
}

export interface ChangesResult {
  /** Cleaned changes, one per setting, in catalogue order. */
  changes: SettingChange[];
  problems: string[];
}

/** Validates a batch: unknown keys and bad values are reported; a setting named twice keeps the last. */
export function prepareChanges(inputs: SettingChange[]): ChangesResult {
  const problems: string[] = [];
  const byKey = new Map<string, SettingChange>();
  for (const c of inputs) {
    const p = validateChange(c);
    if (p.length > 0) {
      problems.push(...p);
      continue;
    }
    const spec = specFor(c.key) as SettingSpec;
    byKey.set(c.key, { key: c.key, value: spec.kind === "number" ? Number(c.value) : String(c.value) });
  }
  const changes = SETTINGS.filter((s) => byKey.has(s.key)).map((s) => byKey.get(s.key) as SettingChange);
  return { changes, problems };
}

/**
 * The changes a campaign actually needs: those whose current value differs
 * from the wanted one. A setting the campaign doesn't report is treated as
 * needing the write — better one harmless write than a silent skip.
 */
export function diffCampaign(changes: SettingChange[], raw: Record<string, unknown>): SettingChange[] {
  return changes.filter((c) => {
    const spec = specFor(c.key);
    if (!spec) return false;
    const current = readValue(spec, raw[c.key]);
    return current === null || current !== c.value;
  });
}

/** The PATCH body for a set of changes. */
export function patchBody(workspaceId: string, campaignId: string, changes: SettingChange[]): Record<string, unknown> {
  const body: Record<string, unknown> = { workspace_id: workspaceId, campaign_id: campaignId };
  for (const c of changes) body[c.key] = c.value;
  return body;
}

/** After a write: the changes that did NOT read back as wanted. */
export function unverified(changes: SettingChange[], raw: Record<string, unknown>): SettingChange[] {
  return diffCampaign(changes, raw);
}

/** "ESP matching → On, Stop on reply → Off" */
export function describeChanges(changes: SettingChange[]): string {
  return changes
    .map((c) => {
      const spec = specFor(c.key);
      if (!spec) return c.key;
      const v =
        spec.kind === "toggle"
          ? c.value === "yes" ? "On" : "Off"
          : spec.kind === "choice"
            ? spec.choices?.find((o) => o.value === c.value)?.label ?? String(c.value)
            : `${spec.unit === "$" ? "$" : ""}${c.value}${spec.unit === "%" ? "%" : ""}`;
      return `${spec.label} → ${v}`;
    })
    .join(", ");
}

/** Statuses the job touches: live campaigns only. */
export const IN_SCOPE_STATUSES = new Set(["ACTIVE"]);
