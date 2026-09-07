// Unit checks for the Blocked Domains repeat-check schedule: when a domain is
// looked at again, and when watching it stops being worth anything.
// Imports the REAL modules.
//
//   node scripts/check-blocked-recheck.mjs

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

const m = await importTs("@/lib/blocked-domains/recheck");
const {
  DAY_MS, nextRunAt, isRecheckDue, canRecheck, endOfTheLine, startRecheck, describeNext,
  DEFAULT_RECHECK_DAYS, MAX_RECHECK_DAYS, normalizeRecheckDays,
} = m;

const NOW = 1_800_000_000_000;
const job = (over = {}) => ({ id: "j", domain: "acme.com", status: "kept", ...over });

// --- the schedule ------------------------------------------------------------------
eq("a day is a day", DAY_MS, 86_400_000);
eq("7 days on", nextRunAt(NOW, 7), NOW + 7 * DAY_MS);
eq("the default gap is 7 days", DEFAULT_RECHECK_DAYS, 7);


const armed = startRecheck(NOW, 7, true);
eq("a newly armed record is due in 7 days, with no runs yet", [armed.enabled, armed.nextAt, armed.runs], [true, NOW + 7 * DAY_MS, []]);
eq("…armed as off, it has no next time at all", startRecheck(NOW, 7, false).nextAt, undefined);

// --- when a check is due --------------------------------------------------------------
eq("not due before the time", isRecheckDue(job({ recheck: armed }), NOW + 6 * DAY_MS), false);
eq("due on the dot", isRecheckDue(job({ recheck: armed }), NOW + 7 * DAY_MS), true);
eq("…and still due later (a restart must not skip it)", isRecheckDue(job({ recheck: armed }), NOW + 30 * DAY_MS), true);
eq("switched off is never due", isRecheckDue(job({ recheck: { ...armed, enabled: false } }), NOW + 30 * DAY_MS), false);
eq("no schedule at all is never due", isRecheckDue(job({}), NOW + 30 * DAY_MS), false);
eq("armed but unscheduled is never due", isRecheckDue(job({ recheck: { ...armed, nextAt: undefined } }), NOW + 30 * DAY_MS), false);
eq("a re-armed record stops watching", isRecheckDue(job({ recheck: armed, rearmedAt: NOW }), NOW + 30 * DAY_MS), false);

// --- when a run may start ---------------------------------------------------------------
eq("a kept domain may be re-checked", canRecheck(job({ status: "kept" })), true);
eq("…so may one waiting for confirmation", canRecheck(job({ status: "awaiting_confirmation" })), true);
eq("…and a dismissed or finished one", [canRecheck(job({ status: "dismissed" })), canRecheck(job({ status: "done" }))], [true, true]);
eq("a first pass still running is left alone", canRecheck(job({ status: "working" })), false);
eq("…as is one mid-deletion", canRecheck(job({ status: "deleting" })), false);

// --- when watching stops being worth anything ---------------------------------------------
eq("keep watching a kept domain with inboxes", endOfTheLine({ inboxesFound: 5, keptInboxes: 2, writtenOff: false }).reason, null);
eq("…and a written-off one that still has inboxes sending", endOfTheLine({ inboxesFound: 5, keptInboxes: 2, writtenOff: true }).reason, null);
eq("no inboxes left ends it", endOfTheLine({ inboxesFound: 0, keptInboxes: 0, writtenOff: true }).reason, "No inboxes left on this domain.");
eq("…even on a domain that was kept", endOfTheLine({ inboxesFound: 0, keptInboxes: 0, writtenOff: false }).reason, "No inboxes left on this domain.");
eq("written off with everything stopped ends it", endOfTheLine({ inboxesFound: 5, keptInboxes: 0, writtenOff: true }).reason, "The domain is written off and every inbox is stopped.");
// A kept domain whose inboxes are all stopped is NOT finished: the domain
// itself can still fall under its bar and need writing off.
eq("a kept domain with everything stopped is still watched", endOfTheLine({ inboxesFound: 5, keptInboxes: 0, writtenOff: false }).reason, null);

// --- the gap between checks ---------------------------------------------------------------
eq("a whole number of days passes through", normalizeRecheckDays(14), 14);
eq("a numeric string is read", normalizeRecheckDays("3"), 3);
eq("a fraction is rounded", normalizeRecheckDays(6.6), 7);
eq("zero and below fall back to 7", [normalizeRecheckDays(0), normalizeRecheckDays(-5)], [7, 7]);
eq("nonsense falls back to 7", normalizeRecheckDays("soon"), 7);
eq("missing falls back to 7", normalizeRecheckDays(undefined), 7);
eq("an absurd gap is clamped", normalizeRecheckDays(9999), MAX_RECHECK_DAYS);

// --- how it reads -------------------------------------------------------------------------
eq("days out", describeNext(NOW + 7 * DAY_MS, NOW), "in 7 days");
eq("hours out", describeNext(NOW + 4 * 3_600_000, NOW), "in 4h");
eq("past due", describeNext(NOW - 1000, NOW), "due now");
eq("unscheduled", describeNext(undefined, NOW), "not scheduled");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
