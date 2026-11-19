import type { Metadata } from "next";
import { Header } from "@/components/header";
import { TldTool } from "./tool";

export const metadata: Metadata = {
  title: "TLD Performance Tracking · Plusvibe Tools",
  description: "Which domain endings and registrars are worth buying, month by month.",
};

export default function TldPerformancePage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">TLD Performance Tracking</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Which domain ending and registrar to buy next. Each combo is measured against the clients its domains send for,
            month by month, with the blocks the Blocked Domains automation caught.
          </p>
        </div>
        <TldTool />
      </main>
    </div>
  );
}
