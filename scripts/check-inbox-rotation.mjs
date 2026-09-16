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
  validateSetup, describeSetup, isGroup, isPhase,
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
eq("groups are 1 and 2", [isGroup(1), isGroup(2), isGroup(3), isGroup("1")], [true, true, false, false]);
eq("phases are the two periods", [isPhase("rampUp"), isPhase("maintaining"), isPhase("ramp")], [true, true, false]);
eq("a good set-up has no problems", validateSetup({ workspaceId: "ws1", workspaceName: "A", startingGroup: 2, phase: "maintaining" }), []);
eq("every problem is named", validateSetup({ workspaceId: "", startingGroup: 3, phase: "x" }), [
  "Pick a workspace.", "Pick which sending group starts.", "Pick the ramp-up period or the maintaining period.",
]);
eq("a set-up reads as a sentence", describeSetup({ startingGroup: 2, phase: "rampUp" }), "Sending Group 2 first · ramp-up period");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
