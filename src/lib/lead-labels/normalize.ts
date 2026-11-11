/**
 * Comparable form of a lead label name.
 *
 * Emoji, punctuation and case are all cosmetic here — "🤩 positive reply 1",
 * "Positive Reply 1" and "positive-reply-1" are the same label to a human, and
 * a workspace set up by hand will have drifted in exactly those ways. Anything
 * that isn't a letter or a digit becomes a single space.
 *
 * The words themselves are kept intact, so distinct labels ("meeting booked"
 * vs "meeting booked - cell phone call") never collapse into each other.
 *
 * Lives on its own because two features need the same rule: the first-campaign
 * blueprint matching its labels against a workspace, and the bulk "Add Custom
 * Label" action spotting a workspace that already has one.
 */
export function normalizeLabelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** One label as a workspace reports it. */
export interface WorkspaceLabel {
  key: string;
  name: string;
  isSystem?: boolean;
}
