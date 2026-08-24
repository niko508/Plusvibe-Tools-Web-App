import type { Metadata } from "next";
import { Header } from "@/components/header";
import { CampaignTypesTool } from "./tool";

export const metadata: Metadata = {
  title: "Create All Campaign Types · Plusvibe Tools",
  description:
    "Split a campaign's leads across its Microsoft and Opt Out copies, and add the opt-out line to step 1.",
};

export default function CampaignTypesPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Create All Campaign Types
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Duplicate your campaign three times in Plusvibe — a 🔵 copy, an Opt
            Out copy and a 🔵 Opt Out copy — then point this at the original. It
            adds the opt-out line to step 1 of both Opt Out campaigns, sorts the
            not-contacted leads by mailbox provider, and splits them four ways so
            Microsoft recipients land in the 🔵 campaigns.
          </p>
        </div>
        <CampaignTypesTool />
      </main>
    </div>
  );
}
