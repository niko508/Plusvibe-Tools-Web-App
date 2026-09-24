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

const { DEFAULT_WARMUP_SETTINGS: D, validateWarmupSettings, normalizeWarmupSettings, toPlusvibeWarmup, describeWarmup } =
  await importTs("@/lib/azure-warmup/warmup-settings");

console.log("--- the defaults change nothing");
// Exactly what the tool sent when these values were fixed in code.
eq("the defaults send what the tool always sent", toPlusvibeWarmup(D), {
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
eq("…and read as", describeWarmup(D), "2 → 18/day, +3 a day (slow ramp-up) ±10 · 46% replies · every day, all day (Asia/Singapore)");

console.log("--- what the form may save");
const form = (patch) => ({ ...D, ...patch });
{
  const r = validateWarmupSettings(form({ initialDailyLimit: "5", paceIncrement: "2", maxDailyLimit: "30", replyRatePct: "35.5", slowRampup: false, randomize: false, timezone: "Europe/Helsinki", fromTime: "08:00", toTime: "18:30", days: ["Friday", "Monday"] }));
  eq("numbers typed as text are accepted", r.problems, []);
  const body = toPlusvibeWarmup(r.settings);
  eq("…and sent as Plusvibe wants them", [body.warmup_initial_daily_limit, body.warmup_pace_increment, body.warmup_max_daily_limit, body.warmup_reply_rate, body.bulk_warmup_is_slow_rampup, body.warmup_randomize],
    [5, 2, 30, 0.355, "no", "no"]);
  eq("…days in week order, whatever order they were ticked", body.warmup_schedule.days, ["Monday", "Friday"]);
  eq("…read back as", describeWarmup(r.settings), "5 → 30/day, +2 a day · 35.5% replies · Mon, Fri, 08:00–18:30 (Europe/Helsinki)");
}
eq("weekdays are called weekdays", describeWarmup({ ...D, days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] }).includes("weekdays, all day"), true);
const problems = (patch) => validateWarmupSettings(form(patch)).problems;
eq("a start above the maximum is refused", problems({ initialDailyLimit: 20, maxDailyLimit: 10 }), ["Starting emails per day can't be more than the maximum."]);
eq("…so are fractions and zero", problems({ paceIncrement: 1.5, maxDailyLimit: 0 }).length, 2);
eq("…a reply rate over 100", problems({ replyRatePct: 120 }), ["Reply rate must be a percentage from 0 to 100."]);
eq("…a time zone that isn't one", problems({ timezone: "Mars/Olympus" })[0].startsWith('"Mars/Olympus" is not a time zone'), true);
eq("…a window that ends before it starts", problems({ fromTime: "18:00", toTime: "08:00" }), ["Send until must be later than send from."]);
eq("…a time that isn't one", problems({ fromTime: "8am" }), ["Send from must be a time like 08:00."]);
eq("…and no days at all", problems({ days: [] }), ["Pick at least one day."]);
eq("an empty field is named, not read as 0", problems({ maxDailyLimit: "" }), ["Maximum emails per day must be a whole number from 1 to 100."]);
eq("nothing is saved while anything is wrong", validateWarmupSettings(form({ days: [] })).settings, null);

console.log("--- a damaged or missing file");
eq("nothing saved yet reads as the defaults", normalizeWarmupSettings(undefined), D);
eq("one bad field falls back alone; the rest are kept",
  normalizeWarmupSettings({ ...D, maxDailyLimit: 30, timezone: "Nowhere/Land" }),
  { ...D, maxDailyLimit: 30 });
eq("a field this build doesn't know is dropped", Object.keys(normalizeWarmupSettings({ ...D, extra: 1 })).includes("extra"), false);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
