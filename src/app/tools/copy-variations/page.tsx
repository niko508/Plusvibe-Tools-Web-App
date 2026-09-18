import type { Metadata } from "next";
import { Header } from "@/components/header";
import { CopyVariationsTool } from "./tool";

export const metadata: Metadata = {
  title: "Create Email Copy Variations · Plusvibe Tools",
  description:
    "Paste a batch of email copy variants and add them to a campaign sequence step in one pass, keeping the existing subject line.",
};

export default function CopyVariationsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Create Email Copy Variations
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick a campaign, paste your variants in the usual{" "}
            <span className="font-mono text-xs">VARIANT n — name</span> format,
            and add them all to a sequence step at once — the subject line and
            the variants already there are left untouched.
          </p>
        </div>
        <CopyVariationsTool />
      </main>
    </div>
  );
}
