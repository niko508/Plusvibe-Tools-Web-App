// What counts as burned, per ESP.
//
// Two numbers decide it, and they are kept PER PROVIDER because Google and
// Microsoft are judged at different levels and rarely want the same bars:
//
//   Minimum sends   below this there is nothing to judge — one reply out of
//                   twelve reads as 8%, which is noise, not health
//   Reply % (OOO)   replies INCLUDING out-of-office, over unique leads
//                   contacted. This is the figure that says "these are still
//                   landing in inboxes people read": a mailbox whose only
//                   answers are auto-replies is still delivering, and one
//                   that has stopped pulling even those is burned
//
// Each provider's pair is saved and comes back as what the form starts on,
// until it is edited again.
//
// Pure module — the file on disk is store.ts — so all of it is unit-tested
// and the form can import it.

export type Esp = "google" | "microsoft";

export const ESPS: Esp[] = ["google", "microsoft"];

export const ESP_LABELS: Record<Esp, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/**
 * What a run looks at for each provider.
 *
 * Google is judged INBOX by inbox: Google mailboxes burn one at a time, and a
 * domain's average hides the ones that have. Microsoft is judged by DOMAIN,
 * the way this tool always has — a Microsoft tenant's mailboxes go together.
 */
export type Level = "inbox" | "domain";

export const LEVEL_OF: Record<Esp, Level> = {
  google: "inbox",
  microsoft: "domain",
};

export function levelOf(esp: Esp): Level {
  return LEVEL_OF[esp];
}

/** What a row IS, for the labels: "inbox"/"inboxes" or "domain"/"domains". */
export const NOUNS: Record<Level, { one: string; many: string }> = {
  inbox: { one: "inbox", many: "inboxes" },
  domain: { one: "domain", many: "domains" },
};

/** "1 inbox", "11 inboxes" — an -s plural would say "inboxs". */
export function countNoun(n: number, esp: Esp): string {
  const noun = NOUNS[levelOf(esp)];
  return `${n.toLocaleString()} ${n === 1 ? noun.one : noun.many}`;
}

export function isEsp(v: unknown): v is Esp {
  return v === "google" || v === "microsoft";
}

export interface Thresholds {
  /** Emails sent in the window, below which the row is not judged. */
  minSends: number;
  /** Reply rate including out-of-office, in percent. Below this is burned. */
  replyOooPct: number;
}

/**
 * The bars this app already uses elsewhere: 1% per inbox, 1.5% per domain —
 * the same pair the Blocked Domains automation decides on. 100 sends is the
 * point at which a percentage starts meaning something.
 */
export const DEFAULT_THRESHOLDS: Record<Esp, Thresholds> = {
  google: { minSends: 100, replyOooPct: 1 },
  microsoft: { minSends: 100, replyOooPct: 1.5 },
};

export interface BurnedSettings {
  thresholds: Record<Esp, Thresholds>;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: BurnedSettings = {
  thresholds: { google: { ...DEFAULT_THRESHOLDS.google }, microsoft: { ...DEFAULT_THRESHOLDS.microsoft } },
  updatedAt: 0,
};

export const MAX_MIN_SENDS = 1_000_000;

/** A whole number of sends, 0 up. Returns the problem, in words, when it isn't. */
export function parseMinSends(raw: unknown): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, error: "Minimum sends: enter a number." };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: "Minimum sends: enter a number." };
  if (!Number.isInteger(n)) return { value: null, error: "Minimum sends: use a whole number." };
  if (n < 0) return { value: null, error: "Minimum sends: can't be negative." };
  if (n > MAX_MIN_SENDS) return { value: null, error: `Minimum sends: ${MAX_MIN_SENDS.toLocaleString()} is the most.` };
  return { value: n };
}

/** A percentage from 0 to 100, fractions allowed. */
export function parseReplyPct(raw: unknown): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, error: "Reply % (OOO): enter a percentage." };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: "Reply % (OOO): enter a percentage." };
  if (n < 0) return { value: null, error: "Reply % (OOO): can't be negative." };
  if (n > 100) return { value: null, error: "Reply % (OOO): must be 100 or less." };
  return { value: Math.round(n * 100) / 100 };
}

/** Problems with one provider's pair, in reading order. Empty when they can be saved. */
export function validateThresholds(raw: { minSends?: unknown; replyOooPct?: unknown }): string[] {
  const problems: string[] = [];
  const sends = parseMinSends(raw.minSends);
  if (sends.error) problems.push(sends.error);
  const pct = parseReplyPct(raw.replyOooPct);
  if (pct.error) problems.push(pct.error);
  return problems;
}

/** Whatever was given, as thresholds; anything unreadable falls back to the default. */
export function normalizeThresholds(raw: unknown, esp: Esp): Thresholds {
  const r = (raw ?? {}) as { minSends?: unknown; replyOooPct?: unknown };
  const sends = parseMinSends(r.minSends);
  const pct = parseReplyPct(r.replyOooPct);
  return {
    minSends: sends.value ?? DEFAULT_THRESHOLDS[esp].minSends,
    replyOooPct: pct.value ?? DEFAULT_THRESHOLDS[esp].replyOooPct,
  };
}

/** Whatever was stored, as settings: a bad or missing half reads as the default. */
export function normalizeSettings(raw: Partial<BurnedSettings> | null | undefined): BurnedSettings {
  const r = raw ?? {};
  const stored = (r.thresholds ?? {}) as Record<string, unknown>;
  return {
    thresholds: {
      google: normalizeThresholds(stored.google, "google"),
      microsoft: normalizeThresholds(stored.microsoft, "microsoft"),
    },
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

/** "Google inboxes · under 1% reply (OOO) on 100+ sends" */
export function describeThresholds(esp: Esp, t: Thresholds): string {
  const what = levelOf(esp) === "inbox" ? "inboxes" : "domains";
  return `${ESP_LABELS[esp]} ${what} · under ${t.replyOooPct}% reply (OOO) on ${t.minSends.toLocaleString()}+ sends`;
}
