import type { Metadata } from "next";
import { Header } from "@/components/header";
import { ChangeLimitsTool } from "./tool";

export const metadata: Metadata = {
  title: "Change Limits with Best Performing Inboxes · Plusvibe Tools",
  description:
    "Find the inboxes clearing a true reply rate for their provider, then raise their sending and warmup settings in one background run.",
};

export default function ChangeLimitsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Change Limits with Best Performing Inboxes
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Set a true reply rate for Google and for Microsoft inboxes plus a
            minimum number of sends, and it finds every inbox in the workspaces
            you pick that clears its own threshold. Then it raises their
            campaign and warmup settings in one background run. Rates are
            worked out on unique contacts, never on emails sent.
          </p>
        </div>
        <ChangeLimitsTool />
      </main>
    </div>
  );
}
