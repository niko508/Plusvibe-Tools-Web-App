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
