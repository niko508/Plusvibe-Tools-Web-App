// What a restart does to a run's inner states.
//
// A run that was going when the server stopped is marked "interrupted" — but
// only at the top. Every phase, step and target inside it was left saying
// "running", and the card draws a spinner for each one, so a run that died
// hours ago looks as if it is still working. That is worse than untidy: it
// invites waiting for something that will never finish.
//
// So anything still "running" anywhere in the record is settled as "error" —
// it did not finish — and the card's own banner says why. Anything "pending"
// is left alone: it never started, and saying so is accurate.
//
// Walked generically rather than field by field, so a state added to a job
// later is settled without anyone having to remember this file exists.
//
// Pure — mutates the object it is given and returns how many it settled.

const RUNNING = "running";
const SETTLED = "error";

export function settleRunning(value: unknown, depth = 0): number {
  if (depth > 12 || value === null || typeof value !== "object") return 0;
  let settled = 0;
  if (Array.isArray(value)) {
    for (const item of value) settled += settleRunning(item, depth + 1);
    return settled;
  }
  const obj = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    // A step's own state, and each entry of a phaseStates record. The job's
    // top-level `status` is deliberately not one of these: it is already set
    // to "interrupted" by the caller, which is the more useful word there.
    if (key === "state" && v === RUNNING) {
      obj[key] = SETTLED;
      settled += 1;
    } else if (key === "phaseStates" && v && typeof v === "object" && !Array.isArray(v)) {
      const states = v as Record<string, unknown>;
      for (const [phase, s] of Object.entries(states)) {
        if (s === RUNNING) {
          states[phase] = SETTLED;
          settled += 1;
        }
      }
    } else if (v && typeof v === "object") {
      settled += settleRunning(v, depth + 1);
    }
  }
  return settled;
}
