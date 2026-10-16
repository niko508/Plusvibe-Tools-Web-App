"use client";

// The Settings tab: how Clay reaches the automation, whether a blocked
// domain's inboxes are deleted without asking, and blocking a domain by hand.

import { useState } from "react";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";
import { blockedInboxAction, setBlockedDomainSettings } from "@/lib/api-client";
import { copyToClipboard } from "@/lib/clipboard";
import { Spinner } from "@/components/ui";
import { CheckIcon, CopyIcon, FireIcon, TrashIcon } from "@/components/icons";

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
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Full automation */}
        <section className="pv-card p-4 sm:p-6">
          <h2 className="text-base font-semibold">Full automation</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {view?.settings.autoDelete
              ? "Every inbox on a blocked domain is stopped and deleted straight away, with no confirmation."
              : "Every inbox on a blocked domain is stopped straight away — sending and warmup off — and its deletion waits for you on the domain's card on Home."}
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
          POST the <strong>sender inbox</strong> to this URL, with the header <span className="font-mono">x-webhook-secret</span> and a
          body of{" "}
          <span className="font-mono">
            {'{ "email": …, "domain": …, "domain_blocked": …, "tenant_block": …, "stop_sending_to_google": …, "bounce_reason": … }'}
          </span>
          , run when any of the three columns says <span className="font-mono">YES</span>.
        </p>
        <p className="mt-2 text-xs text-muted-foreground" data-google-stop-doc>
          <strong>Stop Sending to Google:</strong> every inbox on the sender&apos;s domain, in every workspace, gets the{" "}
          <span className="font-mono">No Sending to Google</span> tag (created where it&apos;s missing), and the google-pool tag comes
          off any inbox that carries it. Nothing is stopped or deleted
          and the sheet isn&apos;t touched. Every YES row checks the domain again and tags any inbox still missing the tag.
        </p>
        <p className="mt-2 text-xs text-muted-foreground" data-tenant-block-doc>
          <strong>Domain Blocked or Tenant Block:</strong> the sender&apos;s whole domain is blocked: every inbox on it
          stopped and deleted{view?.settings.autoDelete ? "" : " (once you confirm, while Auto-delete is off)"}, the domain set Not Active,
          and the domain and its tenant added to 🚯 Tenants to Cancel (a Google inbox goes on 🛑 Google Inboxes to Cancel). Once per
          domain; later YES rows for it are only counted. A body without domain_blocked or stop_sending_to_google counts as Domain
          Blocked.
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
