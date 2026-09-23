// Unit checks for settling a run's inner states after a restart. Imports the
// REAL module.
//
//   node scripts/check-settle.mjs

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

const { settleRunning } = await importTs("@/lib/jobs/settle");

// The shape of a real run that was stopped by a redeploy mid-move: the top
// says interrupted, and everything inside still says it is going.
const stuck = () => ({
  status: "interrupted",
  phase: "building",
  phaseStates: { segmenting: "skipped", building: "running", tagging: "pending" },
  sources: [{
    state: "running",
    phase: "moving",
    phaseStates: { sorting: "done", duplicating: "done", moving: "running", activating: "skipped" },
    moving: { targets: [{ role: "blue", state: "running" }, { role: "optOut", state: "pending" }] },
  }],
  tagging: { targets: [] },
});

const rec = stuck();
const n = settleRunning(rec);
eq("every spinner in a stopped run is settled", n, 4);
eq("…the job's own phase", rec.phaseStates.building, "error");
eq("…the original's state and its phase", [rec.sources[0].state, rec.sources[0].phaseStates.moving], ["error", "error"]);
eq("…and the target it was moving into", rec.sources[0].moving.targets[0].state, "error");

// What never started is left saying so; what finished is left alone.
eq("what never started still says pending",
  [rec.phaseStates.tagging, rec.sources[0].moving.targets[1].state], ["pending", "pending"]);
eq("…and what finished is untouched",
  [rec.phaseStates.segmenting, rec.sources[0].phaseStates.sorting, rec.sources[0].phaseStates.activating], ["skipped", "done", "skipped"]);
// The top-level word is the caller's to set, and "interrupted" says more than
// "error" would.
eq("the run's own status is not touched", rec.status, "interrupted");
eq("…nor are the phase names, which are not states", [rec.phase, rec.sources[0].phase], ["building", "moving"]);

eq("settling twice changes nothing more", settleRunning(rec), 0);
eq("a Start Outreach run's steps are settled too",
  (() => { const r = { status: "interrupted", steps: [{ key: "move", state: "done" }, { key: "signatures", state: "running" }, { key: "tags", state: "pending" }] }; settleRunning(r); return r.steps.map((s) => s.state); })(),
  ["done", "error", "pending"]);
eq("nothing to settle is nothing to do", [settleRunning(null), settleRunning({}), settleRunning([])], [0, 0, 0]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
