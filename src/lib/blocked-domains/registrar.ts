// Which platform a domain was bought on, when the sheet does not say.
//
// The card's platform chip comes from the 📋 Domains sheet's "Domain Host"
// column. A domain missing from the sheet, or with that cell empty, used to
// show no platform at all. The registrar is public record, though: RDAP — the
// registries' own JSON replacement for WHOIS — names it for every domain,
// e.g. "Porkbun LLC" for gronda.org. It is read from there and shown the way
// the rest of the app names platforms ("porkbun"), so a domain looks the same
// whichever source it came from.
//
// The parsing and naming are pure and unit-tested; lookupRegistrar is the one
// network call.

import { findPlatformTag } from "@/lib/tags/domain-tags";
import { generalSettings } from "@/lib/general-settings/settings";

/** rdap.org redirects to whichever registry runs the domain's ending. */
const RDAP_BASE = process.env.RDAP_BASE_URL || "https://rdap.org/domain/";
const TIMEOUT_MS = 8000;

interface RdapEntity {
  roles?: unknown;
  vcardArray?: unknown;
  entities?: unknown;
}

/** The "fn" (full name) out of a jCard: ["vcard", [["fn", {}, "text", "Porkbun LLC"], …]]. */
function vcardName(vcard: unknown): string | null {
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return null;
  for (const prop of vcard[1] as unknown[]) {
    if (Array.isArray(prop) && prop[0] === "fn" && typeof prop[3] === "string" && prop[3].trim()) return prop[3].trim();
  }
  return null;
}

/** The registrar's name from an RDAP domain response, or null when it names none. */
export function registrarFromRdap(json: unknown): string | null {
  const walk = (entities: unknown, depth: number): string | null => {
    if (!Array.isArray(entities) || depth > 3) return null;
    for (const e of entities as RdapEntity[]) {
      const roles = Array.isArray(e?.roles) ? (e.roles as unknown[]).map(String) : [];
      if (roles.includes("registrar")) {
        const name = vcardName(e.vcardArray);
        if (name) return name;
      }
      const inner = walk(e?.entities, depth + 1);
      if (inner) return inner;
    }
    return null;
  };
  return walk((json as { entities?: unknown } | null)?.entities, 0);
}

/**
 * How the card names a registrar: the app's own platform name when it is one
 * of them ("Porkbun LLC" → "porkbun"), otherwise the registrar's name without
 * the company suffix ("NameCheap, Inc." → "NameCheap").
 */
export function platformLabel(registrar: string): string {
  const known = findPlatformTag(registrar, generalSettings().tags.platform);
  if (known) return known.name;
  return registrar
    .replace(/[,\s]+(llc|l\.l\.c\.|inc\.?|ltd\.?|limited|gmbh|s\.?a\.?|corp\.?|corporation|co\.?)$/i, "")
    .trim();
}

/**
 * The registrar for a domain, from RDAP. Null when the lookup fails or the
 * registry names none — the chip is context, never worth failing a run over.
 */
export async function lookupRegistrar(domain: string): Promise<string | null> {
  const d = domain.trim().toLowerCase();
  if (!d || !d.includes(".")) return null;
  try {
    const res = await fetch(`${RDAP_BASE}${encodeURIComponent(d)}`, {
      // rdap.org answers 403 to a request with Node's default user agent.
      headers: { accept: "application/rdap+json, application/json", "user-agent": "plusvibe-tools/1.0 (blocked-domains)" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return registrarFromRdap(await res.json());
  } catch {
    return null;
  }
}
