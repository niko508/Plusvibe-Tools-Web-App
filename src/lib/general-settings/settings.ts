// General Settings: the business values several tools share — tag names, the
// Google Sheet's tab names and statuses, the workspaces left out of counts,
// sending capacity, the opt-out text — kept in one place instead of typed out
// in each tool.
//
// Adding a setting is three steps, all in this file:
//
//   1. a field on GeneralSettings, under the section it belongs to
//   2. its value in DEFAULT_GENERAL_SETTINGS — what the app did before
//   3. a line in SECTIONS: its label, help text, kind and the tools it feeds
//
// The kind ("text", "tagList", "number", …) is what loading, validation and
// the settings page all go by, so nothing else has to change for the value to
// be saved, checked and editable. Then read it where it is used with
// generalSettings().<section>.<field>.
//
// The values live on the server (the volume), because jobs and webhooks read
// them with no browser involved. Both sides keep the current copy on
// globalThis: the server loads it at boot and after every save, the browser
// fetches it when the app opens. Until then, and whenever a stored value
// doesn't read, the defaults below apply — so the app behaves exactly as it
// did before anything was saved.
//
// Pure module: no fs, no fetch, so all of it is unit-tested.

import type { TagInput } from "@/lib/tags/bulk-tags";
import { normalizeColor, tagKey } from "@/lib/tags/bulk-tags";
import { DEFAULT_PLATFORM_TAGS, DEFAULT_TLD_TAGS } from "@/lib/tags/domain-tags";
import { OPT_OUT_SPINTAX } from "@/lib/campaign-types/opt-out-spintax";
import { PREVIOUS_OPT_OUT_SPINTAX } from "@/lib/campaign-types/opt-out-spintax-previous";

export interface GeneralSettings {
  tags: {
    tld: TagInput[];
    platform: TagInput[];
    googlePool: TagInput;
    microsoftPool: TagInput;
    active: TagInput;
    masterInbox: string;
    rotationGroup1: string;
    rotationGroup2: string;
  };
  sheet: {
    url: string;
    domainsTab: string;
    tenantsTab: string;
    tenantsToCancelTab: string;
    googleInboxesToCancelTab: string;
    notActiveStatus: string;
    warmingUpStatus: string;
  };
  workspaces: {
    excluded: string[];
  };
  capacity: {
    google: number;
    azure50: number;
    azure25: number;
  };
  optOut: {
    current: string;
    previous: string[];
  };
}

export type SectionKey = keyof GeneralSettings;

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  tags: {
    tld: DEFAULT_TLD_TAGS,
    platform: DEFAULT_PLATFORM_TAGS,
    googlePool: { name: "google-pool", color: "#F59E0B" },
    microsoftPool: { name: "microsoft-pool", color: "#3B82F6" },
    active: { name: "active", color: "#10B981" },
    masterInbox: "master inbox",
    rotationGroup1: "Sending Group 1",
    rotationGroup2: "Sending Group 2",
  },
  sheet: {
    url: "https://docs.google.com/spreadsheets/d/1V9F5NwK_hPBeDHgHcIz5APDd3VFL1ckzrxCAnVvBQFU/edit",
    domainsTab: "📋 Domains",
    tenantsTab: "👴 Tenants",
    tenantsToCancelTab: "🚯 Tenants to Cancel",
    googleInboxesToCancelTab: "🛑 Google Inboxes to Cancel",
    notActiveStatus: "Not Active",
    warmingUpStatus: "Warming Up",
  },
  workspaces: {
    excluded: ["Ikoni Digital Lead Nurturing + Duplicate Workspace", "Inbox Warmup"],
  },
  capacity: {
    google: 13,
    azure50: 3,
    azure25: 5,
  },
  optOut: {
    current: OPT_OUT_SPINTAX,
    previous: [PREVIOUS_OPT_OUT_SPINTAX],
  },
};

// --- The fields, as the page and the checks see them ----------------------------

export type FieldKind =
  /** One line of text, never empty. */
  | "text"
  /** A web address. */
  | "url"
  /** A whole number, between min and max. */
  | "number"
  /** Lines of text, no repeats (case ignored). */
  | "list"
  /** One tag: a name and a colour. */
  | "tag"
  /** Tags with colours, no repeated names. */
  | "tagList"
  /** A {{Random | … }} block. */
  | "spintax"
  /** Several {{Random | … }} blocks; may be empty. */
  | "spintaxList";

export interface FieldDef {
  key: string;
  label: string;
  help: string;
  kind: FieldKind;
  /** The tools that read it, by name, for the page. */
  usedBy: string[];
  min?: number;
  max?: number;
  /** Shown beside the field: what changing it does and doesn't do. */
  caution?: string;
}

export interface SectionDef {
  key: SectionKey;
  title: string;
  description: string;
  fields: FieldDef[];
}

const RENAME_CAUTION =
  "Renaming doesn't rename the tag in Plusvibe: tools look for the new name from now on, and create it where they create tags.";
const TAB_CAUTION = "Rename the tab in the sheet at the same time — the tools look for it by this name.";

export const SECTIONS: SectionDef[] = [
  {
    key: "tags",
    title: "Tags",
    description: "The tag names and colours tools put on inboxes and campaigns, or look for.",
    fields: [
      {
        key: "tld",
        label: "TLD tags",
        help: "One per domain ending. An inbox gets the tag matching its domain's ending.",
        kind: "tagList",
        usedBy: ["General Bulk Actions → Auto domain tags", "Start Outreach with New Inboxes", "Blocked Domains (Automation) stats"],
      },
      {
        key: "platform",
        label: "Domain platform tags",
        help: "One per registrar. Matched against the Domain Host column of the Domains tab.",
        kind: "tagList",
        usedBy: ["General Bulk Actions → Auto domain tags", "Start Outreach with New Inboxes", "Blocked Domains (Automation) stats"],
      },
      {
        key: "googlePool",
        label: "Google pool tag",
        help: "Put on Google inboxes and on the plain (🟡) campaigns.",
        kind: "tag",
        usedBy: ["Create All Campaign Types", "General Bulk Actions → Auto domain tags"],
        caution: RENAME_CAUTION,
      },
      {
        key: "microsoftPool",
        label: "Microsoft pool tag",
        help: "Put on Microsoft inboxes and on the 🔵 campaigns.",
        kind: "tag",
        usedBy: ["Create All Campaign Types", "General Bulk Actions → Auto domain tags"],
        caution: RENAME_CAUTION,
      },
      {
        key: "active",
        label: "Active sending tag",
        help: "Put on inboxes Start Outreach moves; a new workspace's first campaign sends from the inboxes carrying it.",
        kind: "tag",
        usedBy: ["Start Outreach with New Inboxes", "New Workspace 1st Campaign"],
        caution: RENAME_CAUTION,
      },
      {
        key: "masterInbox",
        label: "Master inbox tag",
        help: "Inboxes with this tag are never given signatures or offered for removal.",
        kind: "text",
        usedBy: ["Add Signatures", "Remove Inboxes"],
      },
      {
        key: "rotationGroup1",
        label: "Rotation group 1 tag",
        help: "The first of the two sending groups Inbox Rotation switches between.",
        kind: "text",
        usedBy: ["Inbox Rotation"],
        caution: RENAME_CAUTION,
      },
      {
        key: "rotationGroup2",
        label: "Rotation group 2 tag",
        help: "The second sending group.",
        kind: "text",
        usedBy: ["Inbox Rotation"],
        caution: RENAME_CAUTION,
      },
    ],
  },
  {
    key: "sheet",
    title: "Google Sheet",
    description: "The Email Infra sheet: where it is, what its tabs are called, and the statuses tools write.",
    fields: [
      {
        key: "url",
        label: "Sheet link",
        help: "Filled in wherever a tool asks for the sheet.",
        kind: "url",
        usedBy: ["Azure Start Warmup", "Find Burned Domains & Inboxes", "General Bulk Actions → Auto domain tags"],
      },
      {
        key: "domainsTab",
        label: "Domains tab",
        help: "One row per domain: Domain, Status, Tenant Email Address, Domain Host, …",
        kind: "text",
        usedBy: ["Blocked Domains (Automation)", "Azure Start Warmup", "Find Burned Domains & Inboxes", "Start Outreach with New Inboxes", "General Bulk Actions"],
        caution: TAB_CAUTION,
      },
      {
        key: "tenantsTab",
        label: "Tenants tab",
        help: "Where a tenant's provider is read from.",
        kind: "text",
        usedBy: ["Azure Start Warmup"],
        caution: TAB_CAUTION,
      },
      {
        key: "tenantsToCancelTab",
        label: "Tenants to Cancel tab",
        help: "A cancelled Microsoft domain and its tenant email are added here.",
        kind: "text",
        usedBy: ["Blocked Domains (Automation)", "Find Burned Domains & Inboxes"],
        caution: TAB_CAUTION,
      },
      {
        key: "googleInboxesToCancelTab",
        label: "Google Inboxes to Cancel tab",
        help: "A blocked or burned Google inbox is added here.",
        kind: "text",
        usedBy: ["Blocked Domains (Automation)", "Find Burned Domains & Inboxes"],
        caution: TAB_CAUTION,
      },
      {
        key: "notActiveStatus",
        label: "Not active status",
        help: "Written to a domain's Status when it stops being used.",
        kind: "text",
        usedBy: ["Blocked Domains (Automation)", "Find Burned Domains & Inboxes"],
      },
      {
        key: "warmingUpStatus",
        label: "Warming up status",
        help: "Written to a domain's Status when its warmup starts.",
        kind: "text",
        usedBy: ["Azure Start Warmup"],
      },
    ],
  },
  {
    key: "workspaces",
    title: "Workspaces",
    description: "Workspaces that are not client workspaces.",
    fields: [
      {
        key: "excluded",
        label: "Left out of counts and scans",
        help: "One workspace name per line. Never counted for capacity, and unticked by default when scanning for inboxes to remove.",
        kind: "list",
        usedBy: ["Sending Capacity", "Remove Inboxes"],
      },
    ],
  },
  {
    key: "capacity",
    title: "Sending capacity",
    description: "Emails a day one inbox is counted as sending, by what its domain runs on.",
    fields: [
      { key: "google", label: "Google inbox", help: "Emails a day.", kind: "number", min: 0, max: 1000, usedBy: ["Sending Capacity"] },
      { key: "azure50", label: "Azure 50 inbox", help: "Emails a day, on a domain with more than 25 mailboxes.", kind: "number", min: 0, max: 1000, usedBy: ["Sending Capacity"] },
      { key: "azure25", label: "Azure 25 inbox", help: "Emails a day, on a domain with 25 mailboxes or fewer.", kind: "number", min: 0, max: 1000, usedBy: ["Sending Capacity"] },
    ],
  },
  {
    key: "optOut",
    title: "Opt-out text",
    description: "The spintax line put at the bottom of step 1 in the Opt Out campaigns.",
    fields: [
      {
        key: "current",
        label: "Current opt-out block",
        help: "One {{Random | … | … }} block. Goes out to real recipients exactly as written.",
        kind: "spintax",
        usedBy: ["Create All Campaign Types"],
        caution: "When you change it, the block it replaces is added to the older versions below, so campaigns that carry it get the new one instead of a second block.",
      },
      {
        key: "previous",
        label: "Older versions",
        help: "Blocks used before. Never added to anything — only recognised, so a campaign carrying one has it swapped for the current block.",
        kind: "spintaxList",
        usedBy: ["Create All Campaign Types"],
      },
    ],
  },
];

// --- Reading and checking values -------------------------------------------------

const MAX_TEXT = 500;
const MAX_LIST = 200;
const MAX_SPINTAX = 200_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Splits "{{Random | a | b {{x}} | c}}" into its top-level options; null when it isn't one block. */
export function spintaxOptions(raw: string): string[] | null {
  const s = raw.trim();
  if (!s.startsWith("{{") || !s.endsWith("}}")) return null;
  const inner = s.slice(2, -2);
  const head = /^\s*random\s*\|/i.exec(inner);
  if (!head) return null;
  const out: string[] = [];
  let depth = 0;
  let from = head[0].length;
  for (let i = from; i < inner.length; i++) {
    if (inner.startsWith("{{", i)) {
      depth++;
      i++;
    } else if (inner.startsWith("}}", i)) {
      depth--;
      i++;
      if (depth < 0) return null;
    } else if (inner[i] === "|" && depth === 0) {
      out.push(inner.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (depth !== 0) return null;
  out.push(inner.slice(from).trim());
  return out.filter(Boolean);
}

/** The value as stored, or the problem with it. */
type Checked<T> = { value: T } | { problem: string };

function checkTag(raw: unknown): Checked<TagInput> {
  if (!isObj(raw)) return { problem: "needs a name and a colour" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { problem: "needs a name" };
  if (name.length > 100) return { problem: "name is over 100 characters" };
  const color = normalizeColor(typeof raw.color === "string" ? raw.color : "");
  if (!color) return { problem: `"${name}" needs a colour like #10B981` };
  return { value: { name, color } };
}

function checkField(def: FieldDef, raw: unknown): Checked<unknown> {
  switch (def.kind) {
    case "text":
    case "url": {
      if (typeof raw !== "string" || !raw.trim()) return { problem: "can't be empty" };
      const v = raw.trim();
      if (v.length > MAX_TEXT) return { problem: `is over ${MAX_TEXT} characters` };
      if (def.kind === "url" && !/^https?:\/\/\S+$/i.test(v)) return { problem: "needs to be a link starting with https://" };
      return { value: v };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      const min = def.min ?? 0;
      const max = def.max ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isInteger(n) || n < min || n > max) return { problem: `needs to be a whole number from ${min} to ${max}` };
      return { value: n };
    }
    case "list": {
      if (!Array.isArray(raw)) return { problem: "needs to be a list" };
      const out: string[] = [];
      const seen = new Set<string>();
      for (const item of raw) {
        if (typeof item !== "string") return { problem: "has a line that isn't text" };
        const v = item.trim();
        if (!v) continue;
        if (v.length > MAX_TEXT) return { problem: `has a line over ${MAX_TEXT} characters` };
        if (seen.has(v.toLowerCase())) continue;
        seen.add(v.toLowerCase());
        out.push(v);
      }
      if (out.length > MAX_LIST) return { problem: `has more than ${MAX_LIST} lines` };
      return { value: out };
    }
    case "tag":
      return checkTag(raw);
    case "tagList": {
      if (!Array.isArray(raw)) return { problem: "needs to be a list of tags" };
      const out: TagInput[] = [];
      const seen = new Set<string>();
      for (const item of raw) {
        const t = checkTag(item);
        if ("problem" in t) return t;
        if (seen.has(tagKey(t.value.name))) return { problem: `has "${t.value.name}" twice` };
        seen.add(tagKey(t.value.name));
        out.push(t.value);
      }
      if (out.length === 0) return { problem: "needs at least one tag" };
      if (out.length > MAX_LIST) return { problem: `has more than ${MAX_LIST} tags` };
      return { value: out };
    }
    case "spintax": {
      if (typeof raw !== "string") return { problem: "needs to be a {{Random | … }} block" };
      const v = raw.trim();
      if (v.length > MAX_SPINTAX) return { problem: `is over ${MAX_SPINTAX.toLocaleString("en-US")} characters` };
      const opts = spintaxOptions(v);
      if (!opts) return { problem: "needs to be one {{Random | … | … }} block, with every {{ closed" };
      if (opts.length < 5) return { problem: "needs at least 5 options, so it can be told apart from a greeting or sign-off" };
      return { value: v };
    }
    case "spintaxList": {
      if (!Array.isArray(raw)) return { problem: "needs to be a list of blocks" };
      const out: string[] = [];
      for (const [i, item] of raw.entries()) {
        if (typeof item === "string" && !item.trim()) continue;
        const c = checkField({ ...def, kind: "spintax" }, item);
        if ("problem" in c) return { problem: `version ${i + 1} ${c.problem}` };
        if (!out.includes(c.value as string)) out.push(c.value as string);
      }
      return { value: out };
    }
  }
}

/**
 * The settings from whatever was stored: each field that reads is kept, each
 * one that doesn't — or that isn't there, like a field added since the file
 * was written — takes its default. A bad file never stops the app.
 */
export function normalizeGeneralSettings(raw: unknown): GeneralSettings {
  const out = structuredClone(DEFAULT_GENERAL_SETTINGS) as unknown as Record<string, Record<string, unknown>>;
  if (!isObj(raw)) return out as unknown as GeneralSettings;
  for (const section of SECTIONS) {
    const stored = raw[section.key];
    if (!isObj(stored)) continue;
    for (const def of section.fields) {
      if (stored[def.key] === undefined) continue;
      const c = checkField(def, stored[def.key]);
      if ("value" in c) out[section.key][def.key] = c.value;
    }
  }
  return out as unknown as GeneralSettings;
}

/**
 * Checks settings sent to be saved. Nothing is half-saved: any problem refuses
 * the lot, each problem named with its section and field.
 */
export function validateGeneralSettings(raw: unknown): { settings: GeneralSettings | null; problems: string[] } {
  if (!isObj(raw)) return { settings: null, problems: ["Settings must be an object."] };
  const problems: string[] = [];
  const out = structuredClone(DEFAULT_GENERAL_SETTINGS) as unknown as Record<string, Record<string, unknown>>;
  for (const section of SECTIONS) {
    const sent = raw[section.key];
    if (sent === undefined) continue;
    if (!isObj(sent)) {
      problems.push(`${section.title}: must be an object.`);
      continue;
    }
    for (const def of section.fields) {
      if (sent[def.key] === undefined) continue;
      const c = checkField(def, sent[def.key]);
      if ("problem" in c) problems.push(`${section.title} → ${def.label} ${c.problem}.`);
      else out[section.key][def.key] = c.value;
    }
  }
  // Two tag settings meant to be different tags must not collide.
  const s = out as unknown as GeneralSettings;
  const singles: [string, string][] = [
    ["Google pool tag", s.tags.googlePool.name],
    ["Microsoft pool tag", s.tags.microsoftPool.name],
    ["Rotation group 1 tag", s.tags.rotationGroup1],
    ["Rotation group 2 tag", s.tags.rotationGroup2],
  ];
  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      if (tagKey(singles[i][1]) === tagKey(singles[j][1])) {
        problems.push(`Tags → ${singles[i][0]} and ${singles[j][0]} are both "${singles[i][1]}".`);
      }
    }
  }
  return problems.length > 0 ? { settings: null, problems } : { settings: s, problems: [] };
}

/**
 * What is stored when `next` replaces `prev`: when the opt-out block changes,
 * the one it replaces joins the older versions — otherwise campaigns carrying
 * it would read as having no opt-out, and get a second block under it.
 */
export function withRetiredOptOut(prev: GeneralSettings, next: GeneralSettings): GeneralSettings {
  const old = prev.optOut.current.trim();
  if (old === next.optOut.current.trim() || next.optOut.previous.includes(old)) return next;
  return { ...next, optOut: { ...next.optOut, previous: [...next.optOut.previous, old] } };
}

// --- The current copy ---------------------------------------------------------------

const holder = globalThis as unknown as {
  __pvGeneralSettings?: { settings: GeneralSettings; updatedAt: number; loaded: boolean; version: number };
  __pvGeneralSettingsListeners?: Set<() => void>;
};

function listeners(): Set<() => void> {
  if (!holder.__pvGeneralSettingsListeners) holder.__pvGeneralSettingsListeners = new Set();
  return holder.__pvGeneralSettingsListeners;
}

/** The settings in force: the loaded ones, or the defaults until they are. */
export function generalSettings(): GeneralSettings {
  return holder.__pvGeneralSettings?.settings ?? DEFAULT_GENERAL_SETTINGS;
}

/** Whether saved settings have been loaded here yet, when they were saved (0 = never), and a counter that moves on every change. */
export function generalSettingsState(): { loaded: boolean; updatedAt: number; version: number } {
  const h = holder.__pvGeneralSettings;
  return { loaded: !!h?.loaded, updatedAt: h?.updatedAt ?? 0, version: h?.version ?? 0 };
}

/** Puts a copy in force, on whichever side this runs. */
export function setGeneralSettings(settings: GeneralSettings, updatedAt: number): void {
  const version = (holder.__pvGeneralSettings?.version ?? 0) + 1;
  holder.__pvGeneralSettings = { settings, updatedAt, loaded: true, version };
  for (const l of listeners()) l();
}

export function onGeneralSettingsChange(cb: () => void): () => void {
  listeners().add(cb);
  return () => {
    listeners().delete(cb);
  };
}

// --- Shorthands for the values read in many places ---------------------------------

export const domainsTab = () => generalSettings().sheet.domainsTab;
export const tenantsTab = () => generalSettings().sheet.tenantsTab;
export const tenantsToCancelTab = () => generalSettings().sheet.tenantsToCancelTab;
export const googleInboxesToCancelTab = () => generalSettings().sheet.googleInboxesToCancelTab;
export const notActiveStatus = () => generalSettings().sheet.notActiveStatus;
export const warmingUpStatus = () => generalSettings().sheet.warmingUpStatus;
export const defaultSheetUrl = () => generalSettings().sheet.url;
export const excludedWorkspaces = () => generalSettings().workspaces.excluded;

/** Case-insensitive, spaces trimmed. */
export function isExcludedWorkspace(name: string): boolean {
  const n = name.trim().toLowerCase();
  return excludedWorkspaces().some((w) => w.trim().toLowerCase() === n);
}
