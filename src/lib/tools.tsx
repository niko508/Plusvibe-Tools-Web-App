import type { ComponentType } from "react";
import { GaugeIcon, MailIcon, SparklesIcon } from "@/components/icons";

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
