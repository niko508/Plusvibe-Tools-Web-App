import type { Metadata } from "next";
import { Header } from "@/components/header";
import { InboxPerformanceTool } from "./tool";

export const metadata: Metadata = {
  title: "Inbox Performance Monitoring · Plusvibe Tools",
  description:
    "Compare deliverability and reply performance across every sending inbox, in one workspace or all of them.",
};

export default function InboxPerformancePage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      {/* Wider than the other tools: the global view carries a workspace column. */}
      <main className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Inbox Performance Monitoring
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Every sending inbox side by side over any date range — sent volume,
            reply rates on unique contacts, positive replies and bounces — for
            one workspace or all of them at once. Nothing is fetched until you
            choose what to pull.
          </p>
        </div>
        <InboxPerformanceTool />
      </main>
    </div>
  );
}
