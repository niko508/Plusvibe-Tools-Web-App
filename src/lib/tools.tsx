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
  CopyIcon,
  PlayIcon,
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
    slug: "blocked-domains",
    name: "Blocked Domains (Automation)",
    tagline: "Kill a blocked sending domain the moment Clay spots it",
    description:
      "Clay calls this app when a bounce reason shows one of your sending domains is blocked. Its inboxes stop sending and warming immediately, then wait for you to confirm the deletion — after which the domain goes Not Active in the Domains sheet and its tenant is queued for cancellation.",
    status: "active",
    color: "orange",
    Icon: FireIcon,
  },
  {
    slug: "first-campaign",
    name: "New Workspace 1st Campaign",
    tagline: "Build a new client's first campaign end to end",
    description:
      "Pick a new client's workspace and it builds their first campaign from scratch — the step 1 shell with your greeting and sign-off spintax, every safety and sending setting, the schedule and the Active tag, then all six sub-sequences wired to their lead labels, creating any labels the workspace doesn't have yet.",
    status: "active",
    color: "rose",
    Icon: SparklesIcon,
  },
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
    slug: "inbox-performance",
    name: "Inbox Performance Monitoring",
    tagline: "Compare every sending inbox — in one workspace or across all of them",
    description:
      "Break email stats down by sending inbox over any date range — sent volume, reply rates on unique contacts, positive replies and bounces — for one workspace or every workspace at once. Nothing is fetched until you choose what to pull.",
    status: "active",
    color: "blue",
    Icon: MailIcon,
  },
  {
    slug: "start-outreach",
    name: "Start Outreach with New Inboxes",
    tagline: "Find the inboxes that have warmed long enough, then put them to work",
    description:
      "Pick the workspace where inboxes have been warming and it finds the ones that have warmed for at least 14 days, taking each start date from the Email Infra sheet first and from Plusvibe's own record when the sheet has none. Moving them to a client workspace and starting the outreach are the next steps.",
    status: "active",
    color: "orange",
    Icon: PlayIcon,
  },
  {
    slug: "copy-campaign",
    name: "Copy Campaign to Other Workspace",
    tagline: "Move a campaign's copy across, on another campaign's settings",
    description:
      "Pick the campaign whose email copy you want and a campaign in the destination workspace to take the settings from. The destination campaign is duplicated where it already lives — keeping its settings, schedule, sender accounts and sub-sequences — and the new campaign's own copy is replaced with the source's.",
    status: "active",
    color: "violet",
    Icon: CopyIcon,
  },
  {
    slug: "change-limits",
    name: "Change Limits with Best Performing Inboxes",
    tagline: "Raise the limits on the inboxes that are actually replying",
    description:
      "Set a true reply rate for Google and for Microsoft inboxes plus a minimum number of sends, and it finds every inbox in the workspaces you pick that clears its own threshold — then raises their campaign emails, warmup emails, randomised warmup, warmup reply rate and email interval in one background run. Rates are worked out on unique contacts.",
    status: "active",
    color: "emerald",
    Icon: ZapIcon,
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
    slug: "copy-sections",
    name: "Change Email Copy Sections",
    tagline: "Change one thing across every variation — one step, or every campaign",
    description:
      "Find and replace a sentence or a variable, or swap out the subject line, the opening paragraph or the sign-off, across every variation of a step — with a preview of each before anything is written. Or scan every campaign in every workspace you pick and apply the same find & replace everywhere after confirming.",
    status: "active",
    color: "amber",
    Icon: PenIcon,
  },
  {
    slug: "campaign-types",
    name: "Create All Campaign Types",
    tagline: "Split a campaign across its Microsoft, Opt Out and Signature copies",
    description:
      "Point it at the original campaign and it builds the other five, adds the opt-out line to step 1 of both Opt Out campaigns and swaps step 1's sign-off to {{sender_signature}} on both Signature campaigns, then sorts the not-contacted leads by mailbox provider and splits them six ways — Microsoft into the \u{1F535} campaigns, the rest across the original and its copies.",
    status: "active",
    color: "amber",
    Icon: ScissorsIcon,
  },
  {
    slug: "follow-ups",
    name: "Create Follow Up Emails",
    tagline: "Add your follow-up template library to step 2",
    description:
      "Keep a numbered library of follow-up templates and add them all as variants of step 2 on any campaign, with the SERVICE OFFERING / OFFER placeholder replaced by the offer sentence you enter on the run.",
    status: "active",
    color: "teal",
    Icon: MailIcon,
  },
  {
    slug: "bulk-actions",
    name: "General Bulk Actions",
    tagline: "Run one action across many workspaces at once",
    description:
      "Pick as many workspaces as you like, then apply the same change to all of them. First action: add a webhook to every selected workspace, skipping any that already point at the same URL.",
    status: "active",
    color: "indigo",
    Icon: ZapIcon,
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
];

export function getTool(slug: string): Tool | undefined {
  return TOOLS.find((t) => t.slug === slug);
}
