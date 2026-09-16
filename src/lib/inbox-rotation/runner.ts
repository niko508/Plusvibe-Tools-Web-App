import "server-only";

import { PROFILES, type ProfileKey, type WorkspaceRotation } from "./settings";
import { ensurePicks, positionOn, todayIn, type Position, type Timeline } from "./schedule";
import { buildInventory, profilesPresent, settingsFor } from "./inventory";
import { fetchAllInboxes, findGroupTags, writeSettings } from "./api";
import { loadRotations, loadSettings, updateRotation } from "./store";

// Applies a rotation: reads what is in the workspace, works out which group
// each profile has sending today, and writes the settings — the stage's to
// the sending group, the resting ones to the other. A segment already written
// is not written again, so the ten-minute check is idle until a switch day.
//
// Two ways in: the scheduler, with the server's key, so a switch at midnight
// happens with nobody watching; and "Apply now" from the page, with the
// browser's key. One run per rotation at a time.

const TICK_MS = Number(process.env.INBOX_ROTATION_TICK_MS ?? "") || 10 * 60 * 1000;
const running = new Set<string>();

export function serverApiKey(): string | null {
  return process.env.PLUSVIBE_API_KEY?.trim() || null;
}

/** Where each profile stands on a day, drawing maintaining picks as needed. */
export async function positionsFor(
  rec: WorkspaceRotation,
  day: string
): Promise<{ positions: Partial<Record<ProfileKey, Position>>; rec: WorkspaceRotation }> {
  const settings = await loadSettings();
  const positions: Partial<Record<ProfileKey, Position>> = {};
  let current = rec;
  for (const { key } of PROFILES) {
    const tl: Timeline = {
      profile: settings.profiles[key],
      startDate: current.startDate,
      startingGroup: current.startingGroup,
      stage: current.stage,
      picks: current.picks[key] ?? [],
    };
    const picks = ensurePicks(day, tl);
    if (picks !== tl.picks) {
      const updated = await updateRotation(current.id, (r) => ({ ...r, picks: { ...r.picks, [key]: picks } }));
      if (updated) current = updated;
    }
    positions[key] = positionOn(day, { ...tl, picks });
  }
  return { positions, rec: current };
}

export async function applyRotation(
  id: string,
  apiKey: string,
  opts: { trigger: "setup" | "manual" | "scheduled"; asOf?: string; force?: boolean }
): Promise<WorkspaceRotation | null> {
  if (running.has(id)) return (await loadRotations()).find((r) => r.id === id) ?? null;
  running.add(id);
  const day = opts.asOf ?? todayIn();
  const errors: string[] = [];
  let updated = 0;
  try {
    let rec = (await loadRotations()).find((r) => r.id === id);
    if (!rec) return null;
    rec =
      (await updateRotation(id, (r) => ({
        ...r,
        lastRun: { startedAt: Date.now(), day, updated: 0, errors: [], trigger: opts.trigger },
      }))) ?? rec;

    const settings = await loadSettings();
    const tagIds = await findGroupTags(apiKey, rec.workspaceId);
    const inboxes = await fetchAllInboxes(apiKey, rec.workspaceId);
    const { inventory, ids } = buildInventory(inboxes, tagIds);
    rec = (await updateRotation(id, (r) => ({ ...r, inventory }))) ?? rec;
    if (inventory.tagsFound.length === 0) {
      errors.push("Neither Sending Group tag exists in this workspace, so there is nothing to rotate.");
    }

    const { positions, rec: withPicks } = await positionsFor(rec, day);
    rec = withPicks;

    for (const key of profilesPresent(inventory)) {
      const pos = positions[key];
      if (!pos || pos.kind !== "segment") continue;
      const seg = pos.segment;
      const already = rec.applied[key];
      if (!opts.force && already && already.start === seg.start && already.group === seg.group) continue;
      const profile = settings.profiles[key];
      const label = PROFILES.find((p) => p.key === key)?.label ?? key;
      for (const g of [1, 2] as const) {
        const targets = ids[g][key];
        if (targets.length === 0) continue;
        const sending = g === seg.group;
        updated += await writeSettings(apiKey, rec.workspaceId, targets, settingsFor(profile, seg.stage, sending), (n, message) =>
          errors.push(`${label} · Sending Group ${g}: ${n} inbox${n === 1 ? "" : "es"} not ${sending ? "set to send" : "rested"}: ${message}`)
        );
      }
      rec =
        (await updateRotation(id, (r) => ({
          ...r,
          applied: { ...r.applied, [key]: { start: seg.start, end: seg.end, group: seg.group, stage: seg.stage, at: Date.now() } },
        }))) ?? rec;
    }
    return (
      (await updateRotation(id, (r) => ({
        ...r,
        lastRun: { ...(r.lastRun ?? { startedAt: Date.now(), day, trigger: opts.trigger }), finishedAt: Date.now(), day, updated, errors },
      }))) ?? rec
    );
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "failed");
    return await updateRotation(id, (r) => ({
      ...r,
      lastRun: { ...(r.lastRun ?? { startedAt: Date.now(), day, trigger: opts.trigger }), finishedAt: Date.now(), day, updated, errors },
    }));
  } finally {
    running.delete(id);
  }
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

// --- Scheduler ------------------------------------------------------------------

let schedulerStarted = false;

async function tick() {
  const key = serverApiKey();
  if (!key) return;
  for (const rec of await loadRotations()) {
    await applyRotation(rec.id, key, { trigger: "scheduled" });
  }
}

/** Starts the check that applies each day's switch. Idempotent. */
export function bootScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();
}
