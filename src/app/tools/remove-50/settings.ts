import type { WarmupSettings } from "@/lib/api-client";

// Fixed target: trim every over-provisioned domain down to this many inboxes.
export const DEFAULT_TARGET = 50;

export const DEFAULT_EXCLUDED_WORKSPACE = "inbox warmup"; // preselected workspace

// The warmup config applied to the kept inboxes on trimmed domains.
// Reply rate uses the API's 0–1 scale (46% => 0.46). The timezone can only be
// carried inside the schedule object, so it's set with an all-day/all-week
// window (no effective restriction).
export const WARMUP_SETTINGS: WarmupSettings = {
  warmup_max_daily_limit: 18,
  bulk_warmup_is_slow_rampup: "yes",
  warmup_initial_daily_limit: 2,
  warmup_pace_increment: 3,
  warmup_randomize: "yes",
  warmup_randomize_num: 10,
  warmup_reply_rate: 0.46,
  warmup_business_type: "Generic business type",
  warmup_schedule: {
    tz: "America/New_York",
    from_time: "00:00",
    to_time: "23:59",
    days: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
  },
};

// Human-readable rows for the "settings that will be applied" preview.
export const SETTINGS_SUMMARY: { label: string; value: string }[] = [
  { label: "Daily warmup limit", value: "18" },
  { label: "Warmup ramp-up", value: "Enabled" },
  { label: "Initial daily emails", value: "2" },
  { label: "Daily increment", value: "3" },
  { label: "Randomized warm-up", value: "10%" },
  { label: "Warmup reply rate", value: "46%" },
  { label: "Business type", value: "Generic business type" },
  { label: "Timezone", value: "America/New_York (no schedule restriction)" },
  { label: "Warmup", value: "Enabled" },
];
