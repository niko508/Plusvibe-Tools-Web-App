"use client";

import { useCallback, useEffect, useState } from "react";
import type { WeeklyRun, WeeklyStatus, WeeklyStep } from "@/lib/jobs/burned-schedule-types";
import { ESP_LABELS, NOUNS, levelOf, type ScheduleMode } from "@/lib/burned/settings";
import { MAX_BURNED_SHARE } from "@/lib/burned/schedule";
import { describeDue } from "@/lib/start-outreach/schedule";
import { ApiClientError, fetchBurnedSchedule, runBurnedScheduleNow, saveBurnedSchedule } from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, ClockIcon, PlayIcon } from "@/components/icons";

// The weekly run: on or off, report or remove, and how the last one went.
//
// It runs on the server with the server's key, every Monday at 06:00 Helsinki
// over the last 30 days, on the thresholds saved below. Report only keeps the
// scans here for someone to look at; Remove also records the burned rows in
// the sheet and deletes their inboxes, exactly as the Remove button would.

const POLL_RUNNING_MS = 4000;
const POLL_IDLE_MS = 60_000;

const MODES: { key: ScheduleMode; label: string; hint: string }[] = [
  { key: "report", label: "Report only", hint: "Scans both providers and lists what is burned. Nothing is changed." },
  {
    key: "remove",
    label: "Remove automatically",
    hint: "Also records the burned rows in the Email Infrastructure sheet, then deletes their inboxes in Plusvibe.",
  },
];

export function WeeklyPanel({ onRunStarted }: { onRunStarted: () => void }) {
  const [status, setStatus] = useState<WeeklyStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetUrl, setSheetUrl] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await fetchBurnedSchedule();
      setStatus(s);
      setSheetUrl((cur) => (cur === "" ? s.schedule.sheetUrl : cur));
    } catch (err) {
      // A key for another account can't see or run the weekly check; the
      // page works without it.
      if (err instanceof ApiClientError && (err.status === 403 || err.status === 401)) setHidden(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = status?.running || status?.state.lastRun?.status === "running";
  useEffect(() => {
    const t = setInterval(() => void load(), running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => clearInterval(t);
  }, [running, load]);

  async function save(patch: Parameters<typeof saveBurnedSchedule>[0]) {
    setBusy(true);
    setError(null);
    try {
      await saveBurnedSchedule(patch);
      await load();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setError(null);
    setConfirmRun(false);
    try {
      await runBurnedScheduleNow();
      await load();
      onRunStarted();
      // The first scan is created a moment after the run starts.
      setTimeout(onRunStarted, 2000);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (!status) return <div className="pv-card h-24 animate-pulse" />;

  const { schedule } = status;
  const removeMode = schedule.mode === "remove";
  const sheetDirty = sheetUrl.trim() !== schedule.sheetUrl;

  return (
    <div className="pv-card space-y-4 p-4 sm:p-5" data-weekly>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ClockIcon size={15} /> Weekly check
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Every Monday at 06:00 Helsinki, scans Microsoft domains and Google inboxes in every workspace over the last 30
            days, using the numbers saved below for each provider.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label="Weekly check on"
          data-weekly-switch
          disabled={busy || !status.serverKey}
          onClick={() => void save({ enabled: !schedule.enabled })}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            schedule.enabled ? "bg-accent" : "bg-muted-foreground/30"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              schedule.enabled ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {!status.serverKey && (
        <Warning>PLUSVIBE_API_KEY is not set on the server, so there is no key for the weekly check to run with.</Warning>
      )}

      {/* Mode */}
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">What it does with what it finds</div>
        <div className="flex flex-wrap gap-1.5 text-xs" role="radiogroup" aria-label="Weekly check mode">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={schedule.mode === m.key}
              disabled={busy}
              className={`pv-chip ${schedule.mode === m.key ? "pv-chip-active" : "hover:text-foreground"}`}
              onClick={() => {
                if (m.key === schedule.mode) return;
                if (m.key === "remove") setConfirmRemove(true);
                else void save({ mode: "report" });
              }}
              data-weekly-mode={m.key}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{MODES.find((m) => m.key === schedule.mode)?.hint}</p>
      </div>

      {confirmRemove && (
        <div className="space-y-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-xs" data-weekly-confirm-remove>
          <p>
            From the next run on, burned Microsoft domains are set to Not Active with their tenants queued to cancel, burned
            Google inboxes are queued on 🛑 Google Inboxes to Cancel, and their inboxes are deleted in Plusvibe — with nobody
            checking first. Deleting cannot be undone.
          </p>
          <p className="text-muted-foreground">
            Safeguards: a scan that did not finish cleanly is never acted on, and if more than{" "}
            {Math.round(MAX_BURNED_SHARE * 100)}% of what a scan judged comes out burned, nothing is removed and the run says
            why. Worth running Report only for a few weeks first.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="pv-btn-primary text-xs"
              disabled={busy}
              onClick={() => {
                setConfirmRemove(false);
                void save({ mode: "remove" });
              }}
              data-weekly-confirm
            >
              Yes, remove automatically
            </button>
            <button type="button" className="pv-btn-ghost text-xs" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {removeMode && (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-muted-foreground" htmlFor="weekly-sheet">
            Email Infrastructure sheet
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="weekly-sheet"
              type="url"
              className="pv-input min-w-0 flex-1 text-sm"
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="Blank uses the server's SPREADSHEET_ID"
              aria-label="Email Infrastructure sheet for the weekly check"
            />
            <button
              type="button"
              className="pv-btn-ghost text-xs disabled:opacity-50"
              disabled={busy || !sheetDirty}
              onClick={() => void save({ sheetUrl: sheetUrl.trim() })}
            >
              Save sheet
            </button>
          </div>
          {!status.sheetWriting && (
            <Warning>
              Google Sheets writing isn&apos;t set up (GOOGLE_SERVICE_ACCOUNT_JSON), so the removal step will refuse to run and
              nothing will be deleted.
            </Warning>
          )}
        </div>
      )}

      {error && <Warning>{error}</Warning>}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {schedule.enabled && status.nextRunAt ? (
          <span data-weekly-next>
            Next run: <span className="font-medium text-foreground">{describeDue(status.nextRunAt)}</span>
            {removeMode ? " · removes automatically" : " · report only"}
          </span>
        ) : (
          <span>Off — nothing runs on its own.</span>
        )}
        {confirmRun ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-danger">This run will delete the burned inboxes it finds.</span>
            <button type="button" className="pv-btn-primary text-xs" disabled={busy} onClick={() => void runNow()}>
              Run and remove
            </button>
            <button type="button" className="pv-btn-ghost text-xs" onClick={() => setConfirmRun(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="pv-btn-ghost text-xs disabled:opacity-50"
            disabled={busy || running || !status.serverKey}
            onClick={() => (removeMode ? setConfirmRun(true) : void runNow())}
            data-weekly-run-now
          >
            {busy || running ? <Spinner size={13} /> : <PlayIcon size={13} />}
            {running ? "Running…" : "Run now"}
          </button>
        )}
      </div>

      {status.state.lastRun && <LastRun run={status.state.lastRun} />}
    </div>
  );
}

function LastRun({ run }: { run: WeeklyRun }) {
  return (
    <div className="space-y-1.5 border-t border-border pt-3 text-xs" data-weekly-last>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 font-medium ${RUN_CLASS[run.status]}`}>{RUN_LABEL[run.status]}</span>
        <span className="text-muted-foreground">
          {run.trigger === "manual" ? "Run by hand" : "Scheduled run"} · {describeDue(run.startedAt)} · {run.start} →{" "}
          {run.end} · {run.mode === "remove" ? "remove" : "report only"}
        </span>
      </div>
      {run.steps.map((s) => (
        <p key={s.esp} className="text-muted-foreground">
          <span className="font-medium text-foreground">{ESP_LABELS[s.esp]}:</span> {stepText(s, run.mode)}
        </p>
      ))}
      {run.status === "interrupted" && (
        <p className="text-warning">
          The server restarted in the middle of this run, so it stopped. It is not picked up again by itself; use Run now if
          it needs finishing.
        </p>
      )}
    </div>
  );
}

function stepText(s: WeeklyStep, mode: ScheduleMode): string {
  const noun = NOUNS[levelOf(s.esp)];
  if (!s.scanJobId) return s.note ?? "not started";
  if (s.burned === undefined) return "scanning…";
  const of = s.scanned !== undefined && s.scanned !== s.judged ? ` of ${formatNumber(s.scanned)}` : "";
  const parts = [`${formatNumber(s.judged ?? 0)}${of} ${noun.many} judged, ${formatNumber(s.burned)} burned`];
  if (s.scanStatus && s.scanStatus !== "done") parts.push(`scan ${s.scanStatus}`);
  if (mode === "remove") {
    if (s.removalJobId) {
      parts.push(
        s.removalStatus
          ? `removal ${s.removalStatus === "done" ? "done" : s.removalStatus} · ${formatNumber(s.inboxesDeleted ?? 0)} inboxes deleted`
          : "removing…"
      );
    } else if (s.note) parts.push(s.note);
  }
  return parts.join(" · ");
}

const RUN_LABEL: Record<WeeklyRun["status"], string> = {
  running: "Running",
  done: "Done",
  error: "Finished with problems",
  interrupted: "Interrupted",
};

const RUN_CLASS: Record<WeeklyRun["status"], string> = {
  running: "bg-accent/10 text-accent",
  done: "bg-success/10 text-success",
  error: "bg-warning/10 text-warning",
  interrupted: "bg-warning/10 text-warning",
};

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
