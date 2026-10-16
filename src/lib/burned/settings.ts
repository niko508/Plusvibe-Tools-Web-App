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
//   Reply %         real replies, out-of-office NOT counted. At or above this
//                   the row is kept whatever the OOO figure says: something
//                   people are actually answering is not burned, however few
//                   auto-replies come back with it
//
// Note the two rates are not independent: the OOO figure adds auto-replies to
// the same numerator, so the true rate can never be the higher of the two.
// That means the Reply % rescue only ever changes an outcome while it is set
// BELOW the Reply % (OOO) bar — rescueImpossible() says so, and the form
// passes it on rather than leaving someone to wonder why nothing changed.
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
  /**
   * True reply rate, out-of-office excluded. At or above this the row is kept
   * however low the OOO figure is.
   */
  replyPct: number;
}

/**
 * The bars this app already uses elsewhere: 1% per inbox, 1.5% per domain —
 * the same pair the Blocked Domains automation decides on. 100 sends is the
 * point at which a percentage starts meaning something.
 */
export const DEFAULT_THRESHOLDS: Record<Esp, Thresholds> = {
  google: { minSends: 100, replyOooPct: 1, replyPct: 0.5 },
  microsoft: { minSends: 100, replyOooPct: 1.5, replyPct: 0.5 },
};

export interface BurnedSettings {
  thresholds: Record<Esp, Thresholds>;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: BurnedSettings = {
  thresholds: { google: { ...DEFAULT_THRESHOLDS.google }, microsoft: { ...DEFAULT_THRESHOLDS.microsoft } },
  updatedAt: 0,
};

/**
 * True when the Reply % rescue can never fire, because it sits at or above
 * the OOO bar and the true rate can never be the higher of the two.
 */
export function rescueImpossible(t: { replyPct: number; replyOooPct: number }): boolean {
  return t.replyPct >= t.replyOooPct;
}

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

/** A percentage from 0 to 100, fractions allowed. The label names it in the problem. */
export function parsePercent(raw: unknown, label: string): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, error: `${label}: enter a percentage.` };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: `${label}: enter a percentage.` };
  if (n < 0) return { value: null, error: `${label}: can't be negative.` };
  if (n > 100) return { value: null, error: `${label}: must be 100 or less.` };
  return { value: Math.round(n * 100) / 100 };
}

export function parseReplyOooPct(raw: unknown) {
  return parsePercent(raw, "Reply % (OOO)");
}

export function parseReplyPct(raw: unknown) {
  return parsePercent(raw, "Reply %");
}

/** Problems with one provider's bars, in reading order. Empty when they can be saved. */
export function validateThresholds(raw: { minSends?: unknown; replyOooPct?: unknown; replyPct?: unknown }): string[] {
  const problems: string[] = [];
  const sends = parseMinSends(raw.minSends);
  if (sends.error) problems.push(sends.error);
  const ooo = parseReplyOooPct(raw.replyOooPct);
  if (ooo.error) problems.push(ooo.error);
  const real = parseReplyPct(raw.replyPct);
  if (real.error) problems.push(real.error);
  return problems;
}

/**
 * Whatever was given, as thresholds; anything unreadable falls back to the
 * default. A record written before the Reply % rescue existed has no
 * `replyPct`, and reads as that provider's default.
 */
export function normalizeThresholds(raw: unknown, esp: Esp): Thresholds {
  const r = (raw ?? {}) as { minSends?: unknown; replyOooPct?: unknown; replyPct?: unknown };
  const sends = parseMinSends(r.minSends);
  const ooo = parseReplyOooPct(r.replyOooPct);
  const real = parseReplyPct(r.replyPct);
  return {
    minSends: sends.value ?? DEFAULT_THRESHOLDS[esp].minSends,
    replyOooPct: ooo.value ?? DEFAULT_THRESHOLDS[esp].replyOooPct,
    replyPct: real.value ?? DEFAULT_THRESHOLDS[esp].replyPct,
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

/** "Google inboxes · under 1% reply (OOO) and under 0.5% reply on 100+ sends" */
export function describeThresholds(esp: Esp, t: Thresholds): string {
  const what = levelOf(esp) === "inbox" ? "inboxes" : "domains";
  return `${ESP_LABELS[esp]} ${what} · under ${t.replyOooPct}% reply (OOO) and under ${t.replyPct}% reply on ${t.minSends.toLocaleString()}+ sends`;
}
