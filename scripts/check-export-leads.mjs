// Unit checks for Export Not Contacted Leads: a lead as a flat row, several
// campaigns combined (one row per email or not), the columns and the CSV.
// Imports the REAL module.
//
//   node scripts/check-export-leads.mjs

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

const { flattenLead, combineLeads, columnsOf, toCsv, fileName, deletionPlan, DELETE_CHUNK } = await importTs("@/lib/export-leads/rows");

console.log("--- a lead as a row");
const raw = {
  _id: "x1", campaign_id: "c1", workspace_id: "w", status: "NOT_CONTACTED", current_step: 0, created_at: "2026-01-01",
  email: " Ann@Acme.com ", first_name: "Ann", company_name: "Acme, Inc.", job_title: "CEO",
  segment: "local", opening_line: "Saw your \"new\" site",
  custom_variables: { city_hint: "Oslo", segment: "ignored" },
  nested: { a: 1 }, empty: null, zero: 0,
};
eq("fields and custom variables kept, bookkeeping and nested values left out", flattenLead(raw), {
  email: "Ann@Acme.com", first_name: "Ann", company_name: "Acme, Inc.", job_title: "CEO", segment: "local", opening_line: "Saw your \"new\" site", city_hint: "Oslo", empty: "", zero: "0",
});

console.log("--- several campaigns");
const a = { campaignName: "🟡 Local (Aug)", rows: [{ email: "ann@acme.com", first_name: "Ann", segment: "" }, { email: "bob@b.com", first_name: "Bob" }] };
const b = { campaignName: "🔵 Local (Aug)", rows: [{ email: "ANN@acme.com", first_name: "Annie", segment: "local", phone_number: "123" }] };
const one = combineLeads([a, b], true);
eq("one row per email: the first's fields, gaps filled, both campaigns named", one, {
  rows: [
    { email: "ann@acme.com", first_name: "Ann", segment: "local", campaign: "🟡 Local (Aug) | 🔵 Local (Aug)", phone_number: "123" },
    { email: "bob@b.com", first_name: "Bob", campaign: "🟡 Local (Aug)" },
  ],
  merged: 1,
});
eq("…or once per campaign", combineLeads([a, b], false).rows.map((r) => [r.email, r.campaign]), [["ann@acme.com", "🟡 Local (Aug)"], ["bob@b.com", "🟡 Local (Aug)"], ["ANN@acme.com", "🔵 Local (Aug)"]]);
eq("the same campaign twice isn't named twice", combineLeads([a, { ...a }], true).rows[0].campaign, "🟡 Local (Aug)");

console.log("--- the file");
eq("columns: the usual fields first, then the rest as seen, the campaign last", columnsOf(one.rows), ["email", "first_name", "phone_number", "segment", "campaign"]);
eq("CSV: quoted where needed, empty cells for missing fields", toCsv([{ email: "a@b.com", company_name: "Acme, Inc.", note: 'Say "hi"' }, { email: "c@d.com" }]), 'email,company_name,note\r\na@b.com,"Acme, Inc.","Say ""hi"""\r\nc@d.com,,\r\n');
eq("file name", fileName("Something Inc (SaaS + eCommerce)", "2026-10-07"), "not-contacted-leads-something-inc-saas-ecommerce-2026-10-07.csv");

console.log("--- deleting after the download");
eq("only exported leads still not contacted are removed, in the campaign's spelling", deletionPlan(["Ann@Acme.com", "bob@b.com", "cy@c.com"], ["ann@acme.com", "cy@c.com", "new@n.com"]), { remove: ["ann@acme.com", "cy@c.com"], skipped: 1 });
eq("a lead added after the download is never removed", deletionPlan([], ["new@n.com"]), { remove: [], skipped: 0 });
eq("duplicates and blanks in the export count once / not at all", deletionPlan(["a@b.com", "A@B.com ", ""], ["a@b.com"]), { remove: ["a@b.com"], skipped: 0 });
eq("delete chunk", DELETE_CHUNK, 100);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
