import { parseCsv } from "@/lib/csv";

// Parses the uploaded mailbox CSV. Columns are located BY HEADER NAME, not
// position, so the export's column order can change without breaking this.
//
// The file also carries a Password column. It is deliberately never read: the
// tool has no use for mailbox passwords, so they never leave the browser.

export interface UploadRow {
  email: string;
  domain: string;
  orderEmail: string;
}

export interface UploadDomain {
  domain: string;
  orderEmail: string;
  inboxes: number;
}

export interface ParsedUpload {
  rows: UploadRow[];
  domains: UploadDomain[];
  warnings: string[];
}

const HEADERS = {
  email: ["email"],
  domain: ["domain"],
  orderEmail: ["order email", "order_email", "orderemail"],
};

function findColumn(header: string[], names: string[]): number {
  const normalized = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const i = normalized.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

export function parseUpload(text: string): ParsedUpload {
  const warnings: string[] = [];
  const grid = parseCsv(text ?? "");
  if (grid.length === 0) {
    return { rows: [], domains: [], warnings: ["The file is empty."] };
  }

  const header = grid[0];
  const iEmail = findColumn(header, HEADERS.email);
  const iDomain = findColumn(header, HEADERS.domain);
  const iOrder = findColumn(header, HEADERS.orderEmail);

  const missing: string[] = [];
  if (iEmail === -1) missing.push("Email");
  if (iDomain === -1) missing.push("Domain");
  if (iOrder === -1) missing.push("Order Email");
  if (missing.length > 0) {
    return {
      rows: [],
      domains: [],
      warnings: [
        `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Found: ${header
          .map((h) => h.trim())
          .filter(Boolean)
          .join(", ")}`,
      ],
    };
  }

  const rows: UploadRow[] = [];
  const seen = new Set<string>();
  let blank = 0;
  let duplicates = 0;

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const email = (row[iEmail] ?? "").trim().toLowerCase();
    const domain = (row[iDomain] ?? "").trim().toLowerCase();
    const orderEmail = (row[iOrder] ?? "").trim();
    if (!email && !domain && !orderEmail) continue; // trailing blank line
    if (!email || !domain || !orderEmail) {
      blank += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);
    rows.push({ email, domain, orderEmail });
  }

  if (blank > 0) {
    warnings.push(
      `${blank} row${blank === 1 ? "" : "s"} skipped for a missing Email, Domain or Order Email.`
    );
  }
  if (duplicates > 0) {
    warnings.push(
      `${duplicates} duplicate email${duplicates === 1 ? "" : "s"} skipped.`
    );
  }

  // Group by domain, and flag any domain that maps to more than one order
  // email — the sheet has a single Tenant Email Address cell per domain, so
  // that would be ambiguous.
  const byDomain = new Map<string, { orderEmails: Set<string>; count: number }>();
  for (const row of rows) {
    const entry = byDomain.get(row.domain);
    if (entry) {
      entry.orderEmails.add(row.orderEmail);
      entry.count += 1;
    } else {
      byDomain.set(row.domain, {
        orderEmails: new Set([row.orderEmail]),
        count: 1,
      });
    }
  }

  const domains: UploadDomain[] = [];
  for (const [domain, entry] of byDomain) {
    const orderEmails = Array.from(entry.orderEmails);
    if (orderEmails.length > 1) {
      warnings.push(
        `${domain} has ${orderEmails.length} different Order Emails (${orderEmails.join(", ")}) — the first is used for the sheet.`
      );
    }
    domains.push({ domain, orderEmail: orderEmails[0], inboxes: entry.count });
  }
  domains.sort((a, b) => a.domain.localeCompare(b.domain));

  if (rows.length === 0) {
    warnings.push("No usable rows found.");
  }

  return { rows, domains, warnings };
}
