// Unit checks for the bulk "Add Tags" logic. Imports the REAL module.
//
//   node scripts/check-bulk-tags.mjs

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

const m = await importTs("@/lib/tags/bulk-tags");
const { normalizeColor, validateTag, prepareBatch, findExisting, classifyApiError, tagKey } = m;

// --- colours ------------------------------------------------------------------
eq("6-digit hex is kept, upper-cased", normalizeColor("#ff5733"), "#FF5733");
eq("3-digit hex is expanded", normalizeColor("#f57"), "#FF5577");
eq("whitespace is trimmed", normalizeColor("  #ABC  "), "#AABBCC");
eq("no hash is not a colour", normalizeColor("FF5733"), null);
eq("wrong length is not a colour", normalizeColor("#FF57"), null);
eq("non-hex is not a colour", normalizeColor("#GGGGGG"), null);
eq("a name is not a colour", normalizeColor("red"), null);
eq("empty is not a colour", normalizeColor(""), null);

// --- one tag ---------------------------------------------------------------------
eq("a good tag has no problems", validateTag({ name: "VIP Clients", color: "#FF5733" }), []);
eq("…with a description too", validateTag({ name: "VIP", color: "#F57", description: "Best setup" }), []);
eq("blank name", validateTag({ name: "  ", color: "#FF5733" }), ["Give the tag a name."]);
eq("over 100 chars", validateTag({ name: "x".repeat(101), color: "#FF5733" }).length, 1);
eq("exactly 100 is fine", validateTag({ name: "x".repeat(100), color: "#FF5733" }), []);
eq("bad colour", validateTag({ name: "VIP", color: "orange" }), ["The colour needs to be a hex code like #FF5733 or #F57."]);
eq("over 500 description", validateTag({ name: "VIP", color: "#F57", description: "d".repeat(501) }).length, 1);
eq("two problems come back together", validateTag({ name: "", color: "nope" }).length, 2);

// --- a batch ---------------------------------------------------------------------
const b = prepareBatch([
  { name: " VIP Clients ", color: "#f57", description: " Best setup " },
  { name: "Cold", color: "#3B82F6", description: "" },
  { name: "vip clients", color: "#000000" }, // repeat of row 0, different case
  { name: "", color: "#FF5733" },              // problem row
  { name: "Warm", color: "orange" },          // problem row
]);
eq("good rows become specs, trimmed and normalised", b.specs, [
  { name: "VIP Clients", color: "#FF5577", description: "Best setup" },
  { name: "Cold", color: "#3B82F6" },
]);
eq("an empty description is omitted, not sent as empty", "description" in b.specs[1], false);
eq("a repeated name keeps the first occurrence only", b.duplicates, [2]);
eq("problem rows are reported by position", [...b.problems.keys()], [3, 4]);
eq("…with their problems", b.problems.get(4), ["The colour needs to be a hex code like #FF5733 or #F57."]);
eq("an empty batch has no specs", prepareBatch([]).specs, []);

// --- against a workspace ------------------------------------------------------------
const HAVE = [{ id: "t1", name: "VIP Clients" }, { id: "t2", name: "Active" }];
eq("an existing tag is found", findExisting("VIP Clients", HAVE)?.id, "t1");
eq("…case-insensitively, as Plusvibe treats names", findExisting("vip CLIENTS", HAVE)?.id, "t1");
eq("…and with surrounding spaces", findExisting("  Active ", HAVE)?.id, "t2");
eq("a new name is not found", findExisting("Warm", HAVE), undefined);
eq("tagKey lowercases and trims", tagKey("  VIP Clients "), "vip clients");

// --- the API's refusals ---------------------------------------------------------------
eq("the duplicate refusal is 'already', not an error", classifyApiError("Tag already exists, please try a new name."), "already");
eq("a colour refusal is an error", classifyApiError("Color must be a valid hex color code (e.g., #FF5733 or #F57)"), "error");
eq("a server failure is an error", classifyApiError("Internal server error"), "error");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
