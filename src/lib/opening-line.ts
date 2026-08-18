// Transforms for the "Remove Personalized Opening Line" tool. Shared by the
// server route (which applies them) and the preview (which is the same code
// path run as a dry run), so what you see is exactly what gets written.

// A subject wrapped in the personalized-opening-line fallback:
//   {{fallback| {{subject_line}} | {{Random | … }}}}
// Unwrapping keeps the inner spintax and drops the wrapper's trailing }}.
// Whitespace is tolerated everywhere the editor might have introduced it.
const SUBJECT_FALLBACK_RE =
  /^\s*\{\{\s*fallback\s*\|\s*\{\{\s*subject_line\s*\}\}\s*\|\s*([\s\S]*)\}\}\s*$/;

export interface StripResult {
  result: string;
  changed: boolean;
}

/**
 * Removes the `{{fallback| {{subject_line}} | … }}` wrapper from a subject,
 * leaving the inner spintax. Returns the subject untouched when it isn't
 * wrapped, so running the tool twice is a no-op.
 */
export function stripSubjectFallback(subject: string): StripResult {
  const raw = subject ?? "";
  const m = SUBJECT_FALLBACK_RE.exec(raw);
  if (!m) return { result: raw, changed: false };
  const inner = m[1].trim();
  if (!inner) return { result: raw, changed: false };
  return { result: inner, changed: inner !== raw };
}

// `{{opening_line}}` plus any whitespace/&nbsp; immediately before it, so the
// greeting doesn't keep a dangling space once the variable is gone.
const OPENING_LINE_RE = /(?:&nbsp;|\s)*\{\{\s*opening_line\s*\}\}/gi;

// A block left completely empty by the removal (an opening line that had its
// own paragraph). `<div>&nbsp;</div>` spacers still have content and survive.
const EMPTY_BLOCK_RE = /<(div|p)>\s*<\/\1>/gi;

export interface StripBodyResult extends StripResult {
  removed: number;
}

/**
 * Removes every `{{opening_line}}` from a body, tidying up whitespace and any
 * block the removal emptied. Idempotent — a body with none is left alone.
 */
export function stripOpeningLine(body: string): StripBodyResult {
  const raw = body ?? "";
  const matches = raw.match(OPENING_LINE_RE);
  if (!matches || matches.length === 0) {
    return { result: raw, changed: false, removed: 0 };
  }
  const result = raw.replace(OPENING_LINE_RE, "").replace(EMPTY_BLOCK_RE, "");
  return { result, changed: result !== raw, removed: matches.length };
}

/** True when a campaign body still references the personalized opening line. */
export function hasOpeningLine(body: string): boolean {
  OPENING_LINE_RE.lastIndex = 0;
  return /\{\{\s*opening_line\s*\}\}/i.test(body ?? "");
}
