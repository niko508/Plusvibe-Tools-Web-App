// Unit checks for the bulk Add Webhook logic: config validation, the request
// body it builds, and the duplicate guard.
//
//   node scripts/check-webhooks.mjs

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};

// --- mirrored from src/lib/webhooks/config.ts -------------------------------
const SYSTEM_ALERT = "SYSTEM_ALERT";
const CAMP_IDS_ALL = ["ALL"];

const validate = (c) => {
  const errors = [];
  const url = c.url.trim();
  if (!url) errors.push("no-url");
  else {
    let p = null;
    try { p = new URL(url); } catch { p = null; }
    if (!p) errors.push("bad-url");
    else if (p.protocol !== "https:") errors.push("not-https");
  }
  const events = c.eventTypes.map((e) => e.trim()).filter(Boolean);
  if (events.length === 0) errors.push("no-events");
  if (events.includes(SYSTEM_ALERT) && c.alerts.length === 0) errors.push("alerts-missing");
  if (!events.includes(SYSTEM_ALERT) && c.alerts.length > 0) errors.push("alerts-orphaned");
  return errors;
};

const buildBody = (c, workspaceId) => {
  const events = c.eventTypes.map((e) => e.trim()).filter(Boolean);
  const body = { workspace_id: workspaceId, url: c.url.trim(), camp_ids: CAMP_IDS_ALL, event_types: events };
  if (c.name.trim()) body.name = c.name.trim();
  if (c.secret.trim()) body.secret = c.secret.trim();
  if (c.ignoreOoo) body.ignore_ooo = 1;
  if (c.ignoreAutomatic) body.ignore_automatic = 1;
  if (events.includes(SYSTEM_ALERT)) {
    body.alerts = Object.fromEntries(c.alerts.map((a) => [a, { type: "URGENT" }]));
  }
  return body;
};

const normalizeUrl = (url) => {
  const t = url.trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch { return t.toLowerCase(); }
};
const hasHookForUrl = (hooks, url) => {
  const target = normalizeUrl(url);
  return hooks.some((h) => normalizeUrl(h.url ?? "") === target);
};

const base = {
  name: "", url: "https://hooks.example.com/pv", eventTypes: ["ALL_EMAIL_REPLIES"],
  alerts: [], secret: "", ignoreOoo: false, ignoreAutomatic: false,
};

// --- validation -------------------------------------------------------------
console.log("--- validation");
eq("a minimal valid config passes", validate(base), []);
eq("empty url is rejected", validate({ ...base, url: "" }), ["no-url"]);
eq("a non-url is rejected", validate({ ...base, url: "not a url" }), ["bad-url"]);
eq("a bare host is rejected", validate({ ...base, url: "hooks.example.com" }), ["bad-url"]);
// Webhook payloads carry lead data and reply bodies, so plaintext is refused.
eq("http is rejected", validate({ ...base, url: "http://hooks.example.com/pv" }), ["not-https"]);
eq("no events is rejected", validate({ ...base, eventTypes: [] }), ["no-events"]);
eq("whitespace-only events count as none",
  validate({ ...base, eventTypes: ["  ", ""] }), ["no-events"]);
// The API requires alerts with SYSTEM_ALERT; catching it here beats N failed calls.
eq("system alert without alerts is rejected",
  validate({ ...base, eventTypes: [SYSTEM_ALERT], alerts: [] }), ["alerts-missing"]);
eq("system alert with alerts passes",
  validate({ ...base, eventTypes: [SYSTEM_ALERT], alerts: ["WEBHOOK_DISABLED"] }), []);
// Alerts without the event would be silently dropped — better to say so.
eq("orphaned alerts are flagged",
  validate({ ...base, alerts: ["WEBHOOK_DISABLED"] }), ["alerts-orphaned"]);
eq("multiple problems are all reported",
  validate({ ...base, url: "", eventTypes: [] }).sort(), ["no-events", "no-url"]);

// --- request body -----------------------------------------------------------
console.log("--- request body");
const b1 = buildBody(base, "w1");
eq("carries the workspace id", b1.workspace_id, "w1");
// Campaign ids are workspace-specific, so a cross-workspace add can only be ALL
// — which is also what SYSTEM_ALERT requires.
eq("camp_ids is always ALL", b1.camp_ids, ["ALL"]);
eq("events are passed through", b1.event_types, ["ALL_EMAIL_REPLIES"]);
eq("optional name is omitted when blank", "name" in b1, false);
eq("optional secret is omitted when blank", "secret" in b1, false);
eq("flags are omitted when off", ["ignore_ooo", "ignore_automatic"].some((k) => k in b1), false);
eq("no alerts key without the event", "alerts" in b1, false);

const b2 = buildBody(
  { ...base, name: "  Replies  ", secret: " s3cret ", ignoreOoo: true, ignoreAutomatic: true },
  "w2"
);
eq("name is trimmed", b2.name, "Replies");
eq("secret is trimmed", b2.secret, "s3cret");
// The API takes 0/1, not booleans.
eq("ignore_ooo is 1 not true", b2.ignore_ooo, 1);
eq("ignore_automatic is 1 not true", b2.ignore_automatic, 1);

const b3 = buildBody(
  { ...base, eventTypes: [SYSTEM_ALERT], alerts: ["WEBHOOK_DISABLED", "BILLING_PAYMENT_FAILED"] },
  "w3"
);
eq("alerts map to the documented shape", b3.alerts, {
  WEBHOOK_DISABLED: { type: "URGENT" },
  BILLING_PAYMENT_FAILED: { type: "URGENT" },
});
eq("system alert still sends camp_ids ALL", b3.camp_ids, ["ALL"]);

// The same config must produce an identical body for every workspace bar the id.
const wsA = buildBody(base, "a"), wsB = buildBody(base, "b");
eq("bodies differ only by workspace_id",
  JSON.stringify({ ...wsA, workspace_id: "x" }) === JSON.stringify({ ...wsB, workspace_id: "x" }), true);

// --- duplicate guard --------------------------------------------------------
console.log("--- duplicate guard");
const URL1 = "https://hooks.example.com/pv";
eq("no hooks means not present", hasHookForUrl([], URL1), false);
eq("exact match is found", hasHookForUrl([{ url: URL1 }], URL1), true);
eq("a different path is not a match",
  hasHookForUrl([{ url: "https://hooks.example.com/other" }], URL1), false);
eq("a different host is not a match",
  hasHookForUrl([{ url: "https://other.example.com/pv" }], URL1), false);
// Host case doesn't change the destination; path case can.
eq("host case is ignored",
  hasHookForUrl([{ url: "https://HOOKS.EXAMPLE.COM/pv" }], URL1), true);
eq("path case is respected",
  hasHookForUrl([{ url: "https://hooks.example.com/PV" }], URL1), false);
eq("a trailing slash on the bare root matches",
  hasHookForUrl([{ url: "https://hooks.example.com/" }], "https://hooks.example.com"), true);
// A query string changes where the payload lands, so it must not be collapsed.
eq("query strings are significant",
  hasHookForUrl([{ url: URL1 + "?env=prod" }], URL1), false);
eq("surrounding whitespace is ignored", hasHookForUrl([{ url: "  " + URL1 + " " }], URL1), true);
eq("a hook with no url never matches", hasHookForUrl([{}], URL1), false);
eq("found among several", hasHookForUrl([{ url: "https://a.example/x" }, { url: URL1 }], URL1), true);
// http vs https are different endpoints; the guard must not treat them as one.
eq("scheme is significant",
  hasHookForUrl([{ url: "http://hooks.example.com/pv" }], URL1), false);


// --- lead label event types -------------------------------------------------
const LABEL_PREFIX = "LEAD_MARKED_AS_";
const labelEventType = (key) => {
  const t = key.trim();
  if (!t) return "";
  return t.toUpperCase().startsWith(LABEL_PREFIX) ? t : `${LABEL_PREFIX}${t}`;
};
const isLabelEvent = (e) =>
  e.toUpperCase().startsWith(LABEL_PREFIX) && e !== "LEAD_MARKED_AS_INTERESTED";

console.log("--- lead label event types");
eq("a plain key is prefixed", labelEventType("NQ_INDIAN_COMPANY"), "LEAD_MARKED_AS_NQ_INDIAN_COMPANY");
eq("whitespace is trimmed", labelEventType("  LOST_LEAD  "), "LEAD_MARKED_AS_LOST_LEAD");
eq("an empty key yields nothing", labelEventType("   "), "");
// A key that already carries the prefix must not be prefixed twice.
eq("an already-prefixed key passes through",
  labelEventType("LEAD_MARKED_AS_LOST_LEAD"), "LEAD_MARKED_AS_LOST_LEAD");
eq("prefix check is case-insensitive",
  labelEventType("lead_marked_as_lost"), "lead_marked_as_lost");
eq("the key's own case is preserved", labelEventType("Booked"), "LEAD_MARKED_AS_Booked");
eq("applying twice is stable",
  labelEventType(labelEventType("NQ_OTHER")), labelEventType("NQ_OTHER"));

// The built-in "interested" event is not a custom label, so selecting it must
// not be reported as one.
eq("built-in interested is not a label event", isLabelEvent("LEAD_MARKED_AS_INTERESTED"), false);
eq("a custom label is a label event", isLabelEvent("LEAD_MARKED_AS_LOST_LEAD"), true);
eq("all replies is not a label event", isLabelEvent("ALL_EMAIL_REPLIES"), false);
eq("system alert is not a label event", isLabelEvent("SYSTEM_ALERT"), false);

// Labels are per-workspace: the union carries a count so the UI can warn.
const mergeLabels = (perWorkspace) => {
  const byKey = new Map();
  for (const labels of perWorkspace) {
    for (const l of labels) {
      const e = byKey.get(l.key);
      if (e) e.presentIn += 1;
      else byKey.set(l.key, { key: l.key, name: l.name, presentIn: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.presentIn !== b.presentIn ? b.presentIn - a.presentIn : a.name.localeCompare(b.name));
};
const merged = mergeLabels([
  [{ key: "A", name: "Alpha" }, { key: "B", name: "Beta" }],
  [{ key: "A", name: "Alpha" }],
  [{ key: "A", name: "Alpha" }, { key: "C", name: "Gamma" }],
]);
eq("a label in every workspace counts 3", merged.find((l) => l.key === "A").presentIn, 3);
eq("a label in one workspace counts 1", merged.find((l) => l.key === "B").presentIn, 1);
eq("the union has every label", merged.length, 3);
// Labels present everywhere sort first — those are the safe ones to pick.
eq("everywhere-labels sort first", merged[0].key, "A");
eq("no duplicates in the union", new Set(merged.map((l) => l.key)).size, merged.length);

console.log(failures === 0 ? "\nall webhook checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
