import type { Metadata } from "next";
import { Header } from "@/components/header";
import { MoveLeadsTool } from "./tool";

export const metadata: Metadata = {
  title: "Move Leads to Another Campaign · Plusvibe Tools",
  description:
    "Move a set number of leads from one campaign to another within a workspace, carrying their fields and custom variables across.",
};

export default function MoveLeadsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Move Leads to Another Campaign
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick a source and a destination campaign in the same workspace, say
            how many leads to move, and they&apos;re added to the destination
            first and only then removed from the source.
          </p>
        </div>
        <MoveLeadsTool />
      </main>
    </div>
  );
}
