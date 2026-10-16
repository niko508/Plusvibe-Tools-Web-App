import "server-only";

import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path from "path";

// Where job records live, and whether that place survives a redeploy.
//
// Railway replaces the container on every deploy. A directory on the
// container's own disk goes with it — every record of which domains have been
// handled, every schedule, every run — unless JOBS_DIR points inside a mounted
// volume. Setting the variable is not enough on its own; the volume has to be
// there too, and the two are configured on different screens, so the app
// checks for itself rather than trusting either.

export interface JobStorageInfo {
  /** The base directory records are written under. */
  dir: string;
  /** True when JOBS_DIR was set, rather than the default next to the code. */
  configured: boolean;
  /**
   * True when the directory sits on a filesystem other than the one the code
   * runs from, which is what a mounted volume looks like from inside the
   * container. Null when it could not be determined.
   */
  onVolume: boolean | null;
  /** The mount point it was matched to, when one was found. */
  mountPoint?: string;
}

/** The base directory, exactly as the job managers compute it. */
export function jobsBaseDir(): string {
  return process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
}

/**
 * Mount points from /proc/mounts, longest first, so the most specific one
 * matches. Empty where there is no /proc (a Mac in development).
 */
function mountPoints(): string[] {
  try {
    return readFileSync("/proc/mounts", "utf8")
      .split("\n")
      .map((line) => line.split(" ")[1])
      .filter((m): m is string => !!m && m !== "/")
      .map((m) => m.replace(/\\040/g, " "))
      .sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

export function jobStorageInfo(): JobStorageInfo {
  const dir = path.resolve(jobsBaseDir());
  const configured = !!process.env.JOBS_DIR;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return { dir, configured, onVolume: null };
  }

  // A mount point that contains the directory is the direct answer.
  const under = mountPoints().find((m) => dir === m || dir.startsWith(m + path.sep));
  if (under) return { dir, configured, onVolume: true, mountPoint: under };

  // Otherwise compare filesystems: a different device from the code's own
  // directory means the records are not on the container disk.
  try {
    const here = statSync(process.cwd()).dev;
    const there = statSync(dir).dev;
    return { dir, configured, onVolume: here !== there };
  } catch {
    return { dir, configured, onVolume: null };
  }
}
