// Unit checks for "Remove Inboxes & Domains": which burned rows are acted on,
// what gets written to each tab of the Email Infrastructure sheet, and which
// Plusvibe inboxes a row means. Imports the REAL modules.
//
//   node scripts/check-burned-removal.mjs

import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};

const R = await importTs("@/lib/burned/removal");
const SP = await importTs("@/lib/blocked-domains/sheet-plan");
const {
  REMOVED_STATUS, targetsFrom, domainsOf, planDomainsTab, tenantsToQueue,
  inboxesFor, inboxCount, describeRun,
} = R;

const COLS = {
  domain: "Domain",
  status: "Status",
  tenantEmail: "Tenant Email Address",
  tenantSource: "Tenant / Inbox Source",
};
const TAB = "📋 Domains";

const row = (over = {}) => ({
  workspaceId: "ws1",
  workspaceName: "Media Manager",
  name: "burned.io",
  domain: "burned.io",
  inboxes: 2,
  sent: 400,
  contacted: 200,
  replies: 0,
  oooReplies: 0,
  replyRate: 0,
  replyRateOoo: 0,
  verdict: "burned",
  ...over,
});

// --- which rows are acted on ------------------------------------------------
console.log("--- the targets");
eq("only burned rows are removed", targetsFrom([
  row({ name: "a.io", domain: "a.io" }),
  row({ name: "b.io", domain: "b.io", verdict: "ok" }),
  row({ name: "c.io", domain: "c.io", verdict: "quiet", reason: "few-sends" }),
]).map((t) => t.name), ["a.io"]);
// A row the Reply % rescue saved is an "ok" row, so it is never removed — the
// whole point of the rescue is that those mailboxes are still working.
eq("a rescued row is not removed", targetsFrom([row({ verdict: "ok", rescued: true })]), []);
eq("nothing burned means nothing to do", targetsFrom([]), []);
eq("names are lowercased, so the sheet lookup and the inbox match agree",
  targetsFrom([row({ name: "Burned.IO", domain: "Burned.IO" })]).map((t) => [t.name, t.domain]),
  [["burned.io", "burned.io"]]);
eq("the same row twice in one workspace is one target",
  targetsFrom([row(), row()]).length, 1);
// The same domain really can be judged in two workspaces, and each
// workspace's inboxes have to be deleted separately.
eq("the same domain in two workspaces is two targets",
  targetsFrom([row(), row({ workspaceId: "ws2", workspaceName: "Ikoni" })]).map((t) => t.workspaceId),
  ["ws2", "ws1"]);
eq("targets come out grouped by workspace, then by name",
  targetsFrom([
    row({ workspaceId: "ws2", workspaceName: "Zeta", name: "b.io", domain: "b.io" }),
    row({ workspaceId: "ws1", workspaceName: "Alpha", name: "z.io", domain: "z.io" }),
    row({ workspaceId: "ws1", workspaceName: "Alpha", name: "a.io", domain: "a.io" }),
  ]).map((t) => `${t.workspaceName}/${t.name}`),
  ["Alpha/a.io", "Alpha/z.io", "Zeta/b.io"]);
eq("a domain is only listed once for the sheet, however many workspaces it is in",
  domainsOf(targetsFrom([row(), row({ workspaceId: "ws2", workspaceName: "Ikoni" })])), ["burned.io"]);
// Google targets are inboxes; their domain still drives nothing but display.
eq("a Google target falls back to the address's own domain",
  domainsOf([{ workspaceId: "w", workspaceName: "W", name: "a@g.com", domain: "" }]), ["g.com"]);

// --- 📋 Domains -------------------------------------------------------------
console.log("--- the Domains tab");
const GRID = [
  // Deliberately NOT in the screenshot's order: columns are found by name.
  ["Status", "Domain", "Tenant / Inbox Source", "Inboxes", "Tenant Email Address"],
  ["Active", "burned.io", "Cheap Inboxes", "3", "admin@burnedco.onmicrosoft.com"],
  ["Not Active", "already.io", "Cheap Inboxes", "3", "admin@alreadyco.onmicrosoft.com"],
  ["Active", "notenant.io", "", "3", ""],
  ["Active", "twice.io", "Cheap Inboxes", "3", "admin@twiceco.onmicrosoft.com"],
  ["Active", "twice.io", "Cheap Inboxes", "3", "admin@otherco.onmicrosoft.com"],
];

const plan = planDomainsTab(GRID, ["burned.io", "already.io", "notenant.io", "twice.io", "missing.io"], COLS, TAB);
eq("the status cell is found by header name, not column order",
  plan.updates.find((u) => u.row === 2), { row: 2, column: 0, value: REMOVED_STATUS });
// A row that already says Not Active is left alone rather than rewritten with
// the same value — one less cell to send, and the card can say it was already.
eq("a row already Not Active is not written again",
  [plan.updates.some((u) => u.row === 3), plan.lookups.find((l) => l.domain === "already.io").statusAlready],
  [false, true]);
eq("the tenant and its source come off the same row",
  (({ tenantEmail, tenantSource }) => [tenantEmail, tenantSource])(plan.lookups.find((l) => l.domain === "burned.io")),
  ["admin@burnedco.onmicrosoft.com", "Cheap Inboxes"]);
eq("a domain listed twice reports it and only the first row is touched",
  (({ matches, rowNumber }) => [matches, rowNumber])(plan.lookups.find((l) => l.domain === "twice.io")), [2, 5]);
eq("only one status cell per domain is written", plan.updates.filter((u) => u.value === REMOVED_STATUS).length, 3);
// A domain nobody put in the sheet is reported against its own row rather
// than stopping the run — the other domains still get recorded.
eq("a domain that isn't in the tab says so and has no row",
  (({ matches, rowNumber, problem }) => [matches, rowNumber, problem])(plan.lookups.find((l) => l.domain === "missing.io")),
  [0, undefined, 'missing.io isn\'t in the "📋 Domains" tab, so nothing was updated there and its inboxes were left alone.']);
eq("a tab with no Domain column is a problem with the tab, not with a domain",
  planDomainsTab([["Notes"]], ["a.io"], COLS, TAB).problem,
  'The "📋 Domains" tab has no Domain column, so no domains could be found in it.');
eq("a tab with no Status column leaves the status alone and says so",
  planDomainsTab([["Domain"], ["a.io"]], ["a.io"], COLS, TAB).lookups[0].problem,
  'The "📋 Domains" tab has no Status column, so the status was left as it was.');
eq("a header with stray padding still matches",
  planDomainsTab([[" Domain ", " Status "], ["a.io", "Active"]], ["a.io"], COLS, TAB).updates,
  [{ row: 2, column: 1, value: REMOVED_STATUS }]);

// --- 🚯 Tenants to Cancel ---------------------------------------------------
console.log("--- the tenants");
const tq = tenantsToQueue(plan.lookups);
eq("a domain with no tenant is reported, not queued blank", tq.missing, ["notenant.io"]);
eq("every tenant that was found is queued with its own source and domain",
  tq.entries,
  [
    { key: "admin@burnedco.onmicrosoft.com", source: "Cheap Inboxes", domain: "burned.io" },
    { key: "admin@alreadyco.onmicrosoft.com", source: "Cheap Inboxes", domain: "already.io" },
    { key: "admin@twiceco.onmicrosoft.com", source: "Cheap Inboxes", domain: "twice.io" },
  ]);
// Several burned domains normally sit on one tenant, and cancelling it once
// is the point.
eq("one tenant behind two domains is queued once, under the first domain",
  tenantsToQueue([
    { domain: "a.io", rowNumber: 2, matches: 1, status: "", tenantEmail: "t@x.com", tenantSource: "S" },
    { domain: "b.io", rowNumber: 3, matches: 1, status: "", tenantEmail: "T@X.com", tenantSource: "S" },
  ]).entries, [{ key: "t@x.com", source: "S", domain: "a.io" }]);
eq("a domain that was never found has no tenant to queue",
  tenantsToQueue([{ domain: "a.io", matches: 0, status: "", tenantEmail: "", tenantSource: "" }]),
  { entries: [], missing: [] });

// The tenants tab is laid out with blank rows and a source dropdown, exactly
// like the Google one, so it fills those rows instead of appending below them.
console.log("--- the cancel tabs");
const TENANTS = [
  ["Tenant", "Tenant / Inbox Source"],
  ["admin@old.onmicrosoft.com", "Cheap Inboxes"],
  ["", "–"],
  ["", "–"],
];
const tplan = SP.planQueueTabWrites(
  TENANTS,
  [
    { key: "admin@new.onmicrosoft.com", source: "Cheap Inboxes" },
    { key: "admin@old.onmicrosoft.com", source: "Cheap Inboxes" },
  ],
  SP.TENANT_QUEUE
);
eq("a new tenant fills the first blank row rather than landing below them",
  tplan.updates,
  [{ row: 3, column: 0, value: "admin@new.onmicrosoft.com" }, { row: 3, column: 1, value: "Cheap Inboxes" }]);
eq("a tenant already on the tab is not queued twice",
  [tplan.queued, tplan.already, tplan.append], [["admin@new.onmicrosoft.com"], ["admin@old.onmicrosoft.com"], []]);
// Each entry carries its own dropdown value, so two tenants bought from
// different places don't both get the first one's source.
eq("each tenant keeps its own source",
  SP.planQueueTabWrites([["Tenant", "Tenant / Inbox Source"], ["", "–"], ["", "–"]],
    [{ key: "a@x.com", source: "Cheap Inboxes" }, { key: "b@x.com", source: "Hypertise" }],
    SP.TENANT_QUEUE).updates,
  [
    { row: 2, column: 0, value: "a@x.com" }, { row: 2, column: 1, value: "Cheap Inboxes" },
    { row: 3, column: 0, value: "b@x.com" }, { row: 3, column: 1, value: "Hypertise" },
  ]);
// The Domain column says what sent the tenant to the list.
eq("the tenant's domain lands in the tab's Domain column",
  SP.planQueueTabWrites([["Domain", "Tenant", "Tenant / Inbox Source"], ["", "", "–"]],
    [{ key: "admin@burnedco.onmicrosoft.com", source: "Cheap Inboxes", domain: "burned.io" }],
    SP.TENANT_QUEUE).updates,
  [
    { row: 2, column: 1, value: "admin@burnedco.onmicrosoft.com" },
    { row: 2, column: 2, value: "Cheap Inboxes" },
    { row: 2, column: 0, value: "burned.io" },
  ]);
// A Google row has no tenant behind it, so its domain is its own.
eq("a Google address brings its own domain and no source",
  SP.planQueueTabWrites([["Domain", "Email Address", "Tenant / Inbox Source"], ["", "", "–"]],
    [{ key: "sarah@leclu.co", source: "", domain: "leclu.co" }], SP.GOOGLE_QUEUE).updates,
  [{ row: 2, column: 1, value: "sarah@leclu.co" }, { row: 2, column: 0, value: "leclu.co" }]);
eq("a tenants tab without its key column says so in its own words",
  SP.planQueueTabWrites([["Notes"]], [{ key: "a@x.com", source: "" }], SP.TENANT_QUEUE).problem,
  'The "🚯 Tenants to Cancel" tab has no Tenant column, so no tenants were listed there.');
// Google's side of the same planner: the source is left blank on purpose.
eq("a Google address is queued with its source cell untouched",
  SP.planQueueTabWrites([["Email Address", "Tenant / Inbox Source"], ["", "–"]],
    [{ key: "a@g.com", source: "" }], SP.GOOGLE_QUEUE).updates,
  [{ row: 2, column: 0, value: "a@g.com" }]);

// --- which inboxes ----------------------------------------------------------
console.log("--- the inboxes");
const INBOXES = [
  { id: "1", email: "a@burned.io", provider: "MICROSOFT365" },
  { id: "2", email: "b@burned.io", provider: "MICROSOFT365" },
  { id: "3", email: "c@burned.io", provider: "GOOGLE_WORKSPACE" },
  { id: "4", email: "a@other.io", provider: "MICROSOFT365" },
  { id: "5", email: "a@mail.burned.io", provider: "MICROSOFT365" },
  { id: "6", email: "a@smtp.io", provider: "REGULAR_ACCOUNT" },
];
const target = { workspaceId: "ws1", workspaceName: "W", name: "burned.io", domain: "burned.io" };
eq("a burned Microsoft domain takes every Microsoft mailbox on it",
  inboxesFor(target, INBOXES, "microsoft").map((i) => i.id), ["1", "2"]);
// The scan judged Microsoft mailboxes only, so a Google one on the same
// domain was never looked at — deleting it would act on evidence nobody
// gathered.
eq("…and never the Google one sharing the domain",
  inboxesFor(target, INBOXES, "microsoft").some((i) => i.id === "3"), false);
eq("a subdomain is a different domain", inboxesFor(target, INBOXES, "microsoft").some((i) => i.id === "5"), false);
eq("plain SMTP is never touched", inboxesFor({ ...target, name: "smtp.io", domain: "smtp.io" }, INBOXES, "microsoft"), []);
eq("a burned Google row takes that one address",
  inboxesFor({ workspaceId: "ws1", workspaceName: "W", name: "c@burned.io", domain: "burned.io" }, INBOXES, "google")
    .map((i) => i.id), ["3"]);
eq("a Google row matches its address whatever case the sheet used",
  inboxesFor({ workspaceId: "ws1", workspaceName: "W", name: "c@burned.io", domain: "burned.io" },
    [{ id: "9", email: "C@Burned.IO", provider: "GOOGLE_WORKSPACE" }], "google").map((i) => i.id), ["9"]);
eq("nothing left to delete is an empty list, not an error",
  inboxesFor(target, [], "microsoft"), []);

// --- what it says afterwards ------------------------------------------------
console.log("--- the summary");
eq("plurals", [inboxCount(1), inboxCount(0), inboxCount(12)], ["1 inbox", "0 inboxes", "12 inboxes"]);
const results = [
  { workspaceId: "w", workspaceName: "W", name: "a.io", domain: "a.io", state: "done", inboxesFound: 3, inboxesDeleted: 3 },
  { workspaceId: "w", workspaceName: "W", name: "b.io", domain: "b.io", state: "skipped", inboxesFound: 0, inboxesDeleted: 0 },
  { workspaceId: "w", workspaceName: "W", name: "c.io", domain: "c.io", state: "error", inboxesFound: 2, inboxesDeleted: 1 },
];
eq("the summary counts what happened, not what was asked for",
  describeRun(results, "microsoft"), "1 domain handled · 4 inboxes deleted · 1 left alone · 1 failed");
eq("a clean run says only the two numbers that matter",
  describeRun([results[0]], "google"), "1 inbox handled · 3 inboxes deleted");
eq("an empty run is still a sentence", describeRun([], "microsoft"), "0 domains handled · 0 inboxes deleted");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
