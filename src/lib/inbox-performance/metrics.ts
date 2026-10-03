// The numbers behind Inbox Performance Monitoring.
//
// Every rate here is computed from counts over UNIQUE LEADS CONTACTED. Plusvibe
// also reports a reply_rate on each mailbox, but that divides by emails sent;
// with follow-up steps each lead is sent several emails, so it reads several
// times lower than the rate over contacts for the same replies. The reported
// field is ignored on purpose.
//
// Pure module — no clock, no API — so all of it is unit-tested.

import type { EmailStatsChartPoint, EmailStatsHeader } from "@/lib/plusvibe-types";
import { uniqueContacted } from "@/lib/format";

/** The bulk stats endpoint refuses a range longer than this. */
export const MAX_RANGE_DAYS = 90;
/** Mailbox ids per bulk stats call. */
export const BULK_CHUNK = 100;
/**
 * An inbox still pulling out-of-office replies at or above this is still
 * delivering, so it is never counted as burned however low its true rate.
 */
export const BURNED_OOO_SAFE = 1.5;

export interface InboxRates {
  sent: number;
  contacted: number;
  replies: number;
  ooo: number;
  posReplies: number;
  bounces: number;
  /** replies ÷ unique contacted, as a percentage. */
  replyRate: number;
  /** (replies + OOO) ÷ unique contacted. */
  replyRateOoo: number;
  /** positive replies ÷ replies. */
  posRate: number;
  /** bounces ÷ sent. */
  bounceRate: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number, d: number) => (d > 0 ? round2((n / d) * 100) : 0);

export function ratesFromHeader(h: EmailStatsHeader): InboxRates {
  const contacted = uniqueContacted(h);
  const replies = h.total_reply_count;
  const ooo = h.total_ooo_reply_count;
  const posReplies = h.total_pos_reply_count;
  const bounces = h.total_bounce_count;
  const sent = h.total_sent_count;
  return {
    sent,
    contacted,
    replies,
    ooo,
    posReplies,
    bounces,
    replyRate: pct(replies, contacted),
    replyRateOoo: pct(replies + ooo, contacted),
    posRate: pct(posReplies, replies),
    bounceRate: pct(bounces, sent),
  };
}

export interface Totals extends InboxRates {
  /** Inboxes summed. */
  count: number;
}

/** Sums the counts and recomputes the rates from the sums, never averaging rates. */
export function sumTotals(rates: InboxRates[]): Totals {
  const t = { sent: 0, contacted: 0, replies: 0, ooo: 0, posReplies: 0, bounces: 0 };
  for (const r of rates) {
    t.sent += r.sent;
    t.contacted += r.contacted;
    t.replies += r.replies;
    t.ooo += r.ooo;
    t.posReplies += r.posReplies;
    t.bounces += r.bounces;
  }
  return {
    ...t,
    count: rates.length,
    replyRate: pct(t.replies, t.contacted),
    replyRateOoo: pct(t.replies + t.ooo, t.contacted),
    posRate: pct(t.posReplies, t.replies),
    bounceRate: pct(t.bounces, t.sent),
  };
}

/** Burned: no real replies AND no sign of delivery either. */
export function isBurned(r: InboxRates, threshold: number, oooSafe = BURNED_OOO_SAFE): boolean {
  return r.replyRate < threshold && r.replyRateOoo < oooSafe;
}

/** Inclusive days between two YYYY-MM-DD dates; NaN when either is unreadable. */
export function rangeDays(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Why a range can't be fetched, or null when it can. */
export function rangeProblem(start: string, end: string): string | null {
  const days = rangeDays(start, end);
  if (!Number.isFinite(days)) return "Pick a start and an end date.";
  if (days < 1) return "The end date is before the start date.";
  if (days > MAX_RANGE_DAYS) {
    return `Plusvibe reports at most ${MAX_RANGE_DAYS} days at a time; this range is ${days}.`;
  }
  return null;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * One mailbox's row from the bulk endpoint, in the app's shapes.
 *
 * The chart items name the contacted count differently from the header
 * (total_new_lead_contacted_count), so it is carried across into the field
 * the rest of the app reads.
 */
export function readBulkRow(raw: Record<string, unknown>): {
  id: string;
  email: string;
  header: EmailStatsHeader;
  chart?: EmailStatsChartPoint[];
} | null {
  const id = String(raw.email_acc_id ?? raw.id ?? raw._id ?? "").trim();
  const email = String(raw.email ?? "").trim().toLowerCase();
  if (!id && !email) return null;
  const h = (raw.header ?? {}) as Record<string, unknown>;
  const header: EmailStatsHeader = {
    total_sent_count: num(h.total_sent_count),
    total_reply_count: num(h.total_reply_count),
    total_ooo_reply_count: num(h.total_ooo_reply_count),
    total_open_count: num(h.total_open_count),
    total_bounce_count: num(h.total_bounce_count),
    total_contacted_count: num(h.total_contacted_count),
    total_completed_count: num(h.total_completed_count),
    total_pos_reply_count: num(h.total_pos_reply_count),
    bounce_rate: num(h.bounce_rate),
    open_rate: num(h.open_rate),
    reply_rate: num(h.reply_rate),
    reply_rate_with_ooo: num(h.reply_rate_with_ooo),
    pos_reply_rate: num(h.pos_reply_rate),
  };
  if (h.total_unique_contacted_count != null) {
    header.total_unique_contacted_count = num(h.total_unique_contacted_count);
  }
  if (h.total_new_lead_contacted_count != null) {
    header.total_new_lead_contacted_count = num(h.total_new_lead_contacted_count);
  }
  const chart = Array.isArray(raw.chart) ? normalizeChart(raw.chart) : undefined;
  return { id, email, header, chart };
}

export function normalizeChart(raw: unknown[]): EmailStatsChartPoint[] {
  return raw
    .map((p) => {
      const c = (p ?? {}) as Record<string, unknown>;
      const date = String(c.date ?? "");
      if (!date) return null;
      return {
        label: String(c.label ?? date),
        date,
        total_sent_count: num(c.total_sent_count),
        total_reply_count: num(c.total_reply_count),
        total_ooo_reply_count: num(c.total_ooo_reply_count),
        total_open_count: num(c.total_open_count),
        total_bounce_count: num(c.total_bounce_count),
        total_contacted_count: num(c.total_contacted_count ?? c.total_new_lead_contacted_count),
        total_completed_count: num(c.total_completed_count),
        total_pos_reply_count: num(c.total_pos_reply_count),
      };
    })
    .filter((p): p is EmailStatsChartPoint => p !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Sums per-day charts into one series, by date. */
export function aggregateChart(charts: EmailStatsChartPoint[][]): EmailStatsChartPoint[] {
  const byDate = new Map<string, EmailStatsChartPoint>();
  for (const chart of charts) {
    for (const p of chart) {
      const e = byDate.get(p.date);
      if (!e) {
        byDate.set(p.date, { ...p });
        continue;
      }
      e.total_sent_count += p.total_sent_count;
      e.total_reply_count += p.total_reply_count;
      e.total_ooo_reply_count += p.total_ooo_reply_count;
      e.total_open_count += p.total_open_count;
      e.total_bounce_count += p.total_bounce_count;
      e.total_contacted_count += p.total_contacted_count;
      e.total_completed_count += p.total_completed_count;
      e.total_pos_reply_count += p.total_pos_reply_count;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
