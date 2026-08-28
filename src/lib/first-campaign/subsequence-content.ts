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
 * Liquid's `date: '%u'` gives the ISO weekday (1 = Monday). There's no branch
 * for 6 or 7, so an email that somehow sends at the weekend renders the
 * sentence with a gap — the schedules keep sending inside Mon–Fri, which is
 * what makes that safe.
 */
const AVAILABILITY_NEAR =
  "{% assign today_number = 'now' | date: '%u' | plus: 0 %}" +
  "{% if today_number == 1 %}this Wednesday and Thursday" +
  "{% elsif today_number == 2 %}this Thursday and Friday" +
  "{% elsif today_number == 3 %}this Friday or next Monday" +
  "{% elsif today_number == 4 %}next Monday or Tuesday" +
  "{% elsif today_number == 5 %}next Tuesday or Wednesday" +
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
