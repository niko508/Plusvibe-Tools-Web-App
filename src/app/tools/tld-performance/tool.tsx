"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TldReport, TldReportSummary, TldStatus } from "@/lib/jobs/tld-performance-types";
import {
  PROVIDER_VIEWS,
  RATING_LABELS,
  VIEW_LABELS,
  buyThese,
  combosCsv,
  domainsCsv,
  monthName,
  type ComboRow,
  type ProviderView,
  type Rating,
} from "@/lib/tld-performance/report";
import {
  ApiClientError,
  deleteTldReport,
  fetchTldReport,
  fetchTldStatus,
  resendTldSheet,
  runTldReport,
  saveTldSettings,
} from "@/lib/api-client";
import { describeDue } from "@/lib/start-outreach/schedule";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { EmptyState, RemoveJobButton, Spinner, TableDisclosure } from "@/components/ui";
import { AlertIcon, ClockIcon, DownloadIcon, GaugeIcon, PlayIcon, SettingsIcon, SheetIcon } from "@/components/icons";

// TLD Performance Tracking.
//
// The point of the page is the short list on top: the combos worth buying
// this month. Everything else — every combo with its numbers, the domains
// behind them, the rules — is one click further down.

const POLL_RUNNING_MS = 3000;

const RATING_CLASS: Record<Rating, string> = {
  best: "bg-success/10 text-success",
  good: "bg-success/5 text-success",
  caution: "bg-warning/10 text-warning",
  avoid: "bg-danger/10 text-danger",
  "little-data": "bg-muted text-muted-foreground",
};

export function TldTool() {
  const { hasKey, ready } = useApiKey();
  const [status, setStatus] = useState<TldStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<TldReport | null>(null);
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await fetchTldStatus();
      setStatus(s);
      setMonth((m) => m || s.lastFullMonth);
      setSelected((cur) => {
        if (cur && s.reports.some((r) => r.id === cur)) return cur;
        return s.reports.find((r) => r.status !== "running")?.id ?? s.reports[0]?.id ?? null;
      });
    } catch (err) {
      setError(errMessage(err));
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void load();
  }, [ready, hasKey, load]);

  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => void load(), POLL_RUNNING_MS);
    return () => clearInterval(t);
  }, [status?.running, load]);

  // The full report — tables included — for the one picked.
  const selectedSummary = status?.reports.find((r) => r.id === selected) ?? null;
  useEffect(() => {
    if (!selected || !selectedSummary || selectedSummary.status === "running") {
      setReport(null);
      return;
    }
    let live = true;
    fetchTldReport(selected)
      .then(({ report: r }) => live && setReport(r))
      .catch((err) => live && setError(errMessage(err)));
    return () => {
      live = false;
    };
  }, [selected, selectedSummary?.status, selectedSummary?.finishedAt, selectedSummary?.sheet?.at, selectedSummary]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await runTldReport(month);
      await load();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={load} />;
  if (!status) {
    return error ? <Warning>{error}</Warning> : <div className="pv-card h-40 animate-pulse" />;
  }

  const running = status.reports.find((r) => r.id === status.running) ?? null;

  return (
    <div className="space-y-5">
      <SchedulePanel status={status} onSaved={load} />

      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="tld-month">
              Month
            </label>
            <input
              id="tld-month"
              type="month"
              className="pv-input w-auto text-sm"
              value={month}
              max={status.lastFullMonth}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={busy || !!status.running || !month}
            onClick={() => void run()}
            data-run
          >
            {busy || running ? <Spinner /> : <PlayIcon size={16} />}
            Make report
          </button>
          <span className="text-xs text-muted-foreground">
            Reads every workspace&apos;s figures for the month — nothing is changed. Takes a minute or two. A month already
            reported is replaced.
          </span>
        </div>
        {running && <Progress r={running} />}
        {error && <Warning>{error}</Warning>}
      </div>

      {status.reports.length === 0 ? (
        <EmptyState icon={<GaugeIcon />} title="No reports yet">
          Make one for {monthName(status.lastFullMonth)} to see which combos are worth buying.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 text-xs" role="radiogroup" aria-label="Report">
            {status.reports.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={selected === r.id}
                className={`pv-chip ${selected === r.id ? "pv-chip-active" : "hover:text-foreground"}`}
                onClick={() => setSelected(r.id)}
                data-report-chip={r.month}
              >
                {monthName(r.month)}
                {r.status === "running" ? " · running" : r.status === "done" ? "" : " · problems"}
              </button>
            ))}
          </div>
          {selectedSummary && report && report.id === selectedSummary.id ? (
            <ReportView
              report={report}
              sheetSet={!!status.settings.sheetUrl}
              onResend={async () => {
                await resendTldSheet(report.id);
                await load();
              }}
              onDelete={async () => {
                await deleteTldReport(report.id);
                setSelected(null);
                await load();
              }}
            />
          ) : selectedSummary?.status === "running" ? null : (
            <div className="pv-card h-40 animate-pulse" />
          )}
        </>
      )}
    </div>
  );
}

function Progress({ r }: { r: TldReportSummary }) {
  const pct = r.progress.workspacesTotal > 0 ? Math.round((r.progress.workspacesDone / r.progress.workspacesTotal) * 100) : 0;
  const phase = {
    registrars: "Reading registrars from 📋 Domains…",
    inboxes: `Reading figures: ${r.progress.workspacesDone} of ${r.progress.workspacesTotal || "…"} workspaces, ${formatNumber(r.progress.inboxes)} inboxes`,
    blocks: "Adding the month's blocked domains…",
    sheet: "Writing to the sheet…",
    finished: "Finishing…",
  }[r.phase];
  return (
    <div data-progress>
      <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
        <span>
          {monthName(r.month)} · {phase}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReportView({
  report,
  sheetSet,
  onResend,
  onDelete,
}: {
  report: TldReport;
  sheetSet: boolean;
  onResend: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [view, setView] = useState<ProviderView>("all");
  const [allOpen, setAllOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const body = report.body;
  const rows = useMemo(() => body?.combos[view] ?? [], [body, view]);
  const buy = useMemo(() => buyThese(rows), [rows]);

  if (!body) {
    return (
      <div className="pv-card space-y-2 p-4 sm:p-5">
        <div className="text-sm font-medium">{monthName(report.month)} could not be made.</div>
        {report.errors.slice(0, 5).map((e, i) => (
          <Warning key={i}>{e}</Warning>
        ))}
        <RemoveJobButton onRemove={onDelete} label="Remove this report" />
      </div>
    );
  }
  const t = body.totals[view];

  function download(name: string, text: string) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5" data-report={report.month}>
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold">Buy these · {monthName(report.month)}</div>
            <div className="text-xs text-muted-foreground">
              {report.trigger === "scheduled" ? "Monthly run" : "Made by hand"}
              {report.finishedAt ? ` · ${describeDue(report.finishedAt)}` : ""} · {report.start} → {report.end}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs" role="radiogroup" aria-label="Mailbox provider">
            {PROVIDER_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                className={`pv-chip ${view === v ? "pv-chip-active" : "hover:text-foreground"}`}
                onClick={() => setView(v)}
                data-view={v}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
        </div>

        {buy.length === 0 ? (
          <p className="rounded-xl border border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No combo cleared the bar for {VIEW_LABELS[view].toLowerCase() === "all" ? "this month" : `${VIEW_LABELS[view]} this month`} — keep
            to last month&apos;s list, or see every combo below.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm" data-buy>
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">Ending</th>
                  <th className="px-3 py-2 text-left font-medium">Registrar</th>
                  <th className="px-3 py-2 text-right font-medium">Reply rate</th>
                  <th className="px-3 py-2 text-right font-medium" title="Replies against what the same clients get on average">
                    Vs its clients
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Domains</th>
                  <th className="px-3 py-2 text-right font-medium">Clients</th>
                  <th className="px-3 py-2 text-right font-medium">Blocked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {buy.map((c) => (
                  <tr key={`${c.tld}|${c.platform}`} className="bg-success/5">
                    <td className="px-3 py-2.5 text-base font-semibold text-success">{c.tld}</td>
                    <td className="px-3 py-2.5 font-medium">{c.platform}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.replyRate}%</td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums">{c.vsClients}x</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(c.domains)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(c.clients)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.blocked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Buy = at least {report.rules.minDomains} domains across {report.rules.minClients}+ clients, replies at or above what
          those clients get elsewhere, and none blocked in the month.
          {report.rules.hiddenPlatforms.length > 0 && ` ${report.rules.hiddenPlatforms.join(" and ")} left out: not bought any more.`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Domains sending" value={formatNumber(t.domains)} sub={VIEW_LABELS[view]} />
        <StatCard label="Emails sent" value={formatNumber(t.sent)} />
        <StatCard label="Real reply rate" value={`${t.replyRate}%`} sub={`${formatNumber(t.replies)} replies`} />
        <StatCard label="Blocked in the month" value={formatNumber(t.blocked)} health={t.blocked > 0 ? "bad" : "good"} />
      </div>

      <div className="pv-card space-y-3 p-4 sm:p-5">
        <TableDisclosure open={allOpen} onToggle={() => setAllOpen(!allOpen)} label={`Every combo · ${rows.length}`}>
          <AllCombos rows={rows} />
        </TableDisclosure>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pv-btn-ghost text-xs" onClick={() => download(`tld-combos-${report.month}-${view}.csv`, combosCsv(rows))}>
            <DownloadIcon size={14} /> Combos CSV
          </button>
          <button type="button" className="pv-btn-ghost text-xs" onClick={() => download(`tld-domains-${report.month}.csv`, domainsCsv(body.domains))}>
            <DownloadIcon size={14} /> Domains CSV
          </button>
          {sheetSet && (
            <button
              type="button"
              className="pv-btn-ghost text-xs disabled:opacity-50"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                try {
                  await onResend();
                } finally {
                  setSending(false);
                }
              }}
            >
              {sending ? <Spinner size={13} /> : <SheetIcon size={14} />} Write to sheet
            </button>
          )}
          <RemoveJobButton onRemove={onDelete} label="Remove this report" />
        </div>

        {report.sheet && (
          <p className={`text-xs ${report.sheet.ok ? "text-muted-foreground" : "text-warning"}`} data-sheet-status>
            {report.sheet.ok ? (
              <>
                Written to the{" "}
                <a
                  className="underline"
                  href={`https://docs.google.com/spreadsheets/d/${report.sheet.spreadsheetId}/edit`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {report.sheet.tab} tab
                </a>
                {report.sheet.at ? ` · ${describeDue(report.sheet.at)}` : ""}
              </>
            ) : (
              `The sheet could not be written: ${report.sheet.error}`
            )}
          </p>
        )}
        {body.unknownPlatform > 0 && (
          <p className="text-xs text-muted-foreground">
            {formatNumber(body.unknownPlatform)} sending domains have no Domain Host in 📋 Domains and no platform tag in
            Plusvibe, so they are counted under Unknown platform and never listed to buy.
          </p>
        )}
        {report.errors.slice(0, 3).map((e, i) => (
          <Warning key={i}>{e}</Warning>
        ))}
      </div>
    </div>
  );
}

function AllCombos({ rows }: { rows: ComboRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-sm" data-all-combos>
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Ending</th>
            <th className="px-3 py-2 text-left font-medium">Registrar</th>
            <th className="px-3 py-2 text-left font-medium">Rating</th>
            <th className="px-3 py-2 text-right font-medium">Domains</th>
            <th className="px-3 py-2 text-right font-medium">Clients</th>
            <th className="px-3 py-2 text-right font-medium">Sent</th>
            <th className="px-3 py-2 text-right font-medium">Reply rate</th>
            <th className="px-3 py-2 text-right font-medium">Clients&apos; rate</th>
            <th className="px-3 py-2 text-right font-medium">Vs clients</th>
            <th className="px-3 py-2 text-right font-medium">Bounces</th>
            <th className="px-3 py-2 text-right font-medium">Blocked</th>
            <th className="px-3 py-2 text-left font-medium">Why</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((c) => (
            <tr key={`${c.tld}|${c.platform}`} className={c.hidden ? "opacity-60" : ""}>
              <td className="px-3 py-2 font-medium">{c.tld}</td>
              <td className="px-3 py-2">{c.platform}</td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RATING_CLASS[c.rating]}`}>
                  {RATING_LABELS[c.rating]}
                </span>
                {c.hidden && <span className="ml-1 text-[11px] text-muted-foreground">not buying</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(c.domains)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{c.clients}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(c.sent)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{c.replyRate}%</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{c.expectedRate}%</td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">{c.vsClients}x</td>
              <td className="px-3 py-2 text-right tabular-nums">{c.bounceRate}%</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {c.blocked}
                {c.blocked > 0 && <span className="text-muted-foreground"> / {c.domainsUsed}</span>}
              </td>
              <td className="max-w-[280px] px-3 py-2 text-xs text-muted-foreground">{c.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchedulePanel({ status, onSaved }: { status: TldStatus; onSaved: () => Promise<void> }) {
  const s = status.settings;
  const [sheetUrl, setSheetUrl] = useState(s.sheetUrl);
  const [sheetTab, setSheetTab] = useState(s.sheetTab);
  const [minDomains, setMinDomains] = useState(String(s.rules.minDomains));
  const [minClients, setMinClients] = useState(String(s.rules.minClients));
  const [hidden, setHidden] = useState(s.rules.hiddenPlatforms.join(", "));
  const [rulesOpen, setRulesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Parameters<typeof saveTldSettings>[0]) {
    setBusy(true);
    setError(null);
    try {
      await saveTldSettings(patch);
      await onSaved();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const sheetDirty = sheetUrl.trim() !== s.sheetUrl || sheetTab.trim() !== s.sheetTab;
  const hiddenList = hidden.split(",").map((p) => p.trim()).filter(Boolean);
  const rulesDirty =
    minDomains !== String(s.rules.minDomains) ||
    minClients !== String(s.rules.minClients) ||
    hiddenList.join("|") !== s.rules.hiddenPlatforms.join("|");

  return (
    <div className="pv-card space-y-4 p-4 sm:p-5" data-schedule>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ClockIcon size={15} /> Monthly report
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            On the 1st of every month at 06:00 Helsinki, makes the report for the month before
            {s.sheetUrl ? " and writes it to the sheet below" : ""}.
            {s.enabled && status.nextRunAt ? (
              <>
                {" "}
                Next: <span className="font-medium text-foreground">{describeDue(status.nextRunAt)}</span>.
              </>
            ) : (
              " Off — nothing runs on its own."
            )}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label="Monthly report on"
          disabled={busy}
          onClick={() => void save({ enabled: !s.enabled })}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            s.enabled ? "bg-accent" : "bg-muted-foreground/30"
          }`}
          data-schedule-switch
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              s.enabled ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {!status.serverKey && s.enabled && (
        <Warning>PLUSVIBE_API_KEY is not set on the server, so the monthly report has no key to run with.</Warning>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="tld-sheet">
            Google Sheet to write to (optional)
          </label>
          <input
            id="tld-sheet"
            type="url"
            className="pv-input text-sm"
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="tld-tab">
            Tab
          </label>
          <input id="tld-tab" className="pv-input text-sm" value={sheetTab} onChange={(e) => setSheetTab(e.target.value)} />
        </div>
        <button
          type="button"
          className="pv-btn-ghost text-xs disabled:opacity-50"
          disabled={busy || !sheetDirty}
          onClick={() => void save({ sheetUrl: sheetUrl.trim(), sheetTab: sheetTab.trim() })}
        >
          Save sheet
        </button>
      </div>
      {s.sheetUrl && !status.sheetWriting && (
        <Warning>Google Sheets writing isn&apos;t set up (GOOGLE_SERVICE_ACCOUNT_JSON), so nothing can be written to the sheet.</Warning>
      )}
      {s.sheetUrl && status.sheetWriting && (
        <p className="text-xs text-muted-foreground">
          Share the sheet with the same service account as the Email Infra sheet, as an Editor. The tab is created if it is
          missing and rewritten each month.
        </p>
      )}

      <div>
        <button type="button" className="pv-btn-ghost text-xs" onClick={() => setRulesOpen(!rulesOpen)} aria-expanded={rulesOpen}>
          <SettingsIcon size={13} /> Rules
        </button>
        {rulesOpen && (
          <div className="mt-3 grid gap-3 sm:grid-cols-[140px_140px_1fr_auto] sm:items-end" data-rules>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="tld-min-domains">
                Minimum domains
              </label>
              <input id="tld-min-domains" type="number" min={1} className="pv-input text-sm" value={minDomains} onChange={(e) => setMinDomains(e.target.value)} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="tld-min-clients">
                Minimum clients
              </label>
              <input id="tld-min-clients" type="number" min={1} className="pv-input text-sm" value={minClients} onChange={(e) => setMinClients(e.target.value)} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="tld-hidden">
                Registrars not bought from
              </label>
              <input id="tld-hidden" className="pv-input text-sm" value={hidden} onChange={(e) => setHidden(e.target.value)} placeholder="Spaceship, Porkbun" />
            </div>
            <button
              type="button"
              className="pv-btn-ghost text-xs disabled:opacity-50"
              disabled={busy || !rulesDirty}
              onClick={() =>
                void save({ rules: { minDomains: Number(minDomains), minClients: Number(minClients), hiddenPlatforms: hiddenList } })
              }
            >
              Save rules
            </button>
            <p className="text-[11px] text-muted-foreground sm:col-span-4">
              New rules apply from the next report. Buy needs replies at or above what its clients get elsewhere and no block
              in the month; OK is within 10% and under 2% blocked; Avoid is 20% or more below, or 5% or more blocked.
            </p>
          </div>
        )}
      </div>

      {error && <Warning>{error}</Warning>}
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-1.5 text-xs text-warning">
      <AlertIcon size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}
