import type { Metadata } from "next";
import { Header } from "@/components/header";
import { FirstCampaignTool } from "./tool";

export const metadata: Metadata = {
  title: "New Workspace 1st Campaign · Plusvibe Tools",
  description:
    "Build a new client's first campaign — step 1, the standard settings and schedule, and all six sub-sequences with their label triggers.",
};

export default function FirstCampaignPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            New Workspace 1st Campaign
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick a new client&apos;s workspace and it builds their first
            campaign from scratch — the step 1 shell with your greeting and
            sign-off spintax, every safety and sending setting, the schedule and
            the Active tag, then all six sub-sequences wired to their lead
            labels, creating any labels the workspace doesn&apos;t have yet.
          </p>
        </div>
        <FirstCampaignTool />
      </main>
    </div>
  );
}
