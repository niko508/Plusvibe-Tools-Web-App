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
        </div>
        <CampaignTypesTool />
      </main>
    </div>
  );
}
