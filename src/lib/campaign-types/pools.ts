// The two pools every campaign belongs to, and how leads are sent to them.
//
// A campaign is either a Google campaign — the original and its plain copies,
// named with a 🟡 — or a Microsoft one, the 🔵 copies. Leads are sorted the
// same way: Google recipients stay on the plain side, and Microsoft
// recipients AND everyone whose provider is neither go to the 🔵 side. Only
// Google mailboxes get the Google campaigns; that is what the pools are for.
//
// The pools are also tags, so the campaigns can be filtered and picked out by
// other tools: every plain campaign is tagged google-pool, every 🔵 one
// microsoft-pool.
//
// Pure module, shared by the form and the job.

import type { Esp } from "./esp";
import type { CampaignRole, CreatedRole } from "@/lib/jobs/campaign-types-types";

export type Pool = "google" | "microsoft";

export const POOL_TAGS: Record<Pool, { name: string; color: string }> = {
  google: { name: "google-pool", color: "#F59E0B" },
  microsoft: { name: "microsoft-pool", color: "#3B82F6" },
};

/** The 🔵 copies: the ones that take the Microsoft side of the split. */
export const BLUE_ROLES: CreatedRole[] = ["blue", "blueOptOut", "blueSignature"];

export function isBlueRole(role: CreatedRole): boolean {
  return BLUE_ROLES.includes(role);
}

/** Which pool a campaign is in, by its role. The source is a Google campaign. */
export function poolOf(role: CampaignRole): Pool {
  return role !== "source" && isBlueRole(role) ? "microsoft" : "google";
}

/**
 * Which side each lead goes to, order kept. Microsoft and other-ESP leads to
 * the 🔵 campaigns; Google leads stay on the plain side.
 */
export function sidesFor<T>(classified: { lead: T; esp: Esp }[]): { blue: T[]; plain: T[] } {
  const blue: T[] = [];
  const plain: T[] = [];
  for (const { lead, esp } of classified) (esp === "GOOGLE" ? plain : blue).push(lead);
  return { blue, plain };
}
