import type { Metadata } from "next";
import { Header } from "@/components/header";
import { BulkActionsTool } from "./tool";

export const metadata: Metadata = {
  title: "General Bulk Actions · Plusvibe Tools",
  description: "Run the same action across as many workspaces as you pick.",
};

export default function BulkActionsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            General Bulk Actions
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Actions that run across many workspaces at once. Pick the workspaces
            once, then choose what to do with them — starting with adding a
            webhook to all of them.
          </p>
        </div>
        <BulkActionsTool />
      </main>
    </div>
  );
}
