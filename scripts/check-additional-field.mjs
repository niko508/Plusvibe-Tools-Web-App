// Unit checks for the bulk "Add Additional Field" logic.
//
// Imports the REAL module through the TS loader.
//
//   node scripts/check-additional-field.mjs

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
const ok = (label, cond) => eq(label, cond === true, true);

const f = await importTs("@/lib/additional-fields/field");
const {
  normalizeFieldName,
  validateFieldName,
  classifyWorkspace,
  classifyApiError,
  STANDARD_FIELDS,
} = f;

// --- normalization: what Plusvibe turns the name into ------------------------

eq("lowercases", normalizeFieldName("Industry"), "industry");
eq("spaces become underscores", normalizeFieldName("Industry Type"), "industry_type");
eq("punctuation becomes underscores", normalizeFieldName("Employee-Count"), "employee_count");
eq("runs collapse", normalizeFieldName("Coupon  --  Code"), "coupon_code");
eq("ends are trimmed", normalizeFieldName("  (Region)  "), "region");
eq("already-normalized is a fixed point", normalizeFieldName("industry_type"), "industry_type");
eq("digits survive", normalizeFieldName("Q3 Target"), "q3_target");
eq("only punctuation normalizes to nothing", normalizeFieldName("---"), "");
// Emoji aren't letters here — this is a variable name, not a label.
eq("emoji becomes a separator", normalizeFieldName("🔥 Hot Lead"), "hot_lead");

// --- validation ------------------------------------------------------------

eq("a plain name is fine", validateFieldName("Industry"), []);
eq("a two-word name is fine", validateFieldName("Industry Type"), []);
ok("empty is rejected", validateFieldName("   ").length === 1);
ok(
  "punctuation-only is rejected",
  validateFieldName("---").some((p) => p.includes("at least one letter or number"))
);
ok(
  "a standard field is rejected",
  validateFieldName("email").some((p) => p.includes("standard lead field"))
);
ok(
  "…however it's spelled",
  validateFieldName("First Name").some((p) => p.includes("standard lead field"))
);
ok(
  "…and the message names the normalized form",
  validateFieldName("First Name").some((p) => p.includes('"first_name"'))
);
ok("over 100 characters is rejected", validateFieldName("a".repeat(101)).length === 1);
eq("exactly 100 is allowed", validateFieldName("a".repeat(100)), []);
ok("email is a standard field", STANDARD_FIELDS.has("email"));
ok("first_name is a standard field", STANDARD_FIELDS.has("first_name"));

// --- classifying one workspace ---------------------------------------------

const FIELDS = [
  { name: "industry", default_value: "SaaS" },
  { name: "employee_count" },
];

eq("an empty workspace creates", classifyWorkspace("Industry", []).action, "create");
eq("an unrelated field doesn't block", classifyWorkspace("Region", FIELDS).action, "create");

const hit = classifyWorkspace("Industry", FIELDS);
eq("the same name is already there", hit.action, "already");
eq("…and the existing field comes back", hit.existing.name, "industry");
eq("…with its default", hit.existing.default_value, "SaaS");

// The user types the display form; the workspace holds the normalized form.
// Comparing them raw would miss, and the API would then refuse the create.
eq(
  "display form matches the stored normalized form",
  classifyWorkspace("Employee Count", FIELDS).action,
  "already"
);
eq(
  "…whatever the case and punctuation",
  classifyWorkspace("EMPLOYEE-COUNT", FIELDS).action,
  "already"
);
eq(
  "a stored name that isn't quite normalized still matches",
  classifyWorkspace("Industry", [{ name: "Industry" }]).action,
  "already"
);

// --- sorting the API's refusals ----------------------------------------------

eq(
  "a standard-field refusal is a conflict",
  classifyApiError("Field name should not be same as Standard Field"),
  "conflict"
);
eq(
  "a campaign-variable clash is a conflict",
  classifyApiError("Field name conflicts with a campaign variable"),
  "conflict"
);
eq(
  "'already exists' is already, not an error",
  classifyApiError("Field already exists on Workspace"),
  "already"
);
eq("anything else is an error", classifyApiError("Internal server error"), "error");
eq("a network failure is an error", classifyApiError("fetch failed"), "error");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
