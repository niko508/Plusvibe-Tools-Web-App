// The starter follow-up templates, seeded into a fresh library.
//
// Verbatim copy that goes out to real recipients — do not reword or "fix" the
// punctuation. The mix of straight and curly apostrophes is deliberate: it's
// what the spintax was written with, and varying them is part of what keeps the
// sends from looking templated.
//
// SERVICE OFFERING / OFFER is substituted at run time with the sentence entered
// on the run.

export const DEFAULT_FOLLOW_UP_TEMPLATES: string[] = [
  `{% if first_name != blank %} {{Random | {{first_name}} – | {{first_name}} –}} {% else %} {{Random | Hey – | Hi –}} {% endif %} {{Random | I tried to reach out earlier | I tried to reach out a few days ago | I emailed you a while ago | I reached out earlier | I contacted previously | I tried reaching out earlier | I tried getting in touch a few days ago | I sent you an email a while back | I reached out a few days ago | I contacted you earlier | I wanted to follow up on my last message | I reached out not too long ago | I sent you a quick email earlier | I tried connecting with you recently | I emailed you a little while ago | I reached out a short time ago | I contacted you the other day | I sent over a message earlier | I tried to get in touch a few days back}} about SERVICE OFFERING / OFFER but {{Random | didn't hear back. | haven't gotten a response. | didn’t receive a reply. | didn't get a reply. | didn’t hear from you.}}

{{Random | Is there someone else on your team I should speak with about this? | Should I connect with someone else on your team regarding this? | Is there another person on your team who handles this that I should reach out to? | Would it make sense to talk to someone else on your team about this? | Is there a better person on your team to discuss this with? | Should I be reaching out to someone else on your team for this? | Who on your team would be the best person to discuss this with? | Is there someone else in your company who takes care of this? | Would it be better to connect with another team member about this? | Is there a specific person in your team responsible for this that I should contact? | Should I follow up with someone else on your team regarding this? | Is there a more relevant contact in your team I should speak to? | Would this be better suited for another person on your team? | Who on your team is the right person to discuss this with? | Is there anyone else in your company I should be speaking with about this?}}

{{Random | Either way, let me know. | Let me know either way. | Whatever the case, let me know. | Let me know if you're interested.}}

{{sender_first_name}}`,

  `{% if first_name != blank %} {{Random | {{first_name}} – | {{first_name}} –}} {% else %} {{Random | Hey – | Hi –}} {% endif %} {{Random | I reached out | I contacted you | I sent an email | I got in touch | I emailed | I tried to reach out | I emailed you | I wrote to you | I tried to email | reached out earlier}} {{Random | earlier about | previously about | before regarding | a few weeks ago about | earlier regarding | previously regarding | a while back about | some time ago about | not long ago about | recently about}} SERVICE OFFERING / OFFER {{Random | but didn't hear from you. | but haven't heard back. | but didn't get a response. | but never heard back.}}

{{Random | Is there another person | Is there someone else | Is there anybody else | Would there be someone}} {{Random | on your team | in your team | at your company | on your company}} {{Random | who handles this | who's in charge of this | who manages this | who oversees this}} {{Random | that I should reach out to? | I should connect with? | I should contact? | I could speak with?}}

{{Random | Either way, let me know. | Let me know either way. | Whatever the case, let me know. | Let me know if you're interested.}}

{{sender_first_name}}`,
];
