// Unit checks for the Remove Inboxes list parsing and matching — both the
// long-standing domain mode and the address mode. Imports the REAL module.
//
//   node scripts/check-remove-inboxes.mjs

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
const check = (label, ok, detail = "") => {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? `\n   ${detail}` : ""}`);
  }
};

const {
  parseDomains,
  parseEmails,
  normalizeEmailToken,
  domainsOfEmails,
  matchDomains,
  matchEmails,
} = await importTs("@/app/tools/remove-inboxes/parse");

// --- Domain mode is unchanged ----------------------------------------------
eq(
  "domains come back lower-cased, de-duplicated and sorted",
  parseDomains("Acme.com, acme.io\nACME.COM"),
  ["acme.com", "acme.io"]
);
eq(
  "a pasted address still yields its domain in domain mode",
  parseDomains("joe@acme.com"),
  ["acme.com"]
);

// --- One address at a time --------------------------------------------------
eq("a plain address", normalizeEmailToken("Joe.D@Acme.com"), "joe.d@acme.com");
eq("a mailto: link", normalizeEmailToken("mailto:sara@acme.io"), "sara@acme.io");
eq(
  "a spreadsheet cell with a display name",
  normalizeEmailToken("Sara Lee <sara@acme.io>"),
  "sara@acme.io"
);
eq("a trailing comma from a CSV", normalizeEmailToken("joe@acme.com,"), "joe@acme.com");
eq("a bare domain is not an address", normalizeEmailToken("acme.com"), null);
eq("a local part alone is not an address", normalizeEmailToken("joe@"), null);
eq("a domain with no dot is not an address", normalizeEmailToken("joe@acme"), null);

// --- The pasted block -------------------------------------------------------
const parsed = parseEmails("Joe@Acme.com\nsara@acme.io\njoe@acme.com\nacme.com\nEmail Address");
eq("addresses are de-duplicated case-insensitively and sorted", parsed.emails, [
  "joe@acme.com",
  "sara@acme.io",
]);
eq(
  "everything that is not an address is reported, not dropped silently",
  parsed.skipped,
  ["acme.com", "Email", "Address"]
);
eq("an empty paste yields nothing", parseEmails("  \n \n").emails, []);
eq(
  "the domains behind the addresses are what the scan needs",
  domainsOfEmails(["joe@acme.com", "sara@acme.io", "kim@acme.com"]),
  ["acme.com", "acme.io"]
);

// --- Matching against a scanned index --------------------------------------
const entry = (email, workspaceName, workspace_id) => ({
  workspace_id,
  workspaceName,
  email,
  domain: email.slice(email.lastIndexOf("@") + 1).toLowerCase(),
  accountId: `id-${email}`,
});
const index = new Map([
  [
    "acme.com",
    [
      entry("joe@acme.com", "Client A", "w1"),
      entry("Kim@Acme.com", "Client A", "w1"),
      entry("pat@acme.com", "Client B", "w2"),
    ],
  ],
  ["acme.io", [entry("sara@acme.io", "Client A", "w1")]],
]);

const dm = matchDomains(["acme.com", "nope.com"], index);
eq("a matched domain takes every inbox on it", dm.matched[0].inboxes.length, 3);
eq("…and names its workspaces", dm.matched[0].workspaces, ["Client A", "Client B"]);
eq("…while an unknown domain is not found", dm.notFound, ["nope.com"]);

const im = matchEmails(
  ["joe@acme.com", "kim@acme.com", "sara@acme.io", "ghost@acme.com"],
  index,
  new Set()
);
eq(
  "only the named mailboxes are taken, grouped under their domain",
  im.matched.map((m) => [m.domain, m.inboxes.map((i) => i.email)]),
  [
    ["acme.com", ["joe@acme.com", "Kim@Acme.com"]],
    ["acme.io", ["sara@acme.io"]],
  ]
);
check(
  "…so the third inbox on that domain is left alone",
  !im.matched
    .flatMap((m) => m.inboxes)
    .some((i) => i.email.toLowerCase() === "pat@acme.com")
);
eq("…an address with no inbox is not found", im.notFound, ["ghost@acme.com"]);
eq("…and nothing is reported as protected", im.protectedMaster, []);
eq(
  "matching an address is case-insensitive on both sides",
  matchEmails(["KIM@ACME.COM"], index, new Set()).matched[0].inboxes[0].email,
  "Kim@Acme.com"
);

const pm = matchEmails(
  ["master@acme.com", "ghost@acme.com"],
  index,
  new Set(["master@acme.com"])
);
eq(
  "a Master Inbox address is called protected, not missing",
  [pm.protectedMaster, pm.notFound],
  [["master@acme.com"], ["ghost@acme.com"]]
);
eq("…and it is never queued for deletion", pm.matched, []);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
