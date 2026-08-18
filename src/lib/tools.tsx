import type { ComponentType } from "react";
import {
  GaugeIcon,
  MailIcon,
  SparklesIcon,
  TrashIcon,
  PenIcon,
  FireIcon,
  LayersIcon,
  ScissorsIcon,
} from "@/components/icons";

// Registry of tools shown on the landing page. Adding a new tool = add an entry
// here and (for active tools) a page under src/app/tools/<slug>/page.tsx.

export type ToolStatus = "active" | "soon";

export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  status: ToolStatus;
  Icon: ComponentType<{ className?: string; size?: number }>;
}

export const TOOLS: Tool[] = [
  {
    slug: "domain-performance",
    name: "Domain Performance Monitoring",
    tagline: "Compare deliverability & replies across every sending domain",
    description:
      "Break a workspace's email stats down by sending domain over any date range — sent volume, reply and positive-reply rates, bounce rate and more, side by side.",
    status: "active",
    Icon: GaugeIcon,
  },
  {
    slug: "copy-variations",
    name: "Create Email Copy Variations",
    tagline: "Bulk-add copy variants to a campaign step, subject line untouched",
    description:
      "Pick a campaign, paste your variants in the usual VARIANT n — name format, and add them all to a sequence step in one pass — keeping the existing subject line and the variants already there.",
    status: "active",
    Icon: LayersIcon,
  },
  {
    slug: "remove-opening-line",
    name: "Remove Personalized Opening Line",
    tagline: "Strip the opening-line personalization from a whole campaign",
    description:
      "Unwrap the {{fallback| {{subject_line}} …}} subject on every variation and drop {{opening_line}} from every body — the rest of the copy, and the variations themselves, stay exactly as they are.",
    status: "active",
    Icon: ScissorsIcon,
  },
  {
    slug: "remove-50",
    name: "Remove 50 Inboxes from Domain",
    tagline: "Trim over-provisioned warmup domains down to 50 and standardize warmup",
    description:
      "For a workspace, trim every domain that has more than 50 inboxes down to 50 — deleting the worst warmup-health inboxes first — then apply your standard warmup settings and enable warmup on the ones kept.",
    status: "active",
    Icon: FireIcon,
  },
  {
    slug: "add-signatures",
    name: "Add Signatures",
    tagline: "Push unique spintaxed signatures to every inbox in a workspace",
    description:
      "Pick a workspace, provide your company / phone / address variations, and generate hundreds of spintax signature combinations — personalized with each inbox's own name — then apply them in one pass.",
    status: "active",
    Icon: PenIcon,
  },
  {
    slug: "remove-inboxes",
    name: "Remove Inboxes",
    tagline: "Bulk-delete inboxes by domain across all your workspaces",
    description:
      "Paste a list of sending domains, scan every workspace to find their inboxes, then delete them in a background job you can leave running — with a full results report of what was removed.",
    status: "active",
    Icon: TrashIcon,
  },
  {
    slug: "mailbox-health",
    name: "Mailbox Health Audit",
    tagline: "Spot warmup and bounce issues across all mailboxes at once",
    description:
      "Scan every mailbox in a workspace for warmup health, bounce rates and disconnects, and flag the accounts that need attention.",
    status: "soon",
    Icon: MailIcon,
  },
  {
    slug: "bulk-actions",
    name: "Bulk Mailbox Actions",
    tagline: "Update limits, warmup and tags across many mailboxes",
    description:
      "Apply daily-limit, warmup and tagging changes to hundreds of mailboxes in one pass instead of editing them one by one.",
    status: "soon",
    Icon: SparklesIcon,
  },
];

export function getTool(slug: string): Tool | undefined {
  return TOOLS.find((t) => t.slug === slug);
}
