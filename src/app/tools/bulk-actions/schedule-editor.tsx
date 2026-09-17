"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CampaignSummary, Workspace } from "@/lib/plusvibe-types";
import {
  PRESETS,
  SHORT_DAY,
  SLOTS_PER_DAY,
  TIMEZONES,
  WEEKDAYS,
  describeWeek,
  emptySlots,
  emptyWeek,
  parseWeek,
  pretty,
  slotTime,
  slotsToWeek,
  stringifyWeek,
  totalSlots,
  weekToSlots,
  windowsToSlots,
  type WeekSlots,
  type Weekday,
} from "@/lib/campaign-settings/schedule";
import { fetchCampaigns, fetchCampaignSchedule, ApiClientError } from "@/lib/api-client";
import { Spinner } from "@/components/ui";
import { AlertIcon, ChevronDownIcon, CopyIcon } from "@/components/icons";

// The weekly grid: a row per day, a cell per half hour. Click or drag to
// paint; the first cell decides whether the drag is filling or clearing, so
// dragging over a selected stretch removes it.
//
// Every cell is a real button carrying its day and time, so the grid can be
// driven by the keyboard and read by a test without simulating a drag.

const LABEL_EVERY = 4; // 4 half-hour cells = 2 hours, as Plusvibe's own grid reads

export function ScheduleEditor({
  value,
  onChange,
  workspaces,
}: {
  /** The week as JSON, or "" before anything is picked. */
  value: string;
  onChange: (next: string) => void;
  workspaces: Workspace[];
}) {
  const week = useMemo(() => parseWeek(value) ?? emptyWeek(), [value]);
  const slots = useMemo(() => weekToSlots(week), [week]);
  const timezone = week.timezone;

  const painting = useRef<{ to: boolean } | null>(null);
  useEffect(() => {
    const stop = () => {
      painting.current = null;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const write = useCallback(
    (next: WeekSlots, tz = timezone) => onChange(stringifyWeek(slotsToWeek(next, tz))),
    [onChange, timezone]
  );

  const paint = useCallback(
    (day: Weekday, slot: number, to: boolean) => {
      const next: WeekSlots = { ...slots, [day]: [...slots[day]] };
      next[day][slot] = to;
      write(next);
    },
    [slots, write]
  );

  function down(day: Weekday, slot: number) {
    const to = !slots[day][slot];
    painting.current = { to };
    paint(day, slot, to);
  }
  function enter(day: Weekday, slot: number) {
    if (painting.current) paint(day, slot, painting.current.to);
  }

  /** This day's windows onto every other day. */
  function copyRow(day: Weekday) {
    const row = slots[day];
    const next = Object.fromEntries(WEEKDAYS.map((d) => [d, [...row]])) as WeekSlots;
    write(next);
  }

  const chosen = totalSlots(slots);

  return (
    <div className="w-full space-y-2.5" data-schedule>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="adv-timezone">
            Timezone
          </label>
          <div className="relative">
            <select
              id="adv-timezone"
              className="pv-input w-auto appearance-none pr-8 text-sm"
              value={timezone}
              onChange={(e) => write(slots, e.target.value)}
              aria-label="Schedule timezone"
            >
              {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className="pv-chip hover:text-foreground" onClick={() => write(p.build())}>
              {p.label}
            </button>
          ))}
          <button type="button" className="pv-chip hover:text-foreground" onClick={() => write(emptySlots())}>
            Clear week
          </button>
        </div>
      </div>

      <CopyFromCampaign workspaces={workspaces} onCopied={(w) => onChange(stringifyWeek(w))} />

      <div className="overflow-x-auto">
        <div className="min-w-[640px] select-none">
          {/* Hour labels, one every two hours */}
          <div className="flex pl-10">
            {Array.from({ length: SLOTS_PER_DAY / LABEL_EVERY }, (_, i) => (
              <div key={i} className="flex-1 text-[10px] text-muted-foreground">
                {pretty(slotTime(i * LABEL_EVERY))}
              </div>
            ))}
          </div>
          {WEEKDAYS.map((day) => {
            const row = slots[day];
            const any = row.some(Boolean);
            return (
              <div key={day} className="flex items-center gap-1">
                <span className={`w-9 shrink-0 text-[11px] ${any ? "font-medium" : "text-muted-foreground"}`}>
                  {SHORT_DAY[day]}
                </span>
                <div className="flex flex-1 gap-px py-0.5">
                  {row.map((on, i) => (
                    <button
                      key={i}
                      type="button"
                      data-day={day}
                      data-slot={i}
                      aria-pressed={on}
                      aria-label={`${day} ${slotTime(i)}`}
                      title={`${SHORT_DAY[day]} ${pretty(slotTime(i))}–${pretty(slotTime(i + 1))}`}
                      onMouseDown={() => down(day, i)}
                      onMouseEnter={() => enter(day, i)}
                      onClick={(e) => e.preventDefault()}
                      className={`h-6 flex-1 first:rounded-l last:rounded-r ${
                        on ? "bg-accent" : "bg-muted hover:bg-muted-foreground/20"
                      } ${i % LABEL_EVERY === 0 ? "border-l border-border" : ""}`}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="pv-btn-ghost shrink-0 px-1.5 py-1"
                  title={`Copy ${SHORT_DAY[day]} to every day`}
                  aria-label={`Copy ${day} to every day`}
                  onClick={() => copyRow(day)}
                >
                  <CopyIcon size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground" data-schedule-summary>
        {chosen === 0 ? (
          <span className="text-warning">Nothing selected — pick at least one window, or untick the setting.</span>
        ) : (
          <>
            {describeWeek(week)} · {timezone}
          </>
        )}
      </p>
    </div>
  );
}

/** Reads one campaign's schedule and loads it into the grid. */
function CopyFromCampaign({
  workspaces,
  onCopied,
}: {
  workspaces: Workspace[];
  onCopied: (week: ReturnType<typeof emptyWeek>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignId, setCampaignId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    setCampaigns(null);
    setCampaignId("");
    let live = true;
    void (async () => {
      try {
        const { campaigns: list } = await fetchCampaigns({ workspace_id: workspaceId });
        if (live) setCampaigns(list.filter((c) => c.campaignType !== "subseq"));
      } catch (err) {
        if (live) setError(err instanceof ApiClientError ? err.message : "Could not read the campaigns.");
      }
    })();
    return () => {
      live = false;
    };
  }, [workspaceId]);

  async function copy() {
    if (!workspaceId || !campaignId) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { week, exact } = await fetchCampaignSchedule({ workspace_id: workspaceId, campaign_id: campaignId });
      onCopied(week);
      setNote(
        exact
          ? "Copied its advanced schedule exactly."
          : "Copied its schedule — that campaign reports one window per day, which is all the API returns, so check the grid before applying."
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not read that campaign's schedule.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="pv-btn-ghost text-xs" onClick={() => setOpen(true)} data-copy-open>
        <CopyIcon size={13} /> Copy from a campaign
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border p-2.5" data-copy-from>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <select
          className="pv-input text-sm"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          aria-label="Copy from workspace"
        >
          <option value="">Workspace…</option>
          {workspaces.map((w) => (
            <option key={w._id} value={w._id}>
              {w.name}
            </option>
          ))}
        </select>
        <select
          className="pv-input text-sm"
          value={campaignId}
          disabled={!workspaceId || campaigns === null}
          onChange={(e) => setCampaignId(e.target.value)}
          aria-label="Copy from campaign"
        >
          <option value="">{!workspaceId ? "Pick a workspace…" : campaigns === null ? "Loading…" : "Campaign…"}</option>
          {(campaigns ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" className="pv-btn-ghost text-xs disabled:opacity-50" disabled={!campaignId || busy} onClick={copy} data-copy-go>
          {busy ? <Spinner size={12} /> : <CopyIcon size={13} />} Copy schedule
        </button>
      </div>
      {note && <p className="mt-1.5 text-[11px] text-muted-foreground">{note}</p>}
      {error && (
        <p className="mt-1.5 flex gap-1.5 text-[11px] text-warning">
          <AlertIcon size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export { windowsToSlots };
