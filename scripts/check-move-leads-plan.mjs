// Unit checks for what a lead chunk sends and what it leaves behind. Imports
// the REAL module.
//
//   node scripts/check-move-leads-plan.mjs

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

const m = await importTs("@/lib/move-leads-plan");
const { prepareChunk, readAddCounts, accountFor, describeUnmoved, isValidEmail } = m;

// --- what goes out ------------------------------------------------------------
const L = (email) => ({ email, first_name: "x" });
const p = prepareChunk([L("a@x.com"), L("A@X.COM"), L("not-an-email"), L("b@x.com"), L(" b@x.com "), L("c@x")]);
eq("one of each address goes, the first spelling kept", p.send.map((l) => l.email), ["a@x.com", "b@x.com"]);
eq("the repeat, ignoring case and padding, is left behind and named",
  p.unmoved.filter((u) => u.reason === "duplicate").map((u) => u.email), ["A@X.COM", " b@x.com "]);
eq("addresses that aren't are left behind and named",
  p.unmoved.filter((u) => u.reason === "invalid-email").map((u) => u.email), ["not-an-email", "c@x"]);
eq("a clean chunk is sent whole", prepareChunk([L("a@x.com"), L("b@x.com")]).unmoved, []);
eq("an empty chunk", prepareChunk([]), { send: [], unmoved: [] });
// The check matches Plusvibe's own rule, strict or not, because Plusvibe
// refuses a whole batch for one address it won't take. This used to accept
// "+" and let a single plus-addressed lead sink ninety-nine good ones.
eq("ordinary addresses pass", [isValidEmail("first.last@sub.domain.co"), isValidEmail("a_b-c@x.com"), isValidEmail("A@B.CO")], [true, true, true]);
eq("the address that sank a real batch is caught before sending",
  isValidEmail("agency-it+exteriorscc@voicemediagroup.com"), false);
eq("…as is any plus address", isValidEmail("first.last+tag@sub.domain.co"), false);
eq("a local part may not start or end on punctuation", [isValidEmail(".a@x.com"), isValidEmail("a.@x.com"), isValidEmail("-a@x.com")], [false, false, false]);
eq("…and the obvious non-addresses still fail", [isValidEmail("a b@x.com"), isValidEmail("@x.com"), isValidEmail("a@x"), isValidEmail("")], [false, false, false, false]);

// --- which lead a refused batch names -----------------------------------------------
const { rejectedIndex } = m;
eq("the lead named in Plusvibe's message is found",
  rejectedIndex('leads>60>email: "leads[60].email" with value "agency-it+exteriorscc@voicemediagroup.com" fails to match the required pattern'), 60);
eq("…in either of the forms it uses", [rejectedIndex('"leads[0].email" is required'), rejectedIndex("leads>7>first_name: too long")], [0, 7]);
eq("a refusal naming no lead is about the batch, and says so", [rejectedIndex("Campaign not found"), rejectedIndex("")], [null, null]);

// --- what came back -------------------------------------------------------------
const c = readAddCounts({ status: "success", total_sent: 100, leads_uploaded: 99, duplicate_email_count: 0, already_in_campaign: 0, invalid_email_count: 1, skipped: 0, overflowed_lead_count: 0 });
eq("every counter is read", c, { uploaded: 99, alreadyThere: 0, duplicate: 0, invalid: 1, skipped: 0, overflow: 0, totalSent: 100 });
eq("missing counters read as zero, not NaN", readAddCounts({ leads_uploaded: "5" }).invalid, 0);
eq("…and numbers sent as text are read", readAddCounts({ leads_uploaded: "5" }).uploaded, 5);
eq("no body at all", readAddCounts(undefined).uploaded, 0);

// --- settling the chunk ------------------------------------------------------------
eq("all landed is complete", accountFor(100, readAddCounts({ leads_uploaded: 60, already_in_campaign: 40 })), { landed: 100, refused: 0, complete: true, quotaHit: false });
eq("the case from the screenshot: 99 of 100, one refused", accountFor(100, c), { landed: 99, refused: 1, complete: false, quotaHit: false });
eq("the plan quota is a different kind of shortfall", accountFor(100, readAddCounts({ leads_uploaded: 40, overflowed_lead_count: 60 })).quotaHit, true);
eq("a short answer with no counters explaining it", accountFor(100, readAddCounts({ leads_uploaded: 90 })), { landed: 90, refused: 0, complete: false, quotaHit: false });

// --- saying it --------------------------------------------------------------------
eq("reasons are counted and named, most common first", describeUnmoved([
  { email: "a", reason: "duplicate" }, { email: "b", reason: "invalid-email" }, { email: "c", reason: "duplicate" },
]), "3 could not be moved: 2 duplicate address in the batch, 1 not a valid email address");
eq("nothing unmoved → nothing to say", describeUnmoved([]), "");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
