"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BurnedJob } from "@/lib/jobs/burned-types";
import type { BurnedRemovalJob } from "@/lib/jobs/burned-removal-types";
import {
  DEFAULT_SETTINGS,
  ESPS,
  ESP_LABELS,
  levelOf,
  parseMinSends,
  parseReplyOooPct,
  parseReplyPct,
  rescueImpossible,
  type BurnedSettings,
  type Esp,
} from "@/lib/burned/settings";
import {
  abortBurnedJob,
  abortBurnedRemoval,
  deleteBurnedJob,
  deleteBurnedRemoval,
  fetchBurnedSettings,
  listBurnedJobs,
  saveBurnedSettings,
  listBurnedRemovals,
  startBurnedRemoval,
  startBurnedScan,
  ApiClientError,
} from "@/lib/api-client";
import { MAX_RANGE_DAYS, rangeProblem } from "@/lib/inbox-performance/metrics";
import { useApiKey } from "@/lib/use-api-key";
import { DATE_PRESETS, formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, FireIcon, SettingsIcon } from "@/components/icons";
import { ResultsCard } from "./results";

// Find Burned Domains & Inboxes.
//
// One provider at a time, because the two are judged at different levels and
// carry their own thresholds. The thresholds are saved server-side per
// provider, so picking Google shows the Google bar and picking Microsoft
// shows the Microsoft one — each as it was last left.

const POLL_MS = 2000;
const DEFAULT_PRESET = "30d";
/** The ranges the bulk stats endpoint can answer in one go. */
const PRESETS = DATE_PRESETS.filter((p) => ["7d", "14d", "21d", "30d"].includes(p.key));

export function BurnedTool() {
  const { hasKey, ready } = useApiKey();

  const [esp, setEsp] = useState<Esp>("microsoft");
  const [settings, setSettings] = useState<BurnedSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [minSends, setMinSends] = useState("");
  const [replyOoo, setReplyOoo] = useState("");
  const [replyPct, setReplyPct] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const initial = PRESETS.find((p) => p.key === DEFAULT_PRESET)!.range();
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [preset, setPreset] = useState<string | null>(DEFAULT_PRESET);

  const [jobs, setJobs] = useState<BurnedJob[]>([]);
  const [removals, setRemovals] = useState<BurnedRemovalJob[]>([]);
  const [removalBusy, setRemovalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  // --- Thresholds: read once, shown per provider ---------------------------
  const showThresholds = useCallback((s: BurnedSettings, which: Esp) => {
    setMinSends(String(s.thresholds[which].minSends));
    setReplyOoo(String(s.thresholds[which].replyOooPct));
    setReplyPct(String(s.thresholds[which].replyPct));
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const { settings: s } = await fetchBurnedSettings();
      setSettings(s);
      setSettingsLoaded(true);
      showThresholds(s, esp);
    } catch (err) {
      setError(errMessage(err));
    }
    // The provider is read once, on load; switching providers re-fills from
    // the settings already in hand rather than fetching again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showThresholds]);

  const refresh = useCallback(async () => {
    try {
      const [scans, runs] = await Promise.all([listBurnedJobs(), listBurnedRemovals()]);
      setJobs(scans.jobs);
      setRemovals(runs.jobs);
    } catch {
      // polling failure is not worth a banner
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) {
      void loadSettings();
      void refresh();
    }
  }, [ready, hasKey, loadSettings, refresh]);

  const active = jobs.find((j) => j.status === "running") ?? null;
  const activeRemoval = removals.find((r) => r.status === "running") ?? null;
  useEffect(() => {
    if (!active && !activeRemoval) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [active, activeRemoval, refresh]);

  useEffect(() => {
    if (!savedNote) return;
    const t = setTimeout(() => setSavedNote(null), 4000);
    return () => clearTimeout(t);
  }, [savedNote]);

  function pickEsp(next: Esp) {
    setEsp(next);
    showThresholds(settings, next);
    setSavedNote(null);
  }

  // --- Derived -------------------------------------------------------------
  const sends = parseMinSends(minSends);
  const ooo = parseReplyOooPct(replyOoo);
  const real = parseReplyPct(replyPct);
  const thresholdProblem = sends.error ?? ooo.error ?? real.error ?? null;
  const saved = settings.thresholds[esp];
  const dirty =
    !thresholdProblem &&
    (sends.value !== saved.minSends || ooo.value !== saved.replyOooPct || real.value !== saved.replyPct);
  // The OOO rate counts the same replies plus the auto-replies, so it can
  // never be the lower of the two — a Reply % bar at or above it can never
  // rescue anything, and saying nothing would leave that a mystery.
  const rescueDead =
    !thresholdProblem && rescueImpossible({ replyPct: real.value as number, replyOooPct: ooo.value as number });
  const rangeIssue = rangeProblem(start, end);
  const canScan = settingsLoaded && !thresholdProblem && !rangeIssue && !busy && !active;
  const level = levelOf(esp);

  async function handleSave() {
    if (!dirty || thresholdProblem || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { settings: s } = await saveBurnedSettings({
        [esp]: { minSends: sends.value as number, replyOooPct: ooo.value as number, replyPct: real.value as number },
      } as Partial<Record<Esp, { minSends: number; replyOooPct: number; replyPct: number }>>);
      setSettings(s);
      showThresholds(s, esp);
      setSavedNote(`Saved for ${ESP_LABELS[esp]} — every scan uses these until you change them.`);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleScan() {
    if (!canScan || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      // The scan reads the SAVED thresholds, so an edit left in the boxes is
      // saved first rather than quietly ignored.
      if (dirty) {
        const { settings: s } = await saveBurnedSettings({
          [esp]: { minSends: sends.value as number, replyOooPct: ooo.value as number, replyPct: real.value as number },
        } as Partial<Record<Esp, { minSends: number; replyOooPct: number; replyPct: number }>>);
        setSettings(s);
      }
      await startBurnedScan({ esp, start, end });
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function handleRemoval(scanJobId: string, sheetUrl: string) {
    if (removalBusy) return;
    setRemovalBusy(true);
    setError(null);
    try {
      await startBurnedRemoval({ scanJobId, sheetUrl });
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRemovalBusy(false);
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    }
  };

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadSettings} />;

  return (
    <div className="space-y-5">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        {/* Provider */}
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Provider to watch</div>
          <div className="flex flex-wrap gap-1.5 text-xs" role="radiogroup" aria-label="Provider to watch">
            {ESPS.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={esp === e}
                className={`pv-chip ${esp === e ? "pv-chip-active" : "hover:text-foreground"}`}
                onClick={() => pickEsp(e)}
                data-esp={e}
              >
                {ESP_LABELS[e]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground" data-level-note>
            {esp === "microsoft"
              ? "Microsoft is judged by domain: a tenant's mailboxes burn together, so the whole domain's figures decide it."
              : "Google is judged by inbox: Google mailboxes burn one at a time, and a domain average hides the ones that have."}
          </p>
        </div>

        {/* Thresholds */}
        <div className="grid gap-4 sm:grid-cols-3" data-thresholds>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="burned-min-sends">
              Minimum sends
            </label>
            <input
              id="burned-min-sends"
              type="number"
              className="pv-input"
              min={0}
              step={1}
              value={minSends}
              onChange={(e) => setMinSends(e.target.value)}
              aria-label="Minimum sends"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Below this there is nothing to judge, so the {level} is listed as too quiet rather than burned.
              {sends.error && <span className="block text-warning">{sends.error}</span>}
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="burned-reply-ooo">
              Reply % (OOO)
            </label>
            <input
              id="burned-reply-ooo"
              type="number"
              className="pv-input"
              min={0}
              step={0.1}
              value={replyOoo}
              onChange={(e) => setReplyOoo(e.target.value)}
              aria-label="Reply % (OOO)"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Replies including out-of-office, over unique leads contacted. Under this is burned.
              {ooo.error && <span className="block text-warning">{ooo.error}</span>}
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="burned-reply-pct">
              Reply %
            </label>
            <input
              id="burned-reply-pct"
              type="number"
              className="pv-input"
              min={0}
              step={0.1}
              value={replyPct}
              onChange={(e) => setReplyPct(e.target.value)}
              aria-label="Reply %"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Real replies, out-of-office not counted. At or above this the {level} is kept whatever the OOO figure says.
              {real.error && <span className="block text-warning">{real.error}</span>}
            </p>
          </div>
        </div>

        {rescueDead && (
          <p className="flex gap-1.5 text-xs text-muted-foreground" data-rescue-note>
            <AlertIcon size={13} className="mt-0.5 shrink-0 text-warning" />
            <span>
              Reply % sits at or above Reply % (OOO), so it can never rescue anything: the OOO figure counts the same
              replies plus the auto-replies, so it is never the lower of the two. Set it below {ooo.value}% for it to
              have an effect.
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="pv-btn-ghost text-xs disabled:opacity-50" disabled={!dirty || saving} onClick={handleSave} data-save-thresholds>
            {saving ? <Spinner size={13} /> : <SettingsIcon size={13} />}
            Save for {ESP_LABELS[esp]}
          </button>
          {savedNote ? (
            <span className="text-xs text-success">{savedNote}</span>
          ) : !settingsLoaded ? (
            <span className="text-xs text-muted-foreground">Reading the saved thresholds…</span>
          ) : dirty ? (
            <span className="text-xs text-muted-foreground">Not saved yet — scanning saves them too.</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Saved per provider: {ESP_LABELS[esp]} is under {saved.replyOooPct}% reply (OOO), unless reply % is{" "}
              {saved.replyPct}% or better, on {formatNumber(saved.minSends)}+ sends.
            </span>
          )}
        </div>

        {/* Date range */}
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Window</div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5 text-xs">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`pv-chip ${preset === p.key ? "pv-chip-active" : "hover:text-foreground"}`}
                  onClick={() => {
                    const r = p.range();
                    setStart(r.start);
                    setEnd(r.end);
                    setPreset(p.key);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <input
                type="date"
                className="pv-input w-auto text-sm"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  setPreset(null);
                }}
                aria-label="Start date"
              />
              <span className="text-muted-foreground">→</span>
              <input
                type="date"
                className="pv-input w-auto text-sm"
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setPreset(null);
                }}
                aria-label="End date"
              />
            </div>
          </div>
          {rangeIssue && (
            <p className="mt-1.5 flex gap-1.5 text-xs text-warning" data-range-problem>
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{rangeIssue}</span>
            </p>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canScan} onClick={handleScan} data-scan>
            {busy ? <Spinner /> : <FireIcon size={16} />}
            Scan every workspace
          </button>
          <span className="text-xs text-muted-foreground">
            {active
              ? "A scan is running — let it finish or stop it first."
              : `Reads only: every workspace's ${ESP_LABELS[esp]} inboxes and their figures for the window. Nothing is paused, changed or deleted. At most ${MAX_RANGE_DAYS} days at a time.`}
          </span>
        </div>
      </div>

      {jobs.length === 0 ? (
        <EmptyState icon={<FireIcon />} title="No scans yet">
          Pick a provider, set the bar, and scan. The run keeps going even if you close this tab.
        </EmptyState>
      ) : (
        jobs.map((job) => (
          <ResultsCard
            key={job.id}
            job={job}
            removals={removals.filter((r) => r.scanJobId === job.id)}
            removalBusy={removalBusy}
            removalBlocked={!!activeRemoval}
            onAbort={() => act(() => abortBurnedJob(job.id))}
            onRemove={() => act(() => deleteBurnedJob(job.id))}
            onStartRemoval={(sheetUrl) => void handleRemoval(job.id, sheetUrl)}
            onAbortRemoval={(id) => act(() => abortBurnedRemoval(id))}
            onDeleteRemoval={(id) => act(() => deleteBurnedRemoval(id))}
          />
        ))
      )}
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}
