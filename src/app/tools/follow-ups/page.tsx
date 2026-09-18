import type { Metadata } from "next";
import { Header } from "@/components/header";
import { FollowUpsTool } from "./tool";

export const metadata: Metadata = {
  title: "Create Follow Up Emails · Plusvibe Tools",
  description:
    "Add your follow-up template library to step 2 of a campaign, with the offer substituted in.",
};

export default function FollowUpsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Create Follow Up Emails
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Keep a library of follow-up templates, then add them all as variants
            of step 2 on any campaign. The{" "}
            <span className="font-mono text-xs">SERVICE OFFERING / OFFER</span>{" "}
            placeholder is replaced with the sentence you enter on the run, so
            one library covers every campaign.
          </p>
        </div>
        <FollowUpsTool />
      </main>
    </div>
  );
}
