// Tagging inboxes by the provider that SENDS them: google-pool on every
// Google mailbox, microsoft-pool on every Microsoft one.
//
// The two tag names are the ones Create All Campaign Types already puts on
// campaigns, imported rather than restated — the whole point of the pools is
// that a campaign and the mailboxes that send it carry the same label, and two
// definitions would eventually drift apart.
//
// An inbox carrying EITHER pool tag is left alone, whichever one it is. An
// inbox moved between pools by hand has been put there on purpose, and a job
// that quietly corrected it would undo somebody's decision without saying so.
// Anything on neither provider gets no pool: there is no third pool to put it
// in, and guessing would be worse than leaving it.
//
// Pure module — no API calls — so all of it is unit-tested.

import { POOL_TAGS, type Pool } from "@/lib/campaign-types/pools";
import { bucketOf } from "@/lib/plusvibe-providers";
import type { TagInput } from "@/lib/tags/bulk-tags";
import type { InboxLite } from "@/lib/inbox-tags/plan";

export const POOLS: Pool[] = ["google", "microsoft"];

/** The two tags, in the shape the tag machinery takes. */
export const POOL_TAG_SET: TagInput[] = POOLS.map((p) => ({ ...POOL_TAGS[p] }));

export const POOL_LABELS: Record<Pool, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** Which pool an inbox belongs to, or null when it is on neither provider. */
export function poolOfInbox(provider: string | undefined | null): Pool | null {
  const bucket = bucketOf(provider);
  return bucket === "google" || bucket === "microsoft" ? bucket : null;
}

export type PoolDecision =
  /** Gets its pool tag. */
  | "assign"
  /** Already carries a pool tag — either one — so it is left alone. */
  | "has"
  /** On neither provider, so there is no pool for it. */
  | "no-pool";

export interface PoolPlanRow {
  id: string;
  email: string;
  decision: PoolDecision;
  pool?: Pool;
  /** The tag it would get. */
  tag?: string;
}

export interface PoolCounts {
  google: number;
  microsoft: number;
  /** Already carried a pool tag. */
  has: number;
  /** On neither provider. */
  noPool: number;
}

export function emptyPoolCounts(): PoolCounts {
  return { google: 0, microsoft: 0, has: 0, noPool: 0 };
}

export interface PoolPlan {
  rows: PoolPlanRow[];
  /** tag id → inbox ids to put it on. */
  assignments: Map<string, string[]>;
  counts: PoolCounts;
}

/**
 * Which inboxes get which pool tag.
 *
 * `poolTags` is the workspace's own two tags, already found or created, so the
 * ids are the ones this workspace uses — tag ids are per workspace, and one
 * from another would silently assign nothing.
 */
export function planPools(
  inboxes: InboxLite[],
  poolTags: { name: string; id: string }[]
): PoolPlan {
  const idOf = new Map<Pool, string>();
  for (const p of POOLS) {
    const found = poolTags.find((t) => t.name.trim().toLowerCase() === POOL_TAGS[p].name);
    if (found) idOf.set(p, found.id);
  }
  // Any pool tag at all counts as "already sorted", not just the matching one.
  const poolIds = new Set(idOf.values());

  const out: PoolPlan = { rows: [], assignments: new Map(), counts: emptyPoolCounts() };
  for (const i of inboxes) {
    if (!i.id) continue;
    const pool = poolOfInbox(i.provider);
    if (!pool) {
      out.rows.push({ id: i.id, email: i.email, decision: "no-pool" });
      out.counts.noPool += 1;
      continue;
    }
    if (i.tags.some((t) => poolIds.has(t))) {
      out.rows.push({ id: i.id, email: i.email, decision: "has", pool });
      out.counts.has += 1;
      continue;
    }
    const tagId = idOf.get(pool);
    if (!tagId) {
      // The workspace has no such tag and none could be made; counted as
      // having no pool rather than reported as assigned.
      out.rows.push({ id: i.id, email: i.email, decision: "no-pool", pool });
      out.counts.noPool += 1;
      continue;
    }
    out.rows.push({ id: i.id, email: i.email, decision: "assign", pool, tag: POOL_TAGS[pool].name });
    out.counts[pool] += 1;
    const list = out.assignments.get(tagId) ?? [];
    list.push(i.id);
    out.assignments.set(tagId, list);
  }
  return out;
}

/** "12 google-pool · 40 microsoft-pool · 6 already · 2 on neither" */
export function describePools(c: PoolCounts): string {
  const parts: string[] = [];
  if (c.google > 0) parts.push(`${c.google.toLocaleString()} ${POOL_TAGS.google.name}`);
  if (c.microsoft > 0) parts.push(`${c.microsoft.toLocaleString()} ${POOL_TAGS.microsoft.name}`);
  if (c.has > 0) parts.push(`${c.has.toLocaleString()} already tagged`);
  if (c.noPool > 0) parts.push(`${c.noPool.toLocaleString()} on neither provider`);
  return parts.join(" · ") || "nothing to tag";
}
