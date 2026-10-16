// Which campaign types a run builds.
//
// Each type is a pair — a plain (Google) campaign and a 🔵 (Microsoft) one:
//
//   Default         the original itself, plus its 🔵 copy
//   With Opt Out    a copy whose step 1 carries the opt-out line, plus its 🔵
//   With Signature  a copy whose step 1 signs off with the signature, plus its 🔵
//   Opt Out only    no plain copies: the ORIGINAL gets the opt-out line on
//                   step 1 and is renamed to its Opt Out name, then its 🔵 Opt
//                   Out copy is made from it. It goes with With Signature and
//                   nothing else: the Signature copies are then made from the
//                   converted original, so they carry the opt-out line too, and
//                   are named "… - Opt Out - Signature (August)".
//
// The original campaign is the plain Default, so picking Default creates one
// campaign and the other two create two each. A type left out is simply not
// built, and the lead split skips it: its share stays with the campaigns in
// the same pool that are there.
//
// Pure module, shared by the form and the job.

import { CREATED_ROLES, type CampaignKind, type CreatedRole } from "@/lib/jobs/campaign-types-types";

export type { CampaignKind };

export const KIND_ORDER: CampaignKind[] = ["default", "optOut", "signature", "optOutOnly"];

/** What a run builds unless told otherwise: the three types. */
export const DEFAULT_KINDS: CampaignKind[] = ["default", "optOut", "signature"];

export const KIND_LABELS: Record<CampaignKind, string> = {
  default: "Default",
  optOut: "With Opt Out",
  signature: "With Signature",
  optOutOnly: "Opt Out only",
};

export const KIND_HINTS: Record<CampaignKind, string> = {
  default: "The original, plus a 🔵 copy for its Microsoft leads.",
  optOut: "A copy with the opt-out line on step 1, and its 🔵 copy.",
  signature: "A copy whose step 1 signs off with the signature, and its 🔵 copy.",
  optOutOnly: "No new plain campaign: the original gets the opt-out line on step 1 and is renamed to Opt Out, plus its 🔵 Opt Out copy. Goes with With Signature.",
};

/** The copies each type creates. */
const ROLES_BY_KIND: Record<CampaignKind, CreatedRole[]> = {
  default: ["blue"],
  optOut: ["optOut", "blueOptOut"],
  signature: ["signature", "blueSignature"],
  optOutOnly: ["blueOptOut"],
};

export function isKind(v: unknown): v is CampaignKind {
  return v === "default" || v === "optOut" || v === "signature" || v === "optOutOnly";
}

/** The one type that goes with Opt Out only. */
const WITH_OPT_OUT_ONLY: CampaignKind = "signature";

/**
 * Whatever was sent, as a de-duplicated list in the fixed order. Opt Out only
 * goes with With Signature alone: sent with Default or With Opt Out, those are
 * dropped, since Opt Out only is the one that changes the original.
 */
export function normalizeKinds(raw: unknown): CampaignKind[] {
  const set = new Set<CampaignKind>();
  if (Array.isArray(raw)) for (const v of raw) if (isKind(v)) set.add(v);
  if (set.has("optOutOnly")) return KIND_ORDER.filter((k) => set.has(k) && (k === "optOutOnly" || k === WITH_OPT_OUT_ONLY));
  return KIND_ORDER.filter((k) => set.has(k));
}

/** Whether a run converts its originals rather than building plain copies. */
export function convertsOriginal(kinds: CampaignKind[]): boolean {
  return kinds.includes("optOutOnly");
}

/**
 * The kinds after ticking or unticking one card. Ticking Opt Out only clears
 * the three; With Signature can then be ticked beside it. Ticking Default or
 * With Opt Out clears Opt Out only.
 */
export function toggleKinds(prev: CampaignKind[], kind: CampaignKind): CampaignKind[] {
  if (prev.includes(kind)) {
    const left = prev.filter((k) => k !== kind);
    // Unticking Opt Out only goes back to the usual three rather than nothing.
    return kind === "optOutOnly" ? [...DEFAULT_KINDS] : left;
  }
  if (kind === "optOutOnly") return ["optOutOnly"];
  if (prev.includes("optOutOnly") && kind === WITH_OPT_OUT_ONLY) return normalizeKinds([...prev, kind]);
  return KIND_ORDER.filter((k) => k !== "optOutOnly" && (k === kind || prev.includes(k)));
}

/** The copies a run creates for these types, in creation order. */
export function rolesFor(kinds: CampaignKind[]): CreatedRole[] {
  const wanted = new Set(kinds.flatMap((k) => ROLES_BY_KIND[k]));
  return CREATED_ROLES.filter((r) => wanted.has(r));
}

/** The type a copy belongs to. */
export function kindOfRole(role: CreatedRole): CampaignKind {
  for (const k of KIND_ORDER) if (ROLES_BY_KIND[k].includes(role)) return k;
  return "default";
}

/** "Default, With Opt Out" */
export function describeKinds(kinds: CampaignKind[]): string {
  return normalizeKinds(kinds).map((k) => KIND_LABELS[k]).join(", ");
}
