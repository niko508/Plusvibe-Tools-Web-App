// Which section a handled domain belongs in: the "New Blocked Domains" list at
// the top, or the history below it.
//
// The top section is for domains with something still to decide. Once someone
// has dealt with a domain's stopped inboxes — deleted them, or chosen to keep
// them — it drops into the history, even if the automation is still watching
// it. It comes back to the top only when a later check stops something NEW,
// which is exactly the moment there is a fresh decision to make.
//
// Pure module — no API, no clock — so all of it is unit-tested.

/** The parts of a record this decision reads. */
export interface Triageable {
  status: string;
  createdAt: number;
  inboxesFound: number;
  quarantinedEmails?: string[];
  performance?: { inboxes: { decision: string }[] };
  /** When the automation last stopped one or more inboxes. */
  lastStoppedAt?: number;
  /** When a person last dealt with the stopped inboxes. */
  handledAt?: number;
}

/**
 * Inboxes this run has stopped and not yet deleted — exactly what the card's
 * "Delete N stopped inboxes" button would take, worked out the same way.
 */
export function stoppedCount(job: Triageable): number {
  if (job.quarantinedEmails) return job.quarantinedEmails.length;
  const perf = job.performance;
  if (perf) return perf.inboxes.filter((i) => i.decision === "stop").length;
  return job.inboxesFound;
}

/**
 * True when a person still has something to decide on this domain.
 *
 * A deletion waiting for confirmation always counts. Otherwise it is "there
 * are stopped inboxes, and nobody has dealt with them since they were
 * stopped". A record from before these timestamps existed has neither, so it
 * behaves as it always did: stopped inboxes mean it is waiting on you.
 */
export function needsYou(job: Triageable): boolean {
  if (job.status === "awaiting_confirmation") return true;
  if (job.status === "working" || job.status === "deleting") return false;
  if (stoppedCount(job) === 0) return false;
  if (!job.handledAt) return true;
  // Stopped again since it was dealt with — a new decision, so back to the top.
  return (job.lastStoppedAt ?? job.createdAt) > job.handledAt;
}
