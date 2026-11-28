// Turning a workspace's inboxes into the per-person groups a signature run
// works on, with an optional tag filter.
//
// Filtering happens here, on inboxes already loaded, rather than by asking
// Plusvibe for a filtered list. Two reasons:
//
//  - The tag counts shown next to each tag come from the same pass, so you can
//    see "Active · 200 inboxes" before committing to a run rather than after.
//  - Changing the filter is instant, with no reload and no chance of applying
//    to a set that was fetched under a different filter.
//
// Pure module: no fetching, so the counting rules are unit-testable.

import type { PersonGroup } from "./types";

/** Chip value for "inboxes carrying no tags at all". */
export const UNTAGGED = "__untagged__";

/** The parts of an account this module needs. */
export interface InboxLike {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  tags?: string[];
}

export interface GroupResult {
  /** People, each with the inboxes of theirs that passed the filter. */
  groups: PersonGroup[];
  /** Inboxes in the workspace, before anything was excluded. */
  total: number;
  /** Always excluded, whatever the filter. */
  excludedMaster: number;
  /** Eligible inboxes the tag filter left out. Zero when no filter is set. */
  filteredOut: number;
  /** Passed the filter but carry no first name, so can't be personalized. */
  skippedNoName: number;
  /** Inboxes that will actually be updated. */
  matched: number;
}

/**
 * Does one inbox pass the tag filter?
 *
 * An empty filter means "everything" — that's the default, and it keeps the
 * whole-workspace behaviour the tool had before tags were selectable.
 *
 * Multiple tags are OR, not AND: picking "Active" and "New" means an inbox with
 * either. AND would silently produce an empty run for anyone who tags each
 * inbox once, which is the normal way these tags are used.
 */
export function matchesTagFilter(
  inbox: InboxLike,
  filter: ReadonlySet<string>
): boolean {
  if (filter.size === 0) return true;
  const tags = inbox.tags ?? [];
  if (filter.has(UNTAGGED) && tags.length === 0) return true;
  return tags.some((t) => filter.has(t));
}

/**
 * Groups inboxes by the person whose name they carry.
 *
 * Master Inbox exclusion comes first and is never subject to the filter — it's
 * a safety rule, not a preference, so a tag selection can't drag one back in.
 *
 * A person with inboxes both inside and outside the filter keeps only the ones
 * inside it. Their signature is built from their name either way, so updating
 * just the matched inboxes is exactly right.
 */
export function groupInboxes(
  accounts: InboxLike[],
  opts: {
    masterTagIds: ReadonlySet<string>;
    tagFilter: ReadonlySet<string>;
  }
): GroupResult {
  const byPerson = new Map<string, PersonGroup>();
  let excludedMaster = 0;
  let filteredOut = 0;
  let skippedNoName = 0;
  let matched = 0;

  for (const a of accounts) {
    if (a.tags?.some((id) => opts.masterTagIds.has(id))) {
      excludedMaster += 1;
      continue;
    }
    if (!matchesTagFilter(a, opts.tagFilter)) {
      filteredOut += 1;
      continue;
    }
    const first = (a.first_name ?? "").trim();
    const last = (a.last_name ?? "").trim();
    if (!first) {
      skippedNoName += 1;
      continue;
    }
    const key = `${first} ${last}`.trim().toLowerCase();
    let g = byPerson.get(key);
    if (!g) {
      g = { key, first, last, ids: [], emails: [] };
      byPerson.set(key, g);
    }
    if (a.id) {
      g.ids.push(a.id);
      matched += 1;
    }
    if (a.email) g.emails.push(a.email);
  }

  return {
    groups: Array.from(byPerson.values()),
    total: accounts.length,
    excludedMaster,
    filteredOut,
    skippedNoName,
    matched,
  };
}

export interface TagCounts {
  /** Updatable inboxes per tag id. */
  byTag: Map<string, number>;
  /** Updatable inboxes carrying no tags at all. */
  untagged: number;
  /** Updatable inboxes in total, across every tag and none. */
  eligible: number;
}

/**
 * How many inboxes each tag would actually update.
 *
 * Master Inboxes and inboxes with no first name are left out of every count,
 * for the same reason: the run skips both. A count that included them would be
 * a number that shrinks the moment you press Apply, which is the opposite of
 * what these are for — they exist so the right tag can be picked by size.
 */
export function countByTag(
  accounts: InboxLike[],
  masterTagIds: ReadonlySet<string>
): TagCounts {
  const byTag = new Map<string, number>();
  let untagged = 0;
  let eligible = 0;

  for (const a of accounts) {
    if (a.tags?.some((id) => masterTagIds.has(id))) continue;
    if (!(a.first_name ?? "").trim()) continue;
    eligible += 1;
    const tags = a.tags ?? [];
    if (tags.length === 0) {
      untagged += 1;
      continue;
    }
    // An inbox with two tags counts once under each — the chips are an OR, so
    // the totals are meant to overlap rather than sum to the workspace size.
    for (const t of new Set(tags)) {
      byTag.set(t, (byTag.get(t) ?? 0) + 1);
    }
  }

  return { byTag, untagged, eligible };
}
