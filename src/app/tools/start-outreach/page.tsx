import type { Metadata } from "next";
import { Header } from "@/components/header";
import { StartOutreachTool } from "./tool";

export const metadata: Metadata = {
  title: "Start Outreach with New Inboxes · Plusvibe Tools",
  description:
    "Find the inboxes in a warming workspace that have warmed long enough, then move them to a client workspace and start sending.",
};

export default function StartOutreachPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Start Outreach with New Inboxes
          </h1>
        </div>
        <StartOutreachTool />
      </main>
    </div>
  );
}
