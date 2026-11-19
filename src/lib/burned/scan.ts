// Turning a workspace's inboxes and their stats into rows to judge.
//
// Google is judged inbox by inbox, Microsoft domain by domain, so the two
// produce the same row shape from different groupings and everything
// downstream — the verdict, the table, the CSV, the copy — is shared.
//
// Each row is compared with the REST OF ITS WORKSPACE on the same provider:
// every other row's replies over every other row's contacts. The row itself
// is left out, so a workspace's one big domain is never measured against
// mostly itself.
//
// Rates are replies over UNIQUE LEADS CONTACTED, matching the rest of the
// app. Plusvibe's own reply_rate divides by emails sent, and with follow-up
// steps each lead gets several emails, so that figure runs several times
// lower for the same replies. The reported rate is used only when no
// contacted count came back to divide by.
//
// Pure module — no API calls — so all of it is unit-tested.

import { inboxRates, statsFor, type InboxStats } from "@/lib/blocked-domains/performance";
import { domainOf } from "@/lib/campaign-types/esp";
import { levelOf, type Esp, type Thresholds } from "./settings";

export type Verdict =
  /** Under the workspace bar with enough sends and days to mean it. */
  | "burned"
  /** At or above the bar. */
  | "ok"
  /** Not judged: see the reason. */
  | "quiet";

export type QuietReason =
  /** Under the minimum sends. */
  | "few-sends"
  /** Fewer days of outreach than the minimum. */
  | "too-new"
  /** Sent, but no daily figures came back to say since when. */
  | "no-history"
  /** The rest of the workspace sent too little on this provider to compare with. */
  | "no-baseline"
  /** No figures from Plusvibe at all. */
  | "no-figures";

/** What the rest of the workspace did on the same provider. */
export interface Baseline {
  sent: number;
  replyRate: number;
  replyRateOoo: number;
}

export interface ScanRow {
  /**
   * Kept because its REAL reply rate cleared the bar, even though the OOO
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
  /** Days from the first send in the window to its end. Absent when unknown. */
  days?: number;
  /** The rest of the workspace on this provider. Absent when there was too little to compare with. */
  baseline?: Baseline;
  /** The row's OOO rate as a percentage of the baseline's: 40 means 40% of the workspace. */
  vsWorkspace?: number;
  verdict: Verdict;
  reason?: QuietReason;
}

export interface InboxLike {
  id: string;
  email: string;
  provider?: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Inclusive days from one YYYY-MM-DD to another; null when either is unreadable. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Burned, fine, or not worth judging.
 *
 * In this order, so a row always says the first thing that stopped it being
 * judged: no figures, too few sends, no history, too new, nothing to compare
 * with. Then two bars, both a share of the rest of the workspace:
 *
 *   OOO included   the usual signal: anything landing in an inbox people
 *                  read brings auto-replies, so a row that has stopped
 *                  pulling even those is burned
 *   real replies   overrules it: something people are actually answering is
 *                  not burned, however few auto-replies come back with it.
 *                  Only when the workspace has real replies to compare with
 *
 * A row with no figures is never called burned: naming a domain burned on no
 * evidence would have someone replace one that was never sending.
 */
export function judge(
  row: {
    sent: number;
    days: number | null;
    replyRate: number;
    replyRateOoo: number;
    hasFigures: boolean;
    baseline: Baseline | null;
  },
  t: Thresholds
): { verdict: Verdict; reason?: QuietReason; rescued?: true } {
  if (!row.hasFigures) return { verdict: "quiet", reason: "no-figures" };
  if (row.sent < t.minSends) return { verdict: "quiet", reason: "few-sends" };
  if (row.days === null) return { verdict: "quiet", reason: "no-history" };
  if (row.days < t.minDays) return { verdict: "quiet", reason: "too-new" };
  const b = row.baseline;
  if (!b || b.sent < t.minSends || b.replyRateOoo <= 0) return { verdict: "quiet", reason: "no-baseline" };
  const share = t.relativePct / 100;
  if (row.replyRateOoo >= b.replyRateOoo * share) return { verdict: "ok" };
  if (b.replyRate > 0 && row.replyRate >= b.replyRate * share) return { verdict: "ok", rescued: true };
  return { verdict: "burned" };
}

/** A row's raw figures before it is judged. */
interface Unit {
  name: string;
  domain: string;
  inboxes: number;
  sent: number;
  contacted: number;
  replies: number;
  oooReplies: number;
  replyRate: number;
  replyRateOoo: number;
  firstSend?: string;
  hasFigures: boolean;
}

function unitForInbox(inbox: InboxLike, index: Map<string, InboxStats>): Unit {
  const stats = statsFor(inbox, index);
  const rates = stats ? inboxRates(stats) : { replyRate: 0, replyRateOoo: 0 };
  return {
    name: inbox.email,
    domain: domainOf(inbox.email),
    inboxes: 1,
    sent: stats?.sent ?? 0,
    contacted: stats?.contacted ?? 0,
    replies: stats?.replies ?? 0,
    oooReplies: stats?.oooReplies ?? 0,
    replyRate: round(rates.replyRate),
    replyRateOoo: round(rates.replyRateOoo),
    firstSend: stats?.firstSend,
    hasFigures: !!stats,
  };
}

/**
 * One domain's figures, summed across its inboxes rather than averaged: a
 * mailbox that sent five emails and got a reply must not outweigh one that
 * sent five hundred and got none. Its first send is the earliest of any of
 * its mailboxes.
 */
function unitForDomain(domain: string, list: InboxLike[], index: Map<string, InboxStats>): Unit {
  const stats = list.map((i) => statsFor(i, index)).filter((s): s is InboxStats => !!s);
  const sum = (pick: (r: InboxStats) => number) => stats.reduce((n, r) => n + pick(r), 0);
  const sent = sum((r) => r.sent);
  const contacted = sum((r) => r.contacted);
  const replies = sum((r) => r.replies);
  const oooReplies = sum((r) => r.oooReplies);
  let replyRate = 0;
  let replyRateOoo = 0;
  if (contacted > 0) {
    replyRate = (replies / contacted) * 100;
    replyRateOoo = ((replies + oooReplies) / contacted) * 100;
  } else if (sent > 0) {
    // No denominator came back, but the per-inbox rates did. Weight them by
    // send volume, which is the closest honest thing to the real aggregate.
    replyRate = sum((r) => r.replyRate * r.sent) / sent;
    replyRateOoo = sum((r) => r.replyRateOoo * r.sent) / sent;
  }
  const firsts = stats.map((s) => s.firstSend).filter((d): d is string => !!d).sort();
  return {
    name: domain,
    domain,
    inboxes: list.length,
    sent,
    contacted,
    replies,
    oooReplies,
    replyRate: round(replyRate),
    replyRateOoo: round(replyRateOoo),
    firstSend: firsts[0],
    // The same rule the domain aggregate has always used: nothing sent and
    // nobody contacted is no figures, even if Plusvibe answered for it.
    hasFigures: contacted > 0 || sent > 0,
  };
}

/**
 * Everything else in the workspace, as one rate pair.
 *
 * Counted, not averaged, and only over rows with a contacted count: the
 * baseline is "of every lead the rest of this client's provider reached, how
 * many answered".
 */
export function baselineExcluding(units: Pick<Unit, "sent" | "contacted" | "replies" | "oooReplies" | "hasFigures">[], skip: number): Baseline | null {
  let sent = 0;
  let contacted = 0;
  let replies = 0;
  let ooo = 0;
  units.forEach((u, i) => {
    if (i === skip || !u.hasFigures) return;
    sent += u.sent;
    contacted += u.contacted;
    replies += u.replies;
    ooo += u.oooReplies;
  });
  if (contacted <= 0) return null;
  return {
    sent,
    replyRate: round((replies / contacted) * 100),
    replyRateOoo: round(((replies + ooo) / contacted) * 100),
  };
}

function judgeUnits(
  ws: { workspaceId: string; workspaceName: string },
  units: Unit[],
  t: Thresholds,
  end: string
): ScanRow[] {
  return units.map((u, i) => {
    const baseline = baselineExcluding(units, i);
    const days = u.firstSend ? daysBetween(u.firstSend, end) : null;
    const { firstSend: _firstSend, hasFigures, ...figures } = u;
    void _firstSend;
    const row: ScanRow = {
      ...ws,
      ...figures,
      ...(days !== null ? { days } : {}),
      ...(baseline ? { baseline } : {}),
      ...(baseline && baseline.replyRateOoo > 0 ? { vsWorkspace: Math.round((u.replyRateOoo / baseline.replyRateOoo) * 100) } : {}),
      verdict: "quiet",
    };
    return { ...row, ...judge({ sent: u.sent, days, replyRate: u.replyRate, replyRateOoo: u.replyRateOoo, hasFigures, baseline }, t) };
  });
}

/** One row per inbox — how Google is judged. */
export function rowsForInboxes(
  ws: { workspaceId: string; workspaceName: string },
  inboxes: InboxLike[],
  index: Map<string, InboxStats>,
  t: Thresholds,
  end: string
): ScanRow[] {
  return judgeUnits(ws, inboxes.map((i) => unitForInbox(i, index)), t, end);
}

/** One row per domain — how Microsoft is judged. */
export function rowsForDomains(
  ws: { workspaceId: string; workspaceName: string },
  inboxes: InboxLike[],
  index: Map<string, InboxStats>,
  t: Thresholds,
  end: string
): ScanRow[] {
  const byDomain = new Map<string, InboxLike[]>();
  for (const inbox of inboxes) {
    const domain = domainOf(inbox.email);
    if (!domain) continue;
    const list = byDomain.get(domain);
    if (list) list.push(inbox);
    else byDomain.set(domain, [inbox]);
  }
  const units = [...byDomain].map(([domain, list]) => unitForDomain(domain, list, index));
  return judgeUnits(ws, units, t, end);
}

/** The rows for one workspace, grouped the way this provider is judged. */
export function rowsFor(
  esp: Esp,
  ws: { workspaceId: string; workspaceName: string },
  inboxes: InboxLike[],
  index: Map<string, InboxStats>,
  t: Thresholds,
  end: string
): ScanRow[] {
  return levelOf(esp) === "inbox" ? rowsForInboxes(ws, inboxes, index, t, end) : rowsForDomains(ws, inboxes, index, t, end);
}

export interface ScanCounts {
  scanned: number;
  burned: number;
  ok: number;
  /** Of the ok ones, those the real reply rate saved from the OOO bar. */
  rescued: number;
  /** Too few sends to judge. */
  fewSends: number;
  /** Sending for fewer days than the minimum, or since an unknown day. */
  tooNew: number;
  /** Nothing in the rest of the workspace to compare with. */
  noBaseline: number;
  /** No figures from Plusvibe at all. */
  noFigures: number;
}

export function emptyCounts(): ScanCounts {
  return { scanned: 0, burned: 0, ok: 0, rescued: 0, fewSends: 0, tooNew: 0, noBaseline: 0, noFigures: 0 };
}

export function countRows(rows: ScanRow[]): ScanCounts {
  const c = emptyCounts();
  c.scanned = rows.length;
  for (const r of rows) {
    if (r.verdict === "burned") c.burned += 1;
    else if (r.verdict === "ok") {
      c.ok += 1;
      if (r.rescued) c.rescued += 1;
    } else if (r.reason === "few-sends") c.fewSends += 1;
    else if (r.reason === "too-new" || r.reason === "no-history") c.tooNew += 1;
    else if (r.reason === "no-baseline") c.noBaseline += 1;
    else c.noFigures += 1;
  }
  return c;
}

/** Burned first, furthest under its workspace first, then by workspace and name. */
export function sortRows(rows: ScanRow[]): ScanRow[] {
  const rank = { burned: 0, ok: 1, quiet: 2 } as const;
  return [...rows].sort(
    (a, b) =>
      rank[a.verdict] - rank[b.verdict] ||
      (a.vsWorkspace ?? Infinity) - (b.vsWorkspace ?? Infinity) ||
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
export const QUIET_TEXT: Record<QuietReason, string> = {
  "few-sends": "too few sends",
  "too-new": "sending too few days",
  "no-history": "no daily figures",
  "no-baseline": "nothing in the workspace to compare with",
  "no-figures": "no figures",
};

export function verdictText(r: ScanRow): string {
  if (r.verdict === "quiet") return QUIET_TEXT[r.reason ?? "no-figures"] ?? "not judged";
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
  "workspace_reply_rate",
  "workspace_reply_rate_ooo",
  "vs_workspace_pct",
  "days_sending",
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
        r.baseline?.replyRate ?? "",
        r.baseline?.replyRateOoo ?? "",
        r.vsWorkspace ?? "",
        r.days ?? "",
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
