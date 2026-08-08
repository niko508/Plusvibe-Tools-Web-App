"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchAccounts,
  bulkUpdateSignature,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { mapPool } from "@/lib/concurrency";
import { copyToClipboard } from "@/lib/clipboard";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { Spinner, EmptyState } from "@/components/ui";
import {
  PenIcon,
  AlertIcon,
  CopyIcon,
  CheckIcon,
  ChevronDownIcon,
  RefreshIcon,
} from "@/components/icons";
import { buildSignature, generateBlocks, nameFormsFor } from "./generate";
import type { ApplyRow, PersonGroup, SignatureFields } from "./types";

const COMPANY_SLOTS = 3;
const PHONE_SLOTS = 5;
const ADDRESS_SLOTS = 3;

export function AddSignaturesTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [title, setTitle] = useState("");
  const [companies, setCompanies] = useState<string[]>(
    Array(COMPANY_SLOTS).fill("")
  );
  const [phones, setPhones] = useState<string[]>(Array(PHONE_SLOTS).fill(""));
  const [addresses, setAddresses] = useState<string[]>(
    Array(ADDRESS_SLOTS).fill("")
  );

  const [loadingInboxes, setLoadingInboxes] = useState(false);
  const [groups, setGroups] = useState<PersonGroup[]>([]);
  const [inboxTotal, setInboxTotal] = useState(0);
  const [skippedNoName, setSkippedNoName] = useState(0);
  const [loadedForWs, setLoadedForWs] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyRows, setApplyRows] = useState<ApplyRow[]>([]);
  const [applyProgress, setApplyProgress] = useState({ done: 0, total: 0 });
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const fields: SignatureFields = useMemo(
    () => ({ title, companies, phones, addresses }),
    [title, companies, phones, addresses]
  );

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      if (list.length && !workspaceId) setWorkspaceId(list[0]._id);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  // --- Load inboxes for the selected workspace -----------------------------
  async function loadInboxes() {
    if (!workspaceId) return;
    setLoadingInboxes(true);
    setError(null);
    setApplied(false);
    setApplyRows([]);
    try {
      const res = await fetchAccounts({ workspace_id: workspaceId });
      const accounts = res.accounts ?? [];
      const byPerson = new Map<string, PersonGroup>();
      let skipped = 0;
      for (const a of accounts) {
        const first = (a.first_name ?? "").trim();
        const last = (a.last_name ?? "").trim();
        if (!first) {
          skipped += 1;
          continue;
        }
        const key = `${first} ${last}`.trim().toLowerCase();
        let g = byPerson.get(key);
        if (!g) {
          g = { key, first, last, ids: [], emails: [] };
          byPerson.set(key, g);
        }
        if (a.id) g.ids.push(a.id);
        if (a.email) g.emails.push(a.email);
      }
      setGroups(Array.from(byPerson.values()));
      setInboxTotal(accounts.length);
      setSkippedNoName(skipped);
      setLoadedForWs(workspaceId);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoadingInboxes(false);
    }
  }

  // --- Derived preview -----------------------------------------------------
  const namedInboxes = useMemo(
    () => groups.reduce((s, g) => s + g.ids.length, 0),
    [groups]
  );
  const hasCompany = companies.some((c) => c.trim());
  const canApply =
    !!title.trim() &&
    hasCompany &&
    groups.length > 0 &&
    loadedForWs === workspaceId;

  // A representative person for the preview: prefer one with a last name.
  const sample = useMemo(() => {
    const withLast = groups.find((g) => g.last);
    const g = withLast ?? groups[0];
    return g ? { first: g.first, last: g.last } : { first: "Jane", last: "Doe" };
  }, [groups]);

  const preview = useMemo(() => {
    if (!title.trim() || !hasCompany) return null;
    const built = buildSignature(fields, sample.first, sample.last);
    if (!built) return null;
    const blocks = generateBlocks(fields, nameFormsFor(sample.first, sample.last));
    return { count: built.count, signature: built.signature, blocks };
  }, [fields, sample, title, hasCompany]);

  async function copySignature() {
    if (!preview) return;
    if (await copyToClipboard(preview.signature)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  // --- Apply ---------------------------------------------------------------
  async function handleApply() {
    if (!canApply) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const rows: ApplyRow[] = groups.map((g) => ({
      ...g,
      status: "pending",
      variations: 0,
    }));
    setApplyRows(rows);
    setApplyProgress({ done: 0, total: rows.length });
    setApplying(true);
    setApplied(false);
    setError(null);

    try {
      await mapPool(
        groups,
        async (group) => {
          updateRow(setApplyRows, group.key, { status: "running" });
          const built = buildSignature(fields, group.first, group.last);
          if (!built) {
            updateRow(setApplyRows, group.key, {
              status: "error",
              error: "Could not build signature (missing name).",
            });
          } else {
            try {
              await bulkUpdateSignature(
                {
                  workspace_id: workspaceId,
                  ids: group.ids,
                  signature: built.signature,
                },
                signal
              );
              updateRow(setApplyRows, group.key, {
                status: "done",
                variations: built.count,
              });
            } catch (err) {
              if (isAbort(err)) throw err;
              updateRow(setApplyRows, group.key, {
                status: "error",
                error: errMessage(err),
              });
            }
          }
          if (!signal.aborted) {
            setApplyProgress((p) => ({ ...p, done: p.done + 1 }));
          }
        },
        { concurrency: 3, minSpacingMs: 220, signal }
      );
      setApplied(true);
    } catch (err) {
      if (!isAbort(err)) setError(errMessage(err));
    } finally {
      if (!controller.signal.aborted) setApplying(false);
    }
  }

  function abortApply() {
    abortRef.current?.abort();
    setApplying(false);
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  const results = summarize(applyRows);

  return (
    <div className="space-y-5">
      {/* Workspace + fields */}
      <div className="pv-card space-y-5 p-4 sm:p-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Workspace</label>
          <div className="relative max-w-md">
            <select
              className="pv-input appearance-none pr-9"
              value={workspaceId}
              disabled={workspacesLoading || workspaces.length === 0}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setGroups([]);
                setLoadedForWs(null);
                setApplyRows([]);
                setApplied(false);
              }}
            >
              {workspacesLoading && <option>Loading…</option>}
              {!workspacesLoading &&
                workspaces.map((w) => (
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

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Job title / role" required>
            <input
              className="pv-input"
              placeholder="Co-Owner"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
        </div>

        <SlotGroup
          label="Company names"
          hint="At least one required"
          values={companies}
          onChange={setCompanies}
          placeholder="The Media Manager"
        />
        <SlotGroup
          label="Phone numbers"
          values={phones}
          onChange={setPhones}
          placeholder="(507) 218-8731"
        />
        <SlotGroup
          label="Addresses"
          values={addresses}
          onChange={setAddresses}
          placeholder="Rochester, MN 55901"
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            {loadedForWs === workspaceId && groups.length > 0
              ? `${formatNumber(namedInboxes)} inboxes · ${formatNumber(
                  groups.length
                )} people${
                  skippedNoName ? ` · ${formatNumber(skippedNoName)} skipped (no name)` : ""
                }`
              : "Load the workspace inboxes to personalize by name."}
          </p>
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={loadInboxes}
            disabled={loadingInboxes || !workspaceId}
          >
            {loadingInboxes ? <Spinner size={16} /> : <RefreshIcon size={16} />}
            {loadedForWs === workspaceId ? "Reload inboxes" : "Load inboxes"}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Variations / inbox" value={formatNumber(preview.count)} />
            <StatCard
              label="Inboxes to update"
              value={loadedForWs === workspaceId ? formatNumber(namedInboxes) : "—"}
            />
            <StatCard
              label="People"
              value={loadedForWs === workspaceId ? formatNumber(groups.length) : "—"}
            />
          </div>

          <div className="pv-card p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Preview{" "}
                <span className="font-normal text-muted-foreground">
                  · sample name {sample.first} {sample.last}
                </span>
              </h3>
              <button type="button" className="pv-chip" onClick={copySignature}>
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                {copied ? "Copied" : "Copy spintax"}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {preview.blocks.slice(0, 3).map((b, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border bg-muted/40 p-3 text-sm leading-6"
                  dangerouslySetInnerHTML={{ __html: b }}
                />
              ))}
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Show raw spintax ({formatNumber(preview.signature.length)} chars)
              </summary>
              <pre className="pv-scroll mt-2 max-h-52 overflow-auto rounded-xl border border-border bg-background p-3 text-xs">
                {preview.signature}
              </pre>
            </details>
          </div>
        </div>
      )}

      {/* Apply */}
      {loadedForWs === workspaceId && groups.length > 0 && (
        <div className="pv-card border-accent/30 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Applies a name-personalized spintax signature to{" "}
              <strong className="text-foreground">
                {formatNumber(namedInboxes)} inboxes
              </strong>
              . This overwrites their current signature.
            </p>
            <div className="flex items-center gap-2">
              {applying && (
                <button type="button" className="pv-btn-ghost" onClick={abortApply}>
                  Abort
                </button>
              )}
              <button
                type="button"
                className="pv-btn-primary"
                onClick={handleApply}
                disabled={!canApply || applying}
              >
                {applying ? <Spinner /> : <PenIcon size={16} />}
                {applying
                  ? "Applying…"
                  : `Apply to ${formatNumber(namedInboxes)} inboxes`}
              </button>
            </div>
          </div>

          {(applying || applied) && (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {applied ? "Done" : "Applying signatures…"}
                </span>
                <span className="tabular-nums">
                  {applyProgress.done} / {applyProgress.total} people
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{
                    width: `${
                      applyProgress.total > 0
                        ? Math.round((applyProgress.done / applyProgress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              {(applied || results.errors > 0) && (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Inboxes updated" value={results.inboxesDone} />
                  <Metric label="People" value={results.peopleDone} />
                  <Metric label="Skipped (no name)" value={skippedNoName} />
                  <Metric
                    label="Errors"
                    value={results.errors}
                    danger={results.errors > 0}
                  />
                </div>
              )}
              {results.errorRows.length > 0 && (
                <div className="pv-scroll mt-3 max-h-40 overflow-y-auto rounded-xl border border-border text-xs">
                  {results.errorRows.map((r) => (
                    <div
                      key={r.key}
                      className="flex justify-between gap-3 border-b border-border/70 px-3 py-2 last:border-0"
                    >
                      <span className="font-medium">
                        {r.first} {r.last}
                      </span>
                      <span className="text-danger">{r.error}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {children}
    </div>
  );
}

function SlotGroup({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const filled = values.filter((v) => v.trim()).length;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          {label}{" "}
          <span className="text-muted-foreground/70">
            ({filled}/{values.length}
            {hint ? ` · ${hint}` : ""})
          </span>
        </label>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {values.map((v, i) => (
          <input
            key={i}
            className="pv-input"
            placeholder={i === 0 ? placeholder : `${placeholder} (alt ${i})`}
            value={v}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div>
      <div
        className={`text-lg font-semibold tabular-nums ${
          danger ? "text-danger" : "text-foreground"
        }`}
      >
        {formatNumber(value)}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateRow(
  setRows: React.Dispatch<React.SetStateAction<ApplyRow[]>>,
  key: string,
  patch: Partial<ApplyRow>
) {
  setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
}

function summarize(rows: ApplyRow[]) {
  let inboxesDone = 0;
  let peopleDone = 0;
  let errors = 0;
  const errorRows: ApplyRow[] = [];
  for (const r of rows) {
    if (r.status === "done") {
      peopleDone += 1;
      inboxesDone += r.ids.length;
    } else if (r.status === "error") {
      errors += 1;
      errorRows.push(r);
    }
  }
  return { inboxesDone, peopleDone, errors, errorRows };
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
