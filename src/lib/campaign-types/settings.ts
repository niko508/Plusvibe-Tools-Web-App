// The Create All Campaign Types settings: which side the "other" leads go
// to, and the daily limit each kind of campaign is created with.
//
// A lead is Microsoft, Google, or neither. The two Microsoft/non-Microsoft
// sides of the six-way split have always been "the 🔵 campaigns" and "the
// rest"; what changes with DOMINANT targeting is which side the neither-leads
// join. Google dominant is what the tool always did: they stay with the
// Google leads on the plain side. Microsoft dominant sends them to the 🔵
// campaigns instead, leaving only Google recipients on the plain side.
//
// The daily limits are the campaign-level "Maximum emails per day" written to
// each campaign the run creates: the Google limit to the plain copies, the
// Microsoft limit to the 🔵 ones. Blank means the copy keeps whatever it
// inherited from the campaign it was duplicated from, which is what happened
// before there was a setting.
//
// Pure module — the file on disk is settings-store.ts — so all of it is
// unit-tested and the client can import it for the form and the preview.

import type { Esp } from "./esp";
import type { CreatedRole, Dominant, RunSettings } from "@/lib/jobs/campaign-types-types";

// Dominant and RunSettings live with the job types (that file cannot import
// from this one without a cycle) and are re-exported here, where the rest of
// the settings vocabulary is.
export type { Dominant, RunSettings };

export const DOMINANT_OPTIONS: { key: Dominant; label: string; hint: string }[] = [
  { key: "google", label: "Google", hint: "other-ESP leads stay with the Google leads, in the plain campaigns" },
  { key: "microsoft", label: "Microsoft", hint: "other-ESP leads go to the 🔵 campaigns with the Microsoft leads" },
];

/** What is stored: the three values a run needs, and when they were last saved. */
export interface CampaignTypesSettings extends RunSettings {
  updatedAt: number;
}

export const DEFAULT_SETTINGS: CampaignTypesSettings = {
  dominant: "google",
  googleDailyLimit: null,
  microsoftDailyLimit: null,
  updatedAt: 0,
};

/** Plusvibe's own screen takes any whole number; this is a sanity ceiling, not a rule. */
export const MAX_DAILY_LIMIT = 100_000;

export function isDominant(v: unknown): v is Dominant {
  return v === "google" || v === "microsoft";
}

/**
 * A limit as typed or stored: blank is "not set", anything else must be a
 * whole number from 0 up. Returns the problem, in words, when it isn't.
 */
export function parseLimit(raw: unknown, label: string): { value: number | null; error?: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw === "string" && raw.trim() === "") return { value: null };
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: `${label}: enter a number, or leave it blank.` };
  if (!Number.isInteger(n)) return { value: null, error: `${label}: use a whole number.` };
  if (n < 0) return { value: null, error: `${label}: can't be negative.` };
  if (n > MAX_DAILY_LIMIT) return { value: null, error: `${label}: ${MAX_DAILY_LIMIT.toLocaleString()} is the most this will set.` };
  return { value: n };
}

/** Whatever was stored, read as settings: unknown values fall back to the defaults. */
export function normalizeSettings(raw: Partial<CampaignTypesSettings> | null | undefined): CampaignTypesSettings {
  const r = raw ?? {};
  const limit = (v: unknown) => {
    const p = parseLimit(v, "");
    return p.error ? null : p.value;
  };
  return {
    dominant: isDominant(r.dominant) ? r.dominant : DEFAULT_SETTINGS.dominant,
    googleDailyLimit: limit(r.googleDailyLimit),
    microsoftDailyLimit: limit(r.microsoftDailyLimit),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

export function runSettingsOf(s: RunSettings): RunSettings {
  return { dominant: s.dominant, googleDailyLimit: s.googleDailyLimit, microsoftDailyLimit: s.microsoftDailyLimit };
}

/** The 🔵 copies: the ones that take the Microsoft side of the split. */
export const BLUE_ROLES: CreatedRole[] = ["blue", "blueOptOut", "blueSignature"];

export function isBlueRole(role: CreatedRole): boolean {
  return BLUE_ROLES.includes(role);
}

/** The daily limit a created copy gets, or null to leave what it inherited. */
export function limitForRole(role: CreatedRole, s: RunSettings): number | null {
  return isBlueRole(role) ? s.microsoftDailyLimit : s.googleDailyLimit;
}

/**
 * Which side each lead goes to. Order is kept, so with Google dominant the
 * two lists are exactly the Microsoft / non-Microsoft split the tool has
 * always made.
 */
export function sidesFor<T>(classified: { lead: T; esp: Esp }[], dominant: Dominant): { blue: T[]; plain: T[] } {
  const blue: T[] = [];
  const plain: T[] = [];
  for (const { lead, esp } of classified) {
    const toBlue = esp === "MICROSOFT" || (esp === "OTHER" && dominant === "microsoft");
    (toBlue ? blue : plain).push(lead);
  }
  return { blue, plain };
}

/** "Other-ESP leads go to the 🔵 (Microsoft) campaigns." */
export function describeDominant(d: Dominant): string {
  return d === "microsoft"
    ? "Other-ESP leads go to the 🔵 (Microsoft) campaigns; only Google recipients stay in the plain ones."
    : "Other-ESP leads stay with the Google recipients in the plain campaigns; the 🔵 campaigns take Microsoft only.";
}

/** "Google 3,000/day · Microsoft 1,500/day", or what is left unset. */
export function describeLimits(s: RunSettings): string {
  const parts: string[] = [];
  if (s.googleDailyLimit !== null) parts.push(`Google copies ${s.googleDailyLimit.toLocaleString()}/day`);
  if (s.microsoftDailyLimit !== null) parts.push(`🔵 copies ${s.microsoftDailyLimit.toLocaleString()}/day`);
  return parts.length > 0 ? parts.join(" · ") : "daily limits as duplicated";
}
