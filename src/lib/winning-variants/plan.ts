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
// Positive replies come from Plusvibe's variation stats (`pos_reply`), which
// also say which variants are deleted: those never travel.
//
// Pure module — no API — so all of it is unit-tested.

import type { SequenceStep, SequenceVariation } from "@/lib/plusvibe-types";

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
  /** The first line of its subject, short enough for a table cell. */
  subject: string;
  sent: number;
  replies: number;
  positiveReplies: number;
  /** Positive replies per 100 sent, 2 decimals; 0 when nothing was sent. */
  positiveRate: number;
  kept: boolean;
}

export interface WinnerPlan {
  /** The step judged: the campaign's first. */
  firstStep: number;
  rows: VariantRow[];
  /** The winners, most positive replies first, at most three. */
  top3: VariantRow[];
  kept: number;
  dropped: number;
  /** No variant in step 1 has a positive reply: it becomes one empty variant. */
  noWinners: boolean;
  /** Follow-up steps, kept as they are. */
  followUps: { step: number; variations: number }[];
  /** Variants Plusvibe has deleted but still returns: never written back. */
  droppedDeleted: number;
  /** What the clone's sequence is written as. */
  steps: SequenceStep[];
}

const SUBJECT_CHARS = 90;

function shortSubject(s: string | undefined): string {
  const line = (s ?? "").split(/\r?\n/)[0].trim();
  return line.length > SUBJECT_CHARS ? `${line.slice(0, SUBJECT_CHARS - 1)}…` : line;
}

/** The single blank variant a step 1 with no winners is left with. */
export function emptyVariant(): SequenceVariation {
  return { variation: "A", subject: "", preheader: "", name: "", body: "" };
}

/** Most positive replies first; then most replies; then fewest sent (the better rate). */
function byStrength(a: VariantRow, b: VariantRow): number {
  return b.positiveReplies - a.positiveReplies || b.replies - a.replies || a.sent - b.sent || a.variation.localeCompare(b.variation);
}

export function planWinners(sequence: SequenceStep[], stats: StatsByStep): WinnerPlan {
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
    };
  });
  const winners = rows.filter((r) => r.kept);
  const noWinners = winners.length === 0;
  const keptLetters = new Set(winners.map((r) => r.variation));

  const steps: SequenceStep[] = live.map((s, i) => {
    if (i > 0) return s;
    return {
      ...s,
      variations: noWinners ? [emptyVariant()] : s.variations.filter((v) => keptLetters.has(v.variation)),
    };
  });

  return {
    firstStep,
    rows,
    top3: [...winners].sort(byStrength).slice(0, 3),
    kept: winners.length,
    dropped: rows.length - winners.length,
    noWinners,
    followUps: live.slice(1).map((s) => ({ step: s.step, variations: s.variations.length })),
    droppedDeleted,
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
