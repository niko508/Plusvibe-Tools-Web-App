// Runs once when the Next.js server boots.
//
// The Pause Campaigns scheduler has to be running whether or not anyone opens
// the app: a resume can be due days after the pause, and on Railway the process
// is replaced on every deploy. Starting it here — rather than lazily on the
// first request — means a restart with nobody looking still fires on time.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootScheduler } = await import("@/lib/jobs/pause-campaigns");
    await bootScheduler();
  }
}
