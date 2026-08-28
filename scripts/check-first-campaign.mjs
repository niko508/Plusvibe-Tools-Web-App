// Unit checks for the "New Workspace 1st Campaign" blueprint and its lead-label
// matching.
//
// Unlike the older check scripts, this one imports the REAL modules through
// scripts/ts-loader.mjs rather than re-implementing them, so a change to the
// blueprint that breaks an expectation fails here instead of passing against a
// stale copy.
//
//   node scripts/check-first-campaign.mjs

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
const ok = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
};

const bp = await importTs("@/lib/first-campaign/blueprint");
const lb = await importTs("@/lib/first-campaign/labels");

// --- Step 1 ----------------------------------------------------------------
console.log("--- step 1");
const step = bp.buildStepOne();
eq("one step, step 1", step.step, 1);
eq("one variation", step.variations.length, 1);
eq("variation A", step.variations[0].variation, "A");
eq("subject is the placeholder", step.variations[0].subject, "{{SUBJECT_LINE}}");
ok("wait_time is present (API requires it)", typeof step.wait_time === "number");

const body = step.variations[0].body;
// The Liquid conditional and both spintax blocks must survive HTML conversion
// intact — an escaped brace or a swallowed pipe would break personalisation
// silently, and it would only show up in sent mail.
ok(
  "liquid conditional intact",
  body.includes("{% if first_name != blank %}") && body.includes("{% endif %}"),
  body.slice(0, 200)
);
ok("greeting spintax intact", body.includes("{{Random | Hey {{first_name}}, | Hi {{first_name}},}}"));
ok("else-branch spintax intact", body.includes("{{Random | Hey, | Hi,}}"));
ok("BODY_COPY placeholder intact", body.includes("{{BODY_COPY}}"));
ok("sign-off spintax intact", body.includes("| Best wishes,}}"));
ok("signature token intact", body.includes("{{sender_signature}}"));
ok("no HTML-escaped braces", !body.includes("&lt;") && !body.includes("&gt;"));
eq("four paragraphs", body.split("<div>&nbsp;</div>").length, 4);
// The sign-off block has all ten options.
eq(
  "ten sign-off options",
  (body.match(/\| (Thanks|Best|Thx|Thank you|Regards|All the best|Best regards|King regards|Have a good one|Best wishes),/g) ?? []).length,
  10
);

// --- Schedules --------------------------------------------------------------
console.log("--- schedules");
eq("parent days are Mon-Fri + Sun", Object.keys(bp.PARENT_SCHEDULE.days).sort(), ["1", "2", "3", "4", "5", "7"]);
ok("parent excludes Saturday", bp.PARENT_SCHEDULE.days["6"] === undefined);
eq("parent window", bp.PARENT_SCHEDULE.timing, { from: "07:30", to: "17:30" });
eq("parent timezone", bp.PARENT_SCHEDULE.timezone, "America/New_York");
eq("parent daily limit", bp.PARENT_SCHEDULE.daily_limit, 3000);
eq("subsequence days are Mon-Fri", Object.keys(bp.SUBSEQUENCE_SCHEDULE.days).sort(), ["1", "2", "3", "4", "5"]);
eq("subsequence window", bp.SUBSEQUENCE_SCHEDULE.timing, { from: "09:30", to: "15:30" });
eq("subsequence timezone matches parent", bp.SUBSEQUENCE_SCHEDULE.timezone, bp.PARENT_SCHEDULE.timezone);
// "No Limit" in the UI means the field is absent. Sending 0 would mean the
// opposite — no new leads contacted at all.
ok("no daily_limit_new_lead on either schedule",
  !("daily_limit_new_lead" in bp.PARENT_SCHEDULE) &&
  !("daily_limit_new_lead" in bp.SUBSEQUENCE_SCHEDULE));

// --- Parent settings --------------------------------------------------------
console.log("--- parent settings");
const s = bp.PARENT_SETTINGS;
eq("Balanced 50/50", s.send_priority, 0.5);
eq("Round Robin", s.var_sel_type, "R_ROBIN");
eq("ESP matching off", s.is_esp_match, "no");
eq("opportunity value 0", s.opportunity_val, 0);
eq("stop on reply", s.stop_on_lead_replied, "yes");
eq("continue after OOO", s.exclude_ooo, "yes");
eq("OOO uses AI", s.ooo_nr_opt, "AI");
eq("OOO fallback 15 days", s.ooo_nr_ai_d, "15");
eq("domain-stop off", s.is_acc_based_sending, "no");
eq("open tracking off", s.is_emailopened_tracking, "no");
eq("unsubscribe link off", s.is_unsubscribed_link, "no");
eq("plain text on", s.send_as_txt, "yes");
eq("risky emails on", s.send_risky_email, "yes");
eq("SEG off", s.send_seg_email, "no");
eq("bounce auto-pause off", s.is_pause_on_bouncerate, "no");
eq("fallback sending on", s.other_email_acc, "yes");
eq("per-domain cap on", s.is_max_lead_domain_per_day, "yes");
eq("per-domain cap is 2", s.max_lead_domain_per_day, 2);
// A setting sent as a bare boolean instead of "yes"/"no" is silently ignored by
// the API, so the whole block is checked for stray types.
const yesNoFields = ["is_esp_match", "stop_on_lead_replied", "exclude_ooo",
  "is_acc_based_sending", "is_emailopened_tracking", "is_unsubscribed_link",
  "send_as_txt", "send_risky_email", "send_seg_email", "is_pause_on_bouncerate",
  "other_email_acc", "is_max_lead_domain_per_day"];
ok("every yes/no field is the string yes or no",
  yesNoFields.every((f) => s[f] === "yes" || s[f] === "no"),
  JSON.stringify(yesNoFields.filter((f) => s[f] !== "yes" && s[f] !== "no")));

// --- Sub-sequences ----------------------------------------------------------
console.log("--- sub-sequences");
eq("six sub-sequences", bp.SUBSEQUENCES.length, 6);
eq(
  "the six names",
  bp.SUBSEQUENCES.map((x) => x.name).sort(),
  [
    "Evergreen Follow Up",
    "Meeting Confirmation - Normal",
    "Meeting Confirmation - Prospect's Calendar",
    "No Show",
    "Positive Reply 1",
    "Positive Reply 2",
  ]
);
eq(
  "Meeting Confirmation - Normal fires on two labels",
  bp.SUBSEQUENCES.find((x) => x.name === "Meeting Confirmation - Normal").labels.map((l) => l.name),
  ["🤑 meeting booked", "🤑 meeting booked - cell phone call"]
);
eq("seven distinct labels", bp.allSpecLabels().length, 7);
ok("every sub-sequence has at least one label",
  bp.SUBSEQUENCES.every((x) => x.labels.length > 0));

// --- Label normalization ----------------------------------------------------
console.log("--- label normalization");
eq("emoji stripped", lb.normalizeLabelName("🤩 positive reply 1"), "positive reply 1");
eq("case ignored", lb.normalizeLabelName("Positive Reply 1"), "positive reply 1");
eq("hyphens ignored", lb.normalizeLabelName("positive-reply-1"), "positive reply 1");
eq("apostrophes ignored",
  lb.normalizeLabelName("🤑 meeting booked - prospect's calendar link"),
  "meeting booked prospect s calendar link");
eq("extra whitespace collapsed", lb.normalizeLabelName("  no   show  "), "no show");
// The two "meeting booked" labels must stay distinct, or one sub-sequence
// would steal the other's trigger.
const norms = bp.allSpecLabels().map((l) => lb.normalizeLabelName(l.name));
eq("all seven labels normalize distinctly", new Set(norms).size, 7);
ok('"meeting booked" is not a match for the longer names',
  norms.filter((n) => n === "meeting booked").length === 1);

// --- Label planning ---------------------------------------------------------
console.log("--- label planning");
const spec = bp.allSpecLabels();

// A brand-new workspace: only system labels, so all seven must be created.
const fresh = lb.planLabels(spec, [
  { key: "INTERESTED", name: "Interested", isSystem: true },
  { key: "NOT_INTERESTED", name: "Not Interested", isSystem: true },
]);
eq("fresh workspace matches nothing", fresh.matched.length, 0);
eq("fresh workspace creates all seven", fresh.missing.length, 7);

// A workspace set up partway by hand, with drifted spellings.
const partial = lb.planLabels(spec, [
  { key: "INTERESTED", name: "Interested", isSystem: true },
  { key: "_POSITIVE_REPLY_1", name: "🤩 positive reply 1" },
  { key: "POSITIVE_REPLY_2", name: "Positive Reply 2" },
  { key: "NO_SHOW", name: "no-show" },
]);
eq("three existing labels matched", partial.matched.length, 3);
eq("the other four are created", partial.missing.length, 4);
eq(
  "the key is taken from the workspace, never derived",
  partial.matched.find((m) => m.spec.name === "🤩 positive reply 1").existing.key,
  "_POSITIVE_REPLY_1"
);
ok("a drifted spelling still matches",
  partial.matched.some((m) => m.spec.name === "😡 no show" && m.existing.key === "NO_SHOW"));
ok("a system label is never matched to a spec label",
  !partial.matched.some((m) => m.existing.key === "INTERESTED"));

// A label with no usable key is treated as missing rather than producing an
// event with an empty val, which would create a trigger that never fires.
const keyless = lb.planLabels(
  [{ name: "😡 no show", sentiment: "NEGATIVE" }],
  [{ key: "", name: "no show" }]
);
eq("a keyless label counts as missing", keyless.missing.length, 1);

// First match wins, so a stray near-duplicate can't shadow the real label.
const dup = lb.planLabels(
  [{ name: "😡 no show", sentiment: "NEGATIVE" }],
  [{ key: "NO_SHOW", name: "No Show" }, { key: "NO_SHOW_2", name: "no show" }]
);
eq("the first matching label wins", dup.matched[0].existing.key, "NO_SHOW");

// --- Key lookup -------------------------------------------------------------
console.log("--- key lookup");
const index = lb.buildKeyIndex(
  spec.map((l, i) => ({ name: l.name, key: `KEY_${i}` }))
);
eq("index covers every label", index.size, 7);
const mcNormal = bp.SUBSEQUENCES.find((x) => x.name === "Meeting Confirmation - Normal");
eq("two keys resolved for the two-label sub-sequence",
  lb.keysForLabels(mcNormal.labels, index).length, 2);

// A missing key must throw. Dropping it would build a sub-sequence that quietly
// catches only half the leads it should.
let threw = false;
try {
  lb.keysForLabels([{ name: "🤩 never created", sentiment: "POSITIVE" }], index);
} catch {
  threw = true;
}
ok("an unresolved label throws rather than being dropped", threw);

// --- Trigger event ----------------------------------------------------------
console.log("--- trigger event");
const ev = bp.buildLabelEvent(["POSITIVE_REPLY_1"]);
eq("event name", ev.name, "LEAD_LABEL_UPDATED");
eq("prefix added", ev.val, ["LEAD_MARKED_AS_POSITIVE_REPLY_1"]);
eq("prefix not doubled",
  bp.buildLabelEvent(["LEAD_MARKED_AS_X"]).val, ["LEAD_MARKED_AS_X"]);
eq("multiple labels in one event",
  bp.buildLabelEvent(["A", "B"]).val,
  ["LEAD_MARKED_AS_A", "LEAD_MARKED_AS_B"]);

// --- PATCH payloads ---------------------------------------------------------
console.log("--- patch payloads");
const parent = bp.buildParentUpdate({
  workspaceId: "w".repeat(24),
  campaignId: "c".repeat(24),
  emailAccounts: ["t".repeat(24)],
});
eq("parent carries the ids", [parent.workspace_id, parent.campaign_id],
  ["w".repeat(24), "c".repeat(24)]);
eq("parent carries one step", parent.sequences.length, 1);
eq("parent carries the tag as an email account", parent.email_accounts, ["t".repeat(24)]);
eq("parent carries the schedule", parent.schedules.timing, { from: "07:30", to: "17:30" });
eq("parent carries the settings", parent.send_as_txt, "yes");
// With no tag resolved the field must be absent, not empty: an empty array
// would clear whatever sending accounts the campaign has.
ok("no email_accounts key when nothing resolved",
  !("email_accounts" in bp.buildParentUpdate({
    workspaceId: "w", campaignId: "c", emailAccounts: [],
  })));

const sub = bp.buildSubsequenceUpdate({ workspaceId: "w", campaignId: "c" });
eq("subsequence gets its own window", sub.schedules.timing, { from: "09:30", to: "15:30" });
eq("subsequence ignores the mailbox limit", sub.ignore_mailbox_limit, 1);
// Sending `sequences` for a sub-sequence would also require first_wait_time;
// the content is added in a later step, so neither belongs here.
ok("subsequence sends no sequences and no first_wait_time",
  !("sequences" in sub) && !("first_wait_time" in sub));

console.log(
  failures === 0 ? "\nall first-campaign checks OK" : `\n${failures} failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
