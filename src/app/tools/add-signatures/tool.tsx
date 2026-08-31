"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchAccounts,
  fetchTags,
  bulkUpdateSignature,
  ApiClientError,
  fetchSignaturePreset,
  saveSignaturePreset,
  deleteSignaturePreset,
  type SignaturePreset,
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
import {
  UNTAGGED,
  countByTag,
  groupInboxes,
  type InboxLike,
} from "./filter";
import type { ApplyRow, SignatureFields } from "./types";

const COMPANY_SLOTS = 3;
const PHONE_SLOTS = 5;
const ADDRESS_SLOTS = 3;
const TITLE_SLOTS = 5;

// Default pool of roles; the 5 title slots start pre-filled with a random 5.
const DEFAULT_ROLES = [
  "Account Executive",
  "Key Account Executive",
  "Growth Manager",
  "Business Development",
  "Head of Growth",
  "Growth Director",
  "Growth Lead",
  "Head of Business Development",
  "BDR Manager",
  "BDR",
  "Business Development Representative",
  "Partnerships Manager",
];

function pickRandomRoles(n: number): string[] {
  const pool = [...DEFAULT_ROLES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n);
  while (picked.length < n) picked.push("");
  return picked;
}

export function AddSignaturesTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [titles, setTitles] = useState<string[]>(Array(TITLE_SLOTS).fill(""));
  const [companies, setCompanies] = useState<string[]>(
    Array(COMPANY_SLOTS).fill("")
  );
  const [phones, setPhones] = useState<string[]>(Array(PHONE_SLOTS).fill(""));
  const [addresses, setAddresses] = useState<string[]>(
    Array(ADDRESS_SLOTS).fill("")
  );

  const [loadingInboxes, setLoadingInboxes] = useState(false);
  // The workspace's inboxes as loaded, unfiltered. The tag filter is applied
  // over these rather than by re-fetching, so switching tags is instant and the
  // per-tag counts below are the real ones.
  const [inboxes, setInboxes] = useState<InboxLike[]>([]);
  const [masterTagIds, setMasterTagIds] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [loadedForWs, setLoadedForWs] = useState<string | null>(null);
  const [toast, setToast] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);

  const [applying, setApplying] = useState(false);
  const [applyRows, setApplyRows] = useState<ApplyRow[]>([]);
  const [applyProgress, setApplyProgress] = useState({ done: 0, total: 0 });
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // What was last used for this workspace, so adding signatures to its new
  // inboxes doesn't mean retyping the client's details every time.
  const [preset, setPreset] = useState<SignaturePreset | null>(null);
  const [presetLoading, setPresetLoading] = useState(false);
  const [presetSaved, setPresetSaved] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fields: SignatureFields = useMemo(
    () => ({ titles, companies, phones, addresses }),
    [titles, companies, phones, addresses]
  );

  // Seed the role slots with a random 5 of the default pool on mount (client
  // only, so no SSR/hydration mismatch).
  useEffect(() => {
    setTitles(pickRandomRoles(TITLE_SLOTS));
  }, []);

  // Auto-dismiss the completion toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

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

  /** Spreads saved values back across the fixed slots, padding the rest. */
  const applyPreset = useCallback((p: SignaturePreset) => {
    const pad = (values: string[], slots: number) =>
      Array.from({ length: slots }, (_, i) => values[i] ?? "");
    // Only fields the preset actually has are restored; an empty one leaves
    // the randomised role slots alone rather than blanking them.
    if (p.titles.length) setTitles(pad(p.titles, TITLE_SLOTS));
    if (p.companies.length) setCompanies(pad(p.companies, COMPANY_SLOTS));
    if (p.phones.length) setPhones(pad(p.phones, PHONE_SLOTS));
    if (p.addresses.length) setAddresses(pad(p.addresses, ADDRESS_SLOTS));
  }, []);

  // Restore the workspace's remembered details when it's selected.
  useEffect(() => {
    if (!ready || !hasKey || !workspaceId) return;
    let cancelled = false;
    setPresetLoading(true);
    setPresetSaved(false);
    void (async () => {
      try {
        const { preset: found } = await fetchSignaturePreset(workspaceId);
        if (cancelled) return;
        setPreset(found);
        if (found) applyPreset(found);
      } catch {
        // Remembering is a convenience; failing to read it must not stop the
        // tool being used with details typed in by hand.
        if (!cancelled) setPreset(null);
      } finally {
        if (!cancelled) setPresetLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, hasKey, workspaceId, applyPreset]);

  // --- Load inboxes for the selected workspace -----------------------------
  async function loadInboxes() {
    if (!workspaceId) return;
    setLoadingInboxes(true);
    setError(null);
    setApplied(false);
    setApplyRows([]);
    try {
      const [accountsRes, tagsRes] = await Promise.all([
        fetchAccounts({ workspace_id: workspaceId }),
        fetchTags({ workspace_id: workspaceId }).catch(() => ({ tags: [] })),
      ]);
      const accounts = accountsRes.accounts ?? [];
      const allTags = tagsRes.tags ?? [];
      // Tag IDs named "Master Inbox" — those inboxes are always excluded, and
      // the tag is not offered as a filter since it can never select anything.
      const masters = new Set(
        allTags
          .filter((t) => t.name.trim().toLowerCase() === "master inbox")
          .map((t) => t.id)
      );

      setInboxes(accounts);
      setMasterTagIds(masters);
      setTags(allTags.filter((t) => !masters.has(t.id)));
      setLoadedForWs(workspaceId);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoadingInboxes(false);
    }
  }

  // --- Derived preview -----------------------------------------------------
  // Re-derived whenever the tag filter changes, so the counts, the preview and
  // the Apply button always describe the same set of inboxes.
  const result = useMemo(
    () => groupInboxes(inboxes, { masterTagIds, tagFilter }),
    [inboxes, masterTagIds, tagFilter]
  );
  const groups = result.groups;
  const namedInboxes = result.matched;
  const skippedNoName = result.skippedNoName;
  const excludedMaster = result.excludedMaster;

  const counts = useMemo(
    () => countByTag(inboxes, masterTagIds),
    [inboxes, masterTagIds]
  );

  function toggleTag(id: string) {
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // The previous run's rows describe a different set of inboxes now.
    setApplyRows([]);
    setApplied(false);
  }

  const hasTitle = titles.some((t) => t.trim());
  const hasCompany = companies.some((c) => c.trim());
  const canApply =
    hasTitle &&
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
    if (!hasTitle || !hasCompany) return null;
    const built = buildSignature(fields, sample.first, sample.last);
    if (!built) return null;
    const blocks = generateBlocks(fields, nameFormsFor(sample.first, sample.last));
    return { count: built.count, signature: built.signature, blocks };
  }, [fields, sample, hasTitle, hasCompany]);

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
    setToast(null);
    requestNotifyPermission();

    let okInboxes = 0;
    let errCount = 0;

    try {
      await mapPool(
        groups,
        async (group) => {
          updateRow(setApplyRows, group.key, { status: "running" });
          const built = buildSignature(fields, group.first, group.last);
          if (!built) {
            errCount += 1;
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
              okInboxes += group.ids.length;
              updateRow(setApplyRows, group.key, {
                status: "done",
                variations: built.count,
              });
            } catch (err) {
              if (isAbort(err)) throw err;
              errCount += 1;
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

      // Saved after the apply rather than as you type: this is the moment the
      // details are known to be the ones actually used for this client.
      try {
        const { preset: saved } = await saveSignaturePreset({
          workspaceId,
          titles,
          companies,
          phones,
          addresses,
        });
        setPreset(saved);
        setPresetSaved(true);
      } catch {
        // Not worth failing the run over — the signatures are already applied.
      }
      const message =
        errCount > 0
          ? `Signatures applied to ${formatNumber(okInboxes)} inboxes · ${formatNumber(
              errCount
            )} failed`
          : `Signatures applied to ${formatNumber(okInboxes)} inboxes 🎉`;
      setToast({ kind: errCount > 0 ? "error" : "success", message });
      showNotification("Add Signatures — done", message);
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
                setInboxes([]);
                setTags([]);
                // Tag ids are workspace-specific, so carrying a selection over
                // would filter the next workspace by ids it has never heard of.
                setTagFilter(new Set());
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

        <SlotGroup
          label="Job titles / roles"
          hint="At least one required"
          values={titles}
          onChange={setTitles}
          placeholder="Account Executive"
          headerAction={
            <button
              type="button"
              className="pv-chip"
              onClick={() => setTitles(pickRandomRoles(TITLE_SLOTS))}
            >
              <RefreshIcon size={13} />
              Shuffle
            </button>
          }
        />

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

        {/* Whether these details came back from a previous run */}
        {(presetLoading || preset) && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
            {presetLoading ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size={13} />
                Checking for saved details…
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-success">
                <CheckIcon size={13} />
                {presetSaved
                  ? "Saved for this workspace — next time these fill in automatically."
                  : `Filled in from the last run for this workspace${
                      preset?.savedAt ? ` · ${relativeDay(preset.savedAt)}` : ""
                    }.`}
              </span>
            )}
            {preset && !presetLoading && (
              <button
                type="button"
                className="pv-btn-ghost text-xs"
                onClick={async () => {
                  try {
                    await deleteSignaturePreset(workspaceId);
                    setPreset(null);
                    setPresetSaved(false);
                  } catch (err) {
                    setError(errMessage(err));
                  }
                }}
              >
                Forget these
              </button>
            )}
          </div>
        )}

        {/* Tag filter — the whole workspace unless you narrow it */}
        {loadedForWs === workspaceId && inboxes.length > 0 && (
          <div className="border-t border-border pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Filter by tag{" "}
                <span className="text-muted-foreground/70">
                  {tagFilter.size === 0
                    ? "(all inboxes)"
                    : `(${formatNumber(tagFilter.size)} selected · any of them)`}
                </span>
              </span>
              {tagFilter.size > 0 && (
                <button
                  type="button"
                  className="pv-btn-ghost text-xs"
                  onClick={() => {
                    setTagFilter(new Set());
                    setApplyRows([]);
                    setApplied(false);
                  }}
                >
                  Clear filter
                </button>
              )}
            </div>
            {tags.length === 0 && counts.untagged === 0 ? (
              <p className="text-xs text-muted-foreground">
                This workspace has no tags, so every inbox is included.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTagFilter(new Set());
                      setApplyRows([]);
                      setApplied(false);
                    }}
                    className={`pv-chip ${
                      tagFilter.size === 0 ? "pv-chip-active" : "hover:text-foreground"
                    }`}
                  >
                    All inboxes
                    <span className="tabular-nums opacity-70">
                      {formatNumber(counts.eligible)}
                    </span>
                  </button>
                  {tags.map((t) => {
                    const n = counts.byTag.get(t.id) ?? 0;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggleTag(t.id)}
                        disabled={n === 0}
                        className={`pv-chip ${
                          tagFilter.has(t.id)
                            ? "pv-chip-active"
                            : n === 0
                              ? "opacity-40"
                              : "hover:text-foreground"
                        }`}
                        title={n === 0 ? "No inboxes carry this tag" : undefined}
                      >
                        {t.name}
                        <span className="tabular-nums opacity-70">
                          {formatNumber(n)}
                        </span>
                      </button>
                    );
                  })}
                  {counts.untagged > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleTag(UNTAGGED)}
                      className={`pv-chip ${
                        tagFilter.has(UNTAGGED)
                          ? "pv-chip-active"
                          : "hover:text-foreground"
                      }`}
                    >
                      No tags
                      <span className="tabular-nums opacity-70">
                        {formatNumber(counts.untagged)}
                      </span>
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Each number is what that tag would actually update — Master
                  Inboxes and inboxes with no first name are already left out.
                  Picking more than one tag includes an inbox carrying{" "}
                  <strong className="font-medium">any</strong> of them, so the
                  numbers can overlap rather than add up.
                </p>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            {loadedForWs === workspaceId && inboxes.length > 0
              ? `${formatNumber(namedInboxes)} inboxes · ${formatNumber(
                  groups.length
                )} people${
                  result.filteredOut
                    ? ` · ${formatNumber(result.filteredOut)} filtered out by tag`
                    : ""
                }${
                  excludedMaster
                    ? ` · ${formatNumber(excludedMaster)} Master Inbox excluded`
                    : ""
                }${
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

      {/* A filter that matches nothing would otherwise just make the Apply card
          vanish, which reads as something being broken. */}
      {loadedForWs === workspaceId &&
        inboxes.length > 0 &&
        groups.length === 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>
              {tagFilter.size > 0
                ? "No inboxes match the selected tags. Clear the filter or pick a different tag."
                : "No inboxes in this workspace carry a first name, so none can be personalized."}
            </span>
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
              {tagFilter.size > 0 ? (
                <>
                  {" "}
                  tagged{" "}
                  <strong className="text-foreground">
                    {selectedTagNames(tags, tagFilter).join(" or ")}
                  </strong>
                </>
              ) : (
                <> — the whole workspace</>
              )}
              . This overwrites their current signature.
            </p>
            <div className="flex items-center gap-2">
              {applying && (
                <button type="button" className="pv-btn-ghost" onClick={abortApply}>
                  Stop task
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

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Names for the selected tag ids, so the Apply card can say what it's hitting. */
function selectedTagNames(
  tags: { id: string; name: string }[],
  filter: ReadonlySet<string>
): string[] {
  const names = tags.filter((t) => filter.has(t.id)).map((t) => t.name);
  if (filter.has(UNTAGGED)) names.push("no tags");
  return names;
}

function Toast({
  toast,
  onClose,
}: {
  toast: { kind: "success" | "error"; message: string };
  onClose: () => void;
}) {
  const ok = toast.kind === "success";
  return (
    <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
      <div
        className={`pv-card flex items-center gap-3 px-4 py-3 shadow-card ${
          ok ? "border-success/40" : "border-danger/40"
        }`}
      >
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full ${
            ok ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
          }`}
        >
          {ok ? <CheckIcon size={16} /> : <AlertIcon size={16} />}
        </span>
        <span className="text-sm font-medium">{toast.message}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-1 text-muted-foreground hover:text-foreground"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function SlotGroup({
  label,
  hint,
  values,
  onChange,
  placeholder,
  headerAction,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  headerAction?: React.ReactNode;
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
        {headerAction}
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

// Best-effort desktop notifications so a long apply can ping you if you've
// tabbed away. Requested when the apply starts, shown on completion.
function requestNotifyPermission() {
  try {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission();
    }
  } catch {
    // notifications unsupported / blocked — ignore
  }
}

function showNotification(title: string, body: string) {
  try {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      new Notification(title, { body });
    }
  } catch {
    // ignore
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

/** "today" / "3 days ago" — enough context for a remembered preset. */
function relativeDay(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "saved today";
  if (days === 1) return "saved yesterday";
  if (days < 30) return `saved ${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "saved a month ago" : `saved ${months} months ago`;
}
