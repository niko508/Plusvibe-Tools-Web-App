"use client";

// The Remove tab: deletes every not-contacted lead from the picked campaigns,
// without a download first. Each campaign is emptied a page at a time — read
// its first page of not-contacted leads, delete exactly those, read the first
// page again — so the gap between seeing a lead not contacted and deleting it
// is one request, and a lead contacted meanwhile stays out of the next read.

import { useRef, useState } from "react";
import { deleteCampaignLeads, fetchNotContactedPage } from "@/lib/api-client";
import { withRetry } from "@/lib/client-retry";
import { CampaignPick, errMessage, useCampaignPick } from "@/components/campaign-pick";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, TrashIcon } from "@/components/icons";

/** Rounds per campaign beyond its count, before giving up on a campaign that won't empty. */
const ROUND_SLACK = 20;
const HARD_ROUNDS = 5000;

interface Progress {
  campaign: string;
  index: number;
  total: number;
  deleted: number;
  retry?: number;
}

interface Result {
  campaignName: string;
  deleted: number;
  error?: string;
}

export function RemoveLeadsTool() {
  const { hasKey, ready } = useApiKey();
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<{ results: Result[]; stopped: boolean } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const pick = useCampaignPick({
    enabled: ready && hasKey,
    onError: setError,
    onChange: () => setResults(null),
  });
  const { campaigns, picked, ws, expected, countsKnown } = pick;
  const running = progress !== null;
  const typed = confirmText.trim();
  const confirmed = typed.toUpperCase() === "DELETE" || (countsKnown && typed.replace(/[,\s]/g, "") === String(expected));

  async function run() {
    if (running || picked.length === 0 || !confirmed) return;
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setResults(null);
    const order = campaigns.filter((x) => picked.includes(x.id));
    const out: Result[] = [];
    let stopped = false;
    for (let i = 0; i < order.length; i++) {
      const camp = order[i];
      const result: Result = { campaignName: camp.name, deleted: 0 };
      out.push(result);
      const count = pick.counts[camp.id];
      const maxRounds = Math.min(HARD_ROUNDS, typeof count === "number" ? Math.ceil(count / 100) + ROUND_SLACK : HARD_ROUNDS);
      let last = new Set<string>();
      try {
        for (let round = 0; ; round++) {
          if (round >= maxRounds) throw new Error("The campaign kept returning leads after every round; stopped to be safe.");
          const at: Progress = { campaign: camp.name, index: i, total: order.length, deleted: result.deleted };
          setProgress(at);
          const r = await withRetry(() => fetchNotContactedPage({ workspace_id: ws, campaign_id: camp.id, page: 1 }, c.signal), c.signal, (secs) => setProgress({ ...at, retry: secs }));
          // Plusvibe sent contacted leads: its status filter isn't holding,
          // and reading page 1 over and over would never get past them.
          if (r.wrongStatus > 0) throw new Error("Plusvibe returned contacted leads in the not-contacted list; stopped so none of them is deleted.");
          const emails = r.leads.map((l) => String(l.email ?? "").trim()).filter(Boolean);
          if (emails.length === 0) break;
          if (emails.every((e) => last.has(e.toLowerCase()))) throw new Error("Plusvibe didn't delete the last batch; stopped.");
          await withRetry(() => deleteCampaignLeads({ workspaceId: ws, campaignId: camp.id, emails }, c.signal), c.signal, (secs) => setProgress({ ...at, retry: secs }));
          result.deleted += emails.length;
          last = new Set(emails.map((e) => e.toLowerCase()));
        }
      } catch (err) {
        if (c.signal.aborted) {
          stopped = true;
          break;
        }
        result.error = errMessage(err);
      }
    }
    setResults({ results: out, stopped });
    setProgress(null);
    setConfirmText("");
    pick.refreshCounts();
    ctrl.current = null;
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={pick.loadWorkspaces} />;

  const deleted = results?.results.reduce((n, r) => n + r.deleted, 0) ?? 0;
  const failed = results?.results.filter((r) => r.error).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <CampaignPick pick={pick} disabled={running} idPrefix="rl" />

        {picked.length > 0 && (
          <div className="space-y-3 rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm" data-remove-card>
            <p className="font-medium text-danger">
              Delete every not-contacted lead from {picked.length === 1 ? "this campaign" : `these ${picked.length} campaigns`}
              {countsKnown ? ` — ${formatNumber(expected)} lead${expected === 1 ? "" : "s"}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Deleted leads can&apos;t be brought back — if you need them, download them on the Export tab first. Only leads
              not contacted yet are deleted, and only from the picked campaigns: contacted, replied and bounced leads stay, and
              the same address in another campaign isn&apos;t touched. Keep this tab open while it runs.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <input
                className="pv-input w-60 py-1.5 text-sm"
                placeholder={countsKnown ? `Type DELETE or ${expected}` : "Type DELETE"}
                value={confirmText}
                disabled={running}
                onChange={(e) => setConfirmText(e.target.value)}
                aria-label="Confirm delete"
                data-remove-confirm
              />
              <button type="button" className="pv-btn bg-danger text-white shadow-soft hover:brightness-110 disabled:opacity-50" disabled={running || !confirmed} onClick={run} data-remove-run>
                {running ? <Spinner /> : <TrashIcon size={16} />}
                {running ? "Deleting…" : "Delete not-contacted leads"}
              </button>
              {running && progress && (
                <>
                  <span className="text-xs text-muted-foreground" data-remove-progress>
                    {progress.campaign} ({progress.index + 1} of {progress.total}) · {formatNumber(progress.deleted)} deleted
                    {progress.retry ? ` · no answer, trying again in ${progress.retry}s` : ""}
                  </span>
                  <button type="button" className="pv-btn-ghost text-xs" onClick={() => ctrl.current?.abort()}>
                    Stop
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {!running && picked.length === 0 && ws && <p className="text-xs text-muted-foreground">Tick the campaigns to empty of not-contacted leads.</p>}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {results && (
        <div className="pv-card p-4 sm:p-5" data-remove-done>
          <p className="flex items-center gap-2 text-sm font-medium">
            {failed || results.stopped ? <AlertIcon size={16} className="text-warning" /> : <CheckIcon size={16} className="text-success" />}
            {results.stopped ? "Stopped — " : ""}Deleted {formatNumber(deleted)} not-contacted lead{deleted === 1 ? "" : "s"}
          </p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {results.results.map((r) => (
              <li key={r.campaignName} className="flex justify-between gap-3">
                <span className="truncate">{r.campaignName}</span>
                <span className={`shrink-0 tabular-nums ${r.error ? "text-danger" : "text-muted-foreground"}`}>
                  {formatNumber(r.deleted)} deleted
                  {r.error ? ` · ${r.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {(failed > 0 || results.stopped) && (
            <p className="mt-2 text-xs text-muted-foreground">Run it again to carry on — it picks up whatever is still not contacted.</p>
          )}
        </div>
      )}
    </div>
  );
}
