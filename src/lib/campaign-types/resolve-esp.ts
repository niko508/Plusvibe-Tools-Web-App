import "server-only";

import { promises as dns } from "dns";
import {
  classifyMx,
  classifyProviderField,
  domainOf,
  type Esp,
} from "./esp";
import type { RawLead } from "@/lib/plusvibe-leads";

// Resolves each lead's mailbox provider.
//
// Plusvibe doesn't document a provider field on leads, so this checks the lead
// for one (free, exact) and falls back to an MX lookup on its domain. Lookups
// are per-DOMAIN and cached, so 20k leads across ~3k domains costs ~3k queries,
// not 20k — and re-running a resumed job re-uses the same cache.
//
// DNS is not Plusvibe, so these do NOT go through the Plusvibe rate limiter;
// they have their own concurrency cap instead.

const DNS_CONCURRENCY = 20;
const DNS_TIMEOUT_MS = 5000;

// Fields a lead might plausibly carry the provider in.
const PROVIDER_FIELDS = ["provider", "esp", "email_provider", "recp_provider"];

export interface EspResolution {
  microsoft: RawLead[];
  other: RawLead[];
  /** Domains whose MX lookup failed outright (treated as OTHER). */
  unresolvedDomains: string[];
  /** How many leads were classified from a field rather than DNS. */
  fromLeadField: number;
  domainsLookedUp: number;
}

/** Per-run domain → ESP cache. */
export type EspCache = Map<string, Esp>;

export function newEspCache(): EspCache {
  return new Map();
}

async function resolveMxWithTimeout(domain: string): Promise<string[] | null> {
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS)
      ),
    ]);
    return records.map((r) => r.exchange);
  } catch (err) {
    // NODATA/NOTFOUND are answers, not failures: the domain genuinely has no
    // MX, so it classifies as OTHER. Anything else is a real lookup failure
    // worth surfacing, because it means the classification is a guess.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    return null;
  }
}

/**
 * Splits leads into the Microsoft bucket and everything else.
 *
 * `onProgress` is called as domains resolve so a long classification phase can
 * show live progress rather than appearing to hang.
 */
export async function resolveLeadEsps(
  leads: RawLead[],
  opts: {
    cache?: EspCache;
    isAborted?: () => boolean;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<EspResolution> {
  const cache = opts.cache ?? newEspCache();
  const isAborted = opts.isAborted ?? (() => false);

  // Pass 1: anything the lead already tells us, plus the domain work list.
  const fieldEsp = new Map<RawLead, Esp>();
  const needed = new Set<string>();

  for (const lead of leads) {
    let esp: Esp | null = null;
    for (const f of PROVIDER_FIELDS) {
      esp = classifyProviderField(lead[f]);
      if (esp) break;
    }
    if (esp) {
      fieldEsp.set(lead, esp);
      continue;
    }
    const domain = domainOf(String(lead.email ?? ""));
    if (domain && !cache.has(domain)) needed.add(domain);
  }

  // Pass 2: resolve the domains we still don't know, capped concurrency.
  const domains = [...needed];
  const unresolvedDomains: string[] = [];
  let done = 0;
  let cursor = 0;

  const worker = async () => {
    while (true) {
      if (isAborted()) return;
      const domain = domains[cursor++];
      if (domain === undefined) return;
      const exchanges = await resolveMxWithTimeout(domain);
      if (exchanges === null) {
        unresolvedDomains.push(domain);
        cache.set(domain, "OTHER");
      } else {
        cache.set(domain, classifyMx(exchanges));
      }
      opts.onProgress?.(++done, domains.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DNS_CONCURRENCY, domains.length) }, worker)
  );

  // Pass 3: bucket.
  const microsoft: RawLead[] = [];
  const other: RawLead[] = [];
  for (const lead of leads) {
    const esp =
      fieldEsp.get(lead) ??
      cache.get(domainOf(String(lead.email ?? ""))) ??
      "OTHER";
    if (esp === "MICROSOFT") microsoft.push(lead);
    else other.push(lead);
  }

  return {
    microsoft,
    other,
    unresolvedDomains,
    fromLeadField: fieldEsp.size,
    domainsLookedUp: domains.length,
  };
}
