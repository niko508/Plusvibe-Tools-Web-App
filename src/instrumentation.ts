// Runs once when the Next.js server boots.
//
// Two schedulers have to be running whether or not anyone opens the app, and
// on Railway the process is replaced on every deploy:
//
//   Pause Campaigns   a resume can be due days after the pause
//   Blocked Domains   a flagged domain is re-assessed every 7 days
//   Start Outreach    a batch's week 2 settings land a week after it started
//
// Starting them here — rather than lazily on the first request — means a
// restart with nobody looking still fires on time.
//
// Both imports stay INSIDE the runtime check. Next.js compiles this file for
// the edge runtime as well, and these modules read the volume with `fs`, which
// edge has no notion of.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootScheduler } = await import("@/lib/jobs/pause-campaigns");
    await bootScheduler();

    const blocked = await import("@/lib/jobs/blocked-domains");
    await blocked.bootScheduler();

    // Inbox Rotation: a group switch falls at midnight, with nobody watching.
    const rotation = await import("@/lib/inbox-rotation/runner");
    rotation.bootScheduler();

    // Start Outreach: a batch moves onto its week 2 settings seven days later,
    // at six in the morning Helsinki time.
    const outreach = await import("@/lib/jobs/outreach-schedule");
    outreach.bootScheduler();

    // Create All Campaign Types: a run a deploy cut off is picked up again,
    // finishing the split it had started.
    const campaignTypes = await import("@/lib/jobs/campaign-types");
    void campaignTypes.bootResume().catch(() => undefined);
  }
}
