// Which campaign types a run builds.
//
// Each type is a pair — a plain (Google) campaign and a 🔵 (Microsoft) one:
//
//   Default         the original itself, plus its 🔵 copy
//   With Opt Out    a copy whose step 1 carries the opt-out line, plus its 🔵
//   With Signature  a copy whose step 1 signs off with the signature, plus its 🔵
//
// The original campaign is the plain Default, so picking Default creates one
// campaign and the other two create two each. A type left out is simply not
// built, and the lead split skips it: its share stays with the campaigns in
// the same pool that are there.
//
// Pure module, shared by the form and the job.

import { CREATED_ROLES, type CampaignKind, type CreatedRole } from "@/lib/jobs/campaign-types-types";

export type { CampaignKind };

export const KIND_ORDER: CampaignKind[] = ["default", "optOut", "signature"];

export const KIND_LABELS: Record<CampaignKind, string> = {
  default: "Default",
  optOut: "With Opt Out",
  signature: "With Signature",
};

export const KIND_HINTS: Record<CampaignKind, string> = {
  default: "The original, plus a 🔵 copy for its Microsoft leads.",
  optOut: "A copy with the opt-out line on step 1, and its 🔵 copy.",
  signature: "A copy whose step 1 signs off with the signature, and its 🔵 copy.",
};

/** The copies each type creates. */
const ROLES_BY_KIND: Record<CampaignKind, CreatedRole[]> = {
  default: ["blue"],
  optOut: ["optOut", "blueOptOut"],
  signature: ["signature", "blueSignature"],
};

export function isKind(v: unknown): v is CampaignKind {
  return v === "default" || v === "optOut" || v === "signature";
}

/** Whatever was sent, as a de-duplicated list in the fixed order. */
export function normalizeKinds(raw: unknown): CampaignKind[] {
  const set = new Set<CampaignKind>();
  if (Array.isArray(raw)) for (const v of raw) if (isKind(v)) set.add(v);
  return KIND_ORDER.filter((k) => set.has(k));
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
