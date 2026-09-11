import type { SignatureFields } from "./types";

// Generates a spintax email signature: many deduped full-block variations built
// from a small set of layouts × the user's field pools × two name forms, wrapped
// in a single {{Random | … | …}}. Lines are joined with <br> (HTML signature).

// Sanitizes a field value: strips spintax delimiters/braces, escapes HTML.
export function sanitizeValue(v: string): string {
  return v
    .trim()
    .replace(/[|{}]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The two name forms used in the example: "Justin Steinle" and "Justin S.".
export function nameFormsFor(first: string, last: string): string[] {
  const f = sanitizeValue(first || "");
  const l = sanitizeValue(last || "");
  if (!f) return [];
  if (!l) return [f];
  return [`${f} ${l}`, `${f} ${l[0].toUpperCase()}.`];
}

interface LayoutInput {
  name: string;
  title: string;
  company: string;
  phone: string;
  address: string;
}

// The six structural layouts from the reference signature: name on its own line
// (with/without phone/address) and the "Name – Company" variants.
const LAYOUTS: ((i: LayoutInput) => string[])[] = [
  ({ name, title, company, phone, address }) => [name, title, company, phone, address],
  ({ name, title, company, phone }) => [name, title, company, phone],
  ({ name, title, company }) => [name, title, company],
  ({ name, title, company, phone, address }) => [`${name} – ${company}`, title, phone, address],
  ({ name, title, company, phone }) => [`${name} – ${company}`, title, phone],
  ({ name, title, company }) => [`${name} – ${company}`, title],
];

// Cleans a field pool: sanitize, drop blanks, dedupe. Empty pools fall back to a
// single blank so phone/address-bearing layouts still render (and collapse via
// dedup) when the user left them empty.
function pool(values: string[], allowEmpty: boolean): string[] {
  const cleaned = values.map(sanitizeValue).filter(Boolean);
  const unique = Array.from(new Set(cleaned));
  if (unique.length === 0 && allowEmpty) return [""];
  return unique;
}

// Builds the set of unique signature blocks for the given name forms + fields.
export function generateBlocks(
  fields: SignatureFields,
  nameForms: string[]
): string[] {
  const titles = pool(fields.titles, false);
  const companies = pool(fields.companies, false);
  const phones = pool(fields.phones, true);
  const addresses = pool(fields.addresses, true);
  if (titles.length === 0 || companies.length === 0 || nameForms.length === 0)
    return [];

  const blocks = new Set<string>();
  for (const layout of LAYOUTS) {
    for (const name of nameForms) {
      for (const title of titles) {
        for (const company of companies) {
          for (const phone of phones) {
            for (const address of addresses) {
              const lines = layout({
                name,
                title,
                company,
                phone,
                address,
              }).filter((l) => l && l.trim());
              if (lines.length) blocks.add(lines.join("<br>"));
            }
          }
        }
      }
    }
  }
  return Array.from(blocks);
}

export interface BuiltSignature {
  signature: string;
  count: number;
}

// Full signature (spintax) for one person. Returns null if there's no usable
// name or no company.
export function buildSignature(
  fields: SignatureFields,
  first: string,
  last: string
): BuiltSignature | null {
  const nameForms = nameFormsFor(first, last);
  if (nameForms.length === 0) return null;
  const blocks = generateBlocks(fields, nameForms);
  if (blocks.length === 0) return null;
  return {
    signature: `{{Random | ${blocks.join(" | ")}}}`,
    count: blocks.length,
  };
}
