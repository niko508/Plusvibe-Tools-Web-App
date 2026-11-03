import type { Metadata } from "next";
import { Header } from "@/components/header";
import { WinningVariantsTool } from "./tool";

export const metadata: Metadata = {
  title: "Clone Campaign with Winning Variants · Plusvibe Tools",
  description: "Clone a campaign keeping only the first-step variants that got positive replies — from it, or from several campaigns.",
};

export default function WinningVariantsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Clone Campaign with Winning Variants</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick a campaign, or several, to see how each of their first emails has done, all time. One campaign is cloned
            where it is — its settings, sender accounts, follow-ups and sub-sequences as they are — and the clone&apos;s first
            step keeps only the variants that got at least one positive reply, from every campaign picked.
          </p>
        </div>
        <WinningVariantsTool />
      </main>
    </div>
  );
}
