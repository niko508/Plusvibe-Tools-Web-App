// Variation label helpers, shared by the server (allocating letters on write)
// and the client (previewing which letters new variants will get). No
// server-only imports.

// The API validates variation labels against ^([A-Z]|[ABC][A-Z])$ — A..Z, then
// AA..AZ, BA..BZ, CA..CZ. That's 104 per step and a hard ceiling.
export const VARIATION_LABELS: string[] = (() => {
  const letters = Array.from({ length: 26 }, (_, i) =>
    String.fromCharCode(65 + i)
  );
  return [...letters, ...["A", "B", "C"].flatMap((p) => letters.map((l) => p + l))];
})();

export const MAX_VARIATIONS_PER_STEP = VARIATION_LABELS.length;

/** Picks the next unused variation labels, in order. */
export function nextVariationLabels(
  used: Iterable<string>,
  count: number
): string[] {
  const taken = new Set(Array.from(used, (l) => l.toUpperCase()));
  return VARIATION_LABELS.filter((l) => !taken.has(l)).slice(0, count);
}
