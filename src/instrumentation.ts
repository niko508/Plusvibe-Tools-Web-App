// Runs once when the Next.js server boots.
//
// Two schedulers have to be running whether or not anyone opens the app, and
// on Railway the process is replaced on every deploy:
//
//   Pause Campaigns   a resume can be due days after the pause
//   Blocked Domains   a flagged domain is re-assessed every 7 days
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
  }
}
