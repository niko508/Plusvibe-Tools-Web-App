// Clone Campaign with Winning Variants: which of a campaign's first-step
// variants earned their place, and what the clone's sequence becomes.
//
// Only step 1 is judged. It is the email every lead gets first, so it is where
// a variant's positive replies say something about the variant; follow-ups
// answer threads the opener started, so they are kept exactly as they are.
//
//   winner      a step-1 variant with at least one positive reply, all time
//   the clone   step 1 holds only the winners, under their own letters;
//               every follow-up step is kept as it is
//   no winners  step 1 becomes one empty variant, to be written by hand —
//               the page warns before anything is created
//
// The opt-out line: the page asks whether the kept variants should carry it.
// Yes adds the current block where a variant has none (and swaps an older
// wording for the current one); no takes it out wherever it is. Only step 1 —
// the follow-ups stay exactly as they are either way.
//
// Positive replies come from Plusvibe's variation stats (`pos_reply`), which
// also say which variants are deleted: those never travel.
//
// Pure module — no API — so all of it is unit-tested.

import type { SequenceStep, SequenceVariation } from "@/lib/plusvibe-types";
import { optOutState, withCurrentOptOut, withoutOptOut, type OptOutState } from "@/lib/campaign-types/append-opt-out";
import { VARIATION_LABELS } from "@/lib/variation-labels";

export interface VariantStat {
  variation: string;
  sent: number;
  replies: number;
  positiveReplies: number;
  isActive: boolean;
  isDel: boolean;
}

/** step → variation letter → its all-time figures. */
export type StatsByStep = Map<number, Map<string, VariantStat>>;

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Plusvibe's variation-stats answer, grouped by step, read defensively. */
export function parseVariationStats(raw: unknown): StatsByStep {
  const out: StatsByStep = new Map();
  if (!Array.isArray(raw)) return out;
  for (const s of raw) {
    const step = s as Record<string, unknown>;
    const stepNo = num(step.step);
    if (!stepNo) continue;
    const byLetter = out.get(stepNo) ?? new Map<string, VariantStat>();
    for (const v of Array.isArray(step.variations) ? step.variations : []) {
      const va = v as Record<string, unknown>;
      const letter = String(va.variation ?? "").trim();
      if (!letter) continue;
      byLetter.set(letter, {
        variation: letter,
        sent: num(va.sent),
        replies: num(va.reply),
        positiveReplies: num(va.pos_reply),
        isActive: va.is_active !== false,
        isDel: va.is_del === true,
      });
    }
    out.set(stepNo, byLetter);
  }
  return out;
}

/** One step-1 variant as the preview shows it. */
export interface VariantRow {
  variation: string;
  /** From several campaigns: the campaign it comes from. */
  campaignId?: string;
  campaignName?: string;
  /** From several campaigns: its letter in the clone, when kept. */
  newLetter?: string;
  /** From several campaigns: the same email as a kept variant of another campaign, counted into it. */
  sameAs?: string;
  /** The first line of its subject, short enough for a table cell. */
  subject: string;
  sent: number;
  replies: number;
  positiveReplies: number;
  /** Positive replies per 100 sent, 2 decimals; 0 when nothing was sent. */
  positiveRate: number;
  kept: boolean;
  /** Whether its body carries the opt-out line: the current one, an older wording, or none. */
  optOut: OptOutState;
}

/**
 * What to do with the opt-out line on the kept variants. "keep" leaves each
 * body as it is — only for callers that don't say.
 */
export type OptOutChoice = "add" | "remove" | "keep";

export interface OptOutSummary {
  choice: OptOutChoice;
  /** Variants that had none and got the current block. */
  added: string[];
  /** Variants whose older wording (or a second copy) was swapped for the current block. */
  replaced: string[];
  /** Variants already carrying the current block, left as they were. */
  present: string[];
  /** Variants it was taken out of. */
  removed: string[];
}

export interface WinnerPlan {
  /** From several campaigns: each one's step-1 variants and winners. */
  campaigns?: { id: string; name: string; variants: number; winners: number }[];
  /** From several campaigns: winners that were the same email as another, counted together. */
  merged?: number;
  /** From several campaigns: winners past the per-step limit, left out. */
  overLimit?: number;
  /** The step judged: the campaign's first. */
  firstStep: number;
  rows: VariantRow[];
  /** The winners, most positive replies first, at most three. */
  top3: VariantRow[];
  kept: number;
  dropped: number;
  /** No variant in step 1 has a positive reply: it becomes one empty variant. */
  noWinners: boolean;
  /** The clone's letters whose names get "(Previous Winner)": the most positive replies, if more than one. */
  marked: string[];
  /** Follow-up steps, kept as they are. */
  followUps: { step: number; variations: number }[];
  /** Variants Plusvibe has deleted but still returns: never written back. */
  droppedDeleted: number;
  /** What happens to the opt-out line on the kept variants. */
  optOut: OptOutSummary;
  /** What the clone's sequence is written as. */
  steps: SequenceStep[];
}

const SUBJECT_CHARS = 90;

function shortSubject(s: string | undefined): string {
  const line = (s ?? "").split(/\r?\n/)[0].trim();
  return line.length > SUBJECT_CHARS ? `${line.slice(0, SUBJECT_CHARS - 1)}…` : line;
}

/** Added to the name of the variant(s) that did best. */
export const WINNER_MARK = "(Previous Winner)";

/**
 * A variant's name in the clone: as it was, with "(Previous Winner)" after it
 * when it is a winner — and a mark left over from an earlier clone taken off
 * when it isn't, so the mark only ever means this round.
 */
export function withWinnerMark(name: string, isWinner: boolean): string {
  const bare = (name ?? "").replace(/\s*\(previous winner\)\s*$/i, "").trim();
  if (!isWinner) return bare;
  return bare ? `${bare} ${WINNER_MARK}` : WINNER_MARK;
}

/**
 * The positive replies a variant needs to be marked: the most any kept one got
 * — so ties are all marked — and only when that is more than one. When every
 * variant has a single positive reply, none stands out, and none is marked.
 */
export function winnerBar(positives: number[]): number | null {
  const top = Math.max(0, ...positives);
  return top >= 2 ? top : null;
}

/** The single blank variant a step 1 with no winners is left with. */
export function emptyVariant(): SequenceVariation {
  return { variation: "A", subject: "", preheader: "", name: "", body: "" };
}

/** Most positive replies first; then most replies; then fewest sent (the better rate). */
function byStrength(a: VariantRow, b: VariantRow): number {
  return b.positiveReplies - a.positiveReplies || b.replies - a.replies || a.sent - b.sent || a.variation.localeCompare(b.variation);
}

/**
 * The box starts ticked when most of the kept variants already carry the line,
 * so leaving it alone changes as little as possible.
 */
export function defaultOptOut(rows: VariantRow[]): boolean {
  const kept = rows.filter((r) => r.kept && !r.sameAs);
  if (kept.length === 0) return false;
  return kept.filter((r) => r.optOut !== "none").length * 2 >= kept.length;
}

/** Applies the choice to step 1's kept variants, saying what each got. */
function applyOptOut(variations: SequenceVariation[], choice: OptOutChoice): { variations: SequenceVariation[]; summary: OptOutSummary } {
  const summary: OptOutSummary = { choice, added: [], replaced: [], present: [], removed: [] };
  if (choice === "keep") return { variations, summary };
  const out = variations.map((v) => {
    const body = v.body ?? "";
    if (choice === "remove") {
      const r = withoutOptOut(body);
      if (r.removed === 0) return v;
      summary.removed.push(v.variation);
      return { ...v, body: r.body };
    }
    // An empty body is left for writing by hand, not given a lone opt-out line.
    if (!body.trim()) return v;
    const r = withCurrentOptOut(body);
    if (r.outcome === "present") {
      summary.present.push(v.variation);
      return v;
    }
    (r.outcome === "added" ? summary.added : summary.replaced).push(v.variation);
    return { ...v, body: r.body };
  });
  return { variations: out, summary };
}

export function planWinners(sequence: SequenceStep[], stats: StatsByStep, optOut: OptOutChoice = "keep"): WinnerPlan {
  const ordered = [...sequence].sort((a, b) => a.step - b.step);
  let droppedDeleted = 0;
  // Deleted variants are left out everywhere, as the other copy tools do.
  const live = ordered.map((s) => {
    const flags = stats.get(s.step);
    const variations = s.variations.filter((v) => {
      const gone = flags?.get(v.variation)?.isDel === true;
      if (gone) droppedDeleted += 1;
      return !gone;
    });
    return { ...s, variations };
  });

  const first = live[0];
  const firstStep = first?.step ?? 1;
  const figures = stats.get(firstStep);
  const rows: VariantRow[] = (first?.variations ?? []).map((v) => {
    const f = figures?.get(v.variation);
    const sent = f?.sent ?? 0;
    const positiveReplies = f?.positiveReplies ?? 0;
    return {
      variation: v.variation,
      subject: shortSubject(v.subject),
      sent,
      replies: f?.replies ?? 0,
      positiveReplies,
      positiveRate: sent > 0 ? Math.round((positiveReplies / sent) * 10000) / 100 : 0,
      kept: positiveReplies >= 1,
      optOut: optOutState(v.body ?? ""),
    };
  });
  const winners = rows.filter((r) => r.kept);
  const noWinners = winners.length === 0;
  const keptLetters = new Set(winners.map((r) => r.variation));
  const marked: string[] = [];

  let optOutSummary: OptOutSummary = { choice: optOut, added: [], replaced: [], present: [], removed: [] };
  const steps: SequenceStep[] = live.map((s, i) => {
    if (i > 0) return s;
    if (noWinners) return { ...s, variations: [emptyVariant()] };
    const bar = winnerBar(winners.map((w) => w.positiveReplies));
    const kept = s.variations
      .filter((v) => keptLetters.has(v.variation))
      .map((v) => {
        const isTop = bar !== null && winners.find((w) => w.variation === v.variation)!.positiveReplies === bar;
        if (isTop) marked.push(v.variation);
        return { ...v, name: withWinnerMark(v.name ?? "", isTop) };
      });
    const applied = applyOptOut(kept, optOut);
    optOutSummary = applied.summary;
    return { ...s, variations: applied.variations };
  });

  return {
    firstStep,
    rows,
    top3: [...winners].sort(byStrength).slice(0, 3),
    kept: winners.length,
    dropped: rows.length - winners.length,
    noWinners,
    marked,
    followUps: live.slice(1).map((s) => ({ step: s.step, variations: s.variations.length })),
    droppedDeleted,
    optOut: optOutSummary,
    steps,
  };
}

// --- Winners from several campaigns ------------------------------------------

export interface CampaignInput {
  id: string;
  name: string;
  sequence: SequenceStep[];
  stats: StatsByStep;
}

/** Two variants are the same email when subject and body match, opt-out line, case and spacing aside. */
function sameEmailKey(v: SequenceVariation): string {
  const tidy = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  return `${tidy(v.subject ?? "")}\n${tidy(withoutOptOut(v.body ?? "").body)}`;
}

/**
 * The clone of `base` whose step 1 holds the winners of every campaign given
 * (the base among them): each step-1 variant with at least one positive reply,
 * all time. The same email in two campaigns — a 🟡 campaign and its 🔵 copy,
 * say — is one variant, its figures added up and the strongest copy's wording
 * kept. Winners are lettered A, B, C… strongest first; past the per-step limit
 * the weakest are left out. Settings, follow-ups and sub-sequences are the
 * base's, as in the one-campaign clone.
 */
export function planMultiWinners(base: CampaignInput, campaigns: CampaignInput[], optOut: OptOutChoice = "keep"): WinnerPlan {
  const all = campaigns.some((c) => c.id === base.id) ? campaigns : [base, ...campaigns];
  let droppedDeleted = 0;
  const firstOf = (c: CampaignInput) => {
    const ordered = [...c.sequence].sort((a, b) => a.step - b.step);
    const live = ordered.map((s) => {
      const flags = c.stats.get(s.step);
      const variations = s.variations.filter((v) => {
        const gone = flags?.get(v.variation)?.isDel === true;
        if (gone) droppedDeleted += 1;
        return !gone;
      });
      return { ...s, variations };
    });
    return { live, first: live[0] };
  };

  type Entry = { row: VariantRow; v: SequenceVariation };
  const entries: Entry[] = [];
  const perCampaign: { id: string; name: string; variants: number; winners: number }[] = [];
  let baseLive: SequenceStep[] = [];
  for (const c of all) {
    const { live, first } = firstOf(c);
    if (c.id === base.id) baseLive = live;
    const figures = first ? c.stats.get(first.step) : undefined;
    let winners = 0;
    for (const v of first?.variations ?? []) {
      const f = figures?.get(v.variation);
      const sent = f?.sent ?? 0;
      const positiveReplies = f?.positiveReplies ?? 0;
      if (positiveReplies >= 1) winners += 1;
      entries.push({
        v,
        row: {
          variation: v.variation,
          campaignId: c.id,
          campaignName: c.name,
          subject: shortSubject(v.subject),
          sent,
          replies: f?.replies ?? 0,
          positiveReplies,
          positiveRate: sent > 0 ? Math.round((positiveReplies / sent) * 10000) / 100 : 0,
          kept: false,
          optOut: optOutState(v.body ?? ""),
        },
      });
    }
    perCampaign.push({ id: c.id, name: c.name, variants: first?.variations.length ?? 0, winners });
  }

  // The winners, the same email counted once.
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.row.positiveReplies < 1) continue;
    const k = sameEmailKey(e.v);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const strongestFirst = (a: Entry, b: Entry) => byStrength(a.row, b.row);
  const merged = [...groups.values()].map((g) => {
    const sorted = [...g].sort(strongestFirst);
    const sent = g.reduce((n, e) => n + e.row.sent, 0);
    const positiveReplies = g.reduce((n, e) => n + e.row.positiveReplies, 0);
    const total: VariantRow = {
      ...sorted[0].row,
      sent,
      replies: g.reduce((n, e) => n + e.row.replies, 0),
      positiveReplies,
      positiveRate: sent > 0 ? Math.round((positiveReplies / sent) * 10000) / 100 : 0,
    };
    return { lead: sorted[0], rest: sorted.slice(1), total };
  });
  merged.sort((a, b) => byStrength(a.total, b.total));
  const fits = merged.slice(0, VARIATION_LABELS.length);
  const overLimit = merged.length - fits.length;
  fits.forEach((g, i) => {
    const letter = VARIATION_LABELS[i];
    g.lead.row.kept = true;
    g.lead.row.newLetter = letter;
    g.total.newLetter = letter;
    g.total.variation = letter;
    for (const e of g.rest) {
      e.row.kept = true;
      e.row.newLetter = letter;
      e.row.sameAs = `${g.lead.row.campaignName} · ${g.lead.row.variation}`;
    }
  });
  const noWinners = fits.length === 0;
  const bar = winnerBar(fits.map((g) => g.total.positiveReplies));
  const marked = bar === null ? [] : fits.map((g, j) => (g.total.positiveReplies === bar ? VARIATION_LABELS[j] : "")).filter(Boolean);

  let optOutSummary: OptOutSummary = { choice: optOut, added: [], replaced: [], present: [], removed: [] };
  const steps: SequenceStep[] = baseLive.map((s, i) => {
    if (i > 0) return s;
    if (noWinners) return { ...s, variations: [emptyVariant()] };
    const applied = applyOptOut(
      fits.map((g, j) => ({
        ...g.lead.v,
        variation: VARIATION_LABELS[j],
        name: withWinnerMark(g.lead.v.name ?? "", bar !== null && g.total.positiveReplies === bar),
      })),
      optOut
    );
    optOutSummary = applied.summary;
    return { ...s, variations: applied.variations };
  });

  const rows = entries.map((e) => e.row);
  return {
    campaigns: perCampaign,
    merged: fits.reduce((n, g) => n + g.rest.length, 0),
    overLimit,
    firstStep: steps[0]?.step ?? 1,
    rows,
    top3: fits.slice(0, 3).map((g) => g.total),
    kept: fits.length,
    dropped: rows.filter((r) => !r.kept).length,
    noWinners,
    marked,
    followUps: baseLive.slice(1).map((s) => ({ step: s.step, variations: s.variations.length })),
    droppedDeleted,
    optOut: optOutSummary,
    steps,
  };
}

/** Everything wrong with the choices, in the order it should be fixed. */
export function planProblems(sel: { workspaceId?: string; campaignId?: string; name?: string }, opts: { steps?: number } = {}): string[] {
  const problems: string[] = [];
  if (!sel.workspaceId) problems.push("Pick a workspace.");
  if (!sel.campaignId) problems.push("Pick the campaign to clone.");
  if (!(sel.name ?? "").trim()) problems.push("Give the new campaign a name.");
  else if ((sel.name ?? "").trim().length > 200) problems.push("Keep the name under 200 characters.");
  if (opts.steps === 0) problems.push("That campaign has no sequence steps, so there is nothing to clone.");
  return problems;
}


/**
 * What to do to the clone's tags. A duplicate arrives with the source's tags,
 * so the clone is brought to the chosen set: missing tags added, the rest of
 * what it carries taken off.
 */
export function tagChanges(current: string[], wanted: string[]): { add: string[]; remove: string[] } {
  const have = new Set(current);
  const want = new Set(wanted);
  return { add: [...want].filter((t) => !have.has(t)), remove: [...have].filter((t) => !want.has(t)) };
}

/** A typed new tag name, tidied; null when there is nothing to create. */
export function cleanTagName(name: string): string | null {
  const n = name.replace(/\s+/g, " ").trim().slice(0, 60);
  return n ? n : null;
}

/**
 * The default name is the source's own, so it can be kept as it is or edited
 * — the clone lives beside the source, and a tag or a word tells them apart.
 */
export function defaultName(sourceName: string): string {
  return (sourceName ?? "").trim().slice(0, 200);
}

// --- What the routes answer (shared by the server and the page) ------------

export interface TagRef {
  id: string;
  name: string;
  color?: string;
}

export type PlanSummary = Omit<WinnerPlan, "steps">;

export interface WinnersPreview {
  campaignName: string;
  status: string;
  plan: PlanSummary;
  /** The tags the campaign carries now. */
  tags: TagRef[];
  /** Every tag in the workspace, to choose from. */
  workspaceTags: TagRef[];
  subsequences: number;
}

export interface CloneResult {
  createdId: string;
  name: string;
  plan: PlanSummary;
  subsequences: number;
  tags: TagRef[];
  createdTags: string[];
  verified: boolean;
  problems: string[];
  warnings: string[];
}
