// Editing one part of an email across every variation of a step.
//
// Two kinds of edit:
//
//  - replace-text: find a sentence, phrase or variable and replace it wherever
//    it appears, in the subject, the body, or both.
//  - set-section: replace a whole section by position — the subject line, the
//    opening paragraph, or the closing paragraph (sign-off / signature).
//
// Bodies are HTML in Plusvibe's editor shape: paragraphs are <div>s, blank
// lines are <div>&nbsp;</div> spacers, and text carries entities (&nbsp;,
// &#39;, &amp;). A person types "Hi John, how's it going" — the stored body may
// hold "Hi John,&nbsp;how&#39;s it going" or split it across a <span>. Matching
// literally against the HTML would miss most of those, so matching happens
// against a decoded, whitespace-collapsed VIEW of the text that maps every
// character back to its position in the raw HTML. The replacement is then
// spliced into the raw HTML at exactly those positions; everything around it
// is untouched.
//
// Pure module: no API calls, so every rule here is unit-tested.

export type ReplaceTarget = "subject" | "body" | "both";
export type Section = "subject" | "opening" | "closing";

export type CopyEdit =
  | {
      kind: "replace-text";
      find: string;
      replace: string;
      target: ReplaceTarget;
      caseSensitive: boolean;
    }
  | {
      kind: "set-section";
      section: Section;
      text: string;
      /** Treat `text` as HTML rather than escaping it. Body sections only. */
      asHtml?: boolean;
    };

export interface VariationCopy {
  variation: string;
  subject: string;
  body: string;
}

export interface VariationEditResult extends VariationCopy {
  changed: boolean;
  /** Matches replaced, for replace-text. */
  subjectMatches: number;
  bodyMatches: number;
  /** Why nothing changed, when nothing did. */
  reason?: string;
}

// --- HTML view ---------------------------------------------------------------

/** One character of the decoded view and the raw range it came from. */
interface ViewChar {
  ch: string;
  start: number;
  end: number;
  /** A block boundary — never matchable, so a match can't cross paragraphs. */
  sep?: boolean;
}

const BLOCK_TAG = /^<\/?(div|p|br|li|ul|ol|table|tbody|tr|td|th|h[1-6]|blockquote|hr)\b/i;
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntity(raw: string): string | null {
  const m = /^&(#x([0-9a-f]+)|#(\d+)|([a-z]+));$/i.exec(raw);
  if (!m) return null;
  if (m[2]) return String.fromCodePoint(parseInt(m[2], 16));
  if (m[3]) return String.fromCodePoint(parseInt(m[3], 10));
  const named = NAMED_ENTITIES[m[4].toLowerCase()];
  return named ?? null;
}

/**
 * Builds the matchable view of a string.
 *
 * `html: true` skips tags (block tags become separators) and decodes entities.
 * `html: false` treats the whole string as text — for subject lines. Either
 * way, runs of whitespace collapse to a single space that maps back to the
 * whole run, so "Hi  John" and "Hi John" match each other.
 */
function buildView(raw: string, html: boolean): ViewChar[] {
  const out: ViewChar[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (html && c === "<") {
      const close = raw.indexOf(">", i);
      if (close === -1) {
        out.push({ ch: c, start: i, end: i + 1 });
        i += 1;
        continue;
      }
      const tag = raw.slice(i, close + 1);
      if (BLOCK_TAG.test(tag)) out.push({ ch: "\n", start: i, end: close + 1, sep: true });
      i = close + 1;
      continue;
    }
    if (html && c === "&") {
      const semi = raw.indexOf(";", i);
      if (semi !== -1 && semi - i <= 10) {
        const decoded = decodeEntity(raw.slice(i, semi + 1));
        if (decoded !== null) {
          out.push({ ch: decoded, start: i, end: semi + 1 });
          i = semi + 1;
          continue;
        }
      }
    }
    out.push({ ch: c, start: i, end: i + 1 });
    i += 1;
  }

  // Collapse whitespace runs (never across a separator, which stays as-is).
  const collapsed: ViewChar[] = [];
  for (const vc of out) {
    const prev = collapsed[collapsed.length - 1];
    const isWs = !vc.sep && /\s/.test(vc.ch);
    if (isWs && prev && !prev.sep && prev.ch === " ") {
      prev.end = vc.end;
      continue;
    }
    collapsed.push(isWs ? { ...vc, ch: " " } : vc);
  }
  return collapsed;
}

/** What the user typed, made comparable to the view. */
export function normalizeFind(find: string): string {
  return find.replace(/\s+/g, " ").trim();
}

function charEq(a: string, b: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return a === b;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** Non-overlapping [start, end) match ranges in the view, left to right. */
function findMatches(view: ViewChar[], find: string, caseSensitive: boolean): [number, number][] {
  const out: [number, number][] = [];
  if (find.length === 0) return out;
  let i = 0;
  while (i + find.length <= view.length) {
    let ok = true;
    for (let k = 0; k < find.length; k++) {
      const vc = view[i + k];
      if (vc.sep || !charEq(vc.ch, find[k], caseSensitive)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push([i, i + find.length]);
      i += find.length;
    } else {
      i += 1;
    }
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replaces every occurrence of `find` in `raw`, tolerant of entities,
 * whitespace and inline tags. Returns the new string and how many matches
 * were replaced.
 *
 * A match may span inline tags (<span>, <b>, <a>), in which case those tags
 * are dropped along with the matched text — the replacement is plain. A match
 * never spans a block boundary (<div>, <p>, <br>), so a sentence that runs
 * onto a new line is not matched.
 */
export function replaceText(
  raw: string,
  find: string,
  replace: string,
  opts: { html: boolean; caseSensitive: boolean }
): { text: string; matches: number } {
  const needle = normalizeFind(find);
  if (!needle) return { text: raw, matches: 0 };
  const view = buildView(raw, opts.html);
  const matches = findMatches(view, needle, opts.caseSensitive);
  if (matches.length === 0) return { text: raw, matches: 0 };

  const rep = opts.html ? escapeHtml(replace).replace(/\r?\n/g, "<br>") : replace;
  let text = raw;
  // Right to left, so earlier raw offsets stay valid.
  for (let m = matches.length - 1; m >= 0; m--) {
    const [s, e] = matches[m];
    const rawStart = view[s].start;
    const rawEnd = view[e - 1].end;
    text = text.slice(0, rawStart) + rep + text.slice(rawEnd);
  }
  return { text, matches: matches.length };
}

// --- Paragraph sections ------------------------------------------------------

interface Block {
  start: number;
  end: number;
  raw: string;
  /** Blank line: a block holding no text (typically <div>&nbsp;</div>). */
  spacer: boolean;
}

/** Plain text of a fragment: tags become line breaks where they mean one. */
export function blockText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|h[1-6])>\s*<(div|p|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}

/**
 * Splits a body into top-level blocks: each <div>…</div> or <p>…</p> at the
 * outermost level, and any loose text between them.
 */
export function splitBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const openRe = /<(div|p)\b[^>]*>/gi;
  let pos = 0;

  const pushLoose = (start: number, end: number) => {
    const raw = html.slice(start, end);
    if (raw.trim() === "") return;
    blocks.push({ start, end, raw, spacer: blockText(raw) === "" });
  };

  while (pos < html.length) {
    openRe.lastIndex = pos;
    const open = openRe.exec(html);
    if (!open) {
      pushLoose(pos, html.length);
      break;
    }
    if (open.index > pos) pushLoose(pos, open.index);

    // Find the matching close for this tag name, counting nesting.
    const name = open[1].toLowerCase();
    const pair = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
    pair.lastIndex = open.index + open[0].length;
    let depth = 1;
    let end = html.length;
    let m: RegExpExecArray | null;
    while ((m = pair.exec(html))) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    const raw = html.slice(open.index, end);
    blocks.push({ start: open.index, end, raw, spacer: blockText(raw) === "" });
    pos = end;
  }
  return blocks;
}

interface Run {
  start: number;
  end: number;
  raw: string;
}

/**
 * Paragraph runs: maximal stretches of non-spacer blocks. A sign-off written as
 * "Thanks,<br>Niko" or as two <div>s with no blank line between is ONE run, so
 * the closing section is the whole sign-off, not just its last line.
 */
export function paragraphRuns(html: string): Run[] {
  const blocks = splitBlocks(html);
  const runs: Run[] = [];
  let cur: Block[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    runs.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      raw: html.slice(cur[0].start, cur[cur.length - 1].end),
    });
    cur = [];
  };
  for (const b of blocks) {
    if (b.spacer) flush();
    else cur.push(b);
  }
  flush();
  return runs;
}

export const SPACER = "<div>&nbsp;</div>";

/**
 * Renders typed text in the editor's shape: one <div> per line, a spacer for
 * each blank line. With asHtml the text is used as-is.
 */
export function renderParagraphs(text: string, asHtml = false): string {
  if (asHtml) return text;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let blank = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blank += 1;
      continue;
    }
    if (out.length > 0) for (let i = 0; i < Math.max(1, blank); i++) if (blank > 0) out.push(SPACER);
    blank = 0;
    out.push(`<div>${escapeHtml(line)}</div>`);
  }
  return out.join("");
}

/**
 * Replaces the opening or closing paragraph run. A body with a single run has
 * that run as both. An empty body gets the text as its only paragraph.
 */
export function setBodySection(
  html: string,
  which: "opening" | "closing",
  text: string,
  asHtml = false
): { body: string; before: string; changed: boolean } {
  const runs = paragraphRuns(html);
  const rendered = renderParagraphs(text, asHtml);
  if (runs.length === 0) {
    return { body: rendered, before: "", changed: rendered !== html };
  }
  const run = which === "opening" ? runs[0] : runs[runs.length - 1];
  const before = blockText(run.raw);
  if (run.raw === rendered) return { body: html, before, changed: false };
  const body = html.slice(0, run.start) + rendered + html.slice(run.end);
  return { body, before, changed: body !== html };
}

// --- Applying an edit to one variation ---------------------------------------

export function applyEdit(v: VariationCopy, edit: CopyEdit): VariationEditResult {
  const base = { variation: v.variation, subjectMatches: 0, bodyMatches: 0 };

  if (edit.kind === "replace-text") {
    let subject = v.subject;
    let body = v.body;
    let subjectMatches = 0;
    let bodyMatches = 0;
    if (edit.target !== "body") {
      const r = replaceText(v.subject, edit.find, edit.replace, {
        html: false,
        caseSensitive: edit.caseSensitive,
      });
      subject = r.text;
      subjectMatches = r.matches;
    }
    if (edit.target !== "subject") {
      const r = replaceText(v.body, edit.find, edit.replace, {
        html: true,
        caseSensitive: edit.caseSensitive,
      });
      body = r.text;
      bodyMatches = r.matches;
    }
    const changed = subject !== v.subject || body !== v.body;
    return {
      ...base,
      subject,
      body,
      subjectMatches,
      bodyMatches,
      changed,
      reason: changed ? undefined : "text not found",
    };
  }

  if (edit.section === "subject") {
    const subject = edit.text;
    const changed = subject !== v.subject;
    return { ...base, subject, body: v.body, changed, reason: changed ? undefined : "already this subject" };
  }

  const r = setBodySection(v.body, edit.section, edit.text, edit.asHtml);
  return {
    ...base,
    subject: v.subject,
    body: r.body,
    changed: r.changed,
    reason: r.changed ? undefined : "already this text",
  };
}

/**
 * Problems with an edit before it touches anything. Empty when fine.
 *
 * Step 1 of a parent campaign must keep a subject; a sub-sequence's step 1
 * replies in-thread and legitimately has none, so the rule doesn't apply there.
 */
export function validateEdit(
  edit: CopyEdit,
  step: number,
  opts: { subsequence?: boolean } = {}
): string[] {
  const problems: string[] = [];
  if (edit.kind === "replace-text") {
    if (!normalizeFind(edit.find)) problems.push("Enter the text to find.");
    if (normalizeFind(edit.find) === normalizeFind(edit.replace) && edit.find === edit.replace) {
      problems.push("The replacement is the same as the text to find.");
    }
  } else {
    if (edit.section === "subject" && step === 1 && !opts.subsequence && edit.text.trim() === "") {
      problems.push("Step 1 needs a subject line — it can't be blank.");
    }
    if (edit.section !== "subject" && edit.text.trim() === "") {
      problems.push("Enter the new paragraph text.");
    }
  }
  return problems;
}
