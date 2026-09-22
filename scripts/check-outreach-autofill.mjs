// Unit checks for picking a Start Outreach batch by size: which domains are
// taken for a given provider and count, and what it says when the number
// cannot be hit. Imports the REAL module.
//
//   node scripts/check-outreach-autofill.mjs

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

const { fillDomains, describeFill, providerOfDomain, FILL_PROVIDERS, FILL_PROVIDER_LABELS } =
  await importTs("@/lib/start-outreach/autofill");

const G = "GOOGLE_WORKSPACE", M = "MICROSOFT365", R = "REGULAR_ACCOUNT";
/** A domain with `ready` mailboxes ready to move, all on one provider. */
const dom = (domain, ready, provider = M) => ({ domain, ready, providers: [[provider, ready]] });

// --- which provider a domain counts as ------------------------------------------
console.log("--- the provider");
eq("the two the page offers", FILL_PROVIDERS, ["google", "microsoft"]);
eq("…named plainly", [FILL_PROVIDER_LABELS.google, FILL_PROVIDER_LABELS.microsoft], ["Google", "Microsoft"]);
eq("a Google domain is Google", providerOfDomain([[G, 3]]), "google");
eq("a Microsoft one is Microsoft", providerOfDomain([[M, 3]]), "microsoft");
eq("a mixed domain goes by the majority", providerOfDomain([[M, 5], [G, 1]]), "microsoft");
// An even split is a domain to look at, not one to guess at.
eq("an even split belongs to neither", providerOfDomain([[M, 2], [G, 2]]), null);
eq("plain SMTP belongs to neither", providerOfDomain([[R, 4]]), "other");

// --- the fill ---------------------------------------------------------------------
console.log("--- filling to a number");
const THREES = [dom("a.com", 3), dom("b.com", 3), dom("c.com", 3), dom("d.com", 3)];
// The case from the request: 7 asked, 3 per domain, so 6.
const seven = fillDomains(THREES, "microsoft", 7);
eq("7 asked of domains carrying 3 each takes 6", [seven.inboxes, seven.domains.length], [6, 2]);
eq("…and says why it is not 7", seven.shortfall, "rounded-down");
eq("…never taking more than asked", seven.inboxes <= seven.wanted, true);
eq("a number that fits exactly is hit exactly",
  (({ inboxes, shortfall }) => [inboxes, shortfall])(fillDomains(THREES, "microsoft", 9)), [9, null]);
eq("…and so is every domain there is",
  (({ inboxes, domains, shortfall }) => [inboxes, domains.length, shortfall])(fillDomains(THREES, "microsoft", 12)),
  [12, 4, null]);

// Asking for more than exists takes the lot and says so, rather than silently
// handing back a smaller batch that looks like the one that was asked for.
const tooMany = fillDomains(THREES, "microsoft", 50);
eq("more than there is takes everything", [tooMany.inboxes, tooMany.available], [12, 12]);
eq("…and says it is short", tooMany.shortfall, "short");

// --- which domains it takes ----------------------------------------------------------
console.log("--- which domains");
const MIXED = [dom("small.com", 2), dom("big.com", 6), dom("mid.com", 3), dom("tiny.com", 1)];
// Biggest first: 6 + 3 = 9, then 2 would overshoot 10 and is skipped, and 1
// still fits — so carrying on past a domain that does not fit is what lands
// it exactly on the number.
eq("it keeps going past a domain that would overshoot",
  (({ domains, inboxes, shortfall }) => [domains, inboxes, shortfall])(fillDomains(MIXED, "microsoft", 10)),
  [["big.com", "mid.com", "tiny.com"], 10, null]);
eq("…and takes the smaller one when that is what fits",
  (({ domains, inboxes }) => [domains, inboxes])(fillDomains(MIXED, "microsoft", 11)),
  [["big.com", "mid.com", "small.com"], 11]);
// Plenty left over, but nothing small enough to use it: 9 of two 5s is 5,
// and the second would take it to 10.
eq("it stops when nothing left fits, even with inboxes to spare",
  (({ domains, inboxes, available, shortfall }) => [domains, inboxes, available, shortfall])(
    fillDomains([dom("x.com", 5), dom("y.com", 5)], "microsoft", 9)
  ),
  [["x.com"], 5, 10, "rounded-down"]);
eq("the same numbers always pick the same domains",
  fillDomains([...MIXED].reverse(), "microsoft", 10).domains, ["big.com", "mid.com", "tiny.com"]);

// --- what it leaves alone ---------------------------------------------------------------
console.log("--- what it leaves out");
const BOTH = [dom("g1.com", 4, G), dom("g2.com", 4, G), dom("m1.com", 4, M), dom("smtp.com", 4, R)];
eq("only the provider asked for", fillDomains(BOTH, "google", 8).domains, ["g1.com", "g2.com"]);
eq("…and the other provider's on its own", fillDomains(BOTH, "microsoft", 8).domains, ["m1.com"]);
eq("…never one on neither provider",
  [fillDomains(BOTH, "google", 100).domains, fillDomains(BOTH, "microsoft", 100).domains].flat().includes("smtp.com"),
  false);
// Ticking a domain with nothing ready adds a name and no inboxes.
eq("a domain with nothing ready is not taken",
  fillDomains([dom("none.com", 0), dom("some.com", 2)], "microsoft", 5).domains, ["some.com"]);

// --- the awkward numbers -------------------------------------------------------------------
console.log("--- the awkward numbers");
// Asking for none and getting none is not a shortfall — there is nothing to
// explain, and the page says "type a number" instead.
eq("nothing asked for takes nothing, and is not called short",
  (({ domains, inboxes, shortfall }) => [domains, inboxes, shortfall])(fillDomains(THREES, "microsoft", 0)),
  [[], 0, null]);
eq("a negative is read as nothing", fillDomains(THREES, "microsoft", -5).wanted, 0);
eq("a fraction is read as the whole number below it", fillDomains(THREES, "microsoft", 9.9).inboxes, 9);
eq("no domains at all is an empty batch, not an error",
  (({ domains, inboxes, available, shortfall }) => [domains, inboxes, available, shortfall])(fillDomains([], "google", 10)),
  [[], 0, 0, "short"]);
// Every domain bigger than the target: nothing fits, and it must say so
// rather than quietly handing back one oversized domain.
eq("when every domain is bigger than the target, nothing is taken",
  (({ domains, inboxes, shortfall }) => [domains, inboxes, shortfall])(fillDomains([dom("big.com", 50)], "microsoft", 10)),
  [[], 0, "rounded-down"]);

// --- what the page says ----------------------------------------------------------------------
console.log("--- the wording");
eq("an exact fill says so", describeFill(fillDomains(THREES, "microsoft", 9), "microsoft"),
  "9 inboxes on 3 domains — exactly 9.");
eq("a rounded one explains itself", describeFill(seven, "microsoft"),
  "6 inboxes on 2 domains — 7 is not a whole number of domains, so it rounds down.");
eq("a short one says how short", describeFill(tooMany, "microsoft"),
  "12 inboxes on 4 domains — every Microsoft inbox that is ready, 38 short of 50.");
eq("nothing asked for asks for a number", describeFill(fillDomains(THREES, "microsoft", 0), "microsoft"),
  "Type how many Microsoft inboxes to move.");
eq("nothing ready says that instead", describeFill(fillDomains([], "google", 10), "google"),
  "No Google domains are ready.");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
