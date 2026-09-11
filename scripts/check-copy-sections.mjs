// Unit checks for Change Email Copy Sections: tolerant find & replace inside
// HTML bodies, paragraph sections, and applying an edit to a variation.
//
// Imports the REAL module through the TS loader.
//
//   node scripts/check-copy-sections.mjs

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

const m = await importTs("@/lib/copy-sections/edit");
const { replaceText, blockText, splitBlocks, paragraphRuns, renderParagraphs, setBodySection, applyEdit, validateEdit, normalizeFind, SPACER } = m;
const H = { html: true, caseSensitive: false };

// --- find & replace: the plain cases ----------------------------------------

eq("plain replace", replaceText("<div>Hope you are well.</div>", "Hope you are well.", "Quick one.", H),
  { text: "<div>Quick one.</div>", matches: 1 });
eq("every occurrence", replaceText("<div>a b a</div><div>a</div>", "a", "x", H).matches, 3);
eq("not found leaves it alone", replaceText("<div>Hello</div>", "Goodbye", "x", H), { text: "<div>Hello</div>", matches: 0 });
eq("case-insensitive by default", replaceText("<div>HELLO there</div>", "hello", "hi", H).text, "<div>hi there</div>");
eq("case-sensitive when asked", replaceText("<div>HELLO there</div>", "hello", "hi", { html: true, caseSensitive: true }).matches, 0);
eq("empty find matches nothing", replaceText("<div>x</div>", "   ", "y", H).matches, 0);
eq("variables are literal", replaceText("<div>Hi {{first_name}},</div>", "{{first_name}}", "{{company_name}}", H).text, "<div>Hi {{company_name}},</div>");

// --- the reason matching is done on a view, not the raw HTML ----------------

eq("&nbsp; counts as a space", replaceText("<div>Hi&nbsp;John, how are you</div>", "Hi John, how", "Hey John, how", H).text, "<div>Hey John, how are you</div>");
eq("an apostrophe stored as &#39; matches a typed one", replaceText("<div>how&#39;s it going</div>", "how's it going", "all good?", H).text, "<div>all good?</div>");
eq("double spaces in the HTML don't defeat a single-spaced find", replaceText("<div>Hi  John</div>", "Hi John", "Yo John", H).text, "<div>Yo John</div>");
eq("double spaces in the FIND don't defeat it either", replaceText("<div>Hi John</div>", "Hi   John", "Yo John", H).text, "<div>Yo John</div>");
eq("a bold word inside the match is absorbed", replaceText("<div>Hi <b>John</b>, hello</div>", "Hi John, hello", "Bye", H).text, "<div>Bye</div>");
eq("a link around the match is absorbed", replaceText('<div>see <a href="x">our site</a> now</div>', "see our site now", "visit", H).text, "<div>visit</div>");
eq("a match never crosses a paragraph", replaceText("<div>Hi John,</div><div>how are you</div>", "Hi John, how are you", "x", H).matches, 0);
eq("a match never crosses a <br>", replaceText("<div>Thanks,<br>Niko</div>", "Thanks, Niko", "x", H).matches, 0);
eq("but matches on either side of a <br> work", replaceText("<div>Thanks,<br>Niko</div>", "Niko", "Sam", H).text, "<div>Thanks,<br>Sam</div>");
eq("tags outside the match are untouched", replaceText("<div><b>Hi</b> John, <i>bye</i></div>", "John", "Sam", H).text, "<div><b>Hi</b> Sam, <i>bye</i></div>");
eq("entities outside the match survive", replaceText("<div>Tom &amp; Jerry, hi John</div>", "hi John", "hi Sam", H).text, "<div>Tom &amp; Jerry, hi Sam</div>");

// --- the replacement is written safely --------------------------------------

eq("replacement is escaped for HTML", replaceText("<div>x</div>", "x", "a < b & c", H).text, "<div>a &lt; b &amp; c</div>");
eq("a newline in the replacement becomes <br>", replaceText("<div>x</div>", "x", "Thanks,\nNiko", H).text, "<div>Thanks,<br>Niko</div>");
eq("empty replacement deletes", replaceText("<div>Hi John, hello</div>", "John,", "", H).text, "<div>Hi  hello</div>");
// Leading/trailing whitespace in the find text is ignored — it's collapsed on
// both sides, so " John" means "John".
eq("surrounding spaces in the find are ignored", replaceText("<div>Hi John</div>", "  John  ", "Sam", H).text, "<div>Hi Sam</div>");
eq("subject is plain: no escaping", replaceText("Tom & Jerry", "Jerry", "<Spike>", { html: false, caseSensitive: false }).text, "Tom & <Spike>");
// A subject is plain text, so "&amp;" in it really is the five characters.
eq("subject: no entity decoding — a literal & is a &", replaceText("a & b", "&", "and", { html: false, caseSensitive: false }).text, "a and b");

// --- paragraphs ---------------------------------------------------------------

const BODY = "<div>Hi {{first_name}},</div><div>&nbsp;</div><div>Noticed you're hiring.</div><div>Worth a chat?</div><div>&nbsp;</div><div>Thanks,</div><div>Niko</div>";
eq("blockText reads paragraphs with line breaks", blockText(BODY), "Hi {{first_name}},\n\nNoticed you're hiring.\nWorth a chat?\n\nThanks,\nNiko");
eq("splitBlocks finds every top-level div", splitBlocks(BODY).length, 7);
eq("…and knows which are spacers", splitBlocks(BODY).map((b) => b.spacer), [false, true, false, false, true, false, false]);
eq("a spacer with a <br> is still a spacer", splitBlocks("<div><br></div>")[0].spacer, true);
eq("runs are groups between blank lines", paragraphRuns(BODY).map((r) => blockText(r.raw)), ["Hi {{first_name}},", "Noticed you're hiring.\nWorth a chat?", "Thanks,\nNiko"]);
eq("nested divs stay inside their run", paragraphRuns("<div><div>a</div><div>b</div></div><div>&nbsp;</div><div>c</div>").length, 2);
eq("<p> bodies work too", paragraphRuns("<p>a</p><p>&nbsp;</p><p>b</p>").length, 2);
eq("a bare-text body is one run", paragraphRuns("Just text").length, 1);
eq("an empty body has no runs", paragraphRuns("").length, 0);

eq("renderParagraphs: one div per line", renderParagraphs("Thanks,\nNiko"), "<div>Thanks,</div><div>Niko</div>");
eq("…a blank line becomes a spacer", renderParagraphs("a\n\nb"), `<div>a</div>${SPACER}<div>b</div>`);
eq("…text is escaped", renderParagraphs("a < b"), "<div>a &lt; b</div>");
eq("…variables survive", renderParagraphs("Hi {{first_name}}"), "<div>Hi {{first_name}}</div>");
eq("…asHtml is used as written", renderParagraphs("<div><b>x</b></div>", true), "<div><b>x</b></div>");

// --- the sections people actually change --------------------------------------

const op = setBodySection(BODY, "opening", "Hey {{first_name}} — quick one.");
eq("opening: replaces the first paragraph only", op.body, "<div>Hey {{first_name}} — quick one.</div><div>&nbsp;</div><div>Noticed you're hiring.</div><div>Worth a chat?</div><div>&nbsp;</div><div>Thanks,</div><div>Niko</div>");
eq("…reporting what it replaced", op.before, "Hi {{first_name}},");
const cl = setBodySection(BODY, "closing", "Best,\n{{sender_first_name}}");
eq("closing: replaces the WHOLE sign-off, both lines", cl.body, "<div>Hi {{first_name}},</div><div>&nbsp;</div><div>Noticed you're hiring.</div><div>Worth a chat?</div><div>&nbsp;</div><div>Best,</div><div>{{sender_first_name}}</div>");
eq("…reporting what it replaced", cl.before, "Thanks,\nNiko");
eq("closing with a <br> sign-off replaces the whole thing", setBodySection("<div>Hi</div><div>&nbsp;</div><div>Thanks,<br>Niko</div>", "closing", "Cheers").body, "<div>Hi</div><div>&nbsp;</div><div>Cheers</div>");
eq("a single-paragraph body: opening and closing are the same paragraph", setBodySection("<div>only</div>", "closing", "new").body, "<div>new</div>");
eq("an empty body gets the paragraph", setBodySection("", "opening", "Hi").body, "<div>Hi</div>");
eq("already the same text is not a change", setBodySection("<div>Hi</div>", "opening", "Hi").changed, false);

// --- applying to a variation -----------------------------------------------------

const V = { variation: "A", subject: "Quick question, {{first_name}}", body: BODY };
const r1 = applyEdit(V, { kind: "replace-text", find: "{{first_name}}", replace: "{{company_name}}", target: "both", caseSensitive: false });
eq("replace in both: subject and body", [r1.subjectMatches, r1.bodyMatches, r1.changed], [1, 1, true]);
eq("…subject changed", r1.subject, "Quick question, {{company_name}}");
const r2 = applyEdit(V, { kind: "replace-text", find: "{{first_name}}", replace: "x", target: "subject", caseSensitive: false });
eq("target subject only leaves the body alone", [r2.subjectMatches, r2.bodyMatches, r2.body === BODY], [1, 0, true]);
const r3 = applyEdit(V, { kind: "replace-text", find: "nope", replace: "x", target: "both", caseSensitive: false });
eq("not found: unchanged with a reason", [r3.changed, r3.reason], [false, "text not found"]);
const r4 = applyEdit(V, { kind: "set-section", section: "subject", text: "New subject" });
eq("set subject", [r4.subject, r4.changed, r4.body === BODY], ["New subject", true, true]);
eq("set subject to the same is no change", applyEdit(V, { kind: "set-section", section: "subject", text: V.subject }).changed, false);
const r5 = applyEdit(V, { kind: "set-section", section: "closing", text: "Best,\nSam" });
eq("set closing changes only the body", [r5.changed, r5.subject === V.subject, r5.body.endsWith("<div>Best,</div><div>Sam</div>")], [true, true, true]);

// --- validation ---------------------------------------------------------------------

eq("find is required", validateEdit({ kind: "replace-text", find: " ", replace: "x", target: "both", caseSensitive: false }, 2).length, 1);
eq("find == replace is pointless", validateEdit({ kind: "replace-text", find: "a", replace: "a", target: "both", caseSensitive: false }, 2).length, 1);
eq("a good replace is fine", validateEdit({ kind: "replace-text", find: "a", replace: "b", target: "both", caseSensitive: false }, 2), []);
eq("step 1 can't get a blank subject", validateEdit({ kind: "set-section", section: "subject", text: " " }, 1).length, 1);
eq("a later step can (replies in-thread)", validateEdit({ kind: "set-section", section: "subject", text: "" }, 2), []);
eq("a paragraph needs text", validateEdit({ kind: "set-section", section: "opening", text: "" }, 1).length, 1);
eq("normalizeFind collapses whitespace", normalizeFind("  a \n  b  "), "a b");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
