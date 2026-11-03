import type { Metadata } from "next";
import { Header } from "@/components/header";
import { CopySectionsTool } from "./tool";

export const metadata: Metadata = {
  title: "Change Email Copy Sections · Plusvibe Tools",
  description:
    "Change the subject, a sentence, a variable, the opening or the sign-off across every variation of a sequence step in one pass.",
};

export default function CopySectionsPage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Change Email Copy Sections
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Change one thing across many variations at once — find and replace
            a sentence or a variable, or swap out the subject line, the opening
            paragraph or the sign-off. Work on one campaign and step with a
            per-variation preview, or run a find &amp; replace across the
            campaigns you tick, or across every workspace, as a background job
            that shows what would change before you confirm.
          </p>
        </div>
        <CopySectionsTool />
      </main>
    </div>
  );
}
