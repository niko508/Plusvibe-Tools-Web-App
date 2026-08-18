import type { Metadata } from "next";
import { Header } from "@/components/header";
import { RemoveOpeningLineTool } from "./tool";

export const metadata: Metadata = {
  title: "Remove Personalized Opening Line · Plusvibe Tools",
  description:
    "Strip the opening-line personalization from every variation of a campaign — unwrap the subject fallback and drop {{opening_line}} from the bodies.",
};

export default function RemoveOpeningLinePage() {
  return (
    <div className="min-h-screen">
      <Header back={{ href: "/", label: "All tools" }} />
      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="py-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Remove Personalized Opening Line
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Unwraps the{" "}
            <span className="font-mono text-xs">
              {"{{fallback| {{subject_line}} | … }}"}
            </span>{" "}
            subject on every variation and removes{" "}
            <span className="font-mono text-xs">{"{{opening_line}}"}</span> from
            every body. The variations themselves and the rest of the copy stay
            exactly as they are.
          </p>
        </div>
        <RemoveOpeningLineTool />
      </main>
    </div>
  );
}
