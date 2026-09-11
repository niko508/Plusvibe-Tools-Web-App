// Start Outreach with New Inboxes — what a move does to the inboxes once they
// are in the client workspace: the sending and warmup settings, the signature
// per person, the tags, and the sheet's Client column.
//
// Pure module — no API, no clock — so all of it is unit-tested. The job in
// src/lib/jobs/start-outreach.ts calls these; the page uses the same ones for
// its preview, so what is shown before the run is what the run does.

import type { SignatureFields } from "@/app/tools/add-signatures/types";
import { groupInboxes, type InboxLike } from "@/app/tools/add-signatures/filter";
import type { PersonGroup } from "@/app/tools/add-signatures/types";
import { findPlatformTag, findTldTag, tldOf } from "@/lib/tags/domain-tags";
import type { TagInput } from "@/lib/tags/bulk-tags";
import {
  SHEET_COL_CLIENT,
  SHEET_COL_DOMAIN,
  SHEET_COL_WARMUP_DAYS,
  SHEET_COL_WARMUP_STARTED,
  normalizeDomain,
} from "@/lib/start-outreach/readiness";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The form's raw strings, exactly as typed. Blank means "leave it alone". */
export interface OutreachSettingsInput {
  campaignEmails: string;
  startingEmails: string;
  rampUp: string;
  warmupEmails: string;
  randomize: string;
  warmupReplyRate: string;
  intervalMinutes: string;
}

export const EMPTY_OUTREACH_SETTINGS: OutreachSettingsInput = {
  campaignEmails: "",
  startingEmails: "",
  rampUp: "",
  warmupEmails: "",
  randomize: "",
  warmupReplyRate: "",
  intervalMinutes: "",
};

export type OutreachSettingsKey = keyof OutreachSettingsInput;

export interface OutreachFieldSpec {
  key: OutreachSettingsKey;
  label: string;
  /** The field it becomes on PUT /account/bulk-update. */
  apiField: string;
  unit: string;
  min: number;
  max: number;
  integer: boolean;
}

/** In the order asked for; bounds follow Plusvibe's own. */
export const OUTREACH_FIELDS: OutreachFieldSpec[] = [
  { key: "warmupEmails", label: "Warmup emails", apiField: "warmup_max_daily_limit", unit: "per day", min: 1, max: 1000, integer: true },
  { key: "campaignEmails", label: "Campaign emails", apiField: "daily_limit", unit: "per day", min: 0, max: 2000, integer: true },
  { key: "startingEmails", label: "Starting emails", apiField: "bulk_rampup_daily_limit", unit: "per day", min: 1, max: 2000, integer: true },
  { key: "rampUp", label: "Ramp-up", apiField: "bulk_rampup_daily_inc", unit: "per day", min: 1, max: 2000, integer: true },
  { key: "randomize", label: "Randomized Warm-Up Limit", apiField: "warmup_randomize_num", unit: "%", min: 0, max: 100, integer: true },
  { key: "warmupReplyRate", label: "Warmup reply rate", apiField: "warmup_reply_rate", unit: "%", min: 0, max: 100, integer: false },
  { key: "intervalMinutes", label: "Email interval", apiField: "interval_limit_in_min", unit: "minutes", min: 1, max: 1440, integer: true },
];

/** Always sent: both ramp-ups off, as asked. */
export const FIXED_SETTINGS: Record<string, string> = {
  bulk_is_slow_rampup: "no",
  bulk_warmup_is_slow_rampup: "no",
};

export interface SettingsRow {
  key: string;
  label: string;
  apiField: string;
  value: string;
}

export const FIXED_ROWS: SettingsRow[] = [
  { key: "campaignRampUp", label: "Campaign email ramp-up", apiField: "bulk_is_slow_rampup", value: "Off" },
  { key: "warmupRampUp", label: "Warmup email ramp-up", apiField: "bulk_warmup_is_slow_rampup", value: "Off" },
];

export interface ParsedOutreachSettings {
  values: Partial<Record<OutreachSettingsKey, number>>;
  problems: Partial<Record<OutreachSettingsKey, string>>;
  /** The body to merge into PUT /account/bulk-update — never empty. */
  body: Record<string, string | number>;
  /** One row per field that will be applied, fixed ones last. */
  summary: SettingsRow[];
  ok: boolean;
}

const isBlank = (v: string) => String(v ?? "").trim() === "";

/**
 * Reads the form. Blank fields are left alone on the inbox; anything filled
 * in has to be a number inside its range, and says so by name when it isn't.
 * The two ramp-up switches are always sent off.
 */
export function parseOutreachSettings(input: OutreachSettingsInput): ParsedOutreachSettings {
  const values: Partial<Record<OutreachSettingsKey, number>> = {};
  const problems: Partial<Record<OutreachSettingsKey, string>> = {};
  const body: Record<string, string | number> = {};
  const summary: SettingsRow[] = [];

  for (const f of OUTREACH_FIELDS) {
    const raw = input[f.key] ?? "";
    if (isBlank(raw)) continue;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) {
      problems[f.key] = `${f.label} must be a number.`;
      continue;
    }
    if (f.integer && !Number.isInteger(n)) {
      problems[f.key] = `${f.label} must be a whole number.`;
      continue;
    }
    if (n < f.min || n > f.max) {
      problems[f.key] = `${f.label} must be between ${f.min} and ${f.max} ${f.unit}.`;
      continue;
    }
    values[f.key] = n;
  }

  const row = (key: OutreachSettingsKey, value: string) => {
    const f = OUTREACH_FIELDS.find((x) => x.key === key)!;
    summary.push({ key, label: f.label, apiField: f.apiField, value });
  };

  for (const f of OUTREACH_FIELDS) {
    const n = values[f.key];
    if (n === undefined) continue;
    if (f.key === "randomize") {
      // Plusvibe's randomize number starts at 1, so 0 is said as "off".
      if (n === 0) {
        body.warmup_randomize = "no";
        row(f.key, "Off");
      } else {
        body.warmup_randomize = "yes";
        body.warmup_randomize_num = n;
        row(f.key, `${n}%`);
      }
    } else if (f.key === "warmupReplyRate") {
      // The API takes a 0–1 fraction; the tool asks for a percentage.
      body.warmup_reply_rate = Math.round((n / 100) * 1000) / 1000;
      row(f.key, `${n}%`);
    } else if (f.key === "intervalMinutes") {
      body.interval_limit_in_min = n;
      row(f.key, `${n} minute${n === 1 ? "" : "s"}`);
    } else {
      body[f.apiField] = n;
      row(f.key, `${n} ${f.unit}`);
    }
  }

  Object.assign(body, FIXED_SETTINGS);
  summary.push(...FIXED_ROWS);

  return { values, problems, body, summary, ok: Object.keys(problems).length === 0 };
}

export function describeSettingRows(rows: SettingsRow[]): string {
  return rows.map((r) => `${r.label} ${r.value}`).join(" · ");
}

// ---------------------------------------------------------------------------
// The inboxes being moved
// ---------------------------------------------------------------------------

export interface MovingInbox {
  id: string;
  email: string;
  domain: string;
  /** Plusvibe's provider key, e.g. GOOGLE_WORKSPACE. */
  provider: string;
  firstName?: string;
  lastName?: string;
}

export function domainsOf(inboxes: { domain: string }[]): string[] {
  return Array.from(new Set(inboxes.map((i) => normalizeDomain(i.domain)).filter(Boolean)));
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** The signature step only runs with a title and a company to put in it. */
export function signatureFieldsUsable(fields: SignatureFields | null | undefined): boolean {
  if (!fields) return false;
  const some = (v: string[]) => v.some((x) => x.trim() !== "");
  return some(fields.titles) && some(fields.companies);
}

export function trimFields(fields: SignatureFields): SignatureFields {
  const clean = (v: string[]) => v.map((x) => x.trim()).filter(Boolean);
  return {
    titles: clean(fields.titles),
    companies: clean(fields.companies),
    phones: clean(fields.phones),
    addresses: clean(fields.addresses),
  };
}

export interface SignaturePlan {
  /** One entry per person; every inbox carrying that name gets one signature. */
  people: PersonGroup[];
  withName: number;
  noName: number;
}

/**
 * Groups the moving inboxes by the person named on them. Nothing is excluded
 * by tag here: these inboxes were chosen by domain, not filtered.
 */
export function planSignatures(inboxes: MovingInbox[]): SignaturePlan {
  const like: InboxLike[] = inboxes.map((i) => ({
    id: i.id,
    email: i.email,
    first_name: i.firstName,
    last_name: i.lastName,
  }));
  const r = groupInboxes(like, { masterTagIds: new Set(), tagFilter: new Set() });
  return { people: r.groups, withName: r.matched, noName: r.skippedNoName };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const ACTIVE_TAG_NAME = "active";
export const ACTIVE_TAG_COLOR = "#10B981";

export interface DomainTagRow {
  domain: string;
  inboxes: number;
  tldTag?: string;
  host?: string;
  platformTag?: string;
}

export interface DomainTagPreview {
  rows: DomainTagRow[];
  /** tag name → inboxes it would go on. */
  tldCounts: Map<string, number>;
  platformCounts: Map<string, number>;
  /** Domains the sheet has no host for, so no platform tag. */
  notInSheet: number;
  /** Domains whose TLD / host has no tag in the set. */
  tldNoTag: number;
  hostNoTag: number;
}

/**
 * Which TLD and platform tag each domain gets: the TLD from the domain
 * itself, the platform from the sheet's "Domain Host" for that domain. Tags
 * the inboxes already carry are only known in the workspace, so the run
 * re-checks that; here the preview says what the sets would give.
 */
export function previewDomainTags(
  inboxes: MovingInbox[],
  hosts: Record<string, string | undefined>,
  tld: TagInput[],
  platform: TagInput[]
): DomainTagPreview {
  const perDomain = new Map<string, number>();
  for (const i of inboxes) {
    const d = normalizeDomain(i.domain);
    if (!d) continue;
    perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
  }
  const out: DomainTagPreview = {
    rows: [],
    tldCounts: new Map(),
    platformCounts: new Map(),
    notInSheet: 0,
    tldNoTag: 0,
    hostNoTag: 0,
  };
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const [domain, n] of perDomain) {
    const row: DomainTagRow = { domain, inboxes: n };
    const tldTag = findTldTag(domain, tld);
    if (tldTag) {
      row.tldTag = tldTag.name;
      bump(out.tldCounts, tldTag.name, n);
    } else if (tldOf(domain)) {
      out.tldNoTag += 1;
    }
    const host = hosts[domain];
    if (host) {
      row.host = host;
      const p = findPlatformTag(host, platform);
      if (p) {
        row.platformTag = p.name;
        bump(out.platformCounts, p.name, n);
      } else out.hostNoTag += 1;
    } else out.notInSheet += 1;
    out.rows.push(row);
  }
  out.rows.sort((a, b) => b.inboxes - a.inboxes || a.domain.localeCompare(b.domain));
  return out;
}

/** "porkbun ×12, dynadot ×3" — a count map in words, biggest first. */
export function countsInWords(m: Map<string, number>, max = 6): string {
  const entries = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = entries.slice(0, max).map(([k, n]) => `${k} ×${n}`);
  const more = entries.length > max ? `, +${entries.length - max} more` : "";
  return shown.join(", ") + more;
}

// ---------------------------------------------------------------------------
// The sheet's Client column
// ---------------------------------------------------------------------------

export interface ClientPreview {
  /** Domains with a row in the sheet, and what the Client cell says now. */
  inSheet: { domain: string; current?: string }[];
  notInSheet: string[];
  /** Rows whose Client already reads as the destination. */
  alreadySet: number;
  /** Rows that still carry a warmup date or day count to clear. */
  withWarmup: number;
}

export function previewClientColumn(
  domains: string[],
  sheet: Record<string, { client?: string; started?: string; days?: string | number } | undefined>,
  destinationName: string
): ClientPreview {
  const out: ClientPreview = { inSheet: [], notInSheet: [], alreadySet: 0, withWarmup: 0 };
  const want = destinationName.trim().toLowerCase();
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    const row = sheet[d];
    if (!row) {
      out.notInSheet.push(d);
      continue;
    }
    out.inSheet.push({ domain: d, current: row.client });
    if ((row.client ?? "").trim().toLowerCase() === want && want) out.alreadySet += 1;
    if (row.started || (row.days !== undefined && row.days !== "")) out.withWarmup += 1;
  }
  return out;
}

/** What a moved domain's Status cell is set to. */
export const ACTIVE_STATUS = "Active";

export interface SheetWrite {
  domain: string;
  /** 1-based sheet row and 0-based column, ready for A1 notation. */
  row: number;
  column: number;
  value: string;
}

/**
 * The cell writes for the moved domains: Client set to the destination,
 * Status set to Active, and the Warmup Started / Warmup Days cells cleared,
 * since the domain is no longer warming. Cells that already read that way
 * are not written. Returns the domains the grid does not have, and the rows
 * that needed nothing at all.
 */
export function planSheetWrites(
  grid: string[][],
  domains: string[],
  destinationName: string
): {
  writes: SheetWrite[];
  /** Rows that were changed (one per domain, however many cells). */
  rows: string[];
  alreadySet: string[];
  notInSheet: string[];
  /** Columns the tab does not have, so those cells were left alone. */
  missingColumns: string[];
  problem: string | null;
} {
  const empty = {
    writes: [] as SheetWrite[],
    rows: [] as string[],
    alreadySet: [] as string[],
    notInSheet: [] as string[],
    missingColumns: [] as string[],
    problem: null as string | null,
  };
  if (grid.length === 0) return { ...empty, problem: "The Domains tab is empty." };
  const header = grid[0].map((h) => String(h ?? "").trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const iDomain = col(SHEET_COL_DOMAIN);
  const iClient = col(SHEET_COL_CLIENT);
  const iStatus = col("Status");
  const iStarted = col(SHEET_COL_WARMUP_STARTED);
  const iDays = col(SHEET_COL_WARMUP_DAYS);
  if (iDomain === -1) return { ...empty, problem: `No "${SHEET_COL_DOMAIN}" column in the Domains tab.` };
  if (iClient === -1) return { ...empty, problem: `No "${SHEET_COL_CLIENT}" column in the Domains tab.` };
  const missingColumns = [
    iStatus === -1 ? "Status" : null,
    iStarted === -1 ? SHEET_COL_WARMUP_STARTED : null,
    iDays === -1 ? SHEET_COL_WARMUP_DAYS : null,
  ].filter((c): c is string => !!c);

  const rowByDomain = new Map<string, number>();
  for (let r = 1; r < grid.length; r++) {
    const d = normalizeDomain(grid[r]?.[iDomain]);
    if (d && !rowByDomain.has(d)) rowByDomain.set(d, r + 1); // first row wins
  }
  const wanted: [number, string][] = [
    [iClient, destinationName.trim()],
    [iStatus, ACTIVE_STATUS],
    [iStarted, ""],
    [iDays, ""],
  ];
  const out = { ...empty, missingColumns };
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    const row = rowByDomain.get(d);
    if (!row) {
      out.notInSheet.push(d);
      continue;
    }
    let changed = false;
    for (const [column, value] of wanted) {
      if (column === -1) continue;
      const current = String(grid[row - 1]?.[column] ?? "").trim();
      if (current.toLowerCase() === value.toLowerCase()) continue;
      out.writes.push({ domain: d, row, column, value });
      changed = true;
    }
    if (changed) out.rows.push(d);
    else out.alreadySet.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run, in words
// ---------------------------------------------------------------------------

export function describeRun(p: {
  inboxes: number;
  domains: number;
  source: string;
  destination: string;
}): string {
  return `${p.inboxes} inbox${p.inboxes === 1 ? "" : "es"} on ${p.domains} domain${p.domains === 1 ? "" : "s"} · ${p.source} → ${p.destination}`;
}
