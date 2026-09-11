// Resolving a domain's "Tenant / Inbox Source" from the Tenants tab.
//
// The Domains tab gets a Tenant Email Address written into it; that email is
// looked up in the Tenants tab, and its Tenant Provider becomes the domain's
// Tenant / Inbox Source.
//
// The two tabs are expected to spell providers identically, in which case this
// copies the value straight across. They have drifted before — the Domains
// column read "CheapInboxes" while Tenants said "Cheap Inboxes" — and writing
// the Tenants spelling into a column whose dropdown doesn't offer it produces a
// cell Sheets marks invalid. So the values ALREADY in the Domains column are
// treated as the canonical vocabulary, and a provider is matched against them
// ignoring case, spaces and punctuation. When the tabs agree this changes
// nothing; when they drift again it keeps the column valid and says so.

/** Comparison key: case, spaces and separators don't distinguish providers. */
export function providerKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s._/\\-]+/g, "");
}

/** Email comparison key. Local-part case can vary; the address is the same. */
export function emailKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Builds email -> provider from the Tenants tab.
 *
 * The first row wins on a duplicate email: a later row can't quietly override
 * an earlier one, and the duplicate is reported instead.
 */
export function buildProviderByEmail(
  rows: string[][],
  iEmail: number,
  iProvider: number
): { byEmail: Map<string, string>; duplicates: string[] } {
  const byEmail = new Map<string, string>();
  const duplicates: string[] = [];

  for (let r = 1; r < rows.length; r++) {
    const email = emailKey(rows[r]?.[iEmail] ?? "");
    if (!email) continue;
    const provider = (rows[r]?.[iProvider] ?? "").trim();
    if (!provider) continue;
    if (byEmail.has(email)) {
      if (byEmail.get(email) !== provider) duplicates.push(email);
      continue;
    }
    byEmail.set(email, provider);
  }

  return { byEmail, duplicates };
}

/**
 * The vocabulary already in use in the Domains tab's Tenant / Inbox Source
 * column, keyed for comparison. Used to write the spelling that column's
 * dropdown expects rather than the Tenants tab's.
 */
export function buildSourceVocabulary(
  rows: string[][],
  iSource: number
): Map<string, string> {
  const vocab = new Map<string, string>();
  for (let r = 1; r < rows.length; r++) {
    const raw = (rows[r]?.[iSource] ?? "").trim();
    if (!raw) continue;
    const key = providerKey(raw);
    if (key && !vocab.has(key)) vocab.set(key, raw);
  }
  return vocab;
}

export interface ResolvedSource {
  /** The value to write, or null when the email has no provider. */
  value: string | null;
  /**
   * True when the Tenants spelling had to be rewritten to the Domains column's
   * own spelling — i.e. the two tabs have drifted apart.
   */
  adapted: boolean;
  /**
   * True when the provider isn't a value the Domains column already uses —
   * written as-is, but worth flagging since the dropdown may not offer it.
   */
  unknown: boolean;
}

/** Resolves one tenant email to the value to write in Tenant / Inbox Source. */
export function resolveSource(
  email: string,
  byEmail: Map<string, string>,
  vocabulary: Map<string, string>
): ResolvedSource {
  const provider = byEmail.get(emailKey(email));
  if (!provider) return { value: null, adapted: false, unknown: false };

  const canonical = vocabulary.get(providerKey(provider));
  if (!canonical) return { value: provider, adapted: false, unknown: true };

  return {
    value: canonical,
    adapted: canonical !== provider,
    unknown: false,
  };
}
