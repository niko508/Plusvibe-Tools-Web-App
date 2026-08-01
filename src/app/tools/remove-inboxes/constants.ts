// Workspaces excluded from the Remove Inboxes scope by default (lowercased,
// trimmed for case-insensitive matching). The user can still re-check them.
export const DEFAULT_EXCLUDED_WORKSPACES = [
  "ikoni digital lead nurturing + duplicate workspace",
  "inbox warmup",
];

export function isDefaultExcluded(name: string): boolean {
  return DEFAULT_EXCLUDED_WORKSPACES.includes(name.trim().toLowerCase());
}
