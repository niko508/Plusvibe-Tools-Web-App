// Unit checks for the Azure Start Warmup settings: what is accepted, what is
// sent to Plusvibe, and how a damaged file is read. Imports the REAL module.
//
//   node scripts/check-warmup-settings.mjs

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

const { DEFAULT_WARMUP_SETTINGS: D, LEGACY_WARMUP_SETTINGS: LEGACY, validateWarmupSettings, normalizeWarmupSettings, toPlusvibeWarmup, describeWarmup, signatureHtml } =
  await importTs("@/lib/azure-warmup/warmup-settings");

console.log("--- defaults, and runs from before the settings tab");
// Exactly what the tool sent when these values were fixed in code — which
// is what a run from before the signature setting still sends.
eq("a run from before the settings tab still sends what the tool always sent", toPlusvibeWarmup(LEGACY, { withSignature: false }), {
  warmup_max_daily_limit: 18,
  bulk_warmup_is_slow_rampup: "yes",
  warmup_initial_daily_limit: 2,
  warmup_pace_increment: 3,
  warmup_randomize: "yes",
  warmup_randomize_num: 10,
  warmup_reply_rate: 0.46,
  warmup_schedule: {
    tz: "Asia/Singapore",
    from_time: "00:00",
    to_time: "23:59",
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  },
});
eq("the signature is on by default: {{sender_first_name}}, used in warmup",
  [D.signature, D.warmupSignature, toPlusvibeWarmup(D).signature, toPlusvibeWarmup(D).warmup_signature],
  ["{{sender_first_name}}", true, "{{sender_first_name}}", "yes"]);
eq("the default time zone is New York", [D.timezone, toPlusvibeWarmup(D).warmup_schedule.tz], ["America/New_York", "America/New_York"]);
eq("…and read as", describeWarmup(D), "18/day, ramp-up from 2 (+3 a day) ±10% · 46% replies · every day, all day (America/New_York) · signature “{{sender_first_name}}”, in warmup emails");

console.log("--- the signature");
eq("a typed line break becomes <br>", signatureHtml("Best,\n{{sender_first_name}} {{sender_last_name}}\n"), "Best,<br>{{sender_first_name}} {{sender_last_name}}");
{
  const off = toPlusvibeWarmup({ ...D, warmupSignature: false });
  eq("warmup signature off is sent as no", off.warmup_signature, "no");
  const empty = toPlusvibeWarmup({ ...D, signature: "  " });
  eq("an empty signature leaves each inbox's own alone: the field isn't sent", ["signature" in empty, empty.warmup_signature], [false, "yes"]);
  eq("…and is described so", describeWarmup({ ...D, signature: "" }).endsWith("· each inbox's own signature, in warmup emails"), true);
}
eq("a signature is saved trimmed", validateWarmupSettings({ ...D, signature: "  Hi  " }).settings.signature, "Hi");
eq("a runaway signature is refused", validateWarmupSettings({ ...D, signature: "x".repeat(5001) }).problems, ["The signature can be at most 5000 characters."]);
eq("settings saved before the signature existed read with it on", [normalizeWarmupSettings({ ...D, signature: undefined, warmupSignature: undefined }).signature, normalizeWarmupSettings({ maxDailyLimit: 30 }).warmupSignature], ["{{sender_first_name}}", true]);

console.log("--- what the form may save");
const form = (patch) => ({ ...D, ...patch });
{
  const r = validateWarmupSettings(form({ initialDailyLimit: "5", paceIncrement: "2", maxDailyLimit: "30", replyRatePct: "35.5", slowRampup: false, randomize: false, timezone: "Europe/Helsinki", fromTime: "08:00", toTime: "18:30", days: ["Friday", "Thursday", "Monday", "Wednesday", "Tuesday"], businessType: "Consulting Firms" }));
  eq("numbers typed as text are accepted", r.problems, []);
  const body = toPlusvibeWarmup(r.settings);
  eq("…and sent as Plusvibe wants them", [body.warmup_initial_daily_limit, body.warmup_pace_increment, body.warmup_max_daily_limit, body.warmup_reply_rate, body.bulk_warmup_is_slow_rampup, body.warmup_randomize],
    [5, 2, 30, 0.355, "no", "no"]);
  eq("…days in week order, whatever order they were ticked", body.warmup_schedule.days, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  eq("…with the business type", body.warmup_business_type, "Consulting Firms");
  eq("…read back as", describeWarmup(r.settings), "30/day, no ramp-up · 35.5% replies · Consulting Firms · weekdays, 08:00–18:30 (Europe/Helsinki) · signature “{{sender_first_name}}”, in warmup emails");
}
eq("the generic business type isn't sent, so each inbox keeps its own", "warmup_business_type" in toPlusvibeWarmup(D), false);
eq("the Range in % goes over as a percentage", [toPlusvibeWarmup({ ...D, randomizeNum: 20 }).warmup_randomize_num, describeWarmup({ ...D, randomizeNum: 20 }).includes("±20%")], [20, true]);
const problems = (patch) => validateWarmupSettings(form(patch)).problems;
eq("a start above the maximum is refused", problems({ initialDailyLimit: 20, maxDailyLimit: 10 }), ["The starting daily limit can't be more than the Daily Warmup Limit."]);
eq("…so is a Daily Warmup Limit over Plusvibe's 50", problems({ maxDailyLimit: 51 }), ["Daily Warmup Limit must be a whole number from 1 to 50."]);
eq("…and a business type Plusvibe doesn't have", problems({ businessType: "Pet Grooming" }), ['"Pet Grooming" is not one of Plusvibe\'s business types.']);
eq("…so are fractions and zero", problems({ paceIncrement: 1.5, maxDailyLimit: 0 }).length, 2);
eq("…a reply rate over 100", problems({ replyRatePct: 120 }), ["Warmup Reply Rate must be a percentage from 0 to 100."]);
eq("…a time zone that isn't one", problems({ timezone: "Mars/Olympus" })[0].startsWith('"Mars/Olympus" is not a time zone'), true);
eq("…a window that ends before it starts", problems({ fromTime: "18:00", toTime: "08:00" }), ["End time must be later than the start time."]);
eq("…a time that isn't one", problems({ fromTime: "8am" }), ["Start time must be a time like 08:00."]);
eq("…and fewer than the 5 days Plusvibe needs", problems({ days: ["Monday", "Friday"] }), ["The warmup schedule needs at least 5 days."]);
eq("an empty field is named, not read as 0", problems({ maxDailyLimit: "" }), ["Daily Warmup Limit must be a whole number from 1 to 50."]);
eq("nothing is saved while anything is wrong", validateWarmupSettings(form({ days: [] })).settings, null);

console.log("--- a damaged or missing file");
eq("nothing saved yet reads as the defaults", normalizeWarmupSettings(undefined), D);
eq("one bad field falls back alone; the rest are kept",
  normalizeWarmupSettings({ ...D, maxDailyLimit: 30, timezone: "Nowhere/Land" }),
  { ...D, maxDailyLimit: 30 });
eq("a field this build doesn't know is dropped", Object.keys(normalizeWarmupSettings({ ...D, extra: 1 })).includes("extra"), false);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
