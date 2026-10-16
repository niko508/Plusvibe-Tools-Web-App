"use client";

// Analyze Positive Reply Rates — Step 1 vs Step 2: how many positive replies
// the first email brought in against the first follow-up, overall, workspace
// by workspace and campaign by campaign.

import { useMemo, useState } from "react";
import { MIN_POSITIVE, type CampaignFigures, type GroupTotals } from "@/lib/reply-rates/opt-out";
import { compareSteps, compareStepsByWorkspace, stepAt, type StepsVerdict, type WorkspaceSteps } from "@/lib/reply-rates/steps";
import { formatNumber } from "@/lib/format";
import { ChevronDownIcon } from "@/components/icons";

const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);

export function StepsSection({ rows, running, allWorkspaces }: { rows: CampaignFigures[]; running: boolean; allWorkspaces: boolean }) {
  const result = useMemo(() => compareSteps(rows), [rows]);
  const byWorkspace = useMemo(() => compareStepsByWorkspace(rows), [rows]);
  const [hideQuiet, setHideQuiet] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Figures from before steps were kept can't be split: Analyze again.
  const stale = rows.length > 0 && rows.every((r) => !r.steps);
  const listed = useMemo(
    () =>
      rows
        .map((r) => ({ r, s1: stepAt(r, 0), s2: stepAt(r, 1) }))
        .filter(({ s1, s2 }) => showAll || (s1?.sent ?? 0) + (s2?.sent ?? 0) + (s1?.positive ?? 0) + (s2?.positive ?? 0) > 0)
        .sort((a, b) => (b.s1?.positive ?? 0) + (b.s2?.positive ?? 0) - ((a.s1?.positive ?? 0) + (a.s2?.positive ?? 0)) || (b.s1?.sent ?? 0) - (a.s1?.sent ?? 0)),
    [rows, showAll]
  );

  if (stale) return <p className="text-sm text-muted-foreground">Analyze again to split these figures by step.</p>;

  const { step1, step2 } = result;
  const noStep2 = step1.campaigns - step2.campaigns;

  return (
    <div className="space-y-4" data-steps>
      <div className="grid gap-3 sm:grid-cols-2">
        <StepCard title="Step 1 · first email" totals={step1} share={result.step1Share} accent data-step="1" />
        <StepCard title="Step 2 · first follow-up" totals={step2} share={result.step1Share === null ? null : Math.round((100 - result.step1Share) * 10) / 10} data-step="2" />
      </div>
      <div className="pv-card p-4 text-sm" data-steps-verdict>
        {step1.contacted === 0 && step2.contacted === 0 ? (
          <span className="text-muted-foreground">Nothing was sent in this range.</span>
        ) : (
          <>
            <span className="font-medium" data-steps-count>
              {step1.positive === step2.positive
                ? `Steps 1 and 2 both got ${formatNumber(step1.positive)} positive replies.`
                : `Step ${step1.positive > step2.positive ? 1 : 2} got ${formatNumber(Math.abs(step1.positive - step2.positive))} more positive replies (${formatNumber(step1.positive)} vs ${formatNumber(step2.positive)})${
                    result.step1Share !== null ? ` — step 1 brought ${result.step1Share}% of the two.` : "."
                  }`}
            </span>{" "}
            {result.difference !== null && (
              <span className="text-muted-foreground">
                {result.difference === 0
                  ? "Per email sent, the two rates are the same."
                  : `Per email sent, step ${result.difference > 0 ? 1 : 2}'s rate is ${Math.abs(result.difference).toFixed(2)} points higher (${pct(step1.rate)} vs ${pct(step2.rate)}).`}{" "}
                <span data-steps-confidence={result.confidence ?? ""}>
                  {result.confidence === "likely"
                    ? "A gap this size is very unlikely to be chance (95% confidence)."
                    : result.confidence === "unclear"
                      ? "With these numbers that gap could still be chance."
                      : `Too few positive replies to tell per email yet (under ${MIN_POSITIVE} on a step).`}
                </span>
              </span>
            )}
            {(result.later > 0 || noStep2 > 0) && (
              <span className="mt-1 block text-xs text-muted-foreground">
                {result.later > 0 && `${formatNumber(result.later)} more came from step 3 or later, counted in neither. `}
                {noStep2 > 0 && `${formatNumber(noStep2)} campaign${noStep2 === 1 ? " has" : "s have"} no step 2.`}
              </span>
            )}
          </>
        )}
        {running && <span className="ml-1 text-xs text-muted-foreground">— still reading, so these will move.</span>}
      </div>

      {byWorkspace.length > 1 && <ByWorkspace rows={byWorkspace} hideQuiet={hideQuiet} onHideQuiet={setHideQuiet} />}

      <div className="pv-card overflow-hidden p-0">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium"
          onClick={() => setListOpen((v) => !v)}
          aria-expanded={listOpen}
          data-steps-list-toggle
        >
          <span>
            Every campaign <span className="font-normal text-muted-foreground">· {formatNumber(rows.length)}</span>
          </span>
          <ChevronDownIcon size={16} className={`transition-transform ${listOpen ? "rotate-180" : ""}`} />
        </button>
        {listOpen && (
          <div className="border-t border-border">
            <label className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show campaigns that sent nothing in the range
            </label>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-xs" data-steps-table>
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    {allWorkspaces && <th className="px-3 py-2 text-left font-medium">Workspace</th>}
                    <th className="px-3 py-2 text-left font-medium">Campaign</th>
                    <th className="px-3 py-2 text-right font-medium">Step 1 positive</th>
                    <th className="px-3 py-2 text-right font-medium">Step 2 positive</th>
                    <th className="px-3 py-2 text-right font-medium">Step 1 sent</th>
                    <th className="px-3 py-2 text-right font-medium">Step 2 sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {listed.map(({ r, s1, s2 }) => (
                    <tr key={`${r.workspaceId}-${r.campaignId}`} data-steps-row>
                      {allWorkspaces && <td className="px-3 py-1.5 text-muted-foreground">{r.workspaceName}</td>}
                      <td className="px-3 py-1.5">{r.name}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatNumber(s1?.positive ?? 0)}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{s2 ? formatNumber(s2.positive) : "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(s1?.sent ?? 0)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{s2 ? formatNumber(s2.sent) : "no step 2"}</td>
                    </tr>
                  ))}
                  {listed.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-3 text-muted-foreground">
                        No campaign sent anything in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const VERDICT: Record<StepsVerdict, { label: string; className: string }> = {
  step1: { label: "Step 1 clearly ahead", className: "bg-accent/10 text-accent" },
  step2: { label: "Step 2 clearly ahead", className: "bg-success/10 text-success" },
  even: { label: "No clear winner", className: "bg-muted text-muted-foreground" },
  "too-few": { label: "Too few replies to tell", className: "bg-muted text-muted-foreground" },
  "one-step": { label: "Only one step sent", className: "bg-muted text-muted-foreground" },
  none: { label: "Nothing sent", className: "bg-muted text-muted-foreground" },
};

function ByWorkspace({ rows, hideQuiet, onHideQuiet }: { rows: WorkspaceSteps[]; hideQuiet: boolean; onHideQuiet: (v: boolean) => void }) {
  const shown = hideQuiet ? rows.filter((r) => r.verdict !== "none") : rows;
  const counts = { step1: rows.filter((r) => r.verdict === "step1").length, step2: rows.filter((r) => r.verdict === "step2").length };
  const cell = (t: GroupTotals) => (
    <>
      <span className="font-medium tabular-nums">{formatNumber(t.positive)}</span>
      <span className="block text-[11px] text-muted-foreground tabular-nums">
        {formatNumber(t.contacted)} sent · {pct(t.rate)}
      </span>
    </>
  );
  return (
    <div className="pv-card overflow-hidden p-0" data-steps-by-workspace>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <div className="text-sm font-medium">
          By workspace{" "}
          <span className="font-normal text-muted-foreground">
            · step 1 clearly ahead in {formatNumber(counts.step1)}, step 2 in {formatNumber(counts.step2)}
          </span>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={hideQuiet} onChange={(e) => onHideQuiet(e.target.checked)} />
          Hide workspaces that sent nothing
        </label>
      </div>
      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[680px] text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Workspace</th>
              <th className="px-3 py-2 text-right font-medium">Step 1 positive</th>
              <th className="px-3 py-2 text-right font-medium">Step 2 positive</th>
              <th className="px-3 py-2 text-right font-medium">Step 1 share</th>
              <th className="px-3 py-2 text-left font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((r) => {
              const v = VERDICT[r.verdict];
              const clear = r.verdict === "step1" || r.verdict === "step2";
              return (
                <tr key={r.workspaceId} className={clear ? "bg-muted/20" : ""} data-steps-ws-row={r.workspaceId} data-verdict={r.verdict}>
                  <td className="px-3 py-2 font-medium">{r.workspaceName}</td>
                  <td className="px-3 py-2 text-right">{cell(r.step1)}</td>
                  <td className="px-3 py-2 text-right">{cell(r.step2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.step1Share === null ? "—" : `${r.step1Share}%`}</td>
                  <td className="px-3 py-2">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${v.className}`}>{v.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Step 1 share is step 1&apos;s part of the positive replies from the two steps. &ldquo;Clearly ahead&rdquo; compares positive
        replies per email each step sent, at 95% confidence in that workspace on its own.
      </p>
    </div>
  );
}

function StepCard({ title, totals, share, accent, ...rest }: { title: string; totals: GroupTotals; share: number | null; accent?: boolean; "data-step"?: string }) {
  return (
    <div className={`pv-card p-4 sm:p-5 ${accent ? "border-accent/40" : ""}`} {...rest}>
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums" data-positive>
        {formatNumber(totals.positive)}
      </div>
      <div className="text-sm">
        positive repl{totals.positive === 1 ? "y" : "ies"}
        {share !== null && <span className="text-muted-foreground"> · {share}% of steps 1–2</span>}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground" data-rate>
        from {formatNumber(totals.contacted)} email{totals.contacted === 1 ? "" : "s"} sent · {pct(totals.rate)} rate
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {formatNumber(totals.campaigns)} campaign{totals.campaigns === 1 ? "" : "s"} with this step · {formatNumber(totals.sending)} sent it in the range
      </div>
    </div>
  );
}
