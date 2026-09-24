"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";
import { isBlocked } from "@/lib/jobs/blocked-inboxes-types";
import { blockedDomains } from "@/lib/blocked-inboxes/domains";
import {
  fetchBlockedDomains,
  confirmBlockedDomain,
  dismissBlockedDomain,
  rearmBlockedDomain,
  rejudgeBlockedDomain,
  restoreBlockedDomainInboxes,
  undoBlockedDomainWriteOff,
  deleteStoppedBlockedDomainInboxes,
  listBlockedDomainGoogleInboxes,
  deleteBlockedDomainJob,
  blockedInboxAction,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, ChevronDownIcon, FireIcon } from "@/components/icons";
import { formatNumber } from "@/lib/format";
import { needsYou, stoppedCount } from "@/lib/blocked-domains/triage";
import { JobCard } from "./job-card";
import { InboxCard } from "./inbox-card";
import { BlockedDomainsList, BlockedInboxesView } from "./blocked-lists";
import { StatsView } from "./stats-view";
import { SettingsView } from "./settings-view";
import { TenantBlocksView, isTenantBlock } from "./tenant-blocks";

/** Polled while anything is in flight; slower otherwise, since Clay drives it. */
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 20000;
/** Recent runs shown on Home before "more". */
const RECENT = 15;

type Section = "home" | "inboxes" | "domains" | "tenants" | "stats" | "settings";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "inboxes", label: "Blocked Inboxes" },
  { id: "domains", label: "Blocked Domains" },
  { id: "tenants", label: "Tenant Blocks" },
  { id: "stats", label: "Stats" },
  { id: "settings", label: "Settings" },
];

export function BlockedDomainsTool() {
  const { hasKey, ready } = useApiKey();

  const [section, setSection] = useState<Section>("home");
  const [view, setView] = useState<BlockedDomainsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [recentShown, setRecentShown] = useState(RECENT);
  const [oldOpen, setOldOpen] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await fetchBlockedDomains());
    } catch (err) {
      // A failed poll isn't worth a banner — the automation runs server-side
      // regardless of whether this page can reach it.
      if (err instanceof ApiClientError && err.status === 401) setError(err.message);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void refresh();
    else if (ready && !hasKey) setView(null);
  }, [ready, hasKey, refresh]);

  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (!view) return;
    const busy = (s: string) => s === "queued" || s === "working" || s === "deleting";
    const active =
      view.jobs.some((j) => busy(j.status)) ||
      (view.inboxJobs ?? []).some((j) => busy(j.status)) ||
      (view.inboxDomains ?? []).some((d) => d.cancelRequestedAt !== undefined && d.cancelledAt === undefined);
    pollRef.current = setTimeout(() => void refresh(), active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [view, refresh]);

  async function withBusy(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusyId(null);
      await refresh();
    }
  }

  async function confirmAll() {
    setConfirmingAll(true);
    setError(null);
    try {
      await blockedInboxAction({ action: "confirm-all" });
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setConfirmingAll(false);
      await refresh();
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={refresh} />;

  const inboxJobs = view?.inboxJobs ?? [];
  const domainJobs = view?.jobs ?? [];
  const blocked = inboxJobs.filter(isBlocked);
  const waiting = inboxJobs.filter((j) => j.status === "awaiting_confirmation");
  const domainCount = blockedDomains(inboxJobs).length;
  const stats = {
    checked: inboxJobs.length,
    waiting: waiting.length,
    blocked: blocked.length,
    deleted: inboxJobs.filter((j) => j.status === "deleted").length,
    passed: inboxJobs.filter((j) => j.status === "passed").length,
  };
  // Inboxes waiting their turn are counted, not listed: Clay can send hundreds at once.
  const inLine = inboxJobs.filter((j) => j.status === "queued").length;
  const checkingNow = inboxJobs.filter((j) => j.status === "working").length;
  const domainsInLine = (view?.inboxDomains ?? []).filter((d) => d.cancelRequestedAt !== undefined && d.cancelledAt === undefined).length;
  const recent = inboxJobs.filter((j) => j.status !== "awaiting_confirmation" && j.status !== "queued" && j.hiddenAt === undefined);

  // The domain-level runs from before the move to inboxes. Kept: some still
  // have stopped inboxes waiting to be deleted.
  const oldWaiting = domainJobs.filter(needsYou);
  const oldRest = domainJobs.filter((j) => !needsYou(j));
  const oldStopped = oldWaiting.reduce((n, j) => n + stoppedCount(j), 0);
  const oldCard = (job: (typeof domainJobs)[number]) => (
    <JobCard
      key={job.id}
      job={job}
      busy={busyId === job.id}
      onConfirm={(id) => withBusy(id, () => confirmBlockedDomain(id))}
      onDismiss={(id) => withBusy(id, () => dismissBlockedDomain(id))}
      onRearm={(id) => withBusy(id, () => rearmBlockedDomain(id))}
      onRemove={(id) => withBusy(id, () => deleteBlockedDomainJob(id))}
      onRejudge={(id) => withBusy(id, () => rejudgeBlockedDomain({ jobId: id }))}
      onRestore={(id, dailyLimit) => withBusy(id, () => restoreBlockedDomainInboxes(id, dailyLimit))}
      onUndoWriteOff={(id) => withBusy(id, () => undoBlockedDomainWriteOff(id))}
      onDeleteStopped={(id) => withBusy(id, () => deleteStoppedBlockedDomainInboxes(id))}
      onListGoogle={(id) => withBusy(id, () => listBlockedDomainGoogleInboxes(id))}
    />
  );
  const inboxCard = (job: (typeof inboxJobs)[number]) => (
    <InboxCard
      key={job.id}
      job={job}
      busy={busyId === job.id}
      onConfirm={(id) => withBusy(id, () => blockedInboxAction({ action: "confirm", jobId: id }))}
      onDismiss={(id) => withBusy(id, () => blockedInboxAction({ action: "dismiss", jobId: id }))}
      onRemove={(id) => withBusy(id, () => blockedInboxAction({ action: "remove", jobId: id }))}
    />
  );

  const badge = (id: Section) =>
    id === "home"
      ? stats.waiting
      : id === "inboxes"
        ? stats.blocked
        : id === "domains"
          ? domainCount
          : id === "tenants"
            ? (view?.inboxDomains ?? []).filter(isTenantBlock).length
            : 0;

  return (
    <div className="space-y-5">
      <nav role="tablist" aria-label="Blocked Domains sections" className="flex flex-wrap items-center gap-2">
        {SECTIONS.map((s) => {
          const current = section === s.id;
          const n = badge(s.id);
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={current}
              data-section={s.id}
              onClick={() => setSection(s.id)}
              className={`pv-chip ${current ? "pv-chip-active" : "hover:text-foreground"}`}
            >
              {s.label}
              {n > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[10px] tabular-nums ${current ? "bg-accent/15" : "bg-muted"} ${s.id === "home" ? "text-warning" : ""}`}
                  title={s.id === "home" ? "Blocked inboxes waiting for you" : undefined}
                >
                  {formatNumber(n)}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {section === "inboxes" && (
        <BlockedInboxesView
          jobs={inboxJobs}
          busyId={busyId}
          onConfirm={(id) => withBusy(id, () => blockedInboxAction({ action: "confirm", jobId: id }))}
          onDismiss={(id) => withBusy(id, () => blockedInboxAction({ action: "dismiss", jobId: id }))}
          onConfirmAll={confirmAll}
          confirmingAll={confirmingAll}
        />
      )}
      {section === "domains" && (
        <BlockedDomainsList jobs={inboxJobs} states={view?.inboxDomains ?? []} cancelAfter={view?.settings.cancelAfterDeleted ?? 13} />
      )}
      {section === "tenants" && (
        <TenantBlocksView states={view?.inboxDomains ?? []} jobs={inboxJobs} cancelAfter={view?.settings.cancelAfterDeleted ?? 13} />
      )}
      {section === "stats" && <StatsView inboxJobs={inboxJobs} domainJobs={domainJobs} />}
      {section === "settings" && <SettingsView view={view} onChanged={refresh} onError={setError} />}

      {section === "home" && (
        <>
          {view?.readiness &&
            (!view.readiness.webhookSecret || !view.readiness.serverKey || !view.readiness.spreadsheet || !view.readiness.sheetWriting) && (
              <button
                type="button"
                className="flex w-full items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-left text-sm text-warning"
                onClick={() => setSection("settings")}
                data-not-ready
              >
                <AlertIcon size={16} className="mt-0.5 shrink-0" />
                <span>The automation isn&apos;t fully set up on the server — see Settings.</span>
              </button>
            )}
          {stats.checked > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-home-stats>
              <Stat label="Inboxes checked" value={stats.checked} />
              <Stat label="Waiting for you" value={stats.waiting} tone={stats.waiting > 0 ? "warning" : undefined} />
              <Stat label="Blocked" value={stats.blocked} tone={stats.blocked > 0 ? "danger" : undefined} />
              <Stat label="Deleted" value={stats.deleted} />
              <Stat label="Passed" value={stats.passed} />
            </div>
          )}

          {domainsInLine > 0 && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-left text-sm"
              data-domains-in-line
              onClick={() => setSection("tenants")}
            >
              <Spinner size={14} />
              <span>
                <strong className="tabular-nums">{formatNumber(domainsInLine)}</strong> {domainsInLine === 1 ? "domain" : "domains"} being blocked as a whole — see Tenant
                Blocks.
              </span>
            </button>
          )}
          {inLine > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm" data-in-line>
              <Spinner size={14} />
              <span>
                <strong className="tabular-nums">{formatNumber(inLine)}</strong> {inLine === 1 ? "inbox" : "inboxes"} in line to be checked
                {checkingNow > 0 ? `, ${formatNumber(checkingNow)} being checked now` : ""}. They are taken a few at a time, so Plusvibe&apos;s
                rate limit isn&apos;t swamped.
              </span>
            </div>
          )}

          {waiting.length > 0 && (
            <div className="space-y-3" data-waiting>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-warning">Blocked — waiting for you ({formatNumber(waiting.length)})</h2>
                <button type="button" className="pv-btn-ghost text-danger disabled:opacity-50" disabled={confirmingAll} onClick={confirmAll}>
                  {confirmingAll ? <Spinner size={14} /> : null} Delete all {formatNumber(waiting.length)}
                </button>
              </div>
              {waiting.map(inboxCard)}
            </div>
          )}

          {recent.length > 0 ? (
            <div className="space-y-3" data-recent>
              <h2 className="text-sm font-semibold">Recent inboxes</h2>
              {recent.slice(0, recentShown).map(inboxCard)}
              {recent.length > recentShown && (
                <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setRecentShown((n) => n + RECENT)}>
                  {formatNumber(recent.length - recentShown)} more
                </button>
              )}
            </div>
          ) : (
            waiting.length === 0 && (
              <EmptyState icon={<FireIcon />} title="No inboxes yet">
                Nothing has come through from Clay since the automation moved to inboxes. The webhook details are on Settings; point the Clay column at the
                sender inbox and every bounce lands here.
              </EmptyState>
            )
          )}

          {domainJobs.length > 0 && (
            <div className="space-y-3 border-t border-border pt-5" data-old-runs>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-sm font-semibold"
                  onClick={() => setOldOpen((v) => !v)}
                  aria-expanded={oldOpen}
                >
                  <ChevronDownIcon size={16} className={`transition-transform ${oldOpen ? "" : "-rotate-90"}`} />
                  Earlier domain-level runs ({formatNumber(domainJobs.length)})
                </button>
                <span className="text-xs text-muted-foreground">
                  From before the automation moved to single inboxes. Nothing new is added here and nothing is scheduled.
                  {oldStopped > 0
                    ? ` ${formatNumber(oldStopped)} stopped inbox${oldStopped === 1 ? "" : "es"} on ${formatNumber(oldWaiting.length)} domain${oldWaiting.length === 1 ? "" : "s"} can still be deleted.`
                    : ""}
                </span>
              </div>
              {oldOpen && (
                <div className="space-y-3">
                  {oldWaiting.map(oldCard)}
                  {oldRest.map(oldCard)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warning" | "danger" }) {
  return (
    <div className="pv-card p-3">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : ""}`}>
        {formatNumber(value)}
      </div>
    </div>
  );
}
