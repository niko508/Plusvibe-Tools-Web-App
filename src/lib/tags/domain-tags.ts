// Tagging inboxes by their domain: the TLD tag (".com", ".co", …) from the
// email's domain, and the domain platform tag ("porkbun", "dynadot", …) from
// the "Domain Host" column of the 📋 Domains sheet.
//
// The two are independent. An inbox that already carries ANY tag from the
// TLD set is left alone on that side; likewise for the platform set. A domain
// missing from the sheet still gets its TLD tag, just no platform tag.
//
// Pure module — no API calls — so all of it is unit-tested.

import { normalizeDomainToken } from "@/lib/format";
import { tagKey, type TagInput } from "@/lib/tags/bulk-tags";
import type { InboxLite } from "@/lib/inbox-tags/plan";

export const DEFAULT_TLD_TAGS: TagInput[] = [
  { name: ".co", color: "#3B82F6" },
  { name: ".com", color: "#10B981" },
  { name: ".digital", color: "#F59E0B" },
  { name: ".live", color: "#8B5CF6" },
  { name: ".one", color: "#14B8A6" },
  { name: ".org", color: "#6B7280" },
  { name: ".pro", color: "#FF5733" },
];

export const DEFAULT_PLATFORM_TAGS: TagInput[] = [
  { name: "porkbun", color: "#FD4949" },
  { name: "dynadot", color: "#3341FF" },
  { name: "namesilo", color: "#88E798" },
  { name: "spaceship", color: "#562FC1" },
];

export const COL_DOMAIN = "Domain";
export const COL_DOMAIN_HOST = "Domain Host";

/** ".com" for "acme-mail.com". Null when there is no dot at all. */
export function tldOf(domain: string): string | null {
  const d = normalizeDomainToken(domain);
  if (!d) return null;
  const i = d.lastIndexOf(".");
  if (i === -1 || i === d.length - 1) return null;
  return `.${d.slice(i + 1)}`;
}

/** Tag names compare without the leading dot, so ".com" and "com" are one tag. */
export function tldKey(name: string): string {
  return tagKey(name).replace(/^\./, "");
}

export function findTldTag<T extends { name: string }>(domain: string, tlds: T[]): T | undefined {
  const tld = tldOf(domain);
  if (!tld) return undefined;
  const key = tldKey(tld);
  return tlds.find((t) => tldKey(t.name) === key);
}

/**
 * The platform tag for a "Domain Host" value. Exact name first, then a host
 * that contains the tag name ("Porkbun.com" → porkbun) or a tag name that
 * contains the host ("Name Silo" won't, but "silo" would).
 */
export function findPlatformTag<T extends { name: string }>(host: string, platforms: T[]): T | undefined {
  const h = tagKey(host);
  if (!h) return undefined;
  return (
    platforms.find((p) => tagKey(p.name) === h) ??
    platforms.find((p) => h.includes(tagKey(p.name))) ??
    platforms.find((p) => tagKey(p.name).includes(h))
  );
}

/** Case-insensitive header lookup: exact first, then contains. */
function headerIndex(header: string[], name: string): number {
  const want = name.trim().toLowerCase();
  const exact = header.findIndex((h) => String(h ?? "").trim().toLowerCase() === want);
  if (exact !== -1) return exact;
  return header.findIndex((h) => String(h ?? "").trim().toLowerCase().includes(want));
}

export interface DomainHosts {
  /** normalised domain → host, exactly as the sheet says it (trimmed). */
  hosts: Map<string, string>;
  /** Rows with a domain, whether or not they name a host. */
  rows: number;
}

/**
 * The domain → host map from the 📋 Domains grid. Throws when the two columns
 * can't be found, since guessing would tag inboxes with the wrong platform.
 */
export function parseDomainHosts(grid: string[][]): DomainHosts {
  if (grid.length === 0) throw new Error("The Domains tab is empty.");
  const header = grid[0];
  const iDomain = headerIndex(header, COL_DOMAIN);
  const iHost = headerIndex(header, COL_DOMAIN_HOST);
  const missing = [iDomain === -1 ? COL_DOMAIN : null, iHost === -1 ? COL_DOMAIN_HOST : null].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Could not find the column${missing.length === 1 ? "" : "s"} ${missing.map((m) => `"${m}"`).join(" and ")} in the Domains tab.`);
  }
  const hosts = new Map<string, string>();
  let rows = 0;
  for (let r = 1; r < grid.length; r++) {
    const domain = normalizeDomainToken(grid[r][iDomain] ?? "");
    if (!domain) continue;
    rows += 1;
    const host = String(grid[r][iHost] ?? "").trim();
    if (host && host !== "-" && host !== "–") hosts.set(domain, host);
  }
  return { hosts, rows };
}

export type TldOutcome = "assign" | "has" | "no-tag" | "no-domain";
export type PlatformOutcome = "assign" | "has" | "not-in-sheet" | "no-tag";

export interface InboxPlan {
  id: string;
  email: string;
  domain: string;
  tld: TldOutcome;
  tldTag?: string;
  platform: PlatformOutcome;
  platformTag?: string;
  host?: string;
}

export interface PlanCounts {
  tldAssign: number;
  tldHas: number;
  tldNoTag: number;
  platformAssign: number;
  platformHas: number;
  notInSheet: number;
  hostNoTag: number;
}

export interface WorkspacePlan {
  plans: InboxPlan[];
  /** tag id → inbox ids to assign it to. */
  assignments: Map<string, string[]>;
  counts: PlanCounts;
  /** TLDs seen with no tag in the set, with how many inboxes each. */
  unknownTlds: Map<string, number>;
  /** Hosts from the sheet with no tag in the set, with how many inboxes each. */
  unknownHosts: Map<string, number>;
}

/**
 * What to do with each inbox in one workspace, given that workspace's tag ids
 * for the TLD set and the platform set, and the sheet's domain → host map.
 */
export function planInboxes(
  inboxes: InboxLite[],
  tldTags: { name: string; id: string }[],
  platformTags: { name: string; id: string }[],
  hosts: Map<string, string>
): WorkspacePlan {
  const tldIds = new Set(tldTags.map((t) => t.id));
  const platformIds = new Set(platformTags.map((t) => t.id));
  const out: WorkspacePlan = {
    plans: [],
    assignments: new Map(),
    counts: { tldAssign: 0, tldHas: 0, tldNoTag: 0, platformAssign: 0, platformHas: 0, notInSheet: 0, hostNoTag: 0 },
    unknownTlds: new Map(),
    unknownHosts: new Map(),
  };
  const add = (tagId: string, inboxId: string) => {
    const list = out.assignments.get(tagId) ?? [];
    list.push(inboxId);
    out.assignments.set(tagId, list);
  };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const i of inboxes) {
    if (!i.id) continue;
    const domain = normalizeDomainToken(i.email) ?? "";
    const plan: InboxPlan = { id: i.id, email: i.email, domain, tld: "no-domain", platform: "not-in-sheet" };

    // --- TLD ---
    // A "domain" with no dot ("broken", "localhost") has no TLD to tag by.
    const tld = tldOf(domain);
    if (!domain || !tld) {
      plan.tld = "no-domain";
    } else if (i.tags.some((t) => tldIds.has(t))) {
      plan.tld = "has";
      out.counts.tldHas += 1;
    } else {
      const tag = findTldTag(domain, tldTags);
      if (tag) {
        plan.tld = "assign";
        plan.tldTag = tag.name;
        out.counts.tldAssign += 1;
        add(tag.id, i.id);
      } else {
        plan.tld = "no-tag";
        out.counts.tldNoTag += 1;
        bump(out.unknownTlds, tld);
      }
    }

    // --- Platform ---
    if (i.tags.some((t) => platformIds.has(t))) {
      plan.platform = "has";
      out.counts.platformHas += 1;
    } else {
      const host = domain ? hosts.get(domain) : undefined;
      if (!host) {
        plan.platform = "not-in-sheet";
        out.counts.notInSheet += 1;
      } else {
        plan.host = host;
        const tag = findPlatformTag(host, platformTags);
        if (tag) {
          plan.platform = "assign";
          plan.platformTag = tag.name;
          out.counts.platformAssign += 1;
          add(tag.id, i.id);
        } else {
          plan.platform = "no-tag";
          out.counts.hostNoTag += 1;
          bump(out.unknownHosts, host);
        }
      }
    }
    out.plans.push(plan);
  }
  return out;
}

/** "porkbun ×12, godaddy ×3" — the top few of a count map. */
export function topCounts(m: Map<string, number>, max = 5): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([k, n]) => `${k} ×${n}`)
    .join(", ") + (m.size > max ? `, +${m.size - max} more` : "");
}
