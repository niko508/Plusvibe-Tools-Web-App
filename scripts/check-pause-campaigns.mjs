// Unit checks for the Pause Campaigns decisions: what gets paused, the order
// it is paused and resumed in, when a resume is due, and what dates are
// accepted.
//
// Imports the REAL module through the TS loader.
//
//   node scripts/check-pause-campaigns.mjs

import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(
      `FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`
    );
  }
};

const p = await importTs("@/lib/pause-campaigns/plan");
const { planPause, orderForPause, orderForResume, validateResumeAt, isResumeDue, labelFor, kindOf } = p;

// --- what gets paused ------------------------------------------------------

const WS = [
  { id: "p1", name: "Tree Removal", status: "ACTIVE", campaignType: "parent" },
  { id: "s1", name: "Tree · Positive Reply", status: "ACTIVE", campaignType: "subseq", parentCampId: "p1" },
  { id: "s2", name: "Tree · No Show", status: "ACTIVE", campaignType: "subseq", parentCampId: "p1" },
  { id: "p2", name: "Gutter", status: "PAUSED", campaignType: "parent" },
  { id: "s3", name: "Gutter · Reply", status: "PAUSED", campaignType: "subseq", parentCampId: "p2" },
  { id: "p3", name: "Roof", status: "DRAFTED", campaignType: "parent" },
  { id: "p4", name: "Old", status: "ARCHIVED", campaignType: "parent" },
  { id: "p5", name: "Done", status: "COMPLETED", campaignType: "parent" },
  { id: "p6", name: "Solar", status: "active", campaignType: "parent" },
];

const plan = planPause(WS);
eq("only ACTIVE campaigns are paused", plan.toPause.map((c) => c.id), ["p1", "p6", "s1", "s2"]);
eq("…counted by kind", [plan.parents, plan.subsequences], [2, 2]);
eq("…and everything else is left alone", plan.skipped, 5);
eq("status is matched case-insensitively", plan.toPause.some((c) => c.id === "p6"), true);
eq("a sub-sequence keeps its parent id", plan.toPause.find((c) => c.id === "s1").parentId, "p1");
eq("a parent has no parent id", plan.toPause.find((c) => c.id === "p1").parentId, undefined);

// A campaign someone paused by hand last week must never be touched — it is
// not in the plan, so the resume can't turn it on either.
eq("a hand-paused parent is not in the plan", plan.toPause.some((c) => c.id === "p2"), false);
eq("nor its paused sub-sequence", plan.toPause.some((c) => c.id === "s3"), false);

eq("an empty workspace plans nothing", planPause([]).toPause, []);
eq("a campaign with no id is dropped", planPause([{ id: "", name: "x", status: "ACTIVE" }]).toPause, []);
eq("no campaignType means parent", kindOf({}), "parent");

// --- order ------------------------------------------------------------------

const mixed = [
  { kind: "subseq", id: "s1" },
  { kind: "parent", id: "p1" },
  { kind: "subseq", id: "s2" },
  { kind: "parent", id: "p2" },
];
eq("parents come first, order kept within each kind", orderForPause(mixed).map((c) => c.id), ["p1", "p2", "s1", "s2"]);
eq("resume uses the same order", orderForResume === orderForPause, true);

// --- resume date -------------------------------------------------------------

const NOW = 1_800_000_000_000;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
eq("a time in the past is refused", typeof validateResumeAt(NOW - HOUR, NOW), "string");
eq("now is refused", typeof validateResumeAt(NOW, NOW), "string");
eq("30 seconds out is refused", typeof validateResumeAt(NOW + 30_000, NOW), "string");
eq("a minute out is allowed", validateResumeAt(NOW + MIN, NOW), null);
eq("tomorrow is allowed", validateResumeAt(NOW + DAY, NOW), null);
eq("next month is allowed", validateResumeAt(NOW + 30 * DAY, NOW), null);
eq("a year out is allowed", validateResumeAt(NOW + 365 * DAY, NOW), null);
eq("over a year is refused as a likely typo", typeof validateResumeAt(NOW + 400 * DAY, NOW), "string");
eq("a string is refused", typeof validateResumeAt("2026-01-01", NOW), "string");
eq("NaN is refused", typeof validateResumeAt(NaN, NOW), "string");
eq("undefined is refused", typeof validateResumeAt(undefined, NOW), "string");

// --- when the scheduler fires -------------------------------------------------

eq("paused and past due fires", isResumeDue({ status: "paused", resumeAt: NOW - 1 }, NOW), true);
eq("paused and exactly due fires", isResumeDue({ status: "paused", resumeAt: NOW }, NOW), true);
eq("paused but not yet due waits", isResumeDue({ status: "paused", resumeAt: NOW + 1 }, NOW), false);
eq("no resume scheduled never fires", isResumeDue({ status: "paused" }, NOW), false);
eq("already resumed never fires again", isResumeDue({ status: "done", resumeAt: NOW - 1, resumedAt: NOW - 1 }, NOW), false);
eq("resuming in flight doesn't fire twice", isResumeDue({ status: "resuming", resumeAt: NOW - 1 }, NOW), false);
eq("still pausing doesn't fire", isResumeDue({ status: "running", resumeAt: NOW - 1 }, NOW), false);
// A pause that was stopped or cut off still left campaigns paused, and the
// date the user set still applies to them.
eq("a stopped pause still fires its resume", isResumeDue({ status: "aborted", resumeAt: NOW - 1 }, NOW), true);
eq("an interrupted pause still fires its resume", isResumeDue({ status: "interrupted", resumeAt: NOW - 1 }, NOW), true);
eq("a finished job doesn't fire", isResumeDue({ status: "done", resumeAt: NOW - 1 }, NOW), false);
eq("an errored job doesn't fire", isResumeDue({ status: "error", resumeAt: NOW - 1 }, NOW), false);

// --- label -------------------------------------------------------------------

eq("one workspace", labelFor(["Alpha"]), "Alpha");
eq("two workspaces", labelFor(["Alpha", "Bravo"]), "Alpha, Bravo");
eq("many workspaces", labelFor(["Alpha", "Bravo", "Charlie", "Delta"]), "Alpha, Bravo +2 more");
eq("blank names are dropped", labelFor(["", "Alpha", " "]), "Alpha");
eq("none", labelFor([]), "No workspaces");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
