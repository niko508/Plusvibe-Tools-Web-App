"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type { DeleteTask, JobRecord, JobStatus } from "@/lib/jobs/types";
import {
  fetchWorkspaces,
  startBulkDelete,
  listBulkDeleteJobs,
  abortBulkDelete,
  deleteBulkDeleteJob,
  fetchSheetMap,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { useSheetConfig } from "@/lib/use-sheet-config";
import { formatNumber } from "@/lib/format";
import { copyToClipboard } from "@/lib/clipboard";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { Spinner, EmptyState, RemoveJobButton } from "@/components/ui";
import {
  TrashIcon,
  AlertIcon,
  CopyIcon,
  CheckIcon,
  DownloadIcon,
  RefreshIcon,
  ChevronDownIcon,
  SheetIcon,
  UploadIcon,
} from "@/components/icons";
import { buildDomainIndex } from "./scan";
import {
  parseDomains,
  parseEmails,
  domainsOfEmails,
  matchDomains,
  matchEmails,
} from "./parse";
import { exportNotFound, exportErrors } from "./export";
import { isDefaultExcluded } from "./constants";
import type { Phase, Mode, ScanResult, IndexEntry } from "./types";

const MAX_TABLE_ROWS = 200;

/** Everything that differs between the two list modes, in one place. */
const MODE_COPY: Record<
  Mode,
  {
    tab: string;
    label: string;
    placeholder: string;
    unit: string;
    unitPlural: string;
    matchedStat: string;
    notFoundStat: string;
    emptyPrompt: string;
    hint: string;
  }
> = {
  domain: {
    tab: "By domain",
    label: "Domains to remove",
    placeholder: "acme.com\nacme.io\nmail.acme.co\n…",
    unit: "domain",
    unitPlural: "domains",
    matchedStat: "Domains matched",
    notFoundStat: "Domains not found",
    emptyPrompt: "Paste at least one domain first.",
    hint: "Every inbox on these domains is removed.",
  },
  inbox: {
    tab: "By inbox address",
    label: "Inboxes to remove",
    placeholder: "joe.d@acme.com\nsara@acme.io\n…",
    unit: "address",
    unitPlural: "addresses",
    matchedStat: "Inboxes matched",
    notFoundStat: "Addresses not found",
    emptyPrompt: "Paste at least one inbox address first.",
    hint: "Only these exact mailboxes are removed. Others on the same domain are left alone.",
  },
};

export function RemoveInboxesTool() {
  const { hasKey, ready } = useApiKey();
  const { config: sheetConfig, hasSheet } = useSheetConfig();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [scopeOpen, setScopeOpen] = useState(false);

  const [mode, setMode] = useState<Mode>("domain");
  const [raw, setRaw] = useState("");
  const copy = MODE_COPY[mode];

  // Domain mode reads the paste as domains; inbox mode as addresses, keeping
  // the domains behind them for the sheet lookup and the scan.
  const parsedDomains = useMemo(
    () => (mode === "domain" ? parseDomains(raw) : []),
    [raw, mode]
  );
  const parsedEmails = useMemo(
    () => (mode === "inbox" ? parseEmails(raw) : { emails: [], skipped: [] }),
    [raw, mode]
  );
  const entryCount =
    mode === "domain" ? parsedDomains.length : parsedEmails.emails.length;
  // What the scan has to look for, either way.
  const scanDomains = useMemo(
    () =>
      mode === "domain" ? parsedDomains : domainsOfEmails(parsedEmails.emails),
    [mode, parsedDomains, parsedEmails.emails]
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0, inboxes: 0 });
  const [scanLabel, setScanLabel] = useState("Scanning…");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetWarning, setSheetWarning] = useState<string | null>(null);

  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      // Start with all workspaces selected except the default-excluded ones.
      setScopeIds(
        list.filter((w) => !isDefaultExcluded(w.name)).map((w) => w._id)
      );
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  // --- Jobs polling --------------------------------------------------------
  const refreshJobs = useCallback(async () => {
    try {
      const res = await listBulkDeleteJobs();
      setJobs(res.jobs ?? []);
    } catch {
      // transient; keep last known list
    }
  }, []);

  useEffect(() => {
    if (!(ready && hasKey)) return;
    void refreshJobs();
    const interval = setInterval(() => void refreshJobs(), 2500);
    return () => clearInterval(interval);
  }, [ready, hasKey, refreshJobs]);

  // --- Scan ----------------------------------------------------------------
  async function handleScan() {
    setError(null);
    if (entryCount === 0) {
      setError(copy.emptyPrompt);
      return;
    }
    const scoped = workspaces.filter((w) => scopeIds.includes(w._id));
    if (scoped.length === 0) {
      setError("Select at least one workspace to scan.");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setPhase("scanning");
    setScanResult(null);
    setConfirmText("");
    setSheetWarning(null);
    setScanProgress({ done: 0, total: 0, inboxes: 0 });
    setScanLabel("Scanning…");

    try {
      // 1) Sheet targeting — resolve pasted domains to workspaces via the sheet
      //    so we only scan the workspaces that actually hold them.
      let targetWorkspaces = scoped; // default: full scan of the scope
      let usedSheet = false;
      if (sheetConfig) {
        setScanLabel("Reading Email Infra sheet…");
        try {
          const sheet = await fetchSheetMap(
            { url: sheetConfig.url, tab: sheetConfig.tab },
            signal
          );
          const wsByName = new Map<string, Workspace>();
          for (const w of scoped) wsByName.set(w.name.trim().toLowerCase(), w);
          const targetSet = new Map<string, Workspace>();
          for (const d of scanDomains) {
            const client = sheet.map[d];
            if (!client) continue;
            const w = wsByName.get(client.trim().toLowerCase());
            if (w) targetSet.set(w._id, w);
          }
          if (targetSet.size > 0) {
            usedSheet = true;
            targetWorkspaces = Array.from(targetSet.values());
          }
        } catch (err) {
          if (isAbort(err)) {
            setPhase("idle");
            return;
          }
          // Sheet unreadable — warn and fall back to a full scan.
          setSheetWarning(`Sheet not used: ${errMessage(err)}`);
        }
      }

      const combinedIndex = new Map<string, IndexEntry[]>();
      const workspaceNames: Record<string, string> = {};
      const masterEmails = new Set<string>();
      // One matcher for both modes, so the two phases below stay identical.
      const match = (index: Map<string, IndexEntry[]>) =>
        mode === "domain"
          ? matchDomains(parsedDomains, index)
          : matchEmails(parsedEmails.emails, index, masterEmails);

      // 2) Scan the targeted (or full) set of workspaces.
      setScanLabel(
        usedSheet
          ? `Scanning ${targetWorkspaces.length} targeted workspace${
              targetWorkspaces.length === 1 ? "" : "s"
            } (via sheet)…`
          : "Scanning workspaces for matching inboxes…"
      );
      setScanProgress({ done: 0, total: targetWorkspaces.length, inboxes: 0 });
      const first = await buildDomainIndex(
        targetWorkspaces,
        { concurrency: 2, spacingMs: 250, signal },
        setScanProgress
      );
      mergeIndex(combinedIndex, first.index);
      Object.assign(workspaceNames, first.workspaceNames);
      for (const e of first.masterEmails) masterEmails.add(e);
      let excludedMaster = first.excludedMaster;

      let { matched, notFound, protectedMaster } = match(combinedIndex);

      // 3) Fallback — full-scan the remaining workspaces for anything the sheet
      //    couldn't place (unlisted domain, blank client, or drift).
      if (usedSheet && notFound.length > 0) {
        const scanned = new Set(targetWorkspaces.map((w) => w._id));
        const remaining = scoped.filter((w) => !scanned.has(w._id));
        if (remaining.length > 0) {
          setScanLabel(
            `Full-scanning ${remaining.length} more workspace${
              remaining.length === 1 ? "" : "s"
            } for ${notFound.length} unmatched ${
              notFound.length === 1 ? copy.unit : copy.unitPlural
            }…`
          );
          setScanProgress({ done: 0, total: remaining.length, inboxes: 0 });
          const second = await buildDomainIndex(
            remaining,
            { concurrency: 2, spacingMs: 250, signal },
            setScanProgress
          );
          mergeIndex(combinedIndex, second.index);
          Object.assign(workspaceNames, second.workspaceNames);
          for (const e of second.masterEmails) masterEmails.add(e);
          excludedMaster += second.excludedMaster;
          ({ matched, notFound, protectedMaster } = match(combinedIndex));
        }
      }

      const totalInboxes = matched.reduce((s, m) => s + m.inboxes.length, 0);
      setScanResult({
        mode,
        matched,
        notFound,
        protectedMaster,
        totalInboxes,
        workspaceNames,
        excludedMaster,
      });
      setPhase("preview");
    } catch (err) {
      if (isAbort(err)) {
        setPhase("idle");
        return;
      }
      setError(errMessage(err));
      setPhase("idle");
    }
  }

  function cancelScan() {
    abortRef.current?.abort();
    setPhase("idle");
  }

  // --- Start delete job ----------------------------------------------------
  const totalInboxes = scanResult?.totalInboxes ?? 0;
  const confirmArmed =
    confirmText.trim() === String(totalInboxes) ||
    confirmText.trim().toUpperCase() === "DELETE";

  async function handleDelete() {
    if (!scanResult || totalInboxes === 0) return;
    const tasks: DeleteTask[] = [];
    for (const m of scanResult.matched) {
      for (const inbox of m.inboxes) {
        tasks.push({
          workspace_id: inbox.workspace_id,
          email: inbox.email,
          domain: m.domain,
        });
      }
    }
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await startBulkDelete({
        label:
          scanResult.mode === "inbox"
            ? `${formatNumber(tasks.length)} inboxes by address`
            : `${scanResult.matched.length} domains · ${formatNumber(tasks.length)} inboxes`,
        workspaceNames: scanResult.workspaceNames,
        notFound: scanResult.notFound,
        mode: scanResult.mode,
        tasks,
      });
      setHighlightJobId(jobId);
      setTimeout(() => setHighlightJobId(null), 4000);
      setPhase("idle");
      setScanResult(null);
      setConfirmText("");
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleAbortJob(id: string) {
    try {
      await abortBulkDelete(id);
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    }
  }

  async function handleRemoveJob(id: string) {
    try {
      await deleteBulkDeleteJob(id);
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  const scanning = phase === "scanning";

  return (
    <div className="space-y-5">
      {/* Input */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <ModeTabs
          mode={mode}
          onChange={(next) => {
            setMode(next);
            // The pasted list means something different now, so drop the scan.
            setScanResult(null);
            setPhase("idle");
            setError(null);
          }}
        />

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label className="block text-sm font-medium">{copy.label}</label>
            <UploadButton onText={(text) => setRaw((v) => joinLists(v, text))} />
          </div>
          <textarea
            className="pv-input pv-scroll resize-none font-mono text-sm leading-6"
            rows={14}
            placeholder={copy.placeholder}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            spellCheck={false}
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-medium text-muted-foreground">
              {formatNumber(entryCount)}{" "}
              {entryCount === 1 ? copy.unit : copy.unitPlural}
            </span>
            <span className="text-muted-foreground">· {copy.hint}</span>
            {mode === "inbox" && parsedEmails.skipped.length > 0 && (
              <span
                className="text-warning"
                title={parsedEmails.skipped.slice(0, 20).join("\n")}
              >
                · {formatNumber(parsedEmails.skipped.length)} line
                {parsedEmails.skipped.length === 1 ? "" : "s"} ignored (not an
                email address)
              </span>
            )}
          </div>
          {hasSheet ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-success">
              <SheetIcon size={13} />
              Sheet synced — scans target only the workspaces your{" "}
              {mode === "inbox" ? "addresses" : "domains"} map to.
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">
              Tip: sync your Email Infra sheet (top-right) to scan only the
              relevant workspaces instead of all of them.
            </div>
          )}
        </div>

        <ScopeSelector
          workspaces={workspaces}
          loading={workspacesLoading}
          selected={scopeIds}
          onChange={setScopeIds}
          open={scopeOpen}
          onToggleOpen={() => setScopeOpen((v) => !v)}
        />

        <div className="flex items-center justify-end gap-2">
          {scanning ? (
            <button type="button" className="pv-btn-ghost" onClick={cancelScan}>
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="pv-btn-primary"
            onClick={handleScan}
            disabled={scanning || entryCount === 0}
          >
            {scanning ? <Spinner /> : <RefreshIcon size={16} />}
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </div>

        {sheetWarning && (
          <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertIcon size={14} className="mt-0.5 shrink-0" />
            <span>{sheetWarning}</span>
          </div>
        )}

        {scanning && (
          <ProgressLine
            label={scanLabel}
            done={scanProgress.done}
            total={scanProgress.total}
            inboxes={scanProgress.inboxes}
          />
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Preview + confirm */}
      {phase === "preview" && scanResult && (
        <PreviewPanel
          result={scanResult}
          confirmText={confirmText}
          onConfirmText={setConfirmText}
          confirmArmed={confirmArmed}
          starting={starting}
          onDelete={handleDelete}
          onCancel={() => {
            setScanResult(null);
            setPhase("idle");
          }}
        />
      )}

      {/* Jobs */}
      <JobsPanel
        jobs={jobs}
        highlightJobId={highlightJobId}
        onAbort={handleAbortJob}
        onRemove={handleRemoveJob}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode tabs + list upload
// ---------------------------------------------------------------------------

function ModeTabs({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="What the list names"
      className="inline-flex rounded-xl border border-border p-1"
    >
      {(Object.keys(MODE_COPY) as Mode[]).map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(m)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              active
                ? "bg-accent/10 font-medium text-accent"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {MODE_COPY[m].tab}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Reads a pasted-in list from a file. Anything text-shaped works — a one-column
 * CSV export is just lines with commas, which the parsers already split on.
 */
function UploadButton({ onText }: { onText: (text: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {name && (
        <span className="max-w-[160px] truncate text-xs text-muted-foreground">
          {name}
        </span>
      )}
      <button
        type="button"
        className="pv-chip"
        onClick={() => inputRef.current?.click()}
      >
        <UploadIcon size={13} />
        Upload list
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.csv,.tsv,text/plain,text/csv"
        className="hidden"
        aria-label="Upload a list file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          onText(text);
          setName(file.name);
          // Let the same file be picked again after an edit.
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Appends an uploaded list to whatever is already in the box. */
function joinLists(existing: string, added: string): string {
  const left = existing.trimEnd();
  const right = added.trim();
  if (!left) return right;
  if (!right) return existing;
  return `${left}\n${right}`;
}

// ---------------------------------------------------------------------------
// Scope selector
// ---------------------------------------------------------------------------

function ScopeSelector({
  workspaces,
  loading,
  selected,
  onChange,
  open,
  onToggleOpen,
}: {
  workspaces: Workspace[];
  loading: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const all = workspaces.length > 0 && selected.length === workspaces.length;
  const summary = loading
    ? "Loading workspaces…"
    : all
      ? `All workspaces (${workspaces.length})`
      : `${selected.length} of ${workspaces.length} workspaces`;

  function toggle(id: string) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id]
    );
  }

  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-sm"
      >
        <span className="text-muted-foreground">
          Scope: <span className="font-medium text-foreground">{summary}</span>
        </span>
        <ChevronDownIcon
          size={16}
          className={`text-muted-foreground transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && !loading && (
        <div className="border-t border-border p-2">
          <div className="mb-2 flex gap-2 px-1.5">
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={() => onChange(workspaces.map((w) => w._id))}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>
          <div className="pv-scroll max-h-48 space-y-0.5 overflow-y-auto">
            {workspaces.map((w) => (
              <label
                key={w._id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={selected.includes(w._id)}
                  onChange={() => toggle(w._id)}
                />
                {w.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview + confirm
// ---------------------------------------------------------------------------

function PreviewPanel({
  result,
  confirmText,
  onConfirmText,
  confirmArmed,
  starting,
  onDelete,
  onCancel,
}: {
  result: ScanResult;
  confirmText: string;
  onConfirmText: (v: string) => void;
  confirmArmed: boolean;
  starting: boolean;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = MODE_COPY[result.mode];
  const byInbox = result.mode === "inbox";
  const shown = result.matched.slice(0, MAX_TABLE_ROWS);
  // Inbox mode lists the mailboxes themselves rather than a domain rollup.
  const shownInboxes = result.matched
    .flatMap((m) => m.inboxes)
    .slice(0, MAX_TABLE_ROWS);
  const workspaceCount = new Set(
    result.matched.flatMap((m) => m.workspaces)
  ).size;

  async function copyNotFound() {
    if (await copyToClipboard(result.notFound.join("\n"))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label={byInbox ? "Domains touched" : copy.matchedStat}
          value={formatNumber(result.matched.length)}
        />
        <StatCard label="Inboxes to delete" value={formatNumber(result.totalInboxes)} />
        <StatCard label={copy.notFoundStat} value={formatNumber(result.notFound.length)} />
      </div>

      {result.protectedMaster.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertIcon size={14} className="mt-0.5 shrink-0" />
          <span>
            {formatNumber(result.protectedMaster.length)} pasted address
            {result.protectedMaster.length === 1 ? " is a" : "es are"}{" "}
            &ldquo;Master Inbox&rdquo; mailbox
            {result.protectedMaster.length === 1 ? "" : "es"} and will not be
            deleted: {result.protectedMaster.slice(0, 5).join(", ")}
            {result.protectedMaster.length > 5
              ? `, +${result.protectedMaster.length - 5} more`
              : ""}
            .
          </span>
        </div>
      )}

      {result.excludedMaster > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-success">
          <CheckIcon size={13} />
          {formatNumber(result.excludedMaster)} &ldquo;Master Inbox&rdquo; mailbox
          {result.excludedMaster === 1 ? "" : "es"} excluded from deletion.
        </div>
      )}

      {result.matched.length > 0 ? (
        <div className="pv-card overflow-hidden">
          <div className="pv-scroll overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  {byInbox ? (
                    <>
                      <th className="px-4 py-3 text-left font-medium">Inbox</th>
                      <th className="px-4 py-3 text-left font-medium">Domain</th>
                      <th className="px-4 py-3 text-left font-medium">Workspace</th>
                    </>
                  ) : (
                    <>
                      <th className="px-4 py-3 text-left font-medium">Domain</th>
                      <th className="px-4 py-3 text-right font-medium">Inboxes</th>
                      <th className="px-4 py-3 text-left font-medium">Workspaces</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {byInbox
                  ? shownInboxes.map((i) => (
                      <tr
                        key={`${i.workspace_id}:${i.email}`}
                        className="border-b border-border/70 last:border-0"
                      >
                        <td className="px-4 py-2.5 font-medium">{i.email}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {i.domain}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {i.workspaceName}
                        </td>
                      </tr>
                    ))
                  : shown.map((m) => (
                      <tr
                        key={m.domain}
                        className="border-b border-border/70 last:border-0"
                      >
                        <td className="px-4 py-2.5 font-medium">{m.domain}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatNumber(m.inboxes.length)}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {m.workspaces.join(", ")}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {byInbox
            ? result.totalInboxes > shownInboxes.length && (
                <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                  + {formatNumber(result.totalInboxes - shownInboxes.length)} more
                  inboxes (all included in the delete)
                </div>
              )
            : result.matched.length > shown.length && (
                <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                  + {formatNumber(result.matched.length - shown.length)} more
                  domains (all included in the delete)
                </div>
              )}
        </div>
      ) : (
        <EmptyState title="No matching inboxes">
          {byInbox
            ? "None of the pasted addresses exist in the selected workspaces. Nothing to delete."
            : "None of the pasted domains have inboxes in the selected workspaces. Nothing to delete."}
        </EmptyState>
      )}

      {result.notFound.length > 0 && (
        <div className="pv-card px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {formatNumber(result.notFound.length)}{" "}
              {result.notFound.length === 1 ? copy.unit : copy.unitPlural} not
              found
            </span>
            <span className="flex gap-2">
              <button type="button" className="pv-chip" onClick={copyNotFound}>
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="pv-chip"
                onClick={() => exportNotFound(result.notFound, result.mode)}
              >
                <DownloadIcon size={13} />
                Export
              </button>
            </span>
          </div>
          <div className="pv-scroll mt-3 max-h-52 overflow-y-auto font-mono text-xs text-muted-foreground">
            {result.notFound.map((d) => (
              <div key={d} className="py-0.5">
                {d}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirm bar */}
      {result.totalInboxes > 0 && (
        <div className="pv-card border-danger/40 p-4 sm:p-5">
          <div className="flex items-start gap-2 text-sm text-danger">
            <AlertIcon size={18} className="mt-0.5 shrink-0" />
            <span>
              This permanently deletes{" "}
              <strong>{formatNumber(result.totalInboxes)} inboxes</strong> across{" "}
              <strong>
                {workspaceCount} workspace{workspaceCount === 1 ? "" : "s"}
              </strong>
              . This cannot be undone.
            </span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">
              Type <strong className="text-foreground">{result.totalInboxes}</strong>{" "}
              to confirm:
            </span>
            <input
              className="pv-input w-36 font-mono"
              value={confirmText}
              onChange={(e) => onConfirmText(e.target.value)}
              placeholder={String(result.totalInboxes)}
            />
            <button
              type="button"
              className="pv-btn bg-danger text-white shadow-soft hover:brightness-110 disabled:opacity-50"
              disabled={!confirmArmed || starting}
              onClick={onDelete}
            >
              {starting ? <Spinner /> : <TrashIcon size={16} />}
              Delete {formatNumber(result.totalInboxes)} inboxes
            </button>
            <button type="button" className="pv-btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Deletion runs as a background job — you can close this app and come
            back to check the results.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs panel
// ---------------------------------------------------------------------------

function JobsPanel({
  jobs,
  highlightJobId,
  onAbort,
  onRemove,
}: {
  jobs: JobRecord[];
  highlightJobId: string | null;
  onAbort: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">Jobs</h2>
      {jobs.length === 0 ? (
        <EmptyState icon={<TrashIcon />} title="No jobs yet">
          Scan a list and start a removal — it&apos;ll appear here and keep
          running even if you close the app.
        </EmptyState>
      ) : (
        jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            highlight={job.id === highlightJobId}
            onAbort={onAbort}
            onRemove={onRemove}
          />
        ))
      )}
    </div>
  );
}

const STATUS_META: Record<JobStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Aborted", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

function JobCard({
  job,
  highlight,
  onAbort,
  onRemove,
}: {
  job: JobRecord;
  highlight: boolean;
  onAbort: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const p = job.progress;
  const pct =
    p.inboxesTotal > 0
      ? Math.round((p.inboxesAttempted / p.inboxesTotal) * 100)
      : job.status === "done"
        ? 100
        : 0;
  const status = STATUS_META[job.status];
  const domainsDeleted = job.domains.filter(
    (d) => d.deleted + d.skipped > 0
  ).length;
  // Jobs made before inbox mode existed carry no mode; those were domain runs.
  const jobMode = job.mode ?? "domain";
  const byInbox = jobMode === "inbox";

  return (
    <div
      className={`pv-card p-4 sm:p-5 ${highlight ? "ring-2 ring-accent/40" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}
          >
            {job.status === "running" && <Spinner size={10} />}{" "}
            {status.label}
          </span>
          <span className="text-sm font-medium">{job.label}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {relativeTime(job.createdAt)}
        </span>
      </div>

      {/* Progress */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {formatNumber(p.domainsDone)} / {formatNumber(p.domainsTotal)} domains
            processed
          </span>
          <span className="tabular-nums">
            {formatNumber(p.inboxesAttempted)} / {formatNumber(p.inboxesTotal)}{" "}
            inboxes
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              job.status === "error" ? "bg-danger" : "bg-accent"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Result counts */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label={byInbox ? "Domains touched" : "Domains removed"}
          value={domainsDeleted}
          tone="default"
        />
        <Metric label="Inboxes deleted" value={p.inboxesDeleted} tone="success" />
        <Metric
          label={byInbox ? "Addresses not found" : "Not found"}
          value={job.notFound.length}
          tone="muted"
        />
        <Metric
          label="Errors"
          value={p.inboxesErrored}
          tone={p.inboxesErrored > 0 ? "danger" : "muted"}
        />
      </div>

      {p.inboxesSkipped > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {formatNumber(p.inboxesSkipped)} already removed (skipped).
        </p>
      )}
      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart — re-scan the same list to finish the
          remaining inboxes.
        </p>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {job.status === "running" && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => onAbort(job.id)}
          >
            Stop task
          </button>
        )}
        {(job.errors.length > 0 || job.notFound.length > 0) && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide details" : "Details"}
          </button>
        )}
        {job.notFound.length > 0 && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => exportNotFound(job.notFound, jobMode)}
          >
            <DownloadIcon size={16} />
            Not found
          </button>
        )}
        {job.errors.length > 0 && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => exportErrors(job.errors)}
          >
            <DownloadIcon size={16} />
            Errors
          </button>
        )}
        {job.status !== "running" && (
          <RemoveJobButton onRemove={() => onRemove(job.id)} />
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {job.errors.length > 0 && (
            <div className="pv-scroll max-h-48 overflow-y-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Workspace</th>
                    <th className="px-3 py-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {job.errors.map((e, i) => (
                    <tr key={i} className="border-b border-border/70 last:border-0">
                      <td className="px-3 py-2 font-mono">{e.email}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {e.workspaceName ?? e.workspace_id}
                      </td>
                      <td className="px-3 py-2 text-danger">{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {job.errorsTruncated && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  Error list truncated — export for the full set.
                </div>
              )}
            </div>
          )}
          {job.notFound.length > 0 && (
            <div className="pv-scroll max-h-40 overflow-y-auto rounded-xl border border-border p-3 font-mono text-xs text-muted-foreground">
              {job.notFound.map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "success" | "danger" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-danger"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>
        {formatNumber(value)}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ProgressLine({
  label,
  done,
  total,
  inboxes,
}: {
  label: string;
  done: number;
  total: number;
  inboxes?: number;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <Spinner size={12} />
          {label}
        </span>
        <span className="flex items-center gap-2 tabular-nums">
          {inboxes != null && inboxes > 0 && (
            <span className="text-foreground">
              {formatNumber(inboxes)} inboxes
            </span>
          )}
          <span>
            {done} / {total} workspaces
          </span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

// Merges one domain index into another (workspaces are disjoint across scan
// phases, so appending entries per domain is safe).
function mergeIndex(
  target: Map<string, IndexEntry[]>,
  source: Map<string, IndexEntry[]>
) {
  for (const [domain, entries] of source) {
    const existing = target.get(domain);
    if (existing) existing.push(...entries);
    else target.set(domain, [...entries]);
  }
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
