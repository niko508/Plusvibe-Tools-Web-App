import type { Metadata } from "next";
import { Header } from "@/components/header";
import { Remove50Tool } from "./tool";

export const metadata: Metadata = {
  title: "Remove 50 Inboxes from Domain · Plusvibe Tools",
  description:
    "Trim over-provisioned warmup domains down to 50 inboxes (worst warmup health first) and standardize warmup settings.",
};

export default function Remove50Page() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Remove 50 Inboxes from Domain
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            For a workspace, trim every domain with more than 50 inboxes down to
            50 — deleting the worst warmup-health inboxes first — then apply your
            standard warmup config and enable warmup on the ones kept.
          </p>
        </div>
        <Remove50Tool />
      </main>
    </div>
  );
}
