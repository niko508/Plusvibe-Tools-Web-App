// What to send in a chunk, and what to leave behind, before /lead/add is called.
//
// Plusvibe refuses a lead for reasons it reports only as COUNTS
// (duplicate_email_count, invalid_email_count …), never as which emails. The
// two commonest — a repeated address within the batch, and an address that
// isn't one — can be found here first, so the batch that goes out is one the
// API will accept whole, and the leads it would have refused are left in the
// source and named rather than lost in a count.
//
// Pure module — no API — so all of it is unit-tested.

export type UnmovedReason =
  /** Same address (ignoring case) as an earlier lead in the batch. */
  | "duplicate"
  /** Not an email address. */
  | "invalid-email"
  /** The API counted it out and said why in a counter, without naming it. */
  | "rejected"
  /** The plan's lead quota was hit. Movable later, once there is room. */
  | "overflow"
  /** Sent, but could not be confirmed in the destination, so left in the source. */
  | "not-confirmed"
  /** The add call itself failed for the whole chunk, twice. */
  | "add-failed";

export interface UnmovedLead {
  email: string;
  reason: UnmovedReason;
  detail?: string;
}

export const UNMOVED_LABELS: Record<UnmovedReason, string> = {
  duplicate: "duplicate address in the batch",
  "invalid-email": "not a valid email address",
  rejected: "refused by Plusvibe",
  overflow: "plan lead quota reached",
  "not-confirmed": "not confirmed in the destination",
  "add-failed": "the add call failed",
};

// Plusvibe's own rule, as it quotes it when it refuses a batch:
//
//   "leads[60].email" … fails to match the required pattern:
//   /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{1,}$/i
//
// The point is to catch what Plusvibe will refuse BEFORE sending, because it
// refuses the whole batch for one bad address — a single plus-addressed lead
// ("it+tag@x.com") used to take ninety-nine good ones down with it. So this
// matches Plusvibe exactly, strict or not, rather than what an email is.
const EMAIL_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{1,}$/i;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/**
 * The lead a refused batch names, if it names one.
 *
 * Plusvibe validates a batch as a whole and fails it on the first bad lead,
 * naming it by position — `"leads[60].email"`, or `leads>60>email` in the
 * path form. Knowing which lies at the heart of not losing the other 99: drop
 * that one and send the rest again. Null when the message names no lead, which
 * means the failure is about the batch rather than one of its leads.
 */
export function rejectedIndex(message: string): number | null {
  const m = /leads\[(\d+)\]/.exec(message) ?? /leads>(\d+)>/.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Splits a chunk into the leads worth sending and the ones to leave behind. */
export function prepareChunk<T extends { email: string }>(
  chunk: T[]
): { send: T[]; unmoved: UnmovedLead[] } {
  const seen = new Set<string>();
  const send: T[] = [];
  const unmoved: UnmovedLead[] = [];
  for (const lead of chunk) {
    const email = lead.email.trim();
    if (!isValidEmail(email)) {
      unmoved.push({ email: lead.email, reason: "invalid-email" });
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      unmoved.push({ email: lead.email, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    send.push(lead);
  }
  return { send, unmoved };
}

/** The counters /lead/add answers with. Anything missing reads as zero. */
export interface AddCounts {
  uploaded: number;
  alreadyThere: number;
  duplicate: number;
  invalid: number;
  skipped: number;
  overflow: number;
  totalSent: number;
}

export function readAddCounts(raw: Record<string, unknown> | null | undefined): AddCounts {
  const n = (v: unknown) => {
    const x = typeof v === "number" ? v : Number(String(v ?? "").trim());
    return Number.isFinite(x) ? x : 0;
  };
  const r = raw ?? {};
  return {
    uploaded: n(r.leads_uploaded),
    alreadyThere: n(r.already_in_campaign),
    duplicate: n(r.duplicate_email_count),
    invalid: n(r.invalid_email_count),
    skipped: n(r.skipped),
    overflow: n(r.overflowed_lead_count),
    totalSent: n(r.total_sent),
  };
}

/**
 * Whether the counters explain every lead that was sent.
 *
 * "Landed" is what is now in the destination; "refused" is what the API says
 * it turned away. When the two sum to the batch, the batch can be settled from
 * the counts alone — provided nothing was refused, since the API does not say
 * WHICH ones. Anything else calls for confirming lead by lead.
 */
export function accountFor(sent: number, c: AddCounts): {
  landed: number;
  refused: number;
  /** True when landed === sent: every lead is in the destination. */
  complete: boolean;
  /** True when the plan quota turned leads away; more chunks will do the same. */
  quotaHit: boolean;
} {
  const landed = c.uploaded + c.alreadyThere;
  const refused = c.duplicate + c.invalid + c.skipped + c.overflow;
  return { landed, refused, complete: landed >= sent, quotaHit: c.overflow > 0 };
}

/** "3 could not be moved: 2 duplicate address in the batch, 1 not a valid email address" */
export function describeUnmoved(unmoved: UnmovedLead[]): string {
  if (unmoved.length === 0) return "";
  const by = new Map<UnmovedReason, number>();
  for (const u of unmoved) by.set(u.reason, (by.get(u.reason) ?? 0) + 1);
  const parts = [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${UNMOVED_LABELS[reason]}`);
  return `${unmoved.length} could not be moved: ${parts.join(", ")}`;
}
