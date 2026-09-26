import { isExcludedWorkspace } from "@/lib/general-settings/settings";

// Workspaces left out of the Remove Inboxes scope by default: the list in
// General Settings (Workspaces). The user can still re-check them.
export function isDefaultExcluded(name: string): boolean {
  return isExcludedWorkspace(name);
}
