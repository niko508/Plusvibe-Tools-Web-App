import type { ComponentType } from "react";
import {
  GaugeIcon,
  MailIcon,
  SparklesIcon,
  TrashIcon,
  PenIcon,
  FireIcon,
  LayersIcon,
  ZapIcon,
  ScissorsIcon,
  MoveIcon,
} from "@/components/icons";

// Registry of tools shown on the landing page. Adding a new tool = add an entry
// here and (for active tools) a page under src/app/tools/<slug>/page.tsx.

export type ToolStatus = "active" | "soon";

// Each tool gets its own accent so the grid is scannable at a glance. Tailwind
// needs literal class names, so these map to a static table below rather than
// being built from the key at runtime.
export type ToolColor =
  | "sky"
  | "violet"
  | "amber"
  | "cyan"
  | "orange"
  | "emerald"
  | "rose"
  | "teal"
  | "indigo"
  | "blue";

export interface ToolColorClasses {
  /** Icon tile background + glyph. */
  tile: string;
  /** Card border on hover. */
  border: string;
  /** "Open tool" link. */
  link: string;
}

export const TOOL_COLORS: Record<ToolColor, ToolColorClasses> = {
  sky: {
    tile: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    border: "hover:border-sky-500/40",
    link: "text-sky-600 dark:text-sky-400",
  },
  violet: {
    tile: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    border: "hover:border-violet-500/40",
    link: "text-violet-600 dark:text-violet-400",
  },
  amber: {
    tile: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    border: "hover:border-amber-500/40",
    link: "text-amber-600 dark:text-amber-400",
  },
  cyan: {
    tile: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    border: "hover:border-cyan-500/40",
    link: "text-cyan-600 dark:text-cyan-400",
  },
  orange: {
    tile: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    border: "hover:border-orange-500/40",
    link: "text-orange-600 dark:text-orange-400",
  },
  emerald: {
    tile: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    border: "hover:border-emerald-500/40",
    link: "text-emerald-600 dark:text-emerald-400",
  },
  rose: {
    tile: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    border: "hover:border-rose-500/40",
    link: "text-rose-600 dark:text-rose-400",
  },
  teal: {
    tile: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
    border: "hover:border-teal-500/40",
    link: "text-teal-600 dark:text-teal-400",
  },
  indigo: {
    tile: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    border: "hover:border-indigo-500/40",
    link: "text-indigo-600 dark:text-indigo-400",
  },
  blue: {
    tile: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    border: "hover:border-blue-500/40",
    link: "text-blue-600 dark:text-blue-400",
  },
};

export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  status: ToolStatus;
  color: ToolColor;
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
    color: "sky",
    Icon: GaugeIcon,
  },
  {
    slug: "azure-warmup",
    name: "Azure Start Warmup",
    tagline: "Upload the mailbox export and start warmup as inboxes land",
    description:
      "Writes each domain's tenant email and a Warming Up status into the Domains sheet, then polls Plusvibe hourly for up to 7 days, applying the standard warmup config and switching warmup on for every inbox as it appears.",
    status: "active",
    color: "blue",
    Icon: ZapIcon,
  },
  {
    slug: "copy-variations",
    name: "Create Email Copy Variations",
    tagline: "Bulk-add copy variants to a campaign step, subject line untouched",
    description:
      "Pick a campaign, paste your variants in the usual VARIANT n — name format, and add them all to a sequence step in one pass — keeping the existing subject line and the variants already there.",
    status: "active",
    color: "violet",
    Icon: LayersIcon,
  },
  {
    slug: "remove-opening-line",
    name: "Remove Personalized Opening Line",
    tagline: "Strip the opening-line personalization from a whole campaign",
    description:
      "Unwrap the {{fallback| {{subject_line}} …}} subject on every variation and drop {{opening_line}} from every body — the rest of the copy, and the variations themselves, stay exactly as they are.",
    status: "active",
    color: "amber",
    Icon: ScissorsIcon,
  },
  {
    slug: "move-leads",
    name: "Move Leads to Another Campaign",
    tagline: "Shift a set number of leads from one campaign to another",
    description:
      "Pick a source and destination campaign in the same workspace and move a set number of leads across — added to the destination first, then removed from the source once that's confirmed, carrying their fields and custom variables with them.",
    status: "active",
    color: "cyan",
    Icon: MoveIcon,
  },
  {
    slug: "remove-50",
    name: "Remove 50 Inboxes from Domain",
    tagline: "Trim over-provisioned warmup domains down to 50 and standardize warmup",
    description:
      "For a workspace, trim every domain that has more than 50 inboxes down to 50 — deleting the worst warmup-health inboxes first — then apply your standard warmup settings and enable warmup on the ones kept.",
    status: "active",
    color: "orange",
    Icon: FireIcon,
  },
  {
    slug: "add-signatures",
    name: "Add Signatures",
    tagline: "Push unique spintaxed signatures to every inbox in a workspace",
    description:
      "Pick a workspace, provide your company / phone / address variations, and generate hundreds of spintax signature combinations — personalized with each inbox's own name — then apply them in one pass.",
    status: "active",
    color: "emerald",
    Icon: PenIcon,
  },
  {
    slug: "remove-inboxes",
    name: "Remove Inboxes",
    tagline: "Bulk-delete inboxes by domain across all your workspaces",
    description:
      "Paste a list of sending domains, scan every workspace to find their inboxes, then delete them in a background job you can leave running — with a full results report of what was removed.",
    status: "active",
    color: "rose",
    Icon: TrashIcon,
  },
  {
    slug: "mailbox-health",
    name: "Mailbox Health Audit",
    tagline: "Spot warmup and bounce issues across all mailboxes at once",
    description:
      "Scan every mailbox in a workspace for warmup health, bounce rates and disconnects, and flag the accounts that need attention.",
    status: "soon",
    color: "teal",
    Icon: MailIcon,
  },
  {
    slug: "bulk-actions",
    name: "Bulk Mailbox Actions",
    tagline: "Update limits, warmup and tags across many mailboxes",
    description:
      "Apply daily-limit, warmup and tagging changes to hundreds of mailboxes in one pass instead of editing them one by one.",
    status: "soon",
    color: "indigo",
    Icon: SparklesIcon,
  },
];

export function getTool(slug: string): Tool | undefined {
  return TOOLS.find((t) => t.slug === slug);
}
