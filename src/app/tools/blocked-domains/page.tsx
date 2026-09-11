import type { Metadata } from "next";
import { Header } from "@/components/header";
import { BlockedDomainsTool } from "./tool";

export const metadata: Metadata = {
  title: "Blocked Domains (Automation) · Plusvibe Tools",
  description:
    "Clay flags a blocked sending domain; domains above the bar are left sending, the rest are stopped and you confirm the inbox deletion here.",
};

export default function BlockedDomainsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      {/* No heading or intro: the setup card below says what this does, and
          the page is only ever reached from the tool grid. The tab title still
          names it. */}
      <main className="mx-auto max-w-6xl px-4 pb-24 pt-8 sm:px-6">
        <BlockedDomainsTool />
      </main>
    </div>
  );
}
