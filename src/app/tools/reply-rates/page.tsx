import type { Metadata } from "next";
import { Header } from "@/components/header";
import { ReplyRatesTool } from "./tool";

export const metadata: Metadata = {
  title: "Analyze Positive Reply Rates · Plusvibe Tools",
  description: "Compare positive reply rates between groups of campaigns over a date range.",
};

export default function ReplyRatesPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Analyze Positive Reply Rates</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick a date range and compare the positive reply rate between groups of campaigns. The rate is positive replies
            per lead emailed.
          </p>
        </div>
        <ReplyRatesTool />
      </main>
    </div>
  );
}
