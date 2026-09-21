// Turning a workspace's inboxes and their stats into rows to judge.
//
// Google is judged inbox by inbox, Microsoft domain by domain, so the two
// produce the same row shape from different groupings and everything
// downstream — the verdict, the table, the CSV, the copy — is shared.
//
// Rates are replies over UNIQUE LEADS CONTACTED, matching the rest of the
// app. Plusvibe's own reply_rate divides by emails sent, and with follow-up
// steps each lead gets several emails, so that figure runs several times
// lower for the same replies. The reported rate is used only when no
// contacted count came back to divide by.
//
// Pure module — no API calls — so all of it is unit-tested.

import { aggregateDomain, inboxRates, statsFor, type InboxStats } from "@/lib/blocked-domains/performance";
import { domainOf } from "@/lib/campaign-types/esp";
import { levelOf, type Esp, type Thresholds } from "./settings";

export type Verdict =
  /** Under the reply bar with enough sends to mean it. */
  | "burned"
  /** At or above the bar. */
  | "ok"
  /** Not judged: too few sends, or no figures at all. */
  | "quiet";

export type QuietReason = "few-sends" | "no-figures";

export interface ScanRow {
  /**
   * Kept because its TRUE reply rate cleared the bar, even though the OOO
   * figure was under its own. Worth saying: the row would otherwise read as
   * one the bar missed.
   */
  rescued?: true;
  workspaceId: string;
  workspaceName: string;
  /** The inbox address, or the domain — whichever this run judges. */
  name: string;
  /** The sending domain either way, so a burned inbox says where it lives. */
  domain: string;
  /** 1 for an inbox row; the domain's mailbox count for a domain row. */
  inboxes: number;
  sent: number;
  contacted: number;
  replies: number;
  oooReplies: number;
  /** Percentages over unique leads contacted. */
  replyRate: number;
  replyRateOoo: number;
  verdict: Verdict;
  reason?: QuietReason;
}

export interface InboxLike {
  id: string;
  email: string;
  provider?: string;
}

/**
 * Burned, fine, or not worth judging.
 *
 * Two bars have to be under for a row to be burned. The OOO figure is the
 * usual signal, but real replies overrule it: something people are actually
 * answering is not burned, however few auto-replies come back with it. That
 * rescue only ever changes an outcome while the Reply % bar sits below the
 * OOO one, since the OOO rate counts the same replies plus more.
 *
 * A row with no figures at all is never called burned: this tool reports, and
 * naming a domain burned on no evidence would have someone replace one that
 * was never sending in the first place.
 */
export function judge(
  row: { sent: number; replyRate: number; replyRateOoo: number; hasFigures: boolean },
  t: Thresholds
): { verdict: Verdict; reason?: QuietReason; rescued?: true } {
  if (!row.hasFigures) return { verdict: "quiet", reason: "no-figures" };
  if (row.sent < t.minSends) return { verdict: "quiet", reason: "few-sends" };
  if (row.replyRateOoo >= t.replyOooPct) return { verdict: "ok" };
  if (row.replyRate >= t.replyPct) return { verdict: "ok", rescued: true };
  return { verdict: "burned" };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** One row per inbox — how Google is judged. */
export function rowsForInboxes(
  ws: { workspaceId: string; workspaceName: string },
  inboxes: InboxLike[],
  index: Map<string, InboxStats>,
  t: Thresholds
): ScanRow[] {
  return inboxes.map((inbox) => {
    const stats = statsFor(inbox, index);
    const rates = stats ? inboxRates(stats) : { replyRate: 0, replyRateOoo: 0 };
    const base = {
      ...ws,
      name: inbox.email,
      domain: domainOf(inbox.email),
      inboxes: 1,
      sent: stats?.sent ?? 0,
      contacted: stats?.contacted ?? 0,
      replies: stats?.replies ?? 0,
      oooReplies: stats?.oooReplies ?? 0,
      replyRate: round(rates.replyRate),
      replyRateOoo: round(rates.replyRateOoo),
    };
    return { ...base, ...judge({ sent: base.sent, replyRate: base.replyRate, replyRateOoo: base.replyRateOoo, hasFigures: !!stats }, t) };
  });
}

/**
 * One row per domain — how Microsoft is judged.
 *
 * Summed across the domain's inboxes rather than averaged: a mailbox that
 * sent five emails and got a reply must not outweigh one that sent five
 * hundred and got none.
 */
export function rowsForDomains(
  ws: { workspaceId: string; workspaceName: string },
  inboxes: InboxLike[],
  index: Map<string, InboxStats>,
  t: Thresholds
): ScanRow[] {
  const byDomain = new Map<string, InboxLike[]>();
  for (const inbox of inboxes) {
    const domain = domainOf(inbox.email);
    if (!domain) continue;
    const list = byDomain.get(domain);
    if (list) list.push(inbox);
    else byDomain.set(domain, [inbox]);
  }

  const rows: ScanRow[] = [];
  for (const [domain, list] of byDomain) {
    const stats = list.map((i) => statsFor(i, index)).filter((s): s is InboxStats => !!s);
    const agg = aggregateDomain(stats, t.replyOooPct);
    const base = {
      ...ws,
      name: domain,
      domain,
      inboxes: list.length,
      sent: agg.sent,
      contacted: agg.contacted,
      replies: agg.replies,
      oooReplies: agg.oooReplies,
      replyRate: round(agg.replyRate),
      replyRateOoo: round(agg.replyRateOoo),
    };
    rows.push({ ...base, ...judge({ sent: base.sent, replyRate: base.replyRate, replyRateOoo: base.replyRateOoo, hasFigures: agg.basis !== "none" }, t) });
  }
  return rows;
}

/** The rows for one workspace, grouped the way this provider is judged. */
export function rowsFor(
  esp: Esp,
  ws: { workspaceId: string; workspaceName: string },
  inboxes: InboxLike[],
  index: Map<string, InboxStats>,
  t: Thresholds
): ScanRow[] {
  return levelOf(esp) === "inbox" ? rowsForInboxes(ws, inboxes, index, t) : rowsForDomains(ws, inboxes, index, t);
}

export interface ScanCounts {
  scanned: number;
  burned: number;
  ok: number;
  /** Of the ok ones, those the true reply rate saved from the OOO bar. */
  rescued: number;
  /** Too few sends to judge. */
  fewSends: number;
  /** No figures from Plusvibe at all. */
  noFigures: number;
}

export function countRows(rows: ScanRow[]): ScanCounts {
  const c: ScanCounts = { scanned: rows.length, burned: 0, ok: 0, rescued: 0, fewSends: 0, noFigures: 0 };
  for (const r of rows) {
    if (r.verdict === "burned") c.burned += 1;
    else if (r.verdict === "ok") {
      c.ok += 1;
      if (r.rescued) c.rescued += 1;
    } else if (r.reason === "few-sends") c.fewSends += 1;
    else c.noFigures += 1;
  }
  return c;
}

/** Burned first, worst reply rate first, then by workspace and name. */
export function sortRows(rows: ScanRow[]): ScanRow[] {
  const rank = { burned: 0, ok: 1, quiet: 2 } as const;
  return [...rows].sort(
    (a, b) =>
      rank[a.verdict] - rank[b.verdict] ||
      a.replyRateOoo - b.replyRateOoo ||
      b.sent - a.sent ||
      a.workspaceName.localeCompare(b.workspaceName) ||
      a.name.localeCompare(b.name)
  );
}

// --- What comes out ----------------------------------------------------------

/** The burned names, one per line — what the copy button puts on the clipboard. */
export function copyText(rows: ScanRow[]): string {
  return rows.map((r) => r.name).join("\n");
}

/** The verdict in words, for the CSV and the table's tooltip. */
export function verdictText(r: ScanRow): string {
  if (r.verdict === "quiet") return r.reason === "few-sends" ? "too few sends" : "no figures";
  if (r.rescued) return "ok — still getting real replies";
  return r.verdict;
}

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADERS = [
  "workspace",
  "name",
  "domain",
  "inboxes",
  "sent",
  "contacted",
  "replies",
  "ooo_replies",
  "reply_rate",
  "reply_rate_ooo",
  "verdict",
];

export function toCsv(rows: ScanRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.workspaceName,
        r.name,
        r.domain,
        r.inboxes,
        r.sent,
        r.contacted,
        r.replies,
        r.oooReplies,
        r.replyRate,
        r.replyRateOoo,
        verdictText(r),
      ]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\n");
}

/** "burned-google-inboxes-2026-09-21.csv" */
export function csvName(esp: Esp, end: string): string {
  return `burned-${esp}-${levelOf(esp) === "inbox" ? "inboxes" : "domains"}-${end}.csv`;
}
