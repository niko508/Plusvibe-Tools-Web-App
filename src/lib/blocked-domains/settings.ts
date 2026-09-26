import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
  DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO,
  DEFAULT_MIN_REPLY_RATE_OOO,
  normalizeThreshold,
} from "@/lib/blocked-domains/performance";
import { DEFAULT_RULES, normalizeRules, type InboxRules } from "@/lib/blocked-inboxes/rules";
import {
  DEFAULT_RECHECK_DAYS,
  MAX_RECHECK_DAYS,
  normalizeRecheckDays,
} from "@/lib/blocked-domains/recheck";

// The one setting the Blocked Domains automation has: whether a blocked domain
// is deleted on arrival, or quarantined and left for someone to confirm.
//
// Stored on the volume rather than in localStorage because the webhook runs
// with no browser involved — the server has to be able to read the answer at
// 3am. Off by default: the first runs should be watched.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const STORE_DIR = path.join(JOBS_BASE, "blocked-domains");
const FILE = path.join(STORE_DIR, "settings.json");

export interface BlockedDomainSettings {
  /**
   * When true a blocked domain goes straight through to deletion. When false
   * the inboxes are still quarantined immediately — sending and warmup stop —
   * but nothing is deleted until someone confirms in the UI.
   */
  autoDelete: boolean;
  /**
   * When true the domain's inboxes are judged on their last 7 days first, and
   * only the ones under the bar are stopped. Off means every inbox on the
   * domain is stopped, which is what the automation did before.
   */
  checkPerformance: boolean;
  /**
   * The INBOX bar, in percent, on reply rate with OOO. An inbox under it has
   * its daily limit set to 0 and its warmup switched off — whatever the domain
   * as a whole is doing.
   */
  minReplyRateOoo: number;
  /**
   * The DOMAIN bar. Under it, the domain goes Not Active in the sheet and its
   * tenant is queued for cancellation; at or above it, the sheet and the
   * tenant are left alone.
   */
  minDomainReplyRateOoo: number;
  /**
   * Whether a flagged domain is checked again on a schedule. A blocked domain
   * usually keeps declining, so the same assessment is repeated until there is
   * nothing left to watch.
   */
  recheck: boolean;
  /** How often the repeat check runs, in days. */
  recheckDays: number;
  /** The tiers each sender inbox is judged on, per provider. */
  inboxRules: InboxRules;
  /**
   * A Microsoft domain is cancelled once MORE than this many of its inboxes
   * have been deleted by the rules.
   */
  cancelAfterDeleted: number;
  /**
   * At cancellation, an inbox is kept when its OOO reply rate over the last
   * 14 days is at least this, in percent.
   */
  cancelKeepReplyRate: number;
  updatedAt: number;
}

export { DEFAULT_RECHECK_DAYS, MAX_RECHECK_DAYS, normalizeRecheckDays };

export const DEFAULT_CANCEL_AFTER = 13;
export const DEFAULT_CANCEL_KEEP_RATE = 1;
export const MAX_CANCEL_AFTER = 500;

export function normalizeCancelAfter(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_CANCEL_AFTER ? n : DEFAULT_CANCEL_AFTER;
}

export function normalizeKeepRate(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_CANCEL_KEEP_RATE;
}

export const DEFAULT_SETTINGS: BlockedDomainSettings = {
  autoDelete: false,
  checkPerformance: true,
  minReplyRateOoo: DEFAULT_MIN_REPLY_RATE_OOO,
  minDomainReplyRateOoo: DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO,
  recheck: true,
  recheckDays: DEFAULT_RECHECK_DAYS,
  inboxRules: DEFAULT_RULES,
  cancelAfterDeleted: DEFAULT_CANCEL_AFTER,
  cancelKeepReplyRate: DEFAULT_CANCEL_KEEP_RATE,
  updatedAt: 0,
};

export async function loadSettings(): Promise<BlockedDomainSettings> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<BlockedDomainSettings>;
    return {
      // Anything other than a literal true is off. A corrupt or half-written
      // file must not be what turns unattended deletion on.
      autoDelete: parsed.autoDelete === true,
      // The check is the safer behaviour for the client's inboxes, so it is on
      // unless the file explicitly says otherwise — including for the settings
      // files written before it existed.
      checkPerformance: parsed.checkPerformance !== false,
      minReplyRateOoo: normalizeThreshold(parsed.minReplyRateOoo, DEFAULT_MIN_REPLY_RATE_OOO),
      minDomainReplyRateOoo: normalizeThreshold(
        parsed.minDomainReplyRateOoo,
        DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO
      ),
      recheck: parsed.recheck !== false,
      recheckDays: normalizeRecheckDays(parsed.recheckDays),
      // A file with no rules, or rules that don't read, judges on the
      // defaults rather than on nothing.
      inboxRules: parsed.inboxRules === undefined ? DEFAULT_RULES : normalizeRules(parsed.inboxRules),
      cancelAfterDeleted: normalizeCancelAfter(parsed.cancelAfterDeleted ?? DEFAULT_CANCEL_AFTER),
      cancelKeepReplyRate: normalizeKeepRate(parsed.cancelKeepReplyRate ?? DEFAULT_CANCEL_KEEP_RATE),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(
  patch: Partial<
    Pick<
      BlockedDomainSettings,
      | "autoDelete"
      | "checkPerformance"
      | "minReplyRateOoo"
      | "minDomainReplyRateOoo"
      | "recheck"
      | "recheckDays"
      | "inboxRules"
      | "cancelAfterDeleted"
      | "cancelKeepReplyRate"
    >
  >
): Promise<BlockedDomainSettings> {
  const current = await loadSettings();
  const next: BlockedDomainSettings = {
    autoDelete: patch.autoDelete === undefined ? current.autoDelete : patch.autoDelete === true,
    checkPerformance:
      patch.checkPerformance === undefined ? current.checkPerformance : patch.checkPerformance === true,
    minReplyRateOoo:
      patch.minReplyRateOoo === undefined
        ? current.minReplyRateOoo
        : normalizeThreshold(patch.minReplyRateOoo, DEFAULT_MIN_REPLY_RATE_OOO),
    minDomainReplyRateOoo:
      patch.minDomainReplyRateOoo === undefined
        ? current.minDomainReplyRateOoo
        : normalizeThreshold(patch.minDomainReplyRateOoo, DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO),
    recheck: patch.recheck === undefined ? current.recheck : patch.recheck === true,
    recheckDays:
      patch.recheckDays === undefined ? current.recheckDays : normalizeRecheckDays(patch.recheckDays),
    inboxRules: patch.inboxRules === undefined ? current.inboxRules : normalizeRules(patch.inboxRules),
    cancelAfterDeleted:
      patch.cancelAfterDeleted === undefined ? current.cancelAfterDeleted : normalizeCancelAfter(patch.cancelAfterDeleted),
    cancelKeepReplyRate:
      patch.cancelKeepReplyRate === undefined ? current.cancelKeepReplyRate : normalizeKeepRate(patch.cancelKeepReplyRate),
    updatedAt: Date.now(),
  };
  await fs.mkdir(STORE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next), "utf8");
  await fs.rename(tmp, FILE);
  return next;
}
