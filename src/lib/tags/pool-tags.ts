// Tagging inboxes by the provider that SENDS them: google-pool on every
// Google mailbox, microsoft-pool on every Microsoft one.
//
// The two tag names are the ones Create All Campaign Types already puts on
// campaigns, imported rather than restated — the whole point of the pools is
// that a campaign and the mailboxes that send it carry the same label, and two
// definitions would eventually drift apart.
//
// This does not just add the missing tag; it makes the pools TRUE. An inbox
// carrying the other provider's pool tag has it taken off, because a pool that
// says "these send through Google" is worth nothing if some of them send
// through Microsoft. Only that one tag is removed, and only from the inboxes
// found carrying it — everything else an inbox carries stays.
//
// Anything on neither provider is left exactly as it is: there is no third
// pool to put it in, and no way to tell whether a pool tag on a plain SMTP
// mailbox was a mistake or a decision.
//
// Pure module — no API calls — so all of it is unit-tested.

import { POOL_TAGS, type Pool } from "@/lib/campaign-types/pools";
import { bucketOf } from "@/lib/plusvibe-providers";
import type { TagInput } from "@/lib/tags/bulk-tags";
import type { InboxLite } from "@/lib/inbox-tags/plan";

export const POOLS: Pool[] = ["google", "microsoft"];

/** The two tags, in the shape the tag machinery takes — as General Settings has them now. */
export const poolTagSet = (): TagInput[] => POOLS.map((p) => ({ ...POOL_TAGS[p] }));

export const POOL_LABELS: Record<Pool, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** The pool an inbox is NOT in. */
export const otherPool = (p: Pool): Pool => (p === "google" ? "microsoft" : "google");

/** Which pool an inbox belongs to, or null when it is on neither provider. */
export function poolOfInbox(provider: string | undefined | null): Pool | null {
  const bucket = bucketOf(provider);
  return bucket === "google" || bucket === "microsoft" ? bucket : null;
}

export type PoolDecision =
  /** Gets its pool's tag. */
  | "assign"
  /** Has the other pool's tag taken off. Usually alongside "assign". */
  | "remove"
  /** Both: the wrong tag comes off and the right one goes on. */
  | "fix"
  /** Already in the right pool and no other — nothing to do. */
  | "ok"
  /** On neither provider, so there is no pool for it. */
  | "no-pool";

export interface PoolPlanRow {
  id: string;
  email: string;
  decision: PoolDecision;
  pool?: Pool;
  /** The tag it gets, when one goes on. */
  tag?: string;
  /** The tag taken off, when one comes off. */
  removes?: string;
}

export interface PoolCounts {
  /** Tags put on, per pool. */
  google: number;
  microsoft: number;
  /** Wrong pool tags taken off. */
  removed: number;
  /** Already in the right pool, with no wrong one to take off. */
  ok: number;
  /** On neither provider, so left alone. */
  noPool: number;
}

export function emptyPoolCounts(): PoolCounts {
  return { google: 0, microsoft: 0, removed: 0, ok: 0, noPool: 0 };
}

export interface PoolPlan {
  rows: PoolPlanRow[];
  /** tag id → inbox ids to put it on. */
  assignments: Map<string, string[]>;
  /** tag id → inbox ids to take it off. */
  removals: Map<string, string[]>;
  counts: PoolCounts;
}

/**
 * Which inboxes get which pool tag, and which have the wrong one taken off.
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

  const out: PoolPlan = { rows: [], assignments: new Map(), removals: new Map(), counts: emptyPoolCounts() };
  const add = (map: Map<string, string[]>, tagId: string, id: string) => {
    const list = map.get(tagId) ?? [];
    list.push(id);
    map.set(tagId, list);
  };

  for (const i of inboxes) {
    if (!i.id) continue;
    const pool = poolOfInbox(i.provider);
    if (!pool) {
      out.rows.push({ id: i.id, email: i.email, decision: "no-pool" });
      out.counts.noPool += 1;
      continue;
    }
    const mine = idOf.get(pool);
    const theirs = idOf.get(otherPool(pool));
    // The workspace has no tag of that name and none could be made: counted as
    // having no pool rather than reported as sorted.
    if (!mine) {
      out.rows.push({ id: i.id, email: i.email, decision: "no-pool", pool });
      out.counts.noPool += 1;
      continue;
    }

    const needsTag = !i.tags.includes(mine);
    const wrongTag = theirs !== undefined && theirs !== mine && i.tags.includes(theirs);

    if (!needsTag && !wrongTag) {
      out.rows.push({ id: i.id, email: i.email, decision: "ok", pool });
      out.counts.ok += 1;
      continue;
    }
    if (needsTag) {
      add(out.assignments, mine, i.id);
      out.counts[pool] += 1;
    }
    if (wrongTag) {
      add(out.removals, theirs as string, i.id);
      out.counts.removed += 1;
    }
    out.rows.push({
      id: i.id,
      email: i.email,
      decision: needsTag && wrongTag ? "fix" : needsTag ? "assign" : "remove",
      pool,
      tag: needsTag ? POOL_TAGS[pool].name : undefined,
      removes: wrongTag ? POOL_TAGS[otherPool(pool)].name : undefined,
    });
  }
  return out;
}

/** "12 google-pool · 40 microsoft-pool · 3 wrong tag removed · 6 already right" */
export function describePools(c: PoolCounts): string {
  const parts: string[] = [];
  if (c.google > 0) parts.push(`${c.google.toLocaleString()} ${POOL_TAGS.google.name}`);
  if (c.microsoft > 0) parts.push(`${c.microsoft.toLocaleString()} ${POOL_TAGS.microsoft.name}`);
  if (c.removed > 0) parts.push(`${c.removed.toLocaleString()} wrong tag removed`);
  if (c.ok > 0) parts.push(`${c.ok.toLocaleString()} already right`);
  if (c.noPool > 0) parts.push(`${c.noPool.toLocaleString()} on neither provider`);
  return parts.join(" · ") || "nothing to tag";
}
