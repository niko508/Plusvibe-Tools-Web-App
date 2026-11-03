import type { Metadata } from "next";
import { Header } from "@/components/header";
import { InboxRotationTool } from "./tool";

export const metadata: Metadata = {
  title: "Inbox Rotation · Plusvibe Tools",
  description: "Rotate the sending settings between a workspace's two sending groups.",
};

export default function InboxRotationPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Inbox Rotation</h1>
        </div>
        <InboxRotationTool />
      </main>
    </div>
  );
}
