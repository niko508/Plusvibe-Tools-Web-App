import type { Metadata } from "next";
import { Header } from "@/components/header";
import { AddSignaturesTool } from "./tool";

export const metadata: Metadata = {
  title: "Add Signatures · Plusvibe Tools",
  description:
    "Generate hundreds of spintax signature variations and apply them, personalized per inbox, across a Plusvibe workspace.",
};

export default function AddSignaturesPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Add Signatures
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Provide your company, phone and address variations. The tool builds
            hundreds of spintax signature combinations, personalizes each with
            the inbox&apos;s own name, and applies them across the workspace.
          </p>
        </div>
        <AddSignaturesTool />
      </main>
    </div>
  );
}
