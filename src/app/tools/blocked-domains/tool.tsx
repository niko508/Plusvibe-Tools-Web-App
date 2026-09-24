"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";
import { isBlocked } from "@/lib/jobs/blocked-inboxes-types";
import { GOOGLE_TIERS, MICROSOFT_TIERS, JUDGE_WINDOW_DAYS, describeRule, describeTier, type Tier } from "@/lib/blocked-inboxes/rules";
import { blockedDomains } from "@/lib/blocked-inboxes/domains";
import {
  fetchBlockedDomains,
  setBlockedDomainSettings,
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
import { AlertIcon, CheckIcon, ChevronDownIcon, CopyIcon, FireIcon, GaugeIcon } from "@/components/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { formatNumber } from "@/lib/format";
import { needsYou, stoppedCount } from "@/lib/blocked-domains/triage";
import { JobCard } from "./job-card";
import { InboxCard } from "./inbox-card";
import { BlockedDomainsList, BlockedInboxesView } from "./blocked-lists";
import { StatsView } from "./stats-view";

/** Polled while anything is in flight; slower otherwise, since Clay drives it. */
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 20000;
/** Recent runs shown on Home before "more". */
const RECENT = 15;

type Section = "home" | "inboxes" | "domains" | "stats";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "inboxes", label: "Blocked Inboxes" },
  { id: "domains", label: "Blocked Domains" },
  { id: "stats", label: "Stats" },
];

export function BlockedDomainsTool() {
  const { hasKey, ready } = useApiKey();

  const [section, setSection] = useState<Section>("home");
  const [view, setView] = useState<BlockedDomainsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingToggle, setSavingToggle] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recentShown, setRecentShown] = useState(RECENT);
  const [oldOpen, setOldOpen] = useState(false);
  const [checkEmail, setCheckEmail] = useState("");
  const [checking, setChecking] = useState(false);
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
    const busy = (s: string) => s === "working" || s === "deleting";
    const active = view.jobs.some((j) => busy(j.status)) || (view.inboxJobs ?? []).some((j) => busy(j.status));
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

  async function toggleAutoDelete() {
    setSavingToggle(true);
    setError(null);
    try {
      await setBlockedDomainSettings({ autoDelete: !view?.settings.autoDelete });
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSavingToggle(false);
      await refresh();
    }
  }

  async function checkInbox() {
    if (!checkEmail.trim()) return;
    setChecking(true);
    setError(null);
    try {
      await blockedInboxAction({ action: "check", email: checkEmail.trim() });
      setCheckEmail("");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setChecking(false);
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

  async function handleCopyUrl() {
    const url = typeof window !== "undefined" ? `${window.location.origin}/api/hooks/blocked-domain` : "";
    if (await copyToClipboard(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
  const recent = inboxJobs.filter((j) => j.status !== "awaiting_confirmation");

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

  const readiness = view?.readiness;
  const notReady = readiness
    ? [
        !readiness.webhookSecret && "BLOCKED_DOMAIN_WEBHOOK_SECRET — until this is set the webhook rejects every call",
        !readiness.serverKey && "PLUSVIBE_API_KEY — without it the webhook has no key to find or delete inboxes",
        !readiness.spreadsheet && "SPREADSHEET_ID — without it the Domains and Google Inboxes to Cancel tabs are left alone",
        !readiness.sheetWriting && "GOOGLE_SERVICE_ACCOUNT_JSON — without it the sheet can be read but not written",
        readiness.jobStorage?.onVolume === false &&
          "JOBS_DIR — points at the container's own disk, so every deploy wipes the log; mount a volume in Railway and set JOBS_DIR to a path inside it",
      ].filter(Boolean as unknown as (v: unknown) => v is string)
    : [];
  const storage = readiness?.jobStorage;

  const badge = (id: Section) =>
    id === "home" ? stats.waiting : id === "inboxes" ? stats.blocked : id === "domains" ? domainCount : 0;

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
          onRemove={(id) => withBusy(id, () => blockedInboxAction({ action: "remove", jobId: id }))}
          onConfirmAll={confirmAll}
          confirmingAll={confirmingAll}
        />
      )}
      {section === "domains" && <BlockedDomainsList jobs={inboxJobs} />}
      {section === "stats" && <StatsView inboxJobs={inboxJobs} domainJobs={domainJobs} />}

      {section === "home" && (
        <>
          <div className="pv-card p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="min-w-[260px] flex-1 space-y-4">
                <div>
                  <h2 className="text-sm font-semibold">Clay webhook</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    POST the <strong>sender inbox</strong> that bounced to this URL, with the header{" "}
                    <span className="font-mono">x-webhook-secret</span> and a body of{" "}
                    <span className="font-mono">{'{ "email": "sender@domain.com" }'}</span>. That inbox — only that inbox —
                    is read over its last {JUDGE_WINDOW_DAYS} days and judged on the rules. Repeat bounces are counted,
                    not re-run: a blocked inbox is never judged again, and one that passed is judged again on its first
                    bounce 24 hours later.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 truncate rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
                      {typeof window !== "undefined" ? `${window.location.origin}/api/hooks/blocked-domain` : "/api/hooks/blocked-domain"}
                    </code>
                    <button type="button" className="pv-btn-ghost" onClick={handleCopyUrl} aria-label="Copy the webhook URL">
                      {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                    </button>
                  </div>
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Check an inbox now</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Runs one inbox exactly as if Clay had sent it.</p>
                  <div className="mt-2 flex max-w-md items-center gap-2">
                    <input
                      className="pv-input"
                      placeholder="sender@domain.com"
                      value={checkEmail}
                      aria-label="Inbox to check"
                      data-check-email
                      onChange={(e) => setCheckEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void checkInbox();
                      }}
                    />
                    <button type="button" className="pv-btn-primary disabled:opacity-50" data-check disabled={checking || !checkEmail.trim()} onClick={checkInbox}>
                      {checking ? <Spinner size={14} /> : <GaugeIcon size={14} />} Check
                    </button>
                  </div>
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Full automation</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {view?.settings.autoDelete
                      ? "A blocked inbox is stopped and deleted straight away, with no confirmation."
                      : "A blocked inbox is stopped straight away — sending and warmup off — and its deletion waits for you here."}{" "}
                    Nothing is done to a domain as a whole: no domain-wide warmup pause, no Not Active in the Domains tab,
                    nothing on 🚯 Tenants to Cancel. A blocked Google inbox is listed on 🛑 Google Inboxes to Cancel.
                  </p>
                  <button
                    type="button"
                    disabled={savingToggle || !view}
                    onClick={toggleAutoDelete}
                    data-auto-delete={String(!!view?.settings.autoDelete)}
                    className={`mt-2 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
                      view?.settings.autoDelete ? "border-danger/40 bg-danger/10 text-danger" : "border-border hover:text-foreground"
                    }`}
                  >
                    {savingToggle ? <Spinner size={12} /> : <FireIcon size={13} />}
                    {view?.settings.autoDelete ? "Auto-delete is ON" : "Auto-delete is OFF"}
                  </button>
                </div>
              </div>

              <div className="min-w-[280px] flex-1" data-rules>
                <h2 className="text-sm font-semibold">The rules</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Last {JUDGE_WINDOW_DAYS} days of the one inbox. Bounce rate is over everything sent; reply rates are over
                  unique leads contacted, and the OOO reply rate counts out-of-office replies too. An inbox that is neither
                  Microsoft nor Google is left alone.
                </p>
                <RulesTable title="Microsoft (Azure)" tiers={MICROSOFT_TIERS} />
                <RulesTable title="Google" tiers={GOOGLE_TIERS} />
              </div>
            </div>

            {notReady.length > 0 && (
              <div className="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-3">
                <p className="text-xs font-medium text-warning">Not ready to run unattended — set these on Railway:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {notReady.map((n) => (
                    <li key={n}>
                      <span className="font-mono">{n.split(" — ")[0]}</span>
                      {" — "}
                      {n.split(" — ")[1]}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {storage && (
              <p className={`mt-3 text-xs ${storage.onVolume === false ? "text-warning" : "text-muted-foreground"}`}>
                Job records: <span className="font-mono">{storage.dir}</span>
                {storage.onVolume === true
                  ? ` — on a volume${storage.mountPoint ? ` mounted at ${storage.mountPoint}` : ""}, kept across deploys.`
                  : storage.onVolume === false
                    ? " — on the container's own disk, wiped on every deploy."
                    : " — could not tell whether this survives a deploy."}
              </p>
            )}
          </div>

          {stats.checked > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-home-stats>
              <Stat label="Inboxes checked" value={stats.checked} />
              <Stat label="Waiting for you" value={stats.waiting} tone={stats.waiting > 0 ? "warning" : undefined} />
              <Stat label="Blocked" value={stats.blocked} tone={stats.blocked > 0 ? "danger" : undefined} />
              <Stat label="Deleted" value={stats.deleted} />
              <Stat label="Passed" value={stats.passed} />
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
                Nothing has come through from Clay since the automation moved to inboxes. Point the Clay column at the
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

function RulesTable({ title, tiers }: { title: string; tiers: Tier[] }) {
  return (
    <div className="mt-3">
      <div className="text-xs font-medium">{title}</div>
      <table className="mt-1 w-full text-xs">
        <tbody>
          {tiers.map((t) => (
            <tr key={t.min} className="border-t border-border">
              <td className="py-1.5 pr-3 text-muted-foreground">{describeTier(t)}</td>
              <td className="py-1.5">blocked when {describeRule(t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
