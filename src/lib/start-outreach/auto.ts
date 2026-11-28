import "server-only";

// Start Outreach without the page: Outengine Bulk Actions' Replace Domains
// (Automated) calls this once a replaced domain has warmed for 15 days, to
// move all of that domain's inboxes into the client workspace it was blocked
// in. It builds exactly the payload the page would — the saved week 1 / week 2
// numbers per category, the destination's saved signature details (else the
// source's), the active tag and the TLD / platform tags from General
// Settings, and the sheet update — and hands it to the same job manager, so
// the run, its queueing and its week 2 switch are the page's own.

import { plusvibeGet } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { createJob } from "@/lib/jobs/start-outreach";
import { loadSettings } from "@/lib/start-outreach/store";
import { loadPreset } from "@/lib/signatures/store";
import { pickRandomRoles } from "@/lib/signatures/roles";
import { categoryOf, type Category } from "@/lib/start-outreach/categories";
import { signatureFieldsUsable, type MovingInbox } from "@/lib/start-outreach/plan";
import { defaultSheetUrl, domainsTab, generalSettings } from "@/lib/general-settings/settings";
import type { SignatureFields } from "@/lib/signatures/types";

const PAGE_SIZE = 100;
const MAX_PAGES = 500;
const TITLE_SLOTS = 5;

export class AutoOutreachProblem extends Error {
  status = 400;
}

const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

async function workspaceNames(apiKey: string): Promise<Map<string, string>> {
  const data = await plusvibeGet<{ workspaces?: { _id?: string; name?: string }[] }>({ apiKey, path: "/authenticate", retries: 1 });
  return new Map((data.workspaces ?? []).filter((w) => w._id).map((w) => [String(w._id), String(w.name ?? w._id)]));
}

/** Every inbox in the workspace on one of `domains`, with what a move needs. */
async function inboxesOn(apiKey: string, workspaceId: string, domains: Set<string>) {
  const out: { id: string; email: string; domain: string; provider: string; firstName?: string; lastName?: string }[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    await acquireSlot();
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/account/list",
      query: { workspace_id: workspaceId, skip: String(page * PAGE_SIZE), limit: String(PAGE_SIZE) },
    });
    const raw = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : Array.isArray((data as { accounts?: unknown })?.accounts)
        ? (data as { accounts: Record<string, unknown>[] }).accounts
        : [];
    for (const a of raw) {
      const id = String(a.id ?? a._id ?? "").trim();
      const email = String(a.email ?? "").trim();
      if (!id || !email || !domains.has(domainOf(email))) continue;
      const name = ((a.payload ?? {}) as { name?: { first_name?: string; last_name?: string } }).name ?? {};
      out.push({
        id,
        email,
        domain: domainOf(email),
        provider: String(a.provider ?? ""),
        firstName: name.first_name?.trim() || undefined,
        lastName: name.last_name?.trim() || undefined,
      });
    }
    if (raw.length < PAGE_SIZE) break;
  }
  return out;
}

export interface AutoOutreachResult {
  jobId: string;
  inboxes: number;
  domains: string[];
  /** Domains asked for that have no inboxes in the source workspace. */
  missing: string[];
  categories: Partial<Record<Category, number>>;
  /** Where the signature details came from, or null when signatures were skipped. */
  signaturesFrom: "destination" | "source" | null;
}

export async function startAutomatedOutreach(
  apiKey: string,
  input: { sourceWorkspaceId: string; destWorkspaceId: string; domains: string[]; label?: string }
): Promise<AutoOutreachResult> {
  const wanted = new Set(input.domains.map(lower).filter(Boolean));
  if (!input.sourceWorkspaceId || !input.destWorkspaceId) throw new AutoOutreachProblem("sourceWorkspaceId and destWorkspaceId are required.");
  if (!wanted.size) throw new AutoOutreachProblem("No domains given.");

  const names = await workspaceNames(apiKey);
  for (const id of [input.sourceWorkspaceId, input.destWorkspaceId]) {
    if (!names.has(id)) throw new AutoOutreachProblem(`Workspace ${id} isn't in this Plusvibe account.`);
  }

  const found = await inboxesOn(apiKey, input.sourceWorkspaceId, wanted);
  const missing = [...wanted].filter((d) => !found.some((i) => i.domain === d));
  if (!found.length) throw new AutoOutreachProblem(`No inboxes on ${[...wanted].join(", ")} in ${names.get(input.sourceWorkspaceId)}.`);

  // Category per domain, from every mailbox on it — as the page decides it.
  const byDomain = new Map<string, typeof found>();
  for (const i of found) byDomain.set(i.domain, [...(byDomain.get(i.domain) ?? []), i]);
  const categoryFor = new Map<string, Category | null>();
  for (const [d, list] of byDomain) {
    const counts = new Map<string, number>();
    for (const i of list) counts.set(i.provider, (counts.get(i.provider) ?? 0) + 1);
    categoryFor.set(d, categoryOf([...counts.entries()], list.length));
  }
  const inboxes: MovingInbox[] = found.map((i) => ({ ...i, category: categoryFor.get(i.domain) ?? null }));
  const uncategorised = [...categoryFor].filter(([, c]) => !c).map(([d]) => d);
  if (uncategorised.length) {
    throw new AutoOutreachProblem(`Can't tell whether ${uncategorised.join(", ")} is Google or Microsoft, so there are no settings to apply.`);
  }

  const saved = await loadSettings();
  const present = [...new Set([...categoryFor.values()].filter((c): c is Category => !!c))];
  const weeks = Object.fromEntries(present.map((c) => [c, saved[c]]));

  // Signature details: the destination's saved ones, else the source's.
  let signaturesFrom: AutoOutreachResult["signaturesFrom"] = null;
  let signatures: SignatureFields | null = null;
  for (const [from, id] of [["destination", input.destWorkspaceId], ["source", input.sourceWorkspaceId]] as const) {
    const preset = await loadPreset(apiKey, id);
    if (!preset) continue;
    const fields: SignatureFields = {
      titles: preset.titles.length ? preset.titles : pickRandomRoles(TITLE_SLOTS).filter(Boolean),
      companies: preset.companies,
      phones: preset.phones,
      addresses: preset.addresses,
    };
    if (signatureFieldsUsable(fields)) {
      signatures = fields;
      signaturesFrom = from;
      break;
    }
  }

  const general = generalSettings();
  const jobId = await createJob(apiKey, {
    sourceWorkspaceId: input.sourceWorkspaceId,
    sourceWorkspaceName: names.get(input.sourceWorkspaceId) ?? input.sourceWorkspaceId,
    destWorkspaceId: input.destWorkspaceId,
    destWorkspaceName: names.get(input.destWorkspaceId) ?? input.destWorkspaceId,
    inboxes,
    weeks,
    signatures,
    activeTag: general.tags.active.name || null,
    domainTags: { tld: general.tags.tld, platform: general.tags.platform },
    sheet: { url: defaultSheetUrl() || undefined, tab: domainsTab(), updateSheet: true },
  });

  const categories: Partial<Record<Category, number>> = {};
  for (const i of inboxes) if (i.category) categories[i.category] = (categories[i.category] ?? 0) + 1;
  return { jobId, inboxes: inboxes.length, domains: [...byDomain.keys()], missing, categories, signaturesFrom };
}

