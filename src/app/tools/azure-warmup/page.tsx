import type { Metadata } from "next";
import { Header } from "@/components/header";
import { AzureWarmupTool } from "./tool";

export const metadata: Metadata = {
  title: "Azure Start Warmup · Plusvibe Tools",
  description:
    "Upload the Azure mailbox export, update the Domains sheet, then wait for the inboxes to land in Plusvibe and start warmup on each one automatically.",
};

export default function AzureWarmupPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Azure Start Warmup
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Upload the mailbox export and the run does the rest: it writes each
            domain&apos;s tenant email and a &ldquo;Warming Up&rdquo; status into
            the Domains sheet, then checks Plusvibe every hour and starts warmup
            on each inbox as it appears — for up to 7 days.
          </p>
        </div>
        <AzureWarmupTool />
      </main>
    </div>
  );
}
