// Unit checks for General Settings: the defaults, reading a stored file,
// validating a save, retiring the old opt-out block — and that a changed
// setting actually reaches the tools that read it. Imports the REAL modules.
//
//   node scripts/check-general-settings.mjs

import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}\n   got  ${JSON.stringify(got)?.slice(0, 600)}\n   want ${JSON.stringify(want)?.slice(0, 600)}`);
  }
};

const GS = await importTs("@/lib/general-settings/settings");
const {
  DEFAULT_GENERAL_SETTINGS: D,
  SECTIONS,
  normalizeGeneralSettings,
  validateGeneralSettings,
  withRetiredOptOut,
  setGeneralSettings,
  generalSettings,
  generalSettingsState,
  spintaxOptions,
} = GS;
const clone = (v) => JSON.parse(JSON.stringify(v));
const { OPT_OUT_SPINTAX } = await importTs("@/lib/campaign-types/opt-out-spintax");
const { PREVIOUS_OPT_OUT_SPINTAX } = await importTs("@/lib/campaign-types/opt-out-spintax-previous");

console.log("--- the defaults are what the tools used before");
{
  eq("tags", [D.tags.googlePool, D.tags.microsoftPool, D.tags.active.name, D.tags.masterInbox, D.tags.rotationGroup1, D.tags.rotationGroup2], [
    { name: "google-pool", color: "#F59E0B" },
    { name: "microsoft-pool", color: "#3B82F6" },
    "active",
    "master inbox",
    "Sending Group 1",
    "Sending Group 2",
  ]);
  eq("TLD and platform lists", [D.tags.tld.map((t) => t.name), D.tags.platform.map((t) => t.name)], [
    [".co", ".com", ".digital", ".live", ".one", ".org", ".pro", ".biz"],
    ["porkbun", "dynadot", "namesilo", "spaceship", "name.com"],
  ]);
  eq("sheet", D.sheet, {
    url: "https://docs.google.com/spreadsheets/d/1V9F5NwK_hPBeDHgHcIz5APDd3VFL1ckzrxCAnVvBQFU/edit",
    domainsTab: "📋 Domains",
    tenantsTab: "👴 Tenants",
    tenantsToCancelTab: "🚯 Tenants to Cancel",
    googleInboxesToCancelTab: "🛑 Google Inboxes to Cancel",
    notActiveStatus: "Not Active",
    warmingUpStatus: "Warming Up",
  });
  eq("workspaces and capacity", [D.workspaces.excluded, D.capacity], [
    ["Ikoni Digital Lead Nurturing + Duplicate Workspace", "Inbox Warmup"],
    { google: 13, azure50: 3, azure25: 5 },
  ]);
  eq("opt-out: the current block, and the one before it", [D.optOut.current === OPT_OUT_SPINTAX, D.optOut.previous.length, D.optOut.previous[0] === PREVIOUS_OPT_OUT_SPINTAX], [true, 1, true]);
}

console.log("--- every setting has a field on the page, and every field a default");
{
  const fromSections = SECTIONS.flatMap((s) => s.fields.map((f) => `${s.key}.${f.key}`)).sort();
  const fromDefaults = Object.entries(D).flatMap(([s, v]) => Object.keys(v).map((k) => `${s}.${k}`)).sort();
  eq("the same keys", fromSections, fromDefaults);
  eq("no key twice", new Set(fromSections).size, fromSections.length);
  eq("each field names the tools it feeds", SECTIONS.flatMap((s) => s.fields).filter((f) => f.usedBy.length === 0).map((f) => f.key), []);
  eq("the defaults pass their own checks", validateGeneralSettings(clone(D)).problems, []);
}

console.log("--- reading a stored file");
{
  eq("nothing stored → the defaults", normalizeGeneralSettings(undefined), D);
  eq("garbage → the defaults", normalizeGeneralSettings("nope"), D);
  const stored = {
    sheet: { domainsTab: "  🗂 Domains  ", notActiveStatus: "" },
    capacity: { google: 20, azure50: -1 },
    tags: { tld: [{ name: ".xyz", color: "#123" }], googlePool: { name: "g-pool" } },
    unknownSection: { x: 1 },
  };
  const n = normalizeGeneralSettings(stored);
  eq("a good value is kept, trimmed", n.sheet.domainsTab, "🗂 Domains");
  eq("a bad value takes its default, the rest of the section stays", [n.sheet.notActiveStatus, n.sheet.tenantsTab], ["Not Active", "👴 Tenants"]);
  eq("numbers: good kept, out of range defaulted", [n.capacity.google, n.capacity.azure50, n.capacity.azure25], [20, 3, 5]);
  eq("a colour is normalised", n.tags.tld, [{ name: ".xyz", color: "#112233" }]);
  eq("a tag with no colour takes its default", n.tags.googlePool, D.tags.googlePool);
  eq("sections nobody stored are the defaults", n.optOut.current === OPT_OUT_SPINTAX, true);
}

console.log("--- validating a save");
{
  const bad = clone(D);
  bad.sheet.domainsTab = "   ";
  bad.tags.tld.push({ name: ".COM", color: "#000000" });
  bad.tags.active.color = "green";
  bad.capacity.google = 2.5;
  bad.optOut.current = "{{Random | a | b}}";
  bad.sheet.url = "docs.google.com/x";
  const { settings, problems } = validateGeneralSettings(bad);
  eq("refused whole", settings, null);
  eq("each problem named with its section and field", problems, [
    'Tags → TLD tags has ".COM" twice.',
    'Tags → Active sending tag "active" needs a colour like #10B981.',
    "Google Sheet → Sheet link needs to be a link starting with https://.",
    "Google Sheet → Domains tab can't be empty.",
    "Sending capacity → Google inbox needs to be a whole number from 0 to 1000.",
    "Opt-out text → Current opt-out block needs at least 5 options, so it can be told apart from a greeting or sign-off.",
  ]);
  const clash = clone(D);
  clash.tags.rotationGroup2 = "Google-Pool";
  eq("two tags that must differ can't share a name", validateGeneralSettings(clash).problems, ['Tags → Google pool tag and Rotation group 2 tag are both "google-pool".']);
  const lines = clone(D);
  lines.workspaces.excluded = ["  A  ", "", "a", "B"];
  eq("list lines are trimmed, blanks and repeats dropped", validateGeneralSettings(lines).settings.workspaces.excluded, ["A", "B"]);
  eq("an unclosed spintax block is refused", validateGeneralSettings({ optOut: { current: "{{Random | a | b | c | d | e {{x}" } }).problems.length, 1);
  eq("spintax options are split at the top level only", spintaxOptions("{{Random | a {{first_name}} | b|c }}"), ["a {{first_name}}", "b", "c"]);
}

console.log("--- changing the opt-out block keeps the old one recognised");
{
  const NEW = "{{Random | Not for you? Reply stop. | Wrong person? Say so. | Reply no and I'll go. | Just say pass. | Reply nope and that's that.}}";
  const next = clone(D);
  next.optOut.current = NEW;
  const stored = withRetiredOptOut(D, next);
  eq("the replaced block joins the older versions", [stored.optOut.previous.length, stored.optOut.previous[1] === OPT_OUT_SPINTAX], [2, true]);
  eq("…once, however often it is saved", withRetiredOptOut(D, stored).optOut.previous.length, 2);
  eq("no change, nothing added", withRetiredOptOut(D, clone(D)).optOut.previous.length, 1);
}

console.log("--- a changed setting reaches the tools");
{
  const custom = clone(D);
  custom.tags.googlePool = { name: "g-pool", color: "#111111" };
  custom.tags.active = { name: "Sending", color: "#222222" };
  custom.tags.rotationGroup1 = "Group A";
  custom.tags.platform = [...D.tags.platform, { name: "godaddy", color: "#333333" }];
  custom.sheet.googleInboxesToCancelTab = "Google to cancel";
  custom.sheet.notActiveStatus = "Dead";
  custom.workspaces.excluded = ["Sandbox"];
  custom.capacity.google = 20;
  const NEW = "{{Random | Not for you? Reply stop. | Wrong person? Say so. | Reply no and I'll go. | Just say pass. | Reply nope and that's that.}}";
  custom.optOut.current = NEW;
  const before = generalSettingsState().version;
  setGeneralSettings(withRetiredOptOut(D, custom), 123);
  eq("in force, with a new version", [generalSettings().sheet.notActiveStatus, generalSettingsState().version > before, generalSettingsState().updatedAt], ["Dead", true, 123]);

  const { POOL_TAGS } = await importTs("@/lib/campaign-types/pools");
  const { poolTagSet } = await importTs("@/lib/tags/pool-tags");
  eq("pool tags (Create All Campaign Types, Bulk Actions)", [POOL_TAGS.google.name, poolTagSet()[0]], ["g-pool", { name: "g-pool", color: "#111111" }]);

  const { GROUP_TAG_NAMES } = await importTs("@/lib/inbox-rotation/settings");
  eq("rotation group tags (Inbox Rotation)", [GROUP_TAG_NAMES[1], GROUP_TAG_NAMES[2]], ["Group A", "Sending Group 2"]);

  const { sendingTagName } = await importTs("@/lib/first-campaign/blueprint");
  eq("active tag (New Workspace 1st Campaign)", sendingTagName(), "Sending");

  const cap = await importTs("@/lib/capacity/capacity");
  eq("capacity and exclusions (Sending Capacity)", [cap.DAILY_PER_INBOX.google, cap.isExcluded(" sandbox "), cap.isExcluded("Inbox Warmup")], [20, true, false]);
  const { isDefaultExcluded } = await importTs("@/app/tools/remove-inboxes/constants");
  eq("…and Remove Inboxes", isDefaultExcluded("SANDBOX"), true);

  const sp = await importTs("@/lib/blocked-domains/sheet-plan");
  eq("cancel tab (Blocked Domains)", sp.GOOGLE_QUEUE.tab, "Google to cancel");

  const R = await importTs("@/lib/burned/removal");
  const grid = [["Domain", "Status"], ["a.com", "Active"], ["b.com", "dead"]];
  const plan = R.planDomainsTab(grid, ["a.com", "b.com"], { domain: "Domain", status: "Status", tenantEmail: "Tenant Email Address", tenantSource: "Tenant / Inbox Source" }, "📋 Domains");
  eq("status written (Find Burned Domains)", [plan.updates.map((u) => u.value), plan.lookups.map((l) => !!l.statusAlready)], [["Dead"], [false, true]]);

  const { platformKey } = await importTs("@/lib/blocked-inboxes/domains");
  eq("platform list (Blocked Domains stats)", platformKey("GoDaddy.com", undefined), "godaddy");

  const A = await importTs("@/lib/campaign-types/append-opt-out");
  const plain = A.withCurrentOptOut("<div>Hi</div>");
  eq("opt-out: a body without one gets the new block", [plain.outcome, plain.body.endsWith(`<div>${NEW}</div>`)], ["added", true]);
  const old = A.withCurrentOptOut(`<div>Hi</div><div>&nbsp;</div><div>${OPT_OUT_SPINTAX}</div>`);
  eq("…the block it replaced is swapped, not stacked", [old.outcome, old.body.includes(NEW), old.body.includes("I'll leave with a smile")], ["replaced", true, false]);
  eq("…the new one is left alone", A.withCurrentOptOut(plain.body).outcome, "present");
  eq("…and a block from before that too", A.withCurrentOptOut(`<div>x</div><div>${PREVIOUS_OPT_OUT_SPINTAX}</div>`).outcome, "replaced");

  setGeneralSettings(clone(D), 0);
  eq("back to the defaults", [POOL_TAGS.google.name, sp.GOOGLE_QUEUE.tab, A.withCurrentOptOut(`<div>${OPT_OUT_SPINTAX}</div>`).outcome], ["google-pool", "🛑 Google Inboxes to Cancel", "present"]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
