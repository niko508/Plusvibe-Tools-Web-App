// The sub-sequence emails, verbatim.
//
// Kept apart from blueprint.ts because it's copy, not configuration — it
// changes for different reasons and reads better without the settings around
// it. Assembled from shared fragments where the real emails are genuinely
// identical, so a wording fix lands everywhere it should instead of in one of
// three near-copies.
//
// EVERY step has an empty subject. In a sub-sequence that makes the email a
// reply on the lead's existing thread rather than a new one, which is the whole
// point of these follow-ups.

/** Handles a blank first name, so nobody gets "Hey ,". */
const GREETING =
  "{% if first_name != blank %} {{Random | Hey {{first_name}}, | Hi {{first_name}},}} {% else %} {{Random | Hey, | Hi,}} {% endif %}";

/**
 * Two working days out from today, named rather than dated.
 *
 * Liquid's `date: '%u'` gives the ISO weekday (1 = Monday), so 6 and 7 are the
 * weekend. Every table here ends in an `{% else %}` for that reason: without
 * one, a Saturday render produces "Does  work?" with the phrase missing
 * entirely. The send schedules are Mon–Fri, so a real send can't hit it — but
 * Plusvibe's Preview Email renders on demand, any day of the week, and a
 * preview that looks broken is worth avoiding on its own.
 */
const AVAILABILITY_NEAR =
  "{% assign today_number = 'now' | date: '%u' | plus: 0 %}" +
  "{% if today_number == 1 %}this Wednesday and Thursday" +
  "{% elsif today_number == 2 %}this Thursday and Friday" +
  "{% elsif today_number == 3 %}this Friday or next Monday" +
  "{% elsif today_number == 4 %}next Monday or Tuesday" +
  "{% elsif today_number == 5 %}next Tuesday or Wednesday" +
  "{% else %}early next week" +
  "{% endif %}";

/**
 * The same two days as AVAILABILITY_NEAR, offered as a choice rather than a
 * pair — "this Wednesday or Thursday" instead of "and". Only Monday and
 * Tuesday differ; the other branches are word-for-word identical.
 */
const AVAILABILITY_NEAR_OR =
  "{% assign today_number = 'now' | date: '%u' | plus: 0 %}" +
  "{% if today_number == 1 %}this Wednesday or Thursday" +
  "{% elsif today_number == 2 %}this Thursday or Friday" +
  "{% elsif today_number == 3 %}this Friday or next Monday" +
  "{% elsif today_number == 4 %}next Monday or Tuesday" +
  "{% elsif today_number == 5 %}next Tuesday or Wednesday" +
  "{% else %}early next week" +
  "{% endif %}";

/** The later slots offered in step 2. This one has an `else`, so it always renders. */
const AVAILABILITY_FAR =
  "{% assign today_number = 'now' | date: '%u' | plus: 0 %}" +
  "{% if today_number == 1 %}this Thursday or Friday" +
  "{% elsif today_number == 2 %}this Friday or next Monday" +
  "{% elsif today_number == 3 %}next Monday or Tuesday" +
  "{% elsif today_number == 4 %}next Tuesday or Wednesday" +
  "{% elsif today_number == 5 %}next Wednesday or Thursday" +
  "{% else %}early next week" +
  "{% endif %}";

/**
 * Step 1 for Positive Reply 1 and Evergreen Follow Up — the same email in both,
 * only the delays differ.
 */
export const BUMP_STEP_ONE = [
  GREETING,
  "Did those times work for you?",
  `I have availability also on ${AVAILABILITY_NEAR} between 11am - 4pm if that helps.`,
  "Just let me know which slot would work best for you.",
  "Thanks!",
  "{{sender_first_name}}",
].join("\n\n");

/**
 * Step 1 for Positive Reply 2 — answers a question rather than bumping times,
 * so it offers a first slot instead of "also".
 *
 * It ends on "Thanks," with no {{sender_first_name}}, exactly as supplied.
 */
export const ANSWER_STEP_ONE = [
  GREETING,
  "Did that answer your question?",
  "Happy to cover everything in more detail on a quick call once I get a better understanding of your exact situation and problems.",
  `I have availability on ${AVAILABILITY_NEAR} between 12pm - 4pm.`,
  "Thanks,",
].join("\n\n");

/**
 * Step 2 is the same email in all three sub-sequences. The greeting runs into
 * the first sentence on one line, unlike step 1.
 */
export const NUDGE_STEP_TWO = [
  `${GREETING} haven't heard back, so guessing those times didn't fit.`,
  `I could also do ${AVAILABILITY_FAR} between 10am - 2pm.`,
  "Would either of those days work better for you?",
  "Thanks!",
  "{{sender_first_name}}",
].join("\n\n");

// --- No Show ----------------------------------------------------------------

/** Offers a fresh slot after a missed meeting, without dwelling on the miss. */
export const NO_SHOW_STEP_ONE = [
  GREETING,
  "Still happy to find another time that works.",
  `Does ${AVAILABILITY_NEAR_OR} work?`,
  "I'm free between 12pm - 4pm.",
  "Thanks!",
  "{{sender_first_name}}",
].join("\n\n");

/** The last try — names the silence and offers one final slot. */
export const NO_SHOW_STEP_TWO = [
  GREETING,
  "I'll keep this short. I don't want to keep following up if the timing isn't right.",
  `If you'd still like to see what we'd put together for your company, I have availability ${AVAILABILITY_NEAR_OR} between 10am - 3pm.`,
  "Is there a slot that would work for you?",
  "Either way, appreciate your time.",
  "Thanks!",
  "{{sender_first_name}}",
].join("\n\n");

// --- Meeting confirmations --------------------------------------------------
//
// Both go out two hours after the meeting is booked, while it's still fresh.
//
// These two carry per-client placeholders in CAPS that no automation can fill
// — the client's job title, their first name, and whose name the invite shows
// under. They are listed in MEETING_CONFIRMATION_EDITS so the run can say
// plainly that they still need editing, rather than leaving one client's
// details to go out to another client's prospects.

/** Confirms the invite landed, when the booking used our own calendar. */
export const MEETING_CONFIRMATION_NORMAL = [
  `${GREETING} just to double-check:`,
  "Did you get the calendar invite from our JOB TITLE, CLIENT FIRST NAME?",
  "The event should appear as “Your Name and Alix Rudin” on your calendar.",
  "Thanks and let me know!",
  "{{sender_first_name}}",
].join("\n\n");

/** Confirms the invite landed, when the prospect booked through their own link. */
export const MEETING_CONFIRMATION_PROSPECT = [
  GREETING,
  "Just wanted to let you know that our JOB TITLE CLIENT FIRST NAME got the invite.",
  "HE/SHE will be the one speaking with you.",
  "Did the booking come through to you as well?",
  "Thanks!",
  "{{sender_first_name}}",
].join("\n\n");

// The ALL-CAPS markers — JOB TITLE, CLIENT FIRST NAME, HE/SHE — are deliberate.
// This is a template campaign that gets duplicated per client, so they are
// meant to sit there until someone fills them in, and the run does NOT report
// them as unfinished work.
//
// "Your Name and Alix Rudin" is different in kind: not a marker but a real
// person's name carried over from the template this came from, so it reads as
// finished copy while being wrong for every other client. That one is worth
// naming once.
export const MEETING_CONFIRMATION_NORMAL_EDITS = ["Your Name and Alix Rudin"];
