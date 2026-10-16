// Unit checks for gathering blocked inboxes into blocked domains, and the
// stats by ending, platform and provider. Imports the REAL module.
//
//   node scripts/check-blocked-inbox-domains.mjs

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

const m = await importTs("@/lib/blocked-inboxes/domains");

const job = (email, over = {}) => ({
  id: email, email, domain: email.split("@")[1], status: "deleted", createdAt: 1000, updatedAt: 1000,
  source: "clay", duplicateHits: 0, errors: [], verdict: "block", blockedAt: 1000, provider: "microsoft", ...over,
});

console.log("--- platforms, whichever source named them");
eq("the sheet's host and the registry's name land on one platform",
  [m.platformKey("Porkbun", undefined), m.platformKey(undefined, "Porkbun LLC"), m.platformKey(" porkbun.com ", undefined)],
  ["porkbun", "porkbun", "porkbun"]);
eq("one the app has no tag for keeps its name", [m.platformKey("GoDaddy", undefined), m.platformKey(undefined, "NameCheap, Inc.")], ["GoDaddy", "NameCheap"]);
eq("no source at all", m.platformKey(undefined, undefined), "Unknown platform");

console.log("--- blocked domains");
const jobs = [
  job("a@gronda.org", { blockedAt: 3000, domainHost: "Porkbun", workspaceName: "One Thing" }),
  job("b@gronda.org", { blockedAt: 2000, status: "awaiting_confirmation" }),
  job("c@other.com", { blockedAt: 1500, provider: "google", registrar: "Dynadot Inc" }),
  job("d@fine.com", { verdict: "pass", blockedAt: undefined, status: "passed" }),
];
const d = m.blockedDomains(jobs);
eq("only domains with a blocked inbox, most recent first", d.map((e) => e.domain), ["gronda.org", "other.com"]);
eq("…each with its blocked inboxes, newest first", d[0].inboxes.map((i) => i.email), ["a@gronda.org", "b@gronda.org"]);
eq("…counted, and how many are deleted", [d[0].blockedInboxes, d[0].deletedInboxes], [2, 1]);
eq("…with its ending, platform, provider and workspace", [d[0].tld, d[0].platform, d[0].provider, d[0].workspaceName], [".org", "porkbun", "Microsoft", "One Thing"]);
eq("…and the platform from the registry when the sheet has none", [d[1].platform, d[1].provider], ["dynadot", "Google"]);

console.log("--- stats, old domain runs included");
const old = [
  { id: "o1", domain: "gronda.org", createdAt: 500, inboxesQuarantined: 39, inboxesDeleted: 0, sheet: { domainHost: "Porkbun" }, providers: { google: 0, microsoft: 50, other: 0 } },
  { id: "o2", domain: "legacy.co", createdAt: 400, inboxesQuarantined: 10, inboxesDeleted: 10, registrar: "Spaceship, Inc.", providers: { google: 0, microsoft: 10, other: 0 } },
];
const s = m.statsEntries(jobs, old);
eq("a domain in both is counted once", s.map((e) => e.domain).sort(), ["gronda.org", "legacy.co", "other.com"]);
const g = s.find((e) => e.domain === "gronda.org");
eq("…with the old run's inboxes added", [g.blockedInboxes, g.deletedInboxes, g.fromDomainRun, g.firstBlockedAt], [41, 1, true, 500]);
const t = m.byTld(s);
eq("by ending", t.rows.map((r) => [r.key, r.domains, r.blockedInboxes]), [[".org", 1, 41], [".co", 1, 10], [".com", 1, 1]]);
eq("…as shares of blocked domains", t.rows.map((r) => m.percent(r.share)), ["33%", "33%", "33%"]);
eq("by platform, ties broken by blocked inboxes", m.byPlatform(s).rows.map((r) => [r.key, r.blockedInboxes]), [["porkbun", 41], ["spaceship", 10], ["dynadot", 1]]);
eq("by platform and ending together", m.byPlatformAndTld(s).rows.map((r) => r.key).sort(), ["dynadot · .com", "porkbun · .org", "spaceship · .co"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
