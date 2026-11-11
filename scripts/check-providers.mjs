// Unit checks for the shared mailbox-provider classifier and the Blocked
// Domains provider breakdown. Imports the REAL modules.
//
//   node scripts/check-providers.mjs

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

const p = await importTs("@/lib/plusvibe-providers");
const { bucketOf, countProviders, dominantProvider, describeProviders, emptyProviderCounts } = p;

// --- bucketOf, exactly as Plusvibe spells it --------------------------------
eq("Google Workspace", bucketOf("GOOGLE_WORKSPACE"), "google");
eq("Microsoft 365", bucketOf("MICROSOFT365"), "microsoft");
eq("…case-insensitively", bucketOf("microsoft365"), "microsoft");
eq("an SMTP mailbox reports something else", bucketOf("SMTP"), "other");
eq("no provider at all is other, not a crash", [bucketOf(undefined), bucketOf(null), bucketOf("")], ["other", "other", "other"]);
eq("a lookalike is not Microsoft", bucketOf("MICROSOFT"), "other");

// The inbox-tags tool must still read the same classifier.
const plan = await importTs("@/lib/inbox-tags/plan");
eq("Update Inbox Tags uses the shared classifier", plan.bucketOf, bucketOf);

// --- counting ---------------------------------------------------------------
const inboxes = [
  { provider: "MICROSOFT365" }, { provider: "MICROSOFT365" }, { provider: "GOOGLE_WORKSPACE" }, {},
];
eq("counts per bucket", countProviders(inboxes), { google: 1, microsoft: 2, other: 1 });
eq("no inboxes → zeroes", countProviders([]), emptyProviderCounts());

// --- the dominant provider --------------------------------------------------
eq("a 49/1 domain is a Microsoft domain", dominantProvider({ google: 1, microsoft: 49, other: 0 }), "microsoft");
eq("all one kind", dominantProvider({ google: 3, microsoft: 0, other: 0 }), "google");
eq("a real tie is mixed", dominantProvider({ google: 2, microsoft: 2, other: 0 }), null);
eq("…even a three-way one", dominantProvider({ google: 1, microsoft: 1, other: 1 }), null);
eq("nothing is nothing", dominantProvider(emptyProviderCounts()), null);
eq("other alone still counts", dominantProvider({ google: 0, microsoft: 0, other: 4 }), "other");

// --- the chip text ----------------------------------------------------------
eq("biggest first, zeroes left out", describeProviders({ google: 2, microsoft: 46, other: 0 }), "46 Microsoft · 2 Google");
eq("one kind reads as one", describeProviders({ google: 0, microsoft: 3, other: 0 }), "3 Microsoft");
eq("nothing reads as empty", describeProviders(emptyProviderCounts()), "");

// --- the stats breakdown ----------------------------------------------------
const stats = await importTs("@/lib/blocked-domains/stats");
const job = (domain, providers, over = {}) => ({
  id: domain + Math.random(), domain, status: "done", phaseStates: { sheet: "done" },
  inboxesQuarantined: 0, inboxesDeleted: 0, providers, ...over,
});
eq("a Microsoft-heavy domain is filed under Microsoft", stats.providerKeyOf(job("a.co", { google: 1, microsoft: 49, other: 0 })), "Microsoft");
eq("a tie is filed as Mixed", stats.providerKeyOf(job("a.co", { google: 2, microsoft: 2, other: 0 })), stats.MIXED_PROVIDER);
eq("a record from before this was captured is unknown", stats.providerKeyOf(job("a.co", undefined)), stats.UNKNOWN_PROVIDER);
eq("…as is one with no inboxes found", stats.providerKeyOf(job("a.co", emptyProviderCounts())), stats.UNKNOWN_PROVIDER);
const bd = stats.byProvider([
  job("a.co", { google: 0, microsoft: 50, other: 0 }),
  job("b.co", { google: 0, microsoft: 3, other: 0 }),
  job("c.co", { google: 5, microsoft: 0, other: 0 }),
  job("d.co", undefined),
]);
eq("blocks by provider, most first", bd.rows.map((r) => [r.key, r.count]), [["Microsoft", 2], ["Google", 1], [stats.UNKNOWN_PROVIDER, 1]]);
eq("shares add up", Math.round(bd.rows.reduce((n, r) => n + r.share, 0) * 100), 100);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
