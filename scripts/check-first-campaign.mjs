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

// --- Campaign name ----------------------------------------------------------
console.log("--- campaign name");
// Fixed, not asked for. The re-run guard matches on it, so a change here
// silently turns re-runs into duplicate campaigns.
eq("the campaign is always TEMPLATE CAMPAIGN", bp.CAMPAIGN_NAME, "TEMPLATE CAMPAIGN");

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

// The one that bit for real: Plusvibe ships a built-in "Meeting Booked", and
// the blueprint wants the workspace's own "🤑 meeting booked". They normalize
// identically, so without the system filter the trigger gets wired to a label
// nobody applies and simply never fires.
console.log("--- system vs custom labels that collide");
const collide = lb.planLabels(
  [{ name: "🤑 meeting booked", sentiment: "POSITIVE" }],
  [
    { key: "MEETING_BOOKED", name: "Meeting Booked", isSystem: true },
    { key: "_MEETING_BOOKED", name: "🤑 meeting booked", isSystem: false },
  ]
);
eq("the custom label wins over the system one",
  collide.matched[0].existing.key, "_MEETING_BOOKED");
// Order must not decide it either.
eq("still wins when the system label is listed second",
  lb.planLabels([{ name: "🤑 meeting booked", sentiment: "POSITIVE" }], [
    { key: "_MEETING_BOOKED", name: "🤑 meeting booked", isSystem: false },
    { key: "MEETING_BOOKED", name: "Meeting Booked", isSystem: true },
  ]).matched[0].existing.key, "_MEETING_BOOKED");
// With ONLY the system label present, the custom one is created rather than
// the system one being hijacked.
const systemOnly = lb.planLabels(
  [{ name: "🤑 meeting booked", sentiment: "POSITIVE" }],
  [{ key: "MEETING_BOOKED", name: "Meeting Booked", isSystem: true }]
);
eq("a system-only workspace creates the custom label", systemOnly.missing.length, 1);
eq("and matches nothing", systemOnly.matched.length, 0);
// The longer custom labels must not be captured by the shorter one.
const three = lb.planLabels(
  [
    { name: "🤑 meeting booked", sentiment: "POSITIVE" },
    { name: "🤑 meeting booked - cell phone call", sentiment: "POSITIVE" },
    { name: "🤑 meeting booked - prospect's calendar link", sentiment: "POSITIVE" },
  ],
  [
    { key: "MEETING_BOOKED", name: "Meeting Booked", isSystem: true },
    { key: "K1", name: "🤑 meeting booked", isSystem: false },
    { key: "K2", name: "🤑 meeting booked - cell phone call", isSystem: false },
    { key: "K3", name: "🤑 meeting booked - prospect's calendar link", isSystem: false },
  ]
);
eq("all three meeting-booked labels resolve distinctly",
  three.matched.map((m) => m.existing.key), ["K1", "K2", "K3"]);
eq("none of them fall back to the system label", three.missing.length, 0);

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
  startDate: "2026-08-29",
});
eq("parent carries the ids", [parent.workspace_id, parent.campaign_id],
  ["w".repeat(24), "c".repeat(24)]);
eq("parent carries one step", parent.sequences.length, 1);
eq("parent carries the tag as an email account", parent.email_accounts, ["t".repeat(24)]);
eq("parent carries the schedule", parent.schedules.timing, { from: "07:30", to: "17:30" });
// The live API requires start_date even though the docs call it optional.
eq("parent schedule carries a start date", parent.schedules.start_date, "2026-08-29");
ok("an omitted start date defaults to today in the campaign timezone",
  /^\d{4}-\d{2}-\d{2}$/.test(
    bp.buildParentUpdate({ workspaceId: "w", campaignId: "c", emailAccounts: [] })
      .schedules.start_date
  ));
eq("today is formatted YYYY-MM-DD",
  bp.todayInTimezone("America/New_York", new Date("2026-08-29T18:00:00Z")),
  "2026-08-29");
// Near midnight UTC the New York date is still the previous day; using the
// campaign's own timezone is what keeps "start immediately" from slipping.
eq("the campaign timezone decides the date, not UTC",
  bp.todayInTimezone("America/New_York", new Date("2026-08-30T02:00:00Z")),
  "2026-08-29");
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
// A sub-sequence with no copy yet must not send `sequences` — and therefore
// must not send first_wait_time, which the API only accepts alongside it.
ok("a content-less subsequence sends no sequences and no first_wait_time",
  !("sequences" in sub) && !("first_wait_time" in sub));

// --- Sub-sequence content ---------------------------------------------------
console.log("--- sub-sequence content");
ok("every sub-sequence now has copy", bp.SUBSEQUENCES.every((s) => s.content),
  bp.SUBSEQUENCES.filter((s) => !s.content).map((s) => s.name).join(", "));

const byName = (n) => bp.SUBSEQUENCES.find((s) => s.name === n);
// Initial delay, then the gap between step 1 and 2, exactly as specified.
for (const [name, first, unit, gap, steps] of [
  ["Positive Reply 1", 1, "days", 2, 2],
  ["Evergreen Follow Up", 2, "days", 3, 2],
  ["Positive Reply 2", 2, "days", 3, 2],
  ["No Show", 2, "days", 2, 2],
  ["Meeting Confirmation - Normal", 120, "minutes", 1, 1],
  ["Meeting Confirmation - Prospect's Calendar", 120, "minutes", 1, 1],
]) {
  const c = byName(name).content;
  eq(`${name} cadence`,
    [c.firstWait, c.firstWaitUnit, c.steps[0].waitDays, c.steps.length],
    [first, unit, gap, steps]);
}
// Nothing follows the last step, so its wait never elapses.
// The API rejects wait_time 0 even on a final step that never elapses.
ok("every last step waits at least 1",
  bp.SUBSEQUENCES.every((s) => s.content.steps.at(-1).waitDays >= 1));
ok("no step anywhere waits 0",
  bp.SUBSEQUENCES.every((s) => s.content.steps.every((x) => x.waitDays >= 1)));

// Positive Reply 1 and Evergreen send the same two emails; only the cadence
// differs. If someone edits one copy and not the other, this catches it.
eq("Positive Reply 1 and Evergreen share step 1",
  byName("Positive Reply 1").content.steps[0].body,
  byName("Evergreen Follow Up").content.steps[0].body);
eq("the three reply sub-sequences share step 2",
  new Set(["Positive Reply 1", "Evergreen Follow Up", "Positive Reply 2"]
    .map((n) => byName(n).content.steps[1].body)).size, 1);
ok("Positive Reply 2 has its own step 1",
  byName("Positive Reply 2").content.steps[0].body !==
    byName("Positive Reply 1").content.steps[0].body);
// No Show is its own copy end to end — it must not have picked up the shared
// step 2 by accident.
ok("No Show step 2 is its own",
  byName("No Show").content.steps[1].body !==
    byName("Positive Reply 1").content.steps[1].body);

// Copy details that would be invisible until sent.
const pr1s1 = byName("Positive Reply 1").content.steps[0].body;
const pr2s1 = byName("Positive Reply 2").content.steps[0].body;
const s2 = byName("Positive Reply 1").content.steps[1].body;
const ns1 = byName("No Show").content.steps[0].body;
const ns2 = byName("No Show").content.steps[1].body;
const mcn = byName("Meeting Confirmation - Normal").content.steps[0].body;
const mcp = byName("Meeting Confirmation - Prospect's Calendar").content.steps[0].body;

ok("step 1 asks about the times", pr1s1.includes("Did those times work for you?"));
ok("step 1 offers 11am - 4pm", pr1s1.includes("between 11am - 4pm if that helps."));
ok("Positive Reply 2 answers a question", pr2s1.includes("Did that answer your question?"));
ok("Positive Reply 2 offers 12pm - 4pm", pr2s1.includes("between 12pm - 4pm."));
ok("Positive Reply 2 says 'availability on', not 'also on'",
  pr2s1.includes("I have availability on ") && !pr2s1.includes("availability also on"));
// Supplied that way: it ends on "Thanks," with no sender token.
ok("Positive Reply 2 step 1 ends without a sender token",
  pr2s1.trimEnd().endsWith("Thanks,") && !pr2s1.includes("{{sender_first_name}}"));
ok("step 2 runs the greeting into the sentence",
  s2.includes("{% endif %} haven't heard back"));
ok("step 2 offers 10am - 2pm", s2.includes("between 10am - 2pm."));
ok("step 2 signs off with the sender", s2.trimEnd().endsWith("{{sender_first_name}}"));

ok("No Show step 1 offers another time",
  ns1.includes("Still happy to find another time that works."));
ok("No Show step 1 offers 12pm - 4pm", ns1.includes("I'm free between 12pm - 4pm."));
ok("No Show step 2 offers to stop", ns2.includes("I don't want to keep following up"));
ok("No Show step 2 offers 10am - 3pm", ns2.includes("between 10am - 3pm."));
ok("No Show step 2 closes warmly", ns2.includes("Either way, appreciate your time."));

ok("Meeting Confirmation - Normal runs into the greeting",
  mcn.includes("{% endif %} just to double-check:"));
ok("Meeting Confirmation - Normal asks about the invite",
  mcn.includes("Did you get the calendar invite from our JOB TITLE, CLIENT FIRST NAME?"));
ok("Meeting Confirmation - Normal keeps the curly quotes",
  mcn.includes("\u201CYour Name and Alix Rudin\u201D"));
ok("Meeting Confirmation - Prospect's names the speaker",
  mcp.includes("HE/SHE will be the one speaking with you."));
ok("Meeting Confirmation - Prospect's asks about the booking",
  mcp.includes("Did the booking come through to you as well?"));
// The ALL-CAPS markers are deliberate template placeholders and must NOT be
// reported as unfinished work — only the stale real name is.
ok("the caps markers are left in the copy",
  mcn.includes("JOB TITLE") && mcn.includes("CLIENT FIRST NAME") &&
  mcp.includes("JOB TITLE") && mcp.includes("HE/SHE"));
eq("the caps markers are not reported as edits",
  bp.SUBSEQUENCES.flatMap((x) => x.content.manualEdits ?? [])
    .filter((e) => /JOB TITLE|CLIENT FIRST NAME|HE\/SHE/.test(e)),
  []);
eq("only the stale name is reported",
  bp.SUBSEQUENCES.flatMap((x) => x.content.manualEdits ?? []),
  ["Your Name and Alix Rudin"]);
ok("the reported text is actually in the copy",
  mcn.includes("Your Name and Alix Rudin"));

// The tables must render cleanly on the days that can actually send, Mon-Fri.
// The weekend is deliberately uncovered: the schedules never send then, and no
// fallback wording is wanted, so a weekend preview showing "Does  work?" is
// intended. These checks pin that down in both directions, so neither the
// weekday branches nor the deliberate weekend gap can drift unnoticed.
console.log("--- weekday tables, Mon-Fri and the deliberate weekend gap");
/**
 * Minimal Liquid evaluator for the one construct these tables use.
 *
 * Scanned with indexOf rather than one big regex: the assign contains
 * `date: '%u'`, and a `%`-excluding character class silently fails to match
 * it — which made an earlier version of this helper return the body
 * unchanged, so every "renders fine" assertion passed without substituting
 * anything.
 */
function renderWeekday(body, isoDay) {
  let out = "";
  let rest = body;
  for (;;) {
    const start = rest.indexOf("{% assign today_number");
    if (start === -1) return out + rest;
    const endTag = "{% endif %}";
    const end = rest.indexOf(endTag, start);
    if (end === -1) return out + rest;
    const block = rest.slice(start, end + endTag.length);

    const branches = [...block.matchAll(/\{% (?:els)?if today_number == (\d) %\}([^{]*)/g)]
      .map((m) => [Number(m[1]), m[2]]);
    const hit = branches.find(([d]) => d === isoDay);
    const els = /\{% else %\}([^{]*)/.exec(block);
    const value = hit ? hit[1] : els ? els[1] : "";

    out += rest.slice(0, start) + value;
    rest = rest.slice(end + endTag.length);
  }
}

// The helper has to actually substitute, or every assertion below is vacuous.
// It only resolves the weekday tables — the greeting's own {% if %} is left
// alone, so this checks for today_number specifically rather than any liquid.
ok("the evaluator resolves the weekday table",
  !renderWeekday(ns1, 3).includes("today_number"),
  renderWeekday(ns1, 3).slice(0, 100));
ok("and leaves the greeting alone",
  renderWeekday(ns1, 3).includes("{% if first_name != blank %}"));
eq("and picks the right weekday branch",
  renderWeekday("x {% assign today_number = 'now' | date: '%u' | plus: 0 %}" +
    "{% if today_number == 1 %}MON{% elsif today_number == 3 %}WED" +
    "{% else %}ELSE{% endif %} y", 3),
  "x WED y");

for (const [label, body] of [
  ["Positive Reply 1 step 1", pr1s1],
  ["Positive Reply 2 step 1", pr2s1],
  ["shared step 2", s2],
  ["No Show step 1", ns1],
  ["No Show step 2", ns2],
]) {
  for (let day = 1; day <= 5; day++) {
    const out = renderWeekday(body, day);
    const gap = /\b(on|Does|availability|do)\s{2,}|\s{2,}(work|between)/.test(out);
    ok(`${label} renders on ISO day ${day}`, !gap,
      JSON.stringify(out.split("\n\n").find((l) => /\s{2,}/.test(l)) ?? ""));
  }
}
// The weekend, asserted as INTENDED rather than fixed. The two "near" tables
// have no else by design; step 2's far table was supplied with one.
for (const day of [6, 7]) {
  eq(`No Show step 1 leaves the phrase out on ISO day ${day}`,
    renderWeekday(ns1, day).split("\n\n")[2], "Does  work?");
  ok(`the shared step 2 still renders on ISO day ${day}`,
    renderWeekday(s2, day).includes("early next week"),
    renderWeekday(s2, day).split("\n\n")[1]);
}
ok("no else branch was added to the near tables",
  !pr1s1.includes("{% else %}early next week") &&
  !ns1.includes("{% else %}early next week"));
ok("the far table keeps the else it was supplied with",
  s2.includes("{% else %}early next week"));

// The weekday branch tables. All three now carry an else branch.
for (const [label, body, branches, hasElse] of [
  ["reply step 1", pr1s1, ["this Wednesday and Thursday", "this Thursday and Friday",
    "this Friday or next Monday", "next Monday or Tuesday", "next Tuesday or Wednesday"], false],
  ["reply step 2", s2, ["this Thursday or Friday", "this Friday or next Monday",
    "next Monday or Tuesday", "next Tuesday or Wednesday", "next Wednesday or Thursday"], true],
  ["No Show step 1", ns1, ["this Wednesday or Thursday", "this Thursday or Friday",
    "this Friday or next Monday", "next Monday or Tuesday", "next Tuesday or Wednesday"], false],
  ["No Show step 2", ns2, ["this Wednesday or Thursday", "this Thursday or Friday",
    "this Friday or next Monday", "next Monday or Tuesday", "next Tuesday or Wednesday"], false],
]) {
  ok(`${label} has all five weekday branches`,
    branches.every((b) => body.includes(b)),
    branches.filter((b) => !body.includes(b)).join(" / "));
  eq(`${label} else branch`, body.includes("{% else %}early next week"), hasElse);
  ok(`${label} assigns today_number once`,
    (body.match(/assign today_number/g) ?? []).length === 1);
  ok(`${label} closes its liquid`, (body.match(/\{% endif %\}/g) ?? []).length === 2);
}
// No Show uses the "or" table, not the "and" one — they differ only on Mon/Tue.
ok("No Show uses the 'or' phrasing on Monday and Tuesday",
  ns1.includes("this Wednesday or Thursday") && !ns1.includes("this Wednesday and Thursday"));
// The meeting confirmations offer no times at all, so they carry no table.
ok("the confirmations carry no weekday table",
  !mcn.includes("today_number") && !mcp.includes("today_number"));

// The PATCH the runner actually sends.
const subFull = bp.buildSubsequenceUpdate({
  workspaceId: "w", campaignId: "c",
  content: byName("Positive Reply 1").content,
});
eq("content patch carries first_wait_time", subFull.first_wait_time, 1);
eq("content patch names the unit", subFull.first_wait_time_unit, "days");
// A confirmation waits two hours, not two days — the unit has to travel with
// the number or the email lands 120 days late.
const subMinutes = bp.buildSubsequenceUpdate({
  workspaceId: "w", campaignId: "c",
  content: byName("Meeting Confirmation - Normal").content,
});
eq("a minutes-based delay keeps its unit",
  [subMinutes.first_wait_time, subMinutes.first_wait_time_unit], [120, "minutes"]);
eq("a one-step subsequence sends one step", subMinutes.sequences.length, 1);
eq("content patch carries two steps", subFull.sequences.length, 2);
eq("steps are numbered from 1", subFull.sequences.map((x) => x.step), [1, 2]);
eq("step waits", subFull.sequences.map((x) => x.wait_time), [2, 1]);
eq("content patch keeps its own window", subFull.schedules.timing,
  { from: "09:30", to: "15:30" });
ok("a subsequence schedule also carries a start date",
  /^\d{4}-\d{2}-\d{2}$/.test(subFull.schedules.start_date),
  String(subFull.schedules.start_date));
// Empty subject on EVERY step: that's what makes it a reply on the lead's
// existing thread rather than a new one.
ok("every step has an empty subject",
  subFull.sequences.every((x) => x.variations[0].subject === ""));
ok("every step has one variation A",
  subFull.sequences.every((x) => x.variations.length === 1 && x.variations[0].variation === "A"));
// The liquid must survive HTML conversion, same as step 1 of the parent.
const html = subFull.sequences[0].variations[0].body;
ok("subsequence liquid survives conversion",
  html.includes("{% if first_name != blank %}") && html.includes("{% assign today_number"));
ok("subsequence html is not escaped", !html.includes("&lt;") && !html.includes("&gt;"));
ok("subsequence body is wrapped in divs", html.startsWith("<div>"));

console.log(
  failures === 0 ? "\nall first-campaign checks OK" : `\n${failures} failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
