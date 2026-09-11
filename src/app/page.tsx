import Link from "next/link";
import { Header } from "@/components/header";
import { TOOLS, TOOL_COLORS } from "@/lib/tools";
import { ArrowRightIcon, ClockIcon } from "@/components/icons";

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Header />
      {/* Wider than the tool pages so four cards sit comfortably in a row. */}
      <main className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        {/* Hero */}
        <section className="py-14 sm:py-20">
          <div className="max-w-2xl">
            <span className="pv-chip pv-chip-active mb-5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Plusvibe toolkit
            </span>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Bulk tools for your Plusvibe workspaces
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
              A clean, focused workbench of utilities built on the Plusvibe API.
              Pick a tool and run the work that would otherwise take dozens of
              clicks — across all your domains and mailboxes at once.
            </p>
          </div>
        </section>

        {/* Tool grid */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Tools
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {TOOLS.map((tool) => {
              const isActive = tool.status === "active";
              const Icon = tool.Icon;
              const c = TOOL_COLORS[tool.color];
              const card = (
                <div
                  className={`pv-card group relative flex h-full flex-col p-5 transition ${
                    isActive
                      ? `hover:-translate-y-0.5 hover:shadow-card ${c.border}`
                      : "opacity-70"
                  }`}
                >
                  <div className="mb-4 flex items-center justify-between">
                    <span
                      className={`flex h-11 w-11 items-center justify-center rounded-xl ${
                        isActive ? c.tile : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <Icon size={22} />
                    </span>
                    {!isActive && (
                      <span className="pv-chip">
                        <ClockIcon size={12} />
                        Coming soon
                      </span>
                    )}
                  </div>
                  <h3 className="text-base font-semibold">{tool.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tool.tagline}
                  </p>
                  <div className="mt-4 flex-1" />
                  {isActive && (
                    <span
                      className={`inline-flex items-center gap-1.5 text-sm font-medium ${c.link}`}
                    >
                      Open tool
                      <ArrowRightIcon
                        size={16}
                        className="transition group-hover:translate-x-0.5"
                      />
                    </span>
                  )}
                </div>
              );

              return isActive ? (
                <Link key={tool.slug} href={`/tools/${tool.slug}`}>
                  {card}
                </Link>
              ) : (
                <div key={tool.slug}>{card}</div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
