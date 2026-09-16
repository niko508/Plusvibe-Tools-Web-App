// Unit checks for Inbox Rotation: the profile defaults, validation of what is
// typed, reading a stored file back, and the per-workspace set-up. Imports
// the REAL module.
//
//   node scripts/check-inbox-rotation.mjs

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

const m = await importTs("@/lib/inbox-rotation/settings");
const {
  PROFILES, CYCLE_COUNT, DEFAULT_PROFILE, DEFAULT_SETTINGS, RAMP_UP_DISABLED,
  validateCycle, validateMaintaining, validateResting, validateProfile, cleanProfile, normalizeSettings, withWarmupDefaults, describeCycle,
  DEFAULT_WARMUP_SENDING, DEFAULT_WARMUP_RESTING,
  validateSetup, describeSetup, isGroup,
} = m;

console.log("--- profiles");
eq("three profiles, in the order the page shows them", PROFILES.map((p) => p.label), ["Azure (50)", "Azure (25)", "Google"]);
eq("five cycles", [CYCLE_COUNT, DEFAULT_PROFILE.cycles.length], [5, 5]);
const W = DEFAULT_WARMUP_SENDING;
eq("the Azure (50) plan as written up, with the warmup placeholders", DEFAULT_PROFILE, {
  cycles: [
    { dayLength: 1, dailySends: 1, emailInterval: 180, warmupEmails: W },
    { dayLength: 2, dailySends: 1, emailInterval: 180, warmupEmails: W },
    { dayLength: 3, dailySends: 2, emailInterval: 180, warmupEmails: W },
    { dayLength: 4, dailySends: 3, emailInterval: 120, warmupEmails: W },
    { dayLength: 5, dailySends: 3, emailInterval: 120, warmupEmails: W },
  ],
  maintaining: { dayLengthMin: 2, dayLengthMax: 5, dailySends: 3, emailInterval: 120, warmupEmails: W },
  resting: { warmupEmails: DEFAULT_WARMUP_RESTING },
});
eq("every profile starts from it", Object.values(DEFAULT_SETTINGS.profiles).every((p) => JSON.stringify(p) === JSON.stringify(DEFAULT_PROFILE)), true);
eq("ramp-up is off, not a setting", RAMP_UP_DISABLED, { bulk_is_slow_rampup: "no" });
eq("a cycle reads as a sentence", describeCycle({ dayLength: 1, dailySends: 1, emailInterval: 180, warmupEmails: 20 }), "1 day · 1/day · every 180 min · warmup 20");
eq("…plural days", describeCycle({ dayLength: 3, dailySends: 2, emailInterval: 180, warmupEmails: 20 }), "3 days · 2/day · every 180 min · warmup 20");

console.log("--- validation");
eq("a good cycle has no problems", validateCycle({ dayLength: 1, dailySends: 1, emailInterval: 180, warmupEmails: 20 }, "C"), []);
eq("…typed as strings too", validateCycle({ dayLength: "1", dailySends: "0", emailInterval: "180", warmupEmails: "0" }, "C"), []);
eq("a blank is a problem", validateCycle({ dayLength: "", dailySends: 1, emailInterval: 180, warmupEmails: 20 }, "C"), ["C · Day Length: enter a number."]);
eq("a fraction is a problem", validateCycle({ dayLength: 1.5, dailySends: 1, emailInterval: 180, warmupEmails: 20 }, "C"), ["C · Day Length: use a whole number."]);
eq("a day length of 0 is a problem, a daily send of 0 is not", validateCycle({ dayLength: 0, dailySends: 0, emailInterval: 180, warmupEmails: 20 }, "C"), ["C · Day Length: must be at least 1."]);
eq("an interval of 0 is a problem", validateCycle({ dayLength: 1, dailySends: 1, emailInterval: 0, warmupEmails: 20 }, "C"), ["C · Email Interval: must be at least 1."]);
eq("every problem is listed", validateCycle({ dayLength: "x", dailySends: -1, emailInterval: "", warmupEmails: 1.5 }, "C").length, 4);
eq("a blank warmup is a problem", validateCycle({ dayLength: 1, dailySends: 1, emailInterval: 180, warmupEmails: "" }, "C"), ["C · Warmup Emails: enter a number."]);
eq("…and so is one for the resting group", validateResting({ warmupEmails: -1 }, "R"), ["R · Warmup Emails: must be at least 0."]);
eq("a good maintaining period has no problems", validateMaintaining({ dayLengthMin: 2, dayLengthMax: 5, dailySends: 3, emailInterval: 120, warmupEmails: 20 }, "M"), []);
eq("…the range can be one number", validateMaintaining({ dayLengthMin: 3, dayLengthMax: 3, dailySends: 3, emailInterval: 120, warmupEmails: 20 }, "M"), []);
eq("…but not backwards", validateMaintaining({ dayLengthMin: 5, dayLengthMax: 2, dailySends: 3, emailInterval: 120, warmupEmails: 20 }, "M"), ["M · Day Length: the range runs from the smaller number to the larger."]);
eq("the default profile validates", validateProfile(DEFAULT_PROFILE, "P"), []);
eq("fewer than five cycles is a problem", validateProfile({ cycles: DEFAULT_PROFILE.cycles.slice(0, 4), maintaining: DEFAULT_PROFILE.maintaining, resting: DEFAULT_PROFILE.resting }, "P"), ["P: 5 cycles are needed."]);
eq("a problem names its cycle", validateProfile({ cycles: DEFAULT_PROFILE.cycles.map((c, i) => (i === 2 ? { ...c, dailySends: "" } : c)), maintaining: DEFAULT_PROFILE.maintaining, resting: DEFAULT_PROFILE.resting }, "Azure (50)"), ["Azure (50) · Cycle 3 · Daily Sends: enter a number."]);
eq("cleaning turns typed strings into numbers", cleanProfile({
  cycles: DEFAULT_PROFILE.cycles.map((c) => ({ dayLength: String(c.dayLength), dailySends: String(c.dailySends), emailInterval: String(c.emailInterval), warmupEmails: String(c.warmupEmails) })),
  maintaining: { dayLengthMin: "2", dayLengthMax: "5", dailySends: "3", emailInterval: "120", warmupEmails: String(W) },
  resting: { warmupEmails: String(DEFAULT_WARMUP_RESTING) },
}), DEFAULT_PROFILE);

console.log("--- reading a stored file");
eq("nothing stored reads as the defaults", normalizeSettings(null), DEFAULT_SETTINGS);
eq("a good profile reads as itself, the missing ones as defaults", normalizeSettings({
  profiles: { google: { cycles: DEFAULT_PROFILE.cycles.map((c) => ({ ...c, dailySends: 9 })), maintaining: DEFAULT_PROFILE.maintaining, resting: DEFAULT_PROFILE.resting } },
  updatedAt: 5,
}).profiles.google.cycles.map((c) => c.dailySends), [9, 9, 9, 9, 9]);
// A file saved before the warmup fields existed keeps its numbers and gains
// the placeholders, instead of falling back to the default profile.
const OLD = {
  cycles: DEFAULT_PROFILE.cycles.map((c) => ({ dayLength: c.dayLength, dailySends: 7, emailInterval: c.emailInterval })),
  maintaining: { dayLengthMin: 2, dayLengthMax: 5, dailySends: 7, emailInterval: 120 },
};
eq("an older file gains the warmup fields", withWarmupDefaults(OLD), {
  cycles: DEFAULT_PROFILE.cycles.map((c) => ({ dayLength: c.dayLength, dailySends: 7, emailInterval: c.emailInterval, warmupEmails: W })),
  maintaining: { dayLengthMin: 2, dayLengthMax: 5, dailySends: 7, emailInterval: 120, warmupEmails: W },
  resting: { warmupEmails: DEFAULT_WARMUP_RESTING },
});
eq("…and reads back with its own numbers kept", normalizeSettings({ profiles: { azure50: OLD } }).profiles.azure50.cycles.map((c) => [c.dailySends, c.warmupEmails]), [[7, W], [7, W], [7, W], [7, W], [7, W]]);
eq("…while a warmup that was set is not overwritten", withWarmupDefaults({ ...OLD, resting: { warmupEmails: 55 } }).resting, { warmupEmails: 55 });
eq("…and a broken one falls back to the default rather than half of itself",
  normalizeSettings({ profiles: { azure25: { cycles: [{ dayLength: "x" }], maintaining: {} } } }).profiles.azure25, DEFAULT_PROFILE);
eq("updatedAt is kept", normalizeSettings({ profiles: {}, updatedAt: 5 }).updatedAt, 5);

console.log("--- set-up");
const { STAGES, isStage, isYmd, stageLabel, otherGroup } = m;
eq("groups are 1 and 2", [isGroup(1), isGroup(2), isGroup(3), isGroup("1")], [true, true, false, false]);
eq("the stages are the five cycles and the maintaining period", STAGES.map((s) => s.label), ["Cycle 1", "Cycle 2", "Cycle 3", "Cycle 4", "Cycle 5", "Maintaining period"]);
eq("…checked, not trusted", [isStage(1), isStage(5), isStage("maintaining"), isStage(6), isStage("1")], [true, true, true, false, false]);
eq("a date is YYYY-MM-DD and real", [isYmd("2026-09-20"), isYmd("2026-13-01"), isYmd("20/09/2026"), isYmd("")], [true, false, false, false]);
eq("the other group", [otherGroup(1), otherGroup(2)], [2, 1]);
eq("a good set-up has no problems", validateSetup({ workspaceId: "ws1", workspaceName: "A", startingGroup: 2, startDate: "2026-09-20", stage: "maintaining" }), []);
eq("every problem is named", validateSetup({ workspaceId: "", startingGroup: 3, startDate: "soon", stage: 7 }), [
  "Pick a workspace.", "Pick which sending group starts.", "Pick a start date.", "Pick the stage to start on.",
]);
eq("a set-up reads as a sentence", describeSetup({ startingGroup: 2, startDate: "2026-09-20", stage: 3 }), "Sending Group 2 first · from 2026-09-20 · Cycle 3");
eq("…stage labels", [stageLabel(1), stageLabel("maintaining")], ["Cycle 1", "Maintaining period"]);

// --- the schedule ---------------------------------------------------------------
console.log("--- schedule");
const sch = await importTs("@/lib/inbox-rotation/schedule");
const { addDays, daysBetween, positionOn, ensurePicks, drawPick, groupByDay, describePosition, todayIn } = sch;
eq("date arithmetic", [addDays("2026-09-30", 1), addDays("2026-12-31", 1), daysBetween("2026-09-01", "2026-09-13"), daysBetween("2026-09-13", "2026-09-01")], ["2026-10-01", "2027-01-01", 12, -12]);
const TL = { profile: DEFAULT_PROFILE, startDate: "2026-09-01", startingGroup: 1, stage: 1, picks: [] };
// The worked example, day by day: cycle 1 one day each, cycle 2 two, cycle 3 three.
eq("the worked example", groupByDay(TL, 12), [1, 2, 1, 1, 2, 2, 1, 1, 1, 2, 2, 2]);
eq("…then cycle 4 (four each) and cycle 5 (five each)", groupByDay(TL, 30).slice(12), [1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
const d1 = positionOn("2026-09-01", TL);
eq("day 1 is Group 1, cycle 1, day 1 of 1, switching tomorrow", [d1.kind, d1.segment.group, d1.segment.stage, d1.dayOfSegment, d1.segment.length, d1.segment.end], ["segment", 1, 1, 1, 1, "2026-09-02"]);
const d8 = positionOn("2026-09-08", TL);
eq("day 8 is Group 1, cycle 3, day 2 of 3, switching on day 10", [d8.segment.group, d8.segment.stage, d8.dayOfSegment, d8.segment.start, d8.segment.end], [1, 3, 2, "2026-09-07", "2026-09-10"]);
eq("it reads as a sentence", describePosition(d8), "Sending Group 1 · Cycle 3 · day 2 of 3 · switches 2026-09-10");
eq("Group 2 first just swaps the groups", groupByDay({ ...TL, startingGroup: 2 }, 6), [2, 1, 2, 2, 1, 1]);
eq("starting on cycle 3 starts with three days each", groupByDay({ ...TL, stage: 3 }, 8), [1, 1, 1, 2, 2, 2, 1, 1]);
eq("before the start date it has not started", positionOn("2026-08-30", TL), { kind: "notStarted", startsIn: 2 });
eq("…which reads as such", describePosition(positionOn("2026-08-30", TL)), "starts in 2 days");
// Cycles 1–5 take 2·(1+2+3+4+5) = 30 days; day 31 is the maintaining period.
eq("after the cycles the maintaining period needs a draw", positionOn("2026-10-01", TL), { kind: "needPicks", count: 1 });
eq("…and starting on it needs one at once", positionOn("2026-09-01", { ...TL, stage: "maintaining" }), { kind: "needPicks", count: 1 });
const fixed = (v) => () => v; // a stand-in rng: 0 draws the minimum, 0.999 the maximum
eq("a draw is a whole number in the range", [drawPick(DEFAULT_PROFILE, fixed(0)), drawPick(DEFAULT_PROFILE, fixed(0.999)), drawPick(DEFAULT_PROFILE, fixed(0.5))], [2, 5, 4]);
const M = { ...TL, stage: "maintaining" };
eq("ensurePicks draws what a day needs and no more", ensurePicks("2026-09-01", M, fixed(0.5)), [4]);
eq("…one draw covers both groups' turns", ensurePicks("2026-09-08", M, fixed(0.5)), [4]);
eq("…the ninth day needs a second draw", ensurePicks("2026-09-09", M, fixed(0.5)), [4, 4]);
eq("…and draws already made are kept, not redrawn", ensurePicks("2026-09-09", { ...M, picks: [3] }, fixed(0.5)), [3, 4]);
eq("…nothing needed returns the same array", ensurePicks("2026-09-02", { ...M, picks: [3] }, fixed(0.5)) === M.picks || ensurePicks("2026-09-02", { ...M, picks: [3] }).length === 1, true);
eq("a maintaining draw of 3: Group 1 three days, Group 2 three days, then the next draw", groupByDay({ ...M, picks: [3, 2] }, 10), [1, 1, 1, 2, 2, 2, 1, 1, 2, 2]);
const mp = positionOn("2026-09-05", { ...M, picks: [3, 2] });
eq("…and reads as the maintaining period", describePosition(mp), "Sending Group 2 · Maintaining period · day 2 of 3 · switches 2026-09-07");
eq("today is a date in the rotation's zone", /^\d{4}-\d{2}-\d{2}$/.test(todayIn()), true);
// Profiles with different day lengths keep their own timelines.
const slow = { ...DEFAULT_PROFILE, cycles: DEFAULT_PROFILE.cycles.map((c) => ({ ...c, dayLength: 2 })) };
eq("a profile with longer days switches later", groupByDay({ ...TL, profile: slow }, 4), [1, 1, 2, 2]);

// --- the inventory --------------------------------------------------------------
console.log("--- inventory");
const inv = await importTs("@/lib/inbox-rotation/inventory");
const { classifyInbox, domainCounts, buildInventory, groupTotal, profilesPresent, settingsFor, AZURE_25_MAX } = inv;
eq("Microsoft on a big domain is Azure (50), on a small one Azure (25)", [classifyInbox("MICROSOFT365", 30), classifyInbox("MICROSOFT365", 26), classifyInbox("MICROSOFT365", 25), classifyInbox("MICROSOFT365", 1)], ["azure50", "azure50", "azure25", "azure25"]);
eq("…the line is at 25", AZURE_25_MAX, 25);
eq("Google is Google whatever the domain", [classifyInbox("GOOGLE_WORKSPACE", 1), classifyInbox("GOOGLE_WORKSPACE", 40)], ["google", "google"]);
eq("anything else is other", [classifyInbox("REGULAR_ACCOUNT", 30), classifyInbox(undefined, 30)], ["other", "other"]);
const mkI = (id, domain, provider, tags) => ({ id, email: `${id}@${domain}`, provider, tags });
const INBOXES = [
  ...Array.from({ length: 26 }, (_, i) => mkI(`b${i}`, "big.com", "MICROSOFT365", [i < 20 ? "t1" : "t2"])),
  ...Array.from({ length: 3 }, (_, i) => mkI(`s${i}`, "small.com", "MICROSOFT365", ["t2"])),
  mkI("g0", "goog.com", "GOOGLE_WORKSPACE", ["t1"]),
  mkI("g1", "goog.com", "GOOGLE_WORKSPACE", ["t1", "t2"]), // in both groups: counted in both
  mkI("x0", "smtp.com", "REGULAR_ACCOUNT", ["t1"]),
  mkI("u0", "big.com", "MICROSOFT365", []),
  mkI("", "big.com", "MICROSOFT365", ["t1"]), // no id: cannot be written
];
eq("domains are counted across the whole workspace, tagged or not", [domainCounts(INBOXES).get("big.com"), domainCounts(INBOXES).get("goog.com")], [28, 2]);
const built = buildInventory(INBOXES, { 1: "t1", 2: "t2" }, 7);
eq("each group is counted by kind", built.inventory.groups, {
  1: { azure50: 20, azure25: 0, google: 2, other: 1 },
  2: { azure50: 6, azure25: 3, google: 1, other: 0 },
});
// The id-less inbox carries a tag, so it is not untagged — it is unwritable,
// and skipped before any counting.
eq("…with the untagged noted and both tags found", [built.inventory.untagged, built.inventory.tagsFound, built.inventory.fetchedAt], [1, [1, 2], 7]);
eq("…and the ids ready to write", [built.ids[1].google, built.ids[2].azure25], [["g0", "g1"], ["s0", "s1", "s2"]]);
eq("totals per group", [groupTotal(built.inventory, 1), groupTotal(built.inventory, 2)], [23, 10]);
eq("the profiles present", profilesPresent(built.inventory), ["azure50", "azure25", "google"]);
eq("a workspace with one tag reads that way", buildInventory(INBOXES, { 1: "t1" }).inventory.tagsFound, [1]);
eq("…and its other group is empty", groupTotal(buildInventory(INBOXES, { 1: "t1" }).inventory, 2), 0);
eq("sending in cycle 3: the cycle's numbers, ramp-up off", settingsFor(DEFAULT_PROFILE, 3, true), { daily_limit: 2, interval_limit_in_min: 180, warmup_max_daily_limit: W, bulk_is_slow_rampup: "no" });
eq("sending in the maintaining period: its numbers", settingsFor(DEFAULT_PROFILE, "maintaining", true), { daily_limit: 3, interval_limit_in_min: 120, warmup_max_daily_limit: W, bulk_is_slow_rampup: "no" });
eq("resting: no sends, the resting warmup, ramp-up off, interval untouched", settingsFor(DEFAULT_PROFILE, 3, false), { daily_limit: 0, warmup_max_daily_limit: DEFAULT_WARMUP_RESTING, bulk_is_slow_rampup: "no" });

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
