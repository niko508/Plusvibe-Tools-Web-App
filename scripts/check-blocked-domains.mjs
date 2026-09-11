// Unit checks for the Blocked Domains automation: what counts as the same
// domain, which inboxes a block matches, and what gets written to the sheet.
//
// Imports the real modules through scripts/ts-loader.mjs.
//
//   node scripts/check-blocked-domains.mjs

import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(
      `FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`
    );
  }
};
const ok = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
};

const d = await importTs("@/lib/blocked-domains/domain");
const sp = await importTs("@/lib/blocked-domains/sheet-plan");

// --- Domain normalization ---------------------------------------------------
console.log("--- domain normalization");
eq("a plain domain", d.normalizeDomain("lavasi.pro"), "lavasi.pro");
eq("case folded", d.normalizeDomain("LaVaSi.PRO"), "lavasi.pro");
eq("padding trimmed", d.normalizeDomain("  lavasi.pro  "), "lavasi.pro");
// Bounce text and Slack defang links; Clay may pass that through verbatim.
eq("defanged with spaces", d.normalizeDomain("trovino . click"), "trovino.click");
eq("defanged with brackets", d.normalizeDomain("trovino[.]click"), "trovino.click");
eq("a full URL", d.normalizeDomain("https://redcrest.site/path?x=1"), "redcrest.site");
eq("a URL with a port", d.normalizeDomain("http://redcrest.site:8080/x"), "redcrest.site");
eq("an email address", d.normalizeDomain("bob@lavasi.pro"), "lavasi.pro");
eq("a leading @", d.normalizeDomain("@lavasi.pro"), "lavasi.pro");
eq("a trailing root dot", d.normalizeDomain("lavasi.pro."), "lavasi.pro");
eq("a multi-label domain", d.normalizeDomain("mail.lavasi.co.uk"), "mail.lavasi.co.uk");
eq("a hyphenated domain", d.normalizeDomain("the-grow-wire.one"), "the-grow-wire.one");

// Anything unreadable must be rejected outright rather than guessed at — this
// value drives deletion.
console.log("--- rejected input");
for (const bad of [
  "", "   ", "not a domain", "lavasi", "lavasi.", ".pro", "-lavasi.pro",
  "lavasi-.pro", "lavasi..pro?", "http://", "@", null, undefined, 42, {},
]) {
  ok(`rejects ${JSON.stringify(bad)}`, d.normalizeDomain(bad) === null,
    String(d.normalizeDomain(bad)));
}
ok("rejects an over-long name", d.normalizeDomain("a".repeat(250) + ".com") === null);

// --- Inbox matching ---------------------------------------------------------
console.log("--- inbox matching");
eq("the domain of an address", d.domainOfEmail("Bob@Lavasi.PRO"), "lavasi.pro");
eq("a plus-addressed inbox", d.domainOfEmail("bob+news@lavasi.pro"), "lavasi.pro");
eq("no @ means no domain", d.domainOfEmail("lavasi.pro"), null);
ok("an inbox on the domain matches", d.inboxIsOnDomain("bob@lavasi.pro", "lavasi.pro"));
ok("case is ignored", d.inboxIsOnDomain("BOB@LAVASI.PRO", "lavasi.pro"));
// The critical one: matching by suffix would let a block on one domain delete
// inboxes on every domain that merely ends the same way.
ok("a subdomain does NOT match", !d.inboxIsOnDomain("bob@mail.lavasi.pro", "lavasi.pro"));
ok("a longer domain does NOT match", !d.inboxIsOnDomain("bob@notlavasi.pro", "lavasi.pro"));
ok("a different TLD does NOT match", !d.inboxIsOnDomain("bob@lavasi.com", "lavasi.pro"));
ok("junk does not match", !d.inboxIsOnDomain("", "lavasi.pro"));

// --- The Domains tab --------------------------------------------------------
console.log("--- domains tab");
const DOMAINS = [
  ["Domain", "Tenant Email Address", "Status", "Warmup Started", "Warmup Days",
   "Domain Host", "Infra Type", "Tenant / Inbox Source", "Client"],
  ["sparkfirm.pro", "admin@spark.onmicrosoft.com", "Active", "", "", "Dynadot",
   "Azure", "Cheap Inboxes", "Essence Growth"],
  ["lavasi.pro", "admin@lava.onmicrosoft.com", "Active", "", "", "Dynadot",
   "Azure", "CGC", "Digital Time Savers"],
  ["leadbase.one", "", "Not Active", "", "", "Dynadot", "Azure", "Cheap Inboxes", ""],
];
const header = DOMAINS[0];
const cols = {
  domain: sp.headerIndex(header, "Domain"),
  status: sp.headerIndex(header, "Status"),
  tenantEmail: sp.headerIndex(header, "Tenant Email Address"),
  tenantSource: sp.headerIndex(header, "Tenant / Inbox Source"),
  client: sp.headerIndex(header, "Client"),
};
eq("header lookup is case-insensitive", sp.headerIndex(header, "  status  "), 2);
eq("a missing header is -1", sp.headerIndex(header, "Nope"), -1);

const hit = sp.findDomainRow(DOMAINS, "lavasi.pro", cols);
eq("one match", hit.matches, 1);
// Row 3 of the sheet: header is row 1, sparkfirm row 2.
eq("the 1-based sheet row", hit.row.rowNumber, 3);
eq("the tenant to cancel", hit.row.tenantEmail, "admin@lava.onmicrosoft.com");
eq("the tenant source", hit.row.tenantSource, "CGC");
eq("the client hint", hit.row.client, "Digital Time Savers");
eq("the status it will replace", hit.row.currentStatus, "Active");
// A domain arriving in any of the shapes above must still find its row.
eq("a defanged domain finds the row",
  sp.findDomainRow(DOMAINS, "lavasi . pro", cols).row.rowNumber, 3);
eq("an unknown domain finds nothing",
  sp.findDomainRow(DOMAINS, "nowhere.pro", cols).row, null);
// A duplicate listing takes the first row but reports the count, so a sheet
// problem is visible rather than half-handled.
const dupGrid = [...DOMAINS, ["lavasi.pro", "x@y.com", "Active", "", "", "", "", "", ""]];
const dup = sp.findDomainRow(dupGrid, "lavasi.pro", cols);
eq("duplicates are counted", dup.matches, 2);
eq("the first row still wins", dup.row.rowNumber, 3);
eq("the blocked status", sp.BLOCKED_STATUS, "Not Active");

// --- The Tenants to Cancel tab ----------------------------------------------
console.log("--- tenants to cancel");
const CANCEL_HEADER = ["Tenant", "Tenant / Inbox Source", "", ""];
const row = sp.buildCancelRow(CANCEL_HEADER, {
  tenant: "admin@lava.onmicrosoft.com",
  source: "CGC",
});
eq("the row matches the header width", row.length, 4);
eq("tenant and source land in their columns", row.slice(0, 2),
  ["admin@lava.onmicrosoft.com", "CGC"]);
eq("other columns are left blank", row.slice(2), ["", ""]);
// Column order is read from the header, so reordering the tab can't write the
// tenant into the source column.
eq("a reordered header still writes correctly",
  sp.buildCancelRow(["Tenant / Inbox Source", "Tenant"],
    { tenant: "a@b.com", source: "CGC" }),
  ["CGC", "a@b.com"]);

// The tab is append-only, so a second blocked domain on the same tenant must
// not queue it twice.
const CANCEL_GRID = [CANCEL_HEADER, ["admin@lava.onmicrosoft.com", "CGC", "", ""]];
ok("an already-queued tenant is detected",
  sp.tenantAlreadyQueued(CANCEL_GRID, 0, "admin@lava.onmicrosoft.com"));
ok("case and padding are ignored",
  sp.tenantAlreadyQueued(CANCEL_GRID, 0, "  ADMIN@Lava.onmicrosoft.com "));
ok("a new tenant is not queued",
  !sp.tenantAlreadyQueued(CANCEL_GRID, 0, "admin@other.onmicrosoft.com"));
ok("a blank tenant is never 'already queued'",
  !sp.tenantAlreadyQueued(CANCEL_GRID, 0, "   "));
ok("an empty tab queues nothing", !sp.tenantAlreadyQueued([CANCEL_HEADER], 0, "a@b.com"));

// --- the Google path ---------------------------------------------------------
// Google Workspace has no tenant: burned inboxes are listed one per row, and
// the domain goes Not Active only once every inbox is burned.
eq("the constants match the real tab", [sp.GOOGLE_CANCEL_TAB, sp.COL_GOOGLE_EMAIL], ["🛑 Google Inboxes to Cancel", "Email Address"]);
const GH = ["Email Address", "Tenant / Inbox Source"];
eq("a Google inbox row lands under its columns",
  sp.buildGoogleCancelRow(GH, { email: "a@x.com", source: "Cheap Inboxes" }), ["a@x.com", "Cheap Inboxes"]);
eq("…whatever the column order",
  sp.buildGoogleCancelRow(["Tenant / Inbox Source", "Notes", "Email Address"], { email: "a@x.com", source: "S" }), ["S", "", "a@x.com"]);
eq("…and a tab missing the column gets nothing written into the wrong place",
  sp.buildGoogleCancelRow(["Notes"], { email: "a@x.com", source: "S" }), [""]);
// The real tab carries placeholder rows with an empty address and a dash for
// the source; those must not count as "already listed".
const GG = [GH, ["old@x.com", "S"], ["", "–"], ["", "–"]];
eq("only inboxes not yet on the tab are queued, once each",
  sp.googleInboxesToQueue(GG, 0, ["new@x.com", "OLD@x.com ", "new@x.com", "", "  "]),
  { toQueue: ["new@x.com"], alreadyQueued: ["old@x.com"] });
eq("an empty tab queues everything", sp.googleInboxesToQueue([GH], 0, ["a@x.com", "b@x.com"]).toQueue, ["a@x.com", "b@x.com"]);
eq("a missing column queues nothing as already listed", sp.googleInboxesToQueue(GG, -1, ["old@x.com"]).toQueue, ["old@x.com"]);
eq("a Google-majority domain takes the Google path", sp.isGoogleDomain({ google: 49, microsoft: 1, other: 0 }), true);
eq("…a Microsoft one does not", sp.isGoogleDomain({ google: 1, microsoft: 49, other: 0 }), false);
eq("…nor a tie", sp.isGoogleDomain({ google: 2, microsoft: 2, other: 0 }), false);
eq("…nor a record from before providers were captured", sp.isGoogleDomain(undefined), false);
// A record handled before the Google path: what still needs listing is what
// it stopped or deleted, minus what it has listed since.
eq("an older record's burned inboxes are all still to list",
  sp.googleInboxesToList({ quarantinedEmails: ["One@old.com", "two@old.com"], deletedEmails: ["two@old.com", "three@old.com"] }),
  ["one@old.com", "two@old.com", "three@old.com"]);
eq("…the assessment's stopped inboxes count too",
  sp.googleInboxesToList({ performance: { inboxes: [{ email: "a@x.com", decision: "stop" }, { email: "b@x.com", decision: "keep" }] } }),
  ["a@x.com"]);
eq("…and what is already on the tab is left out",
  sp.googleInboxesToList({ quarantinedEmails: ["a@x.com", "b@x.com"], sheet: { googleQueued: ["A@x.com"], googleAlreadyQueued: ["b@x.com"] } }),
  []);
eq("a record with nothing stopped has nothing to list", sp.googleInboxesToList({}), []);
eq("…nor one with no inboxes", sp.isGoogleDomain({ google: 0, microsoft: 0, other: 0 }), false);

// --- Already Not Active -----------------------------------------------------
// The status and the tenant are separate records. A domain someone already
// marked Not Active by hand is exactly the case where its tenant is most
// likely to have been forgotten, so the lookup must not skip it.
console.log("--- a domain already marked Not Active");
const ALREADY = [
  DOMAINS[0],
  ["deadco.pro", "admin@dead.onmicrosoft.com", "Not Active", "", "", "Dynadot",
   "Azure", "", "Some Client"],
];
const already = sp.findDomainRow(ALREADY, "deadco.pro", cols);
ok("an already-Not-Active domain is still found", already.row !== null);
eq("its tenant is still available", already.row.tenantEmail,
  "admin@dead.onmicrosoft.com");
eq("the status it already had is reported", already.row.currentStatus, "Not Active");
// Its source is blank in Domains, which must write a blank cell rather than
// being skipped — the tenant still has to be queued.
eq("a blank source still produces a row",
  sp.buildCancelRow(CANCEL_HEADER, {
    tenant: already.row.tenantEmail,
    source: already.row.tenantSource,
  }),
  ["admin@dead.onmicrosoft.com", "", "", ""]);
ok("and it is not already queued",
  !sp.tenantAlreadyQueued(CANCEL_GRID, 0, already.row.tenantEmail));

// --- Client to workspace ----------------------------------------------------
console.log("--- client to workspace");
const WS = [
  { _id: "w1", name: "Digital Time Savers" },
  { _id: "w2", name: "Essence Growth" },
  { _id: "w3", name: "Dimension6" },
];
eq("an exact client name", sp.matchWorkspaceByClient("Digital Time Savers", WS), "w1");
eq("case and padding ignored", sp.matchWorkspaceByClient("  essence growth ", WS), "w2");
eq("a partial name with one candidate",
  sp.matchWorkspaceByClient("Dimension", WS), "w3");
eq("a blank client is no hint", sp.matchWorkspaceByClient("", WS), null);
eq("an unknown client is no hint", sp.matchWorkspaceByClient("Nobody Ltd", WS), null);
// Two plausible candidates is not a hint worth acting on — the run falls back
// to scanning, which is slower but can't target the wrong client's inboxes.
eq("an ambiguous name is no hint",
  sp.matchWorkspaceByClient("Growth", [
    { _id: "a", name: "Essence Growth" },
    { _id: "b", name: "Growth Partners" },
  ]),
  null
);

console.log(
  failures === 0 ? "\nall blocked-domain checks OK" : `\n${failures} failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
