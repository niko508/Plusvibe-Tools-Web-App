"use client";

// The Settings tab: how Clay reaches the automation, whether blocked inboxes
// are deleted without asking, and the rule they are judged on — which can be
// changed here.

import { useEffect, useState } from "react";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";
import { DEFAULT_REMOVAL_RULE, JUDGE_WINDOW_DAYS, MAX_WINDOW_DAYS, validateRemovalRule, type RemovalRule } from "@/lib/blocked-inboxes/rules";
import { blockedInboxAction, setBlockedDomainSettings } from "@/lib/api-client";
import { copyToClipboard } from "@/lib/clipboard";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, CopyIcon, FireIcon, GaugeIcon, TrashIcon } from "@/components/icons";

/** The rule as the form holds it: numbers as typed. */
type RuleDraft = Record<keyof RemovalRule, string>;
const RULE_KEYS: (keyof RemovalRule)[] = ["oooDays", "maxOooRate", "humanDays", "maxHumanRate", "minSendingDays"];
const toRuleDraft = (r: RemovalRule): RuleDraft => Object.fromEntries(RULE_KEYS.map((k) => [k, String(r[k])])) as RuleDraft;
const sameRule = (a: RemovalRule, b: RemovalRule) => RULE_KEYS.every((k) => a[k] === b[k]);

export function SettingsView({
  view,
  onChanged,
  onError,
}: {
  view: BlockedDomainsView | null;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkEmail, setCheckEmail] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [blockDomain, setBlockDomain] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [blockNote, setBlockNote] = useState<string | null>(null);

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
      <RuleEditor view={view} onChanged={onChanged} onError={onError} />

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

/**
 * The one rule every inbox Clay sends is judged on, Microsoft and Google
 * alike: no replies of any kind over the OOO window (unless people replied
 * over the human window), or out-of-office replies
 * but no human ones over the human window once it has been sending long enough.
 */
function RuleEditor({
  view,
  onChanged,
  onError,
}: {
  view: BlockedDomainsView | null;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const saved = view?.settings.removalRule ?? DEFAULT_REMOVAL_RULE;
  const [draft, setDraft] = useState<RuleDraft>(() => toRuleDraft(saved));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  // Follow what the server holds until someone starts editing.
  useEffect(() => {
    if (!touched) setDraft(toRuleDraft(saved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(saved), touched]);

  const checked = validateRemovalRule(draft);
  const dirty = !!checked.rule && !sameRule(checked.rule, saved);
  const isDefault = !!checked.rule && sameRule(checked.rule, DEFAULT_REMOVAL_RULE);
  const set = (k: keyof RemovalRule, v: string) => {
    setTouched(true);
    setSavedNote(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const field = (k: keyof RemovalRule, label: string, kind: "days" | "pct") => (
    <input
      type="number"
      inputMode={kind === "days" ? "numeric" : "decimal"}
      min={kind === "days" ? (k === "minSendingDays" ? 0 : 1) : 0}
      max={kind === "days" ? MAX_WINDOW_DAYS : 100}
      step={kind === "days" ? 1 : 0.1}
      className="pv-input mx-1 inline-block w-16 py-1 text-center text-xs tabular-nums"
      value={draft[k]}
      aria-label={label}
      data-rule-field={k}
      onChange={(e) => set(k, e.target.value)}
    />
  );
  const d = checked.rule ?? DEFAULT_REMOVAL_RULE;

  async function save() {
    if (!checked.rule) return;
    setSaving(true);
    try {
      await setBlockedDomainSettings({ removalRule: checked.rule });
      setTouched(false);
      setSavedNote(true);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the rule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="pv-card p-4 sm:p-6" data-rules-editor>
      <h2 className="text-base font-semibold">The rule</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Every inbox Clay sends is judged on its own figures — the same rule for Microsoft (Azure) and Google. Reply rates are
        over unique leads contacted; the OOO reply rate counts out-of-office replies as well as people&apos;s. An inbox that
        is neither Microsoft nor Google is left alone. Changes apply to inboxes judged from now on.
      </p>

      <ol className="mt-4 space-y-3 text-sm">
        <li className="rounded-xl border border-border p-3" data-rule-one>
          <div className="text-xs font-medium text-muted-foreground">1 · No replies at all</div>
          <div className="mt-1.5 leading-8">
            Removed when its OOO reply rate over the last
            {field("oooDays", "OOO window in days", "days")}
            days is at or under
            {field("maxOooRate", "Highest OOO reply rate that removes an inbox", "pct")}%.
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground" data-rule-one-exception>
            Unless people replied to it: an inbox whose human reply rate over the last {d.humanDays} days is above{" "}
            {d.maxHumanRate}% is kept, however quiet its last {d.oooDays} days were.
          </p>
        </li>
        <li className="rounded-xl border border-border p-3" data-rule-two>
          <div className="text-xs font-medium text-muted-foreground">2 · Out-of-office replies, but nobody answers</div>
          <div className="mt-1.5 leading-8">
            Otherwise, removed when its human reply rate over the last
            {field("humanDays", "Human reply window in days", "days")}
            days is at or under
            {field("maxHumanRate", "Highest human reply rate that removes an inbox", "pct")}% — once it has been sending for at least
            {field("minSendingDays", "Days it must have been sending", "days")}
            days.
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            &ldquo;Sending for at least {d.minSendingDays} days&rdquo; means it had campaign sends {d.minSendingDays} or more days ago — the
            date it was added to Plusvibe would count its warmup too. When that, or its human reply rate, can&apos;t be read,
            it is kept.
          </p>
        </li>
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">
        An inbox that sent nothing in the last {d.oooDays} days has no OOO reply rate, so it isn&apos;t judged. There is no
        minimum number of sends and no bounce check.
      </p>

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
        <button type="button" className="pv-btn-primary disabled:opacity-50" data-save-rules disabled={!dirty || saving} onClick={save}>
          {saving ? <Spinner size={14} /> : null} Save rule
        </button>
        <button
          type="button"
          className="pv-btn-ghost disabled:opacity-50"
          data-reset-rules
          disabled={isDefault || saving}
          onClick={() => {
            setTouched(true);
            setSavedNote(false);
            setDraft(toRuleDraft(DEFAULT_REMOVAL_RULE));
          }}
        >
          Reset to defaults
        </button>
        <span className="text-xs text-muted-foreground" data-rules-state>
          {savedNote ? "Saved — inboxes are judged on this from now on." : dirty ? "Unsaved changes." : isDefault ? "Using the defaults." : checked.rule ? "Saved." : ""}
        </span>
      </div>
    </section>
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
