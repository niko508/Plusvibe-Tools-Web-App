import type { Metadata } from "next";
import { Header } from "@/components/header";
import { CapacityTool } from "./tool";

export const metadata: Metadata = {
  title: "Sending Capacity · Plusvibe Tools",
  description: "How many emails a day every workspace's inboxes could carry, and what that adds up to.",
};

export default function SendingCapacityPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Sending Capacity</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            How many emails a day the inboxes could carry, per workspace and all told —
            counted by what each domain runs on.
          </p>
        </div>
        <CapacityTool />
      </main>
    </div>
  );
}
