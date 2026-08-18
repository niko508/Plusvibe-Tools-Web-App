// Parses the pasted "VARIANT N — Name" block format into structured variants.
//
// Expected shape (rule lines and headers are both optional/tolerated):
//
//   VARIANT 1 — Poke-the-bear
//   ═══════════════════════════
//
//   <body…>
//
//   ═══════════════════════════
//   VARIANT 2 — Value-prop
//   ═══════════════════════════
//
//   <body…>
//
// Rule lines (runs of ═ or =) are pure decoration and are stripped. Variants are
// split on the "VARIANT n" header lines. If the paste has no headers at all we
// fall back to splitting on the rule lines, so a plain separator-delimited list
// still works.

export interface ParsedVariant {
  /** 1-based position in the paste (not necessarily the number in the header). */
  position: number;
  /** The number written in the header, when present. */
  number?: number;
  /** Free-text name from the header, e.g. "Poke-the-bear (checkable)". */
  name: string;
  /** Body as plain text, blank-line separated paragraphs. */
  body: string;
  /** Body converted to HTML for the campaign editor. */
  html: string;
}

export interface ParseResult {
  variants: ParsedVariant[];
  /** Non-fatal problems worth surfacing before the user applies anything. */
  warnings: string[];
}

// A decoration rule: a line made only of ═ or = (3 or more).
const RULE_RE = /^\s*(?:═|=){3,}\s*$/;

// "VARIANT 12 — Some name", "Variant 3: Name", "VARIANT 4" (name optional).
const HEADER_RE = /^\s*VARIANT\s+(\d+)\s*(?:[—–\-:]\s*(.*))?$/i;

export function parseVariants(raw: string): ParseResult {
  const warnings: string[] = [];
  const text = (raw ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return { variants: [], warnings };

  const lines = text.split("\n");

  // Collect chunks: each header starts a new chunk; rule lines are dropped.
  interface Chunk {
    number?: number;
    name: string;
    lines: string[];
  }
  const chunks: Chunk[] = [];
  let current: Chunk | null = null;
  let preamble: string[] = [];

  for (const line of lines) {
    if (RULE_RE.test(line)) continue;
    const header = HEADER_RE.exec(line);
    if (header) {
      current = {
        number: Number(header[1]),
        name: (header[2] ?? "").trim(),
        lines: [],
      };
      chunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }

  // No headers found — fall back to splitting the whole paste on rule lines.
  if (chunks.length === 0) {
    const blocks = text
      .split("\n")
      .reduce<string[][]>(
        (acc, line) => {
          if (RULE_RE.test(line)) acc.push([]);
          else acc[acc.length - 1].push(line);
          return acc;
        },
        [[]]
      )
      .map((block) => trimBlank(block).join("\n"))
      .filter((b) => b.trim());

    const variants = blocks.map((body, i) => toVariant(i + 1, undefined, "", body));
    if (variants.length > 0) {
      warnings.push(
        `No "VARIANT n" headers found — split into ${variants.length} block${
          variants.length === 1 ? "" : "s"
        } on the separator lines instead.`
      );
    }
    return { variants, warnings };
  }

  if (preamble.some((l) => l.trim())) {
    warnings.push(
      "Text before the first VARIANT header was ignored."
    );
  }

  const variants: ParsedVariant[] = [];
  let skippedEmpty = 0;
  for (const chunk of chunks) {
    const body = trimBlank(chunk.lines).join("\n");
    if (!body.trim()) {
      skippedEmpty += 1;
      continue;
    }
    variants.push(
      toVariant(variants.length + 1, chunk.number, chunk.name, body)
    );
  }

  if (skippedEmpty > 0) {
    warnings.push(
      `${skippedEmpty} variant${skippedEmpty === 1 ? "" : "s"} had an empty body and ${
        skippedEmpty === 1 ? "was" : "were"
      } skipped.`
    );
  }

  // Duplicate bodies are almost always a copy/paste slip.
  const seen = new Map<string, number>();
  for (const v of variants) {
    const key = v.body.replace(/\s+/g, " ").trim();
    const first = seen.get(key);
    if (first != null) {
      warnings.push(
        `Variant ${v.position} has the same body as variant ${first}.`
      );
    } else {
      seen.set(key, v.position);
    }
  }

  return { variants, warnings };
}

function toVariant(
  position: number,
  number: number | undefined,
  name: string,
  body: string
): ParsedVariant {
  return { position, number, name, body, html: bodyToHtml(body) };
}

// Drops leading/trailing blank lines without touching the interior.
function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

// Converts a plain-text body into the HTML the campaign editor stores: one <p>
// per blank-line-separated block, single newlines inside a block become <br>.
// Spintax ({{Random | … }}) and Liquid ({% if … %}) contain no HTML-special
// characters, so escaping the text is safe and leaves them intact.
export function bodyToHtml(body: string): string {
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return "";
  return blocks
    .map(
      (block) =>
        `<p>${block
          .split("\n")
          .map((line) => escapeHtml(line.trim()))
          .join("<br />")}</p>`
    )
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
