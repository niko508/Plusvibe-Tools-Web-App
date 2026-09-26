// Unit checks for filling the Domains tab's "Tenant / Inbox Source" from the
// Tenants tab's "Tenant Provider".
//
//   node scripts/check-tenant-source.mjs

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};

// --- mirrored from src/lib/jobs/tenant-source.ts ----------------------------
const providerKey = (v) => v.trim().toLowerCase().replace(/[\s._/\\-]+/g, "");
const emailKey = (v) => v.trim().toLowerCase();

const buildProviderByEmail = (rows, iEmail, iProvider) => {
  const byEmail = new Map();
  const duplicates = [];
  for (let r = 1; r < rows.length; r++) {
    const email = emailKey(rows[r]?.[iEmail] ?? "");
    if (!email) continue;
    const provider = (rows[r]?.[iProvider] ?? "").trim();
    if (!provider) continue;
    if (byEmail.has(email)) {
      if (byEmail.get(email) !== provider) duplicates.push(email);
      continue;
    }
    byEmail.set(email, provider);
  }
  return { byEmail, duplicates };
};

const buildSourceVocabulary = (rows, iSource) => {
  const vocab = new Map();
  for (let r = 1; r < rows.length; r++) {
    const raw = (rows[r]?.[iSource] ?? "").trim();
    if (!raw) continue;
    const k = providerKey(raw);
    if (k && !vocab.has(k)) vocab.set(k, raw);
  }
  return vocab;
};

const resolveSource = (email, byEmail, vocabulary) => {
  const provider = byEmail.get(emailKey(email));
  if (!provider) return { value: null, adapted: false, unknown: false };
  const canonical = vocabulary.get(providerKey(provider));
  if (!canonical) return { value: provider, adapted: false, unknown: true };
  return { value: canonical, adapted: canonical !== provider, unknown: false };
};

// --- the real sheets --------------------------------------------------------
// Tenants tab: A = Tenant Email Address, C = Tenant Provider.
const TENANTS = [
  ["Tenant Email Address", "Added to Outengine?", "Tenant Provider", "Registered", "Tenant Age"],
  ["admin@stonevalelive.onmicrosoft.com", "TRUE", "Cheap Inboxes", "31/07/2026", "27"],
  ["admin@moorbriarlive.onmicrosoft.com", "TRUE", "Cheap Inboxes", "31/07/2026", "27"],
  ["admin@vesboco.onmicrosoft.com", "TRUE", "Azure Direct", "31/07/2026", "27"],
];
// Domains tab: B = Tenant Email Address, H = Tenant / Inbox Source. Both tabs
// now spell it "Cheap Inboxes", which is the normal case.
const DOMAINS = [
  ["Domain", "Tenant Email Address", "Status", "Warmup Started", "Warmup Days",
   "Domain Host", "Infra Type", "Tenant / Inbox Source", "Client"],
  ["demandspot.live", "", "Warming Up", "", "", "Spaceship", "Azure", "Cheap Inboxes", ""],
  ["revhub.live", "", "Warming Up", "", "", "Spaceship", "Azure", "Cheap Inboxes", ""],
  ["cymleda.co", "admin@varneolive.onmicrosoft.com", "Warming Up", "", "", "Spaceship", "Azure", "", ""],
];

const { byEmail, duplicates } = buildProviderByEmail(TENANTS, 0, 2);
const vocab = buildSourceVocabulary(DOMAINS, 7);

console.log("--- lookup");
eq("three tenant emails mapped", byEmail.size, 3);
eq("no duplicates in a clean sheet", duplicates, []);
eq("the vocabulary is read from the Domains column", [...vocab.values()], ["Cheap Inboxes"]);

// The normal case: both tabs agree, so the value copies straight across and
// nothing is rewritten or flagged.
const r1 = resolveSource("admin@stonevalelive.onmicrosoft.com", byEmail, vocab);
eq("a matching spelling copies straight across", r1.value, "Cheap Inboxes");
eq("nothing is rewritten when the tabs agree", r1.adapted, false);
eq("a matching value is not flagged unknown", r1.unknown, false);

// The fallback: if the two tabs drift apart again, the Domains column's own
// spelling wins so its dropdown stays valid, and the rewrite is reported.
const drifted = buildSourceVocabulary(
  [["Tenant / Inbox Source"], ["CheapInboxes"]], 0
);
const r1b = resolveSource("admin@stonevalelive.onmicrosoft.com", byEmail, drifted);
eq("drift writes the Domains spelling", r1b.value, "CheapInboxes");
eq("drift is reported", r1b.adapted, true);
eq("drift is not flagged unknown", r1b.unknown, false);

// A provider the Domains column has never held is written as-is but flagged.
const r2 = resolveSource("admin@vesboco.onmicrosoft.com", byEmail, vocab);
eq("an unseen provider is written verbatim", r2.value, "Azure Direct");
eq("an unseen provider is flagged", r2.unknown, true);
eq("an unseen provider is not marked adapted", r2.adapted, false);

// An email not in the Tenants tab leaves the cell alone rather than guessing.
const r3 = resolveSource("admin@nowhere.onmicrosoft.com", byEmail, vocab);
eq("an unknown email resolves to nothing", r3.value, null);
eq("an unknown email is not flagged unknown-provider", r3.unknown, false);

console.log("--- matching tolerance");
eq("email case is ignored",
  resolveSource("ADMIN@StoneValeLive.onmicrosoft.com", byEmail, vocab).value, "Cheap Inboxes");
eq("surrounding whitespace is ignored",
  resolveSource("  admin@stonevalelive.onmicrosoft.com  ", byEmail, vocab).value, "Cheap Inboxes");
// Provider spellings that differ only by separators are the same provider.
for (const variant of ["cheap inboxes", "CHEAPINBOXES", "Cheap-Inboxes", "Cheap_Inboxes", "cheap.inboxes"]) {
  eq(`"${variant}" maps to the Domains spelling`,
    resolveSource("e", new Map([["e", variant]]), vocab).value, "Cheap Inboxes");
}
// But a genuinely different provider must not be collapsed into it.
eq("a different provider is not collapsed",
  resolveSource("e", new Map([["e", "Cheap Inboxes Pro"]]), vocab).unknown, true);

console.log("--- edge cases");
eq("an empty Tenants tab maps nothing", buildProviderByEmail([["a","b","c"]], 0, 2).byEmail.size, 0);
eq("rows with a blank provider are skipped",
  buildProviderByEmail([["h"],["a@b.com","","" ]], 0, 2).byEmail.size, 0);
eq("rows with a blank email are skipped",
  buildProviderByEmail([["h"],["","x","P"]], 0, 2).byEmail.size, 0);
eq("an empty Domains column yields an empty vocabulary",
  buildSourceVocabulary([["h"],["","",""]], 2).size, 0);
// With no vocabulary at all, values still write — just flagged as unverified.
eq("no vocabulary means write verbatim",
  resolveSource("e", new Map([["e", "Cheap Inboxes"]]), new Map()).value, "Cheap Inboxes");
eq("no vocabulary means flagged unknown",
  resolveSource("e", new Map([["e", "Cheap Inboxes"]]), new Map()).unknown, true);

// A duplicated email with conflicting providers must not silently pick the last.
const dup = buildProviderByEmail([
  ["Tenant Email Address", "x", "Tenant Provider"],
  ["a@b.com", "", "Cheap Inboxes"],
  ["a@b.com", "", "Azure Direct"],
], 0, 2);
eq("the first row wins on a conflict", dup.byEmail.get("a@b.com"), "Cheap Inboxes");
eq("the conflict is reported", dup.duplicates, ["a@b.com"]);
// The same provider twice is not a conflict worth reporting.
const same = buildProviderByEmail([
  ["h", "x", "p"],
  ["a@b.com", "", "Cheap Inboxes"],
  ["a@b.com", "", "Cheap Inboxes"],
], 0, 2);
eq("an identical repeat is not a conflict", same.duplicates, []);

// The vocabulary keeps the first spelling seen, so a stray variant already in
// the column doesn't win over the established one.
eq("the first spelling in the column wins",
  buildSourceVocabulary([["h"], ["Cheap Inboxes"], ["cheapinboxes"]], 0).get("cheapinboxes"),
  "Cheap Inboxes");

console.log(failures === 0 ? "\nall tenant-source checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
