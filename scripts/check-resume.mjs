// Unit checks for continuing a run a restart cut off: what it already moved,
// the request that continues it, and a split that comes out as one whole.
// Imports the REAL modules.
//
//   node scripts/check-resume.mjs

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

const { planSplitFor, ALL_AVAILABLE } = await importTs("@/lib/campaign-types/split");
const { planAllocation } = await importTs("@/lib/campaign-types/allocate");
const { movedSoFar, resumePayload, shouldAutoResume, supersededBy, AUTO_RESUME_WINDOW_MS } = await importTs(
  "@/lib/campaign-types/resume"
);

const range = (n, p = "l") => Array.from({ length: n }, (_, i) => `${p}${i}`);
const sizes = (plan) => Object.fromEntries(plan.moves.map((m) => [m.destination, m.leads.length]));

// --- the split, finished rather than redone ------------------------------------
console.log("--- the split with nothing carried is the plain split");
{
  const avail = { blue: true, blueOptOut: true, blueSignature: false, optOut: true, signature: false };
  const a = planSplitFor(range(9555, "m"), range(16594, "g"), avail);
  eq("…counts", a.counts, { source: 8297, optOut: 8297, blue: 4778, blueOptOut: 4777, signature: 0, blueSignature: 0 });
  // The same run with every copy present, on odd numbers.
  const b = planSplitFor(range(7, "m"), range(9, "g"), ALL_AVAILABLE);
  eq("…all five copies, odd numbers", b.counts, { source: 3, optOut: 4, blue: 2, blueOptOut: 3, signature: 2, blueSignature: 2 });
}

console.log("--- a run cut off part-way, then continued");
{
  // The run in the report: 9,555 on the 🔵 side, 16,594 Google, no
  // Signature copies. It stopped 2,400 leads into the 🔵 campaign.
  const avail = { blue: true, blueOptOut: true, blueSignature: false, optOut: true, signature: false };
  const whole = planSplitFor(range(9555, "m"), range(16594, "g"), avail);
  const rest = planSplitFor(range(9555 - 2400, "m"), range(16594, "g"), avail, { blue: 2400 });
  eq("the 🔵 campaign gets only what it is still short of", sizes(rest).blue, whole.counts.blue - 2400);
  eq("…the others their full share", [sizes(rest).blueOptOut, sizes(rest).optOut], [whole.counts.blueOptOut, whole.counts.optOut]);
  eq("…and the same stays in the source", rest.counts.source, whole.counts.source);
  const naive = planSplitFor(range(9555 - 2400, "m"), range(16594, "g"), avail);
  eq("(a plain re-run would have given the 🔵 campaign 1,200 too many)", 2400 + naive.counts.blue - whole.counts.blue, 1200);
}
{
  // Cut off twice, in different copies: the totals still match one run.
  const whole = planSplitFor(range(101, "m"), range(77, "g"), ALL_AVAILABLE).counts;
  const carried = { blue: whole.blue, blueSignature: 10, signature: 3 };
  const leftMs = 101 - whole.blue - 10;
  const leftOt = 77 - 3;
  const rest = planSplitFor(range(leftMs, "m"), range(leftOt, "g"), ALL_AVAILABLE, carried);
  const total = (d) => (carried[d] ?? 0) + (sizes(rest)[d] ?? 0);
  eq("across two interruptions, every copy ends with its one-run share",
    ["blue", "blueSignature", "blueOptOut", "signature", "optOut"].map(total),
    [whole.blue, whole.blueSignature, whole.blueOptOut, whole.signature, whole.optOut]);
  eq("…and the source keeps its share", rest.counts.source, whole.source);
}
{
  // Over-credited (an estimate that ran high): Microsoft leads left over go
  // to the 🔵 campaign, never to the Google source.
  const rest = planSplitFor(range(10, "m"), range(0, "g"), ALL_AVAILABLE, { blueOptOut: 50 });
  eq("an over-credited copy leaves no Microsoft lead in the source", rest.counts.source, 0);
  eq("…they all still move", Object.values(sizes(rest)).reduce((a, b) => a + b, 0), 10);
}

console.log("--- Fix Allocation, continued");
{
  const dests = [
    { campaignId: "y", campaignName: "🟡 Apps (August)", role: "source" },
    { campaignId: "b", campaignName: "🔵 Apps (August)", role: "blue" },
    { campaignId: "yo", campaignName: "🟡 Apps - Opt Out (August)", role: "optOut" },
    { campaignId: "bo", campaignName: "🔵 Apps - Opt Out (August)", role: "blueOptOut" },
  ];
  const mk = (n, blue, p) => range(n, p).map((lead) => ({ lead, segment: "app", blue }));
  const whole = planAllocation([...mk(40, true, "m"), ...mk(30, false, "g")], "app", dests);
  const size = (plan) => Object.fromEntries(plan.moves.map((m) => [m.campaignId, m.leads.length]));
  eq("with nothing carried it is unchanged", size(whole), { b: 20, bo: 20, y: 15, yo: 15 });
  // Stopped 12 leads into 🔵 Apps.
  const rest = planAllocation([...mk(28, true, "m"), ...mk(30, false, "g")], "app", dests, { blue: 12 });
  eq("continued, 🔵 Apps is topped up to its share and no further", size(rest), { b: 8, bo: 20, y: 15, yo: 15 });
  eq("…nothing stranded", rest.stranded, 0);
}

// --- what a cut-off run had moved ----------------------------------------------
console.log("--- how far an interrupted run got");
const target = (role, name, planned, moved = 0, extra = {}) => ({ role, name, planned, moved, state: "error", ...extra });
const reported = {
  // The card in the report, as saved by the build before live counts.
  campaignId: "src",
  campaignName: "Home Services Broad (September)",
  state: "error",
  phase: "moving",
  phaseStates: { sorting: "done", duplicating: "done", moving: "error", activating: "skipped" },
  sorting: {},
  created: [
    { role: "blue", name: "🔵 Home Services Broad (September)", campaignId: "b", state: "done" },
    { role: "optOut", name: "Home Services Broad - Opt Out (September)", campaignId: "o", state: "done" },
    { role: "blueOptOut", name: "🔵 Home Services Broad - Opt Out (September)", campaignId: "bo", state: "done" },
  ],
  moving: {
    targets: [
      target("blue", "🔵 Home Services Broad (September)", 4778),
      target("optOut", "Home Services Broad - Opt Out (September)", 8297, 0, { state: "pending" }),
      target("blueOptOut", "🔵 Home Services Broad - Opt Out (September)", 4777, 0, { state: "pending" }),
    ],
    staysInSource: 8297,
    processed: 2500,
    plannedTotal: 17852,
  },
  activation: [],
};
const reportedErrors = [
  "3 domain(s) could not be resolved (e.g. a.com). Their leads were treated as neither Microsoft nor Google.",
  'Moving leads 2401–2500 to "🔵 Home Services Broad (September)" failed twice at the add step: leads>60>email: "leads[60].email" …. Those leads stayed where they were.',
];
eq("the reported run: 2,400 into the 🔵 campaign, the failed chunk not counted",
  movedSoFar(reported, reportedErrors), { blue: 2400 });
eq("…without the error to go on, the whole 2,500", movedSoFar(reported, []), { blue: 2500 });
{
  // Counted live: the recorded numbers are taken as they are.
  const live = structuredClone(reported);
  live.moving.targets[0] = target("blue", live.moving.targets[0].name, 4778, 4778, { state: "done" });
  live.moving.targets[2] = target("blueOptOut", live.moving.targets[2].name, 4777, 1200, { unmoved: 3 });
  live.moving.processed = 4778 + 1203;
  eq("a live-counted run is read as recorded", movedSoFar(live, []), { blue: 4778, blueOptOut: 1200 });
}

// --- the request that continues it ---------------------------------------------
console.log("--- the request that continues it");
const job = (over = {}) => ({
  id: "j1",
  label: "Home Services Broad (September)",
  mode: "move",
  status: "interrupted",
  phase: "finished",
  phaseStates: { segmenting: "skipped", building: "error", tagging: "pending" },
  createdAt: 1000,
  updatedAt: 5000,
  startedAt: 1100,
  workspaceId: "ws1",
  workspaceName: "Client A",
  kinds: ["default", "optOut"],
  segmenting: { rules: [], leadsFound: 0, stayed: 0, unmapped: 0, unmappedSegments: [], plannedTotal: 0, processed: 0, moved: 0 },
  sources: [structuredClone(reported)],
  tagging: { targets: [], tagsCreated: [] },
  errors: reportedErrors,
  ...over,
});
{
  const p = resumePayload(job());
  eq("an old record is rebuilt into the same request", [p.mode, p.workspaceId, p.kinds, p.rules, p.activate], ["move", "ws1", ["default", "optOut"], [], false]);
  eq("…with the names the run really used", [p.sources[0].names.blue, p.sources[0].names.optOut, p.sources[0].names.blueOptOut],
    ["🔵 Home Services Broad (September)", "Home Services Broad - Opt Out (September)", "🔵 Home Services Broad - Opt Out (September)"]);
  eq("…carrying what it moved", p.carry, { src: { blue: 2400 } });
}
{
  // A record that kept its request uses it, and adds up carries across
  // more than one interruption.
  const request = { mode: "create", workspaceId: "ws1", workspaceName: "Client A", sources: [{ campaignId: "src", campaignName: "X", names: { blue: "🔵 X" } }], kinds: ["default"], rules: [], activate: true };
  const j = job({ mode: "create", request });
  j.sources[0].moving.targets[0].carried = 1000;
  const p = resumePayload(j);
  eq("a kept request is used as it was", [p.mode, p.activate, p.sources[0].names.blue], ["create", true, "🔵 X"]);
  eq("…and earlier carries are added to this run's", p.carry, { src: { blue: 3400 } });
}
{
  const fix = job({
    mode: "fix",
    sources: [],
    allocation: {
      segment: "app",
      sources: [{ campaignId: "s1", campaignName: "🟡 LB", leads: 10 }],
      destinations: [
        { campaignId: "y", campaignName: "🟡 Apps", role: "source", planned: 5, moved: 5, unmoved: 0 },
        { campaignId: "b", campaignName: "🔵 Apps", role: "blue", planned: 5, moved: 2, unmoved: 0, carried: 3 },
      ],
      leadsFound: 10, matched: 10, stranded: 0, moved: 7, state: "error",
    },
  });
  const p = resumePayload(fix);
  eq("a fix run continues with the same segment and campaigns", [p.mode, p.segment, p.destinations.map((d) => d.campaignId)], ["fix", "app", ["y", "b"]]);
  eq("…carrying what each destination got", p.carryAlloc, { y: 5, b: 5 });
}
eq("a record with no workspace cannot be continued", resumePayload(job({ workspaceId: undefined })), null);

// --- when it happens on its own ------------------------------------------------
console.log("--- when a run is picked up on its own");
{
  const now = 5000 + 60_000;
  eq("an interrupted run is", shouldAutoResume(job(), now), true);
  eq("…not one already continued", shouldAutoResume(job({ resumedAs: "j2" }), now), false);
  eq("…not one that finished", shouldAutoResume(job({ status: "done" }), now), false);
  eq("…not one cut off more than a day ago", shouldAutoResume(job({ interruptedAt: 1000 }), 1000 + AUTO_RESUME_WINDOW_MS + 1), false);
  // Started again by hand from the form since: continuing the old one would
  // redo that run's split on top of it.
  const later = job({ id: "j9", status: "running", createdAt: 9000 });
  eq("…not one a later run of the same campaign has overtaken", shouldAutoResume(job(), now, [job(), later]), false);
  eq("…and that later run is named", supersededBy(job(), [later])?.id, "j9");
  eq("…while its own continuation does not count", supersededBy(job(), [job({ id: "j2", createdAt: 9000, resumedFrom: "j1" })]), null);
  const other = job({ id: "j8", createdAt: 9000, sources: [{ ...structuredClone(reported), campaignId: "elsewhere" }] });
  eq("…nor a later run of a different campaign", shouldAutoResume(job(), now, [other]), true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
