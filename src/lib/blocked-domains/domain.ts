// Turning whatever Clay sends into a domain we can match inboxes against.
//
// The value arrives from a bounce-reason parse, so it can carry a scheme, a
// path, stray spaces (Slack and bounce text often render "trovino . click" to
// defuse the link), or a trailing dot. Everything downstream — the inbox match,
// the sheet lookup and the duplicate guard — compares normalized forms, so this
// is the single place that decides what "the same domain" means.
//
// Pure module: no I/O, so `scripts/check-blocked-domains.mjs` exercises the
// real thing.

/** A domain we're willing to act on. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Normalizes a domain, or returns null if it can't be read as one.
 *
 * Returning null rather than a best guess is deliberate: this drives deletion,
 * and a mangled value that still *looks* like a domain would scan every
 * workspace, match nothing, and log a confusing no-op. Better to reject it at
 * the webhook and say so.
 */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;

  // A whole URL, or something pasted with a scheme.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // An email address, or a leading @.
  const at = s.lastIndexOf("@");
  if (at !== -1) s = s.slice(at + 1);
  // Path, query, fragment, port.
  s = s.split(/[/?#]/)[0].split(":")[0];
  // Defanged text: "trovino . click" or "trovino[.]click".
  s = s.replace(/\s*\[\s*\.\s*\]\s*/g, ".").replace(/\s+/g, "");
  // Trailing dot (a fully-qualified root).
  s = s.replace(/\.+$/, "");
  // Doubled dots are deliberately NOT collapsed. "lavasi..pro" is a typo, and
  // quietly repairing it into a real domain is how the wrong inboxes get
  // deleted — the regex below rejects it instead.

  if (!s || s.length > 253) return null;
  return DOMAIN_RE.test(s) ? s : null;
}

/** The domain part of an email address, normalized the same way. */
export function domainOfEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return normalizeDomain(email.slice(at + 1));
}

/**
 * Whether an inbox belongs to the blocked domain.
 *
 * Exact match only — these domains never have subdomains, and matching by
 * suffix would let a block on "example.com" take out "mail.example.com" and
 * anything else that merely ends the same way.
 */
export function inboxIsOnDomain(email: unknown, domain: string): boolean {
  const d = domainOfEmail(email);
  return d !== null && d === domain;
}
