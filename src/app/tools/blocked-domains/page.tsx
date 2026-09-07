import type { Metadata } from "next";
import { Header } from "@/components/header";
import { BlockedDomainsTool } from "./tool";

export const metadata: Metadata = {
  title: "Blocked Domains (Automation) · Plusvibe Tools",
  description:
    "Clay flags a blocked sending domain; domains still replying are left alone, the rest are stopped and you confirm the inbox deletion here.",
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
            calls this app, which first works out how the domain has replied
            over the last 7 days. A domain still performing is left entirely
            alone. One that isn&apos;t has its inboxes stopped, goes Not Active
            in the Domains sheet and its tenant queued on Tenants to Cancel —
            except for any individual inbox still replying, which keeps
            sending. Only deleting inboxes waits for you here, because only
            that can&apos;t be undone.
          </p>
        </div>
        <BlockedDomainsTool />
      </main>
    </div>
  );
}
