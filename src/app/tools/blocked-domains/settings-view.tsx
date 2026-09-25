"use client";

// The Settings tab: how Clay reaches the automation, whether blocked inboxes
// are deleted without asking, and the rules they are judged on — which can be
// changed here.

import { useEffect, useMemo, useState } from "react";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";
import {
  DEFAULT_RULES,
  JUDGE_WINDOW_DAYS,
  MAX_TIERS,
  coverageNotes,
  validateRules,
  type InboxRules,
} from "@/lib/blocked-inboxes/rules";
import { blockedInboxAction, setBlockedDomainSettings } from "@/lib/api-client";
import { copyToClipboard } from "@/lib/clipboard";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, ChevronDownIcon, CopyIcon, FireIcon, GaugeIcon, TrashIcon } from "@/components/icons";

type Side = "microsoft" | "google";
/**
 * A tier as the form holds it: numbers as typed. Each tier is its own range —
 * `to` empty for "and up", equal to `min` for a single count — and the rows
 * are tried top to bottom.
 */
interface DraftTier {
  /** Exactly one send count, a range, or a start and everything above it. */
  mode: RangeMode;
  min: string;
  /** Only read for a range. */
  to: string;
  maxBounceRate: string;
  minOooReplyRate: string;
  humanReplyOverrule: string;
}
type Draft = Record<Side, DraftTier[]>;
type RangeMode = "exact" | "range" | "up";
const MODES: { id: RangeMode; label: string }[] = [
  { id: "exact", label: "Exactly" },
  { id: "range", label: "From–to" },
  { id: "up", label: "And up" },
];
/** The "to" a tier actually has: its own for a range, "from" when exact, none for "and up". */
const effectiveTo = (t: DraftTier) => (t.mode === "exact" ? t.min : t.mode === "up" ? "" : t.to);

const str = (n: number | undefined | null) => (n === undefined || n === null ? "" : String(n));
const draftSide = (tiers: InboxRules["microsoft"]): DraftTier[] =>
  tiers.map((t) => ({
    mode: t.max === null ? "up" : t.max === t.min ? "exact" : "range",
    min: str(t.min),
    to: str(t.max),
    maxBounceRate: str(t.maxBounceRate),
    minOooReplyRate: str(t.minOooReplyRate),
    humanReplyOverrule: str(t.humanReplyOverrule),
  }));
const toDraft = (r: InboxRules): Draft => ({ microsoft: draftSide(r.microsoft), google: draftSide(r.google) });
/** What is sent: empty optional fields left out, so "not checked" stays that. */
const fromDraft = (d: Draft) => {
  const side = (tiers: DraftTier[]) =>
    tiers.map((t) => ({
      min: t.min,
      // Always sent, so the server reads each tier as its own range.
      // A range with its "to" left empty is still asked for one, not
      // quietly turned into "and up".
      max: t.mode === "up" ? null : t.mode === "exact" ? t.min : t.to.trim() === "" ? "missing" : t.to,
      maxBounceRate: t.maxBounceRate,
      ...(t.minOooReplyRate.trim() ? { minOooReplyRate: t.minOooReplyRate } : {}),
      ...(t.humanReplyOverrule.trim() ? { humanReplyOverrule: t.humanReplyOverrule } : {}),
    }));
  return { microsoft: side(d.microsoft), google: side(d.google) };
};
const same = (a: InboxRules, b: InboxRules) => JSON.stringify(a) === JSON.stringify(b);

export function SettingsView({
  view,
  onChanged,
  onError,
}: {
  view: BlockedDomainsView | null;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const saved = view?.settings.inboxRules ?? DEFAULT_RULES;
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkEmail, setCheckEmail] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [blockDomain, setBlockDomain] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [blockNote, setBlockNote] = useState<string | null>(null);

  // Follow what the server holds until someone starts editing.
  useEffect(() => {
    if (!touched) setDraft(toDraft(saved));
  }, [saved, touched]);

  const checked = useMemo(() => validateRules(fromDraft(draft)), [draft]);
  const notes = useMemo(
    () =>
      checked.rules
        ? { microsoft: coverageNotes(checked.rules.microsoft, "Microsoft"), google: coverageNotes(checked.rules.google, "Google") }
        : { microsoft: [], google: [] },
    [checked]
  );
  const dirty = !!checked.rules && !same(checked.rules, saved);
  const isDefault = !!checked.rules && same(checked.rules, DEFAULT_RULES);

  const url = typeof window !== "undefined" ? `${window.location.origin}/api/hooks/blocked-domain` : "/api/hooks/blocked-domain";
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

  const change = (side: Side, fn: (tiers: DraftTier[]) => DraftTier[]) => {
    setTouched(true);
    setSavedNote(false);
    setDraft((d) => ({ ...d, [side]: fn(d[side].map((t) => ({ ...t }))) }));
  };
  const edit = (side: Side, i: number, key: keyof DraftTier, value: string) =>
    change(side, (tiers) => {
      const t = tiers[i];
      if (key === "mode") {
        t.mode = value as RangeMode;
        // Turning a single count into a range starts it as that count to itself.
        if (t.mode === "range" && t.to.trim() === "") t.to = t.min;
      } else {
        t[key] = value;
      }
      return tiers;
    });
  // A new tier starts where the covered sends end, or empty to fill in; its
  // rule is copied from the tier it lands below. Move it where it belongs.
  const addTier = (side: Side) =>
    change(side, (tiers) => {
      const last = tiers[tiers.length - 1];
      // A new tier is one exact send count to fill in, placed at the bottom;
      // switch it to a range or "and up", and move it where it belongs.
      return [
        ...tiers,
        {
          mode: "exact",
          min: "",
          to: "",
          maxBounceRate: last?.maxBounceRate ?? "10",
          minOooReplyRate: last?.minOooReplyRate ?? "",
          humanReplyOverrule: last?.humanReplyOverrule ?? "",
        },
      ];
    });
  const removeTier = (side: Side, i: number) => change(side, (tiers) => tiers.filter((_, j) => j !== i));
  // Moving a tier moves all of it — its range and its rule. Order is what
  // decides between two tiers that cover the same sends: the higher one wins.
  const moveTier = (side: Side, i: number, by: -1 | 1) =>
    change(side, (tiers) => {
      const j = i + by;
      if (j < 0 || j >= tiers.length) return tiers;
      [tiers[i], tiers[j]] = [tiers[j], tiers[i]];
      return tiers;
    });
  const sortTiers = (side: Side) =>
    change(side, (tiers) =>
      [...tiers].sort((a, b) => {
        const num = (v: string, open: number) => (v.trim() === "" || !Number.isFinite(Number(v)) ? open : Number(v));
        return num(a.min, 0) - num(b.min, 0) || num(effectiveTo(a), Infinity) - num(effectiveTo(b), Infinity);
      })
    );

  async function saveRules() {
    if (!checked.rules) return;
    setSaving(true);
    try {
      await setBlockedDomainSettings({ inboxRules: checked.rules });
      setTouched(false);
      setSavedNote(true);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the rules.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleAuto() {
    setTogglingAuto(true);
    try {
      await setBlockedDomainSettings({ autoDelete: !view?.settings.autoDelete });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not change Auto-delete.");
    } finally {
      setTogglingAuto(false);
    }
  }

  async function checkInbox() {
    if (!checkEmail.trim()) return;
    setChecking(true);
    setCheckNote(null);
    try {
      const r = await blockedInboxAction({ action: "check", email: checkEmail.trim() });
      setCheckNote(r.outcome === "duplicate" ? "Already handled recently — see Home." : "Checking — the result appears on Home.");
      setCheckEmail("");
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not check that inbox.");
    } finally {
      setChecking(false);
    }
  }

  async function tenantBlock() {
    const domain = blockDomain.trim();
    if (!domain) return;
    const ok = window.confirm(
      `Block all of ${domain}? Every inbox on it is stopped now and deleted${view?.settings.autoDelete ? " straight away" : " once you confirm"}, the domain is set Not Active, and its tenant goes onto 🚯 Tenants to Cancel.`
    );
    if (!ok) return;
    setBlocking(true);
    setBlockNote(null);
    try {
      const r = await blockedInboxAction({ action: "tenant-block", domain });
      setBlockNote(r.outcome === "duplicate" ? `${r.domain} is already blocked, or being blocked.` : `Blocking ${r.domain} — follow it on Blocked Domains.`);
      setBlockDomain("");
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not block that domain.");
    } finally {
      setBlocking(false);
    }
  }

  return (
    <div className="space-y-5" data-settings>
      {/* The rules */}
      <section className="pv-card p-4 sm:p-6" data-rules-editor>
        <h2 className="text-base font-semibold">The rules</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Each inbox Clay sends is judged on its own last {JUDGE_WINDOW_DAYS} days, on the tier its send count falls in. Bounce
          rate is over everything sent; reply rates are over unique leads contacted, and the OOO reply rate counts
          out-of-office replies too. Leave a box empty (“off”) to not check that figure. Each tier is its own range of sends —
          exactly one number, from–to, or a number and up. Tiers are tried top to bottom and
          the first that covers an inbox&apos;s sends is used, so a narrow tier above a wide one is an exception to it — ↑ ↓ move a
          whole tier. Sends no tier covers aren&apos;t judged. An inbox that is neither Microsoft nor Google is left alone. Changes
          apply to inboxes judged from now on.
        </p>
        <TierTable side="microsoft" title="Microsoft (Azure)" tiers={draft.microsoft} notes={notes.microsoft} onEdit={edit} onAdd={addTier} onRemove={removeTier} onMove={moveTier} onSort={sortTiers} />
        <TierTable side="google" title="Google" tiers={draft.google} notes={notes.google} onEdit={edit} onAdd={addTier} onRemove={removeTier} onMove={moveTier} onSort={sortTiers} />

        {checked.problems.length > 0 && (
          <ul className="mt-4 space-y-1 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning" data-problems>
            {checked.problems.map((p) => (
              <li key={p} className="flex gap-2">
                <AlertIcon size={14} className="mt-0.5 shrink-0" /> {p}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="pv-btn-primary disabled:opacity-50" data-save-rules disabled={!dirty || saving} onClick={saveRules}>
            {saving ? <Spinner size={14} /> : null} Save rules
          </button>
          <button
            type="button"
            className="pv-btn-ghost disabled:opacity-50"
            data-reset-rules
            disabled={isDefault}
            onClick={() => {
              setTouched(true);
              setSavedNote(false);
              setDraft(toDraft(DEFAULT_RULES));
            }}
          >
            Reset to defaults
          </button>
          <span className="text-xs text-muted-foreground" data-rules-state>
            {savedNote ? "Saved — inboxes are judged on these from now on." : dirty ? "Unsaved changes." : isDefault ? "Using the defaults." : "Saved."}
          </span>
        </div>
      </section>

      <DomainEndings view={view} onChanged={onChanged} onError={onError} />

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Full automation */}
        <section className="pv-card p-4 sm:p-6">
          <h2 className="text-base font-semibold">Full automation</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {view?.settings.autoDelete
              ? "A blocked inbox is stopped and deleted straight away, with no confirmation."
              : "A blocked inbox is stopped straight away — sending and warmup off — and its deletion waits for you on Home."}{" "}
            A blocked Google inbox is listed on 🛑 Google Inboxes to Cancel. The same goes for the inboxes a domain
            cancellation stops.
          </p>
          <button
            type="button"
            disabled={togglingAuto || !view}
            onClick={toggleAuto}
            data-auto-delete={String(!!view?.settings.autoDelete)}
            className={`mt-3 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
              view?.settings.autoDelete ? "border-danger/40 bg-danger/10 text-danger" : "border-border hover:text-foreground"
            }`}
          >
            {togglingAuto ? <Spinner size={12} /> : <FireIcon size={13} />}
            {view?.settings.autoDelete ? "Auto-delete is ON" : "Auto-delete is OFF"}
          </button>
        </section>

        {/* Check one inbox */}
        <section className="pv-card p-4 sm:p-6">
          <h2 className="text-base font-semibold">Check an inbox now</h2>
          <p className="mt-1 text-xs text-muted-foreground">Runs one inbox exactly as if Clay had sent it, on the saved rules.</p>
          <div className="mt-3 flex items-center gap-2">
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
          {checkNote && <p className="mt-2 text-xs text-muted-foreground">{checkNote}</p>}
        </section>

        {/* Block a whole domain */}
        <section className="pv-card p-4 sm:p-6 lg:col-span-2">
          <h2 className="text-base font-semibold">Block a whole domain now</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Does what Clay&apos;s Tenant Block does: every inbox on the domain is stopped and deleted, the domain is set Not Active,
            and its tenant goes onto 🚯 Tenants to Cancel.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              className="pv-input"
              placeholder="domain.com"
              value={blockDomain}
              aria-label="Domain to block"
              data-block-domain
              onChange={(e) => setBlockDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void tenantBlock();
              }}
            />
            <button type="button" className="pv-btn-ghost shrink-0 whitespace-nowrap text-danger disabled:opacity-50" data-tenant-block disabled={blocking || !blockDomain.trim()} onClick={tenantBlock}>
              {blocking ? <Spinner size={14} /> : <TrashIcon size={14} />} Block domain
            </button>
          </div>
          {blockNote && <p className="mt-2 text-xs text-muted-foreground">{blockNote}</p>}
        </section>
      </div>

      {/* Clay */}
      <section className="pv-card p-4 sm:p-6">
        <h2 className="text-base font-semibold">Clay webhook</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          POST the <strong>sender inbox</strong> that bounced to this URL, with the header{" "}
          <span className="font-mono">x-webhook-secret</span> and a body of{" "}
          <span className="font-mono">{'{ "email": "sender@domain.com" }'}</span>. Repeat bounces are counted, not re-run: a
          blocked inbox is never judged again, and one that passed is judged again on its first bounce 24 hours later.
        </p>
        <p className="mt-2 text-xs text-muted-foreground" data-tenant-block-doc>
          <strong>Tenant Block:</strong> add <span className="font-mono">{'"tenant_block": "{{Tenant Block}}"'}</span> to the same body.
          When it is <span className="font-mono">YES</span>, the inbox is not judged — its whole domain is blocked: every inbox on it
          stopped and deleted{view?.settings.autoDelete ? "" : " (once you confirm, while Auto-delete is off)"}, the domain set Not Active,
          and the domain and its tenant added to 🚯 Tenants to Cancel. Once per domain; later YES rows for it are only counted. Empty
          or anything else: the inbox is judged as usual.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs">{url}</code>
          <button
            type="button"
            className="pv-btn-ghost"
            aria-label="Copy the webhook URL"
            onClick={async () => {
              if (await copyToClipboard(url)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          </button>
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
      </section>
    </div>
  );
}

// Kept in step with lib/blocked-domains/settings (server-only, so not imported).
const DEFAULT_CANCEL_AFTER = 13;
const DEFAULT_CANCEL_KEEP_RATE = 1;

/** When a domain as a whole is finished: Google's last inbox, Microsoft's Nth deletion. */
function DomainEndings({
  view,
  onChanged,
  onError,
}: {
  view: BlockedDomainsView | null;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const savedAfter = view?.settings.cancelAfterDeleted ?? DEFAULT_CANCEL_AFTER;
  const savedKeep = view?.settings.cancelKeepReplyRate ?? DEFAULT_CANCEL_KEEP_RATE;
  const [after, setAfter] = useState(String(savedAfter));
  const [keep, setKeep] = useState(String(savedKeep));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    if (!touched) {
      setAfter(String(savedAfter));
      setKeep(String(savedKeep));
    }
  }, [savedAfter, savedKeep, touched]);

  const afterN = Number(after);
  const keepN = Number(keep);
  const problems = [
    !(after.trim() && Number.isInteger(afterN) && afterN >= 0 && afterN <= 500) && "The deletion count must be a whole number from 0 to 500.",
    !(keep.trim() && Number.isFinite(keepN) && keepN >= 0 && keepN <= 100) && "The reply rate must be a percentage from 0 to 100.",
  ].filter(Boolean as unknown as (v: unknown) => v is string);
  const dirty = problems.length === 0 && (afterN !== savedAfter || keepN !== savedKeep);
  const isDefault = afterN === DEFAULT_CANCEL_AFTER && keepN === DEFAULT_CANCEL_KEEP_RATE;

  async function save() {
    setSaving(true);
    try {
      await setBlockedDomainSettings({ cancelAfterDeleted: afterN, cancelKeepReplyRate: keepN });
      setTouched(false);
      setSavedNote(true);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the domain settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="pv-card p-4 sm:p-6" data-domain-endings>
      <h2 className="text-base font-semibold">When a whole domain is finished</h2>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">Google</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            When a blocked inbox is the <strong>last one on its domain</strong> — every other inbox on it already blocked
            here — the domain’s status in 📋 Domains is set to <strong>Not Active</strong>. The inbox itself goes onto 🛑
            Google Inboxes to Cancel as usual.
          </p>
        </div>
        <div>
          <h3 className="text-sm font-semibold">Microsoft (Azure)</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Every Microsoft inbox the rules delete is counted against its domain. Once the count goes past the number
            below, the domain is cancelled the way the old automation did it: inboxes still getting replies are kept,
            every other inbox is stopped and deleted (or waits for you, with Auto-delete off), the domain goes{" "}
            <strong>Not Active</strong>, and the domain and its tenant email are added to 🚯 Tenants to Cancel. Once per
            domain.
          </p>
          <div className="mt-3 space-y-2 text-xs">
            <label className="flex flex-wrap items-center gap-2">
              Cancel after more than
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={500}
                step={1}
                className="pv-input w-20 py-1 text-xs tabular-nums"
                value={after}
                aria-label="Cancel a Microsoft domain after more than this many deleted inboxes"
                data-cancel-after
                onChange={(e) => {
                  setTouched(true);
                  setSavedNote(false);
                  setAfter(e.target.value);
                }}
              />
              inboxes deleted
            </label>
            <label className="flex flex-wrap items-center gap-2">
              Keep an inbox when its OOO reply rate is at least
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={0.1}
                className="pv-input w-20 py-1 text-xs tabular-nums"
                value={keep}
                aria-label="Keep an inbox at cancellation when its OOO reply rate is at least this"
                data-cancel-keep
                onChange={(e) => {
                  setTouched(true);
                  setSavedNote(false);
                  setKeep(e.target.value);
                }}
              />
              % over the last {JUDGE_WINDOW_DAYS} days
            </label>
          </div>
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {problems.map((p) => (
            <li key={p} className="flex gap-2">
              <AlertIcon size={14} className="mt-0.5 shrink-0" /> {p}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="pv-btn-primary disabled:opacity-50" data-save-endings disabled={!dirty || saving} onClick={save}>
          {saving ? <Spinner size={14} /> : null} Save
        </button>
        <button
          type="button"
          className="pv-btn-ghost disabled:opacity-50"
          disabled={isDefault || saving}
          onClick={() => {
            setTouched(true);
            setSavedNote(false);
            setAfter(String(DEFAULT_CANCEL_AFTER));
            setKeep(String(DEFAULT_CANCEL_KEEP_RATE));
          }}
        >
          Reset to defaults
        </button>
        <span className="text-xs text-muted-foreground" data-endings-state>
          {savedNote ? "Saved." : dirty ? "Unsaved changes." : problems.length ? "" : "Saved."}
        </span>
      </div>
    </section>
  );
}

function TierTable({
  side,
  title,
  tiers,
  onEdit,
  onAdd,
  onRemove,
  onMove,
  onSort,
  notes,
}: {
  side: Side;
  title: string;
  tiers: DraftTier[];
  notes: string[];
  onSort: (side: Side) => void;
  onEdit: (side: Side, i: number, key: keyof DraftTier, value: string) => void;
  onAdd: (side: Side) => void;
  onRemove: (side: Side, i: number) => void;
  onMove: (side: Side, i: number, by: -1 | 1) => void;
}) {
  const num = (i: number, key: keyof DraftTier, label: string, suffix: string, placeholder = "") => (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={key === "min" || key === "to" ? undefined : 100}
        step={key === "min" || key === "to" ? 1 : 0.1}
        className={`pv-input ${key === "to" ? "w-24" : "w-20"} py-1 text-xs tabular-nums`}
        value={tiers[i][key]}
        placeholder={placeholder}
        aria-label={`${title} tier ${i + 1}: ${label}`}
        data-tier={`${side}-${i}-${key}`}
        onChange={(e) => onEdit(side, i, key, e.target.value)}
      />
      <span className="text-muted-foreground">{suffix}</span>
    </span>
  );

  return (
    <div className="mt-5" data-tier-table={side}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="flex items-center gap-3">
          <button type="button" className="text-xs text-muted-foreground underline disabled:opacity-50" data-sort-tiers={side} disabled={tiers.length < 2} onClick={() => onSort(side)}>
            Sort by sends
          </button>
          <button type="button" className="text-xs text-muted-foreground underline disabled:opacity-50" data-add-tier={side} disabled={tiers.length >= MAX_TIERS} onClick={() => onAdd(side)}>
            Add a tier
          </button>
        </span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">Sends in the window</th>
              <th className="pb-2 pr-3 font-medium">Blocked when bounce is over</th>
              <th className="pb-2 pr-3 font-medium">…or OOO reply rate is under</th>
              <th className="pb-2 pr-3 font-medium">Kept anyway when human reply rate is over</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i} className="border-t border-border align-middle">
                <td className="whitespace-nowrap py-2 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <select
                      className="pv-input w-24 py-1 text-xs"
                      value={t.mode}
                      aria-label={`${title} tier ${i + 1}: kind of range`}
                      data-tier-mode={`${side}-${i}`}
                      onChange={(e) => onEdit(side, i, "mode", e.target.value)}
                    >
                      {MODES.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    {num(i, "min", t.mode === "exact" ? "sends" : "from sends", "", t.mode === "exact" ? "sends" : "from")}
                    {t.mode === "range" && (
                      <>
                        <span className="text-muted-foreground">to</span>
                        {num(i, "to", "to sends", "", "to")}
                      </>
                    )}
                    {t.mode === "up" && <span className="text-muted-foreground">and up</span>}
                  </span>
                </td>
                <td className="py-2 pr-3">{num(i, "maxBounceRate", "bounce over", "%")}</td>
                <td className="py-2 pr-3">{num(i, "minOooReplyRate", "OOO reply rate under", "%", "off")}</td>
                <td className="py-2 pr-3">{num(i, "humanReplyOverrule", "human reply rate over", "%", "off")}</td>
                <td className="whitespace-nowrap py-2 text-right">
                  <span className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      aria-label={`Move ${title} tier ${i + 1} up`}
                      title="Move this tier up: it is tried before the ones below it"
                      data-move-up={`${side}-${i}`}
                      disabled={i === 0}
                      onClick={() => onMove(side, i, -1)}
                    >
                      <ChevronDownIcon size={14} className="rotate-180" />
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      aria-label={`Move ${title} tier ${i + 1} down`}
                      title="Move this tier down"
                      data-move-down={`${side}-${i}`}
                      disabled={i === tiers.length - 1}
                      onClick={() => onMove(side, i, 1)}
                    >
                      <ChevronDownIcon size={14} />
                    </button>
                    {tiers.length > 1 && (
                      <button type="button" className="text-muted-foreground hover:text-danger" aria-label={`Remove ${title} tier ${i + 1}`} onClick={() => onRemove(side, i)}>
                        <TrashIcon size={14} />
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" data-tier-notes={side}>
          {notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

