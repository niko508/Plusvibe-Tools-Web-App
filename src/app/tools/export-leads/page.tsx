import type { Metadata } from "next";
import { Header } from "@/components/header";
import { ExportRemoveTabs } from "./tabs";

export const metadata: Metadata = {
  title: "Export/Remove Not Contacted Leads · Plusvibe Tools",
  description: "Download the not-contacted leads of several campaigns in one workspace as one CSV, or delete them.",
};

export default function ExportLeadsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Export/Remove Not Contacted Leads</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick a workspace and the campaigns, and download every lead in them that hasn&apos;t been contacted yet as one CSV
            — every field and custom variable, and the campaign it is in — ready to run through Clay again. Then, or on the
            Remove tab without a download, delete them from their campaigns.
          </p>
        </div>
        <ExportRemoveTabs />
      </main>
    </div>
  );
}
