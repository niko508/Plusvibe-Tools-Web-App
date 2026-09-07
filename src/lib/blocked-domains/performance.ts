// Deciding which of a blocked domain's inboxes actually have to be stopped.
//
// A blocked sending domain used to mean every inbox on it went to daily limit
// 0. That throws away inboxes that are still producing replies. Instead each
// inbox's last 7 days are read and only the ones under the reply-rate bar are
// stopped.
//
// The bar is REPLY RATE WITH OOO, as a percentage, because that's the figure
// that says "people are still receiving and answering this" — an inbox whose
// only answers are out-of-office replies is still landing.
//
// Everything here errs towards stopping. The domain is blocked; keeping an
// inbox sending is the exception that has to be earned with evidence, so an
// inbox with no stats, no sends, or an unreadable figure is stopped.
//
// Pure module — no API calls — so all of it is unit-tested.

export const DEFAULT_MIN_REPLY_RATE_OOO = 1;

export type InboxDecision = "stop" | "keep";

/** Why an inbox was stopped or kept, in the words the card shows. */
export type DecisionReason =
  /** Reply rate with OOO is at or above the bar. */
  | "performing"
  /** Below the bar. */
  | "under-bar"
  /** Sent nothing in the window, so there is nothing to judge it on. */
  | "no-sends"
  /** Plusvibe returned no figures for this inbox. */
  | "no-stats"
  /** The performance check was off, or stats could not be read at all. */
  | "not-checked";

export interface InboxStats {
  /** The account id, as Plusvibe knows it. */
  id: string;
  email: string;
  sent: number;
  replies: number;
  oooReplies: number;
  /** Percentages, as the API reports them: 7.5 means 7.5%. */
  replyRate: number;
  replyRateOoo: number;
}

export interface InboxAssessment {
  id: string;
  email: string;
  decision: InboxDecision;
  reason: DecisionReason;
  sent?: number;
  replyRate?: number;
  replyRateOoo?: number;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * One mailbox's figures from a stats payload.
 *
 * The per-mailbox and bulk endpoints disagree on shape — the bulk rows carry
 * their numbers under `header`, the single-account call returns `header` at the
 * top — so both are accepted, and the ids come as `email_acc_id`, `id` or
 * `_id` depending on which is answering.
 */
export function readStatsRow(raw: Record<string, unknown>): InboxStats | null {
  const header = (raw.header ?? raw) as Record<string, unknown>;
  const id = String(raw.email_acc_id ?? raw.id ?? raw._id ?? "").trim();
  const email = String(raw.email ?? "").trim().toLowerCase();
  if (!id && !email) return null;
  return {
    id,
    email,
    sent: num(header.total_sent_count),
    replies: num(header.total_reply_count),
    oooReplies: num(header.total_ooo_reply_count),
    replyRate: num(header.reply_rate),
    replyRateOoo: num(header.reply_rate_with_ooo),
  };
}

/** Indexes stats by account id AND by address, since either may be missing. */
export function indexStats(rows: InboxStats[]): Map<string, InboxStats> {
  const byKey = new Map<string, InboxStats>();
  for (const r of rows) {
    if (r.id) byKey.set(r.id, r);
    if (r.email) byKey.set(r.email, r);
  }
  return byKey;
}

export function statsFor(
  inbox: { id: string; email: string },
  index: Map<string, InboxStats>
): InboxStats | undefined {
  return index.get(inbox.id) ?? index.get(inbox.email.trim().toLowerCase());
}

/**
 * Stop or keep one inbox.
 *
 * `minReplyRateOoo` is the bar in percent: at or above it the inbox keeps
 * sending. Below it — including an inbox that sent nothing, or that Plusvibe
 * has no figures for — it is stopped.
 */
export function assessInbox(
  inbox: { id: string; email: string },
  stats: InboxStats | undefined,
  minReplyRateOoo: number
): InboxAssessment {
  const base = { id: inbox.id, email: inbox.email };
  if (!stats) return { ...base, decision: "stop", reason: "no-stats" };
  const common = { sent: stats.sent, replyRate: stats.replyRate, replyRateOoo: stats.replyRateOoo };
  if (stats.sent <= 0) return { ...base, ...common, decision: "stop", reason: "no-sends" };
  if (stats.replyRateOoo >= minReplyRateOoo) {
    return { ...base, ...common, decision: "keep", reason: "performing" };
  }
  return { ...base, ...common, decision: "stop", reason: "under-bar" };
}

export interface QuarantinePlan {
  assessments: InboxAssessment[];
  stop: { id: string; email: string }[];
  keep: { id: string; email: string }[];
}

export function planQuarantine<T extends { id: string; email: string }>(
  inboxes: T[],
  index: Map<string, InboxStats>,
  minReplyRateOoo: number
): QuarantinePlan {
  const assessments = inboxes.map((i) => assessInbox(i, statsFor(i, index), minReplyRateOoo));
  const byId = new Map(inboxes.map((i) => [i.id, i]));
  const pick = (d: InboxDecision) =>
    assessments.filter((a) => a.decision === d).map((a) => byId.get(a.id) as T).filter(Boolean);
  return { assessments, stop: pick("stop"), keep: pick("keep") };
}

/**
 * The plan when no check was made — the check is off, or the stats could not
 * be read. Everything is stopped, which is what the automation did before the
 * check existed.
 */
export function stopEverything<T extends { id: string; email: string }>(inboxes: T[]): QuarantinePlan {
  return {
    assessments: inboxes.map((i) => ({ id: i.id, email: i.email, decision: "stop" as const, reason: "not-checked" as const })),
    stop: [...inboxes],
    keep: [],
  };
}

/** The bar, sanitised: a percentage between 0 and 100. */
export function normalizeThreshold(raw: unknown): number {
  // Blank must NOT read as 0 — Number("") is 0, and a bar of 0 would keep
  // every inbox on a blocked domain sending. Missing means "use the default".
  if (typeof raw !== "number") {
    const text = String(raw ?? "").trim();
    if (text === "") return DEFAULT_MIN_REPLY_RATE_OOO;
    raw = Number(text);
  }
  const n = raw as number;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_REPLY_RATE_OOO;
  return Math.min(100, n);
}

export const REASON_LABELS: Record<DecisionReason, string> = {
  performing: "replying — left alone",
  "under-bar": "under the bar — stopped",
  "no-sends": "nothing sent in the window — stopped",
  "no-stats": "no figures from Plusvibe — stopped",
  "not-checked": "not checked — stopped",
};

/** "3 stopped, 2 left sending" */
export function describePlan(plan: QuarantinePlan): string {
  const n = plan.stop.length;
  const k = plan.keep.length;
  return `${n} stopped${k > 0 ? `, ${k} left sending` : ""}`;
}
