import type { Metadata } from "next";
import { Header } from "@/components/header";
import { CopyCampaignTool } from "./tool";

export const metadata: Metadata = {
  title: "Copy Campaign to Other Workspace · Plusvibe Tools",
  description:
    "Take one campaign's email copy into another workspace, on top of a destination campaign's settings and sub-sequences.",
};

export default function CopyCampaignPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Copy Campaign to Other Workspace
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick the campaign whose copy you want and a campaign in the
            destination workspace to take the settings from. The destination
            campaign is duplicated where it already lives, keeping its
            settings, schedule, sender accounts and sub-sequences, and the new
            campaign&apos;s own email copy is replaced with the source&apos;s.
          </p>
        </div>
        <CopyCampaignTool />
      </main>
    </div>
  );
}
