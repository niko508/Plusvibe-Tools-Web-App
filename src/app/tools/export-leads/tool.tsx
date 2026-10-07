"use client";

// Export Not Contacted Leads. The campaigns are read one page at a time from
// the browser — a campaign of tens of thousands of leads never has to fit in
// one request — then combined into one CSV and downloaded. Downloading only
// reads; deleting the exported leads is a separate, confirmed step offered
// once a complete download has happened.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CampaignSummary, Workspace } from "@/lib/plusvibe-types";
import { ApiClientError, deleteCampaignLeads, fetchCampaigns, fetchLeadsPreview, fetchNotContactedPage, fetchWorkspaces } from "@/lib/api-client";
import { columnsOf, combineLeads, deletionPlan, DELETE_CHUNK, fileName, toCsv, type CampaignLeads } from "@/lib/export-leads/rows";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, ChevronDownIcon, DownloadIcon, TrashIcon } from "@/components/icons";

const errMessage = (err: unknown) => (err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");

interface Progress {
  campaign: string;
  index: number;
  total: number;
  read: number;
}

interface Done {
  rows: number;
  merged: number;
  columns: number;
  perCampaign: { name: string; leads: number }[];
  wrongStatus: number;
  stopped: boolean;
  file: string;
}

/** What a complete download exported, per campaign — what a delete may remove. */
interface Exported {
  campaignId: string;
  campaignName: string;
  emails: string[];
}

interface DeleteProgress {
  campaign: string;
  index: number;
  total: number;
  step: "checking" | "deleting";
  done: number;
}

interface DeleteResult {
  campaignName: string;
  deleted: number;
  /** Exported but no longer not-contacted (contacted since, or already gone): kept. */
  skipped: number;
  error?: string;
}

export function ExportLeadsTool() {
  const { hasKey, ready } = useApiKey();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ws, setWs] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  /** Not-contacted leads per campaign, read when it is ticked. */
  const [counts, setCounts] = useState<Record<string, number | "loading" | "error">>({});
  const [onePerEmail, setOnePerEmail] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<Exported[] | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [delProgress, setDelProgress] = useState<DeleteProgress | null>(null);
  const [delResults, setDelResults] = useState<{ results: DeleteResult[]; stopped: boolean } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const delCtrl = useRef<AbortController | null>(null);
  /** Counts are read one after another, so ticking many at once stays under Plusvibe's rate limit. */
  const countQueue = useRef<Promise<void>>(Promise.resolve());

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces((await fetchWorkspaces()).workspaces ?? []);
    } catch (err) {
      setError(errMessage(err));
    }
  }, []);
  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  useEffect(() => {
    setCampaigns([]);
    setPicked([]);
    setCounts({});
    setDone(null);
    setExported(null);
    setDelResults(null);
    if (!ws) return;
    let cancelled = false;
    setCampaignsLoading(true);
    fetchCampaigns({ workspace_id: ws, campaign_type: "parent" })
      .then((r) => !cancelled && setCampaigns(r.campaigns ?? []))
      .catch((err) => !cancelled && setError(errMessage(err)))
      .finally(() => !cancelled && setCampaignsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ws]);

  function toggle(id: string) {
    setDone(null);
    setExported(null);
    setDelResults(null);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    if (counts[id] === undefined) {
      setCounts((c) => ({ ...c, [id]: "loading" }));
      const workspaceId = ws;
      countQueue.current = countQueue.current.then(() =>
        fetchLeadsPreview({ workspace_id: workspaceId, campaign_id: id })
          .then((r) => setCounts((c) => ({ ...c, [id]: r.available })))
          .catch(() => setCounts((c) => ({ ...c, [id]: "error" })))
      );
    }
  }

  const q = filter.trim().toLowerCase();
  const shown = campaigns.filter((c) => !q || c.name.toLowerCase().includes(q));
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.includes(c.id));
  const expected = useMemo(() => picked.reduce((n, id) => n + (typeof counts[id] === "number" ? (counts[id] as number) : 0), 0), [picked, counts]);
  const deleting = delProgress !== null;
  const running = progress !== null || deleting;
  const toDelete = exported?.reduce((n, x) => n + x.emails.length, 0) ?? 0;
  const confirmed = confirmText.trim().toUpperCase() === "DELETE" || confirmText.trim().replace(/[,\s]/g, "") === String(toDelete);

  async function run() {
    if (running || picked.length === 0) return;
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setDone(null);
    setExported(null);
    setDelResults(null);
    setConfirmText("");
    const order = campaigns.filter((x) => picked.includes(x.id));
    const collected: CampaignLeads[] = [];
    let wrongStatus = 0;
    let stopped = false;
    try {
      for (let i = 0; i < order.length; i++) {
        const camp = order[i];
        const rows: CampaignLeads["rows"] = [];
        collected.push({ campaignName: camp.name, rows });
        for (let page = 1; ; page++) {
          setProgress({ campaign: camp.name, index: i, total: order.length, read: rows.length });
          const r = await fetchNotContactedPage({ workspace_id: ws, campaign_id: camp.id, page }, c.signal);
          rows.push(...r.leads);
          wrongStatus += r.wrongStatus;
          if (!r.more) break;
        }
      }
    } catch (err) {
      if (c.signal.aborted) stopped = true;
      else {
        setError(`${errMessage(err)} Nothing was downloaded.`);
        setProgress(null);
        return;
      }
    }
    const { rows, merged } = combineLeads(collected, onePerEmail);
    const columns = columnsOf(rows);
    const name = fileName(workspaces.find((w) => w._id === ws)?.name ?? "workspace", new Date().toISOString().slice(0, 10));
    if (rows.length > 0) {
      const blob = new Blob(["﻿" + toCsv(rows, columns)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    // Only a complete download can be followed by a delete: after a stop, the
    // CSV is missing leads the delete would otherwise have to guess at.
    if (!stopped && rows.length > 0) {
      setExported(
        order.map((camp, i) => ({
          campaignId: camp.id,
          campaignName: camp.name,
          emails: collected[i].rows.map((r) => String(r.email ?? "").trim()).filter(Boolean),
        }))
      );
    }
    setDone({
      rows: rows.length,
      merged,
      columns: columns.length,
      perCampaign: collected.map((x) => ({ name: x.campaignName, leads: x.rows.length })),
      wrongStatus,
      stopped,
      file: name,
    });
    setProgress(null);
    ctrl.current = null;
  }

  /**
   * Deletes the exported leads, each from the campaign it was exported from.
   * Every campaign's not-contacted leads are read again first and only leads
   * that are still not contacted are deleted — one contacted since the
   * download keeps its history in the campaign.
   */
  async function deleteExported() {
    if (!exported || running || !confirmed) return;
    const c = new AbortController();
    delCtrl.current = c;
    setError(null);
    const results: DeleteResult[] = [];
    let stopped = false;
    for (let i = 0; i < exported.length; i++) {
      const camp = exported[i];
      if (camp.emails.length === 0) continue;
      const result: DeleteResult = { campaignName: camp.campaignName, deleted: 0, skipped: 0 };
      results.push(result);
      try {
        const current: string[] = [];
        for (let page = 1; ; page++) {
          setDelProgress({ campaign: camp.campaignName, index: i, total: exported.length, step: "checking", done: current.length });
          const r = await fetchNotContactedPage({ workspace_id: ws, campaign_id: camp.campaignId, page }, c.signal);
          for (const l of r.leads) if (l.email) current.push(String(l.email));
          if (!r.more) break;
        }
        const plan = deletionPlan(camp.emails, current);
        result.skipped = plan.skipped;
        for (let k = 0; k < plan.remove.length; k += DELETE_CHUNK) {
          setDelProgress({ campaign: camp.campaignName, index: i, total: exported.length, step: "deleting", done: result.deleted });
          const chunk = plan.remove.slice(k, k + DELETE_CHUNK);
          await deleteCampaignLeads({ workspaceId: ws, campaignId: camp.campaignId, emails: chunk }, c.signal);
          result.deleted += chunk.length;
        }
      } catch (err) {
        if (c.signal.aborted) {
          stopped = true;
          break;
        }
        result.error = errMessage(err);
      }
    }
    setDelResults({ results, stopped });
    setDelProgress(null);
    setConfirmText("");
    // What was deleted can't be deleted again; a stopped or failed run can be
    // finished by downloading afresh.
    setExported(null);
    setCounts({});
    delCtrl.current = null;
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="el-ws">
              Workspace
            </label>
            <div className="relative">
              <select id="el-ws" className="pv-input appearance-none pr-9" value={ws} disabled={running} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
                <option value="">Pick a workspace</option>
                {workspaces.map((w) => (
                  <option key={w._id} value={w._id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>
        </div>

        {ws && (
          <div data-campaigns>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Campaigns{picked.length > 0 ? ` · ${picked.length} picked` : ""}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {campaigns.length > 8 && (
                  <input className="pv-input w-48 py-1 text-xs" placeholder="Filter campaigns…" value={filter} aria-label="Filter campaigns" onChange={(e) => setFilter(e.target.value)} />
                )}
                <button
                  type="button"
                  className="pv-btn-ghost py-1 text-xs disabled:opacity-50"
                  disabled={running || shown.length === 0}
                  onClick={() => {
                    if (allShownPicked) setPicked((p) => p.filter((id) => !shown.some((c) => c.id === id)));
                    else for (const c of shown) if (!picked.includes(c.id)) toggle(c.id);
                  }}
                  data-pick-all
                >
                  {allShownPicked ? "Clear" : q ? "Pick shown" : "Pick all"}
                </button>
              </div>
            </div>
            {campaignsLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size={12} /> Loading campaigns…
              </p>
            ) : (
              <div className="pv-scroll max-h-80 overflow-y-auto rounded-xl border border-border p-1.5">
                {shown.map((c) => {
                  const n = counts[c.id];
                  return (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/40" data-campaign-option={c.id}>
                      <input type="checkbox" checked={picked.includes(c.id)} disabled={running} onChange={() => toggle(c.id)} aria-label={`Pick ${c.name}`} />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      {picked.includes(c.id) && (
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-count={c.id}>
                          {n === "loading" ? <Spinner size={10} /> : n === "error" ? "count unknown" : typeof n === "number" ? `${formatNumber(n)} not contacted` : ""}
                        </span>
                      )}
                    </label>
                  );
                })}
                {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{campaigns.length === 0 ? "No campaigns in this workspace." : "No campaign matches."}</p>}
              </div>
            )}
          </div>
        )}

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={onePerEmail} disabled={running} onChange={(e) => setOnePerEmail(e.target.checked)} aria-label="One row per email" />
          <span>
            <span className="font-medium">One row per email</span>
            <span className="block text-xs text-muted-foreground">
              A lead in several campaigns — a 🟡 campaign and its 🔵 copy, say — comes out once, with every campaign it is in.
              Unticked, it comes out once per campaign.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={running || picked.length === 0} onClick={run} data-download>
            {running ? <Spinner /> : <DownloadIcon size={16} />}
            {running ? "Reading the leads…" : `Download CSV${expected > 0 ? ` · about ${formatNumber(expected)} leads` : ""}`}
          </button>
          {running && progress && (
            <>
              <span className="text-xs text-muted-foreground" data-progress>
                {progress.campaign} ({progress.index + 1} of {progress.total}) · {formatNumber(progress.read)} read
              </span>
              <button type="button" className="pv-btn-ghost text-xs" onClick={() => ctrl.current?.abort()}>
                Stop and download what&apos;s read
              </button>
            </>
          )}
          {!running && picked.length === 0 && ws && <span className="text-xs text-muted-foreground">Tick the campaigns to export.</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          Only leads not contacted yet. Every field and custom variable comes along (segment, opening line…), plus a campaign
          column; the campaign&apos;s own bookkeeping — ids, send counts, status — doesn&apos;t. Downloading changes nothing in
          Plusvibe; once it&apos;s done you can delete the exported leads from their campaigns.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {done && (
        <div className="pv-card p-4 sm:p-5" data-done>
          <p className="flex items-center gap-2 text-sm font-medium">
            {done.rows > 0 ? <CheckIcon size={16} className="text-success" /> : <AlertIcon size={16} className="text-warning" />}
            {done.rows > 0
              ? `${done.stopped ? "Stopped — downloaded what was read: " : "Downloaded "}${formatNumber(done.rows)} lead${done.rows === 1 ? "" : "s"} · ${done.file}`
              : "No not-contacted leads in those campaigns, so there was nothing to download."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatNumber(done.columns)} columns
            {done.merged > 0 ? ` · ${formatNumber(done.merged)} in more than one campaign, kept once` : ""}.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {done.perCampaign.map((p) => (
              <li key={p.name} className="flex justify-between gap-3">
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(p.leads)}</span>
              </li>
            ))}
          </ul>
          {done.wrongStatus > 0 && (
            <p className="mt-2 text-xs text-warning">
              Plusvibe also sent {formatNumber(done.wrongStatus)} lead{done.wrongStatus === 1 ? "" : "s"} that had been contacted; they were left out.
            </p>
          )}
          {done.stopped && done.rows > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">Deleting is only offered after a complete download — run it again without stopping to get that option.</p>
          )}
        </div>
      )}

      {exported && toDelete > 0 && !delResults && (
        <div className="pv-card space-y-3 border-danger/30 p-4 sm:p-5" data-delete-card>
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <TrashIcon size={16} className="text-danger" />
              Delete these {formatNumber(toDelete)} lead{toDelete === 1 ? "" : "s"} from their campaigns
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Check the CSV first — deleted leads can&apos;t be brought back. Each lead is deleted only from the campaign it was
              exported from{exported.length > 1 ? " (a lead in two campaigns is deleted from both)" : ""}. The campaigns are read
              again just before: a lead contacted since the download is kept. Keep this tab open while it runs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="pv-input w-60 py-1.5 text-sm"
              placeholder={`Type DELETE or ${toDelete}`}
              value={confirmText}
              disabled={running}
              onChange={(e) => setConfirmText(e.target.value)}
              aria-label="Confirm delete"
              data-delete-confirm
            />
            <button
              type="button"
              className="pv-btn bg-danger text-white shadow-soft hover:brightness-110 disabled:opacity-50"
              disabled={running || !confirmed}
              onClick={deleteExported}
              data-delete-run
            >
              {deleting ? <Spinner /> : <TrashIcon size={16} />}
              {deleting ? "Deleting…" : `Delete ${formatNumber(toDelete)} lead${toDelete === 1 ? "" : "s"}`}
            </button>
            {deleting && delProgress && (
              <>
                <span className="text-xs text-muted-foreground" data-delete-progress>
                  {delProgress.campaign} ({delProgress.index + 1} of {delProgress.total}) ·{" "}
                  {delProgress.step === "checking" ? `checking, ${formatNumber(delProgress.done)} still not contacted` : `${formatNumber(delProgress.done)} deleted`}
                </span>
                <button type="button" className="pv-btn-ghost text-xs" onClick={() => delCtrl.current?.abort()}>
                  Stop
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {delResults && (
        <div className="pv-card p-4 sm:p-5" data-delete-done>
          {(() => {
            const deleted = delResults.results.reduce((n, r) => n + r.deleted, 0);
            const skipped = delResults.results.reduce((n, r) => n + r.skipped, 0);
            const failed = delResults.results.filter((r) => r.error).length;
            return (
              <>
                <p className="flex items-center gap-2 text-sm font-medium">
                  {failed || delResults.stopped ? <AlertIcon size={16} className="text-warning" /> : <CheckIcon size={16} className="text-success" />}
                  {delResults.stopped ? "Stopped — " : ""}Deleted {formatNumber(deleted)} lead{deleted === 1 ? "" : "s"}
                  {skipped > 0 ? ` · kept ${formatNumber(skipped)} no longer not contacted` : ""}
                </p>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {delResults.results.map((r) => (
                    <li key={r.campaignName} className="flex justify-between gap-3">
                      <span className="truncate">{r.campaignName}</span>
                      <span className={`shrink-0 tabular-nums ${r.error ? "text-danger" : "text-muted-foreground"}`}>
                        {formatNumber(r.deleted)} deleted{r.skipped > 0 ? ` · ${formatNumber(r.skipped)} kept` : ""}
                        {r.error ? ` · ${r.error}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                {(failed > 0 || delResults.stopped) && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    To finish, download the same campaigns again — what&apos;s left is what wasn&apos;t deleted — and delete from there.
                  </p>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
