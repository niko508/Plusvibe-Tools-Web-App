import type { Metadata } from "next";
import { Header } from "@/components/header";
import { BurnedTool } from "./tool";

export const metadata: Metadata = {
  title: "Find Burned Domains & Inboxes · Plusvibe Tools",
  description: "Scan every workspace for domains and inboxes that have stopped pulling replies.",
};

export default function BurnedDomainsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Find Burned Domains &amp; Inboxes
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Each Microsoft domain and Google inbox is compared with the rest of its own
            workspace. Scan by hand, or let the weekly check do it every Monday.
          </p>
        </div>
        <BurnedTool />
      </main>
    </div>
  );
}
