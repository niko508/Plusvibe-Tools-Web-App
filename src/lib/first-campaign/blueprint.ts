// The fixed shape of a new workspace's first campaign.
//
// Everything here is the standard setup that gets rebuilt by hand for every new
// client: one cold step, a known set of safety settings, a schedule, and six
// sub-sequences each triggered by a custom lead label. Keeping it as data (not
// code paths) means the whole blueprint can be unit-tested and diffed, and the
// job runner just walks it.
//
// No API calls in this file — it's pure so `scripts/check-first-campaign.mjs`
// can assert the exact payloads without a key.

import { bodyToHtml } from "@/lib/body-html";
import {
  ANSWER_STEP_ONE,
  BUMP_STEP_ONE,
  NUDGE_STEP_TWO,
} from "@/lib/first-campaign/subsequence-content";

// --- Step 1 ----------------------------------------------------------------

/**
 * Subject and body are left as literal placeholders. The campaign is a shell
 * the copywriter fills in; substituting anything here would only have to be
 * deleted again.
 */
export const SUBJECT_PLACEHOLDER = "{{SUBJECT_LINE}}";

/**
 * The greeting handles a missing first name, so a blank lead doesn't get
 * "Hey ,". The sign-off spintax is the standard 10.
 */
export const STEP_ONE_BODY = [
  "{% if first_name != blank %} {{Random | Hey {{first_name}}, | Hi {{first_name}},}} {% else %} {{Random | Hey, | Hi,}} {% endif %}",
  "{{BODY_COPY}}",
  "{{Random | Thanks, | Best, | Thx, | Thank you, | Regards, | All the best, | Best regards, | King regards, | Have a good one, | Best wishes,}}",
  "{{sender_signature}}",
].join("\n\n");

/**
 * The campaign has a single step, so `wait_time` (the gap AFTER this step)
 * never elapses. It's required by the API, so it gets a neutral 1.
 */
export const STEP_ONE_WAIT_TIME = 1;

export function buildStepOne(): Record<string, unknown> {
  return {
    step: 1,
    wait_time: STEP_ONE_WAIT_TIME,
    variations: [
      {
        variation: "A",
        subject: SUBJECT_PLACEHOLDER,
        name: "",
        body: bodyToHtml(STEP_ONE_BODY),
      },
    ],
  };
}

// --- Schedules -------------------------------------------------------------

export const TIMEZONE = "America/New_York";
export const DAILY_LIMIT = 3000;

export interface Schedule {
  daily_limit: number;
  days: Record<string, boolean>;
  timezone: string;
  timing: { from: string; to: string };
}

/** Days are keyed "1" = Monday … "7" = Sunday. Only the sending days appear. */
function days(...nums: number[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const n of nums) out[String(n)] = true;
  return out;
}

/** Mon–Fri plus Sunday (no Saturday), 07:30–17:30. */
export const PARENT_SCHEDULE: Schedule = {
  daily_limit: DAILY_LIMIT,
  days: days(1, 2, 3, 4, 5, 7),
  timezone: TIMEZONE,
  timing: { from: "07:30", to: "17:30" },
};

/** Sub-sequences run a tighter window, weekdays only. */
export const SUBSEQUENCE_SCHEDULE: Schedule = {
  daily_limit: DAILY_LIMIT,
  days: days(1, 2, 3, 4, 5),
  timezone: TIMEZONE,
  timing: { from: "09:30", to: "15:30" },
};

// `daily_limit_new_lead` is deliberately absent from both: the UI's "Maximum
// new leads to contact per day" is left blank ("No Limit"), and the field is
// optional, so omitting it is how you say "no cap". Sending 0 would mean the
// opposite — no new leads at all.

// --- Parent campaign settings ----------------------------------------------

/**
 * Every safety/sending setting, exactly as the standard campaign has them.
 *
 * `send_priority` is the one value the API docs contradict themselves on: the
 * field is declared `enum: [0, 1]` while its own description says "0.5 =
 * equally prioritize". The UI's Balanced (50/50) is 0.5, so that's what's sent;
 * if the server rejects it the run reports the failure rather than silently
 * falling back to a different split.
 */
export const PARENT_SETTINGS: Record<string, unknown> = {
  send_priority: 0.5, // Balanced (50/50)
  var_sel_type: "R_ROBIN", // Round Robin
  is_esp_match: "no",
  opportunity_val: 0,

  stop_on_lead_replied: "yes",
  exclude_ooo: "yes", // continue sending after OOO / auto-replies
  ooo_nr_opt: "AI", // use AI to detect the return date
  ooo_nr_ai_d: "15", // …and add 15 days when it can't
  is_acc_based_sending: "no", // don't stop the whole domain on one reply
  is_emailopened_tracking: "no",
  is_unsubscribed_link: "no",
  send_as_txt: "yes",
  send_risky_email: "yes",
  send_seg_email: "no",
  is_pause_on_bouncerate: "no",
  other_email_acc: "yes", // fallback sending
  is_max_lead_domain_per_day: "yes",
  max_lead_domain_per_day: 2,
};

// Two settings on the campaign screen have no API field at all, so a campaign
// built here will differ from a hand-built one in exactly these places:
//   - "Pause sending on public holidays" (Skip Holidays)
//   - "Fallback Sending for errored accounts" — the UI has two fallback
//     toggles, the API has one (`other_email_acc`), so only the
//     deleted/removed one is certain to be set.
export const UNSETTABLE_PARENT_SETTINGS = [
  "Pause sending on public holidays",
  "Fallback Sending for errored accounts (shares one API field with deleted/removed)",
];

/** The tag whose email accounts send this campaign. */
export const SENDING_TAG_NAME = "Active";

// --- Sub-sequences ---------------------------------------------------------

export type Sentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL";

export interface SpecLabel {
  /** Display name, emoji included — used verbatim when the label must be created. */
  name: string;
  sentiment: Sentiment;
}

export interface SubsequenceStep {
  /**
   * Days to wait AFTER this step. The last step's value never elapses, so it
   * is 0 — nothing follows it.
   */
  waitDays: number;
  /** Plain text; converted to the editor's HTML shape on the way out. */
  body: string;
}

export interface SubsequenceContent {
  /** Days between the trigger firing and step 1. */
  firstWaitDays: number;
  steps: SubsequenceStep[];
}

export interface SubsequenceSpec {
  /** Sub-sequence name, as it appears in the campaign list. */
  name: string;
  /** Labels that add a lead to this sub-sequence. */
  labels: SpecLabel[];
  /**
   * The emails. Absent for the sub-sequences whose copy hasn't been written
   * yet — those are still created with their trigger and schedule, and the run
   * reports them as awaiting content rather than pretending they're finished.
   */
  content?: SubsequenceContent;
}

/**
 * Listed in creation order. The campaign list sorts newest-first, so building
 * them in this order reproduces the familiar ordering on screen.
 */
export const SUBSEQUENCES: SubsequenceSpec[] = [
  {
    name: "Positive Reply 1",
    labels: [{ name: "🤩 positive reply 1", sentiment: "POSITIVE" }],
    content: {
      firstWaitDays: 1,
      steps: [
        { waitDays: 2, body: BUMP_STEP_ONE },
        { waitDays: 0, body: NUDGE_STEP_TWO },
      ],
    },
  },
  {
    name: "Evergreen Follow Up",
    labels: [{ name: "😈 evergreen follow up", sentiment: "NEUTRAL" }],
    // The same two emails as Positive Reply 1, on a slower cadence.
    content: {
      firstWaitDays: 2,
      steps: [
        { waitDays: 3, body: BUMP_STEP_ONE },
        { waitDays: 0, body: NUDGE_STEP_TWO },
      ],
    },
  },
  {
    name: "Meeting Confirmation - Normal",
    labels: [
      { name: "🤑 meeting booked", sentiment: "POSITIVE" },
      { name: "🤑 meeting booked - cell phone call", sentiment: "POSITIVE" },
    ],
  },
  {
    name: "Positive Reply 2",
    labels: [{ name: "🤩 positive reply 2", sentiment: "POSITIVE" }],
    content: {
      firstWaitDays: 2,
      steps: [
        { waitDays: 3, body: ANSWER_STEP_ONE },
        { waitDays: 0, body: NUDGE_STEP_TWO },
      ],
    },
  },
  { name: "No Show", labels: [{ name: "😡 no show", sentiment: "NEGATIVE" }] },
  {
    name: "Meeting Confirmation - Prospect's Calendar",
    labels: [
      {
        name: "🤑 meeting booked - prospect's calendar link",
        sentiment: "POSITIVE",
      },
    ],
  },
];

/** Every distinct label the blueprint needs, in first-use order. */
export function allSpecLabels(): SpecLabel[] {
  const seen = new Set<string>();
  const out: SpecLabel[] = [];
  for (const sub of SUBSEQUENCES) {
    for (const label of sub.labels) {
      if (seen.has(label.name)) continue;
      seen.add(label.name);
      out.push(label);
    }
  }
  return out;
}

// --- Payload builders ------------------------------------------------------

export const LABEL_EVENT_PREFIX = "LEAD_MARKED_AS_";

/**
 * The trigger event for a sub-sequence.
 *
 * `keys` are the labels' stable keys as returned by the API — never derived
 * from the display name here. The names carry emoji, and the documented key
 * rule ("letters/numbers kept, everything else becomes `_`") would turn a
 * multi-unit emoji into an unpredictable number of underscores.
 */
export function buildLabelEvent(keys: string[]): Record<string, unknown> {
  return {
    name: "LEAD_LABEL_UPDATED",
    val: keys.map((k) =>
      k.startsWith(LABEL_EVENT_PREFIX) ? k : `${LABEL_EVENT_PREFIX}${k}`
    ),
  };
}

/** The PATCH body that turns the empty parent shell into the real campaign. */
export function buildParentUpdate(args: {
  workspaceId: string;
  campaignId: string;
  emailAccounts: string[];
}): Record<string, unknown> {
  return {
    workspace_id: args.workspaceId,
    campaign_id: args.campaignId,
    sequences: [buildStepOne()],
    schedules: PARENT_SCHEDULE,
    ...(args.emailAccounts.length
      ? { email_accounts: args.emailAccounts }
      : {}),
    ...PARENT_SETTINGS,
  };
}

/**
 * The PATCH body for a sub-sequence: its schedule, its emails, and the delay
 * before the first one.
 *
 * Every step's subject is empty on purpose. In a sub-sequence that makes the
 * email a reply on the lead's existing thread instead of starting a new one.
 *
 * `first_wait_time` is only meaningful alongside `sequences`, and the API
 * requires it whenever `sequences` is sent for a sub-sequence — so a
 * sub-sequence with no copy yet gets its schedule and nothing else.
 *
 * `ignore_mailbox_limit` is on so a follow-up to an interested lead isn't held
 * back by the mailbox's cold-email daily cap.
 */
export function buildSubsequenceUpdate(args: {
  workspaceId: string;
  campaignId: string;
  content?: SubsequenceContent;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    workspace_id: args.workspaceId,
    campaign_id: args.campaignId,
    schedules: SUBSEQUENCE_SCHEDULE,
    ignore_mailbox_limit: 1,
  };
  if (!args.content) return base;

  return {
    ...base,
    first_wait_time: args.content.firstWaitDays,
    first_wait_time_unit: "days",
    sequences: args.content.steps.map((s, i) => ({
      step: i + 1,
      wait_time: s.waitDays,
      variations: [
        {
          variation: "A",
          subject: "",
          name: "",
          body: bodyToHtml(s.body),
        },
      ],
    })),
  };
}
