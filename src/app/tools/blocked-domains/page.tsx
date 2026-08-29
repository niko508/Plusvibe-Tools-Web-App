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
            calls this app. Without waiting for anyone: the domain&apos;s
            inboxes stop sending and warming, the domain goes Not Active in the
            Domains sheet, and its tenant is queued on Tenants to Cancel. Only
            deleting the inboxes waits for you here, because only that
            can&apos;t be undone.
          </p>
        </div>
        <BlockedDomainsTool />
      </main>
    </div>
  );
}
