// Converts plain-text copy into the HTML shape Plusvibe's campaign editor
// stores and renders correctly:
//
//   <div>Hello {{first_name}},</div><div>&nbsp;</div><div>I noticed…</div>
//
// One <div> per paragraph, joined by a non-breaking-space spacer div. Emitting
// <p> instead loses the spacing — the editor gives paragraphs no margin, so
// everything renders tight against the next line. Single newlines inside a
// paragraph become <br />.
//
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
        `<div>${block
          .split("\n")
          .map((line) => escapeHtml(line.trim()))
          .join("<br />")}</div>`
    )
    .join("<div>&nbsp;</div>");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** "1. ", "2) ", "* ", "- ", "• " — a line that is one item of a list. */
const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[*•\-–])\s+/;

/**
 * Like bodyToHtml, but every LINE is a paragraph, not only blank-line
 * separated blocks. The variation generator writes one paragraph per line
 * with no blank line between them; read with bodyToHtml, each email became
 * one paragraph of <br />-joined lines and rendered with no spacing at all.
 *
 * Consecutive list lines ("1. …", "* …") stay together as one paragraph, a
 * line each, so a list still reads as a list. Blank lines, however many, are
 * one spacer. Spintax, Liquid and the text itself are untouched.
 */
export function linesToHtml(body: string): string {
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const paragraphs: string[][] = [];
  for (const line of lines) {
    const last = paragraphs[paragraphs.length - 1];
    if (last && LIST_ITEM.test(line) && LIST_ITEM.test(last[last.length - 1])) last.push(line);
    else paragraphs.push([line]);
  }
  return paragraphs.map((p) => `<div>${p.map(escapeHtml).join("<br />")}</div>`).join("<div>&nbsp;</div>");
}
