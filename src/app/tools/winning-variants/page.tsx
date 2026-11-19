import type { Metadata } from "next";
import { Header } from "@/components/header";
import { WinningVariantsTool } from "./tool";

export const metadata: Metadata = {
  title: "Clone Campaign with Winning Variants · Plusvibe Tools",
  description: "Tick segments; each becomes a 🟡 clone whose first step keeps only the variants that got positive replies.",
};

export default function WinningVariantsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Clone Campaign with Winning Variants</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Tick the segments you want. For each one, every campaign of the segment is read, and its newest 🟡 campaign is
            cloned — settings, sender accounts, follow-ups and sub-sequences as they are — with only the first emails that got
            a positive reply. It runs in the background, so you can close the page.
          </p>
        </div>
        <WinningVariantsTool />
      </main>
    </div>
  );
}
