import type { Metadata } from "next";
import { Header } from "@/components/header";
import { DomainPerformanceTool } from "./tool";

export const metadata: Metadata = {
  title: "Domain Performance Monitoring · Plusvibe Tools",
  description:
    "Compare deliverability and reply performance across every sending domain in a Plusvibe workspace.",
};

export default function DomainPerformancePage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Domain Performance Monitoring
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Break a workspace&apos;s email stats down by sending domain over any
            date range — volume, reply and positive-reply rates, and bounce
            rate, side by side.
          </p>
        </div>
        <DomainPerformanceTool />
      </main>
    </div>
  );
}
