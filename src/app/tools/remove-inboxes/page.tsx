import type { Metadata } from "next";
import { Header } from "@/components/header";
import { RemoveInboxesTool } from "./tool";

export const metadata: Metadata = {
  title: "Remove Inboxes · Plusvibe Tools",
  description:
    "Bulk-delete inboxes by sending domain or by exact address across all your Plusvibe workspaces, with a background job you can leave running.",
};

export default function RemoveInboxesPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Remove Inboxes
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Paste or upload a list of sending domains, or the exact inbox
            addresses. The tool scans your workspaces to find them, shows you
            exactly what will be removed, then deletes them in a background job
            you can leave running.
          </p>
        </div>
        <RemoveInboxesTool />
      </main>
    </div>
  );
}
