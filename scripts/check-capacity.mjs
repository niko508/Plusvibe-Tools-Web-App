// Unit checks for Sending Capacity: which workspaces are counted, how inboxes
// are sorted by what their domain runs on, and the emails-a-day that come out.
// Imports the REAL modules.
//
//   node scripts/check-capacity.mjs

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

const C = await importTs("@/lib/capacity/capacity");
const {
  DAILY_PER_INBOX, excludedWorkspaces, isExcluded, CAPACITY_ORDER, COLUMN_LABELS,
  capacityOf, capacityFrom, totalsOf, sortRows, emptyCounts, toCsv, csvNameFor, describeRates,
} = C;

const G = "GOOGLE_WORKSPACE", M = "MICROSOFT365", R = "REGULAR_ACCOUNT";
/** n inboxes on one domain, all on the same provider. */
const seats = (n, domain, provider) =>
  Array.from({ length: n }, (_, i) => ({ email: `u${i}@${domain}`, provider }));

// --- the rates ---------------------------------------------------------------
console.log("--- the rates");
eq("a day's capacity per inbox, as asked", DAILY_PER_INBOX, { google: 13, azure50: 3, azure25: 5 });
eq("the columns read Google first", CAPACITY_ORDER, ["google", "azure50", "azure25"]);
eq("…named as the table names them",
  CAPACITY_ORDER.map((c) => COLUMN_LABELS[c]), ["Google Inboxes", "Azure 50 Inboxes", "Azure 25 Inboxes"]);
eq("the rates read back in words", describeRates(),
  "Google Inboxes 13 · Azure 50 Inboxes 3 · Azure 25 Inboxes 5 emails per inbox per day");

// --- the workspaces that never count -----------------------------------------
console.log("--- the exclusions");
const EXCLUDED_WORKSPACES = excludedWorkspaces();
eq("the two that never send to prospects are named (General Settings default)",
  EXCLUDED_WORKSPACES, ["Ikoni Digital Lead Nurturing + Duplicate Workspace", "Inbox Warmup"]);
eq("…and are recognised", EXCLUDED_WORKSPACES.map(isExcluded), [true, true]);
// Matched on the name, so stray spacing or case in Plusvibe cannot slip one in.
eq("…whatever the case or padding", isExcluded("  inbox warmup "), true);
eq("anything else counts", ["Ikoni Digital", "Warmup", "Media Manager", ""].map(isExcluded), [false, false, false, false]);

// --- counting one workspace ---------------------------------------------------
console.log("--- one workspace");
const ws = { workspaceId: "w1", workspaceName: "Media Manager" };
// Google is Google however many seats sit on the domain.
eq("three Google seats are three Google inboxes",
  capacityOf(ws, seats(3, "g.com", G)).counts, { google: 3, azure50: 0, azure25: 0 });
// The Azure split is a property of the DOMAIN — how many share it — so all of
// a 30-seat domain's mailboxes are Azure 50, not just the six over the line.
eq("a 30-seat Microsoft domain is thirty Azure 50 inboxes",
  capacityOf(ws, seats(30, "big.io", M)).counts, { google: 0, azure50: 30, azure25: 0 });
eq("…and a 25-seat one is twenty-five Azure 25s",
  capacityOf(ws, seats(25, "small.io", M)).counts, { google: 0, azure50: 0, azure25: 25 });
eq("the split falls at 25", [25, 26].map((n) => capacityOf(ws, seats(n, "d.io", M)).counts),
  [{ google: 0, azure50: 0, azure25: 25 }, { google: 0, azure50: 26, azure25: 0 }]);
// Two Microsoft domains of different sizes land in different columns.
eq("each domain is judged on its own size",
  capacityOf(ws, [...seats(30, "big.io", M), ...seats(4, "small.io", M)]).counts,
  { google: 0, azure50: 30, azure25: 4 });

// Anything on neither provider is counted apart rather than given a rate.
const mixed = capacityOf(ws, [...seats(2, "g.com", G), ...seats(3, "smtp.io", R)]);
eq("plain SMTP carries no capacity here", [mixed.counts.google, mixed.uncategorized, mixed.inboxes], [2, 3, 5]);
eq("…and an address with no domain is counted apart too",
  capacityOf(ws, [{ email: "not-an-address", provider: G }]).uncategorized, 1);
eq("an empty workspace is zeroes, not an error",
  [capacityOf(ws, []).counts, capacityOf(ws, []).total], [emptyCounts(), 0]);

// --- the emails a day ---------------------------------------------------------
console.log("--- the capacity");
eq("Google at 13, Azure 50 at 3, Azure 25 at 5",
  capacityFrom({ google: 10, azure50: 100, azure25: 20 }),
  { google: 130, microsoft: 400, total: 530 });
eq("Microsoft is the two Azure columns added", capacityFrom({ google: 0, azure50: 50, azure25: 25 }).microsoft, 275);
eq("nothing is nothing", capacityFrom(emptyCounts()), { google: 0, microsoft: 0, total: 0 });
const one = capacityOf(ws, [...seats(3, "g.com", G), ...seats(30, "big.io", M), ...seats(4, "small.io", M)]);
eq("a workspace's own row adds up", [one.google, one.microsoft, one.total], [39, 110, 149]);

// --- adding the workspaces up --------------------------------------------------
console.log("--- the overview");
const rows = [
  capacityOf({ workspaceId: "a", workspaceName: "Alpha" }, seats(3, "g.com", G)),
  capacityOf({ workspaceId: "b", workspaceName: "Beta" }, [...seats(30, "big.io", M), ...seats(2, "smtp.io", R)]),
  capacityOf({ workspaceId: "c", workspaceName: "Ceta" }, seats(10, "s.io", M)),
];
const t = totalsOf(rows);
eq("the counts are summed", t.counts, { google: 3, azure50: 30, azure25: 10 });
eq("…and so are the capacities", [t.google, t.microsoft, t.total], [39, 140, 179]);
eq("…with the workspaces and inboxes counted", [t.workspaces, t.inboxes, t.uncategorized], [3, 45, 2]);
eq("nothing counted is all zeroes",
  totalsOf([]), { counts: emptyCounts(), workspaces: 0, inboxes: 0, uncategorized: 0, google: 0, microsoft: 0, total: 0 });
// The table is read to find where the capacity is, so the biggest is first —
// by EMAILS A DAY, not inbox count: ten Azure 25s outsend three Google seats.
eq("biggest sender first",
  sortRows(rows).map((r) => [r.workspaceName, r.total]), [["Beta", 90], ["Ceta", 50], ["Alpha", 39]]);

// --- what comes out -------------------------------------------------------------
console.log("--- the CSV");
const csv = toCsv(sortRows(rows)).split("\n");
eq("the header matches the table", csv[0],
  "workspace,google_inboxes,azure_50_inboxes,azure_25_inboxes,google_capacity,microsoft_capacity,total_capacity");
eq("a row carries its counts and its capacities", csv[1], "Beta,0,30,0,0,90,90");
// The file answers the same question the overview does, without adding up by hand.
eq("…and the last line is the total", csv[csv.length - 1], "All workspaces,3,30,10,39,140,179");
eq("a workspace name with a comma is quoted",
  toCsv([capacityOf({ workspaceId: "x", workspaceName: "Ikoni, Digital" }, seats(1, "g.com", G))]).split("\n")[1],
  '"Ikoni, Digital",1,0,0,13,0,13');
eq("the file is named for the day", csvNameFor(new Date("2026-09-21T10:00:00Z")), "sending-capacity-2026-09-21.csv");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
