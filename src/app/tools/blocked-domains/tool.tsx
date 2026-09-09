"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";
import {
  fetchBlockedDomains,
  setBlockedDomainSettings,
  confirmBlockedDomain,
  dismissBlockedDomain,
  rearmBlockedDomain,
  recheckBlockedDomain,
  deleteBlockedDomainJob,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CopyIcon,
  FireIcon,
  GaugeIcon,
} from "@/components/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { formatNumber } from "@/lib/format";
import { JobCard } from "./job-card";
import { ScheduledView, watchedJobs } from "./scheduled-view";
import { StatsView } from "./stats-view";

/** Polled while anything is in flight; slower otherwise, since Clay drives it. */
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 20000;

// The three sections of the page. Home is the setup and the log, as it always
// was; the other two are different cuts of the same records.
type Section = "home" | "scheduled" | "stats";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "scheduled", label: "Scheduled" },
  { id: "stats", label: "Stats" },
];

export function BlockedDomainsTool() {
  const { hasKey, ready } = useApiKey();

  const [section, setSection] = useState<Section>("home");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [view, setView] = useState<BlockedDomainsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingToggle, setSavingToggle] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await fetchBlockedDomains());
    } catch (err) {
      // A failed poll isn't worth a banner — the automation runs server-side
      // regardless of whether this page can reach it.
      if (err instanceof ApiClientError && err.status === 401) {
        setError(err.message);
      }
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void refresh();
    else if (ready && !hasKey) setView(null);
  }, [ready, hasKey, refresh]);

  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (!view) return;
    const active = view.jobs.some(
      (j) => j.status === "working" || j.status === "deleting"
    );
    pollRef.current = setTimeout(
      () => void refresh(),
      active ? POLL_ACTIVE_MS : POLL_IDLE_MS
    );
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

  async function handleToggle(next: boolean) {
    await saveSettings({ autoDelete: next });
  }

  async function saveSettings(patch: {
    autoDelete?: boolean;
    checkPerformance?: boolean;
    minReplyRateOoo?: number;
    minDomainReplyRateOoo?: number;
    recheck?: boolean;
    recheckDays?: number;
  }) {
    setSavingToggle(true);
    setError(null);
    try {
      await setBlockedDomainSettings(patch);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSavingToggle(false);
      await refresh();
    }
  }

  async function handleCopyUrl() {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/api/hooks/blocked-domain`
        : "";
    if (await copyToClipboard(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={refresh} />;

  const jobs = view?.jobs ?? [];
  const awaiting = jobs.filter((j) => j.status === "awaiting_confirmation");
  const rest = jobs.filter((j) => j.status !== "awaiting_confirmation");
  // Every run is kept, so the log doubles as the record of which domains have
  // been dealt with. These counts are what makes that scannable.
  const stats = {
    total: jobs.length,
    waiting: awaiting.length,
    deleted: jobs.filter((j) => j.inboxesDeleted > 0).length,
    // Domains nothing was done to: still performing, or someone declined the
    // deletion.
    kept: jobs.filter((j) => j.status === "dismissed" || j.status === "kept").length,
    failed: jobs.filter(
      (j) =>
        (j.status === "error" || j.status === "interrupted") &&
        j.inboxesDeleted === 0
    ).length,
    inboxes: jobs.reduce((n, j) => n + j.inboxesDeleted, 0),
  };
  const readiness = view?.readiness;
  const notReady = readiness
    ? [
        !readiness.webhookSecret &&
          "BLOCKED_DOMAIN_WEBHOOK_SECRET — until this is set the webhook rejects every call",
        !readiness.serverKey &&
          "PLUSVIBE_API_KEY — without it the webhook has no key to find or delete inboxes",
        !readiness.spreadsheet &&
          "SPREADSHEET_ID — without it the Domains and Tenants to Cancel tabs are left alone",
        !readiness.sheetWriting &&
          "GOOGLE_SERVICE_ACCOUNT_JSON — without it the sheet can be read but not written",
      ].filter(Boolean as unknown as (v: unknown) => v is string)
    : [];

  const watchedCount = watchedJobs(jobs).length;
  const recheck = (id: string, action: "now" | "on" | "off") =>
    withBusy(id, () => recheckBlockedDomain(id, action));

  return (
    <div className="space-y-5">
      {/* Menu bar */}
      <nav
        role="tablist"
        aria-label="Blocked Domains sections"
        className="flex flex-wrap items-center gap-2"
      >
        {SECTIONS.map((s) => {
          const current = section === s.id;
          const badge =
            s.id === "scheduled" ? watchedCount : s.id === "stats" ? stats.total : stats.waiting;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={current}
              onClick={() => setSection(s.id)}
              className={`pv-chip ${current ? "pv-chip-active" : "hover:text-foreground"}`}
            >
              {s.label}
              {badge > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                    current ? "bg-accent/15" : "bg-muted"
                  } ${s.id === "home" ? "text-warning" : ""}`}
                  title={
                    s.id === "home"
                      ? "Waiting for your confirmation"
                      : s.id === "scheduled"
                        ? "Domains being watched"
                        : "Blocks counted"
                  }
                >
                  {formatNumber(badge)}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {error && section !== "home" && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {section === "scheduled" && (
        <ScheduledView jobs={jobs} busyId={busyId} onRecheck={recheck} />
      )}

      {section === "stats" && <StatsView jobs={jobs} />}

      {section === "home" && (
        <>
      {/* Setup + the automation toggle */}
      <div className="pv-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[260px] flex-1">
            <h2 className="text-sm font-semibold">Clay webhook</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Add an HTTP API column in Clay with the same run condition as your{" "}
              <span className="font-mono">Domain Blocked</span> column, POSTing
              to this URL with the header{" "}
              <span className="font-mono">x-webhook-secret</span> and a body of{" "}
              <span className="font-mono">
                {"{ \"domain\": \"...\" }"}
              </span>
              . A domain is only ever handled <strong>once</strong> — every
              later bounce row for it gets an{" "}
              <span className="font-mono">already_handled</span> reply and
              nothing runs — so it&apos;s safe to fire on every bounce, even
              with 50 inboxes on one domain bouncing for weeks.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
                {typeof window !== "undefined"
                  ? `${window.location.origin}/api/hooks/blocked-domain`
                  : "/api/hooks/blocked-domain"}
              </code>
              <button
                type="button"
                className="pv-btn-ghost"
                onClick={handleCopyUrl}
              >
                {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
              </button>
            </div>
          </div>

          <div className="min-w-[240px]">
            <h2 className="text-sm font-semibold">Full automation</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {view?.settings.autoDelete
                ? "Blocked domains are deleted as they arrive, with no confirmation."
                : "Sending, warmup and both sheet updates happen straight away; only the deletion waits for you here."}
            </p>
            <button
              type="button"
              disabled={savingToggle || !view}
              onClick={() => handleToggle(!view?.settings.autoDelete)}
              className={`mt-2 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
                view?.settings.autoDelete
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : "border-border hover:text-foreground"
              }`}
            >
              {savingToggle ? <Spinner size={12} /> : <FireIcon size={13} />}
              {view?.settings.autoDelete
                ? "Auto-delete is ON"
                : "Auto-delete is OFF"}
            </button>

            <h2 className="mt-4 text-sm font-semibold">Keep what&apos;s working</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {view?.settings.checkPerformance
                ? "Two bars on reply rate with OOO over the last 7 days. Inboxes under theirs are stopped whatever the domain does; a domain at or above its own keeps its sheet status and its tenant, and nothing is deleted. Google Workspace domains have no tenant: their burned inboxes go onto 🛑 Google Inboxes to Cancel, and the domain is written off only once every inbox on it is burned."
                : "Every blocked domain is cancelled and all its inboxes stopped, whatever the numbers say."}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={savingToggle || !view}
                onClick={() => saveSettings({ checkPerformance: !view?.settings.checkPerformance })}
                aria-label="Toggle the performance check"
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
                  view?.settings.checkPerformance
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-border hover:text-foreground"
                }`}
              >
                {savingToggle ? <Spinner size={12} /> : <GaugeIcon size={13} />}
                {view?.settings.checkPerformance ? "Check is ON" : "Check is OFF"}
              </button>
            </div>
            <h2 className="mt-4 text-sm font-semibold">Keep watching</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {view?.settings.recheck
                ? `A flagged domain is assessed again every ${view.settings.recheckDays} days — the same two bars on fresh figures — until it is written off with every inbox stopped, or has no inboxes left.`
                : "A domain is assessed once, when it is flagged, and never looked at again."}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={savingToggle || !view}
                onClick={() => saveSettings({ recheck: !view?.settings.recheck })}
                aria-label="Toggle repeat checks"
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
                  view?.settings.recheck
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-border hover:text-foreground"
                }`}
              >
                {savingToggle ? <Spinner size={12} /> : <ClockIcon size={13} />}
                {view?.settings.recheck ? "Repeat checks are ON" : "Repeat checks are OFF"}
              </button>
              {view?.settings.recheck && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  every
                  <input
                    type="number"
                    className="pv-input w-16 py-1 text-xs"
                    min={1}
                    max={90}
                    step={1}
                    value={String(view.settings.recheckDays)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isInteger(n) && n >= 1 && n <= 90) void saveSettings({ recheckDays: n });
                    }}
                    aria-label="Days between repeat checks"
                  />
                  days
                </label>
              )}
            </div>

            {view?.settings.checkPerformance && (
              <div className="mt-3 space-y-1.5">
                <Bar
                  label="Stop an inbox under"
                  hint="daily limit to 0 and warmup off"
                  value={view.settings.minReplyRateOoo}
                  ariaLabel="Reply rate with OOO bar"
                  onSave={(n) => void saveSettings({ minReplyRateOoo: n })}
                />
                <Bar
                  label="Write the domain off under"
                  hint="Not Active in the sheet, tenant queued to cancel"
                  value={view.settings.minDomainReplyRateOoo}
                  ariaLabel="Domain reply rate with OOO bar"
                  onSave={(n) => void saveSettings({ minDomainReplyRateOoo: n })}
                />
              </div>
            )}
          </div>
        </div>

        {notReady.length > 0 && (
          <div className="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-3">
            <p className="text-xs font-medium text-warning">
              Not ready to run unattended — set these on Railway:
            </p>
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
      </div>

      {stats.total > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Domains handled" value={stats.total} />
          <Stat
            label="Waiting for you"
            value={stats.waiting}
            tone={stats.waiting > 0 ? "warning" : undefined}
          />
          <Stat label="Inboxes deleted" value={stats.inboxes} />
          <Stat label="Kept" value={stats.kept} />
          <Stat
            label="Failed"
            value={stats.failed}
            tone={stats.failed > 0 ? "danger" : undefined}
          />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-warning">
            Waiting for you ({awaiting.length})
          </h2>
          {awaiting.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              busy={busyId === job.id}
              onConfirm={(id) => withBusy(id, () => confirmBlockedDomain(id))}
              onDismiss={(id) => withBusy(id, () => dismissBlockedDomain(id))}
              onRearm={(id) => withBusy(id, () => rearmBlockedDomain(id))}
              onRemove={(id) => withBusy(id, () => deleteBlockedDomainJob(id))}
              onRecheck={recheck}
            />
          ))}
        </div>
      )}

      {rest.length > 0 ? (
        <div className="space-y-3">
          {/* Closed by default: the log grows without bound and the cards
              are tall, so an open history pushes anything waiting for
              confirmation off the screen. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-semibold"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              aria-controls="blocked-domains-history"
            >
              <ChevronDownIcon
                size={16}
                className={`transition-transform ${historyOpen ? "" : "-rotate-90"}`}
              />
              History ({formatNumber(rest.length)})
            </button>
            <span className="text-xs text-muted-foreground">
              {historyOpen
                ? "Every run is kept. “Allow re-run” lets a domain trigger again without losing its record."
                : "Every run is kept. Open to see them."}
            </span>
          </div>
          {historyOpen && (
          <div id="blocked-domains-history" className="space-y-3">
          {rest.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              busy={busyId === job.id}
              onConfirm={(id) => withBusy(id, () => confirmBlockedDomain(id))}
              onDismiss={(id) => withBusy(id, () => dismissBlockedDomain(id))}
              onRearm={(id) => withBusy(id, () => rearmBlockedDomain(id))}
              onRemove={(id) => withBusy(id, () => deleteBlockedDomainJob(id))}
              onRecheck={recheck}
            />
          ))}
          </div>
          )}
        </div>
      ) : (
        awaiting.length === 0 && (
          <EmptyState icon={<FireIcon />} title="No blocked domains yet">
            Nothing has come through from Clay. When a bounce reason shows one
            of your sending domains is blocked, it lands here.
          </EmptyState>
        )
      )}
        </>
      )}
    </div>
  );
}

/** One editable percentage bar, with what it governs written next to it. */
function Bar({
  label,
  hint,
  value,
  ariaLabel,
  onSave,
}: {
  label: string;
  hint: string;
  value: number;
  ariaLabel: string;
  onSave: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Follow the saved value, so a save from elsewhere (or a rejected entry)
  // shows up here.
  useEffect(() => setText(String(value)), [value]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function edit(next: string) {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    // Only a complete number saves: "2." on the way to "2.5" would otherwise
    // save 2 and snap the field back mid-typing.
    if (!/^\d+(\.\d+)?$/.test(next.trim())) return;
    const n = Number(next);
    if (n > 100 || n === value) return;
    timer.current = setTimeout(() => onSave(n), 600);
  }

  return (
    <label className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <input
        type="number"
        className="pv-input w-20 py-1 text-xs"
        min={0}
        max={100}
        step={0.1}
        value={text}
        onChange={(e) => edit(e.target.value)}
        aria-label={ariaLabel}
      />
      % <span className="text-muted-foreground/70">— {hint}</span>
    </label>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warning" | "danger";
}) {
  return (
    <div className="pv-card p-3">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          tone === "danger"
            ? "text-danger"
            : tone === "warning"
              ? "text-warning"
              : ""
        }`}
      >
        {formatNumber(value)}
      </div>
    </div>
  );
}
