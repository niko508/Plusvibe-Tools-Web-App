// Unit checks for the bulk "Add Custom Label" logic.
//
// Imports the REAL modules through the TS loader, so a passing run says
// something about the code that ships rather than about a copy of it.
//
//   node scripts/check-custom-label.mjs

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

const cl = await importTs("@/lib/lead-labels/custom-label");
const nz = await importTs("@/lib/lead-labels/normalize");

// --- name validation --------------------------------------------------------

eq("a plain name is fine", cl.validateLabelName("Meeting booked"), []);
eq("an emoji name is fine", cl.validateLabelName("🤑 meeting booked"), []);
eq(
  "leading/trailing space is trimmed, not rejected",
  cl.validateLabelName("  🤑 meeting booked  "),
  []
);
ok("empty is rejected", cl.validateLabelName("   ").length === 1);
ok(
  "angle brackets are rejected",
  cl.validateLabelName("<script>").some((p) => p.includes("< or >"))
);
ok(
  "over 100 UTF-16 units is rejected",
  cl.validateLabelName("a".repeat(101)).some((p) => p.includes("limit is 100"))
);
eq("exactly 100 is allowed", cl.validateLabelName("a".repeat(100)), []);
// 50 of these emoji are 100 UTF-16 units — the API counts the same way, so a
// name that "looks" half the limit is right at it.
eq("50 two-unit emoji plus a word is over", cl.validateLabelName("🤑".repeat(50) + " x").length, 1);
ok(
  "emoji-only is rejected — nothing left to match on",
  cl
    .validateLabelName("🤑🎉")
    .some((p) => p.includes("at least one letter or number"))
);

// The count the UI shows must be the count the rule uses, or the field would
// read 49/100 while the API rejects it.
eq("nameLength counts UTF-16 units", cl.nameLength("🤑 ab"), 5);
eq("nameLength trims first", cl.nameLength("  ab  "), 2);

// --- sentiment --------------------------------------------------------------

ok("POSITIVE is a sentiment", cl.isSentiment("POSITIVE"));
ok("NEGATIVE is a sentiment", cl.isSentiment("NEGATIVE"));
ok("NEUTRAL is a sentiment", cl.isSentiment("NEUTRAL"));
eq("lowercase is not", cl.isSentiment("positive"), false);
eq("junk is not", cl.isSentiment("MAYBE"), false);
eq("the picker offers exactly the three", cl.SENTIMENTS.length, 3);

// --- classifying one workspace ---------------------------------------------

const SYSTEM_BOOKED = { key: "MEETING_BOOKED", name: "Meeting Booked", isSystem: true };
const CUSTOM_BOOKED = { key: "K1", name: "🤑 meeting booked" };
const OTHER = { key: "K2", name: "😡 not interested" };

eq(
  "an empty workspace creates",
  cl.classifyWorkspace("🤑 meeting booked", []).action,
  "create"
);
eq(
  "an unrelated label doesn't block",
  cl.classifyWorkspace("🤑 meeting booked", [OTHER]).action,
  "create"
);

// The case that matters most: the user's own "🤑 meeting booked" lives happily
// alongside Plusvibe's built-in "Meeting Booked". Normalizing strips the emoji
// and the case, so a normalized comparison against system labels would call
// this a conflict and skip every workspace.
eq(
  "the built-in Meeting Booked does NOT block the emoji one",
  cl.classifyWorkspace("🤑 meeting booked", [SYSTEM_BOOKED]).action,
  "create"
);

eq(
  "an exact system name is a conflict",
  cl.classifyWorkspace("Meeting Booked", [SYSTEM_BOOKED]).action,
  "conflict"
);
eq(
  "system conflict is case-insensitive",
  cl.classifyWorkspace("meeting booked", [SYSTEM_BOOKED]).action,
  "conflict"
);

const already = cl.classifyWorkspace("🤑 meeting booked", [
  SYSTEM_BOOKED,
  CUSTOM_BOOKED,
]);
eq("an existing custom label is skipped", already.action, "already");
eq("…matched exactly", already.matchedBy, "exact");
eq("…and its key comes back", already.existing.key, "K1");

// Case alone is still an exact match — the name is compared lowercased.
const cased = cl.classifyWorkspace("🤑 Meeting Booked", [CUSTOM_BOOKED]);
eq("a differently-cased custom label is skipped", cased.action, "already");
eq("…as an exact match, since case is ignored", cased.matchedBy, "exact");

// A different emoji, or different punctuation, is where "similar" starts.
const similar = cl.classifyWorkspace("💰 meeting booked", [CUSTOM_BOOKED]);
eq("a differently-spelled custom label is skipped", similar.action, "already");
eq("…and reported as a near-match, not an exact one", similar.matchedBy, "similar");
eq("…naming what's actually there", similar.existing.name, "🤑 meeting booked");

// A near-match must not win over an exact one further down the list, or the
// report would name the wrong label.
const both = cl.classifyWorkspace("🤑 meeting booked", [
  { key: "KA", name: "meeting-booked" },
  CUSTOM_BOOKED,
]);
eq("an exact match later in the list still wins", both.existing.key, "K1");
eq("…as an exact match", both.matchedBy, "exact");

// A system label that only normalizes the same way is not a conflict AND not a
// match — so a workspace with just the built-in gets the custom label created.
eq(
  "system labels are never a near-match",
  cl.classifyWorkspace("meeting-booked", [SYSTEM_BOOKED]).action,
  "create"
);

// --- the shared normalizer --------------------------------------------------

eq("emoji stripped", nz.normalizeLabelName("🤩 positive reply 1"), "positive reply 1");
eq("case ignored", nz.normalizeLabelName("Positive Reply 1"), "positive reply 1");
eq("hyphens ignored", nz.normalizeLabelName("positive-reply-1"), "positive reply 1");
eq("emoji-only normalizes to nothing", nz.normalizeLabelName("🤑"), "");

// first-campaign re-exports it rather than keeping a second copy; if that ever
// diverges, the two features would disagree about what counts as the same label.
const fc = await importTs("@/lib/first-campaign/labels");
eq(
  "first-campaign uses the same normalizer",
  fc.normalizeLabelName === nz.normalizeLabelName,
  true
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
