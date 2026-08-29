import type { Metadata } from "next";
import { Header } from "@/components/header";
import { BlockedDomainsTool } from "./tool";

export const metadata: Metadata = {
  title: "Blocked Domains (Automation) · Plusvibe Tools",
  description:
    "Clay flags a blocked sending domain, sending and warmup stop immediately, and you confirm the inbox deletion here.",
};

export default function BlockedDomainsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Blocked Domains (Automation)
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            When Clay spots a blocked sending domain in a bounce reason, it
            calls this app: the domain&apos;s inboxes stop sending and warming
            immediately, then wait here for you to confirm the deletion. On
            confirmation it deletes them, sets the domain to Not Active in the
            Domains sheet, and queues its tenant for cancellation.
          </p>
        </div>
        <BlockedDomainsTool />
      </main>
    </div>
  );
}
