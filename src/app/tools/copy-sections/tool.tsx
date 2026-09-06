"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary, CampaignDetail } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  fetchCampaign,
  editCopySections,
  ApiClientError,
  type CopySectionsResponse,
} from "@/lib/api-client";
import type { CopyEdit, ReplaceTarget, Section } from "@/lib/copy-sections/edit";
import { validateEdit } from "@/lib/copy-sections/edit";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  PenIcon,
  RefreshIcon,
} from "@/components/icons";

// One edit, every variation of one step. The preview is the whole point: it
// shows exactly which variations change and which don't (and why), before a
// single byte is written — because the write replaces the step's copy
// wholesale and there is no undo in Plusvibe.

type Bucket = "active" | "draft" | "paused" | "completed" | "archived";
function statusBucket(status: string): Bucket {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "RUNNING") return "active";
  if (s === "PAUSED") return "paused";
  if (s === "COMPLETED") return "completed";
  if (s === "ARCHIVED") return "archived";
  return "draft";
}
const BUCKET_LABEL: Record<Bucket, string> = {
  active: "Active",
  draft: "Draft",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

type Mode = "replace" | "section";

export function CopySectionsTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [campaignId, setCampaignId] = useState("");

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [step, setStep] = useState<number | null>(null);

  const [mode, setMode] = useState<Mode>("replace");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [target, setTarget] = useState<ReplaceTarget>("both");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [section, setSection] = useState<Section>("opening");
  const [sectionText, setSectionText] = useState("");
  const [asHtml, setAsHtml] = useState(false);

  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CopySectionsResponse | null>(null);
  const [previewFor, setPreviewFor] = useState("");
  const [result, setResult] = useState<CopySectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lock = useRef(false);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      setWorkspaceId((prev) => prev || list[0]?._id || "");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Campaigns (parents and sub-sequences) --------------------------------
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setCampaignsLoading(true);
    setCampaigns(null);
    setCampaignId("");
    setDetail(null);
    setStep(null);
    setPreview(null);
    setResult(null);
    fetchCampaigns({ workspace_id: workspaceId, campaign_type: "all" })
      .then((res) => {
        if (!cancelled) setCampaigns(res.campaigns ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setCampaignsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Sub-sequences listed under their parent, so the picker reads as a tree.
  const ordered = useMemo(() => {
    const all = campaigns ?? [];
    const parents = all.filter((c) => c.campaignType !== "subseq");
    const subs = all.filter((c) => c.campaignType === "subseq");
    const out: { c: CampaignSummary; sub: boolean }[] = [];
    const byParent = new Map<string, CampaignSummary[]>();
    for (const s of subs) {
      const list = byParent.get(s.parentCampId ?? "") ?? [];
      list.push(s);
      byParent.set(s.parentCampId ?? "", list);
    }
    for (const p of parents) {
      out.push({ c: p, sub: false });
      for (const s of byParent.get(p.id) ?? []) out.push({ c: s, sub: true });
      byParent.delete(p.id);
    }
    // Orphans (parent hidden or missing) still show, un-nested.
    for (const list of byParent.values()) for (const s of list) out.push({ c: s, sub: true });
    return out;
  }, [campaigns]);

  const visible = useMemo(
    () =>
      showAll
        ? ordered
        : ordered.filter(({ c }) => {
            const b = statusBucket(c.status);
            return b === "active" || b === "draft" || b === "paused";
          }),
    [ordered, showAll]
  );

  // --- Campaign detail ---------------------------------------------------------
  const loadDetail = useCallback(async () => {
    if (!workspaceId || !campaignId) return;
    setDetailLoading(true);
    setError(null);
    // The preview describes copy that may just have changed, so it goes; the
    // result of an apply stays — reloading is what apply does last, and the
    // person still wants to see what it did.
    setPreview(null);
    try {
      const d = await fetchCampaign({ workspace_id: workspaceId, campaign_id: campaignId });
      setDetail(d);
      setStep((prev) => (prev && d.steps.some((s) => s.step === prev) ? prev : d.steps[0]?.step ?? null));
    } catch (err) {
      setError(errMessage(err));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [workspaceId, campaignId]);

  useEffect(() => {
    if (campaignId) void loadDetail();
    else setDetail(null);
  }, [campaignId, loadDetail]);

  const activeStep = detail?.steps.find((s) => s.step === step) ?? null;

  const edit: CopyEdit =
    mode === "replace"
      ? { kind: "replace-text", find, replace, target, caseSensitive }
      : { kind: "set-section", section, text: sectionText, asHtml: section !== "subject" && asHtml };
  const problems = step
    ? validateEdit(edit, step, { subsequence: detail?.campaignType === "subseq" })
    : [];
  const fingerprint = JSON.stringify([campaignId, step, edit]);
  const previewStale = preview !== null && previewFor !== fingerprint;
  const canPreview = !!activeStep && problems.length === 0 && !busy;
  const canApply = canPreview && preview !== null && !previewStale && preview.changed > 0;

  async function runPreview() {
    if (!canPreview || !activeStep || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await editCopySections({
        workspace_id: workspaceId,
        campaign_id: campaignId,
        step: activeStep.step,
        edit,
        dryRun: true,
      });
      setPreview(r);
      setPreviewFor(fingerprint);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function apply() {
    if (!canApply || !activeStep || !preview || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await editCopySections({
        workspace_id: workspaceId,
        campaign_id: campaignId,
        step: activeStep.step,
        edit,
        expectedVariationCount: preview.total,
      });
      setResult(r);
      setPreview(null);
      setToast(
        r.verified
          ? `Updated ${formatNumber(r.changed)} of ${formatNumber(r.total)} variations on step ${r.step}.`
          : `Written, but ${r.unverified.length} variation(s) didn't read back as expected — check them in Plusvibe.`
      );
      await loadDetail();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  const shown = result ?? preview;

  return (
    <div className="space-y-5">
      {/* Workspace + campaign */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1.5 block text-sm font-medium">Workspace</label>
            <Select value={workspaceId} disabled={workspacesLoading || workspaces.length === 0} onChange={setWorkspaceId}>
              {workspacesLoading && <option>Loading…</option>}
              {!workspacesLoading &&
                workspaces.map((w) => (
                  <option key={w._id} value={w._id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          </div>
          <div className="min-w-[240px] flex-[1.4]">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="block text-sm font-medium">Campaign</label>
              {campaignsLoading && <Spinner size={12} />}
            </div>
            <Select value={campaignId} disabled={campaignsLoading || visible.length === 0} onChange={setCampaignId}>
              <option value="">
                {campaignsLoading ? "Loading campaigns…" : visible.length === 0 ? "No campaigns" : "Select a campaign…"}
              </option>
              {visible.map(({ c, sub }) => (
                <option key={c.id} value={c.id}>
                  {sub ? "↳ " : ""}
                  {c.name} — {BUCKET_LABEL[statusBucket(c.status)]}
                  {sub ? " · sub-sequence" : ""}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show completed and archived campaigns too
          </label>
          <button type="button" className="pv-btn-ghost text-xs" onClick={loadDetail} disabled={!campaignId || detailLoading}>
            {detailLoading ? <Spinner size={14} /> : <RefreshIcon size={14} />}
            Reload campaign
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {detailLoading && (
        <div className="pv-card flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <Spinner size={14} /> Loading campaign sequence…
        </div>
      )}

      {detail && !detailLoading && (
        <>
          {detail.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}

          {detail.steps.length > 0 && (
            <div className="pv-card space-y-4 p-4 sm:p-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Step</label>
                <div className="flex flex-wrap gap-2">
                  {detail.steps.map((s) => (
                    <button
                      key={s.step}
                      type="button"
                      onClick={() => {
                        setStep(s.step);
                        setPreview(null);
                        setResult(null);
                      }}
                      className={`rounded-xl border px-3 py-2 text-left text-sm transition ${
                        s.step === step ? "border-accent bg-accent/10" : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <div className="font-medium">Step {s.step}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(s.variations.length)} variation{s.variations.length === 1 ? "" : "s"}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {activeStep && (
                <>
                  {/* Mode */}
                  <div className="flex flex-wrap gap-2">
                    <ModeChip active={mode === "replace"} onClick={() => setMode("replace")}>
                      Find &amp; replace text
                    </ModeChip>
                    <ModeChip active={mode === "section"} onClick={() => setMode("section")}>
                      Replace a whole section
                    </ModeChip>
                  </div>

                  {mode === "replace" ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Find</label>
                          <textarea
                            className="pv-input min-h-[72px] font-mono text-sm"
                            placeholder="e.g. Hope you're doing well  —  or  {{company_name}}"
                            value={find}
                            onChange={(e) => setFind(e.target.value)}
                            spellCheck={false}
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Replace with</label>
                          <textarea
                            className="pv-input min-h-[72px] font-mono text-sm"
                            placeholder="Leave empty to delete the text"
                            value={replace}
                            onChange={(e) => setReplace(e.target.value)}
                            spellCheck={false}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <span className="text-muted-foreground">Look in</span>
                        {(["both", "body", "subject"] as ReplaceTarget[]).map((t) => (
                          <ModeChip key={t} active={target === t} onClick={() => setTarget(t)} small>
                            {t === "both" ? "subject and body" : t}
                          </ModeChip>
                        ))}
                        <label className="ml-2 flex items-center gap-1.5 text-muted-foreground">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
                          Match case
                        </label>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Matching ignores the HTML behind the text — extra spaces, <span className="font-mono">&amp;nbsp;</span>,
                        an apostrophe stored as <span className="font-mono">&amp;#39;</span>, bold or a link around a word.
                        A match never crosses a paragraph or line break. Variables like{" "}
                        <span className="font-mono">{"{{first_name}}"}</span> are matched and written literally.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Section</span>
                        {(["subject", "opening", "closing"] as Section[]).map((s) => (
                          <ModeChip key={s} active={section === s} onClick={() => setSection(s)} small>
                            {s === "subject" ? "subject line" : s === "opening" ? "opening paragraph" : "closing paragraph / sign-off"}
                          </ModeChip>
                        ))}
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                          {section === "subject" ? "New subject line — every variation gets this" : "New paragraph text — every variation gets this"}
                        </label>
                        <textarea
                          className="pv-input min-h-[96px] font-mono text-sm"
                          placeholder={
                            section === "subject"
                              ? "{{Random | Quick question | Idea for {{company_name}}}}"
                              : section === "opening"
                                ? "Hi {{first_name}}, noticed {{company_name}} is hiring…"
                                : "Thanks,\n{{sender_first_name}}"
                          }
                          value={sectionText}
                          onChange={(e) => setSectionText(e.target.value)}
                          spellCheck={false}
                        />
                      </div>
                      {section !== "subject" && (
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={asHtml} onChange={(e) => setAsHtml(e.target.checked)} />
                          Text is HTML — use it as written
                        </label>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        A paragraph is a block of lines with a blank line before and after it, so a sign-off written as
                        &quot;Thanks,&quot; then your name on the next line counts as one. Each line you type becomes its
                        own line; a blank line becomes a blank line.
                      </p>
                    </div>
                  )}

                  {problems.length > 0 && (find || sectionText) && (
                    <div className="space-y-1">
                      {problems.map((p, i) => (
                        <p key={i} className="flex gap-1.5 text-xs text-warning">
                          <AlertIcon size={13} className="mt-0.5 shrink-0" />
                          <span>{p}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <button type="button" className="pv-btn-ghost disabled:opacity-50" disabled={!canPreview} onClick={runPreview}>
                      {busy && !preview ? <Spinner /> : <RefreshIcon size={16} />}
                      Preview
                    </button>
                    <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canApply} onClick={apply}>
                      {busy && preview ? <Spinner /> : <PenIcon size={16} />}
                      {preview && !previewStale
                        ? `Apply to ${formatNumber(preview.changed)} of ${formatNumber(preview.total)} variations`
                        : "Apply"}
                    </button>
                    {preview === null && !busy && (
                      <span className="text-xs text-muted-foreground">Preview first — Apply is enabled once you have.</span>
                    )}
                    {previewStale && (
                      <span className="flex gap-1.5 text-xs text-warning">
                        <AlertIcon size={13} className="mt-0.5 shrink-0" />
                        The edit changed since the preview. Preview again.
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {shown && <ResultCard r={shown} stale={previewStale && !result} />}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="pv-card flex items-center gap-3 border-success/40 px-4 py-3 shadow-card">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckIcon size={16} />
            </span>
            <span className="text-sm font-medium">{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({ r, stale }: { r: CopySectionsResponse; stale: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(true);
  const rows = showUnchanged ? r.results : r.results.filter((x) => x.changed);
  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {r.dryRun ? "Preview" : r.verified ? "Done" : "Written — check needed"}
          <span className="ml-1.5 font-normal text-muted-foreground">
            · step {r.step} · {formatNumber(r.changed)} of {formatNumber(r.total)} variation{r.total === 1 ? "" : "s"}{" "}
            {r.dryRun ? "would change" : "changed"}
          </span>
        </h2>
        {r.dryRun ? (
          <span className="text-xs text-muted-foreground">Nothing has been written yet.</span>
        ) : (
          <span className={`text-xs ${r.verified ? "text-success" : "text-warning"}`}>
            {r.verified ? "Read back from Plusvibe and confirmed." : `Not confirmed for ${r.unverified.join(", ")}.`}
          </span>
        )}
      </div>
      {stale && (
        <p className="mt-2 flex gap-1.5 text-xs text-warning">
          <AlertIcon size={13} className="mt-0.5 shrink-0" /> The edit changed since this preview.
        </p>
      )}
      {r.dryRun && r.changed < r.total && (
        <p className="mt-2 text-xs text-muted-foreground">
          {formatNumber(r.total - r.changed)} variation{r.total - r.changed === 1 ? "" : "s"} would be left as-is — the
          reason is shown on each. They are written back unchanged.
        </p>
      )}
      <label className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
        Show unchanged variations
      </label>
      <div className="pv-scroll mt-3 max-h-[32rem] overflow-y-auto rounded-xl border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="w-12 px-3 py-2 font-medium">Var.</th>
              <th className="px-3 py-2 font-medium">Before</th>
              <th className="px-3 py-2 font-medium">After</th>
              <th className="w-28 px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.variation} className={`border-b border-border/70 align-top last:border-0 ${x.changed ? "" : "opacity-60"}`}>
                <td className="px-3 py-2 font-mono">{x.variation}</td>
                <td className="px-3 py-2">
                  {x.subjectBefore !== x.subjectAfter && <div className="mb-1 font-mono text-[11px]">{x.subjectBefore || "(no subject)"}</div>}
                  <div className="whitespace-pre-wrap">{x.textBefore}</div>
                </td>
                <td className="px-3 py-2">
                  {x.subjectBefore !== x.subjectAfter && <div className="mb-1 font-mono text-[11px] text-success">{x.subjectAfter || "(no subject)"}</div>}
                  <div className={`whitespace-pre-wrap ${x.changed ? "" : "text-muted-foreground"}`}>{x.changed ? x.textAfter : "—"}</div>
                  <button type="button" className="mt-1 text-[11px] text-muted-foreground underline" onClick={() => setOpen(open === x.variation ? null : x.variation)}>
                    {open === x.variation ? "hide full email" : "full email"}
                  </button>
                  {open === x.variation && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div className="rounded-lg border border-border bg-muted/40 p-2 text-[11px] leading-5" dangerouslySetInnerHTML={{ __html: x.bodyBefore }} />
                      <div className="rounded-lg border border-success/40 bg-muted/40 p-2 text-[11px] leading-5" dangerouslySetInnerHTML={{ __html: x.bodyAfter }} />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {x.changed ? (
                    <span className="text-success">
                      {r.dryRun ? "will change" : "changed"}
                      {x.bodyMatches + x.subjectMatches > 0 && ` · ${x.bodyMatches + x.subjectMatches} match${x.bodyMatches + x.subjectMatches === 1 ? "" : "es"}`}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{x.reason ?? "unchanged"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModeChip({ active, onClick, small, children }: { active: boolean; onClick: () => void; small?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${small ? "pv-chip" : "rounded-xl border px-3 py-2 text-sm"} ${
        active ? (small ? "pv-chip-active" : "border-accent bg-accent/10 font-medium") : small ? "hover:text-foreground" : "border-border hover:bg-muted/50"
      }`}
    >
      {children}
    </button>
  );
}

function Select({ value, disabled, onChange, children }: { value: string; disabled?: boolean; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <select className="pv-input appearance-none pr-9" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function errMessage(err: unknown): string {
  return err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "Something went wrong";
}
