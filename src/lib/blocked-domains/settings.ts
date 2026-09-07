import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
  DEFAULT_MIN_REPLY_RATE_OOO,
  normalizeThreshold,
} from "@/lib/blocked-domains/performance";

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
  /** The bar, in percent, on reply rate with OOO. */
  minReplyRateOoo: number;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: BlockedDomainSettings = {
  autoDelete: false,
  checkPerformance: true,
  minReplyRateOoo: DEFAULT_MIN_REPLY_RATE_OOO,
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
      minReplyRateOoo: normalizeThreshold(
        parsed.minReplyRateOoo ?? DEFAULT_MIN_REPLY_RATE_OOO
      ),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(
  patch: Partial<Pick<BlockedDomainSettings, "autoDelete" | "checkPerformance" | "minReplyRateOoo">>
): Promise<BlockedDomainSettings> {
  const current = await loadSettings();
  const next: BlockedDomainSettings = {
    autoDelete: patch.autoDelete === undefined ? current.autoDelete : patch.autoDelete === true,
    checkPerformance:
      patch.checkPerformance === undefined ? current.checkPerformance : patch.checkPerformance === true,
    minReplyRateOoo:
      patch.minReplyRateOoo === undefined ? current.minReplyRateOoo : normalizeThreshold(patch.minReplyRateOoo),
    updatedAt: Date.now(),
  };
  await fs.mkdir(STORE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next), "utf8");
  await fs.rename(tmp, FILE);
  return next;
}
