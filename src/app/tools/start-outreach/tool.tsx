"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, EmailAccount } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchAccountsPage,
  fetchWarmupDates,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { useSheetConfig } from "@/lib/use-sheet-config";
import { domainFromEmail, formatNumber, formatPercent, providerBucket } from "@/lib/format";
import { copyToClipboard } from "@/lib/clipboard";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { EmptyState, Spinner } from "@/components/ui";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  MailIcon,
  PlayIcon,
  SheetIcon,
} from "@/components/icons";
import { PROVIDER_BADGE, providerShort } from "../domain-performance/providers";
import {
  DEFAULT_MIN_WARMUP_DAYS,
  DEFAULT_RULES,
  VERDICT_LABELS,
  countVerdicts,
  describeSkipped,
  domainVerdict,
  groupByDomain,
  judge,
  parseMinDays,
  resolveWarmupStart,
  selectionTotals,
  warmupIsOn,
  type DomainSummary,
  type SheetWarmup,
  type StartSource,
  type Verdict,
} from "@/lib/start-outreach/readiness";
import type { MovingInbox } from "@/lib/start-outreach/plan";
import { OutreachSetup } from "./setup";

// Start Outreach with New Inboxes — step 1: find the domains whose inboxes
// have warmed long enough, and pick the ones to move.
//
// One workspace, one listing call, then one read of the Domains tab for the
// domains those inboxes are on. Each inbox's warmup start is the sheet's
// "Warmup Started" for its domain, or Plusvibe's own timestamp when the sheet
// has none, and the page says which was used. Inboxes are shown grouped by
// domain, because that is the unit they are moved in. Nothing is changed here.

const PAGE_SIZE = 100;
const PAGE_SPACING_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WS_KEY = "pv_outreach_ws";
const DAYS_KEY = "pv_outreach_min_days";
const SKIP_KEY = "pv_outreach_skip_campaign";

interface Row {
  id: string;
  email: string;
  domain: string;
  provider: string;
  warmupStatus?: string;
  warmupHealth?: number;
  campaignIds: string[];
  plusvibeEnabledAt?: string;
  firstName?: string;
  lastName?: string;
}

interface Judged extends Row {
  startAt: number | null;
  source: StartSource;
  days: number | null;
  verdict: Verdict;
}

const VERDICT_CLASS: Record<Verdict | "partly", string> = {
  ready: "bg-success/10 text-success",
  partly: "bg-warning/10 text-warning",
  "too-new": "bg-muted text-muted-foreground",
  "warmup-off": "bg-danger/10 text-danger",
  "no-start-date": "bg-warning/10 text-warning",
  "in-campaign": "bg-muted text-muted-foreground",
};

const SOURCE_LABEL: Record<StartSource, string> = {
  sheet: "Sheet",
  plusvibe: "Plusvibe",
  none: "—",
};

export function StartOutreachTool() {
  const { hasKey, ready } = useApiKey();
  const { config: sheetConfig, hasSheet } = useSheetConfig();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [ws, setWs] = useState("");
  const [minDaysRaw, setMinDaysRaw] = useState(String(DEFAULT_MIN_WARMUP_DAYS));
  const [skipInCampaign, setSkipInCampaign] = useState(DEFAULT_RULES.skipInCampaign);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [sheetDates, setSheetDates] = useState<Record<string, SheetWarmup>>({});
  const [sheetNote, setSheetNote] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [fetched, setFetched] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [readyOnly, setReadyOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // --- Remembered choices --------------------------------------------------
  useEffect(() => {
    try {
      const d = window.localStorage.getItem(DAYS_KEY);
      if (d !== null) setMinDaysRaw(d);
      const s = window.localStorage.getItem(SKIP_KEY);
      if (s !== null) setSkipInCampaign(s !== "0");
    } catch {
      // storage unavailable
    }
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      window.localStorage.setItem(DAYS_KEY, minDaysRaw);
      window.localStorage.setItem(SKIP_KEY, skipInCampaign ? "1" : "0");
      if (ws) window.localStorage.setItem(WS_KEY, ws);
    } catch {
      // storage unavailable
    }
  }, [minDaysRaw, skipInCampaign, ws, prefsLoaded]);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      let remembered = "";
      try {
        remembered = window.localStorage.getItem(WS_KEY) ?? "";
      } catch {
        // ignore
      }
      if (remembered && list.some((w) => w._id === remembered)) setWs(remembered);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  // --- Fetch: the inboxes, then the sheet's dates for their domains -------
  const fetchInboxes = useCallback(async () => {
    const target = workspaces.find((w) => w._id === ws);
    if (!target) {
      setError("Pick the workspace the inboxes are warming in.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setBusy(true);
    setError(null);
    setRows([]);
    setSheetDates({});
    setSheetNote(null);
    setSelected(new Set());
    setExpanded(null);
    setFetchedFor(target.name);
    setFetched(0);
    setPhase("Finding inboxes…");

    try {
      // Paged, so the count climbs while a large workspace is still loading.
      const found: Row[] = [];
      let skip = 0;
      let firstPage = true;
      while (true) {
        if (!firstPage) await sleep(PAGE_SPACING_MS);
        firstPage = false;
        const res = await fetchAccountsPage(
          { workspace_id: target._id, skip, limit: PAGE_SIZE },
          signal
        );
        for (const a of res.accounts ?? []) {
          const row = toRow(a);
          if (row) found.push(row);
        }
        setFetched((n) => n + (res.accounts?.length ?? 0));
        if (!res.hasMore) break;
        skip += PAGE_SIZE;
      }
      setRows(found);

      // The sheet is per domain, so one read covers every inbox.
      setPhase("Reading the sheet's warmup dates…");
      const domains = Array.from(new Set(found.map((r) => r.domain).filter(Boolean)));
      try {
        const dates = await fetchWarmupDates(
          { domains, url: sheetConfig?.url, tab: sheetConfig?.tab },
          signal
        );
        setSheetDates(dates.byDomain ?? {});
        setSheetNote(
          dates.problem ? `${dates.problem} Plusvibe's own warmup dates are used instead.` : null
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        setSheetDates({});
        setSheetNote(
          `The sheet could not be read (${errMessage(err)}). Plusvibe's own warmup dates are used instead.`
        );
      }
      setFetchedAt(Date.now());
    } catch (err) {
      if (!isAbort(err)) setError(errMessage(err));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setPhase("");
      }
    }
  }, [workspaces, ws, sheetConfig]);

  function cancelFetch() {
    abortRef.current?.abort();
    setBusy(false);
    setPhase("");
  }

  // --- Derived -------------------------------------------------------------
  const minDays = useMemo(() => parseMinDays(minDaysRaw), [minDaysRaw]);
  const rules = useMemo(
    () => ({ minDays: minDays.value, skipInCampaign }),
    [minDays.value, skipInCampaign]
  );

  const judged: Judged[] = useMemo(() => {
    const now = fetchedAt || Date.now();
    return rows.map((r) => {
      const resolved = resolveWarmupStart(sheetDates[r.domain], r.plusvibeEnabledAt, now);
      const j = judge(
        {
          warmupStatus: r.warmupStatus,
          warmupEnabledAt: resolved.at ?? undefined,
          campaignIds: r.campaignIds,
        },
        rules,
        now
      );
      return { ...r, startAt: resolved.at, source: resolved.source, ...j };
    });
  }, [rows, sheetDates, rules, fetchedAt]);

  const counts = useMemo(() => countVerdicts(judged.map((r) => r.verdict)), [judged]);
  const groups = useMemo(() => groupByDomain(judged), [judged]);
  const readyGroups = useMemo(() => groups.filter((g) => g.ready > 0), [groups]);
  const visibleGroups = readyOnly ? readyGroups : groups;
  const fromSheet = judged.filter((r) => r.source === "sheet").length;
  const fromPlusvibe = judged.filter((r) => r.source === "plusvibe").length;
  const warmingOn = judged.filter((r) => warmupIsOn(r.warmupStatus)).length;

  // A selection only ever means ready inboxes, so a rule change that makes a
  // domain unready quietly drops it from the total rather than counting it.
  const totals = useMemo(() => selectionTotals(groups, selected), [groups, selected]);
  // What a run would move: the ready inboxes on the ticked domains.
  const moving: MovingInbox[] = useMemo(
    () =>
      judged
        .filter((r) => r.verdict === "ready" && selected.has(r.domain))
        .map((r) => ({
          id: r.id,
          email: r.email,
          domain: r.domain,
          provider: r.provider,
          firstName: r.firstName,
          lastName: r.lastName,
        })),
    [judged, selected]
  );
  const sourceWorkspace = useMemo(() => {
    const w = workspaces.find((x) => x._id === ws);
    return w && fetchedFor ? { id: w._id, name: w.name } : null;
  }, [workspaces, ws, fetchedFor]);
  const inboxesByDomain = useMemo(() => {
    const m = new Map<string, Judged[]>();
    for (const r of judged) {
      const list = m.get(r.domain) ?? [];
      list.push(r);
      m.set(r.domain, list);
    }
    return m;
  }, [judged]);

  function toggleDomain(domain: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }
  const allReadySelected =
    readyGroups.length > 0 && readyGroups.every((g) => selected.has(g.domain));

  async function handleCopy() {
    const emails = totals.inboxes > 0 ? totals.emails : readyGroups.flatMap((g) => g.readyEmails);
    if (await copyToClipboard(emails.join("\n"))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* Step 1 */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Step 1 · Find the domains that are ready</h2>

        <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
          <div className="min-w-[260px] flex-1">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Workspace the inboxes are warming in
            </label>
            <div className="relative">
              <select
                className="pv-input appearance-none pr-9"
                value={ws}
                disabled={workspacesLoading || busy}
                aria-label="Warming workspace"
                onChange={(e) => {
                  setWs(e.target.value);
                  setRows([]);
                  setFetchedFor(null);
                  setSelected(new Set());
                }}
              >
                <option value="">
                  {workspacesLoading ? "Loading workspaces…" : "Pick a workspace"}
                </option>
                {workspaces.map((w) => (
                  <option key={w._id} value={w._id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                size={16}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Warming for at least
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={365}
                step={1}
                className={`pv-input w-24 text-right tabular-nums ${minDays.problem ? "border-danger" : ""}`}
                value={minDaysRaw}
                onChange={(e) => setMinDaysRaw(e.target.value)}
                aria-label="Minimum warmup days"
              />
              <span className="text-xs text-muted-foreground">days</span>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground lg:pb-2.5">
            <input
              type="checkbox"
              className="accent-accent"
              checked={skipInCampaign}
              onChange={(e) => setSkipInCampaign(e.target.checked)}
              aria-label="Skip inboxes already in a campaign"
            />
            Skip inboxes already in a campaign
          </label>

          <div className="flex gap-2">
            {busy && (
              <button type="button" className="pv-btn-ghost" onClick={cancelFetch}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className="pv-btn-primary disabled:opacity-50"
              onClick={() => void fetchInboxes()}
              disabled={busy || !ws || !!minDays.problem}
              data-fetch
            >
              {busy ? <Spinner /> : <MailIcon size={16} />}
              {busy ? phase || "Fetching…" : rows.length > 0 ? "Fetch again" : "Fetch inboxes"}
            </button>
          </div>
        </div>

        {minDays.problem && <p className="text-xs text-danger">{minDays.problem}</p>}

        {busy && (
          <div className="space-y-1.5" data-fetch-progress>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{phase}</span>
              <span className="tabular-nums">
                {formatNumber(fetched)} inbox{fetched === 1 ? "" : "es"} found
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <SheetIcon size={13} />
          {hasSheet
            ? `Warmup dates come from the synced sheet's "${sheetConfig?.tab || "📋 Domains"}" tab first.`
            : "No sheet is synced here, so the server's Email Infra sheet is read for warmup dates, if it is set up."}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {rows.length === 0 && !busy && (
        <EmptyState icon={<PlayIcon />} title="Nothing fetched yet">
          Pick the warming workspace and press <strong>Fetch inboxes</strong>.
        </EmptyState>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard
              label="Inboxes found"
              value={formatNumber(rows.length)}
              sub={`${formatNumber(groups.length)} domain${groups.length === 1 ? "" : "s"} in ${fetchedFor ?? "the workspace"}`}
            />
            <StatCard
              label="Ready"
              value={formatNumber(counts.ready)}
              sub={`on ${formatNumber(readyGroups.length)} domain${readyGroups.length === 1 ? "" : "s"} · warmed ${minDays.value}+ days${skipInCampaign ? ", not in a campaign" : ""}`}
            />
            <StatCard
              label="Still warming"
              value={formatNumber(counts["too-new"])}
              sub={`${formatNumber(warmingOn)} with warmup on`}
            />
            <StatCard
              label="Dates from the sheet"
              value={formatNumber(fromSheet)}
              sub={
                fromPlusvibe > 0
                  ? `${formatNumber(fromPlusvibe)} from Plusvibe instead`
                  : counts["no-start-date"] > 0
                    ? `${formatNumber(counts["no-start-date"])} with no date anywhere`
                    : "every inbox"
              }
            />
          </div>

          {sheetNote && (
            <div
              className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
              data-sheet-note
            >
              <AlertIcon size={14} className="mt-0.5 shrink-0" />
              <span>{sheetNote}</span>
            </div>
          )}

          {counts.ready < rows.length && (
            <p className="text-xs text-muted-foreground" data-skipped>
              Not ready: {describeSkipped(counts)}.
            </p>
          )}

          {/* Selection */}
          <div
            className={`pv-card p-4 sm:p-5 ${totals.inboxes > 0 ? "border-accent/40" : ""}`}
            data-selection
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">
                  {totals.domains === 0
                    ? "No domains selected"
                    : `${formatNumber(totals.domains)} domain${totals.domains === 1 ? "" : "s"} selected · ${formatNumber(totals.inboxes)} inbox${totals.inboxes === 1 ? "" : "es"} to move`}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="pv-chip"
                  disabled={readyGroups.length === 0}
                  onClick={() =>
                    setSelected(
                      allReadySelected ? new Set() : new Set(readyGroups.map((g) => g.domain))
                    )
                  }
                  data-select-all
                >
                  {allReadySelected
                    ? "Clear selection"
                    : `Select all ready (${formatNumber(readyGroups.length)})`}
                </button>
                <button
                  type="button"
                  className="pv-btn-ghost"
                  disabled={totals.inboxes === 0 && readyGroups.length === 0}
                  onClick={handleCopy}
                  title="Copies the selected inboxes' addresses, or every ready one when nothing is selected"
                >
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                  <span className="hidden sm:inline">
                    {copied
                      ? "Copied!"
                      : `Copy ${formatNumber(totals.inboxes > 0 ? totals.inboxes : counts.ready)} addresses`}
                  </span>
                </button>
                <button
                  type="button"
                  className="pv-btn-ghost"
                  disabled={judged.length === 0}
                  onClick={() => exportCsv(judged, selected, fetchedFor ?? "inboxes")}
                >
                  <DownloadIcon size={16} />
                  <span className="hidden sm:inline">Export CSV</span>
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">By domain</h2>
              <button
                type="button"
                onClick={() => setReadyOnly((v) => !v)}
                className={`pv-chip ${readyOnly ? "pv-chip-active" : "hover:text-foreground"}`}
              >
                <CheckIcon size={13} />
                {readyOnly ? "Ready only" : "Filter ready"}
              </button>
            </div>
            <span className="text-xs text-muted-foreground">
              Click a domain to see its inboxes.
            </span>
          </div>

          {visibleGroups.length > 0 ? (
            <div className="pv-card overflow-hidden">
              <div className="pv-scroll overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          className="accent-accent"
                          aria-label="Select every ready domain"
                          checked={allReadySelected}
                          disabled={readyGroups.length === 0}
                          onChange={() =>
                            setSelected(
                              allReadySelected
                                ? new Set()
                                : new Set(readyGroups.map((g) => g.domain))
                            )
                          }
                        />
                      </th>
                      <th className="px-3 py-3 text-left font-medium">Domain</th>
                      <th className="whitespace-nowrap px-2.5 py-3 text-right font-medium">Warmed</th>
                      <th className="px-3 py-3 text-left font-medium">Date from</th>
                      <th className="whitespace-nowrap px-2.5 py-3 text-right font-medium">Ready</th>
                      <th className="px-3 py-3 text-left font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleGroups.map((g) => (
                      <DomainRows
                        key={g.domain}
                        group={g}
                        inboxes={inboxesByDomain.get(g.domain) ?? []}
                        selected={selected.has(g.domain)}
                        expanded={expanded === g.domain}
                        onToggle={() => toggleDomain(g.domain)}
                        onExpand={() => setExpanded(expanded === g.domain ? null : g.domain)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState icon={<MailIcon />} title="No domain is ready">
              Nothing has warmed for {minDays.value} days yet
              {skipInCampaign ? ", or the ones that have are already in a campaign" : ""}.
              Lower the days, or untick the campaign filter.
            </EmptyState>
          )}

          <OutreachSetup
            source={sourceWorkspace}
            workspaces={workspaces}
            inboxes={moving}
            sheetDates={sheetDates}
            sheetConfig={sheetConfig}
            hasSheet={hasSheet}
          />
        </>
      )}
    </div>
  );
}

// --- Domain row + its inboxes ----------------------------------------------

function DomainRows({
  group,
  inboxes,
  selected,
  expanded,
  onToggle,
  onExpand,
}: {
  group: DomainSummary;
  inboxes: Judged[];
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const verdict = domainVerdict(group);
  const label =
    verdict === "partly"
      ? `Partly ready`
      : verdict === "ready"
        ? "Ready"
        : VERDICT_LABELS[verdict];
  // One provider reads as its name; a mix is counted out, most common first.
  const providers =
    group.providers.length === 1
      ? providerShort(group.providers[0][0])
      : group.providers.map(([key, n]) => `${formatNumber(n)} ${providerShort(key)}`).join(" · ");

  return (
    <>
      <tr
        className={`border-b border-border/70 transition ${selected ? "bg-accent/5" : ""}`}
        data-domain-row={group.domain}
      >
        <td className="px-3 py-3 align-top">
          <input
            type="checkbox"
            className="accent-accent"
            aria-label={`Select ${group.domain}`}
            checked={selected}
            disabled={group.ready === 0}
            onChange={onToggle}
            title={group.ready === 0 ? "No inbox on this domain is ready" : undefined}
          />
        </td>
        <td className="px-3 py-3">
          <button
            type="button"
            className="text-left"
            onClick={onExpand}
            aria-expanded={expanded}
          >
            <span className="font-mono text-sm font-medium">{group.domain}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground" data-domain-sub>
              {formatNumber(group.total)} inbox{group.total === 1 ? "" : "es"}
              {providers ? ` · ${providers}` : ""}
            </span>
          </button>
        </td>
        <td className="whitespace-nowrap px-2.5 py-3 text-right tabular-nums">
          {group.days !== null ? `${formatNumber(group.days)} days` : "—"}
        </td>
        <td className="px-3 py-3 text-xs text-muted-foreground">{SOURCE_LABEL[group.source]}</td>
        <td className="whitespace-nowrap px-2.5 py-3 text-right tabular-nums">
          {formatNumber(group.ready)} / {formatNumber(group.total)}
        </td>
        <td className="px-3 py-3">
          <span
            className={`inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${VERDICT_CLASS[verdict]}`}
          >
            {label}
          </span>
        </td>
      </tr>
      {expanded &&
        inboxes.map((r) => (
          <tr key={r.id} className="border-b border-border/40 bg-muted/30 text-xs" data-inbox-row>
            <td />
            <td className="px-3 py-2">
              <span className="break-all">{r.email}</span>
              <span
                className={`ml-2 inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                  PROVIDER_BADGE[r.provider] ?? PROVIDER_BADGE.REGULAR_ACCOUNT
                }`}
              >
                {providerShort(r.provider)}
              </span>
              <span className="ml-2 text-muted-foreground">
                warmup {warmupIsOn(r.warmupStatus) ? "on" : (r.warmupStatus ?? "off").toLowerCase()}
                {r.warmupHealth !== undefined ? ` · health ${formatPercent(r.warmupHealth)}` : ""}
                {r.campaignIds.length > 0
                  ? ` · in ${formatNumber(r.campaignIds.length)} campaign${r.campaignIds.length === 1 ? "" : "s"}`
                  : ""}
              </span>
            </td>
            <td className="whitespace-nowrap px-2.5 py-2 text-right tabular-nums">
              {r.days !== null ? `${formatNumber(r.days)} days` : "—"}
            </td>
            <td className="px-3 py-2 text-muted-foreground">{SOURCE_LABEL[r.source]}</td>
            <td />
            <td className="px-3 py-2">
              <span
                className={`inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-medium ${VERDICT_CLASS[r.verdict]}`}
              >
                {VERDICT_LABELS[r.verdict]}
              </span>
            </td>
          </tr>
        ))}
    </>
  );
}

// --- Helpers ---------------------------------------------------------------

function toRow(a: EmailAccount): Row | null {
  if (!a.id || !a.email) return null;
  return {
    id: a.id,
    email: a.email.trim().toLowerCase(),
    domain: domainFromEmail(a.email) ?? "",
    provider: providerBucket(a.provider),
    warmupStatus: a.warmup_status,
    warmupHealth: a.warmup_health,
    campaignIds: a.campaign_ids ?? [],
    plusvibeEnabledAt: a.warmup_enabled_at,
    firstName: a.first_name,
    lastName: a.last_name,
  };
}

function exportCsv(rows: Judged[], selected: Set<string>, scope: string) {
  const headers = [
    "inbox",
    "domain",
    "selected",
    "provider",
    "warmup_status",
    "warmup_started",
    "warmup_days",
    "date_source",
    "warmup_health",
    "campaigns",
    "verdict",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.email,
        r.domain,
        selected.has(r.domain) && r.verdict === "ready" ? "yes" : "",
        providerShort(r.provider),
        r.warmupStatus ?? "",
        r.startAt !== null ? new Date(r.startAt).toISOString().slice(0, 10) : "",
        r.days ?? "",
        r.source,
        r.warmupHealth ?? "",
        r.campaignIds.length,
        VERDICT_LABELS[r.verdict],
      ]
        .map((v) => {
          const s = String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `start-outreach_${scope.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
