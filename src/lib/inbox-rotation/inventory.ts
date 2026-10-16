// What is in a workspace, and what each group gets written.
//
// An inbox is in a group by carrying that group's tag. Its kind is read from
// the provider Plusvibe reports and, for Microsoft, from how many inboxes the
// workspace has on its domain: 26 or more is Azure (50), 25 or fewer is Azure
// (25). Anything that is neither Microsoft nor Google is "other" and is left
// alone — the rotation has no settings for it.
//
// When a group is sending, its inboxes get the stage's daily sends, email
// interval and warmup; when it is not, they get a daily limit of 0 and the
// profile's resting warmup. Campaign ramp-up is switched off either way.
//
// Pure module — no API calls — so all of it is unit-tested.

import { bucketOf } from "@/lib/plusvibe-providers";
import { domainOf } from "@/lib/campaign-types/esp";
import type { InboxLite } from "@/lib/inbox-tags/plan";
import {
  INBOX_CLASSES,
  RAMP_UP_DISABLED,
  type Group,
  type InboxClass,
  type Inventory,
  type Profile,
  type ProfileKey,
  type Stage,
} from "./settings";

/** Microsoft inboxes on a domain with more than this many are Azure (50). */
export const AZURE_25_MAX = 25;

export function classifyInbox(provider: string | undefined | null, domainCount: number): InboxClass {
  const bucket = bucketOf(provider);
  if (bucket === "google") return "google";
  if (bucket === "microsoft") return domainCount > AZURE_25_MAX ? "azure50" : "azure25";
  return "other";
}

/** Inboxes per domain across the whole workspace, tagged or not. */
export function domainCounts(inboxes: { email: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of inboxes) {
    const d = domainOf(i.email);
    if (d) out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

export type GroupTagIds = Partial<Record<Group, string>>;

/** Ids to write, by group and kind. */
export type GroupIds = Record<Group, Record<InboxClass, string[]>>;

function emptyClasses<T>(make: () => T): Record<InboxClass, T> {
  return { azure50: make(), azure25: make(), google: make(), other: make() };
}

export function buildInventory(
  inboxes: InboxLite[],
  tagIds: GroupTagIds,
  fetchedAt = Date.now()
): { inventory: Inventory; ids: GroupIds } {
  const counts = domainCounts(inboxes);
  const ids: GroupIds = { 1: emptyClasses(() => []), 2: emptyClasses(() => []) };
  let untagged = 0;
  for (const i of inboxes) {
    if (!i.id) continue;
    const cls = classifyInbox(i.provider, counts.get(domainOf(i.email)) ?? 0);
    let inAny = false;
    for (const g of [1, 2] as Group[]) {
      const tag = tagIds[g];
      if (tag && i.tags.includes(tag)) {
        ids[g][cls].push(i.id);
        inAny = true;
      }
    }
    if (!inAny) untagged += 1;
  }
  const count = (g: Group) => {
    const out = emptyClasses(() => 0);
    for (const c of INBOX_CLASSES) out[c] = ids[g][c].length;
    return out;
  };
  return {
    inventory: {
      fetchedAt,
      groups: { 1: count(1), 2: count(2) },
      untagged,
      tagsFound: ([1, 2] as Group[]).filter((g) => !!tagIds[g]),
    },
    ids,
  };
}

/** Inboxes in a group, all kinds. */
export function groupTotal(inv: Inventory, g: Group): number {
  return INBOX_CLASSES.reduce((n, c) => n + (inv.groups[g]?.[c] ?? 0), 0);
}

/** The profiles that have at least one inbox in either group. */
export function profilesPresent(inv: Inventory): ProfileKey[] {
  return (["azure50", "azure25", "google"] as ProfileKey[]).filter(
    (p) => (inv.groups[1]?.[p] ?? 0) + (inv.groups[2]?.[p] ?? 0) > 0
  );
}

/**
 * What a group's inboxes of one profile are written, sending or resting. In
 * the maintaining stage the daily sends are the turn's draw, passed in.
 */
export function settingsFor(
  profile: Profile,
  stage: Stage,
  sending: boolean,
  drawnSends?: number
): Record<string, number | string> {
  if (!sending) {
    return { daily_limit: 0, warmup_max_daily_limit: profile.resting.warmupEmails, ...RAMP_UP_DISABLED };
  }
  if (stage === "maintaining") {
    const m = profile.maintaining;
    return {
      daily_limit: drawnSends ?? m.dailySendsMin,
      interval_limit_in_min: m.emailInterval,
      warmup_max_daily_limit: m.warmupEmails,
      ...RAMP_UP_DISABLED,
    };
  }
  const c = profile.cycles[stage - 1];
  return {
    daily_limit: c.dailySends,
    interval_limit_in_min: c.emailInterval,
    warmup_max_daily_limit: c.warmupEmails,
    ...RAMP_UP_DISABLED,
  };
}
