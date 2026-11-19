import type { Metadata } from "next";
import { Header } from "@/components/header";
import { GeneralSettingsTool } from "./tool";

export const metadata: Metadata = {
  title: "General Settings · Plusvibe Tools",
  description: "The tag names, sheet tabs, statuses and other values the tools share, in one place.",
};

export default function GeneralSettingsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">General Settings</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            The values several tools share — tag names, the sheet&apos;s tabs and statuses, the workspaces left out, sending
            capacity and the opt-out text. Change one here and every tool that uses it follows, including the automations
            that run on their own.
          </p>
        </div>
        <GeneralSettingsTool />
      </main>
    </div>
  );
}
