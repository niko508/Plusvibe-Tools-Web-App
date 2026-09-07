// Unit checks for the Blocked Domains stats: which endings and which hosts the
// blocks come from. Imports the REAL module.
//
//   node scripts/check-blocked-stats.mjs

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

const m = await importTs("@/lib/blocked-domains/stats");
const { byTld, byHost, byHostAndTld, tldKeyOf, hostKeyOf, wasWrittenOff, percent, UNKNOWN_HOST, UNKNOWN_TLD } = m;

const job = (domain, over = {}) => ({
  id: domain + Math.random(), domain, status: "done", phaseStates: { sheet: "done" },
  inboxesQuarantined: 0, inboxesDeleted: 0, ...over,
});
const host = (h) => ({ sheet: { statusUpdated: true, tenantQueued: true, domainHost: h } });

// --- keys ------------------------------------------------------------------
eq("the ending of a domain", tldKeyOf("dretull.co"), ".co");
eq("…of a longer one", tldKeyOf("growunit.one"), ".one");
eq("no ending gets a placeholder", tldKeyOf("localhost"), UNKNOWN_TLD);
eq("the host as the sheet spelled it", hostKeyOf(job("a.co", host("Spaceship"))), "Spaceship");
eq("…trimmed", hostKeyOf(job("a.co", host("  Porkbun "))), "Porkbun");
eq("no host gets a placeholder", hostKeyOf(job("a.co")), UNKNOWN_HOST);
eq("…so does a blank one", hostKeyOf(job("a.co", host(""))), UNKNOWN_HOST);

// --- written off or kept -----------------------------------------------------
eq("a kept domain was not written off", wasWrittenOff(job("a.co", { status: "kept", sheet: { statusUpdated: false } })), false);
eq("a sheet write means written off", wasWrittenOff(job("a.co", host("x"))), true);
eq("an old record that reached the sheet step counts", wasWrittenOff(job("a.co", { phaseStates: { sheet: "done" } })), true);
eq("…but one that never did doesn't", wasWrittenOff(job("a.co", { phaseStates: { sheet: "skipped" }, sheet: { statusUpdated: false } })), false);

// --- the breakdowns ------------------------------------------------------------
const JOBS = [
  job("a.co", { ...host("Spaceship"), inboxesQuarantined: 50, inboxesDeleted: 50 }),
  job("b.co", { ...host("Spaceship"), inboxesQuarantined: 40 }),
  job("c.co", { ...host("Porkbun"), inboxesQuarantined: 10 }),
  job("d.live", { ...host("Spaceship"), status: "kept", sheet: { statusUpdated: false, domainHost: "Spaceship" }, inboxesQuarantined: 1 }),
  job("e.one", { ...host("Dynadot") }),
  job("f.one", {}), // no host known
  job("a.co", { ...host("Spaceship"), rearmedAt: 1 }), // the same domain, flagged again after a re-arm
];

const tld = byTld(JOBS);
eq("total is every block", tld.total, 7);
eq("endings in order of blocks", tld.rows.map((r) => [r.key, r.count]), [[".co", 4], [".one", 2], [".live", 1]]);
eq("share adds to one", Math.round(tld.rows.reduce((n, r) => n + r.share, 0) * 100), 100);
eq(".co is 4 of 7", percent(tld.rows[0].share), "57%");
eq("a re-armed domain is one domain but two blocks", tld.rows[0].domains === 3 && tld.rows[0].count === 4, true);
eq("stopped and deleted inboxes add up per ending", [tld.rows[0].inboxesStopped, tld.rows[0].inboxesDeleted], [100, 50]);
eq("written off vs kept per ending", tld.rows.map((r) => [r.key, r.writtenOff, r.kept]), [[".co", 4, 0], [".one", 2, 0], [".live", 0, 1]]);

const hosts = byHost(JOBS);
eq("hosts in order of blocks, unknown last among equals", hosts.rows.map((r) => [r.key, r.count]), [["Spaceship", 4], ["Dynadot", 1], ["Porkbun", 1], [UNKNOWN_HOST, 1]]);
eq("Spaceship is 4 of 7", percent(hosts.rows[0].share), "57%");
eq("…with one of its domains kept", hosts.rows[0].kept, 1);

const pairs = byHostAndTld(JOBS);
eq("the combination that blocks most", pairs.rows[0], { key: "Spaceship · .co", count: 3, share: 3 / 7, writtenOff: 3, kept: 0, inboxesStopped: 90, inboxesDeleted: 50, domains: 2 });
eq("every pair is listed", pairs.rows.length, 5);

eq("no records → empty", byTld([]), { total: 0, rows: [] });
eq("percent rounds small shares finer", [percent(0.05), percent(0.123), percent(0), percent(1)], ["5%", "12%", "0%", "100%"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
