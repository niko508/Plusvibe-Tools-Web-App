// Unit checks for Change Limits with Best Performing Inboxes: the thresholds
// that decide which inboxes qualify, and the five settings applied to them.
// Imports the REAL modules.
//
//   node scripts/check-change-limits.mjs

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
const check = (label, ok, detail = "") => {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? `\n   ${detail}` : ""}`);
  }
};

const {
  parseThresholds,
  thresholdFor,
  judge,
  countVerdicts,
  describeSkipped,
  DEFAULT_THRESHOLDS,
} = await importTs("@/lib/change-limits/qualify");
const { parseSettings, describeSettings, FIELDS, EMPTY_SETTINGS } = await importTs(
  "@/lib/change-limits/settings"
);

// --- Thresholds -------------------------------------------------------------
const t = parseThresholds({ google: "3", microsoft: "2.5", other: "", minSends: "100" });
eq("the two providers get their own rate", [t.google, t.microsoft], [3, 2.5]);
eq("…a blank rate for the rest means skip them", t.other, null);
eq("…and the minimum sends is read", t.minSends, 100);
check("…with nothing to complain about", t.ok, JSON.stringify(t.problems));

eq(
  "a threshold set for other providers is used",
  parseThresholds({ google: "3", microsoft: "3", other: "1", minSends: "0" }).other,
  1
);
eq(
  "a missing Google rate is named",
  parseThresholds({ google: "", microsoft: "3", other: "", minSends: "10" }).problems,
  ["Set a true reply rate for Google."]
);
eq(
  "a rate over 100 is refused",
  parseThresholds({ google: "150", microsoft: "3", other: "", minSends: "10" }).problems,
  ["The Google reply rate must be between 0 and 100%."]
);
eq(
  "fractional sends are refused",
  parseThresholds({ google: "3", microsoft: "3", other: "", minSends: "10.5" }).problems,
  ["Minimum sends must be a whole number."]
);
check("the defaults are usable as they are", parseThresholds(DEFAULT_THRESHOLDS).ok);

eq("Google is measured against the Google rate", thresholdFor("google", t), 3);
eq("Microsoft against its own", thresholdFor("microsoft", t), 2.5);
eq("…and anything else against nothing, when it is skipped", thresholdFor("other", t), null);

// --- Judging ----------------------------------------------------------------
const j = (over) =>
  judge({ provider: "google", loaded: true, sent: 500, replyRate: 5, ...over }, t);

eq("a strong Google inbox qualifies", j({}).verdict, "qualifies");
eq("…exactly at the threshold still qualifies", j({ replyRate: 3 }).verdict, "qualifies");
eq("…a hair under does not", j({ replyRate: 2.99 }).verdict, "below-rate");
eq("…and it says what it was measured against", j({ replyRate: 2.99 }).threshold, 3);
eq("too few sends is its own answer", j({ sent: 99 }).verdict, "too-few-sends");
eq(
  "…checked before the rate, so a quiet inbox is never called weak",
  j({ sent: 3, replyRate: 0 }).verdict,
  "too-few-sends"
);
eq("an inbox with no figures is not judged on them", j({ loaded: false }).verdict, "no-stats");
eq(
  "…even when its provider is skipped, the skip comes first",
  j({ provider: "other", loaded: false }).verdict,
  "provider-skipped"
);
eq(
  "a Microsoft inbox uses the Microsoft rate",
  judge({ provider: "microsoft", loaded: true, sent: 500, replyRate: 2.6 }, t).verdict,
  "qualifies"
);
eq(
  "…which the Google rate would have failed",
  judge({ provider: "google", loaded: true, sent: 500, replyRate: 2.6 }, t).verdict,
  "below-rate"
);

const counts = countVerdicts([
  "qualifies",
  "qualifies",
  "below-rate",
  "no-stats",
  "below-rate",
  "below-rate",
]);
eq("verdicts are counted", [counts.qualifies, counts["below-rate"], counts["no-stats"]], [2, 3, 1]);
eq(
  "…and what was left out is said in words, most common first",
  describeSkipped(counts),
  "3 below reply rate, 1 no stats"
);
eq("nothing left out says nothing", describeSkipped(countVerdicts(["qualifies"])), "");

// --- Settings ---------------------------------------------------------------
eq("nothing filled in applies nothing", parseSettings(EMPTY_SETTINGS).body, {});
check("…and is not ready to run", !parseSettings(EMPTY_SETTINGS).ok);

const s = parseSettings({
  campaignEmails: "40",
  warmupEmails: "18",
  randomize: "10",
  warmupReplyRate: "46",
  intervalMinutes: "6",
});
eq("the five values become the fields Plusvibe takes", s.body, {
  daily_limit: 40,
  warmup_max_daily_limit: 18,
  warmup_randomize: "yes",
  warmup_randomize_num: 10,
  warmup_reply_rate: 0.46,
  interval_limit_in_min: 6,
});
check("…and it is ready to run", s.ok);
eq("…with a row per field for the preview", s.count, 5);
eq(
  "…read back in the tool's own words",
  describeSettings(s.summary),
  "Campaign emails 40 per day · Warmup emails 18 per day · Randomized Warm-Up Limit 10% · Warmup reply rate 46% · Email Interval 6 minutes"
);

const partial = parseSettings({ ...EMPTY_SETTINGS, campaignEmails: "60" });
eq("a blank field is left off the wire entirely", partial.body, { daily_limit: 60 });
check("…and one value is enough to run", partial.ok);

eq(
  "zero randomising is said with the switch, not a zero it would refuse",
  parseSettings({ ...EMPTY_SETTINGS, randomize: "0" }).body,
  { warmup_randomize: "no" }
);
eq(
  "a campaign limit of zero is allowed — that is how you stop sending",
  parseSettings({ ...EMPTY_SETTINGS, campaignEmails: "0" }).body,
  { daily_limit: 0 }
);
eq(
  "the reply rate goes over as a fraction",
  parseSettings({ ...EMPTY_SETTINGS, warmupReplyRate: "33.5" }).body.warmup_reply_rate,
  0.335
);

eq(
  "a warmup limit of zero is refused, and says so by name",
  parseSettings({ ...EMPTY_SETTINGS, warmupEmails: "0" }).problems.warmupEmails,
  "Warmup emails must be between 1 and 1000 per day."
);
eq(
  "a fractional interval is refused",
  parseSettings({ ...EMPTY_SETTINGS, intervalMinutes: "2.5" }).problems.intervalMinutes,
  "Email Interval must be a whole number."
);
eq(
  "text is refused",
  parseSettings({ ...EMPTY_SETTINGS, campaignEmails: "lots" }).problems.campaignEmails,
  "Campaign emails must be a number."
);
check(
  "…and a bad field stops the run",
  !parseSettings({ ...EMPTY_SETTINGS, campaignEmails: "lots" }).ok
);

// The labels are the user's own words, and each says which API field it sets.
eq(
  "every field is labelled as asked for",
  FIELDS.map((f) => f.label),
  [
    "Campaign emails",
    "Warmup emails",
    "Randomized Warm-Up Limit",
    "Warmup reply rate",
    "Email Interval",
  ]
);
eq(
  "…and mapped to the documented API field",
  FIELDS.map((f) => f.apiField),
  [
    "daily_limit",
    "warmup_max_daily_limit",
    "warmup_randomize_num",
    "warmup_reply_rate",
    "interval_limit_in_min",
  ]
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
