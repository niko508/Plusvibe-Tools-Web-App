"use client";

// Analyze Positive Reply Rates: Opt Out vs No Opt Out, and Step 1 vs Step 2.
//
// The figures are read workspace by workspace, so "All workspaces" shows how
// far it has got and can be stopped; nothing is written anywhere. One read
// serves both sections, so switching between them reads nothing again.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import { ApiClientError, fetchOptOutRates, fetchWorkspaces } from "@/lib/api-client";
import {
  compareByWorkspace,
  compareOptOut,
  groupOf,
  MIN_POSITIVE,
  type CampaignFigures,
  type GroupTotals,
  type WorkspaceComparison,
  type WorkspaceVerdict,
} from "@/lib/reply-rates/opt-out";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, ChevronDownIcon, GaugeIcon } from "@/components/icons";
import { StepsSection } from "./steps-section";

type Section = "opt-out" | "steps";
const SECTIONS: [Section, string][] = [
  ["opt-out", "Opt Out vs No Opt Out"],
  ["steps", "Step 1 vs Step 2"],
];
const SECTION_KEY = "pv_rr_section";

const ALL = "__all";
const PRESETS = [7, 14, 30, 90] as const;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDay(d);
};
const errMessage = (err: unknown) => (err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);

export function ReplyRatesTool() {
  const { hasKey, ready } = useApiKey();
  const [section, setSectionState] = useState<Section>("opt-out");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SECTION_KEY);
      if (saved === "steps" || saved === "opt-out") setSectionState(saved);
    } catch {
      // storage unavailable: start on the first section
    }
  }, []);
  const setSection = (s: Section) => {
    setSectionState(s);
    try {
      localStorage.setItem(SECTION_KEY, s);
    } catch {
      // not remembered, no harm
    }
  };
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWs, setLoadingWs] = useState(false);
  const [scope, setScope] = useState(ALL);
  const [start, setStart] = useState(() => daysAgo(29));
  const [end, setEnd] = useState(() => isoDay(new Date()));

  const [rows, setRows] = useState<CampaignFigures[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setLoadingWs(true);
    try {
      setWorkspaces((await fetchWorkspaces()).workspaces ?? []);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoadingWs(false);
    }
  }, []);
  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  const running = progress !== null;
  const rangeProblem = !start || !end ? "Pick both dates." : start > end ? "The start date is after the end date." : end > isoDay(new Date()) ? "The end date is in the future." : null;

  async function analyze() {
    if (running || rangeProblem) return;
    const targets = scope === ALL ? workspaces : workspaces.filter((w) => w._id === scope);
    if (targets.length === 0) return;
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setErrors([]);
    setRows([]);
    const got: CampaignFigures[] = [];
    const problems: string[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const w = targets[i];
        setProgress({ done: i, total: targets.length, current: w.name });
        try {
          const r = await fetchOptOutRates({ workspaceId: w._id, workspaceName: w.name, start, end }, c.signal);
          got.push(...r.campaigns);
          problems.push(...r.errors);
        } catch (err) {
          if (c.signal.aborted) throw err;
          problems.push(`${w.name}: ${errMessage(err)}`);
        }
        setRows([...got]);
        setErrors([...problems]);
      }
    } catch {
      setError("Stopped. What was read before stopping is shown.");
    } finally {
      setProgress(null);
      ctrl.current = null;
    }
  }

  const result = useMemo(() => (rows ? compareOptOut(rows) : null), [rows]);
  const byWorkspace = useMemo(() => (rows ? compareByWorkspace(rows) : []), [rows]);
  const [hideQuiet, setHideQuiet] = useState(true);
  const listed = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => showAll || r.contacted > 0 || r.positive > 0)
        .sort((a, b) => (groupOf(a.name) === groupOf(b.name) ? b.positive - a.positive || b.contacted - a.contacted : groupOf(a.name) === "optOut" ? -1 : 1)),
    [rows, showAll]
  );

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Section">
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={`pv-chip ${section === id ? "pv-chip-active" : "hover:text-foreground"}`}
            onClick={() => setSection(id)}
            data-section={id}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="pv-card space-y-4 p-4 sm:p-5">
        {section === "opt-out" ? (
          <p className="text-xs text-muted-foreground">
            Every campaign counts, by its name: one with &ldquo;Opt Out&rdquo; in it is <strong>Opt Out</strong>, every other —
            plain, 🔵 and Signature alike — is <strong>No Opt Out</strong>. The rate is positive replies per lead emailed:
            leads emailed is what step 1 sent in the range, positive replies are counted over every step.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Every campaign counts. Its positive replies are split by the step Plusvibe puts them on: <strong>step 1</strong>, the
            first email, against <strong>step 2</strong>, the first follow-up. Beside each count is its rate per email that step
            sent, since fewer leads reach step 2. Both sections come from the same read.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="rr-scope">
              Workspace
            </label>
            <div className="relative">
              <select id="rr-scope" className="pv-input appearance-none pr-9" value={scope} disabled={loadingWs || running} onChange={(e) => setScope(e.target.value)} aria-label="Workspace">
                <option value={ALL}>{loadingWs ? "Loading workspaces…" : `All workspaces (${formatNumber(workspaces.length)})`}</option>
                {workspaces.map((w) => (
                  <option key={w._id} value={w._id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="rr-start">
              From
            </label>
            <input id="rr-start" type="date" className="pv-input" value={start} max={end || undefined} disabled={running} onChange={(e) => setStart(e.target.value)} aria-label="From" />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="rr-end">
              To
            </label>
            <input id="rr-end" type="date" className="pv-input" value={end} min={start || undefined} max={isoDay(new Date())} disabled={running} onChange={(e) => setEnd(e.target.value)} aria-label="To" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={`pv-chip ${start === daysAgo(n - 1) && end === isoDay(new Date()) ? "pv-chip-active" : "hover:text-foreground"}`}
              disabled={running}
              onClick={() => {
                setStart(daysAgo(n - 1));
                setEnd(isoDay(new Date()));
              }}
              data-preset={n}
            >
              Last {n} days
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={running || !!rangeProblem || workspaces.length === 0} onClick={analyze} data-analyze>
            {running ? <Spinner /> : <GaugeIcon size={16} />} Analyze
          </button>
          {running && (
            <>
              <span className="text-xs text-muted-foreground" data-progress>
                Reading {progress.current} ({formatNumber(progress.done + 1)} of {formatNumber(progress.total)})…
              </span>
              <button type="button" className="pv-btn-ghost text-xs" onClick={() => ctrl.current?.abort()}>
                Stop
              </button>
            </>
          )}
          {rangeProblem && <span className="text-xs text-warning">{rangeProblem}</span>}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!rows && !running && (
        <EmptyState icon={<GaugeIcon />} title="Pick a range and analyze">
          Every campaign in the workspaces you pick is read for the range, and the two groups&apos; positive reply rates are put side by side.
        </EmptyState>
      )}

      {result && rows && (rows.length > 0 || !running) && (
        <div className="space-y-4" data-result>
          {section === "steps" ? (
            <StepsSection rows={rows} running={running} allWorkspaces={scope === ALL} />
          ) : (
          <>
          <div className="grid gap-3 sm:grid-cols-2">
            <GroupCard title="Opt Out" totals={result.optOut} accent data-group="optOut" />
            <GroupCard title="No Opt Out" totals={result.noOptOut} data-group="noOptOut" />
          </div>
          <div className="pv-card p-4 text-sm" data-verdict>
            {result.difference === null ? (
              <span className="text-muted-foreground">
                {result.optOut.contacted === 0 && result.noOptOut.contacted === 0
                  ? "Nothing was sent in this range."
                  : `Only ${result.optOut.contacted === 0 ? "No Opt Out" : "Opt Out"} campaigns sent anything in this range, so there is nothing to compare yet.`}
              </span>
            ) : (
              <>
                <span className="font-medium" data-count-verdict>
                  {result.optOut.positive === result.noOptOut.positive
                    ? `Both got ${formatNumber(result.optOut.positive)} positive replies`
                    : `Opt Out got ${formatNumber(Math.abs(result.optOut.positive - result.noOptOut.positive))} ${
                        result.optOut.positive > result.noOptOut.positive ? "more" : "fewer"
                      } positive replies (${formatNumber(result.optOut.positive)} vs ${formatNumber(result.noOptOut.positive)})`}
                  {result.optOut.contacted === result.noOptOut.contacted
                    ? `, from the same ${formatNumber(result.optOut.contacted)} leads emailed.`
                    : `, from ${formatNumber(result.optOut.contacted)} vs ${formatNumber(result.noOptOut.contacted)} leads emailed.`}
                </span>{" "}
                <span className="text-muted-foreground">
                  {result.difference === 0
                    ? "Per lead emailed, the two rates are the same."
                    : `Per lead emailed, Opt Out's rate is ${Math.abs(result.difference).toFixed(2)} points ${result.difference > 0 ? "higher" : "lower"}${
                        result.relative !== null ? ` (${result.relative > 0 ? "+" : ""}${result.relative}%)` : ""
                      }.`}
                </span>{" "}
                <span className="text-muted-foreground" data-confidence={result.confidence ?? ""}>
                  {result.confidence === "likely"
                    ? "A gap this size is very unlikely to be chance (95% confidence)."
                    : result.confidence === "unclear"
                      ? "With these numbers the gap could still be chance — a longer range or more sends will tell."
                      : `Too few positive replies to tell yet (under ${MIN_POSITIVE} in a group).`}
                </span>
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
              data-campaign-list-toggle
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
                  <table className="w-full min-w-[640px] text-xs" data-campaign-table>
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        {scope === ALL && <th className="px-3 py-2 text-left font-medium">Workspace</th>}
                        <th className="px-3 py-2 text-left font-medium">Campaign</th>
                        <th className="px-3 py-2 text-left font-medium">Group</th>
                        <th className="px-3 py-2 text-right font-medium">Positive replies</th>
                        <th className="px-3 py-2 text-right font-medium">Leads emailed</th>
                        <th className="px-3 py-2 text-right font-medium">Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {listed.map((r) => (
                        <tr key={`${r.workspaceId}-${r.campaignId}`} data-row-group={groupOf(r.name)}>
                          {scope === ALL && <td className="px-3 py-1.5 text-muted-foreground">{r.workspaceName}</td>}
                          <td className="px-3 py-1.5">{r.name}</td>
                          <td className="px-3 py-1.5">{groupOf(r.name) === "optOut" ? "Opt Out" : "No Opt Out"}</td>
                          <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatNumber(r.positive)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(r.contacted)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.contacted > 0 ? (r.positive / r.contacted) * 100 : null)}</td>
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
          </>
          )}

          {errors.length > 0 && (
            <div className="space-y-1 text-xs text-warning" data-read-errors>
              <p className="font-medium">Not counted — these could not be read:</p>
              {errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const VERDICT: Record<WorkspaceVerdict, { label: string; className: string }> = {
  optOut: { label: "Opt Out clearly ahead", className: "bg-success/10 text-success" },
  noOptOut: { label: "No Opt Out clearly ahead", className: "bg-accent/10 text-accent" },
  even: { label: "No clear winner", className: "bg-muted text-muted-foreground" },
  "too-few": { label: "Too few replies to tell", className: "bg-muted text-muted-foreground" },
  "one-group": { label: "Only one group sent", className: "bg-muted text-muted-foreground" },
  none: { label: "Nothing sent", className: "bg-muted text-muted-foreground" },
};

/**
 * Each workspace's own Opt Out vs No Opt Out, so one where either side is
 * clearly winning stands out from the overall number. Clear winners first.
 */
function ByWorkspace({ rows, hideQuiet, onHideQuiet }: { rows: WorkspaceComparison[]; hideQuiet: boolean; onHideQuiet: (v: boolean) => void }) {
  const shown = hideQuiet ? rows.filter((r) => r.verdict !== "none") : rows;
  const counts = { optOut: rows.filter((r) => r.verdict === "optOut").length, noOptOut: rows.filter((r) => r.verdict === "noOptOut").length };
  const cell = (t: GroupTotals) => (
    <>
      <span className="font-medium tabular-nums">{formatNumber(t.positive)}</span>
      <span className="block text-[11px] text-muted-foreground tabular-nums">
        {formatNumber(t.contacted)} leads · {pct(t.rate)}
      </span>
    </>
  );
  return (
    <div className="pv-card overflow-hidden p-0" data-by-workspace>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <div className="text-sm font-medium">
          By workspace{" "}
          <span className="font-normal text-muted-foreground">
            · Opt Out clearly ahead in {formatNumber(counts.optOut)}, No Opt Out in {formatNumber(counts.noOptOut)}
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
              <th className="px-3 py-2 text-right font-medium">Opt Out positive</th>
              <th className="px-3 py-2 text-right font-medium">No Opt Out positive</th>
              <th className="px-3 py-2 text-right font-medium">Difference</th>
              <th className="px-3 py-2 text-left font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((r) => {
              const diff = r.optOut.positive - r.noOptOut.positive;
              const v = VERDICT[r.verdict];
              const clear = r.verdict === "optOut" || r.verdict === "noOptOut";
              return (
                <tr key={r.workspaceId} className={clear ? "bg-muted/20" : ""} data-ws-row={r.workspaceId} data-verdict={r.verdict}>
                  <td className="px-3 py-2 font-medium">{r.workspaceName}</td>
                  <td className="px-3 py-2 text-right">{cell(r.optOut)}</td>
                  <td className="px-3 py-2 text-right">{cell(r.noOptOut)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="font-medium">{diff > 0 ? `+${formatNumber(diff)}` : formatNumber(diff)}</span>
                    {r.difference !== null && (
                      <span className="block text-[11px] text-muted-foreground">
                        {r.difference > 0 ? "+" : ""}
                        {r.difference.toFixed(2)} pts per lead
                      </span>
                    )}
                  </td>
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
        Difference is Opt Out minus No Opt Out. &ldquo;Clearly ahead&rdquo; means the gap per lead emailed holds at 95% confidence
        in that workspace on its own — a workspace with few sends rarely gets there.
      </p>
    </div>
  );
}

function GroupCard({ title, totals, accent, ...rest }: { title: string; totals: GroupTotals; accent?: boolean; "data-group"?: string }) {
  return (
    <div className={`pv-card p-4 sm:p-5 ${accent ? "border-accent/40" : ""}`} {...rest}>
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums" data-positive>
        {formatNumber(totals.positive)}
      </div>
      <div className="text-sm">positive repl{totals.positive === 1 ? "y" : "ies"}</div>
      <div className="mt-1.5 text-xs text-muted-foreground" data-rate>
        from {formatNumber(totals.contacted)} lead{totals.contacted === 1 ? "" : "s"} emailed · {pct(totals.rate)} rate
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {formatNumber(totals.campaigns)} campaign{totals.campaigns === 1 ? "" : "s"} · {formatNumber(totals.sending)} sent in the range
      </div>
    </div>
  );
}
