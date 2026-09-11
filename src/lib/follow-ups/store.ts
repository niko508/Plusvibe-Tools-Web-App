import "server-only";

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_FOLLOW_UP_TEMPLATES } from "./default-templates";
import type { FollowUpTemplate } from "./templates";

// Persistent store for the follow-up template library.
//
// Kept server-side rather than in localStorage: the library is curated copy
// worth real effort, and browser storage loses it on a cleared cache and never
// follows you to another machine. Scoped by API-key fingerprint like the job
// stores, so one key never sees another's templates. The key itself is never
// written to disk.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const STORE_DIR = path.join(JOBS_BASE, "follow-up-templates");

/** Guards against a runaway paste filling the volume. */
export const MAX_TEMPLATES = 200;
export const MAX_TEMPLATE_CHARS = 20_000;

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function fileFor(apiKey: string): string {
  return path.join(STORE_DIR, `${fingerprintKey(apiKey)}.json`);
}

function seeded(): FollowUpTemplate[] {
  return DEFAULT_FOLLOW_UP_TEMPLATES.map((body, i) => ({
    id: `seed-${i + 1}`,
    body,
  }));
}

/**
 * Reads the library, seeding the starter templates the first time.
 *
 * A corrupt or unreadable file falls back to the seed rather than throwing —
 * losing the library is bad, but a tool that won't open at all is worse, and
 * the next save overwrites cleanly.
 */
export async function loadTemplates(apiKey: string): Promise<{
  templates: FollowUpTemplate[];
  seeded: boolean;
}> {
  try {
    const raw = await fs.readFile(fileFor(apiKey), "utf8");
    const parsed = JSON.parse(raw) as { templates?: unknown };
    const list = Array.isArray(parsed.templates) ? parsed.templates : [];
    const templates = list
      .map((t, i) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          id: typeof o.id === "string" && o.id ? o.id : `t${i + 1}`,
          body: typeof o.body === "string" ? o.body : "",
        };
      })
      .filter((t) => t.body.trim());
    // An empty stored library is a real state (everything deleted), so it is
    // NOT re-seeded — that would resurrect templates the user removed.
    return { templates, seeded: false };
  } catch {
    return { templates: seeded(), seeded: true };
  }
}

export class TemplateValidationError extends Error {}

export async function saveTemplates(
  apiKey: string,
  templates: FollowUpTemplate[]
): Promise<FollowUpTemplate[]> {
  if (templates.length > MAX_TEMPLATES) {
    throw new TemplateValidationError(
      `Too many templates (${templates.length}); the limit is ${MAX_TEMPLATES}.`
    );
  }
  const clean = templates
    .map((t, i) => ({
      id: String(t.id || `t${i + 1}`),
      body: String(t.body ?? ""),
    }))
    .filter((t) => t.body.trim());

  const oversized = clean.findIndex((t) => t.body.length > MAX_TEMPLATE_CHARS);
  if (oversized >= 0) {
    throw new TemplateValidationError(
      `Template ${oversized + 1} is ${clean[oversized].body.length} characters; the limit is ${MAX_TEMPLATE_CHARS}.`
    );
  }

  await fs.mkdir(STORE_DIR, { recursive: true });
  // Write to a temp file and rename, so an interrupted write can't leave the
  // library truncated — a half-written JSON file would read back as corrupt.
  const target = fileFor(apiKey);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ templates: clean }), "utf8");
  await fs.rename(tmp, target);
  return clean;
}
