import { bodyToHtml } from "@/lib/body-html";

// Follow-up templates and the offer substitution applied when they're written
// into a campaign.
//
// Each template is one variant of step 2. The literal SERVICE OFFERING / OFFER
// is replaced with the sentence entered on the run, so the same library of
// templates is reusable across campaigns selling different things.

export const OFFER_PLACEHOLDER = "SERVICE OFFERING / OFFER";

/** The line that separates templates in a bulk paste or export. */
export const TEMPLATE_SEPARATOR = "--";

export interface FollowUpTemplate {
  id: string;
  /** Raw text, placeholder included. */
  body: string;
}

export interface RenderedTemplate {
  id: string;
  /** 1-based position in the library, matching the numbering in the UI. */
  position: number;
  /** Body with the offer substituted. */
  body: string;
  html: string;
  /** How many placeholder occurrences were replaced. */
  replacements: number;
}

/**
 * Replaces every occurrence of the placeholder.
 *
 * Matching is case-insensitive and tolerant of the spacing around the slash,
 * because the placeholder is retyped by hand into new templates. It is NOT
 * tolerant of a partial match — "SERVICE OFFERING" alone is left alone, so a
 * template that half-uses the marker shows up as unsubstituted rather than
 * being silently mangled.
 */
export function applyOffer(text: string, offer: string): {
  body: string;
  replacements: number;
} {
  const re = /SERVICE\s+OFFERING\s*\/\s*OFFER/gi;
  let replacements = 0;
  const body = text.replace(re, () => {
    replacements += 1;
    return offer;
  });
  return { body, replacements };
}

export function hasPlaceholder(text: string): boolean {
  return /SERVICE\s+OFFERING\s*\/\s*OFFER/i.test(text);
}

/**
 * Splits a bulk paste into templates on a line containing only the separator.
 *
 * A leading or trailing separator is tolerated, and blank chunks are dropped,
 * so pasting a list that starts or ends with "--" doesn't create empty
 * templates.
 */
export function splitTemplates(raw: string): string[] {
  return (raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/^[ \t]*--+[ \t]*$/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

/** Joins templates back into the paste format, for export. */
export function joinTemplates(templates: FollowUpTemplate[]): string {
  return templates
    .map((t) => t.body.trim())
    .filter(Boolean)
    .join(`\n\n${TEMPLATE_SEPARATOR}\n\n`);
}

export interface RenderResult {
  rendered: RenderedTemplate[];
  /** Non-fatal problems worth showing before anything is written. */
  warnings: string[];
}

/**
 * Prepares the whole library for writing: substitutes the offer and converts
 * each template to editor HTML.
 *
 * Templates with no placeholder are still rendered — a follow-up that never
 * names the offer is legitimate — but they're called out, because the usual
 * cause is a typo in the marker.
 */
export function renderTemplates(
  templates: FollowUpTemplate[],
  offer: string
): RenderResult {
  const warnings: string[] = [];
  const trimmedOffer = offer.trim();

  const rendered: RenderedTemplate[] = [];
  const missing: number[] = [];

  templates.forEach((t, i) => {
    const position = i + 1;
    const body = t.body.trim();
    if (!body) return; // empty rows in the editor are not variants

    const { body: withOffer, replacements } = applyOffer(body, trimmedOffer);
    if (replacements === 0) missing.push(position);

    rendered.push({
      id: t.id,
      position,
      body: withOffer,
      html: bodyToHtml(withOffer),
      replacements,
    });
  });

  if (missing.length > 0) {
    warnings.push(
      `Template ${missing.join(", ")} ${
        missing.length === 1 ? "has" : "have"
      } no "${OFFER_PLACEHOLDER}" placeholder, so nothing was substituted there.`
    );
  }

  // Two identical bodies become two identical variants, which is almost always
  // a duplication slip rather than intent.
  const seen = new Map<string, number>();
  for (const r of rendered) {
    const key = r.body.replace(/\s+/g, " ").trim();
    const first = seen.get(key);
    if (first != null) {
      warnings.push(`Template ${r.position} is identical to template ${first}.`);
    } else {
      seen.set(key, r.position);
    }
  }

  return { rendered, warnings };
}

let idCounter = 0;

/** Stable-enough id for list keys and reordering. */
export function newTemplateId(): string {
  idCounter += 1;
  return `t${Date.now().toString(36)}${idCounter.toString(36)}`;
}
