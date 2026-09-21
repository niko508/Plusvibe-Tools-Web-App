// Unit checks for Change Campaign Settings: reading the API's mixed forms,
// validating changes, the per-campaign diff, the PATCH body and the read-back
// check. Imports the REAL module.
//
//   node scripts/check-campaign-settings.mjs

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

const m = await importTs("@/lib/campaign-settings/settings");
const { SETTINGS, specFor, readValue, validateChange, prepareChanges, diffCampaign, patchBody, unverified, unconfirmable, describeChanges, IN_SCOPE_STATUSES, RATIO_PRESETS, wireValue, describeRatio } = m;
const esp = specFor("is_esp_match");
const varSel = specFor("var_sel_type");
const maxLead = specFor("max_lead_domain_per_day");

// --- reading what the API reports ------------------------------------------------
eq("ESP matching is in the catalogue as a toggle", esp?.kind, "toggle");
eq("a toggle read as 1 is yes", readValue(esp, 1), "yes");
eq("…as 0 is no", readValue(esp, 0), "no");
eq("…as 'yes' is yes", readValue(esp, "yes"), "yes");
eq("…as true is yes", readValue(esp, true), "yes");
eq("…as '0' is no", readValue(esp, "0"), "no");
eq("…missing is null", readValue(esp, undefined), null);
eq("…garbage is null", readValue(esp, "maybe"), null);
eq("a choice reads as its string", readValue(varSel, "R_ROBIN"), "R_ROBIN");
eq("a number reads as a number, even from a string", readValue(maxLead, "2"), 2);
eq("a non-number is null", readValue(maxLead, "two"), null);

// --- validation ------------------------------------------------------------------------
eq("toggle on is fine", validateChange({ key: "is_esp_match", value: "yes" }), []);
eq("toggle must be yes/no", validateChange({ key: "is_esp_match", value: "on" }), ["ESP matching: choose On or Off."]);
eq("unknown setting is refused", validateChange({ key: "status", value: "ACTIVE" }), ['"status" is not a setting this tool can change.']);
eq("choice must be one of the options", validateChange({ key: "var_sel_type", value: "RANDOM" }), ["Follow-up variation selection: pick one of the options."]);
eq("number below the minimum is refused", validateChange({ key: "max_lead_domain_per_day", value: 0 }), ["Max leads per domain per day: must be at least 1."]);
eq("a blank number is refused", validateChange({ key: "opportunity_val", value: "" }).length, 1);
eq("a number as a string is fine", validateChange({ key: "opportunity_val", value: "250" }), []);

const prep = prepareChanges([
  { key: "stop_on_lead_replied", value: "no" },
  { key: "is_esp_match", value: "no" },
  { key: "is_esp_match", value: "yes" }, // the later one wins
  { key: "opportunity_val", value: "250" },
  { key: "bogus", value: "x" },
]);
eq("changes come out in catalogue order, one per setting, numbers as numbers", prep.changes, [
  { key: "is_esp_match", value: "yes" },
  { key: "stop_on_lead_replied", value: "no" },
  { key: "opportunity_val", value: 250 },
]);
eq("…with the bad one reported", prep.problems, ['"bogus" is not a setting this tool can change.']);
eq("nothing picked → nothing", prepareChanges([]), { changes: [], problems: [] });

// --- the per-campaign diff ------------------------------------------------------------------
const WANT = [{ key: "is_esp_match", value: "yes" }, { key: "stop_on_lead_replied", value: "yes" }];
eq("a campaign with ESP off needs ESP only", diffCampaign(WANT, { is_esp_match: 0, stop_on_lead_replied: 1 }), [{ key: "is_esp_match", value: "yes" }]);
eq("a campaign already set needs nothing", diffCampaign(WANT, { is_esp_match: "yes", stop_on_lead_replied: true }), []);
eq("a campaign that doesn't report a setting gets it written", diffCampaign(WANT, { stop_on_lead_replied: 1 }), [{ key: "is_esp_match", value: "yes" }]);
eq("a number is compared as a number", diffCampaign([{ key: "opportunity_val", value: 250 }], { opportunity_val: "250" }), []);

// --- the write and the read-back --------------------------------------------------------------
eq("the PATCH body carries ids and only the needed settings", patchBody("ws1", "c1", [{ key: "is_esp_match", value: "yes" }]), { workspace_id: "ws1", campaign_id: "c1", is_esp_match: "yes" });
eq("read-back confirms when the API reports 1", unverified([{ key: "is_esp_match", value: "yes" }], { is_esp_match: 1 }), []);
eq("read-back flags a value that didn't stick", unverified([{ key: "is_esp_match", value: "yes" }], { is_esp_match: 0 }).map((c) => c.key), ["is_esp_match"]);

// --- labels and scope ---------------------------------------------------------------------------
eq("the label reads as the changes", describeChanges(prep.changes), "ESP matching → On, Stop on reply → Off, Opportunity value → $250");
eq("a choice is labelled", describeChanges([{ key: "var_sel_type", value: "INIT_STEP_VAR" }]), "Follow-up variation selection → Match initial variation");
eq("a percentage is labelled", describeChanges([{ key: "bounce_rate_limit", value: 5 }]), "Bounce rate limit → 5%");
eq("only ACTIVE campaigns are in scope", [...IN_SCOPE_STATUSES], ["ACTIVE"]);
eq("every catalogue key is unique", new Set(SETTINGS.map((s) => s.key)).size, SETTINGS.length);

// --- Sending Preference -------------------------------------------------------
// The tool works in the new-leads percentage, the way Plusvibe's own screen
// reads it. The API takes `send_priority`: the FOLLOW-UP share, 0 to 1.
console.log("--- sending preference");
const pref = specFor("send_priority");
eq("it is in the catalogue as a ratio", pref?.kind, "ratio");
eq("Plusvibe's own presets are offered", RATIO_PRESETS.map((p) => p.newLeads), [100, 70, 50, 30, 0]);
eq("…named as Plusvibe names them", RATIO_PRESETS.map((p) => p.label), [
  "All New (100/0)", "Growth (70/30)", "Balanced (50/50)", "Retention (30/70)", "All Follow-ups (0/100)",
]);

eq("70/30 goes out as a 0.3 follow-up share", wireValue(pref, 70), 0.3);
eq("all new goes out as 0", wireValue(pref, 100), 0);
eq("all follow-ups goes out as 1", wireValue(pref, 0), 1);
eq("balanced goes out as 0.5", wireValue(pref, 50), 0.5);
eq("an odd split still lands on two decimals", wireValue(pref, 65), 0.35);
eq("a setting that is not a ratio is written as it is", wireValue(specFor("bounce_rate_limit"), 5), 5);

eq("0.3 reads back as 70% new", readValue(pref, 0.3), 70);
eq("…0 as all new", readValue(pref, 0), 100);
eq("…1 as all follow-ups", readValue(pref, 1), 0);
eq("…a string is read too", readValue(pref, "0.5"), 50);
eq("…and nothing reported is null", readValue(pref, undefined), null);
// A value outside 0–1 is not a share this build understands; guessing at it
// would silently write the wrong split.
eq("a value out of range is not guessed at", [readValue(pref, 30), readValue(pref, -1), readValue(pref, "x")], [null, null, null]);

eq("a whole percentage is accepted", validateChange({ key: "send_priority", value: 70 }), []);
eq("…the ends too", [validateChange({ key: "send_priority", value: 0 }).length, validateChange({ key: "send_priority", value: 100 }).length], [0, 0]);
eq("over 100 is refused", validateChange({ key: "send_priority", value: 101 }), ["Sending preference: must be between 0 and 100."]);
eq("below 0 is refused", validateChange({ key: "send_priority", value: -1 }), ["Sending preference: must be between 0 and 100."]);
eq("a fraction of a percent is refused", validateChange({ key: "send_priority", value: 70.5 }), ["Sending preference: use a whole percentage."]);
eq("a blank is refused", validateChange({ key: "send_priority", value: "" }), ["Sending preference: enter a percentage."]);

// The diff and the read-back both work in percentages, so a campaign already
// on 70/30 is counted rather than written.
eq("a campaign already on 70/30 needs no write",
  diffCampaign([{ key: "send_priority", value: 70 }], { send_priority: 0.3 }), []);
eq("…one on 50/50 does",
  diffCampaign([{ key: "send_priority", value: 70 }], { send_priority: 0.5 }).map((c) => c.value), [70]);
eq("…and one that doesn't report it does",
  diffCampaign([{ key: "send_priority", value: 70 }], {}).length, 1);
eq("the PATCH body carries the wire form",
  patchBody("w1", "c1", prepareChanges([{ key: "send_priority", value: 70 }]).changes),
  { workspace_id: "w1", campaign_id: "c1", send_priority: 0.3 });
eq("the read-back confirms it", unverified([{ key: "send_priority", value: 70 }], { send_priority: 0.3 }), []);
eq("…and catches a write that didn't land",
  unverified([{ key: "send_priority", value: 70 }], { send_priority: 0.5 }).length, 1);

eq("a preset is named in the label", describeChanges([{ key: "send_priority", value: 70 }]), "Sending preference → Growth (70/30)");
eq("…and an odd split is spelled out", describeChanges([{ key: "send_priority", value: 65 }]), "Sending preference → 65% new / 35% follow-ups");
eq("every preset round-trips through the wire", RATIO_PRESETS.every((p) => readValue(pref, wireValue(pref, p.newLeads)) === p.newLeads), true);
eq("…as does every whole percentage", Array.from({ length: 101 }, (_, i) => i).every((n) => readValue(pref, wireValue(pref, n)) === n), true);
eq("describeRatio names the presets", describeRatio(30), "Retention (30/70)");

// --- Advanced scheduling -----------------------------------------------------
// A different sending window (or several) per day. The editor works in
// half-hour slots; the API takes a list of windows per weekday.
console.log("--- advanced scheduling");
const sch = await importTs("@/lib/campaign-settings/schedule");
const {
  WEEKDAYS, SLOTS_PER_DAY, emptySlots, emptyWeek, slotsToWindows, windowsToSlots, slotTime, pretty,
  weekToSlots, slotsToWeek, totalSlots, PRESETS, validateWeek, describeWeek, describeDays,
  parseWeek, stringifyWeek, advScheduleBody, limitsOf, weekFromCampaign, DEFAULT_TIMEZONE,
} = sch;

eq("a day is 48 half-hour slots", [SLOTS_PER_DAY, slotTime(0), slotTime(19), slotTime(47), slotTime(48)], [48, "00:00", "09:30", "23:30", "24:00"]);
eq("times read as people say them", [pretty("09:00"), pretty("09:30"), pretty("12:00"), pretty("17:30"), pretty("00:00"), pretty("24:00")], ["9am", "9:30am", "12pm", "5:30pm", "12am", "12am"]);

// Slots to windows: adjacent slots merge, a gap splits.
const row = Array(SLOTS_PER_DAY).fill(false);
for (let i = 18; i < 24; i++) row[i] = true;   // 09:00–12:00
for (let i = 26; i < 35; i++) row[i] = true;   // 13:00–17:30
eq("adjacent slots merge into one window, a gap splits them", slotsToWindows(row), [
  { from: "09:00", to: "12:00" },
  { from: "13:00", to: "17:30" },
]);
eq("no slots, no windows", slotsToWindows(Array(SLOTS_PER_DAY).fill(false)), []);
eq("a full day is one window to midnight", slotsToWindows(Array(SLOTS_PER_DAY).fill(true)), [{ from: "00:00", to: "24:00" }]);
eq("windows come back as the same slots", windowsToSlots(slotsToWindows(row)), row);
eq("half past is kept, not rounded away", slotsToWindows(windowsToSlots([{ from: "09:30", to: "10:30" }])), [{ from: "09:30", to: "10:30" }]);
// A window from somewhere else need not land on the half hour; it must still show.
eq("an off-grid window covers every slot it touches", slotsToWindows(windowsToSlots([{ from: "09:10", to: "10:05" }])), [{ from: "09:00", to: "10:30" }]);
eq("a backwards window is ignored rather than drawn", windowsToSlots([{ from: "12:00", to: "09:00" }]).some(Boolean), false);

// The week as the grid and as the API see it.
const bus = PRESETS[0].build();
eq("Business hours is Mon–Fri 9 to 5", slotsToWeek(bus, "UTC").windows.Monday, [{ from: "09:00", to: "17:00" }]);
eq("…and leaves the weekend alone", [slotsToWeek(bus, "UTC").windows.Saturday, slotsToWeek(bus, "UTC").windows.Sunday], [[], []]);
eq("Skip lunch is two windows a day", slotsToWeek(PRESETS[2].build(), "UTC").windows.Wednesday, [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "17:00" }]);
eq("Light Mon & Fri is shorter at both ends of the week", [
  slotsToWeek(PRESETS[1].build(), "UTC").windows.Monday, slotsToWeek(PRESETS[1].build(), "UTC").windows.Tuesday,
], [[{ from: "10:00", to: "14:00" }], [{ from: "09:00", to: "17:00" }]]);
eq("slots count what is selected", [totalSlots(emptySlots()), totalSlots(bus)], [0, 5 * 16]);
eq("a week round-trips through the grid", slotsToWeek(weekToSlots(slotsToWeek(bus, "UTC")), "UTC"), slotsToWeek(bus, "UTC"));

// Validation: a blank week would stop every campaign it reached.
eq("a good week has no problems", validateWeek(slotsToWeek(bus, "America/New_York")), []);
eq("a week with nothing selected is refused", validateWeek(emptyWeek()), ["Advanced scheduling: select at least one sending window."]);
eq("a backwards window is refused, naming the day", validateWeek({ timezone: "UTC", windows: { ...emptyWeek().windows, Tuesday: [{ from: "17:00", to: "09:00" }] } }),
  ["Advanced scheduling · Tue: a window has to end after it starts."]);
eq("a blank timezone is refused", validateWeek({ ...slotsToWeek(bus, ""), timezone: "" })[0], "Advanced scheduling: pick a timezone.");

// How it reads back to a person.
eq("days read as runs", [describeDays(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]), describeDays(["Monday", "Wednesday", "Friday"]), describeDays(["Monday", "Tuesday"]), describeDays(["Sunday"])],
  ["Mon–Fri", "Mon, Wed, Fri", "Mon, Tue", "Sun"]);
eq("a week reads as a sentence", describeWeek(slotsToWeek(bus, "UTC")), "Mon–Fri 9am–5pm");
eq("…two windows and all", describeWeek(slotsToWeek(PRESETS[2].build(), "UTC")), "Mon–Fri 9am–12pm, 1pm–5pm");
eq("…and days that differ are counted instead", describeWeek(slotsToWeek(PRESETS[1].build(), "UTC")), "Mon–Fri · 5 windows");
eq("an empty week says so", describeWeek(emptyWeek()), "no sending windows");

// Carried through the settings catalogue as JSON.
const week = slotsToWeek(bus, "America/New_York");
eq("a week survives the round trip", parseWeek(stringifyWeek(week)), week);
eq("nonsense reads as nothing", [parseWeek(""), parseWeek("{"), parseWeek(null)], [null, null, null]);
eq("a half-written week still reads, with the days it has", parseWeek('{"windows":{"Monday":[{"from":"09:00","to":"10:00"},"x"]}}').windows.Monday, [{ from: "09:00", to: "10:00" }]);
eq("…and takes the default timezone", parseWeek('{"windows":{}}').timezone, DEFAULT_TIMEZONE);

// The two fields the API takes.
const body = advScheduleBody(week, 600);
eq("it switches advanced scheduling on", body.use_adv_schedule, true);
eq("…carries the timezone and only the days that send", [body.adv_schedule.timezone, Object.keys(body.adv_schedule.windows)],
  ["America/New_York", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]]);
eq("…each as a list of windows", body.adv_schedule.windows.Monday, [{ from: "09:00", to: "17:00" }]);
eq("…and the campaign's own daily limit, which this tool does not change", body.adv_schedule.daily_limit, 600);
// The live API refuses a body without daily_limit_new_lead and documents
// null as "no separate new-lead cap" — so it is always present, and never a guess.
eq("the new-lead cap is always present, null when there is none to carry", body.adv_schedule.daily_limit_new_lead, null);
eq("…and the campaign's own when it has one", advScheduleBody(week, 600, 80).adv_schedule.daily_limit_new_lead, 80);
eq("a campaign with no limit to carry gets none", "daily_limit" in advScheduleBody(week, null).adv_schedule, false);
// Where the limits come from: the campaign, or the advanced schedule it reports.
eq("limits off a listed campaign", limitsOf({ daily_limit: 600, daily_limit_new_lead: 80 }), { dailyLimit: 600, newLeadLimit: 80 });
eq("a new-lead cap of 0 is no cap", limitsOf({ daily_limit: 600, daily_limit_new_lead: 0 }), { dailyLimit: 600, newLeadLimit: null });
eq("a campaign reporting neither", limitsOf({}), { dailyLimit: null, newLeadLimit: null });
eq("…or nothing at all", limitsOf(null), { dailyLimit: null, newLeadLimit: null });
eq("strings are read as numbers", limitsOf({ daily_limit: "150", daily_limit_new_lead: "40" }), { dailyLimit: 150, newLeadLimit: 40 });
eq("an advanced schedule the campaign reports carries its own, which win",
  limitsOf({ daily_limit: 600, daily_limit_new_lead: 80, adv_schedule: { daily_limit: 250, daily_limit_new_lead: 100 } }), { dailyLimit: 250, newLeadLimit: 100 });
eq("…falling back to the campaign's where it has none", limitsOf({ daily_limit: 600, adv_schedule: { daily_limit_new_lead: null } }), { dailyLimit: 600, newLeadLimit: null });

// Reading one off a campaign, to copy it onto others.
eq("nothing to read", [weekFromCampaign(null), weekFromCampaign({}), weekFromCampaign({ schedule: {} })], [null, null, null]);
const simple = weekFromCampaign({
  schedule: { days: ["Monday", "Wednesday"], from_time: "10:00", to_time: "17:00", tz: "Europe/London" },
});
eq("the simple schedule spreads across its days as one window each", [simple.exact, simple.week.timezone, simple.week.windows.Monday, simple.week.windows.Tuesday],
  [false, "Europe/London", [{ from: "10:00", to: "17:00" }], []]);
eq("…days keyed 1–7 read too", weekFromCampaign({ schedule: { days: { 1: true, 7: true }, from_time: "09:00", to_time: "12:00", tz: "UTC" } }).week.windows.Sunday, [{ from: "09:00", to: "12:00" }]);
// The advanced shape is undocumented in the listing, but read first so this
// becomes exact the day the API returns it.
const adv = weekFromCampaign({
  schedule: { days: ["Monday"], from_time: "09:00", to_time: "17:00", tz: "UTC" },
  adv_schedule: { timezone: "Asia/Tokyo", windows: { Friday: [{ from: "08:00", to: "09:30" }] } },
});
eq("an advanced schedule wins over the simple one, and is exact", [adv.exact, adv.week.timezone, adv.week.windows.Friday, adv.week.windows.Monday],
  [true, "Asia/Tokyo", [{ from: "08:00", to: "09:30" }], []]);
eq("…an empty advanced schedule falls back to the simple one", weekFromCampaign({ schedule: { days: ["Monday"], from_time: "09:00", to_time: "17:00", tz: "UTC" }, adv_schedule: { timezone: "UTC", windows: {} } }).exact, false);

// --- the schedule as a setting ------------------------------------------------
const schedSpec = specFor("adv_schedule");
eq("it is in the catalogue as a schedule", schedSpec?.kind, "schedule");
eq("it cannot be confirmed by reading back", m.confirmable(schedSpec), false);
eq("…while everything else can", SETTINGS.filter((x) => x.kind !== "schedule").every((x) => m.confirmable(x)), true);
const SCHED_CHANGE = [{ key: "adv_schedule", value: stringifyWeek(week) }];
eq("a good week validates", validateChange(SCHED_CHANGE[0]), []);
eq("an empty one does not", validateChange({ key: "adv_schedule", value: stringifyWeek(emptyWeek()) }), ["Advanced scheduling: select at least one sending window."]);
eq("nonsense does not", validateChange({ key: "adv_schedule", value: "not json" }), ["Advanced scheduling: the weekly schedule could not be read."]);
// A campaign that doesn't report one always needs the write.
eq("a campaign that reports no advanced schedule needs it written", diffCampaign(SCHED_CHANGE, { daily_limit: 600 }).length, 1);
eq("…and one already on it is left alone", diffCampaign(SCHED_CHANGE, { adv_schedule: { timezone: week.timezone, windows: week.windows } }), []);
eq("the PATCH body carries both fields and the campaign's limits", patchBody("w1", "c1", SCHED_CHANGE, { daily_limit: 250, daily_limit_new_lead: 60 }), {
  workspace_id: "w1", campaign_id: "c1", use_adv_schedule: true,
  adv_schedule: { timezone: "America/New_York", windows: advScheduleBody(week, 250).adv_schedule.windows, daily_limit: 250, daily_limit_new_lead: 60 },
});
eq("…with a null new-lead cap when the campaign has none", patchBody("w1", "c1", SCHED_CHANGE, { daily_limit: 250 }).adv_schedule.daily_limit_new_lead, null);
// The listing doesn't report it, so a written schedule reads back as nothing:
// that is unconfirmable, not a failed write.
eq("a schedule that can't be read back is not called unverified", unverified(SCHED_CHANGE, { daily_limit: 600 }), []);
eq("…it is reported as unconfirmable instead", unconfirmable(SCHED_CHANGE, { daily_limit: 600 }).map((c) => c.key), ["adv_schedule"]);
eq("…and when the API does report it, it is checked like anything else",
  [unverified(SCHED_CHANGE, { adv_schedule: { timezone: week.timezone, windows: week.windows } }), unconfirmable(SCHED_CHANGE, { adv_schedule: { timezone: week.timezone, windows: week.windows } })], [[], []]);
eq("…a schedule that read back different IS unverified",
  unverified(SCHED_CHANGE, { adv_schedule: { timezone: "UTC", windows: week.windows } }).map((c) => c.key), ["adv_schedule"]);
eq("other settings are still confirmed the old way", unconfirmable([{ key: "is_esp_match", value: "yes" }], { is_esp_match: 1 }), []);
eq("the label says what the week is", describeChanges(SCHED_CHANGE), "Advanced scheduling → Mon–Fri 9am–5pm (America/New_York)");

eq("an advanced schedule the campaign has switched off is not what gets copied",
  weekFromCampaign({ use_adv_schedule: false, adv_schedule: { timezone: "America/Denver", windows: { Monday: [{ from: "08:00", to: "11:00" }] } }, schedule: { days: ["Monday", "Friday"], from_time: "09:00", to_time: "17:00", tz: "UTC" } }),
  { week: { timezone: "UTC", windows: { Monday: [{ from: "09:00", to: "17:00" }], Tuesday: [], Wednesday: [], Thursday: [], Friday: [{ from: "09:00", to: "17:00" }], Saturday: [], Sunday: [] } }, exact: false });

// --- the plain sending schedule -------------------------------------------------
// Days, one daily window, a timezone: what Plusvibe's screen shows with
// Advanced Scheduling off. Read from the listing's `schedule`, written as
// `schedules` with use_adv_schedule false, carrying the campaign's own
// limits and dates.
console.log("--- sending schedule");
const ss = await importTs("@/lib/campaign-settings/simple-schedule");
const { parseSimple, stringifySimple, validateSimple, describeSimple, simpleFromCampaign, simpleFromWeek, simpleScheduleBody, todayIn, knownPlain, TIME_OPTIONS, DEFAULT_SIMPLE } = ss;
const SIMPLE = { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], timezone: "America/New_York", from: "08:30", to: "15:00" };
eq("the default is business hours, Mon–Fri", DEFAULT_SIMPLE, { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], timezone: "America/New_York", from: "09:00", to: "17:00" });
eq("the pickers step every half hour", [TIME_OPTIONS.length, TIME_OPTIONS[0], TIME_OPTIONS[17], TIME_OPTIONS[47]], [48, "00:00", "08:30", "23:30"]);
eq("a schedule round-trips as JSON", parseSimple(stringifySimple(SIMPLE)), SIMPLE);
eq("days come out in week order without repeats, however they went in",
  parseSimple({ days: ["Friday", "Monday", "monday", "3", "Wed"], timezone: "UTC", from: "9:00", to: "17:00" }), { days: ["Monday", "Wednesday", "Friday"], timezone: "UTC", from: "09:00", to: "17:00" });
eq("…and a missing timezone takes the default", parseSimple({ days: ["Monday"], from: "09:00", to: "10:00" }).timezone, "America/New_York");
eq("nonsense is null", [parseSimple("x"), parseSimple(""), parseSimple(null), parseSimple(5)], [null, null, null, null]);
eq("a good schedule has no problems", validateSimple(SIMPLE), []);
eq("no days is refused", validateSimple({ ...SIMPLE, days: [] }), ["Sending schedule: pick at least one day."]);
eq("an end before the start is refused", validateSimple({ ...SIMPLE, from: "15:00", to: "08:30" }), ["Sending schedule: the end time has to be after the start time."]);
eq("…and equal is too", validateSimple({ ...SIMPLE, to: "08:30" }).length, 1);
eq("a time that isn't one is refused", validateSimple({ ...SIMPLE, to: "3pm" }), ["Sending schedule: times read as HH:MM."]);
eq("a bad timezone is refused", validateSimple({ ...SIMPLE, timezone: "nope!" })[0], "Sending schedule: pick a timezone.");
eq("it reads as a sentence", describeSimple(SIMPLE), "Mon–Fri 8:30am–3pm");
eq("…with gaps in the days spelled out", describeSimple({ ...SIMPLE, days: ["Monday", "Wednesday", "Friday"] }), "Mon, Wed, Fri 8:30am–3pm");

// What the listing reports.
const LISTED = { id: "c1", daily_limit: 600, daily_limit_new_lead: 0, camp_st_date: "2026-08-01T00:00:00.000Z", camp_end_date: "", schedule: { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], from_time: "08:30", to_time: "15:00", tz: "America/New_York" } };
eq("the listing's schedule reads as one", simpleFromCampaign(LISTED), SIMPLE);
eq("…so does a write-shaped one, should the API ever return it", simpleFromCampaign({ schedules: [{ days: { 1: true, 5: true }, timezone: "UTC", timing: { from: "09:00", to: "10:00" } }] }), { days: ["Monday", "Friday"], timezone: "UTC", from: "09:00", to: "10:00" });
eq("a campaign with none reads as null", [simpleFromCampaign({ id: "c" }), simpleFromCampaign(null), simpleFromCampaign({ schedule: { tz: "UTC" } })], [null, null, null]);
eq("a week with the same window every sending day is a plain schedule",
  simpleFromWeek({ timezone: "UTC", windows: { Monday: [{ from: "09:00", to: "17:00" }], Tuesday: [], Wednesday: [{ from: "09:00", to: "17:00" }], Thursday: [], Friday: [], Saturday: [], Sunday: [] } }),
  { days: ["Monday", "Wednesday"], timezone: "UTC", from: "09:00", to: "17:00" });
eq("…a week with different windows is not", simpleFromWeek({ timezone: "UTC", windows: { Monday: [{ from: "09:00", to: "17:00" }], Tuesday: [{ from: "10:00", to: "17:00" }], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] } }), null);
eq("…nor one with two windows a day", simpleFromWeek({ timezone: "UTC", windows: { Monday: [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "17:00" }], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] } }), null);
eq("…nor an empty one", simpleFromWeek({ timezone: "UTC", windows: { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] } }), null);

// The write.
const NOW = new Date("2026-09-21T12:00:00Z");
eq("the write switches advanced scheduling off and carries the campaign's limit and start date",
  simpleScheduleBody(SIMPLE, LISTED, NOW), { use_adv_schedule: false, schedules: [{ daily_limit: 600, days: { 1: true, 2: true, 3: true, 4: true, 5: true }, timezone: "America/New_York", timing: { from: "08:30", to: "15:00" }, start_date: "2026-08-01" }] });
eq("a new-lead cap of 0 is not carried; a real one is", [
  "daily_limit_new_lead" in simpleScheduleBody(SIMPLE, LISTED, NOW).schedules[0],
  simpleScheduleBody(SIMPLE, { ...LISTED, daily_limit_new_lead: 40 }, NOW).schedules[0].daily_limit_new_lead,
], [false, 40]);
eq("an end date is carried when the campaign has one", simpleScheduleBody(SIMPLE, { ...LISTED, camp_end_date: "2026-12-31" }, NOW).schedules[0].end_date, "2026-12-31");
eq("…and left out when it has none", "end_date" in simpleScheduleBody(SIMPLE, LISTED, NOW).schedules[0], false);
eq("a campaign with no start date gets today, in the schedule's zone", simpleScheduleBody(SIMPLE, { daily_limit: 5 }, NOW).schedules[0].start_date, todayIn("America/New_York", NOW));
eq("…which is a date", /^\d{4}-\d{2}-\d{2}$/.test(todayIn("America/New_York")), true);
eq("…even for a zone that isn't one", /^\d{4}-\d{2}-\d{2}$/.test(todayIn("Not/AZone")), true);
eq("a campaign with no limit is not given one", "daily_limit" in simpleScheduleBody(SIMPLE, {}, NOW).schedules[0], false);
eq("the listing only says 'plain' when it says so", [knownPlain({ use_adv_schedule: false }), knownPlain({ use_adv_schedule: true }), knownPlain({}), knownPlain(null)], [true, false, false, false]);

// As a setting.
const sched = specFor("schedule");
eq("it is in the catalogue as a sending schedule, confirmable", [sched?.kind, sched?.label, m.confirmable(sched)], ["sendingSchedule", "Sending schedule", true]);
const SS_CHANGE = [{ key: "schedule", value: stringifySimple(SIMPLE) }];
eq("it reads off a listed campaign", readValue(sched, LISTED), stringifySimple(SIMPLE));
eq("an empty value is refused for each thing it lacks", validateChange({ key: "schedule", value: "{}" }), ["Sending schedule: pick at least one day.", "Sending schedule: times read as HH:MM."]);
eq("…and one that can't be read at all", validateChange({ key: "schedule", value: "not json" }), ["Sending schedule: the schedule could not be read."]);
eq("a campaign whose plain schedule matches is still written, since it may be on advanced scheduling", diffCampaign(SS_CHANGE, LISTED).length, 1);
eq("…unless the API says outright that it is not", diffCampaign(SS_CHANGE, { ...LISTED, use_adv_schedule: false }), []);
eq("…and one that differs is written either way", diffCampaign(SS_CHANGE, { ...LISTED, use_adv_schedule: false, schedule: { ...LISTED.schedule, to_time: "17:00" } }).length, 1);
const ssBody = patchBody("w1", "c1", SS_CHANGE, LISTED);
eq("the PATCH body is the write, with the ids", Object.keys(ssBody).sort(), ["campaign_id", "schedules", "use_adv_schedule", "workspace_id"]);
eq("…switching advanced scheduling off", ssBody.use_adv_schedule, false);
eq("after the write it is confirmed on what reads back", unverified(SS_CHANGE, LISTED), []);
eq("…and flagged when the read-back differs", unverified(SS_CHANGE, { ...LISTED, schedule: { ...LISTED.schedule, to_time: "17:00" } }).map((c) => c.key), ["schedule"]);
eq("…and never called unconfirmable", unconfirmable(SS_CHANGE, LISTED), []);
eq("the label says the schedule", describeChanges(SS_CHANGE), "Sending schedule → Mon–Fri 8:30am–3pm (America/New_York)");
eq("asking for both schedules at once is refused",
  prepareChanges([...SS_CHANGE, { key: "adv_schedule", value: stringifyWeek(week) }]).problems, ["Pick either Sending schedule or Advanced scheduling, not both: a campaign runs one or the other."]);
eq("…while either alone is fine", [prepareChanges(SS_CHANGE).problems, prepareChanges([{ key: "adv_schedule", value: stringifyWeek(week) }]).problems], [[], []]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
