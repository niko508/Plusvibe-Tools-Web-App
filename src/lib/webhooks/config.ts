// Webhook configuration shared by the client form and the server route.
//
//   POST /hook/add   { workspace_id, name, url, camp_ids, event_types,
//                      alerts?, secret?, ignore_ooo?, ignore_automatic? }
//   GET  /hook/list  ?workspace_id=...  -> { hooks: [...] }
//
// camp_ids is always ["ALL"] here. Campaign ids are workspace-specific, so a
// bulk action across workspaces has nothing else it could sensibly send — and
// SYSTEM_ALERT requires ["ALL"] anyway.

export const CAMP_IDS_ALL = ["ALL"];

export const EVENT_TYPES = [
  { value: "ALL_EMAIL_REPLIES", label: "All email replies" },
  { value: "LEAD_MARKED_AS_INTERESTED", label: "Lead marked as interested" },
  { value: "SYSTEM_ALERT", label: "System alert" },
] as const;

export const SYSTEM_ALERT = "SYSTEM_ALERT";

/** Every alert name the API documents for the `alerts` object. */
export const SYSTEM_ALERTS = [
  "EMAIL_ACCOUNT_DISCONNECTED",
  "EMAIL_ACCOUNT_FORWARDING_BOUNCED",
  "INTEGRATION_DISCONNECTED",
  "INTEGRATION_GSHEET_SYNC_FAILED",
  "CAMPAIGN_AUTO_PAUSED",
  "WEBHOOK_DISABLED",
  "BILLING_PAYMENT_FAILED",
  "BILLING_SUBSCRIPTION_EXPIRED",
  "BILLING_DFY_SUBSCRIPTION_EXPIRED",
  "BILLING_DFY_DOMAIN_CANCELLED",
  "BILLING_DFY_EMAIL_EXPIRED",
  "BILLING_DFY_PAYMENT_FAILING",
  "BILLING_PLACEMENT_SUBSCRIPTION_EXPIRED",
] as const;

export type SystemAlert = (typeof SYSTEM_ALERTS)[number];

export interface WebhookConfig {
  name: string;
  url: string;
  eventTypes: string[];
  /** Alert names to subscribe to; only meaningful with SYSTEM_ALERT. */
  alerts: string[];
  secret: string;
  ignoreOoo: boolean;
  ignoreAutomatic: boolean;
}

export function emptyWebhookConfig(): WebhookConfig {
  return {
    name: "",
    url: "",
    eventTypes: ["ALL_EMAIL_REPLIES"],
    alerts: [],
    secret: "",
    ignoreOoo: false,
    ignoreAutomatic: false,
  };
}

/**
 * Validates a config before it is sent to any workspace.
 *
 * A bulk action multiplies mistakes — a bad URL isn't one broken webhook, it's
 * one per workspace, each needing manual deletion. So this is checked up front
 * rather than letting the API reject each call in turn.
 */
export function validateWebhookConfig(config: WebhookConfig): string[] {
  const errors: string[] = [];

  const url = config.url.trim();
  if (!url) {
    errors.push("Enter the URL events should be sent to.");
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      errors.push("The URL isn't valid — include the scheme, e.g. https://…");
    } else if (parsed.protocol !== "https:") {
      // Webhook payloads carry lead data and reply bodies.
      errors.push("The URL must be https — webhook payloads carry lead data.");
    }
  }

  const events = config.eventTypes.map((e) => e.trim()).filter(Boolean);
  if (events.length === 0) {
    errors.push("Pick at least one event type.");
  }
  if (events.includes(SYSTEM_ALERT) && config.alerts.length === 0) {
    errors.push(
      "System alert is selected but no alerts are ticked — the API requires at least one."
    );
  }
  if (!events.includes(SYSTEM_ALERT) && config.alerts.length > 0) {
    errors.push(
      "Alerts are ticked but System alert isn't selected — they would be ignored."
    );
  }

  return errors;
}

/** The POST /hook/add body for one workspace. */
export function buildWebhookBody(
  config: WebhookConfig,
  workspaceId: string
): Record<string, unknown> {
  const events = config.eventTypes.map((e) => e.trim()).filter(Boolean);
  const body: Record<string, unknown> = {
    workspace_id: workspaceId,
    url: config.url.trim(),
    camp_ids: CAMP_IDS_ALL,
    event_types: events,
  };

  const name = config.name.trim();
  if (name) body.name = name;

  const secret = config.secret.trim();
  if (secret) body.secret = secret;

  // The API takes 0/1 rather than booleans, and only means anything for
  // reply-shaped events — but sending it always is harmless and keeps the
  // body identical across workspaces.
  if (config.ignoreOoo) body.ignore_ooo = 1;
  if (config.ignoreAutomatic) body.ignore_automatic = 1;

  if (events.includes(SYSTEM_ALERT)) {
    body.alerts = Object.fromEntries(
      config.alerts.map((a) => [a, { type: "URGENT" }])
    );
  }

  return body;
}

/** A webhook as returned by GET /hook/list, loosely typed. */
export interface ExistingHook {
  _id?: string;
  url?: string;
  name?: string;
  status?: string;
}

/**
 * True if this workspace already has a webhook pointing at the same URL.
 *
 * Re-running a bulk add must not stack a second copy on the workspaces it
 * already reached — the API has no upsert, and duplicates would double every
 * event.
 */
export function hasHookForUrl(hooks: ExistingHook[], url: string): boolean {
  const target = normalizeUrl(url);
  return hooks.some((h) => normalizeUrl(h.url ?? "") === target);
}

/** Compares URLs ignoring only what genuinely doesn't change the destination. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    // Host is case-insensitive; the path is not. A trailing slash on an empty
    // path is the same endpoint, but "/a/" and "/a" are not guaranteed to be,
    // so only the bare-root case is collapsed.
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

// --- Custom lead labels -----------------------------------------------------

/** A lead label as exposed by GET /workspace-settings/lead-labels. */
export interface LeadLabel {
  /** Stable reference key the API documents "for use in other APIs". */
  key: string;
  name: string;
  sentiment: string;
  isSystem: boolean;
}

export const LABEL_EVENT_PREFIX = "LEAD_MARKED_AS_";

/**
 * The event_types string for a lead label.
 *
 * The docs give the shape as LEAD_MARKED_AS_X "where X is a custom label" but
 * never say whether X is the label's `key` or its display name. `key` is the
 * field described as the stable reference for other APIs, so that's what's
 * used — and the resulting string is shown in the UI, so it can be checked
 * against Plusvibe's own webhook screen before anything is created.
 *
 * A key that already carries the prefix is passed through rather than being
 * prefixed twice.
 */
export function labelEventType(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  return trimmed.toUpperCase().startsWith(LABEL_EVENT_PREFIX)
    ? trimmed
    : `${LABEL_EVENT_PREFIX}${trimmed}`;
}

/** True if an event type refers to a lead label rather than a built-in event. */
export function isLabelEvent(eventType: string): boolean {
  return (
    eventType.toUpperCase().startsWith(LABEL_EVENT_PREFIX) &&
    eventType !== "LEAD_MARKED_AS_INTERESTED"
  );
}
